# Check-in/Out & Leave Logic Review — Opus 4.8 → Sonnet Fix Plan
Date: 2026-07-21

## ส่วนที่ตรวจแล้ว (ไม่พบ bug)

| ฟังก์ชัน | บรรทัด | ผล |
|---|---|---|
| `businessDateStr()` | 3292-3300 | ✅ pre-5AM boundary ถูกต้อง |
| `doScan(source)` | 3306-3361 | ✅ isPreDawn/isFirst pattern ถูกต้อง |
| `updateScanButton()` | 3363-3403 | ✅ UI sync ถูกต้อง |
| `appendLog()` | 3405-3413 | ✅ simple push, ไม่มีปัญหา |
| `loadAttendanceFromBackend()` | 2316-2400 | ✅ event replay + 5AM boundary + 17:00 heuristic + 12:00 morning-skip — intentional ทุกข้อ |
| `restoreTodayLog()` | 2841-2854 | ✅ backward-compat ถูกต้อง |

---

## Bug ที่พบ

### CI-01 — `submitLeave()` นับ public holiday เป็นวันลา ⚠️ HIGH IMPACT

**ไฟล์:** `/z/attendance/js/app.js`  
**บรรทัด:** 7174

```js
// CURRENT (bug):
while (d <= end) { if (d.getDay() !== 0 && d.getDay() !== 6) days++; d.setDate(d.getDate()+1); }

// FIX:
while (d <= end) {
  if (d.getDay() !== 0 && d.getDay() !== 6 && !isPublicHoliday(localDateStr(d))) days++;
  d.setDate(d.getDate()+1);
}
```

**ผลกระทบ:** พนักงานยื่นลาพักร้อน Mon-Fri ที่มี public holiday (วันพุธ) → ถูกหักวันลา 5 วันแทนที่จะเป็น 4 วัน  
Balance gate (line 7250) ยัง `days * 8 * 60` ตัวเลขเดิม → บล็อกการยื่นผิดถ้า balance เหลือน้อย  
`leaveData.days` ที่ save ลง DB ก็เป็นตัวเลขที่ผิด → ตัด balance ผิดถาวร

---

### CI-02 — `applyApprovalToLog()` เขียน `status='leave-annual'` ทับ public holiday ⚠️ MEDIUM

**ไฟล์:** `/z/attendance/js/app.js`  
**บรรทัด:** 6644-6651

```js
// CURRENT (bug):
while (d <= endDate) {
  const dow = d.getDay();
  if (dow !== 0 && dow !== 6) {
    const k = attKey(l.userId, localDateStr(d));
    attendanceLog[k] = { checkIn: null, checkOut: null, status: leaveStatus, checkInSource: 'web' };
  }
  d.setDate(d.getDate() + 1);
}

// FIX: เพิ่ม !isPublicHoliday check ใน condition
while (d <= endDate) {
  const dow = d.getDay();
  if (dow !== 0 && dow !== 6 && !isPublicHoliday(localDateStr(d))) {
    const k = attKey(l.userId, localDateStr(d));
    attendanceLog[k] = { checkIn: null, checkOut: null, status: leaveStatus, checkInSource: 'web' };
  }
  d.setDate(d.getDate() + 1);
}
```

**ผลกระทบ:** `attendanceLog[k]` ของวันหยุดนักขัตฤกษ์ที่อยู่ในช่วงลา ถูกเขียนทับด้วย `status = 'leave-annual'`  
→ ในตาราง attendance วันหยุดนักขัตฤกษ์จะโชว์เป็น "Annual Leave" แทน "Holiday"

---

### CI-03 — `generatePeriodDays()` DATA_LEAVES overlay ทับ holiday status ⚠️ MEDIUM

**ไฟล์:** `/z/attendance/js/app.js`  
**บรรทัด:** 2223-2229

```js
// CURRENT (bug):
if (!isWeekend && !isFuture && uid) {
  DATA_LEAVES.filter(l => l.userId == uid && l.status === 'approved').forEach(l => {
    if (['annual','sick','business'].includes(l.type)) {
      if (dateStr >= l.dateFrom && dateStr <= l.dateTo) {   // ← ไม่มี !isPubHoliday guard
        status = l.type === 'annual' ? 'leave-annual' : l.type === 'sick' ? 'leave-sick' : 'leave-business';
        checkIn = null; checkOut = null; upcountry = false;
      }
    }
    // ...
  });
}

// FIX: เพิ่ม && !isPubHoliday ใน if
if (['annual','sick','business'].includes(l.type)) {
  if (dateStr >= l.dateFrom && dateStr <= l.dateTo && !isPubHoliday) {
    status = l.type === 'annual' ? 'leave-annual' : l.type === 'sick' ? 'leave-sick' : 'leave-business';
    checkIn = null; checkOut = null; upcountry = false;
  }
}
```

**หมายเหตุ:** `isPubHoliday` ถูก declare ไว้แล้วที่ line 2158 (`const isPubHoliday = isPublicHoliday(dateStr) && !isWeekend;`) — ใช้ได้เลย

**ผลกระทบ:** แม้ `status` จะถูกตั้งเป็น `'holiday'` ที่ line 2218 (`status = isPubHoliday ? 'holiday' : 'absent'`) overlay ที่ 2227 ยังทับกลายเป็น `'leave-annual'`  
→ วันหยุดนักขัตฤกษ์ในช่วงลา **แสดงเป็น "Leave" บนตาราง attendance** แทนที่จะเป็น "Holiday"

---

## สรุปสิ่งที่ต้องแก้ (3 จุด)

| Bug | ไฟล์ | บรรทัด | Fix |
|---|---|---|---|
| CI-01 | app.js | 7174 | เพิ่ม `&& !isPublicHoliday(localDateStr(d))` ใน while loop |
| CI-02 | app.js | 6646 | เพิ่ม `&& !isPublicHoliday(localDateStr(d))` ใน if condition |
| CI-03 | app.js | 2226 | เพิ่ม `&& !isPubHoliday` ใน date range check |

ทั้ง 3 fix เป็น one-liner ไม่ต้องเพิ่มฟังก์ชันใหม่ ฟังก์ชัน `isPublicHoliday()` และ `localDateStr()` มีอยู่แล้วในโค้ด
