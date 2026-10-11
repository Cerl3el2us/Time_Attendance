// The roster flag, checked against the data instead of the code (2026-10-11).
//
// app.js and server.js now agree on one reading of `active`: absent means nobody ever recorded a
// departure, so the person is still on the roster. That makes the code safe against a record with
// no `active` key -- it no longer falls between two screens -- but it does not make such a record
// correct. `active` is the payroll roster flag, and a row that never says true or false is a row
// nobody decided about.
//
// This check cannot live in `npm run check`: users.json is gitignored and a worktree has no data
// directory at all, so a test reading it would either fail everywhere or skip itself everywhere --
// a guard that cannot go red. It belongs in `npm run status`, which already reads the live files
// and already reports "NOT measured" when it cannot. The function here is pure so this test can
// prove it goes red, without any data directory.
//
// Reports ids, never names: this runs against the real roster on Z:.
'use strict';
const assert = require('assert');
const { describeRosterHealth } = require('../scripts/lib/roster-health');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok ', name); }
  catch (e) { process.exitCode = 1; console.log('  FAIL', name, '\n      ', e.message); }
}

console.log('Roster health — every record says whether the person is still here');

const ok1 = { id: 1, active: true };
const ok2 = { id: 2, active: false };
const observerGone = { id: 3, active: false, isObserver: true };
const sysAccount = { id: 900001, isSystemAccount: true, active: true };

// 2026-10-11 (review): both assertions here were loose enough that a wrong implementation passed.
// `/3 records/` is matched by "33 records", and the only complaint-check looked for words the
// Observer line does not contain -- so flagging EVERY Observer, including a correctly resigned
// one, stayed green and would have told the owner a correct record was a payroll error.
test('a roster where every record carries true or false reports clean', () => {
  // Four entries go in, three come back counted: the system account is not an employee record,
  // which a later test in this file pins separately.
  const lines = describeRosterHealth([ok1, ok2, observerGone, sysAccount]).join('\n');
  assert.ok(/\b3 records\b/.test(lines), `expected exactly the count 3, got: ${lines}`);
  assert.ok(/every record says/.test(lines), `expected the clean line, got: ${lines}`);
  assert.strictEqual(describeRosterHealth([ok1, ok2, observerGone, sysAccount]).length, 2,
    `a clean roster is two lines, got: ${lines}`);
});

test('an Observer who WAS taken off the roster is correct and must not be flagged', () => {
  const lines = describeRosterHealth([observerGone]).join('\n');
  assert.ok(!/Observer still on the payroll roster/.test(lines),
    `a resigned Observer is the correct shape, not an error: ${lines}`);
});

test('a record with no `active` key is named by id, under its own heading', () => {
  const noFlag = { id: 7 };
  const lines = describeRosterHealth([ok1, noFlag]).join('\n');
  assert.ok(/\b7\b/.test(lines), `expected id 7 in the report, got: ${lines}`);
  // Not /active/: the Observer line contains the word too, so the missing-key case could be
  // reported under the wrong heading and still pass.
  assert.ok(/nobody ever recorded/.test(lines), `expected the missing-flag heading, got: ${lines}`);
});

test('`active` set to something that is not a boolean is caught too', () => {
  const lines = describeRosterHealth([{ id: 8, active: 'true' }]).join('\n');
  assert.ok(/\b8\b/.test(lines), `expected id 8 in the report, got: ${lines}`);
});

// The owner's rule, 2026-10-11: Observer means the person resigned and kept a badge and a
// read-only login. Taking someone off the roster is `active:false` -- see canOpenDoor() in
// server.js, whose comment says forcing active:true to keep a badge would silently put a resigned
// person back into payroll. Observer with active:true is that mistake, sitting in the data.
test('an Observer still marked active is reported — that is a resigned person on the payroll roster', () => {
  const lines = describeRosterHealth([{ id: 9, active: true, isObserver: true }]).join('\n');
  assert.ok(/\b9\b/.test(lines), `expected id 9 in the report, got: ${lines}`);
  assert.ok(/Observer/i.test(lines), `expected Observer named, got: ${lines}`);
});

test('the system account is not judged by the roster rules', () => {
  const lines = describeRosterHealth([{ id: 900001, isSystemAccount: true }]).join('\n');
  assert.ok(!/900001/.test(lines), `the system account is not an employee record, got: ${lines}`);
});

// 2026-10-11 (review): three data errors the first version did not look for.
//
// Duplicate ids matter most and nothing anywhere in this project guards them:
// computeYearEndCarryForward() keys its output `${year}_${u.id}`, so two records sharing an id
// overwrite each other's carry-forward without a word.
test('two records sharing an id are reported — they overwrite each other everywhere id is a key', () => {
  const lines = describeRosterHealth([{ id: 5, active: true }, { id: 5, active: true }]).join('\n');
  assert.ok(/\b5\b/.test(lines), `expected the duplicated id, got: ${lines}`);
  assert.ok(/more than one record|duplicate/i.test(lines), `expected it named as a duplicate, got: ${lines}`);
});

// The mirror of the `active` check. server.js reads isObserver both strictly (`!== true`) and as a
// truthy value, so a non-boolean makes the person an Observer for one gate and not for another --
// the same two-answers disease this whole change exists to end.
test('`isObserver` set to something that is not a boolean is reported', () => {
  const lines = describeRosterHealth([{ id: 11, active: true, isObserver: 'yes' }]).join('\n');
  assert.ok(/\b11\b/.test(lines), `expected id 11, got: ${lines}`);
  assert.ok(/isObserver/.test(lines), `expected the field named, got: ${lines}`);
});

// A row that is not an object was dropped silently, and the report then still said every record
// was fine -- a confident sentence about records it never looked at.
test('entries that are not records are counted, not quietly dropped', () => {
  const lines = describeRosterHealth([{ id: 1, active: true }, null, 'nope']).join('\n');
  assert.ok(/2 entr|not a record/i.test(lines), `expected the skipped entries named, got: ${lines}`);
  assert.ok(!/every record says/.test(lines),
    `must not claim the roster is clean when entries were skipped: ${lines}`);
});

// 2026-10-11 (review round 2): the hole left right next to the one just closed. This module read
// `isSystemAccount` truthily while the server's isSystemAccountUser() reads it strictly
// (`=== true || username === 'superadmin'`), so a record carrying `isSystemAccount: 1` was in no
// total, checked by none of the checks, and the clean line printed anyway -- the exact failure the
// "entries that are not records" check was added to end. The split is live, not theoretical:
// systemAccount.js treats such a record as a payroll employee while app.js's isEmployeeRecord
// hides it from every screen.
test('a non-boolean `isSystemAccount` is reported, and the record is still counted', () => {
  const lines = describeRosterHealth([{ id: 12, isSystemAccount: 1, active: true }]).join('\n');
  assert.ok(/\b12\b/.test(lines), `expected id 12, got: ${lines}`);
  assert.ok(/isSystemAccount/.test(lines), `expected the field named, got: ${lines}`);
  assert.ok(/\b1 records\b/.test(lines), `it must be counted like the server counts it, got: ${lines}`);
});

test('the system account is excluded the way the server excludes it, by username too', () => {
  // systemAccount.js:28 -- `isSystemAccount === true || username === 'superadmin'`.
  const lines = describeRosterHealth([{ id: 900001, username: 'superadmin', active: true }]).join('\n');
  assert.ok(!/900001/.test(lines), `the system account must not be listed, got: ${lines}`);
  assert.ok(/\b0 records\b/.test(lines), `and must not be counted, got: ${lines}`);
});

// data-files.js says "no .json files here" rather than reporting health on nothing. A roster with
// nobody in it has not been found clean; there was nothing to find.
test('a roster with no employee records says so instead of calling itself clean', () => {
  for (const input of [[], [{ id: 900001, isSystemAccount: true }]]) {
    const lines = describeRosterHealth(input).join('\n');
    assert.ok(!/every record says/.test(lines),
      `an empty roster is not a clean verdict: ${JSON.stringify(input)} -> ${lines}`);
    assert.ok(/no employee records/.test(lines), `expected it said so, got: ${lines}`);
  }
});

// Same promise the sibling data-files module makes: on Z: this runs against files the live backend
// is rewriting, and a status tool that throws mid-report hides every section after it.
test('it never throws, whatever it is handed', () => {
  // 2026-10-11 (review round 2): the list used to stop short of the two paths added with the
  // skipped-entry and duplicate-id checks -- an array inside the array, and an `id` that is not a
  // primitive. Those are exactly the shapes JSON.parse can hand over and nothing else covered.
  const bad = [null, undefined, 'nope', 42, {}, [null], [undefined], [{}],
    [[]], [[1, 2]], [{ id: {} }], [{ id: [1, 2] }], [{ id: null }, { id: null }],
    [{ id: 1 }, { id: '1' }], [{ active: 'x' }], [{ isObserver: {} }]];
  for (const input of bad) {
    assert.doesNotThrow(() => describeRosterHealth(input), `threw on ${JSON.stringify(input)}`);
  }
});

// Two records with no id at all do not share an id -- they have none, which the missing-flag line
// already names. Saying "1 id used by more than one record: id (no id)" sends someone looking for
// a collision that is not there.
test('records with no id are not reported as sharing one', () => {
  const lines = describeRosterHealth([{ active: true }, { active: true }]).join('\n');
  assert.ok(!/more than one record/.test(lines), `expected no duplicate claim, got: ${lines}`);
});

console.log(`  ${passed} passed`);
