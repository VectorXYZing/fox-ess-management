'use strict';

// Central configuration module.
// Owns the single mutable `config` object that all other modules reference.
// Uses an onConfigSaved callback registry so modules can clear their caches
// when settings change — without creating circular imports.

const fs   = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------
const ROOT_DIR         = path.join(__dirname, '..');
const CONFIG_PATH      = path.join(ROOT_DIR, 'config.json');
const EXAMPLE_CONFIG_PATH = path.join(ROOT_DIR, 'config.example.json');
const STATE_DIR        = path.join(ROOT_DIR, 'state');
const DUMP_HISTORY_PATH = path.join(STATE_DIR, 'dump-history.json');
const DATA_DIR         = path.join(ROOT_DIR, 'data');
const SOC_HISTORY_PATH = path.join(DATA_DIR, 'soc-history.jsonl');

// ---------------------------------------------------------------------------
// Startup timestamp (used by the UI to show last deploy time)
// ---------------------------------------------------------------------------
const SERVER_STARTED_AT = new Date().toISOString();

// ---------------------------------------------------------------------------
// Config load
// ---------------------------------------------------------------------------
// The object is mutated in place by saveConfig() so all modules that hold a
// reference automatically see the latest values without a re-require.
const config = (() => {
  const source = fs.existsSync(CONFIG_PATH) ? CONFIG_PATH : EXAMPLE_CONFIG_PATH;
  return JSON.parse(fs.readFileSync(source, 'utf8'));
})();

// If config.json doesn't exist yet, persist the example so the settings UI
// has a stable file to write to on first save.
if (!fs.existsSync(CONFIG_PATH)) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

// ---------------------------------------------------------------------------
// Deep-merge helper
// ---------------------------------------------------------------------------
// Values in `src` win; keys only in `dst` are preserved.  Arrays and null
// are leaf values and replaced wholesale.  This lets the Settings form POST
// only the fields it knows about without wiping sections it doesn't touch
// (e.g. `recommendation`, `battery.maxDischargeKw`).
function deepMerge(dst, src) {
  if (src === null || typeof src !== 'object' || Array.isArray(src)) return src;
  const out = { ...(dst && typeof dst === 'object' && !Array.isArray(dst) ? dst : {}) };
  for (const k of Object.keys(src)) out[k] = deepMerge(out[k], src[k]);
  return out;
}

// ---------------------------------------------------------------------------
// Cache-clear callback registry
// ---------------------------------------------------------------------------
// Modules call onConfigSaved(fn) at init time; saveConfig() fires them all.
// Keeps config.js free of imports from other lib/ modules.
const _onSaveCallbacks = [];
function onConfigSaved(cb) { _onSaveCallbacks.push(cb); }

// ---------------------------------------------------------------------------
// saveConfig
// ---------------------------------------------------------------------------
function saveConfig(next) {
  const merged = deepMerge(config, next);
  // Replace keys in place (preserve the shared reference for all modules).
  for (const k of Object.keys(config)) delete config[k];
  Object.assign(config, merged);
  // Write directly rather than rename-from-tmp: when config.json is a Docker
  // bind-mounted single file, cross-fs rename fails with EXDEV.
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
  // Notify all modules so they drop stale cached data.
  for (const cb of _onSaveCallbacks) { try { cb(); } catch {} }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function isConfigured() {
  return !!(config.foxApiKey && config.deviceSN && !String(config.foxApiKey).startsWith('PASTE_'));
}

/** Return a copy of config safe to send to the browser (API key masked). */
function maskedConfig() {
  const copy = JSON.parse(JSON.stringify(config));
  if (copy.foxApiKey) {
    const k = String(copy.foxApiKey);
    copy.foxApiKey = k.length > 4 ? '••••' + k.slice(-4) : '••••';
  }
  copy.__configured = isConfigured();
  // __defaultPassword is filled in by the server layer (avoids importing auth here).
  return copy;
}

// ---------------------------------------------------------------------------
module.exports = {
  config,
  CONFIG_PATH,
  STATE_DIR,
  DUMP_HISTORY_PATH,
  DATA_DIR,
  SOC_HISTORY_PATH,
  SERVER_STARTED_AT,
  deepMerge,
  saveConfig,
  isConfigured,
  maskedConfig,
  onConfigSaved,
};
