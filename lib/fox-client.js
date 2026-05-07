'use strict';

// Fox ESS Open API client.
// Handles HMAC signing, per-endpoint response caching, a proper serial
// throttle queue (min 2 s between calls), and the full proxy-request path
// including inflight deduplication for read endpoints.

const https  = require('https');
const crypto = require('crypto');
const { config, onConfigSaved } = require('./config');

const FOX_HOST = 'www.foxesscloud.com';

// ---------------------------------------------------------------------------
// Per-endpoint cache TTLs (ms)
// ---------------------------------------------------------------------------
// Read endpoints get a short TTL so multiple browser tabs share one upstream
// fetch. Write endpoints (not listed here, TTL = 0) bypass the cache entirely
// and flush it on completion.
const FOX_CACHE_TTL = {
  '/op/v0/device/real/query'         :  25_000,  // live — client polls ~60 s, cache 25 s
  '/op/v1/device/real/query'         :  25_000,  // v1 equivalent (sns array body)
  '/op/v0/device/report/query'       : 300_000,  // today totals — 5 min
  '/op/v3/device/scheduler/get'      : 120_000,  // scheduler read — 2 min (current)
  '/op/v1/device/scheduler/get'      : 120_000,  // kept for diagnose / fallback
  '/op/v1/device/scheduler/get/flag' : 120_000,
  '/op/v0/device/scheduler/get'      : 120_000,  // kept for diagnose
  // Battery-info probes used by the diagnose page to find a battery temp endpoint.
  '/op/v0/device/battery/info'       :  60_000,
  '/op/v0/device/battery/info/get'   :  60_000,
  '/op/v0/device/bms/info'           :  60_000,
  '/op/v0/device/battery/soc/get'    :  60_000,
  '/op/v1/device/battery/info'       :  60_000,
  '/op/v0/device/list'               : 600_000,
};

// ---------------------------------------------------------------------------
// Response cache
// ---------------------------------------------------------------------------
// Map<cacheKey, { at, body, status } | { at: 0, inflight: Promise }>
// The `inflight` field lets concurrent requests for the same key share a
// single upstream fetch instead of all firing independently.
const foxCache = new Map();

function clearCache() { foxCache.clear(); }
onConfigSaved(clearCache);

// ---------------------------------------------------------------------------
// Serial throttle queue
// ---------------------------------------------------------------------------
// Fox Open API: ~1440/day, ~30/min per key.  We enforce a minimum 2-second
// gap between consecutive calls by chaining each call onto the previous one.
// The old code declared a `foxQueue` array that was never actually used —
// this replaces it with a correct promise-chain approach.

const FOX_MIN_INTERVAL_MS = 2000;
let foxLastCallAt     = 0;
let foxThrottleChain  = Promise.resolve();

function throttleFox() {
  // Append to the chain: each caller waits for the previous caller's gap to
  // elapse before taking its own slot.
  const slot = foxThrottleChain.then(
    () => new Promise((resolve) => {
      const wait = Math.max(0, FOX_MIN_INTERVAL_MS - (Date.now() - foxLastCallAt));
      setTimeout(() => { foxLastCallAt = Date.now(); resolve(); }, wait);
    }),
  );
  // Swallow errors so a failed call doesn't permanently break the chain.
  foxThrottleChain = slot.catch(() => {});
  return slot;
}

// ---------------------------------------------------------------------------
// Low-level Fox API request
// ---------------------------------------------------------------------------
/**
 * POST to the Fox ESS Open API with correct HMAC signature headers.
 * Returns { status, body } (raw string body).
 */
function foxRequest(apiPath, body) {
  return new Promise((resolve, reject) => {
    const timestamp = Date.now().toString();
    const payload   = body ? JSON.stringify(body) : '';

    // Fox Open API wants the LITERAL 4-char sequence \r\n (backslash-r-backslash-n)
    // as separator — not actual CR/LF bytes.
    const signature = crypto
      .createHash('md5')
      .update(`${apiPath}\\r\\n${config.foxApiKey}\\r\\n${timestamp}`)
      .digest('hex');

    const req = https.request(
      {
        host  : FOX_HOST,
        path  : apiPath,
        method: 'POST',
        headers: {
          'Content-Type'  : 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          token           : config.foxApiKey,
          timestamp,
          lang            : 'en',
          signature,
        },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode, body: data }));
      },
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// High-level proxy request (used by the HTTP server route)
// ---------------------------------------------------------------------------
/**
 * Handle a proxied Fox request with caching and inflight deduplication.
 *
 * For read endpoints (TTL > 0):
 *   - Returns a cached response if still fresh.
 *   - Shares an in-progress fetch if one is already running.
 *   - Otherwise fetches, caches, and returns.
 *
 * For write endpoints (TTL = 0):
 *   - Fetches immediately (throttled), clears the entire cache, returns
 *     { body, isWrite: true } so the caller can fire notifications.
 *
 * @returns {Promise<{ body: string, isWrite?: boolean }>}
 */
async function proxyFoxRequest(foxPath, body) {
  const ttl      = FOX_CACHE_TTL[foxPath] || 0;
  const cacheKey = foxPath + '|' + JSON.stringify(body);

  // --- Cache hit ---
  if (ttl > 0) {
    const hit = foxCache.get(cacheKey);
    if (hit && hit.at && Date.now() - hit.at < ttl) {
      return { body: hit.body };
    }
    // Inflight deduplication: piggyback on an in-progress fetch.
    if (hit?.inflight) {
      const shared = await hit.inflight;
      return { body: shared.body };
    }
  }

  // --- Fetch helper (shared between read + write paths) ---
  const fetchOnce = async () => {
    await throttleFox();
    const r = await foxRequest(foxPath, body);
    let parsed;
    try { parsed = JSON.parse(r.body); } catch { parsed = null; }
    const payload = parsed
      ? r.body
      : JSON.stringify({
          errno     : -1,
          msg       : `HTTP ${r.status} from Fox — ${r.body ? r.body.slice(0, 200) : 'empty body'}`,
          httpStatus: r.status,
        });
    if (ttl > 0) foxCache.set(cacheKey, { at: Date.now(), body: payload, status: r.status });
    return { body: payload };
  };

  // --- Read path: mark inflight, await, return ---
  if (ttl > 0) {
    const inflight = fetchOnce();
    foxCache.set(cacheKey, { at: 0, inflight });
    return inflight;
  }

  // --- Write path: fetch, clear cache ---
  const result = await fetchOnce();
  foxCache.clear();
  return { body: result.body, isWrite: true };
}

// ---------------------------------------------------------------------------
module.exports = {
  FOX_CACHE_TTL,
  foxCache,
  throttleFox,
  foxRequest,
  proxyFoxRequest,
  clearCache,
};
