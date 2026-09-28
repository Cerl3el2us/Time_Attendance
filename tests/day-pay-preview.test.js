// In-form pay preview (2026-09-28): "ใส่ชั่วโมงแล้วให้บอกว่าจะได้เงินเท่าไหร่" for the OT and Holiday
// Work forms, so an employee choosing money vs an extra leave day can see both outcomes.
//
// What these tests are really protecting:
//   1. the preview owns NO money rule of its own -- it composes payroll's own functions, so the two
//      extracted helpers (hasUpcountryLocation, holidayTransportForRecord) must keep working for
//      both callers;
//   2. OT is the MARGINAL amount across the period's multiplier buckets, because payroll rounds each
//      bucket once for the whole period -- a per-record figure could never match the payslip;
//   3. a driver already above their guaranteed-OT floor previews +฿0, which is the truth and the
//      whole point of a decision aid.
//
// Everything is extracted from attendance/js/app.js and run in a sandbox: behavioural assertions,
// not greps. `node tests/day-pay-preview.test.js`
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const APP_SRC = fs.readFileSync(path.join(ROOT, 'attendance/js/app.js'), 'utf8');

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

const FNS = [
  'round2HalfUp', 'isVoidLeaveStatus', 'parseHHMMToMins', 'lateNightCheckoutMins', 'lateNightThresholdHourOf',
  'lateNightThresholdMins', 'lateOutAllowanceForHour', 'isDeviceScanSource',
  'isEarlyMorningDayStatus', 'isRestAttendanceDay', 'deviceScanQualifiesForEarlyMorning',
  'earlyMorningThresholdMins', 'earlyMorningAllowanceForTier', 'earlyMorningTierFromCheckIn',
  'effectiveOtMultiplier', 'standardOtMultiplier', 'isNonWorkDayForComp', 'deriveOfficeOtFromEndTime',
  'holidayWorkEndMins', 'splitHolidayWorkOtMinutes', 'addOtHours', 'accumulateApprovedOtHours',
  'otPayFromHourBuckets', 'isAllowanceEligible', 'localDateStr',
  // the extraction that removed the last inline money rules from computePayroll
  'hasUpcountryLocation', 'holidayTransportForRecord',
  // the preview itself
  'periodBoundsForDate', 'existingOtBuckets', 'applyGuaranteedOtFloor', 'estimateDayEarnings',
];

const EVERY_ROLE = ['md', 'manager', 'accounting', 'user', 'marketing', 'driver'];
const SETTINGS = () => ({
  allowances: {
    earlyMorning1: 240, earlyMorning2: 480, earlyThreshold1Min: 450, earlyThreshold2Min: 390,
    lateNight1: 240, lateNight2: 480, lateNightThreshold1Hour: 19, lateNightThreshold2Hour: 20,
    upcountry: 240, holidayTransport: 500,
  },
  workSchedule: { standardStartHour: 8, standardStartMinute: 30 },
  payroll: { periodStartDay: 21 },
  // Spelled out so the DEFAULT_ALLOWANCE_ELIGIBILITY fallback never silently decides a test.
  allowanceEligibility: { ot: EVERY_ROLE, earlyLate: EVERY_ROLE, upcountry: EVERY_ROLE },
});

// A sandbox per test. generatePeriodDays is stubbed to one row -- the preview only ever reads that
// day's scan out of it, and the row shape is the contract between them.
function makeWorld(opts = {}) {
  const sandbox = {
    APP_SETTINGS: opts.settings || SETTINGS(),
    DATA_LEAVES: opts.leaves || [],
    HHMM_RE: /^([01]\d|2[0-3]):[0-5]\d$/,
    currentLang: 'en',
    L: (en) => en,
    isPublicHoliday: () => !!opts.publicHoliday,
    isCompanyTripDay: () => !!opts.companyTrip,
    isApprovedAbroadDate: () => !!opts.abroad,
    generatePeriodDays: () => [opts.row || { date: opts.date, status: 'absent' }],
    DEFAULT_ALLOWANCE_ELIGIBILITY: { ot: EVERY_ROLE, earlyLate: EVERY_ROLE, upcountry: EVERY_ROLE },
    Number, Math, JSON, Object, Array, String, Set, Date, isNaN, parseInt, parseFloat, Boolean,
    console: { log() {}, error() {} },
  };
  vm.createContext(sandbox);
  vm.runInContext(FNS.map(n => extractFunction(APP_SRC, n)).join('\n'), sandbox);
  return sandbox;
}

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok ', name); }
  catch (e) { process.exitCode = 1; console.log('  FAIL', name, '\n      ', e.message); }
}
// 24,000 / 30 / 8 = 100 baht an hour, so every expected figure below is readable by eye.
const STAFF = { id: 1, role: 'user', salary: 24000 };
const DRIVER = (over = {}) => ({ id: 2, role: 'driver', salary: 24000, ...over });
const amountOf = (est, key) => {
  const l = est.lines.find(x => x.key === key);
  return l ? l.amount : null;
};

console.log('T1 office OT — the marginal amount, not a per-record one');

test('2h x1.5 at 100/h previews 300 from an empty period', () => {
  const W = makeWorld({ date: '2026-09-28' });
  const est = W.estimateDayEarnings({ date: '2026-09-28', user: STAFF, otEndTime: '19:30' });
  assert.strictEqual(amountOf(est, 'ot'), 300);
  assert.strictEqual(est.total, 300);
  assert.strictEqual(est.salaryKnown, true);
});

test('with 1h already approved in the period, 2h more is still worth exactly 300', () => {
  // The bucket total goes 1h -> 3h; the DIFFERENCE is what this request adds.
  const W = makeWorld({
    date: '2026-09-28',
    leaves: [{ id: 9, userId: 1, type: 'ot', status: 'approved', dateFrom: '2026-09-25', otHours: 1, otMultiplier: 1.5 }],
  });
  const est = W.estimateDayEarnings({ date: '2026-09-28', user: STAFF, otEndTime: '19:30' });
  assert.strictEqual(amountOf(est, 'ot'), 300);
});

test('an approved record in a DIFFERENT period does not change the marginal figure', () => {
  const W = makeWorld({
    date: '2026-09-28',
    leaves: [{ id: 9, userId: 1, type: 'ot', status: 'approved', dateFrom: '2026-08-15', otHours: 5, otMultiplier: 1.5 }],
  });
  assert.strictEqual(
    amountOf(W.estimateDayEarnings({ date: '2026-09-28', user: STAFF, otEndTime: '19:30' }), 'ot'), 300);
});

test('editing an existing record counts only the change, not the whole record again', () => {
  const rec = { id: 42, userId: 1, type: 'ot', status: 'approved', dateFrom: '2026-09-28', otHours: 2, otMultiplier: 1.5 };
  const W = makeWorld({ date: '2026-09-28', leaves: [rec] });
  const withoutExclude = W.estimateDayEarnings({ date: '2026-09-28', user: STAFF, otEndTime: '19:30' });
  const withExclude = W.estimateDayEarnings({ date: '2026-09-28', user: STAFF, otEndTime: '19:30', excludeLeaveId: 42 });
  assert.strictEqual(amountOf(withExclude, 'ot'), 300, 'the edited record must be taken out of the baseline');
  assert.strictEqual(amountOf(withoutExclude, 'ot'), 300, 'a pure addition is worth the same here');
});

test('a role with no OT eligibility gets no OT line at all', () => {
  const s = SETTINGS();
  s.allowanceEligibility.ot = ['driver'];
  const W = makeWorld({ date: '2026-09-28', settings: s });
  const est = W.estimateDayEarnings({ date: '2026-09-28', user: STAFF, otEndTime: '19:30' });
  assert.strictEqual(amountOf(est, 'ot'), null);
});

test('no salary on file: hours still preview, money is marked unknown', () => {
  const W = makeWorld({ date: '2026-09-28' });
  const est = W.estimateDayEarnings({ date: '2026-09-28', user: { id: 3, role: 'user', salary: 0 }, otEndTime: '19:30' });
  assert.strictEqual(est.salaryKnown, false);
  assert.strictEqual(amountOf(est, 'ot'), 0);
});

console.log('T2 driver OT — the guaranteed-OT floor tells the truth');

test('a driver under the floor sees the real gain', () => {
  const W = makeWorld({ date: '2026-09-28' });
  const est = W.estimateDayEarnings({ date: '2026-09-28', user: DRIVER(), driverTiers: { 1.5: 2 } });
  assert.strictEqual(amountOf(est, 'ot'), 300);
});

test('a driver whose floor already covers the hours previews +0, with a warning', () => {
  const W = makeWorld({ date: '2026-09-28' });
  const est = W.estimateDayEarnings({
    date: '2026-09-28', user: DRIVER({ guaranteedOT: 30 }), driverTiers: { 1.5: 2 },
  });
  assert.strictEqual(amountOf(est, 'ot'), 0, 'the floor already pays these hours');
  assert.ok(est.warnings.some(w => /guaranteed/i.test(w)), 'the reason must be said out loud');
});

test('hours beyond the floor are worth the part that exceeds it', () => {
  const W = makeWorld({
    date: '2026-09-28',
    leaves: [{ id: 5, userId: 2, type: 'ot', status: 'approved', dateFrom: '2026-09-25', otHours: 29, otMultiplier: 1.5 }],
  });
  // Floor 30h: baseline lifts 29 -> 30. Asking 2h makes 31h, so only 1h is genuinely new.
  const est = W.estimateDayEarnings({
    date: '2026-09-28', user: DRIVER({ guaranteedOT: 30 }), driverTiers: { 1.5: 2 },
  });
  assert.strictEqual(amountOf(est, 'ot'), 150);
});

test('the x2 and x3 tiers are itemised together', () => {
  const W = makeWorld({ date: '2026-09-27' });
  const est = W.estimateDayEarnings({ date: '2026-09-27', user: DRIVER(), driverTiers: { 2: 3, 3: 1 } });
  assert.strictEqual(amountOf(est, 'ot'), 3 * 2 * 100 + 1 * 3 * 100);
  assert.ok(/×2/.test(est.lines[0].label) && /×3/.test(est.lines[0].label), est.lines[0].label);
});

console.log('T3 Holiday Work — the two modes, side by side');

const HW = { date: '2026-09-27', hwStartTime: '08:30', hwEndTime: '17:30' };

test('paid mode pays holiday transport plus x2 hours, lunch excluded', () => {
  const W = makeWorld({ date: HW.date });
  const est = W.estimateDayEarnings({ ...HW, user: STAFF, mode: 'paid' });
  // 08:30-17:30 minus the 12:00-13:00 lunch = 8 paid hours at x2.
  assert.strictEqual(amountOf(est, 'ot'), 1600);
  assert.strictEqual(amountOf(est, 'holiday-transport'), 500);
  assert.strictEqual(est.total, 2100);
  assert.strictEqual(est.earnsLeaveDay, false);
});

test('annual-leave mode pays neither transport nor OT, and earns the day', () => {
  const W = makeWorld({ date: HW.date });
  const est = W.estimateDayEarnings({ ...HW, user: STAFF, mode: 'annual-leave' });
  assert.strictEqual(amountOf(est, 'ot'), null);
  assert.strictEqual(amountOf(est, 'holiday-transport'), null);
  assert.strictEqual(est.total, 0);
  assert.strictEqual(est.earnsLeaveDay, true);
});

test('Upcountry pays in BOTH modes when a location was entered', () => {
  const W = makeWorld({ date: HW.date });
  const locations = [{ name: 'Rayong' }];
  assert.strictEqual(amountOf(W.estimateDayEarnings({ ...HW, user: STAFF, mode: 'paid', locations }), 'upcountry'), 240);
  assert.strictEqual(amountOf(W.estimateDayEarnings({ ...HW, user: STAFF, mode: 'annual-leave', locations }), 'upcountry'), 240);
});

test('a blank location name is not an Upcountry claim', () => {
  const W = makeWorld({ date: HW.date });
  assert.strictEqual(amountOf(W.estimateDayEarnings({ ...HW, user: STAFF, mode: 'paid', locations: [{ name: '   ' }] }), 'upcountry'), null);
});

test('the bundled Late Night tier is itemised', () => {
  const W = makeWorld({ date: HW.date });
  const est = W.estimateDayEarnings({ ...HW, user: STAFF, mode: 'paid', lateOutHour: 20 });
  assert.strictEqual(amountOf(est, 'late-night'), 480);
  assert.strictEqual(amountOf(W.estimateDayEarnings({ ...HW, user: STAFF, mode: 'paid', lateOutHour: 19 }), 'late-night'), 240);
});

test('an approved Abroad day pays neither holiday transport nor Upcountry, and says why', () => {
  const W = makeWorld({ date: HW.date, abroad: true });
  const est = W.estimateDayEarnings({ ...HW, user: STAFF, mode: 'paid', locations: [{ name: 'Osaka' }] });
  assert.strictEqual(amountOf(est, 'holiday-transport'), null);
  assert.strictEqual(amountOf(est, 'upcountry'), null);
  assert.strictEqual(amountOf(est, 'ot'), 1600, 'OT x2/x3 is still paid on an Abroad day');
  assert.ok(est.warnings.length, 'the missing allowances must be explained');
});

test('an OT request already filed for a paid holiday-work day is flagged, not silently dropped', () => {
  // computePayroll ignores a separate office-OT record on a paid Holiday Work day; the employee had
  // no way to know that before choosing the money.
  const W = makeWorld({
    date: HW.date,
    leaves: [{ id: 7, userId: 1, type: 'ot', status: 'approved', dateFrom: HW.date, otHours: 3, otMultiplier: 1.5 }],
  });
  const paid = W.estimateDayEarnings({ ...HW, user: STAFF, mode: 'paid' });
  assert.ok(paid.warnings.some(w => /3/.test(w) && /not counted/i.test(w)), paid.warnings.join(' | '));
  // The leave option does not swallow the OT record, so it must not carry that warning.
  const leave = W.estimateDayEarnings({ ...HW, user: STAFF, mode: 'annual-leave' });
  assert.ok(!leave.warnings.some(w => /not counted/i.test(w)), 'warning must be scoped to the paid mode');
});

test('a driver OT record on the same day is not flagged (it is paid independently)', () => {
  const W = makeWorld({
    date: HW.date,
    leaves: [{ id: 8, userId: 1, type: 'ot', isDriverOT: true, status: 'approved', dateFrom: HW.date, otHours: 3, otMultiplier: 1.5 }],
  });
  const paid = W.estimateDayEarnings({ ...HW, user: STAFF, mode: 'paid' });
  assert.ok(!paid.warnings.some(w => /not counted/i.test(w)), paid.warnings.join(' | '));
});

console.log('T4 Early Morning — read off the real scan, never guessed');

const deviceRow = (checkIn) => ({ date: '2026-09-28', status: 'present', checkIn, checkInSource: 'device' });

test('a qualifying face-scanner check-in pays its tier and names the scan time', () => {
  const W = makeWorld({ date: '2026-09-28', row: deviceRow('06:12') });
  const est = W.estimateDayEarnings({ date: '2026-09-28', user: STAFF, otEndTime: '19:30' });
  assert.strictEqual(amountOf(est, 'early'), 480, 'before 06:30 is the x2 tier');
  assert.ok(/06:12/.test(est.lines.find(l => l.key === 'early').note));
  assert.strictEqual(est.total, 780);
});

test('the x1 tier is used between the two thresholds', () => {
  const W = makeWorld({ date: '2026-09-28', row: deviceRow('07:10') });
  assert.strictEqual(amountOf(W.estimateDayEarnings({ date: '2026-09-28', user: STAFF }), 'early'), 240);
});

test('a web check-in shows 0 and says a face scan is needed, instead of vanishing', () => {
  const W = makeWorld({ date: '2026-09-28', row: { date: '2026-09-28', status: 'present', checkIn: '06:12', checkInSource: 'web' } });
  const est = W.estimateDayEarnings({ date: '2026-09-28', user: STAFF });
  assert.strictEqual(amountOf(est, 'early'), 0);
  assert.ok(/face-scanner/i.test(est.lines.find(l => l.key === 'early').note));
});

test('an ordinary on-time scan earns no early-morning line at all', () => {
  const W = makeWorld({ date: '2026-09-28', row: deviceRow('08:20') });
  assert.strictEqual(amountOf(W.estimateDayEarnings({ date: '2026-09-28', user: STAFF }), 'early'), null);
});

test('a role excluded from earlyLate never sees the line', () => {
  const s = SETTINGS();
  s.allowanceEligibility.earlyLate = ['user'];
  const W = makeWorld({ date: '2026-09-28', settings: s, row: deviceRow('06:12') });
  assert.strictEqual(amountOf(W.estimateDayEarnings({ date: '2026-09-28', user: DRIVER() }), 'early'), null);
});

console.log('T5 the period the marginal figure is measured over');

test('periodBoundsForDate splits on the configured start day', () => {
  const W = makeWorld({ date: '2026-09-28' });
  assert.deepStrictEqual({ ...W.periodBoundsForDate('2026-09-28') }, { start: '2026-09-21', end: '2026-10-20' });
  assert.deepStrictEqual({ ...W.periodBoundsForDate('2026-09-20') }, { start: '2026-08-21', end: '2026-09-20' });
  assert.deepStrictEqual({ ...W.periodBoundsForDate('2026-09-21') }, { start: '2026-09-21', end: '2026-10-20' });
});

test('a paid Holiday Work day owns its own OT: a separate OT record on it is not double-counted', () => {
  // Mirrors computePayroll's own skip.
  const W = makeWorld({
    date: '2026-09-28',
    leaves: [
      { id: 1, userId: 1, type: 'holiday-work', status: 'approved', compensationMode: 'paid', dateFrom: '2026-09-27', otHours20: 8 },
      { id: 2, userId: 1, type: 'ot', status: 'approved', dateFrom: '2026-09-27', otHours: 8, otMultiplier: 1.5 },
    ],
  });
  const buckets = { ...W.existingOtBuckets(1, '2026-09-28', null) };
  assert.strictEqual(buckets['2'], 8);
  assert.strictEqual(buckets['1.5'], undefined, 'the office OT record on a paid holiday-work day must be skipped');
});

test('only approved records of THIS employee form the baseline', () => {
  const W = makeWorld({
    date: '2026-09-28',
    leaves: [
      { id: 1, userId: 1, type: 'ot', status: 'pending-md', dateFrom: '2026-09-25', otHours: 4, otMultiplier: 1.5 },
      { id: 2, userId: 2, type: 'ot', status: 'approved', dateFrom: '2026-09-25', otHours: 4, otMultiplier: 1.5 },
      { id: 3, userId: 1, type: 'ot', status: 'cancelled', dateFrom: '2026-09-25', otHours: 4, otMultiplier: 1.5 },
    ],
  });
  assert.deepStrictEqual({ ...W.existingOtBuckets(1, '2026-09-28', null) }, {});
});

console.log('T6 the rules extracted out of computePayroll still hold for both callers');

test('holidayTransportForRecord: paid mode only, never on an Abroad day, a deliberate 0 stays 0', () => {
  const W = makeWorld({ date: '2026-09-27' });
  const S = SETTINGS();
  const rec = { compensationMode: 'paid', dateFrom: '2026-09-27' };
  assert.strictEqual(W.holidayTransportForRecord(rec, S, new Set()), 500);
  assert.strictEqual(W.holidayTransportForRecord({ ...rec, compensationMode: 'annual-leave' }, S, new Set()), 0);
  assert.strictEqual(W.holidayTransportForRecord(rec, S, new Set(['2026-09-27'])), 0);
  const zero = SETTINGS(); zero.allowances.holidayTransport = 0;
  assert.strictEqual(W.holidayTransportForRecord(rec, zero, new Set()), 0, 'a rate set to 0 must not fall back to 500');
  const absent = SETTINGS(); delete absent.allowances.holidayTransport;
  assert.strictEqual(W.holidayTransportForRecord(rec, absent, new Set()), 500, 'a missing rate falls back');
});

test('hasUpcountryLocation needs a real name', () => {
  const W = makeWorld({ date: '2026-09-27' });
  assert.strictEqual(W.hasUpcountryLocation({ locations: [{ name: 'Rayong' }] }), true);
  assert.strictEqual(W.hasUpcountryLocation({ locations: [{ name: '' }, { name: '  ' }] }), false);
  assert.strictEqual(W.hasUpcountryLocation({ locations: [] }), false);
  assert.strictEqual(W.hasUpcountryLocation({}), false);
  assert.strictEqual(W.hasUpcountryLocation(null), false);
});

console.log(`\n${passed} passed`);
