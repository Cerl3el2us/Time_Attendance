# Design decisions — 2026-09-26

Agreed with the owner during a long review session, working from interactive mockups rather than
descriptions. Nothing here is implemented yet; the live app is untouched by all of it.

**House rule that came out of this session:** keep "the owner decided" and "I proposed" as separate
lists. Silence is not agreement. See `feedback-attendance-dont-assume-approval` in memory.

## Direction

Keep the existing visual language — the blue gradient panel, the round green punch button, the
emoji, the pastel request tiles — and improve the craft inside it. Two attempts at a different
visual language were rejected ("ไม่สวยเลย ดูโบราณมาก", "ไม่ชอบทั้ง2แบบ ชอบแนวทางของเดิมที่ทำไว้มากกว่า").

Screens to design against: **employees use 14" notebooks**, so the real target is about
**1366×660** after browser chrome. Vertical space is the scarce resource, not width. Only the owner
has a 32" monitor and uses it rarely.

## Motion

Approved after trying a clickable demo. Everything under 300 ms, and every effect must do a job:
button press feedback, a success moment on punching in, new rows sliding in, skeletons instead of
blank space while loading, entrance stagger, hover lift. No scroll-triggered reveals, no springy
easing, no looping glows. `prefers-reduced-motion` turns all of it off.

## Dashboard — decided

- Two-column layout below the stat row (saves ~118 px; one screen instead of two).
- Announcement composer collapses to a "+ เขียนประกาศ" button; it currently occupies the top 481 px
  of the page while holding nothing.
- Hide the Hikvision connection strip — it is administrator information.
- Remove the "ใครอยู่ในออฟฟิศตอนนี้" list. It duplicates the "Check-in วันนี้" stat card, which is
  already clickable and opens the full list in a modal. Nothing is lost.
- Exchange-rate card: keep the real bank logos, add the actual TTB rate, add each bank's own update
  time, and add ▲▼ change indicators.
- Keep the 📷 / 🌐 scan-source icons. (I dropped them in a mockup; the owner caught it.)
- Check-in time in the status list: green, the same green as the "เข้างานแล้ว" pill. Red when late.
  **Not bold.** Check-out time always uses the same green.

### Rejected
- Renaming "ออก 14:14" to "สแกนล่าสุด 14:14" — keep "ออก".
- A fourth stat card for "วันลาคงเหลือของฉัน" — keep three.

### Owner's ruling on privacy
Every employee may see who is late. Raised because a mockup showed an individual's lateness on a
screen all staff can open; the owner confirmed that is intended.

## Login — decided

Real company logo on the card (switch `logo-long.jpg` → `logo-long.png`; the JPG has no
transparency, which is what produced the grey box behind it), a three-language switcher available
before login (none exists today), icons inside the fields rather than in attached grey boxes, a
custom checkbox, a press animation on the button, and no marketing column. No test credentials —
verified none remain.

## Settings — decided

Split 21 cards / 7,815 px into **six tabs**: บริษัท (2) · เงินเดือน & ภาษี (4) · เบี้ยเลี้ยง (3) ·
เวลาทำงาน & วันลา (5) · แจ้งเตือน & อีเมล (4) · ระบบ (3). Worst tab is 2.8 screens instead of 12.

Three things make tabs actually usable, and all were agreed:
- One Save button, pinned to the bottom of the viewport, saving the whole page as it does now.
- A dot on any tab holding unsaved edits, visible from every tab.
- On a validation failure, jump to the tab containing the bad field and highlight it — today a
  single bad value discards every edit on the page with a generic message.

## Payslip — decided

The controls card spans 1,036 px while the payslip document is 820 px and centred, so the left edges
sit 108 px apart. Fix: constrain this page's cards to the document's width and centre them. One CSS
rule; the document itself is not touched, because its proportions are meant for A4 printing.

## Version string — decided

`v1.0.0` is hardcoded in one line of `app.js` and has never changed across 74 commits. Replace it
with the deploy round — **Build 74** — derived from the commit count, plus a test that compares the
number in the file against `git rev-list --count HEAD` so it cannot silently go stale.

## Still open

- Check-in page: the direction was approved from a before/after mockup, but the individual changes
  were never itemised.
- Sidebar: 22 nav items, about 7 visible at a time on a 14" screen. Collapsible groups, shorter
  rows, or leave it — not decided.
- Other pages measured as over-long: attendance 4.2 screens, FAQ 3.8, holidays 2.9.
- Content width differs per page (1,036 / 860 / 820). A single standard would settle it, with
  document pages exempt.
- The ▲▼ indicators need the server to store each bank's last published rate and compare on the next
  fetch — roughly 15 lines, and the arrows only appear from the second publication onwards.
