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
// A handful of tests (the doScan press-time GPS refresh) drive a real `await` inside the
// extracted, vm-wrapped async function -- fn() then returns a Promise instead of running to
// completion synchronously. Collected here and awaited before the final summary prints, so a
// failure in one still sets process.exitCode and prints FAIL like every synchronous test, instead
// of surfacing as an unhandled rejection after the script appears to have already finished.
const pendingAsync = [];
function test(name, fn) {
  let result;
  try { result = fn(); }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; return; }
  if (result && typeof result.then === 'function') {
    pendingAsync.push(result.then(
      () => { passed++; console.log(`  ok  ${name}`); },
      e => { console.log(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; }
    ));
    return;
  }
  passed++; console.log(`  ok  ${name}`);
}

const PASO  = { lat: 13.7268315, lng: 100.52847 };
const AMARA = { lat: 13.7290317, lng: 100.5274579 };
const G = { enabled: true, lat: PASO.lat, lng: PASO.lng, radiusM: 150, exemptRoles: ['driver'] };

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

// 2026-09-26 (owner, 2nd decision): the distance-minus-accuracy rule shipped earlier the same day
// had a defect the owner then ruled on -- crediting the device's own margin of error made the
// effective refusal radius grow with it (radiusM + accuracy), so a coarse fix (iOS "Precise
// Location" off, or any desktop browser positioning by IP) was refused across the whole city,
// including at Amara -- the owner's one named worry -- with a message claiming the employee was at
// the office. The owner's decision: trust the reported point and ignore accuracy in the gate
// entirely. `geofenceCheckinReason()` no longer takes an accuracy parameter at all; the tests below
// still pass a 5th argument in several places specifically to prove it has NO effect any more --
// they must fail if anyone reintroduces an accuracy term that reads it.

test('at the tower: refused with a good fix, with no accuracy reported at all, and with a coarse one', () => {
  assert.strictEqual(S.geofenceCheckinReason(G, 'user', PASO.lat, PASO.lng, 20), 'geofence-inside');
  assert.strictEqual(S.geofenceCheckinReason(G, 'user', PASO.lat, PASO.lng), 'geofence-inside',
    'no accuracy argument at all must still refuse at the office');
  assert.strictEqual(S.geofenceCheckinReason(G, 'user', PASO.lat, PASO.lng, 50000), 'geofence-inside',
    'a coarse/desktop-style accuracy value must never affect the decision -- the rule ignores accuracy entirely');
});

test('at Amara (268 m away): allowed at every accuracy value, including desktop-style ±5,000 m and ±50,000 m fixes -- this is the case the owner cares about', () => {
  // Under the removed rule, `268 - 5000 <= 150` and `268 - 50000 <= 150` were both refused
  // ('geofence-inside') with a message claiming the employee was at the office, even though Amara
  // is 268 m away and unreachable from the 14th-floor scanner. Every value here must allow.
  for (const acc of [undefined, null, 0, 1, 50, 117, 118, 200, 1000, 5000, 50000, 'garbage', NaN, -50]) {
    assert.strictEqual(S.geofenceCheckinReason(G, 'user', AMARA.lat, AMARA.lng, acc), '',
      `must be allowed at the hotel regardless of any accuracy value (${acc}) -- accuracy must never enter the decision`);
  }
});

test('a desktop-style ±50,000 m fix reporting a point 5 km away is allowed (the removed accuracy-proportional exclusion zone would have refused this)', () => {
  const FIVE_KM = { lat: PASO.lat + (5000 / 111320), lng: PASO.lng }; // ~5 km due north of the tower
  const d = S.geofenceDistanceM(PASO.lat, PASO.lng, FIVE_KM.lat, FIVE_KM.lng);
  assert.ok(Math.abs(d - 5000) < 50, `expected ~5 km, got ${d.toFixed(0)} m`);
  assert.strictEqual(S.geofenceCheckinReason(G, 'user', FIVE_KM.lat, FIVE_KM.lng, 50000), '',
    'a coarse desktop/IP fix reporting a point 5 km away must be allowed -- 5000 - 50000 <= 150 would have wrongly refused this under the removed rule');
});

test('no position, or a position that is not a number, is refused', () => {
  assert.strictEqual(S.geofenceCheckinReason(G, 'user', null, null), 'geofence-no-position');
  assert.strictEqual(S.geofenceCheckinReason(G, 'user', NaN, 100.5), 'geofence-no-position');
});

test('a position 700 km away is allowed, with or without any accuracy value', () => {
  const FAR = { lat: PASO.lat + (700000 / 111320), lng: PASO.lng }; // ~700 km due north of the tower
  const d = S.geofenceDistanceM(PASO.lat, PASO.lng, FAR.lat, FAR.lng);
  assert.ok(Math.abs(d - 700000) < 2000, `expected ~700 km, got ${(d / 1000).toFixed(0)} km`);
  assert.strictEqual(S.geofenceCheckinReason(G, 'user', FAR.lat, FAR.lng), '');
  assert.strictEqual(S.geofenceCheckinReason(G, 'user', FAR.lat, FAR.lng, 100000), '');
});

test('a driver is allowed everywhere, including with no position at all', () => {
  assert.strictEqual(S.geofenceCheckinReason(G, 'driver', PASO.lat, PASO.lng), '');
  assert.strictEqual(S.geofenceCheckinReason(G, 'driver', null, null), '');
});

test('the master switch restores the old behaviour exactly', () => {
  const off = { ...G, enabled: false };
  assert.strictEqual(S.geofenceCheckinReason(off, 'user', PASO.lat, PASO.lng), '');
  assert.strictEqual(S.geofenceCheckinReason(off, 'user', null, null), '');
  assert.strictEqual(S.geofenceCheckinReason(undefined, 'user', PASO.lat, PASO.lng), '');
});

test('a radius of 0 is honoured, not replaced by a default', () => {
  // Falsy-zero guard: `radiusM || 150` would silently restore 150 here.
  assert.strictEqual(S.geofenceCheckinReason({ ...G, radiusM: 0 }, 'user', PASO.lat, PASO.lng), '');
});

console.log('Geofence: settings');

test('both files default to Paso Tower, 150 m radius, driver exempt, and no maxAccuracyM', () => {
  for (const [label, src, name] of [['server', SERVER_SRC, 'DEFAULT_APP_SETTINGS'], ['app', APP_SRC, 'APP_SETTINGS']]) {
    const m = new RegExp(`geofence:\\s*\\{[^}]*\\}`).exec(src);
    assert.ok(m, `${label}: no geofence defaults in ${name}`);
    const g = m[0];
    assert.ok(/enabled:\s*true/.test(g), `${label}: geofence must default to enabled`);
    assert.ok(/13\.7268315/.test(g) && /100\.52847/.test(g), `${label}: office centre must be Paso Tower`);
    assert.ok(/radiusM:\s*150/.test(g), `${label}: radius must default to 150`);
    assert.ok(/exemptRoles:\s*\['driver'\]/.test(g), `${label}: driver must be exempt by default`);
    // 2026-09-26: maxAccuracyM served the removed accuracy ceiling and is now meaningless --
    // a dead setting that still looks meaningful is worse than none.
    assert.ok(!/maxAccuracyM/.test(g), `${label}: maxAccuracyM must be removed from the geofence defaults`);
  }
});

test('getAppSettings merges geofence over the defaults', () => {
  const fn = extractFunction(SERVER_SRC, 'getAppSettings');
  assert.ok(/geofence:\s*\{\s*\.\.\.DEFAULT_APP_SETTINGS\.geofence,\s*\.\.\.\(raw\.geofence\s*\|\|\s*\{\}\)\s*\}/.test(fn),
    'geofence must be merged like workSchedule, or a partial stored value loses its other fields');
});

test('PUT /api/settings accepts geofence and validates it, with the maxAccuracyM bounds check gone', () => {
  const allowed = /const ALLOWED_APPSETTINGS_KEYS = \[[^\]]*\]/.exec(SERVER_SRC)[0];
  assert.ok(/'geofence'/.test(allowed), 'geofence must be in the appSettings whitelist or every save is rejected');
  const objLoop = /for \(const sub of \['company'[^\]]*\]\)/.exec(SERVER_SRC)[0];
  assert.ok(/'geofence'/.test(objLoop), 'geofence must be type-checked like the other sub-objects');
  for (const needle of [
    'appSettings.geofence.lat must be a number between -90 and 90',
    'appSettings.geofence.lng must be a number between -180 and 180',
    'appSettings.geofence.radiusM must be a number between 10 and 5000',
    'appSettings.geofence.exemptRoles must be an array of known roles',
    'appSettings.geofence.enabled must be true or false',
  ]) {
    assert.ok(SERVER_SRC.includes(needle), `missing validation: ${needle}`);
  }
  assert.ok(!SERVER_SRC.includes('maxAccuracyM must be a number'),
    'the maxAccuracyM bounds-validation message must be fully removed from server.js');
});

// Minor 2 (2026-09-26 review): the setting is dead, but a client still holding an old cached
// payload -- or a settings.json on disk saved before this removal -- can still carry a stale
// maxAccuracyM value. It must be stripped before the deep-merge persists it forever, not merely
// left unvalidated (unvalidated + accepted is exactly how a dead field lives on in storage
// indefinitely, looking meaningful to the next person who reads settings.json).
test('PUT /api/settings strips a stale maxAccuracyM from the geofence payload rather than letting it persist', () => {
  const geoBlock = /if \(A\.geofence\) \{[\s\S]*?\n    \}\n/.exec(SERVER_SRC);
  assert.ok(geoBlock, 'geofence validation block not found');
  const deleteIdx = geoBlock[0].indexOf('delete g.maxAccuracyM');
  assert.ok(deleteIdx >= 0, 'the geofence validation block must delete g.maxAccuracyM so it cannot persist through the deep-merge');
  const constGIdx = geoBlock[0].indexOf('const g = A.geofence');
  assert.ok(constGIdx >= 0 && constGIdx < deleteIdx,
    'g must be assigned from A.geofence before the stale key is deleted from it');
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
  // I1 fix (2026-09-25 review): Number(null) === 0 and Number('') === 0, so these used to
  // sanitise to a perfect 0 m fix instead of "no accuracy reported" -- the shipped client sends
  // gpsAccuracy: null whenever currentGPS is absent, so this is a real, frequent input, not a
  // theoretical one.
  assert.strictEqual(A.sanitizeGpsAccuracy(null), null, 'null must never become a fabricated 0 m fix');
  assert.strictEqual(A.sanitizeGpsAccuracy(''), null, 'an empty string must never become a fabricated 0 m fix');
  // A non-number/non-string value (e.g. a stray boolean or array in the request body) must be
  // rejected outright rather than coerced -- Number(true) === 1 and Number([7]) === 7 would
  // otherwise fabricate a plausible-looking accuracy from garbage input.
  assert.strictEqual(A.sanitizeGpsAccuracy(true), null);
  assert.strictEqual(A.sanitizeGpsAccuracy([7]), null);
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

// 2026-09-25 (review round 1): the two tests below replace a version that only compared
// indexOf() positions of source substrings. That version would still have passed if the `return`
// on the 403 line were dropped (403 sent AND the event still saved), or if the check-in test were
// bypassed so a check-out got asked for GPS too -- nothing actually ran. These execute the real
// extracted code instead: one drives webScanGateReason() itself with stubbed dependencies, the
// other simulates the route's own dispatch (a stub req/res, a sentinel standing in for "reached
// saveEvent") so a dropped `return` or a bypassed check-in test makes an assertion fail, not just
// a text pattern go missing.

test('webScanGateReason: a check-out is never asked for GPS', () => {
  // M2 (2026-09-25 review) moved getAppSettings() to run first (to short-circuit on the master
  // switch before the expensive log build) -- it now legitimately runs for a check-out too, so
  // this stub returns a normal enabled settings object instead of throwing on any call.
  let geofenceCalls = 0;
  const ctx = {
    webScanWouldBeCheckIn: () => false,
    getAppSettings: () => ({ geofence: { enabled: true } }),
    parseGpsCoords: () => { throw new Error('parseGpsCoords must not run for a check-out'); },
    geofenceCheckinReason: () => { geofenceCalls++; return 'geofence-inside'; },
  };
  vm.createContext(ctx);
  vm.runInContext(extractFunction(SERVER_SRC, 'webScanGateReason'), ctx);
  const result = ctx.webScanGateReason({ role: 'user' }, '2026-09-25T17:40:00', '13.7,100.5');
  assert.strictEqual(result, '', 'a check-out must never be gated');
  assert.strictEqual(geofenceCalls, 0, 'geofenceCheckinReason must not run when the check-in test says no');
});

// M2 fix (2026-09-25 review): webScanGateReason() used to call webScanWouldBeCheckIn() --
// buildAttendanceLogForUser() -> a full readEvents() + log build -- unconditionally, even when
// geofence.enabled is false and the answer can never be anything but ''. It now reads the master
// switch first and returns immediately, skipping that work entirely. This test proves the skip
// actually happens (not just that the final answer is still ''), by making every downstream
// collaborator throw if it is ever reached.
test('webScanGateReason: the master switch is checked first, without running the expensive log build', () => {
  const ctx = {
    webScanWouldBeCheckIn: () => { throw new Error('webScanWouldBeCheckIn (and its readEvents() log build) must not run when geofence.enabled is false'); },
    getAppSettings: () => ({ geofence: { enabled: false } }),
    parseGpsCoords: () => { throw new Error('parseGpsCoords must not run when disabled'); },
    geofenceCheckinReason: () => { throw new Error('geofenceCheckinReason must not run when disabled'); },
  };
  vm.createContext(ctx);
  vm.runInContext(extractFunction(SERVER_SRC, 'webScanGateReason'), ctx);
  const result = ctx.webScanGateReason({ role: 'user' }, '2026-09-25T08:25:00', '13.7,100.5');
  assert.strictEqual(result, '', 'a disabled geofence must always allow the scan');
});

// 2026-09-26: webScanGateReason() no longer receives or forwards a gpsAccuracy argument at all --
// geofenceCheckinReason() dropped the parameter entirely, so there is nothing left to pass through.
test('webScanGateReason: a check-in defers entirely to geofenceCheckinReason, with the live role and parsed coords', () => {
  const G = { enabled: true };
  const calls = [];
  const ctx = {
    webScanWouldBeCheckIn: () => true,
    getAppSettings: () => ({ geofence: G }),
    parseGpsCoords: raw => raw === '13.7,100.5' ? { lat: 13.7, lng: 100.5 } : null,
    geofenceCheckinReason: (...args) => { calls.push(args); return 'geofence-inside'; },
  };
  vm.createContext(ctx);
  vm.runInContext(`${extractFunction(SERVER_SRC, 'sanitizeGpsAge')}\n${extractFunction(SERVER_SRC, 'webScanGateReason')}`, ctx);

  // No 4th argument at all here (same as an older client never sending gpsAgeSec) -- must not
  // affect this test's own concern (role/coords pass-through), see the dedicated staleness tests.
  const result = ctx.webScanGateReason({ role: 'manager' }, '2026-09-25T08:25:00', '13.7,100.5');
  assert.strictEqual(result, 'geofence-inside');
  assert.strictEqual(calls.length, 1);
  assert.deepStrictEqual(calls[0], [G, 'manager', 13.7, 100.5],
    'must pass the settings object, hikUser.role and the parsed coords through unchanged, with no accuracy argument');

  // No gps at all: coords stay null, and NaN/NaN reach geofenceCheckinReason (its own
  // "lat == null" check does not apply to NaN, so this must be NaN, not null or undefined).
  ctx.webScanGateReason({ role: 'user' }, '2026-09-25T08:25:00', '');
  assert.deepStrictEqual(calls[1], [G, 'user', NaN, NaN]);
});

function extractWebscanGateWiring(routeBody) {
  const anchorIdx = routeBody.indexOf('webScanGateReason(req.hikUser');
  assert.ok(anchorIdx > 0, 'the route must call webScanGateReason(req.hikUser, ...) -- role must come from the live record, never the request body');
  const ifIdx = routeBody.lastIndexOf("if (req.hikSource === 'webscan') {", anchorIdx);
  assert.ok(ifIdx > 0, 'webScanGateReason must be called inside the webscan branch -- the physical device is never gated');
  const openIdx = routeBody.indexOf('{', ifIdx);
  return extractBraced(routeBody, ifIdx, openIdx, 'webscan gate wiring');
}

test('the gate is wired into the WebScan branch, before the event is saved', () => {
  const route = SERVER_SRC.slice(SERVER_SRC.indexOf("app.post('/api/hikvision/event'"));
  const body = route.slice(0, route.indexOf('\napp.'));
  const gateBlock = extractWebscanGateWiring(body);
  const gateAt = body.indexOf(gateBlock);
  const saveAt = body.indexOf('saveEvent({');
  assert.ok(gateAt > 0 && gateAt < saveAt, 'the gate wiring must run BEFORE saveEvent, or a refused check-in is still recorded');

  // Simulate the route's own dispatch: wrap the extracted wiring block in a function that takes
  // the same req/res/eventTime/gps/body the route has in scope (body.gpsAgeSec is read directly
  // inside the wiring block -- see review Important-2), stub webScanGateReason's return value, and
  // put a sentinel right where the route's next statement (const tz = ...) begins. If the `return`
  // on the 403 line were ever dropped, execution would fall through into the sentinel even on a
  // refusal -- this is what makes that regression a failing assertion, not a silent pass.
  function runWiring(gateReason) {
    const ctx = { webScanGateReason: () => gateReason, sentinel: () => { ctx.reached = true; }, reached: false };
    vm.createContext(ctx);
    vm.runInContext(`function wiring(req, res, eventTime, gps, body) {\n${gateBlock}\n  sentinel();\n}`, ctx);
    const calls = {};
    const res = {
      status(code) { calls.status = code; return this; },
      json(payload) { calls.json = payload; return this; },
    };
    const req = { hikSource: 'webscan', hikUser: { role: 'user', employeeNo: '1' } };
    ctx.wiring(req, res, '2026-09-25T08:25:00', '13.7,100.5', { gpsAgeSec: null });
    return { reached: ctx.reached, calls };
  }

  const refused = runWiring('geofence-inside');
  assert.strictEqual(refused.reached, false,
    'a refusal must return before reaching the next statement (saveEvent) -- would wrongly be true if `return` were dropped');
  assert.strictEqual(refused.calls.status, 403);
  // Field-by-field, not deepStrictEqual: the json payload literal is constructed by code running
  // INSIDE the vm sandbox, so it carries that realm's Object.prototype -- deepStrictEqual across
  // realms fails on prototype identity even when every value matches.
  assert.strictEqual(refused.calls.json.success, false);
  assert.strictEqual(refused.calls.json.reason, 'geofence-inside');
  assert.strictEqual(refused.calls.json.message, 'Company policy: check-in must be made with the face scanner at the office. Please scan at the device, or submit a time-correction request if you cannot.');

  const allowed = runWiring('');
  assert.strictEqual(allowed.reached, true, 'an allowed scan must fall through to saveEvent');
  assert.strictEqual(allowed.calls.status, undefined, 'an allowed scan must never send a response in this block');
});

test('the stored event carries the accuracy, and it is not public', () => {
  const route = SERVER_SRC.slice(SERVER_SRC.indexOf("app.post('/api/hikvision/event'"));
  assert.ok(/gpsAcc/.test(route.slice(0, route.indexOf('\napp.'))), 'the event must store gpsAcc');
  const pub = /const EVENT_PUBLIC_FIELDS = \[[^\]]*\]/.exec(SERVER_SRC)[0];
  assert.ok(!/gpsAcc/.test(pub), 'gpsAcc must stay out of the public projection, like gps itself');
});

console.log('Geofence: stale-GPS fix (2026-09-26)');

test('the GPS fix age is sanitised to a bounded number or null, exactly like accuracy', () => {
  const A = sandbox(SERVER_SRC, ['sanitizeGpsAge']);
  assert.strictEqual(A.sanitizeGpsAge(5), 5);
  assert.strictEqual(A.sanitizeGpsAge('12'), 12);
  assert.strictEqual(A.sanitizeGpsAge(0), 0, 'a real 0s age (just-obtained fix) must be kept');
  assert.strictEqual(A.sanitizeGpsAge(-1), null);
  assert.strictEqual(A.sanitizeGpsAge('abc'), null);
  assert.strictEqual(A.sanitizeGpsAge(undefined), null, 'an older client that never sends this field must sanitise to null, not 0');
  assert.strictEqual(A.sanitizeGpsAge(1e9), null);
  assert.strictEqual(A.sanitizeGpsAge(null), null);
  assert.strictEqual(A.sanitizeGpsAge(''), null);
  assert.strictEqual(A.sanitizeGpsAge(true), null);
  assert.strictEqual(A.sanitizeGpsAge([7]), null);
});

// 2026-09-26 (review Important-2): the route must forward the RAW body.gpsAgeSec, never a
// pre-sanitized local -- sanitizing at the route would collapse "the key is undefined" and
// "present but unusable" to the identical null, which is exactly the bypass the review found
// (gpsAgeSec: -1/90000/"x"/true/[] all used to escape the staleness check like a merely-absent
// key). webScanGateReason() now does its own sanitizing internally, where it can still see
// whether the raw value was there at all.
test('the route forwards RAW body.gpsAgeSec into the gate, not a pre-sanitized local', () => {
  const route = SERVER_SRC.slice(SERVER_SRC.indexOf("app.post('/api/hikvision/event'"));
  const body = route.slice(0, route.indexOf('\napp.'));
  assert.ok(!/const gpsAgeSec\s*=\s*sanitizeGpsAge/.test(body),
    'the route must not pre-sanitize gpsAgeSec -- that would destroy the undefined-vs-unusable distinction');
  assert.ok(/webScanGateReason\(req\.hikUser,\s*eventTime,\s*gps,\s*body\.gpsAgeSec\)/.test(body),
    'body.gpsAgeSec must be forwarded into webScanGateReason RAW, as the 4th argument');
});

test('webScanGateReason itself calls sanitizeGpsAge on the raw value it receives', () => {
  const fn = extractFunction(SERVER_SRC, 'webScanGateReason');
  assert.ok(/sanitizeGpsAge\(/.test(fn), 'webScanGateReason must sanitize the age itself, now that the route no longer does');
});

// 2026-09-26 (CRITICAL + review Important-2): webScanGateReason() independently enforces the same
// 60s bound the client-side twin (app.js's gpsIsFresh()) applies before ever sending a request, and
// must distinguish a genuinely ABSENT key (gpsAgeSecRaw === undefined -- the one-load
// compatibility window for a client that predates this field, adds nothing against a hostile
// client) from any value that is PRESENT but unusable (a negative number, one far too large, a
// string, a boolean, an array, or an explicit null) -- sanitizeGpsAge() collapses all of the
// latter to the same null a truly-absent key would sanitize to, so reading that null back as
// "absent" was a real bypass, not just an omission. These drive the real, extracted function
// (with the real sanitizeGpsAge() alongside it, stubbing only the other collaborators) so a
// regression in either the staleness arithmetic or the undefined-vs-present distinction fails
// here, not only in the wiring test above (which stubs webScanGateReason itself).
function runWebScanGateReasonStaleness({ role, gps, gpsAgeSec, wouldBeCheckIn }) {
  const G = { enabled: true };
  const calls = [];
  const ctx = {
    webScanWouldBeCheckIn: () => wouldBeCheckIn,
    getAppSettings: () => ({ geofence: G }),
    parseGpsCoords: raw => raw === gps && gps ? { lat: 13.7268315, lng: 100.52847 } : null,
    geofenceCheckinReason: (...args) => { calls.push(args); return 'stub-reason'; },
  };
  vm.createContext(ctx);
  vm.runInContext(`${extractFunction(SERVER_SRC, 'sanitizeGpsAge')}\n${extractFunction(SERVER_SRC, 'webScanGateReason')}`, ctx);
  // gpsAgeSec here is the RAW value, exactly as the route now forwards body.gpsAgeSec unsanitized.
  ctx.webScanGateReason({ role }, '2026-09-25T08:25:00', gps, gpsAgeSec);
  return { G, calls };
}

test('webScanGateReason: a PRESENT, stale gpsAgeSec (>60s) is treated as no position, even with real in-office coords', () => {
  const { G, calls } = runWebScanGateReasonStaleness({ role: 'user', gps: '13.7268315,100.52847', gpsAgeSec: 61, wouldBeCheckIn: true });
  assert.strictEqual(calls.length, 1);
  assert.deepStrictEqual(calls[0], [G, 'user', NaN, NaN],
    'a stale fix must reach geofenceCheckinReason as NaN/NaN -- exactly like no position at all, not the real (in-office) coords');
});

test('webScanGateReason: a PRESENT, fresh gpsAgeSec (<=60s) still uses the real coords', () => {
  const { G, calls } = runWebScanGateReasonStaleness({ role: 'user', gps: '13.7268315,100.52847', gpsAgeSec: 60, wouldBeCheckIn: true });
  assert.deepStrictEqual(calls[0], [G, 'user', 13.7268315, 100.52847], 'exactly 60s (the boundary) must still count as fresh');
});

test('webScanGateReason: an ABSENT gpsAgeSec (key never sent -- older client) falls through to the ordinary distance check', () => {
  // Deliberate, and the reviewer agreed: refusing every scan with no age field the moment this
  // deploys would lock out every employee still running a cached app.js. Not defence in depth --
  // see this function's own comment in server.js for the honest accounting (it adds nothing
  // against a client that lies, which can simply omit the field for the same pass-through).
  const undef = runWebScanGateReasonStaleness({ role: 'user', gps: '13.7268315,100.52847', gpsAgeSec: undefined, wouldBeCheckIn: true });
  assert.deepStrictEqual(undef.calls[0], [undef.G, 'user', 13.7268315, 100.52847]);
});

// 2026-09-26 (review Important-2, the bug itself): every one of these IS present in the request
// body (unlike the test above) -- sanitizeGpsAge() rejects each one to null, exactly the same
// null an absent key would produce, so before this fix every one of them slipped through as if
// the key had never been sent at all. Each must now be judged as no position at all (NaN/NaN),
// same as a genuinely stale fix.
test('webScanGateReason: a PRESENT-but-unusable gpsAgeSec (negative, absurd, string, boolean, array, explicit null) is treated as no position, never as absent', () => {
  for (const badValue of [-1, 90000, 'x', true, [], null]) {
    const { G, calls } = runWebScanGateReasonStaleness({ role: 'user', gps: '13.7268315,100.52847', gpsAgeSec: badValue, wouldBeCheckIn: true });
    assert.deepStrictEqual(calls[0], [G, 'user', NaN, NaN],
      `gpsAgeSec: ${JSON.stringify(badValue)} is PRESENT but unusable -- must be treated as no position, not fall through to the real coords`);
  }
});

console.log('Geofence: the client');

const JA_SRC = fs.readFileSync(path.join(ROOT, 'attendance/lang/ja.js'), 'utf8');
const INDEX_SRC = fs.readFileSync(path.join(ROOT, 'attendance/index.html'), 'utf8');

test('the check-in POST sends the accuracy and the fix age', () => {
  const fn = extractFunction(APP_SRC, 'doScan');
  assert.ok(/gpsAccuracy:/.test(fn), 'doScan must send gpsAccuracy or the server refuses every check-in');
  assert.ok(/gpsAgeSec:/.test(fn), 'doScan must send gpsAgeSec or the server cannot judge staleness for an old/modified client');
});

test('the client refuses before posting, using the same shared oracle as the button decision', () => {
  const fn = extractFunction(APP_SRC, 'doScan');
  assert.ok(/geofenceUiState\(\)/.test(fn), 'doScan must pre-check via geofenceUiState() -- the single shared decision');
  const preIdx = fn.indexOf('geofenceUiState()');
  const postIdx = fn.indexOf('/api/hikvision/event');
  assert.ok(preIdx > 0 && preIdx < postIdx, 'the pre-check must run before the request');
});

console.log('Geofence: stale-GPS fix -- client-side (2026-09-26)');

// 2026-09-26 (CRITICAL): currentGPS is written once by onGPSSuccess() and otherwise never
// re-validated -- a fix from minutes or hours ago would still satisfy the gate. gpsIsFresh() is
// the pure, testable guard both geofenceUiState() and doScan() now use to treat an old fix as no
// position at all. Pure and takes `nowMs` explicitly, so no Date.now() faking is needed here.
test('gpsIsFresh (executed): a fresh fix passes, exactly 60s is still fresh, 61s is stale, and absence is never fresh', () => {
  const A = sandbox(APP_SRC, ['gpsIsFresh']);
  const now = 1_700_000_000_000;
  assert.strictEqual(A.gpsIsFresh({ epochMs: now - 1000 }, now), true, 'a 1s-old fix is fresh');
  assert.strictEqual(A.gpsIsFresh({ epochMs: now - 60000 }, now), true, 'exactly 60s old is still fresh (boundary)');
  assert.strictEqual(A.gpsIsFresh({ epochMs: now - 60001 }, now), false, 'a hair over 60s old is stale');
  assert.strictEqual(A.gpsIsFresh({ epochMs: now - 3600000 }, now), false, 'an hour-old commute fix must never satisfy the gate');
  assert.strictEqual(A.gpsIsFresh(null, now), false, 'no position at all is not fresh');
  assert.strictEqual(A.gpsIsFresh(undefined, now), false);
  assert.strictEqual(A.gpsIsFresh({ epochMs: NaN }, now), false, 'a non-finite timestamp is not fresh');
  assert.strictEqual(A.gpsIsFresh({}, now), false, 'a missing epochMs field (old-shaped currentGPS) is not fresh');
});

// 2026-09-26 (CRITICAL): PERMISSION_DENIED (1) and POSITION_UNAVAILABLE (2) are terminal -- no
// further fix is coming without the user changing something -- so the stale commute position must
// not go on satisfying the gate. TIMEOUT (3) is a deliberate exception: watchPosition keeps
// retrying on its own and a single timeout is often transient, while a still-fresh position from
// moments ago may already be sitting in currentGPS -- see the function's own comment in app.js for
// the full reasoning. This drives the real, extracted function.
test('handleGPSError (executed): clears currentGPS on PERMISSION_DENIED/POSITION_UNAVAILABLE, keeps it on TIMEOUT', () => {
  function run(code) {
    const ctx = {
      currentGPS: { lat: '13.7', lng: '100.5' },
      updateGPSError: () => {},
      gpsErrorMsg: () => '',
    };
    vm.createContext(ctx);
    vm.runInContext(extractFunction(APP_SRC, 'handleGPSError'), ctx);
    ctx.handleGPSError({ code });
    return ctx.currentGPS;
  }
  assert.strictEqual(run(1), null, 'PERMISSION_DENIED must clear currentGPS');
  assert.strictEqual(run(2), null, 'POSITION_UNAVAILABLE must clear currentGPS');
  assert.notStrictEqual(run(3), null, 'TIMEOUT must NOT clear currentGPS -- see the function\'s own comment for why');
});

test('onGPSSuccess (executed): stores an epochMs alongside the ISO timestamp, for the staleness check', () => {
  const elements = {};
  const stub = () => ({ style: {}, textContent: '' });
  const ctx = {
    document: {
      getElementById: id => elements[id] || (elements[id] = stub()),
      querySelectorAll: () => [],
    },
    currentGPS: null,
    L: en => en,
    fmtTime: () => '',
    initGpsMap: () => {},
    scheduleServerClockFromGps: () => {},
  };
  vm.createContext(ctx);
  vm.runInContext(extractFunction(APP_SRC, 'onGPSSuccess'), ctx);
  const before = Date.now();
  ctx.onGPSSuccess({ coords: { latitude: 13.7268315, longitude: 100.52847, accuracy: 12 } });
  const after = Date.now();
  assert.ok(ctx.currentGPS, 'onGPSSuccess must set currentGPS');
  assert.ok(Number.isFinite(ctx.currentGPS.epochMs) && ctx.currentGPS.epochMs >= before && ctx.currentGPS.epochMs <= after,
    'epochMs must be a real Date.now() snapshot taken during this call');
  assert.strictEqual(ctx.currentGPS.latRaw, 13.7268315);
});

// 2026-09-25 (review round 4): webCheckinWouldBeCheckIn() is the client half of the "would this
// scan become a CHECK-IN" rule (webScanWouldBeCheckIn() in server.js is the other) and is shared
// by doScan()'s pre-check and geofenceUiState()'s button state -- but until now it had no executed
// test of its own; every existing test stubbed it out. This drives the real, extracted function
// against a controllable clock/log so a regression in any one of its four branches fails here.
test('webCheckinWouldBeCheckIn (executed): already checked in, pre-dawn, at/after the cutoff, and the ordinary case', () => {
  function run(bk, existingCheckIn) {
    const ctx = {
      currentUser: { id: 'u1' },
      CHECKIN_CUTOFF: '13:00',
      attendanceLog: existingCheckIn ? { 'u1|2026-09-25': { checkIn: existingCheckIn } } : {},
      scanYmd: () => bk,
      businessDateFromYmd: () => '2026-09-25',
      attKey: (userId, dateStr) => `${userId}|${dateStr}`,
    };
    vm.createContext(ctx);
    vm.runInContext(extractFunction(APP_SRC, 'webCheckinWouldBeCheckIn'), ctx);
    return ctx.webCheckinWouldBeCheckIn();
  }
  assert.strictEqual(run({ h: 8, min: 25 }, '08:00'), false, 'already checked in today -- the next press is a check-out');
  assert.strictEqual(run({ h: 2, min: 10 }, null), false, 'before 05:00 is a late-night check-out');
  assert.strictEqual(run({ h: 13, min: 0 }, null), false, 'at the cutoff is a check-out');
  assert.strictEqual(run({ h: 14, min: 30 }, null), false, 'after the cutoff is a check-out');
  assert.strictEqual(run({ h: 8, min: 25 }, null), true, 'the ordinary case: no check-in yet, before the cutoff, not pre-dawn');
});

test('the Settings page exposes all four geofence fields and saves them safely (set-geo-acc is gone)', () => {
  for (const id of ['set-geo-enabled', 'set-geo-lat', 'set-geo-lng', 'set-geo-radius']) {
    assert.ok(APP_SRC.includes(id), `Settings field missing: ${id}`);
  }
  assert.ok(!APP_SRC.includes('set-geo-acc'), 'set-geo-acc must be removed along with maxAccuracyM');
  const save = extractFunction(APP_SRC, 'saveSettingsPage');
  for (const key of ['enabled', 'lat', 'lng', 'radiusM']) {
    assert.ok(new RegExp(`geofence\\.${key}\\s*=`).test(save), `save must write geofence.${key}`);
  }
  assert.ok(!/geofence\.maxAccuracyM/.test(save), 'save must no longer write geofence.maxAccuracyM');
  // Falsy-zero guard: `ff()` ends in `|| 0`, which would turn an empty latitude into 0.
  const geoLines = save.split('\n').filter(l => /geofence\.(lat|lng|radiusM)\s*=/.test(l));
  assert.ok(geoLines.length === 3, 'all three numeric fields must be assigned');
  for (const line of geoLines) {
    assert.ok(!/\bff\(|\bfi\(/.test(line),
      `use the strict reader, not fi()/ff() -- they coerce an empty field to 0: ${line.trim()}`);
  }
  assert.ok(/geofenceNum\(/.test(save), 'a strict numeric reader must be used for the geofence fields');
});

// Minor 3 (2026-09-26 review): the Radius field used to share a row2() with the (now-removed)
// accuracy field, which supplied the 12px gap before the "Inside this radius..." hint line below.
// Once accuracy was deleted, the standalone field() lost that spacing entirely. Fixed by wrapping
// it in the same margin-bottom:12px div this Settings page already uses for other single elements.
test('the standalone Radius field keeps its 12px gap now that its row2() partner is gone', () => {
  // Anchored on the card's own title rather than on the section() signature: 2026-09-26 added a
  // tab key as its first argument, which broke this test without anything about the card changing.
  const cardStart = APP_SRC.indexOf("L('Area where web check-in is blocked");
  assert.ok(cardStart >= 0, 'geofence Settings card not found');
  const cardEnd = APP_SRC.indexOf("adminSection('🏖️'", cardStart);
  const card = APP_SRC.slice(cardStart, cardEnd);
  assert.ok(/margin-bottom:12px">\$\{field\(L\('Radius \(m\)'/.test(card),
    'the Radius field must be wrapped in a margin-bottom:12px div, matching the rest of this page\'s standalone elements');
});

// 2026-09-25 (review round 3, Important): the test above is purely string/regex-based -- it would
// still pass if `geofenceNum` were rewritten as `parseFloat(v) || fallback` (breaking a real 0),
// or if the `set-geo-enabled` checkbox read lost its existence guard (silently disabling the
// geofence company-wide when the element is absent, since `null?.checked` -> undefined ->
// `!!undefined` -> false). These tests execute the REAL extracted read-back logic in a vm sandbox
// with a stubbed `document`/`APP_SETTINGS`, the way the webScanGateReason/geofenceUiState tests
// above do, so a regression in either direction fails an assertion, not just a text pattern.
function extractGeofenceSaveSnippet(appSrc) {
  const save = extractFunction(appSrc, 'saveSettingsPage');
  const numFn = /const geofenceNum = \(id, fallback\) => \{[\s\S]*?\n  \};/.exec(save);
  assert.ok(numFn, 'geofenceNum definition not found in saveSettingsPage');

  // Anchor on the stable, unrelated line immediately BEFORE the geofence writes (not on any
  // particular guard implementation for `enabled`), so a regression that changes how `enabled`
  // is read -- guarded or not -- is still captured verbatim instead of breaking extraction.
  const anchor = "APP_SETTINGS.workSchedule.standardStartMinute";
  const anchorIdx = save.indexOf(anchor);
  assert.ok(anchorIdx >= 0, 'workSchedule anchor not found (used to bound the geofence write block)');
  const blockStart = save.indexOf('\n', anchorIdx) + 1;

  const radiusIdx = save.indexOf('APP_SETTINGS.geofence.radiusM', blockStart);
  assert.ok(radiusIdx >= 0, 'geofence.radiusM write not found in saveSettingsPage');
  const blockEnd = save.indexOf('\n', radiusIdx);
  const writes = save.slice(blockStart, blockEnd >= 0 ? blockEnd : save.length);

  return `${numFn[0]}\n${writes}`;
}
function runGeofenceSave(existingGeofence, elements) {
  const snippet = extractGeofenceSaveSnippet(APP_SRC);
  const ctx = {
    document: {
      getElementById(id) {
        return Object.prototype.hasOwnProperty.call(elements, id) ? elements[id] : null;
      },
    },
    APP_SETTINGS: { geofence: { ...existingGeofence } },
  };
  vm.createContext(ctx);
  vm.runInContext(`function run() {\n${snippet}\n}`, ctx);
  ctx.run();
  return ctx.APP_SETTINGS.geofence;
}

test('geofence save (executed): all four fields read correctly when every element is present', () => {
  const existing = { enabled: false, lat: 1, lng: 2, radiusM: 3 };
  const elements = {
    'set-geo-enabled': { checked: true },
    'set-geo-lat': { value: '13.7268315' },
    'set-geo-lng': { value: '100.52847' },
    'set-geo-radius': { value: '200' },
  };
  const result = runGeofenceSave(existing, elements);
  assert.strictEqual(result.enabled, true);
  assert.strictEqual(result.lat, 13.7268315);
  assert.strictEqual(result.lng, 100.52847);
  assert.strictEqual(result.radiusM, 200);
  assert.strictEqual(result.maxAccuracyM, undefined, 'maxAccuracyM must never be written back by the save path');
});

test('geofence save (executed): a missing enabled checkbox keeps the stored value, never writes false', () => {
  // Risk 1 (review round 3): `!!document.getElementById(id)?.checked` with no existence guard
  // turns an absent element into `false`, silently disabling the geofence company-wide.
  const existing = { enabled: true, lat: 1, lng: 2, radiusM: 3 };
  const elements = {
    // set-geo-enabled deliberately absent -- simulates the element missing from the DOM
    'set-geo-lat': { value: '1' },
    'set-geo-lng': { value: '2' },
    'set-geo-radius': { value: '3' },
  };
  const result = runGeofenceSave(existing, elements);
  assert.strictEqual(result.enabled, true, 'a missing checkbox must not silently disable the geofence');
});

test('geofence save (executed): a real 0 is kept, not replaced by the fallback', () => {
  // Mutation guard: would fail if geofenceNum were rewritten as `parseFloat(v) || fallback`
  // instead of the Number.isFinite check -- 0 is a valid latitude (the equator) but falsy.
  const existing = { enabled: true, lat: 13.7, lng: 100.5, radiusM: 150 };
  const elements = {
    'set-geo-enabled': { checked: true },
    'set-geo-lat': { value: '0' },
    'set-geo-lng': { value: '100.5' },
    'set-geo-radius': { value: '150' },
  };
  const result = runGeofenceSave(existing, elements);
  assert.strictEqual(result.lat, 0, 'a real 0 must be kept, not silently replaced by the fallback');
});

test('geofence save (executed): a blank, garbage or missing numeric field keeps the stored value', () => {
  const existing = { enabled: true, lat: 13.7, lng: 100.5, radiusM: 150 };
  const elements = {
    'set-geo-enabled': { checked: true },
    'set-geo-lat': { value: '' },
    'set-geo-lng': { value: 'abc' },
    // set-geo-radius element deliberately absent entirely
  };
  const result = runGeofenceSave(existing, elements);
  assert.strictEqual(result.lat, 13.7, 'blank latitude must keep the stored value');
  assert.strictEqual(result.lng, 100.5, 'unreadable longitude must keep the stored value');
  assert.strictEqual(result.radiusM, 150, 'missing radius element must keep the stored value');
});

// 2026-09-25 (review round 4): the version above only grepped independently for an EN substring in
// app.js and an unrelated-looking JA substring in ja.js -- it could never prove the two were the
// SAME string, i.e. that ja.js's key is the exact L() English argument. All 13 keys introduced by
// this feature were checked by hand instead. Replaced with an assertion that extracts the real
// L('English', 'Thai') arguments from the actual call sites (geofenceMessage() and the Settings
// card) plus the static policy note's data-en attribute, and requires ja.js to carry an EXACT
// '"<that English string>":' key for every one of them -- so the next string added is caught
// automatically instead of depending on someone checking by hand.
function extractLArgPairs(snippet) {
  // Matches L('EN', 'TH') / L("EN", "TH") -- both quote styles appear elsewhere in app.js, though
  // every geofence call site happens to use single quotes.
  const out = [];
  const re = /\bL\(\s*(['"])((?:\\.|(?!\1)[^\\])*)\1\s*,\s*(['"])((?:\\.|(?!\3)[^\\])*)\3/g;
  let m;
  while ((m = re.exec(snippet))) out.push({ en: m[2].replace(/\\(.)/g, '$1'), th: m[4].replace(/\\(.)/g, '$1') });
  return out;
}

test('every new message exists in all three languages, with ja.js keyed on the exact English argument', () => {
  const msgFn = extractFunction(APP_SRC, 'geofenceMessage');
  const settingsStart = APP_SRC.indexOf("L('Area where web check-in is blocked");
  assert.ok(settingsStart >= 0, 'geofence Settings card not found (adminSection anchor)');
  const settingsEnd = APP_SRC.indexOf("L('Leave Policy'", settingsStart);
  assert.ok(settingsEnd > settingsStart, 'end of geofence Settings card not found (next adminSection anchor)');
  const settingsSnippet = APP_SRC.slice(settingsStart, settingsEnd);

  const pairs = [...extractLArgPairs(msgFn), ...extractLArgPairs(settingsSnippet)];
  // 2026-09-26: unchanged at 9 -- geofenceMessage() still has exactly 2 L() calls (the
  // 'geofence-inside' text just got longer, with the remedy sentence added; no call was added or
  // removed) and the Settings card is untouched by this round of fixes.
  assert.strictEqual(pairs.length, 9, `expected 9 L(en, th) calls across geofenceMessage + the Settings card, found ${pairs.length}`);

  // The #geofence-modal header is translated by fixStaticText()/applyStaticI18n() via data-en
  // (which also keys into window.LANG_JA, see applyStaticI18n()), not via L() -- it is the 10th
  // string. (Its dismiss button uses data-en="Close" -- 2026-09-26 review Minor-3: it originally
  // said data-en="OK", but the only "OK" key in ja.js is "一致" from the unrelated Hikvision
  // sync-mismatch table, so the button rendered as that word in Japanese; "Close" reuses the
  // correct, already-widely-used key this app's other btn-primary dismiss buttons share -- see
  // e.g. closeLeaveDetail()/closeAttDetail() in index.html -- so it needs no check of its own
  // here. The permanent policy banner this used to be is gone -- see "no permanent policy
  // banner..." above.)
  const modalStart = INDEX_SRC.indexOf('id="geofence-modal"');
  assert.ok(modalStart >= 0, 'geofence-modal not found');
  const headerMatch = /<h3\s+data-en="((?:[^"\\]|\\.)*)"/.exec(INDEX_SRC.slice(modalStart, modalStart + 400));
  assert.ok(headerMatch, 'geofence-modal header data-en attribute not found');
  pairs.push({ en: headerMatch[1], th: null });

  assert.strictEqual(pairs.length, 10, `expected 10 total strings (9 L() + the modal's static header), found ${pairs.length}`);

  for (const { en, th } of pairs) {
    assert.ok(en.length > 0, 'an L() English argument must not be empty');
    if (th !== null) assert.ok(th.length > 0, `Thai argument must not be empty for: ${en}`);
    const key = `"${en}":`;
    assert.ok(JA_SRC.includes(key), `ja.js is missing an exact key for the English string: ${en}`);
  }
});

// 2026-09-26: the removed 'geofence-accuracy' reason code took its own two ja.js strings, plus
// the Settings label for the removed field, with it -- an unreachable branch is worse than none,
// and a leftover ja.js key for a string nothing calls any more is the same problem the other way.
test('the removed accuracy-ceiling strings are gone from ja.js, not just unreachable', () => {
  for (const removed of [
    'Your location is not precise enough yet',
    ' — please wait a moment or move to an open area.',
    'Max GPS accuracy (m)',
  ]) {
    assert.ok(!JA_SRC.includes(`"${removed}":`), `ja.js still carries the removed key: ${removed}`);
  }
});

// 2026-09-26 (owner): the permanent policy banner and the always-on hint are gone -- the geofence
// never disables the button any more, so there is nothing left for either to stand in for.
test('no permanent policy banner or always-on hint remain in the markup', () => {
  assert.ok(!/id="scan-policy-note"/.test(INDEX_SRC), 'the permanent policy banner must be removed');
  assert.ok(!/id="scan-geofence-hint"/.test(INDEX_SRC), 'the always-on hint must be removed');
});

test('the geofence modal exists with the expected structure', () => {
  assert.ok(/id="geofence-modal"/.test(INDEX_SRC), '#geofence-modal must exist');
  assert.ok(/id="geofence-modal-body"/.test(INDEX_SRC), '#geofence-modal-body must exist -- openGeofenceModal() fills it');
  assert.ok(/onclick="closeGeofenceModal\(\)"/.test(INDEX_SRC), 'the modal must be closable, following this app\'s existing modal convention');
});

// 2026-09-26 (review Minor-3): the dismiss button used to say data-en="OK", but ja.js's only "OK"
// key ("一致") is the Hikvision sync-mismatch table's "Match" label, not a generic dismiss word --
// the button rendered as that word in Japanese. Reused "Close" instead, the same key this app's
// other btn-primary dismiss buttons (closeLeaveDetail(), closeAttDetail(), etc.) already carry
// correctly.
test('the modal dismiss button does not reuse the mistranslated "OK" key', () => {
  const modalStart = INDEX_SRC.indexOf('id="geofence-modal"');
  const modalEnd = INDEX_SRC.indexOf('</div>\n</div>\n\n<script', modalStart);
  const modalHtml = INDEX_SRC.slice(modalStart, modalEnd > modalStart ? modalEnd : modalStart + 1000);
  assert.ok(/closeGeofenceModal\(\)"\s+data-en="Close"/.test(modalHtml),
    'the dismiss button must use data-en="Close", not "OK" (ja.js\'s only "OK" key is unrelated and wrong here)');
  const closeJa = /"Close":\s*"((?:[^"\\]|\\.)*)"/.exec(JA_SRC);
  assert.ok(closeJa, 'ja.js must have a "Close" key');
  assert.notStrictEqual(closeJa[1], '一致', 'must not collide with the Hikvision sync-mismatch table\'s "Match" label');
});

// 2026-09-26 (owner): the geofence must NEVER disable #scan-btn any more -- applyGeofenceToScanButton()
// (which used to set btn.disabled/toggle .scan-blocked from geofenceUiState()) is removed entirely,
// and nothing has replaced it with an equivalent. Every OTHER reason the button can be disabled
// (observer accounts via blockIfObserver(), an in-flight scan via _scanInFlight/scanBtn.disabled in
// doScan()) is untouched -- this only asserts the geofence-specific path is gone.
test('the geofence never disables the scan button any more', () => {
  assert.ok(!/function applyGeofenceToScanButton/.test(APP_SRC), 'the button-disabling function must be removed entirely');
  assert.ok(!APP_SRC.includes('scan-blocked'), 'the now-dead disabled-state CSS class must not be referenced any more');
  assert.ok(!/btn\.disabled\s*=\s*st\.blocked/.test(APP_SRC), 'nothing may assign the geofence decision into btn.disabled');
  // doScan() itself must still disable the button while a request is in flight -- that is a
  // DIFFERENT, still-legitimate reason and must be left exactly as it is.
  const doScanFn = extractFunction(APP_SRC, 'doScan');
  assert.ok(/scanBtn\.disabled\s*=\s*true/.test(doScanFn), 'the in-flight disable in doScan() must still be there');
});

// currentUser is guarded defensively in geofenceUiState() even though doScan() -- its only caller
// -- is only ever reachable after login. The guard costs nothing to keep; this proves it stays.
test('geofenceUiState guards every currentUser read', () => {
  const fn = extractFunction(APP_SRC, 'geofenceUiState');
  assert.ok(/currentUser/.test(fn) === false || /currentUser\s*&&/.test(fn) || /currentUser\?\./.test(fn),
    'guard every currentUser read in geofenceUiState');
});

// 2026-09-25 (review round 2, Critical): geofenceUiState() must be aware of whether the next press
// would be a check-in or a check-out (via webCheckinWouldBeCheckIn()) -- checking out on-site in
// the evening must never be refused by location. These stub that shared test directly (rather than
// driving scanYmd()/attendanceLog/etc. through it) so a regression that stops checking it fails
// loudly instead of silently. _geofenceSettingsFresh/_geofenceAttendanceFresh are stubbed true and
// gpsIsFresh stubbed true so these two tests isolate exactly the webCheckinWouldBeCheckIn() branch;
// the fail-open and staleness branches have their own dedicated tests below.
test('geofenceUiState never blocks a press that would not be a new check-in, even standing at the office', () => {
  const ctx = {
    webCheckinWouldBeCheckIn: () => false,
    geofenceCheckinReason: () => { throw new Error('geofenceCheckinReason must not run -- this press is not a check-in'); },
    geofenceMessage: () => { throw new Error('geofenceMessage must not run -- this press is not a check-in'); },
    gpsIsFresh: () => { throw new Error('gpsIsFresh must not run -- returned before reaching it'); },
    currentUser: { role: 'user' },
    currentGPS: { latRaw: PASO.lat, lngRaw: PASO.lng, accuracy: 10 },
    APP_SETTINGS: { geofence: G },
    _geofenceSettingsFresh: true,
    _geofenceAttendanceFresh: true,
  };
  vm.createContext(ctx);
  vm.runInContext(extractFunction(APP_SRC, 'geofenceUiState'), ctx);
  const st = ctx.geofenceUiState();
  // Field-by-field, not deepStrictEqual: `st` is an object literal built INSIDE the vm sandbox,
  // so it carries that realm's Object.prototype -- deepStrictEqual across realms fails on
  // prototype identity even when every value matches (see the wiring test above for the same note).
  assert.strictEqual(st.blocked, false, 'a check-out (or late-night return, or after-cutoff press) must never be blocked by location');
  assert.strictEqual(st.reason, '');
  assert.strictEqual(st.text, '');
});

test('geofenceUiState still blocks an actual check-in standing at the office, with fresh settings/attendance/position', () => {
  const ctx = {
    webCheckinWouldBeCheckIn: () => true,
    geofenceCheckinReason: () => 'geofence-inside',
    geofenceMessage: reason => `msg:${reason}`,
    gpsIsFresh: () => true,
    currentUser: { role: 'user' },
    currentGPS: { latRaw: PASO.lat, lngRaw: PASO.lng, accuracy: 10 },
    APP_SETTINGS: { geofence: G },
    _geofenceSettingsFresh: true,
    _geofenceAttendanceFresh: true,
  };
  vm.createContext(ctx);
  vm.runInContext(extractFunction(APP_SRC, 'geofenceUiState'), ctx);
  const st = ctx.geofenceUiState();
  assert.strictEqual(st.blocked, true);
  assert.strictEqual(st.reason, 'geofence-inside');
});

// 2026-09-26 (Important #2a/#2b, fail-open): until this session has genuinely fresh settings AND
// fresh attendance, geofenceUiState() must never refuse locally -- see the flags' own comment in
// app.js. Real scenarios this fixes: GET /api/settings failed (or is served from a stale pre-off
// service-worker cache) so the compiled-in geofence.enabled:true would otherwise still apply; and
// GET /api/events failed so attendanceLog looks empty and a real check-OUT would otherwise look
// like an unknown first scan and get wrongly geofenced.
test('geofenceUiState fails OPEN when settings have not loaded fresh this session', () => {
  const ctx = {
    webCheckinWouldBeCheckIn: () => true,
    geofenceCheckinReason: () => { throw new Error('geofenceCheckinReason must not run -- settings are not fresh'); },
    geofenceMessage: () => { throw new Error('geofenceMessage must not run -- settings are not fresh'); },
    gpsIsFresh: () => true,
    currentUser: { role: 'user' },
    currentGPS: { latRaw: PASO.lat, lngRaw: PASO.lng },
    APP_SETTINGS: { geofence: G },
    _geofenceSettingsFresh: false,
    _geofenceAttendanceFresh: true,
  };
  vm.createContext(ctx);
  vm.runInContext(extractFunction(APP_SRC, 'geofenceUiState'), ctx);
  const st = ctx.geofenceUiState();
  assert.strictEqual(st.blocked, false, 'must fail open when GET /api/settings has not succeeded this session');
  assert.strictEqual(st.reason, '');
});

test('geofenceUiState fails OPEN when attendance has not loaded fresh this session', () => {
  const ctx = {
    webCheckinWouldBeCheckIn: () => true,
    geofenceCheckinReason: () => { throw new Error('geofenceCheckinReason must not run -- attendance is not fresh'); },
    geofenceMessage: () => { throw new Error('geofenceMessage must not run -- attendance is not fresh'); },
    gpsIsFresh: () => true,
    currentUser: { role: 'user' },
    currentGPS: { latRaw: PASO.lat, lngRaw: PASO.lng },
    APP_SETTINGS: { geofence: G },
    _geofenceSettingsFresh: true,
    _geofenceAttendanceFresh: false,
  };
  vm.createContext(ctx);
  vm.runInContext(extractFunction(APP_SRC, 'geofenceUiState'), ctx);
  const st = ctx.geofenceUiState();
  assert.strictEqual(st.blocked, false, 'must fail open when GET /api/events has not succeeded this session -- a real check-out must never look like an unknown first scan');
});

// 2026-09-26 (CRITICAL #1): a stale fix must reach geofenceCheckinReason as NaN/NaN -- exactly
// like no position at all -- never the real (possibly in-office) coordinates.
test('geofenceUiState (Critical 1): a stale GPS fix is treated as no position, not the real coords', () => {
  let seenLat, seenLng;
  const ctx = {
    webCheckinWouldBeCheckIn: () => true,
    geofenceCheckinReason: (_G, _role, lat, lng) => { seenLat = lat; seenLng = lng; return 'geofence-no-position'; },
    geofenceMessage: reason => `msg:${reason}`,
    gpsIsFresh: () => false, // stale
    currentUser: { role: 'user' },
    currentGPS: { latRaw: PASO.lat, lngRaw: PASO.lng },
    APP_SETTINGS: { geofence: G },
    _geofenceSettingsFresh: true,
    _geofenceAttendanceFresh: true,
  };
  vm.createContext(ctx);
  vm.runInContext(extractFunction(APP_SRC, 'geofenceUiState'), ctx);
  const st = ctx.geofenceUiState();
  assert.ok(Number.isNaN(seenLat) && Number.isNaN(seenLng), 'a stale fix must be passed through as NaN/NaN, not the real coordinates');
  assert.strictEqual(st.blocked, true);
  assert.strictEqual(st.reason, 'geofence-no-position');
});

test('openGeofenceModal/closeGeofenceModal (executed): follow this app\'s existing modal-overlay convention', () => {
  const modalEl = { classList: { added: [], removed: [], add(c) { this.added.push(c); }, remove(c) { this.removed.push(c); } } };
  const bodyEl = { textContent: '' };
  const ctx = {
    document: { getElementById: id => id === 'geofence-modal' ? modalEl : id === 'geofence-modal-body' ? bodyEl : null },
    geofenceMessage: reason => `msg:${reason}`,
  };
  vm.createContext(ctx);
  vm.runInContext(`${extractFunction(APP_SRC, 'openGeofenceModal')}\n${extractFunction(APP_SRC, 'closeGeofenceModal')}`, ctx);
  ctx.openGeofenceModal('geofence-inside');
  assert.ok(modalEl.classList.added.includes('show'), 'openGeofenceModal must add the "show" class');
  assert.strictEqual(bodyEl.textContent, 'msg:geofence-inside', 'openGeofenceModal must render the reason\'s message into the body');
  ctx.closeGeofenceModal();
  assert.ok(modalEl.classList.removed.includes('show'), 'closeGeofenceModal must remove the "show" class');
});

test('applyLanguage refreshes the geofence modal body while it is open, so a language switch mid-press is not stuck in the old language', () => {
  const fn = extractFunction(APP_SRC, 'applyLanguage');
  assert.ok(/geofence-modal/.test(fn) && /openGeofenceModal\(/.test(fn),
    'applyLanguage must re-render the geofence modal body (via openGeofenceModal) when it is currently shown');
});

// 2026-09-26 (owner + review Important-1): a press that would be blocked must open the modal and
// send NO request at all -- not even reach the code that sets _scanInFlight/posts the request --
// UNLESS the block was 'geofence-no-position', in which case ONE fresh getCurrentPosition() must
// be tried first (a stationary device's watchPosition can go silent forever after login; see
// requestFreshPosition()'s own comment), and only the SECOND (post-refresh) verdict decides.
// 'geofence-inside' is never retried -- a real, current in-range position is a genuine refusal a
// retry cannot change. This extracts the real wiring block from doScan() (the same "wrap in a
// function + sentinel" technique the server-side wiring test above uses) so a dropped `return`, a
// retry on the wrong reason, or a call to the wrong function, fails an assertion here instead of
// only in a live browser. MUTATION-VERIFIED by hand (twice): (1) removing the `return` after
// openGeofenceModal() made `reached` become true on a blocked press; (2) removing the refresh
// block entirely made the "stale fix, refresh succeeds -> allowed" case fail. Both failed as
// expected, then the source was restored (see the report for the transcript).
function extractDoScanGateWiring(fnBody) {
  // Starts at the scanBtn/labelEl declarations, not `let gate = ...`, because the refresh block
  // uses both (to show the press is doing something during the await) and they must stay in scope.
  const anchor = "const scanBtn = document.getElementById('scan-btn');";
  const anchorIdx = fnBody.indexOf(anchor);
  assert.ok(anchorIdx >= 0, 'doScan must look up scanBtn before the gate check');
  const gateIdx = fnBody.indexOf('let gate = geofenceUiState();', anchorIdx);
  assert.ok(gateIdx > anchorIdx, 'doScan must call geofenceUiState() to decide the gate');
  const endNeedle = 'if (gate.blocked) { openGeofenceModal(gate.reason); return; }';
  const endIdx = fnBody.indexOf(endNeedle, gateIdx);
  assert.ok(endIdx > gateIdx, 'the final blocked-check not found after the gate is (re)computed');
  return fnBody.slice(anchorIdx, endIdx + endNeedle.length);
}
test('doScan (executed wiring): a blocked press opens the modal and returns before any request is sent', () => {
  const fn = extractFunction(APP_SRC, 'doScan');
  const block = extractDoScanGateWiring(fn);
  // gateResults: what geofenceUiState() returns on the 1st call, then the 2nd (post-refresh) call,
  // if a refresh happens at all. freshPos: what requestFreshPosition() resolves to.
  function runWiring(gateResults, freshPos) {
    let gateCall = 0;
    const ctx = {
      geofenceUiState: () => gateResults[Math.min(gateCall++, gateResults.length - 1)],
      requestFreshPosition: () => { ctx.refreshCalled = true; return Promise.resolve(freshPos); },
      onGPSSuccess: pos => { ctx.onGPSSuccessCalledWith = pos; },
      openGeofenceModal: r => { ctx.modalReason = r; },
      sentinel: () => { ctx.reached = true; },
      document: { getElementById: () => ({ disabled: false, textContent: '' }) },
      L: en => en,
      _scanInFlight: false,
      reached: false, modalReason: null, refreshCalled: false, onGPSSuccessCalledWith: null,
    };
    vm.createContext(ctx);
    vm.runInContext(`async function wiring() {\n${block}\n  sentinel();\n}`, ctx);
    return ctx.wiring().then(() => ctx);
  }

  return Promise.resolve()
    .then(() => runWiring([{ blocked: true, reason: 'geofence-inside' }], null))
    .then(insideRun => {
      assert.strictEqual(insideRun.refreshCalled, false, 'geofence-inside must never trigger a refresh -- a real in-range position is not something a retry can fix');
      assert.strictEqual(insideRun.reached, false, 'a blocked press must return before _scanInFlight is ever set -- i.e. before any request is sent');
      assert.strictEqual(insideRun.modalReason, 'geofence-inside');
    })
    .then(() => runWiring([{ blocked: false, reason: '' }], null))
    .then(allowedRun => {
      assert.strictEqual(allowedRun.refreshCalled, false, 'an already-allowed press must not trigger a pointless refresh');
      assert.strictEqual(allowedRun.reached, true, 'an allowed press must fall through toward sending the request');
      assert.strictEqual(allowedRun.modalReason, null, 'the modal must never open for an allowed press');
    })
    // Important-1's own scenario: a stale/absent stored fix (1st verdict blocked), then a fresh
    // getCurrentPosition() succeeds and the re-evaluated 2nd verdict allows it.
    .then(() => runWiring(
      [{ blocked: true, reason: 'geofence-no-position' }, { blocked: false, reason: '' }],
      { coords: { latitude: 13.7268315, longitude: 100.52847, accuracy: 10 } }
    ))
    .then(refreshAllowedRun => {
      assert.strictEqual(refreshAllowedRun.refreshCalled, true, 'a stale/absent position must trigger exactly one refresh attempt');
      assert.ok(refreshAllowedRun.onGPSSuccessCalledWith, 'a successful refresh must be fed into onGPSSuccess so currentGPS actually updates');
      assert.strictEqual(refreshAllowedRun.reached, true, 'a refresh that resolves the block must let the press proceed');
      assert.strictEqual(refreshAllowedRun.modalReason, null, 'the modal must not open once the refresh clears the block');
    })
    // Both stale AND the refresh itself fails (getCurrentPosition errors) -> refused, via the
    // existing no-position modal, same as the brief asks for.
    .then(() => runWiring(
      [{ blocked: true, reason: 'geofence-no-position' }, { blocked: true, reason: 'geofence-no-position' }],
      null
    ))
    .then(bothFailRun => {
      assert.strictEqual(bothFailRun.refreshCalled, true);
      assert.strictEqual(bothFailRun.onGPSSuccessCalledWith, null, 'a failed refresh must never call onGPSSuccess');
      assert.strictEqual(bothFailRun.reached, false, 'refusing must still send no request');
      assert.strictEqual(bothFailRun.modalReason, 'geofence-no-position', 'a failed refresh must surface the existing no-position modal, not silently do nothing');
    });
});

test('doScan: a 403 that slips through from the server also opens the modal, not a toast', () => {
  const fn = extractFunction(APP_SRC, 'doScan');
  const catchIdx = fn.indexOf('} catch (e) {');
  const finallyIdx = fn.indexOf('} finally {', catchIdx);
  assert.ok(catchIdx > 0 && finallyIdx > catchIdx, 'doScan\'s catch/finally blocks not found');
  const catchBlock = fn.slice(catchIdx, finallyIdx);
  assert.ok(/e\.geofenceReason/.test(catchBlock), 'the catch block must branch on a tagged geofence error');
  assert.ok(/openGeofenceModal\(\s*e\.geofenceReason\s*\)/.test(catchBlock), 'a geofence-tagged error must open the modal, not showToast()');

  const throwSiteIdx = fn.indexOf('res.status === 403 && data.reason');
  assert.ok(throwSiteIdx > 0 && throwSiteIdx < catchIdx, 'the 403 must be tagged with geofenceReason before the catch block, not handled inline there');
});

test('freshness flags: set only after a genuinely successful load, and reset on logout', () => {
  const settingsFn = extractFunction(APP_SRC, 'loadSettingsFromBackend');
  const okIdx = settingsFn.indexOf('if (!res.ok)');
  const settingsFreshIdx = settingsFn.indexOf('_geofenceSettingsFresh = true');
  assert.ok(okIdx >= 0 && settingsFreshIdx > okIdx, '_geofenceSettingsFresh must be set only after the res.ok check, never before it');

  const attFn = extractFunction(APP_SRC, 'loadAttendanceFromBackend');
  const returnTrueIdx = attFn.lastIndexOf('return true;');
  const attFreshIdx = attFn.indexOf('_geofenceAttendanceFresh = true');
  assert.ok(attFreshIdx >= 0 && attFreshIdx < returnTrueIdx, '_geofenceAttendanceFresh must be set right before the successful return, not after it');

  const logoutFn = extractFunction(APP_SRC, 'logout');
  assert.ok(/_geofenceSettingsFresh\s*=\s*false/.test(logoutFn), 'logout must reset _geofenceSettingsFresh');
  assert.ok(/_geofenceAttendanceFresh\s*=\s*false/.test(logoutFn), 'logout must reset _geofenceAttendanceFresh');
  assert.ok(/currentGPS\s*=\s*null/.test(logoutFn), 'logout must still clear currentGPS');
});

// 2026-09-26 (review Minor-4): sw.js is network-first for GET /api/* with a cache fallback -- on a
// failed live fetch it replays the last-cached 200 verbatim, stamped X-TA-From-Cache (apiFetch()
// already reads this exact header to drive the offline banner). res.ok is true either way, so
// without this check a settings/attendance response cached from before the owner turned the
// geofence off (or before a real check-in landed) would count as "fresh" even though it is not.
test('freshness flags: a stale service-worker-cached response does not count as fresh', () => {
  const settingsFn = extractFunction(APP_SRC, 'loadSettingsFromBackend');
  assert.ok(/if \(res\.headers\.get\('X-TA-From-Cache'\) !== '1'\) _geofenceSettingsFresh = true;/.test(settingsFn),
    'a cache-replayed GET /api/settings (X-TA-From-Cache) must not be treated as a fresh load');

  const attFn = extractFunction(APP_SRC, 'loadAttendanceFromBackend');
  assert.ok(/if \(res\.headers\.get\('X-TA-From-Cache'\) !== '1'\) _geofenceAttendanceFresh = true;/.test(attFn),
    'the same guard must apply to attendance -- GET /api/events goes through the exact same sw.js cache-replay path');
});

console.log('Geofence: reviewing the stored accuracy (Task 6)');

// The brief's own test: a coarse guard that the row-building code near gpsInBtn/gpsOutBtn
// mentions the accuracy field at all, and that gpsPopupHtml() renders a '±' figure somewhere.
// Kept for the TDD record, but it is string/regex-only -- it would still pass if `gpsAccIn`
// were declared and never actually used. The executed tests below are what actually prove the
// value reaches the reviewer: 2026-09-25 review history on this same plan (progress.md, T3-T5)
// found this exact class of gap more than once.
test('the review popup shows the accuracy that was stored with the position', () => {
  const rows = APP_SRC.slice(APP_SRC.indexOf('const gpsInBtn'), APP_SRC.indexOf('const gpsInBtn') + 1200);
  assert.ok(/checkInGpsAcc|gpsAcc/.test(rows), 'the row must pass the stored accuracy to the popup');
  const fn = extractFunction(APP_SRC, 'gpsPopupHtml');
  assert.ok(/±/.test(fn), 'the popup must render the accuracy');
});

test('gpsAccuracyText (executed): renders ±Nm for a finite number, including a real 0, and nothing when absent', () => {
  const A = sandbox(APP_SRC, ['gpsAccuracyText']);
  assert.strictEqual(A.gpsAccuracyText(23), ' ±23m');
  assert.strictEqual(A.gpsAccuracyText(0), ' ±0m', 'a real 0 m fix is a legitimate value, not "absent"');
  assert.strictEqual(A.gpsAccuracyText(null), '', 'no stored accuracy (old record) must render nothing');
  assert.strictEqual(A.gpsAccuracyText(undefined), '');
  assert.strictEqual(A.gpsAccuracyText(NaN), '');
});

// 2026-09-25 (T6): extracts and RUNS the real gpsInBtn/gpsOutBtn construction from
// renderAttendanceTable() against a stubbed `row`, instead of only grepping the source -- this is
// what makes a regression that stops threading row.checkIn/checkOutGpsAcc through to the button
// (e.g. the variable declared but never interpolated, or interpolated but not carried into
// data-gps-acc/title) fail an assertion here, not just go unnoticed.
function extractGpsRowButtonsSnippet(appSrc) {
  const startAnchor = 'const safeGpsIn  = row.checkInGPS';
  const startIdx = appSrc.indexOf(startAnchor);
  assert.ok(startIdx >= 0, 'gpsInBtn/gpsOutBtn row-building block not found (safeGpsIn anchor)');
  const endAnchor = 'tr.innerHTML = `';
  const endIdx = appSrc.indexOf(endAnchor, startIdx);
  assert.ok(endIdx > startIdx, 'end anchor (tr.innerHTML) not found after safeGpsIn');
  return appSrc.slice(startIdx, endIdx);
}
function runGpsRowButtons(row, canSeeGPS) {
  const snippet = extractGpsRowButtonsSnippet(APP_SRC);
  const accFn = extractFunction(APP_SRC, 'gpsAccuracyText');
  const ctx = {
    row, canSeeGPS,
    escapeHtml: s => s,
    L: en => en,
  };
  vm.createContext(ctx);
  vm.runInContext(`${accFn}\nfunction run() {\n${snippet}\n  return { gpsInBtn, gpsOutBtn };\n}`, ctx);
  return ctx.run();
}

test('gpsInBtn/gpsOutBtn (executed): the stored accuracy reaches the button, a real 0 renders, absence renders nothing', () => {
  const withAcc = runGpsRowButtons({
    checkInSource: 'web', checkInGPS: '13.7,100.5', checkInGpsAcc: 7,
    checkOutSource: 'web', checkOutGPS: '13.8,100.6', checkOutGpsAcc: 0,
  }, true);
  assert.ok(/data-gps-acc="7"/.test(withAcc.gpsInBtn), 'the check-in button must carry the stored accuracy');
  assert.ok(/±7m/.test(withAcc.gpsInBtn), 'the check-in button must render ±7m for the reviewer');
  assert.ok(/data-gps-acc="0"/.test(withAcc.gpsOutBtn), 'a real 0 m accuracy must be carried, never treated as absent');
  assert.ok(/±0m/.test(withAcc.gpsOutBtn), 'a real 0 m accuracy must render ±0m, not vanish');

  const noAcc = runGpsRowButtons({
    checkInSource: 'web', checkInGPS: '13.7,100.5',
    checkOutSource: 'web', checkOutGPS: '13.8,100.6',
  }, true);
  assert.ok(/data-gps-acc=""/.test(noAcc.gpsInBtn), 'an old record with no accuracy must carry nothing, not a fabricated value');
  assert.ok(!/±/.test(noAcc.gpsInBtn), 'no stored accuracy must render no ± figure at all (check-in)');
  assert.ok(!/±/.test(noAcc.gpsOutBtn), 'no stored accuracy must render no ± figure at all (check-out)');
});

Promise.all(pendingAsync).then(() => {
  console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ', 0 failed'}`);
});
