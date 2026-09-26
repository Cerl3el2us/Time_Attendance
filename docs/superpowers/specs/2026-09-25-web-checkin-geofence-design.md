# Web Check-in GPS Geofence — Design

**Date:** 2026-09-25
**Status:** awaiting user review
**Amended 2026-09-26 (owner request, twice in one day):** first the accuracy ceiling (`maxAccuracyM`,
the `geofence-accuracy` refusal) was removed and replaced with a distance-minus-accuracy rule — see
"2026-09-26 amendment" below. A review then found that rule itself defective (Critical 1: an
unbounded, accuracy-proportional exclusion zone that could refuse a check-in at Amara, the owner's
one named worry, from a coarse fix). The owner's second decision — **ignore accuracy in the gate
entirely** — is the rule that actually ships; see "2026-09-26 second amendment" below it. Both
sections supersede every mention of `maxAccuracyM`, "±50 m", and "Accuracy too poor" further down in
this document; those sections, and the first amendment itself, are kept for their history rather
than rewritten (with two factual errors the review also caught corrected in place — see the notes
inline).

## 2026-09-26 amendment — the accuracy ceiling is gone

> **Superseded a few hours later the same day.** This section describes the *first* fix (distance
> minus accuracy), not what ships. See "2026-09-26 second amendment" below for the rule that actually
> ships and why this one was replaced. Kept as the historical record of that first fix, with two
> factual errors a review caught (marked inline below) corrected rather than left standing.

The owner's own words, translated: *"I don't need much precision. I only want positions around Paso
to be unable to web check-in, to stop people claiming they came in to the office — because for a
check-in anywhere else I can already look at the position and see where they were. My only worry is
that too wide a radius would affect people who need to check in at Amara."*

`maxAccuracyM` served a precision requirement the owner never actually had, and it was actively
harmful: an honest employee at a client's site hundreds of kilometres away, with a phone reporting
±80 m, was refused before the distance check ever ran, and told to "move to an open area" — advice
that cannot fix a problem that was never about precision.

**The rule is now:** uncertainty counts *against* the claim to be elsewhere, instead of being a reason
to refuse outright.

```
d = distance from the reported point to the office centre
acc = reported accuracy, or 0 if missing/zero/negative/unusable
refuse (as 'geofence-inside') when (d - acc) <= radiusM
```

A missing or unusable accuracy is now treated as **0** — trust the point as reported — not as a
refusal. This is deliberate: accuracy is not a security control (a spoofed position can claim any
accuracy it likes), so treating its absence as "refuse" only ever punished honest, low-end phones.

Consequences, worked through with the real numbers (Paso ↔ Amara = 268 m, radius 150 m):

| Scenario | Old rule (`maxAccuracyM: 50`) | New rule |
|---|---|---|
| At the tower, ±20 m fix | refused (`geofence-inside`) | refused (`geofence-inside`) |
| At the tower, a coarse ±1000 m fix that happens to report a point 800 m away | **CORRECTED (review, Important 2):** refused — but **for the wrong reason**. `maxAccuracyM: 50` means accuracy 1000 > 50 is caught by the old step 4 (`geofence-accuracy`) *before distance is even checked* — the point being 800 m away, outside the old 150 m radius, never enters into it. *(Originally, incorrectly, written here as "allowed" — it was not; the old rule refused this case too, just via the accuracy ceiling rather than distance.)* | refused — `800 - 1000 = -200 <= 150` |
| At Amara Bangkok Hotel (268 m away) | refused if accuracy > 50 m (`geofence-accuracy`), before distance was even checked | refused only once accuracy reaches **118 m** (`268 - 118 = 150`); allowed up to 117 m |
| 700 km away, any accuracy | refused if accuracy > 50 m — an honest, low-end fix from a legitimate client visit was blocked for being imprecise, nowhere near the office | **always allowed** — there is no ceiling anywhere in the new rule |
| No accuracy reported at all (an old cached `app.js`) | refused (`geofence-accuracy`) everywhere, including far from the office | correct — accuracy absent counts as 0, so the point is trusted as reported |

The Amara tolerance is wider than before (118 m vs. the old 50 m ceiling) — more tolerant, which is
what the owner asked for. **CORRECTED (review, Important 2):** the claim originally made here — that
the tower itself became "harder to spoof past with a coarse fix" — was the opposite of true. Crediting
the device's own margin of error made the *effective refusal radius* `radiusM + accuracy`: a coarse,
large accuracy value widens the zone a coarse fix is caught in, it does not narrow it. That is exactly
the defect (Critical 1) that got this rule replaced a few hours later — see the second amendment below.

**What follows from this:**
- `maxAccuracyM` is removed everywhere: `DEFAULT_APP_SETTINGS.geofence` / `APP_SETTINGS.geofence`
  defaults, the `PUT /api/settings` validation block, the Settings card (`set-geo-acc` field and its
  label), the `saveSettingsPage()` read-back, and the now-unused `ja.js` keys.
- The `geofence-accuracy` reason code is removed everywhere: the server's 403 message map, the
  client's `geofenceMessage()` (which now only handles `geofence-inside` and `geofence-no-position`),
  and the TH/EN/JA strings that only existed for it.
- The stored accuracy itself is untouched — `sanitizeGpsAccuracy()`, the `gpsAcc` field on the event,
  and the reviewer's `±N m` display all stay exactly as they were. Only the *gate* stopped using
  accuracy as a ceiling; the owner still wants to see how good a fix was when reviewing a check-in
  after the fact.

## 2026-09-26 second amendment — accuracy removed from the gate entirely

**This is the rule that ships.** A few hours after the amendment above, a review found it defective:

> **Critical 1 — An accuracy-proportional exclusion zone.** The credited accuracy is unbounded, so
> the effective refusal radius is `radiusM + accuracy`: ±1,000 m → refused within ~1.15 km of Paso;
> ±5,000 m (iOS "Precise Location: Off") → refused across central Bangkok; ±50,000 m (desktop/IP fix)
> → refused across greater Bangkok. Concrete scenario: an employee at **Amara** — the owner's one
> named worry — with iOS Precise Location off, or on a laptop, gets `268 − 5000 = −4732 ≤ 150` →
> button disabled, text *"You are within the office area — please scan at the device."* They are
> 268 m away, cannot reach the 14th-floor scanner from the hotel, and on a device with no GPS the
> accuracy never improves. Attendance is simply not recorded.

The owner's second decision (asked and answered the same day): **trust the reported position; do not
use accuracy in the gate at all.** Reasoning, in the owner's own words, unchanged from the first
amendment: *"I don't need much precision. I only want positions around Paso to be unable to web
check-in... because for a check-in anywhere else I can already look at the position and see where
they were."* The owner accepts the trade-off this implies: someone standing at the office whose
device reports a coarse position outside the zone will pass the gate — caught, if at all, by
reviewing the recorded position afterwards, not by the gate itself.

**The rule is now a plain distance test, with no accuracy term of any kind:**

```
refuse (as 'geofence-inside') when distance(reported point, office centre) <= radiusM
```

`geofenceCheckinReason(G, role, lat, lng)` — the `accuracy` parameter is removed from the function
signature entirely, on both sides, rather than kept and ignored. Its callers changed to match:
`webScanGateReason()` (server.js) no longer receives or forwards a `gpsAccuracy` argument into the
gate; `geofenceUiState()` and `doScan()` (app.js) no longer read `currentGPS.accuracy` / `gpsAcc` for
this purpose. Everything above the distance test is unchanged from before either amendment: the
disabled switch, the exempt-roles check, and both `geofence-no-position` guards — no position is
still an outright refusal.

Consequences (superseding the table in the first amendment above):

| Scenario | Result |
|---|---|
| At the tower, any fix, any accuracy (including none at all) | refused (`geofence-inside`) |
| At Amara (268 m away), **any accuracy value at all** — including a desktop/IP fix (±50,000 m) or iOS Precise Location off (±5,000 m) | **always allowed** — this is the case the owner named explicitly, and the whole point of this second amendment |
| A desktop-style ±50,000 m fix reporting a point 5 km from the tower | allowed — the accuracy-proportional exclusion zone from the first amendment (which would have refused this) no longer exists |
| Hundreds of km away, any accuracy | allowed, as before |
| No position at all | still refused (`geofence-no-position`), unchanged |

This also resolves a related inconsistency the same review found (Important 1): under the first
amendment's rule, the client passed raw, unsanitised `currentGPS.accuracy` into the gate while the
server passed the sanitised value (`sanitizeGpsAccuracy()`'s output, capped and non-negative) — the
two could disagree above very large accuracy values. Removing accuracy from the gate on both sides
removes the disagreement by construction; there is no accuracy value left for the two sides to read
differently.

**Also fixed in the same pass (from the same review):**
- **Minor 2:** `PUT /api/settings` now `delete`s a stale `maxAccuracyM` key from the incoming
  `geofence` payload (not just stops validating it), so a client still holding an old cached settings
  snapshot — or a `settings.json` on disk saved before the removal — can never make the dead key
  persist forever through the deep-merge.
- **Minor 3:** the Settings card's standalone Radius field (it lost its `row2()` partner, and the
  12 px gap that came with it, when the accuracy field was removed) is re-wrapped in the same
  `margin-bottom:12px` div this page already uses for other single elements.

**What is still unchanged from both amendments:** `sanitizeGpsAccuracy()`, the `gpsAcc` event field,
and the `±N m` reviewer display are untouched by either amendment — the owner's audit trail, which
matters *more* now that the gate trusts the reported point outright, not less.

## Problem

The office is on the 14th floor of Paso Tower. Staff who arrive close to the start of the working
day cannot reach the face scanner upstairs in time, so they open the web app in the lobby — or in
the car park, or the lift queue — and press the web check-in button instead. The recorded time is
then the moment they reached the building, not the moment they reached the office, and they are not
marked late.

The owner's assessment (2026-09-25): this is the common case, not an occasional one.

Three facts make it possible today:

1. There is no geofence at all. `server.js` says so outright in the WebScan branch: "GPS is
   client-controlled and there is no geofence".
2. Web check-in works with **no position whatsoever** — if the browser refuses to give one, the
   client sends the string `'ไม่ทราบตำแหน่ง'` and the check-in is accepted (`app.js`, `doScan()`).
3. The accuracy of the fix is shown on screen but **never sent to the server**. `sanitizeGps()`
   accepts a bare `"lat,lng"` pair and nothing else, so there is no record of how trustworthy any
   stored position was.

Web check-in itself must stay — staff working upcountry, visiting clients, or abroad depend on it.
Only its use *at the office* is the problem.

## What we are building

A server-side gate on web **check-in** only: if the employee is within a configured radius of the
office, the check-in is refused and they are told the company policy is to use the face scanner.

## Decisions taken (confirmed with the owner, 2026-09-25)

| Question | Decision |
|---|---|
| Office centre | Paso Tower — `13.7268315, 100.52847` |
| Radius | **150 m**, editable in Settings |
| Minimum GPS accuracy to decide anything | ~~±50 m~~ — removed 2026-09-26 (first amendment), then accuracy was removed from the decision **entirely** the same day (second amendment): the gate now runs on distance alone |
| No position / permission denied | **Refuse** the check-in |
| Accuracy worse than the threshold | ~~Refuse — treated exactly like "no position"~~ — removed 2026-09-26: there is no threshold, and no accuracy term of any kind, any more |
| Who is exempt | **`driver`** — may check in from the web anywhere, including inside the radius |
| Check-out | **Not affected at all.** The gate runs on check-in only |
| Blocked attempts | **Not recorded.** Refuse and move on — no audit trail, no counter |
| Where it is enforced | **Server.** The client only previews the decision |
| Wording | Must state the company policy — check-in is done by face scan at the office |

## Why 150 m, and why ±50 m (original 2026-09-25 rationale — the ±50 m accuracy ceiling described here was removed 2026-09-26; kept for how the 150 m radius itself was chosen, which is unchanged)

The two numbers are linked, and both come from one measurement: **Amara Bangkok Hotel is 268 m from
Paso Tower** (haversine, from the two map pins the owner supplied). Staff legitimately check in from
the hotel sometimes, so the geofence must never reach it.

A reading from a phone that claims accuracy `a` can land anywhere within `a` metres of the truth.
That bounds the radius `R` from both sides:

- **Lower bound ≈ 80 m.** Someone standing at the tower (0–30 m away) can read as far out as
  30 + 50 = 80 m. Below that, people at the door escape the fence through noise alone.
- **Upper bound ≈ 218 m.** Someone standing at the hotel (268 m away) can read as close in as
  268 − 50 = 218 m. Above that, they are refused while genuinely off-site.

150 m sits inside that band with 68 m of margin at the hotel end. The accuracy threshold is what
keeps the arithmetic true: without it, a ±500 m fix could place a person at the tower "800 m away"
and pass. Hence the rule the whole design rests on — **if the system does not know where the
employee is, it does not let them check in from the web.**

The radius also sets the cost of the obvious workaround: walking out of the zone and back is ~300 m,
about four minutes, which is longer than the trip to the 14th floor it is meant to avoid.

## Server-side gate

In `POST /api/hikvision/event`, **WebScan branch only**. The physical device branch is untouched —
the scanner is the behaviour we want.

| Order | Condition | Result |
|---|---|---|
| 1 | Employee's live role is in the exempt list (`driver`) | allow |
| 2 | This scan would **not** become a check-in | allow |
| 3 | No position, or a malformed one | **refuse** (`geofence-no-position`) |
| 4 | ~~No accuracy value, or accuracy > `maxAccuracyM`~~ — removed 2026-09-26 (first amendment) | — |
| 5 | `distance from the office centre ≤ radiusM` — **no accuracy term of any kind** (second amendment) | **refuse** (`geofence-inside`, policy message) |
| 6 | otherwise | allow |

*(Steps renumbered 2026-09-26, twice: step 4's accuracy ceiling was removed by the first amendment;
step 5 briefly folded accuracy into the distance test itself (`distance − accuracy ≤ radiusM`) before
a review found that defective (an unbounded, accuracy-proportional exclusion zone — see the second
amendment above) and the owner ruled it out entirely. `geofenceCheckinReason()`'s `accuracy`
parameter is gone from the function signature, not merely unused.)*

**Step 2 must come before steps 3–5.** Check-out is explicitly out of scope, so it must not start
demanding GPS. Whether a scan becomes a check-in is derived the same way
`buildAttendanceLogForUser()` (server.js) already derives it, so the gate and the attendance log can
never disagree:

- before 05:00 → check-out (late-night return)
- no check-in yet and the time is at or after `CHECKIN_CUTOFF` → check-out (`not-clocked-in` day)
- no check-in yet, before the cutoff → **this is the check-in**
- otherwise → check-out / later scan

The role is read from the employee's live record, never from the request body — `hikAuth()` already
resolves the live user for exactly this reason.

Refusal is `403` with a machine-readable reason (`geofence-inside`, `geofence-no-position` — the
third reason, `geofence-accuracy`, was removed 2026-09-26 along with the ceiling that produced it)
so the client can show the right message and the tests can assert on it.

## Client behaviour

The check-in button states the reason before it is pressed rather than letting a press fail. **This
table is as of the second amendment** — accuracy no longer affects the button state at all; the two
tables originally drafted here for the pre-amendment and first-amendment designs (which both had an
accuracy-dependent "waiting for a usable fix" / "accuracy good" state) described states that no
longer exist and were replaced rather than kept for comparison, since a button-state table has no
useful "what the old wrong table said" reading the way the decision tables above it do:

| State | Button | Text |
|---|---|---|
| No position yet (still loading), or permission denied | disabled | "Web check-in requires your location…" |
| Inside the radius (`geofence-inside`) | disabled | policy message (below) |
| Outside the radius, position known | normal | — |
| `driver` | normal | — (no change for drivers) |

A standing note sits on the check-in panel whether or not the button is blocked, so the rule is
visible before anyone is refused by it: **company policy is to check in with the face scanner at the
office; web check-in is for working away from the office.**

`watchPosition` with `enableHighAccuracy: true` is still in place (`app.js`) and still improves the
reported accuracy over the first seconds, but that improvement no longer changes whether the button
is enabled — only whether a position exists at all does. The disabled-for-no-position state is
usually a short wait (until any fix arrives, not a *precise* one), not a dead end.

The client mirrors the server's rule. It is a preview only; the server decides. Both copies read the
same Settings values, and the distance helper must stay identical on both sides — this is the same
dual-sync discipline the payroll rules already follow.

## Messages (TH / EN / JA — all three from the start)

**Inside the radius**
- TH: นโยบายบริษัท: การลงเวลาเข้างานต้องสแกนใบหน้าที่เครื่องในออฟฟิศ — ขณะนี้คุณอยู่ในบริเวณออฟฟิศ (ห่างประมาณ X ม.) กรุณาสแกนที่เครื่อง
- EN: Company policy: check-in must be made with the face scanner at the office. You are within the office area (about X m) — please scan at the device.
- JA: 会社規定により、出勤打刻はオフィスの顔認証端末で行ってください。現在オフィス周辺（約X m）にいるため、Webでの出勤打刻はできません。

**No position**
- TH: เช็คอินผ่านเว็บต้องระบุตำแหน่ง — กรุณาอนุญาตให้เข้าถึงตำแหน่งในเบราว์เซอร์ หรือสแกนใบหน้าที่เครื่องในออฟฟิศ
- EN: Web check-in requires your location — please allow location access, or use the face scanner at the office.
- JA: Web出勤打刻には位置情報が必要です。ブラウザで位置情報を許可するか、オフィスの顔認証端末をご利用ください。

**Accuracy too poor — removed 2026-09-26**
This third message (and its `geofence-accuracy` reason code) existed only for the accuracy ceiling
described above. It no longer exists in any of the three languages: `geofenceMessage()` now only
branches on `geofence-inside` and `geofence-no-position`.

## Settings

One new `geofence` object, editable by MD on the Settings page:

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Master switch — turns the whole gate off if it misbehaves in production |
| `lat` / `lng` | `13.7268315` / `100.52847` | Office centre |
| `radiusM` | `150` | Refusal radius |
| ~~`maxAccuracyM`~~ | ~~`50`~~ | **Removed 2026-09-26** — the field, its Settings input (`set-geo-acc`), and its validation are gone; a dead setting that still looked meaningful was judged worse than none |
| `exemptRoles` | `['driver']` | Roles that may always check in from the web |

Values are validated server-side (lat/lng in range, radius positive and bounded, roles from the known
list). As with every other settings group, the UI sends the **complete** object, not a partial patch.

## Event payload

The client starts sending the accuracy alongside the coordinates, and it is stored on the event.
Originally this was for two reasons: the gate needed it, and without it there was no way to review
after the fact how good a stored position was. **Updated 2026-09-26 (second amendment):** the first
reason is gone — the gate does not read accuracy at all any more — but the second is unchanged and,
per the owner, matters *more* now: reviewing the recorded position after the fact is how a coarse fix
standing at the office (which the gate itself now lets through) gets caught, since the gate no longer
even tries.

Accuracy is sanitised like the coordinates: a finite non-negative number, bounded, or absent. This is
still true and unrelated to either amendment — `sanitizeGpsAccuracy()` was never part of the gate's
own decision, only of what gets stored for review.

The existing `'ไม่ทราบตำแหน่ง'` placeholder stays valid — a check-out with no position is still
accepted and still stored that way, because the gate never runs on a check-out.

**Backward compatibility (updated 2026-09-26, twice):** a browser holding a cached copy of the old
`app.js` sends no accuracy at all. Under the pre-amendment rule this was refused everywhere with the
"not precise enough" message, including far from the office — a false refusal. Under the first
amendment, a missing accuracy counted as 0 (trust the point as reported), which happened to also
behave correctly for this specific case. Under the rule that actually ships (the second amendment),
the question is moot: a stale client's missing accuracy is simply never read by the gate at all, same
as a fresh client's accuracy value — neither one affects the outcome. Bumping the `?v=` cache-buster
remains routine practice for this project regardless.

## Testing

*(Updated 2026-09-26, twice — for the accuracy-ceiling removal, then again for removing accuracy
from the gate entirely; see `tests/geofence.test.js`, currently 43 tests.)*

- Distance helper against known pairs, including Paso ↔ Amara = 268 m.
- At the tower: refused with a good/precise fix, refused with **no accuracy reported at all**, and
  refused with a coarse one (e.g. ±50,000 m) — accuracy must never change this outcome either way.
- At Amara (268 m away): **allowed at every accuracy value**, including desktop-style ±5,000 m (iOS
  Precise Location off) and ±50,000 m (IP/desktop fix) — this is the scenario the owner named
  explicitly, and the test must fail if anyone reintroduces an accuracy term that reads it.
- A desktop-style ±50,000 m fix reporting a point 5 km from the tower is allowed — the
  accuracy-proportional exclusion zone from the first (superseded) amendment would have refused this.
- A position hundreds of kilometres away is allowed, with or without any accuracy value.
- `driver` passes every branch, including inside the radius, including with no position at all.
- A check-out inside the radius is untouched — with a good fix, a poor fix, and no fix at all.
- No position or a malformed one → refused (`geofence-no-position`); `maxAccuracyM`/
  `geofence-accuracy` no longer exist to test, and `geofenceCheckinReason()` no longer has an
  `accuracy` parameter to pass one to.
- `enabled: false` restores today's behaviour exactly.
- `radiusM: 0` is honoured, not replaced by the 150 m default (falsy-zero guard).
- The client's copy of the rule agrees with the server's for the same inputs (dual-sync guard).
- `maxAccuracyM`/`set-geo-acc`/`geofence-accuracy` are asserted absent from both source files and
  from `ja.js`, not just untested; a stale `maxAccuracyM` sent in a `PUT /api/settings` payload is
  asserted to be stripped (Minor 2), not merely unvalidated.
- Verified by mutation: reintroducing an accuracy term (as if reverting to either the first amendment
  or the original ceiling) was confirmed to make the Amara-any-accuracy and 5 km-desktop-fix tests
  fail for the right reason (a `'geofence-inside'` where `''` is expected), then reverted.

## Out of scope

- **Office-network (IP) check.** `req.socket.remoteAddress` would identify anyone on the office LAN
  regardless of GPS, and the Hikvision allowlist already uses it. Held back as the response if
  position spoofing actually appears.
- **Offline check-in queueing.** Storing a check-in while offline means trusting a time the server
  never saw, which is a wider hole than the one being closed. Network failures are handled by the
  existing time-correction request, approved by MD.
- **Recording blocked attempts.** The owner decided against it.

## Known limits — and the owner's decision about them

A browser's position is supplied by the device and can be faked with a phone app in a few minutes.
The owner has weighed this and accepted it (2026-09-25): "if someone can fake it, let them" — the
company rule is unchanged either way, which is that attendance is recorded by face scan at the
office.

Two properties make that a reasonable position to take:

1. **Faking a position *into* the zone cannot help anyone.** The gate reads the reported position
   and nothing else, so a spoofed pin on Paso Tower is refused exactly like a real one. The only
   useful lie is a position far from the office.
2. **Every check-in that passes leaves its claimed position on the record**, reviewable on a map
   from the attendance row (`app.js`, the GPS button on web check-ins). A check-in claiming to be
   kilometres away, minutes before a face scan at the office door, contradicts itself in a way that
   is visible to anyone who looks.

Storing the accuracy improves that review: a genuinely poor phone fix and a spoofed one look
different, because spoofing apps typically report an implausibly precise value. The GPS popup should
show the stored accuracy alongside the coordinates for this reason.

It is a policy control, not a security boundary, and it is meant as one.
