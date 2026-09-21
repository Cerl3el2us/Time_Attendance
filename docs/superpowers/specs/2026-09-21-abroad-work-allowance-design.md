# Abroad Work Request + Allowance — Design

**Date:** 2026-09-21
**Status:** awaiting user review

## Problem

A day with no check-in and no check-out is derived as `absent`. Staff who travel abroad for work
cannot scan at the office device, so every day of the trip lands on the payslip as a day of
absence. There is currently no way to declare "I was working, just not at this building".

The company also pays an allowance for these trips, which the system does not know about at all.

## What we are building

A new request type — **Abroad** — that an employee submits for a date range. Once approved:

1. every date in the range stops being counted as absent, and
2. every date in the range earns an allowance (default **฿1,100/day**).

## Decisions taken (confirmed with the user, 2026-09-21)

| Question | Decision |
|---|---|
| Spelling | **Abroad** (user initially wrote "Aboard"; corrected — `abroad` everywhere, key and label) |
| Who may submit / be paid | Configurable in Settings, exactly like the other allowances |
| Approval route | Configurable in Settings, exactly like the other request types |
| Weekends / public holidays inside the range | **Paid** — every calendar day in the range earns the allowance |
| Other claims on an Abroad day | **OT only**. Everything else is blocked |

Two starting values, chosen by Claude and editable in Settings immediately after install:

- Eligibility: `['manager', 'user']` (same as Upcountry)
- Approval route: `['md']` — **corrected 2026-09-21 after reading the code**: every single type in
  `APPROVAL_ROUTING_DEFAULT` defaults to `['md']`, not `['manager','md']`. The array is the
  sequence of approver roles; `['manager','md']` is only the fallback for a legacy `true` value.
  Matching the house default keeps Abroad consistent with every other type.

## Approach

Implement `abroad` as a **new leave type inside the existing leave system** (`leaves.json`,
`/api/leaves`), not as a separate entity.

The leave system already provides, for free: a start/end date range (annual leave uses
`dateFrom`/`dateTo`), configurable approval routing, the approval queue, My Requests, edit and
cancel while pending, pay-period locks, Accounting-confirmed guards, push notifications, and the
per-day overlay that rewrites attendance status for approved records.

Alternatives rejected:

- **Separate `abroad.json` + its own endpoints** — would duplicate approval routing, locking,
  notification and audit machinery for no benefit.
- **Reuse `settings.companyTripDates`** — admin-set, not employee-submitted, so it cannot satisfy
  "a button for staff to declare a trip".

## Data model

New leave record, `type: 'abroad'`:

| Field | Notes |
|---|---|
| `dateFrom`, `dateTo` | required, `dateTo >= dateFrom`, range capped at 90 days |
| `location` | **required** — free text, length-capped. Either a country or a customer name is acceptable; the field hint says so (`เช่น ญี่ปุ่น หรือ ชื่อลูกค้า` / `e.g. Japan, or a customer name` / `例：日本、または顧客名`) |
| `reason` | required — what the work is |
| `status` | `pending-*` → `approved` / `rejected`, same lifecycle as every other type |

No quota is consumed. `leaveBalanceError()` already returns `null` for anything that is not
`annual` or `business`, so no change is needed there — but the type must **not** be added to the
leave-summary quota columns.

New attendance status string: `'abroad'` (sits alongside `leave-annual`, `company-trip`).

## Touch points

Every rule below exists in both `attendance/js/app.js` and
`attendance-server/backend/server.js` and **must be changed in both** — the payroll dual-sync rule.

### Registries to extend

| Symbol | File(s) | Change |
|---|---|---|
| `APPROVAL_ROUTING_DEFAULT` | both | add `abroad: ['manager', 'md']` |
| `TYPE_SCOPED_LEAVE_FIELDS` | server | add `abroad: ['location']` |
| `DATE_OVERLAP_LEAVE_TYPES` | server | add `'abroad'` — cannot be abroad and on leave the same day |
| `ALLOWANCE_KEYS` | both | add `'abroad'` |
| `MY_REQUEST_TYPES` | app.js | add `'abroad'` |
| `EDITABLE_LEAVE_TYPES` | app.js | add `'abroad'` |
| `LEAVE_TYPE_ICON` | app.js | add `abroad: '✈️'` |
### Settings validation — checked 2026-09-21

- `appSettings.allowances` and `appSettings.allowanceEligibility` are validated **generically**
  (any key, value must be a number 0–100000 / an array of known roles). Adding `abroad` needs **no**
  server validation change.
- `approvalRouting` is different: `ALLOWED_ROUTE_KEYS = Object.keys(APPROVAL_ROUTING_DEFAULT)`.
  If `abroad` is not added to the server's `APPROVAL_ROUTING_DEFAULT`, saving its route returns
  400 and the setting silently never persists. This is the same trap that broke the 50-Tawi
  SSF/PVD save on 2026-08-17 — do not repeat it.

### Not-absent behaviour

In the per-day generation loop (app.js `generatePeriodDays()`, server.js `computePayroll()`'s day
builder), overlay approved `abroad` records the same way approved annual leave is overlaid: for
each date within `dateFrom..dateTo`, set `status = 'abroad'`.

Unlike annual leave, the overlay **does not skip weekends** — the trip covers every calendar day.

Then add `'abroad'` to the status lists that already exclude non-working days:

- the `isWorkDay` exclusion list in app.js (`['holiday','leave-annual',…,'company-trip']`)
- the Long Distance row-button exclusion list
- status badge + label maps (badge colour, `Abroad` / `ทำงานต่างประเทศ` / `海外勤務`)
- `absentDays` counters must not count it (falls out automatically once status is no longer
  `absent`)

### Allowance

- Rate lives at `appSettings.allowances.abroad`, default `1100`.
- Paid days = count of dates in approved `abroad` records that fall inside the payroll period.
  All calendar days count, weekends and public holidays included.
- Gated on `isAllowanceEligible(S.allowanceEligibility, user.role, 'abroad')`.
- Added to the allowance total and shown as its own line on **both** payslips:
  - **Web / print payslip** (`app.js`) — a row in the earnings list.
  - **Excel payslip** (`payslipXlsx.js`) — an entry in `earningsItems`, wrapped in
    `canShow('abroad')` exactly like `holidayWork` / `upcountry`. The list already ends with
    `.filter(([, amount]) => (amount || 0) > 0)`, so a zero Abroad month drops out on its own,
    matching the other allowances.
- Mirrors the existing `const allowance1 = S.allowances.upcountry * totalUpcountryCount` pattern.

### Deductions — checked 2026-09-21, no work needed

Deductions already appear by themselves on both payslips, with line item and amount:

- **Web payslip**: SSF, PVD, PIT are fixed rows; each manual advance renders as
  `เบิกล่วงหน้า <type>`; `totalDeduct = ssf + pvd + pit + manualAdvanceTotal`.
- **Excel payslip**: same four, as `deductionItems`. SSF/PVD/PIT always print even at 0.00
  (deliberate — they recur monthly); advances print only when greater than 0.

The only money deductions the system has are those four. The late-arrival policy deducts **annual
leave minutes**, not money, so it never appears as a payslip deduction — and it is disabled in the
live settings today. Abroad adds no new deduction.

### Two traps that will break production if missed

1. `isAllowanceEligible()` falls back to `DEFAULT_ALLOWANCE_ELIGIBILITY[key].includes(role)` when
   the live settings have no entry for the key. Live `settings.json` has no
   `allowanceEligibility.abroad`, so adding `'abroad'` to `ALLOWANCE_KEYS` **without** also adding
   it to `DEFAULT_ALLOWANCE_ELIGIBILITY` in **both** files throws
   `TypeError: Cannot read properties of undefined` and takes the page down. The existing comment
   above that constant warns about exactly this.
2. `approvalRouting` validation, described above.

### superadmin / QA visibility — no special code

Request buttons are gated on the **selected employee's** `user.role`
(`isAllowanceEligible(APP_SETTINGS.allowanceEligibility, user.role, key)`), not on the logged-in
account's role. That is what already makes the existing buttons visible to superadmin in QA mode —
the on-screen note says "ปุ่มคำขอแสดงตามพนักงานที่เลือก (หรือตาม role ที่ดูเป็น) — บัญชีระบบยื่นคำขอจริงไม่ได้".

So building `canUseAbroad(user)` on the same helper makes the Abroad button visible to superadmin
automatically, with **zero superadmin-specific code**. superadmin still cannot actually submit —
that restriction is pre-existing and applies to every request type, not something Abroad adds.
To exercise the full submit → approve path, submit from a real employee account and approve as
MD/superadmin.

### Claim blocking

Add `'abroad'` handling so that on a date covered by an approved Abroad record the following are
refused, on both the client (button gating + submit guard) and the server (submit guard):

Upcountry, Long Distance, Personal Car, Late-Out (กลับดึก), Early Morning (มาเช้า), Holiday Work.

**OT remains allowed.**

This mirrors the existing `COMPANY_TRIP_NO_CLAIM_TYPES` / `FULL_LEAVE_NO_CLAIM_TYPES` sets; add a
third, `ABROAD_NO_CLAIM_TYPES`, containing every type above except `ot`.

Scan-derived bonuses (early/late) cannot trigger anyway with no device scans, but the explicit
guard keeps a stray scan from paying twice.

### Settings UI

Three additions, each following the existing pattern for the other allowances:

1. **Allowance Rates** — numeric field "Abroad" (฿/day), default 1100.
2. **Allowance Eligibility** — a row for `abroad` in the role matrix.
3. **Approval Routing** — a row for `abroad`.

### i18n

Every new string ships in Thai, English and Japanese together. Strings with interpolated values use
the inline `currentLang === 'ja'` pattern; fixed strings go in `lang/ja.js`.

Key labels: `Abroad` / `ทำงานต่างประเทศ` / `海外勤務`;
`Abroad Allowance` / `ค่าทำงานต่างประเทศ` / `海外勤務手当`.

## Out of scope

- Per-country allowance rates — one flat rate for now.
- Travel-time / flight-hour handling.
- Attaching tickets or itineraries — confirmed not wanted (2026-09-21).
- Any change to how salary is prorated — Abroad days are worked days, salary is untouched.

## Verification plan

Playwright against the live app, then revert all test data:

1. Submit an Abroad request spanning a weekend; confirm it appears in My Requests and the approval
   queue with the configured route.
2. Approve it; confirm every date in the range — weekend included — shows `ทำงานต่างประเทศ`, not
   `ขาดงาน`, on the attendance page and in the payslip.
3. Confirm **both** payslips show the Abroad allowance line at days × rate, weekend days included —
   the web/print payslip and the exported Excel payslip (open the .xlsx and read the earnings
   block). Confirm a zero-Abroad employee has no Abroad row on either.
4. Confirm `absentDays` on the payslip no longer counts those days.
5. On an Abroad date, confirm Upcountry / Long Distance / Personal Car / Late-Out / Early Morning /
   Holiday Work are refused and **OT is accepted**.
6. Change the rate in Settings and confirm the payslip figure follows it (no hardcoded 1100).
7. Remove a role from eligibility and confirm that role stops earning it.
8. Check all three languages render.
9. Confirm the cache-buster on `app.js` is bumped and the backend restart is verified (PID newer
   than `server.js` mtime) before any live write test.
