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

const SHARED = ['round2HalfUp', 'deriveOfficeOtFromEndTime', 'lateNightCheckoutMins', 'parseHHMMToMins',
  'isHolidayWorkDay', 'isNonWorkDayForComp', 'isHolidayWorkOtRecord', 'companyTripDateInRange',
  'isFullDayPersonalLeaveStatus', 'isRestAttendanceDay', 'isDeviceScanSource', 'isEarlyMorningDayStatus',
  'deviceScanQualifiesForEarlyMorning', 'deviceScanQualifiesForLateNight', 'lateNightCheckoutOk',
  'accumulateApprovedOtPay', 'effectiveOtMultiplier', 'computePayroll', 'splitHolidayWorkOtMinutes'];
const CLIENT_FNS = [...SHARED, 'scanWindowError', 'getApprovedHolidayWorkDays', 'abroadTravelCreditDays',
  'otEndCrossesMidnight', 'canSubmitHolidayWorkForDate', 'standardOtMultiplier'];
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
test('duration: end before 05:00 is after midnight of the same work day', () => {
  for (const [side, X] of both(world())) {
    const d = (date, t) => X.deriveOfficeOtFromEndTime(date, t, SETTINGS).otHours;
    assert.strictEqual(d(THU, '20:30'), 3, side);
    assert.strictEqual(d(THU, '00:00'), 6.5, side);
    assert.strictEqual(d(THU, '01:00'), 7.5, side);
    assert.strictEqual(d(THU, '04:59'), 11.48, side);
    assert.strictEqual(d(THU, '05:00'), 0, side);   // morning time -> not OT
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
test('Holiday Work split is unchanged (end must still be after start)', () => {
  for (const [side, X] of both(world())) {
    assert.strictEqual(X.splitHolidayWorkOtMinutes('20:00', '01:00', SETTINGS).otHours30, 0, side);
    assert.strictEqual(X.splitHolidayWorkOtMinutes('08:30', '17:30', SETTINGS).otHours20, 8, side);
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

console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ', 0 failed'}`);
