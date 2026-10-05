# Holiday Work for managers, without the cash option — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let managers file Holiday Work requests while only staff may take the compensation as money.

**Architecture:** A new `holidayWorkPaid` key in the existing `allowanceEligibility` role→roles map decides who may pick `compensationMode: 'paid'`. A new shared predicate `mayChoosePaidHolidayWork(S, role)` requires BOTH `holidayWork` and `holidayWorkPaid`, so inconsistent settings grant nothing. The Settings grid gets the key as an indented sub-row that auto-ticks its parent.

**Tech Stack:** Plain ES2020 browser JS (`attendance/js/app.js`, no build step), Node/Express (`attendance-server/backend/server.js`), node-only tests in `tests/` using `vm` sandboxes that extract functions from both sources.

**Spec:** `docs/superpowers/specs/2026-10-05-holiday-work-manager-paid-design.md`

## Global Constraints

- `mayChoosePaidHolidayWork` must be byte-identical in `attendance/js/app.js` and `attendance-server/backend/server.js` (project DUAL-SYNC rule).
- Every user-visible string needs Thai, English and Japanese. JS uses `L('English','ไทย')`; Japanese goes through `currentLang === 'ja' ? '日本語' : L(...)`.
- Run `node --check attendance/js/app.js` after every edit to `app.js`. One syntax error blanks the whole app.
- Any new key in `ALLOWANCE_KEYS` MUST also get a row in the hardcoded Settings table, or the next Settings save writes it as `[]` (nobody eligible). There is an existing warning comment at `attendance/js/app.js:5062`.
- Bump the `?v=` cache-buster for `js/app.js` in `attendance/index.html` before merging. Current value: `20261005e`.
- Escape any user-supplied value with `escapeHtml()` before putting it in HTML.
- Work in the git worktree; never edit `Z:\Time_Attendance` directly. Merging into `main` there is the deploy.

---

### Task 1: The shared predicate and its eligibility key

**Files:**
- Modify: `attendance/js/app.js:1422-1423` (add `holidayWorkPaid` to the live-settings default `allowanceEligibility`)
- Modify: `attendance/js/app.js:1468` (`ALLOWANCE_KEYS`)
- Modify: `attendance/js/app.js:1477` (`DEFAULT_ALLOWANCE_ELIGIBILITY`)
- Modify: `attendance/js/app.js` — add `mayChoosePaidHolidayWork` directly below `isAllowanceEligible` (currently ends at line 1494)
- Modify: `attendance-server/backend/server.js:9239-9252` (`DEFAULT_ALLOWANCE_ELIGIBILITY`)
- Modify: `attendance-server/backend/server.js` — add `mayChoosePaidHolidayWork` below `isAllowanceEligible` (currently ends at line 9263)
- Test: `tests/holiday-work-paid.test.js` (create)

**Interfaces:**
- Consumes: `isAllowanceEligible(allowanceEligibilityConfig, role, key)` — existing, in both files.
- Produces: `mayChoosePaidHolidayWork(allowanceEligibilityConfig, role) -> boolean`, in both files. Tasks 2, 3 and 4 call it.

- [ ] **Step 1: Write the failing test**

Create `tests/holiday-work-paid.test.js`:

```js
// Holiday Work "paid" compensation permission (2026-10-05).
// Follows the house pattern: the functions are extracted from the real sources and run in a vm
// sandbox, so this also proves the two DUAL-SYNC copies agree.
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
// Asserts the same answer on both sides, and returns it.
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
test('may file but not paid -> false', () => {
  const cfg = { holidayWork: ['user', 'manager'], holidayWorkPaid: ['user'] };
  assert.strictEqual(both(cfg, 'manager'), false);
});
test('paid ticked without the parent grants nothing', () => {
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

console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ', 0 failed'}`);
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
node tests/holiday-work-paid.test.js
```

Expected: throws `function mayChoosePaidHolidayWork not found`, exit code non-zero.

- [ ] **Step 3: Add the key to the client's two maps and the key list**

In `attendance/js/app.js`, in the live-settings default `allowanceEligibility` block (line ~1422), add the new line directly after `holidayWork`:

```js
    holidayWork:  ['md', 'manager', 'user'],
    // 2026-10-05 (owner): who may take Holiday Work compensation as money (OT + holiday
    // transport) instead of one annual-leave day. A sub-permission of holidayWork above --
    // mayChoosePaidHolidayWork() requires BOTH, so ticking this alone grants nothing.
    holidayWorkPaid: ['md', 'user'],
```

At line 1468, add the key to `ALLOWANCE_KEYS`:

```js
const ALLOWANCE_KEYS = ['diligence', 'longDistance', 'personalCar', 'upcountry', 'earlyLate', 'ot', 'phone', 'holidayWork', 'holidayWorkPaid', 'abroad'];
```

In `DEFAULT_ALLOWANCE_ELIGIBILITY` (line ~1477), add the same entry after `holidayWork`:

```js
  holidayWorkPaid: ['md', 'user'],
```

- [ ] **Step 4: Add the predicate to the client**

In `attendance/js/app.js`, immediately after `isAllowanceEligible` closes (line ~1494):

```js
// 2026-10-05 (owner): managers may file Holiday Work but must take the annual-leave day, never the
// money. Two keys, both required: holidayWork says who may file at all, holidayWorkPaid says who
// may pick compensationMode 'paid'. Requiring the parent here is the real control -- settings.json
// can be edited by hand or by an older client, and a holidayWorkPaid tick without its parent must
// grant nothing rather than quietly allowing the cash option.
// STANDING RULE (dual-sync): this function exists in BOTH app.js and server.js.
function mayChoosePaidHolidayWork(allowanceEligibilityConfig, role) {
  return isAllowanceEligible(allowanceEligibilityConfig, role, 'holidayWork') &&
         isAllowanceEligible(allowanceEligibilityConfig, role, 'holidayWorkPaid');
}
```

- [ ] **Step 5: Mirror both changes on the server**

In `attendance-server/backend/server.js`, in `DEFAULT_ALLOWANCE_ELIGIBILITY` (line ~9245), after `holidayWork`:

```js
  // 2026-10-05 (owner): sub-permission of holidayWork -- who may take the compensation as money.
  // MUST exist here: isAllowanceEligible() reads DEFAULT_ALLOWANCE_ELIGIBILITY[key] when the live
  // settings have no such key, and a missing key throws.
  holidayWorkPaid: ['md', 'user'],
```

Then immediately after `isAllowanceEligible` closes (line ~9263), paste the SAME function body as Step 4, comment included.

- [ ] **Step 6: Run the test and the syntax check**

```bash
node --check attendance/js/app.js && node tests/holiday-work-paid.test.js
```

Expected: `6 passed, 0 failed`, exit code 0.

- [ ] **Step 7: Commit**

```bash
git add attendance/js/app.js attendance-server/backend/server.js tests/holiday-work-paid.test.js
git commit -m "feat(holiday-work): a second permission decides who may take the money

holidayWorkPaid is a sub-permission of holidayWork; mayChoosePaidHolidayWork
requires both, so a tick without its parent grants nothing."
```

---

### Task 2: The server refuses a paid request from a role without the permission

**Files:**
- Modify: `attendance-server/backend/server.js:5166-5176` (`holidayWorkSubmitBlockReason`)
- Modify: `attendance-server/backend/server.js:6220-6222` (the `compensationMode` validator)
- Test: `tests/holiday-work-paid.test.js` (extend)

**Interfaces:**
- Consumes: `mayChoosePaidHolidayWork(allowanceEligibilityConfig, role)` from Task 1.
- Produces: `paidHolidayWorkBlockReason(S, user, compensationMode) -> string|null` in `server.js` — returns a message when the submitter may not use `paid`, else `null`.

- [ ] **Step 1: Write the failing test**

Append to `tests/holiday-work-paid.test.js`, before the final `console.log` line:

```js
console.log('\nServer: refusing a paid request from a role without the permission');

vm.runInContext(extractFunction(SERVER_SRC, 'paidHolidayWorkBlockReason'), SERVER);
const CFG = { holidayWork: ['user', 'manager'], holidayWorkPaid: ['user'] };

test('manager asking for paid is refused', () => {
  const r = SERVER.paidHolidayWorkBlockReason({ allowanceEligibility: CFG }, { role: 'manager' }, 'paid');
  assert.ok(typeof r === 'string' && r.length > 0, 'expected a refusal message');
});
test('manager asking for the annual-leave day is accepted', () => {
  assert.strictEqual(
    SERVER.paidHolidayWorkBlockReason({ allowanceEligibility: CFG }, { role: 'manager' }, 'annual-leave'), null);
});
test('user asking for paid is accepted', () => {
  assert.strictEqual(
    SERVER.paidHolidayWorkBlockReason({ allowanceEligibility: CFG }, { role: 'user' }, 'paid'), null);
});
test('an absent compensationMode is not this check\'s business', () => {
  assert.strictEqual(
    SERVER.paidHolidayWorkBlockReason({ allowanceEligibility: CFG }, { role: 'manager' }, undefined), null);
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
node tests/holiday-work-paid.test.js
```

Expected: throws `function paidHolidayWorkBlockReason not found`.

- [ ] **Step 3: Add the function and call it from the submit gate**

In `attendance-server/backend/server.js`, directly above `holidayWorkSubmitBlockReason` (line 5166):

```js
// 2026-10-05 (owner): managers may file Holiday Work but only for the annual-leave day. The form
// hides the money option for them; this is the control that actually enforces it, since a request
// can be posted directly. Returns null when there is nothing to block -- including when no mode was
// sent, which the field validator handles separately.
function paidHolidayWorkBlockReason(S, user, compensationMode) {
  if (compensationMode !== 'paid') return null;
  if (mayChoosePaidHolidayWork(S && S.allowanceEligibility, user && user.role)) return null;
  return 'Your role cannot take holiday work compensation as money — choose the annual-leave day';
}
```

Then inside `holidayWorkSubmitBlockReason`, directly after the existing `holidayWork` eligibility check (line ~5176, the block ending `return 'You are not eligible to submit holiday work requests';`), the caller must also pass the mode through. Change the signature and add the check:

```js
function holidayWorkSubmitBlockReason(user, dateStr, compensationMode) {
```

and after that eligibility block:

```js
  const paidErr = paidHolidayWorkBlockReason(S, user, compensationMode);
  if (paidErr) return paidErr;
```

- [ ] **Step 4: Pass the mode at every call site**

```bash
grep -n "holidayWorkSubmitBlockReason(" attendance-server/backend/server.js
```

For each call that is not the definition, add the request's compensation mode as the third argument (the request body field is `compensationMode`; on an edit it is the incoming value when present, otherwise the stored record's). Leaving a call site un-updated passes `undefined`, which the new check treats as "nothing to block" — so update every one.

- [ ] **Step 5: Also guard the edit path**

At the `compensationMode` field validator (line ~6220), the existing check only validates the value's shape. Immediately after it, add the permission check so an edit cannot switch an approved-mode request to `paid`:

```js
  if (body.compensationMode === 'paid') {
    const paidErr = paidHolidayWorkBlockReason(getAppSettings(), user, 'paid');
    if (paidErr) return paidErr;
  }
```

If `user` is not in scope at that point, read it the same way the surrounding validator does and keep the name consistent.

- [ ] **Step 6: Run the tests**

```bash
node tests/holiday-work-paid.test.js && npm run check
```

Expected: `10 passed, 0 failed` from the new file, then `=== 17/17 test files passed ===`.

- [ ] **Step 7: Commit**

```bash
git add attendance-server/backend/server.js tests/holiday-work-paid.test.js
git commit -m "feat(holiday-work): the server refuses a paid request from a role without it

Hiding the option in the form is a convenience; a request can be posted
directly, so the permission is checked on create and on edit."
```

---

### Task 3: The request form offers only the modes the submitter may take

**Files:**
- Modify: `attendance/js/app.js:18084` (`refreshHolidayWorkCompHint`)
- Modify: `attendance/js/app.js:18160` (`refreshHolidayWorkPayCompare`)
- Modify: `attendance/js/app.js:16507` and `:18335` (the two places that open/reset the modal)
- Test: manual, in the browser (this is DOM behaviour; the repo has no DOM test harness)

**Interfaces:**
- Consumes: `mayChoosePaidHolidayWork` from Task 1.
- Produces: `applyHolidayWorkCompModePermission()` — hides the `paid` option and the comparison cards when the current user may not take the money, and forces the select to `annual-leave`.

- [ ] **Step 1: Add the function**

In `attendance/js/app.js`, directly above `refreshHolidayWorkCompHint` (line 18084):

```js
// 2026-10-05 (owner): a role that may file Holiday Work but may not take the money sees one option
// only. The two-card pay comparison is hidden with it -- a single card alone reads as a broken
// layout. The server refuses 'paid' from these roles regardless (paidHolidayWorkBlockReason), so
// this is presentation, not the control.
function applyHolidayWorkCompModePermission() {
  const sel = document.getElementById('holiday-work-comp-mode');
  if (!sel || !currentUser) return;
  const mayPaid = mayChoosePaidHolidayWork(APP_SETTINGS.allowanceEligibility, effectiveRole());
  const paidOpt = sel.querySelector('option[value="paid"]');
  if (paidOpt) paidOpt.style.display = mayPaid ? '' : 'none';
  if (!mayPaid) {
    sel.value = 'annual-leave';
    const cmp = document.getElementById('hw-pay-compare');
    if (cmp) cmp.style.display = 'none';
  }
}
```

- [ ] **Step 2: Call it when the modal opens and when it resets**

At line ~16507 and line ~18335 the modal already calls `refreshHolidayWorkCompHint();`. Add the new call immediately BEFORE each of those two calls, so the hint is computed against the forced value:

```js
  applyHolidayWorkCompModePermission();
  refreshHolidayWorkCompHint();
```

- [ ] **Step 3: Stop the comparison re-showing itself**

`refreshHolidayWorkPayCompare` sets `wrap.style.display` itself, so it would undo Step 1. At the top of that function (line ~18161), directly after the `if (!wrap) return;` line, add:

```js
  if (currentUser && !mayChoosePaidHolidayWork(APP_SETTINGS.allowanceEligibility, effectiveRole())) {
    wrap.style.display = 'none';
    return;
  }
```

- [ ] **Step 4: Syntax check and lint**

```bash
node --check attendance/js/app.js && npm run lint
```

Expected: no output from `node --check`, lint exits 0.

- [ ] **Step 5: Verify in the browser**

Bump the cache-buster in `attendance/index.html` from `20261005e` to `20261005f`, merge to `main` on `Z:`, hard-reload, then:

- sign in as a `user`-role account: the Compensation Mode select still offers both options and the comparison cards still appear
- sign in as a `manager` account (after Task 4 ticks `holidayWork` for manager): the select offers "ลาพักร้อน +1 วัน" only and no comparison cards appear

Record what was checked. Do not claim it works without having looked.

- [ ] **Step 6: Commit**

```bash
git add attendance/js/app.js attendance/index.html
git commit -m "feat(holiday-work): the form offers only the modes the submitter may take

A role without the paid permission sees the leave-day option alone, and the
two-card comparison is hidden with it rather than left as one stray card."
```

---

### Task 4: The Settings sub-row, and its two-way link to its parent

**Files:**
- Modify: `attendance/js/app.js:5055-5069` (the hardcoded eligibility table rows)
- Modify: `attendance/js/app.js:5858` area (`saveSettings`'s `ALLOWANCE_KEYS` loop — verify it needs no change)
- Test: manual, in the browser

**Interfaces:**
- Consumes: the `holidayWorkPaid` key from Task 1.
- Produces: `onHolidayWorkPaidToggle(role)` and `onHolidayWorkParentToggle(role)` — the two live handlers.

- [ ] **Step 1: Add the row**

In the hardcoded row list (line ~5061), directly after the `holidayWork` entry, insert:

```js
              ['holidayWorkPaid', `<span style="color:#94a3b8">└</span> ${L('choose cash compensation','เลือกรับเป็นเงิน')}`, L('needs the row above; ticking this ticks it too','ต้องเปิดสิทธิ์ยื่นด้านบนก่อน — ติ๊กช่องนี้จะติ๊กให้เอง')],
```

The label column already renders its value as HTML, so the `└` and the indent come from the label itself — no change to the row template.

- [ ] **Step 2: Indent the sub-row's label cell**

The row template at line ~5070 is shared. Give the sub-row its indent by keying off the row id. Change the label `<td>` (line ~5071) from:

```js
                <td style="padding:8px 10px">
```

to:

```js
                <td style="padding:8px 10px${key === 'holidayWorkPaid' ? ';padding-left:26px' : ''}">
```

- [ ] **Step 3: Wire the two directions**

The checkbox is rendered at line ~5076 with `id="set-elig-${key}-${role}"`. Add an `onchange` to the parent and the child only, leaving every other row untouched. Change that line to:

```js
                ${ROLE_KEYS.map(role => `<td style="text-align:center;padding:8px 6px">
                  <input type="checkbox" id="set-elig-${key}-${role}" ${isAllowanceEligible(s.allowanceEligibility, role, key) ? 'checked' : ''} ${key === 'holidayWorkPaid' ? `onchange="onHolidayWorkPaidToggle('${role}')"` : key === 'holidayWork' ? `onchange="onHolidayWorkParentToggle('${role}')"` : ''} style="width:16px;height:16px;cursor:pointer">
                </td>`).join('')}
```

- [ ] **Step 4: Add the handlers**

Place these next to the other Settings helpers, directly above `saveSettings` (search for `function saveSettings`):

```js
// 2026-10-05 (owner): "เลือกรับเป็นเงิน" is a sub-permission of "ทำงานวันหยุด" and is meaningless
// without it. Ticking the child ticks the parent, because that is plainly the intent and a disabled
// checkbox just makes people hunt for the reason. The auto-tick is announced: the click asked for
// the narrower permission and granted the broader one too, so the person must see that. Unticking
// the parent unticks the child silently -- that direction only ever narrows.
// mayChoosePaidHolidayWork() requires both regardless, so this is convenience, not the control.
function onHolidayWorkPaidToggle(role) {
  const child = document.getElementById(`set-elig-holidayWorkPaid-${role}`);
  const parent = document.getElementById(`set-elig-holidayWork-${role}`);
  if (!child || !parent || !child.checked || parent.checked) return;
  parent.checked = true;
  parent.style.outline = '2px solid #f59e0b';
  setTimeout(() => { parent.style.outline = ''; }, 1600);
  showToast(currentLang === 'ja'
    ? '休日出勤の申請権限も有効にしました'
    : L('Permission to file Holiday Work was switched on too',
        'เปิดสิทธิ์ยื่นทำงานวันหยุดให้ด้วยแล้ว'), 'info');
}
function onHolidayWorkParentToggle(role) {
  const parent = document.getElementById(`set-elig-holidayWork-${role}`);
  const child = document.getElementById(`set-elig-holidayWorkPaid-${role}`);
  if (!parent || !child || parent.checked) return;
  child.checked = false;
}
```

- [ ] **Step 5: Confirm saving needs no change**

```bash
grep -n "ALLOWANCE_KEYS.forEach\|for (const key of ALLOWANCE_KEYS" attendance/js/app.js
```

`saveSettings` loops `ALLOWANCE_KEYS` and reads `set-elig-<key>-<role>`, so the new key is picked up by the loop added in Task 1 Step 3. Read the loop and confirm. If the loop special-cases keys (it does for `personalCar` and `phone` at line ~5858 — those also write a per-employee flag), make sure `holidayWorkPaid` falls through to the plain path and does NOT get a per-employee flag.

- [ ] **Step 6: Syntax check and lint**

```bash
node --check attendance/js/app.js && npm run check
```

Expected: `=== 17/17 test files passed ===`.

- [ ] **Step 7: Verify in the browser**

Bump the cache-buster, merge to `main` on `Z:`, hard-reload, open Settings → 🎫 สิทธิ์เบี้ยเลี้ยงตามระดับผู้ใช้ as MD, then check all four:

- the new row sits indented under `ทำงานวันหยุด` with the `└` and the hint
- ticking `เลือกรับเป็นเงิน` for a role whose parent is unticked ticks the parent, outlines it, and shows the toast
- unticking `ทำงานวันหยุด` for a role unticks `เลือกรับเป็นเงิน`
- Save, reload, and confirm both values persisted

- [ ] **Step 8: Commit**

```bash
git add attendance/js/app.js attendance/index.html
git commit -m "feat(settings): the cash-compensation permission is a sub-row of its parent

Indented under the row it depends on. Ticking it ticks the parent and says
so, because the narrower click granted the broader permission too."
```

---

### Task 5: Turn the permission on for managers

**Files:**
- No code. A Settings change the owner makes, or Claude makes with the owner watching.

- [ ] **Step 1: Confirm the current live values**

In the browser console on the live site, signed in as any role:

```js
APP_SETTINGS.allowanceEligibility.holidayWork
APP_SETTINGS.allowanceEligibility.holidayWorkPaid
```

Expected before the change: `['user']` and whatever Task 1's default resolved to.

- [ ] **Step 2: Make the change in Settings**

Settings → 🎫 สิทธิ์เบี้ยเลี้ยงตามระดับผู้ใช้ → tick `ทำงานวันหยุด` for `manager`, leave `เลือกรับเป็นเงิน` unticked for `manager`, Save.

- [ ] **Step 3: Verify end to end**

Sign in as a manager account and open the Holiday Work form. Expected: the form opens, Compensation Mode offers "ลาพักร้อน +1 วัน" only, no comparison cards.

Then confirm the server agrees — a `paid` request from that role must be refused even though the form never offers it. Either post one directly or confirm the Task 2 tests cover it and say which.

- [ ] **Step 4: Tell the owner what changed**

State which roles now hold which of the two permissions, and what was verified first-hand versus what rests on the tests.

---

## Notes for whoever executes this

- The repo's own guide is `AGENTS.md` at the repo root. Read it before the first edit.
- `git` commits against the NAS repo print `could not write multi-pack-index: Permission denied`. The commit still succeeds; check with `git log --oneline -1`.
- Task 3 and Task 4 both touch `attendance/index.html` only to bump the cache-buster. If they land in one merge, one bump is enough.
