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
// generatePeriodDays has a default parameter, so the shared extractFunction() -- which finds the
// first { after the name -- stops inside the parameter list. Slice it by anchors instead.
function periodDaysBody(src) {
  const i = src.indexOf('function generatePeriodDays(');
  if (i < 0) throw new Error('generatePeriodDays not found');
  const j = src.indexOf('days.push({', i);
  if (j < 0) throw new Error('generatePeriodDays day push not found');
  return src.slice(i, j + 600);
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

// --- the point of the whole feature: the money moves ----------------------------------
// 2026-10-14 (review): nothing proved a corrected check-in changes what is paid. The owner's own
// example is 07:00 corrected to 08:30 precisely so the early-morning allowance stops being paid,
// and that was the one thing untested. Runs the REAL tier decision on BOTH engines, with invented
// thresholds and amounts so the owner editing a rate can never turn this red.
function earlyMorningPayFor(src, day) {
  const S = {
    allowances: { earlyThreshold1Min: 450, earlyThreshold2Min: 390, earlyMorning1: 11, earlyMorning2: 22 },
  };
  const ctx = Object.assign({
    HHMM_RE: /^([01]\d|2[0-3]):[0-5]\d$/,
    isDeviceScanSource: (s) => s === 'device',
    isRestAttendanceDay: () => false,
    isEarlyMorningDayStatus: () => true,
    hasHolidayWorkClaimOnDate: () => false,
  }, DEPS);
  vm.createContext(ctx);
  vm.runInContext(
    ['earlyMorningCheckInOk', 'deviceScanQualifiesForEarlyMorning', 'applyCheckinEdits']
      .map(n => extractFunction(src, n)).join('\n') +
    '\nthis.qualifies = deviceScanQualifiesForEarlyMorning; this.apply = applyCheckinEdits;', ctx);
  if (!ctx.qualifies(day, new Set())) return 0;
  const mins = DEPS.parseHHMMToMins(day.checkIn);
  if (mins <= S.allowances.earlyThreshold2Min) return S.allowances.earlyMorning2;
  if (mins <= S.allowances.earlyThreshold1Min) return S.allowances.earlyMorning1;
  return 0;
}

test('correcting a 07:00 door pass to 08:30 stops the early-morning allowance, on both engines', () => {
  for (const [label, src] of [['server', SERVER_SRC], ['app', APP_SRC]]) {
    const log = { '2026-10-14': { date: '2026-10-14', checkIn: '07:00', checkInSource: 'device' } };
    assert.strictEqual(earlyMorningPayFor(src, log['2026-10-14']), 11, `${label}: 07:00 should earn the x1 rate before any correction`);
    const edits = { '9_2026-10-14': { checkIn: '08:30', rawCheckIn: '07:00' } };
    const out = SRV().applyCheckinEdits(log, 9, edits);
    assert.strictEqual(earlyMorningPayFor(src, out['2026-10-14']), 0,
      `${label}: after correcting to 08:30 the day must earn nothing -- this is the whole point of the feature`);
  }
});

test('a correction to an EARLIER time moves the day up a tier -- the owner allowed it, so it is pinned', () => {
  // The owner said any time may be entered. That cuts both ways: 07:00 -> 06:00 crosses the x2
  // threshold and PAYS MORE. Pinned deliberately so the behaviour cannot change unnoticed, and
  // flagged to the owner rather than quietly prevented.
  const log = { '2026-10-14': { date: '2026-10-14', checkIn: '07:00', checkInSource: 'device' } };
  const out = SRV().applyCheckinEdits(log, 9, { '9_2026-10-14': { checkIn: '06:00', rawCheckIn: '07:00' } });
  assert.strictEqual(earlyMorningPayFor(SERVER_SRC, out['2026-10-14']), 22, 'an earlier correction reaches the x2 rate');
  assert.strictEqual(earlyMorningPayFor(APP_SRC, out['2026-10-14']), 22, 'and both engines agree about it');
});

test('a correction never turns a web check-in into a device one, so it cannot unlock the allowance', () => {
  const log = { '2026-10-14': { date: '2026-10-14', checkIn: '07:00', checkInSource: 'web' } };
  assert.strictEqual(earlyMorningPayFor(SERVER_SRC, log['2026-10-14']), 0, 'a web check-in earns nothing to begin with');
  const out = SRV().applyCheckinEdits(log, 9, { '9_2026-10-14': { checkIn: '06:00', rawCheckIn: '07:00' } });
  assert.strictEqual(out['2026-10-14'].checkInSource, 'web', 'the source must survive the correction');
  assert.strictEqual(earlyMorningPayFor(SERVER_SRC, out['2026-10-14']), 0, 'and it still earns nothing');
});

// --- findings from the 2026-10-14 review ----------------------------------------------
test('a successful save is not reported as a failure', () => {
  // writeJSON() has no return statement, so `if (!writeJSON(...))` was true on EVERY call: the
  // correction was written to disk and the admin was told "Service temporarily unavailable".
  // Retrying then appended history entries reading 08:30 -> 08:30. Every sibling handler relies on
  // atomicWrite throwing into the surrounding catch instead.
  // The production comments deliberately describe the old shape without quoting it, so this
  // pattern can only match real code.
  assert.ok(!/if \(!writeJSON\(/.test(SERVER_SRC),
    'no handler may branch on writeJSON()\'s return value -- it does not return one');
  const put = extractFunction(SERVER_SRC, 'handlePutCheckinTimeEdit');
  assert.ok(/writeJSON\(CHECKIN_EDITS_FILE, all\);/.test(put), 'the write must still happen');
  assert.ok(/catch \(e\)/.test(put), 'and a write failure must surface through the catch');
});

test('a corrupt corrections file fails CLOSED, it does not quietly restore removed allowances', () => {
  // `readCheckinEdits() || {}` read "unreadable" as "no corrections exist", so a truncated file
  // would pay back every early-morning allowance a correction had removed, company-wide, with
  // nothing failing. Every sibling guard in this file fails closed.
  const fn = extractFunction(SERVER_SRC, 'buildAttendanceLogForUser');
  assert.ok(!/readCheckinEdits\(\) \|\| \{\}/.test(fn), 'a null read must not be treated as "no corrections"');
  assert.ok(/readCheckinEdits\(\)/.test(fn) && /throw new Error/.test(fn),
    'an unreadable corrections file must refuse, the way an unreadable events file already does');
});

test('an accounting record is MD-only, as the owner asked, not merely "not your own"', () => {
  // With one accounting employee these coincide; with two they do not, and accounting A could
  // move accounting B's early-morning allowance -- which the owner reserved to MD.
  const refuseA = (editorRole, targetRole) => SRV().checkinEditRefusalReason(Object.assign({}, base, {
    editor: { id: 4, role: editorRole }, target: { id: 7, role: targetRole },
  }));
  assert.strictEqual(refuseA('accounting', 'accounting'), 'accounting-is-md-only');
  assert.strictEqual(refuseA('md', 'accounting'), '');
  assert.strictEqual(refuseA('accounting', 'user'), '');
});

test('the corrected day carries its original time and an edited flag to the UI', () => {
  // Without these on the row, the pencil disappears after the first correction (its eligibility
  // test falls back to the CORRECTED time), the mandatory history becomes unreachable, and
  // nothing anywhere shows that a check-in was corrected at all.
  for (const [label, src] of [['server', SERVER_SRC], ['app', APP_SRC]]) {
    const gen = periodDaysBody(src);
    for (const f of ['rawCheckIn', 'checkInEdited']) {
      assert.ok(new RegExp(`\\b${f}\\b`).test(gen), `${label} generatePeriodDays must carry ${f} onto the day`);
    }
  }
});

test('a corrected check-in re-derives whether the day is late', () => {
  // The overlay changed checkIn but left `status` as derived from the uncorrected scan, so a day
  // corrected to 09:30 deducted late minutes while reporting zero late arrivals on the same
  // payslip. The approved time-correction path already re-derives it; this now does too.
  for (const [label, src] of [['server', SERVER_SRC], ['app', APP_SRC]]) {
    const gen = periodDaysBody(src);
    assert.ok(/checkInEdited[\s\S]{0,400}?(late|stdStr)/.test(gen),
      `${label} generatePeriodDays must re-derive the status after a correction`);
  }
});

test('correcting a time tells every other open session', () => {
  const put = extractFunction(SERVER_SRC, 'handlePutCheckinTimeEdit');
  assert.ok(/broadcast\(/.test(put), 'siblings broadcast; a stale open page is a known hazard here');
  assert.ok(/CHECKIN_EDITS_UPDATED/.test(SERVER_SRC) && /CHECKIN_EDITS_UPDATED/.test(APP_SRC),
    'the browser must handle the broadcast it is sent');
});

// --- i18n -----------------------------------------------------------------------------
// 2026-10-14 (review): this feature shipped with every one of its strings untranslated and no
// test noticed. The project rule is that TH/EN/JA go together in the same edit, and on this page
// Japanese is resolved by looking the ENGLISH string up in window.LANG_JA -- so a missing entry
// is a silent English leak in JA mode, not an error anyone would see in testing.
test('every string this feature adds exists in all three languages', () => {
  const JA = fs.readFileSync(path.join(ROOT, 'attendance/lang/ja.js'), 'utf8');
  const entries = {};
  for (const m of JA.matchAll(/^\s*"((?:[^"\\]|\\.)*)":\s*"((?:[^"\\]|\\.)*)"/gm)) {
    entries[JSON.parse(`"${m[1]}"`)] = JSON.parse(`"${m[2]}"`);
  }
  // Every L('en', 'th') the feature's own functions use.
  const region = ['checkinEditBtnHtml', 'openCheckinEditModal', 'submitCheckinEdit']
    .map(n => extractFunction(APP_SRC, n)).join('\n');
  const english = [...region.matchAll(/\bL\(\s*'((?:[^'\\]|\\.)+)'\s*,/g)].map(m => m[1].replace(/\\'/g, "'"));
  assert.ok(english.length >= 9, `expected the feature's strings to be found, got ${english.length}`);
  const missing = english.filter(en => !Object.prototype.hasOwnProperty.call(entries, en));
  assert.deepStrictEqual(missing, [], `attendance/lang/ja.js has no entry for: ${missing.join(' | ')}`);
  const notJapanese = english.filter(en => !/[぀-ヿ一-龯]/.test(entries[en]));
  assert.deepStrictEqual(notJapanese, [], `these entries contain no Japanese: ${notJapanese.join(' | ')}`);
  // and Thai is present alongside each English string
  assert.ok(/[฀-๿]/.test(region), 'the feature has no Thai at all');
});

console.log(`\n${passed} assertions passed`);
