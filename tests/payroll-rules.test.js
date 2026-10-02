// Payroll-rule unit tests (2026-09-24 backlog: Company Trip exclusions, office OT past midnight,
// driver OT hours to 2 decimals, Holiday Work OT in OT counts). No framework:
// `node tests/payroll-rules.test.js`.
//
// Same approach as tests/leave-rules.test.js: every function is extracted from the real source
// files (attendance/js/app.js and attendance-server/backend/server.js) and run in a sandbox with
// small stubs, so the tests also prove the two DUAL-SYNC copies agree.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const APP_SRC = fs.readFileSync(path.join(ROOT, 'attendance/js/app.js'), 'utf8');
const SERVER_SRC = fs.readFileSync(path.join(ROOT, 'attendance-server/backend/server.js'), 'utf8');
// 2026-10-02: the business-day boundary is read out of the real source instead of repeating the
// number here, so moving it can never leave these sandboxes asserting against the old value.
const BUSINESS_DAY_START_MINS = Number(/const BUSINESS_DAY_START_MINS = (\d+);/.exec(APP_SRC)[1]);

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

const TRIPS = ['2026-11-27', '2026-11-28']; // Fri + Sat
const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const isWeekend = d => { const x = new Date(d + 'T12:00:00').getDay(); return x === 0 || x === 6; };
const SETTINGS = {
  allowances: {
    earlyMorning1: 240, earlyMorning2: 480, earlyThreshold1Min: 450, earlyThreshold2Min: 390,
    lateNight1: 100, lateNight2: 200, lateNightThreshold1Hour: 19, lateNightThreshold2Hour: 20,
    upcountry: 240, holidayTransport: 500, abroad: 1100, personalCar: 1000, phone: 1000, diligence: 0,
  },
  sso: { rate: 5, maxAmount: 875, minSalary: 1650 },
  tax: { personalAllowanceAnnual: 60000 },
  workSchedule: { standardStartHour: 8, standardStartMinute: 30 },
  allowanceEligibility: {},
  payroll: { periodStartDay: 21 },
};

const SHARED = ['isVoidLeaveStatus', 'round2HalfUp', 'round1HalfUp', 'deriveOfficeOtFromEndTime', 'lateNightCheckoutMins', 'lateNightThresholdMins', 'lateNightThresholdHourOf', 'parseHHMMToMins',
  'isHolidayWorkDay', 'isNonWorkDayForComp', 'isHolidayWorkOtRecord', 'companyTripDateInRange',
  'isFullDayPersonalLeaveStatus', 'isRestAttendanceDay', 'isDeviceScanSource', 'isEarlyMorningDayStatus',
  'deviceScanQualifiesForEarlyMorning', 'earlyMorningCheckInOk', 'deviceScanQualifiesForLateNight', 'lateNightCheckoutOk',
  'addOtHours', 'accumulateApprovedOtHours', 'otPayFromHourBuckets', 'effectiveOtMultiplier', 'computePayroll', 'splitHolidayWorkOtMinutes', 'holidayWorkEndMins',
  // 2026-09-28: extracted out of computePayroll so the in-form pay preview reuses the same rules.
  'hasUpcountryLocation', 'holidayTransportForRecord',
  'lateNightPoints', 'holidayWorkTooLong'];
const CLIENT_FNS = [...SHARED, 'scanWindowError', 'getApprovedHolidayWorkDays', 'abroadTravelCreditDays',
  'otEndCrossesMidnight', 'canSubmitHolidayWorkForDate', 'standardOtMultiplier', 'otPayAmountFromLeave'];
const SERVER_FNS = [...SHARED, 'scanWindowError', 'getApprovedHolidayWorkAnnualLeaveDays', 'abroadTravelCreditDays',
  'isCompanyTripClaimBlocked', 'companyTripNoClaimMessage', 'standardOtMultiplier'];

// world = { leaves, pDays, att: {date: {checkIn, checkOut}} }
function makeClient(world) {
  const ctx = {
    HHMM_RE, APP_SETTINGS: SETTINGS, DATA_LEAVES: world.leaves, DATA_COMPANY_TRIP_DATES: TRIPS,
    DATA_USERS: [world.user], currentUser: world.user, editingLeaveId: null, finalizeData: {},
    isCompanyTripDay: d => TRIPS.includes(d), isPublicHoliday: () => false,
    isAllowanceEligible: () => true, isApprovedAbroadDate: () => false, isAbroadTravelDay: () => false,
    payPeriodBlockedForDate: () => ({ blocked: false }), bangkokDateStr: () => '2026-12-31',
    attendanceTimesForDate: d => ({ checkIn: null, checkOut: null, lastScan: null, ...(world.att[d] || {}) }),
    generatePeriodDays: () => world.pDays, getFinalizeKey: () => 'k', calcAnnualTax: () => 0,
    L: en => en,
  };
  ctx.BUSINESS_DAY_START_MINS = BUSINESS_DAY_START_MINS;
  vm.createContext(ctx);
  vm.runInContext(CLIENT_FNS.map(n => extractFunction(APP_SRC, n)).join('\n'), ctx);
  return ctx;
}
function makeServer(world) {
  const ctx = {
    HHMM_RE, COMPANY_TRIP_NO_CLAIM_TYPES: null,
    readSettings: () => ({ companyTripDates: TRIPS }), getAppSettings: () => SETTINGS,
    isCompanyTripDay: d => TRIPS.includes(d), isPublicHoliday: () => false,
    isAllowanceEligible: () => true, bangkokDateStr: () => '2026-12-31',
    attendanceDayForUser: (u, d) => (world.att[d] ? { date: d, status: 'present', ...world.att[d] } : null),
    buildAttendanceLogForUser: () => ({}), readJSON: () => ({}), readLeaves: () => world.leaves,
    readCheckoutReviews: () => ({}), generatePeriodDays: () => world.pDays, getFinalizeKey: () => 'k',
    calcAnnualTax: () => 0,
  };
  ctx.BUSINESS_DAY_START_MINS = BUSINESS_DAY_START_MINS;
  vm.createContext(ctx);
  // The Set constant is not a function -- evaluate its real declaration line from server.js.
  const setLine = SERVER_SRC.match(/^const COMPANY_TRIP_NO_CLAIM_TYPES = .*$/m)[0].replace(/^const /, '');
  vm.runInContext(setLine + '\n' + SERVER_FNS.map(n => extractFunction(SERVER_SRC, n)).join('\n'), ctx);
  return ctx;
}

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok  ${name}`); }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; }
}
const USER = { id: 1, role: 'user', salary: 24000 };
const world = over => ({ user: USER, leaves: [], pDays: [], att: {}, ...over });
const both = w => [['client', makeClient(w)], ['server', makeServer(w)]];

console.log('T4 rounding: 2 decimal places, half-up');
test('round2HalfUp both sides', () => {
  for (const [side, X] of both(world())) {
    assert.strictEqual(X.round2HalfUp(20 / 60), 0.33, side);
    assert.strictEqual(X.round2HalfUp(40 / 60), 0.67, side);
    assert.strictEqual(X.round2HalfUp(10 / 60), 0.17, side);
    assert.strictEqual(X.round2HalfUp(1.005), 1.01, side);
    assert.strictEqual(X.round2HalfUp(2.675), 2.68, side);
    assert.strictEqual(X.round2HalfUp(0.125), 0.13, side);
    assert.strictEqual(X.round2HalfUp(1.5), 1.5, side);
    assert.strictEqual(X.round2HalfUp('x'), 0, side);
  }
});
test('driver OT hours stored to 2dp: server POST/PUT and app.js submitDriverOT use round2HalfUp', () => {
  assert.ok(/otHours: round2HalfUp\(Number\(body\.otHours\) \|\| 0\)/.test(SERVER_SRC));
  assert.ok(/safeUpdates\.otHours = round2HalfUp\(/.test(SERVER_SRC));
  assert.ok(/const hm = \(hId, mId\) => round2HalfUp\(/.test(APP_SRC));
});

console.log('T2 office OT past midnight');
const THU = '2026-09-24', FRI = '2026-09-25';
test('duration: end before 05:30 is after midnight of the same work day', () => {
  for (const [side, X] of both(world())) {
    const d = (date, t) => X.deriveOfficeOtFromEndTime(date, t, SETTINGS).otHours;
    assert.strictEqual(d(THU, '20:30'), 3, side);
    assert.strictEqual(d(THU, '00:00'), 6.5, side);
    assert.strictEqual(d(THU, '01:00'), 7.5, side);
    assert.strictEqual(d(THU, '04:59'), 11.48, side);
    assert.strictEqual(d(THU, '05:00'), 11.5, side);    // 2026-10-02: still last night
    assert.strictEqual(d(THU, '05:29'), 11.98, side);
    assert.strictEqual(d(THU, '05:30'), 0, side);       // morning time -> not OT
    assert.strictEqual(d(THU, '17:30'), 0, side);
    assert.strictEqual(d(THU, '17:50'), 0.33, side);
    assert.strictEqual(d('2026-09-26', '20:00'), 0, side); // Saturday -> Holiday Work, not office OT
  }
});
test('rate: Friday OT running into Saturday keeps the start day rate (x1.5)', () => {
  for (const [side, X] of both(world())) {
    const r = X.deriveOfficeOtFromEndTime(FRI, '02:00', SETTINGS);
    assert.strictEqual(r.otMultiplier, 1.5, side);
    assert.strictEqual(r.otHours, 8.5, side);
    assert.strictEqual(r.otHours20 + r.otHours30, 0, side);
  }
});
test('scan window: OT end after midnight is checked against an after-midnight check-out', () => {
  const cases = [
    [{ checkIn: '08:00', checkOut: '02:00' }, '01:30', true],
    [{ checkIn: '08:00', checkOut: '02:00' }, '02:00', true],
    [{ checkIn: '08:00', checkOut: '02:00' }, '02:30', false],
    [{ checkIn: '08:00', checkOut: '23:00' }, '01:00', false],
    [{ checkIn: '08:00', checkOut: '23:00' }, '22:00', true],
    [{ checkIn: '08:00', checkOut: '01:00' }, '23:59', true],
  ];
  for (const [att, end, ok] of cases) {
    const w = world({ att: { [THU]: att } });
    const c = makeClient(w).scanWindowError(THU, null, end, 1);
    const s = makeServer(w).scanWindowError(USER, THU, null, end);
    assert.strictEqual(c === null, ok, `client ${att.checkOut} vs ${end}: ${c}`);
    assert.strictEqual(s === null, ok, `server ${att.checkOut} vs ${end}: ${s}`);
  }
});
console.log('T5 Holiday Work past midnight (2026-09-24)');
test('holidayWorkEndMins: end before 05:30 that is not after the start = after midnight', () => {
  for (const [side, X] of both(world())) {
    assert.strictEqual(X.holidayWorkEndMins('20:00', '01:00'), 25 * 60, side);
    assert.strictEqual(X.holidayWorkEndMins('08:30', '04:59'), 28 * 60 + 59, side);
    assert.strictEqual(X.holidayWorkEndMins('08:30', '17:30'), 17 * 60 + 30, side);
    assert.strictEqual(X.holidayWorkEndMins('03:00', '04:00'), 4 * 60, side);   // same early morning
    assert.strictEqual(X.holidayWorkEndMins('20:00', '05:00'), 29 * 60, side);  // 2026-10-02: still last night
    assert.ok(Number.isNaN(X.holidayWorkEndMins('20:00', '05:30')), side);      // 05:30 is morning, before start
    assert.ok(Number.isNaN(X.holidayWorkEndMins('10:00', '10:00')), side);
    assert.ok(Number.isNaN(X.holidayWorkEndMins('10:00', '09:00')), side);
  }
});
test('split: start-day rate, x3 after 17:30 through midnight, lunch only on the start day', () => {
  for (const [side, X] of both(world())) {
    const s = (a, b) => X.splitHolidayWorkOtMinutes(a, b, SETTINGS);
    assert.deepStrictEqual([s('20:00', '01:00').otHours20, s('20:00', '01:00').otHours30], [0, 5], side);
    assert.deepStrictEqual([s('08:30', '02:00').otHours20, s('08:30', '02:00').otHours30], [8, 8.5], side);
    assert.deepStrictEqual([s('10:00', '04:59').otHours20, s('10:00', '04:59').otHours30], [6.5, 11.48], side);
    assert.deepStrictEqual([s('08:30', '17:30').otHours20, s('08:30', '17:30').otHours30], [8, 0], side);
    assert.deepStrictEqual([s('20:00', '05:00').otHours20, s('20:00', '05:00').otHours30], [0, 9], side);
    assert.deepStrictEqual([s('20:00', '05:30').otHours20, s('20:00', '05:30').otHours30], [0, 0], side);
  }
});
test('scan window: an after-midnight Holiday Work end is checked against the real check-out', () => {
  const SAT = '2026-09-26';
  const cases = [[{ checkIn: '08:00', checkOut: '01:30' }, '01:00', true], [{ checkIn: '08:00', checkOut: '23:00' }, '01:00', false]];
  for (const [att, end, ok] of cases) {
    const w = world({ att: { [SAT]: att } });
    assert.strictEqual(makeClient(w).scanWindowError(SAT, '09:00', end, 1) === null, ok, `client ${att.checkOut}`);
    assert.strictEqual(makeServer(w).scanWindowError(USER, SAT, '09:00', end) === null, ok, `server ${att.checkOut}`);
  }
});
test('POST/PUT and the client form accept an after-midnight end (static)', () => {
  assert.strictEqual((SERVER_SRC.match(/!Number\.isFinite\(holidayWorkEndMins\(/g) || []).length, 2, 'server POST + PUT');
  assert.ok(/!Number\.isFinite\(holidayWorkEndMins\(workStartTime, workEndTime\)\)/.test(APP_SRC), 'client submitHolidayWork');
});

// 2026-09-24 (review fix 5): the after-midnight rule only for a start at/after 05:00; 20 h cap.
test('holidayWorkEndMins: start before 05:30 never wraps; 04:00-03:00 and 00:00-00:00 refused; 18:00-02:00 ok', () => {
  for (const [side, X] of both(world())) {
    assert.ok(Number.isNaN(X.holidayWorkEndMins('04:00', '03:00')), side);
    assert.ok(Number.isNaN(X.holidayWorkEndMins('00:00', '00:00')), side);
    assert.ok(Number.isNaN(X.holidayWorkEndMins('04:59', '04:00')), side);
    assert.strictEqual(X.holidayWorkEndMins('18:00', '02:00'), 26 * 60, side);
    assert.ok(Number.isNaN(X.holidayWorkEndMins('05:00', '04:00')), side);     // 2026-10-02: 05:00 starts before the day
    assert.strictEqual(X.holidayWorkEndMins('05:30', '04:00'), 28 * 60, side); // 22.5 h -> refused by the cap
    assert.strictEqual(X.holidayWorkTooLong('18:00', '02:00'), false, side);
    assert.strictEqual(X.holidayWorkTooLong('05:30', '04:00'), true, side);
    assert.strictEqual(X.holidayWorkTooLong('06:00', '02:00'), false, side); // exactly 20 h
    assert.strictEqual(X.holidayWorkTooLong('06:00', '02:01'), true, side);
    assert.strictEqual(X.holidayWorkTooLong('04:00', '03:00'), false, side); // already invalid, not "too long"
  }
  assert.strictEqual((SERVER_SRC.match(/if \(holidayWorkTooLong\(/g) || []).length, 2, 'server POST + PUT refuse');
  assert.ok(/if \(holidayWorkTooLong\(workStartTime, workEndTime\)\)/.test(APP_SRC), 'client submitHolidayWork refuses');
});

// 2026-09-24 (review fix 2): a Late Night check-out after midnight is the x2 tier, not x1.
test('lateNightPoints both sides: before 05:00 = after midnight', () => {
  for (const [side, X] of both(world())) {
    assert.strictEqual(X.lateNightPoints('19:30', 20), 1, side);
    assert.strictEqual(X.lateNightPoints('20:00', 20), 2, side);
    assert.strictEqual(X.lateNightPoints('23:59', 20), 2, side);
    assert.strictEqual(X.lateNightPoints('00:00', 20), 2, side);
    assert.strictEqual(X.lateNightPoints('01:30', 20), 2, side);
    assert.strictEqual(X.lateNightPoints('04:59', 20), 2, side);
    assert.strictEqual(X.lateNightPoints('01:30', 26), 1, side); // x2 from 02:00 (26 h)
  }
  assert.ok(!/parseInt\(\s*(d|row)\.lateOut/.test(APP_SRC), 'no parseInt(lateOut) tier decision left in app.js');
  assert.ok(!/parseInt\(\s*d\.lateOut/.test(SERVER_SRC), 'none left in server.js');
});
test('computePayroll: device check-out at 01:30 pays Late Night x2 on both engines', () => {
  const pDays = [{ date: '2026-11-26', status: 'present', checkIn: '08:20', checkOut: '01:30', checkInSource: 'device',
    checkOutSource: 'device', lateOut: '01:30', lateApproved: true }];
  const w = world({ pDays });
  const start = new Date('2026-11-21T12:00:00'), end = new Date('2026-12-20T12:00:00');
  const c = makeClient(w).computePayroll(w.user, start, end, 1);
  const s = makeServer(w).computePayroll(w.user, start, end, 1);
  for (const [side, r] of [['client', c], ['server', s]]) {
    assert.strictEqual(r.lateNightCount, 2, `${side} lateNightCount`);
    assert.strictEqual(r.allowance2, 200, `${side} Late Night x2 money`);
  }
});

console.log('T1 Company Trip: no allowance of any kind');
test('companyTripDateInRange both sides', () => {
  for (const [side, X] of both(world())) {
    assert.strictEqual(X.companyTripDateInRange('2026-11-20', '2026-11-30'), '2026-11-27', side);
    assert.strictEqual(X.companyTripDateInRange('2026-11-28', '2026-11-28'), '2026-11-28', side);
    assert.strictEqual(X.companyTripDateInRange('2026-11-29', '2026-12-05'), null, side);
    assert.strictEqual(X.companyTripDateInRange('2026-11-28'), '2026-11-28', side);
  }
});
test('server refuses abroad ranges, holiday work and early morning on a trip day', () => {
  const S = makeServer(world());
  assert.strictEqual(S.isCompanyTripClaimBlocked('abroad', '2026-11-25', null, '2026-11-30'), true);
  assert.strictEqual(S.isCompanyTripClaimBlocked('abroad', '2026-11-29', null, '2026-12-02'), false);
  assert.strictEqual(S.isCompanyTripClaimBlocked('holiday-work', '2026-11-28'), true);
  assert.strictEqual(S.isCompanyTripClaimBlocked('early-morning', '2026-11-27'), true);
  assert.strictEqual(S.isCompanyTripClaimBlocked('annual', '2026-11-27'), false);
  assert.ok(/Abroad/.test(S.companyTripNoClaimMessage('abroad')));
});
test('client Holiday Work gate says company-trip on a trip Saturday', () => {
  const w = world({ att: { '2026-11-28': { checkIn: '09:00', checkOut: '17:00' } } });
  assert.strictEqual(makeClient(w).canSubmitHolidayWorkForDate('2026-11-28', 1).reason, 'company-trip');
});
test('annual-leave credit: holiday work on a later-declared trip day earns nothing', () => {
  const hwAL = (id, date) => ({ id, userId: 1, type: 'holiday-work', compensationMode: 'annual-leave', status: 'approved', dateFrom: date, days: 1 });
  const w = world({ leaves: [hwAL(1, '2026-11-28'), hwAL(2, '2026-11-29')] });
  assert.strictEqual(makeClient(w).getApprovedHolidayWorkDays(2026, 1), 1);
  assert.strictEqual(makeServer(w).getApprovedHolidayWorkAnnualLeaveDays(w.leaves, 1, 2026), 1);
});

// One pay period touching the trip days. Only the non-trip claims may pay.
function payrollWorld() {
  const day = (date, extra) => ({ date, status: 'present', checkIn: '08:20', checkOut: '17:40', checkInSource: 'web', checkOutSource: 'web', ...extra });
  const pDays = [
    day('2026-11-26'),
    day('2026-11-27', { status: 'company-trip', checkIn: '06:00', checkInSource: 'device' }),
    day('2026-11-28', { status: 'company-trip', isWeekend: true }),
    day('2026-11-29', { status: 'weekend', isWeekend: true }),
  ];
  const L = (id, o) => ({ id, userId: 1, status: 'approved', dateTo: o.dateFrom, ...o });
  const leaves = [
    L(1, { type: 'early-morning', dateFrom: '2026-11-26', earlyMorningTier: 1 }),
    L(2, { type: 'early-morning', dateFrom: '2026-11-27', earlyMorningTier: 2 }), // approved, then trip declared
    L(3, { type: 'ot', dateFrom: '2026-11-26', otHours: 2, otMultiplier: 1.5 }),
    L(4, { type: 'ot', dateFrom: '2026-11-27', otHours: 3, otMultiplier: 1.5 }),
    L(5, { type: 'holiday-work', compensationMode: 'paid', dateFrom: '2026-11-28', otHours20: 8, otHours30: 0 }),
    L(6, { type: 'holiday-work', compensationMode: 'paid', dateFrom: '2026-11-29', otHours20: 2, otHours30: 1 }),
    L(7, { type: 'personal-car', dateFrom: '2026-11-27', personalCarRate: 1000 }),
  ];
  return world({ leaves, pDays, user: { ...USER, personalCarEligible: true } });
}
test('computePayroll: trip-day early morning / OT / HW / personal car pay nothing, both engines agree', () => {
  const w = payrollWorld();
  const start = new Date('2026-11-21T12:00:00'), end = new Date('2026-12-20T12:00:00');
  const c = makeClient(w).computePayroll(w.user, start, end, 1);
  const s = makeServer(w).computePayroll(w.user, start, end, 1);
  const hourly = 24000 / 30 / 8; // 100
  for (const [side, r] of [['client', c], ['server', s]]) {
    assert.strictEqual(r.earlyCount, 1, `${side} earlyCount`);
    assert.strictEqual(r.allowance2, 240, `${side} early money`);
    assert.strictEqual(r.otTotalHours, 2 + 3, `${side} OT hours (office 2 + HW 3)`);
    assert.strictEqual(r.otAmount, Math.round(hourly * 1.5 * 2) + Math.round(hourly * 2 * 2) + Math.round(hourly * 3 * 1), `${side} OT amount`);
    assert.strictEqual(r.holidayTransportTotal, 500, `${side} transport (one HW day)`);
    assert.strictEqual(r.personalCarTotal, 0, `${side} personal car`);
  }
  assert.strictEqual(c.grossIncome, s.grossIncome);
  assert.strictEqual(c.holidayWorkOtCount, 1, 'client HW OT count for the payslip OT tile');
});

console.log('T3 Holiday Work OT record filter');
test('isHolidayWorkOtRecord both sides', () => {
  for (const [side, X] of both(world())) {
    const hw = o => ({ type: 'holiday-work', status: 'approved', compensationMode: 'paid', otHours20: 1, ...o });
    assert.strictEqual(X.isHolidayWorkOtRecord(hw()), true, side);
    assert.strictEqual(X.isHolidayWorkOtRecord(hw({ compensationMode: 'annual-leave', otHours20: 0 })), false, side);
    assert.strictEqual(X.isHolidayWorkOtRecord(hw({ status: 'pending-md' })), false, side);
    assert.strictEqual(X.isHolidayWorkOtRecord(hw({ otHours20: 0, otHours30: 0 })), false, side);
  }
});

console.log('T4b money rounding (owner 2026-09-24): OT/tax 2 dp half-up, PVD 1 dp half-up, SSO whole baht');
test('round1HalfUp both sides', () => {
  for (const [side, X] of both(world())) {
    assert.strictEqual(X.round1HalfUp(123.45), 123.5, side);
    assert.strictEqual(X.round1HalfUp(123.44), 123.4, side);
    assert.strictEqual(X.round1HalfUp(0.05), 0.1, side);
    assert.strictEqual(X.round1HalfUp(1234.55), 1234.6, side);
    assert.strictEqual(X.round1HalfUp(1200), 1200, side);
    assert.strictEqual(X.round2HalfUp(1.005), 1.01, side);
    assert.strictEqual(X.round2HalfUp(2.675), 2.68, side);
  }
});
// 2026-09-24 (owner, round 7): OT is paid from the TOTAL hours per multiplier, rounded once.
test('OT pay: hours summed per multiplier, each bucket rounded once (both sides)', () => {
  const hourly = 24123 / 30 / 8; // 100.5125
  for (const [side, X] of both(world())) {
    const b = {};
    // Three 0.33 h x1.5 records: per record 49.7536875 -> 49.75 each = 149.25 (old rule);
    // total 0.99 h -> 149.2610625 -> 149.26 (owner rule). The two rules differ by 0.01.
    X.accumulateApprovedOtHours({ otHours: 0.33, otMultiplier: 1.5 }, b);
    X.accumulateApprovedOtHours({ otHours: 0.33, otMultiplier: 1.5 }, b);
    X.accumulateApprovedOtHours({ otHours: 0.33, otMultiplier: 1.5 }, b);
    X.accumulateApprovedOtHours({ otHours20: 1, otHours30: 0.5 }, b); // 201.025 -> 201.03 ; 150.76875 -> 150.77
    assert.deepStrictEqual({ ...b }, { '1.5': 0.99, 2: 1, 3: 0.5 }, `${side} buckets`);
    const r = X.otPayFromHourBuckets(b, hourly);
    assert.strictEqual(r.ot15Amount, 149.26, `${side} x1.5 rounded once (per record would be 149.25)`);
    assert.strictEqual(r.ot15Hours, 0.99, `${side} x1.5 hours`);
    assert.strictEqual(r.ot20Amount, 201.03, `${side} x2`);
    assert.strictEqual(r.ot30Amount, 150.77, `${side} x3`);
    assert.strictEqual(r.otAmount, 501.06, `${side} total = sum of bucket amounts (per record: 501.05)`);
    assert.strictEqual(r.otTotalHours, 2.49, `${side} total hours`);
    const n = {};
    X.accumulateApprovedOtHours({ otHours: 0.1, otMultiplier: 1.5 }, n);
    X.accumulateApprovedOtHours({ otHours: 0.2, otMultiplier: 1.5 }, n);
    assert.strictEqual(n['1.5'], 0.3, `${side} 0.1 + 0.2 h has no float noise`);
    const z = {};
    X.accumulateApprovedOtHours({ otHours: 0, otMultiplier: 1.5 }, z);
    X.accumulateApprovedOtHours({ otHours: -2, otMultiplier: 1.5 }, z);
    assert.deepStrictEqual({ ...z }, {}, `${side} zero/negative hours create no bucket`);
  }
  const C = makeClient(world());
  assert.strictEqual(C.otPayAmountFromLeave({ otHours: 1, otMultiplier: 1.5 }, hourly), 150.77, 'on-screen estimate');
  assert.strictEqual(C.otPayAmountFromLeave({ otHours20: 1, otHours30: 0.5 }, hourly), 351.8, 'on-screen estimate HW');
});
test('computePayroll: PVD 1 dp, driver guaranteed-OT top-up 2 dp, gross parity', () => {
  const driver = { id: 1, role: 'driver', salary: 24691, pvdRate: 5, guaranteedOT: 10 };
  const w = world({ user: driver, leaves: [
    { id: 1, userId: 1, type: 'ot', isDriverOT: true, status: 'approved', dateFrom: '2026-11-24', dateTo: '2026-11-24', otHours: 1.33, otMultiplier: 1.5 },
  ], pDays: [{ date: '2026-11-24', status: 'present', checkIn: '08:00', checkOut: '19:00' }] });
  const start = new Date('2026-11-21T12:00:00'), end = new Date('2026-12-20T12:00:00');
  const hourly = 24691 / 30 / 8; // 102.879166...
  // 2026-09-24 (round 7): the guaranteed floor lifts the x1.5 bucket to 10 h, paid once.
  const expOt = hourly * 1.5 * 10;
  const out = [];
  for (const [side, X] of both(w)) {
    const r = X.computePayroll(driver, start, end, 1);
    assert.strictEqual(r.pvd, 1234.6, `${side} PVD 1234.55 -> 1234.6`);
    assert.strictEqual(r.ssf, 875, `${side} SSO unchanged (whole baht, capped)`);
    assert.strictEqual(r.ot15Amount, Math.round(expOt * 100) / 100, `${side} OT + top-up`);
    assert.strictEqual(r.grossIncome, Math.round(r.grossIncome * 100) / 100, `${side} gross has no float noise`);
    out.push(r);
  }
  assert.strictEqual(out[0].grossIncome, out[1].grossIncome);
  assert.strictEqual(out[0].autoPit, out[1].autoPit);
});
test('calcAnnualTax: 2 dp half-up both sides', () => {
  const brackets = [{ upTo: 150000, rate: 0 }, { upTo: 300000, rate: 5 }, { upTo: Infinity, rate: 10 }];
  const S = { ...SETTINGS, tax: { ...SETTINGS.tax, brackets } };
  const cCtx = { APP_SETTINGS: S }; vm.createContext(cCtx);
  vm.runInContext(extractFunction(APP_SRC, 'round2HalfUp') + '\n' + extractFunction(APP_SRC, 'calcAnnualTax'), cCtx);
  const sCtx = { getAppSettings: () => S }; vm.createContext(sCtx);
  vm.runInContext(extractFunction(SERVER_SRC, 'round2HalfUp') + '\n' + extractFunction(SERVER_SRC, 'calcAnnualTax'), sCtx);
  for (const [side, X] of [['client', cCtx], ['server', sCtx]]) {
    assert.strictEqual(X.calcAnnualTax(162345.67), 617.28, side);   // 12345.67 x 5% = 617.2835
    assert.strictEqual(X.calcAnnualTax(150100.1), 5.01, side);      // 100.1 x 5% = 5.005 -> 5.01
    assert.strictEqual(X.calcAnnualTax(310000.05), 8500.01, side);  // 7500 + 10000.05 x 10% = 8500.005
    assert.strictEqual(X.calcAnnualTax(100000), 0, side);
  }
  assert.ok(/const autoPit = round2HalfUp\(calcAnnualTax\(annualTaxable\) \/ 12\);/.test(APP_SRC));
  assert.ok(/const autoPit = round2HalfUp\(calcAnnualTax\(annualTaxable\) \/ 12\);/.test(SERVER_SRC));
});
test('50 Tawi: no whole-baht rounding left (xlsx cells, server totals, client page)', () => {
  const X = fs.readFileSync(path.join(ROOT, 'attendance-server/backend/tawi50Xlsx.js'), 'utf8');
  assert.ok(!/Math\.round\(amounts\./.test(X), 'tawi50Xlsx.js still rounds to whole baht');
  ['grossIncome', 'pit', 'pvd', 'sso'].forEach(k => assert.ok(X.includes(`money2(amounts.${k})`), k));
  assert.ok(/d\.totalGross = round2HalfUp\(d\.totalGross\)/.test(SERVER_SRC));
  assert.ok(/d\.totalGross = round2HalfUp\(d\.totalGross\)/.test(APP_SRC));
  assert.ok(!/TAWI50_OVERRIDES\[key\]\[field\] = parseInt/.test(APP_SRC), 'override input truncates satang');
  assert.ok(/round2HalfUp\(x\) === x/.test(SERVER_SRC), 'server accepts 2 dp overrides');
});

console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ', 0 failed'}`);
