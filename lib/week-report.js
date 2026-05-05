'use strict';

// Last N days of daily energy totals for all six Today metrics.
//
// Uses Fox's dimension:'month' report (retains ~30 days of per-day totals),
// plus per-day dump-window feedin from history/query, merged with a
// persistent JSON store so dump values survive Fox's ~7-day history retention.

const fs = require('fs');
const { config, STATE_DIR, DUMP_HISTORY_PATH, isConfigured, onConfigSaved } = require('./config');
const { throttleFox, foxRequest } = require('./fox-client');
const { Cache, localParts, round1, hhmmToMin } = require('./utils');

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------
const weekReportCache = new Cache(15 * 60 * 1000);
let   weekReportCacheDays = 0;

function clearCache() { weekReportCache.clear(); weekReportCacheDays = 0; }
onConfigSaved(clearCache);

// ---------------------------------------------------------------------------
// Dump-window history persistence
// ---------------------------------------------------------------------------
// Fox history/query only retains ~3–7 days, so we snapshot each completed
// day's dump-window feedin to state/dump-history.json and keep it forever.

function readDumpHistory() {
  try {
    if (!fs.existsSync(DUMP_HISTORY_PATH)) return {};
    return JSON.parse(fs.readFileSync(DUMP_HISTORY_PATH, 'utf8'));
  } catch (e) {
    console.warn('dump-history read failed:', e.message);
    return {};
  }
}

function writeDumpHistory(obj) {
  try {
    if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(DUMP_HISTORY_PATH, JSON.stringify(obj, null, 2));
  } catch (e) {
    console.warn('dump-history write failed:', e.message);
  }
}

// ---------------------------------------------------------------------------
// Fox report variables
// ---------------------------------------------------------------------------
const WEEK_REPORT_VARS = [
  'generation', 'loads', 'gridConsumption', 'feedin',
  'chargeEnergyToTal', 'dischargeEnergyToTal',
];

// ---------------------------------------------------------------------------
// getWeekReport
// ---------------------------------------------------------------------------
/**
 * Return daily energy totals for the last `days` days (including today).
 *
 * Each row:
 *   { date, dayOfWeek, isToday, generation, loads, gridConsumption, feedin,
 *     feedinDumpWindow, feedinDumpWindowSource, chargeEnergyToTal, dischargeEnergyToTal }
 *
 * feedinDumpWindow is the kWh exported during the configured 17:30–19:30
 * (configurable) window, derived from Fox history/query and persisted so it
 * survives Fox's rolling retention window.
 *
 * @param {number} days  1–30
 */
async function getWeekReport(days = 7) {
  if (weekReportCache.get() && weekReportCacheDays === days) return weekReportCache.get();

  const tz    = config.timezone || 'Australia/Melbourne';
  const today = new Date();

  // Read dump window from config directly (avoids a circular dep on recommendation.js).
  const dumpStartMin = hhmmToMin((config.recommendation?.dumpWindowLocal?.start) || '17:30');
  const dumpEndMin   = hhmmToMin((config.recommendation?.dumpWindowLocal?.end)   || '19:30');

  // --- Monthly totals from Fox ---
  const monthsNeeded = new Set();
  for (let off = 0; off < days; off++) {
    const d  = new Date(today); d.setDate(d.getDate() - off);
    const lp = localParts(d, tz);
    monthsNeeded.add(`${lp.date.slice(0, 4)}-${Number(lp.date.slice(5, 7))}`);
  }

  const byDate = {};
  for (const key of monthsNeeded) {
    const [yy, mm] = key.split('-').map(Number);
    try {
      await throttleFox();
      const r      = await foxRequest('/op/v0/device/report/query', {
        sn: config.deviceSN, deviceSN: config.deviceSN,
        year: yy, month: mm, dimension: 'month', variables: WEEK_REPORT_VARS,
      });
      const parsed = JSON.parse(r.body);
      if (parsed?.errno !== 0) {
        console.warn(`week-report: errno=${parsed?.errno} msg=${parsed?.msg} for ${yy}-${mm}`);
        continue;
      }
      for (const row of parsed.result || []) {
        if (!WEEK_REPORT_VARS.includes(row.variable)) continue;
        (row.values || []).forEach((v, i) => {
          const k = `${yy}-${String(mm).padStart(2, '0')}-${String(i + 1).padStart(2, '0')}`;
          (byDate[k] ||= {})[row.variable] = Number(v) || 0;
        });
      }
    } catch (e) {
      console.warn(`week-report: fetch failed for ${yy}-${mm}: ${e.message}`);
    }
  }

  // --- Per-day dump-window feedin from Fox history ---
  // history/query retention appears to be 3–7 days; we try the full week and
  // skip silently for any days Fox has already dropped.
  const dumpByDate       = {};
  const hourlyFetchDays  = Math.min(days, 8);

  for (let off = 0; off < hourlyFetchDays; off++) {
    const d  = new Date(today); d.setDate(d.getDate() - off);
    const lp = localParts(d, tz);
    const [yy, mm, dd] = lp.date.split('-').map(Number);
    // 06:00–11:00 UTC covers the 17:30–19:30 local window for both AEST (UTC+10)
    // and AEDT (UTC+11) with margin on both ends.
    const begin = Date.UTC(yy, mm - 1, dd, 6, 0);
    const end   = Date.UTC(yy, mm - 1, dd, 11, 0);

    try {
      await throttleFox();
      const r      = await foxRequest('/op/v0/device/history/query', {
        sn: config.deviceSN, variables: ['feedinPower'], begin, end,
      });
      const parsed = JSON.parse(r.body);
      if (parsed?.errno !== 0) {
        console.warn(`week-report: history errno=${parsed?.errno} for ${lp.date}`);
        continue;
      }
      const datas       = parsed.result?.[0]?.datas || [];
      const feedSeries  = datas.find((x) => x.variable === 'feedinPower');
      const feedSamples = feedSeries?.data || [];

      // Collect samples inside the dump window, then trapezoidal-integrate.
      const pts = [];
      for (const s of feedSamples) {
        const m = s.time?.match(/^(\d{4}-\d{2}-\d{2})\s(\d{2}):(\d{2}):(\d{2})/);
        if (!m || m[1] !== lp.date) continue;
        const minOfDay = Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 60;
        if (minOfDay < dumpStartMin || minOfDay > dumpEndMin) continue;
        pts.push({ min: minOfDay, kW: Number(s.value) || 0 });
      }
      pts.sort((a, b) => a.min - b.min);

      let kwh = 0;
      for (let i = 0; i < pts.length - 1; i++) {
        const dtH = (pts[i + 1].min - pts[i].min) / 60;
        kwh += ((pts[i].kW + pts[i + 1].kW) / 2) * dtH;
      }
      if (pts.length > 1) dumpByDate[lp.date] = kwh;
    } catch (e) {
      console.warn(`week-report: history feedin failed for ${lp.date}: ${e.message}`);
    }
  }

  // --- Merge with persisted dump history ---
  const history     = readDumpHistory();
  let   historyDirty = false;
  const dowLabels   = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const result      = [];

  for (let off = days - 1; off >= 0; off--) {
    const d       = new Date(today); d.setDate(d.getDate() - off);
    const k       = localParts(d, tz).date;
    const row     = byDate[k] || {};
    // Derive day-of-week from the local date string (container runs UTC so
    // d.getDay() can be off-by-one near midnight local time).
    const [ly, lmo, ldd] = k.split('-').map(Number);
    const dowIdx  = new Date(Date.UTC(ly, lmo - 1, ldd, 12, 0)).getUTCDay();
    const isToday = off === 0;

    let feedinDumpWindow       = null;
    let feedinDumpWindowSource = null;

    if (dumpByDate[k] != null) {
      feedinDumpWindow       = round1(dumpByDate[k]);
      feedinDumpWindowSource = 'fox';
      if (!isToday && history[k] !== feedinDumpWindow) {
        history[k]   = feedinDumpWindow;
        historyDirty = true;
      }
    } else if (history[k] != null) {
      feedinDumpWindow       = history[k];
      feedinDumpWindowSource = 'stored';
    }

    result.push({
      date                  : k,
      dayOfWeek             : dowLabels[dowIdx],
      isToday,
      generation            : round1(row.generation),
      loads                 : round1(row.loads),
      gridConsumption       : round1(row.gridConsumption),
      feedin                : round1(row.feedin),
      feedinDumpWindow,
      feedinDumpWindowSource,
      chargeEnergyToTal     : round1(row.chargeEnergyToTal),
      dischargeEnergyToTal  : round1(row.dischargeEnergyToTal),
    });
  }

  if (historyDirty) writeDumpHistory(history);

  const dumpWindowLocal = {
    start: (config.recommendation?.dumpWindowLocal?.start) || '17:30',
    end  : (config.recommendation?.dumpWindowLocal?.end)   || '19:30',
  };

  weekReportCacheDays = days;
  return weekReportCache.set({ days: result, dumpWindowLocal });
}

// ---------------------------------------------------------------------------
module.exports = { getWeekReport, clearCache };
