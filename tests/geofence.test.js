// 2026-09-25: web check-in geofence. The real functions are extracted from app.js and server.js
// and run in a sandbox, so the DUAL-SYNC copies are proven to agree. `node tests/geofence.test.js`
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const APP_SRC = fs.readFileSync(path.join(ROOT, 'attendance/js/app.js'), 'utf8');
const SERVER_SRC = fs.readFileSync(path.join(ROOT, 'attendance-server/backend/server.js'), 'utf8');

function extractBraced(src, startIdx, openIdx, name) {
  let depth = 0;
  for (let j = openIdx; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (depth === 0) return src.slice(startIdx, j + 1); }
  }
  throw new Error(`unbalanced ${name}`);
}
function extractFunction(src, name) {
  const m = new RegExp(`^(async )?function ${name}\\(`, 'm').exec(src);
  if (!m) throw new Error(`function ${name} not found`);
  return extractBraced(src, m.index, src.indexOf(') {', m.index) + 2, name);
}
function sameSource(name) {
  const norm = s => s.replace(/\s+/g, ' ').trim();
  assert.strictEqual(norm(extractFunction(APP_SRC, name)), norm(extractFunction(SERVER_SRC, name)),
    `${name} differs between app.js and server.js`);
}
function sandbox(src, names) {
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(names.map(n => extractFunction(src, n)).join('\n'), ctx);
  return ctx;
}

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok  ${name}`); }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; }
}

const PASO  = { lat: 13.7268315, lng: 100.52847 };
const AMARA = { lat: 13.7290317, lng: 100.5274579 };
const G = { enabled: true, lat: PASO.lat, lng: PASO.lng, radiusM: 150, maxAccuracyM: 50, exemptRoles: ['driver'] };

const S = sandbox(SERVER_SRC, ['geofenceDistanceM', 'geofenceCheckinReason']);

console.log('Geofence: distance and the check-in decision');

test('both functions are identical in app.js and server.js (dual-sync)', () => {
  sameSource('geofenceDistanceM');
  sameSource('geofenceCheckinReason');
});

test('Paso Tower to Amara Bangkok Hotel is 268 m', () => {
  const d = S.geofenceDistanceM(PASO.lat, PASO.lng, AMARA.lat, AMARA.lng);
  assert.ok(Math.abs(d - 268) < 2, `expected ~268 m, got ${d.toFixed(1)}`);
  assert.strictEqual(S.geofenceDistanceM(PASO.lat, PASO.lng, PASO.lat, PASO.lng), 0);
});

test('at the office: a check-in is refused', () => {
  assert.strictEqual(S.geofenceCheckinReason(G, 'user', PASO.lat, PASO.lng, 20), 'geofence-inside');
});

test('at the hotel with any accuracy inside the threshold: never refused', () => {
  // The design rests on this: 268 m - 50 m of error is still outside the 150 m fence.
  for (let acc = 0; acc <= G.maxAccuracyM; acc += 5) {
    assert.strictEqual(S.geofenceCheckinReason(G, 'user', AMARA.lat, AMARA.lng, acc), '',
      `refused at the hotel with accuracy ${acc}`);
  }
});

test('no position, or a position that is not a number, is refused', () => {
  assert.strictEqual(S.geofenceCheckinReason(G, 'user', null, null, 10), 'geofence-no-position');
  assert.strictEqual(S.geofenceCheckinReason(G, 'user', NaN, 100.5, 10), 'geofence-no-position');
});

test('a fix worse than the threshold is refused wherever it claims to be', () => {
  assert.strictEqual(S.geofenceCheckinReason(G, 'user', AMARA.lat, AMARA.lng, 51), 'geofence-accuracy');
  assert.strictEqual(S.geofenceCheckinReason(G, 'user', 13.9, 100.9, 500), 'geofence-accuracy');
  assert.strictEqual(S.geofenceCheckinReason(G, 'user', AMARA.lat, AMARA.lng, null), 'geofence-accuracy');
});

test('a driver is allowed everywhere, including with no position at all', () => {
  assert.strictEqual(S.geofenceCheckinReason(G, 'driver', PASO.lat, PASO.lng, 10), '');
  assert.strictEqual(S.geofenceCheckinReason(G, 'driver', null, null, null), '');
});

test('the master switch restores the old behaviour exactly', () => {
  const off = { ...G, enabled: false };
  assert.strictEqual(S.geofenceCheckinReason(off, 'user', PASO.lat, PASO.lng, 10), '');
  assert.strictEqual(S.geofenceCheckinReason(off, 'user', null, null, null), '');
  assert.strictEqual(S.geofenceCheckinReason(undefined, 'user', PASO.lat, PASO.lng, 10), '');
});

test('a radius or threshold of 0 is honoured, not replaced by a default', () => {
  // Falsy-zero guard: `radiusM || 150` would silently restore 150 here.
  assert.strictEqual(S.geofenceCheckinReason({ ...G, radiusM: 0 }, 'user', PASO.lat, PASO.lng, 10), '');
  assert.strictEqual(S.geofenceCheckinReason({ ...G, maxAccuracyM: 0 }, 'user', AMARA.lat, AMARA.lng, 1), 'geofence-accuracy');
});

console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ', 0 failed'}`);
