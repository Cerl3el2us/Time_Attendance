// Excused Attendance (2026-09-28): MD/Accounting forgive a late arrival or a whole missing day
// after a force-majeure event, per employee per date.
//
// The rule that matters, and the one this suite exists to pin down: a forgiven LATE day becomes
// 'present', NOT a new status. The work-day counters in both files are
// `present|late|not-clocked-in|abroad` -- daysWorked is printed on the payslip -- so inventing a
// status for the late case would erase the day of the employee who did come in through the flood.
// A day with no scan at all becomes 'excused' instead of 'absent', which is what drops it out of
// the absentDays counter.
//
// The decision block is extracted from BOTH app.js and server.js and executed, so these are
// behavioural assertions and the two copies are proven to decide identically (dual-sync rule).
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const APP_SRC = fs.readFileSync(path.join(ROOT, 'attendance/js/app.js'), 'utf8');
const SERVER_SRC = fs.readFileSync(path.join(ROOT, 'attendance-server/backend/server.js'), 'utf8');
// 2026-10-02: the business-day boundary is read out of the real source instead of repeating the
// number here, so moving it can never leave these sandboxes asserting against the old value.
const BUSINESS_DAY_START_MINS = Number(/const BUSINESS_DAY_START_MINS = (\d+);/.exec(APP_SRC)[1]);

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok ', name); }
  catch (e) { process.exitCode = 1; console.log('  FAIL', name, '\n      ', e.message); }
}

function extract(src, startMarker, endMarker) {
  const a = src.indexOf(startMarker);
  assert.ok(a > 0, 'not found: ' + startMarker);
  const b = src.indexOf(endMarker, a);
  assert.ok(b > a, 'end not found: ' + endMarker);
  return src.slice(a, b);
}

// Each side's block reads its own leave source (DATA_LEAVES in the browser, the `leaves` argument
// on the server), so each is wrapped with the name its own copy uses.
const APP_BLOCK = extract(APP_SRC, "let excused = false, excusedReason = '';", 'const holidayName =');
const SERVER_BLOCK = extract(SERVER_SRC, "let excused = false, excusedReason = '';", 'days.push({ date: dateStr,');

function compile(block, leavesVarName) {
  const sandbox = {};
  sandbox.BUSINESS_DAY_START_MINS = BUSINESS_DAY_START_MINS;
  vm.createContext(sandbox);
  vm.runInContext(
    `function decide(uid, isFuture, status, dateStr, ${leavesVarName}) {\n${block}\n` +
    '  return { excused, excusedReason, status };\n}', sandbox);
  return sandbox.decide;
}
const decideApp = compile(APP_BLOCK, 'DATA_LEAVES');
const decideServer = compile(SERVER_BLOCK, 'leaves');

const grant = (over = {}) => ({
  id: 1, userId: 7, type: 'excused', status: 'approved',
  dateFrom: '2026-09-28', dateTo: '2026-09-30', reason: 'flood at home', ...over,
});

// Runs the same case through both copies and asserts they agree, then returns the shared result.
// The results are re-spread into THIS realm first: a value returned from a vm context carries that
// context's Object.prototype, and deepStrictEqual compares prototypes, so comparing them directly
// fails on every case no matter how identical the values are.
function decide(args) {
  const { uid = 7, isFuture = false, status, dateStr = '2026-09-29', leaves = [grant()] } = args;
  const a = { ...decideApp(uid, isFuture, status, dateStr, leaves) };
  const s = { ...decideServer(uid, isFuture, status, dateStr, leaves) };
  assert.deepStrictEqual(a, s, 'app.js and server.js disagree (dual-sync broken)');
  return a;
}

console.log('Excused Attendance — the day-status decision');

test('a forgiven LATE day becomes present, never a new status', () => {
  const r = decide({ status: 'late' });
  assert.strictEqual(r.status, 'present');
  assert.strictEqual(r.excused, true);
});

test('a day with no scan becomes excused instead of absent', () => {
  const r = decide({ status: 'absent' });
  assert.strictEqual(r.status, 'excused');
  assert.strictEqual(r.excused, true);
});

test('the reason is carried onto the day for the badge', () => {
  assert.strictEqual(decide({ status: 'absent' }).excusedReason, 'flood at home');
});

test('a missing reason does not become the string "undefined"', () => {
  const r = decide({ status: 'absent', leaves: [grant({ reason: undefined })] });
  assert.strictEqual(r.excusedReason, '');
});

test('no grant at all leaves the day exactly as it was', () => {
  assert.deepStrictEqual(decide({ status: 'late', leaves: [] }),
    { excused: false, excusedReason: '', status: 'late' });
  assert.deepStrictEqual(decide({ status: 'absent', leaves: [] }),
    { excused: false, excusedReason: '', status: 'absent' });
});

test('an on-time day is never touched', () => {
  assert.deepStrictEqual(decide({ status: 'present' }),
    { excused: false, excusedReason: '', status: 'present' });
});

test('a leave / weekend / holiday / company-trip / abroad day is never overridden', () => {
  // These already count as neither late nor absent; an excuse must not rewrite them.
  ['leave-annual', 'leave-sick', 'leave-business', 'weekend', 'holiday', 'company-trip', 'abroad']
    .forEach(st => assert.deepStrictEqual(decide({ status: st }),
      { excused: false, excusedReason: '', status: st }, st));
});

test('a future date is never excused', () => {
  assert.deepStrictEqual(decide({ status: 'absent', isFuture: true }),
    { excused: false, excusedReason: '', status: 'absent' });
});

test('a grant for another employee does not leak across', () => {
  assert.strictEqual(decide({ uid: 8, status: 'late' }).excused, false);
});

test('only an APPROVED grant applies', () => {
  ['pending', 'pending-md', 'rejected', 'cancelled', 'revoked'].forEach(st => {
    assert.strictEqual(decide({ status: 'late', leaves: [grant({ status: st })] }).excused, false, st);
  });
});

test('the range is inclusive on both ends and excludes what is outside it', () => {
  assert.strictEqual(decide({ status: 'late', dateStr: '2026-09-28' }).excused, true, 'first day');
  assert.strictEqual(decide({ status: 'late', dateStr: '2026-09-30' }).excused, true, 'last day');
  assert.strictEqual(decide({ status: 'late', dateStr: '2026-09-27' }).excused, false, 'day before');
  assert.strictEqual(decide({ status: 'late', dateStr: '2026-10-01' }).excused, false, 'day after');
});

test('a single-day grant (no dateTo) covers that one day only', () => {
  const single = [grant({ dateTo: undefined })];
  assert.strictEqual(decide({ status: 'late', dateStr: '2026-09-28', leaves: single }).excused, true);
  assert.strictEqual(decide({ status: 'late', dateStr: '2026-09-29', leaves: single }).excused, false);
});

test('a non-excused leave type on the same date is ignored', () => {
  assert.strictEqual(decide({ status: 'absent',
    leaves: [grant({ type: 'annual' })] }).excused, false);
});

console.log('Excused Attendance — wiring that must stay in place');

test("'excused' is registered as a leave type on the server", () => {
  // VALID_LEAVE_TYPES is built from Object.keys(TYPE_SCOPED_LEAVE_FIELDS), so the key IS the
  // registration -- without it every POST is rejected as an unknown request type.
  assert.ok(/^\s*excused:\s*\[\],/m.test(SERVER_SRC), 'excused missing from TYPE_SCOPED_LEAVE_FIELDS');
});

test('a mistaken grant can be taken back', () => {
  // The DELETE route is owner-only and the record belongs to the employee, so revoke is the only
  // way MD/Accounting can undo a wrong person or a wrong date.
  const fn = extract(SERVER_SRC, 'function isRevocableLeaveType(', '}');
  assert.ok(fn.includes("'excused'"), 'excused is not revocable -- a wrong grant would be permanent');
});

test('the leave-return scan sits BELOW the leaves read (TDZ)', () => {
  // This block iterates `leaves`, which POST /api/leaves declares with `const` partway through the
  // handler. Placed above that declaration it is a TDZ ReferenceError on EVERY excused grant --
  // a 500 for the whole feature -- and both `node --check` and ESLint pass on it happily. The same
  // trap already bit the abroad check in this handler once, which is why it is pinned here.
  const handler = SERVER_SRC.slice(SERVER_SRC.indexOf("app.post('/api/leaves'"));
  const readIdx = handler.indexOf('const leaves = readLeaves();');
  const scanIdx = handler.indexOf('const excusedReturns = [];');
  assert.ok(readIdx > 0 && scanIdx > 0, 'markers not found');
  assert.ok(scanIdx > readIdx,
    'the excused leave-return scan must come after `const leaves = readLeaves()` or every grant throws');
});

test('granting is refused for anyone but MD/Accounting, and needs a reason', () => {
  assert.ok(SERVER_SRC.includes("const isExcusedGrant = type === 'excused' && (['md', 'accounting'].includes(live.role)"),
    'role gate missing');
  assert.ok(/reason is required for excused attendance/.test(SERVER_SRC), 'reason not required');
});

test('the work-day counters still count a present day (the regression this design avoids)', () => {
  // If a future change makes the forgiven-late case its own status, these filters stop counting it
  // and the employee loses the day on their own payslip.
  const appCount = (APP_SRC.match(/d\.status === 'present' \|\| d\.status === 'late'/g) || []).length;
  assert.ok(appCount >= 3, `expected the present|late work-day filters to still exist, found ${appCount}`);
  assert.ok(SERVER_SRC.includes("d.status === 'present' || d.status === 'late'"),
    'server work-day filter changed shape -- re-check the excused design');
});

test('the excused badge is not styled as a failure', () => {
  const entry = extract(APP_SRC, '    excused: `<span class="badge', '`,');
  assert.ok(entry.includes('badge-info'), 'excused should read as information, not danger');
  assert.ok(!entry.includes('badge-danger'), 'excused must not look like an absence');
});

console.log(`\n${passed} passed`);
