# Payroll Calculation Review — Findings for Sonnet (2026-07-19)

> Opus review ก้อน "คำนวณเงิน/ภาษี (payroll core)". อ่าน logic จริงใน `app.js`
> **ผลรวม: core คำนวณเงินถูกต้องดี ไม่พบบั๊กจ่ายเงินผิดแบบชัดเจน** — ที่เจอเป็นเรื่องประมาณการ PIT / config / ข้อจำกัดที่ accounting ชดเชยด้วยการกรอกมือ
> ฟังก์ชันหลัก: `computePayroll()` `app.js:5393-5510` · `calcAnnualTax()` `:501-510` · net assembly `renderFinalize` `:11191-11202`
> **สำคัญ:** ก้อนนี้ส่วนใหญ่ **ไม่ต้องรีบแก้** — flag ให้ accounting รับรู้ + ตัดสินใจว่าจะปรับไหม. ห้ามแก้ตัวเลขภาษี/SSO โดยไม่ยืนยันกับ user (เป็นเงินจริง+กฎหมาย)

---

## ✅ ส่วนที่ตรวจแล้วถูกต้อง (ยืนยัน — เพื่อให้มั่นใจ)
- **`calcAnnualTax()`** — progressive bracket ถูกต้อง (Math.min cap ต่อ bracket + break conditions + boundary case ตรง). trace 400k → 17,500 ✓
- **PIT method** (`:5491-5497`): annualize → หักค่าใช้จ่าย 50% (cap 100k, `มาตรา 40(1)`) → หักส่วนตัว 60k → หัก SSO×12 + PVD×12 (หักลดหย่อนได้จริง) → calcAnnualTax → ÷12. **เป็นวิธี withholding รายเดือนมาตรฐานที่ถูกต้อง**
- **PVD** (`:5488-5489`): MD=0%, อื่น pvdRate% ของ base ✓
- **OT** (`:5454-5474`): hourlyRate = base/30/8 × multiplier × hours ✓ (ตรงกฎหมายแรงงาน) + guaranteedOT top-up ✓
- **net** (`:11202`): `gross + bonus + manualNet − ssf − pvd − pit` — internally consistent ✓
- **SSO cap-by-amount** = cap-by-wage-ceiling (เทียบเท่ากันทางคณิต) ✓

---

## 🟡 P-01 — autoPit ประเมินสูงเกินในเดือนที่ OT/เบี้ยเลี้ยงเยอะ (annualize ทั้ง gross ×12)
**ที่:** `app.js:5493` — `const annualGross = grossIncome * 12;`
**ปัญหา:** `grossIncome` รวม **OT, upcountry, personal-car, long-distance, early/late bonus** (รายการผันแปร/ครั้งเดียว) แล้วคูณ 12 = สมมติว่าได้เท่านี้ทุกเดือน → เดือนที่ OT เยอะ autoPit จะพุ่งสูงเกินจริง (over-withhold). ตามหลัก ม.50(1) เงินได้ประจำ (เงินเดือน+เบี้ยประจำ) ควร annualize ส่วน OT/โบนัสใช้วิธีแยก ไม่ควรคูณ 12
**ผลกระทบจริง:** **ต่ำ** เพราะ accounting กรอก `saved.pit` เองทุกคนก่อน confirm (autoPit เป็นแค่ค่าตั้งต้นในช่อง) → ไม่ได้จ่ายผิดโดยตรง แต่ค่าตั้งต้นที่เพี้ยนอาจทำให้กรอกตามผิดถ้าไม่ทันสังเกต
**ทางเลือก:** (ก) ปล่อยไว้ + แจ้ง accounting ว่า autoPit เป็นแค่ประมาณการ ต้องปรับเองเดือนที่มี OT/โบนัส; (ข) แยก annualize เฉพาะเงินได้ประจำ (base+transport+posAllowance+housing+allowance3+diligence) แล้วบวก OT/allowance ผันแปรเข้า taxable แบบไม่คูณ 12 — **ต้องยืนยันวิธีกับ accounting/บัญชีบริษัทก่อน** (เป็นนโยบายภาษี ไม่ใช่แค่โค้ด)

## ✅ P-02 — [ปิดแล้ว 2026-07-19] เพดาน SSO 875 ถูกต้อง — user ยืนยัน
> **user ยืนยันแล้วว่า 875 คือค่าที่ถูกต้องสำหรับรอบที่ใช้งานจริง — ห้ามแก้** (เพดาน SSO ปี 2026 = 17,500 → 5% = 875). ข้อความด้านล่างเก็บไว้เป็นบันทึกเฉยๆ ไม่ต้อง action

### (บันทึกเดิม) เพดาน SSO default 875
**ที่:** `app.js:5485` — `Math.min(Math.round(base * ssoRate), S.sso.maxAmount || 875)`
**ปัญหา:** default fallback = 875 (= 5%×17,500). เพดาน SSO ลูกจ้างตามกฎหมายที่ใช้กันมา = **750** (5%×15,000). ถ้าเพดานจริงในรอบที่คำนวณคือ 750 แต่ settings.json ไม่ได้ตั้งค่า → จะหัก SSO เกิน 125/เดือน สำหรับคนเงินเดือน ≥17,500 **และ**ทำให้ SSO ที่หักลดหย่อนภาษี (ssf×12) เพี้ยนตาม
**วิธีทำ:** **อย่าเดา — verify กับ user/accounting** ว่าเพดาน SSO ปีที่ใช้งาน (2026) คือเท่าไร (กฎหมายมีแผนปรับเพดานเป็นเฟส) แล้วตั้ง `APP_SETTINGS.sso.maxAmount` ใน Settings ให้ตรง. ถ้ายืนยันว่า 750 → แก้ค่าใน settings.json (ไม่ใช่แก้ default ในโค้ดอย่างเดียว เพราะ live ใช้ค่าจาก settings). ตรวจ `S.sso.minSalary`/`maxSalary` ด้วยว่าตรงกฎหมาย

## 🟢 P-03 — โบนัส + manual allowance บวกเข้า net หลังหักภาษี (ไม่เข้า autoPit)
**ที่:** `app.js:11196,11201-11202` — `bonus`/`manualNet` บวกเข้า net แต่ไม่อยู่ใน grossIncome ที่ใช้คำนวณ autoPit
**ปัญหา:** โบนัสเป็นเงินได้ที่ต้องเสียภาษีจริง แต่ autoPit ไม่รวม → ถ้ามีโบนัสแล้ว accounting ไม่ปรับ PIT เอง = หักภาษีขาด. manual allowance `amount` ก็บวก net โดยไม่ถูกภาษี/ไม่เข้าฐาน SSO/PVD (อาจตั้งใจ เพราะเป็นรายการปรับครั้งเดียว)
**ผลกระทบ:** ต่ำ (accounting กรอก PIT เองชดเชยได้) — **flag ให้ accounting รับรู้ว่าเดือนที่มีโบนัสต้องปรับ PIT เพิ่มเอง** ไม่ใช่บั๊กโค้ด แต่เป็นจุดพลาดง่ายเชิงปฏิบัติ

## 🟢 P-04 — diligenceAllowance จ่ายให้ non-driver ได้ใน computePayroll แต่ไม่มี UI toggle
**ที่:** `app.js:5478` computePayroll บวก `diligenceAllowance` ให้ทุก user ที่ `user.diligenceAllowance>0`; แต่ `:11200` `hasDiligence = u.role === 'driver'` → toggle จ่าย/ไม่จ่ายโชว์เฉพาะ driver
**ปัญหา:** ถ้ามี non-driver ที่ตั้ง `diligenceAllowance>0` จะได้เบี้ยขยันเข้า gross แต่ไม่มีปุ่ม toggle ให้ปิด (edge case, ปกติมีแค่ driver). แก้: sync เงื่อนไข — computePayroll ควรเช็ค role driver เหมือนกัน หรือ UI แสดง toggle ให้ทุกคนที่มี diligenceAllowance>0. **low priority**

---

## หมายเหตุ — ยังไม่ได้ตรวจในก้อนนี้ (ขึ้นก้อนถัดไป)
- **`generatePeriodDays()`** — เบี้ยเช้า/ดึก/upcountry (`earlyCount`, `lateNightCount`, `upcountryCount`) พึ่ง logic นี้ทั้งหมด ถ้ามันนับ status/วันผิด เบี้ยเลี้ยงจะเพี้ยน → อยู่ในก้อน **"เวลา/OT/เบี้ยเลี้ยง"**
- **`computeLateDeductMinutes()`** (`:1809`) — หักวันลาสายจากยอดพักร้อน → อยู่ในก้อน **"วันลา/สิทธิ์ลา"**
- **50 ทวิ override** (`TAWI50_OVERRIDES`) + payroll history — อยู่ในก้อน 50-ทวิ/ภาษีรายปี
