// The form must not offer an Early Morning tier the server is going to refuse (2026-10-16).
//
// Both engines decide whether a check-in is early enough for a tier by comparing the check-in
// against the threshold in settings. server.js reads that threshold raw. app.js read it as
// `S.earlyThreshold2Min || 390` / `S.earlyThreshold1Min || 450`, so a threshold the owner sets to
// 0 -- the natural way to close a tier so nobody qualifies -- was replaced by the hardcoded
// default on the browser side alone. The form then offered the tier, the employee submitted, and
// the server answered 400 against the real 0. The employee is told to use a button that is not
// allowed to work, which is the same shape of bug the auto-pay switch comment warns about.
//
// Proven before fixing, without touching the live settings: the threshold was set to 0 in the
// browser's memory only (never saved), where earlyMorningTierAllowed('06:00', 2) answered true,
// while the real server function lifted into node answered false for the same input.
//
// This file requires the two to agree for every threshold value, including 0.
// `node tests/early-morning-threshold-zero.test.js`
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const APP_SRC = fs.readFileSync(path.join(ROOT, 'attendance/js/app.js'), 'utf8');
const SERVER_SRC = fs.readFileSync(path.join(ROOT, 'attendance-server/backend/server.js'), 'utf8');
const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function extractFunction(src, name) {
  const re = new RegExp(`^function ${name}\\(`, 'm');
  const m = re.exec(src);
  if (!m) throw new Error(`function ${name} not found`);
  const i = src.indexOf('{', m.index);
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (depth === 0) return src.slice(m.index, j + 1); }
  }
  throw new Error(`unbalanced ${name}`);
}

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok  ${name}`); }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; }
}

// The browser side reads APP_SETTINGS at call time, so the sandbox's copy is swapped per case.
const client = { console, HHMM_RE, APP_SETTINGS: { allowances: {} } };
vm.createContext(client);
vm.runInContext(['parseHHMMToMins', 'earlyThresholdMinsOf', 'earlyMorningThresholdMins', 'earlyMorningTierAllowed']
  .map(n => extractFunction(APP_SRC, n)).join('\n'), client);

const server = { console, HHMM_RE };
vm.createContext(server);
vm.runInContext(['parseHHMMToMins', 'earlyMorningTierAllowed']
  .map(n => extractFunction(SERVER_SRC, n)).join('\n'), server);

function formOffers(checkIn, tier, thr1, thr2) {
  client.APP_SETTINGS.allowances = { earlyThreshold1Min: thr1, earlyThreshold2Min: thr2 };
  return client.earlyMorningTierAllowed(checkIn, tier);
}
function serverAccepts(checkIn, tier, thr1, thr2) {
  return server.earlyMorningTierAllowed(checkIn, tier,
    { allowances: { earlyThreshold1Min: thr1, earlyThreshold2Min: thr2 } });
}
function agree(label, checkIn, tier, thr1, thr2) {
  const f = formOffers(checkIn, tier, thr1, thr2);
  const s = serverAccepts(checkIn, tier, thr1, thr2);
  assert.strictEqual(f, s,
    `${label}: the form ${f ? 'offers' : 'refuses'} tier ${tier} for ${checkIn} but the server ${s ? 'accepts' : 'refuses'} it`);
  return s;
}

console.log('The form offers exactly what the server will accept');

test('ordinary thresholds: both agree on either side of each line', () => {
  assert.strictEqual(agree('inside x2', '06:00', 2, 450, 390), true);
  assert.strictEqual(agree('on the x2 line', '06:30', 2, 450, 390), true);
  assert.strictEqual(agree('past the x2 line', '06:31', 2, 450, 390), false);
  assert.strictEqual(agree('inside x1', '07:00', 1, 450, 390), true);
  assert.strictEqual(agree('past the x1 line', '07:31', 1, 450, 390), false);
});

test('a tier closed with 0 is closed on BOTH sides, not just the server', () => {
  // The owner's way of switching a tier off. The form used to keep offering it from a hardcoded
  // default while the server refused every submission against the real 0.
  assert.strictEqual(agree('x2 closed, early arrival', '06:00', 2, 450, 0), false);
  assert.strictEqual(agree('x2 closed, very early arrival', '05:31', 2, 450, 0), false);
  assert.strictEqual(agree('x1 closed', '07:00', 1, 0, 390), false);
});

test('closing one tier leaves the other alone', () => {
  assert.strictEqual(agree('x1 still open while x2 is closed', '07:00', 1, 450, 0), true);
  assert.strictEqual(agree('x2 still open while x1 is closed', '06:00', 2, 0, 390), true);
});

test('a threshold of 1 minute past midnight behaves like any other number', () => {
  assert.strictEqual(agree('00:01 threshold refuses an 06:00 arrival', '06:00', 2, 450, 1), false);
  assert.strictEqual(agree('00:01 threshold accepts a 00:01 arrival', '00:01', 2, 450, 1), true);
});

test('neither side accepts a tier that is not 1 or 2, or a missing time', () => {
  assert.strictEqual(formOffers('06:00', 3, 450, 390), false);
  assert.strictEqual(serverAccepts('06:00', 3, 450, 390), false);
  assert.strictEqual(formOffers('', 2, 450, 390), false);
  assert.strictEqual(serverAccepts('', 2, 450, 390), false);
});

test('no threshold read in app.js falls back with `||`, which is what swallowed the 0', () => {
  const bad = [...APP_SRC.matchAll(/earlyThreshold[12]Min\s*\|\|\s*([A-Za-z0-9_]+)/g)].map(m => m[0]);
  assert.deepStrictEqual(bad, [],
    `these reads replace a legitimate 0 with a default: ${bad.join(', ')}`);
});

console.log(`\n${passed} passed, ${process.exitCode ? 'some failed' : '0 failed'}`);
