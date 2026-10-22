// Rejection reason (2026-10-22, owner): rejecting a request must carry a reason.
//
// What the owner asked for: when an approver presses reject, they say WHY; the employee gets that
// reason in the notification and can read it back later from their own request history. Before
// this, a rejected record carried only `approver` and `approvedAt` -- who and when, never why.
//
// The rules this suite pins down, because both sides must agree or the employee is told one thing
// and the server stores another:
//   - the reason is REQUIRED (owner's decision 2026-10-22): blank, spaces-only or missing is a
//     refusal, not an empty reason;
//   - `rejectReason` is accepted ONLY on a rejection. Sent with an approval it is an error, never
//     silently dropped -- a dropped key would look to the approver like it was saved;
//   - normalization is identical in app.js and server.js (DUAL-SYNC), so the client cannot show
//     "too long" while the server accepts, or trim differently than the server stores.
//
// Both implementations are extracted from the real sources and executed, so this is behavioural:
// a copy that drifts goes red here, not in production.
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const APP_SRC = fs.readFileSync(path.join(ROOT, 'attendance/js/app.js'), 'utf8');
const SERVER_SRC = fs.readFileSync(path.join(ROOT, 'attendance-server/backend/server.js'), 'utf8');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok ', name); }
  catch (e) { process.exitCode = 1; console.log('  FAIL', name, '\n      ', e.message); }
}

// A top-level function, sliced from `function <name>(` to the first line that is exactly `}`.
// Only used for functions whose bodies have no closing brace in column 1, which is true of every
// function taken here (checked by the assertions below: a wrong slice throws on evaluation).
function topLevelFn(src, name, where) {
  const a = src.indexOf(`function ${name}(`);
  assert.ok(a > 0, `${where}: function ${name} not found`);
  const b = src.indexOf('\n}', a);
  assert.ok(b > a, `${where}: end of ${name} not found`);
  return src.slice(a, b + 2);
}
function constOf(src, name, where) {
  const m = new RegExp("const " + name + " = ([0-9]+);").exec(src);
  assert.ok(m, `${where}: const ${name} not found`);
  return Number(m[1]);
}

const APP_MAX = constOf(APP_SRC, 'REJECT_REASON_MAX', 'app.js');
const SERVER_MAX = constOf(SERVER_SRC, 'REJECT_REASON_MAX', 'server.js');

function sandbox(code) {
  const ctx = { assert };
  vm.createContext(ctx);
  vm.runInContext(code, ctx);
  return ctx;
}
const appNorm = sandbox(topLevelFn(APP_SRC, 'normalizeRejectReason', 'app.js')).normalizeRejectReason;
const srvNorm = sandbox(topLevelFn(SERVER_SRC, 'normalizeRejectReason', 'server.js')).normalizeRejectReason;
const srvValidate = sandbox(
  `const REJECT_REASON_MAX = ${SERVER_MAX};\n`
  + topLevelFn(SERVER_SRC, 'normalizeRejectReason', 'server.js')
  + topLevelFn(SERVER_SRC, 'validateRejectReason', 'server.js')
).validateRejectReason;

test('the length cap is one number, the same on both sides', () => {
  assert.strictEqual(APP_MAX, SERVER_MAX, `app.js ${APP_MAX} vs server.js ${SERVER_MAX}`);
  assert.ok(SERVER_MAX >= 100, `a cap of ${SERVER_MAX} is too short for a real reason`);
});

test('normalization decides identically in app.js and server.js, for every shape', () => {
  const samples = [
    'งบประมาณไม่พอในรอบนี้',
    '  เว้นหน้าและหลัง  ',
    '',
    '     ',
    'บรรทัดแรก\nบรรทัดสอง',
    // the BELL that a heredoc once smuggled into this project's own files
    'ก่อน\u0007หลัง',
    '\u0000\u001f',
    'x'.repeat(SERVER_MAX + 50),
    'tab\there',
  ];
  for (const s of samples) {
    assert.strictEqual(appNorm(s), srvNorm(s), `disagree on ${JSON.stringify(s)}`);
  }
  // a non-string from a hand-made request body must not throw on either side
  for (const s of [undefined, null, 123, {}, []]) {
    assert.strictEqual(appNorm(s), srvNorm(s), `disagree on ${JSON.stringify(s)}`);
    assert.strictEqual(srvNorm(s), '', `${JSON.stringify(s)} should normalize to the empty string`);
  }
});

test('normalization keeps the text, drops control characters, trims the ends', () => {
  assert.strictEqual(srvNorm('  งบไม่พอ  '), 'งบไม่พอ');
  assert.strictEqual(srvNorm('ก่อน\u0007หลัง'), 'ก่อนหลัง');
  assert.strictEqual(srvNorm('บรรทัดแรก\nบรรทัดสอง'), 'บรรทัดแรก\nบรรทัดสอง');
  assert.strictEqual(srvNorm('     '), '');
});

test('a rejection without a usable reason is refused, never stored as an empty reason', () => {
  for (const raw of [undefined, null, '', '   ', '\u0007\u0007', 123]) {
    const r = srvValidate('rejected', raw);
    assert.ok(r.error, `${JSON.stringify(raw)} was accepted: ${JSON.stringify(r)}`);
    assert.strictEqual(r.value, undefined, `${JSON.stringify(raw)} produced a value`);
  }
});

test('a rejection with a reason stores the normalized text', () => {
  const r = srvValidate('rejected', '  วันนั้นมีงานด่วนอยู่แล้ว  ');
  assert.ok(!r.error, JSON.stringify(r));
  assert.strictEqual(r.value, 'วันนั้นมีงานด่วนอยู่แล้ว');
});

test('the cap is enforced on the normalized text, at the boundary', () => {
  const atCap = srvValidate('rejected', 'x'.repeat(SERVER_MAX));
  assert.ok(!atCap.error, `exactly ${SERVER_MAX} characters must be accepted: ${JSON.stringify(atCap)}`);
  const over = srvValidate('rejected', 'x'.repeat(SERVER_MAX + 1));
  assert.ok(over.error, `${SERVER_MAX + 1} characters must be refused`);
  // padding does not push a legal reason over the cap, because the ends are trimmed first
  const padded = srvValidate('rejected', '   ' + 'x'.repeat(SERVER_MAX) + '   ');
  assert.ok(!padded.error, JSON.stringify(padded));
});

test('rejectReason is accepted only on a rejection, and is never silently dropped', () => {
  for (const status of ['approved', 'pending', 'pending-md', 'cancelled']) {
    const r = srvValidate(status, 'เหตุผลที่ไม่ควรถูกเก็บ');
    assert.ok(r.error, `${status} accepted a rejectReason: ${JSON.stringify(r)}`);
  }
  // and an approval that sends nothing is fine, with no value to store
  const ok = srvValidate('approved', undefined);
  assert.ok(!ok.error, JSON.stringify(ok));
  assert.strictEqual(ok.value, undefined);
});

test('rejectReason can never be set by the submitter: it is a server-controlled field', () => {
  const m = /const SERVER_LEAVE_FIELDS = \[([^\]]*)\]/.exec(SERVER_SRC);
  assert.ok(m, 'SERVER_LEAVE_FIELDS not found');
  assert.ok(m[1].includes("'rejectReason'"), `not in SERVER_LEAVE_FIELDS: ${m[1]}`);
  // ... and it is not reachable through the universal or the type-scoped client lists
  const uni = /const UNIVERSAL_LEAVE_FIELDS = \[([^\]]*)\]/.exec(SERVER_SRC);
  assert.ok(uni && !uni[1].includes('rejectReason'), 'rejectReason must not be client-settable');
});

console.log(`reject-reason: ${passed} passed`);
