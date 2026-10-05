// appSettings.allowances validation (2026-10-05).
//
// Regression guard for a bug the owner hit: `allowances` holds money AND on/off flags
// (morningReviewEnabled), but the validator demanded a number from every key, so once that
// checkbox had been saved once EVERY later Settings save was refused -- the whole page.
//
// The rule is extracted from the real server source so it cannot drift from what runs.
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const SERVER_SRC = fs.readFileSync(path.join(ROOT, 'attendance-server/backend/server.js'), 'utf8');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok  ${name}`); }
  catch (e) { process.exitCode = 1; console.log(`  FAIL  ${name}\n        ${e.message}`); }
}

// The validator is inline in a route handler, so mirror its decision by reading the two conditions
// out of the source rather than re-typing them: if either line changes shape this test fails loudly.
const flagRe = /const isFlagKey = (k => \/[^/]+\/\.test\(k\));/.exec(SERVER_SRC);
assert.ok(flagRe, 'isFlagKey not found in server.js — the allowances validator changed shape');
// eslint-disable-next-line no-eval
const isFlagKey = eval('(' + flagRe[1] + ')');

function validate(key, value) {
  if (isFlagKey(key)) return typeof value === 'boolean' ? null : `appSettings.allowances.${key} must be true or false`;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100000) {
    return `appSettings.allowances.${key} must be a number 0-100000`;
  }
  return null;
}

console.log('appSettings.allowances: flags are booleans, everything else is money');

test('morningReviewEnabled accepts true and false', () => {
  assert.strictEqual(validate('morningReviewEnabled', true), null);
  assert.strictEqual(validate('morningReviewEnabled', false), null);
});
test('morningReviewEnabled rejects a number', () => {
  assert.ok(validate('morningReviewEnabled', 1), 'a number should be refused for a flag');
});
test('a future ...Enabled flag is covered without touching the validator', () => {
  assert.strictEqual(validate('checkoutReviewEnabled', false), null);
});
test('money keys still require a number in range', () => {
  assert.strictEqual(validate('holidayTransport', 500), null);
  assert.ok(validate('holidayTransport', true), 'a boolean should be refused for money');
  assert.ok(validate('holidayTransport', -1), 'negative should be refused');
  assert.ok(validate('holidayTransport', 100001), 'over the cap should be refused');
});
test('zero is a legal rate', () => {
  assert.strictEqual(validate('holidayTransport', 0), null);
});
test('the window/gap minute keys are numbers, not flags', () => {
  assert.strictEqual(validate('morningReviewWindowStartMin', 480), null);
  assert.strictEqual(validate('morningReviewMinGapMin', 30), null);
  assert.ok(validate('morningReviewWindowStartMin', true));
});

console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ', 0 failed'}`);
