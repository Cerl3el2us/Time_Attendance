// The Long Distance rate the driver is TOLD must be the rate the server PAYS (2026-10-16).
//
// server.js decides the money twice -- when the request is created and when it is edited -- and
// both read `S.allowances.longDistance || 0`: an unset or zero rate pays nothing. Every display
// site in app.js used to read `S.allowances.longDistance || LONG_DISTANCE_ALLOWANCE`, a hardcoded
// 150. The two agree only while the rate is a normal positive number. Set the rate to 0 in
// Settings to stop paying the allowance -- or run on a settings file old enough never to have had
// the key -- and the request form promised the driver "+฿150/day" while the request the server
// stamped carried ฿0 and the payslip paid nothing.
//
// longDistanceRateOf() is now the one reader, and it answers the server's way. This file pins the
// three things that have to stay true for that to keep holding:
//   1. the reader's own answers, including the two cases that used to diverge
//   2. no display site re-introduces a fallback of its own
//   3. server.js still decides with `|| 0` -- if that ever changes, the reader must change with it
//      rather than drifting silently, which is the whole failure mode this file exists for
// `node tests/long-distance-rate-display.test.js`
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const APP_SRC = fs.readFileSync(path.join(ROOT, 'attendance/js/app.js'), 'utf8');
const SERVER_SRC = fs.readFileSync(path.join(ROOT, 'attendance-server/backend/server.js'), 'utf8');

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

const sandbox = { console };
vm.createContext(sandbox);
vm.runInContext(extractFunction(APP_SRC, 'longDistanceRateOf'), sandbox);
const rateOf = vm.runInContext('longDistanceRateOf', sandbox);

// What server.js pays for a trip past the threshold, written the way server.js writes it.
const serverPays = S => (S.allowances.longDistance || 0);

console.log('The rate shown and the rate paid are one number');

test('a normal rate is shown as it is', () => {
  const S = { allowances: { longDistance: 150 } };
  assert.strictEqual(rateOf(S), 150);
  assert.strictEqual(rateOf(S), serverPays(S));
});

test('a rate the owner set to 0 is shown as 0, not as a default', () => {
  const S = { allowances: { longDistance: 0 } };
  assert.strictEqual(rateOf(S), 0, 'a deliberate 0 must survive the read');
  assert.strictEqual(rateOf(S), serverPays(S), 'the form must say what the payslip pays');
});

test('a settings file with no rate key at all pays nothing, so it shows nothing', () => {
  const S = { allowances: { longDistanceThresholdKm: 250 } };
  assert.strictEqual(rateOf(S), 0);
  assert.strictEqual(rateOf(S), serverPays(S));
});

test('a missing settings object does not throw -- the form still has to render', () => {
  assert.strictEqual(rateOf(undefined), 0);
  assert.strictEqual(rateOf(null), 0);
  assert.strictEqual(rateOf({}), 0);
});

test('every other rate value agrees with the server', () => {
  for (const v of [1, 80, 150, 999, 0]) {
    const S = { allowances: { longDistance: v } };
    assert.strictEqual(rateOf(S), serverPays(S), `rate ${v}`);
  }
});

test('no display site carries a fallback rate of its own', () => {
  // Any `allowances.longDistance || X` anywhere in app.js must have X === 0. A site that invents
  // its own default is exactly the bug: it shows money the server will not pay.
  const found = [...APP_SRC.matchAll(/\.allowances\.longDistance\s*\|\|\s*([A-Za-z0-9_]+)/g)]
    .map(m => m[1]);
  const bad = found.filter(x => x !== '0');
  assert.deepStrictEqual(bad, [],
    `these fallbacks are not 0, so the form can promise what the payslip will not pay: ${bad.join(', ')}`);
});

test('the hardcoded 150 is gone from app.js entirely', () => {
  assert.ok(!/LONG_DISTANCE_ALLOWANCE/.test(APP_SRC),
    'LONG_DISTANCE_ALLOWANCE is back -- it is the default that caused the mismatch');
});

test('server.js still decides with `|| 0`, at both the create and the edit site', () => {
  const sites = [...SERVER_SRC.matchAll(/S\.allowances\.longDistance\s*\|\|\s*([A-Za-z0-9_]+)/g)]
    .map(m => m[1]);
  assert.strictEqual(sites.length, 2, `expected the POST and the PUT, found ${sites.length}`);
  assert.deepStrictEqual(sites, ['0', '0'],
    'server.js changed how it falls back -- longDistanceRateOf() in app.js must be changed to match');
});

console.log(`\n${passed} passed, ${process.exitCode ? 'some failed' : '0 failed'}`);
