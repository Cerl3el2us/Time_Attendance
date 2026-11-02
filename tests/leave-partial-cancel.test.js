// Partial cancellation of an approved leave (2026-11-02, owner's request): an employee may give
// back the days of an approved annual/sick/business leave that have not arrived yet. The record's
// dateTo shrinks and the cancelled tail becomes its own 'cancelled' row (cancelledWith -> the
// original). No framework: `node tests/leave-partial-cancel.test.js`. Same extraction approach as
// tests/cancel-revoke.test.js: real functions from both sources in a vm sandbox.
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
  const i = src.indexOf(') {', m.index) + 2;
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (depth === 0) return src.slice(m.index, j + 1); }
  }
  throw new Error(`unbalanced ${name}`);
}

// 2026-11-02: one public holiday inside the window on purpose -- a plain weekday count would
// pass every assertion below without ever exercising the holiday skip.
const HOLIDAYS = new Set(['2026-11-04']);
const localDateStr = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

function makeClientDays() {
  const ctx = { isPublicHoliday: s => HOLIDAYS.has(s), localDateStr };
  vm.createContext(ctx);
  vm.runInContext(extractFunction(APP_SRC, 'deriveLeaveDaysCount'), ctx);
  return ctx;
}
function makeServerDays() {
  const ctx = { isPublicHoliday: s => HOLIDAYS.has(s), ta_localDateStr: localDateStr };
  vm.createContext(ctx);
  vm.runInContext(extractFunction(SERVER_SRC, 'deriveLeaveDaysCount'), ctx);
  return ctx;
}

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok  ${name}`); }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; }
}

console.log('day counter: one function, both sides');
test('client and server count the same working days for every range', () => {
  const C = makeClientDays(), S = makeServerDays();
  const ranges = [
    ['2026-10-30', '2026-11-05'],  // Fri..Thu, spans a weekend and the 04 holiday
    ['2026-10-30', '2026-11-02'],  // the kept half of the owner's real case
    ['2026-11-03', '2026-11-05'],  // the cancelled half
    ['2026-10-31', '2026-11-01'],  // Sat..Sun only -> 0
    ['2026-11-04', '2026-11-04'],  // the holiday alone -> 0
    ['2026-11-03', '2026-11-03'],  // a single plain weekday -> 1
  ];
  for (const [from, to] of ranges) {
    assert.strictEqual(C.deriveLeaveDaysCount(from, to), S.deriveLeaveDaysCount(from, to), `${from}..${to}`);
  }
});
test('expected counts (weekend and the 04 holiday both skipped)', () => {
  const C = makeClientDays();
  assert.strictEqual(C.deriveLeaveDaysCount('2026-10-30', '2026-11-05'), 4); // 30, 02, 03, 05
  assert.strictEqual(C.deriveLeaveDaysCount('2026-10-30', '2026-11-02'), 2); // 30, 02
  assert.strictEqual(C.deriveLeaveDaysCount('2026-11-03', '2026-11-05'), 2); // 03, 05
  assert.strictEqual(C.deriveLeaveDaysCount('2026-10-31', '2026-11-01'), 0);
  assert.strictEqual(C.deriveLeaveDaysCount('2026-11-04', '2026-11-04'), 0);
});
test('a missing dateTo counts the single dateFrom', () => {
  const C = makeClientDays();
  assert.strictEqual(C.deriveLeaveDaysCount('2026-11-03', ''), 1);
  assert.strictEqual(C.deriveLeaveDaysCount('2026-11-03', undefined), 1);
});
test('submitLeave() uses the helper instead of keeping its own copy of the loop', () => {
  const i = APP_SRC.indexOf('async function submitLeave()');
  assert.ok(i > 0, 'submitLeave not found');
  const body = APP_SRC.slice(i, APP_SRC.indexOf('\nasync function ', i + 10));
  assert.ok(body.includes('deriveLeaveDaysCount('), 'submitLeave must call the shared helper');
  assert.ok(!/while \(d <= end\)/.test(body), 'the inline day-count loop must be gone from submitLeave');
});

console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ', 0 failed'}`);
