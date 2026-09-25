# Web Check-in GPS Geofence — Design

**Date:** 2026-09-25
**Status:** awaiting user review

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
| Minimum GPS accuracy to decide anything | **±50 m** |
| No position / permission denied | **Refuse** the check-in |
| Accuracy worse than the threshold | **Refuse** — treated exactly like "no position" |
| Who is exempt | **`driver`** — may check in from the web anywhere, including inside the radius |
| Check-out | **Not affected at all.** The gate runs on check-in only |
| Blocked attempts | **Not recorded.** Refuse and move on — no audit trail, no counter |
| Where it is enforced | **Server.** The client only previews the decision |
| Wording | Must state the company policy — check-in is done by face scan at the office |

## Why 150 m, and why ±50 m

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
| 3 | No position, or a malformed one | **refuse** |
| 4 | No accuracy value, or accuracy > `maxAccuracyM` | **refuse** |
| 5 | Distance from the office centre ≤ `radiusM` | **refuse** (policy message) |
| 6 | otherwise | allow |

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

Refusal is `403` with a machine-readable reason (`geofence-inside`, `geofence-no-position`,
`geofence-accuracy`) so the client can show the right message and the tests can assert on it.

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

**Accuracy too poor**
- TH: ตำแหน่งยังไม่แม่นพอ (±X ม.) — กรุณารอสักครู่หรือขยับไปที่โล่ง
- EN: Your location is not precise enough yet (±X m) — please wait a moment or move to an open area.
- JA: 位置情報の精度が不足しています（±X m）。しばらく待つか、屋外や窓際へ移動してください。

## Settings

One new `geofence` object, editable by MD on the Settings page:

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Master switch — turns the whole gate off if it misbehaves in production |
| `lat` / `lng` | `13.7268315` / `100.52847` | Office centre |
| `radiusM` | `150` | Refusal radius |
| `maxAccuracyM` | `50` | Worst accuracy the gate will act on |
| `exemptRoles` | `['driver']` | Roles that may always check in from the web |

Values are validated server-side (lat/lng in range, radius and accuracy positive and bounded, roles
from the known list). As with every other settings group, the UI sends the **complete** object, not
a partial patch.

## Event payload

The client starts sending the accuracy alongside the coordinates, and it is stored on the event.
Two reasons: the gate needs it, and without it there is no way to review after the fact how good a
stored position was — the very gap that made the ±20 vs ±96 question unanswerable during design.

Accuracy is sanitised like the coordinates: a finite non-negative number, bounded, or absent.

The existing `'ไม่ทราบตำแหน่ง'` placeholder stays valid — a check-out with no position is still
accepted and still stored that way, because the gate never runs on a check-out.

**Backward compatibility:** a browser holding a cached copy of the old `app.js` sends no accuracy and
is refused at step 4 with the "not precise enough" message. Bumping the `?v=` cache-buster (already
routine for this project) and the service-worker cache version keeps that window short; the refusal
is safe rather than silently permissive.

## Testing

- Distance helper against known pairs, including Paso ↔ Amara = 268 m.
- Property: a position at the hotel with accuracy ≤ 50 m is **never** refused.
- Property: a position at the tower with accuracy ≤ 50 m is **always** refused for a check-in.
- `driver` passes every branch, including inside the radius.
- A check-out inside the radius is untouched — with a good fix, a poor fix, and no fix at all.
- No position, malformed position, missing accuracy, accuracy over the threshold → refused, each
  with its own reason code.
- `enabled: false` restores today's behaviour exactly.
- The client's copy of the rule agrees with the server's for the same inputs (dual-sync guard).

## Out of scope

- **Office-network (IP) check.** `req.socket.remoteAddress` would identify anyone on the office LAN
  regardless of GPS, and the Hikvision allowlist already uses it. Held back as the response if
  position spoofing actually appears.
- **Offline check-in queueing.** Storing a check-in while offline means trusting a time the server
  never saw, which is a wider hole than the one being closed. Network failures are handled by the
  existing time-correction request, approved by MD.
- **Recording blocked attempts.** The owner decided against it.

## Known limits

A browser's position is supplied by the device and can be faked with a phone app in a few minutes.
This gate raises the effort from "press a button" to "install and configure a spoofing app", and a
faked position leaves a contradiction in the record — a check-in claiming to be kilometres away
minutes before a face scan at the door. It is a policy control, not a security boundary.
