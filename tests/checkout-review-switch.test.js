// The web check-out review policy switch (2026-10-05).
//
// Why this exists, from the owner: almost every case in that review queue ought to have been
// denied, but MD allowed them all without reading — a queue demands to be cleared, and clearing it
// is easier than judging it. So the fix is not a better queue, it is no queue. With the policy off
// a web check-out simply does not earn Late Night, which is the company rule it always was, and the
// genuine exception is still grantable from the attendance row by somebody who went looking for it.
//
// These tests pin the split that makes that work: "could this be granted" and "should this be
// queued" are two different questions, and collapsing them back into one brings the rubber stamp
// back. Both copies of the rule are extracted from the real sources, so the client and the server
// cannot drift apart.
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
  let i = src.indexOf('(', m.index);
  let paren = 0;
  for (; i < src.length; i++) {
    if (src[i] === '(') paren++;
    else if (src[i] === ')') { paren--; if (paren === 0) { i++; break; } }
  }
  const bodyStart = src.indexOf('{', i);
  let depth = 0;
  for (let j = bodyStart; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (depth === 0) return src.slice(m.index, j + 1); }
  }
  throw new Error(`unbalanced ${name}`);
}

const FNS = ['isAllowanceEligible', 'lateNightThresholdHourOf', 'lateNightCheckoutMins',
  'lateNightThresholdMins', 'isFullDayPersonalLeaveStatus',
  'checkoutReviewEligible', 'checkoutReviewEnabled', 'checkoutReviewQueued'];

function sandbox(src) {
  const ctx = { console };
  vm.createContext(ctx);
  const BD = /const BUSINESS_DAY_START_MINS = (\d+);/.exec(src)[1];
  vm.runInContext(`const BUSINESS_DAY_START_MINS = ${BD};`, ctx);
  // DEFAULT_ALLOWANCE_ELIGIBILITY is what isAllowanceEligible falls back to.
  const re = /^const DEFAULT_ALLOWANCE_ELIGIBILITY = \{/m;
  const m = re.exec(src);
  let i = src.indexOf('{', m.index), d = 0, decl = '';
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') d++;
    else if (src[j] === '}') { d--; if (d === 0) { decl = src.slice(m.index, j + 1) + ';'; break; } }
  }
  vm.runInContext(decl, ctx);
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
function both(fnName, day, user, S) {
  const c = CLIENT[fnName](day, user, S);
  const s = SERVER[fnName](day, user, S);
  assert.strictEqual(c, s, `client/server disagree on ${fnName}`);
  return c;
}

const USER = { id: 1, role: 'user' };
// A web check-out at 19:42 on an ordinary worked day — the exact shape that used to fill the queue.
const DAY = { checkIn: '08:30', checkOut: '19:42', checkOutSource: 'web', status: 'present', isFuture: false };
const S = (on) => ({
  allowanceEligibility: { earlyLate: ['user', 'manager'] },
  allowances: { lateNightThreshold1Hour: 19, checkoutReviewEnabled: on },
});

console.log('Checkout review: granting and queueing are different questions');

test('a qualifying day is always grantable, policy on or off', () => {
  assert.strictEqual(both('checkoutReviewEligible', DAY, USER, S(true)), true);
  assert.strictEqual(both('checkoutReviewEligible', DAY, USER, S(false)), true,
    'the one-off exception must stay possible from the attendance row — that is the escape hatch');
});
test('it is only queued while the policy is on', () => {
  assert.strictEqual(both('checkoutReviewQueued', DAY, USER, S(true)), true);
  assert.strictEqual(both('checkoutReviewQueued', DAY, USER, S(false)), false,
    'with the policy off nothing demands to be cleared, which is the entire point');
});
test('the policy is OFF unless it is explicitly switched on', () => {
  // The company rule is a face-scan check-out; the review is the exception. A missing key, an
  // empty settings file, or a truthy-but-not-true value must never turn it on by accident.
  [undefined, {}, { allowances: {} }, { allowances: { checkoutReviewEnabled: 'yes' } },
   { allowances: { checkoutReviewEnabled: 1 } }].forEach(cfg => {
    assert.strictEqual(CLIENT.checkoutReviewEnabled(cfg), false, `${JSON.stringify(cfg)} must read as off`);
    assert.strictEqual(SERVER.checkoutReviewEnabled(cfg), false);
  });
  assert.strictEqual(CLIENT.checkoutReviewEnabled({ allowances: { checkoutReviewEnabled: true } }), true);
});

console.log('\nCheckout review: what still does not qualify at all');

test('a face-scanner check-out was never part of this', () => {
  const scanned = { ...DAY, checkOutSource: 'device' };
  assert.strictEqual(both('checkoutReviewEligible', scanned, USER, S(true)), false,
    'a device scan earns Late Night directly and must never enter the review path');
});
test('too early, a future day, or an ineligible role are refused whatever the policy says', () => {
  assert.strictEqual(both('checkoutReviewEligible', { ...DAY, checkOut: '18:10' }, USER, S(true)), false);
  assert.strictEqual(both('checkoutReviewEligible', { ...DAY, isFuture: true }, USER, S(true)), false);
  assert.strictEqual(both('checkoutReviewEligible', DAY, { id: 2, role: 'accounting' }, S(true)), false);
});
test('a Company Trip or Abroad day pays nothing, policy or no policy', () => {
  ['company-trip', 'abroad'].forEach(status =>
    assert.strictEqual(both('checkoutReviewEligible', { ...DAY, status }, USER, S(true)), false));
});

console.log('\nCheckout review: the wiring that keeps it honest');

test('the review box reads "queued", the row control reads "eligible"', () => {
  const box = extractFunction(APP_SRC, 'checkoutReviewBoxItems');
  assert.ok(/checkoutReviewQueued\(/.test(box), 'the box must empty when the policy is off');
  const rowCtl = extractFunction(APP_SRC, 'buildCheckoutReviewHtml');
  assert.ok(/checkoutReviewEligible\(/.test(rowCtl),
    'the approve control must survive the policy being off — it is the only way to grant the exception');
});
test('the server guard reads "eligible", so the exception can still be granted', () => {
  assert.ok(/checkoutReviewEligible\(day, target, getAppSettings\(\)\)/.test(SERVER_SRC),
    'guarding on "queued" would make the escape hatch unusable while the policy is off');
});
test('nobody is told to wait for a review that is not coming', () => {
  const fn = extractFunction(APP_SRC, 'canSubmitLateNightForDate');
  assert.ok(/web-not-allowed/.test(fn), 'there must be a distinct reason for "policy off"');
  assert.ok(/checkoutReviewQueued\([\s\S]{0,60}\|\| row\.checkOutReview/.test(fn),
    'a day already decided keeps its own answer even after the policy is switched off');
  const msg = extractFunction(APP_SRC, 'lateNightSubmitBlockedMessage');
  assert.ok(/web-not-allowed/.test(msg), 'and it needs its own message');
  assert.ok(/ja'/.test(msg) || /currentLang === 'ja'/.test(msg), 'three languages, like every other message');
});
test('a day already allowed keeps working after the policy is switched off', () => {
  // The five days MD already allowed must not stop paying. Nothing enforces this but
  // lateNightCheckoutOk reading the stored decision rather than the policy — so pin that.
  const fn = extractFunction(APP_SRC, 'lateNightCheckoutOk');
  assert.ok(!/checkoutReviewEnabled|checkoutReviewQueued/.test(fn),
    'pay must follow the decision that was recorded, not the policy in force today');
  assert.ok(/checkOutReview === 'allow'/.test(fn), 'an allowed web check-out still qualifies');
});

console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ', 0 failed'}`);
