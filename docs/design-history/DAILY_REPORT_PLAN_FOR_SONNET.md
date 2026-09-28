# Daily Report feature — implementation plan

## Context

Sales (Teerawat, Ratanavalee) and Engineering (Somrak, Prida) currently keep a manual weekly
"Daily Report" in Excel and email it by hand — Sales's to the Managing Director (cc everyone),
Engineering's to the Manager (cc everyone). This feature replaces that manual workflow in-app:
submit once a week, auto-send the same routed email, let everyone except Marketing/Driver view it,
still allow CSV export for anyone who wants the old format.

This was originally scoped 2026-07-23 (see `Z:\attendance-server\DAILY_REPORT_PLAN_FOR_SONNET.md`)
and only one piece was ever built — the employee `dept` dropdown (fully complete, verified this
session, **not touched by this plan**: `index.html:1735-1743`, `app.js:5388/5482/5557/5585`).

This session the user supplied 6 screenshots of their actual working Excel files and asked for two
changes to the 2026-07-23 draft:
1. **The entry grid must have the real Excel's "feel"**, not the originally-drafted card-list form
   (7 day-blocks each with a "+ เพิ่มรายการ" button) — the user said that draft "looked hard to
   use."
2. **The Allowance/OT column must be automatically pre-filled** from approved
   Upcountry/Long-Distance/OT/Personal-Car requests for that day (not just offered as a
   click-to-insert suggestion) — but must stay freely editable afterward, never locked.
3. **The Place field should also auto-fill for Upcountry/Long-Distance** (confirmed in a follow-up
   this session): those two request types already capture a free-text location in their `reason`
   field when the employee submits them, so making them re-type the same place into the Daily
   Report's Place cell is pointless duplicate entry.
4. **Submission eligibility narrows to `role ∈ {user, manager}`, in addition to the existing
   `dept ∈ {Sales, Engineering}` check** (confirmed in a follow-up this session) — both conditions
   must hold. In practice every current Sales/Engineering employee is already role `user`, so this
   changes nothing today; it closes the theoretical gap where an md/accounting/marketing/driver
   account with its `dept` field set to Sales/Engineering could otherwise submit.

Checker routing and email to/cc were re-confirmed unchanged from the original 2026-07-23 design
(Sales → checked by md, cc'd to everyone active except marketing/driver, including the sender's own
Sales teammates; Engineering → checked by manager, same cc scope) — an earlier round of this
session's questions worried these might be changing too, but the user's answers converged back to
the original rule once fully spelled out.

The real templates (both the dense/informal one and the clean recurring one) share one column set,
and always render **one table row per calendar day**, with multiple same-day activities stacked as
aligned sub-lines within that row rather than exploded into separate day-rows. That structural fact
drives the grid design below (§4.2).

An Opus Plan-agent (per [[feedback_attendance_consult_opus_for_architecture]] — architecture
changes get planned with Opus first) designed the implementation after independently re-reading the
live code. Three things it found change the plan and are called out explicitly in §0 below because
they are easy to miss and would silently break the feature if skipped.

## §0 — Corrections found while designing (read before implementing)

- **F-1 (critical if skipped):** the sidebar nav in `index.html` is decorative only — `app.js`'s
  `fixStaticText()` (~line 9693) rebuilds `.sidebar-nav` from a JS template on every bootstrap *and*
  every language toggle (this exact trap has its own memory file,
  [[feedback_attendance_fixstatictext]]). **The new nav item must be added inside that JS template**
  (after the existing `reports` item, ~app.js:9769), or it will flash visible and then vanish on the
  first language switch. Adding it to `index.html` too is fine but purely cosmetic/redundant.
- **F-2:** the new Settings toggle must be a **top-level** key (`dailyReportPolicy`), mirroring
  `payslipEmailEnabled` exactly — `PUT /api/settings` 409s any body containing `appSettings` without
  a matching stamp, so do not nest this under `appSettings`.
- **F-3:** Katagiri (id 1, role `md`) is `active:false`; Takiuchi (id 2) is the only live MD. Email
  recipient resolution for Sales reports must filter `active !== false`, or mail silently goes
  nowhere.

## Data model — `Z:\attendance-server\backend\data\reports.json`

One record per (userId, weekStart), via the existing generic `readJSON()`/`writeJSON()` helpers
(`server.js:1046-1057`, already used for `settings.json`/`finalize.json`).

```jsonc
{
  "id": 1, "userId": 7, "dept": "Sales",       // dept forced server-side from live user record
  "weekStart": "2026-07-13", "weekEnd": "2026-07-19",
  "days": [                                     // ALWAYS exactly 7, Mon..Sun
    {
      "date": "2026-07-13", "dayName": "Mon",
      "dayType": "work",                        // work | weekend | holiday | leave-annual |
                                                 // leave-sick | leave-business | company-trip
      "dayLabel": "",                           // shown in PLACE cell for non-work days
      "activities": [                            // [] for non-work days, >=1 for work days
        { "place": "Rayong customer site", "placeAuto": true, "pic": "K.Miftahfarid",
          "details": "** Follow up quotation", "allowanceOt": "Upcountry",
          "allowanceOtAuto": true, "remark": "" }
      ]
    }
    // ...6 more
  ],
  "submittedAt": "2026-07-20T02:11:00.000Z", "updatedAt": "2026-07-20T02:11:00.000Z",
  "emailSentAt": "2026-07-20T02:11:03.000Z",   // null if send failed; never re-set on edit
  "checked": false, "checkedBy": null, "checkedByRole": null, "checkedAt": null   // ONE tick/week
}
```

`placeAuto`/`allowanceOtAuto` are internal bookkeeping (tracks whether that specific cell is still
following the live auto-fill or has been manually taken over) — never shown in CSV/email, not a
template column.

## Backend — `Z:\attendance-server\backend\server.js`

New `// ===== DAILY REPORTS =====` block after the leaves routes end (~line 1508), email builder
next to `buildPayslipHtml` (~line 2408) so it can reuse `emailShell()`/`escapeHtml()`.

- `readReports()`/`saveReports()` — thin wrappers over `readJSON('reports.json', [])`.
- `dailyReportEnabled()` — `readSettings().dailyReportPolicy?.enabled !== false` (defaults ON so the
  feature works on first deploy without a Settings visit, mirroring `payslipEmailEnabled`).
- **`GET /api/daily-reports`** — 403 for `marketing`/`driver` (live role lookup); everyone else gets
  the full list (gate is on writes only, not reads — see rationale below). Not gated on the enabled
  toggle, so turning the feature off stops new submissions without making history unreachable.
- **`POST /api/daily-reports`** — body `{weekStart, days}`. Forces `userId`/`dept` from
  `req.user.sub` + live user record (same anti-spoof rule as `POST /api/leaves`), 400 if
  `weekStart` isn't a Monday, 409 with `existingId` if that user already has a record for that week
  (client falls back to PUT), 403 if `dailyReportPolicy` is off or `!canSubmitDailyReport(live)` —
  `canSubmitDailyReport(u)` = `['Sales','Engineering'].includes(u.dept) && ['user','manager'].includes(u.role)`
  (both conditions, not dept alone — confirmed this session). Sends the routed email inside a
  try/catch so a mail failure never blocks the save; `emailSentAt` set only on actual success.
- **`PUT /api/daily-reports/:id`** — owner-only (`report.userId === live.id`), updates `days` +
  `updatedAt` only. Never touches `submittedAt`/`emailSentAt`/`checked*`. Sends no email (edits
  don't resend, per the confirmed 2026-07-23 rule) and does not clear an existing `checked` flag —
  the tick is informal/non-blocking by design, not a gate that should force re-review on every edit.
- **`PUT /api/daily-reports/:id/check`** — `requireRole('md','manager')` outer gate, then narrows:
  Sales report → md only, Engineering → manager only, anything else → 403.
- **`sanitizeDays()`** — the anti-abuse boundary since this data gets interpolated into email HTML:
  rebuilds the 7-day skeleton from `weekStart` server-side (never trusts client `date`/`dayName`),
  clamps `dayType` to the known enum, caps activities to 20/day and field lengths (place/pic/remark/
  allowanceOt 500 chars, details 4000), and drops any unknown keys from each activity object.
- **Email** — `to` = active (`!== false`) users with the checker role for that dept; `cc` = every
  active user except marketing/driver, minus whoever's already in `to`. Subject literally
  `Daily Report — {name} (Week of {weekStart})`. One English email regardless of recipients'
  language preference (unlike the pending-approvals digest's per-language bucketing) — the subject
  is a confirmed English literal and this is meant to be a single shared cc'd thread, not fragmented
  copies. Body reuses `emailShell()`, renders the same 8-column layout as **real HTML `<table>` +
  `rowspan`** (not the Payslip page's flex/gap-background trick — email clients don't render
  flex/grid), every interpolated string through `escapeHtml()`.

## Frontend — new page, grid, and wiring

**`index.html`** — new `<div id="page-daily-report" class="page">` inserted after `page-reports`
(before `page-payroll-history`), page id `daily-report` (deliberately distinct from the existing
unrelated `reports` page — "รายงานสรุปวันทำงาน"). Toolbar: employee selector (only relevant for
viewers who aren't Sales/Engineering themselves), week selector, Save/Submit buttons, CSV export,
print. Below that: an 8-column `<table class="dr-table">` with the exact template header labels
(Date/Day/Place/Customer Name (PIC)/Details/Allowance up country/OT/Remark/Check), styled TH/EN/JA
via the existing `data-en`/`data-th`/`LANG_JA` convention rather than literally stacking two
languages in one header cell like the screenshots — kept consistent with every other table in this
app; cheap to revisit later if the user prefers the literal bilingual-cell look.

**`css/style.css`** — new `dr-`-prefixed block modeled on two existing patterns already in this
codebase: the Payslip page's Excel-feel visual language (`style.css:1081-1266` — navy `#1e3a5f`
header bars, `#2563eb` accent bar, bordered box grid) for the sheet chrome/title bar, and the 50-Tawi
page's genuinely-editable table (`render50Tawi()`, `app.js:1104`, `.tawi-input` — real `<table>`
with bordered `<textarea>`/`<input>` directly in `<td>`) for the actual data-entry grid, since that
page needs real per-cell editing rather than the Payslip page's read-only display. `.dr-in[readonly]`
strips the border for the view-only rendering non-owners get — one markup path, two looks, no
separate read-only renderer to maintain.

**Grid structure (`app.js`, new `// ===== DAILY REPORT =====` section)** — the core design decision:
**one `<tr>` per activity; `<td rowspan>` merges the Date/Day cells across a day's activities; the
single per-week Check cell spans the whole `<tbody>` via one big rowspan.** This is what makes the
screenshots' "multiple stacked, line-aligned sub-entries per day" shape correct for free — the
browser's table layout keeps Place/PIC/Details/Allowance/Remark aligned row-by-row without any
manual line-splitting logic, and a `<textarea>` growing in one cell grows the whole activity row
together. Non-work days render as one shaded (`.dr-row-nonwork`) row with the day-type label
spanning the middle columns via `colspan`.

Auto-grow textareas, `+ line` / `×` controls per day, explicit Save/Submit buttons (not per-keystroke
autosave like 50-Tawi — one weekly report is a single coherent document, not independent per-cell
overrides, and per-keystroke PUTs on free text would hammer the file).

**Auto-fill (`dailyReportAutoFillDay(userId, dateStr)`)** — runs live at render time (not a
one-shot at creation), using the exact approved-lookup idiom already established elsewhere in this
codebase (`app.js:3846`: `DATA_LEAVES.filter(l => l.userId===X && l.type===Y &&
l.dateFrom===dateStr && l.status==='approved')`) against `upcountry`/`long-distance`/`ot`
(covers driver-ot, same `type:'ot'`)/`personal-car`, written into activity index 0. Two fields are
populated independently, each tracking its own auto/manual flag (`placeAuto`, `allowanceOtAuto`):
- **`place`** — only for `upcountry`/`long-distance` (the two types that capture an actual location
  in their `reason` field at submission time): set to that `reason` text directly, so the employee
  never re-types a place they already wrote once. `ot`/`personal-car` don't touch `place` — they
  aren't inherently about a location.
- **`allowanceOt`** — all four types contribute a concise tag: `upcountry` → "Upcountry" (the
  location itself is now in `place`, so it isn't repeated here); `long-distance` → "Long Distance:
  {distanceKm} km"; `ot` → "OT: {otHours}h ×{otMultiplier}"; `personal-car` → "Personal Car".
  Multiple matches on the same day join with newlines.

**Merge policy** (applies to each field independently): only overwrites the cell while its `*Auto`
flag is `!== false`; the moment a user types over either field, that field's flag flips to `false`
and the value is theirs permanently; clearing a field back to empty re-arms auto-tracking for that
field only — editing `place` never affects `allowanceOt`'s auto state or vice versa. This satisfies
"pre-filled, not just suggested" and "never silently overwritten" at the same time. An amber
`.dr-in-auto` tint marks whichever cells are still auto-tracked so the source is visually obvious
without locking anything.

**Nav/visibility wiring**:
- Nav item added inside `fixStaticText()`'s template (see F-1), class `no-report-hide`.
- `applyRolePermissions()` (`app.js:3186-3192`) extended in its **existing single pass** (adding a
  second pass previously caused a clobbering bug per that function's own comment) — hidden when
  `dailyReportPolicy.enabled === false` or role is marketing/driver.
- `navigateTo()` gets a guard alongside its existing ones, plus a title-map entry and render-dispatch
  line, following the same pattern as the `archive`/`tawi50` pages.
- Settings toggle (`dailyReportPolicy.enabled`, default true) cloned from the existing Payslip-email
  toggle section — load/save/PUT-body wiring in the same 3-4 spots that toggle already touches, plus
  an `applyRolePermissions()` call right after save so the nav updates without a reload.

**CSV export** — new `exportDailyReportCSV()` reusing `downloadCSV()`/`csvSafeCell()`
(`app.js:1224-1232`) verbatim, so BOM handling and formula-injection guarding come for free. One row
per activity (blank Date/Day/Check on continuation rows within a day, matching how the table looks).

**i18n** — every new string (8 headers, toolbar buttons, status chips, Settings section text, the
"Upcountry"/"Long Distance"/"Personal Car" auto-fill prefix words) gets TH/EN/JA from the start, per
standing project convention — not added as a follow-up.

## Decisions made while designing (flagged rather than silently picked)

- **Single weekly Check cell**: rendered as one `rowspan`-merged cell across the whole table (most
  faithful to the template's look while staying unambiguous that it's one tick, not per-day) — also
  mirrored as a status chip above the grid since a 44px merged cell is cramped on mobile.
- **Kill-switch scope**: blocks new submissions only; `GET` stays open to non-marketing/driver roles,
  so turning the feature off is "stop collecting", not "make history unreachable."
- **Editing after check doesn't clear the tick** — consistent with "informal, non-blocking," though
  worth a quick confirm with the user once they see it in practice, since the alternative
  (edit un-ticks, forcing re-check) is also defensible.
- **API path `/api/daily-reports`**, not `/api/reports` — the existing unrelated `reports` page/id
  makes `/api/reports` a confusing name; naming-only difference from the 2026-07-23 draft.

## Critical files

- `Z:\attendance-server\backend\server.js` — new `/api/daily-reports*` routes + `reports.json`
  helpers (insert ~line 1508), email builder (insert ~line 2408).
- `Z:\attendance\js\app.js` — new Daily Report section; nav item inside `fixStaticText()` (~9769);
  `applyRolePermissions()` (~3186); `navigateTo()` (~3263/3305/3336); Settings load/save/PUT wiring
  (mirror the existing `payslipEmailEnabled` touch-points); bootstrap loader alongside
  `loadLeavesFromBackend()`.
- `Z:\attendance\index.html` — new `#page-daily-report` container (after `page-reports`).
- `Z:\attendance\css\style.css` — new `/* DAILY REPORT */` block after the Payslip block; two lines
  added to the existing `@media print` block.
- `Z:\attendance\lang\ja.js` — JA entries for every new string.

## Verification (Playwright, existing QA accounts)

Accounts: `teerawat` (dept Sales), `somrak`/`prida` (dept Engineering), `takiuchi` (md),
`loesan` (manager, dept Operations — view-only case), `jaraspong` (driver, excluded),
`thitima` (marketing, excluded).

1. **Feature flag**: toggle off in Settings as `takiuchi` → nav disappears without reload for
   `teerawat`; direct `POST /api/daily-reports` still 403s even bypassing the UI; toggle back on →
   nav returns.
2. **Role exclusion**: `jaraspong`/`thitima` — no nav item, `GET /api/daily-reports` 403s directly.
3. **Nav survival**: on the Daily Report page as `teerawat`, cycle language TH→EN→JA→TH — nav item
   must still be present and `.active` after every switch (the F-1 regression check).
4. **Grid correctness**: current week shows 7 rows; weekend/holiday rows shaded with the label in
   the Place position; `+ line` on a day correctly grows the rowspan and keeps Place/PIC/Details
   line-aligned across the new rows.
5. **Auto-fill round-trip**: approve an Upcountry request for a day in the shown week → reload →
   that day's Place cell shows the request's `reason` text and the Allowance cell shows "Upcountry",
   both tinted; edit Place only → save → reload → Place keeps the manual text and loses its tint
   while Allowance stays auto-tracked (proves the two fields are independent); approve a second
   request (e.g. Personal Car) the same day → reload → the manually-edited Place is **not**
   overwritten, Allowance gains a second line; clear Place back to empty → reload → auto-fill
   returns for Place only.
6. **Submit/email/edit**: submit a full week → email arrives with the literal subject, correct
   to/cc (excluding Katagiri via the `active:false` filter, excluding marketing/driver from cc);
   re-submitting the same week 409s and falls back to a PUT; editing after submit does not
   re-trigger an email and does not clear an existing `checked` flag; a non-owner PUT 403s; a
   spoofed `userId`/`dept` in the POST body is ignored server-side.
7. **Single weekly check**: exactly one Check control per rendered report, rowspan spanning every
   row; Sales report checkable by `takiuchi` only (403 for `loesan`); Engineering report checkable
   by `loesan` only (403 for `takiuchi`).
8. **CSV/print/i18n**: exported CSV opens correctly in Excel with the 8 canonical headers and
   preserved multi-line Details; print view hides the toolbar and input borders; full TH/EN/JA
   coverage with no leaked English/Thai in the wrong mode.

## Separate, unrelated item that surfaced during this session — needs a decision before or after this build

A backgrounded Opus audit of the 2026-08-02 permission/export batch (unrelated to Daily Report)
just returned a **critical** finding: `POST /api/users` (`server.js:707-724`) has no role/field
whitelist, so a `manager`-role account can create a brand-new user with `role:'md'` directly via the
API (client only hides the "Add Employee" button, nothing enforces it server-side) and log in as a
full Managing Director. This is independent of everything in this plan and worth fixing regardless
of whether Daily Report proceeds — flagging here so it isn't lost, not proposing to fix it as part
of this plan.
