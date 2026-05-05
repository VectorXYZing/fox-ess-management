'use strict';

// Midday top-up recommendation engine (read-only advisor).
//
// Each tick (default every 15 min, only active 10:30–14:30 local) the engine:
//   1. Reads the current battery SoC from Fox live telemetry.
//   2. Integrates remaining solar from the Open-Meteo forecast.
//   3. Estimates overnight house load from a rolling N-day average.
//   4. Computes a surplus/shortfall against a full evening dump + reserve.
//   5. If short, checks the AEMO forecast for a cheap midday charge window.
//   6. Produces a headline, subline, and full plain-English narrative.
//
// The engine NEVER writes to Fox.

const { config, onConfigSaved }   = require('./config');
const { throttleFox, foxRequest } = require('./fox-client');
const { fetchForecastForRegion }  = require('./aemo');
const { getSolarForecast, getSolarRemainingKwh } = require('./solar');
const {
  Cache,
  localParts, parseAEMODate, inHoursRange,
  hhmmToMin, minToHHMM, round1,
  localOrdinalFromNaive, localOrdinalFromDate,
} = require('./utils');

// ---------------------------------------------------------------------------
// Caches
// ---------------------------------------------------------------------------
const recommendationCache = new Cache(15 * 60 * 1000);
const loadCache           = new Cache(6 * 60 * 60 * 1000); // rolling avg — 6 h

function clearCache() { recommendationCache.clear(); loadCache.clear(); }
onConfigSaved(clearCache);

const TICK_MS = 15 * 60 * 1000;

// ---------------------------------------------------------------------------
// recConfig — read the recommendation section of config
// ---------------------------------------------------------------------------
function recConfig() {
  const r = config.recommendation || {};
  return {
    enabled                  : r.enabled !== false,
    reserveSoCPct            : Number(r.reserveSoCPct        ?? 20),
    dumpStart                : r.dumpWindowLocal?.start       || '17:30',
    dumpEnd                  : r.dumpWindowLocal?.end         || '19:30',
    topUpSearchStart         : r.topUpSearchLocal?.start      || '10:00',
    topUpSearchEnd           : r.topUpSearchLocal?.end        || '15:00',
    activeStart              : r.activeWindowLocal?.start     || '10:30',
    activeEnd                : r.activeWindowLocal?.end       || '14:30',
    loadDays                 : Math.max(1, Math.min(30, Number(r.loadDays) || 7)),
    safetyMarginPct          : Number(r.safetyMarginPct       ?? 10),
    minTopupKwh              : Number(r.minTopupKwh           ?? 1.0),
    minNetImprovementDollars : Number(r.minNetImprovementDollars ?? 0.20),
    peakFeedInCentsPerKwh    : Number(r.peakFeedInCentsPerKwh ?? 35),
    allowGridCharging        : r.allowGridCharging === true,
    timezone                 : config.timezone || 'Australia/Melbourne',
    batteryCapacityKwh       : Number(config.battery?.capacityKwh)        || 10,
    maxDischargeKw           : Number(config.battery?.maxDischargeKw)      || 5,
    maxChargeKw              : Number(config.battery?.maxChargeKw)         || 5,
    roundTripEfficiency      : Number(config.battery?.roundTripEfficiency  ?? 0.85),
  };
}

// ---------------------------------------------------------------------------
// avgFlatCentsForWindow — TOU markup for a given time window
// ---------------------------------------------------------------------------
function avgFlatCentsForWindow(startMin, endMin) {
  const tou = config.flowPowerMarkup?.tou;
  if (!tou) return 0;
  const midHour = Math.floor(((startMin + endMin) / 2) / 60);
  for (const block of Object.values(tou)) {
    if (!block?.hours) continue;
    if (inHoursRange(midHour, block.hours)) return Number(block.flatCentsPerKwh) || 0;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// getAvgDailyLoadKwh — rolling average house load
// ---------------------------------------------------------------------------
async function getAvgDailyLoadKwh() {
  const cached = loadCache.get();
  if (cached) return cached;

  const { loadDays, timezone } = recConfig();
  const today         = new Date();
  const monthsNeeded  = new Set();
  for (let off = loadDays; off >= 1; off--) {
    const d  = new Date(today); d.setDate(d.getDate() - off);
    const lp = localParts(d, timezone);
    monthsNeeded.add(`${lp.date.slice(0, 4)}-${Number(lp.date.slice(5, 7))}`);
  }

  const byDate = {};
  for (const key of monthsNeeded) {
    const [yy, mm] = key.split('-').map(Number);
    try {
      await throttleFox();
      const r      = await foxRequest('/op/v0/device/report/query', {
        sn: config.deviceSN, deviceSN: config.deviceSN,
        year: yy, month: mm, dimension: 'month', variables: ['loads'],
      });
      const parsed = JSON.parse(r.body);
      if (parsed?.errno !== 0) {
        console.warn(`rec: load fetch errno=${parsed?.errno} msg=${parsed?.msg} for ${yy}-${mm}`);
        continue;
      }
      const row = (parsed.result || []).find((x) => x.variable === 'loads');
      (row?.values || []).forEach((v, i) => {
        const k = `${yy}-${String(mm).padStart(2, '0')}-${String(i + 1).padStart(2, '0')}`;
        byDate[k] = Number(v) || 0;
      });
    } catch (e) {
      console.warn(`rec: load fetch failed for ${yy}-${mm}: ${e.message}`);
    }
  }

  const perDay = [];
  for (let off = loadDays; off >= 1; off--) {
    const d = new Date(today); d.setDate(d.getDate() - off);
    const k = localParts(d, timezone).date;
    if (byDate[k] != null) perDay.push({ date: k, kwh: byDate[k] });
  }
  const valid = perDay.filter((x) => x.kwh > 0);
  if (valid.length === 0) return null;
  const avg = valid.reduce((a, b) => a + b.kwh, 0) / valid.length;

  return loadCache.set({ avgKwh: avg, samples: valid.length, perDay });
}

// ---------------------------------------------------------------------------
// getCurrentSoC — live battery state of charge
// ---------------------------------------------------------------------------
async function getCurrentSoC() {
  await throttleFox();
  const r      = await foxRequest('/op/v0/device/real/query', {
    sn: config.deviceSN, deviceSN: config.deviceSN, variables: ['SoC'],
  });
  const parsed = JSON.parse(r.body);
  const soc    = parsed?.result?.[0]?.datas?.find?.((d) => d.variable === 'SoC')?.value;
  return typeof soc === 'number' ? soc : null;
}

// ---------------------------------------------------------------------------
// findCheapestWindow — AEMO forecast window search
// ---------------------------------------------------------------------------
/**
 * Find the cheapest contiguous `neededHours`-wide window in the AEMO
 * predispatch forecast that:
 *   - Falls inside the configured topUpSearch window today
 *   - Ends before the dump window starts
 *   - Is in the future
 *
 * @returns {{ startLocalMin, endLocalMin, startTs, endTs, avgRrp } | null}
 */
function findCheapestWindow(forecastRows, neededHours, cfg, nowDate) {
  const tz          = cfg.timezone;
  const nowLP       = localParts(nowDate, tz);
  const searchStart = hhmmToMin(cfg.topUpSearchStart);
  const searchEnd   = hhmmToMin(cfg.topUpSearchEnd);
  const dumpStart   = hhmmToMin(cfg.dumpStart);

  const candidates = [];
  for (const row of forecastRows) {
    const dt = parseAEMODate(row.DATETIME);
    if (isNaN(dt.getTime())) continue;
    const lp = localParts(dt, tz);
    if (lp.date !== nowLP.date)      continue;
    if (lp.minutes < searchStart)    continue;
    if (lp.minutes >= searchEnd)     continue;
    if (lp.minutes + 30 > dumpStart) continue;
    if (dt.getTime() <= nowDate.getTime()) continue;
    candidates.push({ t: dt.getTime(), localMin: lp.minutes, rrp: row.RRP });
  }
  candidates.sort((a, b) => a.t - b.t);

  const slots = Math.max(1, Math.ceil(neededHours * 2));
  if (candidates.length < slots) return null;

  let best = null;
  for (let i = 0; i + slots <= candidates.length; i++) {
    let contig = true;
    for (let j = 1; j < slots; j++) {
      if (candidates[i + j].t - candidates[i + j - 1].t !== 30 * 60 * 1000) {
        contig = false; break;
      }
    }
    if (!contig) continue;
    let sum = 0;
    for (let j = 0; j < slots; j++) sum += candidates[i + j].rrp;
    const avgRrp = sum / slots;
    if (!best || avgRrp < best.avgRrp) {
      best = {
        startLocalMin: candidates[i].localMin,
        endLocalMin  : candidates[i + slots - 1].localMin + 30,
        startTs      : candidates[i].t,
        endTs        : candidates[i + slots - 1].t + 30 * 60 * 1000,
        avgRrp,
      };
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// buildNarrative — plain-English summary
// ---------------------------------------------------------------------------
function buildNarrative(ctx) {
  const c      = ctx;
  const soc    = c.currentSoCPct;
  const sol    = round1(c.solarRemainingKwh);
  const dumpKwh = round1(c.expectedDumpKwh);
  const dumpRev = (c.expectedDumpRevenueDollars || 0).toFixed(2);

  if (c.action === 'none') {
    let line1 = `Battery's at ${soc}% with about ${sol} kWh of sun still expected — that's plenty to top it up before tonight.`;
    if (sol < 2) line1 = `Battery's at ${soc}% and the sun's almost done for the day, but you've already got enough to fuel the dump.`;
    const line2 = dumpKwh > 0
      ? `Tonight's automatic dump should send around ${dumpKwh} kWh to the grid for ~$${dumpRev}.`
      : `Battery's high enough that tonight's dump will run, but at ${soc}% it's already partly drained so the dump may be smaller.`;
    return `${line1} ${line2} Sit back — nothing to do.`;
  }

  if (c.action === 'topUp') {
    const t       = c.topUp || {};
    const w       = t.window || {};
    const cost    = (t.estimatedCostDollars || 0).toFixed(2);
    const fullKwh = round1(c.dumpAfterTopupKwh || 0);
    const fullRev = (c.dumpRevenueAfterDollars || 0).toFixed(2);
    const improve = (c.netImprovementDollars  || 0).toFixed(2);
    const breakEven = round1(c.breakEvenImportCents || 29.75);
    return `Solar's not quite enough today (battery ${soc}%, only ${sol} kWh more sun coming). `
      + `The cheapest midday window is ${w.start || '—'}–${w.end || '—'} at about ${t.avgRetailCentsPerKwh}¢/kWh, `
      + `well below your ${breakEven}¢ break-even. `
      + `Charge ${round1(t.kwh)} kWh during that window for ~$${cost}, and tonight's dump grows from `
      + `${dumpKwh} to ${fullKwh} kWh ($${fullRev}). Net improvement: +$${improve}.`;
  }

  if (c.action === 'solarShort') {
    const sh = round1(c.shortfallKwh);
    if (c.cheapestRetailCents != null) {
      return `Tough one — battery's ${sh} kWh short of a full dump, and the cheapest grid hour today is `
        + `${c.cheapestRetailCents}¢/kWh which is above your ${round1(c.breakEvenImportCents || 0)}¢ break-even. `
        + `Best to let the dump run smaller (~${dumpKwh} kWh, $${dumpRev}) and not import. Tomorrow may be cheaper.`;
    }
    if (c.cfg?.allowGridCharging) {
      return `Battery's ${sh} kWh short of a full dump. AEMO predispatch forecast wasn't available so I can't check `
        + `whether grid charging would be profitable right now. `
        + `The dump will still run with what you have (~${dumpKwh} kWh, $${dumpRev}). Try refreshing in a few minutes.`;
    }
    return `Battery's tracking ${sh} kWh short for a full dump and grid charging is disabled in your config. `
      + `The dump will still run with what you have (~${dumpKwh} kWh, $${dumpRev}) — `
      + `preserving your CPEA discount is worth more than chasing extra export revenue.`;
  }

  return '';
}

// ---------------------------------------------------------------------------
// computeRecommendation — core engine
// ---------------------------------------------------------------------------
async function computeRecommendation() {
  const cfg = recConfig();
  const now = new Date();

  if (!cfg.enabled)    return { action: 'disabled',      computedAt: now.toISOString() };
  if (!config.foxApiKey || !config.deviceSN) {
    return { action: 'error', error: 'not configured',  computedAt: now.toISOString() };
  }

  const nowLP        = localParts(now, cfg.timezone);
  const inActiveWindow = nowLP.minutes >= hhmmToMin(cfg.activeStart)
                      && nowLP.minutes <= hhmmToMin(cfg.activeEnd);

  // Post-dump short-circuit: between dump end and midnight, today's plan is
  // done.  Serve a quiet "complete" response rather than an alarming shortfall.
  if (nowLP.minutes >= hhmmToMin(cfg.dumpEnd)) {
    return {
      action       : 'postDump',
      computedAt   : now.toISOString(),
      inActiveWindow: false,
      headline     : 'Today\'s plan complete',
      subline      : 'The dump has run. Refreshes tomorrow morning around 10:30.',
      narrative    : 'Tonight\'s 5:30–7:30 pm dump has finished. The recommender goes quiet overnight and reactivates tomorrow morning when it has a fresh solar forecast and battery state to plan against.',
      netDollars   : null,
      expectedDumpKwh: null,
    };
  }

  // --- Gather inputs ---
  let currentSoCPct = null;
  try   { currentSoCPct = await getCurrentSoC(); }
  catch (e) { console.warn('rec: SoC fetch failed:', e.message); }

  const solarRemainingKwh = await getSolarRemainingKwh(now).catch((e) => {
    console.warn('rec: solar forecast failed:', e.message); return null;
  });

  const loadData   = await getAvgDailyLoadKwh().catch((e) => {
    console.warn('rec: load avg failed:', e.message); return null;
  });
  const avgLoadKwh = loadData?.avgKwh ?? null;

  if (currentSoCPct == null || solarRemainingKwh == null || avgLoadKwh == null) {
    return {
      action    : 'error',
      error     : 'missing inputs',
      computedAt: now.toISOString(),
      partial   : { currentSoCPct, solarRemainingKwh, avgLoadKwh, loadSamples: loadData?.samples ?? 0 },
    };
  }

  // --- Hours to tomorrow's sunrise ---
  const s            = await getSolarForecast();
  const tomorrow     = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  const tomorrowDate = localParts(tomorrow, cfg.timezone).date;
  const sunriseEntry = s.sunrises.find((x) => x.date === tomorrowDate);
  const nowOrd       = localOrdinalFromDate(now, cfg.timezone);
  const sunriseOrd   = sunriseEntry ? localOrdinalFromNaive(sunriseEntry.time) : null;
  const hoursToDawn  = sunriseOrd != null ? Math.max(1, (sunriseOrd - nowOrd) / 60) : 19;

  // --- Energy budget ---
  const usableNowKwh  = Math.max(0, ((currentSoCPct - cfg.reserveSoCPct) / 100) * cfg.batteryCapacityKwh);
  const loadToDawnKwh = avgLoadKwh * (hoursToDawn / 24);
  const dumpHours     = Math.max(0, (hhmmToMin(cfg.dumpEnd) - hhmmToMin(cfg.dumpStart)) / 60);
  const dumpTargetKwh = cfg.maxDischargeKw * dumpHours;
  const surplusKwh    = usableNowKwh + solarRemainingKwh - loadToDawnKwh - dumpTargetKwh;

  const inputs = {
    currentSoCPct, batteryCapacityKwh: cfg.batteryCapacityKwh,
    reserveSoCPct  : cfg.reserveSoCPct,
    solarRemainingKwh: round1(solarRemainingKwh),
    avgDailyLoadKwh: round1(avgLoadKwh),
    loadSamples    : loadData?.samples ?? 0,
    hoursToDawn    : round1(hoursToDawn),
    dumpTargetKwh  : round1(dumpTargetKwh),
    dumpWindowLocal: { start: cfg.dumpStart, end: cfg.dumpEnd },
    maxDischargeKw : cfg.maxDischargeKw,
  };
  const computed = {
    usableNowKwh : round1(usableNowKwh),
    loadToDawnKwh: round1(loadToDawnKwh),
    surplusKwh   : round1(surplusKwh),
  };

  // Expected dump revenue (before any top-up).
  const peakFiTcents           = cfg.peakFeedInCentsPerKwh;
  const expectedDumpKwh        = Math.max(0, Math.min(
    cfg.maxDischargeKw * dumpHours,
    (usableNowKwh + solarRemainingKwh) * cfg.roundTripEfficiency,
  ));
  const expectedDumpRevenueDollars = (expectedDumpKwh * peakFiTcents) / 100;

  // --- Surplus: no action needed ---
  if (surplusKwh >= 0) {
    return {
      action    : 'none', computedAt: now.toISOString(), inActiveWindow, inputs, computed,
      expectedDumpKwh: round1(expectedDumpKwh),
      expectedDumpRevenueDollars: Number(expectedDumpRevenueDollars.toFixed(2)),
      netDollars: Number(expectedDumpRevenueDollars.toFixed(2)),
      headline  : 'No action needed',
      subline   : 'Battery on track — automatic dump will run 17:30–19:30.',
      narrative : buildNarrative({ action: 'none', cfg, currentSoCPct, solarRemainingKwh, expectedDumpKwh, expectedDumpRevenueDollars }),
    };
  }

  // --- Shortfall ---
  const shortfallKwh        = Math.abs(surplusKwh) * (1 + cfg.safetyMarginPct / 100);
  const neededHours         = shortfallKwh / cfg.maxChargeKw;
  const breakEvenImportCents = cfg.peakFeedInCentsPerKwh * cfg.roundTripEfficiency;

  const effectiveImportForOutput = Number(config.billing?.effectiveImportCentsPerKwh);
  const arbitrage = {
    peakFeedInCentsPerKwh      : cfg.peakFeedInCentsPerKwh,
    roundTripEfficiency        : cfg.roundTripEfficiency,
    breakEvenImportCentsPerKwh : round1(breakEvenImportCents),
    effectiveImportCentsPerKwh : Number.isFinite(effectiveImportForOutput) && effectiveImportForOutput > 0
      ? effectiveImportForOutput : null,
  };

  // If grid-charging is disabled, report solarShort immediately.
  if (!cfg.allowGridCharging) {
    return {
      action    : 'solarShort', computedAt: now.toISOString(), inActiveWindow, inputs, computed,
      shortfallKwh: round1(shortfallKwh), arbitrage,
      expectedDumpKwh: round1(expectedDumpKwh),
      expectedDumpRevenueDollars: Number(expectedDumpRevenueDollars.toFixed(2)),
      netDollars: Number(expectedDumpRevenueDollars.toFixed(2)),
      headline  : 'Skip — grid top-up unprofitable',
      subline   : `Battery short ${round1(shortfallKwh)} kWh but charging from grid would lose money.`,
      narrative : buildNarrative({ action: 'solarShort', cfg, currentSoCPct, solarRemainingKwh, expectedDumpKwh, expectedDumpRevenueDollars, shortfallKwh }),
      note      : `Grid charging disabled (config.recommendation.allowGridCharging=false).`,
    };
  }

  // --- Check AEMO forecast for a cheap window ---
  const effectiveImport = Number(config.billing?.effectiveImportCentsPerKwh);
  const useEffective    = Number.isFinite(effectiveImport) && effectiveImport > 0;

  let topUp            = null;
  let cheapestRetailCents = null;
  let forecastNote     = null;

  try {
    const rows = await fetchForecastForRegion(config.aemoRegion);
    if (!rows || rows.length === 0) {
      forecastNote = 'AEMO forecast unavailable; cannot assess arbitrage.';
    } else {
      const w = findCheapestWindow(rows, neededHours, cfg, now);
      if (!w) {
        const tu = `${cfg.topUpSearchStart}–${cfg.topUpSearchEnd}`;
        forecastNote = `Past today's top-up window (${tu}); top-up only runs midday.`;
      } else {
        const avgSpotCentsPerKwh = w.avgRrp / 10;
        const markup             = config.flowPowerMarkup || {};
        const retailCentsPerKwh  = useEffective
          ? effectiveImport
          : avgSpotCentsPerKwh * (markup.lossFactor || 0)
            + avgFlatCentsForWindow(w.startLocalMin, w.endLocalMin);
        cheapestRetailCents = round1(retailCentsPerKwh);
        const profitable = retailCentsPerKwh < breakEvenImportCents;

        if (profitable) {
          const estimatedCostDollars = (retailCentsPerKwh / 100) * shortfallKwh;
          const targetSoCPct         = Math.min(100, Math.round(
            currentSoCPct + (shortfallKwh / cfg.batteryCapacityKwh) * 100,
          ));
          topUp = {
            kwh         : round1(shortfallKwh),
            targetSoCPct,
            window: {
              start   : minToHHMM(w.startLocalMin),
              end     : minToHHMM(w.endLocalMin),
              startIso: new Date(w.startTs).toISOString(),
              endIso  : new Date(w.endTs).toISOString(),
            },
            avgSpotCentsPerKwh  : round1(avgSpotCentsPerKwh),
            avgRetailCentsPerKwh: round1(retailCentsPerKwh),
            estimatedCostDollars: Number(estimatedCostDollars.toFixed(2)),
            estimatedNetCentsPerKwh: round1(breakEvenImportCents - retailCentsPerKwh),
          };
        }
      }
    }
  } catch (e) {
    console.warn('rec: AEMO forecast failed for top-up window:', e.message);
    forecastNote = 'AEMO forecast unavailable; cannot assess arbitrage.';
  }

  // --- Profitable top-up found ---
  if (topUp) {
    const dumpAfterTopupKwh       = Math.min(
      cfg.maxDischargeKw * dumpHours,
      (usableNowKwh + solarRemainingKwh + shortfallKwh) * cfg.roundTripEfficiency,
    );
    const dumpRevenueAfterDollars  = (dumpAfterTopupKwh * peakFiTcents) / 100;
    const netAfterDollars          = dumpRevenueAfterDollars - (topUp.estimatedCostDollars || 0);
    const netImprovementDollars    = netAfterDollars - expectedDumpRevenueDollars;

    // Deadband: skip if the gain is inside forecast noise.
    const tooSmall    = shortfallKwh < cfg.minTopupKwh;
    const tooMarginal = netImprovementDollars < cfg.minNetImprovementDollars;
    if (tooSmall || tooMarginal) {
      return {
        action    : 'none', computedAt: now.toISOString(), inActiveWindow, inputs, computed,
        expectedDumpKwh: round1(expectedDumpKwh),
        expectedDumpRevenueDollars: Number(expectedDumpRevenueDollars.toFixed(2)),
        netDollars: Number(expectedDumpRevenueDollars.toFixed(2)),
        headline  : 'No action needed',
        subline   : `Battery marginally short — gap (${round1(shortfallKwh)} kWh) inside forecast noise.`,
        narrative : `Battery's marginally short of a full dump (~${round1(shortfallKwh)} kWh, $${netImprovementDollars.toFixed(2)} potential gain) but that's inside the noise of the load/solar forecasts. Not worth grid-charging. Tonight's automatic dump should still send around ${round1(expectedDumpKwh)} kWh for ~$${expectedDumpRevenueDollars.toFixed(2)}.`,
        marginalShortfallKwh        : round1(shortfallKwh),
        marginalGainSkippedDollars  : Number(netImprovementDollars.toFixed(2)),
      };
    }

    return {
      action    : 'topUp', computedAt: now.toISOString(), inActiveWindow,
      inputs, computed, shortfallKwh: round1(shortfallKwh), arbitrage, topUp,
      expectedDumpKwh: round1(expectedDumpKwh),
      expectedDumpRevenueDollars: Number(expectedDumpRevenueDollars.toFixed(2)),
      dumpAfterTopupKwh: round1(dumpAfterTopupKwh),
      netDollars: Number(netAfterDollars.toFixed(2)),
      netImprovementDollars: Number(netImprovementDollars.toFixed(2)),
      headline  : `Top up ${round1(shortfallKwh)} kWh from grid at ${topUp.window?.start || '—'}`,
      subline   : `Adds $${netImprovementDollars.toFixed(2)} to today's net vs doing nothing.`,
      narrative : buildNarrative({ action: 'topUp', cfg, currentSoCPct, solarRemainingKwh, expectedDumpKwh, expectedDumpRevenueDollars, topUp, dumpAfterTopupKwh, dumpRevenueAfterDollars, netImprovementDollars, breakEvenImportCents }),
    };
  }

  // --- No profitable window ---
  return {
    action    : 'solarShort', computedAt: now.toISOString(), inActiveWindow,
    inputs, computed, shortfallKwh: round1(shortfallKwh), arbitrage,
    cheapestWindowRetailCentsPerKwh: cheapestRetailCents,
    expectedDumpKwh: round1(expectedDumpKwh),
    expectedDumpRevenueDollars: Number(expectedDumpRevenueDollars.toFixed(2)),
    netDollars: Number(expectedDumpRevenueDollars.toFixed(2)),
    headline  : 'Solar short — no profitable top-up',
    subline   : cheapestRetailCents != null
      ? `Cheapest midday retail ${cheapestRetailCents}¢ vs ${round1(breakEvenImportCents)}¢ break-even.`
      : 'AEMO forecast unavailable.',
    narrative : buildNarrative({ action: 'solarShort', cfg, currentSoCPct, solarRemainingKwh, expectedDumpKwh, expectedDumpRevenueDollars, shortfallKwh, cheapestRetailCents, breakEvenImportCents }),
    note      : cheapestRetailCents != null
      ? `Cheapest midday retail ≈ ${cheapestRetailCents} c/kWh ≥ break-even ${round1(breakEvenImportCents)} c/kWh.`
      : (forecastNote || 'AEMO forecast unavailable; cannot assess arbitrage.'),
  };
}

// ---------------------------------------------------------------------------
// Polling ticker
// ---------------------------------------------------------------------------
/**
 * Called on a 15-min interval.  Only recomputes during the active window
 * (default 10:30–14:30 local), and keeps serving today's last value outside
 * of it so the UI always has something to show.
 */
async function tick() {
  try {
    const cfg    = recConfig();
    if (!cfg.enabled) return;
    const now    = new Date();
    const nowMin = localParts(now, cfg.timezone).minutes;

    if (nowMin < hhmmToMin(cfg.activeStart) || nowMin > hhmmToMin(cfg.activeEnd)) {
      // Outside active window: keep today's cached value, but clear if it's a
      // new day so we don't show yesterday's recommendation.
      if (recommendationCache.get()) {
        const cachedDate = localParts(new Date(recommendationCache.at), cfg.timezone).date;
        if (cachedDate === localParts(now, cfg.timezone).date) return;
      }
    }
    const rec = await computeRecommendation();
    recommendationCache.set(rec);
  } catch (e) {
    console.warn('rec: tick failed:', e.message);
  }
}

// ---------------------------------------------------------------------------
// getRecommendation — used by the /api/recommendation route
// ---------------------------------------------------------------------------
async function getRecommendation() {
  const cached = recommendationCache.get();
  if (cached) return cached;
  const rec = await computeRecommendation();
  return recommendationCache.set(rec);
}

// ---------------------------------------------------------------------------
module.exports = {
  recConfig,
  getRecommendation,
  computeRecommendation,
  tick,
  clearCache,
  TICK_MS,
};
