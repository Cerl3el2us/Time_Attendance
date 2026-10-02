// Web check-out Late Night review unit tests (2026-09-24; the 2026-09-23 originals lived only in a
// scratchpad). No framework: `node tests/checkout-review.test.js`.
//
// Same approach as tests/leave-rules.test.js / tests/payroll-rules.test.js: every function is
// extracted from the real source files (attendance/js/app.js and attendance-server/backend/server.js)
// and run in a sandbox, so the tests also prove the two DUAL-SYNC copies agree.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const APP_SRC = fs.readFileSync(path.join(ROOT, 'attendance/js/app.js'), 'utf8');
const SERVER_SRC = fs.readFileSync(path.join(ROOT, 'attendance-server/backend/server.js'), 'utf8');
// 2026-10-02: the business-day boundary is read out of the real source instead of repeating the
// number here, so moving it can never leave these sandboxes asserting against the old value.
const BUSINESS_DAY_START_MINS = Number(/const BUSINESS_DAY_START_MINS = (\d+);/.exec(APP_SRC)[1]);

function balancedFrom(src, start, label) {
  const i = src.indexOf('{', start);
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (depth === 0) return src.slice(start, j + 1); }
  }
  throw new Error(`unbalanced ${label}`);
}
function extractFunction(src, name) {
  const m = new RegExp(`^(async )?function ${name}\\(`, 'm').exec(src);
  if (!m) throw new Error(`function ${name} not found`);
  return balancedFrom(src, m.index, name);
}
function extractConstObject(src, name) {
  const m = new RegExp(`^const ${name} = \\{`, 'm').exec(src);
  if (!m) throw new Error(`const ${name} not found`);
  return balancedFrom(src, m.index, name).replace(/^const /, 'var ') + ';';
}

const FNS = ['isAllowanceEligible', 'isDeviceScanSource', 'isFullDayPersonalLeaveStatus',
  'lateNightCheckoutMins', 'lateNightThresholdMins', 'lateNightThresholdHourOf', 'checkoutReviewDecisionFor', 'lateNightCheckoutOk', 'checkoutReviewTrigger'];
function load(src) {
  const ctx = {};
  ctx.BUSINESS_DAY_START_MINS = BUSINESS_DAY_START_MINS;
  vm.createContext(ctx);
  vm.runInContext(extractConstObject(src, 'DEFAULT_ALLOWANCE_ELIGIBILITY') + '\n' +
    FNS.map(n => extractFunction(src, n)).join('\n'), ctx);
  return ctx;
}
const SIDES = [['client', load(APP_SRC)], ['server', load(SERVER_SRC)]];

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok  ${name}`); }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; }
}

const S = { allowances: { lateNightThreshold1Hour: 19, lateNightThreshold2Hour: 20 }, allowanceEligibility: {} };
const USER = { id: 5, role: 'user' };
const day = o => ({ date: '2026-09-22', status: 'present', checkIn: '08:20', checkOut: '19:30', checkOutSource: 'web', isFuture: false, ...o });

console.log('lateNightCheckoutMins');
test('HH:MM -> minutes; before 05:30 counts as +24h (after midnight, same work day)', () => {
  for (const [side, X] of SIDES) {
    assert.strictEqual(X.lateNightCheckoutMins('19:00'), 19 * 60, side);
    assert.strictEqual(X.lateNightCheckoutMins('23:59'), 23 * 60 + 59, side);
    // 2026-10-02: the boundary moved to 05:30, so 05:00 now belongs to the previous evening.
    assert.strictEqual(X.lateNightCheckoutMins('05:00'), 24 * 60 + 5 * 60, side);
    assert.strictEqual(X.lateNightCheckoutMins('05:29'), 24 * 60 + 5 * 60 + 29, side);
    assert.strictEqual(X.lateNightCheckoutMins('05:30'), 5 * 60 + 30, side);
    assert.strictEqual(X.lateNightCheckoutMins('04:59'), 24 * 60 + 4 * 60 + 59, side);
    assert.strictEqual(X.lateNightCheckoutMins('00:00'), 24 * 60, side);
    assert.strictEqual(X.lateNightCheckoutMins('01:30'), 25 * 60 + 30, side);
  }
});
test('anything that is not strict HH:MM is NaN', () => {
  for (const [side, X] of SIDES) {
    for (const bad of [null, undefined, '', '9:00', '24:00', '19:60', '19:30:00', 1930, 'abc']) {
      assert.ok(Number.isNaN(X.lateNightCheckoutMins(bad)), `${side} ${JSON.stringify(bad)}`);
    }
  }
});

console.log('lateNightCheckoutOk');
test('device check-out always ok; web only when allowed; anything else not', () => {
  for (const [side, X] of SIDES) {
    assert.strictEqual(X.lateNightCheckoutOk({ checkOutSource: 'device' }), true, side);
    assert.strictEqual(X.lateNightCheckoutOk({ checkOutSource: 'device', checkOutReview: 'deny' }), true, side);
    assert.strictEqual(X.lateNightCheckoutOk({ checkOutSource: 'web', checkOutReview: 'allow' }), true, side);
    assert.strictEqual(X.lateNightCheckoutOk({ checkOutSource: 'web', checkOutReview: 'deny' }), false, side);
    assert.strictEqual(X.lateNightCheckoutOk({ checkOutSource: 'web', checkOutReview: null }), false, side);
    assert.strictEqual(X.lateNightCheckoutOk({ checkOutSource: 'web' }), false, side);
    assert.strictEqual(X.lateNightCheckoutOk({ checkOutSource: undefined, checkOutReview: 'allow' }), false, side);
    assert.strictEqual(X.lateNightCheckoutOk({ checkOutSource: 'correction', checkOutReview: 'allow' }), false, side);
    assert.strictEqual(X.lateNightCheckoutOk(null), false, side);
  }
});

console.log('checkoutReviewDecisionFor');
test('a review counts only for the exact web check-out it was made on', () => {
  for (const [side, X] of SIDES) {
    const r = { decision: 'allow', checkOut: '19:30' };
    assert.strictEqual(X.checkoutReviewDecisionFor(r, '19:30', 'web'), 'allow', side);
    assert.strictEqual(X.checkoutReviewDecisionFor({ decision: 'deny', checkOut: '19:30' }, '19:30', 'web'), 'deny', side);
    assert.strictEqual(X.checkoutReviewDecisionFor(r, '20:10', 'web'), null, `${side} later web tap`);
    assert.strictEqual(X.checkoutReviewDecisionFor(r, '19:30', 'device'), null, `${side} device`);
    assert.strictEqual(X.checkoutReviewDecisionFor({ decision: 'maybe', checkOut: '19:30' }, '19:30', 'web'), null, side);
    assert.strictEqual(X.checkoutReviewDecisionFor(null, '19:30', 'web'), null, side);
  }
});

console.log('checkoutReviewTrigger');
test('web check-out at/after the Late Night x1 time triggers a review', () => {
  for (const [side, X] of SIDES) {
    assert.strictEqual(X.checkoutReviewTrigger(day({ checkOut: '19:00' }), USER, S), true, `${side} exactly 19:00`);
    assert.strictEqual(X.checkoutReviewTrigger(day({ checkOut: '18:59' }), USER, S), false, `${side} 18:59`);
    assert.strictEqual(X.checkoutReviewTrigger(day({ checkOut: '01:15' }), USER, S), true, `${side} after midnight`);
    assert.strictEqual(X.checkoutReviewTrigger(day({ checkOut: '05:29' }), USER, S), true, `${side} 05:29 still last night`);
    assert.strictEqual(X.checkoutReviewTrigger(day({ checkOut: '05:30' }), USER, S), false, `${side} 05:30 is morning`);
    const s20 = { ...S, allowances: { lateNightThreshold1Hour: 20 } };
    assert.strictEqual(X.checkoutReviewTrigger(day({ checkOut: '19:30' }), USER, s20), false, `${side} threshold 20`);
    const legacy = { ...S, allowances: { lateNightThresholdHour: 21 } };
    assert.strictEqual(X.checkoutReviewTrigger(day({ checkOut: '20:30' }), USER, legacy), false, `${side} legacy key`);
    assert.strictEqual(X.checkoutReviewTrigger(day({ checkOut: '19:30' }), USER, { allowanceEligibility: {} }), true, `${side} default 19`);
  }
});
test('no trigger for device / missing times / future / leave / Company Trip / Abroad / ineligible role', () => {
  for (const [side, X] of SIDES) {
    const no = (d, u, s, why) => assert.strictEqual(X.checkoutReviewTrigger(d, u || USER, s || S), false, `${side} ${why}`);
    no(day({ checkOutSource: 'device' }), null, null, 'device');
    no(day({ checkOutSource: undefined }), null, null, 'no source');
    no(day({ checkIn: null }), null, null, 'no check-in');
    no(day({ checkOut: null }), null, null, 'no check-out');
    no(day({ isFuture: true }), null, null, 'future');
    for (const st of ['leave-annual', 'leave-sick', 'leave-business', 'company-trip', 'abroad', 'future']) no(day({ status: st }), null, null, st);
    no(day(), { id: 9, role: 'accounting' }, null, 'accounting not earlyLate-eligible by default');
    no(day(), null, { ...S, allowanceEligibility: { earlyLate: ['driver'] } }, 'role removed in Settings');
    no(null, null, null, 'null day');
    no(day(), { role: undefined }, null, 'no role');
  }
  for (const [side, X] of SIDES) {
    assert.strictEqual(X.checkoutReviewTrigger(day({ status: 'late' }), USER, S), true, `${side} late day still reviewed`);
    assert.strictEqual(X.checkoutReviewTrigger(day({ status: 'weekend', isWeekend: true }), USER, S), true, `${side} weekend web check-out`);
  }
});
test('client and server agree on a grid of check-out times', () => {
  const [[, C], [, Sv]] = SIDES;
  for (let h = 0; h < 24; h++) {
    for (const m of ['00', '29', '59']) {
      const t = `${String(h).padStart(2, '0')}:${m}`;
      assert.strictEqual(C.lateNightCheckoutMins(t), Sv.lateNightCheckoutMins(t), t);
      assert.strictEqual(C.checkoutReviewTrigger(day({ checkOut: t }), USER, S), Sv.checkoutReviewTrigger(day({ checkOut: t }), USER, S), t);
    }
  }
});

console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ', 0 failed'}`);
