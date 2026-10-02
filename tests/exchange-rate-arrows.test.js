// ▲▼ change indicators on the dashboard exchange-rate card (2026-09-26).
//
// The banks publish once a day, so "changed" has to mean "since the previous publication".
// Comparing against the previous *fetch* would zero the arrow the moment anyone reloaded the
// dashboard, which is the failure this suite is really guarding: the state is only advanced
// when a bank publishes something new, and the arrow survives any number of reads in between.
//
// annotateExRateChange() is extracted from server.js and executed against an in-memory file,
// so these are behavioural assertions, not greps.
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const SERVER_SRC = fs.readFileSync(path.join(ROOT, 'attendance-server/backend/server.js'), 'utf8');
const APP_SRC = fs.readFileSync(path.join(ROOT, 'attendance/js/app.js'), 'utf8');
// 2026-10-02: the business-day boundary is read out of the real source instead of repeating the
// number here, so moving it can never leave these sandboxes asserting against the old value.
const BUSINESS_DAY_START_MINS = Number(/const BUSINESS_DAY_START_MINS = (\d+);/.exec(APP_SRC)[1]);

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok ', name); }
  catch (e) { process.exitCode = 1; console.log('  FAIL', name, '\n      ', e.message); }
}

function extract(src, startMarker, endMarker) {
  const a = src.indexOf(startMarker);
  assert.ok(a > 0, 'not found: ' + startMarker);
  const b = src.indexOf(endMarker, a);
  assert.ok(b > a, 'end not found: ' + endMarker);
  return src.slice(a, b);
}

const CODE = extract(SERVER_SRC, 'const EXRATE_STATE_FILE =', "app.get('/api/exchange-rate'");

// A fresh sandbox per test: one in-memory file, plus the few globals the extracted code uses.
function makeEnv(opts = {}) {
  const store = { file: opts.initial === undefined ? null : JSON.stringify(opts.initial) };
  const sandbox = {
    DATA_DIR: '/data',
    path: { join: (...p) => p.join('/') },
    fs: {
      readFileSync() {
        if (store.file === null) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; }
        return store.file;
      },
    },
    atomicWrite(_file, str) {
      if (opts.writeThrows) throw new Error('disk full');
      store.file = str;
    },
    console: { error() {} },
    Number, JSON, Array, Object, String, Math,
  };
  sandbox.BUSINESS_DAY_START_MINS = BUSINESS_DAY_START_MINS;
  vm.createContext(sandbox);
  vm.runInContext(CODE, sandbox);
  return { sandbox, store, state: () => (store.file === null ? null : JSON.parse(store.file)) };
}

const bank = (ttb, updatedAt) => ({ ttb, updatedAt });

console.log('Exchange-rate ▲▼ indicators');

test('the very first publication carries no arrow -- there is nothing to compare with', () => {
  const env = makeEnv();
  const out = env.sandbox.annotateExRateChange({
    smbc: bank(4.63, '2026/09/26 05:00'),
    mizuho: bank(4.67, '2026/09/25 00:00'),
    resona: bank(4.67, '2026/09/25 10:29'),
  });
  for (const b of ['smbc', 'mizuho', 'resona']) {
    assert.strictEqual(out[b].prev, null, b + ' must have no previous rate');
    assert.strictEqual(out[b].dir, null, b + ' must have no direction');
  }
  assert.strictEqual(env.state().smbc.ttb, 4.63, 'the rate must still be remembered');
  assert.strictEqual(env.state().smbc.prevTtb, null);
});

test('a NEW publication compares against the previous one', () => {
  const env = makeEnv({ initial: { smbc: { updatedAt: '2026/09/25 05:00', ttb: 4.60, prevTtb: null } } });
  const out = env.sandbox.annotateExRateChange({ smbc: bank(4.63, '2026/09/26 05:00') });
  assert.strictEqual(out.smbc.prev, 4.60);
  assert.strictEqual(out.smbc.dir, 'up');
  assert.strictEqual(env.state().smbc.prevTtb, 4.60, 'yesterday becomes the previous');
  assert.strictEqual(env.state().smbc.ttb, 4.63);
});

test('a rate that went down reads down', () => {
  const env = makeEnv({ initial: { mizuho: { updatedAt: '2026/09/25 00:00', ttb: 4.71, prevTtb: 4.70 } } });
  const out = env.sandbox.annotateExRateChange({ mizuho: bank(4.67, '2026/09/26 00:00') });
  assert.strictEqual(out.mizuho.dir, 'down');
  assert.strictEqual(out.mizuho.prev, 4.71);
});

test('re-reading the SAME publication keeps the arrow -- a reload must not zero it', () => {
  const env = makeEnv({ initial: { smbc: { updatedAt: '2026/09/25 05:00', ttb: 4.60, prevTtb: null } } });
  const first = env.sandbox.annotateExRateChange({ smbc: bank(4.63, '2026/09/26 05:00') });
  assert.strictEqual(first.smbc.dir, 'up');
  // three more reads of the identical payload, as three dashboard loads would produce
  let last = first;
  for (let i = 0; i < 3; i++) {
    last = env.sandbox.annotateExRateChange({ smbc: bank(4.63, '2026/09/26 05:00') });
  }
  assert.strictEqual(last.smbc.dir, 'up', 'still up after repeated reads');
  assert.strictEqual(last.smbc.prev, 4.60, 'still compared against the previous publication');
  assert.strictEqual(env.state().smbc.prevTtb, 4.60, 'state must not have advanced');
});

test('an unchanged republication reads as "same", not as missing data', () => {
  const env = makeEnv({ initial: { resona: { updatedAt: '2026/09/25 10:29', ttb: 4.67, prevTtb: 4.60 } } });
  const out = env.sandbox.annotateExRateChange({ resona: bank(4.67, '2026/09/26 10:29') });
  assert.strictEqual(out.resona.dir, 'same');
  assert.strictEqual(out.resona.prev, 4.67);
});

test('a failed bank neither gets an arrow nor destroys what is stored', () => {
  const env = makeEnv({ initial: { smbc: { updatedAt: '2026/09/25 05:00', ttb: 4.60, prevTtb: 4.55 } } });
  const out = env.sandbox.annotateExRateChange({
    smbc: { error: 'rate fetch failed' },
    mizuho: { ttb: 'N/A', updatedAt: '' },
    resona: { ttb: NaN, updatedAt: '2026/09/26' },
  });
  assert.strictEqual(out.smbc.prev, undefined, 'an errored bank gets no annotation');
  assert.strictEqual(out.mizuho.dir, undefined, 'a non-numeric rate gets no annotation');
  assert.strictEqual(out.resona.dir, undefined, 'NaN gets no annotation');
  assert.strictEqual(env.state().smbc.ttb, 4.60, 'the last good rate must survive a failed fetch');
  assert.strictEqual(env.state().smbc.prevTtb, 4.55);
});

test('a corrupt state file is treated as empty rather than throwing', () => {
  const env = makeEnv();
  env.store.file = '{ not json';
  const out = env.sandbox.annotateExRateChange({ smbc: bank(4.63, '2026/09/26 05:00') });
  assert.strictEqual(out.smbc.dir, null, 'starts over, no invented arrow');
  assert.strictEqual(env.state().smbc.ttb, 4.63);
});

test('a state file holding an array is rejected (JSON.parse alone would accept it)', () => {
  const env = makeEnv();
  env.store.file = '[1,2,3]';
  const out = env.sandbox.annotateExRateChange({ smbc: bank(4.63, '2026/09/26 05:00') });
  assert.strictEqual(out.smbc.dir, null);
});

test('a write failure never fails the rates themselves', () => {
  const env = makeEnv({ writeThrows: true });
  const out = env.sandbox.annotateExRateChange({ smbc: bank(4.63, '2026/09/26 05:00') });
  assert.strictEqual(out.smbc.ttb, 4.63, 'the payload still comes back');
});

test('the route annotates the payload it sends, not a copy', () => {
  assert.ok(/const data = annotateExRateChange\(\{ smbc, mizuho: other\.mizuho/.test(SERVER_SRC),
    'the response object must be the annotated one');
});

test('the client renders the direction the server computed, and only then', () => {
  const start = APP_SRC.indexOf('async function fetchExchangeRate()');
  assert.ok(start > 0);
  const fn = APP_SRC.slice(start, start + 2200);
  assert.ok(/const d = hasRate \? bank\.dir : null;/.test(fn), 'direction comes from the server');
  assert.ok(/!d \? ''/.test(fn), 'no direction means no arrow, not a default one');
  assert.ok(/d === 'up' \? '▲' : '▼'/.test(fn));
  // 2026-10-02 (owner): an unchanged republication reads as a dash. '=' sat right next to the
  // rate and was being read as part of the number.
  assert.ok(/d === 'same' \? '-'/.test(fn), "an unchanged rate must render '-', not '='");
  assert.ok(/typeof bank\.prev === 'number'/.test(fn), 'the delta needs a numeric previous');
  for (const b of ['smbc', 'mizuho', 'resona']) {
    assert.ok(APP_SRC.includes(`id="dash-rate-${b}-arrow"`), `${b} needs somewhere to render it`);
  }
});

console.log(`  ${passed} passed, ${process.exitCode ? 'FAILURES' : '0 failed'}`);
