# Long Distance: entering the mileage in two goes — design

**Owner's decision, 2026-10-16.** Agreed in chat before any code was written; every rule below was
answered by the owner directly, and the two places this document says "the owner chose" are the two
where a different reading would have produced a different system.

## The problem, in the owner's words

A driver has to enter the starting and ending odometer readings in one go. In practice the start is
entered when they are about to drive and the end when they finish — and if they did not write the
start down, by the time they are back they cannot remember it.

What actually happens on a working day:

- normally the start is entered before driving and the end after finishing, on the same day;
- the end may be entered **after midnight**, when work runs past it;
- sometimes both are entered at the end, in one go.

## What this must not break

The one-go path is not being replaced. It is what happens on most days and it keeps working
untouched. Two goes is an *additional* way in, not the new rule.

And the thing that must stay true either way, which the owner asked for explicitly: **a request
cannot be sent unless both readings are there.** Both engines already enforce it and neither check
is relaxed by this change —

- `submitLongDistance()` in `attendance/js/app.js` refuses on `isNaN(mStart) || isNaN(mEnd)` and on
  `mEnd <= mStart`;
- `server.js` (the `type === 'long-distance'` block in the POST `/api/leaves` validator) requires
  both, requires `me > ms`, and **derives `distanceKm` itself** rather than trusting the client.
  That derivation was added on 2026-08-13 after an audit found a forged `distanceKm` could claim
  the allowance for a trip whose real mileage never cleared the threshold.

Saving a start on its own therefore cannot be made to go through the request path, and this design
does not try to.

## The shape

**A saved start is not a request.** It is a small record of its own, and nothing else in the system
learns a new concept:

- the approval route, the two payroll engines, the My Requests badge, the approvals badge, cancel
  and revoke all keep seeing exactly the requests they see today;
- a half-finished entry cannot reach an approver or a payslip **because of the structure**, not
  because somewhere remembered to filter it out.

The request is created at the moment both readings exist — by the same code, with the same fields,
hitting the same server validator as it does today.

### Which day a saved start belongs to

The date is chosen in the form, the way every other request works (the owner asked for this
explicitly when the alternative — pinning it to "today" — was put to them). The existing
`longdistance-date` field already restricts the choice to days the person checked in on.

This also answers the after-midnight case without inventing a rule: the picker defaults through
`businessDateStr()`, and `businessDateFromYmd()` already treats anything before 05:30 as the
previous day (`BUSINESS_DAY_START_MINS = 330`, the same constant in both engines). A driver
finishing at 00:40 gets the day they started on, with no special case. A driver who leaves it
unfinished for two days simply picks that day in the form.

### Who sees a saved start

Only the person who saved it. The owner was asked and chose this: a saved start is not a request,
and a request is invisible to everyone else until it is sent.

The consequence is deliberate and worth stating plainly — **nobody is chasing unfinished entries.**
If a driver saves a start and never comes back, no allowance is claimed and no one is told. That is
the owner's call, not an oversight. If it should be visible to Accounting/MD later, that is an
addition, not a correction.

## Storage

`attendance-server/backend/data/mileage-open.json` — inside the gitignored data directory, like
every other live file.

A flat object keyed `"<userId>_<YYYY-MM-DD>"`, following `checkin-time-edits.json` and
`checkout-reviews.json`:

```json
{ "12_2026-10-16": { "mileageStart": 48210, "savedAt": "2026-10-16 08:40" } }
```

At most one row per person per day, which matches what the system already enforces: a day can carry
only one Long Distance request (`canSubmitLongDistanceForDate()` refuses a duplicate).

## API

Three routes, all authenticated, all acting on the caller's own rows only. Read failures answer 503
with the file's own message rather than an empty object, so a transient read is never mistaken for
"no saved start" — the pattern the other two stores already use.

| Route | Does |
|---|---|
| `GET /api/mileage-open` | the caller's own saved starts |
| `PUT /api/mileage-open` | save or replace one, body `{ date, mileageStart }` |
| `DELETE /api/mileage-open` | remove one, body `{ date }` |

`PUT` validates:

- `date` is a real `YYYY-MM-DD`;
- `mileageStart` is a finite non-negative number (`isFiniteNonNegNumber`, as the leave validator
  uses for the same field);
- the caller is eligible for the Long Distance allowance;
- the date is one they checked in on;
- no Long Distance request already exists for that date.

The last three are the same conditions `canSubmitLongDistanceForDate()` applies on the client, so a
start cannot be saved on a day a request could never be made for.

The system account cannot use any of the three, like every other submission path.

## The form

`attendance/index.html`'s Long Distance modal, unchanged except for one button and one hint.

| State | What the driver sees |
|---|---|
| No saved start for the chosen date | Today's form exactly as it is, plus a second button, **"บันทึกเลขเริ่มต้นไว้ก่อน"** |
| They press that button | The start is stored. No request, no approval, nothing to withdraw |
| They come back (including after midnight) | The start field is filled in and marked with when it was saved; only the end is left to type |
| Both readings present | Submit behaves exactly as today, and the saved row for that date is deleted |
| They never press the new button | Nothing changes at all |

The start stays editable in the second state — a misread odometer should be fixable without
clearing anything.

The date field drives the prefill: changing the date re-reads the saved start for the newly chosen
day.

On the attendance row, the Long Distance button is marked when that date has a saved start, so the
driver can see from the table that something is waiting to be finished.

## What is tested

- A request still cannot be created with one reading, or with an end at or below the start — pinned
  on **both** engines, so the new button cannot grow into a way around the rule.
- `PUT` refuses: a bad date, a negative or non-numeric reading, a day with no check-in, a day that
  already has a request, and an ineligible role.
- Saving, re-reading and deleting a row round-trips, and one person's row is invisible to another.
- Submitting deletes the saved row for that date.

## Not in this change

- No visibility for Accounting/MD, per the owner's decision above.
- No reminder, no expiry, no automatic cleanup of a start that is never finished.
- No change to the allowance threshold, the rate, or how the distance is derived.
