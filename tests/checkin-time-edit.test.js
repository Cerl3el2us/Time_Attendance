// แก้เวลาเข้างานโดย accounting/md (2026-10-14, owner's decision).
//
// The owner's rules, in their words:
//   * กดแก้ได้กับ case ที่มีการผ่านประตูตั้งแต่ 05.30-07.30
//   * แก้เป็นเวลาอะไรก็ได้ แต่ต้องมีเหตุผลและประวัติการแก้
//   * ส่วนใหญ่จะแก้เป็นหลังเวลาที่ผ่าน เช่น ผ่าน 07:00 แก้เป็น 08:30
//   * ของ accounting เอง มีแต่ MD ที่แก้ได้
// Setting the time later is the normal case and it REMOVES the early-morning allowance, so this
// is a money-bearing correction: the overlay that applies it is dual-synced between app.js and
// server.js like every other money rule in this codebase.
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
  const m = new RegExp(`^(async )?function ${name}\\(`, 'm').exec(src);
  if (!m) throw new Error(`function ${name} not found`);
  const i = src.indexOf('{', m.index);
  let d = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') d++;
    else if (src[j] === '}') { d--; if (!d) return src.slice(m.index, j + 1); }
  }
  throw new Error(`unbalanced ${name}`);
}
function load(src, names, extra) {
  const ctx = Object.assign({ Number, Object, Array, String, Math, JSON }, extra || {});
  vm.createContext(ctx);
  vm.runInContext(names.map(n => extractFunction(src, n)).join('\n') + '\n' + names.map(n => `this.${n} = ${n};`).join('\n'), ctx);
  return ctx;
}

const DEPS = {
  parseHHMMToMins: (t) => { const m = /^(\d{2}):(\d{2})$/.exec(String(t || '')); return m ? Number(m[1]) * 60 + Number(m[2]) : NaN; },
  HHMM_RE: /^([01]\d|2[0-3]):[0-5]\d$/,
};

const SRV = () => load(SERVER_SRC, ['checkinEditWindowOk', 'checkinEditRefusalReason', 'applyCheckinEdits'], DEPS);
const CLI = () => load(APP_SRC, ['checkinEditWindowOk', 'applyCheckinEdits'], DEPS);

console.log('check-in time edit: who may, when, and what the day then shows');

// --- the 05:30-07:30 door-pass window -------------------------------------------------
test('only a day whose door pass falls in 05:30-07:30 can be edited', () => {
  const s = SRV();
  for (const [t, ok] of [['05:29', false], ['05:30', true], ['07:00', true], ['07:30', true], ['07:31', false], ['08:30', false], ['', false], [null, false]]) {
    assert.strictEqual(s.checkinEditWindowOk(t), ok, `${JSON.stringify(t)} should be ${ok}`);
  }
});
test('both engines agree on that window, to the minute', () => {
  const s = SRV(), c = CLI();
  assert.strictEqual(extractFunction(SERVER_SRC, 'checkinEditWindowOk'), extractFunction(APP_SRC, 'checkinEditWindowOk'),
    'the window function must be identical text in both files');
  for (const t of ['05:29', '05:30', '06:00', '07:30', '07:31', '12:00']) {
    assert.strictEqual(s.checkinEditWindowOk(t), c.checkinEditWindowOk(t), `disagreement at ${t}`);
  }
});

// --- who may edit ---------------------------------------------------------------------
const base = { editor: { id: 2, role: 'md' }, target: { id: 9, role: 'user' }, rawCheckIn: '07:00', newTime: '08:30', reason: 'มาถึงจริง 08:30', periodLocked: false };
const refuse = (over) => SRV().checkinEditRefusalReason(Object.assign({}, base, over));

test('md and accounting may edit, nobody else', () => {
  assert.strictEqual(refuse({}), '');
  assert.strictEqual(refuse({ editor: { id: 4, role: 'accounting' } }), '');
  for (const role of ['manager', 'user', 'driver', 'marketing']) {
    assert.strictEqual(refuse({ editor: { id: 5, role } }), 'role', `${role} must be refused`);
  }
});
test('nobody edits their own record -- and accounting\'s own is therefore MD-only', () => {
  // The owner's rule "ของ accounting เอง มีแต่ MD ที่แก้ได้" falls straight out of this: accounting
  // may edit others but not itself, so only MD is left to correct an accounting record.
  assert.strictEqual(refuse({ editor: { id: 9, role: 'accounting' }, target: { id: 9, role: 'accounting' } }), 'own-record');
  assert.strictEqual(refuse({ editor: { id: 2, role: 'md' }, target: { id: 9, role: 'accounting' } }), '',
    'MD must be able to correct an accounting record');
});
test('a locked period refuses every edit', () => {
  assert.strictEqual(refuse({ periodLocked: true }), 'period-locked');
});
test('a day with no qualifying door pass cannot be edited at all', () => {
  assert.strictEqual(refuse({ rawCheckIn: '08:45' }), 'not-editable');
  assert.strictEqual(refuse({ rawCheckIn: null }), 'not-editable');
});

// --- the reason and the new time ------------------------------------------------------
test('a reason is required, and is not allowed to be whitespace', () => {
  assert.strictEqual(refuse({ reason: '' }), 'reason-required');
  assert.strictEqual(refuse({ reason: '   ' }), 'reason-required');
  assert.strictEqual(refuse({ reason: undefined }), 'reason-required');
});
test('a reason longer than the cap is refused rather than silently truncated', () => {
  assert.strictEqual(refuse({ reason: 'x'.repeat(501) }), 'reason-too-long');
  assert.strictEqual(refuse({ reason: 'x'.repeat(500) }), '');
});
test('the new time must be a real time of day', () => {
  for (const t of ['', '25:00', '8:30', 'abc', null, '07:60']) {
    assert.strictEqual(refuse({ newTime: t }), 'bad-time', `${JSON.stringify(t)} must be refused`);
  }
  // Any valid time is allowed, including earlier than the scan -- the owner asked for that
  // freedom, which is why the reason and the history are mandatory.
  assert.strictEqual(refuse({ newTime: '04:00' }), '');
  assert.strictEqual(refuse({ newTime: '23:59' }), '');
});

// --- what the day then shows ----------------------------------------------------------
const EDITS = { '9_2026-10-14': { checkIn: '08:30', rawCheckIn: '07:00', reason: 'r', by: 'MD', byId: 2, at: 'x' } };

test('the overlay replaces the check-in and keeps the original visible', () => {
  const log = { '2026-10-14': { checkIn: '07:00', checkInSource: 'device', checkOut: '18:00' } };
  const out = SRV().applyCheckinEdits(log, 9, EDITS);
  assert.strictEqual(out['2026-10-14'].checkIn, '08:30', 'the corrected time is what everything downstream sees');
  assert.strictEqual(out['2026-10-14'].rawCheckIn, '07:00', 'the scan time stays recorded');
  assert.strictEqual(out['2026-10-14'].checkInEdited, true, 'the day must be flagged as corrected');
  assert.strictEqual(out['2026-10-14'].checkOut, '18:00', 'nothing else is touched');
  assert.strictEqual(out['2026-10-14'].checkInSource, 'device', 'the source is not rewritten');
});
test('both engines apply the overlay identically', () => {
  assert.strictEqual(extractFunction(SERVER_SRC, 'applyCheckinEdits'), extractFunction(APP_SRC, 'applyCheckinEdits'),
    'applyCheckinEdits decides what payroll is paid from -- it must be identical text in both files');
  const log = () => ({ '2026-10-14': { checkIn: '07:00', checkInSource: 'device' } });
  assert.deepStrictEqual(
    JSON.parse(JSON.stringify(SRV().applyCheckinEdits(log(), 9, EDITS))),
    JSON.parse(JSON.stringify(CLI().applyCheckinEdits(log(), 9, EDITS))));
});
test('an edit for another employee, another day, or a malformed one, changes nothing', () => {
  const log = () => ({ '2026-10-14': { checkIn: '07:00' } });
  for (const [uid, edits] of [[8, EDITS], [9, { '9_2026-10-13': EDITS['9_2026-10-14'] }], [9, null], [9, 'x'], [9, { '9_2026-10-14': { checkIn: '99:99' } }], [9, { '9_2026-10-14': null }]]) {
    const out = SRV().applyCheckinEdits(log(), uid, edits);
    assert.strictEqual(out['2026-10-14'].checkIn, '07:00', `changed by ${JSON.stringify(edits)} for user ${uid}`);
  }
});
test('the overlay runs inside both attendance builders, not only in a test', () => {
  assert.ok(/applyCheckinEdits\(/.test(extractFunction(SERVER_SRC, 'buildAttendanceLogForUser')),
    'server buildAttendanceLogForUser must apply the overlay, or payroll pays the uncorrected time');
  assert.ok(/applyCheckinEdits\(/.test(extractFunction(APP_SRC, 'loadAttendanceFromBackend')),
    'the browser must apply the overlay where it builds attendanceLog');
});

// --- storage and route wiring ---------------------------------------------------------
test('the edit store is its own file, with a handler lock like checkout-reviews', () => {
  assert.ok(/CHECKIN_EDITS_FILE = 'checkin-time-edits\.json'/.test(SERVER_SRC), 'storage file not declared');
  assert.ok(/makeHandlerLock\('CHECKIN_EDITS'\)/.test(SERVER_SRC), 'concurrent edits must be serialised like checkout-reviews');
  assert.ok(/app\.get\('\/api\/checkin-time-edits'/.test(SERVER_SRC), 'no GET route');
  assert.ok(/app\.put\('\/api\/checkin-time-edits', requireRole\('md', 'accounting'\)/.test(SERVER_SRC), 'the PUT must be role-gated at the route too');
});
test('every edit appends to a history that records who, from, to and why', () => {
  const put = SERVER_SRC.slice(SERVER_SRC.indexOf('function handlePutCheckinTimeEdit'), SERVER_SRC.indexOf('function handlePutCheckinTimeEdit') + 4000);
  for (const field of ['history', 'from', 'to', 'reason', 'byId', 'at']) {
    assert.ok(new RegExp(`\\b${field}\\b`).test(put), `the stored edit must record ${field}`);
  }
  assert.ok(/\.push\(|\.concat\(/.test(put), 'history must be appended to, never replaced');
});

console.log(`\n${passed} assertions passed`);
