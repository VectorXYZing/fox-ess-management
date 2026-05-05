// Fox ESS Management — HTTP server entry point.
// Run: node proxy.js   then open http://localhost:8080
//
// All domain logic lives in lib/. This file is intentionally thin:
// it wires up the HTTP server, maps routes to lib functions, and starts
// the background tickers.

'use strict';

const http = require('http');
const path = require('path');
const fs   = require('fs');

const { config, isConfigured, maskedConfig, saveConfig, SERVER_STARTED_AT } = require('./lib/config');
const auth        = require('./lib/auth');
const foxClient   = require('./lib/fox-client');
const aemo        = require('./lib/aemo');
const solar       = require('./lib/solar');
const socHistory  = require('./lib/soc-history');
const weekReport  = require('./lib/week-report');
const rec         = require('./lib/recommendation');
const { httpsGetJson }        = require('./lib/utils');
const { notifyAction }        = require('./lib/notifications');

// ---------------------------------------------------------------------------
// Background tickers
// ---------------------------------------------------------------------------
// Kick off after the server finishes starting to avoid racing config load.
setTimeout(rec.tick, 5000);
setInterval(rec.tick, rec.TICK_MS);

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------
function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end',  ()  => resolve(data));
  });
}

function send(res, status, body, contentType = 'application/json') {
  res.writeHead(status, {
    'Content-Type'                : contentType,
    'Access-Control-Allow-Origin' : '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  });
  res.end(body);
}

function serveStatic(filePath, res) {
  const ext   = path.extname(filePath).toLowerCase();
  const types = {
    '.html': 'text/html', '.js': 'application/javascript',
    '.css' : 'text/css',  '.json': 'application/json',
  };
  fs.readFile(filePath, (err, data) => {
    if (err) return send(res, 404, 'Not found', 'text/plain');
    const ct = types[ext] || 'application/octet-stream';
    // HTML is never cached — always fetch fresh so UI changes deploy immediately.
    const extra = ext === '.html' ? { 'Cache-Control': 'no-store' } : {};
    res.writeHead(200, { 'Content-Type': ct, ...extra });
    res.end(data);
  });
}

// ---------------------------------------------------------------------------
// Request handler
// ---------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return send(res, 204, '');

  try {

    // --- Fox ESS proxy (per-endpoint cache + serial rate limit) ------------
    if (req.url.startsWith('/api/fox/')) {
      if (!isConfigured()) {
        return send(res, 503, JSON.stringify({
          errno         : -1,
          msg           : 'Fox ESS API key or device SN not configured. Open Settings to configure.',
          notConfigured : true,
        }));
      }

      const foxPath = '/' + req.url.slice('/api/fox/'.length);

      // Non-read (write) paths mutate device state — require admin password.
      if (!(foxPath in foxClient.FOX_CACHE_TTL) && !auth.checkAdmin(req)) {
        return send(res, 401, JSON.stringify({
          errno    : -1,
          msg      : 'Admin password required for this action.',
          needAdmin: true,
        }));
      }

      const raw  = await readBody(req);
      const body = raw ? JSON.parse(raw) : {};
      if (!body.sn && !body.deviceSN) body.sn = config.deviceSN;
      body.deviceSN = body.deviceSN || body.sn || config.deviceSN;
      // v1 real/query uses sns (array) instead of sn (string) — inject both forms.
      if (!body.sns) body.sns = [body.deviceSN];

      const { body: out, isWrite } = await foxClient.proxyFoxRequest(foxPath, body);

      if (isWrite) {
        try { notifyAction(foxPath, body, JSON.parse(out)); } catch {}
      }
      return send(res, 200, out);
    }

    // --- Non-secret config summary (used by the UI on load) ----------------
    if (req.url === '/api/config') {
      return send(res, 200, JSON.stringify({
        aemoRegion    : config.aemoRegion,
        pollSeconds   : config.pollSeconds,
        pricePollSeconds: config.pricePollSeconds,
        deviceSN      : config.deviceSN,
        flowPowerMarkup: config.flowPowerMarkup,
        battery       : config.battery,
        solar         : { systemKw: config.solar?.systemKw },
        configured    : isConfigured(),
        serverStartedAt: SERVER_STARTED_AT,
      }));
    }

    // --- Settings (admin-gated full config read/write) ----------------------
    if (req.url === '/api/settings' && req.method === 'GET') {
      if (!auth.checkAdmin(req)) return send(res, 401, JSON.stringify({ error: 'bad admin password' }));
      const cfg            = maskedConfig();
      cfg.__defaultPassword = auth.isDefaultPassword();
      return send(res, 200, JSON.stringify(cfg));
    }

    if (req.url === '/api/settings' && req.method === 'POST') {
      if (!auth.checkAdmin(req)) return send(res, 401, JSON.stringify({ error: 'bad admin password' }));
      const raw = await readBody(req);
      let incoming;
      try   { incoming = JSON.parse(raw); }
      catch { return send(res, 400, JSON.stringify({ error: 'invalid JSON' })); }
      // If the UI sent the masked placeholder, keep the existing key.
      if (!incoming.foxApiKey || String(incoming.foxApiKey).startsWith('••••')) {
        incoming.foxApiKey = config.foxApiKey;
      }
      if (typeof incoming.foxApiKey !== 'string' || typeof incoming.deviceSN !== 'string') {
        return send(res, 400, JSON.stringify({ error: 'foxApiKey and deviceSN must be strings' }));
      }
      try   { saveConfig(incoming); }
      catch (e) { return send(res, 500, JSON.stringify({ error: 'failed to save: ' + e.message })); }
      return send(res, 200, JSON.stringify({ ok: true, configured: isConfigured() }));
    }

    // --- Admin password check (rate-limited) --------------------------------
    if (req.url === '/api/settings/verify' && req.method === 'POST') {
      const gate = auth.verifyCheck(req);
      if (!gate.allowed) {
        return send(res, 429, JSON.stringify({ error: 'too many attempts', retryAfter: gate.retryAfter }));
      }
      const ok = auth.checkAdmin(req);
      auth.verifyRecord(gate.bucket, gate.ip, ok);
      return send(res, ok ? 200 : 401, JSON.stringify({ ok }));
    }

    // --- Push notification test (admin-only) --------------------------------
    if (req.url === '/api/notify/test' && req.method === 'POST') {
      if (!auth.checkAdmin(req)) return send(res, 401, JSON.stringify({ error: 'admin required' }));
      const { postNtfy } = require('./lib/notifications');
      if (!config.notifications?.ntfyTopic) {
        return send(res, 400, JSON.stringify({ error: 'notifications.ntfyTopic not set' }));
      }
      postNtfy('Fox ESS', 'Test notification — if you see this, notifications are wired up.');
      return send(res, 200, JSON.stringify({ ok: true }));
    }

    // --- AEMO live 5-min summary (all regions) ------------------------------
    if (req.url === '/api/aemo/current') {
      const r = await httpsGetJson('https://visualisations.aemo.com.au/aemo/apps/api/report/ELEC_NEM_SUMMARY');
      return send(res, r.status, r.body);
    }

    // --- AEMO 14-hour dispatch history (30-min spaced) ----------------------
    if (req.url === '/api/aemo/history') {
      try {
        const rows = await aemo.fetchHistoryForRegion(config.aemoRegion);
        return send(res, 200, JSON.stringify(rows));
      } catch (e) {
        return send(res, 500, JSON.stringify({ error: e.message, source: 'nemweb-dispatch' }));
      }
    }

    // --- AEMO 30-min predispatch forecast (~20 h ahead) ---------------------
    if (req.url === '/api/aemo/forecast') {
      try {
        const rows = await aemo.fetchForecastForRegion(config.aemoRegion);
        return send(res, 200, JSON.stringify(rows));
      } catch (e) {
        return send(res, 500, JSON.stringify({ error: e.message, source: 'nemweb-predispatch' }));
      }
    }

    // --- Solar PV forecast (Open-Meteo) -------------------------------------
    if (req.url === '/api/solar') {
      try {
        return send(res, 200, JSON.stringify(await solar.getSolarForecast()));
      } catch (e) {
        return send(res, 500, JSON.stringify({ error: e.message, source: 'open-meteo' }));
      }
    }

    // --- Solar calibration (last N days actual vs ideal) --------------------
    if (req.url.startsWith('/api/solar/calibration')) {
      if (!isConfigured()) return send(res, 503, JSON.stringify({ error: 'not configured', notConfigured: true }));
      const u    = new URL(req.url, 'http://x');
      const days = Math.max(1, Math.min(30, Number(u.searchParams.get('days')) || 14));
      try {
        return send(res, 200, JSON.stringify(await solar.getSolarCalibration(days)));
      } catch (e) {
        return send(res, 500, JSON.stringify({ error: e.message }));
      }
    }

    // --- Daily min-SoC history (snapshots + Fox backfill) -------------------
    if (req.url.startsWith('/api/soc-history') && req.method !== 'POST') {
      const u    = new URL(req.url, 'http://x');
      const days = Math.max(1, Math.min(30, Number(u.searchParams.get('days')) || 7));
      try {
        return send(res, 200, JSON.stringify(await socHistory.getSocHistory(days)));
      } catch (e) {
        return send(res, 500, JSON.stringify({ error: e.message }));
      }
    }

    // --- Manual SoC snapshot (admin-only, for testing) ----------------------
    if (req.url === '/api/soc-history/snapshot' && req.method === 'POST') {
      if (!auth.checkAdmin(req)) return send(res, 401, JSON.stringify({ error: 'admin required' }));
      const entry = await socHistory.takeSnapshot();
      socHistory.clearCache();
      return send(res, 200, JSON.stringify(entry || { error: 'snapshot failed' }));
    }

    // --- Last N days of daily energy totals ---------------------------------
    if (req.url.startsWith('/api/report/week')) {
      if (!isConfigured()) return send(res, 503, JSON.stringify({ error: 'not configured' }));
      const u    = new URL(req.url, 'http://x');
      const days = Math.max(1, Math.min(30, Number(u.searchParams.get('days')) || 7));
      try {
        return send(res, 200, JSON.stringify(await weekReport.getWeekReport(days)));
      } catch (e) {
        return send(res, 500, JSON.stringify({ error: e.message }));
      }
    }

    // --- Midday top-up recommendation (read-only) ---------------------------
    if (req.url === '/api/recommendation') {
      try {
        return send(res, 200, JSON.stringify(await rec.getRecommendation()));
      } catch (e) {
        return send(res, 500, JSON.stringify({ error: e.message }));
      }
    }

    // --- Static: dashboard --------------------------------------------------
    if (req.url === '/' || req.url === '/index.html') {
      return serveStatic(path.join(__dirname, 'index.html'), res);
    }

    send(res, 404, 'Not found', 'text/plain');

  } catch (err) {
    console.error(err);
    send(res, 500, JSON.stringify({ error: err.message }));
  }
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
const PORT = Number(process.env.PORT) || config.port || 8080;
server.listen(PORT, () => {
  console.log(`Fox ESS dashboard running at http://localhost:${PORT}`);
  console.log(`Region: ${config.aemoRegion}   Device SN: ${config.deviceSN || '(not set)'}`);
  if (auth.ADMIN_PASSWORD_GENERATED) {
    console.warn('\n[!] No ADMIN_PASSWORD env var set — generated a temporary one:');
    console.warn('    Check the startup log for the generated password.');
    console.warn('    Set ADMIN_PASSWORD in the environment to make this persistent.\n');
  }
  if (!isConfigured()) {
    console.warn(`[!] Fox ESS not configured. Open http://localhost:${PORT} and click the Settings (⚙) button.\n`);
  }
  socHistory.scheduleNextLockin();
});
