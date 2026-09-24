// 2026-09-24 backlog, final batch: automatic year-end carry-forward (server-side run), Abroad days
// never late + display-only local time. No framework: `node tests/year-end-abroad.test.js`.
//
// Same approach as tests/leave-rules.test.js: every function is extracted from the real source
// files (attendance/js/app.js and attendance-server/backend/server.js) and run in a sandbox, so the
// tests also prove the two DUAL-SYNC copies agree.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const APP_SRC = fs.readFileSync(path.join(ROOT, 'attendance/js/app.js'), 'utf8');
const SERVER_SRC = fs.readFileSync(path.join(ROOT, 'attendance-server/backend/server.js'), 'utf8');

function extractFunction(src, name) {
  const m = new RegExp(`^(async )?function ${name}\\(`, 'm').exec(src);
  if (!m) throw new Error(`function ${name} not found`);
  const i = src.indexOf('{', m.index);
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
  'carryForwardExpiryDateStr', 'leaveMinutesOnOrBefore',
  'carryForwardForfeitMinutes', 'isVoidLeaveStatus'];
const CLIENT_FNS = [...SHARED, 'leaveRecordMinutes', 'getApprovedHolidayWorkDays',
  'getCarryForwardKey', 'getCarryForwardCompKey', 'getCarryForwardDays', 'getCarryForwardCompDays',
  'getOpeningUsedKey', 'getOpeningUsedDays', 'computeLeaveBalance', 'localDateStr', 'isYearEndCountedLeaveStatus', 'annualLeaveRemainingMinutes',
  'computeLateDeductMinutes', 'isSafeTimeZone', 'tzOffsetMinutesAt', 'abroadLocalTimeText', 'abroadLocalTimeHtml', 'escapeHtml', 'stampAbroadScan'];
const SERVER_FNS = [...SHARED, 'leaveMinutesOf', 'getApprovedHolidayWorkAnnualLeaveDays',
  'deriveLeaveDaysCount', 'ta_localDateStr', 'isValidDateStr', 'isYearEndCountedLeaveStatus', 'annualLeaveRemainingMinutes',
  'annualLateDeductMinutes', 'carryForwardAutoRunYear', 'computeYearEndCarryForward'];

const TIERS = [{ afterMonths: 6, days: 3 }, { afterMonths: 12, days: 6 }, { afterMonths: 24, days: 8 }, { afterMonths: 36, days: 10 }];
const LATE_POLICY = { enabled: true, effectiveFromPeriod: '20260101', tiers: [{ fromMin: 1, toMin: 30, deductMin: 30 }, { fromMin: 31, toMin: 240, deductMin: 60 }] };
function leaveSettings(over) {
  return { carryForwardMax: 5, carryForwardExpiryEnabled: true, carryForwardExpiryMonth: 3, carryForwardExpiryDay: 31,
    carryForwardNotifyDays: 30, annualLeaveMinMonths: 6, annualLeaveTiers: TIERS, sickLeaveDays: 30, businessLeaveDays: 3, ...over };
}
// World = { today, leaves, cf, openingUsed, leave, users, log: { '<uid>_<date>': { checkIn } }, lang }
function makeClient(w) {
  const ctx = {
    APP_SETTINGS: { leave: w.leave, lateDeductPolicy: w.latePolicy || { enabled: false }, workSchedule: { standardStartHour: 8, standardStartMinute: 30 } },
    DATA_LEAVES: w.leaves, DATA_USERS: w.users, LEAVE_CARRY_FORWARD: w.cf, LEAVE_OPENING_USED: w.openingUsed,
    attendanceLog: w.log || {}, DEFAULT_ANNUAL_LEAVE_TIERS: TIERS, DEFAULT_TZ: 'Asia/Bangkok',
    currentLang: w.lang || 'en', L: (en, th) => (w.lang === 'th' ? th : en),
    bangkokDateStr: () => w.today, businessDateStr: () => w.today, bangkokYear: () => Number(w.today.slice(0, 4)),
    isPublicHoliday: () => false, isCompanyTripDay: () => false,
    isNonWorkDayForComp: d => { const x = new Date(d + 'T12:00:00').getDay(); return x === 0 || x === 6; },
  };
  vm.createContext(ctx);
  vm.runInContext(CLIENT_FNS.map(n => extractFunction(APP_SRC, n)).join('\n'), ctx);
  return ctx;
}
function makeServer(w) {
  const ctx = {
    HHMM_RE: /^([01]\d|2[0-3]):[0-5]\d$/, DATE_RE: /^\d{4}-\d{2}-\d{2}$/, DEFAULT_ANNUAL_LEAVE_TIERS: TIERS,
    getAppSettings: () => ({ leave: w.leave, lateDeductPolicy: w.latePolicy || { enabled: false }, workSchedule: { standardStartHour: 8, standardStartMinute: 30 } }),
    readSettings: () => ({ leaveCarryForward: w.cf, leaveOpeningUsed: w.openingUsed }),
    bangkokDateStr: () => w.today,
    isPublicHoliday: () => false, isCompanyTripDay: () => false,
    isNonWorkDayForComp: d => { const x = new Date(d + 'T12:00:00').getDay(); return x === 0 || x === 6; },
    businessLeaveEntitlementDays: () => 3,
    buildAttendanceLogForUser: u => {
      const out = {};
      for (const [k, v] of Object.entries(w.log || {})) if (k.startsWith(`${u.id}_`)) out[k.slice(String(u.id).length + 1)] = v;
      return out;
    },
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
let nextId = 1;
const annual = (userId, dateFrom, dateTo, days, status = 'approved') => ({ id: nextId++, userId, type: 'annual', status, dateFrom, dateTo, days });
const abroad = (userId, dateFrom, dateTo, status = 'approved') => ({ id: nextId++, userId, type: 'abroad', status, dateFrom, dateTo });

console.log('T1 automatic carry-forward: should-run decision');
test('January of Y with no run -> runs Y-1', () => {
  const S = makeServer({ today: '2027-01-01', leave: leaveSettings() });
  assert.strictEqual(S.carryForwardAutoRunYear('2027-01-01', undefined), 2026);
  assert.strictEqual(S.carryForwardAutoRunYear('2027-01-31', {}), 2026);
  assert.strictEqual(S.carryForwardAutoRunYear('2027-01-15', { 2025: { at: 'x', by: 'auto' } }), 2026);
});
test('already recorded (auto or manual) -> never again', () => {
  const S = makeServer({ today: '2027-01-01', leave: leaveSettings() });
  assert.strictEqual(S.carryForwardAutoRunYear('2027-01-02', { 2026: { at: '2027-01-01T00:07:00Z', by: 'auto', byId: null } }), null);
  assert.strictEqual(S.carryForwardAutoRunYear('2027-01-02', { 2026: { at: '2027-01-01T03:00:00Z', by: 'Sirintorn', byId: 4 } }), null);
});
test('outside January -> no auto-run (mid-year ship, December)', () => {
  const S = makeServer({ today: '2026-09-24', leave: leaveSettings() });
  for (const d of ['2026-09-24', '2026-12-31', '2027-02-01', '2026-02-01']) assert.strictEqual(S.carryForwardAutoRunYear(d, {}), null, d);
});
test('garbage date / garbage runs are safe', () => {
  const S = makeServer({ today: '2027-01-01', leave: leaveSettings() });
  assert.strictEqual(S.carryForwardAutoRunYear('', {}), null);
  assert.strictEqual(S.carryForwardAutoRunYear(undefined, {}), null);
  assert.strictEqual(S.carryForwardAutoRunYear('2027-01-05', []), 2026);
  assert.strictEqual(S.carryForwardAutoRunYear('2027-01-05', 'x'), 2026);
});

// 2026-09-24 (review M): the run now also subtracts last year's PENDING annual leave, so the
// comparison is against the client twin annualLeaveRemainingMinutes (was computeLeaveBalance,
// approved-only); user 5's pending 1-day request now lowers the carried value by 1.
console.log('T1 computed value == the client twin annualLeaveRemainingMinutes (pending counted)');
const USERS = [
  { id: 1, startDate: '2020-01-01', active: true },                      // 10 days
  { id: 2, startDate: '2026-05-15', active: true },                      // probation, 3 days from Nov
  { id: 3, startDate: '2020-01-01', active: false },                     // inactive -> skipped
  { id: 4, startDate: '2020-01-01', active: true, isSystemAccount: true }, // superadmin -> skipped
  { id: 5, startDate: '2024-01-01', active: true },                      // 8 days, uses a lot
];
function oldClientValue(C, u, year, maxCF) {
  return Math.min(Math.max(0, C.annualLeaveRemainingMinutes(u, year) / 480), maxCF);
}
function worldCF(over) {
  return {
    today: '2027-01-01', users: USERS, openingUsed: { '2026_5_annual': 1.5 },
    cf: { '2026_1': 5, '2027_1': 99 },
    leaves: [annual(1, '2026-03-02', '2026-03-04', 3), annual(1, '2026-12-14', '2026-12-15', 2),
      annual(5, '2026-06-01', '2026-06-03', 3), annual(5, '2026-10-01', '2026-10-01', 1, 'pending-manager'),
      { id: nextId++, userId: 5, type: 'annual', status: 'approved', dateFrom: '2026-08-10', days: 0, hourlyStart: '10:00', hourlyEnd: '15:00' },
      { id: nextId++, userId: 2, type: 'holiday-work', compensationMode: 'annual-leave', status: 'approved', dateFrom: '2026-08-08', days: 1 }],
    leave: leaveSettings(), ...over,
  };
}
for (const max of [5, 20, 0]) {
  test(`carryForwardMax ${max}: server run matches the client balance for every active employee`, () => {
    const w = worldCF({ leave: leaveSettings({ carryForwardMax: max }) });
    const C = makeClient(w), S = makeServer(w);
    const out = S.computeYearEndCarryForward(w.leaves, w.users, 2026, w.cf, max);
    assert.deepStrictEqual(Object.keys(out).sort(), ['2027_1', '2027_2', '2027_5', 'comp_2027_1', 'comp_2027_2', 'comp_2027_5']);
    for (const u of USERS.filter(x => x.active && !x.isSystemAccount)) {
      assert.strictEqual(out[C.getCarryForwardKey(2027, u.id)], oldClientValue(C, u, 2026, max), `user ${u.id}`);
      assert.strictEqual(out[C.getCarryForwardCompKey(2027, u.id)], 0);
    }
  });
}
test('expected numbers: user 1 = min(15 - 5 used - 2 expired CF, 20) = 8; user 5 = 8 - 3 - 1 pending - 4h - 1.5 = 2.0 days', () => {
  const w = worldCF({ leave: leaveSettings({ carryForwardMax: 20 }) });
  const out = makeServer(w).computeYearEndCarryForward(w.leaves, w.users, 2026, w.cf, 20);
  assert.strictEqual(out['2027_1'], 8);
  assert.strictEqual(out['2027_5'], 8 - 3 - 1 - 0.5 - 1.5);
  assert.strictEqual(out['2027_2'], 3 + 1); // quota 3 from Nov + 1 earned holiday-work day
});
test('missing carryForwardMax -> default 5; absurd value clamped to 60', () => {
  const w = worldCF({ leave: leaveSettings({ carryForwardMax: 20 }) });
  const S = makeServer(w);
  assert.strictEqual(S.computeYearEndCarryForward(w.leaves, w.users, 2026, w.cf, undefined)['2027_1'], 5);
  assert.strictEqual(S.computeYearEndCarryForward(w.leaves, w.users, 2026, w.cf, 'x')['2027_1'], 5);
  assert.ok(S.computeYearEndCarryForward(w.leaves, w.users, 2026, w.cf, 999)['2027_1'] <= 60);
});

console.log('T2 approved Abroad days are never late (leave-balance late deduction, both sides)');
function lateWorld(leaves) {
  // Tue 2026-03-03 check-in 10:00 (90 min late -> 60), Wed 03-04 08:40 (10 min -> 30)
  return { today: '2026-09-24', users: [{ id: 1, role: 'user' }], leaves, cf: {}, openingUsed: {}, leave: leaveSettings(),
    latePolicy: LATE_POLICY, log: { '1_2026-03-03': { checkIn: '10:00' }, '1_2026-03-04': { checkIn: '08:40' } } };
}
test('no abroad: both days deduct on both sides', () => {
  const w = lateWorld([]);
  assert.strictEqual(makeClient(w).computeLateDeductMinutes(1, 2026).deductMin, 90);
  assert.strictEqual(makeServer(w).annualLateDeductMinutes({ id: 1, role: 'user' }, 2026, w.leaves), 90);
});
test('approved abroad covering 03-03: only 03-04 deducts on both sides', () => {
  const w = lateWorld([abroad(1, '2026-03-02', '2026-03-03')]);
  assert.strictEqual(makeClient(w).computeLateDeductMinutes(1, 2026).deductMin, 30);
  assert.strictEqual(makeServer(w).annualLateDeductMinutes({ id: 1, role: 'user' }, 2026, w.leaves), 30);
});
test('pending abroad does not exempt', () => {
  const w = lateWorld([abroad(1, '2026-03-02', '2026-03-03', 'pending-manager')]);
  assert.strictEqual(makeClient(w).computeLateDeductMinutes(1, 2026).deductMin, 90);
  assert.strictEqual(makeServer(w).annualLateDeductMinutes({ id: 1, role: 'user' }, 2026, w.leaves), 90);
});

console.log('T2 display-only local time on Abroad days');
test('Bangkok instant shown in Tokyo time (+2h)', () => {
  const C = makeClient({ today: '2026-09-24', leaves: [], users: [], cf: {}, openingUsed: {}, leave: leaveSettings() });
  assert.strictEqual(C.abroadLocalTimeText('2026-09-24T09:00:00+07:00', 'Asia/Tokyo', '09:00'), '11:00 Tokyo time');
  assert.strictEqual(C.abroadLocalTimeText('2026-09-24T09:00:00+07:00', 'America/New_York', null), '22:00 New York time');
});
test('nothing for Bangkok, no zone, unsafe zone, or a time-corrected row', () => {
  const C = makeClient({ today: '2026-09-24', leaves: [], users: [], cf: {}, openingUsed: {}, leave: leaveSettings() });
  assert.strictEqual(C.abroadLocalTimeText('2026-09-24T09:00:00+07:00', 'Asia/Bangkok', '09:00'), '');
  assert.strictEqual(C.abroadLocalTimeText('2026-09-24T09:00:00+07:00', null, '09:00'), '');
  assert.strictEqual(C.abroadLocalTimeText('2026-09-24T09:00:00+07:00', '<script>', '09:00'), '');
  assert.strictEqual(C.abroadLocalTimeText('2026-09-24T09:00:00+07:00', 'Asia/Tokyo', '08:30'), '');
});
// 2026-09-24 (review fix 9): Etc/* zones (open sea, no country) are neither stored nor shown.
test('Etc/* zone: no note on the client, not stamped, and not stored by the server', () => {
  const C = makeClient({ today: '2026-09-24', leaves: [], users: [], cf: {}, openingUsed: {}, leave: leaveSettings() });
  assert.strictEqual(C.abroadLocalTimeText('2026-09-24T09:00:00+07:00', 'Etc/GMT-9', '09:00'), '');
  assert.strictEqual(C.abroadLocalTimeText('2026-09-24T09:00:00+07:00', 'Etc/GMT+7', null), '');
  const rec = {};
  C.stampAbroadScan(rec, 'in', '2026-09-24T09:00:00+07:00', 'Etc/GMT-9');
  assert.strictEqual(rec.checkInGpsTz, null);
  C.stampAbroadScan(rec, 'out', '2026-09-24T18:00:00+07:00', 'Asia/Tokyo');
  assert.strictEqual(rec.checkOutGpsTz, 'Asia/Tokyo');
  for (const [zone, want] of [['Etc/GMT-9', ''], ['Etc/UTC', ''], ['Asia/Tokyo', 'Asia/Tokyo']]) {
    const S = { geoTzFind: () => [zone] };
    vm.createContext(S);
    vm.runInContext(['isSafeTimeZone', 'timezoneFromCoords'].map(n => extractFunction(SERVER_SRC, n)).join('\n'), S);
    assert.strictEqual(S.timezoneFromCoords(35, 139), want, zone);
  }
});
test('row html only on status abroad', () => {
  const C = makeClient({ today: '2026-09-24', leaves: [], users: [], cf: {}, openingUsed: {}, leave: leaveSettings() });
  const scan = { inAt: '2026-09-24T09:00:00+07:00', inTz: 'Asia/Tokyo', outAt: null, outTz: null };
  assert.ok(C.abroadLocalTimeHtml({ status: 'abroad', checkIn: '09:00', abroadScan: scan }, 'in').includes('11:00 Tokyo time'));
  assert.strictEqual(C.abroadLocalTimeHtml({ status: 'present', checkIn: '09:00', abroadScan: scan }, 'in'), '');
  assert.strictEqual(C.abroadLocalTimeHtml({ status: 'abroad', checkOut: '18:00', abroadScan: scan }, 'out'), '');
});

console.log('T1 runYearEndCarryForward: whole-file read-modify-write, run recorded, no second run');
function makeRunner(w, disk) {
  const S = makeServer(w);
  S.readJSON = () => (disk.settings === null ? null : JSON.parse(JSON.stringify(disk.settings)));
  S.writeJSON = (f, data) => { assert.strictEqual(f, 'settings.json'); disk.writes++; disk.settings = data; };
  S.readLeaves = () => w.leaves;
  S.readUsers = () => w.users;
  vm.runInContext(extractFunction(SERVER_SRC, 'runYearEndCarryForward'), S);
  return S;
}
test('writes CF + run log, keeps every other key, refuses a second run', () => {
  const w = worldCF({ leave: leaveSettings({ carryForwardMax: 20 }) });
  const disk = { writes: 0, settings: { appSettings: { leave: w.leave }, periodLocks: { a: 1 }, leaveCarryForward: { ...w.cf, '2026_9': 2 }, emailConfig: { pass: 'x' } } };
  const S = makeRunner(w, disk);
  const r = S.runYearEndCarryForward(2026, null);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.count, 3);
  assert.deepStrictEqual(disk.settings.periodLocks, { a: 1 });
  assert.deepStrictEqual(disk.settings.emailConfig, { pass: 'x' });
  assert.strictEqual(disk.settings.leaveCarryForward['2026_9'], 2);
  assert.strictEqual(disk.settings.leaveCarryForward['2027_1'], 8);
  assert.strictEqual(disk.settings.leaveCarryForwardRuns['2026'].by, 'auto');
  const again = S.runYearEndCarryForward(2026, { id: 4, name: 'Acc' });
  assert.strictEqual(again.ok, false);
  assert.strictEqual(again.code, 'cf-already-processed');
  assert.strictEqual(again.run.by, 'auto');
  assert.strictEqual(disk.writes, 1);
});
test('manual run records the name; unreadable settings -> 503, nothing written', () => {
  const w = worldCF();
  const disk = { writes: 0, settings: {} };
  const r = makeRunner(w, disk).runYearEndCarryForward(2026, { id: 4, name: 'Acc' });
  assert.deepStrictEqual({ by: r.run.by, byId: r.run.byId }, { by: 'Acc', byId: 4 });
  const bad = { writes: 0, settings: null };
  assert.strictEqual(makeRunner(w, bad).runYearEndCarryForward(2026, null).status, 503);
  assert.strictEqual(bad.writes, 0);
});

console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ', 0 failed'}`);
