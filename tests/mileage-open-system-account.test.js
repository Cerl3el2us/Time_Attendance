// The system account may READ its own (always empty) saved starting mileages, and still may not
// WRITE one. Found 2026-10-19 while sweeting role coverage from the superadmin account: every
// superadmin page load logged `[APP] loadMileageOpenFromBackend error: HTTP 403`, because
// mileageOpenActor() guarded all three handlers with a refusal written for a write ("System
// account cannot save a starting mileage"). Nothing broke -- the caller swallows the error and
// leaves the map empty, which is the right end state for a non-employee -- but the console of the
// one account QA is done from carried a permanent error, and on 2026-10-17 a real WebSocket bug
// went unexamined all day behind that kind of noise.
//
// The handlers are read out of the real server.js and run in a sandbox, like the other backend
// tests here, so this cannot pass against a copy that has drifted from what ships.
// `node tests/mileage-open-system-account.test.js`
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'attendance-server/backend/server.js'), 'utf8');

function extractFunction(src, name) {
  const m = new RegExp(`^function ${name}\\(`, 'm').exec(src);
  if (!m) throw new Error(`function ${name} not found`);
  const i = src.indexOf('{', m.index);
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (depth === 0) return src.slice(m.index, j + 1); }
  }
  throw new Error(`unbalanced ${name}`);
}

const SYSTEM = { id: 900001, username: 'superadmin', role: 'superadmin', isSystemAccount: true };
const DRIVER = { id: 10, username: 'jaraspong', role: 'driver', employeeNo: 9 };

// `stored` is what mileage-open.json holds. The driver has a saved start; the system account
// never can, which is the whole point -- its own rows are empty whatever the file contains.
function makeCtx(stored) {
  const sent = { status: 200, body: null };
  const res = {
    status(c) { sent.status = c; return this; },
    json(b) { sent.body = b; return this; },
  };
  const ctx = {
    console, Buffer, JSON, Number, Object, Array, Date, String,
    MILEAGE_OPEN_FILE: 'mileage-open.json',
    MILEAGE_OPEN_UNAVAILABLE: 'Service temporarily unavailable',
    readUsers: () => [SYSTEM, DRIVER],
    isSuperAdminUser: u => u.role === 'superadmin' && u.isSystemAccount === true,
    readMileageOpen: () => stored,
    writeJSON: () => {},
    getAppSettings: () => ({ allowanceEligibility: {} }),
    isAllowanceEligible: () => true,
    attendanceDayForUser: () => ({ date: '2026-10-19', checkIn: '07:00' }),
    readLeaves: () => [],
    isVoidLeaveStatus: s => s === 'cancelled' || s === 'rejected',
  };
  vm.createContext(ctx);
  vm.runInContext(SRC.match(/^const DATE_RE = .*$/m)[0], ctx);
  const names = ['parseBody', 'isValidDateStr', 'isFiniteNonNegNumber', 'mileageOpenSaveError',
    'mileageOpenKey', 'mileageOpenOwnRows', 'mileageOpenActor',
    'handleGetMileageOpen', 'handlePutMileageOpen', 'handleDeleteMileageOpen'];
  vm.runInContext(names.map(n => extractFunction(SRC, n)).join('\n'), ctx);
  return { ctx, res, sent };
}

const rawReq = (userId, payload) => ({
  headers: { 'content-type': 'application/json' },
  body: Buffer.from(JSON.stringify(payload || {}), 'utf8'),
  user: { sub: userId },
  query: {},
});

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok  ${name}`); }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; }
}

const STORED = { '10_2026-10-19': { userId: 10, date: '2026-10-19', mileageStart: 1200 } };

// ---------------------------------------------------------------------------------------------

test('the system account can READ, and gets an empty map rather than a 403', () => {
  const { ctx, res, sent } = makeCtx(STORED);
  ctx.handleGetMileageOpen(rawReq(SYSTEM.id), res);
  assert.strictEqual(sent.status, 200,
    'GET answered ' + sent.status + ' for the system account — the write guard is still on the read, '
    + 'so every superadmin page load logs a console error');
  assert.strictEqual(sent.body.success, true);
  // Object.keys(), not deepStrictEqual({}): the payload is built inside the vm sandbox, so its
  // prototype is that realm's Object.prototype and a strict deep-equal against this realm's {}
  // fails on the prototype alone, however empty the object is.
  assert.strictEqual(Object.keys(sent.body.open).length, 0,
    'the system account owns no rows, so its map must be empty');
});

test('the system account still may NOT write or delete one', () => {
  for (const handler of ['handlePutMileageOpen', 'handleDeleteMileageOpen']) {
    const { ctx, res, sent } = makeCtx(STORED);
    ctx[handler](rawReq(SYSTEM.id, { date: '2026-10-19', mileageStart: 50 }), res);
    assert.strictEqual(sent.status, 403, `${handler} must refuse the system account`);
    assert.match(String(sent.body.message), /System account/,
      `${handler} should say why it refused`);
  }
});

test('a real employee still reads only their own rows', () => {
  const { ctx, res, sent } = makeCtx(STORED);
  ctx.handleGetMileageOpen(rawReq(DRIVER.id), res);
  assert.strictEqual(sent.status, 200);
  assert.deepStrictEqual(Object.keys(sent.body.open), ['10_2026-10-19'],
    'the driver should see their own saved start and nothing else');
});

test('an unknown subject is still refused, read or write', () => {
  const { ctx, res, sent } = makeCtx(STORED);
  ctx.handleGetMileageOpen(rawReq(4242), res);
  assert.strictEqual(sent.status, 403, 'a token for a user who no longer exists must not read');
});

console.log(`mileage-open-system-account: ${passed} passed`);
