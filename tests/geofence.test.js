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

// 2026-09-25 (review round 1): the two tests below replace a version that only compared
// indexOf() positions of source substrings. That version would still have passed if the `return`
// on the 403 line were dropped (403 sent AND the event still saved), or if the check-in test were
// bypassed so a check-out got asked for GPS too -- nothing actually ran. These execute the real
// extracted code instead: one drives webScanGateReason() itself with stubbed dependencies, the
// other simulates the route's own dispatch (a stub req/res, a sentinel standing in for "reached
// saveEvent") so a dropped `return` or a bypassed check-in test makes an assertion fail, not just
// a text pattern go missing.

test('webScanGateReason: a check-out is never asked for GPS', () => {
  let geofenceCalls = 0;
  const ctx = {
    webScanWouldBeCheckIn: () => false,
    getAppSettings: () => { throw new Error('getAppSettings must not run for a check-out'); },
    parseGpsCoords: () => { throw new Error('parseGpsCoords must not run for a check-out'); },
    geofenceCheckinReason: () => { geofenceCalls++; return 'geofence-inside'; },
  };
  vm.createContext(ctx);
  vm.runInContext(extractFunction(SERVER_SRC, 'webScanGateReason'), ctx);
  const result = ctx.webScanGateReason({ role: 'user' }, '2026-09-25T17:40:00', '13.7,100.5', 20);
  assert.strictEqual(result, '', 'a check-out must never be gated');
  assert.strictEqual(geofenceCalls, 0, 'geofenceCheckinReason must not run when the check-in test says no');
});

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
  vm.runInContext(extractFunction(SERVER_SRC, 'webScanGateReason'), ctx);

  const result = ctx.webScanGateReason({ role: 'manager' }, '2026-09-25T08:25:00', '13.7,100.5', 20);
  assert.strictEqual(result, 'geofence-inside');
  assert.strictEqual(calls.length, 1);
  assert.deepStrictEqual(calls[0], [G, 'manager', 13.7, 100.5, 20],
    'must pass the settings object, hikUser.role, the parsed coords and the sanitised accuracy through unchanged');

  // No gps at all: coords stay null, and NaN/NaN reach geofenceCheckinReason (its own
  // "lat == null" check does not apply to NaN, so this must be NaN, not null or undefined).
  ctx.webScanGateReason({ role: 'user' }, '2026-09-25T08:25:00', '', null);
  assert.deepStrictEqual(calls[1], [G, 'user', NaN, NaN, null]);
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
  // the same req/res/eventTime/gps/gpsAccuracy the route passes, stub webScanGateReason's return
  // value, and put a sentinel right where the route's next statement (const tz = ...) begins. If
  // the `return` on the 403 line were ever dropped, execution would fall through into the
  // sentinel even on a refusal -- this is what makes that regression a failing assertion, not a
  // silent pass.
  function runWiring(gateReason) {
    const ctx = { webScanGateReason: () => gateReason, sentinel: () => { ctx.reached = true; }, reached: false };
    vm.createContext(ctx);
    vm.runInContext(`function wiring(req, res, eventTime, gps, gpsAccuracy) {\n${gateBlock}\n  sentinel();\n}`, ctx);
    const calls = {};
    const res = {
      status(code) { calls.status = code; return this; },
      json(payload) { calls.json = payload; return this; },
    };
    const req = { hikSource: 'webscan', hikUser: { role: 'user', employeeNo: '1' } };
    ctx.wiring(req, res, '2026-09-25T08:25:00', '13.7,100.5', 20);
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
  assert.strictEqual(refused.calls.json.message, 'Company policy: check-in must be made with the face scanner at the office.');

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

console.log('Geofence: the client');

const JA_SRC = fs.readFileSync(path.join(ROOT, 'attendance/lang/ja.js'), 'utf8');
const INDEX_SRC = fs.readFileSync(path.join(ROOT, 'attendance/index.html'), 'utf8');

test('the check-in POST sends the accuracy', () => {
  const fn = extractFunction(APP_SRC, 'doScan');
  assert.ok(/gpsAccuracy:/.test(fn), 'doScan must send gpsAccuracy or the server refuses every check-in');
});

test('the client refuses before posting, using the same shared function', () => {
  const fn = extractFunction(APP_SRC, 'doScan');
  assert.ok(/geofenceCheckinReason\(/.test(fn), 'doScan must pre-check');
  const preIdx = fn.indexOf('geofenceCheckinReason');
  const postIdx = fn.indexOf('/api/hikvision/event');
  assert.ok(preIdx > 0 && preIdx < postIdx, 'the pre-check must run before the request');
});

test('the Settings page exposes all five geofence fields and saves them safely', () => {
  for (const id of ['set-geo-enabled', 'set-geo-lat', 'set-geo-lng', 'set-geo-radius', 'set-geo-acc']) {
    assert.ok(APP_SRC.includes(id), `Settings field missing: ${id}`);
  }
  const save = extractFunction(APP_SRC, 'saveSettingsPage');
  for (const key of ['enabled', 'lat', 'lng', 'radiusM', 'maxAccuracyM']) {
    assert.ok(new RegExp(`geofence\\.${key}\\s*=`).test(save), `save must write geofence.${key}`);
  }
  // Falsy-zero guard: `ff()` ends in `|| 0`, which would turn an empty latitude into 0.
  const geoLines = save.split('\n').filter(l => /geofence\.(lat|lng|radiusM|maxAccuracyM)\s*=/.test(l));
  assert.ok(geoLines.length === 4, 'all four numeric fields must be assigned');
  for (const line of geoLines) {
    assert.ok(!/\bff\(|\bfi\(/.test(line),
      `use the strict reader, not fi()/ff() -- they coerce an empty field to 0: ${line.trim()}`);
  }
  assert.ok(/geofenceNum\(/.test(save), 'a strict numeric reader must be used for the geofence fields');
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

  const maxAccIdx = save.indexOf('APP_SETTINGS.geofence.maxAccuracyM', blockStart);
  assert.ok(maxAccIdx >= 0, 'geofence.maxAccuracyM write not found in saveSettingsPage');
  const blockEnd = save.indexOf('\n', maxAccIdx);
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

test('geofence save (executed): all five fields read correctly when every element is present', () => {
  const existing = { enabled: false, lat: 1, lng: 2, radiusM: 3, maxAccuracyM: 4 };
  const elements = {
    'set-geo-enabled': { checked: true },
    'set-geo-lat': { value: '13.7268315' },
    'set-geo-lng': { value: '100.52847' },
    'set-geo-radius': { value: '200' },
    'set-geo-acc': { value: '60' },
  };
  const result = runGeofenceSave(existing, elements);
  assert.strictEqual(result.enabled, true);
  assert.strictEqual(result.lat, 13.7268315);
  assert.strictEqual(result.lng, 100.52847);
  assert.strictEqual(result.radiusM, 200);
  assert.strictEqual(result.maxAccuracyM, 60);
});

test('geofence save (executed): a missing enabled checkbox keeps the stored value, never writes false', () => {
  // Risk 1 (review round 3): `!!document.getElementById(id)?.checked` with no existence guard
  // turns an absent element into `false`, silently disabling the geofence company-wide.
  const existing = { enabled: true, lat: 1, lng: 2, radiusM: 3, maxAccuracyM: 4 };
  const elements = {
    // set-geo-enabled deliberately absent -- simulates the element missing from the DOM
    'set-geo-lat': { value: '1' },
    'set-geo-lng': { value: '2' },
    'set-geo-radius': { value: '3' },
    'set-geo-acc': { value: '4' },
  };
  const result = runGeofenceSave(existing, elements);
  assert.strictEqual(result.enabled, true, 'a missing checkbox must not silently disable the geofence');
});

test('geofence save (executed): a real 0 is kept, not replaced by the fallback', () => {
  // Mutation guard: would fail if geofenceNum were rewritten as `parseFloat(v) || fallback`
  // instead of the Number.isFinite check -- 0 is a valid latitude (the equator) but falsy.
  const existing = { enabled: true, lat: 13.7, lng: 100.5, radiusM: 150, maxAccuracyM: 50 };
  const elements = {
    'set-geo-enabled': { checked: true },
    'set-geo-lat': { value: '0' },
    'set-geo-lng': { value: '100.5' },
    'set-geo-radius': { value: '150' },
    'set-geo-acc': { value: '50' },
  };
  const result = runGeofenceSave(existing, elements);
  assert.strictEqual(result.lat, 0, 'a real 0 must be kept, not silently replaced by the fallback');
});

test('geofence save (executed): a blank, garbage or missing numeric field keeps the stored value', () => {
  const existing = { enabled: true, lat: 13.7, lng: 100.5, radiusM: 150, maxAccuracyM: 50 };
  const elements = {
    'set-geo-enabled': { checked: true },
    'set-geo-lat': { value: '' },
    'set-geo-lng': { value: 'abc' },
    // set-geo-radius / set-geo-acc elements deliberately absent entirely
  };
  const result = runGeofenceSave(existing, elements);
  assert.strictEqual(result.lat, 13.7, 'blank latitude must keep the stored value');
  assert.strictEqual(result.lng, 100.5, 'unreadable longitude must keep the stored value');
  assert.strictEqual(result.radiusM, 150, 'missing radius element must keep the stored value');
  assert.strictEqual(result.maxAccuracyM, 50, 'missing accuracy element must keep the stored value');
});

test('every new message exists in all three languages', () => {
  const EN = [
    'Company policy: check-in must be made with the face scanner at the office.',
    'Web check-in requires your location',
    'not precise enough',
  ];
  for (const en of EN) assert.ok(APP_SRC.includes(en), `English string missing: ${en}`);
  for (const th of ['กรุณาสแกนที่เครื่อง', 'กรุณาอนุญาตให้เข้าถึงตำแหน่ง', 'ยังไม่แม่นพอ']) {
    assert.ok(APP_SRC.includes(th), `Thai string missing: ${th}`);
  }
  for (const ja of ['顔認証端末', '位置情報が必要', '精度が不足']) {
    assert.ok(JA_SRC.includes(ja), `Japanese string missing: ${ja}`);
  }
});

test('the standing policy note is on the check-in screen, not only in the error', () => {
  assert.ok(/id="scan-policy-note"/.test(INDEX_SRC), 'the policy note element must exist');
  assert.ok(/data-en=/.test(INDEX_SRC.slice(INDEX_SRC.indexOf('scan-policy-note') - 300, INDEX_SRC.indexOf('scan-policy-note') + 300)),
    'the note must carry data-en so fixStaticText() can translate it');
});

test('the button state function never reads currentUser at load time', () => {
  // fixStaticText() runs before login; anything it touches must not assume a logged-in user.
  const fn = extractFunction(APP_SRC, 'geofenceUiState');
  assert.ok(/currentUser/.test(fn) === false || /currentUser\s*&&/.test(fn) || /currentUser\?\./.test(fn),
    'guard every currentUser read in geofenceUiState');
});

// 2026-09-25 (review round 2, Critical): geofenceUiState() disables the single shared #scan-btn
// purely from location/role, with no awareness of whether the next press would be a check-in or
// a check-out. Scenario: checked in via the face scanner in the morning, then in the evening --
// still on site -- opens the web app to check OUT. The server never gates a check-out, but the
// old code would disable the button anyway, so the click (and doScan()'s own correctly-scoped
// pre-check) never even fires. Fixed by making geofenceUiState() defer to the same
// webCheckinWouldBeCheckIn() test doScan() uses, so the two paths cannot drift apart. These two
// tests stub that shared test directly (rather than driving scanYmd()/attendanceLog/etc. through
// it) so a regression that stops checking it -- and calls geofenceCheckinReason() unconditionally
// again -- fails loudly instead of silently.
test('geofenceUiState never blocks a press that would not be a new check-in, even standing at the office', () => {
  const ctx = {
    webCheckinWouldBeCheckIn: () => false,
    geofenceCheckinReason: () => { throw new Error('geofenceCheckinReason must not run -- this press is not a check-in'); },
    geofenceMessage: () => { throw new Error('geofenceMessage must not run -- this press is not a check-in'); },
    currentUser: { role: 'user' },
    currentGPS: { latRaw: PASO.lat, lngRaw: PASO.lng, accuracy: 10 },
    APP_SETTINGS: { geofence: G },
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

test('geofenceUiState still blocks an actual check-in standing at the office', () => {
  const ctx = {
    webCheckinWouldBeCheckIn: () => true,
    geofenceCheckinReason: () => 'geofence-inside',
    geofenceMessage: reason => `msg:${reason}`,
    currentUser: { role: 'user' },
    currentGPS: { latRaw: PASO.lat, lngRaw: PASO.lng, accuracy: 10 },
    APP_SETTINGS: { geofence: G },
  };
  vm.createContext(ctx);
  vm.runInContext(extractFunction(APP_SRC, 'geofenceUiState'), ctx);
  const st = ctx.geofenceUiState();
  assert.strictEqual(st.blocked, true);
  assert.strictEqual(st.reason, 'geofence-inside');
});

console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ', 0 failed'}`);
