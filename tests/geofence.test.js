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

console.log('Geofence: settings');

test('both files default to Paso Tower, 150 m, 50 m, driver exempt', () => {
  for (const [label, src, name] of [['server', SERVER_SRC, 'DEFAULT_APP_SETTINGS'], ['app', APP_SRC, 'APP_SETTINGS']]) {
    const m = new RegExp(`geofence:\\s*\\{[^}]*\\}`).exec(src);
    assert.ok(m, `${label}: no geofence defaults in ${name}`);
    const g = m[0];
    assert.ok(/enabled:\s*true/.test(g), `${label}: geofence must default to enabled`);
    assert.ok(/13\.7268315/.test(g) && /100\.52847/.test(g), `${label}: office centre must be Paso Tower`);
    assert.ok(/radiusM:\s*150/.test(g), `${label}: radius must default to 150`);
    assert.ok(/maxAccuracyM:\s*50/.test(g), `${label}: accuracy threshold must default to 50`);
    assert.ok(/exemptRoles:\s*\['driver'\]/.test(g), `${label}: driver must be exempt by default`);
  }
});

test('getAppSettings merges geofence over the defaults', () => {
  const fn = extractFunction(SERVER_SRC, 'getAppSettings');
  assert.ok(/geofence:\s*\{\s*\.\.\.DEFAULT_APP_SETTINGS\.geofence,\s*\.\.\.\(raw\.geofence\s*\|\|\s*\{\}\)\s*\}/.test(fn),
    'geofence must be merged like workSchedule, or a partial stored value loses its other fields');
});

test('PUT /api/settings accepts geofence and validates it', () => {
  const allowed = /const ALLOWED_APPSETTINGS_KEYS = \[[^\]]*\]/.exec(SERVER_SRC)[0];
  assert.ok(/'geofence'/.test(allowed), 'geofence must be in the appSettings whitelist or every save is rejected');
  const objLoop = /for \(const sub of \['company'[^\]]*\]\)/.exec(SERVER_SRC)[0];
  assert.ok(/'geofence'/.test(objLoop), 'geofence must be type-checked like the other sub-objects');
  for (const needle of [
    'appSettings.geofence.lat must be a number between -90 and 90',
    'appSettings.geofence.lng must be a number between -180 and 180',
    'appSettings.geofence.radiusM must be a number between 10 and 5000',
    'appSettings.geofence.maxAccuracyM must be a number between 5 and 1000',
    'appSettings.geofence.exemptRoles must be an array of known roles',
    'appSettings.geofence.enabled must be true or false',
  ]) {
    assert.ok(SERVER_SRC.includes(needle), `missing validation: ${needle}`);
  }
});

console.log('Geofence: the server gate');

test('accuracy is sanitised to a bounded number or null', () => {
  const A = sandbox(SERVER_SRC, ['sanitizeGpsAccuracy']);
  assert.strictEqual(A.sanitizeGpsAccuracy(23.4), 23);
  assert.strictEqual(A.sanitizeGpsAccuracy('12'), 12);
  assert.strictEqual(A.sanitizeGpsAccuracy(0), 0);
  assert.strictEqual(A.sanitizeGpsAccuracy(-1), null);
  assert.strictEqual(A.sanitizeGpsAccuracy('abc'), null);
  assert.strictEqual(A.sanitizeGpsAccuracy(undefined), null);
  assert.strictEqual(A.sanitizeGpsAccuracy(1e9), null);
});

test('only a real check-in is gated: pre-dawn and post-cutoff scans are check-outs', () => {
  const ctx = { CHECKIN_CUTOFF: '13:00', buildAttendanceLogForUser: () => ({}) };
  vm.createContext(ctx);
  vm.runInContext(extractFunction(SERVER_SRC, 'webScanWouldBeCheckIn'), ctx);
  const U = { employeeNo: '1' };
  assert.strictEqual(ctx.webScanWouldBeCheckIn(U, '2026-09-25T08:25:00'), true);
  assert.strictEqual(ctx.webScanWouldBeCheckIn(U, '2026-09-25T02:10:00'), false, 'before 05:00 is a late-night check-out');
  assert.strictEqual(ctx.webScanWouldBeCheckIn(U, '2026-09-25T13:00:00'), false, 'at the cutoff is a check-out');
  assert.strictEqual(ctx.webScanWouldBeCheckIn(U, '2026-09-25T17:40:00'), false);
});

test('an employee who already checked in today is not gated again', () => {
  const ctx = { CHECKIN_CUTOFF: '13:00', buildAttendanceLogForUser: () => ({ '2026-09-25': { checkIn: '08:20' } }) };
  vm.createContext(ctx);
  vm.runInContext(extractFunction(SERVER_SRC, 'webScanWouldBeCheckIn'), ctx);
  assert.strictEqual(ctx.webScanWouldBeCheckIn({ employeeNo: '1' }, '2026-09-25T09:00:00'), false);
});

test('the gate is wired into the WebScan branch, before the event is saved', () => {
  const route = SERVER_SRC.slice(SERVER_SRC.indexOf("app.post('/api/hikvision/event'"));
  const body = route.slice(0, route.indexOf('\napp.'));
  const gateAt = body.indexOf('geofenceCheckinReason');
  const saveAt = body.indexOf('saveEvent({');
  assert.ok(gateAt > 0, 'the route must call geofenceCheckinReason');
  assert.ok(gateAt < saveAt, 'the gate must run BEFORE saveEvent, or a refused check-in is still recorded');
  assert.ok(/hikSource === 'webscan'/.test(body.slice(0, gateAt)),
    'the gate must be inside the webscan branch -- the physical device is never gated');
  assert.ok(/webScanWouldBeCheckIn\(/.test(body.slice(0, gateAt)),
    'the check-in test must run before the gate, so check-outs are never gated');
  assert.ok(/req\.hikUser\.role/.test(body.slice(0, gateAt + 400)),
    'the role must come from the live record, never from the request body');
  assert.ok(/status\(403\)/.test(body.slice(gateAt, gateAt + 600)), 'refusal must be a 403');
});

test('the stored event carries the accuracy, and it is not public', () => {
  const route = SERVER_SRC.slice(SERVER_SRC.indexOf("app.post('/api/hikvision/event'"));
  assert.ok(/gpsAcc/.test(route.slice(0, route.indexOf('\napp.'))), 'the event must store gpsAcc');
  const pub = /const EVENT_PUBLIC_FIELDS = \[[^\]]*\]/.exec(SERVER_SRC)[0];
  assert.ok(!/gpsAcc/.test(pub), 'gpsAcc must stay out of the public projection, like gps itself');
});

console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ', 0 failed'}`);
