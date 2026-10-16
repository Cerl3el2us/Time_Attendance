// Two Long Distance requests for one date must not both reach payroll (2026-10-16).
//
// POST /api/leaves refuses a second personal-car and a second holiday-work claim for a date the
// employee already has one on, each with a comment saying why: payroll would otherwise pay both
// once approved. long-distance had no such guard, although payroll counts RECORDS and not
// distinct dates, so two approved records for one day pay the allowance twice.
//
// The browser does refuse it -- canSubmitLongDistanceForDate() returns {ok:false,
// reason:"duplicate"}, confirmed on the live site while a request was pending -- so this was a
// missing second layer rather than an open door. The project's own rule is that the UI gate is
// never the only gate, and a page left open from before the first request was made is a trap this
// codebase has been bitten by before.
//
// The edit path matters as much as the create path: long-distance is in EDITABLE_LEAVE_TYPES, so
// without a guard there a driver could submit on a free date and then move it onto a date that
// already has one, which is the same duplicate by another road. hasActiveLongDistance() therefore
// takes an exceptId, exactly like hasActiveHolidayWork() and hasActiveOfficeOt() next to it.
// `node tests/long-distance-duplicate-guard.test.js`
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'attendance-server/backend/server.js'), 'utf8');

function extractFunction(src, name) {
  const re = new RegExp(`^function ${name}\\(`, 'm');
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

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok  ${name}`); }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; }
}

const sandbox = { console };
vm.createContext(sandbox);
vm.runInContext(['isVoidLeaveStatus', 'hasActiveLongDistance', 'hasActiveHolidayWork']
  .map(n => extractFunction(SRC, n)).join('\n'), sandbox);
const has = vm.runInContext('hasActiveLongDistance', sandbox);
const hasHw = vm.runInContext('hasActiveHolidayWork', sandbox);

const DATE = '2026-10-16';
const ld = o => Object.assign({ id: 1, userId: 7, type: 'long-distance', dateFrom: DATE, status: 'pending-accounting' }, o);

console.log('One date, one Long Distance claim');

test('a pending claim on that date counts', () => {
  assert.strictEqual(has([ld()], 7, DATE), true);
});

test('an approved claim on that date counts', () => {
  assert.strictEqual(has([ld({ status: 'approved' })], 7, DATE), true);
});

test('a cancelled or rejected claim does not -- resubmitting after a refusal must stay possible', () => {
  assert.strictEqual(has([ld({ status: 'cancelled' })], 7, DATE), false, 'cancelled');
  assert.strictEqual(has([ld({ status: 'rejected' })], 7, DATE), false, 'rejected');
});

test('another date, another employee, another type: none of them count', () => {
  assert.strictEqual(has([ld({ dateFrom: '2026-10-15' })], 7, DATE), false, 'other date');
  assert.strictEqual(has([ld({ userId: 8 })], 7, DATE), false, 'other employee');
  assert.strictEqual(has([ld({ type: 'upcountry' })], 7, DATE), false, 'other type');
});

test('exceptId excludes the record being edited, so saving it unchanged is not a duplicate', () => {
  assert.strictEqual(has([ld({ id: 41 })], 7, DATE, 41), false, 'the record must not block itself');
  assert.strictEqual(has([ld({ id: 41 }), ld({ id: 42 })], 7, DATE, 41), true, 'but a second one still blocks');
});

test('empty and missing lists are safe', () => {
  assert.strictEqual(has([], 7, DATE), false);
  assert.strictEqual(has(null, 7, DATE), false);
  assert.strictEqual(has(undefined, 7, DATE), false);
});

test('it answers the same shape of question as the holiday-work guard beside it', () => {
  // Same records, same dates, differing only in type: whichever type is asked about is the one
  // that answers true. A guard that quietly matched any claim type would pay here.
  const mixed = [ld({ id: 1 }), ld({ id: 2, type: 'holiday-work' })];
  assert.strictEqual(has(mixed, 7, DATE), true);
  assert.strictEqual(hasHw(mixed, 7, DATE), true);
  assert.strictEqual(has([ld({ type: 'holiday-work' })], 7, DATE), false,
    'a holiday-work claim must not count as a long-distance one');
});

console.log('\nBoth roads to a duplicate are closed');

// The create path and the edit path are different handlers. A guard on one only moves the
// duplicate to the other, so both are required to call it.
// These two handlers are tens of thousands of characters long, so the slice runs from the route
// to wherever the NEXT route is mounted rather than to a guessed offset -- a guessed span is how
// a guard ends up outside the window it was meant to be checked in, passing for the wrong reason.
function handlerBody(marker) {
  const i = SRC.indexOf(marker);
  assert.ok(i > 0, `could not find ${marker}`);
  const next = SRC.indexOf('\napp.', i + marker.length);
  assert.ok(next > i, `could not find the end of the handler at ${marker}`);
  return SRC.slice(i, next);
}

test('the create path refuses a second claim with a 409', () => {
  const post = handlerBody("app.post('/api/leaves'");
  assert.ok(/hasActiveLongDistance\(leaves, userId, body\.dateFrom\)/.test(post),
    'POST /api/leaves does not ask hasActiveLongDistance about the submitted date');
  assert.ok(/long distance request already exists/i.test(post),
    'the refusal does not explain itself the way the sibling guards do');
});

test('the edit path refuses moving a claim onto a date that already has one', () => {
  const put = handlerBody("app.put('/api/leaves/");
  assert.ok(/hasActiveLongDistance\(leaves, leave\.userId, .*leave\.id\)/.test(put),
    'PUT /api/leaves/:id does not ask hasActiveLongDistance, so a claim can be moved onto a taken date');
});

console.log(`\n${passed} passed, ${process.exitCode ? 'some failed' : '0 failed'}`);
