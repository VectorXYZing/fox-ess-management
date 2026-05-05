'use strict';

// AEMO price data via nemweb.com.au.
//
// history  — last ~14 h of 30-min-spaced dispatch prices (DISPATCHIS zips)
// forecast — next ~20 h of 30-min predispatch prices (PREDISPATCHIS zip)
//
// Both use the pure-JS unzipFirstEntry() helper — no OS `unzip` binary needed.

const { config, onConfigSaved }          = require('./config');
const { Cache, csvSplit, httpsGetText, httpsGetBuffer, unzipFirstEntry } = require('./utils');

// ---------------------------------------------------------------------------
// Caches
// ---------------------------------------------------------------------------
// historyCache stores { [region]: [{ REGIONID, DATETIME, RRP }] }
const historyCache  = new Cache(10 * 60 * 1000); // 10 min
// forecastCache stores the same shape
const forecastCache = new Cache(5 * 60 * 1000);  // 5 min

function clearCache() { historyCache.clear(); forecastCache.clear(); }
onConfigSaved(clearCache);

// ---------------------------------------------------------------------------
// fetchHistoryForRegion
// ---------------------------------------------------------------------------
/**
 * Download and parse the most recent ~28 DISPATCHIS zip files from nemweb,
 * building a 30-min-spaced price series (~14 h of history) for all regions.
 * Results are cached for 10 minutes.
 *
 * Each DISPATCHIS zip contains a single CSV; we pick every 6th file from the
 * directory listing (files are 5 min apart → every 6th ≈ 30 min spacing).
 *
 * @param {string} region  e.g. 'VIC1'
 * @returns {Promise<Array<{REGIONID, DATETIME, RRP}>>}
 */
async function fetchHistoryForRegion(region) {
  const cached = historyCache.get();
  if (cached) return cached[region] || [];

  const base    = 'https://nemweb.com.au/Reports/Current/DispatchIS_Reports/';
  const listing = await httpsGetText(base);
  const names   = [...new Set(
    [...listing.matchAll(/PUBLIC_DISPATCHIS_\d+_\d+\.zip/g)].map((m) => m[0]),
  )].sort().reverse();

  // Pick ~28 files at ~30-min spacing.
  const picks = [];
  for (let i = 0; i < names.length && picks.length < 28; i += 6) picks.push(names[i]);

  // nemweb rate-limits parallel downloads — fetch sequentially with a short delay.
  const buffers = [];
  for (const name of picks) {
    try {
      buffers.push(await httpsGetBuffer(base + name));
    } catch (e) {
      console.error('aemo history: dl fail', name, e.message);
      buffers.push(null);
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  console.log(`aemo history: ${picks.length} picks, ${buffers.filter(Boolean).length} downloaded`);

  const byRegion = {};
  for (let idx = 0; idx < buffers.length; idx++) {
    const buf = buffers[idx];
    if (!buf || buf.length < 100) {
      if (buf) console.error('aemo history: buffer too small', picks[idx], buf.length);
      continue;
    }
    let csv;
    try {
      csv = unzipFirstEntry(buf);
    } catch (e) {
      console.error('aemo history: unzip failed', picks[idx], e.message);
      continue;
    }
    for (const line of csv.split(/\r?\n/)) {
      if (!line.startsWith('D,DISPATCH,PRICE')) continue;
      const c = csvSplit(line);
      if (c[8] !== '0') continue; // skip intervention runs
      const reg = c[6];
      const rrp = Number(c[9]);
      const dt  = (c[4] || '').replace(/"/g, '');
      if (!reg || !dt || isNaN(rrp)) continue;
      (byRegion[reg] ||= []).push({ REGIONID: reg, DATETIME: dt, RRP: rrp });
    }
  }

  for (const k of Object.keys(byRegion)) {
    byRegion[k].sort((a, b) => a.DATETIME.localeCompare(b.DATETIME));
  }

  historyCache.set(byRegion);
  return byRegion[region] || [];
}

// ---------------------------------------------------------------------------
// fetchForecastForRegion
// ---------------------------------------------------------------------------
/**
 * Download and parse the latest PREDISPATCHIS zip from nemweb, extracting
 * 30-min forecast prices for all regions (~20 h ahead).
 * Results are cached for 5 minutes.
 *
 * @param {string} region  e.g. 'VIC1'
 * @returns {Promise<Array<{REGIONID, DATETIME, RRP}>>}
 */
async function fetchForecastForRegion(region) {
  const cached = forecastCache.get();
  if (cached) return cached[region] || [];

  const base    = 'https://nemweb.com.au/Reports/Current/PredispatchIS_Reports/';
  const listing = await httpsGetText(base);
  const names   = [...new Set(
    [...listing.matchAll(/PUBLIC_PREDISPATCHIS_\d+_\d+\.zip/g)].map((m) => m[0]),
  )];
  if (names.length === 0) throw new Error('no predispatch files in nemweb listing');

  const latest = names.sort().pop();
  const buf    = await httpsGetBuffer(base + latest);
  const csv    = unzipFirstEntry(buf);

  // Parse "D,PREDISPATCH,REGION_PRICES,..." rows.
  // Column indices (from the I-header):
  //   [6]=REGIONID  [8]=INTERVENTION  [9]=RRP  [28]=DATETIME
  const byRegion = {};
  for (const line of csv.split(/\r?\n/)) {
    if (!line.startsWith('D,PREDISPATCH,REGION_PRICES')) continue;
    const c = csvSplit(line);
    if (c[8] !== '0') continue; // ignore intervention runs
    const reg = c[6];
    const rrp = Number(c[9]);
    const dt  = (c[28] || '').replace(/"/g, '');
    if (!reg || !dt || isNaN(rrp)) continue;
    (byRegion[reg] ||= []).push({ REGIONID: reg, DATETIME: dt, RRP: rrp });
  }
  for (const k of Object.keys(byRegion)) {
    byRegion[k].sort((a, b) => a.DATETIME.localeCompare(b.DATETIME));
  }

  forecastCache.set(byRegion);
  return byRegion[region] || [];
}

// ---------------------------------------------------------------------------
module.exports = { fetchHistoryForRegion, fetchForecastForRegion, clearCache };
