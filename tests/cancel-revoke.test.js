// Cancel / revoke status tests (2026-09-24 backlog): an approved record the owner cancels becomes
// status 'cancelled', an approval MD/Accounting takes back becomes 'revoked'. Both must drop out of
// every overlap/duplicate check, balance, payroll and earned-credit calculation -- on BOTH sides.
// No framework: `node tests/cancel-revoke.test.js`. Same extraction approach as the other tests:
// real functions from attendance/js/app.js and attendance-server/backend/server.js in a sandbox.
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
  // Body starts at the first ') {' -- a destructured parameter ({ a, b }) has braces of its own.
  const i = src.indexOf(') {', m.index) + 2;
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
  return m[0].replace(/^const /, '');
}

const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const isWeekend = d => { const x = new Date(d + 'T12:00:00').getDay(); return x === 0 || x === 6; };
const TIERS = [{ afterMonths: 6, days: 3 }, { afterMonths: 12, days: 6 }, { afterMonths: 24, days: 8 }, { afterMonths: 36, days: 10 }];
const SETTINGS = {
  allowances: {
    earlyMorning1: 240, earlyMorning2: 480, earlyThreshold1Min: 450, earlyThreshold2Min: 390,
    lateNight1: 100, lateNight2: 200, lateNightThreshold1Hour: 19, lateNightThreshold2Hour: 20,
    upcountry: 240, holidayTransport: 500, abroad: 1100, personalCar: 1000, phone: 1000, diligence: 0,
  },
  sso: { rate: 5, maxAmount: 875, minSalary: 1650 },
  tax: { personalAllowanceAnnual: 60000, brackets: [{ upTo: 150000, rate: 0 }, { upTo: Infinity, rate: 5 }] },
  workSchedule: { standardStartHour: 8, standardStartMinute: 30 },
  allowanceEligibility: {},
  payroll: { periodStartDay: 21 },
  leave: { carryForwardMax: 20, carryForwardExpiryEnabled: false, annualLeaveMinMonths: 6, annualLeaveTiers: TIERS,
    sickLeaveDays: 30, businessLeaveDays: 3 },
};

const SHARED = ['isVoidLeaveStatus', 'round2HalfUp', 'round1HalfUp', 'lateNightCheckoutMins', 'parseHHMMToMins',
  'isHolidayWorkDay', 'isNonWorkDayForComp', 'isHolidayWorkOtRecord', 'isFullDayPersonalLeaveStatus',
  'isRestAttendanceDay', 'isDeviceScanSource', 'isEarlyMorningDayStatus', 'deviceScanQualifiesForEarlyMorning',
  'deviceScanQualifiesForLateNight', 'lateNightCheckoutOk', 'accumulateApprovedOtPay', 'effectiveOtMultiplier',
  'computePayroll', 'splitHolidayWorkOtMinutes', 'holidayWorkEndMins', 'standardOtMultiplier', 'abroadTravelCreditDays',
  'isAbroadTravelDay', 'isRevocableLeaveType',
  // leave balance
  'normalizeAnnualLeaveTiers', 'getAnnualLeaveTiers', 'getAnnualLeaveMinMonths', 'annualLeaveUnlockDateStr',
  'isAnnualLeaveUnlocked', 'annualLeaveEntitlementDays', 'hourlyLeaveChargedMinutes', 'carryForwardExpiryEnabled',
  'carryForwardExpiryDateStr', 'leaveWorkingDaysBetween', 'leaveMinutesOnOrBefore', 'carryForwardForfeitMinutes',
  'annualLeaveEarnedPoolDays'];
const CLIENT_FNS = [...SHARED, 'getApprovedHolidayWorkDays', 'canSubmitHolidayWorkForDate', 'leaveRecordMinutes',
  'pendingLeaveMinutes', 'getCarryForwardKey', 'getCarryForwardCompKey', 'getCarryForwardDays',
  'getCarryForwardCompDays', 'getOpeningUsedKey', 'getOpeningUsedDays', 'computeLeaveBalance', 'localDateStr',
  'isWithdrawnLeaveStatus'];
const SERVER_FNS = [...SHARED, 'getApprovedHolidayWorkAnnualLeaveDays', 'findOverlappingLeave', 'hasActiveHolidayWork',
  'hasActiveOfficeOt', 'findOtDuplicate', 'leaveMinutesOf', 'deriveLeaveDaysCount', 'ta_localDateStr', 'isValidDateStr',
  'leaveBalanceError', 'annualLeaveRemainingMinutes', 'isCancellableApprovedLeave'];

const TODAY = '2026-12-31';
function makeClient(w) {
  const ctx = {
    HHMM_RE, APP_SETTINGS: SETTINGS, DATA_LEAVES: w.leaves, DATA_USERS: [w.user], currentUser: w.user,
    editingLeaveId: null, finalizeData: {}, LEAVE_CARRY_FORWARD: {}, LEAVE_OPENING_USED: {},
    DEFAULT_ANNUAL_LEAVE_TIERS: TIERS,
    isCompanyTripDay: () => false, isPublicHoliday: () => false, isAllowanceEligible: () => true,
    isApprovedAbroadDate: () => false, payPeriodBlockedForDate: () => ({ blocked: false }),
    bangkokDateStr: () => TODAY, businessDateStr: () => TODAY, bangkokYear: () => 2026,
    attendanceTimesForDate: d => ({ checkIn: null, checkOut: null, lastScan: null, ...(w.att[d] || {}) }),
    generatePeriodDays: () => w.pDays, getFinalizeKey: () => 'k', calcAnnualTax: () => 0,
    computeLateDeductMinutes: () => ({ count: 0, deductMin: 0 }),
    L: en => en,
  };
  vm.createContext(ctx);
  vm.runInContext(CLIENT_FNS.map(n => extractFunction(APP_SRC, n)).join('\n'), ctx);
  return ctx;
}
function makeServer(w) {
  const ctx = {
    HHMM_RE, DATE_RE: /^\d{4}-\d{2}-\d{2}$/, COMPANY_TRIP_NO_CLAIM_TYPES: null, DEFAULT_ANNUAL_LEAVE_TIERS: TIERS,
    readSettings: () => ({ companyTripDates: [], leaveCarryForward: {}, leaveOpeningUsed: {} }),
    getAppSettings: () => SETTINGS,
    isCompanyTripDay: () => false, isPublicHoliday: () => false, isAllowanceEligible: () => true,
    bangkokDateStr: () => TODAY, buildAttendanceLogForUser: () => ({}), readJSON: () => ({}),
    readLeaves: () => w.leaves, readCheckoutReviews: () => ({}), generatePeriodDays: () => w.pDays,
    getFinalizeKey: () => 'k', calcAnnualTax: () => 0, businessLeaveEntitlementDays: () => 3,
    annualLateDeductMinutes: () => 0,
  };
  vm.createContext(ctx);
  vm.runInContext(constLine(SERVER_SRC, 'DATE_OVERLAP_LEAVE_TYPES') + '\n' +
    SERVER_FNS.map(n => extractFunction(SERVER_SRC, n)).join('\n'), ctx);
  return ctx;
}

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok  ${name}`); }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; }
}
const USER = { id: 1, role: 'user', salary: 24000, startDate: '2020-01-01', personalCarEligible: true };
const world = over => ({ user: USER, leaves: [], pDays: [], att: {}, ...over });
const both = w => [['client', makeClient(w)], ['server', makeServer(w)]];
const VOID = ['rejected', 'cancelled', 'revoked'];
let nextId = 100;
const rec = o => ({ id: nextId++, userId: 1, status: 'approved', dateTo: o.dateFrom, ...o });

console.log('status helper');
test('isVoidLeaveStatus both sides', () => {
  for (const [side, X] of both(world())) {
    VOID.forEach(s => assert.strictEqual(X.isVoidLeaveStatus(s), true, `${side} ${s}`));
    ['approved', 'pending', 'pending-md', 'pending-accounting', undefined].forEach(s =>
      assert.strictEqual(X.isVoidLeaveStatus(s), false, `${side} ${s}`));
  }
  const C = makeClient(world());
  assert.strictEqual(C.isWithdrawnLeaveStatus('cancelled'), true);
  assert.strictEqual(C.isWithdrawnLeaveStatus('revoked'), true);
  assert.strictEqual(C.isWithdrawnLeaveStatus('rejected'), false);
});
test('no negative status filter bypasses the helper (static scan of both files)', () => {
  for (const [name, src] of [['app.js', APP_SRC], ['server.js', SERVER_SRC]]) {
    assert.ok(!/status !== 'rejected'/.test(src), `${name}: bare status !== 'rejected'`);
    assert.ok(!/\['rejected', ?'cancelled'\]/.test(src), `${name}: ['rejected','cancelled'] list`);
  }
});
test('revocable (money-bearing) type list identical both sides', () => {
  const types = ['holiday-work', 'ot', 'early-morning', 'late-out', 'upcountry', 'long-distance', 'personal-car',
    'abroad', 'annual', 'sick', 'business', 'time-correction', 'clear-attachments'];
  const [[, C], [, S]] = both(world());
  types.forEach(t => assert.strictEqual(C.isRevocableLeaveType(t), S.isRevocableLeaveType(t), t));
  assert.strictEqual(S.isRevocableLeaveType('annual'), false);
  assert.strictEqual(S.isRevocableLeaveType('abroad'), true);
});

console.log('overlap / duplicate checks: a cancelled or revoked record frees the date');
test('server findOverlappingLeave / hasActiveHolidayWork / hasActiveOfficeOt / findOtDuplicate', () => {
  for (const st of VOID) {
    const leaves = [
      rec({ type: 'annual', dateFrom: '2026-10-05', dateTo: '2026-10-06', status: st }),
      rec({ type: 'holiday-work', dateFrom: '2026-10-10', status: st }),
      rec({ type: 'ot', dateFrom: '2026-10-07', otHours: 2, otMultiplier: 1.5, status: st }),
    ];
    const S = makeServer(world({ leaves }));
    assert.strictEqual(S.findOverlappingLeave(leaves, 1, 'annual', '2026-10-06', '2026-10-06'), null, st);
    assert.strictEqual(S.hasActiveHolidayWork(leaves, 1, '2026-10-10'), false, st);
    assert.strictEqual(S.hasActiveOfficeOt(leaves, 1, '2026-10-07'), false, st);
    assert.ok(!S.findOtDuplicate(leaves, { userId: 1, dateFrom: '2026-10-07', isDriverOT: false, otMultiplier: 1.5 }), st);
  }
  const live = [rec({ type: 'annual', dateFrom: '2026-10-05', dateTo: '2026-10-06' })];
  assert.ok(makeServer(world({ leaves: live })).findOverlappingLeave(live, 1, 'annual', '2026-10-06', '2026-10-06'));
});
test('client Holiday Work duplicate gate: re-filing after cancel/revoke is allowed', () => {
  for (const st of VOID) {
    const w = world({ leaves: [rec({ type: 'holiday-work', dateFrom: '2026-10-10', status: st })],
      att: { '2026-10-10': { checkIn: '09:00', checkOut: '17:00' } } });
    assert.notStrictEqual(makeClient(w).canSubmitHolidayWorkForDate('2026-10-10', 1).reason, 'duplicate', st);
  }
  const w = world({ leaves: [rec({ type: 'holiday-work', dateFrom: '2026-10-10' })],
    att: { '2026-10-10': { checkIn: '09:00', checkOut: '17:00' } } });
  assert.strictEqual(makeClient(w).canSubmitHolidayWorkForDate('2026-10-10', 1).reason, 'duplicate');
});
test('abroad travel day stops blocking holiday work once the trip is cancelled/revoked', () => {
  for (const st of VOID) {
    const leaves = [rec({ type: 'abroad', dateFrom: '2026-10-10', dateTo: '2026-10-12', status: st })];
    for (const [side, X] of both(world({ leaves }))) assert.strictEqual(X.isAbroadTravelDay(leaves, 1, '2026-10-10'), false, `${side} ${st}`);
  }
});

console.log('leave balance');
test('cancelled annual leave returns its days; pending reservation ignores it', () => {
  const w = world({ leaves: [rec({ type: 'annual', dateFrom: '2026-10-05', dateTo: '2026-10-06', days: 2, status: 'cancelled' }),
    rec({ type: 'annual', dateFrom: '2026-10-20', dateTo: '2026-10-20', days: 1 })] });
  const C = makeClient(w), S = makeServer(w);
  const bal = C.computeLeaveBalance(USER, 'annual', C.annualLeaveEntitlementDays(USER, '2026-12-31'), 2026);
  assert.strictEqual(bal.usedMin, 480, 'client used = the one approved day');
  assert.strictEqual(C.pendingLeaveMinutes(1, 'annual', 2026), 0);
  assert.strictEqual(S.annualLeaveRemainingMinutes(w.leaves, USER, 2026, {}), bal.remMin, 'server = client');
  // 10-day entitlement, 1 used: requesting exactly 9 days passes, 9.5 fails (cancelled 2 days not reserved)
  assert.strictEqual(S.leaveBalanceError(w.leaves, USER, 'annual', 9 * 480, undefined, '2026-11-02'), null);
  assert.ok(S.leaveBalanceError(w.leaves, USER, 'annual', 9.5 * 480, undefined, '2026-11-02'));
});

console.log('earned annual-leave credit');
test('revoked holiday work (annual mode) and revoked/cancelled abroad earn nothing', () => {
  // Sat 2026-10-10 travel day; Sat 2026-10-17 holiday work
  const mk = st => [rec({ type: 'holiday-work', compensationMode: 'annual-leave', dateFrom: '2026-10-17', days: 1, status: st }),
    rec({ type: 'abroad', dateFrom: '2026-10-10', dateTo: '2026-10-14', status: st })];
  const okW = world({ leaves: mk('approved') });
  assert.strictEqual(makeClient(okW).getApprovedHolidayWorkDays(2026, 1), 2);
  assert.strictEqual(makeServer(okW).getApprovedHolidayWorkAnnualLeaveDays(okW.leaves, 1, 2026), 2);
  for (const st of VOID) {
    const w = world({ leaves: mk(st) });
    assert.strictEqual(makeClient(w).getApprovedHolidayWorkDays(2026, 1), 0, `client ${st}`);
    assert.strictEqual(makeServer(w).getApprovedHolidayWorkAnnualLeaveDays(w.leaves, 1, 2026), 0, `server ${st}`);
  }
});

console.log('payroll inclusion');
function payWorld(status) {
  const day = (date, extra) => ({ date, status: 'present', checkIn: '08:20', checkOut: '17:40', checkInSource: 'web', checkOutSource: 'web', ...extra });
  const pDays = [day('2026-11-23'), day('2026-11-24'), day('2026-11-28', { status: 'weekend', isWeekend: true })];
  const leaves = [
    rec({ type: 'ot', dateFrom: '2026-11-23', otHours: 2, otMultiplier: 1.5, status }),
    rec({ type: 'early-morning', dateFrom: '2026-11-24', earlyMorningTier: 1, status }),
    rec({ type: 'holiday-work', compensationMode: 'paid', dateFrom: '2026-11-28', otHours20: 2, otHours30: 0, status }),
    rec({ type: 'long-distance', dateFrom: '2026-11-24', longDistanceAllowance: 300, status }),
    rec({ type: 'personal-car', dateFrom: '2026-11-23', personalCarRate: 1000, status }),
  ];
  return world({ leaves, pDays });
}
test('approved claims pay; the same claims cancelled/revoked/rejected pay nothing (both engines)', () => {
  const start = new Date('2026-11-21T12:00:00'), end = new Date('2026-12-20T12:00:00');
  const run = w => both(w).map(([side, X]) => [side, X.computePayroll(w.user, start, end, 1)]);
  for (const [side, r] of run(payWorld('approved'))) {
    assert.ok(r.otAmount > 0 && r.allowance2 > 0 && r.holidayTransportTotal > 0, side);
    assert.ok(r.longDistanceTotal > 0 && r.personalCarTotal > 0, side);
  }
  for (const st of VOID) {
    const rows = run(payWorld(st));
    for (const [side, r] of rows) {
      const tag = `${side} ${st}`;
      assert.strictEqual(r.otAmount, 0, tag);
      assert.strictEqual(r.allowance2, 0, tag);
      assert.strictEqual(r.holidayTransportTotal, 0, tag);
      assert.strictEqual(r.longDistanceTotal, 0, tag);
      assert.strictEqual(r.personalCarTotal, 0, tag);
    }
    assert.strictEqual(rows[0][1].grossIncome, rows[1][1].grossIncome, `gross parity ${st}`);
  }
});

console.log('server endpoints (static checks)');
test('DELETE keeps an approved record as cancelled with who/when; pending still deleted', () => {
  const del = SERVER_SRC.slice(SERVER_SRC.indexOf("app.delete('/api/leaves/:id'"));
  const body = del.slice(0, del.indexOf('\napp.'));
  assert.ok(/status: 'cancelled', cancelledAt: new Date\(\)\.toISOString\(\)/.test(body));
  assert.ok(/cancelledById: live\.id, cancelledBy: live\.name/.test(body));
  assert.ok(/leaves\.splice\(idx, 1\)/.test(body), 'pending cancel still hard-deletes');
  assert.ok(/type: 'LEAVE_UPDATED'/.test(body));
});
test('revoke route: md/accounting only, all three period guards, own-record refusal', () => {
  const i = SERVER_SRC.indexOf("app.post('/api/leaves/:id/revoke', requireRole('md', 'accounting'), withLeavesLock(");
  assert.ok(i > 0);
  const body = SERVER_SRC.slice(i, SERVER_SRC.indexOf('\napp.', i + 10));
  ['mdApprovedPeriodInRange', 'lockedPeriodInRange', 'accountingConfirmedInRange', "code:'revoke-own'",
    "status: 'revoked'", 'revokedById: live.id', 'revokeReason: reason', 'refreshSnapshottedCarryForward',
    "type: 'LEAVE_UPDATED'"].forEach(k => assert.ok(body.includes(k), k));
});
test('an owner cannot cancel (erase) a cancelled or revoked record again', () => {
  const S = makeServer(world());
  for (const st of ['cancelled', 'revoked']) {
    assert.strictEqual(S.isCancellableApprovedLeave({ type: 'annual', status: st, dateFrom: '2027-06-01' }, '2026-12-01'), false, st);
  }
});

console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ', 0 failed'}`);
