// ปิด/เปิด การตอกบัตรผ่านเว็บ (2026-10-14, owner's decision).
//
// The switch ships ON, so deploying it must change nothing. When the owner turns it off, everyone
// clocks in at the face scanner -- except roles they exempt, which defaults to `driver` because
// drivers are not at the office (that is already why geofence.exemptRoles exempts them, so a
// company-wide off switch would leave them unable to clock in at all).
//
// The rules are proven by running the REAL webScanGateReason() out of server.js and the REAL
// geofenceUiState() out of app.js, not by grepping their source: the lesson from
// tests/role-allowance-rates.test.js is that a hand-built settings object proves nothing about
// whether the real code ever sees the setting.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const APP_SRC = fs.readFileSync(path.join(ROOT, 'attendance/js/app.js'), 'utf8');
const SERVER_SRC = fs.readFileSync(path.join(ROOT, 'attendance-server/backend/server.js'), 'utf8');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok  ${name}`); }
  catch (e) { process.exitCode = 1; console.log(`  FAIL  ${name}\n        ${e.message}`); }
}
function extractFunction(src, name) {
  const re = new RegExp(`^(async )?function ${name}\\(`, 'm');
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
function constBlock(src, name) {
  const m = new RegExp(`^const ${name} = `, 'm').exec(src);
  if (!m) throw new Error(`const ${name} not found`);
  const open = src.indexOf('{', m.index);
  let depth = 0;
  for (let j = open; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (depth === 0) return src.slice(m.index, j + 1) + ';'; }
  }
  throw new Error(`unbalanced ${name}`);
}

const GPS = '13.7268,100.5285';           // the office coordinates in DEFAULT_APP_SETTINGS
const FAR = '13.9000,100.9000';           // comfortably outside any sane radius
const NOW = '2026-10-14T01:00:00.000Z';

// Runs the real server gate. `webClock`/`geofence` go in as settings; `wouldBeCheckIn` and
// `hasWebCheckInToday` stand in for the two log-derived facts the gate asks about.
function serverReason({ webClock, geofenceOn = false, role = 'user', gps = GPS, gpsAgeSec = 5, wouldBeCheckIn = true, hasWebCheckInToday = false }) {
  const settings = {
    geofence: { enabled: geofenceOn, lat: 13.7268315, lng: 100.52847, radiusM: 150, exemptRoles: ['driver'] },
  };
  if (webClock !== undefined) settings.webClock = webClock;
  const ctx = {
    getAppSettings: () => settings,
    sanitizeGpsAge: (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null),
    parseGpsCoords: (s) => { const m = /^(-?[\d.]+),(-?[\d.]+)$/.exec(String(s || '')); return m ? { lat: Number(m[1]), lng: Number(m[2]) } : null; },
    webScanWouldBeCheckIn: () => wouldBeCheckIn,
    webScanHasWebCheckInToday: () => hasWebCheckInToday,
    geofenceCheckinReason: () => 'geofence-inside',
    Number, Object, Array, String, Math, JSON,
  };
  vm.createContext(ctx);
  vm.runInContext(`${extractFunction(SERVER_SRC, 'webScanGateReason')}\nthis.out = webScanGateReason({ role: ${JSON.stringify(role)}, employeeNo: '1' }, ${JSON.stringify(NOW)}, ${JSON.stringify(gps)}, ${gpsAgeSec});`, ctx);
  return ctx.out;
}

console.log('web clock switch: off means the scanner, except for the roles the owner exempts');

// --- 1. shipped state changes nothing -------------------------------------------------
test('with no webClock section at all, the gate answers exactly as before', () => {
  assert.strictEqual(serverReason({ webClock: undefined }), '', 'an older settings file must behave as it always did');
});
test('the shipped default is ON, so deploying changes nobody', () => {
  const m = /webClock:\s*\{\s*enabled:\s*(true|false)/.exec(SERVER_SRC);
  assert.ok(m, 'server.js must default a webClock section');
  assert.strictEqual(m[1], 'true', 'it must ship switched ON');
  const d = /webClock:\s*\{[^}]*exemptRoles:\s*\[([^\]]*)\]/.exec(SERVER_SRC);
  assert.ok(d && /'driver'/.test(d[1]), 'driver must be exempt by default -- drivers are not at the office');
  assert.strictEqual(serverReason({ webClock: { enabled: true, exemptRoles: ['driver'] } }), '');
});

// --- 2/3. the switch itself -----------------------------------------------------------
test('switched off: a web check-in is refused for a role that is not exempt', () => {
  assert.strictEqual(serverReason({ webClock: { enabled: false, exemptRoles: ['driver'] }, role: 'user' }), 'web-clock-off');
  assert.strictEqual(serverReason({ webClock: { enabled: false, exemptRoles: ['driver'] }, role: 'manager' }), 'web-clock-off');
});
test('switched off: an exempt role still clocks in from the web', () => {
  assert.strictEqual(serverReason({ webClock: { enabled: false, exemptRoles: ['driver'] }, role: 'driver' }), '');
});
test('switched off: a check-OUT is refused too -- hiding the button is not the rule', () => {
  assert.strictEqual(serverReason({ webClock: { enabled: false, exemptRoles: [] }, role: 'user', wouldBeCheckIn: false }), 'web-clock-off');
});

// --- 4. the day already started on the web --------------------------------------------
test('switched off mid-day: a day whose check-in came from the web can still be closed from the web', () => {
  // The owner's answer was that existing web check-ins stay usable. Without this, flipping the
  // switch at lunchtime strands everyone who clocked in from the web that morning: they cannot
  // record a check-out at all, and every claim for the day needs one.
  assert.strictEqual(serverReason({
    webClock: { enabled: false, exemptRoles: [] }, role: 'user',
    wouldBeCheckIn: false, hasWebCheckInToday: true,
  }), '');
});
test('that exception does not let a NEW web check-in through', () => {
  assert.strictEqual(serverReason({
    webClock: { enabled: false, exemptRoles: [] }, role: 'user',
    wouldBeCheckIn: true, hasWebCheckInToday: true,
  }), 'web-clock-off');
});

// --- 4b. the carve-out itself, run for real against a real-shaped log -------------------
// 2026-10-14 (review): the two *HasWebCheckInToday helpers were stubbed out everywhere above, and
// a review found they disagreed about which day they were asking about. buildAttendanceLogForUser
// keys by BUSINESS date -- a scan before BUSINESS_DAY_START_MINS belongs to the previous day -- so
// looking the day up by calendar date misses exactly the case this carve-out exists for: a web
// check-OUT after midnight, on a day that was checked in from the web the morning before.
function serverHasWebCheckInToday(eventTimeIso, logByBusinessDate) {
  const ctx = {
    BUSINESS_DAY_START_MINS: Number(/const BUSINESS_DAY_START_MINS = (\d+);/.exec(SERVER_SRC)[1]),
    parseHHMMToMins: (t) => { const m = /^(\d{2}):(\d{2})$/.exec(String(t || '')); return m ? Number(m[1]) * 60 + Number(m[2]) : NaN; },
    ta_localDateStr: (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`,
    buildAttendanceLogForUser: () => logByBusinessDate,
    Number, Object, Array, String, Date,
  };
  vm.createContext(ctx);
  vm.runInContext(`${extractFunction(SERVER_SRC, 'webScanHasWebCheckInToday')}\nthis.out = webScanHasWebCheckInToday({ id: 9 }, ${JSON.stringify(eventTimeIso)});`, ctx);
  return ctx.out;
}

test('the carve-out finds a web check-in made the same business day', () => {
  const log = { '2026-10-14': { checkIn: '08:10', checkInSource: 'web' } };
  assert.strictEqual(serverHasWebCheckInToday('2026-10-14T18:00:00.000Z', log), true);
});
test('the carve-out finds it for a check-out AFTER MIDNIGHT, which is the case it exists for', () => {
  // 00:30 on the 15th is still business day the 14th. Asking by calendar date finds nothing and
  // strands the check-out -- and a day with no check-out loses every claim that needs one.
  const log = { '2026-10-14': { checkIn: '08:10', checkInSource: 'web' } };
  assert.strictEqual(serverHasWebCheckInToday('2026-10-15T00:30:00.000Z', log), true);
});
test('the carve-out does not fire for a device check-in, or for a day with none', () => {
  assert.strictEqual(serverHasWebCheckInToday('2026-10-14T18:00:00.000Z', { '2026-10-14': { checkIn: '08:10', checkInSource: 'device' } }), false);
  assert.strictEqual(serverHasWebCheckInToday('2026-10-14T18:00:00.000Z', {}), false);
  assert.strictEqual(serverHasWebCheckInToday('', { '2026-10-14': { checkIn: '08:10', checkInSource: 'web' } }), false);
});

// --- 5. ordering ----------------------------------------------------------------------
test('a scan with no position is refused whatever the switch says', () => {
  for (const webClock of [undefined, { enabled: true, exemptRoles: [] }, { enabled: false, exemptRoles: [] }]) {
    assert.strictEqual(serverReason({ webClock, gps: '' }), 'geofence-no-position');
    assert.strictEqual(serverReason({ webClock, gps: GPS, gpsAgeSec: 9999 }), 'geofence-no-position');
  }
});
test('the geofence still refuses an on-site web check-in when the switch is on', () => {
  assert.strictEqual(serverReason({ webClock: { enabled: true, exemptRoles: [] }, geofenceOn: true, gps: GPS }), 'geofence-inside');
});
test('a malformed webClock section is ignored rather than locking everyone out', () => {
  for (const bad of [null, 'x', [], { enabled: 'false' }, { enabled: false, exemptRoles: 'driver' }]) {
    const out = serverReason({ webClock: bad, role: 'driver' });
    assert.ok(out === '' || out === 'web-clock-off', `unexpected ${out}`);
  }
  // `enabled: 'false'` is not `false`: a string must not read as "switched off".
  assert.strictEqual(serverReason({ webClock: { enabled: 'false', exemptRoles: [] } }), '');
  // exemptRoles of the wrong shape must not throw, and must not exempt everybody.
  assert.strictEqual(serverReason({ webClock: { enabled: false, exemptRoles: 'driver' }, role: 'driver' }), 'web-clock-off');
});

// --- 6. the setting survives both plumbing paths ---------------------------------------
test('webClock survives getAppSettings() and the browser load, like allowanceRoleRates', () => {
  const ctx = {
    DEFAULT_ANNUAL_LEAVE_TIERS: [{ afterMonths: 0, days: 6 }],
    DEFAULT_SICK_LEAVE_DAYS: 30, DEFAULT_BUSINESS_LEAVE_DAYS: 3,
    normalizeAnnualLeaveTiers: (t) => t, normalizeQuotaDays: (v, d) => (v == null ? d : v),
    readSettings: () => ({ appSettings: { webClock: { enabled: false, exemptRoles: ['driver'] } } }),
    Object, Array, Infinity, Number,
  };
  vm.createContext(ctx);
  vm.runInContext(constBlock(SERVER_SRC, 'DEFAULT_APP_SETTINGS') + '\n' + extractFunction(SERVER_SRC, 'getAppSettings') + '\nthis.S = getAppSettings();', ctx);
  assert.ok(ctx.S.webClock, 'getAppSettings() dropped webClock -- the gate would never see it');
  assert.strictEqual(ctx.S.webClock.enabled, false);

  const open = APP_SRC.indexOf('if (data.appSettings) {');
  let d = 0, end = open;
  for (let j = APP_SRC.indexOf('{', open); j < APP_SRC.length; j++) {
    if (APP_SRC[j] === '{') d++;
    else if (APP_SRC[j] === '}') { d--; if (!d) { end = j + 1; break; } }
  }
  const c = {
    data: { appSettings: { webClock: { enabled: false, exemptRoles: ['driver'] } } },
    APP_SETTINGS: { company: {}, payroll: {}, sso: {}, allowances: {}, workSchedule: {}, geofence: {}, leave: {}, map: {}, allowanceEligibility: {}, tax: { brackets: [] }, allowanceRoleRates: { enabled: false, byRole: {} }, webClock: { enabled: true, exemptRoles: [] } },
    // The load block records which optional sections the server actually holds.
    _settingsSectionsOnServer: { allowanceRoleRates: false, webClock: false },
    normalizeAnnualLeaveTiers: (t) => t || [], sickLeaveEntitlementDays: () => 30, businessLeaveEntitlementDays: () => 3,
    Object, Array, Infinity, Number,
  };
  vm.createContext(c);
  vm.runInContext(APP_SRC.slice(open, end), c);
  assert.strictEqual(c.APP_SETTINGS.webClock.enabled, false,
    'the browser never reads webClock back, so the page would show the switch in the wrong position');
});

test('webClock is on both server allowlists, or a save erases it', () => {
  const allow = /const ALLOWED_APPSETTINGS_KEYS = (\[[^\]]*\]);/.exec(SERVER_SRC);
  assert.ok(allow && /'webClock'/.test(allow[1]), 'missing from ALLOWED_APPSETTINGS_KEYS');
  const objList = /for \(const sub of (\[[^\]]*'allowanceEligibility'[^\]]*\])\)/.exec(SERVER_SRC);
  assert.ok(objList && /'webClock'/.test(objList[1]), 'missing from the must-be-an-object list');
});

// --- 6b. the deploy window: what the page sends to a server that may still be the old one ---
// 2026-10-14 (review): merging publishes app.js immediately while the backend keeps running the
// old server.js until it is restarted over SSH. An old server rejects an unknown appSettings key
// with a 400 for the WHOLE request, so sending `webClock` unconditionally breaks every Settings
// save for the length of that window -- the morningReviewEnabled incident a third time.
// The rule is NOT "omit while it looks inert": that would make turning a feature back off
// impossible to persist, because the server keeps whatever it already has for a key you stop
// sending. It is "omit only a section the server has never stored, while it still matches what
// the server would default to anyway".
function runSendFilter(appSettings, stored) {
  const ctx = { Object, Array };
  vm.createContext(ctx);
  vm.runInContext(`${extractFunction(APP_SRC, 'omitUnstoredDefaults')}\nthis.out = omitUnstoredDefaults(${JSON.stringify(appSettings)}, ${JSON.stringify(stored)});`, ctx);
  return ctx.out;
}
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

test('a webClock the server has never stored, still at its default, is not sent', () => {
  const out = runSendFilter({ allowances: {}, webClock: { enabled: true, exemptRoles: ['driver'] } }, { webClock: false, allowanceRoleRates: false });
  assert.ok(!has(out, 'webClock'), 'an old backend must never meet a key it does not know');
  assert.ok(has(out, 'allowances'), 'nothing else may be dropped');
});
test('turning the switch OFF is sent even though the server has never stored it', () => {
  const out = runSendFilter({ webClock: { enabled: false, exemptRoles: ['driver'] } }, { webClock: false, allowanceRoleRates: false });
  assert.ok(has(out, 'webClock'), 'this is the owner actually using the feature');
});
test('once the server has stored it, it is ALWAYS sent -- including switching back on', () => {
  // This is the case "omit while inert" got wrong: stop sending a key and the server keeps what it
  // had, so the owner could never switch the feature back on again.
  const out = runSendFilter({ webClock: { enabled: true, exemptRoles: [] } }, { webClock: true, allowanceRoleRates: false });
  assert.ok(has(out, 'webClock'), 'switching back on must reach the server');
});
test('the same rule covers the per-role rate table', () => {
  const inert = { enabled: false, byRole: {} };
  assert.ok(!has(runSendFilter({ allowanceRoleRates: inert }, { webClock: false, allowanceRoleRates: false }), 'allowanceRoleRates'));
  assert.ok(has(runSendFilter({ allowanceRoleRates: inert }, { webClock: false, allowanceRoleRates: true }), 'allowanceRoleRates'),
    'a stored table must keep being sent, or clearing it could never be saved');
  assert.ok(has(runSendFilter({ allowanceRoleRates: { enabled: true, byRole: {} } }, { webClock: false, allowanceRoleRates: false }), 'allowanceRoleRates'));
});
test('the save path routes through the filter', () => {
  const fn = extractFunction(APP_SRC, 'savePayrollSettings');
  assert.ok(/omitUnstoredDefaults\(/.test(fn), 'savePayrollSettings must send the filtered object');
});

// --- 6c. the button disappears, which is what the owner actually asked for --------------
// 2026-10-14 (owner): "ซ่อนปุ่มตอกบัตรไปเลยตอนปิดสวิตช์". The first cut only refused the press,
// which was safe but not what was asked -- and it meant a confirm() dialog ("this will be recorded
// as your check-OUT") could appear before the refusal. The hide reuses geofenceUiState(), so there
// is exactly ONE place that decides whether web clocking is allowed.
test('the clock-in button is hidden when the switch refuses this person', () => {
  const fn = extractFunction(APP_SRC, 'updateScanButton');
  assert.ok(/web-clock-off/.test(fn), 'updateScanButton must know about the switch');
  assert.ok(/scan-btn-wrap|webclock-hidden/.test(fn), 'it must hide the button, not merely restyle it');
  // and it must decide from the shared gate rather than re-reading the setting itself
  assert.ok(/geofenceUiState\(/.test(fn),
    'the hide must come from geofenceUiState(), or the rule exists in two places and they will drift');
  assert.ok(!/APP_SETTINGS\.webClock/.test(fn), 'updateScanButton must not re-implement the rule');
});

test('the person is told why the button is gone, in all three languages', () => {
  const html = fs.readFileSync(path.join(ROOT, 'attendance/index.html'), 'utf8');
  assert.ok(/id="webclock-off-note"/.test(html), 'there must be somewhere to say why');
  const fn = extractFunction(APP_SRC, 'updateScanButton');
  assert.ok(/geofenceMessage\('web-clock-off'\)/.test(fn),
    'reuse the wording that already exists in three languages rather than writing a second one');
});

// --- 7. the two sides agree ------------------------------------------------------------
test('the browser blocks the press for the same reason the server would refuse it', () => {
  const uiReason = (webClock, role) => {
    const ctx = {
      currentGPS: { lat: 13.7268, lng: 100.5285, at: Date.now() },
      APP_SETTINGS: { geofence: { enabled: false, exemptRoles: ['driver'] }, ...(webClock ? { webClock } : {}) },
      currentUser: { id: 1, role },
      // The production gate refuses locally only on settings this session actually loaded.
      _geofenceSettingsFresh: true, _geofenceAttendanceFresh: true,
      gpsIsFresh: () => true,
      geofenceMessage: (r) => `msg:${r}`,
      webCheckinWouldBeCheckIn: () => true,
      webCheckinHasWebCheckInToday: () => false,
      effectiveRole: () => role,
      geofenceCheckinReason: () => '',
      Number, Object, Array, String, Math, Date,
    };
    vm.createContext(ctx);
    vm.runInContext(`${extractFunction(APP_SRC, 'geofenceUiState')}\nthis.out = geofenceUiState();`, ctx);
    return ctx.out;
  };
  const off = uiReason({ enabled: false, exemptRoles: ['driver'] }, 'user');
  assert.strictEqual(off.blocked, true, 'the browser must block the press');
  assert.strictEqual(off.reason, 'web-clock-off', 'and name the same reason the server uses');
  assert.strictEqual(uiReason({ enabled: false, exemptRoles: ['driver'] }, 'driver').blocked, false, 'an exempt role is not blocked');
  assert.strictEqual(uiReason({ enabled: true, exemptRoles: [] }, 'user').blocked, false, 'switched on, nothing changes');
});

test('the refusal is explained in all three languages', () => {
  const fn = extractFunction(APP_SRC, 'geofenceMessage');
  assert.ok(/web-clock-off/.test(fn), 'geofenceMessage must explain the new reason');
  const JA = fs.readFileSync(path.join(ROOT, 'attendance/lang/ja.js'), 'utf8');
  const en = /'(Company policy: clocking in[^']*)'/.exec(fn);
  assert.ok(en, 'the English wording for web-clock-off was not found');
  assert.ok(JA.includes(en[1].slice(0, 40)), 'attendance/lang/ja.js has no entry for the new refusal');
  assert.ok(/[฀-๿]/.test(fn), 'the Thai wording is missing');
});

test('the Settings card for the switch is in all three languages too', () => {
  // This card sits above the geofence card's anchor, so tests/geofence.test.js's exact-count guard
  // does not see it. These are its strings; each needs a ja.js key or JA mode leaks English.
  const JA = fs.readFileSync(path.join(ROOT, 'attendance/lang/ja.js'), 'utf8');
  const entries = {};
  for (const m of JA.matchAll(/^\s*"((?:[^"\\]|\\.)*)":\s*"((?:[^"\\]|\\.)*)"/gm)) {
    entries[JSON.parse(`"${m[1]}"`)] = JSON.parse(`"${m[2]}"`);
  }
  const needed = [
    'Turn off clocking in and out from the web',
    'When off, attendance is recorded at the face scanner only. Roles ticked below keep the web buttons.',
    'Roles that keep the web buttons',
  ];
  for (const en of needed) {
    assert.ok(APP_SRC.includes(en), `the Settings card no longer uses "${en}" -- re-point this test`);
    assert.ok(Object.prototype.hasOwnProperty.call(entries, en), `attendance/lang/ja.js has no entry for "${en}"`);
    assert.ok(/[぀-ヿ一-龯]/.test(entries[en]), `the Japanese entry for "${en}" contains no Japanese`);
  }
  // and the card carries Thai alongside the English
  const card = APP_SRC.slice(APP_SRC.indexOf("L('Clocking in and out from the web'"), APP_SRC.indexOf("L('Area where web check-in is blocked"));
  assert.ok(/[฀-๿]/.test(card), 'the Settings card has no Thai');
});

console.log(`\n${passed} assertions passed`);
