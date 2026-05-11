'use strict';

// Live test against the Fox v3 scheduler API.
// Run with: node test/test-v3-scheduler.js
// (Reads config.json so the API key + deviceSN are picked up.)
//
// Test plan:
//   1. GET /op/v3/device/scheduler/get — record baseline
//   2. POST /op/v3/device/scheduler/enable — add a unique test slot
//   3. GET — verify the test slot is present
//   4. POST — modify the test slot (different fdSoc)
//   5. GET — verify the modification
//   6. POST — remove the test slot (write groups without it)
//   7. GET — verify removed, baseline restored
//
// The test slot uses a 1-minute window very late at night so it won't
// disturb anything if it accidentally remains.

const https  = require('https');
const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');

const CFG_PATH = path.join(__dirname, '..', 'config.json');
const config  = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8'));

const FOX_HOST = 'www.foxesscloud.com';
const SN       = config.deviceSN;
const API_KEY  = config.foxApiKey;

if (!SN || !API_KEY) { console.error('missing deviceSN or foxApiKey in config.json'); process.exit(1); }

function foxRequest(apiPath, body) {
  return new Promise((resolve, reject) => {
    const timestamp = Date.now().toString();
    const payload   = body ? JSON.stringify(body) : '';
    const signature = crypto.createHash('md5')
      .update(`${apiPath}\\r\\n${API_KEY}\\r\\n${timestamp}`).digest('hex');
    const req = https.request({
      host: FOX_HOST, path: apiPath, method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        token: API_KEY, timestamp, lang: 'en', signature,
      },
    }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve({ errno: -1, msg: data.slice(0, 200) }); }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// Throttle Fox calls (30/min limit, 2s gap is safe)
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

function toV3Group(g) {
  return {
    startHour: g.startHour, startMinute: g.startMinute,
    endHour:   g.endHour,   endMinute:   g.endMinute,
    workMode:  g.workMode,
    ...(g.isRemainMode ? { isRemainMode: true } : {}),
    extraParam: {
      fdSoc:        g.fdSoc        ?? 100,
      fdPwr:        g.fdPwr        ?? 5000,
      maxSoc:       g.maxSoc       ?? 100,
      minSocOnGrid: g.minSocOnGrid ?? 10,
    },
  };
}

function fromV3(g) {
  const ep = g.extraParam || {};
  return {
    workMode: g.workMode,
    startHour: g.startHour, startMinute: g.startMinute,
    endHour: g.endHour, endMinute: g.endMinute,
    isRemainMode: !!g.isRemainMode,
    fdSoc: ep.fdSoc ?? 100,
    fdPwr: ep.fdPwr ?? 5000,
    maxSoc: ep.maxSoc ?? 100,
    minSocOnGrid: ep.minSocOnGrid ?? 10,
  };
}

const TEST_WINDOW = {
  workMode: 'ForceCharge(BAT)',
  startHour: 3, startMinute: 0, endHour: 3, endMinute: 1,
  fdPwr: 1000, fdSoc: 50, minSocOnGrid: 10, maxSoc: 50,
};

const fail = (msg) => { console.error('✗ FAIL:', msg); process.exit(1); };
const ok   = (msg) => console.log('✓', msg);

function matchesTestWindow(g) {
  return g.workMode === TEST_WINDOW.workMode
    && g.startHour === TEST_WINDOW.startHour && g.startMinute === TEST_WINDOW.startMinute
    && g.endHour   === TEST_WINDOW.endHour   && g.endMinute   === TEST_WINDOW.endMinute;
}

async function get() {
  await sleep(2200);
  const r = await foxRequest('/op/v3/device/scheduler/get', { deviceSN: SN });
  if (r.errno !== 0) fail(`get: errno=${r.errno} msg=${r.msg}`);
  const groups = (r.result?.groups || []).map(fromV3);
  return { enable: r.result?.enable, maxGroupCount: r.result?.maxGroupCount, groups };
}

async function set(groups) {
  await sleep(2200);
  const r = await foxRequest('/op/v3/device/scheduler/enable', {
    deviceSN: SN,
    isDefault: false,
    groups: groups.map(toV3Group),
  });
  if (r.errno !== 0) fail(`enable: errno=${r.errno} msg=${r.msg}`);
}

(async () => {
  console.log('Fox v3 scheduler API test\n  deviceSN:', SN, '\n');

  // 1. Baseline
  const baseline = await get();
  ok(`GET baseline: enable=${baseline.enable}, maxGroupCount=${baseline.maxGroupCount}, ${baseline.groups.length} groups`);
  baseline.groups.forEach((g, i) => console.log(`     [${i}] ${g.workMode} ${String(g.startHour).padStart(2,'0')}:${String(g.startMinute).padStart(2,'0')}–${String(g.endHour).padStart(2,'0')}:${String(g.endMinute).padStart(2,'0')} fdSoC=${g.fdSoc}% fdPwr=${g.fdPwr}W${g.isRemainMode?' isRemainMode':''}`));

  if (baseline.groups.some(matchesTestWindow)) {
    console.log('\n  (leftover test slot detected — will clean up before testing)');
    await set(baseline.groups.filter((g) => !matchesTestWindow(g)));
    ok('cleaned up leftover test slot');
  }

  const startGroups = baseline.groups.filter((g) => !matchesTestWindow(g));
  console.log();

  // 2. Add test slot
  console.log('--- Test 1: ADD slot ---');
  await set([...startGroups, TEST_WINDOW]);
  ok('POST add succeeded');

  // 3. Verify added
  const afterAdd = await get();
  const added = afterAdd.groups.find(matchesTestWindow);
  if (!added) fail('test slot not present after add');
  ok(`slot present after add: fdSoC=${added.fdSoc}, fdPwr=${added.fdPwr}`);
  if (added.fdSoc !== TEST_WINDOW.fdSoc) fail(`fdSoc mismatch: expected ${TEST_WINDOW.fdSoc}, got ${added.fdSoc}`);
  if (added.fdPwr !== TEST_WINDOW.fdPwr) fail(`fdPwr mismatch: expected ${TEST_WINDOW.fdPwr}, got ${added.fdPwr}`);
  ok('extraParam fields round-tripped correctly');
  console.log();

  // 4. Modify
  console.log('--- Test 2: MODIFY slot (fdSoc 50 → 75, fdPwr 1000 → 2500) ---');
  const modified = { ...TEST_WINDOW, fdSoc: 75, fdPwr: 2500, maxSoc: 75 };
  await set([...startGroups, modified]);
  ok('POST modify succeeded');

  const afterMod = await get();
  const mod = afterMod.groups.find(matchesTestWindow);
  if (!mod) fail('test slot missing after modify');
  if (mod.fdSoc !== 75) fail(`fdSoc not updated: got ${mod.fdSoc}`);
  if (mod.fdPwr !== 2500) fail(`fdPwr not updated: got ${mod.fdPwr}`);
  if (mod.maxSoc !== 75) fail(`maxSoc not updated: got ${mod.maxSoc}`);
  ok(`modify confirmed: fdSoC=${mod.fdSoc}, fdPwr=${mod.fdPwr}, maxSoc=${mod.maxSoc}`);
  console.log();

  // 5. Delete (write without the slot)
  console.log('--- Test 3: DELETE slot ---');
  await set(startGroups);
  ok('POST delete (write without slot) succeeded');

  const afterDel = await get();
  if (afterDel.groups.some(matchesTestWindow)) fail('test slot still present after delete');
  ok('slot removed');
  if (afterDel.groups.length !== startGroups.length) {
    fail(`group count mismatch after delete: expected ${startGroups.length}, got ${afterDel.groups.length}`);
  }
  ok(`baseline restored: ${afterDel.groups.length} groups`);
  console.log();

  console.log('All v3 scheduler API tests passed ✓');
})().catch((e) => { console.error('threw:', e); process.exit(1); });
