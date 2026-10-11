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

test('a roster where every record carries true or false reports clean', () => {
  // Four entries go in, three come back counted: the system account is not an employee record,
  // which the last test in this file pins separately.
  const lines = describeRosterHealth([ok1, ok2, observerGone, sysAccount]).join('\n');
  assert.ok(/3 records/.test(lines), `expected the count, got: ${lines}`);
  assert.ok(!/MISSING|never recorded/.test(lines), `expected no complaint, got: ${lines}`);
});

test('a record with no `active` key is named by id', () => {
  const noFlag = { id: 7 };
  const lines = describeRosterHealth([ok1, noFlag]).join('\n');
  assert.ok(/\b7\b/.test(lines), `expected id 7 in the report, got: ${lines}`);
  assert.ok(/active/.test(lines), `expected the field named, got: ${lines}`);
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

// Same promise the sibling data-files module makes: on Z: this runs against files the live backend
// is rewriting, and a status tool that throws mid-report hides every section after it.
test('it never throws, whatever it is handed', () => {
  for (const bad of [null, undefined, 'nope', 42, {}, [null], [undefined], [{}]]) {
    assert.doesNotThrow(() => describeRosterHealth(bad), `threw on ${JSON.stringify(bad)}`);
  }
});

console.log(`  ${passed} passed`);
