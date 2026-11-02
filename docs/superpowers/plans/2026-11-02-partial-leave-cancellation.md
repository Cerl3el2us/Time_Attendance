# Partial Leave Cancellation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ให้พนักงานยกเลิกวันลาที่อนุมัติแล้วเฉพาะวันที่ยังไม่มาถึง โดยหด `dateTo` ของใบเดิมและแยกวันที่ยกเลิกออกเป็นรายการ `cancelled` คู่กัน

**Architecture:** เพิ่ม endpoint `POST /api/leaves/:id/shorten` ตัวเดียว เขียนข้อมูลสองรายการในการล็อกและการเซฟครั้งเดียว ใช้ฟังก์ชันที่มีอยู่แล้วทั้งหมด (`deriveLeaveDaysCount`, `addDaysToDateStr`, ด่านงวดเงินสามตัวของ `revoke`, รูปแบบฟิลด์ `cancelled`/`cancelledWith` ของทางเดิน cancel เดิม) ไม่สร้างกลไกใหม่ ฝั่งหน้าจอเพิ่มปุ่มเดียวข้างปุ่มยกเลิกเดิม

**Tech Stack:** Node + Express (ไฟล์เดียว `attendance-server/backend/server.js`) · frontend เป็น vanilla JS ไฟล์เดียว `attendance/js/app.js` · เทสต์ไม่มี framework: `node tests/<ชื่อ>.test.js` ดึงฟังก์ชันจริงออกจาก source เข้า `vm` sandbox (`extractFunction`) และตรวจ route ด้วยการจับข้อความใน source

**เอกสารออกแบบ:** `docs/superpowers/specs/2026-11-02-partial-leave-cancellation-design.md` — อ่านก่อนเริ่ม

## Global Constraints

- **ห้ามแก้ไฟล์ใน `Z:\Time_Attendance`** นั่นคือเว็บจริง เซฟปุ๊บผู้ใช้เห็นปั๊บ · แก้ใน worktree ของเครื่องนี้เท่านั้น
- **ประเภทลาที่รองรับรอบนี้: `annual`, `sick`, `business` เท่านั้น** ใช้ `DAY_BASED_LEAVE_TYPES` (`server.js:6253`) ที่มีสามตัวนี้พอดี · ห้ามแตะ `abroad`, `holiday-work`
- **ยกเลิกได้แต่วันอนาคต** — `returnDate` ต้อง `>` วันนี้ตามปฏิทินกรุงเทพ (`bangkokDateStr()`)
- **สถานะของรายการที่แยกออกมาคือ `cancelled`** ไม่ใช่ `revoked` (`revoked` สงวนไว้ให้ md/accounting — นิยามที่ `app.js:2617`)
- **ทุกข้อความใหม่ต้องมี 3 ภาษา TH/EN/JA** ตามแบบที่ไฟล์ใช้อยู่ (`L(en, th)` และ `currentLang === 'ja' ? ... :`)
- **ทุกกฎที่ฝังในโค้ดต้องมีคอมเมนต์กำกับ** ลงวันที่ `2026-11-02` + ระบุว่าเจ้าของตัดสิน + บอกว่าของเดิมติดที่ไหน
- **ฟังก์ชันที่มีฝาแฝดสองฝั่งต้องมีคอมเมนต์ `DUAL-SYNC`** ตามแบบ `server.js:8069` และ `server.js:8134`
- **บัมพ์ cache-buster** ที่ `attendance/index.html:2833` (`js/app.js?v=...`) เป็นขั้นสุดท้ายก่อนปิดงาน ไม่งั้นเบราว์เซอร์ผู้ใช้รันของเก่า
- **`npm run check` ต้องเขียวทั้งชุด** ก่อนบอกว่าเสร็จ (ตอนเริ่มงานวันนี้ผ่าน 66/66 ไฟล์)
- **ห้าม merge เข้า `main` เองโดยไม่ขอเจ้าของ** · push ขึ้น origin ไม่ต้องขอ

## File Structure

| ไฟล์ | หน้าที่ | สิ่งที่เปลี่ยน |
|---|---|---|
| `attendance-server/backend/server.js` | ตัวตัดสินทุกกฎ | เพิ่ม `isShortenableApprovedLeave()` ข้าง `isCancellableApprovedLeave()` (`:8069`) · เพิ่ม route `POST /api/leaves/:id/shorten` ต่อท้าย route `revoke` (ก่อน `:9261`) |
| `attendance/js/app.js` | หน้าจอ + ตัวเลขที่พนักงานเห็นก่อนกด | เพิ่ม `deriveLeaveDaysCount()` (ฝาแฝดของเซิร์ฟเวอร์) และให้ `submitLeave()` (`:19596`) เรียกมันแทนลูปฝัง · เพิ่ม `isShortenableApprovedLeave()` ข้าง `isCancellableApprovedLeave()` (`:4449`) · เพิ่ม `shortenLeave()` ข้าง `cancelLeave()` (`:22608`) · เพิ่มปุ่มที่ `:22516` |
| `tests/leave-partial-cancel.test.js` | เทสต์ของงานนี้ทั้งหมด | ไฟล์ใหม่ ใช้แบบเดียวกับ `tests/cancel-revoke.test.js` |
| `attendance/index.html` | cache-buster | บัมพ์เลข `?v=` |

---

### Task 1: ตัวนับวันทำงานฝั่งเบราว์เซอร์ให้เป็นฟังก์ชันเดียวกับเซิร์ฟเวอร์

**ทำไมต้องมีขั้นนี้ก่อน:** ตัวเลข "คืนโควตากี่วัน" ในคำยืนยันต้องตรงกับที่เซิร์ฟเวอร์จะคำนวณเป๊ะ ตอนนี้ลูปนับวันของเบราว์เซอร์ฝังอยู่ใน `submitLeave()` เรียกจากที่อื่นไม่ได้ ถ้าปล่อยไว้แล้วไปเขียนลูปที่สองในฟังก์ชันใหม่ จะได้สองก๊อปที่เพี้ยนกันเงียบๆ ซึ่งเป็นกับดักที่โปรเจกต์นี้เจอมาแล้ว

**Files:**
- Modify: `attendance/js/app.js` — เพิ่มฟังก์ชันใหม่ก่อน `isCancellableApprovedLeave()` ที่ `:4449` และแก้ `submitLeave()` ที่ `:19593-19597`
- Test: `tests/leave-partial-cancel.test.js` (สร้างใหม่)

**Interfaces:**
- Produces: `deriveLeaveDaysCount(dateFrom, dateTo) -> number` ใน `app.js` — ฝาแฝดชื่อเดียวกับ `server.js:6281` คืนจำนวนวันทำงาน (ข้ามเสาร์-อาทิตย์และวันหยุดนักขัตฤกษ์) ใน `dateFrom..dateTo` (รวมปลายทั้งสอง) · `dateTo` ว่างให้ถือว่าเท่ากับ `dateFrom`

- [ ] **Step 1: เขียนเทสต์ที่ต้องแดงก่อน** — สร้าง `tests/leave-partial-cancel.test.js`

```js
// Partial cancellation of an approved leave (2026-11-02, owner's request): an employee may give
// back the days of an approved annual/sick/business leave that have not arrived yet. The record's
// dateTo shrinks and the cancelled tail becomes its own 'cancelled' row (cancelledWith -> the
// original). No framework: `node tests/leave-partial-cancel.test.js`. Same extraction approach as
// tests/cancel-revoke.test.js: real functions from both sources in a vm sandbox.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const APP_SRC = fs.readFileSync(path.join(ROOT, 'attendance/js/app.js'), 'utf8');
const SERVER_SRC = fs.readFileSync(path.join(ROOT, 'attendance-server/backend/server.js'), 'utf8');

function extractFunction(src, name) {
  const re = new RegExp(`^(async )?function ${name}\\(`, 'm');
  const m = re.exec(src);
  if (!m) throw new Error(`function ${name} not found`);
  const i = src.indexOf(') {', m.index) + 2;
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (depth === 0) return src.slice(m.index, j + 1); }
  }
  throw new Error(`unbalanced ${name}`);
}

// 2026-11-02: one public holiday inside the window on purpose -- a plain weekday count would
// pass every assertion below without ever exercising the holiday skip.
const HOLIDAYS = new Set(['2026-11-04']);
const localDateStr = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

function makeClientDays() {
  const ctx = { isPublicHoliday: s => HOLIDAYS.has(s), localDateStr };
  vm.createContext(ctx);
  vm.runInContext(extractFunction(APP_SRC, 'deriveLeaveDaysCount'), ctx);
  return ctx;
}
function makeServerDays() {
  const ctx = { isPublicHoliday: s => HOLIDAYS.has(s), ta_localDateStr: localDateStr };
  vm.createContext(ctx);
  vm.runInContext(extractFunction(SERVER_SRC, 'deriveLeaveDaysCount'), ctx);
  return ctx;
}

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok  ${name}`); }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; }
}

console.log('day counter: one function, both sides');
test('client and server count the same working days for every range', () => {
  const C = makeClientDays(), S = makeServerDays();
  const ranges = [
    ['2026-10-30', '2026-11-05'],  // Fri..Thu, spans a weekend and the 04 holiday
    ['2026-10-30', '2026-11-02'],  // the kept half of the owner's real case
    ['2026-11-03', '2026-11-05'],  // the cancelled half
    ['2026-10-31', '2026-11-01'],  // Sat..Sun only -> 0
    ['2026-11-04', '2026-11-04'],  // the holiday alone -> 0
    ['2026-11-03', '2026-11-03'],  // a single plain weekday -> 1
  ];
  for (const [from, to] of ranges) {
    assert.strictEqual(C.deriveLeaveDaysCount(from, to), S.deriveLeaveDaysCount(from, to), `${from}..${to}`);
  }
});
test('expected counts (weekend and the 04 holiday both skipped)', () => {
  const C = makeClientDays();
  assert.strictEqual(C.deriveLeaveDaysCount('2026-10-30', '2026-11-05'), 4); // 30, 02, 03, 05
  assert.strictEqual(C.deriveLeaveDaysCount('2026-10-30', '2026-11-02'), 2); // 30, 02
  assert.strictEqual(C.deriveLeaveDaysCount('2026-11-03', '2026-11-05'), 2); // 03, 05
  assert.strictEqual(C.deriveLeaveDaysCount('2026-10-31', '2026-11-01'), 0);
  assert.strictEqual(C.deriveLeaveDaysCount('2026-11-04', '2026-11-04'), 0);
});
test('a missing dateTo counts the single dateFrom', () => {
  const C = makeClientDays();
  assert.strictEqual(C.deriveLeaveDaysCount('2026-11-03', ''), 1);
  assert.strictEqual(C.deriveLeaveDaysCount('2026-11-03', undefined), 1);
});
test('submitLeave() uses the helper instead of keeping its own copy of the loop', () => {
  const i = APP_SRC.indexOf('async function submitLeave()');
  assert.ok(i > 0, 'submitLeave not found');
  const body = APP_SRC.slice(i, APP_SRC.indexOf('\nasync function ', i + 10));
  assert.ok(body.includes('deriveLeaveDaysCount('), 'submitLeave must call the shared helper');
  assert.ok(!/while \(d <= end\)/.test(body), 'the inline day-count loop must be gone from submitLeave');
});

console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ', 0 failed'}`);
```

- [ ] **Step 2: รันให้เห็นว่าแดง**

Run: `node tests/leave-partial-cancel.test.js`
Expected: FAIL — `function deriveLeaveDaysCount not found` (ฝั่ง `app.js` ยังไม่มี)

- [ ] **Step 3: เพิ่มฟังก์ชันใน `app.js`** — วางไว้ก่อน `function isCancellableApprovedLeave(` ที่ `app.js:4449`

```js
// DUAL-SYNC: server.js deriveLeaveDaysCount (same function, same name). 2026-11-02: the loop this
// replaces lived inline inside submitLeave(), so nothing else could ask "how many working days is
// this range?" -- the partial-cancel confirm needs that number to tell the employee how many days
// come back, and a second copy of the loop would drift from the server's answer in silence.
// Weekends and public holidays are skipped: they are not leave days and never leave the quota.
function deriveLeaveDaysCount(dateFrom, dateTo) {
  let days = 0;
  let d = new Date(dateFrom + 'T12:00:00');
  const end = new Date((dateTo || dateFrom) + 'T12:00:00');
  while (d <= end) {
    if (d.getDay() !== 0 && d.getDay() !== 6 && !isPublicHoliday(localDateStr(d))) days++;
    d.setDate(d.getDate() + 1);
  }
  return days;
}
```

- [ ] **Step 4: ให้ `submitLeave()` เรียกฟังก์ชันนี้** — ที่ `app.js:19593-19597` แทนบล็อกเดิม

เดิม:

```js
    days = 0;
    let d = new Date(dateFrom + 'T12:00:00');
    const end = new Date(dateTo + 'T12:00:00');
    while (d <= end) { if (d.getDay() !== 0 && d.getDay() !== 6 && !isPublicHoliday(localDateStr(d))) days++; d.setDate(d.getDate()+1); }
```

ใหม่:

```js
    // 2026-11-02: the count moved out to deriveLeaveDaysCount() (DUAL-SYNC with server.js) so the
    // partial-cancel confirm can reuse the exact same rule instead of carrying a second copy.
    days = deriveLeaveDaysCount(dateFrom, dateTo);
```

- [ ] **Step 5: รันเทสต์ให้เขียว**

Run: `node tests/leave-partial-cancel.test.js`
Expected: PASS — `4 passed, 0 failed`

- [ ] **Step 6: ตรวจไฟล์ไม่พัง แล้ว commit**

```bash
node --check attendance/js/app.js
npm run lint
git add attendance/js/app.js tests/leave-partial-cancel.test.js
git commit -m "refactor(leave): one working-day counter the confirm dialog can reuse"
```

---

### Task 2: เงื่อนไข "ใบนี้หดได้ไหม" ทั้งสองฝั่ง

**Files:**
- Modify: `attendance-server/backend/server.js` — เพิ่มต่อจาก `isCancellableApprovedLeave()` (บล็อกที่เริ่มที่ `:8069`)
- Modify: `attendance/js/app.js` — เพิ่มต่อจาก `isCancellableApprovedLeave()` (จบที่ `:4461`)
- Test: `tests/leave-partial-cancel.test.js`

**Interfaces:**
- Consumes: ไม่มีจาก Task 1
- Produces: `isShortenableApprovedLeave(leave, asOfYmd) -> boolean` ทั้งสองฝั่ง ชื่อเดียวกัน · `true` เมื่อยังมีวันที่หดออกได้อยู่จริง · `asOfYmd` ว่างให้ใช้ `bangkokDateStr()`

- [ ] **Step 1: เขียนเทสต์ที่ต้องแดงก่อน** — เพิ่มต่อท้าย `tests/leave-partial-cancel.test.js` ก่อนบรรทัดสรุปผล

```js
function makePredicate(src, extra) {
  const ctx = Object.assign({
    DAY_BASED_LEAVE_TYPES: new Set(['annual', 'sick', 'business']),
    bangkokDateStr: () => '2026-11-02',
    isValidDateStr: s => /^\d{4}-\d{2}-\d{2}$/.test(s),
  }, extra || {});
  vm.createContext(ctx);
  vm.runInContext(extractFunction(src, 'isShortenableApprovedLeave'), ctx);
  return ctx;
}
const bothPredicate = () => [['client', makePredicate(APP_SRC)], ['server', makePredicate(SERVER_SRC)]];
const SICK = { id: 7, userId: 1, type: 'sick', status: 'approved', dateFrom: '2026-10-30', dateTo: '2026-11-05', days: 4 };

console.log('shortenable predicate: both sides agree');
test("the owner's real case is shortenable on 2026-11-02", () => {
  for (const [side, X] of bothPredicate()) {
    assert.strictEqual(X.isShortenableApprovedLeave(SICK, '2026-11-02'), true, side);
  }
});
test('a leave whose last day has passed is not shortenable', () => {
  for (const [side, X] of bothPredicate()) {
    assert.strictEqual(X.isShortenableApprovedLeave(SICK, '2026-11-05'), false, side + ' last day');
    assert.strictEqual(X.isShortenableApprovedLeave(SICK, '2026-11-09'), false, side + ' after');
  }
});
test('single-day, hourly, non-approved and out-of-scope types are not shortenable', () => {
  for (const [side, X] of bothPredicate()) {
    const no = (over, why) => assert.strictEqual(
      X.isShortenableApprovedLeave({ ...SICK, ...over }, '2026-11-02'), false, `${side} ${why}`);
    no({ dateTo: '2026-10-30' }, 'single day');
    no({ dateTo: undefined }, 'no dateTo');
    no({ hourlyStart: '09:00', hourlyEnd: '12:00' }, 'hourly mode');
    no({ status: 'pending' }, 'pending');
    no({ status: 'cancelled' }, 'already cancelled');
    no({ status: 'revoked' }, 'already revoked');
    no({ type: 'abroad' }, 'abroad is out of scope this round');
    no({ type: 'holiday-work' }, 'holiday-work is out of scope');
    no({ dateFrom: 'nope' }, 'malformed dateFrom');
  }
  for (const [side, X] of bothPredicate()) {
    assert.strictEqual(X.isShortenableApprovedLeave(null, '2026-11-02'), false, side + ' null');
  }
});
test('a leave entirely in the future is shortenable too (not only one already running)', () => {
  for (const [side, X] of bothPredicate()) {
    assert.strictEqual(X.isShortenableApprovedLeave(
      { ...SICK, dateFrom: '2026-12-01', dateTo: '2026-12-04' }, '2026-11-02'), true, side);
  }
});
test('both copies carry the DUAL-SYNC note', () => {
  for (const [name, src] of [['app.js', APP_SRC], ['server.js', SERVER_SRC]]) {
    const fn = extractFunction(src, 'isShortenableApprovedLeave');
    const before = src.slice(Math.max(0, src.indexOf(fn) - 600), src.indexOf(fn));
    assert.ok(/DUAL-SYNC|Dual-sync/.test(before), `${name} needs the dual-sync comment`);
  }
});
```

- [ ] **Step 2: รันให้เห็นว่าแดง**

Run: `node tests/leave-partial-cancel.test.js`
Expected: FAIL — `function isShortenableApprovedLeave not found`

- [ ] **Step 3: เพิ่มฝั่งเซิร์ฟเวอร์** — ต่อจากท้าย `isCancellableApprovedLeave()` ใน `server.js`

```js
// Dual-sync with app.js: isShortenableApprovedLeave
// 2026-11-02 (owner): an approved annual/sick/business leave may be SHORTENED by the employee --
// the days that have not arrived yet are given back, the rest of the approval stands. Until today
// the only options were isCancellableApprovedLeave() above, which takes the WHOLE record and only
// before it starts, and the MD/Accounting revoke route, which also takes the whole record. The real
// case that forced this: an approved 30/10-5/11 sick leave whose last three days were no longer
// needed on 02/11 -- already running, so nothing could touch it.
// True only when a legal returnDate exists at all: it must be after today (owner's rule: future
// days only), after dateFrom (anything else is cancelling the whole request, which has its own
// route) and no later than dateTo. Such a date exists exactly when dateTo is past both today and
// dateFrom. Hourly-mode records are excluded: they are a single day and carry days:0.
function isShortenableApprovedLeave(leave, asOfYmd) {
  if (!leave || leave.status !== 'approved') return false;
  if (!DAY_BASED_LEAVE_TYPES.has(leave.type)) return false;
  if (leave.hourlyStart || leave.hourlyEnd) return false;
  if (!isValidDateStr(leave.dateFrom) || !isValidDateStr(leave.dateTo)) return false;
  const asOf = isValidDateStr(asOfYmd) ? asOfYmd : bangkokDateStr();
  const earliest = asOf > leave.dateFrom ? asOf : leave.dateFrom;
  return leave.dateTo > earliest;
}
```

- [ ] **Step 4: เพิ่มฝั่งเบราว์เซอร์** — ต่อจาก `isCancellableApprovedLeave()` ที่จบที่ `app.js:4461`

```js
// DUAL-SYNC: server.js isShortenableApprovedLeave (same function, same name).
// 2026-11-02 (owner): see the server copy for why this exists -- the employee gives back the days
// of an approved leave that have not arrived, instead of losing the whole approval. This copy only
// decides whether the button renders; the server decides whether the write happens.
function isShortenableApprovedLeave(l, asOfYmd) {
  if (!l || l.status !== 'approved') return false;
  if (!DAY_BASED_LEAVE_TYPES.has(l.type)) return false;
  if (l.hourlyStart || l.hourlyEnd) return false;
  if (!isValidDateStr(l.dateFrom) || !isValidDateStr(l.dateTo)) return false;
  const asOf = isValidDateStr(asOfYmd) ? asOfYmd : bangkokDateStr();
  const earliest = asOf > l.dateFrom ? asOf : l.dateFrom;
  return l.dateTo > earliest;
}
```

**ตรวจแล้วเมื่อ 2026-11-02: `app.js` ยังไม่มีทั้ง `DAY_BASED_LEAVE_TYPES` และ `isValidDateStr`**
(`grep -c` ได้ 0 ทั้งคู่) ⇒ ต้องเพิ่มทั้งสองตัวไว้เหนือฟังก์ชันข้างบนนี้:

```js
// DUAL-SYNC: server.js DAY_BASED_LEAVE_TYPES (:6253) -- the three leave types counted in working
// days, which are also the three the 2026-11-02 partial cancellation covers.
const DAY_BASED_LEAVE_TYPES = new Set(['annual', 'sick', 'business']);
// DUAL-SYNC: server.js isValidDateStr.
function isValidDateStr(s) { return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s); }
```

- [ ] **Step 5: รันเทสต์ให้เขียว**

Run: `node tests/leave-partial-cancel.test.js`
Expected: PASS — `9 passed, 0 failed`

- [ ] **Step 6: ตรวจและ commit**

```bash
node --check attendance/js/app.js
node --check attendance-server/backend/server.js
npm run lint
git add attendance/js/app.js attendance-server/backend/server.js tests/leave-partial-cancel.test.js
git commit -m "feat(leave): the predicate for whether an approved leave still has days to give back"
```

---

### Task 3: `POST /api/leaves/:id/shorten`

**Files:**
- Modify: `attendance-server/backend/server.js` — แทรก route ใหม่หลัง route `revoke` จบ และก่อน `app.get('/api/exchange-rate'` ที่ `:9261`
- Test: `tests/leave-partial-cancel.test.js`

**Interfaces:**
- Consumes: `isShortenableApprovedLeave()` (Task 2) · `deriveLeaveDaysCount(dateFrom, dateTo)` (`server.js:6281`) · `addDaysToDateStr(dateStr, n)` (`server.js:8386`) · `refreshSnapshottedCarryForward(leaves, user, dateFrom)` (`server.js:8165`)
- Produces: `POST /api/leaves/:id/shorten` body `{ returnDate: 'YYYY-MM-DD' }` → `200 { success:true, leave, cancelled }` · โค้ดปฏิเสธ: `shorten-not-owner` (403) · `shorten-not-eligible` · `shorten-bad-date` · `shorten-past` · `shorten-whole` · `shorten-after-end` · `shorten-empty-remainder` (ทั้งหมด 400) · `period-locked` (400) · `period-frozen` / `period-confirmed` (409)

- [ ] **Step 1: เขียนเทสต์ที่ต้องแดงก่อน** — เพิ่มต่อท้าย `tests/leave-partial-cancel.test.js` ก่อนบรรทัดสรุปผล

เทสต์ route ในโปรเจกต์นี้ตรวจจาก source ของ route ตรงๆ (แบบเดียวกับ `tests/cancel-revoke.test.js` ท้ายไฟล์) เพราะ server.js เป็นไฟล์เดียวที่ยกขึ้นมารันใน sandbox ไม่ได้

```js
console.log('shorten route');
function shortenRouteBody() {
  const i = SERVER_SRC.indexOf("app.post('/api/leaves/:id/shorten'");
  assert.ok(i > 0, 'the shorten route does not exist');
  return SERVER_SRC.slice(i, SERVER_SRC.indexOf('\napp.', i + 10));
}
test('the route is wrapped in the leaves lock and fails closed on an unreadable file', () => {
  const body = shortenRouteBody();
  assert.ok(SERVER_SRC.includes("app.post('/api/leaves/:id/shorten', withLeavesLock("), 'must use withLeavesLock');
  assert.ok(body.includes('if (leaves === null) return res.status(503)'), 'must fail closed on a read error');
});
test('only the employee the leave belongs to, never an approver', () => {
  const body = shortenRouteBody();
  assert.ok(body.includes("code:'shorten-not-owner'"), 'needs the not-owner refusal');
  assert.ok(/leave\.userId !== live\.id/.test(body), 'needs the owner check against the live user');
  assert.ok(!SERVER_SRC.includes("app.post('/api/leaves/:id/shorten', requireRole("),
    'this route is for the employee, so it must not be role-gated to md/accounting');
});
test('every guard from the design is present', () => {
  const body = shortenRouteBody();
  ['isShortenableApprovedLeave(leave)', "code:'shorten-bad-date'", "code:'shorten-past'",
   "code:'shorten-whole'", "code:'shorten-after-end'", "code:'shorten-empty-remainder'",
   'lockedPeriodInRange', 'mdApprovedPeriodInRange', 'accountingConfirmedInRange',
   "code:'period-locked'", "code:'period-frozen'", "code:'period-confirmed'"]
    .forEach(k => assert.ok(body.includes(k), `missing guard: ${k}`));
});
test('both records are written, linked, and the quota snapshot is refreshed', () => {
  const body = shortenRouteBody();
  ['deriveLeaveDaysCount(', 'addDaysToDateStr(', "status: 'cancelled'", 'cancelledWith: leave.id',
   'cancelledById: live.id', 'cancelledBy: live.name', 'id: nextId(leaves)', 'originalDateTo',
   'shortenedAt', 'shortenedBy', 'leaves.push(', 'saveLeaves(leaves)',
   'refreshSnapshottedCarryForward', 'broadcastLeaveUpdated(leaves[idx])']
    .forEach(k => assert.ok(body.includes(k), `missing write step: ${k}`));
  assert.ok(!/status: 'revoked'/.test(body), "the employee's own act is 'cancelled', never 'revoked'");
  // One save only: a half-applied split would leave a record whose days no longer match its range.
  assert.strictEqual((body.match(/saveLeaves\(/g) || []).length, 1, 'exactly one save');
});
test('the shorten route never touches the approval fields of the kept record', () => {
  const body = shortenRouteBody();
  [/status:\s*'approved'/, /approver\s*:/, /approvedAt\s*:/].forEach(re =>
    assert.ok(!re.test(body), `must not rewrite the approval: ${re}`));
});

console.log('the arithmetic the route relies on');
test('kept days + given-back days = the original days, for every split point', () => {
  const S = makeServerDays();
  const from = '2026-10-30', to = '2026-11-05';
  const total = S.deriveLeaveDaysCount(from, to);
  const addDays = (s, n) => { const d = new Date(s + 'T12:00:00'); d.setDate(d.getDate() + n); return localDateStr(d); };
  for (const ret of ['2026-10-31', '2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05']) {
    const kept = S.deriveLeaveDaysCount(from, addDays(ret, -1));
    const back = S.deriveLeaveDaysCount(ret, to);
    assert.strictEqual(kept + back, total, `split at ${ret}: ${kept}+${back} != ${total}`);
  }
});
test('a split that would leave no working day on the record is detectable', () => {
  const S = makeServerDays();
  // Sat 31/10 .. Thu 05/11, coming back Mon 02/11 -> the kept span is Sat+Sun only.
  assert.strictEqual(S.deriveLeaveDaysCount('2026-10-31', '2026-11-01'), 0);
});
```

- [ ] **Step 2: รันให้เห็นว่าแดง**

Run: `node tests/leave-partial-cancel.test.js`
Expected: FAIL — `the shorten route does not exist`

- [ ] **Step 3: เขียน route** — แทรกก่อน `app.get('/api/exchange-rate'`

```js
// 2026-11-02 (owner): the employee gives back the days of an APPROVED annual/sick/business leave
// that have not arrived yet -- "I am coming back to work on <returnDate>". Everything before that
// date keeps its original approval, approver and id; the tail becomes its own 'cancelled' record
// (cancelledWith -> the original) so the history still shows it was approved and then given back.
// Why it exists: DELETE /api/leaves/:id cancels the WHOLE record and only before it starts
// (isCancellableApprovedLeave), and the revoke route is whole-record and md/accounting-only, so an
// approved leave already under way could not be trimmed at all. The real case: sirintorn's sick
// leave 30/10-5/11, approved, with 3-5/11 no longer needed on 02/11.
// Not role-gated on purpose (owner's decision): giving days back costs the company nothing and
// needs no second approval. md/accounting still take approvals back with /revoke.
app.post('/api/leaves/:id/shorten', withLeavesLock((req, res) => {
  try {
    const id = parseInt(req.params.id);
    const body = parseBody(req) || {};
    const leaves = readLeaves();
    if (leaves === null) return res.status(503).json({ success:false, message:'Service temporarily unavailable' });
    const idx = leaves.findIndex(l => l.id === id);
    if (idx < 0) return res.status(404).json({ success:false, message:'Not found' });
    const leave = leaves[idx];
    const users = readUsers() || [];
    const live = users.find(u => u.id === req.user.sub);
    if (!live) return res.status(403).json({ success:false, message:'Forbidden' });
    // The button only ever renders on the employee's own request, but never trust that alone.
    if (leave.userId !== live.id) {
      return res.status(403).json({ success:false, code:'shorten-not-owner', message:'You can only shorten your own leave' });
    }
    if (!isShortenableApprovedLeave(leave)) {
      return res.status(400).json({ success:false, code:'shorten-not-eligible', message:'This request cannot be shortened' });
    }
    const returnDate = String(body.returnDate || '');
    if (!isValidDateStr(returnDate)) {
      return res.status(400).json({ success:false, code:'shorten-bad-date', message:'returnDate must be YYYY-MM-DD' });
    }
    const dateTo = leave.dateTo;
    // Owner's rule (2026-11-02): future days only -- a day that has arrived is history, not a plan.
    if (returnDate <= bangkokDateStr()) {
      return res.status(400).json({ success:false, code:'shorten-past', message:'Only days that have not arrived yet can be given back' });
    }
    if (returnDate <= leave.dateFrom) {
      return res.status(400).json({ success:false, code:'shorten-whole', message:'That would cancel the whole request -- cancel it instead' });
    }
    if (returnDate > dateTo) {
      return res.status(400).json({ success:false, code:'shorten-after-end', message:'The leave already ends before that date' });
    }
    // The same three period guards the revoke route runs, on the span being given back: a day
    // inside a locked / MD-approved / tax-confirmed period must not change under those steps.
    if (lockedPeriodInRange(returnDate, dateTo)) {
      return res.status(400).json({ success:false, code:'period-locked', message:'This pay period is locked' });
    }
    if (mdApprovedPeriodInRange(returnDate, dateTo, leave.userId)) {
      return res.status(409).json({ success:false, code:'period-frozen', message:'Payroll for this period has already been approved by the Managing Director' });
    }
    if (accountingConfirmedInRange(returnDate, dateTo, leave.userId)) {
      return res.status(409).json({ success:false, code:'period-confirmed', message:'Accounting has already confirmed tax for this period — unconfirm before making changes' });
    }
    const keptTo = addDaysToDateStr(returnDate, -1);
    const keptDays = deriveLeaveDaysCount(leave.dateFrom, keptTo);
    const givenBackDays = deriveLeaveDaysCount(returnDate, dateTo);
    // A kept span with no working day would store days:0, and leaveMinutesOf() reads days:0 as an
    // HOURLY record and falls through to hourlyStart/timePart -- a day-mode record must never end
    // up there. Refuse and let the employee cancel the whole request instead.
    if (keptDays === 0) {
      return res.status(400).json({ success:false, code:'shorten-empty-remainder',
        message:'No working day would be left on the request -- cancel the whole request instead' });
    }
    const at = new Date().toISOString();
    // Same field shape as the cancel route so the history views and `cancelledWith` nesting
    // behave identically (app.js:16638 reads cancelledWith to nest this row under its parent).
    const givenBack = {
      ...leave,
      id: nextId(leaves),
      dateFrom: returnDate, dateTo,
      days: givenBackDays,
      status: 'cancelled', cancelledAt: at, cancelledById: live.id, cancelledBy: live.name,
      cancelledWith: leave.id,
      serverCreatedAt: at,
    };
    delete givenBack.shortenedAt; delete givenBack.shortenedBy; delete givenBack.originalDateTo;
    leaves[idx] = { ...leave, dateTo: keptTo, days: keptDays,
      shortenedAt: at, shortenedBy: live.name, originalDateTo: dateTo };
    leaves.push(givenBack);
    console.log('[LEAVE] approved leave shortened', JSON.stringify({ id, userId: leave.userId,
      type: leave.type, dateFrom: leave.dateFrom, originalDateTo: dateTo, keptTo, keptDays,
      givenBackDays, givenBackId: givenBack.id }));
    saveLeaves(leaves);
    // Returning annual-leave days changes next year's carry-forward snapshot, exactly as the
    // revoke route's own refresh does.
    refreshSnapshottedCarryForward(leaves, users.find(u => u.id === leave.userId), leave.dateFrom);
    broadcastLeaveUpdated(leaves[idx]);
    broadcast({ type: 'LEAVE_CREATED', leave: toPublicLeaveProjection(givenBack) });
    return res.json({ success:true, leave: leaves[idx], cancelled: givenBack });
  } catch (e) {
    console.error('[LEAVE] shorten failed', e);
    return res.status(500).json({ success:false, message:'Internal error' });
  }
}));
```

- [ ] **Step 4: ยืนยันว่า `refreshSnapshottedCarryForward` ถูกเรียกแบบเดียวกับ route เดิม**

Run: `grep -n "refreshSnapshottedCarryForward(" attendance-server/backend/server.js`
Expected: การเรียกใหม่ส่งอาร์กิวเมนต์ครบสามตัวเหมือนที่ route `revoke` และ `DELETE` เรียก — ถ้ารูปแบบต่างให้แก้ให้ตรงของเดิม ไม่ใช่แก้ของเดิมให้ตรงของใหม่

- [ ] **Step 5: รันเทสต์ให้เขียว**

Run: `node tests/leave-partial-cancel.test.js`
Expected: PASS — `16 passed, 0 failed`

- [ ] **Step 6: ตรวจและ commit**

```bash
node --check attendance-server/backend/server.js
npm run lint
git add attendance-server/backend/server.js tests/leave-partial-cancel.test.js
git commit -m "feat(leave): POST /api/leaves/:id/shorten gives back the days that have not arrived"
```

---

### Task 4: ปุ่มและคำยืนยันในหน้าจอ

**Files:**
- Modify: `attendance/js/app.js` — เพิ่ม `shortenLeave()` ต่อท้าย `cancelLeave()` (บล็อกที่เริ่มที่ `:22608`) และเพิ่มปุ่มที่ `:22516`
- Modify: `attendance/index.html:2833` — บัมพ์ cache-buster
- Test: `tests/leave-partial-cancel.test.js`

**Interfaces:**
- Consumes: `isShortenableApprovedLeave(l)` และ `deriveLeaveDaysCount(from, to)` (Task 1, 2) · `POST /api/leaves/:id/shorten` (Task 3)
- Produces: `shortenLeave(id)` ฟังก์ชัน global ที่ `onclick` เรียกได้

- [ ] **Step 1: เขียนเทสต์ที่ต้องแดงก่อน** — เพิ่มต่อท้าย `tests/leave-partial-cancel.test.js`

```js
console.log('the button and its confirm');
test('shortenLeave() exists, guards the owner, and posts to the shorten route', () => {
  const i = APP_SRC.indexOf('async function shortenLeave(');
  assert.ok(i > 0, 'shortenLeave() does not exist');
  const body = APP_SRC.slice(i, APP_SRC.indexOf('\nasync function ', i + 10));
  ['blockIfObserver()', 'isShortenableApprovedLeave(', 'deriveLeaveDaysCount(',
   '/shorten', "method: 'POST'", 'confirm(', 'currentUser.id'].forEach(k =>
    assert.ok(body.includes(k), `shortenLeave is missing ${k}`));
});
test('the confirm says how many days come back, in all three languages', () => {
  const i = APP_SRC.indexOf('async function shortenLeave(');
  const body = APP_SRC.slice(i, APP_SRC.indexOf('\nasync function ', i + 10));
  assert.ok(/currentLang === 'ja'/.test(body), 'Japanese wording is required');
  assert.ok(/L\(/.test(body), 'English/Thai wording via L() is required');
});
test('the button renders beside the existing cancel button on the owner\'s own approved request', () => {
  assert.ok(/isShortenableApprovedLeave\(l\)[^\n]*shortenLeave\(\$\{l\.id\}\)/.test(APP_SRC)
    || APP_SRC.includes('shortenLeave(${l.id})'), 'the row must offer the button');
});
test('the cache-buster was bumped past the value this work started from', () => {
  const html = fs.readFileSync(path.join(ROOT, 'attendance/index.html'), 'utf8');
  const m = /js\/app\.js\?v=(\d{8})/.exec(html);
  assert.ok(m, 'cache-buster not found');
  assert.ok(Number(m[1]) >= 20261102, `cache-buster ${m[1]} must be 20261102 or later`);
});
```

- [ ] **Step 2: รันให้เห็นว่าแดง**

Run: `node tests/leave-partial-cancel.test.js`
Expected: FAIL — `shortenLeave() does not exist`

- [ ] **Step 3: เขียน `shortenLeave()`** — ต่อท้าย `cancelLeave()` ใน `app.js`

```js
// 2026-11-02 (owner): "I am coming back to work on <date>" -- gives back the days of an approved
// leave that have not arrived. See isShortenableApprovedLeave() and the server's /shorten route for
// the rules. Kept separate from cancelLeave() on purpose: that one ends a request, this one trims
// it, and mixing the two confirms would make both of them vague.
async function shortenLeave(id) {
  if (blockIfObserver()) return false;
  const l = DATA_LEAVES.find(x => x.id === id);
  if (!l) return false;
  if (l.userId !== currentUser.id) {
    showToast(L('⛔ You can only change your own requests', '⛔ คุณแก้ได้เฉพาะคำขอของตัวเองเท่านั้น'), 'danger');
    return false;
  }
  if (!isShortenableApprovedLeave(l)) {
    showToast(L('This request has no upcoming days left to give back',
      'คำขอนี้ไม่มีวันข้างหน้าเหลือให้คืนแล้ว'), 'warning');
    return false;
  }
  const earliest = (() => {
    const t = bangkokDateStr();
    const next = t > l.dateFrom ? t : l.dateFrom;
    const d = new Date(next + 'T12:00:00');
    d.setDate(d.getDate() + 1);
    return localDateStr(d);
  })();
  const returnDate = prompt(currentLang === 'ja'
    ? `何日から出勤しますか？（${earliest} ～ ${l.dateTo}）`
    : L(`Which day are you coming back to work? (${earliest} to ${l.dateTo})`,
        `กลับมาทำงานวันไหน? (${earliest} ถึง ${l.dateTo})`), earliest);
  if (!returnDate) return false;
  if (!isValidDateStr(returnDate) || returnDate < earliest || returnDate > l.dateTo) {
    showToast(currentLang === 'ja'
      ? `${earliest} ～ ${l.dateTo} の日付を入力してください`
      : L(`Pick a date between ${earliest} and ${l.dateTo}`,
          `กรุณาเลือกวันที่ระหว่าง ${earliest} ถึง ${l.dateTo}`), 'warning');
    return false;
  }
  const keptTo = (() => { const d = new Date(returnDate + 'T12:00:00'); d.setDate(d.getDate() - 1); return localDateStr(d); })();
  const keptDays = deriveLeaveDaysCount(l.dateFrom, keptTo);
  const backDays = deriveLeaveDaysCount(returnDate, l.dateTo);
  if (keptDays === 0) {
    showToast(L('No working day would be left on the request — cancel the whole request instead',
      'จะไม่มีวันทำงานเหลือในคำขอนี้ — ให้ยกเลิกทั้งใบแทน'), 'warning');
    return false;
  }
  if (!confirm(currentLang === 'ja'
    ? `${returnDate} から出勤します。申請は ${l.dateFrom}～${keptTo}（${keptDays}日）になり、${returnDate}～${l.dateTo}（${backDays}日）は取り消して残日数に戻ります。取り消した分は履歴に残ります。`
    : L(`Coming back on ${returnDate}. The request becomes ${l.dateFrom} to ${keptTo} (${keptDays} day(s)); ${returnDate} to ${l.dateTo} (${backDays} day(s)) is cancelled and returned to your balance. The cancelled part stays in your history.`,
        `กลับมาทำงาน ${returnDate} · คำขอจะเหลือ ${l.dateFrom} ถึง ${keptTo} (${keptDays} วัน) และ ${returnDate} ถึง ${l.dateTo} (${backDays} วัน) จะถูกยกเลิกและคืนเข้ายอดคงเหลือ ส่วนที่ยกเลิกจะยังอยู่ในประวัติ`))) return false;
  try {
    const r = await apiFetch(`/api/leaves/${id}/shorten`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ returnDate })
    });
    const data = await r.json();
    if (!data.success) throw new Error(data.code ? shortenBlockMessage(data.code) : (data.message || 'Shorten failed'));
    const i = DATA_LEAVES.findIndex(x => x.id === id);
    if (i >= 0 && data.leave) DATA_LEAVES[i] = data.leave;
    if (data.cancelled) DATA_LEAVES.push(data.cancelled);
    showToast(currentLang === 'ja' ? `✅ ${backDays}日を残日数に戻しました`
      : L(`✅ ${backDays} day(s) returned to your balance`, `✅ คืน ${backDays} วันเข้ายอดคงเหลือแล้ว`), 'success');
  } catch (e) {
    showToast(L('❌ Could not change the request: ', '❌ แก้คำขอไม่สำเร็จ: ') + e.message, 'danger');
    return false;
  }
  return true;
}
// Server refusal codes for /shorten, worded here the way cancelBlockMessage() does for cancels.
function shortenBlockMessage(code) {
  switch (code) {
    case 'shorten-not-owner': return L('You can only change your own requests', 'คุณแก้ได้เฉพาะคำขอของตัวเองเท่านั้น');
    case 'shorten-not-eligible': return L('This request cannot be shortened', 'คำขอนี้หดวันไม่ได้');
    case 'shorten-past': return L('Only days that have not arrived yet can be given back', 'คืนได้เฉพาะวันที่ยังไม่มาถึง');
    case 'shorten-whole': return L('That would cancel the whole request — use Cancel instead', 'นั่นคือการยกเลิกทั้งใบ — ให้กดยกเลิกแทน');
    case 'shorten-after-end': return L('The leave already ends before that date', 'วันลาจบก่อนวันที่เลือกแล้ว');
    case 'shorten-empty-remainder': return L('No working day would be left on the request — cancel the whole request instead', 'จะไม่มีวันทำงานเหลือในคำขอนี้ — ให้ยกเลิกทั้งใบแทน');
    default: return cancelBlockMessage(code);
  }
}
```

**หมายเหตุสำหรับคนลงมือ:** `prompt()` ใช้ชั่วคราวเพื่อให้ task นี้ปิดได้ด้วยตัวเอง ถ้าในไฟล์มีโมดัลเลือกวันของตัวเองอยู่แล้ว (หา `showModal`/`openModal` ที่รับ input type=date) ให้ใช้ของนั้นแทนและคงข้อความ 3 ภาษาเดิมไว้ · อย่าลืมว่าภาษาญี่ปุ่นต้องมาพร้อมกันทั้งสามภาษา ไม่ใช่เติมทีหลัง

- [ ] **Step 4: เพิ่มปุ่มในแถวคำขอ** — ที่ `app.js:22516` ต่อท้ายปุ่ม Cancel เดิมในนิพจน์เดียวกัน

```js
           ${isShortenableApprovedLeave(l) ? `<button class="btn btn-secondary btn-sm" onclick="shortenLeave(${l.id})">${currentLang === 'ja' ? '早めに出勤' : L('Come back early', 'กลับมาทำงานก่อนกำหนด')}</button>` : ''}
```

- [ ] **Step 5: ตรวจว่า `onclick` ตัวใหม่ผ่านยามของโปรเจกต์**

Run: `node tests/inline-handlers.test.js`
Expected: PASS — ยามนี้ตรวจว่าทุกชื่อใน `onclick=` มีฟังก์ชันจริง ถ้าแดงเพราะหาไม่เจอ แปลว่า `shortenLeave` ไม่ได้อยู่ใน scope ที่ยามมองเห็น ให้วางให้อยู่ระดับบนสุดของไฟล์แบบเดียวกับ `cancelLeave`

- [ ] **Step 6: บัมพ์ cache-buster** ที่ `attendance/index.html:2833`

```
<script src="js/app.js?v=20261102v"></script>
```

- [ ] **Step 7: รันเทสต์ให้เขียว**

Run: `node tests/leave-partial-cancel.test.js && node tests/cache-buster-bump.test.js && node tests/inline-handlers.test.js`
Expected: PASS ทั้งสามไฟล์

- [ ] **Step 8: ตรวจและ commit**

```bash
node --check attendance/js/app.js
npm run lint
git add attendance/js/app.js attendance/index.html tests/leave-partial-cancel.test.js
git commit -m "feat(leave): the Come back early button and its three-language confirm"
```

---

### Task 5: ตรวจทั้งระบบและในเบราว์เซอร์จริง

**Files:** ไม่แก้โค้ด — ขั้นนี้คือการพิสูจน์

- [ ] **Step 1: เทสต์ทั้งชุด**

Run: `npm run check`
Expected: `=== 67/67 test files passed ===` (66 เดิม + ไฟล์ใหม่) และ lint ไม่มี error · ถ้าตัวเลขไม่ใช่ 67 ให้หาว่าไฟล์ไหนหาย อย่าปล่อยผ่าน

- [ ] **Step 2: เปิด frontend ของ worktree คุยกับ backend จริง**

ทำตาม `C:\Users\tairo\.claude\projects\Z--\memory\feedback_attendance_browser_verify_against_live_backend.md` — ต้องเสิร์ฟที่ `127.0.0.1` ไม่ใช่ `localhost` และระวัง rate limit ของ `/api/login`
ใช้บัญชีทดสอบจาก `project_time_attendance_qa_accounts.md` ไม่ใช่บัญชีพนักงานจริง

- [ ] **Step 3: พิสูจน์เคสของเจ้าของจากต้นจนจบ**

สร้างใบลาป่วยทดสอบที่คาบวันอนาคต (เช่น `dateFrom` = เมื่อวาน `dateTo` = อีก 3 วัน) อนุมัติด้วยบัญชีผู้อนุมัติ แล้วด้วยบัญชีพนักงาน:
1. ปุ่ม "กลับมาทำงานก่อนกำหนด" ขึ้น
2. ใส่วันที่กลับ → คำยืนยันบอกช่วงที่เหลือ ช่วงที่ยกเลิก และจำนวนวันที่คืน ถูกต้องทั้งสามตัว
3. กดยืนยัน → ยอดคงเหลือลาป่วยเพิ่มขึ้นเท่ากับจำนวนวันที่คืนพอดี
4. ประวัติแสดงใบเดิมที่หดแล้ว **และ** แถวที่ยกเลิกซ้อนอยู่ใต้มัน ขีดฆ่า
5. หน้าบันทึกเวลาของวันที่ยกเลิก **ไม่ใช่วันลาอีกแล้ว**
6. วันที่ยังอยู่ในใบ ยังเป็นวันลาเหมือนเดิม

- [ ] **Step 4: พิสูจน์ด่านที่ต้องปฏิเสธ (อย่างน้อยสองตัว)**

เลือกวันที่เป็นวันนี้ → ต้องถูกปฏิเสธด้วยข้อความ "คืนได้เฉพาะวันที่ยังไม่มาถึง" · เลือกวันเท่ากับ `dateFrom` → ต้องบอกให้ไปกดยกเลิกทั้งใบ

- [ ] **Step 5: เก็บหลักฐาน**

ถ่านภาพหน้าจอขั้นที่ 3 ข้อ 3 และ 4 เก็บไว้ · รายงานตัวเลขยอดคงเหลือก่อน/หลังเป็นตัวเลขจริง ไม่ใช่คำว่า "ถูกต้อง"

- [ ] **Step 6: push และขออนุมัติก่อน merge**

```bash
git push origin feat/2026-11-02-partial-leave-cancel
```

จากนั้น **หยุดถามเจ้าของก่อน merge เข้า `main`** — `Z:\Time_Attendance` คือเว็บจริง เซฟปุ๊บผู้ใช้เห็นปั๊บ และต้องนับไฟล์รูปพนักงานใน `attendance/images/employees/` ให้ครบ 10 ไฟล์ก่อนและหลัง merge ตามข้อส่งต่อใน `STATUS.md`

---

## Self-Review

**ความครอบคลุมเทียบ spec:**

| ข้อใน spec | Task ที่ทำ |
|---|---|
| ถามว่า "กลับมาทำงานวันไหน" | Task 4 Step 3 |
| `POST /api/leaves/:id/shorten` | Task 3 |
| หด `dateTo` + นับ `days` ใหม่ฝั่งเซิร์ฟเวอร์ | Task 3 Step 3 (ใช้ `deriveLeaveDaysCount` ซ้ำ) |
| แยกรายการใหม่สถานะ `cancelled` + `cancelledWith` | Task 3 Step 3 |
| ด่านทั้ง 10 แถวในตาราง spec | Task 3 Step 3 + เทสต์ Task 3 Step 1 |
| เคสช่วงที่เหลือไม่มีวันทำงาน | Task 3 (`shorten-empty-remainder`) + เทสต์ |
| ตัวนับวันทำงานสองฝั่ง + DUAL-SYNC | Task 1 + Task 2 Step 1 (เทสต์จับคอมเมนต์) |
| ข้อความ 3 ภาษา | Task 4 Step 3 + เทสต์ |
| cache-buster | Task 4 Step 6 + เทสต์ |
| เทสต์ทั้ง 10 ข้อใน spec | Task 1–3 (ข้อ 9 "อ่านไฟล์ไม่ได้ → 503" ตรวจด้วยการจับ `leaves === null` ใน route source เพราะ sandbox ยก server.js ทั้งไฟล์มารันไม่ได้) |
| ปีคาบเกี่ยว | ครอบด้วยเทสต์ผลบวกคงที่ใน Task 3 Step 1 ซึ่งคาบ ต.ค.–พ.ย. · ช่วงข้ามปีไม่มีเคสแยกเพราะรายการที่ยกเลิกเป็น void ทั้งสองปี |

**ไม่มี placeholder:** ทุกขั้นที่แก้โค้ดมีโค้ดจริง ทุกขั้นที่รันมีคำสั่งจริงและผลที่คาดไว้

**ความสอดคล้องของชื่อ:** `deriveLeaveDaysCount` · `isShortenableApprovedLeave` · `shortenLeave` · `shortenBlockMessage` · ฟิลด์ `shortenedAt` / `shortenedBy` / `originalDateTo` / `cancelledWith` — ใช้ชื่อเดียวกันทุก task
