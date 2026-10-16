// The Details popup's Early Morning badge must say exactly what the payslip pays (2026-10-16).
//
// The popup gained an "Early Morning (requested)" badge earlier today so that a day paid through
// an approved request stops looking unpaid. It asks two of the questions payroll asks -- is the
// role eligible, and did the automatic scanner path already pay this day -- but not the other
// three. computePayroll() refuses to pay an approved request when the day is full-day personal
// leave, when the day is an approved Abroad day, and when the day is a rest day with no approved
// Holiday Work claim. The popup asked none of those, so it showed "+฿555" on days the payslip
// pays nothing for -- the same class of mismatch the owner reported this morning, in the opposite
// direction (money shown that never arrives, instead of money hidden that does).
//
// The fix is a single predicate, earlyMorningRequestPaidTier(), that answers "which tier does the
// payslip actually pay for this approved request on this day" -- 0 for nothing. The popup asks it
// instead of restating the rules. This file is what stops the two drifting again: every case below
// runs the REAL computePayroll() out of both engines and the REAL predicate out of app.js over the
// same world, and requires them to agree about whether money is paid and how much.
//
// Same sandbox approach as tests/payroll-rules.test.js: functions are extracted from the real
// sources, so the assertions can never ride on a hand-copied stale duplicate.
// `node tests/early-morning-badge-matches-payslip.test.js`
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const APP_SRC = fs.readFileSync(path.join(ROOT, 'attendance/js/app.js'), 'utf8');
const SERVER_SRC = fs.readFileSync(path.join(ROOT, 'attendance-server/backend/server.js'), 'utf8');
const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
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
function constLine(src, name) {
  const m = src.match(new RegExp(`^const ${name} = .*$`, 'm'));
  if (!m) throw new Error(`const ${name} not found`);
  return m[0];
}

// Role rates deliberately unlike the central ones, for the same reason payroll-rules.test.js does
// it: a reader that quietly fell back to the company-wide number would still look right otherwise.
const baseSettings = () => ({
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
  allowanceRoleRates: { enabled: true, byRole: { user: { earlyMorning1: 555, earlyMorning2: 666, lateNight1: 777, lateNight2: 888 } } },
});

const SHARED = [
  'earlyLateRateFor', 'isVoidLeaveStatus', 'round2HalfUp', 'round1HalfUp', 'deriveOfficeOtFromEndTime',
  'lateNightCheckoutMins', 'lateNightThresholdMins', 'lateNightThresholdHourOf', 'parseHHMMToMins',
  'isHolidayWorkDay', 'isNonWorkDayForComp', 'isHolidayWorkOtRecord', 'companyTripDateInRange',
  'isFullDayPersonalLeaveStatus', 'isRestAttendanceDay', 'isDeviceScanSource', 'isEarlyMorningDayStatus',
  'deviceScanQualifiesForEarlyMorning', 'earlyMorningAutoPayEnabled', 'earlyMorningCheckInOk',
  'deviceScanQualifiesForLateNight', 'lateNightCheckoutOk', 'addOtHours', 'accumulateApprovedOtHours',
  'otPayFromHourBuckets', 'effectiveOtMultiplier', 'computePayroll', 'splitHolidayWorkOtMinutes',
  'holidayWorkEndMins', 'hasUpcountryLocation', 'holidayTransportForRecord', 'lateNightPoints', 'holidayWorkTooLong'];
// The predicate under test. Listed with the payroll functions on purpose: it is extracted from the
// same file in the same sandbox, so it can only ever be tested against the real thing.
const CLIENT_FNS = [...SHARED, 'earlyMorningRequestPaidTier', 'scanWindowError', 'getApprovedHolidayWorkDays',
  'abroadTravelCreditDays', 'otEndCrossesMidnight', 'loggedInUser', 'isSuperAdmin', 'effectiveRole',
  'gateRoleFor', 'canSubmitHolidayWorkForDate', 'standardOtMultiplier', 'otPayAmountFromLeave'];
const SERVER_FNS = [...SHARED, 'scanWindowError', 'getApprovedHolidayWorkAnnualLeaveDays',
  'abroadTravelCreditDays', 'isCompanyTripClaimBlocked', 'companyTripNoClaimMessage', 'standardOtMultiplier'];

function makeClient(world) {
  const ctx = {
    HHMM_RE, APP_SETTINGS: world.settings, DATA_LEAVES: world.leaves, DATA_COMPANY_TRIP_DATES: [],
    DATA_USERS: [world.user], currentUser: world.user, realUser: world.user, editingLeaveId: null, finalizeData: {},
    isCompanyTripDay: () => false, isPublicHoliday: () => false,
    isAllowanceEligible: () => true, isApprovedAbroadDate: () => false, isAbroadTravelDay: () => false,
    payPeriodBlockedForDate: () => ({ blocked: false }), bangkokDateStr: () => '2026-12-31',
    attendanceTimesForDate: d => ({ checkIn: null, checkOut: null, lastScan: null, ...(world.att[d] || {}) }),
    generatePeriodDays: () => world.pDays, getFinalizeKey: () => 'k', calcAnnualTax: () => 0,
    L: en => en,
  };
  ctx.BUSINESS_DAY_START_MINS = BUSINESS_DAY_START_MINS;
  vm.createContext(ctx);
  vm.runInContext(constLine(APP_SRC, 'EARLY_LATE_RATE_KEYS') + '\n' + CLIENT_FNS.map(n => extractFunction(APP_SRC, n)).join('\n'), ctx);
  return ctx;
}
function makeServer(world) {
  const ctx = {
    HHMM_RE, COMPANY_TRIP_NO_CLAIM_TYPES: null,
    readSettings: () => ({ companyTripDates: [] }), getAppSettings: () => world.settings,
    isCompanyTripDay: () => false, isPublicHoliday: () => false,
    isAllowanceEligible: () => true, bangkokDateStr: () => '2026-12-31',
    attendanceDayForUser: (u, d) => (world.att[d] ? { date: d, status: 'present', ...world.att[d] } : null),
    buildAttendanceLogForUser: () => ({}), readJSON: () => ({}), readLeaves: () => world.leaves,
    readCheckoutReviews: () => ({}), readMorningReviews: () => ({}),
    generatePeriodDays: () => world.pDays, getFinalizeKey: () => 'k', calcAnnualTax: () => 0,
  };
  ctx.BUSINESS_DAY_START_MINS = BUSINESS_DAY_START_MINS;
  vm.createContext(ctx);
  const setLine = SERVER_SRC.match(/^const COMPANY_TRIP_NO_CLAIM_TYPES = .*$/m)[0].replace(/^const /, '');
  vm.runInContext(setLine + '\n' + constLine(SERVER_SRC, 'EARLY_LATE_RATE_KEYS') + '\n' + SERVER_FNS.map(n => extractFunction(SERVER_SRC, n)).join('\n'), ctx);
  return ctx;
}

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok  ${name}`); }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; }
}

const USER = { id: 1, role: 'user', salary: 24000 };
const PERIOD = [new Date('2026-11-21T12:00:00'), new Date('2026-12-20T12:00:00')];
const THU = '2026-11-26';   // an ordinary working day
const SUN = '2026-11-29';   // a rest day
const day = (date, extra) => ({ date, status: 'present', checkIn: '08:20', checkOut: '17:40', checkInSource: 'web', checkOutSource: 'web', ...extra });
const leave = (id, o) => ({ id, userId: 1, status: 'approved', dateTo: o.dateFrom, ...o });

// What the payslip pays in early/late money for this world. No other allowance is present in any
// world below, so allowance2 IS the Early Morning money -- asserted against both engines, since a
// server that drifted would otherwise be invisible here.
function payslipEarlyMoney(world) {
  const c = makeClient(world).computePayroll(world.user, PERIOD[0], PERIOD[1], 1);
  const s = makeServer(world).computePayroll(world.user, PERIOD[0], PERIOD[1], 1);
  assert.strictEqual(c.allowance2, s.allowance2,
    `the two payroll engines disagree: app.js=${c.allowance2} server.js=${s.allowance2}`);
  return c.allowance2;
}
// What the popup would show for that day's approved Early Morning request, in baht.
function popupEarlyMoney(world, date) {
  const X = makeClient(world);
  const d = world.pDays.find(p => p.date === date);
  const rec = world.leaves.find(l => l.type === 'early-morning' && l.dateFrom === date);
  const hwDates = new Set(world.leaves.filter(l => l.type === 'holiday-work' && l.status === 'approved').map(l => l.dateFrom));
  const tier = X.earlyMorningRequestPaidTier(rec, d, hwDates);
  if (!tier) return 0;
  return X.earlyLateRateFor(world.user.role, tier === 2 ? 'earlyMorning2' : 'earlyMorning1', world.settings);
}
// The point of the file: the badge and the payslip must answer with the same number.
function agree(label, world, date, expected) {
  const paid = payslipEarlyMoney(world);
  const shown = popupEarlyMoney(world, date);
  assert.strictEqual(paid, expected, `${label}: the payslip paid ${paid}, expected ${expected}`);
  assert.strictEqual(shown, paid,
    `${label}: the Details popup shows ฿${shown} but the payslip pays ฿${paid}`);
}

console.log('The Details badge and the payslip answer with one number');

test('auto payment OFF + a scanner check-in: the request is what pays, and the badge shows it', () => {
  const settings = baseSettings();
  settings.allowances.earlyMorningAutoEnabled = false;
  agree('scanner day with the switch off', {
    user: USER, settings, att: {},
    pDays: [day(THU, { checkIn: '06:00', checkInSource: 'device' })],
    leaves: [leave(1, { type: 'early-morning', dateFrom: THU, earlyMorningTier: 1 })],
  }, THU, 555);
});

test('auto payment ON: the scanner pays, so the requested badge must stay quiet (no double count)', () => {
  // The one case agree() cannot express: the money is real, but the popup shows it through the
  // automatic "Early In" chip, which is a different badge with its own condition. What matters
  // here is that the REQUESTED badge adds nothing on top, or the popup would read as double pay.
  const world = {
    user: USER, settings: baseSettings(), att: {},
    pDays: [day(THU, { checkIn: '06:00', checkInSource: 'device' })],
    leaves: [leave(1, { type: 'early-morning', dateFrom: THU, earlyMorningTier: 1 })],
  };
  assert.strictEqual(payslipEarlyMoney(world), 666, 'the scan path pays tier 2 for a 06:00 scan');
  assert.strictEqual(popupEarlyMoney(world, THU), 0,
    'the requested badge must not add a second amount on a day the scanner already paid');
});

test('a full day of annual leave pays nothing for the request, so the badge must not promise it', () => {
  agree('full-day leave', {
    user: USER, settings: baseSettings(), att: {},
    pDays: [day(THU, { status: 'leave-annual' })],
    leaves: [leave(1, { type: 'early-morning', dateFrom: THU, earlyMorningTier: 1 })],
  }, THU, 0);
});

test('an approved Abroad day pays nothing for the request -- the Abroad allowance covers the day', () => {
  agree('abroad day', {
    user: USER, settings: baseSettings(), att: {},
    pDays: [day(THU, { status: 'abroad' })],
    leaves: [leave(1, { type: 'early-morning', dateFrom: THU, earlyMorningTier: 1 })],
  }, THU, 0);
});

test('a rest day with no approved Holiday Work pays nothing for the request', () => {
  agree('Sunday without a Holiday Work claim', {
    user: USER, settings: baseSettings(), att: {},
    pDays: [day(SUN, { status: 'weekend', isWeekend: true })],
    leaves: [leave(1, { type: 'early-morning', dateFrom: SUN, earlyMorningTier: 1 })],
  }, SUN, 0);
});

test('the same rest day WITH an approved Holiday Work claim does pay, and the badge says so', () => {
  agree('Sunday with a Holiday Work claim', {
    user: USER, settings: baseSettings(), att: {},
    pDays: [day(SUN, { status: 'weekend', isWeekend: true })],
    leaves: [
      leave(1, { type: 'early-morning', dateFrom: SUN, earlyMorningTier: 1 }),
      leave(2, { type: 'holiday-work', dateFrom: SUN, compensationMode: 'paid', otHours20: 0, otHours30: 0 }),
    ],
  }, SUN, 555);
});

test('a pending request is not money: the badge must not show one', () => {
  const world = {
    user: USER, settings: baseSettings(), att: {},
    pDays: [day(THU)],
    leaves: [leave(1, { type: 'early-morning', dateFrom: THU, earlyMorningTier: 1, status: 'pending' })],
  };
  assert.strictEqual(payslipEarlyMoney(world), 0, 'a pending request must not be paid');
  assert.strictEqual(popupEarlyMoney(world, THU), 0, 'a pending request must not get a badge');
});

console.log(`\n${passed} passed, ${process.exitCode ? 'some failed' : '0 failed'}`);
