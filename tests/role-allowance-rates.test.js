// Per-role early-morning / late-night rates (2026-10-13, owner's decision).
//
// The rates themselves are DATA, not code: this file must never assert a real rate for a real
// role, or the owner editing a rate on the Settings page turns a test red. Everything below uses
// invented numbers and proves the mechanism.
//
// Both copies of earlyLateRateFor() are extracted from the real sources, so the dual-sync rule
// (app.js and server.js must agree about money) is proven here and not assumed.
//
// 2026-10-13 (plan pre-flight ruling): every locator in this file anchors on a distinctive STRING
// in the source, never on a line number. The tasks that follow insert lines into app.js above the
// regions being inspected, so a line-indexed slice would silently start reading the wrong code.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const APP_SRC = fs.readFileSync(path.join(ROOT, 'attendance/js/app.js'), 'utf8');
const SERVER_SRC = fs.readFileSync(path.join(ROOT, 'attendance-server/backend/server.js'), 'utf8');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok  ${name}`); }
  catch (e) { process.exitCode = 1; console.log(`  FAIL  ${name}\n        ${e.message}`); }
}

function extractFunction(src, name) {
  const re = new RegExp(`^(async )?function ${name}\\(`, 'm');
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

function extractKeys(src) {
  const m = /const EARLY_LATE_RATE_KEYS = (\[[^\]]*\]);/.exec(src);
  if (!m) throw new Error('EARLY_LATE_RATE_KEYS not found');
  return m[1];
}

// Pulls a region out of a source by two anchor strings instead of line numbers, so inserting
// lines elsewhere in the file cannot move the window off the code under test.
function between(src, startAnchor, endAnchor, pad) {
  const a = src.indexOf(startAnchor);
  assert.ok(a > -1, `anchor not found: ${startAnchor}`);
  const b = src.indexOf(endAnchor, a);
  assert.ok(b > -1, `anchor not found after ${startAnchor}: ${endAnchor}`);
  return src.slice(Math.max(0, a - (pad || 0)), b + endAnchor.length + (pad || 0));
}

function load(src) {
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(
    `const EARLY_LATE_RATE_KEYS = ${extractKeys(src)};\n${extractFunction(src, 'earlyLateRateFor')}\n` +
    'this.rate = earlyLateRateFor; this.KEYS = EARLY_LATE_RATE_KEYS;', ctx);
  return { rate: ctx.rate, KEYS: ctx.KEYS };
}

const CLIENT = load(APP_SRC);
const SERVER = load(SERVER_SRC);

// Invented amounts. Nothing here is anyone's real rate.
const CENTRAL = { earlyMorning1: 11, earlyMorning2: 22, lateNight1: 33, lateNight2: 44 };
const S = (roleRates) => ({ allowances: { ...CENTRAL }, allowanceRoleRates: roleRates });

// Every assertion runs through BOTH copies, so a drift cannot pass.
function both(role, key, settings) {
  const a = CLIENT.rate(role, key, settings);
  const b = SERVER.rate(role, key, settings);
  assert.deepStrictEqual(a, b, `app.js gave ${a} but server.js gave ${b} for ${role}/${key}`);
  return a;
}

console.log('per-role early/late rates: the switch, the fallback, and the two engines agreeing');

test('the two copies of the function are identical text', () => {
  assert.strictEqual(extractFunction(APP_SRC, 'earlyLateRateFor'), extractFunction(SERVER_SRC, 'earlyLateRateFor'));
  assert.strictEqual(extractKeys(APP_SRC), extractKeys(SERVER_SRC));
});

test('switch off: every role gets the company-wide amount', () => {
  const s = S({ enabled: false, byRole: { manager: { earlyMorning1: 999, earlyMorning2: 999, lateNight1: 999, lateNight2: 999 } } });
  for (const k of CLIENT.KEYS) {
    assert.strictEqual(both('manager', k, s), CENTRAL[k], `${k} must ignore byRole while the switch is off`);
    assert.strictEqual(both('user', k, s), CENTRAL[k]);
  }
});

test('switch on: the configured role gets its amount, everyone else the company-wide one', () => {
  const s = S({ enabled: true, byRole: { manager: { earlyMorning1: 7, earlyMorning2: 8, lateNight1: 9, lateNight2: 10 } } });
  assert.strictEqual(both('manager', 'earlyMorning1', s), 7);
  assert.strictEqual(both('manager', 'lateNight2', s), 10);
  assert.strictEqual(both('user', 'earlyMorning1', s), CENTRAL.earlyMorning1);
  assert.strictEqual(both('driver', 'lateNight2', s), CENTRAL.lateNight2);
});

// Review Focus 1: 0 means "do not pay this tier" and must survive.
test('a configured rate of 0 pays 0, it does not fall back', () => {
  const s = S({ enabled: true, byRole: { manager: { earlyMorning1: 0 } } });
  assert.strictEqual(both('manager', 'earlyMorning1', s), 0);
});

// Review Focus 2: a half-filled row must not poison the keys it does not mention.
test('a partly filled row takes the company-wide amount for its missing keys', () => {
  const s = S({ enabled: true, byRole: { manager: { earlyMorning1: 5 } } });
  assert.strictEqual(both('manager', 'earlyMorning1', s), 5);
  assert.strictEqual(both('manager', 'earlyMorning2', s), CENTRAL.earlyMorning2);
  assert.strictEqual(both('manager', 'lateNight1', s), CENTRAL.lateNight1);
  assert.strictEqual(both('manager', 'lateNight2', s), CENTRAL.lateNight2);
});

test('a broken value falls back to the company-wide amount, never to 0 or NaN', () => {
  for (const bad of [-1, NaN, Infinity, '360', null, undefined, {}, []]) {
    const s = S({ enabled: true, byRole: { manager: { earlyMorning1: bad } } });
    assert.strictEqual(both('manager', 'earlyMorning1', s), CENTRAL.earlyMorning1, `${JSON.stringify(bad)} should fall back`);
  }
});

test('a missing or malformed section falls back to the company-wide amount', () => {
  const cfgs = [undefined, null, {}, [], 'x', { enabled: true }, { enabled: true, byRole: null },
    { enabled: true, byRole: [] }, { enabled: 'yes', byRole: { manager: { earlyMorning1: 5 } } }];
  for (const cfg of cfgs) {
    assert.strictEqual(both('manager', 'earlyMorning1', S(cfg)), CENTRAL.earlyMorning1, `${JSON.stringify(cfg)} should fall back`);
  }
});

test('no role, or a key outside the four, takes the company-wide amount', () => {
  const s = S({ enabled: true, byRole: { manager: { earlyMorning1: 5 }, '': { earlyMorning1: 6 } } });
  assert.strictEqual(both(undefined, 'earlyMorning1', s), CENTRAL.earlyMorning1);
  assert.strictEqual(both('', 'earlyMorning1', s), CENTRAL.earlyMorning1);
  const s2 = { allowances: { ...CENTRAL, upcountry: 240 }, allowanceRoleRates: { enabled: true, byRole: { manager: { upcountry: 1 } } } };
  assert.strictEqual(both('manager', 'upcountry', s2), 240, 'only the four early/late keys may be overridden');
});

test('the four keys are exactly the early-morning and late-night amounts', () => {
  assert.deepStrictEqual([...CLIENT.KEYS].sort(), ['earlyMorning1', 'earlyMorning2', 'lateNight1', 'lateNight2']);
});

test('both files ship the section switched off with no role configured', () => {
  for (const [label, src] of [['app.js', APP_SRC], ['server.js', SERVER_SRC]]) {
    const m = /allowanceRoleRates:\s*\{\s*enabled:\s*(true|false),\s*byRole:\s*\{\s*\}\s*\}/.exec(src);
    assert.ok(m, `${label} must default allowanceRoleRates to { enabled: <bool>, byRole: {} }`);
    assert.strictEqual(m[1], 'false', `${label} must ship the switch OFF`);
  }
});

test('no role rate is hardcoded anywhere in either source', () => {
  for (const [label, src] of [['app.js', APP_SRC], ['server.js', SERVER_SRC]]) {
    assert.ok(!/byRole:\s*\{\s*[^}\s]/.test(src), `${label} ships a non-empty byRole -- rates are data, not code`);
  }
});

console.log(`\n${passed} assertions passed`);
module.exports = { between };
