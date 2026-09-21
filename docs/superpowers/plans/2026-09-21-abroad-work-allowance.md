# Abroad Work Request + Allowance — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let staff declare a multi-day trip abroad so those days stop counting as absent, and pay a configurable per-day allowance (default ฿1,100) for every calendar day of the trip.

**Architecture:** A new leave type `abroad` inside the existing leave system (`leaves.json`, `/api/leaves`), reusing its date range, approval routing, approval queue, edit/cancel, period locks and per-day attendance overlay. A new allowance key `abroad` in `appSettings.allowances` / `allowanceEligibility`, flowing into payroll and both payslips.

**Tech Stack:** Vanilla JS frontend (`attendance/js/app.js`), Node/Express backend (`attendance-server/backend/server.js`), ExcelJS payslip (`attendance-server/backend/payslipXlsx.js`). No test framework — verification is `node --check`, live API calls, and Playwright against the running app.

**Spec:** `docs/superpowers/specs/2026-09-21-abroad-work-allowance-design.md`

## Global Constraints

- **Spelling is `abroad` everywhere** — key, settings path, status string, label. Never "aboard".
- **Dual-sync rule:** every payroll/attendance rule exists in BOTH `app.js` and `server.js` and must be changed in both, or the numbers silently diverge.
- **i18n rule:** every new user-facing string ships Thai + English + Japanese in the same change. Fixed strings go in `lang/ja.js`; strings with interpolated values use the inline `currentLang === 'ja' ? … : L(en, th)` pattern.
- **Cache-buster rule:** after editing `app.js`, bump `?v=` on `js/app.js` in `attendance/index.html`. Same for `lang/ja.js` and `css/style.css` if touched.
- **Deploy verification rule:** after any `server.js` change, run the deploy script and confirm the PID changed and `/api/health` returns 200 BEFORE any live write test.
- **Real data rule:** verification runs against real employees. Revert every test record afterwards and confirm the revert.
- **Do not touch superadmin code.** Abroad needs none — see Task 3.
- Allowance rate default: `1100`. Eligibility default: `['manager','user']`. Approval route default: `['md']`.

---

### Task 1: Register the `abroad` allowance key and approval route

Adds the constants. Nothing is user-visible yet, but the page must not break.

**Files:**
- Modify: `attendance/js/app.js` — `ALLOWANCE_KEYS` (~line 1022), `DEFAULT_ALLOWANCE_ELIGIBILITY` (~line 1022-1037), `APPROVAL_ROUTING_DEFAULT` (~line 1580)
- Modify: `attendance-server/backend/server.js` — `ALLOWANCE_KEYS` (~line 6580), `DEFAULT_ALLOWANCE_ELIGIBILITY`, `APPROVAL_ROUTING_DEFAULT` (~line 3911)

**Interfaces:**
- Produces: allowance key `'abroad'`; routing key `'abroad'`; `isAllowanceEligible(cfg, role, 'abroad')` is safe to call.

- [ ] **Step 1: Add the key to `ALLOWANCE_KEYS` in both files**

`app.js` (~1022) and `server.js` (~6580) — append `'abroad'`:

```js
const ALLOWANCE_KEYS = ['diligence', 'longDistance', 'personalCar', 'upcountry', 'earlyLate', 'ot', 'phone', 'holidayWork', 'abroad'];
```

- [ ] **Step 2: Add the eligibility default in both files — THIS IS THE CRASH TRAP**

`isAllowanceEligible()` falls back to `DEFAULT_ALLOWANCE_ELIGIBILITY[key].includes(role)` when the live settings have no entry. Live `settings.json` has no `allowanceEligibility.abroad`, so omitting this throws `TypeError: Cannot read properties of undefined` and takes the page down.

In `DEFAULT_ALLOWANCE_ELIGIBILITY` in both files, add:

```js
  abroad:       ['manager', 'user'],
```

- [ ] **Step 3: Add the approval route default in both files**

`server.js` gates saving with `ALLOWED_ROUTE_KEYS = Object.keys(APPROVAL_ROUTING_DEFAULT)`, so omitting it on the server makes saving the route return 400 and silently never persist (the 50-Tawi SSF/PVD bug of 2026-08-17).

`server.js` (~3911) add to the object literal:

```js
  abroad: ['md'],
```

`app.js` (~1580) add, matching the aligned style there:

```js
  abroad:             ['md'],
```

- [ ] **Step 4: Syntax check both files**

```bash
cd "Z:/Time_Attendance" && node --check attendance/js/app.js && node --check attendance-server/backend/server.js && echo OK
```

Expected: `OK`

- [ ] **Step 5: Confirm nothing broke, then commit**

Bump the `app.js` cache-buster in `attendance/index.html`, load the app as MD in Playwright, open Settings, and confirm **0 console errors** (this is what catches the Step 2 trap).

```bash
git add attendance/js/app.js attendance-server/backend/server.js attendance/index.html
git commit -m "feat(abroad): register abroad allowance key and approval route"
```

---

### Task 2: Backend — accept, validate and approve `abroad` requests

**Files:**
- Modify: `attendance-server/backend/server.js` — `TYPE_SCOPED_LEAVE_FIELDS` (~4358), `DATE_OVERLAP_LEAVE_TYPES` (~4443), the `POST /api/leaves` validation block

**Interfaces:**
- Consumes: routing key `'abroad'` from Task 1.
- Produces: a leave record `{ type: 'abroad', dateFrom, dateTo, location, reason, status }` accepted by `POST /api/leaves` and approvable through the normal flow.

- [ ] **Step 1: Allow the `location` field for this type**

In `TYPE_SCOPED_LEAVE_FIELDS` (~4358) add:

```js
  abroad: ['location'],
```

`dateFrom`, `dateTo` and `reason` are already in `UNIVERSAL_LEAVE_FIELDS` — do not duplicate them.

- [ ] **Step 2: Block overlapping requests**

In `DATE_OVERLAP_LEAVE_TYPES` (~4443) add `'abroad'`:

```js
const DATE_OVERLAP_LEAVE_TYPES = new Set(['annual', 'sick', 'business', 'holiday-work', 'abroad']);
```

An employee cannot be on annual leave and abroad on the same day.

- [ ] **Step 3: Add type validation in `POST /api/leaves`**

Alongside the other per-type validations, add a guard for `abroad`. Validate the RESOLVED value (existing record merged with this update) — this is a recurring bug class in this codebase, see memory `project_time_attendance_2026_08_10_round4_audit_fixes`.

```js
  if (type === 'abroad') {
    const from = body.dateFrom, to = body.dateTo || body.dateFrom;
    if (!isValidDateStr(from) || !isValidDateStr(to)) {
      return res.status(400).json({ success: false, message: 'abroad requires a valid dateFrom and dateTo' });
    }
    if (to < from) {
      return res.status(400).json({ success: false, message: 'dateTo must be on or after dateFrom' });
    }
    const spanDays = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000) + 1;
    if (!Number.isFinite(spanDays) || spanDays < 1 || spanDays > 90) {
      return res.status(400).json({ success: false, message: 'abroad range must be between 1 and 90 days' });
    }
    const loc = String(body.location || '').trim();
    if (!loc || loc.length > 200) {
      return res.status(400).json({ success: false, message: 'abroad requires a location of 1-200 characters' });
    }
    const why = String(body.reason || '').trim();
    if (!why) {
      return res.status(400).json({ success: false, message: 'abroad requires a reason' });
    }
  }
```

Apply the same guard on the `PUT /api/leaves/:id` edit path, computing `from`/`to`/`location` from the merged record, not from `body` alone.

- [ ] **Step 4: Syntax check, deploy, verify the deploy**

```bash
cd "Z:/Time_Attendance" && node --check attendance-server/backend/server.js && echo OK
```

```bash
cd "Z:/Time_Attendance/attendance-server/scripts/deploy" && python deploy_backend.py
```

Expected: `[AFTER] running pid(s):` differs from `[BEFORE]`, then `[VERIFY] health check HTTP 200`, then `[DONE]`.

- [ ] **Step 5: Live-test submit and reject**

As a real employee account (`teerawat` / `1234`), `POST /api/leaves` with `{type:'abroad', dateFrom:'2026-10-05', dateTo:'2026-10-09', location:'Japan', reason:'customer visit'}` → expect 201/200 and status `pending-md`.

Negative tests, each must 400: `dateTo` before `dateFrom`; a 120-day range; empty `location`; empty `reason`.

**Delete the created record afterwards** and confirm `leaves.json` is back to its previous record count.

- [ ] **Step 6: Commit**

```bash
git add attendance-server/backend/server.js
git commit -m "feat(abroad): accept and validate abroad leave requests"
```

---

### Task 3: Frontend — the submit button and modal

**Files:**
- Modify: `attendance/index.html` — new modal after the Holiday Work modal (~line 1556)
- Modify: `attendance/js/app.js` — `canUseAbroad()`, modal open/close/submit, `MY_REQUEST_TYPES` (~5844), `EDITABLE_LEAVE_TYPES` (~11997), `LEAVE_TYPE_ICON` (~10780)

**Interfaces:**
- Consumes: `isAllowanceEligible(…, 'abroad')` from Task 1; the `POST /api/leaves` contract from Task 2.
- Produces: `canUseAbroad(user)`, `openAbroadModal(date)`, `closeAbroadModal()`, `submitAbroad()`.

**superadmin note:** gate the button on the *selected employee's* `user.role`, exactly like `canUseHolidayWork(user)` does. That is what already makes request buttons visible to superadmin in QA mode. Write **no** superadmin-specific code and do not touch any `isSuperAdmin*` branch.

- [ ] **Step 1: Add the eligibility helper**

Next to `canUseHolidayWork` (~803) in `app.js`:

```js
function canUseAbroad(user) {
  if (!user) return false;
  return isAllowanceEligible(APP_SETTINGS.allowanceEligibility, user.role, 'abroad');
}
```

- [ ] **Step 2: Add the modal markup**

In `attendance/index.html`, after the Holiday Work modal block that starts at `<div class="modal-overlay" id="holiday-work-modal" …>`, add a sibling with ids `abroad-modal`, `abroad-date-from`, `abroad-date-to`, `abroad-location`, `abroad-reason`. Copy the Holiday Work modal's structure (overlay → `modal` → header/body/footer, `onclick="if(event.target===this)closeAbroadModal()"`), replacing its fields with:

- Start date (`abroad-date-from`) and End date (`abroad-date-to`), both flatpickr `DD/MM/YYYY` text inputs
- Location (`abroad-location`) — required, placeholder `เช่น ญี่ปุ่น หรือ ชื่อลูกค้า` / `e.g. Japan, or a customer name` / `例：日本、または顧客名`
- Reason (`abroad-reason`) — required textarea
- No file attachment (confirmed out of scope)
- Footer buttons: Cancel, and `✈️ ยื่นคำขอ` calling `submitAbroad()`

- [ ] **Step 3: Add open/close/submit**

Model these on `openHolidayWorkModal` / `closeHolidayWorkModal` / `submitHolidayWork`. `submitAbroad()` must:

1. `if (blockIfObserver()) return;`
2. read and trim the four fields; toast and return if date-from, date-to, location or reason is empty
3. reject `dateTo < dateFrom` and ranges over 90 days with a clear toast
4. `POST /api/leaves` with `{ type:'abroad', dateFrom, dateTo, location, reason }`
5. on success: toast, close modal, refresh the requests list

- [ ] **Step 4: Register the type in the three sets**

```js
// MY_REQUEST_TYPES (~5844) — add 'abroad'
// EDITABLE_LEAVE_TYPES (~11997) — add 'abroad'
// LEAVE_TYPE_ICON (~10780) — add abroad:'✈️'
```

- [ ] **Step 5: Syntax check and bump the cache-buster**

```bash
cd "Z:/Time_Attendance" && node --check attendance/js/app.js && echo OK
```

Bump `js/app.js?v=` in `attendance/index.html`.

- [ ] **Step 6: Playwright — submit end to end, then revert**

Log in as `teerawat`, open the Abroad modal, submit a 5-day range covering a weekend, confirm it appears in My Requests with the ✈️ icon and route "MD". Confirm 0 console errors. **Delete the request afterwards.**

- [ ] **Step 7: Commit**

```bash
git add attendance/index.html attendance/js/app.js
git commit -m "feat(abroad): add abroad request button and modal"
```

---

### Task 4: Stop Abroad days counting as absent

**Files:**
- Modify: `attendance/js/app.js` — the approved-leave overlay in `generatePeriodDays()` (~4115), `isWorkDay` exclusion list (~6375), Long Distance row-button exclusion (~6407), status badge map (~6656), status label map
- Modify: `attendance-server/backend/server.js` — the approved-leave overlay in the day builder (~6940-6960)

**Interfaces:**
- Consumes: approved `abroad` records from Task 2.
- Produces: attendance day status string `'abroad'`.

- [ ] **Step 1: Overlay approved Abroad records — server**

In the `leaves.filter(l => l.userId == uid && l.status === 'approved').forEach(…)` block (~6940), add a branch before the annual/sick/business branch. Unlike those, it must **not** skip weekends:

```js
        if (l.type === 'abroad') {
          const to = l.dateTo || l.dateFrom;
          if (l.dateFrom <= dateStr && to >= dateStr) {
            status = 'abroad';
          }
          return;
        }
```

- [ ] **Step 2: Mirror it in app.js**

Add the byte-equivalent branch in `generatePeriodDays()`'s overlay loop (~4115), same placement, same weekend behaviour.

- [ ] **Step 3: Add `'abroad'` to the non-working-day exclusion lists in app.js**

```js
// isWorkDay (~6375)
!['holiday','leave-annual','leave-sick','leave-business','company-trip','abroad'].includes(row.status);

// Long Distance row button (~6407)
!['leave-annual', 'leave-sick', 'leave-business', 'abroad'].includes(row.status)
```

- [ ] **Step 4: Add the badge and label**

In the status badge map (~6656), next to `absent`:

```js
    abroad: `<span class="badge badge-info">✈️ ${L('Abroad', 'ทำงานต่างประเทศ')}</span>`,
```

Add the matching entry to the status label map used by the mobile cards, and `abroad: '海外勤務'` handling in the JA path.

- [ ] **Step 5: Syntax check, deploy, verify**

```bash
cd "Z:/Time_Attendance" && node --check attendance/js/app.js && node --check attendance-server/backend/server.js && echo OK
```

```bash
cd "Z:/Time_Attendance/attendance-server/scripts/deploy" && python deploy_backend.py
```

Expected: PID changed, health 200.

- [ ] **Step 6: Playwright — the core acceptance test**

Submit an Abroad range covering a weekend for a real employee, approve it as MD, then open that employee's attendance page for the period. Every date in the range — Saturday and Sunday included — must show ✈️ ทำงานต่างประเทศ and **not** ⏸ ไม่มาทำงาน. Confirm the payslip's `absentDays` no longer counts them. **Revert the record afterwards.**

- [ ] **Step 7: Commit**

```bash
git add attendance/js/app.js attendance-server/backend/server.js attendance/index.html
git commit -m "feat(abroad): show abroad days as worked, not absent"
```

---

### Task 5: Pay the allowance — payroll, web payslip, Excel payslip

**Files:**
- Modify: `attendance-server/backend/server.js` — `computePayroll()` (~7245)
- Modify: `attendance/js/app.js` — `computePayroll()` twin (~10025), payslip earnings rendering
- Modify: `attendance-server/backend/payslipXlsx.js` — `earningsItems` (~249)

**Interfaces:**
- Consumes: attendance status `'abroad'` from Task 4; `S.allowances.abroad`; `isAllowanceEligible(…,'abroad')`.
- Produces: `calc.abroadDays` (integer) and `calc.abroadTotal` (baht) on the payroll result object, consumed by both payslips.

- [ ] **Step 1: Compute it — server**

In `computePayroll()`, near `const totalUpcountryCount = …` (~7244):

```js
  const abroadEligible = isAllowanceEligible(S.allowanceEligibility, user.role, 'abroad');
  const abroadDays = abroadEligible ? pDays.filter(d => d.status === 'abroad').length : 0;
  const abroadTotal = (S.allowances.abroad || 0) * abroadDays;
```

Add `abroadTotal` to `grossIncome`:

```js
  const grossIncome = base + transport + posAllowance + housingAllowance + diligenceAllowance +
    allowance1 + allowance2 + allowance3val + otAmount + longDistanceTotal + personalCarTotal +
    holidayTransportTotal + abroadTotal;
```

Return `abroadDays` and `abroadTotal` on the result object alongside the other totals.

Counting days off `pDays` (status `'abroad'`) automatically scopes to the payroll period and automatically includes weekends, because Task 4 overlays every calendar day.

- [ ] **Step 2: Mirror it byte-for-byte in app.js's `computePayroll()`**

Same three lines, same `grossIncome` addition, same returned fields. The dual-sync rule is not optional here — a mismatch means the on-screen figure and the emailed payslip disagree.

- [ ] **Step 3: Add the web payslip row**

In the payslip earnings rendering in `app.js`, add an Abroad row next to the Holiday Transport / Personal Car rows, shown only when `abroadTotal > 0`, labelled `Abroad Allowance` / `ค่าทำงานต่างประเทศ` / `海外勤務手当`, with the day count as the detail text.

- [ ] **Step 4: Add the Excel payslip row**

In `payslipXlsx.js` `earningsItems` (~249), after the Holiday Transport line:

```js
    ...(canShow('abroad') ? [['Abroad Allowance', calc.abroadTotal || 0]] : []),
```

The list already ends with `.filter(([, amount]) => (amount || 0) > 0)`, so a zero month drops the row automatically — no extra conditional needed. Pass `abroad` through whatever builds the `eligibility` object handed to `canShow`.

- [ ] **Step 5: Syntax check, deploy, verify**

```bash
cd "Z:/Time_Attendance" && node --check attendance/js/app.js && node --check attendance-server/backend/server.js && node --check attendance-server/backend/payslipXlsx.js && echo OK
```

```bash
cd "Z:/Time_Attendance/attendance-server/scripts/deploy" && python deploy_backend.py
```

- [ ] **Step 6: Verify the money**

With an approved 5-day Abroad range including a weekend, at the default rate:

- web payslip shows `Abroad Allowance` = `5 × 1100 = 5,500`
- exported Excel payslip shows the same row and the same figure — open the .xlsx and read the earnings block, do not infer it
- an employee with no Abroad record has **no** Abroad row on either payslip
- change the rate in Settings to 1200 and confirm the figure follows (proves nothing is hardcoded)
- remove the employee's role from Abroad eligibility and confirm the row disappears

**Revert the record, the rate and the eligibility afterwards, and confirm the revert.**

- [ ] **Step 7: Commit**

```bash
git add attendance/js/app.js attendance-server/backend/server.js attendance-server/backend/payslipXlsx.js attendance/index.html
git commit -m "feat(abroad): pay abroad allowance on web and excel payslips"
```

---

### Task 6: Block double-claiming on Abroad days

**Files:**
- Modify: `attendance-server/backend/server.js` — near `COMPANY_TRIP_NO_CLAIM_TYPES` / `FULL_LEAVE_NO_CLAIM_TYPES` (~6689-6706)
- Modify: `attendance/js/app.js` — the twin sets and the per-row button gating

**Interfaces:**
- Consumes: approved `abroad` records.
- Produces: `ABROAD_NO_CLAIM_TYPES`, `isAbroadClaimBlocked(type, user, dateFrom)`.

- [ ] **Step 1: Add the set and the guard — server**

```js
// OT is deliberately absent: the user confirmed 2026-09-21 that OT is the one claim that
// still applies while abroad. Everything else is covered by the flat daily allowance.
const ABROAD_NO_CLAIM_TYPES = new Set(['upcountry', 'late-out', 'long-distance', 'personal-car', 'holiday-work', 'early-morning']);

function abroadClaimBlockMessage() {
  return 'This day is covered by an approved Abroad request — only OT can be claimed';
}
```

Wire it into the same submit guards that already call the Company Trip / full-leave checks, for both `POST` and `PUT /api/leaves`.

- [ ] **Step 2: Mirror in app.js and gate the buttons**

Add the identical set, and hide/disable the Upcountry / Long Distance / Personal Car / Late-Out / Early Morning / Holiday Work row buttons on a date covered by an approved Abroad record — same visibility pattern the Company Trip check already uses.

- [ ] **Step 3: Syntax check and deploy**

```bash
cd "Z:/Time_Attendance" && node --check attendance/js/app.js && node --check attendance-server/backend/server.js && echo OK
```

```bash
cd "Z:/Time_Attendance/attendance-server/scripts/deploy" && python deploy_backend.py
```

- [ ] **Step 4: Verify each blocked type and the OT exception**

On an approved Abroad date, attempt each of the six blocked types via the API — each must be refused with the Abroad message. Then submit **OT** on the same date — it must be **accepted**. Confirm the row buttons are hidden in the UI too. **Revert everything.**

- [ ] **Step 5: Commit**

```bash
git add attendance/js/app.js attendance-server/backend/server.js attendance/index.html
git commit -m "feat(abroad): block non-OT claims on abroad days"
```

---

### Task 7: Settings UI, Japanese strings, and final verification

**Files:**
- Modify: `attendance/js/app.js` — allowance rate field (~2892), the save handler (~3558), eligibility matrix, approval routing UI, FAQ
- Modify: `attendance/lang/ja.js`
- Modify: `attendance/index.html` — cache-busters

**Interfaces:**
- Consumes: everything above.

- [ ] **Step 1: Add the rate field**

Next to the Upcountry field (~2892), following its exact shape:

```js
        field(L('Abroad (฿/day)','ทำงานต่างประเทศ (฿/วัน)'), inp('set-allow-abroad', s.allowances.abroad, 'number')),
```

and in the save handler (~3558):

```js
  APP_SETTINGS.allowances.abroad              = fi('set-allow-abroad');
```

- [ ] **Step 2: Add the eligibility row and the approval-routing row**

Both matrices are driven by their key lists, so adding `'abroad'` in Task 1 may render them automatically. Load the Settings page and check. If either needs an explicit label, add `Abroad` / `ทำงานต่างประเทศ` / `海外勤務`.

- [ ] **Step 3: Seed the live rate**

The live `settings.json` has no `allowances.abroad`. Set it to `1100` through the Settings UI (not by editing the file), and confirm it persists after a reload.

- [ ] **Step 4: Add the Japanese strings**

Add every fixed new string to `lang/ja.js` and bump its `?v=`. Interpolated strings use the inline `currentLang === 'ja'` branch.

- [ ] **Step 5: Add the FAQ entry**

Add an Abroad item to `_faqRulesItems()`, reading the rate live from `APP_SETTINGS` (never hardcode 1100), and scope its `roles` to whoever is actually eligible — see memory `feedback_attendance_faq_money_scoping`.

- [ ] **Step 6: Bump cache-busters, deploy, and run the full spec verification**

Run all nine checks from the spec's "Verification plan", in all three languages, with 0 console errors. Revert every test record and confirm the revert.

- [ ] **Step 7: Commit**

```bash
git add attendance/js/app.js attendance/lang/ja.js attendance/index.html
git commit -m "feat(abroad): settings, japanese strings and FAQ entry"
```

---

## Self-review notes

- Spec coverage: data model → T2/T3; not-absent → T4; allowance + both payslips → T5; claim blocking → T6; settings ×3 → T1 (routing/eligibility keys) + T7 (UI); i18n → T3/T4/T7; the two production traps → T1 steps 2 and 3.
- The `location` field name is `location` in every task. The payroll fields are `abroadDays` / `abroadTotal` in every task.
- Deductions need no work — confirmed in the spec; no task exists for them by design.
