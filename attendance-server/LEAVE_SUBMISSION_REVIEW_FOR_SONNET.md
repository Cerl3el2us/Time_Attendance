# Leave Submission Review — Opus 4.8 → Sonnet Fix Plan
Date: 2026-07-21

## ส่วนที่ตรวจแล้ว

| ฟังก์ชัน | บรรทัด | ผล |
|---|---|---|
| `submitLeave()` | 7159-7291 | ⚠️ พบปัญหา (LS-01, LS-05, LS-06) |
| `submitOT()` | 7907-7961 | ⚠️ policy question (LS-03) |
| `submitDriverOT()` | 7965-8025 | ✅ clean (tier handling / route ถูกต้อง) |
| `saveLeaveEdit()` | 6897-6917 | ✅ ตัว save เอง clean — แต่ caller bypass gate (LS-01) |
| `editLeaveRequest()` | 6924-7003 | ✅ owner check + type gate ถูกต้อง |
| `cancelLeave()` | 8439-8466 | ✅ pending-only + owner check ถูกต้อง |
| balance display `renderLeaveBalance` | 8274-8295 | ⚠️ share bug กับ gate (LS-05, LS-06) |

---

## Bug ที่พบ

### LS-01 — การแก้ไขคำขอ (edit) ข้าม balance + overlap validation ⚠️ HIGH

**ไฟล์:** `/z/attendance/js/app.js`  
**บรรทัด:** 7218 และ 7232

ทั้ง overlap check และ balance gate ถูกครอบด้วย `if (!editingLeaveId && ...)`:

```js
// line 7218 — overlap check
if (!editingLeaveId && ['annual','sick','business','comp'].includes(type)) { ... }

// line 7232 — balance gate
if (!editingLeaveId && ['annual', 'business'].includes(type)) { ... }
```

**ปัญหา:** พนักงานยื่นลาพักร้อน 1 วัน (ผ่าน gate เพราะยัง balance พอ) → กด **แก้ไข** เปลี่ยนเป็น 10 วัน → **ไม่ถูกตรวจ balance เลย** เพราะ edit ข้าม gate ทั้งหมด. คำขอกลับไป pending และถูกส่งเข้าอนุมัติด้วยจำนวนวันที่เกินสิทธิ

**เหตุผลที่ gate ควรรันตอน edit ด้วย:** gate นับเฉพาะ leave ที่ `status === 'approved'` (บรรทัด 7238) — คำขอที่กำลัง edit ยัง pending อยู่ ไม่ถูกนับใน usedMin อยู่แล้ว ดังนั้นรัน gate ตอน edit จะคำนวณถูกต้อง ไม่ double-count

**FIX:** เอาเงื่อนไข `!editingLeaveId` ออกจากทั้ง 2 จุด (เปลี่ยนเป็นเช็คแค่ type):
```js
// line 7218
if (['annual','sick','business','comp'].includes(type)) {
  const overlap = DATA_LEAVES.find(l =>
    l.userId === currentUser.id &&
    l.id !== editingLeaveId &&                         // ← เพิ่ม: ไม่ชนกับตัวเองตอน edit
    ['annual','sick','business','comp'].includes(l.type) &&
    !['rejected','cancelled'].includes(l.status) &&
    l.dateFrom <= dateTo && (l.dateTo || l.dateFrom) >= dateFrom
  );
  ...
}

// line 7232
if (['annual', 'business'].includes(type)) { ... }   // เอา !editingLeaveId ออก
```
**สำคัญ:** overlap check ต้องเพิ่ม `l.id !== editingLeaveId` ด้วย ไม่งั้นตอน edit จะเจอ record ตัวเองแล้ว false-positive ว่า overlap

---

### LS-02 — Balance gate ไม่นับคำขอที่ยัง pending ⚠️ MEDIUM

**ไฟล์:** `/z/attendance/js/app.js`  
**บรรทัด:** 7238

```js
const approvedLeaves = DATA_LEAVES.filter(l => l.userId === u.id && l.type === type && l.status === 'approved');
```

**ปัญหา:** gate นับเฉพาะ `'approved'` — พนักงานที่เหลือสิทธิ 1 วัน สามารถยื่นคำขอ 1 วัน **หลายใบ** พร้อมกัน (แต่ละใบเห็น remaining เท่าเดิม = ผ่านหมด) แล้วรออนุมัติ. **ยืนยันแล้วว่าไม่มีการเช็ค balance ซ้ำตอนอนุมัติ** (มี "Insufficient balance" ที่บรรทัด 7252 จุดเดียวในไฟล์ = ตอน submit เท่านั้น) → อนุมัติครบทุกใบ = เกินสิทธิ

**FIX:** เปลี่ยน filter ให้รวม pending ด้วย (นับคำขอที่ยังไม่ถูกปฏิเสธ/ยกเลิก) — แต่ต้องกันไม่ให้นับตัวที่กำลัง edit:
```js
const approvedLeaves = DATA_LEAVES.filter(l =>
  l.userId === u.id && l.type === type &&
  !['rejected','cancelled'].includes(l.status) &&
  l.id !== editingLeaveId
);
```
(ตัวแปรยังชื่อ approvedLeaves ได้ หรือ rename เป็น committedLeaves เพื่อความชัด)

---

### LS-05 — usedMin นับชั่วโมงลาแบบ hourly ผิดถ้าคำขอถูกยื่นเป็นภาษาญี่ปุ่น ⚠️ MEDIUM (i18n bug จริง)

**ไฟล์:** `/z/attendance/js/app.js`  
**บรรทัด:** 7242-7245 (gate) **และ** 8279-8283 (display) — โค้ดซ้ำ 2 ที่ ต้องแก้ทั้งคู่

```js
} else if (l.timePart) {
  const hM = l.timePart.match(/(\d+)\s*(?:ชม\.|h)/);
  const mM = l.timePart.match(/(\d+)\s*(?:น\.|m)/);
  usedMin += (hM ? parseInt(hM[1]) : 0) * 60 + (mM ? parseInt(mM[1]) : 0);
}
```

**ปัญหา:** leave แบบ hourly เก็บ `days = 0` แล้วให้ regex อ่านจาก `timePart`. แต่ timePart ผูกภาษาตอนยื่น (บรรทัด 7194): ญี่ปุ่น = `"09:00–12:00 (3時間0分)"`. regex จับแค่ `ชม.|h` และ `น.|m` **ไม่จับ 時間/分** → คำขอ hourly ที่ยื่นภาษาญี่ปุ่นถูกนับเป็น **0 นาที** → พนักงานลาแบบรายชั่วโมงเป็นภาษาญี่ปุ่นจะไม่ถูกหักสิทธิเลย (และ display ก็โชว์ผิด)

**FIX:** record hourly มี `hourlyStart`/`hourlyEnd` เก็บไว้แล้ว (เพิ่มมาทีหลัง) — คำนวณจากตรงนั้นแทน regex ที่เปราะเรื่องภาษา:
```js
} else if (l.hourlyStart && l.hourlyEnd) {
  const [sh, sm] = l.hourlyStart.split(':').map(Number);
  const [eh, em] = l.hourlyEnd.split(':').map(Number);
  usedMin += Math.max(0, (eh*60+em) - (sh*60+sm));
} else if (l.timePart) {
  // fallback สำหรับ record เก่าที่ไม่มี hourlyStart/hourlyEnd — เพิ่ม 時間/分 เข้า regex
  const hM = l.timePart.match(/(\d+)\s*(?:ชม\.|h|時間)/);
  const mM = l.timePart.match(/(\d+)\s*(?:น\.|m|分)/);
  usedMin += (hM ? parseInt(hM[1]) : 0) * 60 + (mM ? parseInt(mM[1]) : 0);
}
```
แก้ทั้ง 2 ที่ (gate 7242 + display 8279) ให้เหมือนกัน

---

### LS-06 — usedMin นับ approved leave ข้ามปี (ไม่มี year filter) ⚠️ MEDIUM (latent)

**ไฟล์:** `/z/attendance/js/app.js`  
**บรรทัด:** 7238 (gate) **และ** 8274 (display)

```js
const approvedLeaves = DATA_LEAVES.filter(l => l.userId === u.id && l.type === type && l.status === 'approved');
```

**ปัญหา:** ไม่กรองปี — `u.annualLeave` เป็นสิทธิ**ต่อปี** (reset ทุกปี, มี carry-forward แยกผ่าน `getCarryForwardDays`) แต่ `DATA_LEAVES` สะสมข้ามปี. พอขึ้นปีใหม่ leave ที่ approved ปีนี้ยังถูกนับกินสิทธิปีหน้าถาวร → balance ปีหน้าเพี้ยน. ตอนนี้ app มีข้อมูลแค่ปี 2026 เลยยังไม่กระทบ แต่จะระเบิดต้นปี 2027

**FIX:** เพิ่ม year filter (นับเฉพาะ leave ที่ dateFrom อยู่ในปีปัจจุบัน) ทั้ง gate และ display:
```js
const yStart = `${thisYear}-01-01`, yEnd = `${thisYear}-12-31`;
const approvedLeaves = DATA_LEAVES.filter(l =>
  l.userId === u.id && l.type === type && l.status === 'approved' &&
  l.dateFrom >= yStart && l.dateFrom <= yEnd
);
```
(display ที่ 8274 ใช้ `thisYear` ที่ประกาศไว้แล้วในฟังก์ชันนั้น — ตรวจชื่อตัวแปรให้ตรง)

**หมายเหตุ:** ระวัง interaction กับ LS-02 — ถ้ารวม pending ด้วย ก็ต้อง filter ปีเหมือนกัน

---

## Policy Question — ต้องถาม user ก่อน (ห้ามแก้เอง)

### LS-03 — submitOT ให้ตัวคูณ OT วันเสาร์-อาทิตย์ = 1.5x (ไม่ใช่ 3x)

**ไฟล์:** `/z/attendance/js/app.js` บรรทัด 7927
```js
const otMultiplier = isPublicHoliday(date) ? 3 : 1.5;
```

เช็คแค่ `isPublicHoliday` — OT วันเสาร์/อาทิตย์ (วันหยุดประจำสัปดาห์) ได้ 1.5x เท่าวันธรรมดา. ตามกฎหมายแรงงานไทย ทำงานในวันหยุด (รวมวันหยุดประจำสัปดาห์) ปกติจ่ายอัตราสูงกว่า. **แต่นี่อาจเป็นนโยบายบริษัทที่ตั้งใจ** (นับเฉพาะวันหยุดนักขัตฤกษ์เป็น 3x) — **ต้องถาม user ว่า OT เสาร์-อาทิตย์ควรเป็นกี่เท่า** ก่อนตัดสินใจแก้

(หมายเหตุ: driver OT กรอกตัวคูณเองไม่กระทบข้อนี้)

---

## สรุปสิ่งที่ต้องแก้

| ID | Severity | ไฟล์:บรรทัด | สรุป |
|---|---|---|---|
| LS-01 | HIGH | app.js:7218,7232 | เอา `!editingLeaveId` guard ออก + เพิ่ม `l.id !== editingLeaveId` ใน overlap |
| LS-02 | MEDIUM | app.js:7238 | นับ pending ด้วย ไม่ใช่แค่ approved |
| LS-05 | MEDIUM | app.js:7242,8279 | คำนวณ hourly จาก hourlyStart/hourlyEnd แทน regex (JP 時間/分 พัง) |
| LS-06 | MEDIUM | app.js:7238,8274 | เพิ่ม year filter กัน balance ข้ามปีเพี้ยน |
| LS-03 | QUESTION | app.js:7927 | OT เสาร์-อาทิตย์ 1.5x — ถาม user ก่อนแก้ |

**หมายเหตุการแก้:** LS-02, LS-05, LS-06 แตะ block เดียวกัน (7238-7246) และ display block (8274-8284) — Sonnet ควรแก้รวดเดียวให้ 2 block นี้ logic ตรงกัน. `node --check` หลังแก้ + Playwright smoke test (login QA account, เปิดหน้า leave, ทดสอบยื่น + edit)
