# Time/OT/Attendance Review — Findings for Sonnet (2026-07-19, Opus)

> ก้อน "เวลา/OT/เบี้ยเลี้ยง" — ตรวจ `generatePeriodDays()` (`app.js:2118-2235`) และ `computeLateDeductMinutes()`
> (`app.js:1809-1833`). `generatePeriodDays()` เองไม่พบบั๊กชัดเจน (status precedence ถูก, leave overlay ทำงานตามลำดับที่ควร)
> แต่เจอบั๊กจริง 1 จุดใน `computeLateDeductMinutes()` — **หักวันลาพักร้อนผิด**

---

## 🔴 T-01 — หักวันลาพักร้อนจากการ "มาสาย" ในวันหยุดนักขัตฤกษ์/วัน company-trip

**ที่:** `app.js:1809-1833`
```js
function computeLateDeductMinutes(userId, year) {
  ...
  Object.keys(attendanceLog).forEach(key => {
    if (!key.startsWith(`${userId}_`)) return;
    const dateStr = key.slice(String(userId).length + 1);
    if (!dateStr.startsWith(yearStr)) return;
    if (dateStr < effDateStr) return;
    const rec = attendanceLog[key];
    if (!rec.checkIn) return;
    const dw = new Date(dateStr + 'T12:00:00').getDay();
    if (dw === 0 || dw === 6) return;               // ← เช็คแค่เสาร์-อาทิตย์
    const [h, m] = rec.checkIn.split(':').map(Number);
    const lateMin = h * 60 + m - stdStart;
    if (lateMin <= 0) return;
    const tier = (policy.tiers || []).find(t => lateMin >= t.fromMin && lateMin <= t.toMin);
    if (tier) { count++; deductMin += tier.deductMin; }
  });
  return { count, deductMin };
}
```

**ปัญหา:** ฟังก์ชันนี้เช็คแค่ "ไม่ใช่เสาร์-อาทิตย์" แล้วถือว่าเป็นวันทำงานปกติทันที **ไม่เช็ค `isPublicHoliday(dateStr)` หรือ `isCompanyTripDay(dateStr)` เลย** — ต่างจาก `generatePeriodDays()`/`computePayroll()` ที่กันวันพวกนี้ไว้ชัดเจนทุกจุด (company-trip: "never counts as late/absent and never earns early/late/OT/upcountry bonuses" — comment ที่ `app.js:2144-2146`; holiday: แยก status `'holiday'` ต่างหาก)

**ผลกระทบจริง:** ถ้าพนักงานมาสแกนเข้างานหลัง 8:30 ในวันหยุดนักขัตฤกษ์ หรือวันที่บริษัทพาไป company trip (เช่น สแกนตอนไปรวมตัวขึ้นรถ, หรือแวะเข้าออฟฟิศก่อนไปทริป) → ระบบนับเป็น "มาสาย" แล้ว**หักวันลาพักร้อนจริง** (`deductMin` ไปลด `remMin` ใน balance check ที่ `app.js:7216` และโชว์ผิดในหน้า balance ที่ `:8256`) ทั้งที่วันนั้นไม่ควรถูกนับตามกฎเวลาทำงานปกติเลย

**วิธีทำ:**
1. เพิ่มเงื่อนไขข้าม: `if (isPublicHoliday(dateStr) || isCompanyTripDay(dateStr)) return;` ต่อจากบรรทัดเช็ค `dw === 0 || dw === 6`
2. **ต้อง verify กับ user ก่อนใช้จริง** (ไม่ใช่แค่โค้ด — กระทบยอดวันลาจริงของพนักงาน): ควร recompute ยอดวันลาที่เคยถูกหักผิดของพนักงานที่มีประวัติ late-deduct ทับวันหยุด/company-trip ไหม หรือปล่อยของเก่าไว้ (grandfather) แล้วแก้แค่ไปข้างหน้า — เป็นการตัดสินใจเชิงนโยบาย ไม่ใช่แค่ patch โค้ด
3. **คำถามรอง (ไม่ใช่บั๊กชัดเจน ต้องถาม):** `computePayroll()` ยกเว้น role `accounting`/`marketing` จาก early/late bonus (`isAcctMkt` check) เพราะอาจไม่มีตารางเข้างานแบบฟิลด์เดียวกับ role อื่น — `computeLateDeductMinutes()` ไม่มี exclusion นี้เลย ควรมีไหม (สอง feature คนละวัตถุประสงค์ — bonus ให้ vs deduction ลง — อาจตั้งใจให้ต่างกันก็ได้ อย่าแก้เองโดยไม่ถาม)

**Verify หลังแก้:** สร้าง holiday ทดสอบ + attendance record ที่ checkIn สายในวันนั้น (ผ่าน test data ไม่ใช่ account จริง) → เรียก `computeLateDeductMinutes` → `count`/`deductMin` ต้องเป็น 0 สำหรับวันนั้น

---

## ✅ ส่วนที่ตรวจแล้วไม่พบปัญหา
- **`generatePeriodDays()`** (`:2118-2235`): status precedence ถูกต้อง (company-trip > weekend > future-holiday > future > real-record > absent), leave overlay ทำงานหลัง base status ตามลำดับที่ควร (annual/sick/business overlay ทับ status, upcountry/long-distance/time-correction/late-out overlay flag เพิ่มโดยไม่ทับ status เว้นแต่ time-correction ที่ recompute late/present ใหม่ถูกต้องตาม role driver-exception)
- **OT/early/late bonus ใน `computePayroll()`**: กันวัน company-trip + accounting/marketing ถูกต้องสม่ำเสมอ (จุดที่ T-01 ขาดไปคือจุดเดียวที่ไม่สม่ำเสมอกับ pattern นี้)
