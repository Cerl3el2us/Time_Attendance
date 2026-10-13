# Per-Role Early-Morning / Late-Night Allowance Rates — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Accounting/MD switch on, and type in, an early-morning / late-night allowance rate that differs per role, without any role's rate existing in the code.

**Architecture:** One new `appSettings` section (`allowanceRoleRates = { enabled, byRole }`) and one reader (`earlyLateRateFor(role, key, S)`) that every rate read goes through. The reader returns the company-wide `allowances.*` amount unless the switch is on and that role has a usable number. The reader is duplicated byte-identically into `app.js` and `server.js` under the project's dual-sync rule, and a test extracts both copies and asserts they agree.

**Tech Stack:** Plain ES2017 browser JS (`attendance/js/app.js`), Node + Express (`attendance-server/backend/server.js`), JSON file storage, no framework. Tests are plain `node tests/*.test.js` files using `assert`, `vm`, and source extraction; run with `npm run check`.

**Spec:** [`docs/superpowers/specs/2026-10-13-role-allowance-rates-design.md`](../specs/2026-10-13-role-allowance-rates-design.md)

## Global Constraints

- **No role's rate may appear in code**, not even as a default. `DEFAULT_APP_SETTINGS.allowanceRoleRates` is exactly `{ enabled: false, byRole: {} }`. The owner types the amounts in Settings. (Owner's decision, 2026-10-13.)
- **Ship with the switch off and the table empty.** Nothing about anyone's pay may change on deploy. The owner locks the previous period first, then turns the switch on themselves. (Owner's decision, 2026-10-13 — see "Period locking" below.)
- **Dual-sync:** `EARLY_LATE_RATE_KEYS` and `earlyLateRateFor()` must be identical text in `attendance/js/app.js` and `attendance-server/backend/server.js`. Money formulas live in both files; changing one only makes the web and the payroll disagree silently.
- **Never wrap the reader's result in `|| default`.** `0` is a legal rate meaning "do not pay this tier"; `0 || 240` pays 240. (Project memory: `feedback_attendance_falsy_zero_settings.md`.)
- **The Settings table's rows are derived from `allowanceEligibility.earlyLate`**, never hardcoded. Today that live value is `["manager","user"]`, so the table shows two rows; if the owner later grants `md`/`driver` the allowance, the rows appear on their own. (Owner's decision, 2026-10-13.)
- **Every user-facing string must ship in all three languages** (TH/EN/JA) in the same change. (Project memory: `feedback_attendance_i18n_always_3_langs.md`.)
- **Every rule embedded in code gets a dated comment** saying who decided it and what was broken before. (Project memory: `feedback_attendance_annotate_rules_in_code.md`.)
- **Bump the cache-buster** for any `app.js` change, or browsers keep the old file. `tests/cache-buster-bump.test.js` guards this.
- `node --check` each edited JS file before running tests. ESLint does not catch TDZ.
- Tests must **not** pin the number 360, or any role's real rate. Pin the mechanism with invented values, so the owner editing a rate never turns a test red.

## Period locking — a precondition this plan does NOT implement

Measured on 2026-10-13 against production `attendance-server/backend/data/settings.json`: `periodLocks` has **0 entries** and `finalize.json` is `{}`. No period has ever been locked.

The spec's claim that "this period onward" comes for free depends on older periods already being locked. It is not true today: payroll reads the settings at close time, so turning the switch on would change **every period that is still open**, retroactively.

The owner decided (2026-10-13): **lock the earlier periods first, then turn the switch on.** Locking is done by the owner in the real web UI. This plan therefore ships `enabled: false` with an empty table, which changes nobody's pay, and the sequencing is safe by construction. **No task here locks a period, and no task may.**

## Review Focus

Failure modes the spec implies but does not give a test. Each has its test assigned to the task that owns the code.

1. **A role rate of `0` must pay `0`, not fall back to 240/480.** Seven existing read sites are written `(S.earlyMorning2 || 480)`; routing them through the reader but keeping the `||` reintroduces the falsy-zero bug on the one value that means "stop paying this". → Task 1 and Task 4 tests.
2. **A role row filled in only partly** (e.g. `manager` has `earlyMorning1` but not `lateNight2`) must take the company-wide amount for the missing keys, never `0` and never `undefined` (which would make payroll add `NaN` and silently zero a whole payslip). → Task 1 test.
3. **A row for a role that is not eligible for `earlyLate` at all** (e.g. `accounting`) must never cause a payment. Rates and eligibility are separate gates and the eligibility gate must still decide first. → Task 2 test.
4. **An admin looking at someone else's row must see that person's rate**, not their own. Every display site must pass the row owner's role; `renderAttendanceTable`'s legend currently runs *before* `targetUser` exists, so this one needs a reordering, not just a new argument. → Task 4 and Task 5 tests.
5. **A Settings save that omits `allowanceRoleRates` must not delete it.** `server.js:4907` rebuilds `current.appSettings` from `ALLOWED_APPSETTINGS_KEYS` only, so a section missing from that list is silently erased from disk by the next unrelated save — and a section present in the body but missing from the list makes the whole page refuse to save, the bug the spec already warns about. → Task 6 test.

---

### Task 1: The reader, the defaults, and the dual-sync proof

**Files:**
- Modify: `attendance-server/backend/server.js` — add `allowanceRoleRates` to `DEFAULT_APP_SETTINGS` (block at `9320-9330`); add `EARLY_LATE_RATE_KEYS` + `earlyLateRateFor()` next to `DEFAULT_ALLOWANCE_ELIGIBILITY` (`9369`)
- Modify: `attendance/js/app.js` — add `allowanceRoleRates` to `APP_SETTINGS` (block at `1695-1703`); add the identical `EARLY_LATE_RATE_KEYS` + `earlyLateRateFor()`
- Test: `tests/role-allowance-rates.test.js` (create)
- Test: `tests/payroll-rules.test.js` — add `'earlyLateRateFor'` to the `SHARED` array (`line ~57`)

**Interfaces:**
- Consumes: nothing.
- Produces: `EARLY_LATE_RATE_KEYS: string[]` and `earlyLateRateFor(role: string|undefined, key: string, S: object) => number|undefined`, available as module-level declarations in both files. Every later task calls only this. It returns `S.allowances[key]` unchanged whenever an override does not apply, so a caller never needs its own fallback.

- [ ] **Step 1: Write the failing test**

Create `tests/role-allowance-rates.test.js`:

```js
// Per-role early-morning / late-night rates (2026-10-13, owner's decision).
//
// The rates themselves are DATA, not code: this file must never assert a real rate for a real
// role, or the owner editing a rate on the Settings page turns a test red. Everything below uses
// invented numbers and proves the mechanism.
//
// Both copies of earlyLateRateFor() are extracted from the real sources, so the dual-sync rule
// (app.js and server.js must agree about money) is proven here and not assumed.
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

function load(src) {
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(`const EARLY_LATE_RATE_KEYS = ${extractKeys(src)};\n${extractFunction(src, 'earlyLateRateFor')}\nthis.rate = earlyLateRateFor; this.KEYS = EARLY_LATE_RATE_KEYS;`, ctx);
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
  for (const cfg of [undefined, null, {}, [], 'x', { enabled: true }, { enabled: true, byRole: null }, { enabled: true, byRole: [] }, { enabled: 'yes', byRole: { manager: { earlyMorning1: 5 } } }]) {
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
    const m = /byRole:\s*\{\s*[^}\s]/.exec(src);
    assert.ok(!m, `${label} ships a non-empty byRole -- rates are data, not code`);
  }
});

console.log(`\n${passed} assertions passed`);
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node tests/role-allowance-rates.test.js`
Expected: FAIL — `EARLY_LATE_RATE_KEYS not found` (the function does not exist yet).

- [ ] **Step 3: Add the reader to `server.js`**

Insert immediately above `const DEFAULT_ALLOWANCE_ELIGIBILITY = {` (currently `server.js:9369`):

```js
// ===== PER-ROLE EARLY-MORNING / LATE-NIGHT RATES =====
// 2026-10-13 (owner's decision): manager is to be paid a different early-morning / late-night
// rate from everyone else. What the owner asked for is a SWITCH plus EDITABLE AMOUNTS, not the
// number itself, so no role's rate appears here or in DEFAULT_APP_SETTINGS -- the table ships
// empty and the owner fills it in on the Settings page. Before this, the four amounts in
// `allowances` were one company-wide value each with no role dimension at all.
//
// DUAL-SYNC: EARLY_LATE_RATE_KEYS and earlyLateRateFor() must stay IDENTICAL TEXT in
// attendance/js/app.js and this file. tests/role-allowance-rates.test.js extracts both copies
// and compares them, because a drift here shows one number on the web and pays a different one,
// with nothing failing.
//
// A configured 0 is legal and means "do not pay this tier", so the guard is
// Number.isFinite && >= 0. NEVER write `|| 240` around this function's result: `0 || 240`
// pays 240 (see project memory feedback_attendance_falsy_zero_settings.md).
//
// This is deliberately only about the rate. Whether the role may be paid at all stays with
// isAllowanceEligible(..., 'earlyLate'), which every caller already checks first; a row here for
// an ineligible role must therefore never cause a payment.
const EARLY_LATE_RATE_KEYS = ['earlyMorning1', 'earlyMorning2', 'lateNight1', 'lateNight2'];
function earlyLateRateFor(role, key, S) {
  const central = S && S.allowances ? S.allowances[key] : undefined;
  if (!EARLY_LATE_RATE_KEYS.includes(key)) return central;
  const cfg = S && S.allowanceRoleRates;
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg) || cfg.enabled !== true || !role) return central;
  const byRole = cfg.byRole;
  if (!byRole || typeof byRole !== 'object' || Array.isArray(byRole)) return central;
  const row = byRole[role];
  if (!row || typeof row !== 'object' || Array.isArray(row)) return central;
  const v = row[key];
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return central;
  return v;
}
```

Then add to `DEFAULT_APP_SETTINGS`, immediately after the `allowances: { ... }` block closes (after `server.js:9329`):

```js
  // 2026-10-13: ships OFF with no role configured, so deploying this changes nobody's pay.
  // The owner turns it on and types the amounts in Settings -- see earlyLateRateFor().
  allowanceRoleRates: { enabled: false, byRole: {} },
```

- [ ] **Step 4: Add the identical reader to `app.js`**

Paste the **same** comment block, `EARLY_LATE_RATE_KEYS`, and `earlyLateRateFor()` into `attendance/js/app.js`, changing only the one phrase `and this file` → `and attendance-server/backend/server.js`, and `attendance/js/app.js and` → `this file and`. Put it immediately above `function earlyMorningThresholdMins(tier) {` (currently `app.js:3038`), so the reader is declared before every caller added in later tasks.

> The dual-sync test compares `extractFunction(...)` output only — the function body, not the comment — so the wording difference above is safe. The two `EARLY_LATE_RATE_KEYS` lines must match exactly.

Then add to `APP_SETTINGS`, immediately after its `allowances: { ... }` block closes (after `app.js:1702`):

```js
  // 2026-10-13: see server.js DEFAULT_APP_SETTINGS -- ships OFF with no role configured.
  allowanceRoleRates: { enabled: false, byRole: {} },
```

- [ ] **Step 5: Add the reader to the dual-sync roster**

In `tests/payroll-rules.test.js`, add `'earlyLateRateFor'` to the `SHARED` array (currently `line ~57`), so the existing payroll sandbox can call it once later tasks route payroll through it.

- [ ] **Step 6: Syntax-check and run the tests**

```bash
node --check attendance/js/app.js
node --check attendance-server/backend/server.js
node tests/role-allowance-rates.test.js
node tests/payroll-rules.test.js
```
Expected: `role-allowance-rates` all ok; `payroll-rules` still passes unchanged.

- [ ] **Step 7: Commit**

```bash
git add attendance/js/app.js attendance-server/backend/server.js tests/role-allowance-rates.test.js tests/payroll-rules.test.js
git commit -m "feat(allowance): one reader for per-role early/late rates, shipped switched off

The four early-morning/late-night amounts had no role dimension. This adds the
settings section and the single reader every rate read will go through, with the
switch off and no role configured, so nothing about anyone's pay changes yet.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: The payer — route `server.js` payroll through the reader

This is the only code that moves real money. It goes first and alone so a reviewer can reject it on its own.

**Files:**
- Modify: `attendance-server/backend/server.js:5358-5359` (`earlyMorningBonusFromWorkStartTime`), `10397`, `10399`, `10405`, `10416`, `10417` (`computePayroll`)
- Test: `tests/role-allowance-rates.test.js` (extend)

**Interfaces:**
- Consumes: `earlyLateRateFor(role, key, S)` and `EARLY_LATE_RATE_KEYS` from Task 1.
- Produces: `earlyMorningBonusFromWorkStartTime(workStartTime, S, role)` — third parameter added, optional; omitting it keeps the company-wide amount. No other signature changes; `computePayroll` already has `user.role` in scope (it is used at `server.js:10348`).

- [ ] **Step 1: Write the failing test**

Append to `tests/role-allowance-rates.test.js`, before the final `console.log`:

```js
// ---- the payer: server.js must not read the four amounts directly any more ----
// A read that bypasses earlyLateRateFor() is the failure the spec calls most likely: it pays the
// company-wide rate while the web shows the role rate, and no test would otherwise notice.
test('server.js payroll reads no early/late amount directly', () => {
  const offenders = [];
  SERVER_SRC.split('\n').forEach((line, i) => {
    if (/\/\//.test(line.trim().slice(0, 2))) return;
    if (/S\.allowances\.(earlyMorning1|earlyMorning2|lateNight1|lateNight2)\b/.test(line)) {
      offenders.push(`${i + 1}: ${line.trim()}`);
    }
  });
  assert.deepStrictEqual(offenders, [], `these server.js lines still read the amount directly instead of calling earlyLateRateFor():\n  ${offenders.join('\n  ')}`);
});

// Review Focus 3: a rate row must never become permission to be paid.
test('a rate row for an ineligible role is not a licence to pay', () => {
  // accounting is absent from allowanceEligibility.earlyLate, so the eligibility gate -- which is
  // a different function and runs first -- must still refuse. earlyLateRateFor() answers only
  // "how much", and is allowed to return a number for a role that will never be asked about.
  const s = S({ enabled: true, byRole: { accounting: { earlyMorning1: 5 } } });
  assert.strictEqual(both('accounting', 'earlyMorning1', s), 5, 'the reader answers how much, nothing else');
  const eligSrc = extractFunction(SERVER_SRC, 'isAllowanceEligible');
  assert.ok(!/allowanceRoleRates/.test(eligSrc), 'eligibility must not consult the rate table');
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node tests/role-allowance-rates.test.js`
Expected: FAIL — the offenders list has 7 `server.js` lines.

- [ ] **Step 3: Route the helper**

`server.js:5355-5362` becomes:

```js
// 2026-10-13: takes the employee's role so the per-role rate table applies here too
// (earlyLateRateFor). Omitting `role` keeps the company-wide amount, which is what every
// caller got before this parameter existed.
function earlyMorningBonusFromWorkStartTime(workStartTime, S, role) {
  const mins = parseHHMMToMins(workStartTime);
  if (!Number.isFinite(mins)) return { earlyCount: 0, bonus: 0 };
  if (mins <= S.allowances.earlyThreshold2Min) return { earlyCount: 2, bonus: earlyLateRateFor(role, 'earlyMorning2', S) };
  if (mins <= S.allowances.earlyThreshold1Min) return { earlyCount: 1, bonus: earlyLateRateFor(role, 'earlyMorning1', S) };
  return { earlyCount: 0, bonus: 0 };
}
```

> This function currently has **no caller in `server.js`** (grep: only the definition). Leave it in place and routed — `tests/payroll-rules.test.js` extracts functions by name, and a future caller must get the role-aware behaviour. Do not delete it in this task; it is out of scope.

- [ ] **Step 4: Route `computePayroll`**

In `server.js`, inside `computePayroll`, immediately below the existing `const canEarlyLate = ...` line (`10348`), add:

```js
  // 2026-10-13: the rate for THIS employee's role. `user` is the person being paid, so this is
  // the owner of the row, never whoever triggered the payroll run.
  const _elRate = (key) => earlyLateRateFor(user.role, key, S);
```

Then replace each amount read:

| Line | Before | After |
|---|---|---|
| `10397` | `earlyLateBonus += S.allowances.earlyMorning2;` | `earlyLateBonus += _elRate('earlyMorning2');` |
| `10399` | `earlyLateBonus += S.allowances.earlyMorning1;` | `earlyLateBonus += _elRate('earlyMorning1');` |
| `10405` | `earlyLateBonus += lnPts === 2 ? S.allowances.lateNight2 : S.allowances.lateNight1;` | `earlyLateBonus += lnPts === 2 ? _elRate('lateNight2') : _elRate('lateNight1');` |
| `10416` | `earlyCount += 2; earlyLateBonus += S.allowances.earlyMorning2;` | `earlyCount += 2; earlyLateBonus += _elRate('earlyMorning2');` |
| `10417` | `earlyCount += 1; earlyLateBonus += S.allowances.earlyMorning1;` | `earlyCount += 1; earlyLateBonus += _elRate('earlyMorning1');` |

- [ ] **Step 5: Run the tests**

```bash
node --check attendance-server/backend/server.js
node tests/role-allowance-rates.test.js
node tests/payroll-rules.test.js
```
Expected: both pass. `payroll-rules` proves the payroll numbers are unchanged while the switch is off.

- [ ] **Step 6: Commit**

```bash
git add attendance-server/backend/server.js tests/role-allowance-rates.test.js
git commit -m "feat(allowance): payroll pays the role's early/late rate

Every amount read in server.js payroll now goes through earlyLateRateFor() with
the paid employee's role, and a test refuses any direct read of the four amounts
so a later edit cannot quietly bypass it. Behaviour is unchanged while the switch
is off.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: The web engine — route `app.js` payroll and the payslip's own figures

**Files:**
- Modify: `attendance/js/app.js:13932`, `13933`, `13941`, `13942`, `13953`, `13954` (`computePayroll`, starts `13838`)
- Modify: `attendance/js/app.js:14080` (the `computePayroll` return) and `14615-14618` (the payslip calculation lines)
- Test: `tests/role-allowance-rates.test.js` (extend)

**Interfaces:**
- Consumes: `earlyLateRateFor` (Task 1).
- Produces: `computePayroll()`'s returned object gains four fields — `early1Rate`, `early2Rate`, `lateNight1Rate`, `lateNight2Rate` (numbers, the rate actually used for that employee). Task 4 and anything else that prints "rate × days" reads these instead of looking the rate up again.

> **Why the return grows:** `14615-14618` print `rate/day × days = total`, and today they re-read the company-wide amount while `c.early2Amount` beside them was computed from the real one. With a per-role rate those two disagree, which is exactly the "the screen does not match the payslip" failure the spec names. Taking the rate from the engine makes the printed rate the paid rate by construction, and needs no role at the print site.

- [ ] **Step 1: Write the failing test**

Append to `tests/role-allowance-rates.test.js`:

```js
// ---- the web engine ----
test('app.js payroll reads no early/late amount directly', () => {
  const offenders = [];
  APP_SRC.split('\n').forEach((line, i) => {
    const n = i + 1;
    // 5400-6310 is the Settings page, which reads and writes the COMPANY-WIDE amounts on
    // purpose; those are the values the role table overrides, not a bypass of it.
    if (n >= 5400 && n <= 6310) return;
    if (/\/\//.test(line.trim().slice(0, 2))) return;
    if (/S\.allowances\.(earlyMorning1|earlyMorning2|lateNight1|lateNight2)\b/.test(line)) offenders.push(`${n}: ${line.trim()}`);
    if (/APP_SETTINGS\.allowances\.(earlyMorning1|earlyMorning2|lateNight1|lateNight2)\b/.test(line)) offenders.push(`${n}: ${line.trim()}`);
  });
  assert.deepStrictEqual(offenders, [], `these app.js lines still read the amount directly:\n  ${offenders.join('\n  ')}`);
});

test('computePayroll reports the rate it used, so the payslip cannot print a different one', () => {
  const ret = /early2Count, early2Amount, early1Count, early1Amount, lateNight2Count, lateNight2Amount, lateNight1Count, lateNight1Amount,/.exec(APP_SRC);
  assert.ok(ret, 'the computePayroll return block changed shape -- re-point this test');
  for (const f of ['early1Rate', 'early2Rate', 'lateNight1Rate', 'lateNight2Rate']) {
    assert.ok(new RegExp(`\\b${f}\\b`).test(APP_SRC), `computePayroll must return ${f}`);
  }
  // and the payslip lines must print those, not a fresh lookup
  const calc = APP_SRC.split('\n').slice(14600, 14625).join('\n');
  assert.ok(/c\.early2Rate|early2Rate/.test(calc), 'the payslip calc lines must print the engine\'s rate');
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node tests/role-allowance-rates.test.js`
Expected: FAIL — offenders list has the `app.js` payroll and payslip lines.

- [ ] **Step 3: Route `app.js` `computePayroll`**

Inside `computePayroll(user, start, end, periodIndex)` (`13838`), immediately above the `let lateNight2Count = 0, ...` line (`13922`), add:

```js
  // 2026-10-13: the rate for THIS employee's role -- the same reader and the same role the
  // server's computePayroll uses, so the web preview and the payslip cannot diverge from what
  // payroll pays (project rule: the money formula lives in two files and must agree).
  const _elRate = (key) => earlyLateRateFor(user.role, key, S);
  const _r = { early1: _elRate('earlyMorning1'), early2: _elRate('earlyMorning2'), lateNight1: _elRate('lateNight1'), lateNight2: _elRate('lateNight2') };
```

Replace the six reads:

| Line | Before (fragment) | After |
|---|---|---|
| `13932` | `earlyLateBonus += S.allowances.earlyMorning2; early2Count++; early2Amount += S.allowances.earlyMorning2;` | `earlyLateBonus += _r.early2; early2Count++; early2Amount += _r.early2;` |
| `13933` | `earlyLateBonus += S.allowances.earlyMorning1; early1Count++; early1Amount += S.allowances.earlyMorning1;` | `earlyLateBonus += _r.early1; early1Count++; early1Amount += _r.early1;` |
| `13941` | `earlyLateBonus += S.allowances.lateNight2; lateNight2Count++; lateNight2Amount += S.allowances.lateNight2;` | `earlyLateBonus += _r.lateNight2; lateNight2Count++; lateNight2Amount += _r.lateNight2;` |
| `13942` | `earlyLateBonus += S.allowances.lateNight1; lateNight1Count++; lateNight1Amount += S.allowances.lateNight1;` | `earlyLateBonus += _r.lateNight1; lateNight1Count++; lateNight1Amount += _r.lateNight1;` |
| `13953` | `earlyLateBonus += S.allowances.earlyMorning2; early2Count++; early2Amount += S.allowances.earlyMorning2;` | `earlyLateBonus += _r.early2; early2Count++; early2Amount += _r.early2;` |
| `13954` | `earlyLateBonus += S.allowances.earlyMorning1; early1Count++; early1Amount += S.allowances.earlyMorning1;` | `earlyLateBonus += _r.early1; early1Count++; early1Amount += _r.early1;` |

- [ ] **Step 4: Return the rates**

At `app.js:14080`, extend the returned object:

```js
    early2Count, early2Amount, early1Count, early1Amount, lateNight2Count, lateNight2Amount, lateNight1Count, lateNight1Amount,
    // 2026-10-13: the rate actually used for this employee, so anything printing "rate x days"
    // prints what was paid instead of looking the company-wide amount up a second time.
    early1Rate: _r.early1, early2Rate: _r.early2, lateNight1Rate: _r.lateNight1, lateNight2Rate: _r.lateNight2,
```

- [ ] **Step 5: Print the engine's rate on the payslip**

`app.js:14615-14618` become:

```js
    if (c.early2Count > 0) calcLines.push(`* Allowance 2 (Early Morning, before ${APP_SETTINGS.allowances.earlyThreshold2Min != null ? Math.floor(APP_SETTINGS.allowances.earlyThreshold2Min/60)+':'+String(APP_SETTINGS.allowances.earlyThreshold2Min%60).padStart(2,'0') : ''}): ${fmt2(c.early2Rate)}/day x ${c.early2Count} days = ${fmt2(c.early2Amount)}`);
    if (c.early1Count > 0) calcLines.push(`* Allowance 2 (Early Morning): ${fmt2(c.early1Rate)}/day x ${c.early1Count} days = ${fmt2(c.early1Amount)}`);
    if (c.lateNight2Count > 0) calcLines.push(`* Allowance 2 (Late Night): ${fmt2(c.lateNight2Rate)}/day x ${c.lateNight2Count} days = ${fmt2(c.lateNight2Amount)}`);
    if (c.lateNight1Count > 0) calcLines.push(`* Allowance 2 (Late Night): ${fmt2(c.lateNight1Rate)}/day x ${c.lateNight1Count} days = ${fmt2(c.lateNight1Amount)}`);
```

> `c.early2Rate` can be `undefined` on an **old stored snapshot** computed before this change. The line only runs when `c.early2Count > 0`, and such a snapshot also carries `early2Amount`, so guard it: use `fmt2(c.early2Rate != null ? c.early2Rate : c.early2Amount / c.early2Count)` for each of the four. Snapshot immutability is a standing project rule (`project_time_attendance_payroll_snapshot_immutability.md`) — an old payslip must keep printing the number it was paid.

- [ ] **Step 6: Run the tests**

```bash
node --check attendance/js/app.js
node tests/role-allowance-rates.test.js
node tests/payroll-rules.test.js
node tests/day-pay-preview.test.js
```
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add attendance/js/app.js tests/role-allowance-rates.test.js
git commit -m "feat(allowance): the web engine and the payslip use the role's rate

app.js computePayroll reads the four amounts through earlyLateRateFor() with the
employee's role, and now returns the rate it used so the payslip's "rate x days"
line prints what was paid instead of looking the company-wide amount up again.
Old snapshots keep printing their own figure.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: Everywhere a number is shown to a person

The spec names this the riskiest group: a badge showing ฿240 next to a day that paid ฿360 reads as a calculation bug. Two display sites show **other people's** rows and must use the row owner's role.

**Files:**
- Modify: `attendance/js/app.js:3042-3045` (`earlyMorningAllowanceForTier`) and `18099-18103` (`lateOutAllowanceForHour`) — add a role parameter
- Modify: `attendance/js/app.js:10359-10360`, `10420` (attendance table badges — use `targetUser.role`)
- Modify: `attendance/js/app.js:20758`, `20766` (attendance detail modal — use the existing `targetRole`, defined at `20569`)
- Modify: `attendance/js/app.js:17010` (request-detail tier line — role of `l.userId`)
- Test: `tests/role-allowance-rates.test.js` (extend)

**Interfaces:**
- Consumes: `earlyLateRateFor` (Task 1).
- Produces: `earlyMorningAllowanceForTier(tier, role)` and `lateOutAllowanceForHour(hour, role)`. In both, `role` is optional and defaults to the signed-in user's role via `selfRateRole()`; callers that are about someone else must pass that person's role explicitly.
- Produces: `selfRateRole() => string|undefined` — returns `currentUser && currentUser.role`, or `undefined` before sign-in.

- [ ] **Step 1: Write the failing test**

Append to `tests/role-allowance-rates.test.js`:

```js
// ---- what people see ----
// Review Focus 1 again, at the display sites: these seven lines were written `(x || 480)`, and
// keeping the `||` after routing them re-breaks the one value that means "stop paying".
test('no display site wraps a rate in || default', () => {
  const offenders = [];
  APP_SRC.split('\n').forEach((line, i) => {
    if (/earlyLateRateFor\([^)]*\)\s*\|\|/.test(line)) offenders.push(`${i + 1}: ${line.trim()}`);
    if (/(earlyMorningAllowanceForTier|lateOutAllowanceForHour)\([^)]*\)\s*\|\|/.test(line)) offenders.push(`${i + 1}: ${line.trim()}`);
  });
  assert.deepStrictEqual(offenders, [], `a rate must never be wrapped in "|| default" -- 0 is a legal rate:\n  ${offenders.join('\n  ')}`);
});

// Review Focus 4: an admin must see the row owner's rate, not their own.
test('the two sites that show other people use that person\'s role', () => {
  const lines = APP_SRC.split('\n');
  // attendance table badges
  const table = lines.slice(10340, 10430).join('\n');
  assert.ok(/earlyLateRateFor\(\s*targetUser\.role/.test(table) || /_elRateTarget\(/.test(table),
    'renderAttendanceTable badges must take the rate for targetUser.role');
  assert.ok(!/earlyLateRateFor\(\s*(currentUser|selfRateRole\(\))/.test(table),
    'renderAttendanceTable must not use the viewer\'s role');
  // attendance detail modal
  const modal = lines.slice(20740, 20775).join('\n');
  assert.ok(/earlyLateRateFor\(\s*targetRole/.test(modal) || /_elRateTarget\(/.test(modal),
    'the attendance detail modal must take the rate for targetRole');
});

test('the self-service helpers take an optional role and default to the signed-in user', () => {
  assert.ok(/function earlyMorningAllowanceForTier\(tier, role\)/.test(APP_SRC));
  assert.ok(/function lateOutAllowanceForHour\(hour, role\)/.test(APP_SRC));
  const self = extractFunction(APP_SRC, 'selfRateRole');
  assert.ok(/currentUser/.test(self), 'selfRateRole must read currentUser');
  // It must tolerate running before sign-in: the reader already falls back when role is falsy.
  const ctx = { currentUser: null };
  vm.createContext(ctx);
  vm.runInContext(`${self}\nthis.out = selfRateRole();`, ctx);
  assert.strictEqual(ctx.out, undefined, 'selfRateRole must return undefined before sign-in, not throw');
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node tests/role-allowance-rates.test.js`
Expected: FAIL — `function selfRateRole not found`.

- [ ] **Step 3: Add `selfRateRole()` and route the two helpers**

Immediately below the `earlyLateRateFor` block added to `app.js` in Task 1:

```js
// 2026-10-13: the rate-lookup role for a self-service screen (a request form, its toast, the FAQ).
// Returns undefined before sign-in, and earlyLateRateFor() falls back to the company-wide amount
// on a falsy role, so anything that renders before login still shows a number and never throws.
// Do NOT call this from fixStaticText() -- that runs before login and must not touch currentUser
// (project memory: feedback_attendance_fixstatictext.md).
function selfRateRole() {
  return (currentUser && currentUser.role) || undefined;
}
```

`app.js:3042-3045` becomes:

```js
// 2026-10-13: `role` picks whose rate to report. It defaults to the signed-in user because every
// existing caller is a self-service screen; a screen showing someone else must pass that person's
// role, or an admin would be shown their own rate on another employee's row.
function earlyMorningAllowanceForTier(tier, role) {
  const r = role === undefined ? selfRateRole() : role;
  return earlyLateRateFor(r, tier === 2 ? 'earlyMorning2' : 'earlyMorning1', APP_SETTINGS);
}
```

`app.js:18099-18103` becomes:

```js
// 2026-10-13: `role` as in earlyMorningAllowanceForTier -- defaults to the signed-in user.
function lateOutAllowanceForHour(hour, role) {
  const S = APP_SETTINGS.allowances;
  const thr2 = lateNightThresholdHourOf(S, 2);
  const r = role === undefined ? selfRateRole() : role;
  return earlyLateRateFor(r, lateNightThresholdMins(hour) >= lateNightThresholdMins(thr2) ? 'lateNight2' : 'lateNight1', APP_SETTINGS);
}
```

> Leave all ten existing callers of `lateOutAllowanceForHour` and all four of `earlyMorningAllowanceForTier` unchanged — every one is about the signed-in user, and the default covers them. Do **not** add a role argument to `app.js:14747`, which runs over a leave record in the signed-in user's own list.

- [ ] **Step 4: Route the attendance table badges**

In `renderAttendanceTable`, immediately below `const _ATallowances = APP_SETTINGS.allowances;` (`10350`), add:

```js
    // 2026-10-13: the rate belongs to the EMPLOYEE WHOSE ROW THIS IS (targetUser), not to whoever
    // is looking. Accounting/MD browse other people here, and showing them their own rate on
    // someone else's row reads as the system miscalculating.
    const _elRateTarget = (key) => earlyLateRateFor(targetUser.role, key, APP_SETTINGS);
```

Then:
- `10359-10360`: `const bonus = mins <= (_ATallowances.earlyThreshold2Min || 390) ? `฿${_elRateTarget('earlyMorning2')}` : `฿${_elRateTarget('earlyMorning1')}`;`
- `10420`: `const bonus = lateNightPoints(row.lateOut, _ln2Thr) === 2 ? `฿${_elRateTarget('lateNight2')}` : `฿${_elRateTarget('lateNight1')}`;`

The `|| 480` / `|| 240` fallbacks disappear with the reader taking over; the threshold fallbacks (`|| 390`) stay as they are, they are not rates.

- [ ] **Step 5: Route the attendance detail modal**

`20758` and `20766` already sit where `targetRole` (`20569`) is in scope:

- `20758`: `const bonus = `฿${mins <= (_dA.earlyThreshold2Min ?? 390) ? earlyLateRateFor(targetRole, 'earlyMorning2', APP_SETTINGS) : earlyLateRateFor(targetRole, 'earlyMorning1', APP_SETTINGS)}`;`
- `20766`: `const bonus = `฿${lateNightPoints(row.lateOut, _ln2Thr) === 2 ? earlyLateRateFor(targetRole, 'lateNight2', APP_SETTINGS) : earlyLateRateFor(targetRole, 'lateNight1', APP_SETTINGS)}`;`

- [ ] **Step 6: Route the request-detail tier line**

`app.js:17010` renders a request record `l`, which may belong to someone else (an approver reading it). Replace:

```js
    const tier = Number(l.earlyMorningTier) || 0;
    // 2026-10-13: the rate of the person who filed the request, not of the approver reading it.
    const _reqRole = (DATA_USERS.find(u => u.id === l.userId) || {}).role;
    const bonus = tier === 2 ? earlyLateRateFor(_reqRole, 'earlyMorning2', APP_SETTINGS)
      : tier === 1 ? earlyLateRateFor(_reqRole, 'earlyMorning1', APP_SETTINGS) : 0;
```

- [ ] **Step 7: Run the tests**

```bash
node --check attendance/js/app.js
node tests/role-allowance-rates.test.js
node tests/inline-handlers.test.js
node tests/ui-glyphs.test.js
```
Expected: all pass.

- [ ] **Step 8: Commit**

```bash
git add attendance/js/app.js tests/role-allowance-rates.test.js
git commit -m "feat(allowance): every badge shows the row owner's rate

The attendance table, the detail modal and the request detail now take the rate
for the employee whose row it is, not the viewer's, and the self-service helpers
default to the signed-in user. The old `|| 480` fallbacks are gone from the rate
reads, so a configured 0 shows as 0 instead of silently becoming 480.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: The legend and the FAQ, in three languages

**Files:**
- Modify: `attendance/js/app.js:10213-10214` (hoist `targetUserId`/`targetUser` above the legend) and `10191-10204` (the legend)
- Modify: `attendance/js/app.js:23489-23491` (the FAQ's early-morning answer, TH/EN/JA)
- Test: `tests/role-allowance-rates.test.js` (extend)

**Interfaces:**
- Consumes: `earlyLateRateFor`, `selfRateRole` (Tasks 1 and 4).
- Produces: nothing other tasks use.

- [ ] **Step 1: Write the failing test**

Append to `tests/role-allowance-rates.test.js`:

```js
// ---- the legend and the FAQ ----
test('the legend is built after targetUser exists', () => {
  const fn = extractFunction(APP_SRC, 'renderAttendanceTable');
  const tgt = fn.indexOf('const targetUser ');
  const legend = fn.indexOf('att-legend-early');
  assert.ok(tgt > -1 && legend > -1, 'renderAttendanceTable changed shape -- re-point this test');
  assert.ok(tgt < legend, 'targetUser must be declared BEFORE the legend reads its role (TDZ: the legend used to run first)');
});

test('the legend labels the table it sits above, so it uses targetUser\'s rate', () => {
  const fn = extractFunction(APP_SRC, 'renderAttendanceTable');
  const legend = fn.slice(fn.indexOf('att-legend-early') - 400, fn.indexOf('att-legend-late') + 600);
  assert.ok(/earlyLateRateFor\(\s*targetUser\.role|_elRateLegend\(/.test(legend), 'the legend must use the viewed employee\'s rate');
  assert.ok(!/_legA\.(earlyMorning1|earlyMorning2|lateNight1|lateNight2)/.test(legend), 'the legend still reads the company-wide amount directly');
});

test('the FAQ answer carries the rate in all three languages', () => {
  const faq = APP_SRC.split('\n').slice(23480, 23500).join('\n');
  const hits = (faq.match(/earlyLateRateFor\(/g) || []).length;
  assert.ok(hits >= 6, `the FAQ's three languages each name two rates, so expect >= 6 reader calls, found ${hits}`);
  for (const marker of ['Check in at the face scanner', 'สแกนเข้าที่เครื่องก่อน', '顔認証端末で']) {
    assert.ok(faq.includes(marker), `the ${marker} language variant went missing -- all three ship together`);
  }
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node tests/role-allowance-rates.test.js`
Expected: FAIL — `targetUser must be declared BEFORE the legend`.

- [ ] **Step 3: Hoist `targetUser` above the legend**

Move these two lines (currently `app.js:10213-10214`) to sit immediately after `if (mobileCards) mobileCards.innerHTML = '';` (`10188`), keeping their order and text:

```js
  const targetUserId = canViewOthers ? (selectedAttUserId || currentUser.id) : currentUser.id;
  const targetUser = canViewOthers ? (DATA_USERS.find(u => u.id === targetUserId) || currentUser) : currentUser;
```

Add above them:

```js
  // 2026-10-13: hoisted above the legend. The legend now names this employee's rate, and it used
  // to be built before targetUser was declared -- reading it there would be a TDZ crash that
  // ESLint does not catch (project memory: feedback_attendance_js_edit_safety.md).
```

Delete the two moved lines from their old position. Verify `const isViewingSelf = targetUserId === currentUser.id;` (which followed them) still comes after.

- [ ] **Step 4: Route the legend**

Replace `const _legA = APP_SETTINGS.allowances;` (`10192`) with:

```js
  const _legA = APP_SETTINGS.allowances;
  // 2026-10-13: the legend explains the table right below it, so it quotes the rate of the
  // employee being viewed. An admin reading someone else's attendance saw their own rate here.
  const _elRateLegend = (key) => earlyLateRateFor(targetUser.role, key, APP_SETTINGS);
```

Then in the four legend template strings (`10195-10197`, `10202-10204`), replace every `${_legA.earlyMorning2}` → `${_elRateLegend('earlyMorning2')}`, `${_legA.earlyMorning1}` → `${_elRateLegend('earlyMorning1')}`, `${_legA.lateNight2}` → `${_elRateLegend('lateNight2')}`, `${_legA.lateNight1}` → `${_elRateLegend('lateNight1')}`. Leave every `_legA.earlyThreshold*Min` and `_legA.lateNightThreshold*Hour` alone — those are times, not money, and are company-wide.

- [ ] **Step 5: Route the FAQ, all three languages together**

In the FAQ block at `23489-23491`, add above it:

```js
      // 2026-10-13: the FAQ answers "what do I get", so it quotes the reader's own rate. All
      // three languages change together (project rule: TH/EN/JA ship in one edit).
      const _faqEm1 = earlyLateRateFor(selfRateRole(), 'earlyMorning1', APP_SETTINGS);
      const _faqEm2 = earlyLateRateFor(selfRateRole(), 'earlyMorning2', APP_SETTINGS);
```

Then replace each `${S.allowances.earlyMorning1}` with `${_faqEm1}` and `${S.allowances.earlyMorning2}` with `${_faqEm2}` in all three strings. Do not reword anything else.

> Check the enclosing function is not `fixStaticText()` before committing — that one runs before sign-in and must not touch `currentUser`. If the FAQ is built there, drop `selfRateRole()` for `undefined` at these two call sites, which yields the company-wide amount, and note it in the commit message.

- [ ] **Step 6: Run the tests**

```bash
node --check attendance/js/app.js
node tests/role-allowance-rates.test.js
npm test
```
Expected: `npm test` ends `N/N test files passed`.

- [ ] **Step 7: Commit**

```bash
git add attendance/js/app.js tests/role-allowance-rates.test.js
git commit -m "feat(allowance): the legend and the FAQ quote the right person's rate

The attendance legend now names the viewed employee's rate (and targetUser is
hoisted above it, since reading it where the legend sat would be a TDZ crash),
and the FAQ quotes the reader's own, in all three languages.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 6: Accept and keep the new section on the server

Without this task the section cannot be saved — and worse, once saved it would be **deleted** by the next unrelated Settings save.

**Files:**
- Modify: `attendance-server/backend/server.js:4691` (`ALLOWED_APPSETTINGS_KEYS`), `4708` (the must-be-an-object list), and a new validation block after the `lateDeductPolicy` block ends (`4822`)
- Test: `tests/role-allowance-rates.test.js` (extend)

**Interfaces:**
- Consumes: `EARLY_LATE_RATE_KEYS` (Task 1), `ROLE_KEYS` (`server.js:9369`).
- Produces: nothing other tasks use.

> `ROLE_KEYS` and `EARLY_LATE_RATE_KEYS` are module-level `const`s declared *below* this route handler. That is fine — the handler body runs per request, long after the module finished evaluating. Do not move them, and do not reference either at module top level above its declaration.

- [ ] **Step 1: Write the failing test**

Append to `tests/role-allowance-rates.test.js`:

```js
// ---- the server accepts the section, and never silently drops it ----
// Review Focus 5: server.js:4907 rebuilds current.appSettings from ALLOWED_APPSETTINGS_KEYS, so a
// section missing from that list is DELETED from disk by the next unrelated Settings save -- and
// a section in the request body but not in the list makes the whole page refuse to save, which is
// the trap the spec warns about from the morningReviewEnabled incident.
test('allowanceRoleRates is on both server allowlists', () => {
  const allow = /const ALLOWED_APPSETTINGS_KEYS = (\[[^\]]*\]);/.exec(SERVER_SRC);
  assert.ok(allow, 'ALLOWED_APPSETTINGS_KEYS not found');
  assert.ok(/'allowanceRoleRates'/.test(allow[1]),
    'without this, saving Settings once wipes the rate table off disk');
  const objList = /for \(const sub of (\[[^\]]*'allowanceEligibility'[^\]]*\])\)/.exec(SERVER_SRC);
  assert.ok(objList, 'the must-be-an-object list not found');
  assert.ok(/'allowanceRoleRates'/.test(objList[1]),
    'a client could otherwise store a scalar where every reader expects an object');
});

test('the saved shape is validated: known roles, the four keys, money in range', () => {
  const block = /if \(A\.allowanceRoleRates !== undefined\) \{[\s\S]*?\n    \}/.exec(SERVER_SRC);
  assert.ok(block, 'no validation block for allowanceRoleRates');
  const b = block[0];
  assert.ok(/ROLE_KEYS\.includes/.test(b), 'an unknown role must be refused');
  assert.ok(/EARLY_LATE_RATE_KEYS\.includes/.test(b), 'a key outside the four must be refused');
  assert.ok(/100000/.test(b), 'the same 0-100000 money cap as the rest of allowances');
  assert.ok(/typeof RR\.enabled !== 'boolean'/.test(b), 'enabled must be a boolean');
});

test('the rate table is NOT inside allowances, which demands a number from every key', () => {
  // The spec's reason: allowances' validator requires a number (or a boolean for ...Enabled) from
  // every key, so a nested object there makes EVERY Settings save fail until an exception is added.
  assert.ok(!/allowances\.allowanceRoleRates|allowances:\s*\{[^}]*byRole/.test(SERVER_SRC));
  assert.ok(!/allowances\.allowanceRoleRates/.test(APP_SRC));
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node tests/role-allowance-rates.test.js`
Expected: FAIL — `without this, saving Settings once wipes the rate table off disk`.

- [ ] **Step 3: Add to both allowlists**

`server.js:4691` — append `'allowanceRoleRates'` before `'map'`:

```js
  const ALLOWED_APPSETTINGS_KEYS = ['company', 'payroll', 'sso', 'allowances', 'workSchedule', 'geofence', 'leave', 'allowanceTypes', 'lateDeductPolicy', 'tax', 'allowanceEligibility', 'allowanceRoleRates', 'map', 'updatedAt'];
```

`server.js:4708` — add `'allowanceRoleRates'` to the `for (const sub of [...])` list:

```js
    for (const sub of ['company', 'payroll', 'sso', 'allowances', 'workSchedule', 'geofence', 'leave', 'allowanceEligibility', 'allowanceRoleRates', 'lateDeductPolicy', 'tax', 'map']) {
```

- [ ] **Step 4: Add the validation block**

Immediately after the `lateDeductPolicy.tiers` block closes (`server.js:4822`):

```js
    // 2026-10-13: per-role early/late rates (owner's decision). A SEPARATE appSettings section,
    // not a nested object inside `allowances`, because that section's validator demands a number
    // from every key -- the morningReviewEnabled incident showed a nested non-number there makes
    // EVERY later Settings save fail, the whole page. Must also be in ALLOWED_APPSETTINGS_KEYS
    // above, or the deep-merge below rebuilds appSettings without it and the table is wiped.
    if (A.allowanceRoleRates !== undefined) {
      const RR = A.allowanceRoleRates;
      if (Object.keys(RR).some(k => !['enabled', 'byRole'].includes(k))) {
        return res.status(400).json({ success: false, message: 'appSettings.allowanceRoleRates accepts only enabled and byRole' });
      }
      if (typeof RR.enabled !== 'boolean') {
        return res.status(400).json({ success: false, message: 'appSettings.allowanceRoleRates.enabled must be true or false' });
      }
      const byRole = RR.byRole === undefined ? {} : RR.byRole;
      if (!byRole || typeof byRole !== 'object' || Array.isArray(byRole)) {
        return res.status(400).json({ success: false, message: 'appSettings.allowanceRoleRates.byRole must be an object' });
      }
      if (Object.keys(byRole).length > ROLE_KEYS.length) {
        return res.status(400).json({ success: false, message: `appSettings.allowanceRoleRates.byRole must have ${ROLE_KEYS.length} or fewer entries` });
      }
      for (const [role, row] of Object.entries(byRole)) {
        if (!ROLE_KEYS.includes(role)) {
          return res.status(400).json({ success: false, message: `appSettings.allowanceRoleRates.byRole."${role}" is not a known role` });
        }
        if (!row || typeof row !== 'object' || Array.isArray(row)) {
          return res.status(400).json({ success: false, message: `appSettings.allowanceRoleRates.byRole.${role} must be an object` });
        }
        for (const [k, v] of Object.entries(row)) {
          if (!EARLY_LATE_RATE_KEYS.includes(k)) {
            return res.status(400).json({ success: false, message: `appSettings.allowanceRoleRates.byRole.${role}.${k} is not an early-morning or late-night rate` });
          }
          // Same 0-100000 money rule the rest of `allowances` uses. 0 is legal: it means this
          // tier is not paid to this role.
          if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 100000) {
            return res.status(400).json({ success: false, message: `appSettings.allowanceRoleRates.byRole.${role}.${k} must be a number 0-100000` });
          }
        }
      }
      RR.byRole = byRole;
    }
```

- [ ] **Step 5: Run the tests**

```bash
node --check attendance-server/backend/server.js
node tests/role-allowance-rates.test.js
node tests/settings-allowances-validation.test.js
npm test
```
Expected: `npm test` ends `N/N test files passed`.

- [ ] **Step 6: Commit**

```bash
git add attendance-server/backend/server.js tests/role-allowance-rates.test.js
git commit -m "feat(allowance): the server stores the rate table and keeps it

allowanceRoleRates joins both appSettings allowlists -- the second one matters
because the save path rebuilds appSettings from that list, so a section missing
from it is deleted from disk by the next unrelated save -- and gets its own
validation: known roles, the four rate keys, money 0-100000, 0 allowed.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 7: The Settings page — one switch and a table the owner fills in

**Files:**
- Modify: `attendance/js/app.js` — the Allowance Rates card, after the late-night fields (`5431`); the save path, after the late-night lines (`6300`)
- Test: `tests/role-allowance-rates.test.js` (extend)

**Interfaces:**
- Consumes: `EARLY_LATE_RATE_KEYS` (Task 1); `APP_SETTINGS.allowanceEligibility.earlyLate` for the row list.
- Produces: nothing other tasks use.

- [ ] **Step 1: Write the failing test**

Append to `tests/role-allowance-rates.test.js`:

```js
// ---- the Settings page ----
test('the rate table rows come from live eligibility, never a hardcoded role list', () => {
  const m = /set-rolerate-rows|_roleRateRoles\s*=/.exec(APP_SRC);
  assert.ok(m, 'no role-rate table in the Settings page');
  const seg = APP_SRC.slice(APP_SRC.indexOf('_roleRateRoles'), APP_SRC.indexOf('_roleRateRoles') + 400);
  assert.ok(/allowanceEligibility/.test(seg),
    'the rows must be derived from allowanceEligibility.earlyLate, so granting a role the allowance later adds its row on its own');
  assert.ok(!/\['manager',\s*'user'\]/.test(seg), 'the role list must not be hardcoded');
});

test('the switch and every cell round-trip through the save path', () => {
  assert.ok(/APP_SETTINGS\.allowanceRoleRates\s*=/.test(APP_SRC), 'the save path must write the section');
  assert.ok(/set-rolerate-enabled/.test(APP_SRC), 'the on/off switch field is missing');
});

test('the table ships with no amount for any role in the source', () => {
  // Already asserted globally, repeated here because this is the task that could introduce one
  // as a "helpful" placeholder value.
  assert.ok(!/byRole:\s*\{\s*[^}\s]/.test(APP_SRC));
  assert.ok(!/(set-rolerate[^\n]*?)(360|240|480)\s*\)/.test(APP_SRC), 'no rate may be baked into a Settings input');
});

test('the new Settings labels exist in all three languages', () => {
  // L(en, th) plus a currentLang === 'ja' branch is this file's three-language shape.
  const seg = APP_SRC.slice(APP_SRC.indexOf('set-rolerate-enabled') - 2000, APP_SRC.indexOf('set-rolerate-enabled') + 3000);
  assert.ok(/L\(/.test(seg), 'labels must go through L() for EN/TH');
  assert.ok(/'ja'/.test(seg) || /ja:/.test(seg), 'the Japanese variant is missing');
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node tests/role-allowance-rates.test.js`
Expected: FAIL — `no role-rate table in the Settings page`.

- [ ] **Step 3: Render the switch and the table**

After the late-night amount fields close (`app.js:5431`), inside the same Allowance Rates card, add:

```js
      ,
      // 2026-10-13 (owner's decision): per-role early/late rates. The rows are derived from
      // allowanceEligibility.earlyLate and NOT hardcoded, so the day a role is granted the
      // allowance its row appears here on its own. No amount is pre-filled: the rate is the
      // owner's policy, and a number shipped in code would arrive on a fresh install with
      // nobody having decided it.
      (() => {
        const _rr = (s.allowanceRoleRates && typeof s.allowanceRoleRates === 'object') ? s.allowanceRoleRates : { enabled: false, byRole: {} };
        const _rrOn = _rr.enabled === true;
        const _roleRateRoles = ((s.allowanceEligibility && s.allowanceEligibility.earlyLate) || []).slice().sort();
        const _rrLabel = (key) => currentLang === 'ja'
          ? ({ earlyMorning1: '早朝 ×1', earlyMorning2: '早朝 ×2', lateNight1: '深夜 ×1', lateNight2: '深夜 ×2' })[key]
          : L(({ earlyMorning1: 'Early ×1', earlyMorning2: 'Early ×2', lateNight1: 'Late ×1', lateNight2: 'Late ×2' })[key],
              ({ earlyMorning1: 'มาเช้า ×1', earlyMorning2: 'มาเช้า ×2', lateNight1: 'กลับดึก ×1', lateNight2: 'กลับดึก ×2' })[key]);
        const head = `<tr><th style="text-align:left">${currentLang === 'ja' ? '役職' : L('Role', 'ตำแหน่ง')}</th>${EARLY_LATE_RATE_KEYS.map(k => `<th>${_rrLabel(k)}</th>`).join('')}</tr>`;
        const body = _roleRateRoles.length
          ? _roleRateRoles.map(r => {
              const row = (_rr.byRole && _rr.byRole[r]) || {};
              return `<tr><td>${escapeHtml(r)}</td>${EARLY_LATE_RATE_KEYS.map(k =>
                `<td><input id="set-rolerate-${escapeHtml(r)}-${k}" type="number" min="0" max="100000" step="1" value="${row[k] != null ? Number(row[k]) : ''}" placeholder="${Number(s.allowances[k])}" ${_rrOn ? '' : 'disabled'} style="width:6rem"></td>`
              ).join('')}</tr>`;
            }).join('')
          : `<tr><td colspan="${EARLY_LATE_RATE_KEYS.length + 1}">${currentLang === 'ja' ? '該当する役職がありません' : L('No role is eligible for this allowance', 'ไม่มีตำแหน่งที่มีสิทธิ์รับเบี้ยเลี้ยงนี้')}</td></tr>`;
        return `<div style="margin-top:1rem;${_rrOn ? '' : 'opacity:.55'}">
          <label><input type="checkbox" id="set-rolerate-enabled" ${_rrOn ? 'checked' : ''} onchange="renderSettings()">
            ${currentLang === 'ja' ? '役職ごとに早朝・深夜手当の金額を変える' : L('Use a different early-morning / late-night rate per role', 'ใช้ยอดเบี้ยเลี้ยงมาเช้า/กลับดึก ต่างกันตามตำแหน่ง')}</label>
          <div style="font-size:.85em;opacity:.8;margin:.25rem 0 .5rem">
            ${currentLang === 'ja' ? '空欄の場合は上記の全社共通額を使用します。' : L('A blank cell uses the company-wide amount above.', 'ช่องที่เว้นว่างจะใช้ยอดกลางด้านบน')}</div>
          <table class="table" style="width:auto">${head}${body}</table>
        </div>`;
      })()
```

> Match the surrounding card's own helper style (`field()`, `inp()`) if it reads more naturally there; the requirement is the derived rows, the disabled-when-off state, the blank-means-central placeholder, and all three languages. `onchange="renderSettings()"` must match this file's existing inline-handler convention — `tests/inline-handlers.test.js` checks that every inline handler names a real global function, so confirm the settings re-render function's actual name before using it.

- [ ] **Step 4: Save the switch and the cells**

After `app.js:6300` (`APP_SETTINGS.allowances.lateNight2 = fi('set-late2-amt');`), add:

```js
  // 2026-10-13: a blank cell means "use the company-wide amount", so it is OMITTED rather than
  // saved as 0 -- 0 is a real rate meaning "do not pay this tier" and the two must stay different.
  {
    const _rrOn = !!(document.getElementById('set-rolerate-enabled') || {}).checked;
    const _rrRoles = ((APP_SETTINGS.allowanceEligibility && APP_SETTINGS.allowanceEligibility.earlyLate) || []);
    // A role that has since lost the allowance has no row on screen, so there is no input to read
    // and the loop below would drop what the owner once typed. Carry those rows forward: they are
    // the owner's data, and losing them on an unrelated Settings save is silent data loss. If the
    // role is granted the allowance again its old amounts are still there.
    const _prevByRole = (APP_SETTINGS.allowanceRoleRates && APP_SETTINGS.allowanceRoleRates.byRole) || {};
    const _byRole = {};
    for (const [r, row] of Object.entries(_prevByRole)) {
      if (!_rrRoles.includes(r) && row && typeof row === 'object' && !Array.isArray(row)) _byRole[r] = row;
    }
    for (const r of _rrRoles) {
      const row = {};
      for (const k of EARLY_LATE_RATE_KEYS) {
        const el = document.getElementById(`set-rolerate-${r}-${k}`);
        if (!el || el.value === '') continue;
        const n = Number(el.value);
        if (Number.isFinite(n) && n >= 0 && n <= 100000) row[k] = n;
      }
      if (Object.keys(row).length) _byRole[r] = row;
    }
    APP_SETTINGS.allowanceRoleRates = { enabled: _rrOn, byRole: _byRole };
  }
```

> The `_prevByRole` carry-forward above is the whole reason this block is not a plain rebuild: `server.js` replaces the section wholesale on save, so anything the page does not send back is gone from disk. Add a test for it in Step 1 if you touch this logic again.

- [ ] **Step 5: Run the tests**

```bash
node --check attendance/js/app.js
node tests/role-allowance-rates.test.js
node tests/inline-handlers.test.js
npm test
```
Expected: `npm test` ends `N/N test files passed`.

- [ ] **Step 6: Commit**

```bash
git add attendance/js/app.js tests/role-allowance-rates.test.js
git commit -m "feat(allowance): Settings grows a switch and a per-role rate table

Rows are derived from allowanceEligibility.earlyLate, so they follow who is
actually eligible instead of a list baked into the code, and no amount ships
pre-filled -- a blank cell is omitted on save and falls back to the company-wide
amount, which keeps it distinct from a deliberate 0. EN/TH/JA together.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 8: Bump the cache-buster and verify the whole branch

**Files:**
- Modify: whichever `APP_BUILD` / `?v=` pairs `tests/cache-buster-bump.test.js` governs
- Test: the full suite

- [ ] **Step 1: Run the bump guard to see what it wants**

Run: `node tests/cache-buster-bump.test.js`
Expected: FAIL — `app.js` changed without a bump. The failure message names the pairs.

- [ ] **Step 2: Bump every pair it names**

Edit each one; all 6 governed pairs must agree.

- [ ] **Step 3: Full verification**

```bash
npm run check
```
Expected: lint clean, then `N/N test files passed`. Nothing less counts.

- [ ] **Step 4: Confirm the deliverable is inert**

```bash
node -e "const s=require('./attendance-server/backend/server.js')" 2>/dev/null || true
grep -n "allowanceRoleRates" attendance-server/backend/data/settings.json || echo "production settings untouched -- correct, the owner enables it themselves"
```
Expected: the production `settings.json` has no `allowanceRoleRates`. This plan must not write to it; the section appears there the first time the owner saves Settings.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore(cache): bump the cache-buster for the per-role rate work

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Hand-back to the owner

When all tasks are done, the branch ships a feature that is **off**. Tell the owner, in this order:

1. The previous periods are still unlocked (`periodLocks` was empty when this was measured). Lock them in the web UI first.
2. Then open Settings → Allowance Rates, tick the new switch, and type the amounts. The table shows `manager` and `user` today.
3. A blank cell keeps the company-wide amount. A deliberate `0` means that tier is not paid to that role.
4. What was *not* built, on purpose: no per-person override, no "effective from this date" mechanism, and no change to any other allowance.
