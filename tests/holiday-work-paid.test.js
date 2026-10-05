// Holiday Work "paid" compensation permission (2026-10-05).
// Spec: docs/superpowers/specs/2026-10-05-holiday-work-manager-paid-design.md
//
// Follows the house pattern: the functions are extracted from the real sources and evaluated in a
// vm sandbox, so this also proves the two DUAL-SYNC copies agree instead of testing a hand-copied
// twin that can drift.
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
  let i = src.indexOf('{', m.index);
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (depth === 0) return src.slice(m.index, j + 1); }
  }
  throw new Error(`unbalanced ${name}`);
}
function extractConst(src, name) {
  const re = new RegExp(`^const ${name} = \\{`, 'm');
  const m = re.exec(src);
  if (!m) throw new Error(`const ${name} not found`);
  let i = src.indexOf('{', m.index);
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (depth === 0) return src.slice(m.index, j + 1) + ';'; }
  }
  throw new Error(`unbalanced ${name}`);
}

const FNS = ['isAllowanceEligible', 'mayChoosePaidHolidayWork'];
function sandbox(src) {
  const ctx = { console };
  vm.createContext(ctx);
  // extractConst() already returns the whole `const NAME = {...};` declaration.
  vm.runInContext(extractConst(src, 'DEFAULT_ALLOWANCE_ELIGIBILITY'), ctx);
  FNS.forEach(n => vm.runInContext(extractFunction(src, n), ctx));
  return ctx;
}
const CLIENT = sandbox(APP_SRC);
const SERVER = sandbox(SERVER_SRC);

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok  ${name}`); }
  catch (e) { process.exitCode = 1; console.log(`  FAIL  ${name}\n        ${e.message}`); }
}
// Asserts both copies answer the same, and returns that answer.
function both(cfg, role) {
  const c = CLIENT.mayChoosePaidHolidayWork(cfg, role);
  const s = SERVER.mayChoosePaidHolidayWork(cfg, role);
  assert.strictEqual(c, s, `client/server disagree for role ${role}`);
  return c;
}

console.log('Holiday Work: who may choose the paid compensation mode');

test('both lists include the role -> true', () => {
  const cfg = { holidayWork: ['user', 'manager'], holidayWorkPaid: ['user'] };
  assert.strictEqual(both(cfg, 'user'), true);
});
test('may file but not paid -> false (the manager case this was built for)', () => {
  const cfg = { holidayWork: ['user', 'manager'], holidayWorkPaid: ['user'] };
  assert.strictEqual(both(cfg, 'manager'), false);
});
test('paid ticked without its parent grants nothing', () => {
  const cfg = { holidayWork: ['user'], holidayWorkPaid: ['user', 'manager'] };
  assert.strictEqual(both(cfg, 'manager'), false);
});
test('neither list mentions the role -> false', () => {
  const cfg = { holidayWork: ['user'], holidayWorkPaid: ['user'] };
  assert.strictEqual(both(cfg, 'driver'), false);
});
test('missing holidayWorkPaid key falls back to the default, never throws', () => {
  const cfg = { holidayWork: ['user', 'manager'] };
  assert.strictEqual(typeof both(cfg, 'user'), 'boolean');
  assert.strictEqual(typeof both(cfg, 'manager'), 'boolean');
});
test('no config at all falls back to the defaults on both sides', () => {
  assert.strictEqual(typeof both(undefined, 'user'), 'boolean');
});
test('the shipped defaults let user take the money and keep manager off it', () => {
  assert.strictEqual(both(undefined, 'user'), true);
  assert.strictEqual(both(undefined, 'manager'), false);
});

console.log('\nServer: refusing a paid request from a role without the permission');

vm.runInContext(extractFunction(SERVER_SRC, 'paidHolidayWorkBlockReason'), SERVER);
const S = { allowanceEligibility: { holidayWork: ['user', 'manager'], holidayWorkPaid: ['user'] } };

test('manager asking for paid is refused', () => {
  const r = SERVER.paidHolidayWorkBlockReason(S, { role: 'manager' }, 'paid');
  assert.ok(typeof r === 'string' && r.length > 0, 'expected a refusal message, got ' + JSON.stringify(r));
});
test('manager asking for the annual-leave day is accepted', () => {
  assert.strictEqual(SERVER.paidHolidayWorkBlockReason(S, { role: 'manager' }, 'annual-leave'), null);
});
test('user asking for paid is accepted', () => {
  assert.strictEqual(SERVER.paidHolidayWorkBlockReason(S, { role: 'user' }, 'paid'), null);
});
test('an absent compensationMode is not this check\'s business', () => {
  assert.strictEqual(SERVER.paidHolidayWorkBlockReason(S, { role: 'manager' }, undefined), null);
});
test('a missing user or settings object does not throw', () => {
  assert.strictEqual(typeof SERVER.paidHolidayWorkBlockReason(undefined, undefined, 'paid'), 'string');
});

console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ', 0 failed'}`);
