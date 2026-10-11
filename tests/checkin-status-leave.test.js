// The Check-in Status list has to separate "on leave" from "has not arrived" (2026-10-09).
//
// Found by the owner on 2026-10-09 looking at the real screen: one employee sat under
// "ยังไม่เข้างาน (1 คน)" in red, with the same "⏳ ยังไม่เข้า" text an absent person gets, on a day
// they had approved leave. getCheckinStatusLists() split everyone on `rec.checkIn` alone, so an
// approved leave and a no-show landed in the same bucket and colleagues could not tell which was
// which. The owner asked for the leave TYPE to be shown, not merely the word "leave".
//
// Showing the type to everyone is not a new disclosure: the "วันลาวันนี้ 🌴" stat card sits in the
// same dashboard row, is not role-gated (unlike "รอการอนุมัติ", which carries display:none), and
// openTodayLeaveModal() already shows every employee the name, the leave type AND the reason.
// This change moves the fact to where people were asking the question. The reason stays out.
//
// These tests pin the RULE (who lands in which bucket), not the HTML, so the list cannot quietly
// go back to two buckets. The population filter is deliberately the same one getTodayPersonalLeaves()
// already applies, so this screen and the dashboard's "On Leave Today" count can never disagree.
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

// Same extractor the other app.js rule tests use: brace-match the real body out of app.js so the
// test runs the shipped rule, not a copy of it. Start after the parameter list closes.
function extractFunction(src, name) {
  const re = new RegExp(`^(?:async\\s+)?function ${name}\\(`, 'm');
  const m = re.exec(src);
  if (!m) throw new Error(`function ${name} not found in app.js`);
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

// The half-day classifier reads module-level constants (the lunch window, the standard end of day,
// the tolerance). Pull the real declarations in rather than retyping the numbers here: a test that
// carries its own copy of a rule stops testing the rule the moment someone edits app.js.
function extractConst(src, name) {
  // The declarations are space-aligned into a column, so allow any run of spaces around the `=`.
  const re = new RegExp(`^const ${name}\\s*=.*?;`, 'm');
  const m = re.exec(src);
  if (!m) throw new Error(`const ${name} not found in app.js`);
  return m[0];
}

const TODAY = '2026-10-09';

const emp = (id, name) => ({ id, name, position: 'Staff', role: 'user', active: true });

// A world holding the real bucketing rule plus the records it should judge. Only the environment
// is stubbed (today's date, the attendance log, the settings the half-day classifier reads).
function world(users, leaves, log) {
  const ctx = {
    console,
    DATA_USERS: users,
    DATA_LEAVES: leaves,
    attendanceLog: log || {},
    APP_SETTINGS: { workSchedule: { standardStartHour: 8, standardStartMinute: 30 } },
    businessDateStr: () => TODAY,
    attKey: (uid, d) => `${uid}_${d}`,
    isApprovedAbroadDate: () => false,
  };
  vm.createContext(ctx);
  ['LUNCH_START_MIN', 'LUNCH_END_MIN', 'STD_END_MIN', 'HALFDAY_TOL_MIN', 'PERSONAL_LEAVE_TYPES']
    .forEach(n => vm.runInContext(extractConst(APP_SRC, n), ctx));
  // 2026-10-11 (review): isEmployeeRecord used to be stubbed here as `() => true`. That hid the
  // whole rule one level down -- putting the truthy test back INSIDE isEmployeeRecord restored the
  // original bug at every call site while these tests stayed 18/18 green, because the stub meant
  // they never ran the real one. Extract it like every other rule in this list.
  ['isEmployeeRecord', 'leaveCoversDate', 'leaveDayCoverage', 'getTodayPersonalLeaves',
   'offTheFloorAllDayIdsToday', 'isActiveEmployee', 'isFormerEmployee', 'employeeStatusValue',
   'getCheckinStatusLists'].forEach(n => vm.runInContext(extractFunction(APP_SRC, n), ctx));
  return ctx;
}

const ALICE = emp(1, 'Alice');
const BOB   = emp(2, 'Bob');

const sickFullDay = { id: 10, userId: 1, type: 'sick', dateFrom: TODAY, dateTo: TODAY,
                      status: 'approved', days: 1 };
const annualAm    = { id: 11, userId: 1, type: 'annual', dateFrom: TODAY, dateTo: TODAY,
                      status: 'approved', days: 0, hourlyStart: '08:30', hourlyEnd: '12:00' };
const annualPm    = { id: 12, userId: 1, type: 'annual', dateFrom: TODAY, dateTo: TODAY,
                      status: 'approved', days: 0, hourlyStart: '13:00', hourlyEnd: '17:30' };
const sickPending = { id: 13, userId: 1, type: 'sick', dateFrom: TODAY, dateTo: TODAY,
                      status: 'pending', days: 1 };
const sickYesterday = { id: 14, userId: 1, type: 'sick', dateFrom: '2026-10-08',
                        dateTo: '2026-10-08', status: 'approved', days: 1 };

// Array.from() first: the lists come back from inside the vm, so they are built by THAT realm's
// Array constructor. deepStrictEqual() compares prototypes, and a cross-realm [1] is not strictly
// equal to this realm's [1] — it fails with an identical-looking diff. Copying into this realm
// makes the comparison about the ids, which is what these tests are for.
const ids = list => Array.from(list, x => (x.user ? x.user.id : x.id));

console.log('Check-in Status — on leave is not the same as has not arrived');

test('THE BUG: approved full-day leave no longer sits in "has not checked in"', () => {
  const w = world([ALICE, BOB], [sickFullDay]);
  const r = w.getCheckinStatusLists();
  assert.ok(Array.isArray(r.onLeave), 'getCheckinStatusLists() returned no onLeave list at all');
  assert.deepStrictEqual(ids(r.onLeave), [1], 'the employee on approved sick leave is not in onLeave');
  assert.deepStrictEqual(ids(r.notChecked), [2],
    'the employee on leave is still counted as "has not arrived" — this is the bug');
});

test('the leave TYPE travels with the row, not just the fact of leave', () => {
  const w = world([ALICE], [sickFullDay]);
  const row = w.getCheckinStatusLists().onLeave[0];
  assert.strictEqual(row.leave.type, 'sick',
    'the row carries no leave type, so the screen cannot say WHICH leave it is');
});

test('someone with no leave who has not arrived is still "has not checked in"', () => {
  const w = world([ALICE, BOB], []);
  const r = w.getCheckinStatusLists();
  assert.deepStrictEqual(ids(r.onLeave), []);
  assert.deepStrictEqual(ids(r.notChecked), [1, 2]);
});

test('half-day PM leave for someone who already checked in stays under "checked in"', () => {
  const w = world([ALICE], [annualPm], { '1_2026-10-09': { checkIn: '08:25' } });
  const r = w.getCheckinStatusLists();
  assert.deepStrictEqual(ids(r.checkedIn), [1], 'they worked this morning; they checked in');
  assert.deepStrictEqual(ids(r.onLeave), [], 'a PM leave must not erase the morning check-in');
});

// 2026-10-09 (owner, asked directly): "คนลาครึ่งเช้าที่ยังไม่มา ควรนับเป็นคนที่คาดว่ามาวันนี้ไหม
// — ใช่ ถูกต้อง". So a half-day leave does NOT take someone off the floor: they are still expected
// for the other half. That is also exactly what the dashboard card has done since 2026-08-06.
// The first version of this screen moved them to "on leave" anyway, which made the card say
// "ยังไม่ check-in 1 คน" while the list it opens showed "ยังไม่เข้างาน (0)".
test('half-day AM leave stays under "has not checked in" — they are still expected today', () => {
  const w = world([ALICE], [annualAm]);
  const r = w.getCheckinStatusLists();
  assert.deepStrictEqual(ids(r.onLeave), [],
    'a half-day leave must not move anyone into the on-leave group');
  assert.deepStrictEqual(ids(r.notChecked), [1]);
});

test('...but the row still says which half, so it does not read as an unexplained absence', () => {
  const w = world([ALICE], [annualAm]);
  const row = w.getCheckinStatusLists().notChecked[0];
  assert.ok(row.partialLeave, 'the row carries no leave at all, so the screen cannot explain it');
  assert.strictEqual(row.partialLeave.leave.type, 'annual');
  assert.strictEqual(row.partialLeave.coverage, 'am');
});

// The two screens must not be able to disagree again. Feed the same world to both rules and
// compare who each one considers off for the whole day.
test('the dashboard card and this list use one rule for "off for the whole day"', () => {
  const w = world([ALICE, BOB], [annualAm, { id: 20, userId: 2, type: 'sick', dateFrom: TODAY,
                                              dateTo: TODAY, status: 'approved', days: 1 }]);
  const stdStartMin = 8 * 60 + 30;
  const cardSet = w.offTheFloorAllDayIdsToday(w.getTodayPersonalLeaves(), TODAY, stdStartMin);
  const listSet = new Set(ids(w.getCheckinStatusLists().onLeave));
  assert.deepStrictEqual(Array.from(cardSet).sort(), Array.from(listSet).sort(),
    'the card and the Check-in list disagree about who is off for the whole day');
  assert.deepStrictEqual(Array.from(listSet), [2], 'only the full-day sick leave counts');
});

test('a leave request that is not approved yet does not excuse anyone', () => {
  const w = world([ALICE], [sickPending]);
  const r = w.getCheckinStatusLists();
  assert.deepStrictEqual(ids(r.onLeave), []);
  assert.deepStrictEqual(ids(r.notChecked), [1]);
});

test("yesterday's leave does not carry over to today", () => {
  const w = world([ALICE], [sickYesterday]);
  const r = w.getCheckinStatusLists();
  assert.deepStrictEqual(ids(r.onLeave), []);
  assert.deepStrictEqual(ids(r.notChecked), [1]);
});

test('the three buckets together still account for every employee, with no one counted twice', () => {
  const w = world([ALICE, BOB], [sickFullDay], { '2_2026-10-09': { checkIn: '08:10' } });
  const r = w.getCheckinStatusLists();
  const all = [...ids(r.checkedIn), ...ids(r.onLeave), ...ids(r.notChecked)];
  assert.deepStrictEqual(all.slice().sort(), [1, 2], 'someone was lost or double-counted');
});

test('the half-day chip is rendered on the "not checked in" row', () => {
  const body = extractFunction(APP_SRC, 'showCheckinStatusModal');
  assert.ok(/partialLeave/.test(body),
    'the "not checked in" rows ignore partialLeave, so a half-day leave reads as an unexplained absence');
});

// 2026-10-09 (review): with two approved leaves in one day the group came from "any of them is
// full-day" while the chip came from "the first one on file", so a full-day row could render
// wearing a half-day label -- and reversing the order in leaves.json changed the answer. The
// server blocks overlapping leaves, so this needs legacy data, but the row must still be coherent.
test('two leaves in one day: the row shows the leave that decided the group', () => {
  const half = { id: 30, userId: 1, type: 'annual', dateFrom: TODAY, dateTo: TODAY,
                 status: 'approved', days: 0, hourlyStart: '08:30', hourlyEnd: '12:00' };
  const full = { id: 31, userId: 1, type: 'sick', dateFrom: TODAY, dateTo: TODAY,
                 status: 'approved', days: 1 };
  for (const order of [[half, full], [full, half]]) {
    const r = world([ALICE], order).getCheckinStatusLists();
    assert.deepStrictEqual(ids(r.onLeave), [1], 'a full-day leave must put them in the on-leave group');
    assert.strictEqual(r.onLeave[0].leave.type, 'sick',
      'the row shows the half-day leave while sitting in the full-day group');
    assert.strictEqual(r.onLeave[0].coverage, 'full',
      'a row in the on-leave group must never carry a half-day coverage');
  }
});

// The rendering that the bug above produced: a half-day suffix under a full-day heading. Nothing
// asserted that a full-day row renders bare.
test('a full-day row carries no half-day suffix', () => {
  const r = world([ALICE], [sickFullDay]).getCheckinStatusLists();
  assert.strictEqual(r.onLeave[0].coverage, 'full');
  const body = extractFunction(APP_SRC, 'showCheckinStatusModal');
  const map = /leaveCoverageSuffix\s*=\s*\{([\s\S]*?)\}/.exec(body);
  assert.ok(map, 'leaveCoverageSuffix not found -- this test went blind');
  assert.ok(!/full\s*:/.test(map[1]),
    'the suffix map has a `full` entry, so a full-day row would print one');
});

// 2026-10-09 (review): the three-language test below greps the hard-coded Japanese in the function
// body, which cannot catch a MISSING ja.js key -- L() silently falls back to English. Check the
// dictionary itself for every English string the new rows pass through L().
test('every new string the rows pass to L() has a Japanese entry in ja.js', () => {
  const ja = fs.readFileSync(path.join(__dirname, '..', 'attendance', 'lang', 'ja.js'), 'utf8');
  for (const key of ['morning half-day', 'afternoon half-day', 'partial day',
                     'Annual Leave', 'Sick Leave', 'Business Leave', 'Not in']) {
    assert.ok(ja.includes(`"${key}"`),
      `ja.js has no entry for "${key}" -- Japanese users silently get the English string`);
  }
});

// The owner asked for the type, not the reason. openTodayLeaveModal() is where reasons live.
test('the rendered rows show the leave type and never the reason', () => {
  const body = extractFunction(APP_SRC, 'showCheckinStatusModal');
  assert.ok(/onLeave/.test(body), 'showCheckinStatusModal() does not render the onLeave list');
  assert.ok(!/\.reason/.test(body),
    'the Check-in list renders a leave reason; the owner scoped this screen to the type only');
});

// Every user-facing string in this app ships in Thai, English and Japanese together.
test('the new section heading exists in all three languages', () => {
  const body = extractFunction(APP_SRC, 'showCheckinStatusModal');
  assert.ok(/ลางาน/.test(body), 'no Thai heading for the on-leave section');
  assert.ok(/On Leave/.test(body), 'no English heading for the on-leave section');
  assert.ok(/休暇/.test(body), 'no Japanese heading for the on-leave section');
});

// 2026-10-11 (owner): the two screens ask "is this person still staff?" differently.
// getTodayPersonalLeaves() asks `u.active !== false`; getCheckinStatusLists() asks `u.active`.
// They agree on every record carrying an explicit true/false, and differ on one carrying no
// `active` key at all: the "วันลาวันนี้" card counts that person, the list drops them from all
// three buckets, and the two numbers disagree with nothing on screen to explain it.
// The lenient reading is the right one. `active` is the payroll roster flag -- see the comment on
// canOpenDoor() in server.js, which says forcing active:true to keep someone's door badge would
// silently put a resigned person back into payroll -- so a record that never said anyone resigned
// has not resigned. Both callers must read it the same way.
test('a record with no `active` field is counted by the card and then lost by the list', () => {
  const noFlag = { id: 3, name: 'Carol', position: 'Staff', role: 'user' }; // no `active` key
  const leave = { id: 21, userId: 3, type: 'annual', dateFrom: TODAY, dateTo: TODAY,
                  status: 'approved', days: 1 };
  const w = world([ALICE, noFlag], [leave]);
  const counted = new Set(w.getTodayPersonalLeaves().map(l => l.userId));
  const r = w.getCheckinStatusLists();
  const shown = new Set([...ids(r.checkedIn), ...ids(r.onLeave), ...ids(r.notChecked)]);
  assert.ok(counted.has(3), 'the dashboard card should count a record that never said they left');
  for (const uid of counted) {
    assert.ok(shown.has(uid),
      `user ${uid} is counted by the "วันลาวันนี้" card but appears in none of the three Check-in Status buckets`);
  }
});

// The archive page ("อดีตพนักงาน") listed anyone the truthy test rejected, so a record with no
// `active` key would have been shown as a former employee -- the same ambiguity read the other
// way round, and this one puts a name on a page that says the person has left. "Still here" and
// "has left" are not each other's complement when the field can be absent: absent means nobody
// ever recorded a departure, which is not a departure.
test('a record with no `active` field is neither counted as gone nor dropped from the roster', () => {
  const noFlag = { id: 3, name: 'Carol', position: 'Staff', role: 'user' }; // no `active` key
  const resigned = { id: 4, name: 'Dave', position: 'Staff', role: 'user', active: false };
  const w = world([ALICE, noFlag, resigned], []);
  assert.strictEqual(w.isActiveEmployee(noFlag), true, 'nobody ever said Carol left');
  assert.strictEqual(w.isFormerEmployee(noFlag), false, 'so she must not appear on the archive page');
  assert.strictEqual(w.isActiveEmployee(resigned), false, 'Dave was taken off the roster');
  assert.strictEqual(w.isFormerEmployee(resigned), true, 'and belongs on the archive page');
});

// 2026-10-11 (review): the status dropdown on the employee edit form read `u.active` as a truthy
// test, so a record with no `active` key came up preselected on "Suspended" -- and the save path
// writes `newActive = (value === 'true')` straight back. Opening that person's record to change a
// phone number would have taken them off the payroll roster, silently, while every roster filter
// on every other screen still counted them as here. The dropdown has to agree with the predicates.
test('the status dropdown never preselects "suspended" for someone the roster counts as here', () => {
  const w = world([], []);
  assert.strictEqual(w.employeeStatusValue({ id: 3, name: 'Carol', role: 'user' }), 'true',
    'a record that never said anyone left must not come up as suspended');
  assert.strictEqual(w.employeeStatusValue({ id: 4, active: false }), 'false');
  assert.strictEqual(w.employeeStatusValue({ id: 5, active: true }), 'true');
  assert.strictEqual(w.employeeStatusValue({ id: 6, active: false, isObserver: true }), 'observer');
  // An Observer who was never taken off the roster is a data error roster-health.js reports; the
  // form still has to show what the record says, not guess.
  assert.strictEqual(w.employeeStatusValue({ id: 7, active: true, isObserver: true }), 'observer');
});

console.log(`  ${passed} passed`);
