# Export / Login-Auth / Navigation Review — Findings for Sonnet (2026-07-22, Opus)

> ก้อนที่ 1, 2, 3 จาก 4 ส่วนที่ยังไม่เคยตรวจ (เว้น FAQ+Misc = ก้อนที่ 4 ไว้ก่อน)
> **Navigation/Routing (`navigateTo()`) ตรวจแล้ว — สะอาด ไม่พบบั๊ก** (จุดที่ดูน่าสงสัยตอนแรก คือ
> `navigateTo('finalize')` บล็อกทุก role ที่ไม่ใช่ accounting รวม MD ด้วย — verify แล้วว่า**ตั้งใจ**
> เพราะ MD อนุมัติ payroll ผ่านการ์ดฝังในหน้า Payslip (`renderPayslipApprovalCard()`, `app.js:10561`)
> ไม่ใช่หน้า Finalize โดยตรง ไม่ต้องแก้อะไร)

---

## 🟠 E-01 — `exportSSOCSV()` คำนวณ SSO แยกจากที่หักจริง เสี่ยงยอดไม่ตรงกับไฟล์ยื่นประกันสังคม

**ที่:** `app.js:1193-1212`
```js
function exportSSOCSV() {
  ...
  const rate = (APP_SETTINGS.sso.rate || 5) / 100;
  const maxSal = APP_SETTINGS.sso.maxSalary || 17500;
  ...
  DATA_USERS.filter(u => u.active && u.role !== 'md').forEach(u => {
    const calc = calcFinalizeEmployee(u, start, end);
    const base = Math.min(calc.base, maxSal);
    const emp = Math.round(base * rate);
    const er = Math.round(base * rate);
    rows.push([seq++, u.ssoId || '', u.name, base, emp, er, emp + er]);
  });
  ...
}
```

**เทียบกับของจริงที่หักในสลิป** (`computePayroll()`, `app.js:5482-5485`):
```js
const ssoRate = (S.sso.rate || 5) / 100;
const ssf = base < (S.sso.minSalary || 1650)
  ? 0
  : Math.min(Math.round(base * ssoRate), S.sso.maxAmount || 875);
```

**ปัญหา 2 จุด:**
1. **ไม่เช็ค `minSalary` exemption เลย** — พนักงานฐานเงินเดือนต่ำกว่า `minSalary` (default 1650) ที่จริงหัก SSO = 0 บาท (`computePayroll` คืน 0) แต่ `exportSSOCSV` จะยังคำนวณ `base*rate` ออกมาเป็นตัวเลขจริง (ไม่ใช่ 0) ใส่ในไฟล์ที่ยื่นประกันสังคม
2. **ไม่ใช้ `maxAmount` cap โดยตรง** — ใช้ `Math.min(calc.base, maxSal)` (cap ด้วย maxSalary) แล้วคูณ rate เอง แทนที่จะ cap ผลลัพธ์ด้วย `maxAmount` เหมือน `computePayroll`. ปัจจุบัน default `maxSalary=17500, rate=5%, maxAmount=875` บังเอิญคำนวณตรงกัน (17500×5%=875) **แต่ถ้า admin แก้ค่าใดค่าหนึ่งใน Settings โดยไม่แก้อีกค่าให้สอดคล้อง (เช่นเปลี่ยน rate โดยไม่เปลี่ยน maxAmount) ไฟล์ที่ส่งประกันสังคมจะไม่ตรงกับยอดที่หักจริงจากพนักงาน** — เป็นเอกสารราชการ ความไม่ตรงกันนี้มีความเสี่ยงจริง

**วิธีทำ:** เปลี่ยนให้ `exportSSOCSV()` ใช้ `calc.ssf` ที่คำนวณจาก `computePayroll()` โดยตรง (เหมือนที่ `exportBankCSV`/`exportPND1CSV`/`exportPayrollSummaryCSV` ทำอยู่แล้ว) แทนการคำนวณเอง:
```js
DATA_USERS.filter(u => u.active && u.role !== 'md').forEach(u => {
  const calc = calcFinalizeEmployee(u, start, end);
  const emp = calc.ssf;         // ใช้ค่าที่หักจริง ไม่คำนวณซ้ำ
  const er  = calc.ssf;         // employer contribution มาตรฐาน = employee share เท่ากัน (5% ทั้งคู่) — ยังคง logic เดิมที่ er=emp
  rows.push([seq++, u.ssoId || '', u.name, Math.min(calc.base, maxSal), emp, er, emp + er]);
});
```
(คอลัมน์ "ฐานเงินเดือน" ยังโชว์ `Math.min(calc.base, maxSal)` ได้เหมือนเดิม เป็นแค่ตัวเลขอ้างอิงแสดงผล ไม่ใช่ตัวเลขที่เอาไปคำนวณ — ตัวเลขที่สำคัญคือ emp/er ที่ต้องมาจาก `calc.ssf`)

**Verify:** ตั้ง employee ทดสอบ (test data ไม่ใช่ account จริง) ที่ base salary ต่ำกว่า minSalary → export SSO CSV → คอลัมน์ประกันฯ ต้องเป็น 0 ตรงกับที่ payslip/Bank export คำนวณ (ปัจจุบัน exportBankCSV ใช้ calc.ssf ถูกอยู่แล้ว ใช้เทียบ baseline ได้). ลองแก้ `APP_SETTINGS.sso.rate` ใน Settings ให้ไม่ตรงกับ maxAmount เดิม (เช่น rate ใหม่ที่ไม่ทำให้ maxSalary×rate=maxAmount พอดี) → export SSO CSV ต้องได้ยอดตรงกับ payslip ไม่ใช่ยอดที่คำนวณจาก maxSalary×rate สดๆ

---

## 🟡 L-01 — `restoreSession()` เป็น dead code ที่มีบั๊กฝังอยู่ (ไม่รองรับ Observer)

**ที่:** `app.js:2486-2498`
```js
function restoreSession() {
  try {
    const savedUser = localStorage.getItem('ta_user');
    if (!savedUser) return false;
    const parsed = JSON.parse(savedUser);
    const fresh = DATA_USERS.find(u => u.id === parsed.id && u.active);   // ← ไม่เช็ค isObserver
    if (!fresh) return false;
    currentUser = fresh;
    ...
  } catch(e) { return false; }
}
```

**ยืนยันว่าไม่มีที่ไหนเรียกใช้ฟังก์ชันนี้เลย** (grep `restoreSession()` ทั้งไฟล์ เจอแค่ definition) — ถูก superseded ด้วย inline logic ตอน boot (`app.js` ราว 9260-9270, ใน `DOMContentLoaded` handler) ที่เช็คถูกต้องอยู่แล้ว:
```js
if (saved && (saved.active !== false || saved.isObserver === true)) { currentUser = saved; ... }
```

**ปัญหา:** `restoreSession()` เช็คแค่ `u.active` เฉยๆ — ถ้าเคยถูกเรียกใช้จริงกับ Observer account (`active:false, isObserver:true`) จะ `return false` ทันที ทั้งที่ Observer ควร login ได้ (ตาม design ที่ backend + boot-logic ทั้งคู่ยืนยันตรงกัน) เป็นโค้ดที่ตายแล้วแต่ "ตายพร้อมบั๊กติดตัว" — ถ้าใครเผลอ resurrect เอาไปเรียกใช้ทีหลัง (เช่น refactor ในอนาคต) จะได้บั๊ก Observer login ไม่ได้กลับมาทันที

**วิธีทำ:** ลบฟังก์ชัน `restoreSession()` ทิ้งทั้งหมด (dead code, ไม่มี caller) — ตรงกับ pattern ที่เคยทำมาแล้วในรอบก่อน (R-01 ลบ dead code ใน Reports) ไม่ต้องแก้ logic อะไรเพิ่ม เพราะ boot-time path ที่ใช้งานจริงถูกต้องอยู่แล้ว

**Verify:** `node --check` (จริงๆ คือตรวจ syntax ของ `app.js` ผ่าน node แม้เป็น browser file) ผ่าน + grep `restoreSession` ทั้งไฟล์ต้องไม่เจออะไรเหลือเลย (ลบทั้งฟังก์ชัน ไม่มี caller อยู่แล้วจึงไม่กระทบอะไร)

---

## หมายเหตุเล็ก (ไม่ต้องแก้ ถ้าไม่มีเวลา)
- `exportPND1CSV()` (`:1170-1174`) และ `exportSSOCSV()` (`:1196-1199`) มีโค้ดคำนวณ "เดือนที่จ่าย" (`rawMonth`/`rollYear`/`y`/`m`) เหมือนกันทุกตัวอักษร ซ้ำกัน 2 จุด — โอกาสหน้าถ้าจะรีแฟคเตอร์ ดึงเป็น helper function กลางได้ ไม่เร่งด่วน
