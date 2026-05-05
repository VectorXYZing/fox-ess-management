'use strict';

// Shared pure helpers used across modules.
// No lib/ imports — safe to require from anywhere without circular deps.

const https = require('https');
const zlib  = require('zlib');

// ---------------------------------------------------------------------------
// Generic TTL cache
// ---------------------------------------------------------------------------
// Replaces the nine ad-hoc { data, at, ttl } objects that were scattered
// through the original proxy.js.
class Cache {
  constructor(ttlMs) {
    this.ttl  = ttlMs;
    this.data = null;
    this.at   = 0;
  }
  /** Return cached value if still fresh, otherwise null. */
  get() {
    return this.data !== null && Date.now() - this.at < this.ttl
      ? this.data
      : null;
  }
  /** Store a value and stamp the time. Returns the stored value. */
  set(v) { this.data = v; this.at = Date.now(); return v; }
  /** Invalidate so the next get() misses. */
  clear() { this.data = null; this.at = 0; }
}

// ---------------------------------------------------------------------------
// CSV parser (handles quoted fields)
// ---------------------------------------------------------------------------
function csvSplit(line) {
  const cols = []; let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"')          { q = !q; continue; }
    if (c === ',' && !q)    { cols.push(cur); cur = ''; continue; }
    cur += c;
  }
  cols.push(cur);
  return cols;
}

// ---------------------------------------------------------------------------
// Timezone helpers
// ---------------------------------------------------------------------------

/**
 * Break a Date into local wall-clock parts for a given IANA timezone.
 * Returns { date: 'YYYY-MM-DD', hour, minute, minutes }.
 */
function localParts(date, timezone) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(date).map((p) => [p.type, p.value]));
  return {
    date   : `${parts.year}-${parts.month}-${parts.day}`,
    hour   : Number(parts.hour),
    minute : Number(parts.minute),
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
  };
}

/**
 * AEMO publishes all NEM times in AEST (UTC+10, no DST).
 * Accepts both "YYYY/MM/DD HH:MM:SS" and "YYYY-MM-DD HH:MM:SS".
 */
function parseAEMODate(s) {
  const normalized = String(s).replace(/\//g, '-').replace(' ', 'T') + '+10:00';
  return new Date(normalized);
}

/** True if `hour` falls inside a "HH-HH[,HH-HH]" range spec (wraps midnight). */
function inHoursRange(hour, spec) {
  for (const part of String(spec).split(',')) {
    const [a, b] = part.split('-').map(Number);
    if (isNaN(a) || isNaN(b)) continue;
    if (a < b) { if (hour >= a && hour < b) return true; }
    else       { if (hour >= a || hour < b) return true; } // wraps midnight
  }
  return false;
}

/** "HH:MM" → total minutes since midnight. */
function hhmmToMin(s) {
  const [h, m] = String(s).split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

/** Total minutes since midnight → "HH:MM". */
function minToHHMM(m) {
  const h = Math.floor(m / 60), mm = m % 60;
  return `${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

/** Round to one decimal place, or return null unchanged. */
function round1(n) { return n == null ? null : Math.round(n * 10) / 10; }

/**
 * Open-Meteo returns naive-local ISO strings ("2026-04-20T12:00").
 * Do NOT feed them to `new Date()` on a UTC-timezone host — it will
 * misinterpret them.  This converts to a comparable ordinal
 * (calendar-days × 1440 + local-minutes) safe for ordering and durations.
 */
function localOrdinalFromNaive(isoNaive) {
  const m = String(isoNaive).match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!m) return null;
  const days = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / 86400000;
  return days * 1440 + Number(m[4]) * 60 + Number(m[5]);
}

/** Same ordinal scale from a real Date + timezone name. */
function localOrdinalFromDate(date, timezone) {
  const lp = localParts(date, timezone);
  const [y, mo, d] = lp.date.split('-').map(Number);
  const days = Date.UTC(y, mo - 1, d) / 86400000;
  return days * 1440 + lp.minutes;
}

// ---------------------------------------------------------------------------
// HTTPS helpers
// ---------------------------------------------------------------------------

/** Fetch a URL and return { status, body } where body is a string. */
function httpsGetJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'fox-dashboard' } }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
      res.on('error', reject);
    }).on('error', reject);
  });
}

/** Fetch a URL and return the body as a UTF-8 string. */
function httpsGetText(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'fox-dashboard' } }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve(data));
      res.on('error', reject);
    }).on('error', reject);
  });
}

/** Fetch a URL and return the body as a Buffer (follows up to 5 redirects). */
function httpsGetBuffer(url, redirects = 5) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'fox-dashboard' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
        res.resume();
        return httpsGetBuffer(res.headers.location, redirects - 1).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// Pure-JS ZIP extractor
// ---------------------------------------------------------------------------
// Replaces the execFileSync('unzip', ...) system call so there is no OS-level
// dependency on the `unzip` binary (previously required in the Dockerfile).
//
// ZIP local-file-header layout (little-endian):
//   Offset  Size  Field
//      0     4    Signature = 0x04034b50
//      4     2    Version needed
//      6     2    General-purpose bit flag
//      8     2    Compression method (0=STORE, 8=DEFLATE)
//     10     2    Last-mod time
//     12     2    Last-mod date
//     14     4    CRC-32
//     18     4    Compressed size
//     22     4    Uncompressed size
//     26     2    File name length (n)
//     28     2    Extra field length (m)
//     30     n    File name
//   30+n     m    Extra field
//  30+n+m    ?    File data (compressedSize bytes)
//
// AEMO nemweb files are standard single-entry ZIPs — STORE or DEFLATE only.

function unzipFirstEntry(buffer) {
  if (buffer.length < 30 || buffer.readUInt32LE(0) !== 0x04034b50) {
    throw new Error('Not a valid ZIP file (bad local-file-header signature)');
  }
  const compression    = buffer.readUInt16LE(8);
  const compressedSize = buffer.readUInt32LE(18);
  const fnLen          = buffer.readUInt16LE(26);
  const extraLen       = buffer.readUInt16LE(28);
  const dataStart      = 30 + fnLen + extraLen;
  const compressedData = buffer.subarray(dataStart, dataStart + compressedSize);

  if (compression === 0) return compressedData.toString('utf8');  // STORE
  if (compression === 8) return zlib.inflateRawSync(compressedData).toString('utf8'); // DEFLATE
  throw new Error(`Unsupported ZIP compression method: ${compression}`);
}

// ---------------------------------------------------------------------------
module.exports = {
  Cache,
  csvSplit,
  localParts,
  parseAEMODate,
  inHoursRange,
  hhmmToMin,
  minToHHMM,
  round1,
  localOrdinalFromNaive,
  localOrdinalFromDate,
  httpsGetJson,
  httpsGetText,
  httpsGetBuffer,
  unzipFirstEntry,
};
