# Web check-out Late Night review — design

Date: 2026-09-23 · Status: owner-approved design, revised after Opus code review

## Problem

Late Night Out (🌙, ฿240 from 19:00 / ฿480 from 20:00, thresholds in Settings) pays only after a
**face-scanner** check-out:

- submit gate — `lateOutSubmitBlockReason` (server.js ~7316), `canSubmitLateNightForDate` (app.js ~13325)
- pay gate — `deviceScanQualifiesForLateNight` (server.js ~6894 / app.js ~1319, dual-sync), used by
  `computePayroll` on both sides and everything built on it (payslip web/xlsx/email, finalize,
  MD snapshot, reports, dashboard)

An employee who really worked late but checked out with the web/mobile button after 19:00 can
never claim. The owner wants Accounting/MD to review those days and, if genuine, unlock the claim.

## Owner decisions (2026-09-23)

- Reviewers: **Accounting and MD**, never on their own record.
- Outcomes **Allow** / **Deny**, reversible (clear) if pressed by mistake.
- Visible as a ⚠️ badge on the attendance-table row **and** a combined pending list on the
  Approvals page for MD/Accounting.
- After Allow the employee submits 🌙 normally; it follows the normal approval route (MD today).
  Allow is not an approval of the allowance.
- Check-out after midnight (00:00–04:59, same business day) **counts as Late Night at the top tier**
  but, like every Late Night, **only via a normal 🌙 request** — applies to device and web alike.
  (Today "00:30" is wrongly refused because the hour is compared as 0 < 19.)

## Trigger (dual-sync helper `checkoutReviewTrigger(day, user, S)`)

A day is reviewable when all hold:

- `day.checkIn` present, day not in the future
- effective `day.checkOutSource === 'web'` (time-corrections keep the original source)
- `lateNightCheckoutMins(day.checkOut) >= thr1 * 60`, where `lateNightCheckoutMins` adds 1440 to
  times before 05:00
- employee role eligible for the `earlyLate` allowance
- status not full-day personal leave, not `company-trip`, not `abroad`

## Data

New file `data/checkout-reviews.json` (not a settings key — avoids the deep-merge PUT hazard),
following the `announcements.json` pattern (`readJSON` / `writeJSON` atomic, new
`withCheckoutReviewsLock = makeHandlerLock('CHECKOUT_REVIEWS')`):

```json
{ "<userId>_<YYYY-MM-DD>": { "decision": "allow"|"deny", "checkOut": "HH:MM",
  "rawCheckOut": "HH:MM", "by": "<name>", "byId": 12, "at": "<ISO>" } }
```

- `checkOut` = effective (corrected) check-out that was reviewed; `rawCheckOut` = scanned time,
  shown to reviewers ("21:00 (corrected from 17:40)").
- A review applies only while the day's current effective check-out equals `checkOut`; a later web
  scan or an approved correction puts the day back to **pending**.
- Unreadable file: `computePayroll` **throws** "Service temporarily unavailable" (same as finalize /
  events), submit gate and PUT return 503. Never silently treat as "no review".

## How the rule reaches every site

`generatePeriodDays` sets two new day fields **after** the leave/time-correction overlay:
`checkOutReview` ('allow' | 'deny' | null — only when review.checkOut === day.checkOut and source is
web) and `rawCheckOut`.

- server: optional 8th param `reviews = {}` (callers `attendanceDayForUser`, `lateOutSubmitBlockReason`,
  `computePayroll` pass the loaded map)
- client: reads new global `DATA_CHECKOUT_REVIEWS` (like `DATA_LEAVES`)

New dual-sync `lateNightCheckoutOk(d) = isDeviceScanSource(d.checkOutSource) ||
(d.checkOutSource === 'web' && d.checkOutReview === 'allow')`, replacing the device-only test in
`deviceScanQualifiesForLateNight` (both files) → payroll, payslips, snapshot, reports and dashboard
follow automatically. Sites with their own inline source test also switch to it: app.js
`canSubmitLateNightForDate` (use the `generatePeriodDays` row; new reasons `web-pending` /
`web-denied`), `refreshLateOutGate` `deviceOk`, detail modal tag (~15279), table 🌙 badge (~7131)
and printed table (~7324). All threshold comparisons (server ~7335, app ~13342, ~13434, ~14024,
~13536) use `lateNightCheckoutMins`.

## Server-side hardening included

`lateOutSubmitBlockReason` also receives `lateOutTime` (from POST ~5171 and PUT ~5618) and refuses a
tier later than the actual check-out — today only the client checks this, so a 19:10 check-out can
claim the ฿480 tier via the API.

## API

- `GET /api/checkout-reviews` — `isLeaveFullAccess` (md/accounting/manager, as managers view others'
  attendance): all; others: own keys only.
- `PUT /api/checkout-reviews` `{userId, date, decision: 'allow'|'deny'|null}` —
  `requireRole('md','accounting')` (observers/inactive already refused; superadmin inheritance
  unchanged), lock held. Refuse self; re-derive the day with `attendanceDayForUser` + reviews and
  require `checkoutReviewTrigger`; refuse when settings read fails, or `lockedPeriodInRange` /
  `accountingConfirmedInRange` / `mdApprovedPeriodInRange` for that date — on every decision incl.
  clear. Store server-derived `checkOut` / `rawCheckOut`. Broadcast `{type:'CHECKOUT_REVIEWS_UPDATED'}`
  **with no payload**; clients re-fetch the scoped GET.
- Deny never touches leaves.json: an approved 🌙 simply stops paying while the review is deny.

## UI (TH/EN/JA)

- Attendance row, trigger day:
  - MD/Accounting on someone else's row (not observer, `blockIfObserver()` on click; hidden for
    locked/confirmed/MD-approved periods via `payPeriodBlockedForDate`): `⚠️ ตรวจสอบ (เว็บ)` +
    ✅ / ❌ when pending; `✅ อนุญาตแล้ว` / `❌ ไม่อนุญาต` + undo when reviewed.
  - Employee: `⏳ รอบัญชีตรวจสอบ` / `✅ ตรวจแล้ว ยื่น 🌙 ได้` / `❌ ไม่อนุญาต`; if denied and a 🌙
    exists: "🌙 not paid — check-out not allowed".
- Deny when a non-rejected 🌙 exists for that day → confirm dialog first.
- Approvals page (MD/Accounting): "Web check-outs awaiting review" box built client-side with the
  shared trigger helper (name, date, check-out, raw time, ✅/❌); hidden when empty.
- Late-out modal refusal text distinguishes pending / denied.
- WS `CHECKOUT_REVIEWS_UPDATED` → re-fetch, re-render attendance/dashboard/approvals/payslip/reports.
- `exportDataBackup` includes the reviews.
- FAQ: both Late Night entries (~17681, ~17852) — web check-out review, after-midnight counts,
  a later web tap after a device scan makes the day web (needs review).

## Testing

- Unit, both copies: `lateNightCheckoutOk`, `lateNightCheckoutMins`, `checkoutReviewTrigger`
  (device; web+allow match; web+allow stale time; deny; none; 00:30; tier later than check-out).
- Parity: server vs client `computePayroll` for web+allowed day with approved 🌙, then after deny.
- Live (Playwright, QA accounts, all test data reverted): buttons only for MD/Accounting on others'
  rows, not observers; PUT refused for self / non-trigger day / locked period; employee socket gets
  no review details; employee sees statuses.
