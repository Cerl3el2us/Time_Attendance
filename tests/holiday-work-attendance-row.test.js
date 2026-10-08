// The attendance table has to count Holiday Work the way every other OT view does (2026-10-08).
//
// 2026-09-24 (owner) decided that approved Holiday Work in paid mode carries OT hours
// (otHours20/otHours30) which payroll already pays, and that the OT count/total views should show
// them: Dashboard, Reports monthly/yearly and their detail, the OT detail, and the payslip OT tile.
// Display only -- no pay changed. That rule lives in reportOtRecords() / isHolidayWorkOtRecord().
//
// The attendance table (ตารางเวลาทำงาน) was missed. It does not call reportOtRecords(): it had its
// own per-day lookup that accepted `l.type === 'ot'` and nothing else, so an approved Holiday Work
// day showed no OT icon and no Holiday Work icon at all, while the same hours were counted on five
// other screens and paid on the payslip. Found by the owner on 2026-10-08 against a real record:
// approved, paid mode, 3.5 hours at x2.0, which reportOtRecords() picks up and the table did not.
//
// These tests pin the rule itself rather than the rendering, so the table and the reports cannot
// drift apart again without one of them going red.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const APP_SRC = fs.readFileSync(path.join(ROOT, 'attendance/js/app.js'), 'utf8');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok ', name); }
  catch (e) { process.exitCode = 1; console.log('  FAIL', name, '\n      ', e.message); }
}

function extractFunction(src, name) {
  const re = new RegExp(`^(?:async\\s+)?function ${name}\\(`, 'm');
  const m = re.exec(src);
  if (!m) throw new Error(`function ${name} not found in app.js`);
  // 2026-10-08 (review): start the body AFTER the parameter list closes. buildAttendancePrintView
  // takes a destructured object, so "the first { after the name" is the parameter pattern — brace
  // matching from there returned the signature alone. Every assertion about its BODY then passed
  // or failed on text that was never searched.
  let p = src.indexOf('(', m.index), parens = 0, afterParams = -1;
  for (let j = p; j < src.length; j++) {
    if (src[j] === '(') parens++;
    else if (src[j] === ')') { parens--; if (parens === 0) { afterParams = j; break; } }
  }
  if (afterParams < 0) throw new Error(`unbalanced parameter list for ${name}`);
  const i = src.indexOf('{', afterParams);
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (depth === 0) return src.slice(m.index, j + 1); }
  }
  throw new Error(`unbalanced ${name}`);
}

// A world holding the real rule plus the records it should judge. isCompanyTripDay is stubbed from
// a set the test controls -- the real one reads settings, and this suite is about the OT rule.
function world(leaves, companyTripDates) {
  const ctx = {
    console,
    DATA_LEAVES: leaves,
    isCompanyTripDay: d => (companyTripDates || []).includes(d),
  };
  vm.createContext(ctx);
  ['isHolidayWorkOtRecord', 'attendanceDayOtRecord'].forEach(n =>
    vm.runInContext(extractFunction(APP_SRC, n), ctx));
  return ctx;
}

const DATE = '2026-09-26';
const UID = 7;

const plainOT = { id: 1, userId: UID, type: 'ot', dateFrom: DATE, status: 'approved', otHours: 2 };
// the shape of the record this was found with: paid mode, 3.5 hours at x2.0
const hwPaid = { id: 2, userId: UID, type: 'holiday-work', dateFrom: DATE, status: 'approved',
                 compensationMode: 'paid', otHours20: 3.5, otHours30: 0 };
const hwLeaveMode = { id: 3, userId: UID, type: 'holiday-work', dateFrom: DATE, status: 'approved',
                      compensationMode: 'annual-leave', otHours20: 0, otHours30: 0 };
const hwPending = { id: 4, userId: UID, type: 'holiday-work', dateFrom: DATE, status: 'pending',
                    compensationMode: 'paid', otHours20: 3.5, otHours30: 0 };
const hwPaidNoHours = { id: 5, userId: UID, type: 'holiday-work', dateFrom: DATE, status: 'approved',
                        compensationMode: 'paid', otHours20: 0, otHours30: 0 };

console.log('Holiday Work on the attendance row');

test('an ordinary approved OT request is still found', () => {
  const w = world([plainOT]);
  const r = w.attendanceDayOtRecord(UID, DATE, true, true);
  assert.ok(r, 'the plain OT record was not found');
  assert.strictEqual(r.type, 'ot');
});

test('approved Holiday Work in paid mode is found — the bug this file exists for', () => {
  const w = world([hwPaid]);
  const r = w.attendanceDayOtRecord(UID, DATE, true, true);
  assert.ok(r, 'approved paid Holiday Work carrying 3.5h at x2.0 was not found;\n' +
               '       this is exactly what reportOtRecords() returns for the same record');
  assert.strictEqual(r.type, 'holiday-work');
});

test('Holiday Work in annual-leave mode carries no OT, so it is not an OT row', () => {
  const w = world([hwLeaveMode]);
  assert.strictEqual(w.attendanceDayOtRecord(UID, DATE, true, true), null);
});

test('Holiday Work that is not approved yet is not counted', () => {
  const w = world([hwPending]);
  assert.strictEqual(w.attendanceDayOtRecord(UID, DATE, true, true), null);
});

test('paid Holiday Work with no OT hours on it is not an OT row', () => {
  const w = world([hwPaidNoHours]);
  assert.strictEqual(w.attendanceDayOtRecord(UID, DATE, true, true), null);
});

test('each type is gated by its OWN eligibility, not by one shared flag', () => {
  // Someone eligible for Holiday Work but not for OT still sees the Holiday Work hours, and the
  // reverse. reportOtRecords() does exactly this; the table must not collapse it to one flag.
  const onlyHw = world([hwPaid]);
  assert.ok(onlyHw.attendanceDayOtRecord(UID, DATE, false, true), 'holiday work hidden when OT ineligible');
  assert.strictEqual(onlyHw.attendanceDayOtRecord(UID, DATE, true, false), null, 'holiday work shown when HW ineligible');
  const onlyOt = world([plainOT]);
  assert.ok(onlyOt.attendanceDayOtRecord(UID, DATE, true, false), 'OT hidden when only OT is eligible');
  assert.strictEqual(onlyOt.attendanceDayOtRecord(UID, DATE, false, true), null, 'OT shown when OT ineligible');
});

test('a Company Trip day is excluded, the same as in the reports', () => {
  const w = world([hwPaid, plainOT], [DATE]);
  assert.strictEqual(w.attendanceDayOtRecord(UID, DATE, true, true), null);
});

test('a record from a NEARBY DAY is not borrowed onto this row', () => {
  // 2026-10-08 (review): every fixture record sat on one date, so deleting the `l.dateFrom ===
  // dateStr` filter outright left all 11 tests green — and every row of the timesheet would then
  // have shown the same OT record. The date is half the question this function answers.
  const w = world([{ ...hwPaid, dateFrom: '2026-09-25' }]);
  assert.strictEqual(w.attendanceDayOtRecord(UID, DATE, true, true), null, 'yesterday leaked in');
  const w2 = world([{ ...plainOT, dateFrom: '2026-09-27' }]);
  assert.strictEqual(w2.attendanceDayOtRecord(UID, DATE, true, true), null, 'tomorrow leaked in');
  // and it still finds the right day when both are present
  const w3 = world([{ ...hwPaid, id: 9, dateFrom: '2026-09-25' }, hwPaid]);
  assert.strictEqual(w3.attendanceDayOtRecord(UID, DATE, true, true).id, hwPaid.id, 'wrong day won');
});

test('another person\'s record on the same day is not borrowed', () => {
  const w = world([{ ...hwPaid, userId: 99 }]);
  assert.strictEqual(w.attendanceDayOtRecord(UID, DATE, true, true), null);
});

test('the rule matches reportOtRecords() — same record, same verdict', () => {
  // The point of the file: one rule, two callers. If someone widens or narrows one of them, the
  // records they accept diverge and this fails.
  const ctx = {
    console, DATA_LEAVES: [hwPaid, plainOT, hwLeaveMode, hwPending, hwPaidNoHours],
    isCompanyTripDay: () => false,
    APP_SETTINGS: { allowanceEligibility: { ot: ['user'], holidayWork: ['user'] } },
    isAllowanceEligible: (cfg, role, key) => (cfg[key] || []).includes(role),
  };
  vm.createContext(ctx);
  ['isHolidayWorkOtRecord', 'attendanceDayOtRecord', 'reportOtRecords'].forEach(n =>
    vm.runInContext(extractFunction(APP_SRC, n), ctx));
  const fromReports = ctx.reportOtRecords({ id: UID, role: 'user' }, DATE, DATE)
    .map(r => r.id).sort();
  // 2026-10-08 (review): a `fromTable` built here, computed nothing (.map(() => null)) and was
  // then thrown away with `void` — six lines of decoy that made the real comparison below hard to
  // find. Deleted. The comparison that matters is tableAccepts vs fromReports.
  const tableAccepts = [hwPaid, plainOT, hwLeaveMode, hwPending, hwPaidNoHours]
    .filter(l => {
      const only = { console, DATA_LEAVES: [l], isCompanyTripDay: () => false };
      vm.createContext(only);
      ['isHolidayWorkOtRecord', 'attendanceDayOtRecord'].forEach(n =>
        vm.runInContext(extractFunction(APP_SRC, n), only));
      return !!only.attendanceDayOtRecord(UID, l.dateFrom, true, true);
    }).map(l => l.id).sort();
  assert.deepStrictEqual(tableAccepts, fromReports,
    `the table accepts ${JSON.stringify(tableAccepts)} but the reports accept ${JSON.stringify(fromReports)}`);
});

// ---------------------------------------------------------------------------------------------
test('the row shows a Holiday Work icon of its own, not only the OT one', () => {
  // The owner's report was that an APPROVED Holiday Work day showed nothing to say so. The OT
  // hours are one half of it; the day itself being holiday work is the other.
  const fn = extractFunction(APP_SRC, 'renderAttendanceTable');
  assert.ok(/holidayWorkBadge/.test(fn),
    'renderAttendanceTable() builds no holidayWorkBadge — an approved Holiday Work day still says nothing');
  const listed = /const allowIcons\s*=\s*\[([^\]]*)\]/.exec(fn);
  assert.ok(listed, 'could not find the allowIcons list');
  assert.ok(/holidayWorkBadge/.test(listed[1]),
    `holidayWorkBadge is built but not in the icon list: ${listed[1].trim()}`);
});

// 2026-10-08 (review): the first version of this change reached the desktop table and stopped
// there. The phone card and the printed sheet are the same timesheet and both still carried the
// old rule — the phone showed ⏱️ with no 🔄 to explain it, and the printout showed neither, so the
// paper that gets filed contradicted the screen. One surface fixed is not the screen fixed.
test('all three renderings of the timesheet show Holiday Work, not just the desktop table', () => {
  const table = extractFunction(APP_SRC, 'renderAttendanceTable');
  const print = extractFunction(APP_SRC, 'buildAttendancePrintView');

  const mobile = /const badgesArr\s*=\s*\[([^\]]*)\]/.exec(table);
  assert.ok(mobile, 'could not find the mobile card badge list in renderAttendanceTable()');
  assert.ok(/holidayWorkBadge/.test(mobile[1]),
    `the phone card omits holidayWorkBadge: ${mobile[1].trim()}`);

  assert.ok(/canHolidayWorkTarget/.test(print),
    'buildAttendancePrintView() never receives canHolidayWorkTarget, so it cannot decide whether\n' +
    '       to print the Holiday Work mark');
  assert.ok(/badges\.push\('🔄'\)/.test(print),
    'the printed sheet has no 🔄 — an approved Holiday Work day prints as an ordinary day');
  assert.ok(/attendanceDayOtRecord\(/.test(print),
    'the printed sheet still decides OT with its own filter instead of the shared rule, so it can\n' +
    '       disagree with the screen it was printed from');
});

test('the Holiday Work icon is gated by holidayWork eligibility', () => {
  const fn = extractFunction(APP_SRC, 'renderAttendanceTable');
  assert.ok(/canHolidayWorkTarget\s*=\s*isAllowanceEligible\([^)]*'holidayWork'\)/.test(fn),
    'no canHolidayWorkTarget gate — the icon would show for roles with no such entitlement');
  // 2026-10-08 (review): this used to be /hasAnyAllowanceTarget[^;]*canHolidayWorkTarget/, and
  // [^;]* crosses newlines — so the COMMENT sitting above the declaration satisfied it. Deleting
  // `|| canHolidayWorkTarget` from the assignment left the suite green. Anchor on the assignment.
  assert.ok(/const hasAnyAllowanceTarget\s*=[^;]*canHolidayWorkTarget/.test(fn),
    'canHolidayWorkTarget is missing from hasAnyAllowanceTarget, so the whole column can stay\n' +
    '       hidden for someone whose only entitlement is Holiday Work');
});

console.log(`\n${passed} passed`);
