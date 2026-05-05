'use strict';

// Daily minimum SoC tracker.
//
// Fox's hourly history has ~7-day retention, so we snapshot the overnight
// minimum SoC for each completed day into a JSONL file (data/soc-history.jsonl)
// so values survive Fox's rolling window forever.
//
// Flow:
//   • scheduleNextLockin() fires daily at 23:55 local time via a setTimeout chain.
//   • lockInToday() queries Fox history for today's overnight window,
//     finds the minimum SoC, and appends it to the JSONL file.
//   • getSocHistory() returns the last N days, backfilling any missing dates
//     from Fox history if still within the retention window.

const fs = require('fs');
const { config, DATA_DIR, SOC_HISTORY_PATH, isConfigured } = require('./config');
const { throttleFox, foxRequest }  = require('./fox-client');
const { Cache, localParts }        = require('./utils');
const { postNtfy }                 = require('./notifications');

// Ensure the data directory exists at module load time.
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch {}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------
const socHistoryCache = new Cache(30 * 60 * 1000);
let   socHistoryCacheDays = 0;

function clearCache() { socHistoryCache.clear(); socHistoryCacheDays = 0; }

// ---------------------------------------------------------------------------
// JSONL persistence helpers
// ---------------------------------------------------------------------------
function readSocSnapshots() {
  if (!fs.existsSync(SOC_HISTORY_PATH)) return [];
  const out = [];
  for (const line of fs.readFileSync(SOC_HISTORY_PATH, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch {}
  }
  return out;
}

function appendSocSnapshot(entry) {
  fs.appendFileSync(SOC_HISTORY_PATH, JSON.stringify(entry) + '\n');
}

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------
/** Today's date string (YYYY-MM-DD) in the configured timezone. */
function localDateKey(date = new Date()) {
  return localParts(date, config.timezone || 'Australia/Melbourne').date;
}

/**
 * Compute when 23:55 local next occurs, returned as a Date.
 * The lock-in fires just before midnight so Fox history has time to settle.
 */
function nextLockinFire() {
  const tz  = config.timezone || 'Australia/Melbourne';
  const now = new Date();
  const lp  = localParts(now, tz);
  // Compute local midnight by subtracting the local minutes-into-day from now.
  const todayLocalMidnight = new Date(now.getTime() - lp.minutes * 60 * 1000);
  // 23:55 = 1435 minutes after local midnight.
  const target = new Date(todayLocalMidnight.getTime() + 1435 * 60 * 1000);
  if (target <= now) target.setTime(target.getTime() + 24 * 60 * 60 * 1000);
  return target;
}

// ---------------------------------------------------------------------------
// findDailyMinSoc
// ---------------------------------------------------------------------------
/**
 * Query Fox history for a UTC window that covers the overnight period of
 * `dateKey` (19:30 local → ~09:30 local next day) and return the minimum SoC.
 *
 * Fox's history/query rejects windows > ~24 h; 14 h is well within limits.
 *
 * @returns {Promise<{ soc: number, atLocal: string }|null>}
 */
async function findDailyMinSoc(dateKey) {
  if (!isConfigured()) return null;
  const [y, m, d] = dateKey.split('-').map(Number);
  // 09:30–23:30 UTC covers the 19:30–09:30-next-day local window for both
  // AEST (UTC+10) and AEDT (UTC+11).
  const beginUTC = Date.UTC(y, m - 1, d,  9, 30);
  const endUTC   = Date.UTC(y, m - 1, d, 23, 30);

  await throttleFox();
  const r = await foxRequest('/op/v0/device/history/query', {
    sn: config.deviceSN, variables: ['SoC'], begin: beginUTC, end: endUTC,
  });

  let parsed;
  try { parsed = JSON.parse(r.body); } catch { return null; }
  if (parsed?.errno !== 0) {
    console.warn(`min-soc ${dateKey}: errno=${parsed?.errno} msg=${parsed?.msg}`);
    return null;
  }

  const datas   = parsed.result?.[0]?.datas || [];
  const series  = datas.find((x) => /^soc$/i.test(x.variable || ''));
  const samples = series?.data || [];
  if (!samples.length) return null;

  // The window can span both `dateKey` (post-dump) AND the next local day
  // (early morning dip) — accept both date prefixes.
  const nextUTC     = new Date(Date.UTC(y, m - 1, d + 1));
  const nextDateKey = `${nextUTC.getUTCFullYear()}-${String(nextUTC.getUTCMonth() + 1).padStart(2, '0')}-${String(nextUTC.getUTCDate()).padStart(2, '0')}`;

  let min = Infinity, minTime = null;
  for (const s of samples) {
    if (s.time == null || s.value == null) continue;
    const match = String(s.time).match(/^(\d{4}-\d{2}-\d{2})/);
    if (!match) continue;
    if (match[1] !== dateKey && match[1] !== nextDateKey) continue;
    const v = Number(s.value);
    if (Number.isFinite(v) && v < min) { min = v; minTime = String(s.time); }
  }
  return min === Infinity ? null : { soc: min, atLocal: minTime };
}

// ---------------------------------------------------------------------------
// lockInToday / takeSnapshot
// ---------------------------------------------------------------------------
/**
 * Capture today's overnight minimum SoC and persist it to the JSONL file.
 * Skips silently if a snapshot for today already exists.
 */
async function lockInToday() {
  const dateKey  = localDateKey();
  const existing = readSocSnapshots().find((e) => e.date === dateKey && e.source === 'snapshot');
  if (existing) {
    console.log(`min-soc lock-in: already have ${dateKey}, skipping`);
    return existing;
  }
  const result = await findDailyMinSoc(dateKey);
  if (!result) {
    console.warn('min-soc lock-in: no data for', dateKey);
    return null;
  }
  const entry = {
    date   : dateKey,
    soc    : result.soc,
    atLocal: result.atLocal,
    takenAt: new Date().toISOString(),
    source : 'snapshot',
  };
  appendSocSnapshot(entry);
  console.log(`min-soc lock-in: ${dateKey} min=${result.soc}% at ${result.atLocal}`);
  postNtfy('Fox ESS', `Daily min SoC: ${Math.round(result.soc)}%`);
  return entry;
}

// Back-compat alias used by the manual /api/soc-history/snapshot endpoint.
const takeSnapshot = lockInToday;

// ---------------------------------------------------------------------------
// scheduleNextLockin
// ---------------------------------------------------------------------------
/** Schedule a recurring 23:55-local lock-in using a self-rescheduling setTimeout. */
function scheduleNextLockin() {
  const fire  = nextLockinFire();
  const delay = fire - new Date();
  console.log(`min-soc lock-in scheduled for ${fire.toLocaleString()} (${Math.round(delay / 60000)} min)`);
  setTimeout(async () => {
    try   { await lockInToday(); }
    catch (e) { console.warn('lockin failed:', e.message); }
    scheduleNextLockin();
  }, Math.max(60_000, delay));
}

// ---------------------------------------------------------------------------
// getSocHistory
// ---------------------------------------------------------------------------
/**
 * Return the daily minimum SoC for the last `days` days plus today.
 * Sources in priority order:
 *   1. JSONL snapshots (persisted, survives Fox retention)
 *   2. Fox history backfill (if within ~7-day window)
 *   3. { soc: null, source: 'missing' } placeholder
 *
 * @param {number} days  1–30
 */
async function getSocHistory(days = 7) {
  if (socHistoryCache.get() && socHistoryCacheDays === days) return socHistoryCache.get();

  const snapshots = readSocSnapshots();
  const byDate    = new Map();
  for (const s of snapshots) {
    byDate.set(s.date, { date: s.date, soc: s.soc, atLocal: s.atLocal, source: 'snapshot' });
  }

  const todayKey = localDateKey();
  const today    = new Date();
  const wanted   = [];
  for (let off = days; off >= 1; off--) {
    const d = new Date(today);
    d.setDate(d.getDate() - off);
    wanted.push(localDateKey(d));
  }
  wanted.push(todayKey); // today as a "running min" entry (not persisted)

  // Backfill any missing dates from Fox history (best-effort).
  if (isConfigured()) {
    for (const key of wanted) {
      if (byDate.has(key)) continue;
      try {
        const r = await findDailyMinSoc(key);
        if (r != null) {
          byDate.set(key, {
            date   : key,
            soc    : r.soc,
            atLocal: r.atLocal,
            source : key === todayKey ? 'today' : 'backfill',
          });
        }
      } catch (e) {
        console.warn(`min-soc ${key} failed:`, e.message);
      }
    }
  }

  const out = wanted.map((key) => byDate.get(key) || { date: key, soc: null, source: 'missing' });
  socHistoryCacheDays = days;
  return socHistoryCache.set({ days: out, metric: 'dailyMin' });
}

// ---------------------------------------------------------------------------
module.exports = {
  readSocSnapshots,
  appendSocSnapshot,
  localDateKey,
  findDailyMinSoc,
  lockInToday,
  takeSnapshot,
  scheduleNextLockin,
  getSocHistory,
  clearCache,
};
