# Frontend Logic Review — for Sonnet 4.6 to fix

**Reviewer:** Opus 4.8 · **Date:** 2026-07-21
**Scope:** ก้อนที่ยังไม่เคยตรวจ — 50-ทวิ, payroll history, Finalize, approval state machine, date/period calculation
**File:** `Z:\attendance\js\app.js` (live NAS mount — แก้แล้วมีผลทันที ไม่ต้อง deploy backend)
**อ่านแล้วไม่ตรวจซ้ำ:** computePayroll/calcAnnualTax core (ถูกต้อง), generatePeriodDays (ถูกต้อง + T-01 แก้แล้ว), security F-01..F-18 (ปิดแล้ว)

หลักการเดียวกับ Sprint 1-3: อ่านโค้ดจริงก่อนแก้, node --check / Playwright smoke test หลังแก้, **อย่าตัดสินใจเชิงนโยบายเงิน/ภาษีเอง** — ข้อไหน mark ⚠️ NEEDS-DECISION ต้องถาม user ก่อน

---

## สรุปที่เจอ

| # | ระดับ | เรื่อง | ต้องถาม user? |
|---|-------|--------|----------------|
| FL-01 | 🔴 HIGH | Manual Adjustments (`manualNet`) หายจาก Bank CSV / PND1 / SSO / Summary / Payroll History / 50-ทวิ — จ่ายเงินไม่ตรง payslip | ไม่ (bug ชัด) |
| FL-02 | 🔴 HIGH | ปุ่ม 📧 Email Payslip ส่งข้อมูลพัง — ส่ง `userId` (number) แทน user object + property ผิดชื่อ | ไม่ (bug ชัด) |
| FL-03 | 🟠 MED-HIGH | `bonus` ไม่โผล่บน payslip ที่พนักงานเห็น/พิมพ์ (แต่ bank จ่ายรวม bonus) | ⚠️ ใช่ (นโยบายว่าจะโชว์ bonus บนสลิปไหม) |
| FL-04 | 🟡 MED | 50-ทวิ dropdown ให้เลือกย้อน 5 ปี แต่ loop ดึงข้อมูลแค่ ~2 ปี → ปีเก่าโชว์ว่าง/ไม่ครบ | ไม่ |
| FL-05 | 🟡 MED | PND1/SSO export ปี พ.ศ. ไม่บวกปีสำหรับรอบเดือนธันวาคม (จ่ายเดือน ม.ค. ปีถัดไป) | ไม่ |
| FL-06 | 🟡 MED | `processYearEndCarryForward` hardcode `maxAnnual = 10` แต่สิทธิลาจริงคือ `u.annualLeave` (default 6) → ยกยอดเกิน | ⚠️ ใช่ (ยืนยัน leave-balance model) |
| FL-07 | 🟢 LOW | `calcFinalizeEmployee` ไม่รับ period index — ใช้ global `finalizeSelectedPeriodIndex` เสมอ → `isCurrent` ผิดตอนคำนวณรอบอื่น | ไม่ |
| FL-08 | 🟢 LOW | `getPeriodBounds`: `ed = sd - 1 || 20` พังถ้า periodStartDay = 1 | ไม่ |
| FL-09 | 🟢 LOW | `getPeriodStartForDate` ใช้ `new Date(dateStr)` (parse เป็น UTC) — เปราะเรื่อง timezone | ไม่ |

**Approval state machine (frontend):** ตรวจแล้ว `isMyTurnOrDelegate()` (723), `computeNextStatus()` (2048), approval action (6388-6413), `mdApprovePayrollForEmployee()` (10561) — **แข็งแรงถูกต้อง** turn-check + stored route snapshot (`l.approvalRoute`) + period-lock gate + accounting-delegate ครบ ไม่พบช่องข้ามขั้น/self-approve ฝั่ง frontend (backend F-02 ก็บังคับซ้ำอยู่แล้ว) ไม่มีอะไรต้องแก้ในก้อนนี้

---

## 🔴 FL-01 (HIGH) — Manual Adjustments หายจากทุก export/report ยกเว้นหน้า Finalize + payslip

### ปัญหา
ฟีเจอร์ "💰 Manual Adj." (`saved.manualAllowances[] = {type, amount, advance}`) — `amount` บวกเข้ารายได้, `advance` หักออกจาก net. Helper `_getFinalizeManualNet(key)` (บรรทัด 11381) = Σ(amount − advance).

`manualNet` ถูกรวมใน **หน้า Finalize** (11298) และ **payslip** (5724-5725: `netPay = grossIncome + manualIncomeTotal − ssf − pvd − pit − manualAdvanceTotal`) — แต่ **หายไปจากทุกที่ที่คำนวณ net/gross ที่เหลือ**:

| จุด | บรรทัด | สูตร net/gross ปัจจุบัน | ขาด |
|-----|--------|------------------------|-----|
| `exportBankCSV()` | 1104 | `grossIncome + bonus − ssf − pvd − pit` | **manualNet** ← นี่คือยอดโอนจริงเข้าบัญชี |
| `exportPayrollSummaryCSV()` | 1168 | `grossIncome + bonus − ssf − pvd − pit` | manualNet |
| `renderPayrollHistory()` | 11181,11183 | gross/net ไม่รวม manual | manualNet |
| `render50Tawi()` | 1002 | `grossIncome + bonus` | manualNet |
| `exportPND1CSV()` | 1125 | เงินได้ = `calc.grossIncome` | manual income (+ bonus) |

**ผลกระทบร้ายแรงสุด = `exportBankCSV`**: ยอดที่โอนเข้าบัญชีพนักงานจริง **ไม่ตรงกับ payslip และไม่ตรงกับคอลัมน์ Net บนหน้า Finalize** ทุกครั้งที่มี Manual Adj. — ถ้ามี advance (หักเงินเบิกล่วงหน้า) พนักงานจะได้เงิน**เกิน** (bank ไม่หัก), ถ้ามี allowance พิเศษจะได้**ขาด**.

### วิธีแก้
เพิ่ม `manualNet` เข้าสูตร net ให้ตรงกับ `renderFinalize` (11298) ทุกจุด:

1. **`exportBankCSV()` (1104):**
```js
const manualNet = _getFinalizeManualNet(fKey);   // fKey มีอยู่แล้วบรรทัด 1098
const net = calc.grossIncome + bonus + manualNet - calc.ssf - calc.pvd - pit;
```
2. **`exportPayrollSummaryCSV()` (1168):** `const net = c.grossIncome + bonus + _getFinalizeManualNet(fKey) - c.ssf - c.pvd - pit;` — `fKey` มีบรรทัด 1163. พิจารณาเพิ่มคอลัมน์ "Manual Adj." ใน header ด้วย (line 1153-1160) เพื่อความโปร่งใส
3. **`renderPayrollHistory()` (11181-11183):**
```js
const mNet = _getFinalizeManualNet(fKey);   // fKey บรรทัด 11173
totalGross += c.grossIncome + bonus + Math.max(0, mNet);  // ดูหมายเหตุด้านล่าง
totalNet   += c.grossIncome + bonus + mNet - c.ssf - c.pvd - pit;
```
   > หมายเหตุ gross: manual มีทั้ง amount(+) และ advance(−). "gross" ควรรวมเฉพาะ income (amount) ไม่ใช่ advance. ถ้าอยากเป๊ะให้ดึง `manualIncomeTotal` แยก (เหมือน payslip 5722) แทน `Math.max`. Net ใช้ `mNet` เต็ม (amount−advance) ถูกต้อง
4. **`render50Tawi()` (1001-1002):** ⚠️ อ่านหมายเหตุ — 50-ทวิ คือเงินได้ทั้งปีเพื่อออกหนังสือรับรองหักภาษี ณ ที่จ่าย. Manual `amount` ที่เป็นเงินได้พึงประเมินควรเข้า gross, แต่ `advance` (เงินเบิกล่วงหน้า/หักคืน) **ไม่ใช่**เงินได้ — อย่าเอา `advance` ไปลด gross ของ 50-ทวิ. ใช้ `manualIncomeTotal` (เฉพาะ amount) ไม่ใช่ `manualNet`:
```js
const _mas = saved.manualAllowances || [];
const manualIncome = _mas.reduce((s, ma) => s + (ma.amount || 0), 0);
const gross = calc.grossIncome + bonus + manualIncome;
```
5. **`exportPND1CSV()` (1125):** เงินได้ (คอลัมน์ 6) ควรเป็นเงินได้ที่จ่ายจริงเดือนนั้น = `calc.grossIncome + bonus + manualIncome` (เฉพาะ amount ไม่รวม advance เหตุผลเดียวกับ 50-ทวิ). PIT ใช้ `saved.pit` ตามเดิม

### Verify
- สร้าง Manual Adj. 1 คน (amount 2000, advance 500) → หน้า Finalize Net ต้องเท่ากับ payslip Net เท่ากับยอดใน Bank CSV เป๊ะทั้ง 3 ที่
- Payroll History net ของรอบนั้นต้องรวม manual แล้ว
- node --check ผ่าน

---

## 🔴 FL-02 (HIGH) — ปุ่ม 📧 Email Payslip คำนวณข้อมูลพัง

### ปัญหา
`sendPayslipEmail(userId, periodIdx)` (บรรทัด 1970) ผูกกับปุ่ม 📧 บนหน้า Finalize (`onclick="sendPayslipEmail(${u.id},...)"` บรรทัด 11349) — ส่ง `u.id` เป็น **number**.

บรรทัด 1981: `const payroll = computePayroll(userId, start);` — แต่ `computePayroll(user, start, end, periodIndex)` (5487) คาดหวัง **user object** (อ่าน `user.salary`, `user.role`, `user.id`) และต้องการ `end`:
- ส่ง number → `user.salary` = undefined → `base = 0` → ทุกอย่างเพี้ยนเป็น 0/ผิด
- ไม่ส่ง `end` → `generatePeriodDays(start, undefined,...)` loop `d <= undefined` = false ตลอด → pDays ว่าง

แถม property ที่ map ผิดชื่อ (1985-1997) — `computePayroll` **ไม่ได้** return ชื่อพวกนี้:
| payslip object ส่งไป | ค่าจริงที่ได้ | ควรเป็น |
|----------------------|--------------|---------|
| `baseSalary: payroll.baseSalary` | undefined | `payroll.base` |
| `diligence: payroll.diligenceBonus` | undefined | `payroll.diligenceAllowance` |
| `otPay: payroll.otPay` | undefined | `payroll.otAmount` |
| `pit: payroll.pit` | undefined | ควรใช้ `finalizeData[fKey]?.pit ?? payroll.autoPit` |
| `netIncome: payroll.netIncome` | undefined | ต้องคำนวณเอง (computePayroll ไม่คืน net) |

→ อีเมลสลิปที่ส่งออกไปโชว์เงินเดือน/ภาษี/สุทธิเป็นค่าว่าง/undefined/0

### วิธีแก้
```js
async function sendPayslipEmail(userId, periodIdx) {
  if (blockIfObserver()) return;
  const emp = DATA_USERS.find(u => u.id === userId);
  if (!emp?.email) { /* ...เดิม... */ return; }
  const cfg = APP_SETTINGS.emailConfig || {};
  if (!cfg.user) { /* ...เดิม... */ return; }

  const { start, end } = getPeriodBounds(periodIdx);          // ← เพิ่ม end
  const payroll = computePayroll(emp, start, end, periodIdx); // ← ส่ง object + end + index
  const fKey = getFinalizeKey(start, userId);
  const saved = finalizeData[fKey] || {};
  const pit = saved.pit !== undefined ? saved.pit : payroll.autoPit;
  const bonus = saved.bonus || 0;
  const mas = saved.manualAllowances || [];
  const manualIncome  = mas.reduce((s, ma) => s + (ma.amount || 0), 0);
  const manualAdvance = mas.reduce((s, ma) => s + (ma.advance || 0), 0);
  const netIncome = payroll.grossIncome + bonus + manualIncome - payroll.ssf - payroll.pvd - pit - manualAdvance;
  const periodLabel = start.toLocaleDateString(currentLang === 'ja' ? 'ja-JP' : currentLang === 'en' ? 'en-US' : 'th-TH', { year: 'numeric', month: 'long' });

  const payslip = {
    employeeName: emp.name,
    periodLabel,
    baseSalary:   payroll.base,
    diligence:    payroll.diligenceAllowance,
    otPay:        payroll.otAmount,
    bonus,
    grossIncome:  payroll.grossIncome,
    ssf:          payroll.ssf,
    pvd:          payroll.pvd,
    pit,
    netIncome
  };
  /* ...ส่วน apiFetch เดิม... */
}
```
> ⚠️ ก่อนแก้: ไปอ่าน server-side `buildPayslipHtml` ใน `server.js` ว่าใช้ key ชื่ออะไรบ้าง (`baseSalary`/`diligence`/`otPay`/`netIncome`?) — map ให้ตรงกับที่ server อ่านจริง ตัวอย่างข้างบนอิงชื่อ key เดิมใน object นี้ ถ้า server อ่านชื่ออื่นให้ยึด server เป็นหลัก. **นี่คือเหตุผลที่ต้องเช็ค ไม่ใช่แก้ดะ**

### Verify
- ตั้งค่า email แล้วกด 📧 ให้พนักงานที่ confirm แล้ว 1 คน → อีเมลต้องมี base/OT/net เป็นตัวเลขจริง ตรงกับ payslip บนจอ
- ยอด net ในอีเมลต้องรวม bonus + manual ตรงกับ Bank CSV (หลังแก้ FL-01)

---

## 🟠 FL-03 (MED-HIGH, ⚠️ NEEDS-DECISION) — `bonus` ไม่โผล่บน payslip ที่พนักงานเห็น

### ปัญหา
`renderPayslip()` (5637) — net = `grossIncome + manualIncomeTotal − ssf − pvd − pit − manualAdvanceTotal` (5725) **ไม่มี `bonus`** และไม่มี income row สำหรับ bonus ในสลิปเลย. แต่ `bonus` (ที่ accounting กรอกในหน้า Finalize) **ถูกจ่ายจริง**ผ่าน Bank CSV (1104) + นับใน Finalize Net (11298) + Summary + History.

→ พนักงานที่ได้โบนัส: payslip ที่พิมพ์/เห็นบนจอ แสดง net **น้อยกว่า**เงินที่โอนเข้าบัญชีจริง และไม่มีบรรทัดโบนัสให้เห็นเลย

### ทำไมต้องถาม user ก่อน
อาจตั้งใจ (บางบริษัทจ่ายโบนัสแยกสลิป/แยกโอน) หรืออาจเป็น bug. **อย่าแก้เอง** — ถาม user 2 ทาง:
- **(ก)** โบนัสควรโชว์บน payslip เป็น income row + รวมใน net → เพิ่ม row ในส่วน income ของ renderPayslip + `netPay += bonus` (5725) + เพิ่ม element ใน payslip HTML template
- **(ข)** โบนัสตั้งใจแยกจาก payslip ปกติ → ไม่ต้องแก้ payslip แต่ควรมี note ว่าโบนัสจ่ายแยก เพื่อกันความสับสนตอน reconcile

### Verify (ถ้าเลือก ก)
กรอก bonus 5000 → payslip โชว์ row bonus + net เพิ่ม 5000 ตรงกับ Finalize/Bank

---

## 🟡 FL-04 (MED) — 50-ทวิ ปีเก่าโชว์ข้อมูลไม่ครบ

### ปัญหา
`render50Tawi()` loop `for (let i = 0; i <= 24; i++)` (บรรทัด 989) = ~25 เดือน ≈ 2 ปีย้อนหลัง. แต่ dropdown ปี (`populateTawi50YearDropdown` บรรทัด 1235: `y >= curYear - 4`) ให้เลือกย้อน **5 ปี**. เลือกปีที่ 3-4 ปีก่อน → loop `break` ที่ `end.getFullYear() < year` ไม่ทันถึงข้อมูลปีนั้น → ตารางว่างหรือไม่ครบ

### วิธีแก้
ขยายเพดาน loop ให้คลุมช่วง dropdown: เปลี่ยน `i <= 24` เป็น `i <= 60` (5 ปี). loop มี `if (end.getFullYear() < year) break;` อยู่แล้ว จึงไม่ทำงานเกินจำเป็น (break ทันทีที่เลยปีเป้าหมาย) — แค่ต้องยอมให้ i เดินได้ไกลพอถึงปีที่เลือก

### Verify
เลือกปี `curYear - 3` และ `curYear - 4` ใน dropdown → ถ้ามี finalizeData ปีนั้น ต้องโชว์ครบ (ทดสอบด้วยข้อมูล QA ไม่ใช่ข้อมูลจริง)

---

## 🟡 FL-05 (MED) — PND1/SSO export: ปี พ.ศ. ไม่บวกสำหรับรอบเดือนธันวาคม

### ปัญหา
`exportPND1CSV()` (1113-1114) และ `exportSSOCSV()` (1133-1134):
```js
const y = start.getFullYear() + 543;                              // ← ไม่ roll ปี
const m = p2(start.getMonth() + 2 > 12 ? 1 : start.getMonth() + 2);
```
รอบที่ start = **21 ธ.ค. 2026** (getMonth()=11) → เงินเดือนจ่ายปลายเดือน ม.ค. 2027 → PND1/SSO เดือนที่ยื่น = มกราคม. โค้ด `m` roll เป็น "01" ถูก แต่ `y` ยังเป็น `2026+543 = 2569` ทั้งที่มกราคม 2027 = **พ.ศ. 2570**. ไฟล์เลยชื่อ `PND1_256901.csv` (ปีผิด 1 ปี) เฉพาะรอบเดือนธันวาคม (ปีละครั้ง)

### วิธีแก้
roll ปีเมื่อเดือน overflow ทั้ง PND1 และ SSO:
```js
const rawMonth = start.getMonth() + 2;           // 2..13
const rollYear = rawMonth > 12;
const y = start.getFullYear() + (rollYear ? 1 : 0) + 543;
const m = p2(rollYear ? rawMonth - 12 : rawMonth);
```
(แก้เหมือนกันทั้ง `exportPND1CSV` 1113-1114 และ `exportSSOCSV` 1133-1134)

### Verify
ตั้ง period index ให้ตกรอบเดือน ธ.ค. → ชื่อไฟล์ export ต้องเป็นปี พ.ศ. ถัดไป เดือน 01

---

## 🟡 FL-06 (MED, ⚠️ NEEDS-DECISION) — Carry-forward hardcode สิทธิลา 10 วัน

### ปัญหา
`processYearEndCarryForward()` (บรรทัด 940): `const maxAnnual = 10;` แล้ว `remaining = max(0, 10 − usedDays)`. แต่สิทธิลาพักร้อนจริง**ตั้งต่อคน** = `u.annualLeave` (ใช้เป็น entitlement ที่ 4489, 7206; ฟอร์ม default 6 ที่ 4919). พนักงานที่ `annualLeave = 6` จะถูกคำนวณ remaining จากฐาน 10 → **ยกยอดเกินจริง**

### ทำไมต้องถาม user
ต้องยืนยัน leave-balance model ก่อน (ดู [[feedback_attendance_users_data]] — อย่าแตะ balance มั่ว): `u.annualLeave` เป็น "สิทธิคงที่ทั้งปี" หรือ "ยอดคงเหลือ live" (บรรทัด 6600 มีการ `u.annualLeave += days` ตอน comp leave → ดูเหมือน live balance). ถ้าเป็น live balance การคิด `maxAnnual − usedDays` ซ้ำอาจ double-count. **ต้องให้ user/บัญชียืนยันว่าสิทธิตั้งต้นต่อคนอยู่ field ไหน แล้วค่อยแก้** — น่าจะเปลี่ยน `const maxAnnual = 10;` เป็น `const maxAnnual = u.annualLeave || 6;` แต่ต้องยืนยันก่อน

### Verify
หลังยืนยัน model: รัน carry-forward กับพนักงาน QA ที่ annualLeave=6 → ยอดยกไปต้อง ≤ 6−used และ ≤ carryForwardMax

---

## 🟢 FL-07 (LOW) — `calcFinalizeEmployee` ไม่รับ period index

`calcFinalizeEmployee(user, start, end)` (10618) เรียก `computePayroll(user, start, end, finalizeSelectedPeriodIndex)` — ใช้ **global** `finalizeSelectedPeriodIndex` เสมอ ไม่ว่าจะคำนวณรอบไหน. `render50Tawi`/`renderPayrollHistory` วน period หลายรอบ แต่ `isCurrent` (=`periodIndex===0`) อิงรอบที่เลือกบนหน้า Finalize ไม่ใช่รอบที่กำลังวน. ปัจจุบัน**ไม่ก่อ bug จ่ายเงินผิด** (isCurrent กระทบแค่ future-day masking ซึ่งรอบอดีตไม่มี future day) แต่เปราะ

**แก้ (optional, robustness):** เพิ่ม param
```js
function calcFinalizeEmployee(user, start, end, periodIndex = finalizeSelectedPeriodIndex) {
  const c = computePayroll(user, start, end, periodIndex);
  ...
```
แล้วส่ง index ที่ถูกจากผู้เรียกที่วน loop (`render50Tawi` ส่ง `i`, `renderPayrollHistory` หา index จริงหรือส่ง `-1` เพื่อบังคับ isCurrent=false สำหรับรอบอดีต). ระดับ LOW — ทำได้แต่ไม่เร่ง

---

## 🟢 FL-08 (LOW) — `getPeriodBounds` พังถ้า periodStartDay = 1

บรรทัด 2094: `const ed = sd - 1 || 20;` — ถ้า `sd = 1` แล้ว `sd - 1 = 0` (falsy) → `ed = 20` ผิด (ควรเป็นวันสุดท้ายของเดือน). Default 21 ปลอดภัย แต่ถ้า admin ตั้ง period start = 1 จะเพี้ยน. **แก้:** `const ed = (sd === 1) ? 0 : sd - 1;` แล้วจัดการ ed=0 = วันสุดท้ายเดือนก่อน (ใช้ `new Date(y, m, 0)`). ระดับ LOW (ค่าที่ไม่น่าตั้งจริง) — แก้เชิงกันไว้

---

## 🟢 FL-09 (LOW) — `getPeriodStartForDate` parse เป็น UTC

บรรทัด 863: `const d = new Date(dateStr);` — `new Date('2026-07-21')` parse เป็น UTC midnight. ไทย UTC+7 จึง `getDate()` ยังได้ 21 ถูก (ปลอดภัยในไทย) แต่ถ้ารันใน timezone ติดลบจะเลื่อนวัน. ฟังก์ชันนี้ใช้ใน period-lock gate ตอน approve (6377) — ถ้า parse เพี้ยนอาจเช็ค lock ผิดรอบ. **แก้เชิงกันไว้:** parse แบบ local เหมือนที่อื่นในไฟล์:
```js
const [yy, mm, dd] = dateStr.split('-').map(Number);
const d = new Date(yy, mm - 1, dd);
```
ระดับ LOW (ไม่กระทบตราบใดรันในไทย)

---

## หมายเหตุปิดท้าย
- FL-01, FL-02 เป็น bug จริงชัดเจน แก้ได้เลย (ไม่ต้องถาม)
- FL-03, FL-06 mark ⚠️ NEEDS-DECISION — **หยุดถาม user ก่อน** อย่าแก้เอง ([[feedback_attendance_confirm_before_build]])
- FL-04, FL-05 แก้ได้เลย, FL-07/08/09 optional robustness
- ทดสอบเงินทั้งหมดด้วยข้อมูล QA ไม่ใช่ข้อมูลพนักงานจริง ([[feedback_attendance_no_real_data_display]])
- หลังแก้: node --check + Playwright smoke (login QA account, เปิดหน้า Finalize/50-ทวิ/Payslip, ไม่มี console error) ([[feedback_attendance_use_playwright]])
