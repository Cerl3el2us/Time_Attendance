# Web Check-in GPS Geofence — Design

**Date:** 2026-09-25
**Status:** awaiting user review
**Amended 2026-09-26 (owner request):** the accuracy ceiling (`maxAccuracyM`, the `geofence-accuracy`
refusal) is removed. See "2026-09-26 amendment" below — it supersedes every mention of `maxAccuracyM`,
"±50 m", and "Accuracy too poor" further down in this document; those sections are kept for their
history (why 150 m was chosen, how the design got here) rather than rewritten.

## 2026-09-26 amendment — the accuracy ceiling is gone

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
| At the tower, a coarse ±1000 m fix that happens to report a point 800 m away | **allowed** (800 m is outside the old 150 m radius, and the accuracy check never even considered the point's own margin of error) | **refused** — `800 - 1000 = -200 <= 150` |
| At Amara Bangkok Hotel (268 m away) | refused if accuracy > 50 m (`geofence-accuracy`), before distance was even checked | refused only once accuracy reaches **118 m** (`268 - 118 = 150`); allowed up to 117 m |
| 700 km away, any accuracy | refused if accuracy > 50 m — an honest, low-end fix from a legitimate client visit was blocked for being imprecise, nowhere near the office | **always allowed** — there is no ceiling anywhere in the new rule |
| No accuracy reported at all (an old cached `app.js`) | refused (`geofence-accuracy`) everywhere, including far from the office | correct — accuracy absent counts as 0, so the point is trusted as reported |

The Amara tolerance is wider than before (118 m vs. the old 50 m ceiling) — more tolerant, which is
what the owner asked for — while the tower itself is, if anything, *harder* to spoof past with a
coarse fix, because a wide accuracy value now works against the claim instead of exempting it from
the distance check entirely.

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
| Minimum GPS accuracy to decide anything | ~~±50 m~~ — removed 2026-09-26, see amendment above: accuracy now widens the effective radius instead of gating on its own |
| No position / permission denied | **Refuse** the check-in |
| Accuracy worse than the threshold | ~~Refuse — treated exactly like "no position"~~ — removed 2026-09-26: there is no threshold any more |
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
| 4 | ~~No accuracy value, or accuracy > `maxAccuracyM`~~ — removed 2026-09-26 | — |
| 5 | `(distance from the office centre − accuracy, or 0 if missing/unusable) ≤ radiusM` | **refuse** (`geofence-inside`, policy message) |
| 6 | otherwise | allow |

*(Steps renumbered 2026-09-26: step 4's accuracy ceiling is gone; step 5 now folds accuracy into the
distance test itself, per the amendment above, instead of gating on it separately beforehand.)*

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

The check-in button states the reason before it is pressed rather than letting a press fail:

| State | Button | Text |
|---|---|---|
| Waiting for a usable fix | disabled | "Locating… ±120 m" (live) |
| Inside the radius | disabled | policy message (below) |
| Outside, accuracy good | normal | — |
| `driver` | normal | — (no change for drivers) |

A standing note sits on the check-in panel whether or not the button is blocked, so the rule is
visible before anyone is refused by it: **company policy is to check in with the face scanner at the
office; web check-in is for working away from the office.**

`watchPosition` with `enableHighAccuracy: true` is already in place (`app.js`), so accuracy improves
on its own over the first seconds — the disabled state is usually a short wait, not a dead end.

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
Two reasons: the gate needs it, and without it there is no way to review after the fact how good a
stored position was — the very gap that made the ±20 vs ±96 question unanswerable during design.

Accuracy is sanitised like the coordinates: a finite non-negative number, bounded, or absent.

The existing `'ไม่ทราบตำแหน่ง'` placeholder stays valid — a check-out with no position is still
accepted and still stored that way, because the gate never runs on a check-out.

**Backward compatibility (updated 2026-09-26):** a browser holding a cached copy of the old `app.js`
sends no accuracy at all. Under the original rule this was refused everywhere with the "not precise
enough" message, including far from the office — a false refusal, not a safe one. Under the current
rule, a missing accuracy counts as 0 (trust the point as reported), so a stale client now behaves
*correctly* instead of being refused; there is no longer a "safe by refusal" argument for bumping the
cache-buster on this account specifically, though it remains routine practice for this project.

## Testing

*(Updated 2026-09-26 for the accuracy-ceiling removal; see `tests/geofence.test.js`.)*

- Distance helper against known pairs, including Paso ↔ Amara = 268 m.
- At the tower, a check-in is refused (with a normal, precise fix).
- At the hotel: allowed with accuracy up to 117 m, refused from 118 m — the boundary the new rule
  draws (`268 − 118 = 150`).
- A coarse fix that reports a point *outside* the zone is still refused once its own margin of error
  reaches back inside it (e.g. 800 m away, ±1000 m accuracy) — the scenario the old ceiling let through.
- A position hundreds of kilometres away is allowed with any accuracy, including none at all.
- A missing/negative/unusable accuracy counts as 0, never as a refusal on its own.
- `driver` passes every branch, including inside the radius, including with no position at all.
- A check-out inside the radius is untouched — with a good fix, a poor fix, and no fix at all.
- No position or a malformed one → refused (`geofence-no-position`); `maxAccuracyM`/
  `geofence-accuracy` no longer exist to test.
- `enabled: false` restores today's behaviour exactly.
- `radiusM: 0` is honoured, not replaced by the 150 m default (falsy-zero guard).
- The client's copy of the rule agrees with the server's for the same inputs (dual-sync guard).
- `maxAccuracyM`/`set-geo-acc`/`geofence-accuracy` are asserted absent from both source files and
  from `ja.js`, not just untested.

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
