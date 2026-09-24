// 2026-09-24 backlog, last batch: owner cancel of approved Holiday Work, "never remove an earned
// day that is already used", revocable time corrections, revoke result email, carry-forward
// button January-only / never before system start, abroad local-time note hidden on Bangkok's clock.
// No framework: `node tests/cancel-hw-earned-day.test.js`. Same approach as the other tests: the
// real functions are extracted from attendance/js/app.js and attendance-server/backend/server.js
// and run in a sandbox, so the DUAL-SYNC copies are proven to agree.
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
  // Body starts at the first ') {' -- a destructured parameter ({ a, b }) has braces of its own.
  return extractBraced(src, m.index, src.indexOf(') {', m.index) + 2, name);
}
function extractConstObject(src, name) {
  const m = new RegExp(`^const ${name} = \\{`, 'm').exec(src);
  if (!m) throw new Error(`const ${name} not found`);
  return extractBraced(src, m.index, src.indexOf('{', m.index), name) + ';';
}
// Two same-named functions from two files: prove the DUAL-SYNC copies are textually identical.
function sameSource(name) {
  const norm = s => s.replace(/\s+/g, ' ').trim();
  assert.strictEqual(norm(extractFunction(APP_SRC, name)), norm(extractFunction(SERVER_SRC, name)), `${name} differs between app.js and server.js`);
}

const TIERS = [{ afterMonths: 6, days: 3 }, { afterMonths: 12, days: 6 }, { afterMonths: 24, days: 8 }, { afterMonths: 36, days: 10 }];
const LEAVE = { carryForwardMax: 5, carryForwardExpiryEnabled: true, carryForwardExpiryMonth: 3, carryForwardExpiryDay: 31,
  annualLeaveMinMonths: 6, annualLeaveTiers: TIERS, sickLeaveDays: 30, businessLeaveDays: 3 };
const isWeekendStr = d => { const x = new Date(d + 'T12:00:00').getDay(); return x === 0 || x === 6; };

const SHARED = ['normalizeAnnualLeaveTiers', 'getAnnualLeaveTiers', 'getAnnualLeaveMinMonths', 'annualLeaveUnlockDateStr',
  'isAnnualLeaveUnlocked', 'annualLeaveEntitlementDays', 'abroadTravelCreditDays', 'hourlyLeaveChargedMinutes',
  'carryForwardExpiryEnabled', 'carryForwardExpiryDateStr', 'leaveWorkingDaysBetween', 'leaveMinutesOnOrBefore',
  'carryForwardForfeitMinutes', 'isVoidLeaveStatus', 'isCancellableApprovedLeave', 'isRevocableLeaveType',
  'earnedCreditMinutesOf', 'earnedCreditYearsOf', 'earnedDayBalanceAsOf', 'carryForwardAfterCreditLoss', 'isEarnedDayUsed',
  'carryForwardRunRefusal'];
const CLIENT_FNS = [...SHARED, 'leaveRecordMinutes', 'getApprovedHolidayWorkDays', 'getCarryForwardKey',
  'getCarryForwardCompKey', 'getCarryForwardDays', 'getCarryForwardCompDays', 'getOpeningUsedKey', 'getOpeningUsedDays',
  'computeLeaveBalance', 'localDateStr', 'annualGateRemainingMinutes', 'isYearEndCountedLeaveStatus', 'annualLeaveRemainingMinutes', 'earnedDayUsedByRecord', 'approvedCancelBlockCode',
  'isRevokeCandidate', 'revokeBlockCode', 'canRevokeLeaveApproval', 'attendanceTimesForDate', 'attKey',
  'carryForwardFirstSourceYear', 'carryForwardNextRunJanuaryYear', 'carryForwardRefusalText',
  'isSafeTimeZone', 'tzOffsetMinutesAt', 'abroadLocalTimeText'];
const SERVER_FNS = [...SHARED, 'leaveMinutesOf', 'getApprovedHolidayWorkAnnualLeaveDays', 'deriveLeaveDaysCount',
  'ta_localDateStr', 'isValidDateStr', 'isYearEndCountedLeaveStatus', 'annualLeaveRemainingMinutes', 'leaveBalanceRemainingMinutes', 'leaveBalanceError',
  'earnedDayUsedError', 'carryForwardAutoRunYear', 'carryForwardFirstSourceYear'];

// World = { today, user, leaves, cf, openingUsed, frozen: bool, log }
function makeClient(w) {
  const ctx = {
    APP_SETTINGS: { leave: LEAVE, lateDeductPolicy: { enabled: false }, workSchedule: { standardStartHour: 8, standardStartMinute: 30 } },
    DATA_LEAVES: w.leaves, DATA_USERS: [w.user], LEAVE_CARRY_FORWARD: w.cf || {}, LEAVE_OPENING_USED: w.openingUsed || {},
    DEFAULT_ANNUAL_LEAVE_TIERS: TIERS, DEFAULT_TZ: 'Asia/Bangkok', APP_FIRST_PERIOD_START: new Date(2026, 5, 21),
    currentUser: w.viewer || w.user, currentLang: 'en', L: en => en, attendanceLog: w.log || {},
    actingRoles: () => [(w.viewer || w.user).role],
    bangkokDateStr: () => w.today, businessDateStr: () => w.today, bangkokYear: () => Number(w.today.slice(0, 4)),
    isPublicHoliday: () => false, isCompanyTripDay: d => (w.tripDays || []).includes(d), isNonWorkDayForComp: isWeekendStr,
    computeLateDeductMinutes: () => ({ count: 0, deductMin: 0 }),
    payPeriodBlockedForRange: () => (w.frozen ? { blocked: true, reason: 'period-frozen' } : { blocked: false }),
  };
  vm.createContext(ctx);
  vm.runInContext(CLIENT_FNS.map(n => extractFunction(APP_SRC, n)).join('\n'), ctx);
  return ctx;
}
function makeServer(w) {
  const ctx = {
    HHMM_RE: /^([01]\d|2[0-3]):[0-5]\d$/, DATE_RE: /^\d{4}-\d{2}-\d{2}$/, DEFAULT_ANNUAL_LEAVE_TIERS: TIERS,
    APP_FIRST_PERIOD_START: new Date(2026, 5, 21),
    getAppSettings: () => ({ leave: LEAVE, lateDeductPolicy: { enabled: false } }),
    readSettings: () => ({ leaveCarryForward: w.cf || {}, leaveOpeningUsed: w.openingUsed || {} }),
    bangkokDateStr: () => w.today, businessLeaveEntitlementDays: () => 3,
    isPublicHoliday: () => false, isCompanyTripDay: d => (w.tripDays || []).includes(d), isNonWorkDayForComp: isWeekendStr,
    annualLateDeductMinutes: () => 0,
  };
  vm.createContext(ctx);
  vm.runInContext(SERVER_FNS.map(n => extractFunction(SERVER_SRC, n)).join('\n'), ctx);
  return ctx;
}
const both = w => [['client', makeClient(w)], ['server', makeServer(w)]];
// The one question both sides answer: may this record's earned day be taken away?
function refused(side, X, w, rec) {
  return side === 'client' ? X.earnedDayUsedByRecord(rec) : !!X.earnedDayUsedError(w.leaves, w.user, rec);
}

let passed = 0;
const pending = [];
function test(name, fn) {
  const ok = () => { passed++; console.log(`  ok  ${name}`); };
  const fail = e => { console.log(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; };
  try {
    const r = fn();
    if (r && typeof r.then === 'function') pending.push(r.then(ok, fail));
    else ok();
  } catch (e) { fail(e); }
}
let nextId = 1;
const USER = { id: 1, role: 'user', startDate: '2020-01-01', active: true }; // 10-day tier
const annual = (dateFrom, dateTo, days, status = 'approved') => ({ id: nextId++, userId: 1, type: 'annual', status, dateFrom, dateTo, days });
const hw = (dateFrom, mode, status = 'approved') => ({ id: nextId++, userId: 1, type: 'holiday-work', compensationMode: mode, status, dateFrom, dateTo: dateFrom, days: 1 });
const trip = (dateFrom, dateTo, status = 'approved') => ({ id: nextId++, userId: 1, type: 'abroad', status, dateFrom, dateTo });

console.log('T2 shared helpers are identical in both files');
test('earnedCreditMinutesOf / earnedCreditYearsOf / earnedDayBalanceAsOf / carryForwardAfterCreditLoss / isEarnedDayUsed', () => {
  ['earnedCreditMinutesOf', 'earnedCreditYearsOf', 'earnedDayBalanceAsOf', 'carryForwardAfterCreditLoss', 'isEarnedDayUsed',
    'carryForwardRunRefusal', 'isRevocableLeaveType', 'isCancellableApprovedLeave'].forEach(n => {
    if (n === 'isCancellableApprovedLeave') return; // date regex differs by design (isValidDateStr vs inline)
    sameSource(n);
  });
});

console.log('T2 never remove an earned day that is already used (annual-mode Holiday Work)');
// Sat 2026-11-07 holiday work taken as +1 annual day. Entitlement 10 + earned 1 = 11 days.
const today = '2026-12-10';
test('earned 1, used 1 (11 of 11 days taken) -> refused on both sides', () => {
  const rec = hw('2026-11-07', 'annual-leave');
  const w = { today, user: USER, leaves: [rec, annual('2026-03-02', '2026-03-13', 10), annual('2026-12-01', '2026-12-01', 1)] };
  for (const [side, X] of both(w)) assert.strictEqual(refused(side, X, w, rec), true, side);
});
test('earned 1, used 0 (10 of 11 days taken) -> allowed on both sides', () => {
  const rec = hw('2026-11-07', 'annual-leave');
  const w = { today, user: USER, leaves: [rec, annual('2026-03-02', '2026-03-13', 10)] };
  for (const [side, X] of both(w)) assert.strictEqual(refused(side, X, w, rec), false, side);
});
test('a PENDING annual request counts as used -> refused', () => {
  const rec = hw('2026-11-07', 'annual-leave');
  const w = { today, user: USER, leaves: [rec, annual('2026-03-02', '2026-03-13', 10), annual('2026-12-21', '2026-12-21', 1, 'pending-manager')] };
  for (const [side, X] of both(w)) assert.strictEqual(refused(side, X, w, rec), true, side);
});
test('cancelled / rejected annual leave does not count as used -> allowed', () => {
  const rec = hw('2026-11-07', 'annual-leave');
  const w = { today, user: USER, leaves: [rec, annual('2026-03-02', '2026-03-13', 10), annual('2026-12-01', '2026-12-01', 1, 'cancelled'), annual('2026-12-02', '2026-12-02', 1, 'rejected')] };
  for (const [side, X] of both(w)) assert.strictEqual(refused(side, X, w, rec), false, side);
});
test('pay-mode Holiday Work earns nothing -> never refused (only period guards apply)', () => {
  const rec = hw('2026-11-07', 'paid');
  const w = { today, user: USER, leaves: [rec, annual('2026-03-02', '2026-03-13', 10)] };
  for (const [side, X] of both(w)) assert.strictEqual(refused(side, X, w, rec), false, side);
});
test('holiday work on a (later) Company Trip day earned nothing -> not refused', () => {
  const rec = hw('2026-11-07', 'annual-leave');
  const w = { today, user: USER, tripDays: ['2026-11-07'], leaves: [rec, annual('2026-03-02', '2026-03-13', 10)] };
  for (const [side, X] of both(w)) assert.strictEqual(refused(side, X, w, rec), false, side);
});
test('two earned days, one used: the first can go, the balance still covers it', () => {
  const a = hw('2026-11-07', 'annual-leave'), b = hw('2026-11-14', 'annual-leave');
  const w = { today, user: USER, leaves: [a, b, annual('2026-03-02', '2026-03-13', 10), annual('2026-12-01', '2026-12-01', 1)] };
  for (const [side, X] of both(w)) assert.strictEqual(refused(side, X, w, a), false, side);
});

console.log('T2 revoke of an approved Abroad trip whose travel-day credit has arrived');
test('arrived Saturday travel day used -> refused; unused -> allowed', () => {
  const rec = trip('2026-11-14', '2026-11-18'); // Sat start: 1 credit day
  const used = { today, user: USER, leaves: [rec, annual('2026-03-02', '2026-03-13', 10), annual('2026-12-01', '2026-12-01', 1)] };
  for (const [side, X] of both(used)) assert.strictEqual(refused(side, X, used, rec), true, side);
  const unused = { today, user: USER, leaves: [rec, annual('2026-03-02', '2026-03-13', 10)] };
  for (const [side, X] of both(unused)) assert.strictEqual(refused(side, X, unused, rec), false, side);
});
test('travel day not arrived yet earns nothing -> not refused', () => {
  const rec = trip('2026-12-19', '2026-12-22'); // Sat 12-19 is after "today"
  const w = { today, user: USER, leaves: [rec, annual('2026-03-02', '2026-03-13', 10)] };
  for (const [side, X] of both(w)) assert.strictEqual(refused(side, X, w, rec), false, side);
});

console.log('T2 next year already snapshotted from the earned day');
// 2026: 10 + 1 earned - 10 used = 1 day left -> carried into 2027 (cf 2027_1 = 1).
function snapWorld(used2027) {
  const rec = hw('2026-11-07', 'annual-leave');
  const leaves = [rec, annual('2026-03-02', '2026-03-13', 10)];
  if (used2027) leaves.push(annual('2027-01-04', '2027-01-15', used2027));
  return { rec, w: { today: '2027-01-20', user: USER, cf: { '2027_1': 1, 'comp_2027_1': 0 }, leaves } };
}
test('carried day still unused in 2027 -> allowed; carried day used in 2027 -> refused', () => {
  const ok = snapWorld(10); // 2027: 10 + 1 CF - 10 = 1 left, losing the 1 CF day leaves 0
  for (const [side, X] of both(ok.w)) assert.strictEqual(refused(side, X, ok.w, ok.rec), false, side);
  const bad = snapWorld(11);
  for (const [side, X] of both(bad.w)) assert.strictEqual(refused(side, X, bad.w, bad.rec), true, side);
});

// 2026-09-24 (review fix 10): the client used computeLeaveBalance(..).remMin (approved only, today's
// forfeit) for the refresh pool while the server uses annualLeaveRemainingMinutes (pending counted,
// forfeit as of 1 Jan next year) -> the Revoke/Cancel button showed and the server refused.
test('pending last-year leave: client and server agree on the carry-forward drop (both refuse)', () => {
  const rec = hw('2026-11-07', 'annual-leave');
  const leaves = [rec, annual('2026-03-02', '2026-03-11', 8), annual('2026-12-21', '2026-12-22', 2, 'pending-manager'),
    annual('2027-01-04', '2027-01-18', 11)];
  // 2026: 10 + 1 earned - 8 approved - 2 pending = 1 carried. Without the earned day the refresh
  // carries 0, and 2027 (10 + 1 CF - 11 used) cannot absorb losing it.
  const w = { today: '2027-01-20', user: USER, cf: { '2027_1': 1, 'comp_2027_1': 0 }, leaves };
  const [[, C], [, S]] = both(w);
  assert.strictEqual(C.annualLeaveRemainingMinutes(USER, 2026), S.annualLeaveRemainingMinutes(leaves, USER, 2026, w.cf));
  assert.strictEqual(refused('client', C, w, rec), true, 'client');
  assert.strictEqual(refused('server', S, w, rec), true, 'server');
});

console.log('T1 owner cancel of approved Holiday Work');
test('approved holiday work (both modes, past date) is owner-cancellable on both sides; void / pending are not', () => {
  const w = { today, user: USER, leaves: [] };
  for (const [side, X] of both(w)) {
    assert.strictEqual(X.isCancellableApprovedLeave(hw('2026-06-06', 'paid'), today), true, side);
    assert.strictEqual(X.isCancellableApprovedLeave(hw('2026-06-06', 'annual-leave'), today), true, side);
    for (const st of ['cancelled', 'revoked', 'rejected', 'pending-md']) {
      assert.strictEqual(X.isCancellableApprovedLeave(hw('2026-06-06', 'paid', st), today), false, `${side} ${st}`);
    }
    assert.strictEqual(X.isCancellableApprovedLeave({ ...hw('2026-06-06', 'paid'), dateFrom: 'x' }, today), false, side);
    // annual leave keeps its before-the-start-date rule
    assert.strictEqual(X.isCancellableApprovedLeave(annual('2026-06-01', '2026-06-01', 1), today), false, side);
  }
});
test('client hides Cancel with the reason: MD-approved period, earned day used', () => {
  const rec = hw('2026-11-07', 'annual-leave');
  const frozen = makeClient({ today, user: USER, frozen: true, leaves: [rec] });
  assert.strictEqual(frozen.approvedCancelBlockCode(rec), 'period-frozen');
  const used = makeClient({ today, user: USER, leaves: [rec, annual('2026-03-02', '2026-03-13', 10), annual('2026-12-01', '2026-12-01', 1)] });
  assert.strictEqual(used.approvedCancelBlockCode(rec), 'earned-day-used');
  const fine = makeClient({ today, user: USER, leaves: [rec] });
  assert.strictEqual(fine.approvedCancelBlockCode(rec), '');
});
test('DELETE route: guard codes, earned-day check, snapshot refresh for annual-mode HW, soft cancel', () => {
  const i = SERVER_SRC.indexOf("app.delete('/api/leaves/:id'");
  const body = SERVER_SRC.slice(i, SERVER_SRC.indexOf('\napp.', i + 10));
  ["code:'period-locked'", "code:'period-confirmed'", "code:'period-frozen'", 'earnedDayUsedError(leaves, live, leave)',
    "leave.type === 'holiday-work' && leave.compensationMode === 'annual-leave'", "status: 'cancelled'", "broadcastLeaveUpdated(leaves[idx])"]
    .forEach(k => assert.ok(body.includes(k), k));
  // the earned-day check runs before anything is written
  assert.ok(body.indexOf('earnedDayUsedError') < body.indexOf('saveLeaves(leaves)'));
});

console.log('T2/T3/T4 revoke route');
test('revoke: earned-day check before the write, owner email via sendResultEmail', () => {
  const i = SERVER_SRC.indexOf("app.post('/api/leaves/:id/revoke'");
  const body = SERVER_SRC.slice(i, SERVER_SRC.indexOf('\napp.', i + 10));
  assert.ok(body.includes('earnedDayUsedError(leaves, ownerUser, leave)'));
  assert.ok(body.indexOf('earnedDayUsedError') < body.indexOf('saveLeaves(leaves)'));
  // 2026-09-24 (review fix 4): the email now also lists the records revoked with a time correction.
  assert.ok(body.includes('sendResultEmail(leaves[idx], undefined, undefined, alsoRevoked).catch('));
});
test('time-correction is revocable on both sides; client Revoke gate = candidate + no block', () => {
  const w = { today, user: USER, leaves: [] };
  for (const [side, X] of both(w)) assert.strictEqual(X.isRevocableLeaveType('time-correction'), true, side);
  const md = { id: 9, role: 'md' };
  const tc = { id: nextId++, userId: 1, type: 'time-correction', status: 'approved', dateFrom: '2026-12-01', dateTo: '2026-12-01', correctionField: 'checkIn', correctedTime: '08:00' };
  assert.strictEqual(makeClient({ today, user: USER, viewer: md, leaves: [tc] }).canRevokeLeaveApproval(tc), true);
  const C = makeClient({ today, user: USER, viewer: md, frozen: true, leaves: [tc] });
  assert.strictEqual(C.canRevokeLeaveApproval(tc), false);
  assert.strictEqual(C.revokeBlockCode(tc), 'period-frozen');
  assert.strictEqual(makeClient({ today, user: USER, viewer: USER, leaves: [tc] }).isRevokeCandidate(tc), false, 'own record');
});
test('after revoke the day falls back to the real scan (approved corrections only)', () => {
  const tc = st => ({ id: 77, userId: 1, type: 'time-correction', status: st, dateFrom: '2026-12-01', correctionField: 'checkIn', correctedTime: '08:00' });
  const log = { '1_2026-12-01': { checkIn: '09:10', checkOut: '18:00' } };
  assert.strictEqual(makeClient({ today, user: USER, log, leaves: [tc('approved')] }).attendanceTimesForDate('2026-12-01', 1).checkIn, '08:00');
  for (const st of ['revoked', 'cancelled', 'pending-md']) {
    assert.strictEqual(makeClient({ today, user: USER, log, leaves: [tc(st)] }).attendanceTimesForDate('2026-12-01', 1).checkIn, '09:10', st);
  }
  // server log builder + late deduction read approved leaves only
  assert.ok(SERVER_SRC.includes("leaves.filter(l => l.userId == uid && l.status === 'approved').forEach(l => {"));
  assert.ok(/l\.status === 'approved' &&\s*\n\s*l\.type === 'time-correction' && l\.correctionField === 'checkIn'/.test(SERVER_SRC));
});

console.log('T4 revoke result email (real template code, transport stubbed)');
function emailCtx(emp) {
  const sent = [];
  const ctx = {
    readUsers: () => [emp], readSettings: () => ({ emailConfig: { user: 'noreply@example.test' } }),
    getEmailTransport: () => ({ sendMail: async m => { sent.push(m); } }),
    EMAIL_COLORS: { success: 'g', successBg: 'gb', danger: 'r', dangerBg: 'rb', amber: 'a', amberBg: 'ab', border: 'b', text: 't', textFaint: 'f' },
    fmtEmailDateLong: () => '1 Dec 2026', getTypeLabel: t => t, TYPE_ICONS: {},
    emailShell: o => `[${o.headerIcon}|${o.headerTitle}]${o.bodyHtml}`, console: { log() {} },
  };
  vm.createContext(ctx);
  vm.runInContext([extractConstObject(SERVER_SRC, 'EMAIL_I18N'), extractFunction(SERVER_SRC, 'escapeHtml'),
    extractFunction(SERVER_SRC, 'emailLangOf'), extractFunction(SERVER_SRC, 'buildResultDetailRows'),
    extractFunction(SERVER_SRC, 'sendResultEmail')].join('\n').replace(/^const EMAIL_I18N/m, 'var EMAIL_I18N'), ctx);
  return { ctx, sent };
}
const revokedRec = { id: 5, userId: 1, type: 'ot', status: 'revoked', dateFrom: '2026-12-01', dateTo: '2026-12-01',
  otHours: 2, otMultiplier: 1.5, revokedBy: 'Acc <b>', revokeReason: 'wrong <script>x</script> day' };
test('opted-in employee gets "Approval revoked" in their language, with escaped revoker + reason', async () => {
  for (const [lang, status, subj] of [['th', 'ถูกเพิกถอนการอนุมัติ', 'เพิกถอน'], ['en', 'Approval revoked', 'revoked'], ['ja', '承認取り消し', '取り消され']]) {
    const { ctx, sent } = emailCtx({ id: 1, email: 'e@example.test', emailNotifyOnResult: true, notifyLangEmail: lang });
    await ctx.sendResultEmail(revokedRec);
    assert.strictEqual(sent.length, 1, lang);
    assert.ok(sent[0].subject.includes(subj), `${lang} subject: ${sent[0].subject}`);
    assert.ok(sent[0].html.includes(status), `${lang} status`);
    assert.ok(sent[0].html.includes('Acc &lt;b&gt;'), `${lang} revoker escaped`);
    assert.ok(sent[0].html.includes('wrong &lt;script&gt;x&lt;/script&gt; day'), `${lang} reason escaped`);
    assert.ok(!sent[0].html.includes('<script>'), lang);
  }
});
test('not opted in -> no email', async () => {
  const { ctx, sent } = emailCtx({ id: 1, email: 'e@example.test', emailNotifyOnResult: false, notifyLangEmail: 'en' });
  await ctx.sendResultEmail(revokedRec);
  assert.strictEqual(sent.length, 0);
});

console.log('T5 carry-forward: January only, never before the system started');
test('carryForwardRunRefusal (both sides)', () => {
  const w = { today, user: USER, leaves: [] };
  for (const [side, X] of both(w)) {
    assert.strictEqual(X.carryForwardRunRefusal('2027-01-15', 2026, 2026), null, side);
    assert.strictEqual(X.carryForwardRunRefusal('2027-02-01', 2026, 2026), 'cf-not-january', side);
    assert.strictEqual(X.carryForwardRunRefusal('2026-09-24', 2025, 2026), 'cf-not-january', side);
    assert.strictEqual(X.carryForwardRunRefusal('2027-01-15', 2025, 2026), 'cf-bad-year', side);
    assert.strictEqual(X.carryForwardRunRefusal('2026-01-15', 2025, 2026), 'cf-before-system-start', side);
    assert.strictEqual(X.carryForwardRunRefusal('', 2026, 2026), 'cf-not-january', side);
    assert.strictEqual(X.carryForwardFirstSourceYear(), 2026, side);
  }
});
test('automatic run skips a year before the system started', () => {
  const S = makeServer({ today, user: USER, leaves: [] });
  assert.strictEqual(S.carryForwardAutoRunYear('2026-01-05', {}, 2026), null);
  assert.strictEqual(S.carryForwardAutoRunYear('2027-01-05', {}, 2026), 2026);
  assert.ok(SERVER_SRC.includes('carryForwardAutoRunYear(bangkokDateStr(), settings.leaveCarryForwardRuns, carryForwardFirstSourceYear())'));
  const i = SERVER_SRC.indexOf("app.post('/api/leave-carry-forward/run'");
  assert.ok(SERVER_SRC.slice(i, i + 800).includes('carryForwardRunRefusal(bangkokDateStr(), year, carryForwardFirstSourceYear())'));
});
test('button text outside January names the next automatic January', () => {
  const C = makeClient({ today: '2026-09-24', user: USER, leaves: [] });
  assert.strictEqual(C.carryForwardNextRunJanuaryYear('2026-09-24'), 2027);
  assert.strictEqual(C.carryForwardNextRunJanuaryYear('2027-01-10'), 2027);
  assert.strictEqual(C.carryForwardNextRunJanuaryYear('2027-03-10'), 2028);
  assert.strictEqual(C.carryForwardRefusalText('cf-not-january', '2026-09-24'), 'Carry-forward runs automatically in January 2027');
});

console.log('T6 leaveCarryForward is server-only');
test('PUT /api/settings refuses leaveCarryForward; no client code sends it', () => {
  const i = SERVER_SRC.indexOf("app.put('/api/settings'");
  const body = SERVER_SRC.slice(i, SERVER_SRC.indexOf('\napp.', i + 10));
  assert.ok(body.includes("hasOwnProperty.call(body, 'leaveCarryForward')"));
  assert.ok(!/^\s*leaveCarryForward: \[/m.test(extractConstObject(SERVER_SRC, 'SETTINGS_KEY_ROLES')));
  // every PUT body in app.js: none may carry leaveCarryForward
  const puts = APP_SRC.split("apiFetch(`/api/settings`, {").slice(1).map(s => s.slice(0, 400)).filter(s => /method: 'PUT'/.test(s));
  assert.ok(puts.length >= 8, `found ${puts.length} PUT call sites`);
  puts.forEach(s => assert.ok(!/leaveCarryForward/.test(s.slice(0, s.indexOf('})') + 2)), s.slice(0, 200)));
});

console.log('T7 abroad local-time note hidden when the clock equals Bangkok');
test('same offset as Bangkok -> no note; different offset -> note', () => {
  const C = makeClient({ today, user: USER, leaves: [] });
  const at = '2026-09-24T09:00:00+07:00';
  for (const tz of ['Asia/Vientiane', 'Asia/Ho_Chi_Minh', 'Asia/Phnom_Penh', 'Asia/Jakarta']) {
    assert.strictEqual(C.abroadLocalTimeText(at, tz, '09:00'), '', tz);
  }
  assert.strictEqual(C.abroadLocalTimeText(at, 'Asia/Tokyo', '09:00'), '11:00 Tokyo time');
  assert.strictEqual(C.abroadLocalTimeText(at, 'Asia/Kolkata', '09:00'), '07:30 Kolkata time');
  assert.strictEqual(C.tzOffsetMinutesAt(Date.parse(at), 'Asia/Bangkok'), 420);
  assert.strictEqual(C.tzOffsetMinutesAt(Date.parse(at), 'Asia/Kolkata'), 330);
  // DST: New York is -4h in September, -5h in January
  assert.strictEqual(C.tzOffsetMinutesAt(Date.parse('2026-09-24T00:00:00Z'), 'America/New_York'), -240);
  assert.strictEqual(C.tzOffsetMinutesAt(Date.parse('2027-01-24T00:00:00Z'), 'America/New_York'), -300);
});

Promise.all(pending).then(() => console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ', 0 failed'}`));
