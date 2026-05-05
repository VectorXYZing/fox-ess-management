'use strict';

// Admin authentication and brute-force rate limiting.
// No lib/ imports — safe to require from anywhere.

const crypto = require('crypto');

// ---------------------------------------------------------------------------
// Admin password
// ---------------------------------------------------------------------------
const DEFAULT_ADMIN_PASSWORD = 'letpscontrol';

let ADMIN_PASSWORD           = process.env.ADMIN_PASSWORD || '';
let ADMIN_PASSWORD_GENERATED = false;

if (!ADMIN_PASSWORD) {
  ADMIN_PASSWORD           = crypto.randomBytes(12).toString('hex');
  ADMIN_PASSWORD_GENERATED = true;
}

/** True when the server is still using the well-known default password. */
function isDefaultPassword() {
  return ADMIN_PASSWORD === DEFAULT_ADMIN_PASSWORD;
}

/**
 * Constant-time comparison of the x-admin-password request header against
 * the configured password.  Returns true on match.
 */
function checkAdmin(req) {
  const given = req.headers['x-admin-password'] || '';
  if (!given || given.length !== ADMIN_PASSWORD.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(given), Buffer.from(ADMIN_PASSWORD));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// /api/settings/verify rate limiter
// ---------------------------------------------------------------------------
// Per-IP bucket: after MAX_FAILS failures in WINDOW_MS, require BACKOFF_MS
// before the next attempt.

const VERIFY_MAX_FAILS  = 5;
const VERIFY_WINDOW_MS  = 5 * 60 * 1000;  // 5 min window
const VERIFY_BACKOFF_MS = 30 * 1000;       // 30 s lock-out

const verifyFails = new Map(); // ip → { fails: number[], nextAllowedAt: number }

/** Extract the real client IP from X-Forwarded-For or the socket. */
function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff) return String(xff).split(',')[0].trim();
  return req.socket.remoteAddress || 'unknown';
}

/**
 * Check whether the client is allowed to attempt a verify right now.
 * Returns { allowed: false, retryAfter } or { allowed: true, bucket, ip }.
 */
function verifyCheck(req) {
  const ip  = clientIp(req);
  const now = Date.now();
  const b   = verifyFails.get(ip) || { fails: [], nextAllowedAt: 0 };
  if (now < b.nextAllowedAt) {
    return { allowed: false, retryAfter: Math.ceil((b.nextAllowedAt - now) / 1000) };
  }
  b.fails = b.fails.filter((t) => now - t < VERIFY_WINDOW_MS);
  return { allowed: true, bucket: b, ip };
}

/**
 * Record the outcome of a verify attempt.
 * On success the bucket is cleared; on failure it accumulates toward lock-out.
 */
function verifyRecord(bucket, ip, success) {
  if (success) { verifyFails.delete(ip); return; }
  const now = Date.now();
  bucket.fails.push(now);
  if (bucket.fails.length >= VERIFY_MAX_FAILS) {
    bucket.nextAllowedAt = now + VERIFY_BACKOFF_MS;
    bucket.fails         = [];
  }
  verifyFails.set(ip, bucket);
}

// ---------------------------------------------------------------------------
module.exports = {
  ADMIN_PASSWORD_GENERATED,
  isDefaultPassword,
  checkAdmin,
  clientIp,
  verifyCheck,
  verifyRecord,
};
