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

const FNS = ['isAllowanceEligible', 'mayChooseHolidayWorkMode', 'holidayWorkModesFor'];
function sandbox(src) {
  const ctx = { console };
  vm.createContext(ctx);
  // extractConst() already returns the whole `const NAME = {...};` declaration.
  vm.runInContext(extractConst(src, 'DEFAULT_ALLOWANCE_ELIGIBILITY'), ctx);
  vm.runInContext(extractConst(src, 'HOLIDAY_WORK_MODE_KEYS'), ctx);
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
function both(cfg, role, mode = 'paid') {
  const c = CLIENT.mayChooseHolidayWorkMode(cfg, role, mode);
  const s = SERVER.mayChooseHolidayWorkMode(cfg, role, mode);
  assert.strictEqual(c, s, `client/server disagree for role ${role} mode ${mode}`);
  return c;
}
// The two sandboxes are separate vm realms, so their Arrays have different prototypes and
// deepStrictEqual would fail on that alone. Compare the contents, and hand back a plain array
// belonging to THIS realm so the callers' own deepStrictEqual works too.
function modesBoth(cfg, role) {
  const c = [...CLIENT.holidayWorkModesFor(cfg, role)];
  const s = [...SERVER.holidayWorkModesFor(cfg, role)];
  assert.deepStrictEqual(c, s, `client/server disagree on modes for ${role}`);
  return c;
}

console.log('Holiday Work: who may choose the paid compensation mode');

test('both lists include the role -> true', () => {
  const cfg = { holidayWork: ['user', 'manager'], holidayWorkLeave: ['user', 'manager'], holidayWorkPaid: ['user'] };
  assert.strictEqual(both(cfg, 'user'), true);
});
test('may file but not paid -> false (the manager case this was built for)', () => {
  const cfg = { holidayWork: ['user', 'manager'], holidayWorkLeave: ['user', 'manager'], holidayWorkPaid: ['user'] };
  assert.strictEqual(both(cfg, 'manager'), false);
});
test('paid ticked without its parent grants nothing', () => {
  const cfg = { holidayWork: ['user'], holidayWorkLeave: ['user'], holidayWorkPaid: ['user', 'manager'] };
  assert.strictEqual(both(cfg, 'manager'), false);
});
test('neither list mentions the role -> false', () => {
  const cfg = { holidayWork: ['user'], holidayWorkLeave: ['user'], holidayWorkPaid: ['user'] };
  assert.strictEqual(both(cfg, 'driver'), false);
});
test('missing holidayWorkPaid key falls back to the default, never throws', () => {
  const cfg = { holidayWork: ['user', 'manager'] };  // no mode keys at all -> defaults
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

vm.runInContext(extractFunction(SERVER_SRC, 'holidayWorkModeBlockReason'), SERVER);
const S = { allowanceEligibility: { holidayWork: ['user', 'manager'], holidayWorkLeave: ['user', 'manager'], holidayWorkPaid: ['user'] } };

test('manager asking for paid is refused', () => {
  const r = SERVER.holidayWorkModeBlockReason(S, { role: 'manager' }, 'paid');
  assert.ok(typeof r === 'string' && r.length > 0, 'expected a refusal message, got ' + JSON.stringify(r));
});
test('manager asking for the annual-leave day is accepted', () => {
  assert.strictEqual(SERVER.holidayWorkModeBlockReason(S, { role: 'manager' }, 'annual-leave'), null);
});
test('user asking for paid is accepted', () => {
  assert.strictEqual(SERVER.holidayWorkModeBlockReason(S, { role: 'user' }, 'paid'), null);
});
test('an absent compensationMode is not this check\'s business', () => {
  assert.strictEqual(SERVER.holidayWorkModeBlockReason(S, { role: 'manager' }, undefined), null);
});
test('a missing user or settings object does not throw', () => {
  assert.strictEqual(typeof SERVER.holidayWorkModeBlockReason(undefined, undefined, 'paid'), 'string');
});
test('a role with no mode enabled at all cannot file', () => {
  const none = { allowanceEligibility: { holidayWork: ['manager'], holidayWorkLeave: [], holidayWorkPaid: [] } };
  const r = SERVER.holidayWorkModeBlockReason(none, { role: 'manager' }, undefined);
  assert.ok(typeof r === 'string' && r.length > 0, 'expected a refusal when no mode is available');
});
test('the modes list is what the form offers, in order', () => {
  const cfg = { holidayWork: ['user', 'manager'], holidayWorkLeave: ['user', 'manager'], holidayWorkPaid: ['user'] };
  assert.deepStrictEqual(modesBoth(cfg, 'user'), ['annual-leave', 'paid']);
  assert.deepStrictEqual(modesBoth(cfg, 'manager'), ['annual-leave']);
  assert.deepStrictEqual(modesBoth(cfg, 'driver'), []);
});
test('leave-only and money-only are both expressible', () => {
  const leaveOnly = { holidayWork: ['manager'], holidayWorkLeave: ['manager'], holidayWorkPaid: [] };
  assert.deepStrictEqual(modesBoth(leaveOnly, 'manager'), ['annual-leave']);
  const moneyOnly = { holidayWork: ['manager'], holidayWorkLeave: [], holidayWorkPaid: ['manager'] };
  assert.deepStrictEqual(modesBoth(moneyOnly, 'manager'), ['paid']);
});
test('an unknown mode is never allowed', () => {
  const cfg = { holidayWork: ['user'], holidayWorkLeave: ['user'], holidayWorkPaid: ['user'] };
  assert.strictEqual(both(cfg, 'user', 'something-else'), false);
});

console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ', 0 failed'}`);
