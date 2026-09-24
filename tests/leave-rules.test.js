// Leave-rule unit tests (2026-09-24 backlog: carry-forward expiry FIFO, hourly lunch exclusion,
// probation earned pool, year-end snapshot). No framework: `node tests/leave-rules.test.js`.
//
// The helpers are NOT copied by hand -- each function is extracted from the real source files
// (attendance/js/app.js and attendance-server/backend/server.js) and evaluated in a sandbox with
// small stubs for data/settings, so the tests also prove the two DUAL-SYNC copies agree.
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
  let i = src.indexOf('{', m.index);
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (depth === 0) return src.slice(m.index, j + 1); }
  }
  throw new Error(`unbalanced ${name}`);
}

const SHARED = ['normalizeAnnualLeaveTiers', 'getAnnualLeaveTiers', 'getAnnualLeaveMinMonths',
  'annualLeaveUnlockDateStr', 'isAnnualLeaveUnlocked', 'annualLeaveEntitlementDays',
  'abroadTravelCreditDays', 'hourlyLeaveChargedMinutes', 'carryForwardExpiryEnabled',
  'carryForwardExpiryDateStr', 'leaveWorkingDaysBetween', 'leaveMinutesOnOrBefore',
  'carryForwardForfeitMinutes', 'annualLeaveEarnedPoolDays'];
const CLIENT_FNS = [...SHARED, 'leaveRecordMinutes', 'getApprovedHolidayWorkDays',
  'getCarryForwardKey', 'getCarryForwardCompKey', 'getCarryForwardDays', 'getCarryForwardCompDays',
  'getOpeningUsedKey', 'getOpeningUsedDays', 'computeLeaveBalance', 'canUseAnnualLeave', 'localDateStr'];
const SERVER_FNS = [...SHARED, 'leaveMinutesOf', 'getApprovedHolidayWorkAnnualLeaveDays',
  'deriveLeaveDaysCount', 'ta_localDateStr', 'isValidDateStr', 'hourlyLeaveShapeError', 'parseHHMMToMins',
  'leaveBalanceError', 'annualLeaveServiceError', 'annualLeaveRemainingMinutes'];

const TIERS = [{ afterMonths: 6, days: 3 }, { afterMonths: 12, days: 6 }, { afterMonths: 24, days: 8 }, { afterMonths: 36, days: 10 }];
function leaveSettings(over) {
  return { carryForwardMax: 20, carryForwardExpiryEnabled: true, carryForwardExpiryMonth: 11, carryForwardExpiryDay: 30,
    carryForwardNotifyDays: 30, annualLeaveMinMonths: 6, annualLeaveTiers: TIERS, sickLeaveDays: 30, businessLeaveDays: 3, ...over };
}

// World = { today, leaves, cf, openingUsed, leave }
function makeClient(world) {
  const ctx = {
    APP_SETTINGS: { leave: world.leave },
    DATA_LEAVES: world.leaves, LEAVE_CARRY_FORWARD: world.cf, LEAVE_OPENING_USED: world.openingUsed,
    DEFAULT_ANNUAL_LEAVE_TIERS: TIERS,
    bangkokDateStr: () => world.today, businessDateStr: () => world.today, bangkokYear: () => Number(world.today.slice(0, 4)),
    isPublicHoliday: () => false, isCompanyTripDay: () => false,
    isNonWorkDayForComp: d => { const x = new Date(d + 'T12:00:00').getDay(); return x === 0 || x === 6; },
    computeLateDeductMinutes: () => ({ count: 0, deductMin: 0 }),
  };
  vm.createContext(ctx);
  vm.runInContext(CLIENT_FNS.map(n => extractFunction(APP_SRC, n)).join('\n'), ctx);
  return ctx;
}
function makeServer(world) {
  const ctx = {
    HHMM_RE: /^([01]\d|2[0-3]):[0-5]\d$/,
    DATE_RE: /^\d{4}-\d{2}-\d{2}$/,
    DEFAULT_ANNUAL_LEAVE_TIERS: TIERS,
    getAppSettings: () => ({ leave: world.leave }),
    readSettings: () => ({ leaveCarryForward: world.cf, leaveOpeningUsed: world.openingUsed }),
    bangkokDateStr: () => world.today,
    isPublicHoliday: () => false, isCompanyTripDay: () => false,
    isNonWorkDayForComp: d => { const x = new Date(d + 'T12:00:00').getDay(); return x === 0 || x === 6; },
    businessLeaveEntitlementDays: () => 3,
    annualLateDeductMinutes: () => 0,
  };
  vm.createContext(ctx);
  vm.runInContext(SERVER_FNS.map(n => extractFunction(SERVER_SRC, n)).join('\n'), ctx);
  return ctx;
}

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok  ${name}`); }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; }
}
const D = 480;
const U = { id: 1, startDate: '2020-01-01' }; // 36+ months -> 10 days
function world(over) {
  return { today: '2026-12-05', leaves: [], cf: { '2026_1': 5 }, openingUsed: {}, leave: leaveSettings(), ...over };
}
let nextId = 1;
function annual(dateFrom, dateTo, days, status = 'approved') {
  return { id: nextId++, userId: 1, type: 'annual', status, dateFrom, dateTo, days };
}
// Both sides must agree on the forfeit for every scenario.
function forfeitBoth(w, asOf, includePending, exceptId) {
  const c = makeClient(w).carryForwardForfeitMinutes(U, 2026, asOf, includePending, exceptId);
  const s = makeServer(w).carryForwardForfeitMinutes(w.leaves, U, 2026, asOf, includePending, exceptId, w.cf);
  assert.strictEqual(c, s, `client ${c} != server ${s}`);
  return c;
}

console.log('T1 carry-forward expiry (FIFO), expiry = 2026-11-30');
test('expiry date clamps day to month length (Feb 31 -> Feb 28)', () => {
  const w = world({ leave: leaveSettings({ carryForwardExpiryMonth: 2, carryForwardExpiryDay: 31 }) });
  assert.strictEqual(makeClient(w).carryForwardExpiryDateStr(2026), '2026-02-28');
  assert.strictEqual(makeServer(w).carryForwardExpiryDateStr(2026), '2026-02-28');
});
test('CF 5, used 3 before E -> forfeit 2 days', () => {
  const w = world({ leaves: [annual('2026-03-02', '2026-03-04', 3)] });
  assert.strictEqual(forfeitBoth(w, '2026-12-01', false), 2 * D);
});
test('CF 5, used 6 before E -> forfeit 0', () => {
  const w = world({ leaves: [annual('2026-03-02', '2026-03-09', 6)] });
  assert.strictEqual(forfeitBoth(w, '2026-12-01', false), 0);
});
test('leave used AFTER E does not count as CF usage', () => {
  const w = world({ leaves: [annual('2026-12-07', '2026-12-09', 3)] });
  assert.strictEqual(forfeitBoth(w, '2026-12-10', false), 5 * D);
});
test('leave straddling E counts only its working days up to E', () => {
  assert.strictEqual(new Date('2026-11-27T12:00:00').getDay(), 5); // Friday
  // Fri 27, (Sat/Sun), Mon 30 = E, Tue 1, Wed 2 -> 4 working days, 2 of them on/before E
  const w = world({ leaves: [annual('2026-11-27', '2026-12-02', 4)] });
  assert.strictEqual(forfeitBoth(w, '2026-12-03', false), 3 * D);
});
test('hourly leave before E counts its (lunch-excluded) minutes', () => {
  const l = { id: 99, userId: 1, type: 'annual', status: 'approved', dateFrom: '2026-05-05', days: 0, hourlyStart: '10:00', hourlyEnd: '15:00' };
  const w = world({ leaves: [l] });
  assert.strictEqual(forfeitBoth(w, '2026-12-01', false), 5 * D - 240);
});
test('go-live opening-used counts as used before E (credit does not)', () => {
  assert.strictEqual(forfeitBoth(world({ openingUsed: { '2026_1_annual': 1.5 } }), '2026-12-01', false), 3.5 * D);
  assert.strictEqual(forfeitBoth(world({ openingUsed: { '2026_1_annual': -2 } }), '2026-12-01', false), 5 * D);
});
test('toggle off -> forfeit 0', () => {
  const w = world({ leave: leaveSettings({ carryForwardExpiryEnabled: false }) });
  assert.strictEqual(forfeitBoth(w, '2026-12-31', false), 0);
});
test('missing toggle key is treated as ON', () => {
  const lv = leaveSettings(); delete lv.carryForwardExpiryEnabled;
  assert.strictEqual(forfeitBoth(world({ leave: lv }), '2026-12-01', false), 5 * D);
});
test('asOf on/before E -> nothing forfeited yet', () => {
  assert.strictEqual(forfeitBoth(world(), '2026-11-30', false), 0);
  assert.strictEqual(forfeitBoth(world(), '2026-09-24', false), 0);
});
test('pending before E counts only when includePending (gate), not for balances', () => {
  const w = world({ leaves: [annual('2026-11-10', '2026-11-11', 2, 'pending-manager')] });
  assert.strictEqual(forfeitBoth(w, '2026-12-01', true), 3 * D);
  assert.strictEqual(forfeitBoth(w, '2026-12-01', false), 5 * D);
});
test('display: today before E -> no forfeit; today after E -> forfeit applied', () => {
  const leaves = [annual('2026-03-02', '2026-03-04', 3)];
  const before = makeClient(world({ leaves, today: '2026-09-24' })).computeLeaveBalance(U, 'annual', 10, 2026);
  assert.strictEqual(before.forfeitMin, 0);
  assert.strictEqual(before.remMin, 12 * D);
  const after = makeClient(world({ leaves, today: '2026-12-05' })).computeLeaveBalance(U, 'annual', 10, 2026);
  assert.strictEqual(after.forfeitMin, 2 * D);
  assert.strictEqual(after.remMin, 10 * D);
});
test('server gate after E: pool reduced by forfeit; before E: full pool', () => {
  const w = world({ leaves: [annual('2026-03-02', '2026-03-04', 3)] });
  const S = makeServer(w);
  assert.strictEqual(S.leaveBalanceError(w.leaves, U, 'annual', 10 * D, undefined, '2026-12-10'), null);
  assert.ok(S.leaveBalanceError(w.leaves, U, 'annual', 11 * D, undefined, '2026-12-10'));
  assert.strictEqual(S.leaveBalanceError(w.leaves, U, 'annual', 12 * D, undefined, '2026-11-20'), null);
});
test('server gate: pending request before E is not double-penalised', () => {
  const w = world({ leaves: [annual('2026-03-02', '2026-03-04', 3), annual('2026-11-10', '2026-11-11', 2, 'pending-manager')] });
  // pool 15 - used 5 (approved+pending) - forfeit 0 (5 CF covered by 3+2 before E) = 10
  assert.strictEqual(makeServer(w).leaveBalanceError(w.leaves, U, 'annual', 10 * D, undefined, '2026-12-10'), null);
});
test('year-end snapshot: server annualLeaveRemainingMinutes == client computeLeaveBalance (post-forfeit)', () => {
  const w = world({ today: '2027-01-05', leaves: [annual('2026-03-02', '2026-03-04', 3), annual('2026-12-14', '2026-12-15', 2)] });
  const c = makeClient(w).computeLeaveBalance(U, 'annual', 10, 2026).remMin;
  const s = makeServer(w).annualLeaveRemainingMinutes(w.leaves, U, 2026, w.cf);
  assert.strictEqual(c, s);
  assert.strictEqual(c, (15 - 3 - 2 - 2) * D);
});

console.log('T4 hourly leave excludes the 12:00-13:00 lunch overlap');
const LUNCH = [['10:00', '15:00', 240], ['12:30', '14:00', 60], ['12:00', '13:00', 0], ['08:30', '12:00', 210],
  ['13:00', '17:30', 270], ['11:00', '12:30', 60], ['08:30', '17:30', 480], ['12:15', '12:45', 0], ['14:00', '13:00', 0]];
for (const [a, b, want] of LUNCH) {
  test(`${a}-${b} -> ${want} min (both sides)`, () => {
    const w = world();
    assert.strictEqual(makeClient(w).hourlyLeaveChargedMinutes(a, b), want);
    assert.strictEqual(makeServer(w).hourlyLeaveChargedMinutes(a, b), want);
    const rec = { days: 0, hourlyStart: a, hourlyEnd: b };
    assert.strictEqual(makeClient(w).leaveRecordMinutes(rec), want);
    assert.strictEqual(makeServer(w).leaveMinutesOf(rec), want);
  });
}
test('server refuses an hourly request whose charged time is 0', () => {
  const S = makeServer(world());
  assert.ok(/lunch/.test(S.hourlyLeaveShapeError('12:00', '13:00', '2026-10-01', '2026-10-01')));
  assert.strictEqual(S.hourlyLeaveShapeError('11:00', '13:00', '2026-10-01', '2026-10-01'), null);
});

console.log('T3 probation: earned days usable before the tenure unlock');
const P = { id: 1, startDate: '2026-06-01' }; // unlock 2026-12-01
const hw = (date, status = 'approved') => ({ id: nextId++, userId: 1, type: 'holiday-work', compensationMode: 'annual-leave', status, dateFrom: date, days: 1 });
test('no earned days -> locked both sides (existing message kept)', () => {
  const w = world({ today: '2026-09-24', cf: {} });
  assert.strictEqual(makeClient(w).canUseAnnualLeave(P), false);
  assert.ok(/unlocks after 6 months/.test(makeServer(w).annualLeaveServiceError(P, 'annual', '2026-10-05', w.leaves)));
});
test('1 approved holiday-work day -> usable up to 1 day, quota part 0', () => {
  const w = world({ today: '2026-09-24', cf: {}, leaves: [hw('2026-08-08')] });
  const C = makeClient(w), S = makeServer(w);
  assert.strictEqual(C.canUseAnnualLeave(P), true);
  assert.strictEqual(S.annualLeaveServiceError(P, 'annual', '2026-10-05', w.leaves), null);
  const bal = C.computeLeaveBalance(P, 'annual', C.annualLeaveEntitlementDays(P), 2026);
  assert.strictEqual(bal.remMin, 1 * D);
  assert.strictEqual(S.leaveBalanceError(w.leaves, P, 'annual', 1 * D, undefined, '2026-10-05'), null);
  assert.ok(S.leaveBalanceError(w.leaves, P, 'annual', 2 * D, undefined, '2026-10-05'));
});
test('pending holiday work does not open annual leave', () => {
  const w = world({ today: '2026-09-24', cf: {}, leaves: [hw('2026-08-08', 'pending-manager')] });
  assert.strictEqual(makeClient(w).canUseAnnualLeave(P), false);
});
test('abroad travel day on a weekend (already arrived) opens annual leave', () => {
  const sat = '2026-09-05'; assert.strictEqual(new Date(sat + 'T12:00:00').getDay(), 6);
  const trip = { id: nextId++, userId: 1, type: 'abroad', status: 'approved', dateFrom: sat, dateTo: '2026-09-09' };
  const w = world({ today: '2026-09-24', cf: {}, leaves: [trip] });
  assert.strictEqual(makeClient(w).canUseAnnualLeave(P), true);
  assert.strictEqual(makeServer(w).annualLeaveServiceError(P, 'annual', '2026-10-05', w.leaves), null);
});
test('year-end: probation user carries quota (3, unlocked 1 Dec) + unused earned day', () => {
  const w = world({ today: '2027-01-05', cf: {}, leaves: [hw('2026-08-08')] });
  const C = makeClient(w);
  const c = C.computeLeaveBalance(P, 'annual', C.annualLeaveEntitlementDays(P, '2026-12-31'), 2026).remMin;
  const s = makeServer(w).annualLeaveRemainingMinutes(w.leaves, P, 2026, w.cf);
  assert.strictEqual(c, s);
  assert.strictEqual(c, 4 * D);
});
test('still in probation at year-end: earned days are carried, not zeroed', () => {
  const late = { id: 1, startDate: '2026-09-01' }; // unlock 2027-03-01
  const w = world({ today: '2027-01-05', cf: {}, leaves: [hw('2026-10-10')] });
  const C = makeClient(w);
  assert.strictEqual(C.computeLeaveBalance(late, 'annual', C.annualLeaveEntitlementDays(late, '2026-12-31'), 2026).remMin, 1 * D);
  assert.strictEqual(makeServer(w).annualLeaveRemainingMinutes(w.leaves, late, 2026, w.cf), 1 * D);
});
test('owner example: 6m in Nov -> 3d; next year at 12m -> 6 + 3 carried = 9', () => {
  const nov = { id: 1, startDate: '2026-05-15' }; // 6m = 2026-11-15, 12m = 2027-05-15
  const C = makeClient(world({ today: '2027-06-01', cf: { '2027_1': 3 } }));
  assert.strictEqual(C.annualLeaveEntitlementDays(nov, '2026-12-31'), 3);
  assert.strictEqual(C.computeLeaveBalance(nov, 'annual', C.annualLeaveEntitlementDays(nov), 2027).effectiveMax, 9);
});

console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ', 0 failed'}`);
