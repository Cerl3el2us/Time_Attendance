# Web check-out Late Night review — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Accounting/MD review a web (browser) check-out at or after the Late Night ×1 time and Allow/Deny it. After Allow, the employee can submit 🌙 and it is paid like a face-scanner check-out. Also count a check-out after midnight (00:00–04:59) at the top tier, and make the server refuse a 🌙 tier later than the real check-out.

**Spec (authoritative):** `Z:\Time_Attendance\docs\superpowers\specs\2026-09-23-web-checkout-late-night-review-design.md`

**Architecture:** Reviews live in a new data file `data/checkout-reviews.json`, keyed `"<userId>_<YYYY-MM-DD>"`. It is not a settings key, so the deep-merge PUT hazard does not apply. Both `generatePeriodDays` copies set two new day fields after the leave/time-correction overlay: `checkOutReview` (`'allow' | 'deny' | null`) and `rawCheckOut`. A review counts only when it is for a web check-out and its stored `checkOut` equals the day's current effective check-out. The pay gate `deviceScanQualifiesForLateNight` (dual-sync) switches from "device only" to the new `lateNightCheckoutOk(d)`. Payroll, payslips, the snapshot, reports and the dashboard all read that one function, so they follow without further edits. New REST: `GET/PUT /api/checkout-reviews`. The server broadcasts `{type:'CHECKOUT_REVIEWS_UPDATED'}` with no payload, and clients re-fetch the scoped GET.

**Tech Stack:** Plain Node/Express backend (`server.js`, CommonJS). Plain browser JS frontend (`app.js`, no bundler). Japanese dictionary `lang/ja.js`. ESLint 9 (`npm run lint`). There is no test framework: tests are standalone node scripts in the session scratchpad. They extract the real function source by name and `eval` it with stubs.

## Global Constraints

- Dual-sync: every rule change goes into `attendance/js/app.js` and `attendance-server/backend/server.js` together. The text between `// ===== ALLOWANCE ELIGIBILITY (DUAL-SYNC BLOCK v1) =====` and `// ===== END DUAL-SYNC BLOCK =====` must stay byte-identical in both files.
- Every new user-facing string ships in TH, EN and JA. `L(en, th)` needs a matching `lang/ja.js` key. `_faq(en, th, ja)` carries its JA inline.
- Never trust client values for money or time. The server derives `checkOut`/`rawCheckOut` itself and re-checks the 🌙 tier against the real check-out.
- Fail closed on unreadable data. If the reviews file cannot be read, `computePayroll` throws `'Service temporarily unavailable'`, and the submit gate and GET/PUT return 503.
- `npm run lint` (run from `Z:\Time_Attendance`) must be clean after every task.
- Do not change anything about the `superadmin` system account (`isSuperAdminUser`, `systemAccount.js`, the `isSuperAdmin()` blocks in app.js). Only keep its existing `requireRole` inheritance working.
- Bump the cache-busters after editing app.js/ja.js: `js/app.js?v=20260923e` → `20260923f` and `lang/ja.js?v=20260923b` → `20260923c` in `attendance/index.html`. This is done in Task 10, after the backend is live.
- No git commits unless the user asks. Every task ends with a "lint + syntax check" step instead of a commit.
- The frontend files are served live from `Z:\` as soon as they are saved. Do Tasks 5–9 in one sitting, and never leave app.js half-edited between tasks. `server.js` edits take effect only after the Task 10 restart.

Paths used below:

- `ROOT` = `Z:\Time_Attendance`
- `SCRATCH` = `C:\Users\tairo\AppData\Local\Temp\claude\Z--\1a698e2c-c5d4-4394-a364-42b928382219\scratchpad` (in node scripts: `C:/Users/tairo/AppData/Local/Temp/claude/Z--/1a698e2c-c5d4-4394-a364-42b928382219/scratchpad`)

Lint + syntax check command (used at the end of every task), run from `Z:\Time_Attendance`:

```
node --check attendance-server/backend/server.js
node --check attendance/js/app.js
npm run lint
```

Expected: both `node --check` print nothing (exit 0); `npm run lint` prints only the npm header lines (`> time-attendance-tooling@1.0.0 lint` / `> eslint ...`) and exits 0 with no problems listed.

---

## Task 1: Dual-sync helpers (both files) + unit tests

The spec calls this the "server dual-sync helpers" task. The helpers are written into **both** files in this task because the block must stay byte-identical. On the client, the only live effect is inside `deviceScanQualifiesForLateNight`, which reads `d.checkOutReview`. That field stays `undefined` until Task 5, so behaviour does not change yet.

**Files:**
- Modify: `Z:\Time_Attendance\attendance-server\backend\server.js`, dual-sync block (~6834–6900), function `deviceScanQualifiesForLateNight` (~6893)
- Modify: `Z:\Time_Attendance\attendance\js\app.js`, dual-sync block (~1259–1325), function `deviceScanQualifiesForLateNight` (~1318)
- Create: `SCRATCH\extract-fn.js`, `SCRATCH\test-dualsync-checkout-review.js`

**Interfaces:**
- Consumes: `isDeviceScanSource(source)`, `isFullDayPersonalLeaveStatus(status)`, `isAllowanceEligible(cfg, role, key)`, `isRestAttendanceDay(d)` (all already in the block)
- Produces (identical in both files):
  - `lateNightCheckoutMins(hhmm) → number` — minutes since midnight; adds 1440 for times before 05:00; `NaN` if not `HH:MM`
  - `checkoutReviewDecisionFor(review, checkOut, checkOutSource) → 'allow' | 'deny' | null`
  - `lateNightCheckoutOk(d) → boolean`
  - `checkoutReviewTrigger(day, user, S) → boolean`
  - `deviceScanQualifiesForLateNight(d, holidayWorkDateSet)` — now uses `lateNightCheckoutOk`

- [ ] **Step 1: Create the shared extractor** `SCRATCH\extract-fn.js`

```js
'use strict';
// Shared helper for the checkout-review tests: pulls REAL source text out of app.js/server.js by
// function name (paren-matched parameter list, then brace-matched body) and evals it with stubs.
const fs = require('fs');

const ROOT = 'Z:/Time_Attendance';
const SERVER = ROOT + '/attendance-server/backend/server.js';
const CLIENT = ROOT + '/attendance/js/app.js';
const BLOCK_START = '// ===== ALLOWANCE ELIGIBILITY (DUAL-SYNC BLOCK v1) =====';
const BLOCK_END = '// ===== END DUAL-SYNC BLOCK =====';

function readSrc(file) {
  return fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
}

function extractFunction(src, name) {
  const re = new RegExp('(^|\\n)(async\\s+)?function\\s+' + name + '\\s*\\(');
  const m = re.exec(src);
  if (!m) throw new Error('function ' + name + ' not found');
  const start = m.index + m[1].length;
  let i = src.indexOf('(', start);
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '(') depth++;
    else if (src[i] === ')' && --depth === 0) break;
  }
  const open = src.indexOf('{', i);
  depth = 0;
  for (let j = open; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}' && --depth === 0) return src.slice(start, j + 1);
  }
  throw new Error('unbalanced braces in ' + name);
}

function dualSyncBlock(src) {
  const a = src.indexOf(BLOCK_START);
  const b = a < 0 ? -1 : src.indexOf(BLOCK_END, a);
  if (a < 0 || b < 0) throw new Error('dual-sync block markers not found');
  return src.slice(a, b);
}

// `names`: identifiers the snippet reads from outside, taken from ctx (stubs).
// `exportsList`: identifiers returned to the test. A name must not be both in ctx and declared in code.
function load(code, ctx, names, exportsList) {
  const pre = names.length ? 'const { ' + names.join(', ') + ' } = ctx;\n' : '';
  return new Function('ctx', pre + code + '\nreturn { ' + exportsList.join(', ') + ' };')(ctx);
}

module.exports = { SERVER, CLIENT, readSrc, extractFunction, dualSyncBlock, load };
```

- [ ] **Step 2: Write the failing test** `SCRATCH\test-dualsync-checkout-review.js`

```js
'use strict';
// Same cases against BOTH copies of the dual-sync block (server.js and app.js).
const assert = require('assert');
const { SERVER, CLIENT, readSrc, dualSyncBlock, load } = require('./extract-fn.js');

const blocks = { server: dualSyncBlock(readSrc(SERVER)), client: dualSyncBlock(readSrc(CLIENT)) };
assert.strictEqual(blocks.server, blocks.client, 'dual-sync block text differs between server.js and app.js');

const EXPORTS = ['lateNightCheckoutMins', 'lateNightCheckoutOk', 'checkoutReviewDecisionFor',
  'checkoutReviewTrigger', 'deviceScanQualifiesForLateNight'];
const S = { allowances: { lateNightThreshold1Hour: 19, lateNightThreshold2Hour: 20 }, allowanceEligibility: {} };
const staff = { id: 7, role: 'user' };
const base = {
  date: '2026-09-10', isWeekend: false, isPubHoliday: false, isFuture: false, status: 'present',
  checkIn: '09:00', checkOut: '21:00', checkInSource: 'device', checkOutSource: 'web',
  lateOut: '20:00', lateApproved: true, checkOutReview: null,
};
const day = over => Object.assign({}, base, over);

for (const [name, code] of Object.entries(blocks)) {
  const h = load(code, {}, [], EXPORTS);
  const eq = (a, b, msg) => assert.strictEqual(a, b, `[${name}] ${msg}`);
  const ok = (v, msg) => assert.ok(v, `[${name}] ${msg}`);

  // lateNightCheckoutMins
  eq(h.lateNightCheckoutMins('19:00'), 1140, '19:00 = 1140');
  eq(h.lateNightCheckoutMins('23:59'), 1439, '23:59 = 1439');
  eq(h.lateNightCheckoutMins('00:30'), 1470, '00:30 counts after midnight');
  eq(h.lateNightCheckoutMins('04:59'), 1739, '04:59 still after midnight');
  eq(h.lateNightCheckoutMins('05:00'), 300, '05:00 is morning');
  ok(Number.isNaN(h.lateNightCheckoutMins('24:00')), '24:00 invalid');
  ok(Number.isNaN(h.lateNightCheckoutMins(null)), 'null invalid');
  // 00:30 -> counts as >= thr2 (top tier)
  ok(h.lateNightCheckoutMins('00:30') >= 20 * 60, '00:30 reaches the 20:00 tier');
  // tier later than check-out is refused (server gate compares exactly like this)
  ok(h.lateNightCheckoutMins('20:00') > h.lateNightCheckoutMins('19:10'), 'tier 20:00 is later than a 19:10 check-out');
  ok(!(h.lateNightCheckoutMins('20:00') > h.lateNightCheckoutMins('00:30')), 'tier 20:00 allowed after a 00:30 check-out');

  // checkoutReviewDecisionFor
  eq(h.checkoutReviewDecisionFor({ decision: 'allow', checkOut: '21:00' }, '21:00', 'web'), 'allow', 'web+allow matching');
  eq(h.checkoutReviewDecisionFor({ decision: 'allow', checkOut: '20:30' }, '21:00', 'web'), null, 'web+allow stale time');
  eq(h.checkoutReviewDecisionFor({ decision: 'deny', checkOut: '21:00' }, '21:00', 'web'), 'deny', 'deny');
  eq(h.checkoutReviewDecisionFor(undefined, '21:00', 'web'), null, 'none');
  eq(h.checkoutReviewDecisionFor({ decision: 'allow', checkOut: '21:00' }, '21:00', 'device'), null, 'device ignores reviews');
  eq(h.checkoutReviewDecisionFor({ decision: 'maybe', checkOut: '21:00' }, '21:00', 'web'), null, 'unknown decision');

  // lateNightCheckoutOk
  eq(h.lateNightCheckoutOk(day({ checkOutSource: 'device' })), true, 'device');
  eq(h.lateNightCheckoutOk(day({ checkOutReview: 'allow' })), true, 'web+allow');
  eq(h.lateNightCheckoutOk(day({ checkOutReview: 'deny' })), false, 'web+deny');
  eq(h.lateNightCheckoutOk(day({ checkOutReview: null })), false, 'web, no review');
  eq(h.lateNightCheckoutOk(day({ checkOutSource: null, checkOutReview: 'allow' })), false, 'no source');
  eq(h.lateNightCheckoutOk(null), false, 'null day');

  // pay gate
  eq(h.deviceScanQualifiesForLateNight(day({ checkOutSource: 'device' }), new Set()), true, 'pay: device');
  eq(h.deviceScanQualifiesForLateNight(day({ checkOutReview: 'allow' }), new Set()), true, 'pay: web+allow');
  eq(h.deviceScanQualifiesForLateNight(day({ checkOutReview: 'deny' }), new Set()), false, 'pay: web+deny');
  eq(h.deviceScanQualifiesForLateNight(day({}), new Set()), false, 'pay: web pending');
  eq(h.deviceScanQualifiesForLateNight(day({ checkOutReview: 'allow', isWeekend: true, status: 'weekend' }), new Set()), false, 'pay: rest day needs holiday work');
  eq(h.deviceScanQualifiesForLateNight(day({ checkOutReview: 'allow', isWeekend: true, status: 'weekend' }), new Set(['2026-09-10'])), true, 'pay: rest day with holiday work');

  // checkoutReviewTrigger
  eq(h.checkoutReviewTrigger(day({}), staff, S), true, 'trigger: web 21:00');
  eq(h.checkoutReviewTrigger(day({ checkOut: '00:30' }), staff, S), true, 'trigger: web 00:30');
  eq(h.checkoutReviewTrigger(day({ checkOut: '18:59' }), staff, S), false, 'trigger: before thr1');
  eq(h.checkoutReviewTrigger(day({ checkOut: '05:00' }), staff, S), false, 'trigger: 05:00 is morning');
  eq(h.checkoutReviewTrigger(day({ checkOutSource: 'device' }), staff, S), false, 'trigger: device');
  eq(h.checkoutReviewTrigger(day({ checkIn: null }), staff, S), false, 'trigger: no check-in');
  eq(h.checkoutReviewTrigger(day({ isFuture: true }), staff, S), false, 'trigger: future');
  ['leave-annual', 'leave-sick', 'leave-business', 'company-trip', 'abroad', 'future'].forEach(st =>
    eq(h.checkoutReviewTrigger(day({ status: st }), staff, S), false, 'trigger: status ' + st));
  eq(h.checkoutReviewTrigger(day({}), { id: 3, role: 'accounting' }, S), false, 'trigger: role not earlyLate-eligible');
  eq(h.checkoutReviewTrigger(day({}), staff, { allowances: {}, allowanceEligibility: { earlyLate: ['user'] } }), true, 'trigger: default thr1 = 19');
  eq(h.checkoutReviewTrigger(day({ status: 'weekend', isWeekend: true }), staff, S), true, 'trigger: weekend web check-out counts');
  eq(h.checkoutReviewTrigger(day({}), null, S), false, 'trigger: no user');

  console.log(`[${name}] dual-sync checkout-review cases passed`);
}
console.log('ALL PASS');
```

- [ ] **Step 3: Run it and confirm it fails**

Run: `node C:/Users/tairo/AppData/Local/Temp/claude/Z--/1a698e2c-c5d4-4394-a364-42b928382219/scratchpad/test-dualsync-checkout-review.js`
Expected: `ReferenceError: lateNightCheckoutMins is not defined`.

- [ ] **Step 4: Replace the late-night function in server.js**

Find the following in `server.js` (dual-sync block, ~6893):

```js
// Late night pay: device check-out + approved late-out. Rest days also need approved holiday-work.
function deviceScanQualifiesForLateNight(d, holidayWorkDateSet) {
  if (!d || !d.lateOut || !d.lateApproved || d.status === 'company-trip') return false;
  if (isFullDayPersonalLeaveStatus(d.status) || !isDeviceScanSource(d.checkOutSource)) return false;
  if (isRestAttendanceDay(d) && !(holidayWorkDateSet && holidayWorkDateSet.has(d.date))) return false;
  return true;
}
```

Replace it with:

```js
// 2026-09-23 (web check-out Late Night review): a check-out before 05:00 belongs to the same
// business day (after midnight), so it compares as 24:00 + time. NaN for anything not HH:MM.
function lateNightCheckoutMins(hhmm) {
  if (typeof hhmm !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(hhmm)) return NaN;
  const [h, m] = hhmm.split(':').map(Number);
  const mins = h * 60 + m;
  return mins < 5 * 60 ? mins + 24 * 60 : mins;
}
// An Accounting/MD review applies only to a web check-out, and only while the day's current
// effective check-out is still the time that was reviewed -- a later web tap or an approved
// time-correction puts the day back to pending (null).
function checkoutReviewDecisionFor(review, checkOut, checkOutSource) {
  if (!review || checkOutSource !== 'web' || !checkOut || review.checkOut !== checkOut) return null;
  return review.decision === 'allow' || review.decision === 'deny' ? review.decision : null;
}
// Late Night can be paid after a face-scanner check-out, or after a web check-out that
// Accounting/MD allowed (d.checkOutReview is set by generatePeriodDays).
function lateNightCheckoutOk(d) {
  if (!d) return false;
  return isDeviceScanSource(d.checkOutSource) || (d.checkOutSource === 'web' && d.checkOutReview === 'allow');
}
// A day Accounting/MD must review: a web check-out at/after the Late Night x1 time, on a worked
// day that is not full-day personal leave / Company Trip / Abroad, for a role eligible for earlyLate.
function checkoutReviewTrigger(day, user, S) {
  if (!day || !user || !S || !day.checkIn || !day.checkOut || day.isFuture) return false;
  if (day.checkOutSource !== 'web') return false;
  if (isFullDayPersonalLeaveStatus(day.status) || day.status === 'company-trip' ||
      day.status === 'abroad' || day.status === 'future') return false;
  if (!isAllowanceEligible(S.allowanceEligibility, user.role, 'earlyLate')) return false;
  const a = S.allowances || {};
  const thr1 = a.lateNightThreshold1Hour || a.lateNightThresholdHour || 19;
  const mins = lateNightCheckoutMins(day.checkOut);
  return Number.isFinite(mins) && mins >= thr1 * 60;
}
// Late night pay: device check-out (or an Accounting/MD-allowed web check-out) + approved
// late-out. Rest days also need approved holiday-work.
function deviceScanQualifiesForLateNight(d, holidayWorkDateSet) {
  if (!d || !d.lateOut || !d.lateApproved || d.status === 'company-trip') return false;
  if (isFullDayPersonalLeaveStatus(d.status) || !lateNightCheckoutOk(d)) return false;
  if (isRestAttendanceDay(d) && !(holidayWorkDateSet && holidayWorkDateSet.has(d.date))) return false;
  return true;
}
```

- [ ] **Step 5: Make the same replacement in app.js**

In `app.js` (dual-sync block, ~1318), find the identical 7-line snippet from Step 4 (`// Late night pay: device check-out + approved late-out. ...` through the closing `}` of `deviceScanQualifiesForLateNight`). Replace it with the exact same new text from Step 4, character for character.

- [ ] **Step 6: Run the test and confirm it passes**

Run: `node C:/Users/tairo/AppData/Local/Temp/claude/Z--/1a698e2c-c5d4-4394-a364-42b928382219/scratchpad/test-dualsync-checkout-review.js`
Expected:
```
[server] dual-sync checkout-review cases passed
[client] dual-sync checkout-review cases passed
ALL PASS
```

- [ ] **Step 7: Lint + syntax check** (command block at the top). Expected: clean.

---

## Task 2: Server data file, `generatePeriodDays` fields, `computePayroll` wiring (fail closed)

**Files:**
- Modify: `server.js` — insert the data-layer block before the comment `// Was missing entirely — GET/PUT /api/settings referenced these but they were never defined,` (~3016)
- Modify: `server.js` `attendanceDayForUser` (~4112), `generatePeriodDays` (~7150, the overlay comment ~7220, `days.push` ~7307), `computePayroll` (~7387)
- Create: `SCRATCH\test-server-period-days.js`

**Interfaces:**
- Consumes: `readJSON(filename, fallback)` (returns `null` on a parse or read error, `fallback` when the file is missing), `makeHandlerLock(label)`, `checkoutReviewDecisionFor` (Task 1)
- Produces:
  - `const CHECKOUT_REVIEWS_FILE = 'checkout-reviews.json'`
  - `const CHECKOUT_REVIEWS_UNAVAILABLE = 'Service temporarily unavailable'`
  - `const withCheckoutReviewsLock = makeHandlerLock('CHECKOUT_REVIEWS')`
  - `readCheckoutReviews() → object | null` (null = unreadable or corrupt; `{}` when the file is missing)
  - `attendanceDayForUser(user, dateStr, reviews = {})`
  - `generatePeriodDays(start, end, isCurrent, user, attLog, leaves, appSettings, reviews = {})` — each day gains `checkOutReview` and `rawCheckOut`
  - `computePayroll` throws `Error('Service temporarily unavailable')` when `readCheckoutReviews()` returns null

- [ ] **Step 1: Write the failing test** `SCRATCH\test-server-period-days.js`

```js
'use strict';
const assert = require('assert');
const { SERVER, readSrc, extractFunction, dualSyncBlock, load } = require('./extract-fn.js');

const src = readSrc(SERVER);
const code = [
  dualSyncBlock(src),
  extractFunction(src, 'ta_localDateStr'),
  extractFunction(src, 'generatePeriodDays'),
  extractFunction(src, 'readCheckoutReviews'),
].join('\n');
const state = { json: {} };
const ctx = {
  bangkokTodayDate: () => new Date(2026, 8, 23),
  isPublicHoliday: () => false,
  isCompanyTripDay: () => false,
  leaveDayCoverage: () => 'none',
  lateReferenceMin: (row, std) => std,
  readJSON: () => state.json,
  CHECKOUT_REVIEWS_FILE: 'checkout-reviews.json',
};
const h = load(code, ctx, Object.keys(ctx), ['generatePeriodDays', 'readCheckoutReviews']);

const user = { id: 7, role: 'user', employeeNo: '9001' };
const S = { workSchedule: { standardStartHour: 8, standardStartMinute: 30 }, allowances: {}, allowanceEligibility: {} };
const D = '2026-09-10';
const day0 = new Date(D + 'T12:00:00');
const attLog = { [D]: { checkIn: '08:10', checkInSource: 'device', checkOut: '17:40', checkOutSource: 'web', status: 'present' } };
const tc = { id: 1, userId: 7, type: 'time-correction', status: 'approved', dateFrom: D, dateTo: D, correctionField: 'checkOut', correctedTime: '21:00' };
const run = (log, leaves, reviews) => h.generatePeriodDays(day0, day0, false, user, log, leaves, S, reviews)[0];

// optional 8th param: old 7-arg callers keep working
let d = h.generatePeriodDays(day0, day0, false, user, attLog, [], S)[0];
assert.strictEqual(d.checkOutReview, null, 'no reviews -> null');
assert.strictEqual(d.rawCheckOut, '17:40', 'rawCheckOut = scanned time');

// correction overlays checkOut; rawCheckOut keeps the scan; source stays web
d = run(attLog, [tc], {});
assert.strictEqual(d.checkOut, '21:00');
assert.strictEqual(d.rawCheckOut, '17:40');
assert.strictEqual(d.checkOutSource, 'web');
assert.strictEqual(d.checkOutReview, null, 'pending');

d = run(attLog, [tc], { '7_2026-09-10': { decision: 'allow', checkOut: '21:00' } });
assert.strictEqual(d.checkOutReview, 'allow', 'allow applies when checkOut matches');

d = run(attLog, [tc], { '7_2026-09-10': { decision: 'allow', checkOut: '17:40' } });
assert.strictEqual(d.checkOutReview, null, 'stale review (reviewed before the correction) -> pending');

d = run(attLog, [tc], { '7_2026-09-10': { decision: 'deny', checkOut: '21:00' } });
assert.strictEqual(d.checkOutReview, 'deny');

d = run(attLog, [tc], { '17_2026-09-10': { decision: 'allow', checkOut: '21:00' } });
assert.strictEqual(d.checkOutReview, null, 'another user key never applies');

const devLog = { [D]: { checkIn: '08:10', checkInSource: 'device', checkOut: '21:00', checkOutSource: 'device', status: 'present' } };
d = run(devLog, [], { '7_2026-09-10': { decision: 'deny', checkOut: '21:00' } });
assert.strictEqual(d.checkOutReview, null, 'device check-out ignores reviews');

d = run(attLog, [tc], null);
assert.strictEqual(d.checkOutReview, null, 'null map tolerated');

// readCheckoutReviews: fail closed
state.json = null;          assert.strictEqual(h.readCheckoutReviews(), null, 'unreadable -> null');
state.json = [];            assert.strictEqual(h.readCheckoutReviews(), null, 'array (corrupt) -> null');
state.json = 'x';           assert.strictEqual(h.readCheckoutReviews(), null, 'string (corrupt) -> null');
state.json = {};            assert.deepStrictEqual(h.readCheckoutReviews(), {}, 'missing file -> {}');
state.json = { '7_2026-09-10': { decision: 'allow' } };
assert.deepStrictEqual(h.readCheckoutReviews(), { '7_2026-09-10': { decision: 'allow' } });

// computePayroll wiring (static: its dependency list is too large to eval)
const cp = extractFunction(src, 'computePayroll');
assert.ok(cp.includes('const reviews = readCheckoutReviews();'), 'computePayroll reads reviews');
assert.ok(cp.includes("if (reviews === null) throw new Error('Service temporarily unavailable');"), 'computePayroll fails closed');
assert.ok(cp.includes('generatePeriodDays(start, end, isCurrent, user, attLog, leaves, S, reviews)'), 'computePayroll passes reviews');
const ad = extractFunction(src, 'attendanceDayForUser');
assert.ok(ad.includes('function attendanceDayForUser(user, dateStr, reviews = {})'), 'attendanceDayForUser takes reviews');
assert.ok(ad.includes('generatePeriodDays(dayStart, dayStart, false, user, attLog, leaves, S, reviews)'), 'attendanceDayForUser forwards reviews');
console.log('ALL PASS');
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `node C:/Users/tairo/AppData/Local/Temp/claude/Z--/1a698e2c-c5d4-4394-a364-42b928382219/scratchpad/test-server-period-days.js`
Expected: `Error: function readCheckoutReviews not found`.

- [ ] **Step 3: Add the data layer** (server.js, before the settings `readJSON` comment)

Find:

```js
// Was missing entirely — GET/PUT /api/settings referenced these but they were never defined,
```

Replace with:

```js
// ===== WEB CHECK-OUT LATE NIGHT REVIEWS (2026-09-23) =====
// { "<userId>_<YYYY-MM-DD>": { decision:'allow'|'deny', checkOut, rawCheckOut, by, byId, at } }
// Own file, not a settings key -- PUT /api/settings deep-merges object keys, which would make a
// cleared review impossible to delete. Unreadable/corrupt file => null => callers fail closed.
const CHECKOUT_REVIEWS_FILE = 'checkout-reviews.json';
const CHECKOUT_REVIEWS_UNAVAILABLE = 'Service temporarily unavailable';
const withCheckoutReviewsLock = makeHandlerLock('CHECKOUT_REVIEWS');
function readCheckoutReviews() {
  const data = readJSON(CHECKOUT_REVIEWS_FILE, {});
  if (data === null) return null;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  return data;
}

// Was missing entirely — GET/PUT /api/settings referenced these but they were never defined,
```

- [ ] **Step 4: `attendanceDayForUser` takes and forwards reviews** (~4112)

Find:

```js
function attendanceDayForUser(user, dateStr) {
  const dayStart = new Date(dateStr + 'T12:00:00');
  const attLog = buildAttendanceLogForUser(user, dayStart, dayStart);
  const leaves = readLeaves() || [];
  const S = getAppSettings();
  const days = generatePeriodDays(dayStart, dayStart, false, user, attLog, leaves, S);
  return days[0] || null;
}
```

Replace with:

```js
// `reviews`: the checkout-reviews map (PUT /api/checkout-reviews passes it so the derived day
// carries checkOutReview). Other callers do not need review decisions and pass nothing.
function attendanceDayForUser(user, dateStr, reviews = {}) {
  const dayStart = new Date(dateStr + 'T12:00:00');
  const attLog = buildAttendanceLogForUser(user, dayStart, dayStart);
  const leaves = readLeaves() || [];
  const S = getAppSettings();
  const days = generatePeriodDays(dayStart, dayStart, false, user, attLog, leaves, S, reviews);
  return days[0] || null;
}
```

- [ ] **Step 5: `generatePeriodDays` signature** (~7150)

Find:

```js
function generatePeriodDays(start, end, isCurrent, user, attLog, leaves, appSettings) {
  const uid = user.id;
```

Replace with:

```js
function generatePeriodDays(start, end, isCurrent, user, attLog, leaves, appSettings, reviews = {}) {
  const uid = user.id;
  const reviewMap = reviews || {};
```

- [ ] **Step 6: Keep the scanned check-out before the overlay** (~7220)

Find:

```js
    // Overlay approved leaves so approvals always appear regardless of attLog state
    // (mirrors app.js's `DATA_LEAVES.filter(l => l.userId == uid && l.status === 'approved')`).
```

Replace with:

```js
    // 2026-09-23: the scanned check-out before any time-correction overlay -- shown to reviewers
    // as "21:00 (corrected from 17:40)". Dual-sync twin in app.js.
    const rawCheckOut = checkOut;

    // Overlay approved leaves so approvals always appear regardless of attLog state
    // (mirrors app.js's `DATA_LEAVES.filter(l => l.userId == uid && l.status === 'approved')`).
```

- [ ] **Step 7: Set `checkOutReview` after the overlay and push both fields** (~7307)

Find:

```js
    days.push({ date: dateStr, isWeekend, isPubHoliday, isFuture, status, checkIn, checkOut, lateOut, upcountry, longDistance, longDistanceKm, longDistanceAllowance, lateApproved, firstScanAfterCutoff, partialLeave, checkInSource, checkOutSource });
```

Replace with:

```js
    // 2026-09-23: after the overlay, so a review counts only for the effective (corrected) web
    // check-out it was made on. Dual-sync twin in app.js.
    const checkOutReview = checkoutReviewDecisionFor(reviewMap[`${uid}_${dateStr}`], checkOut, checkOutSource);
    days.push({ date: dateStr, isWeekend, isPubHoliday, isFuture, status, checkIn, checkOut, lateOut, upcountry, longDistance, longDistanceKm, longDistanceAllowance, lateApproved, firstScanAfterCutoff, partialLeave, checkInSource, checkOutSource, checkOutReview, rawCheckOut });
```

- [ ] **Step 8: `computePayroll` reads reviews and fails closed** (~7387)

Find (the 2-space-indented copy inside `computePayroll`; the 6-space `const isCurrent = periodIndex === 0;` at ~8034 is a different function and stays unchanged):

```js
  const isCurrent = periodIndex === 0;
  const attLog = buildAttendanceLogForUser(user, start, end);
  const leaves = readLeaves() || [];
  const pDays = generatePeriodDays(start, end, isCurrent, user, attLog, leaves, S);
```

Replace with:

```js
  const isCurrent = periodIndex === 0;
  const attLog = buildAttendanceLogForUser(user, start, end);
  const leaves = readLeaves() || [];
  // 2026-09-23: an Accounting/MD-allowed web check-out pays Late Night like a device scan. Never
  // treat an unreadable reviews file as "no reviews" -- that would silently change payroll.
  const reviews = readCheckoutReviews();
  if (reviews === null) throw new Error('Service temporarily unavailable');
  const pDays = generatePeriodDays(start, end, isCurrent, user, attLog, leaves, S, reviews);
```

- [ ] **Step 9: Run the test and confirm it passes**

Run: `node C:/Users/tairo/AppData/Local/Temp/claude/Z--/1a698e2c-c5d4-4394-a364-42b928382219/scratchpad/test-server-period-days.js`
Expected: `ALL PASS`. Also re-run `test-dualsync-checkout-review.js` → `ALL PASS`.

- [ ] **Step 10: Lint + syntax check.** Expected: clean.

---

## Task 3: Server `lateOutSubmitBlockReason` — after midnight, web pending/denied, tier ≤ check-out

**Files:**
- Modify: `server.js` `lateOutSubmitBlockReason` (~7313–7349), POST `/api/leaves` late-out gate (~5170), owner PUT `/api/leaves/:id` late-out gate (~5617)
- Create: `SCRATCH\test-server-lateout-gate.js`

**Interfaces:**
- Consumes: `readCheckoutReviews`, `CHECKOUT_REVIEWS_UNAVAILABLE` (Task 2), `lateNightCheckoutMins`, `lateNightCheckoutOk` (Task 1), `generatePeriodDays(..., reviews)` (Task 2)
- Produces: `lateOutSubmitBlockReason(user, dateStr, lateOutTime) → string | null`. It returns `CHECKOUT_REVIEWS_UNAVAILABLE` when the reviews file cannot be read, and the callers answer 503 for that value.

- [ ] **Step 1: Write the failing test** `SCRATCH\test-server-lateout-gate.js`

```js
'use strict';
const assert = require('assert');
const { SERVER, readSrc, extractFunction, dualSyncBlock, load } = require('./extract-fn.js');

const src = readSrc(SERVER);
const code = [
  dualSyncBlock(src),
  extractFunction(src, 'ta_localDateStr'),
  extractFunction(src, 'generatePeriodDays'),
  extractFunction(src, 'lateOutSubmitBlockReason'),
].join('\n');
const state = {};
const S = {
  workSchedule: { standardStartHour: 8, standardStartMinute: 30 },
  allowances: { lateNightThreshold1Hour: 19, lateNightThreshold2Hour: 20 },
  allowanceEligibility: {},
};
const ctx = {
  CHECKOUT_REVIEWS_UNAVAILABLE: 'Service temporarily unavailable',
  bangkokTodayDate: () => new Date(2026, 8, 23),
  isPublicHoliday: () => false,
  isCompanyTripDay: () => false,
  leaveDayCoverage: () => 'none',
  lateReferenceMin: (row, std) => std,
  isValidDateStr: s => /^\d{4}-\d{2}-\d{2}$/.test(s),
  getAppSettings: () => S,
  buildAttendanceLogForUser: () => state.attLog,
  readLeaves: () => state.leaves,
  readCheckoutReviews: () => state.reviews,
  fullDayPersonalLeaveNoClaimMessage: () => 'FULL_LEAVE',
  isHolidayWorkDay: () => false,
  hasActiveHolidayWork: () => false,
};
const h = load(code, ctx, Object.keys(ctx), ['lateOutSubmitBlockReason']);
const user = { id: 7, role: 'user', employeeNo: '9001' };
const D = '2026-09-10';
const set = (checkOut, source, reviews, leaves) => {
  state.attLog = { [D]: { checkIn: '08:10', checkInSource: 'device', checkOut, checkOutSource: source, status: 'present' } };
  state.reviews = reviews;
  state.leaves = leaves || [];
};
const gate = t => h.lateOutSubmitBlockReason(user, D, t);

set('21:00', 'web', {});
assert.match(gate('20:00'), /waiting for Accounting\/MD review/, 'web pending');
set('21:00', 'web', { '7_2026-09-10': { decision: 'deny', checkOut: '21:00' } });
assert.match(gate('20:00'), /was not allowed by Accounting\/MD/, 'web denied');
set('21:00', 'web', { '7_2026-09-10': { decision: 'allow', checkOut: '21:00' } });
assert.strictEqual(gate('20:00'), null, 'web+allow matching');
set('21:00', 'web', { '7_2026-09-10': { decision: 'allow', checkOut: '20:30' } });
assert.match(gate('20:00'), /waiting for Accounting\/MD review/, 'web+allow stale time -> pending');
set('19:10', 'web', { '7_2026-09-10': { decision: 'allow', checkOut: '19:10' } });
assert.match(gate('20:00'), /later than your check-out \(19:10\)/, 'web+allow: tier later than check-out refused');
set('19:10', 'device', {});
assert.match(gate('20:00'), /later than your check-out \(19:10\)/, 'device: tier later than check-out refused');
assert.strictEqual(gate('19:00'), null, 'device 19:10 with 19:00 tier ok');
assert.strictEqual(gate(undefined), null, 'no tier given (legacy PUT) -> not checked here');
set('00:30', 'device', {});
assert.strictEqual(gate('20:00'), null, 'device 00:30 counts as top tier');
set('00:30', 'web', {});
assert.match(gate('20:00'), /waiting for Accounting\/MD review/, 'web 00:30 needs review');
set('18:30', 'device', {});
assert.match(gate('19:00'), /at or after 19:00/, 'too early');
set('21:00', null, {});
assert.match(gate('19:00'), /face scanner, not the web app/, 'unknown source');
set('21:00', 'device', null);
assert.strictEqual(gate('19:00'), 'Service temporarily unavailable', 'unreadable reviews -> fail closed');
state.attLog = { [D]: { checkIn: '08:10', checkInSource: 'device', status: 'present' } };
state.reviews = {};
assert.strictEqual(gate('19:00'), 'Late Night Out requires a check-out first', 'no check-out');
assert.strictEqual(h.lateOutSubmitBlockReason(user, 'bad', '19:00'), 'dateFrom must be a valid YYYY-MM-DD date');

// both call sites pass lateOutTime and map the unavailable sentinel to 503
assert.ok(src.includes('const lateOutErr = lateOutSubmitBlockReason(targetUser, body.dateFrom, body.lateOutTime);'), 'POST passes lateOutTime');
assert.ok(src.includes('const lateOutErr = lateOutSubmitBlockReason(live, resolvedDateFromForLock,'), 'PUT passes lateOutTime');
assert.strictEqual((src.match(/if \(lateOutErr === CHECKOUT_REVIEWS_UNAVAILABLE\) return res\.status\(503\)/g) || []).length, 2, 'both sites answer 503');
console.log('ALL PASS');
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `node C:/Users/tairo/AppData/Local/Temp/claude/Z--/1a698e2c-c5d4-4394-a364-42b928382219/scratchpad/test-server-lateout-gate.js`
Expected: an `AssertionError` on the first `assert.match` (the current code returns `'Late Night Out requires check-out at the face scanner, not the web app'`).

- [ ] **Step 3: Replace `lateOutSubmitBlockReason`** (~7313)

Find the whole current function and the comment above it:

```js
// 2026-08-27: Late Night Out may only be submitted after a face-scanner check-out that already
// meets the ×1 threshold. Time-correction overlays the displayed clock time but does not change
// source — a web check-out cannot unlock this claim.
function lateOutSubmitBlockReason(user, dateStr) {
  if (!user || !dateStr || !isValidDateStr(dateStr)) {
    return 'dateFrom must be a valid YYYY-MM-DD date';
  }
  const S = getAppSettings();
  const dayStart = new Date(dateStr + 'T12:00:00');
  const attLog = buildAttendanceLogForUser(user, dayStart, dayStart);
  const leaves = readLeaves() || [];
  const days = generatePeriodDays(dayStart, dayStart, false, user, attLog, leaves, S);
  const day = days[0];
  if (isFullDayPersonalLeaveStatus(day && day.status)) {
    return fullDayPersonalLeaveNoClaimMessage();
  }
  if (!day || !day.checkOut) {
    return 'Late Night Out requires a face-scan check-out first';
  }
  if (!isDeviceScanSource(day.checkOutSource)) {
    return 'Late Night Out requires check-out at the face scanner, not the web app';
  }
  const hour = parseInt(day.checkOut, 10);
  const thr1 = S.allowances.lateNightThreshold1Hour || S.allowances.lateNightThresholdHour || 19;
  if (!Number.isFinite(hour) || hour < thr1) {
    return `Late Night Out requires a device check-out at or after ${String(thr1).padStart(2, '0')}:00`;
  }
  if (!day.checkIn) {
    return 'Late Night Out requires a check-in first';
  }
  const hwDay = isHolidayWorkDay(dateStr);
  const hasHw = hasActiveHolidayWork(leaves, user.id, dateStr);
  if (hwDay && !hasHw) {
    return 'Late night on a holiday requires a holiday work request first';
  }
  return null;
}
```

Replace with:

```js
// 2026-08-27: Late Night Out may only be submitted after a check-out that already meets the ×1
// threshold. 2026-09-23 (web check-out review): a face-scanner check-out qualifies directly; a web
// check-out qualifies only after Accounting/MD allowed that exact effective check-out time (see
// checkoutReviewTrigger / PUT /api/checkout-reviews). A check-out before 05:00 is after midnight
// on the same business day and reaches the top tier. The chosen tier (lateOutTime) may not be
// later than the real check-out -- this used to be checked only in the browser.
// Returns CHECKOUT_REVIEWS_UNAVAILABLE when the reviews file cannot be read (callers answer 503).
function lateOutSubmitBlockReason(user, dateStr, lateOutTime) {
  if (!user || !dateStr || !isValidDateStr(dateStr)) {
    return 'dateFrom must be a valid YYYY-MM-DD date';
  }
  const reviews = readCheckoutReviews();
  if (reviews === null) return CHECKOUT_REVIEWS_UNAVAILABLE;
  const S = getAppSettings();
  const dayStart = new Date(dateStr + 'T12:00:00');
  const attLog = buildAttendanceLogForUser(user, dayStart, dayStart);
  const leaves = readLeaves() || [];
  const days = generatePeriodDays(dayStart, dayStart, false, user, attLog, leaves, S, reviews);
  const day = days[0];
  if (isFullDayPersonalLeaveStatus(day && day.status)) {
    return fullDayPersonalLeaveNoClaimMessage();
  }
  if (!day || !day.checkOut) {
    return 'Late Night Out requires a check-out first';
  }
  const thr1 = S.allowances.lateNightThreshold1Hour || S.allowances.lateNightThresholdHour || 19;
  const outMins = lateNightCheckoutMins(day.checkOut);
  if (!Number.isFinite(outMins) || outMins < thr1 * 60) {
    return `Late Night Out requires a check-out at or after ${String(thr1).padStart(2, '0')}:00`;
  }
  if (!lateNightCheckoutOk(day)) {
    if (day.checkOutSource === 'web') {
      return day.checkOutReview === 'deny'
        ? 'This web check-out was not allowed by Accounting/MD -- Late Night Out cannot be claimed'
        : 'This web check-out is waiting for Accounting/MD review before Late Night Out can be submitted';
    }
    return 'Late Night Out requires check-out at the face scanner, not the web app';
  }
  if (lateOutTime !== undefined && lateOutTime !== null && lateOutTime !== '') {
    const tierMins = lateNightCheckoutMins(lateOutTime);
    if (!Number.isFinite(tierMins) || tierMins > outMins) {
      return `The selected return time is later than your check-out (${day.checkOut})`;
    }
  }
  if (!day.checkIn) {
    return 'Late Night Out requires a check-in first';
  }
  const hwDay = isHolidayWorkDay(dateStr);
  const hasHw = hasActiveHolidayWork(leaves, user.id, dateStr);
  if (hwDay && !hasHw) {
    return 'Late night on a holiday requires a holiday work request first';
  }
  return null;
}
```

- [ ] **Step 4: POST `/api/leaves` passes `lateOutTime`** (~5170)

Find:

```js
    if (type === 'late-out') {
      const lateOutErr = lateOutSubmitBlockReason(targetUser, body.dateFrom);
      if (lateOutErr) return res.status(400).json({ success:false, message: lateOutErr });
    }
```

Replace with:

```js
    if (type === 'late-out') {
      const lateOutErr = lateOutSubmitBlockReason(targetUser, body.dateFrom, body.lateOutTime);
      if (lateOutErr === CHECKOUT_REVIEWS_UNAVAILABLE) return res.status(503).json({ success:false, message: lateOutErr });
      if (lateOutErr) return res.status(400).json({ success:false, message: lateOutErr });
    }
```

- [ ] **Step 5: Owner PUT `/api/leaves/:id` passes the resolved `lateOutTime`** (~5617)

Find:

```js
    if (newType === 'late-out') {
      const lateOutErr = lateOutSubmitBlockReason(live, resolvedDateFromForLock);
      if (lateOutErr) return res.status(400).json({ success:false, message: lateOutErr });
    }
```

Replace with:

```js
    if (newType === 'late-out') {
      // Validate the RESOLVED tier (what the record will end up with), not just this request's.
      const lateOutErr = lateOutSubmitBlockReason(live, resolvedDateFromForLock,
        updates.lateOutTime !== undefined ? updates.lateOutTime : leave.lateOutTime);
      if (lateOutErr === CHECKOUT_REVIEWS_UNAVAILABLE) return res.status(503).json({ success:false, message: lateOutErr });
      if (lateOutErr) return res.status(400).json({ success:false, message: lateOutErr });
    }
```

- [ ] **Step 6: Run the test and confirm it passes**

Run: `node C:/Users/tairo/AppData/Local/Temp/claude/Z--/1a698e2c-c5d4-4394-a364-42b928382219/scratchpad/test-server-lateout-gate.js`
Expected: `ALL PASS`. Re-run the Task 1 and Task 2 tests → `ALL PASS`.

- [ ] **Step 7: Lint + syntax check.** Expected: clean.

---

## Task 4: Server `GET/PUT /api/checkout-reviews`

**Files:**
- Modify: `server.js` — insert the handlers and routes right after `readCheckoutReviews()` (added in Task 2)
- Create: `SCRATCH\test-server-checkout-review-api.js`

**Interfaces:**
- Consumes: `readUsers()`, `parseBody(req)`, `isValidDateStr`, `isSuperAdminUser`, `readJSON`, `lockedPeriodInRange(from, to)`, `accountingConfirmedInRange(from, to, userId)`, `mdApprovedPeriodInRange(from, to, userId)`, `attendanceDayForUser(user, dateStr, reviews)`, `checkoutReviewTrigger`, `getAppSettings`, `writeJSON`, `broadcast`, `isLeaveFullAccess`, `requireRole`, `withCheckoutReviewsLock`
- Produces:
  - `handleGetCheckoutReviews(req, res)` → `{ success:true, reviews }`. `isLeaveFullAccess` (md/accounting/manager + superadmin inheritance) gets all keys; everyone else gets only keys starting with `${live.id}_`.
  - `handlePutCheckoutReview(req, res)` — body `{ userId, date, decision: 'allow'|'deny'|null }` → `{ success:true, review }` (review is `null` on a clear)
  - Routes: `GET /api/checkout-reviews`, `PUT /api/checkout-reviews` (`requireRole('md','accounting')`, lock held)
  - WS message `{ type: 'CHECKOUT_REVIEWS_UPDATED' }` (no other fields)

- [ ] **Step 1: Write the failing test** `SCRATCH\test-server-checkout-review-api.js`

```js
'use strict';
const assert = require('assert');
const { SERVER, readSrc, extractFunction, dualSyncBlock, load } = require('./extract-fn.js');

const src = readSrc(SERVER);
const code = [
  dualSyncBlock(src),
  extractFunction(src, 'isLeaveFullAccess'),
  extractFunction(src, 'handleGetCheckoutReviews'),
  extractFunction(src, 'handlePutCheckoutReview'),
].join('\n');

const USERS = [
  { id: 2, name: 'Acct', role: 'accounting' },
  { id: 7, name: 'Staff', role: 'user' },
  { id: 17, name: 'Staff17', role: 'user' },
  { id: 99, name: 'sys', role: 'superadmin', isSystemAccount: true },
];
const S = { allowances: { lateNightThreshold1Hour: 19 }, allowanceEligibility: {} };
const TRIGGER_DAY = { date: '2026-09-10', status: 'present', isFuture: false, checkIn: '08:10', checkOut: '21:00', checkOutSource: 'web', rawCheckOut: '17:40', checkOutReview: null };
let st;
function reset() {
  st = { users: USERS, settingsOk: true, locked: false, confirmed: false, mdApproved: false,
    reviews: {}, day: Object.assign({}, TRIGGER_DAY), writes: [], broadcasts: [] };
}
const ctx = {
  CHECKOUT_REVIEWS_FILE: 'checkout-reviews.json',
  CHECKOUT_REVIEWS_UNAVAILABLE: 'Service temporarily unavailable',
  readUsers: () => st.users,
  parseBody: req => req.body,
  isValidDateStr: s => /^\d{4}-\d{2}-\d{2}$/.test(s),
  isSuperAdminUser: u => !!(u && u.isSystemAccount),
  readJSON: name => (name === 'settings.json' && !st.settingsOk ? null : {}),
  lockedPeriodInRange: () => st.locked,
  accountingConfirmedInRange: () => st.confirmed,
  mdApprovedPeriodInRange: () => st.mdApproved,
  readCheckoutReviews: () => (st.reviews === null ? null : JSON.parse(JSON.stringify(st.reviews))),
  attendanceDayForUser: () => st.day,
  getAppSettings: () => S,
  writeJSON: (f, d) => st.writes.push({ f, d: JSON.parse(JSON.stringify(d)) }),
  broadcast: m => st.broadcasts.push(m),
};
const h = load(code, ctx, Object.keys(ctx), ['handleGetCheckoutReviews', 'handlePutCheckoutReview']);
const res = () => ({ code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } });
const put = (sub, body) => { const r = res(); h.handlePutCheckoutReview({ user: { sub }, body }, r); return r; };
const get = sub => { const r = res(); h.handleGetCheckoutReviews({ user: { sub } }, r); return r; };
const noWrite = msg => { assert.strictEqual(st.writes.length, 0, msg + ': nothing written'); assert.strictEqual(st.broadcasts.length, 0, msg + ': nothing broadcast'); };

reset(); let r = put(2, { userId: 2, date: '2026-09-10', decision: 'allow' });
assert.strictEqual(r.code, 403, 'self refused'); noWrite('self');

reset(); st.day = Object.assign({}, TRIGGER_DAY, { checkOutSource: 'device' });
r = put(2, { userId: 7, date: '2026-09-10', decision: 'allow' });
assert.strictEqual(r.code, 400, 'non-trigger day refused'); noWrite('non-trigger');

reset(); st.settingsOk = false; r = put(2, { userId: 7, date: '2026-09-10', decision: 'allow' });
assert.strictEqual(r.code, 503, 'settings unreadable -> 503'); noWrite('settings');

for (const decision of ['allow', 'deny', null]) {
  reset(); st.locked = true; r = put(2, { userId: 7, date: '2026-09-10', decision });
  assert.strictEqual(r.code, 400, 'locked period refused: ' + decision); noWrite('locked ' + decision);
  reset(); st.confirmed = true; r = put(2, { userId: 7, date: '2026-09-10', decision });
  assert.strictEqual(r.code, 409, 'confirmed period refused: ' + decision); noWrite('confirmed ' + decision);
  reset(); st.mdApproved = true; r = put(2, { userId: 7, date: '2026-09-10', decision });
  assert.strictEqual(r.code, 409, 'MD-approved period refused: ' + decision); noWrite('md ' + decision);
}

reset(); r = put(2, { userId: 7, date: '2026-09-10', decision: 'maybe' });
assert.strictEqual(r.code, 400, 'bad decision'); noWrite('bad decision');
reset(); r = put(2, { userId: 7, date: '2026/09/10', decision: 'allow' });
assert.strictEqual(r.code, 400, 'bad date'); noWrite('bad date');
reset(); r = put(2, { userId: 99, date: '2026-09-10', decision: 'allow' });
assert.strictEqual(r.code, 404, 'system account is not a review target'); noWrite('system target');
reset(); st.reviews = null; r = put(2, { userId: 7, date: '2026-09-10', decision: 'allow' });
assert.strictEqual(r.code, 503, 'reviews unreadable -> 503'); noWrite('reviews null');

// allow: stores SERVER-derived times (client-sent checkOut ignored), actor, broadcast without payload
reset(); r = put(2, { userId: 7, date: '2026-09-10', decision: 'allow', checkOut: '23:59', rawCheckOut: '23:59' });
assert.strictEqual(r.code, 200); assert.strictEqual(r.body.success, true);
const saved = st.writes[0].d['7_2026-09-10'];
assert.strictEqual(st.writes[0].f, 'checkout-reviews.json');
assert.strictEqual(saved.decision, 'allow');
assert.strictEqual(saved.checkOut, '21:00', 'server-derived checkOut');
assert.strictEqual(saved.rawCheckOut, '17:40', 'server-derived rawCheckOut');
assert.strictEqual(saved.by, 'Acct'); assert.strictEqual(saved.byId, 2);
assert.ok(!Number.isNaN(Date.parse(saved.at)), 'at is ISO');
assert.deepStrictEqual(st.broadcasts, [{ type: 'CHECKOUT_REVIEWS_UPDATED' }], 'payload-less broadcast');

// clear (null) removes the key
reset(); st.reviews = { '7_2026-09-10': { decision: 'deny', checkOut: '21:00' }, '17_2026-09-10': { decision: 'allow', checkOut: '20:00' } };
r = put(2, { userId: 7, date: '2026-09-10', decision: null });
assert.strictEqual(r.code, 200); assert.strictEqual(r.body.review, null);
assert.deepStrictEqual(Object.keys(st.writes[0].d), ['17_2026-09-10'], 'only the cleared key removed');

// GET scoping
reset(); st.reviews = { '7_2026-09-10': { decision: 'allow' }, '17_2026-09-11': { decision: 'deny' } };
r = get(2); assert.deepStrictEqual(Object.keys(r.body.reviews).sort(), ['17_2026-09-11', '7_2026-09-10'], 'accounting sees all');
r = get(7); assert.deepStrictEqual(Object.keys(r.body.reviews), ['7_2026-09-10'], 'user sees only own keys (not 17_)');
r = get(99); assert.strictEqual(Object.keys(r.body.reviews).length, 2, 'superadmin inherits full access');
st.reviews = null; r = get(7); assert.strictEqual(r.code, 503, 'GET fails closed');

// routes registered with the right guards
assert.ok(src.includes("app.get('/api/checkout-reviews', handleGetCheckoutReviews);"));
assert.ok(src.includes("app.put('/api/checkout-reviews', requireRole('md', 'accounting'), withCheckoutReviewsLock(handlePutCheckoutReview));"));
console.log('ALL PASS');
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `node C:/Users/tairo/AppData/Local/Temp/claude/Z--/1a698e2c-c5d4-4394-a364-42b928382219/scratchpad/test-server-checkout-review-api.js`
Expected: `Error: function handleGetCheckoutReviews not found`.

- [ ] **Step 3: Add the handlers and routes**

Find (added in Task 2):

```js
function readCheckoutReviews() {
  const data = readJSON(CHECKOUT_REVIEWS_FILE, {});
  if (data === null) return null;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  return data;
}
```

Replace with:

```js
function readCheckoutReviews() {
  const data = readJSON(CHECKOUT_REVIEWS_FILE, {});
  if (data === null) return null;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  return data;
}
// Full-access roles (md/accounting/manager; managers also browse others' attendance) get every
// review; everyone else only their own "<id>_" keys.
function handleGetCheckoutReviews(req, res) {
  const users = readUsers();
  if (users === null) return res.status(503).json({ success: false, message: CHECKOUT_REVIEWS_UNAVAILABLE });
  const live = users.find(u => u.id === req.user.sub);
  if (!live) return res.status(403).json({ success: false, message: 'Forbidden' });
  const all = readCheckoutReviews();
  if (all === null) return res.status(503).json({ success: false, message: CHECKOUT_REVIEWS_UNAVAILABLE });
  if (isLeaveFullAccess(live)) return res.json({ success: true, reviews: all });
  const prefix = `${live.id}_`;
  const own = {};
  Object.keys(all).forEach(k => { if (k.startsWith(prefix)) own[k] = all[k]; });
  return res.json({ success: true, reviews: own });
}
// Accounting/MD Allow / Deny / clear (decision:null) a web check-out at/after the Late Night time.
// requireRole('md','accounting') already refuses observers/inactive accounts (superadmin inherits,
// unchanged). Never on one's own record; never in a locked / Accounting-confirmed / MD-approved
// period (every decision, including a clear). Times are re-derived here -- never taken from the
// client. The broadcast carries no review data; clients re-fetch the scoped GET.
function handlePutCheckoutReview(req, res) {
  try {
    const users = readUsers();
    if (users === null) return res.status(503).json({ success: false, message: CHECKOUT_REVIEWS_UNAVAILABLE });
    const live = users.find(u => u.id === req.user.sub);
    if (!live) return res.status(403).json({ success: false, message: 'Forbidden: user record not found' });
    const body = parseBody(req) || {};
    const userId = Number(body.userId);
    const dateStr = body.date;
    const decision = body.decision;
    if (!Number.isInteger(userId) || userId <= 0) {
      return res.status(400).json({ success: false, message: 'userId is required' });
    }
    if (typeof dateStr !== 'string' || !isValidDateStr(dateStr)) {
      return res.status(400).json({ success: false, message: 'date must be a valid YYYY-MM-DD date' });
    }
    if (decision !== 'allow' && decision !== 'deny' && decision !== null) {
      return res.status(400).json({ success: false, message: "decision must be 'allow', 'deny' or null" });
    }
    if (userId === live.id) {
      return res.status(403).json({ success: false, message: 'You cannot review your own check-out' });
    }
    const target = users.find(u => u.id === userId);
    if (!target || isSuperAdminUser(target)) {
      return res.status(404).json({ success: false, message: 'Employee not found' });
    }
    // lockedPeriodInRange() reads settings through readSettings(), which turns a read failure into
    // {} (= "nothing locked") -- check the raw read first so a failure refuses instead.
    if (readJSON('settings.json', {}) === null) {
      return res.status(503).json({ success: false, message: CHECKOUT_REVIEWS_UNAVAILABLE });
    }
    if (lockedPeriodInRange(dateStr, dateStr)) {
      return res.status(400).json({ success: false, message: 'This pay period is locked' });
    }
    if (accountingConfirmedInRange(dateStr, dateStr, userId)) {
      return res.status(409).json({ success: false, message: 'Accounting has already confirmed tax for this period — unconfirm before making changes' });
    }
    if (mdApprovedPeriodInRange(dateStr, dateStr, userId)) {
      return res.status(409).json({ success: false, message: 'Payroll for this period has already been approved by the Managing Director -- ask them to revoke approval first' });
    }
    const reviews = readCheckoutReviews();
    if (reviews === null) return res.status(503).json({ success: false, message: CHECKOUT_REVIEWS_UNAVAILABLE });
    const day = attendanceDayForUser(target, dateStr, reviews);
    if (!checkoutReviewTrigger(day, target, getAppSettings())) {
      return res.status(400).json({ success: false, message: 'This day has no web check-out at or after the Late Night time to review' });
    }
    const key = `${userId}_${dateStr}`;
    let review = null;
    if (decision === null) {
      delete reviews[key];
    } else {
      review = {
        decision,
        checkOut: day.checkOut,
        rawCheckOut: day.rawCheckOut || null,
        by: String(live.name || live.username || 'User').slice(0, 120),
        byId: live.id,
        at: new Date().toISOString(),
      };
      reviews[key] = review;
    }
    writeJSON(CHECKOUT_REVIEWS_FILE, reviews);
    broadcast({ type: 'CHECKOUT_REVIEWS_UPDATED' });
    return res.json({ success: true, review });
  } catch (e) {
    const unavailable = !!(e && e.message === CHECKOUT_REVIEWS_UNAVAILABLE);
    console.error('[CHECKOUT_REVIEWS] PUT failed:', e && e.message);
    return res.status(unavailable ? 503 : 500).json({ success: false, message: unavailable ? CHECKOUT_REVIEWS_UNAVAILABLE : 'Server error' });
  }
}
app.get('/api/checkout-reviews', handleGetCheckoutReviews);
app.put('/api/checkout-reviews', requireRole('md', 'accounting'), withCheckoutReviewsLock(handlePutCheckoutReview));
```

Placement note: this block sits between the announcements routes (~2932–3014, already behind the global JWT middleware) and the settings `readJSON` definition, so the routes are registered after authentication. `readJSON`, `writeJSON`, `attendanceDayForUser` etc. are function declarations and are hoisted.

- [ ] **Step 4: Run the test and confirm it passes**

Run: `node C:/Users/tairo/AppData/Local/Temp/claude/Z--/1a698e2c-c5d4-4394-a364-42b928382219/scratchpad/test-server-checkout-review-api.js`
Expected: `ALL PASS`. Re-run the Task 1–3 tests → `ALL PASS`.

- [ ] **Step 5: Lint + syntax check.** Expected: clean.

---

## Task 5: Client data load, WS re-fetch, `generatePeriodDays` fields, pay gate

**Files:**
- Modify: `app.js` — globals after `let DATA_LEAVES = [];` (~1440); new loader after `loadLeavesFromBackend` (~4582–4595); `generatePeriodDays` (overlay comment ~4426, `days.push` ~4540); `initApp` load chain (~5160–5168); WS `onmessage` (~16779)
- Create: `SCRATCH\test-client-period-days.js`

**Interfaces:**
- Consumes: `apiFetch(path, opts)`, `attKey(userId, dateStr)` (`${userId}_${dateStr}`, the same format as the review key), `checkoutReviewDecisionFor` (Task 1), `renderDashboard`, `renderAttendanceTable`, `renderApprovals`, `renderPayslip`, `renderReports`, `updateApprovalBadge`
- Produces:
  - `let DATA_CHECKOUT_REVIEWS = {}`
  - `async loadCheckoutReviewsFromBackend() → boolean`
  - `rerenderAfterCheckoutReviews()`
  - client day objects gain `checkOutReview`, `rawCheckOut`
  - The pay gate is already `lateNightCheckoutOk` since Task 1. The client `computePayroll`, the dashboard (~7499, ~7939), reports (~9491, ~9990, ~10046), the table badge (~7131) and the printed table (~7324) all call `deviceScanQualifiesForLateNight`, so they now follow the review without further edits.

- [ ] **Step 1: Write the failing test** `SCRATCH\test-client-period-days.js`. It includes the server-vs-client parity check.

```js
'use strict';
const assert = require('assert');
const { SERVER, CLIENT, readSrc, extractFunction, dualSyncBlock, load } = require('./extract-fn.js');

const D = '2026-09-10';
const day0 = new Date(D + 'T12:00:00');
const user = { id: 7, role: 'user', employeeNo: '9001', name: 'Staff' };
const S = { workSchedule: { standardStartHour: 8, standardStartMinute: 30 }, allowances: { lateNightThreshold1Hour: 19, lateNightThreshold2Hour: 20, lateNight1: 240, lateNight2: 480 }, allowanceEligibility: {} };

// ---- client copy ----
const csrc = readSrc(CLIENT);
const ccode = [dualSyncBlock(csrc), extractFunction(csrc, 'localDateStr'), extractFunction(csrc, 'generatePeriodDays')].join('\n');
const cstate = { attendanceLog: {}, DATA_LEAVES: [], DATA_CHECKOUT_REVIEWS: {} };
const cctx = {
  attendanceLog: cstate.attendanceLog, DATA_LEAVES: cstate.DATA_LEAVES, DATA_CHECKOUT_REVIEWS: cstate.DATA_CHECKOUT_REVIEWS,
  attKey: (u, d) => `${u}_${d}`, APP_SETTINGS: S, DATA_USERS: [user], DATA_HOLIDAYS: [], currentUser: user,
  bangkokTodayDate: () => new Date(2026, 8, 23), businessDateStr: () => '2026-09-23',
  isPublicHoliday: () => false, isCompanyTripDay: () => false,
  leaveDayCoverage: () => 'none', lateReferenceMin: (row, std) => std,
};
const c = load(ccode, cctx, Object.keys(cctx), ['generatePeriodDays', 'deviceScanQualifiesForLateNight']);

// ---- server copy ----
const ssrc = readSrc(SERVER);
const scode = [dualSyncBlock(ssrc), extractFunction(ssrc, 'ta_localDateStr'), extractFunction(ssrc, 'generatePeriodDays')].join('\n');
const sctx = { bangkokTodayDate: () => new Date(2026, 8, 23), isPublicHoliday: () => false, isCompanyTripDay: () => false, leaveDayCoverage: () => 'none', lateReferenceMin: (row, std) => std };
const s = load(scode, sctx, Object.keys(sctx), ['generatePeriodDays', 'deviceScanQualifiesForLateNight']);

function scenario(rec, leaves, reviews) {
  Object.keys(cstate.attendanceLog).forEach(k => delete cstate.attendanceLog[k]);
  cstate.attendanceLog[`7_${D}`] = rec;
  cstate.DATA_LEAVES.length = 0; leaves.forEach(l => cstate.DATA_LEAVES.push(l));
  Object.keys(cstate.DATA_CHECKOUT_REVIEWS).forEach(k => delete cstate.DATA_CHECKOUT_REVIEWS[k]);
  Object.assign(cstate.DATA_CHECKOUT_REVIEWS, reviews);
  const cd = c.generatePeriodDays(day0, day0, false, 7)[0];
  const sd = s.generatePeriodDays(day0, day0, false, user, { [D]: rec }, leaves, S, reviews)[0];
  return { cd, sd };
}
// Late-night money exactly as both computePayroll copies derive it
const lnBonus = (h, d) => h.deviceScanQualifiesForLateNight(d, new Set()) ? (parseInt(d.lateOut) >= 20 ? 480 : 240) : 0;

const webRec = { checkIn: '08:10', checkInSource: 'device', checkOut: '17:40', checkOutSource: 'web', status: 'present' };
const tc = { id: 1, userId: 7, type: 'time-correction', status: 'approved', dateFrom: D, dateTo: D, correctionField: 'checkOut', correctedTime: '21:00' };
const lo = { id: 2, userId: 7, type: 'late-out', status: 'approved', dateFrom: D, dateTo: D, lateOutTime: '20:00' };

let r = scenario(webRec, [tc, lo], {});
assert.strictEqual(r.cd.checkOut, '21:00'); assert.strictEqual(r.cd.rawCheckOut, '17:40');
assert.strictEqual(r.cd.checkOutReview, null, 'client pending');
assert.strictEqual(lnBonus(c, r.cd), 0); assert.strictEqual(lnBonus(s, r.sd), 0, 'parity pending: 0');

r = scenario(webRec, [tc, lo], { [`7_${D}`]: { decision: 'allow', checkOut: '21:00' } });
assert.strictEqual(r.cd.checkOutReview, 'allow', 'client allow');
assert.strictEqual(lnBonus(c, r.cd), 480); assert.strictEqual(lnBonus(s, r.sd), 480, 'parity web+allow with approved 🌙: 480');

r = scenario(webRec, [tc, lo], { [`7_${D}`]: { decision: 'deny', checkOut: '21:00' } });
assert.strictEqual(r.cd.checkOutReview, 'deny');
assert.strictEqual(lnBonus(c, r.cd), 0); assert.strictEqual(lnBonus(s, r.sd), 0, 'parity after deny: 0');

r = scenario(webRec, [tc, lo], { [`7_${D}`]: { decision: 'allow', checkOut: '17:40' } });
assert.strictEqual(r.cd.checkOutReview, null, 'client stale review -> pending');
assert.strictEqual(lnBonus(c, r.cd), 0); assert.strictEqual(lnBonus(s, r.sd), 0, 'parity stale: 0');

const devRec = { checkIn: '08:10', checkInSource: 'device', checkOut: '00:30', checkOutSource: 'device', status: 'present' };
r = scenario(devRec, [lo], {});
assert.strictEqual(lnBonus(c, r.cd), 480); assert.strictEqual(lnBonus(s, r.sd), 480, 'parity device 00:30 + 20:00 tier: 480');

// every key both builders produce must match (review fields included)
r = scenario(webRec, [tc, lo], { [`7_${D}`]: { decision: 'allow', checkOut: '21:00' } });
['checkIn', 'checkOut', 'rawCheckOut', 'checkOutSource', 'checkOutReview', 'lateOut', 'lateApproved', 'status'].forEach(k =>
  assert.deepStrictEqual(r.cd[k], r.sd[k], 'parity field ' + k));

// wiring checks
assert.ok(csrc.includes('let DATA_CHECKOUT_REVIEWS = {};'));
assert.ok(csrc.includes("if (data.type === 'CHECKOUT_REVIEWS_UPDATED') {"));
assert.ok(extractFunction(csrc, 'loadCheckoutReviewsFromBackend').includes("apiFetch('/api/checkout-reviews')"));
console.log('ALL PASS');
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `node C:/Users/tairo/AppData/Local/Temp/claude/Z--/1a698e2c-c5d4-4394-a364-42b928382219/scratchpad/test-client-period-days.js`
Expected: `AssertionError` on `r.cd.rawCheckOut` (`undefined !== '17:40'`).

- [ ] **Step 3: Global** (~1440)

Find:

```js
let DATA_LEAVES = [];
let DATA_ANNOUNCEMENTS = [];
```

Replace with:

```js
let DATA_LEAVES = [];
// 2026-09-23: Accounting/MD reviews of web check-outs at/after the Late Night time, keyed
// "<userId>_<YYYY-MM-DD>" (same format as attKey). GET /api/checkout-reviews is scoped server-side:
// md/accounting/manager get all, everyone else only their own.
let DATA_CHECKOUT_REVIEWS = {};
let DATA_ANNOUNCEMENTS = [];
```

- [ ] **Step 4: Loader + re-render helper** (right after `loadLeavesFromBackend`, ~4595)

Find:

```js
    console.log('[APP] Loaded', DATA_LEAVES.length, 'leaves from backend');
    return true;
  } catch(e) {
    console.error('[APP] loadLeavesFromBackend error:', e.message);
    return false;
  }
}
```

Replace with:

```js
    console.log('[APP] Loaded', DATA_LEAVES.length, 'leaves from backend');
    return true;
  } catch(e) {
    console.error('[APP] loadLeavesFromBackend error:', e.message);
    return false;
  }
}

// On failure the previous map is kept (initially {} = nothing allowed), so the browser never shows
// a web check-out as paid that the server has not confirmed. The server engine is authoritative.
async function loadCheckoutReviewsFromBackend() {
  try {
    const res = await apiFetch('/api/checkout-reviews');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    if (!data || !data.success || !data.reviews || typeof data.reviews !== 'object' || Array.isArray(data.reviews)) {
      throw new Error('bad payload');
    }
    DATA_CHECKOUT_REVIEWS = data.reviews;
    return true;
  } catch(e) {
    console.error('[APP] loadCheckoutReviewsFromBackend error:', e.message);
    return false;
  }
}

function rerenderAfterCheckoutReviews() {
  updateApprovalBadge();
  renderDashboard();
  if (currentPage === 'attendance') renderAttendanceTable();
  if (currentPage === 'approval') renderApprovals();
  if (currentPage === 'payslip') renderPayslip();
  if (currentPage === 'reports') renderReports();
}
```

- [ ] **Step 5: `generatePeriodDays` keeps the scanned time** (~4426)

Find:

```js
    // Overlay approved DATA_LEAVES so approvals always appear regardless of attendanceLog state.
```

Replace with:

```js
    // 2026-09-23: the scanned check-out before any time-correction overlay -- shown to reviewers
    // as "21:00 (corrected from 17:40)". Dual-sync twin in server.js.
    const rawCheckOut = checkOut;

    // Overlay approved DATA_LEAVES so approvals always appear regardless of attendanceLog state.
```

- [ ] **Step 6: `generatePeriodDays` sets `checkOutReview` after the overlay** (~4539)

Find:

```js
    const holidayName = DATA_HOLIDAYS.find(h => h.date === dateStr)?.name || null;
    days.push({ date: dateStr, dayName: dayNamesEn[d.getDay()], isWeekend, isPubHoliday, isFuture, isToday, status, checkIn, checkOut, earlyIn, lateOut, upcountry, longDistance, longDistanceKm, longDistanceAllowance, checkInSource, checkOutSource, earlyApproved, lateApproved, checkInGPS, checkOutGPS, holidayName, firstScanAfterCutoff, partialLeave });
```

Replace with:

```js
    const holidayName = DATA_HOLIDAYS.find(h => h.date === dateStr)?.name || null;
    // 2026-09-23: after the overlay, so a review counts only for the effective (corrected) web
    // check-out it was made on. Dual-sync twin in server.js.
    const checkOutReview = uid ? checkoutReviewDecisionFor(DATA_CHECKOUT_REVIEWS[attKey(uid, dateStr)], checkOut, checkOutSource) : null;
    days.push({ date: dateStr, dayName: dayNamesEn[d.getDay()], isWeekend, isPubHoliday, isFuture, isToday, status, checkIn, checkOut, earlyIn, lateOut, upcountry, longDistance, longDistanceKm, longDistanceAllowance, checkInSource, checkOutSource, earlyApproved, lateApproved, checkInGPS, checkOutGPS, holidayName, firstScanAfterCutoff, partialLeave, checkOutReview, rawCheckOut });
```

- [ ] **Step 7: Load at startup** (`initApp`, ~5160)

Find:

```js
    if (currentPage === 'leave-summary') renderLeaveSummary();
    initNotificationPolling();
  });
```

Replace with:

```js
    if (currentPage === 'leave-summary') renderLeaveSummary();
    initNotificationPolling();
  });
  loadCheckoutReviewsFromBackend().then(ok => { if (ok) rerenderAfterCheckoutReviews(); });
```

- [ ] **Step 8: Re-fetch on the WS message** (~16779)

Find:

```js
      if (data.type === 'USER_CREATED') {
        // SECURITY FIX 2026-08-04: the backend now broadcasts a stripped public projection (no
```

Replace with:

```js
      if (data.type === 'CHECKOUT_REVIEWS_UPDATED') {
        // Payload-less by design: re-fetch through the role-scoped GET so an employee's socket
        // never carries anyone else's review.
        loadCheckoutReviewsFromBackend().then(ok => { if (ok) rerenderAfterCheckoutReviews(); });
      }
      if (data.type === 'USER_CREATED') {
        // SECURITY FIX 2026-08-04: the backend now broadcasts a stripped public projection (no
```

- [ ] **Step 9: Run the test and confirm it passes**

Run: `node C:/Users/tairo/AppData/Local/Temp/claude/Z--/1a698e2c-c5d4-4394-a364-42b928382219/scratchpad/test-client-period-days.js`
Expected: `ALL PASS`. Re-run the Task 1 test → `ALL PASS` (the block is untouched).

- [ ] **Step 10: Confirm the pay-gate sites need no edit**

Run from `Z:\Time_Attendance`: `node -e "const s=require('fs').readFileSync('attendance/js/app.js','utf8');console.log((s.match(/deviceScanQualifiesForLateNight\(/g)||[]).length)"`
Expected: `9` (1 definition + 8 call sites: table badge ~7131, printed table ~7324, dashboard ~7499/~7939, reports ~9491/~9990/~10046, computePayroll ~10304). If the number differs, grep the calls and confirm that each one passes a `generatePeriodDays` row. None of them should re-derive the source itself.

- [ ] **Step 11: Lint + syntax check.** Expected: clean.

---

## Task 6: Client Late Night submit gate, modal, holiday-work bundle, after-midnight thresholds

**Files:**
- Modify: `app.js` `canSubmitLateNightForDate` (~13324), `lateNightSubmitBlockedMessage` (~13363), `refreshLateOutGate` (~13419), `selectLateOutTime` (~13520), `refreshHolidayWorkLateNightBundle` (~13998–14006), `selectHwLateOutTime` (~14050)
- Create: `SCRATCH\test-client-lateout-gate.js`

**Interfaces:**
- Consumes: `generatePeriodDays(start, end, isCurrent, userId)`, `lateNightCheckoutOk`, `lateNightCheckoutMins`, `lateOutThresholdHour(tier)`, `payPeriodBlockedForDate`, `isApprovedFullDayPersonalLeaveDate`
- Produces: `canSubmitLateNightForDate(dateStr, userId, opts) → { ok, reason?, row?, thr1? }` with the new reasons `'web-pending'` and `'web-denied'` (both include `row`). `'web'` is removed. `lateNightSubmitBlockedMessage` gets texts for both new reasons.

- [ ] **Step 1: Write the failing test** `SCRATCH\test-client-lateout-gate.js`

```js
'use strict';
const assert = require('assert');
const { CLIENT, readSrc, extractFunction, dualSyncBlock, load } = require('./extract-fn.js');

const csrc = readSrc(CLIENT);
const code = [dualSyncBlock(csrc), extractFunction(csrc, 'localDateStr'), extractFunction(csrc, 'generatePeriodDays'),
  extractFunction(csrc, 'lateOutThresholdHour'), extractFunction(csrc, 'canSubmitLateNightForDate')].join('\n');
const D = '2026-09-10';
const user = { id: 7, role: 'user', name: 'Staff' };
const S = { workSchedule: { standardStartHour: 8, standardStartMinute: 30 }, allowances: { lateNightThreshold1Hour: 19, lateNightThreshold2Hour: 20 }, allowanceEligibility: {} };
const st = { attendanceLog: {}, DATA_LEAVES: [], DATA_CHECKOUT_REVIEWS: {} };
const ctx = {
  attendanceLog: st.attendanceLog, DATA_LEAVES: st.DATA_LEAVES, DATA_CHECKOUT_REVIEWS: st.DATA_CHECKOUT_REVIEWS,
  attKey: (u, d) => `${u}_${d}`, APP_SETTINGS: S, DATA_USERS: [user], DATA_HOLIDAYS: [], currentUser: user,
  bangkokTodayDate: () => new Date(2026, 8, 23), businessDateStr: () => '2026-09-23',
  isPublicHoliday: () => false, isCompanyTripDay: () => false, leaveDayCoverage: () => 'none', lateReferenceMin: (r, s) => s,
  payPeriodBlockedForDate: () => ({ blocked: false }), isApprovedFullDayPersonalLeaveDate: () => false,
  editingLeaveId: null, isHolidayWorkDay: () => false, hasHolidayWorkClaimOnDate: () => false,
};
const h = load(code, ctx, Object.keys(ctx), ['canSubmitLateNightForDate', 'lateNightCheckoutMins']);
const set = (checkOut, source, reviews) => {
  st.attendanceLog[`7_${D}`] = { checkIn: '08:10', checkInSource: 'device', checkOut, checkOutSource: source, status: 'present' };
  Object.keys(st.DATA_CHECKOUT_REVIEWS).forEach(k => delete st.DATA_CHECKOUT_REVIEWS[k]);
  Object.assign(st.DATA_CHECKOUT_REVIEWS, reviews || {});
};
const gate = () => h.canSubmitLateNightForDate(D, 7);

set('21:00', 'web');                                                   assert.strictEqual(gate().reason, 'web-pending');
set('21:00', 'web', { [`7_${D}`]: { decision: 'deny', checkOut: '21:00' } });  assert.strictEqual(gate().reason, 'web-denied');
set('21:00', 'web', { [`7_${D}`]: { decision: 'allow', checkOut: '20:30' } }); assert.strictEqual(gate().reason, 'web-pending', 'stale allow');
set('21:00', 'web', { [`7_${D}`]: { decision: 'allow', checkOut: '21:00' } });
let g = gate(); assert.strictEqual(g.ok, true, 'web+allow ok'); assert.strictEqual(g.row.checkOutReview, 'allow');
set('00:30', 'device'); g = gate();
assert.strictEqual(g.ok, true, 'device 00:30 ok');
assert.ok(h.lateNightCheckoutMins(g.row.checkOut) >= 20 * 60, '00:30 unlocks the 20:00 tier button');
set('18:30', 'web'); assert.strictEqual(gate().reason, 'too-early', 'web before thr1 is simply too early');
set('21:00', 'device'); assert.strictEqual(gate().ok, true, 'device ok');
st.DATA_LEAVES.push({ id: 5, userId: 7, type: 'late-out', status: 'pending-md', dateFrom: D, dateTo: D, lateOutTime: '20:00' });
assert.strictEqual(gate().reason, 'duplicate'); st.DATA_LEAVES.length = 0;
delete st.attendanceLog[`7_${D}`]; assert.strictEqual(gate().reason, 'no-checkin');

// the other sites use the after-midnight helper
['refreshLateOutGate', 'selectLateOutTime', 'refreshHolidayWorkLateNightBundle', 'selectHwLateOutTime'].forEach(fn =>
  assert.ok(extractFunction(csrc, fn).includes('lateNightCheckoutMins('), fn + ' uses lateNightCheckoutMins'));
assert.ok(extractFunction(csrc, 'refreshLateOutGate').includes('lateNightCheckoutOk(gate.row)'), 'refreshLateOutGate deviceOk');
const msg = extractFunction(csrc, 'lateNightSubmitBlockedMessage');
assert.ok(msg.includes("result.reason === 'web-pending'") && msg.includes("result.reason === 'web-denied'"), 'messages');
console.log('ALL PASS');
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `node C:/Users/tairo/AppData/Local/Temp/claude/Z--/1a698e2c-c5d4-4394-a364-42b928382219/scratchpad/test-client-lateout-gate.js`
Expected: `ReferenceError: attendanceTimesForDate is not defined`. The current function reads `attendanceTimesForDate`, which the test deliberately does not stub, because the new version must get everything from the `generatePeriodDays` row.

- [ ] **Step 3: Rewrite `canSubmitLateNightForDate`** (~13324)

Find the whole current function:

```js
function canSubmitLateNightForDate(dateStr, userId, opts) {
  const uid = userId || (currentUser && currentUser.id);
  if (!uid || !dateStr) return { ok: false, reason: 'missing' };
  const user = DATA_USERS.find(u => u.id === uid) || currentUser;
  if (!user) return { ok: false, reason: 'missing' };
  if (!isAllowanceEligible(APP_SETTINGS.allowanceEligibility, user.role, 'earlyLate')) {
    return { ok: false, reason: 'ineligible' };
  }
  const pp = payPeriodBlockedForDate(dateStr, uid);
  if (pp.blocked) return { ok: false, reason: pp.reason };
  const times = attendanceTimesForDate(dateStr, uid);
  if (!times.checkIn) return { ok: false, reason: 'no-checkin' };
  if (!times.checkOut) return { ok: false, reason: 'no-checkout' };
  if (!isDeviceScanSource(times.checkOutSource)) {
    return { ok: false, reason: times.checkOutSource === 'web' ? 'web' : 'no-checkout' };
  }
  const checkOutMins = parseHHMMToMins(times.checkOut);
  const thr1 = lateOutThresholdHour(1);
  if (!Number.isFinite(checkOutMins) || checkOutMins < thr1 * 60) {
    return { ok: false, reason: 'too-early', thr1 };
  }
  const dup = DATA_LEAVES.some(l =>
    l.userId === uid && l.type === 'late-out' && l.dateFrom === dateStr && l.status !== 'rejected' &&
    l.id !== editingLeaveId
  );
  if (dup) return { ok: false, reason: 'duplicate' };
  if (isApprovedFullDayPersonalLeaveDate(dateStr, uid)) {
    return { ok: false, reason: 'full-leave' };
  }
  if (!(opts && opts.ignoreHolidayWork) && isHolidayWorkDay(dateStr) && !hasHolidayWorkClaimOnDate(dateStr, uid, false)) {
    return { ok: false, reason: 'need-holiday-work' };
  }
  const d = new Date(dateStr + 'T12:00:00');
  const days = generatePeriodDays(d, d, false, uid);
  const base = days[0] || { date: dateStr };
  const row = { ...base, checkOut: times.checkOut, checkOutSource: times.checkOutSource, checkIn: times.checkIn, checkInSource: times.checkInSource };
  return { ok: true, row, thr1 };
}
```

Replace with:

```js
// 2026-09-23 (web check-out review): reads ONE generatePeriodDays() row -- the same source payroll
// uses -- so the corrected check-out, its source and the Accounting/MD review always agree with
// what will be paid. Full-day leave is checked first because that overlay clears the times.
// A check-out before 05:00 is after midnight on the same business day (lateNightCheckoutMins).
function canSubmitLateNightForDate(dateStr, userId, opts) {
  const uid = userId || (currentUser && currentUser.id);
  if (!uid || !dateStr) return { ok: false, reason: 'missing' };
  const user = DATA_USERS.find(u => u.id === uid) || currentUser;
  if (!user) return { ok: false, reason: 'missing' };
  if (!isAllowanceEligible(APP_SETTINGS.allowanceEligibility, user.role, 'earlyLate')) {
    return { ok: false, reason: 'ineligible' };
  }
  const pp = payPeriodBlockedForDate(dateStr, uid);
  if (pp.blocked) return { ok: false, reason: pp.reason };
  if (isApprovedFullDayPersonalLeaveDate(dateStr, uid)) {
    return { ok: false, reason: 'full-leave' };
  }
  const d = new Date(dateStr + 'T12:00:00');
  const row = generatePeriodDays(d, d, false, uid)[0] || { date: dateStr };
  if (!row.checkIn) return { ok: false, reason: 'no-checkin' };
  if (!row.checkOut) return { ok: false, reason: 'no-checkout' };
  const thr1 = lateOutThresholdHour(1);
  const checkOutMins = lateNightCheckoutMins(row.checkOut);
  if (!Number.isFinite(checkOutMins) || checkOutMins < thr1 * 60) {
    return { ok: false, reason: 'too-early', thr1 };
  }
  if (!lateNightCheckoutOk(row)) {
    if (row.checkOutSource === 'web') {
      return { ok: false, reason: row.checkOutReview === 'deny' ? 'web-denied' : 'web-pending', row, thr1 };
    }
    return { ok: false, reason: 'no-checkout' };
  }
  const dup = DATA_LEAVES.some(l =>
    l.userId === uid && l.type === 'late-out' && l.dateFrom === dateStr && l.status !== 'rejected' &&
    l.id !== editingLeaveId
  );
  if (dup) return { ok: false, reason: 'duplicate' };
  if (!(opts && opts.ignoreHolidayWork) && isHolidayWorkDay(dateStr) && !hasHolidayWorkClaimOnDate(dateStr, uid, false)) {
    return { ok: false, reason: 'need-holiday-work' };
  }
  return { ok: true, row, thr1 };
}
```

- [ ] **Step 4: Messages** (`lateNightSubmitBlockedMessage`, ~13383 and ~13392)

Find:

```js
  if (result.reason === 'web') {
    return currentLang === 'ja'
      ? '深夜退勤は顔認証端末での退勤が必要です（Webアプリの退勤では申請できません）'
      : L('Late Night Out requires check-out at the face scanner, not the web app',
          'แจ้งกลับดึกได้เฉพาะเมื่อสแกนออกที่เครื่อง ไม่ใช่ปุ่ม Check Out บนเว็บ');
  }
```

Replace with:

```js
  if (result.reason === 'web-pending') {
    return L('This web check-out is waiting for Accounting/MD review — 🌙 can be submitted after it is allowed',
      'เช็กเอาท์ผ่านเว็บนี้รอบัญชี/MD ตรวจสอบ — ยื่น 🌙 ได้หลังได้รับอนุญาต');
  }
  if (result.reason === 'web-denied') {
    return L('Accounting/MD did not allow this web check-out — 🌙 cannot be claimed',
      'บัญชี/MD ไม่อนุญาตเวลาเช็กเอาท์ผ่านเว็บนี้ — ยื่น 🌙 ไม่ได้');
  }
```

Find:

```js
  if (result.reason === 'too-early') {
    return currentLang === 'ja'
      ? `顔認証端末で${t}以降に退勤してから申請してください`
      : L(`Scan out at the face terminal at or after ${t} before submitting`,
          `ต้องสแกนออกที่เครื่องตั้งแต่ ${t} ขึ้นไป ถึงจะแจ้งกลับดึกได้`);
  }
```

Replace with (the gate now also covers web check-outs; JA stays inline, as before):

```js
  if (result.reason === 'too-early') {
    return currentLang === 'ja'
      ? `${t}以降に退勤してから申請してください`
      : L(`Check out at or after ${t} before submitting`,
          `ต้องเช็กเอาท์ตั้งแต่ ${t} ขึ้นไป ถึงจะแจ้งกลับดึกได้`);
  }
```

- [ ] **Step 5: `refreshLateOutGate`** (~13421)

Find:

```js
  const gate = canSubmitLateNightForDate(targetDate);
  const checkOutStr = gate.row?.checkOut || '';
  let checkOutMins = 0;
  if (checkOutStr) {
    const [h, m] = checkOutStr.split(':').map(Number);
    checkOutMins = h * 60 + m;
  }
  const deviceOk = isDeviceScanSource(gate.row?.checkOutSource);
```

Replace with:

```js
  const gate = canSubmitLateNightForDate(targetDate);
  const checkOutStr = gate.row?.checkOut || '';
  const checkOutMins = checkOutStr ? (lateNightCheckoutMins(checkOutStr) || 0) : 0;
  const deviceOk = !!gate.row && lateNightCheckoutOk(gate.row);
```

Find:

```js
    if (gate.reason === 'web' || gate.reason === 'no-checkout' || gate.reason === 'missing') {
```

Replace with:

```js
    if (gate.reason === 'web-pending' || gate.reason === 'web-denied' || gate.reason === 'no-checkout' || gate.reason === 'missing') {
```

- [ ] **Step 6: `selectLateOutTime`** (~13524)

Find:

```js
  const gate = canSubmitLateNightForDate(targetDate);
  const checkOutStr = gate.row?.checkOut || '';
  let checkOutMins = 0;
  if (checkOutStr) {
    const [h, m] = checkOutStr.split(':').map(Number);
    checkOutMins = h * 60 + m;
  }
  if (!skipGate && !gate.ok) {
```

Replace with:

```js
  const gate = canSubmitLateNightForDate(targetDate);
  const checkOutStr = gate.row?.checkOut || '';
  const checkOutMins = checkOutStr ? (lateNightCheckoutMins(checkOutStr) || 0) : 0;
  if (!skipGate && !gate.ok) {
```

- [ ] **Step 7: Holiday-work 🌙 bundle** (`refreshHolidayWorkLateNightBundle`, ~14000)

Find:

```js
  wrap.style.display = '';
  const checkOutStr = gate.row?.checkOut || '';
  let checkOutMins = 0;
  if (checkOutStr) {
    const [h, m] = checkOutStr.split(':').map(Number);
    checkOutMins = h * 60 + m;
  }
```

Replace with:

```js
  wrap.style.display = '';
  const checkOutStr = gate.row?.checkOut || '';
  const checkOutMins = checkOutStr ? (lateNightCheckoutMins(checkOutStr) || 0) : 0;
```

(The following `const can19 = checkOutMins >= thr1 * 60;` / `can20` lines stay unchanged. They now see 1470 for "00:30".)

- [ ] **Step 8: `selectHwLateOutTime`** (~14053)

Find:

```js
  const [h, m] = (checkOutStr || '0:0').split(':').map(Number);
  const checkOutMins = h * 60 + m;
  if (!gate.ok || checkOutMins < hour * 60) return;
```

Replace with:

```js
  const checkOutMins = checkOutStr ? (lateNightCheckoutMins(checkOutStr) || 0) : 0;
  if (!gate.ok || checkOutMins < hour * 60) return;
```

- [ ] **Step 9: Run the test and confirm it passes**

Run: `node C:/Users/tairo/AppData/Local/Temp/claude/Z--/1a698e2c-c5d4-4394-a364-42b928382219/scratchpad/test-client-lateout-gate.js`
Expected: `ALL PASS`. Re-run the Task 1 and Task 5 tests → `ALL PASS`.

- [ ] **Step 10: Confirm no stale `'web'` reason remains**

Run from `Z:\Time_Attendance`: `node -e "const s=require('fs').readFileSync('attendance/js/app.js','utf8');console.log(/reason === 'web'[^-]/.test(s), /reason: 'web'[^-]/.test(s))"`
Expected: `false false`

- [ ] **Step 11: Lint + syntax check.** Expected: clean.

---

## Task 7: Client attendance row, employee status, detail modal, printed table, deny confirm

**Files:**
- Modify: `app.js` — new helpers after `attAllowIcon` (~6715); `renderAttendanceTable` check-out cells (~7178, ~7211, ~7253); `showAttendanceDetail` (~15090, ~15278, ~15287)
- Create: `SCRATCH\test-client-review-row.js`

**Interfaces:**
- Consumes: `checkoutReviewTrigger`, `isMdAccountingView()`, `payPeriodBlockedForDate`, `blockIfObserver()`, `apiFetch`, `attKey`, `escapeHtml`, `escapeJsAttr`, `showToast`, `rerenderAfterCheckoutReviews` (Task 5)
- Produces:
  - `canReviewCheckoutFor(targetUser) → boolean` — md/accounting view (superadmin via `isMdAccountingView`, unchanged), not an observer, not one's own row
  - `buildCheckoutReviewHtml(row, targetUser, withButtons) → string` (`''` when the day is not a trigger)
  - `async setCheckoutReview(userId, dateStr, decision)` — `decision` is `'allow' | 'deny' | null`

- [ ] **Step 1: Write the failing test** `SCRATCH\test-client-review-row.js`

```js
'use strict';
const assert = require('assert');
const { CLIENT, readSrc, extractFunction, dualSyncBlock, load } = require('./extract-fn.js');

const csrc = readSrc(CLIENT);
const code = [dualSyncBlock(csrc), extractFunction(csrc, 'escapeHtml'), extractFunction(csrc, 'escapeJsAttr'),
  extractFunction(csrc, 'canReviewCheckoutFor'), extractFunction(csrc, 'buildCheckoutReviewHtml')].join('\n');
const S = { allowances: { lateNightThreshold1Hour: 19 }, allowanceEligibility: {} };
const staff = { id: 7, role: 'user', name: 'Staff' };
const acct = { id: 2, role: 'accounting', name: 'Acct' };
const row = over => Object.assign({ date: '2026-09-10', status: 'present', isFuture: false, checkIn: '08:10',
  checkOut: '21:00', rawCheckOut: '17:40', checkOutSource: 'web', checkOutReview: null }, over);
function mk({ me, mdAcct = true, blocked = false, leaves = [] }) {
  const ctx = { L: en => en, currentUser: me, isMdAccountingView: () => mdAcct,
    payPeriodBlockedForDate: () => ({ blocked }), DATA_LEAVES: leaves, APP_SETTINGS: S };
  return load(code, ctx, Object.keys(ctx), ['buildCheckoutReviewHtml', 'canReviewCheckoutFor']);
}

let h = mk({ me: acct });
let html = h.buildCheckoutReviewHtml(row({}), staff, true);
assert.ok(html.includes('⚠️ Review (web)'), 'reviewer pending chip');
assert.ok(html.includes("setCheckoutReview(7, '2026-09-10', 'allow')") && html.includes("setCheckoutReview(7, '2026-09-10', 'deny')"), 'allow/deny buttons');
assert.ok(html.includes('corrected from') && html.includes('17:40'), 'raw time shown');
html = h.buildCheckoutReviewHtml(row({ checkOutReview: 'allow' }), staff, true);
assert.ok(html.includes('✅ Allowed') && html.includes("setCheckoutReview(7, '2026-09-10', null)"), 'allowed + undo');
html = h.buildCheckoutReviewHtml(row({ checkOutReview: 'deny' }), staff, true);
assert.ok(html.includes('❌ Not allowed') && html.includes('null)'), 'denied + undo');
assert.ok(!h.buildCheckoutReviewHtml(row({}), staff, false).includes('setCheckoutReview('), 'withButtons=false: no buttons');
assert.strictEqual(h.buildCheckoutReviewHtml(row({ checkOutSource: 'device' }), staff, true), '', 'non-trigger: nothing');

h = mk({ me: acct, blocked: true });
assert.ok(!h.buildCheckoutReviewHtml(row({}), staff, true).includes('setCheckoutReview('), 'locked/confirmed/MD-approved: no buttons');
h = mk({ me: Object.assign({}, acct, { isObserver: true }) });
assert.ok(!h.buildCheckoutReviewHtml(row({}), staff, true).includes('setCheckoutReview('), 'observer: no buttons');
h = mk({ me: { id: 3, role: 'manager' }, mdAcct: false });
html = h.buildCheckoutReviewHtml(row({}), staff, true);
assert.ok(html.includes('⚠️ Review (web)') && !html.includes('setCheckoutReview('), 'manager: status only');

// employee (own row)
h = mk({ me: staff });
assert.ok(h.buildCheckoutReviewHtml(row({}), staff, true).includes('⏳ Awaiting Accounting review'));
assert.ok(h.buildCheckoutReviewHtml(row({ checkOutReview: 'allow' }), staff, true).includes('✅ Reviewed — you can submit 🌙'));
html = h.buildCheckoutReviewHtml(row({ checkOutReview: 'deny' }), staff, true);
assert.ok(html.includes('❌ Not allowed') && !html.includes('🌙 not paid'), 'denied, no 🌙');
h = mk({ me: staff, leaves: [{ userId: 7, type: 'late-out', dateFrom: '2026-09-10', status: 'approved' }] });
assert.ok(h.buildCheckoutReviewHtml(row({ checkOutReview: 'deny' }), staff, true).includes('🌙 not paid — check-out not allowed'), 'denied with 🌙');
assert.ok(!h.buildCheckoutReviewHtml(row({}), staff, true).includes('setCheckoutReview('), 'employee never gets buttons');
assert.strictEqual(mk({ me: acct }).canReviewCheckoutFor(acct), false, 'never own record');

// wiring
const sr = extractFunction(csrc, 'setCheckoutReview');
assert.ok(sr.includes('if (blockIfObserver()) return;'), 'blockIfObserver on click');
assert.ok(sr.includes('confirm('), 'deny with existing 🌙 asks first');
const rat = extractFunction(csrc, 'renderAttendanceTable');
assert.strictEqual((rat.match(/\$\{checkoutReviewHtml\}/g) || []).length, 2, 'table row + mobile card');
const det = extractFunction(csrc, 'showAttendanceDetail');
assert.ok(det.includes('lateNightCheckoutOk(row)') && det.includes('buildCheckoutReviewHtml(row, targetUserObj, false)'), 'detail modal');
assert.ok(extractFunction(csrc, 'buildAttendancePrintView').includes('deviceScanQualifiesForLateNight(row'), 'printed table uses the shared pay gate');
console.log('ALL PASS');
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `node C:/Users/tairo/AppData/Local/Temp/claude/Z--/1a698e2c-c5d4-4394-a364-42b928382219/scratchpad/test-client-review-row.js`
Expected: `Error: function canReviewCheckoutFor not found`.

- [ ] **Step 3: Add the helpers** (after `attAllowIcon`, ~6715)

Find:

```js
function attAllowIcon(emoji, title) {
  return `<span class="att-allow-icon" title="${escapeHtml(title)}">${emoji}</span>`;
}
```

Replace with:

```js
function attAllowIcon(emoji, title) {
  return `<span class="att-allow-icon" title="${escapeHtml(title)}">${emoji}</span>`;
}

// ===== WEB CHECK-OUT LATE NIGHT REVIEW (2026-09-23) =====
// Buttons only for an MD/Accounting view of SOMEONE ELSE's record, never for observers.
// The server enforces the same rules (requireRole + self check).
function canReviewCheckoutFor(targetUser) {
  if (!currentUser || !targetUser || currentUser.isObserver) return false;
  if (Number(targetUser.id) === Number(currentUser.id)) return false;
  return isMdAccountingView();
}

// Status chip (+ buttons) under a trigger day's check-out. Employee on their own row: pending /
// allowed / not allowed (+ "🌙 not paid" if a 🌙 exists). Anyone else: reviewer wording; buttons
// only when canReviewCheckoutFor() and the pay period is still open.
function buildCheckoutReviewHtml(row, targetUser, withButtons) {
  if (!row || !targetUser || !checkoutReviewTrigger(row, targetUser, APP_SETTINGS)) return '';
  const decision = row.checkOutReview;
  const chip = (bg, fg, text) => `<span class="badge" style="display:inline-block;margin-top:3px;background:${bg};color:${fg};font-size:10px">${escapeHtml(text)}</span>`;
  const isSelf = !!currentUser && Number(targetUser.id) === Number(currentUser.id);
  if (isSelf) {
    if (decision === 'allow') {
      return `<div class="checkout-review">${chip('#dcfce7', '#166534', L('✅ Reviewed — you can submit 🌙', '✅ ตรวจแล้ว ยื่น 🌙 ได้'))}</div>`;
    }
    if (decision === 'deny') {
      const hasLateOut = DATA_LEAVES.some(l => l.userId === targetUser.id && l.type === 'late-out' && l.dateFrom === row.date && l.status !== 'rejected');
      const notPaid = hasLateOut
        ? `<div style="font-size:10px;color:#991b1b;margin-top:2px">${escapeHtml(L('🌙 not paid — check-out not allowed', '🌙 ไม่จ่าย — เวลาออกไม่ได้รับอนุญาต'))}</div>`
        : '';
      return `<div class="checkout-review">${chip('#fee2e2', '#991b1b', L('❌ Not allowed', '❌ ไม่อนุญาต'))}${notPaid}</div>`;
    }
    return `<div class="checkout-review">${chip('#fef3c7', '#92400e', L('⏳ Awaiting Accounting review', '⏳ รอบัญชีตรวจสอบ'))}</div>`;
  }
  const rawNote = (row.rawCheckOut && row.rawCheckOut !== row.checkOut)
    ? `<div style="font-size:10px;color:#64748b;margin-top:2px">${escapeHtml(L('corrected from', 'แก้จาก'))} ${escapeHtml(row.rawCheckOut)}</div>`
    : '';
  let html = decision === 'allow' ? chip('#dcfce7', '#166534', L('✅ Allowed', '✅ อนุญาตแล้ว'))
    : decision === 'deny' ? chip('#fee2e2', '#991b1b', L('❌ Not allowed', '❌ ไม่อนุญาต'))
    : chip('#fef3c7', '#92400e', L('⚠️ Review (web)', '⚠️ ตรวจสอบ (เว็บ)'));
  if (withButtons && canReviewCheckoutFor(targetUser) && !payPeriodBlockedForDate(row.date, targetUser.id).blocked) {
    const uid = Number(targetUser.id);
    const d = escapeJsAttr(row.date);
    const btn = (color, title, arg, label) => `<button class="btn btn-ghost btn-sm" style="color:${color};padding:0 4px;margin-left:2px" title="${escapeHtml(title)}" onclick="setCheckoutReview(${uid}, '${d}', ${arg})">${label}</button>`;
    html += decision
      ? btn('#64748b', L('Undo review', 'ยกเลิกผลตรวจสอบ'), 'null', '↩️')
      : btn('#059669', L('Allow this web check-out (unlocks 🌙)', 'อนุญาตเวลาออกผ่านเว็บนี้ (ปลดล็อก 🌙)'), "'allow'", '✅') +
        btn('#dc2626', L('Do not allow this web check-out', 'ไม่อนุญาตเวลาออกผ่านเว็บนี้'), "'deny'", '❌');
  }
  return `<div class="checkout-review">${html}${rawNote}</div>`;
}

async function setCheckoutReview(userId, dateStr, decision) {
  if (blockIfObserver()) return;
  const uid = Number(userId);
  if (!currentUser || uid === Number(currentUser.id) || !isMdAccountingView()) return;
  if (decision === 'deny') {
    const hasLateOut = DATA_LEAVES.some(l => l.userId === uid && l.type === 'late-out' && l.dateFrom === dateStr && l.status !== 'rejected');
    if (hasLateOut && !confirm(L('This employee already has a 🌙 Late Night request for this day. Mark the check-out as not allowed anyway? The 🌙 will not be paid while it stays not allowed.',
      'พนักงานมีคำขอ 🌙 แจ้งกลับดึกของวันนี้อยู่แล้ว ยืนยันไม่อนุญาตเวลาออก? 🌙 จะไม่ถูกจ่ายตราบที่ยังไม่อนุญาต'))) return;
  }
  try {
    const res = await apiFetch('/api/checkout-reviews', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: uid, date: dateStr, decision }),
    });
    const data = await res.json();
    if (!res.ok || !data.success) throw new Error(data.message || ('HTTP ' + res.status));
    const key = attKey(uid, dateStr);
    if (decision === null) delete DATA_CHECKOUT_REVIEWS[key];
    else DATA_CHECKOUT_REVIEWS[key] = data.review;
    rerenderAfterCheckoutReviews();
    showToast(decision === 'allow' ? L('✅ Check-out allowed', '✅ อนุญาตเวลาออกแล้ว')
      : decision === 'deny' ? L('❌ Check-out marked as not allowed', '❌ บันทึกไม่อนุญาตเวลาออกแล้ว')
      : L('↩️ Review cleared', '↩️ ยกเลิกผลตรวจสอบแล้ว'), decision === 'deny' ? 'warning' : 'success');
  } catch(e) {
    showToast(L('❌ Could not save: ', '❌ ไม่สามารถบันทึกได้: ') + e.message, 'danger');
  }
}
```

- [ ] **Step 4: Compute the chip once per row** (`renderAttendanceTable`, ~7178)

Find:

```js
    const outSrc = row.checkOutSource === 'web'
      ? `<span class="log-source web"    style="font-size:10px;margin-left:4px" title="${L('Recorded via Web App','บันทึกผ่าน Web App')}">🌐</span>`
      : `<span class="log-source device" style="font-size:10px;margin-left:4px" title="${L('Face scanner device','สแกนหน้าอุปกรณ์')}">📷</span>`;
```

Replace with:

```js
    const outSrc = row.checkOutSource === 'web'
      ? `<span class="log-source web"    style="font-size:10px;margin-left:4px" title="${L('Recorded via Web App','บันทึกผ่าน Web App')}">🌐</span>`
      : `<span class="log-source device" style="font-size:10px;margin-left:4px" title="${L('Face scanner device','สแกนหน้าอุปกรณ์')}">📷</span>`;
    const checkoutReviewHtml = buildCheckoutReviewHtml(row, targetUser, true);
```

- [ ] **Step 5: Desktop row check-out cell** (~7211)

Find:

```js
          ? `<span class="time-chip out">⬇️ ${escapeHtml(row.checkOut)}</span>${outSrc}${gpsOutBtn}${buildReturnSubline(row)}`
          : (row.checkIn ? `<span style="color:#f59e0b;font-size:11px">⚠️ ${L('No check-out', 'ไม่มีข้อมูลออก')}</span>` : '<span style="color:#cbd5e1">—</span>'))
```

Replace with:

```js
          ? `<span class="time-chip out">⬇️ ${escapeHtml(row.checkOut)}</span>${outSrc}${gpsOutBtn}${buildReturnSubline(row)}${checkoutReviewHtml}`
          : (row.checkIn ? `<span style="color:#f59e0b;font-size:11px">⚠️ ${L('No check-out', 'ไม่มีข้อมูลออก')}</span>` : '<span style="color:#cbd5e1">—</span>'))
```

- [ ] **Step 6: Mobile card check-out** (~7253)

Find:

```js
                ? `<span class="time-chip out">⬇️ ${escapeHtml(row.checkOut)}</span>${outSrc}${gpsOutBtn}${buildReturnSubline(row)}`
                : '<span style="color:#cbd5e1;font-size:12px">—</span>')}
```

Replace with:

```js
                ? `<span class="time-chip out">⬇️ ${escapeHtml(row.checkOut)}</span>${outSrc}${gpsOutBtn}${buildReturnSubline(row)}${checkoutReviewHtml}`
                : '<span style="color:#cbd5e1;font-size:12px">—</span>')}
```

- [ ] **Step 7: Detail modal — target user object** (~15090)

Find:

```js
  const targetRole = (canViewOthers ? (DATA_USERS.find(u => u.id === targetUserId) || currentUser) : currentUser).role;
```

Replace with:

```js
  const targetUserObj = canViewOthers ? (DATA_USERS.find(u => u.id === targetUserId) || currentUser) : currentUser;
  const targetRole = targetUserObj.role;
```

- [ ] **Step 8: Detail modal — 🌙 tag uses the shared rule** (~15278)

Find:

```js
  if (row.lateOut && row.status !== 'company-trip' && isAllowanceEligible(APP_SETTINGS.allowanceEligibility, targetRole, 'earlyLate')
      && isDeviceScanSource(row.checkOutSource)
```

Replace with:

```js
  if (row.lateOut && row.status !== 'company-trip' && isAllowanceEligible(APP_SETTINGS.allowanceEligibility, targetRole, 'earlyLate')
      && lateNightCheckoutOk(row)
```

- [ ] **Step 9: Detail modal — review status tag** (~15287)

Find:

```js
  if (row.upcountry && row.status !== 'company-trip' && isAllowanceEligible(APP_SETTINGS.allowanceEligibility, targetRole, 'upcountry')) {
```

Replace with:

```js
  const _crTag = buildCheckoutReviewHtml(row, targetUserObj, false);
  if (_crTag) tagsEl.innerHTML += _crTag;
  if (row.upcountry && row.status !== 'company-trip' && isAllowanceEligible(APP_SETTINGS.allowanceEligibility, targetRole, 'upcountry')) {
```

(Printed table ~7324 and the table 🌙 badge ~7131 call `deviceScanQualifiesForLateNight` on the `generatePeriodDays` row, so they already follow the review and need no code change. The test asserts this.)

- [ ] **Step 10: Run the test and confirm it passes**

Run: `node C:/Users/tairo/AppData/Local/Temp/claude/Z--/1a698e2c-c5d4-4394-a364-42b928382219/scratchpad/test-client-review-row.js`
Expected: `ALL PASS`. Re-run the Task 1, 5 and 6 tests → `ALL PASS`.

- [ ] **Step 11: Lint + syntax check.** Expected: clean.

---

## Task 8: Client Approvals-page pending box

**Files:**
- Modify: `app.js` — new helpers before `function renderApprovals() {` (~11269); the summary-bar start inside `renderApprovals` (~11301)
- Create: `SCRATCH\test-client-review-pending.js`

**Interfaces:**
- Consumes: `checkoutReviewTrigger`, `generatePeriodDays`, `getPeriodBounds(index)`, `payPeriodBlockedForDate`, `isEmployeeRecord`, `isMdAccountingView`, `fmtDate`, `escapeHtml`, `escapeJsAttr`, `setCheckoutReview` (Task 7)
- Produces:
  - `checkoutReviewPendingItems() → Array<{ user, day }>` — current and previous period, other employees only, not yet reviewed, open periods only; `[]` for observers and non-MD/Accounting views
  - `checkoutReviewPendingBoxHtml(items) → string`
  - A box `#checkout-review-pending-box` at the top of `#approval-summary-bar`, shown only when items exist

The optional nav-badge count is **not** included. `updateApprovalBadge()` runs on every leave WS event, and scanning every employee × 2 periods there would add a full `generatePeriodDays` sweep to each event. The box on the Approvals page covers the requirement.

- [ ] **Step 1: Write the failing test** `SCRATCH\test-client-review-pending.js`

```js
'use strict';
const assert = require('assert');
const { CLIENT, readSrc, extractFunction, dualSyncBlock, load } = require('./extract-fn.js');

const csrc = readSrc(CLIENT);
const code = [dualSyncBlock(csrc), extractFunction(csrc, 'isEmployeeRecord'), extractFunction(csrc, 'escapeHtml'),
  extractFunction(csrc, 'escapeJsAttr'), extractFunction(csrc, 'checkoutReviewPendingItems'),
  extractFunction(csrc, 'checkoutReviewPendingBoxHtml')].join('\n');
const S = { allowances: { lateNightThreshold1Hour: 19 }, allowanceEligibility: {} };
const acct = { id: 2, role: 'accounting', name: 'Acct' };
const users = [acct, { id: 7, role: 'user', name: 'Staff <b>' }, { id: 8, role: 'user', name: 'Old', active: false },
  { id: 99, role: 'superadmin', name: 'sys', isSystemAccount: true }, { id: 9, role: 'driver', name: 'Drv' }];
const dayOf = over => Object.assign({ status: 'present', isFuture: false, checkIn: '08:10', checkOut: '21:00', rawCheckOut: '17:40', checkOutSource: 'web', checkOutReview: null }, over);
const DAYS = {
  2: [dayOf({ date: '2026-09-15' })],                                  // reviewer's own day -> excluded
  7: [dayOf({ date: '2026-09-10' }), dayOf({ date: '2026-09-11', checkOutReview: 'allow' }),
      dayOf({ date: '2026-09-12', checkOutSource: 'device' }), dayOf({ date: '2026-09-01' })],
  8: [dayOf({ date: '2026-09-10' })],                                  // inactive -> excluded
  9: [dayOf({ date: '2026-09-14', checkOut: '00:30' })],
};
function mk({ me = acct, mdAcct = true, blockedDates = [] } = {}) {
  const ctx = {
    L: en => en, currentUser: me, isMdAccountingView: () => mdAcct, DATA_USERS: users, APP_SETTINGS: S,
    getPeriodBounds: i => ({ start: new Date(2026, 8 - i, 21), end: new Date(2026, 9 - i, 20), isCurrent: i === 0 }),
    generatePeriodDays: (start, end, cur, uid) => (start.getMonth() === 8 ? (DAYS[uid] || []) : []),
    payPeriodBlockedForDate: d => ({ blocked: blockedDates.includes(d) }),
    fmtDate: d => d.toISOString().slice(0, 10),
  };
  return load(code, ctx, Object.keys(ctx), ['checkoutReviewPendingItems', 'checkoutReviewPendingBoxHtml']);
}
let h = mk();
let items = h.checkoutReviewPendingItems();
assert.deepStrictEqual(items.map(x => `${x.user.id}@${x.day.date}`), ['9@2026-09-14', '7@2026-09-10', '7@2026-09-01'], 'pending only, newest first');
const html = h.checkoutReviewPendingBoxHtml(items);
assert.ok(html.includes('Web check-outs awaiting review') && html.includes('(3)'));
assert.ok(html.includes('Staff &lt;b&gt;'), 'name escaped');
assert.ok(html.includes("setCheckoutReview(7, '2026-09-10', 'allow')") && html.includes("setCheckoutReview(7, '2026-09-10', 'deny')"));
assert.ok(html.includes('corrected from') && html.includes('17:40'), 'raw time');
assert.strictEqual(mk({ blockedDates: ['2026-09-01'] }).checkoutReviewPendingItems().length, 2, 'locked periods excluded');
assert.deepStrictEqual(mk({ me: Object.assign({}, acct, { isObserver: true }) }).checkoutReviewPendingItems(), [], 'observer: none');
assert.deepStrictEqual(mk({ me: { id: 3, role: 'manager' }, mdAcct: false }).checkoutReviewPendingItems(), [], 'manager: none');
const ra = extractFunction(csrc, 'renderApprovals');
assert.ok(ra.includes('const _crItems = checkoutReviewPendingItems();') && ra.includes('if (_crItems.length) {'), 'box hidden when empty');
console.log('ALL PASS');
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `node C:/Users/tairo/AppData/Local/Temp/claude/Z--/1a698e2c-c5d4-4394-a364-42b928382219/scratchpad/test-client-review-pending.js`
Expected: `Error: function checkoutReviewPendingItems not found`.

- [ ] **Step 3: Add the helpers** (before `renderApprovals`)

Find:

```js
function renderApprovals() {
  const catEl  = document.getElementById('approval-categories');
```

Replace with:

```js
// 2026-09-23: web check-outs at/after the Late Night time still waiting for an Accounting/MD
// review, built client-side with the shared dual-sync trigger. Current + previous pay period,
// other employees only (never the reviewer's own record), open periods only.
function checkoutReviewPendingItems() {
  if (!currentUser || currentUser.isObserver || !isMdAccountingView()) return [];
  const items = [];
  const users = DATA_USERS.filter(u => isEmployeeRecord(u) && u.active !== false &&
    Number(u.id) !== Number(currentUser.id) &&
    isAllowanceEligible(APP_SETTINGS.allowanceEligibility, u.role, 'earlyLate'));
  [0, 1].forEach(idx => {
    const { start, end, isCurrent } = getPeriodBounds(idx);
    users.forEach(u => {
      generatePeriodDays(start, end, isCurrent, u.id).forEach(day => {
        if (day.checkOutReview || !checkoutReviewTrigger(day, u, APP_SETTINGS)) return;
        if (payPeriodBlockedForDate(day.date, u.id).blocked) return;
        items.push({ user: u, day });
      });
    });
  });
  return items.sort((a, b) => b.day.date.localeCompare(a.day.date) ||
    String(a.user.name || '').localeCompare(String(b.user.name || '')));
}

function checkoutReviewPendingBoxHtml(items) {
  const rows = items.map(({ user, day }) => {
    const uid = Number(user.id);
    const d = escapeJsAttr(day.date);
    const raw = (day.rawCheckOut && day.rawCheckOut !== day.checkOut)
      ? ` <span style="color:#64748b;font-size:11px">(${escapeHtml(L('corrected from', 'แก้จาก'))} ${escapeHtml(day.rawCheckOut)})</span>`
      : '';
    return `<tr>
      <td style="padding:6px 8px">${escapeHtml(user.name)}</td>
      <td style="padding:6px 8px;white-space:nowrap">${escapeHtml(fmtDate(new Date(day.date + 'T12:00:00')))}</td>
      <td style="padding:6px 8px;white-space:nowrap">🌐 ${escapeHtml(day.checkOut)}${raw}</td>
      <td style="padding:6px 8px;white-space:nowrap;text-align:right">
        <button class="btn btn-ghost btn-sm" style="color:#059669" title="${escapeHtml(L('Allow this web check-out (unlocks 🌙)', 'อนุญาตเวลาออกผ่านเว็บนี้ (ปลดล็อก 🌙)'))}" onclick="setCheckoutReview(${uid}, '${d}', 'allow')">✅</button>
        <button class="btn btn-ghost btn-sm" style="color:#dc2626" title="${escapeHtml(L('Do not allow this web check-out', 'ไม่อนุญาตเวลาออกผ่านเว็บนี้'))}" onclick="setCheckoutReview(${uid}, '${d}', 'deny')">❌</button>
      </td>
    </tr>`;
  }).join('');
  return `<div style="margin-bottom:14px;padding:12px 14px;border:1px solid #f59e0b;border-radius:10px;background:var(--bg-card)">
    <div style="font-weight:700;color:var(--text);margin-bottom:4px">⚠️ ${escapeHtml(L('Web check-outs awaiting review', 'เช็กเอาท์ผ่านเว็บที่รอตรวจสอบ'))} (${items.length})</div>
    <div style="font-size:12px;color:var(--text-muted);margin-bottom:8px">${escapeHtml(L('A web Check Out after the Late Night time. Allow it only if the employee really worked late — Allow just unlocks the 🌙 request, which still needs normal approval.', 'กด Check Out บนเว็บหลังเวลาแจ้งกลับดึก อนุญาตเฉพาะเมื่อพนักงานทำงานดึกจริง — การอนุญาตแค่เปิดให้ยื่น 🌙 ได้ ส่วน 🌙 ยังต้องอนุมัติตามปกติ'))}</div>
    <div style="overflow-x:auto;-webkit-overflow-scrolling:touch">
      <table style="width:100%;border-collapse:collapse;font-size:13px">
        <thead><tr>
          <th style="padding:6px 8px;text-align:left;color:var(--text-muted)">${escapeHtml(L('Employee', 'ชื่อพนักงาน'))}</th>
          <th style="padding:6px 8px;text-align:left;color:var(--text-muted)">${escapeHtml(L('Date', 'วันที่'))}</th>
          <th style="padding:6px 8px;text-align:left;color:var(--text-muted)">${escapeHtml(L('Check Out', 'ออกงาน'))}</th>
          <th style="padding:6px 8px;text-align:right;color:var(--text-muted)">${escapeHtml(L('Action', 'ดำเนินการ'))}</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  </div>`;
}

function renderApprovals() {
  const catEl  = document.getElementById('approval-categories');
```

- [ ] **Step 4: Show the box at the top of the summary bar** (~11301)

Find:

```js
  if (summEl) {
    // Tab bar
    const tabBar = document.createElement('div');
```

Replace with:

```js
  if (summEl) {
    // Web check-out Late Night reviews (MD/Accounting only; hidden when empty).
    const _crItems = checkoutReviewPendingItems();
    if (_crItems.length) {
      const _crBox = document.createElement('div');
      _crBox.id = 'checkout-review-pending-box';
      _crBox.innerHTML = checkoutReviewPendingBoxHtml(_crItems);
      summEl.appendChild(_crBox);
    }
    // Tab bar
    const tabBar = document.createElement('div');
```

- [ ] **Step 5: Run the test and confirm it passes**

Run: `node C:/Users/tairo/AppData/Local/Temp/claude/Z--/1a698e2c-c5d4-4394-a364-42b928382219/scratchpad/test-client-review-pending.js`
Expected: `ALL PASS`. Re-run all previous tests → `ALL PASS`.

- [ ] **Step 6: Lint + syntax check.** Expected: clean.

---

## Task 9: Backup export, JA strings, both FAQ Late Night entries

**Files:**
- Modify: `app.js` `exportDataBackup` (~3093–3101); `_faqRulesItems` Late Night entry (~17681); Late Night how-to entry in `_faqHowToItems` (~17852)
- Modify: `attendance\lang\ja.js` — append before the closing `};`
- Create: `SCRATCH\test-ja-and-faq.js`

**Interfaces:**
- Consumes: `DATA_CHECKOUT_REVIEWS` (Task 5)
- Produces: backup JSON field `checkoutReviews` (both MD and Accounting backups), 18 new `LANG_JA` keys, updated FAQ text in all 3 languages

- [ ] **Step 1: Write the failing test** `SCRATCH\test-ja-and-faq.js`

```js
'use strict';
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const { CLIENT, readSrc, extractFunction } = require('./extract-fn.js');

const csrc = readSrc(CLIENT);
const sandbox = { window: {} };
vm.runInNewContext(fs.readFileSync('Z:/Time_Attendance/attendance/lang/ja.js', 'utf8'), sandbox);
const JA = sandbox.window.LANG_JA;
const KEYS = [
  'This web check-out is waiting for Accounting/MD review — 🌙 can be submitted after it is allowed',
  'Accounting/MD did not allow this web check-out — 🌙 cannot be claimed',
  '⚠️ Review (web)', '✅ Allowed', '❌ Not allowed',
  'Allow this web check-out (unlocks 🌙)', 'Do not allow this web check-out', 'Undo review',
  '⏳ Awaiting Accounting review', '✅ Reviewed — you can submit 🌙', '🌙 not paid — check-out not allowed',
  'corrected from',
  'This employee already has a 🌙 Late Night request for this day. Mark the check-out as not allowed anyway? The 🌙 will not be paid while it stays not allowed.',
  '✅ Check-out allowed', '❌ Check-out marked as not allowed', '↩️ Review cleared',
  'Web check-outs awaiting review',
  'A web Check Out after the Late Night time. Allow it only if the employee really worked late — Allow just unlocks the 🌙 request, which still needs normal approval.',
  // reused, must already exist
  'Employee', 'Date', 'Check Out', 'Action', '❌ Could not save: ',
];
KEYS.forEach(k => {
  assert.ok(typeof JA[k] === 'string' && JA[k].length > 0, 'missing JA: ' + k);
  assert.ok(csrc.includes(`L('${k.replace(/'/g, "\\'")}'`), 'key not used via L() in app.js: ' + k);
});
assert.ok(extractFunction(csrc, 'exportDataBackup').split('data.checkoutReviews = DATA_CHECKOUT_REVIEWS;').length === 3, 'backup includes reviews for MD and Accounting');
const faq = extractFunction(csrc, '_faqRulesItems');
assert.ok(faq.includes('A web Check Out after') && faq.includes('Web退勤は先に経理／MDが確認します'), 'rules FAQ EN+JA');
assert.ok(faq.includes('บัญชี/MD จะตรวจสอบก่อน'), 'rules FAQ TH');
assert.ok(csrc.includes("or a web Check Out that Accounting/MD has allowed"), 'how-to FAQ date bullet');
assert.ok(csrc.includes('After a web Check Out the row shows ⏳ until Accounting/MD reviews it'), 'how-to FAQ return-time bullet');
console.log('ALL PASS');
```

(`'❌ Could not save: '` is used as `L('❌ Could not save: ', ...)` in app.js, so the `L('` check matches it.)

- [ ] **Step 2: Run it and confirm it fails**

Run: `node C:/Users/tairo/AppData/Local/Temp/claude/Z--/1a698e2c-c5d4-4394-a364-42b928382219/scratchpad/test-ja-and-faq.js`
Expected: `AssertionError: missing JA: This web check-out is waiting for Accounting/MD review — 🌙 can be submitted after it is allowed`

- [ ] **Step 3: Backup export** (`exportDataBackup`, ~3093)

Find:

```js
    data.settings = { periodLocks: PERIOD_LOCKS, leaveCarryForward: LEAVE_CARRY_FORWARD, leaveOpeningUsed: LEAVE_OPENING_USED, tawi50Overrides: TAWI50_OVERRIDES, appSettings: _safeAppSettings };
    data.finalize = finalizeData;
  } else {
    data.finalize = finalizeData;
    data.settings = { appSettings: _safeAppSettings, tawi50Overrides: TAWI50_OVERRIDES };
  }
```

Replace with:

```js
    data.settings = { periodLocks: PERIOD_LOCKS, leaveCarryForward: LEAVE_CARRY_FORWARD, leaveOpeningUsed: LEAVE_OPENING_USED, tawi50Overrides: TAWI50_OVERRIDES, appSettings: _safeAppSettings };
    data.finalize = finalizeData;
    data.checkoutReviews = DATA_CHECKOUT_REVIEWS;
  } else {
    data.finalize = finalizeData;
    data.settings = { appSettings: _safeAppSettings, tawi50Overrides: TAWI50_OVERRIDES };
    data.checkoutReviews = DATA_CHECKOUT_REVIEWS;
  }
```

- [ ] **Step 4: JA dictionary** (`lang\ja.js`, end of file)

Find:

```js
  "Weekdays with a check-in and a check-out only. Weekends and public holidays use Holiday Work.": "出勤・退勤の打刻がある平日のみ選択できます。土日・祝日は休日出勤を申請してください。",
};
```

Replace with:

```js
  "Weekdays with a check-in and a check-out only. Weekends and public holidays use Holiday Work.": "出勤・退勤の打刻がある平日のみ選択できます。土日・祝日は休日出勤を申請してください。",
  // 2026-09-23: web check-out Late Night review (Accounting/MD Allow / Deny)
  "This web check-out is waiting for Accounting/MD review — 🌙 can be submitted after it is allowed": "このWeb退勤は経理／MDの確認待ちです — 許可後に🌙を申請できます",
  "Accounting/MD did not allow this web check-out — 🌙 cannot be claimed": "経理／MDがこのWeb退勤を許可しませんでした — 🌙は申請できません",
  "⚠️ Review (web)": "⚠️ 確認（Web）",
  "✅ Allowed": "✅ 許可済み",
  "❌ Not allowed": "❌ 不許可",
  "Allow this web check-out (unlocks 🌙)": "このWeb退勤を許可（🌙申請が可能に）",
  "Do not allow this web check-out": "このWeb退勤を許可しない",
  "Undo review": "確認を取り消す",
  "⏳ Awaiting Accounting review": "⏳ 経理の確認待ち",
  "✅ Reviewed — you can submit 🌙": "✅ 確認済み — 🌙を申請できます",
  "🌙 not paid — check-out not allowed": "🌙 支給なし — 退勤が許可されていません",
  "corrected from": "修正前",
  "This employee already has a 🌙 Late Night request for this day. Mark the check-out as not allowed anyway? The 🌙 will not be paid while it stays not allowed.": "この従業員はこの日の🌙深夜退勤申請をすでに提出しています。それでも退勤を不許可にしますか？不許可の間、🌙は支給されません。",
  "✅ Check-out allowed": "✅ 退勤を許可しました",
  "❌ Check-out marked as not allowed": "❌ 退勤を不許可にしました",
  "↩️ Review cleared": "↩️ 確認を取り消しました",
  "Web check-outs awaiting review": "確認待ちのWeb退勤",
  "A web Check Out after the Late Night time. Allow it only if the employee really worked late — Allow just unlocks the 🌙 request, which still needs normal approval.": "深夜時刻以降のWeb退勤です。実際に遅くまで勤務した場合のみ許可してください — 許可は🌙申請を可能にするだけで、🌙は通常どおり承認が必要です。",
};
```

Duplicate-key guard (`no-dupe-keys` is an error in lint). Before saving, confirm that none of the 18 new keys already exists. Run from `Z:\Time_Attendance`:
`node -e "const s=require('fs').readFileSync('attendance/lang/ja.js','utf8');['\"⚠️ Review (web)\"','\"✅ Allowed\"','\"❌ Not allowed\"','\"Undo review\"','\"corrected from\"','\"⏳ Awaiting Accounting review\"','\"Web check-outs awaiting review\"','\"↩️ Review cleared\"','\"✅ Check-out allowed\"'].forEach(k=>console.log(k,s.split(k+':').length-1))"`
Expected before the edit: each count `0`. After the edit: each `1`.

- [ ] **Step 5: Rules FAQ Late Night entry** (`_faqRulesItems`, ~17681)

Find:

```js
        `On a weekday: check in, then scan out at the face terminal at or after ${String(thr1).padStart(2,'0')}:00 → +฿${amt1} (or ${String(thr2).padStart(2,'0')}:00 → +฿${amt2}). You must submit 🌙. A web Check Out cannot be used. On a holiday: submit Holiday Work first (or tick 🌙 on that form if you already scanned out), then 🌙 is paid only after both Holiday Work and Late Night are approved. ${_faqNotEligibleText('earlyLate')}`,
        `วันธรรมดา: เช็กอินแล้วสแกนออกที่เครื่องตั้งแต่ ${String(thr1).padStart(2,'0')}:00 → +฿${amt1} (หรือ ${String(thr2).padStart(2,'0')}:00 → +฿${amt2}) ต้องยื่น 🌙 กด Check Out บนเว็บไม่ได้ วันหยุด: ต้องยื่น Holiday Work ก่อน (หรือติ๊ก 🌙 ในฟอร์มนั้นถ้าสแกนออกแล้ว) จ่ายเมื่อทั้ง Holiday Work และแจ้งกลับดึกอนุมัติแล้ว ${_faqNotEligibleText('earlyLate')}`,
        `平日：出勤したうえで端末退勤が${String(thr1).padStart(2,'0')}:00以降 → +฿${amt1}（${String(thr2).padStart(2,'0')}:00以降は+฿${amt2}）。🌙申請が必要。Web退勤不可。休日：先に休日出勤（またはそのフォームで🌙にチェック）。両方承認後に支給。${_faqNotEligibleText('earlyLate')}`
```

Replace with:

```js
        `On a weekday: check in, then check out at or after ${String(thr1).padStart(2,'0')}:00 → +฿${amt1} (or ${String(thr2).padStart(2,'0')}:00 → +฿${amt2}); a check-out after midnight (00:00–04:59, same working day) counts as the ${String(thr2).padStart(2,'0')}:00 tier. You must submit 🌙. A face-scanner check-out unlocks 🌙 straight away. A web Check Out after ${String(thr1).padStart(2,'0')}:00 is first reviewed by Accounting/MD: if they allow it you can submit 🌙 as usual (it still needs normal approval); if they do not, 🌙 is not paid. If you scan out at the terminal and later also tap Check Out on the web, the later web tap becomes your check-out and needs review. On a holiday: submit Holiday Work first (or tick 🌙 on that form if you already checked out), then 🌙 is paid only after both Holiday Work and Late Night are approved. ${_faqNotEligibleText('earlyLate')}`,
        `วันธรรมดา: เช็กอินแล้วเช็กเอาท์ตั้งแต่ ${String(thr1).padStart(2,'0')}:00 → +฿${amt1} (หรือ ${String(thr2).padStart(2,'0')}:00 → +฿${amt2}) เช็กเอาท์หลังเที่ยงคืน (00:00–04:59 ของวันทำงานเดียวกัน) นับเป็นขั้น ${String(thr2).padStart(2,'0')}:00 ต้องยื่น 🌙 สแกนออกที่เครื่องยื่น 🌙 ได้ทันที ถ้ากด Check Out บนเว็บหลัง ${String(thr1).padStart(2,'0')}:00 บัญชี/MD จะตรวจสอบก่อน: ถ้าอนุญาตก็ยื่น 🌙 ได้ตามปกติ (ยังต้องรออนุมัติตามปกติ) ถ้าไม่อนุญาต 🌙 จะไม่จ่าย ถ้าสแกนออกที่เครื่องแล้วมากด Check Out บนเว็บทีหลัง เวลาเว็บที่หลังกว่าจะกลายเป็นเวลาออกและต้องรอตรวจสอบ วันหยุด: ต้องยื่น Holiday Work ก่อน (หรือติ๊ก 🌙 ในฟอร์มนั้นถ้าเช็กเอาท์แล้ว) จ่ายเมื่อทั้ง Holiday Work และแจ้งกลับดึกอนุมัติแล้ว ${_faqNotEligibleText('earlyLate')}`,
        `平日：出勤後、${String(thr1).padStart(2,'0')}:00以降に退勤 → +฿${amt1}（${String(thr2).padStart(2,'0')}:00以降は+฿${amt2}）。深夜0時以降（同じ勤務日の00:00〜04:59）の退勤は${String(thr2).padStart(2,'0')}:00区分として扱います。🌙申請が必要です。顔認証端末での退勤ならすぐ🌙を申請できます。${String(thr1).padStart(2,'0')}:00以降のWeb退勤は先に経理／MDが確認します：許可されれば通常どおり🌙を申請でき（通常の承認は必要）、不許可なら🌙は支給されません。端末で退勤した後にWebで退勤を押すと、後のWeb打刻が退勤時刻になり確認が必要です。休日：先に休日出勤（またはそのフォームで🌙にチェック）。両方承認後に支給。${_faqNotEligibleText('earlyLate')}`
```

- [ ] **Step 6: How-to FAQ entry** (~17855 and ~17858)

Find:

```js
        _faq('<b>Date</b> — only dates with a device check-out at or after the configured time are selectable (dark). A web Check Out cannot unlock this. Locked / confirmed / frozen pay periods are grayed out.',
             '<b>วันที่</b> — เลือกได้เฉพาะวันที่สแกนออกที่เครื่องถึงเกณฑ์เวลาแล้ว (สีเข้ม) กด Check Out บนเว็บแล้วยื่นไม่ได้ รอบที่ล็อก / Confirm / แช่แข็งแล้วเป็นสีเทา',
             '<b>日付</b> — 端末退勤が設定時刻以降の日だけ選べます（濃い色）。Web退勤では申請できません。ロック／確定／凍結済み期間は灰色です。'),
        _faq('<b>Return time</b> — pick whichever of the two tier buttons matches your actual return time; this determines the allowance amount. The 🌙 button appears only after you have scanned out at the face terminal at or after the configured time (default 19:00). On a holiday row it stays hidden until that scan; on a weekday it keeps a placeholder slot. A web Check Out cannot be used to claim this, and advance requests are not allowed.',
             '<b>เวลาที่กลับ</b> — เลือกปุ่ม tier ที่ตรงกับเวลาที่กลับจริง จะกำหนดจำนวนเบี้ยเลี้ยงที่ได้ ปุ่ม 🌙 จะขึ้นเมื่อสแกนออกที่เครื่องถึงเกณฑ์เวลาแล้วเท่านั้น (ค่าเริ่มต้น 19:00) แถววันหยุดจะซ่อนจนกว่าจะสแกน แถววันธรรมดามีช่องว่างรอไว้ กด Check Out บนเว็บแล้วยื่นไม่ได้ และยื่นล่วงหน้าไม่ได้',
             '<b>帰宅時刻</b> — 実際の帰宅時刻に合う方の区分ボタンを選択します。これにより支給額が決まります。🌙ボタンは顔認証端末で設定時刻（既定19:00）以降に退勤したときだけ表示されます。休日行はそのスキャンまで非表示、平日行はプレースホルダー枠があります。Webアプリの退勤では申請できず、事前申請もできません。'),
```

Replace with:

```js
        _faq('<b>Date</b> — only dates with a check-out at or after the configured time are selectable (dark): a face-scanner check-out, or a web Check Out that Accounting/MD has allowed. A check-out after midnight (up to 04:59) belongs to the same working day. Locked / confirmed / frozen pay periods are grayed out.',
             '<b>วันที่</b> — เลือกได้เฉพาะวันที่เช็กเอาท์ถึงเกณฑ์เวลาแล้ว (สีเข้ม): สแกนออกที่เครื่อง หรือกด Check Out บนเว็บที่บัญชี/MD อนุญาตแล้ว เช็กเอาท์หลังเที่ยงคืน (ถึง 04:59) นับเป็นวันทำงานเดียวกัน รอบที่ล็อก / Confirm / แช่แข็งแล้วเป็นสีเทา',
             '<b>日付</b> — 設定時刻以降に退勤した日だけ選べます（濃い色）：顔認証端末での退勤、または経理／MDが許可したWeb退勤。深夜0時以降（04:59まで）の退勤は同じ勤務日です。ロック／確定／凍結済み期間は灰色です。'),
        _faq('<b>Return time</b> — pick whichever of the two tier buttons matches your actual return time; this determines the allowance amount, and it cannot be later than your check-out. The 🌙 button appears only once the day qualifies (default 19:00). On a holiday row it stays hidden until then; on a weekday it keeps a placeholder slot. After a web Check Out the row shows ⏳ until Accounting/MD reviews it — ✅ means you can submit 🌙, ❌ means it will not be paid. Advance requests are not allowed.',
             '<b>เวลาที่กลับ</b> — เลือกปุ่ม tier ที่ตรงกับเวลาที่กลับจริง จะกำหนดจำนวนเบี้ยเลี้ยงที่ได้ และต้องไม่หลังเวลาเช็กเอาท์ ปุ่ม 🌙 จะขึ้นเมื่อวันนั้นเข้าเกณฑ์แล้วเท่านั้น (ค่าเริ่มต้น 19:00) แถววันหยุดจะซ่อนจนกว่าจะเข้าเกณฑ์ แถววันธรรมดามีช่องว่างรอไว้ ถ้ากด Check Out บนเว็บ แถวจะขึ้น ⏳ จนกว่าบัญชี/MD จะตรวจสอบ — ✅ แปลว่ายื่น 🌙 ได้ ❌ แปลว่าไม่จ่าย ยื่นล่วงหน้าไม่ได้',
             '<b>帰宅時刻</b> — 実際の帰宅時刻に合う方の区分ボタンを選択します。これにより支給額が決まり、退勤時刻より後にはできません。🌙ボタンはその日が条件を満たしたときだけ表示されます（既定19:00）。休日行はそれまで非表示、平日行はプレースホルダー枠があります。Web退勤の場合は経理／MDが確認するまで⏳が表示され、✅なら🌙を申請でき、❌なら支給されません。事前申請はできません。'),
```

- [ ] **Step 7: Run the test and confirm it passes**

Run: `node C:/Users/tairo/AppData/Local/Temp/claude/Z--/1a698e2c-c5d4-4394-a364-42b928382219/scratchpad/test-ja-and-faq.js`
Expected: `ALL PASS`. Then run every test script from Tasks 1–8 once more; each prints `ALL PASS`.

- [ ] **Step 8: Lint + syntax check.** Expected: clean. (`no-dupe-keys` would catch a duplicated JA key here.)

---

## Task 10: Deploy + live verification

Follow the project rules: verify the deploy before any write-test; use Playwright MCP (not the Claude Browser tool); use only the QA accounts; revert every test write. Never Allow/Deny a real (non-QA) employee's day. Doing so is a real business decision, not a test.

**Files:**
- Modify: `Z:\Time_Attendance\attendance\index.html` cache-busters (~2591, ~2595)

- [ ] **Step 1: Pre-deploy gate**

From `Z:\Time_Attendance`, run the lint + syntax check, then all 9 scratchpad tests:
`test-dualsync-checkout-review.js`, `test-server-period-days.js`, `test-server-lateout-gate.js`, `test-server-checkout-review-api.js`, `test-client-period-days.js`, `test-client-lateout-gate.js`, `test-client-review-row.js`, `test-client-review-pending.js`, `test-ja-and-faq.js`.
Expected: lint clean; every script prints `ALL PASS`.

- [ ] **Step 2: Deploy the backend**

Run: `python Z:\Time_Attendance\attendance-server\scripts\deploy\deploy_backend.py` (needs the `NAS_PASSWORD` env var).
Expected output includes: `[SSH] connected`, `[BEFORE] running pid(s): <A>`, `[AFTER] running pid(s): <B>` where B ≠ A and is non-empty, `[VERIFY] health check HTTP 200`, `[DONE]`. Stop if you see `[WARN] new pid overlaps`, `FAILED TO START` or `[ERROR]`. Do not live-test on an uncertain deploy.

- [ ] **Step 3: Bump the cache-busters** (`attendance\index.html`)

Find: `<script src="lang/ja.js?v=20260923b"></script>` → Replace: `<script src="lang/ja.js?v=20260923c"></script>`
Find: `<script src="js/app.js?v=20260923e"></script>` → Replace: `<script src="js/app.js?v=20260923f"></script>`

This bump is deliberately made after the backend restart, so browsers only pick up the new app.js once `GET /api/checkout-reviews` exists.

- [ ] **Step 4: Confirm the new code is live (Playwright, Accounting)**

Navigate to `https://attendance.tozaiboeki.co.th`, log in as `sirintorn` / `1234`, and reload. Then `browser_evaluate`:

```js
({ app: document.querySelector('script[src*="js/app.js"]').src, ja: document.querySelector('script[src*="lang/ja.js"]').src,
   helpers: [typeof lateNightCheckoutMins, typeof checkoutReviewTrigger, typeof setCheckoutReview].join(','),
   get: await (await apiFetch('/api/checkout-reviews')).json() })
```

Expected: `app` ends with `v=20260923f`, `ja` ends with `v=20260923c`, `helpers` = `function,function,function`, `get` = `{ success: true, reviews: {} }` (the file does not exist yet, so the map is empty). `browser_console_messages` shows no errors.

- [ ] **Step 5: PUT is refused where it must be (nothing written)**

Still as `sirintorn`, `browser_evaluate` (QA account `teerawat` is the target):

```js
const tee = DATA_USERS.find(u => u.username === 'teerawat');
const put = async b => { const r = await apiFetch('/api/checkout-reviews', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }); return [r.status, (await r.json()).message]; };
const { start, end, isCurrent } = getPeriodBounds(0);
const nonTrigger = generatePeriodDays(start, end, isCurrent, tee.id).find(d => d.checkIn && !checkoutReviewTrigger(d, tee, APP_SETTINGS) && !payPeriodBlockedForDate(d.date, tee.id).blocked);
const lockKey = Object.keys(PERIOD_LOCKS).find(k => PERIOD_LOCKS[k] && PERIOD_LOCKS[k].locked);
const lockedDate = lockKey ? `${lockKey.slice(0,4)}-${lockKey.slice(4,6)}-${lockKey.slice(6,8)}` : null;
({
  self: await put({ userId: currentUser.id, date: nonTrigger ? nonTrigger.date : '2026-09-10', decision: 'allow' }),
  nonTrigger: nonTrigger ? await put({ userId: tee.id, date: nonTrigger.date, decision: 'allow' }) : 'no non-trigger day found',
  locked: lockedDate ? await put({ userId: tee.id, date: lockedDate, decision: null }) : 'no locked period',
  badDecision: await put({ userId: tee.id, date: '2026-09-10', decision: 'maybe' }),
  after: await (await apiFetch('/api/checkout-reviews')).json(),
})
```

Expected: `self` → `[403, 'You cannot review your own check-out']`; `nonTrigger` → `[400, 'This day has no web check-out at or after the Late Night time to review']`; `locked` → `[400, 'This pay period is locked']` (or a recorded "no locked period"); `badDecision` → `[400, "decision must be 'allow', 'deny' or null"]`; `after.reviews` still `{}`.

- [ ] **Step 6: Find a QA trigger day (read-only)**

As `sirintorn`, `browser_evaluate`:

```js
const qa = DATA_USERS.filter(u => ['teerawat'].includes(u.username));
const found = [];
[0, 1, 2].forEach(i => { const { start, end, isCurrent } = getPeriodBounds(i);
  qa.forEach(u => generatePeriodDays(start, end, isCurrent, u.id).forEach(d => {
    if (checkoutReviewTrigger(d, u, APP_SETTINGS) && !payPeriodBlockedForDate(d.date, u.id).blocked) found.push({ id: u.id, date: d.date, checkOut: d.checkOut, raw: d.rawCheckOut, review: d.checkOutReview });
  })); });
found
```

- If `found` is empty: **stop the positive-path tests here and ask the user.** A web check-out event cannot be deleted through the API, and an approved time-correction cannot be deleted either (`DELETE /api/leaves/:id` refuses non-pending records). So test data made to create a trigger day could not be reverted. Report that Steps 5, 9 and 10 passed and that the positive path is waiting on the user's decision.
- If `found` has a day, use the first one (`QA_ID`, `QA_DATE`) for Steps 7–8.

- [ ] **Step 7: Positive path as Accounting (reverted at the end)**

1. Go to the Approvals page and take a screenshot. `#checkout-review-pending-box` lists QA_DATE with its check-out (and "corrected from …" if it was corrected).
2. Hook the socket, then Allow. `browser_evaluate`:
   ```js
   window.__crMsgs = []; hikvisionWs.addEventListener('message', e => { try { const m = JSON.parse(e.data); if (m.type === 'CHECKOUT_REVIEWS_UPDATED') window.__crMsgs.push(e.data); } catch (_) {} });
   ```
   Click the ✅ button for that row (real click, per the "assert what the user sees" rule). Wait 2 s, then evaluate `({ msgs: window.__crMsgs, rev: DATA_CHECKOUT_REVIEWS[`${QA_ID}_${QA_DATE}`] })`.
   Expected: `msgs` = `['{"type":"CHECKOUT_REVIEWS_UPDATED"}']` (no payload); `rev.decision === 'allow'`; `rev.checkOut` equals the day's effective check-out; `rev.byId === currentUser.id`. The box no longer lists the row. On the Attendance page (select teerawat) the row shows `✅ Allowed` plus ↩️. Take a screenshot.
3. Click ↩️ (clear). Expected: the row is back to `⚠️ Review (web)` with ✅/❌, and `GET /api/checkout-reviews` → `reviews: {}`.
4. Click ❌ on the same row. If teerawat has a non-rejected 🌙 for QA_DATE, a `confirm()` dialog appears. Handle it with `browser_handle_dialog` accept and note that it appeared. Expected: `❌ Not allowed` + ↩️. Then click ↩️ again → `reviews: {}`.
5. Leave the day **allowed** for Step 8 by clicking ✅ once more (this is reverted in Step 8.4).

- [ ] **Step 8: Employee view (teerawat)**

1. Log out, then log in as `teerawat` / `1234` and reload. Go to Attendance. The QA_DATE row shows `✅ Reviewed — you can submit 🌙`, and the 🌙 row button is visible. **Do not submit 🌙.** No ✅/❌/↩️ buttons appear anywhere on the page. Take a screenshot.
2. `browser_evaluate`: `Object.keys((await (await apiFetch('/api/checkout-reviews')).json()).reviews).every(k => k.startsWith(currentUser.id + '_'))` → `true`.
3. `browser_evaluate` of a direct PUT: `(await apiFetch('/api/checkout-reviews', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId: currentUser.id, date: QA_DATE, decision: 'deny' }) })).status` → `403` (role gate).
4. Log out, log in as `sirintorn` and clear the review with ↩️ on the Attendance row. Then `GET /api/checkout-reviews` → `reviews: {}`. **This is the revert.** Confirm the pending box lists QA_DATE again.

- [ ] **Step 9: Pay path unchanged for everyone else**

As `sirintorn`, open Payslip for teerawat for the current period and note the Late Night line. It must equal the value before this deploy: the review file is back to `{}`, so no web day pays. Run `browser_console_messages` → no errors on the Attendance, Approvals, Payslip, Reports and Dashboard pages.

- [ ] **Step 10: Language pass**

As `sirintorn`, switch to EN, then JA, then TH on Attendance (teerawat selected) and Approvals. Check that the chips, button titles and the box heading are translated, and that no English leaks in JA. Screenshot each.

- [ ] **Step 11: Final state check**

`GET /api/checkout-reviews` as `sirintorn` → `{ success: true, reviews: {} }`. No leaves were created or changed by the test. Record what was verified, and list anything that was skipped along with the reason (e.g. no QA trigger day, no locked period, no observer QA account: the observer rules are covered by the Task 7/8 unit tests and by `requireRole`).

- [ ] **Step 12: Lint + syntax check** (index.html is not linted; this re-confirms the final tree). Expected: clean.
