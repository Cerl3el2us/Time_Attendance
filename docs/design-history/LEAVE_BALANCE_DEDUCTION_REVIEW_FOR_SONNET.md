# Leave Balance Deduction Review — Opus 4.8 → Sonnet Fix Plan
Date: 2026-07-21

## จุดที่ balance ถูก "หัก" หรือ "เพิ่ม" — map ทั้งระบบ

| กลไก | ที่ไหน | ทิศทาง |
|---|---|---|
| ยื่นลา annual/business (gate) | `submitLeave` 7232-7258 | ตรวจก่อนหัก (ครอบใน LS review แล้ว) |
| แสดงยอดคงเหลือ | `renderLeaveBalance` 8274-8295 | คำนวณ used/remaining |
| มาสายหักวันลา | `computeLateDeductMinutes` 1826-1851 | **หัก** annual |
| วันหยุดชดเชย (comp) อนุมัติ | `applyApprovalToLog` 6627-6638 | **เพิ่ม** annual entitlement |
| ยกยอดปลายปี | `processYearEndCarryForward` 932-956 | snapshot → ปีถัดไป |

## ส่วนที่ตรวจแล้ว — ถูกต้อง ✅

- `computeLateDeductMinutes` **year-scoped ถูก** (1837), `effectiveFromPeriod` ถูก, **ข้าม weekend/public holiday/company-trip ถูก** (1842-1843 = fix T-01 เดิมยังอยู่ครบ), tier matching ถูก
- `key.startsWith(`${userId}_`)` **ปลอดภัย** — underscore กัน prefix ชน (uid "1" ไม่ match "10_")
- Sick leave ไม่มี balance gate — **ตั้งใจ** (ยืนยันจาก FAQ line 10898)
- late-deduct ถูกลบออกจาก remaining ทั้ง gate (7247) และ display (8287) — **consistent**

---

## Bug ที่พบ

### BD-01 — comp entitlement increment ไม่มี reversal + เสี่ยง lost-update ⚠️ MEDIUM

**ไฟล์:** `/z/attendance/js/app.js`  
**บรรทัด:** 6627-6638

```js
} else if (l.type === 'comp') {
  const u = DATA_USERS.find(x => x.id === l.userId);
  if (u) {
    u.annualLeave = (u.annualLeave || 0) + (l.days || 1);   // ← mutate entitlement ถาวร
    if (u.employeeNo) {
      apiFetch(`/api/users/${u.employeeNo}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ annualLeave: u.annualLeave }),
      }).catch(() => {});
    }
  }
}
```

**ปัญหา 2 อย่าง:**

1. **ไม่มีทางย้อนกลับ:** เมื่อ comp อนุมัติแล้ว `u.annualLeave` ถูกบวกถาวร. `rejectMockLeaveInternal` (6448) แค่ set `status='rejected'` ไม่ลบวันที่บวกไป — และ approved comp ปกติ reject ไม่ได้อยู่แล้ว (isMyTurnOrDelegate return false). ถ้าอนุมัติผิด ต้องไปแก้มือใน employee management เท่านั้น (ไม่มี audit trail ว่าบวกมาจาก comp ใบไหน)

2. **Lost update (read-modify-write ไม่ atomic):** อ่าน `u.annualLeave` จาก DATA_USERS ใน session ผู้อนุมัติ (โหลดตอน login) → บวก → PUT ทับ. ถ้ามี comp ของคนเดียวกันถูกอนุมัติจาก session อื่นระหว่างนั้น ค่าใน session นี้ค้าง (stale) → PUT ทับด้วยค่าเก่า+days = **วันชดเชยหายไป 1 รายการ**

**✅ FIX — USER เลือกแนวทาง 1 แล้ว (2026-07-21): นับ comp เป็น +entitlement ตอนคำนวณ ไม่ mutate field**

ทำ 3 ขั้น:

**1. ลบการ mutate ออกจาก `applyApprovalToLog` (6627-6638)** — comp ที่ approved ไม่ต้องไปยุ่งกับ `u.annualLeave` อีก ให้ทั้ง `else if (l.type === 'comp')` block คืนค่าเปล่า (ไม่ทำอะไร) หรือลบ block ทิ้ง (case comp จะไม่มี attendanceLog write อยู่แล้ว)

**2. เพิ่ม helper นับ comp days ที่ approved ในปีนั้น** (วางใกล้ `getCarryForwardDays` ~927):
```js
function getApprovedCompDays(year, userId) {
  const yStart = `${year}-01-01`, yEnd = `${year}-12-31`;
  return DATA_LEAVES.filter(l =>
    l.userId === userId && l.type === 'comp' && l.status === 'approved' &&
    (l.workedDate || l.dateFrom) >= yStart && (l.workedDate || l.dateFrom) <= yEnd
  ).reduce((s, l) => s + (l.days || 1), 0);
}
```

**3. บวก comp days เข้า entitlement ทั้ง 2 จุด (เฉพาะ type annual):**
- **gate** `submitLeave` ~7235-7237:
  ```js
  const cfDays   = type === 'annual' ? getCarryForwardDays(thisYear, u.id) : 0;
  const compDays = type === 'annual' ? getApprovedCompDays(thisYear, u.id) : 0;
  const totalEntitlement = { annual: u.annualLeave, business: u.businessLeave }[type] || 0;
  const totalMin = (totalEntitlement + cfDays + compDays) * 8 * 60;
  ```
- **display** `renderLeaveBalance` ~8270-8272:
  ```js
  const cfDays   = cfg.type === 'annual' ? getCarryForwardDays(thisYear, u.id) : 0;
  const compDays = cfg.type === 'annual' ? getApprovedCompDays(thisYear, u.id) : 0;
  const effectiveMax = cfg.max + cfDays + compDays;
  ```
  (แนะนำเพิ่ม badge บอก "+N วันชดเชย" คล้าย cfBadge ที่ 8297 เพื่อให้พนักงานเห็นว่ามี comp — optional)

**✅ USER ยืนยันแล้ว (2026-07-21):**
- **ข้อ 1 — Migration: ไม่ต้องทำ** — user ยืนยัน "ยังไม่เคยใช้ฟีเจอร์ comp จริง" → ไม่มี comp record ที่ approved อยู่ → ไม่มี double-count → แก้ได้เลย (แต่ Sonnet ควร sanity-check เร็วๆ: `DATA_LEAVES.filter(l=>l.type==='comp'&&l.status==='approved')` ควรว่าง)
- **ข้อ 2 — comp ยกยอดข้ามปีได้** → ต้องแก้ `processYearEndCarryForward` (932) ด้วย (ขั้นที่ 4 ด้านล่าง)

**shape ของ comp record (ยืนยันจากโค้ด):** `submitComp` (8090-8098) สร้าง `dateFrom = dateTo = workedDate`, `days: 1`, `type: 'comp'` → helper `(l.workedDate || l.dateFrom)` + `(l.days || 1)` ถูกต้อง

**4. แก้ `processYearEndCarryForward` (932-948) ให้ comp ยกยอดได้:**
```js
DATA_USERS.filter(u => u.active).forEach(u => {
  const usedDays = DATA_LEAVES.filter(l =>
    l.userId === u.id && l.type === 'annual' && l.status === 'approved' &&
    l.dateFrom >= startOfYear && l.dateFrom <= endOfYear
  ).reduce((sum, l) => sum + (l.days || 0), 0);
  const compDays = getApprovedCompDays(thisYear, u.id);   // ← NEW: comp ที่ได้ปีนี้
  const maxAnnual = 10;
  const remaining = Math.max(0, maxAnnual + compDays - usedDays);   // ← บวก comp เข้า pool
  const cf = Math.min(remaining, maxCF);
  LEAVE_CARRY_FORWARD[getCarryForwardKey(thisYear + 1, u.id)] = cf;
});
```
**⚠️ caveat ที่ Sonnet ต้อง flag กลับหา user (ไม่ block งาน แต่ต้องบอก):** ยอดยกไปถูก cap ด้วย `maxCF` (`APP_SETTINGS.leave.carryForwardMax`, default 5). ถ้าพนักงานมี comp เยอะ (เช่น annual เหลือ 5 + comp 3 = remaining 8) ยอดยกจะถูกตัดเหลือ 5 → **comp ส่วนเกิน cap หายไป**. ถ้า user ต้องการให้ comp ยกยอดได้เต็มโดยไม่ติด cap ต้องเปลี่ยน logic (เช่น `cf = Math.min(annualRemaining, maxCF) + unusedCompDays`) — แต่ต้องถาม user ก่อนเพราะ "unused comp" ต้องนิยามว่าหักการใช้จาก annual ก่อนหรือ comp ก่อน. **เบื้องต้นใช้เวอร์ชัน cap รวมด้านบนไปก่อน + แจ้ง user ว่ามี caveat นี้**

---

### BD-02 — computeLateDeductMinutes เพิกเฉยต่อ time-correction / leave ที่อนุมัติแล้ว (หลัง reload) ⚠️ MEDIUM-HIGH

**ไฟล์:** `/z/attendance/js/app.js`  
**บรรทัด:** 1834-1849

```js
Object.keys(attendanceLog).forEach(key => {
  ...
  const rec = attendanceLog[key];
  if (!rec.checkIn) return;
  ...
  const [h, m] = rec.checkIn.split(':').map(Number);   // ← ใช้ checkIn ดิบจาก attendanceLog
  const lateMin = h * 60 + m - stdStart;
  if (lateMin <= 0) return;
  const tier = ...;
  if (tier) { count++; deductMin += tier.deductMin; }
});
```

**ปัญหา:** ฟังก์ชันนี้อ่าน `attendanceLog` **ดิบ** ซึ่งหลัง reload ถูก rebuild จาก `/api/events` (loadAttendanceFromBackend) = **เวลา scan ดิบเท่านั้น ไม่มี overlay ของ approved corrections/leaves**. corrections/leaves อยู่ใน `DATA_LEAVES` ซึ่งฟังก์ชันนี้ไม่แตะเลย ต่างจาก `generatePeriodDays` ที่ overlay ให้. ผลคือ:

- พนักงานสแกนเข้าสาย 09:00 แล้วได้ **time-correction อนุมัติ**แก้เป็น 08:20 → หลัง reload `computeLateDeductMinutes` ยังเห็น 09:00 → **หักวันลาพักร้อนทั้งที่แก้เวลาถูกอนุมัติแล้ว**
- วันที่เป็น **approved annual/sick/business leave** แต่พนักงานเผลอสแกนเข้าสายก่อนกลับ → ฟังก์ชันนับเป็นมาสาย → **หักวันลาซ้ำบนวันที่ลาอยู่แล้ว**

(หมายเหตุ: มีผลเฉพาะเมื่อ `lateDeductPolicy.enabled = true` — ถ้าปิดอยู่ยังไม่กระทบ แต่เป็นระเบิดเวลาเมื่อเปิด)

**FIX:** ก่อนนับมาสายแต่ละวัน ต้อง consult `DATA_LEAVES` (approved) เหมือน generatePeriodDays:

```js
Object.keys(attendanceLog).forEach(key => {
  if (!key.startsWith(`${userId}_`)) return;
  const dateStr = key.slice(String(userId).length + 1);
  if (!dateStr.startsWith(yearStr)) return;
  if (dateStr < effDateStr) return;
  const rec = attendanceLog[key];
  const dw = new Date(dateStr + 'T12:00:00').getDay();
  if (dw === 0 || dw === 6) return;
  if (isPublicHoliday(dateStr) || isCompanyTripDay(dateStr)) return;

  // NEW: ข้ามวันที่อยู่ในช่วง approved annual/sick/business leave
  const onLeave = DATA_LEAVES.some(l =>
    l.userId === userId && l.status === 'approved' &&
    ['annual','sick','business'].includes(l.type) &&
    dateStr >= l.dateFrom && dateStr <= (l.dateTo || l.dateFrom)
  );
  if (onLeave) return;

  // NEW: ถ้ามี approved time-correction ของ checkIn วันนี้ ใช้เวลาที่ถูกแก้แทน
  const corr = DATA_LEAVES.find(l =>
    l.userId === userId && l.status === 'approved' &&
    l.type === 'time-correction' && l.correctionField === 'checkIn' &&
    l.dateFrom === dateStr
  );
  const effectiveCheckIn = corr ? corr.correctedTime : rec.checkIn;
  if (!effectiveCheckIn) return;

  const [h, m] = effectiveCheckIn.split(':').map(Number);
  const lateMin = h * 60 + m - stdStart;
  if (lateMin <= 0) return;
  const tier = (policy.tiers || []).find(t => lateMin >= t.fromMin && lateMin <= t.toMin);
  if (tier) { count++; deductMin += tier.deductMin; }
});
```

---

## สรุปสิ่งที่ต้องแก้

| ID | Severity | ไฟล์:บรรทัด | สรุป | หมายเหตุ |
|---|---|---|---|---|
| BD-01 | MEDIUM | app.js:6627 | comp บวก entitlement ถาวร ไม่ reversible + lost-update | **design decision — ถาม user ก่อน** |
| BD-02 | MED-HIGH | app.js:1834 | late-deduct เพิกเฉย approved correction/leave หลัง reload | one function, fix ชัด |

**ลำดับแนะนำ:** BD-02 แก้ได้เลย (ชัดเจน). BD-01 ต้องให้ user เลือกแนวทาง (นับ comp เป็น +entitlement ตอนคำนวณ vs คงการ mutate field + เพิ่ม reversal) ก่อน Sonnet ลงมือ

`node --check` หลังแก้ + ตรวจว่าหน้า leave balance ยังโหลดปกติ (Playwright + QA account)
