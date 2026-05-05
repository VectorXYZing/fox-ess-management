'use strict';

// Solar PV forecast and calibration via Open-Meteo (free, no API key).
// Also provides getSolarRemainingKwh() used by the recommendation engine.

const { config, onConfigSaved }  = require('./config');
const { throttleFox, foxRequest } = require('./fox-client');
const {
  Cache,
  httpsGetText,
  localParts,
  localOrdinalFromNaive,
  localOrdinalFromDate,
} = require('./utils');

// ---------------------------------------------------------------------------
// Caches
// ---------------------------------------------------------------------------
const solarCache = new Cache(30 * 60 * 1000); // 30 min — Open-Meteo updates hourly
const calibCache = new Cache(60 * 60 * 1000); // 1 h  — historical, rarely changes

// calibCache is also keyed by the `days` parameter, so track that separately.
let calibCacheDays = 0;

function clearCache() { solarCache.clear(); calibCache.clear(); calibCacheDays = 0; }
onConfigSaved(clearCache);

// ---------------------------------------------------------------------------
// getSolarForecast
// ---------------------------------------------------------------------------
/**
 * Fetch hourly GTI-based PV forecast from Open-Meteo for today + tomorrow
 * plus yesterday (for calibration).
 *
 * Returns:
 *   { points, sunrises, sunsets, systemKw, efficiencyFactor }
 *
 * Each point: { t, gti, cloud, temp, predictedKw }
 * Sunrises/sunsets: [{ date, time }]  (time is a naive local ISO string)
 */
async function getSolarForecast() {
  const cached = solarCache.get();
  if (cached) return cached;

  const s  = config.solar;
  if (!s) throw new Error('config.solar missing');
  const tz = config.timezone || 'Australia/Melbourne';

  const url = `https://api.open-meteo.com/v1/forecast`
    + `?latitude=${s.latitude}&longitude=${s.longitude}`
    + `&hourly=global_tilted_irradiance,cloud_cover,temperature_2m`
    + `&daily=sunrise,sunset`
    + `&tilt=${s.tiltDegrees}&azimuth=${s.azimuthOpenMeteo}`
    + `&timezone=${encodeURIComponent(tz)}&past_days=1&forecast_days=2`;

  const d = JSON.parse(await httpsGetText(url));
  const h = d.hourly || {};
  const times = h.time || [];
  const gtis  = h.global_tilted_irradiance || [];
  const ccs   = h.cloud_cover || [];
  const temps = h.temperature_2m || [];

  const points = times.map((t, i) => ({
    t,
    gti        : gtis[i]  ?? 0,
    cloud      : ccs[i]   ?? null,
    temp       : temps[i] ?? null,
    // Simple PV model: output = (GTI / 1000) × systemKw × efficiency.
    // GTI already accounts for panel tilt and azimuth.
    predictedKw: Math.max(0, ((gtis[i] ?? 0) / 1000) * s.systemKw * s.efficiencyFactor),
  }));

  const daily      = d.daily || {};
  const dailyTimes = daily.time || [];
  const sunrises   = (daily.sunrise || []).map((t, i) => ({ date: dailyTimes[i], time: t }));
  const sunsets    = (daily.sunset  || []).map((t, i) => ({ date: dailyTimes[i], time: t }));

  return solarCache.set({ points, sunrises, sunsets, systemKw: s.systemKw, efficiencyFactor: s.efficiencyFactor });
}

// ---------------------------------------------------------------------------
// getSolarCalibration
// ---------------------------------------------------------------------------
/**
 * Compare the last `days` days of actual Fox generation against the
 * Open-Meteo GTI-derived ideal, returning per-day rows and a weighted
 * efficiency suggestion.
 *
 * The weighting is a linear regression through the origin:
 *   suggestedEfficiency = Σ(actual × ideal) / Σ(ideal²)
 * A bright 57 kWh day contributes ~10× more signal than a 6 kWh cloudy day.
 *
 * @param {number} days  1–30, default 14
 */
async function getSolarCalibration(days = 7) {
  if (calibCache.get() && calibCacheDays === days) return calibCache.get();

  const s  = config.solar;
  const tz = config.timezone || 'Australia/Melbourne';

  // --- GTI from Open-Meteo (past N days) ---
  const url = `https://api.open-meteo.com/v1/forecast`
    + `?latitude=${s.latitude}&longitude=${s.longitude}`
    + `&hourly=global_tilted_irradiance`
    + `&tilt=${s.tiltDegrees}&azimuth=${s.azimuthOpenMeteo}`
    + `&timezone=${encodeURIComponent(tz)}&past_days=${days}&forecast_days=0`;

  const weather    = JSON.parse(await httpsGetText(url));
  const byDayGTI   = {};
  const times      = weather.hourly?.time || [];
  const ghi        = weather.hourly?.global_tilted_irradiance || [];

  for (let i = 0; i < times.length; i++) {
    const day = times[i].slice(0, 10);
    byDayGTI[day] = (byDayGTI[day] || 0) + (ghi[i] || 0) / 1000; // kWh/kW (1-h intervals)
  }

  // --- Actual generation from Fox (dimension:'month' gives per-day totals) ---
  // Fox's `dimension:'day'` only retains ~4 days; `dimension:'month'` returns
  // the full month in one call with ~30-day retention.
  const today         = new Date();
  const monthsNeeded  = new Set();
  for (let offset = days; offset >= 1; offset--) {
    const d  = new Date(today);
    d.setDate(d.getDate() - offset);
    const lp = localParts(d, tz);
    monthsNeeded.add(`${lp.date.slice(0, 4)}-${Number(lp.date.slice(5, 7))}`);
  }

  const actualByDate = {};
  for (const key of monthsNeeded) {
    const [yy, mm] = key.split('-').map(Number);
    try {
      await throttleFox();
      const r      = await foxRequest('/op/v0/device/report/query', {
        sn: config.deviceSN, deviceSN: config.deviceSN,
        year: yy, month: mm, dimension: 'month', variables: ['generation'],
      });
      const parsed = JSON.parse(r.body);
      if (parsed?.errno === 0) {
        const row = (parsed.result || []).find((x) => x.variable === 'generation');
        (row?.values || []).forEach((v, i) => {
          const k = `${yy}-${String(mm).padStart(2, '0')}-${String(i + 1).padStart(2, '0')}`;
          actualByDate[k] = Number(v) || 0;
        });
      } else {
        console.warn(`solar calib: Fox errno=${parsed?.errno} msg=${parsed?.msg} for ${yy}-${mm}`);
      }
    } catch (e) {
      console.warn(`solar calib: fetch failed for ${yy}-${mm}: ${e.message}`);
    }
  }

  // --- Combine ---
  const results = [];
  for (let offset = days; offset >= 1; offset--) {
    const d    = new Date(today);
    d.setDate(d.getDate() - offset);
    const lp   = localParts(d, tz);
    const dateKey = lp.date;

    const actualKwh = actualByDate[dateKey] ?? null;
    const gtiSum    = byDayGTI[dateKey] || 0;
    const idealKwh  = gtiSum * s.systemKw;

    // Skip days before the commissioning start date (if configured), and days
    // with zero actual output (inverter not yet installed, or curtailed).
    const beforeStart       = s.calibrationStartDate && dateKey < s.calibrationStartDate;
    const measuredEfficiency = !beforeStart && idealKwh > 0 && actualKwh != null && actualKwh > 0
      ? actualKwh / idealKwh
      : null;

    results.push({ date: dateKey, actualKwh, idealKwh, measuredEfficiency, excluded: !!beforeStart });
  }

  // Weighted regression through origin: slope = Σ(actual × ideal) / Σ(ideal²)
  const valid = results.filter((r) =>
    r.measuredEfficiency != null && r.measuredEfficiency > 0 && r.measuredEfficiency < 1.5,
  );
  let num = 0, den = 0;
  for (const r of valid) { num += r.actualKwh * r.idealKwh; den += r.idealKwh * r.idealKwh; }
  const weightedEff = den > 0 ? num / den : null;

  calibCacheDays = days;
  return calibCache.set({
    days                : results,
    currentEfficiency   : s.efficiencyFactor,
    suggestedEfficiency : weightedEff != null ? Number(weightedEff.toFixed(3)) : null,
    sampleCount         : valid.length,
  });
}

// ---------------------------------------------------------------------------
// getSolarRemainingKwh
// ---------------------------------------------------------------------------
/**
 * Integrate the remaining predicted PV output from `from` until today's sunset.
 * Used by the recommendation engine to project battery state at dump time.
 *
 * @param {Date} from  Starting point (default: now)
 * @returns {Promise<number|null>}  kWh, or null if forecast is unavailable
 */
async function getSolarRemainingKwh(from = new Date()) {
  const s    = await getSolarForecast();
  const tz   = config.timezone || 'Australia/Melbourne';
  const today = localParts(from, tz).date;

  const sunsetEntry = s.sunsets.find((x) => x.date === today);
  if (!sunsetEntry) return null;

  const nowOrd    = localOrdinalFromDate(from, tz);
  const sunsetOrd = localOrdinalFromNaive(sunsetEntry.time);
  if (sunsetOrd == null || sunsetOrd <= nowOrd) return 0;

  let kwh = 0;
  for (const p of s.points) {
    const tOrd  = localOrdinalFromNaive(p.t);
    if (tOrd == null) continue;
    const endOrd = tOrd + 60; // 1-hour slice
    if (endOrd <= nowOrd)  continue;
    if (tOrd   >= sunsetOrd) break;
    const lo  = Math.max(nowOrd, tOrd);
    const hi  = Math.min(sunsetOrd, endOrd);
    const frac = (hi - lo) / 60;
    if (frac > 0) kwh += p.predictedKw * frac;
  }
  return kwh;
}

// ---------------------------------------------------------------------------
module.exports = { getSolarForecast, getSolarCalibration, getSolarRemainingKwh, clearCache };
