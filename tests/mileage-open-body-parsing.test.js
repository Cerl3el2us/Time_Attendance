// The two-step mileage endpoints must read the body the way this server delivers it (2026-10-16).
//
// server.js mounts `express.raw({ type: '*/*', limit: '10mb' })`, so req.body is ALWAYS a Buffer.
// Every route in the file reads its payload through parseBody(). The three handlers added for the
// two-step Long Distance mileage read `req.body.date` / `req.body.mileageStart` directly, which on
// a Buffer is undefined -- so PUT and DELETE answered 400 "date must be a valid YYYY-MM-DD date"
// for every request ever made to them. The feature could not work at all, and nothing caught it:
// the branch was verified against a static harness with no backend, so the only calls these
// endpoints had ever seen were 401 probes, which never reach the body at all.
//
// This file calls the REAL handlers with the kind of request express.raw() actually hands them --
// a Buffer and a content-type header -- and requires them to succeed. A handler that goes back to
// reading req.body directly fails here immediately, because a Buffer has no `.date`.
// `node tests/mileage-open-body-parsing.test.js`
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

const LIVE = { id: 7, role: 'driver' };

// A world the save is allowed in: eligible, checked in, no request yet for that date.
function makeCtx(over) {
  const o = Object.assign({ stored: {}, day: { date: '2026-10-16', checkIn: '06:58' }, leaves: [] }, over);
  const written = {};
  const ctx = {
    console, Buffer, JSON, Number, Object, Array, Date, String,
    MILEAGE_OPEN_FILE: 'mileage-open.json',
    MILEAGE_OPEN_UNAVAILABLE: 'Service temporarily unavailable',
    // Stubbed: the actor check has its own guards and its own reasons to fail; this file is about
    // the body, so the caller is simply present and allowed.
    mileageOpenActor: () => LIVE,
    readMileageOpen: () => o.stored,
    writeJSON: (file, data) => { written.file = file; written.data = data; },
    getAppSettings: () => ({ allowanceEligibility: {} }),
    isAllowanceEligible: () => true,
    attendanceDayForUser: () => o.day,
    readLeaves: () => o.leaves,
    isVoidLeaveStatus: s => s === 'cancelled' || s === 'rejected',
  };
  vm.createContext(ctx);
  // isValidDateStr() closes over DATE_RE, a module-level const rather than a function -- evaluate
  // its real declaration so the sandbox can never hold a stale copy of the shape it checks.
  vm.runInContext(SRC.match(/^const DATE_RE = .*$/m)[0], ctx);
  const names = ['parseBody', 'isValidDateStr', 'isFiniteNonNegNumber', 'mileageOpenSaveError',
    'mileageOpenKey', 'mileageOpenOwnRows', 'handleGetMileageOpen', 'handlePutMileageOpen',
    'handleDeleteMileageOpen'];
  vm.runInContext(names.map(n => extractFunction(SRC, n)).join('\n'), ctx);
  return { ctx, written };
}

// Exactly what express.raw({ type: '*/*' }) hands a handler: a Buffer, plus the content-type.
function rawReq(payload) {
  return {
    headers: { 'content-type': 'application/json' },
    body: Buffer.from(JSON.stringify(payload), 'utf8'),
    user: { sub: LIVE.id },
  };
}
function fakeRes() {
  const out = { code: 200 };
  return {
    status(c) { out.code = c; return this; },
    json(b) { out.body = b; return out; },
    get result() { return out; },
    out,
  };
}
function call(handler, ctx, req) {
  const res = fakeRes();
  ctx[handler](req, res);
  return res.out;
}

console.log('The mileage endpoints read the body express.raw actually gives them');

test('PUT accepts a raw Buffer body and saves the start', () => {
  const { ctx, written } = makeCtx();
  const out = call('handlePutMileageOpen', ctx, rawReq({ date: '2026-10-16', mileageStart: 120000 }));
  assert.strictEqual(out.code, 200, `expected 200, got ${out.code}: ${out.body && out.body.message}`);
  assert.strictEqual(out.body.success, true);
  assert.strictEqual(written.file, 'mileage-open.json', 'nothing was written');
  assert.strictEqual(written.data['7_2026-10-16'].mileageStart, 120000);
  assert.ok(written.data['7_2026-10-16'].savedAt, 'the saved-at stamp the note reads is missing');
});

test('the exact regression: a valid date in the body is never called invalid', () => {
  const { ctx } = makeCtx();
  const out = call('handlePutMileageOpen', ctx, rawReq({ date: '2026-10-16', mileageStart: 1 }));
  assert.notStrictEqual(out.code, 400,
    'the handler is reading req.body directly again -- a Buffer has no .date, so every save 400s');
  assert.ok(!(out.body && /valid YYYY-MM-DD/.test(out.body.message || '')),
    'the body never reached the validator');
});

test('DELETE accepts a raw Buffer body and removes that date only', () => {
  const { ctx, written } = makeCtx({ stored: { '7_2026-10-16': { mileageStart: 1 }, '7_2026-10-15': { mileageStart: 2 } } });
  const out = call('handleDeleteMileageOpen', ctx, rawReq({ date: '2026-10-16' }));
  assert.strictEqual(out.code, 200, `expected 200, got ${out.code}: ${out.body && out.body.message}`);
  assert.deepStrictEqual(Object.keys(written.data), ['7_2026-10-15'], 'the wrong rows survived');
});

test('validation still bites through the Buffer: a bad date and a bad number are refused', () => {
  const { ctx } = makeCtx();
  const bad = call('handlePutMileageOpen', ctx, rawReq({ date: '2026-13-45', mileageStart: 1 }));
  assert.strictEqual(bad.code, 400, 'an impossible date must still be refused');
  const neg = call('handlePutMileageOpen', ctx, rawReq({ date: '2026-10-16', mileageStart: -5 }));
  assert.strictEqual(neg.code, 400, 'a negative mileage must still be refused');
});

test('the three business refusals still apply, read from the parsed body', () => {
  const noCheckIn = makeCtx({ day: null });
  assert.strictEqual(call('handlePutMileageOpen', noCheckIn.ctx, rawReq({ date: '2026-10-16', mileageStart: 1 })).code, 400,
    'a day with no check-in must refuse the save');
  const already = makeCtx({ leaves: [{ userId: LIVE.id, type: 'long-distance', dateFrom: '2026-10-16', status: 'pending' }] });
  assert.strictEqual(call('handlePutMileageOpen', already.ctx, rawReq({ date: '2026-10-16', mileageStart: 1 })).code, 409,
    'a date that already has a request must refuse the save');
});

test('no mileage handler reads req.body directly any more', () => {
  const code = ['handleGetMileageOpen', 'handlePutMileageOpen', 'handleDeleteMileageOpen']
    .map(n => extractFunction(SRC, n))
    .join('\n')
    // Strip comments, whole-line and trailing alike: the comments in these handlers explain the
    // bug and name req.body on purpose, and a guard that cannot tell code from prose is the kind
    // of guard that passes while the bug is back.
    .replace(/\/\/[^\n]*/g, '')
    ;
  assert.ok(!/req\.body/.test(code),
    'req.body is a Buffer in this server -- read the payload through parseBody(req)');
});

console.log(`\n${passed} passed, ${process.exitCode ? 'some failed' : '0 failed'}`);
