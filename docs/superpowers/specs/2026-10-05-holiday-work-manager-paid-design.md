# Holiday Work for managers, without the cash option

**Date:** 2026-10-05
**Status:** approved by the owner, ready to plan

## The problem

`allowanceEligibility.holidayWork` is `['user']` in the live settings, so only staff can file a
Holiday Work request. The owner wants managers to be able to file one, but managers must only be
able to take the compensation as **one extra annual-leave day** — never as money (OT + holiday
transport).

The compensation mode is a field on the request (`compensationMode`: `annual-leave` | `paid`), and
today any eligible role can pick either.

## Decision

Add a second role list beside the existing one, in the same Settings table, and gate the `paid`
mode on it.

| Eligibility key | Means | Ticked for |
|---|---|---|
| `holidayWork` (exists) | may file a Holiday Work request | add `manager` |
| `holidayWorkPaid` (new) | may choose "ชดเชยเป็นเงิน" | `user` only |

Read as a sentence: *a manager may file a Holiday Work request, but may not take it as money.*

### Why a role list and not a per-employee flag

The owner asked whether to copy the phone-allowance pattern (a role list plus a per-employee
checkbox, `user.phoneAllowanceEligible`). We are not copying it.

The code comment on the phone allowance explains why that one went per-employee: phone allowance
"has zero real correlation with role" — within one role some people get it and some do not. The rule
here is the opposite: it is a statement about the rank. A per-employee flag would mean somebody has
to remember to tick it for every new manager, and forgetting it silently grants the cash option.

A per-employee layer can be added on top later if a real exception appears. Nothing in this design
blocks that.

### Why this table

`allowanceEligibility` is already a map of key → list of roles, already validated server-side, and
already rendered as a role×allowance checkbox grid under Settings → 🎫 สิทธิ์เบี้ยเลี้ยงตามระดับผู้ใช้.
A new key costs one row and no new machinery. The existing warning on that screen — changes only
affect pay periods the MD has not yet approved — applies to the new row unchanged.

## The sub-row and its dependency

`holidayWorkPaid` is meaningless unless `holidayWork` is also ticked for that role. The UI must say
so, and the logic must not depend on the UI saying so.

**1. Visual.** The new row renders indented under its parent with a `└` connector and the hint
"ต้องเปิดสิทธิ์ยื่นด้านบนก่อน". It reads as a sub-row, not a sibling.

**2. Interactive.** Both directions are handled live, before any save:

| Action | Result |
|---|---|
| tick child while parent is unticked | parent is ticked too, **and the change is made visible** |
| untick parent while child is ticked | child is unticked too (no announcement needed) |
| tick parent alone | child does not move |

The auto-tick must not be silent. Ticking the narrower permission grants the broader one as a side
effect; the person setting it must see that more changed than they clicked. A brief highlight on the
parent checkbox or a one-line note ("เปิดสิทธิ์ยื่นทำงานวันหยุดให้ด้วยแล้ว") is enough.

An earlier draft disabled the child checkbox until the parent was ticked. The owner rejected it:
a dead control makes the person hunt for the reason. Auto-ticking expresses the same intent in one
click.

**3. Logic.** The paid-mode check always requires the parent too:

```
mayChoosePaidHolidayWork(role) =
  isAllowanceEligible(S.allowanceEligibility, role, 'holidayWork') &&
  isAllowanceEligible(S.allowanceEligibility, role, 'holidayWorkPaid')
```

This is the layer that matters. Settings can be edited outside this screen — by hand in
`settings.json`, or by an older client that does not know about the sub-row — and inconsistent data
must not grant anything. Without this, the grid could look right while the system quietly allowed
the cash option.

## What changes on screen

**Holiday Work request form.** When the submitter may not choose `paid`:

- the Compensation Mode `<select>` offers only "ลาพักร้อน +1 วัน"
- the two-card pay comparison (`#hw-pay-compare`) is hidden — one card alone looks broken
- the hint line under the select says the leave-day outcome only

**Settings.** One new row in the eligibility grid, indented under `ทำงานวันหยุด`.

## Server

`server.js` validates `compensationMode` as `annual-leave | paid` on create and edit. It must also
reject `paid` from a submitter whose role fails `mayChoosePaidHolidayWork`. The client hiding the
option is a convenience, not a control.

## Data

No migration. Every existing Holiday Work record belongs to a `user`-role employee (verified live on
2026-10-05: one record, user id 7, role `user`), so no stored request contradicts the new rule.

## Dual-sync

`isAllowanceEligible` and the new `mayChoosePaidHolidayWork` exist in both `attendance/js/app.js` and
`attendance-server/backend/server.js` and must stay identical. `ALLOWANCE_KEYS`, the
`DEFAULT_ALLOWANCE_ELIGIBILITY` map, and the hardcoded Settings table rows must all gain the new key
— there is an existing comment in `app.js` warning that a key present in `ALLOWANCE_KEYS` but absent
from the table silently saves as `[]` (nobody eligible) on the next save.

## Tests

- `mayChoosePaidHolidayWork` is false when either list omits the role, true only when both include it
- a `paid` request from a role without the permission is refused by the server
- an `annual-leave` request from a manager is accepted
- ticking the child in Settings also ticks the parent; unticking the parent also unticks the child
- a settings file with `holidayWorkPaid` ticked and `holidayWork` not ticked grants nothing

## Out of scope

- a per-employee override
- giving MD or any other role Holiday Work
- changing how either compensation mode is calculated
