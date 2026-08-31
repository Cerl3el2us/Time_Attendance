# FAQ + Misc Review — Findings for Sonnet (2026-07-22, Opus)

> ก้อนสุดท้ายจาก 4 ส่วนเดิม (Export/Login-Auth/Navigation ทำไปแล้วในรอบก่อน — ดู `EXPORT_AUTH_NAV_REVIEW_FOR_SONNET.md`)
> `_faqRulesItems()`/`_faqHowToItems()` (`app.js:10863-11010`) ส่วนใหญ่ดึงค่าจาก `APP_SETTINGS` สดทุกจุด
> ไม่มีปัญหา hardcode-ไม่-sync-settings แบบที่เจอใน Reports/Attendance รอบก่อน (STD_START_MIN) —
> **ยกเว้น 1 จุดที่เป็น policy mismatch จริง ไม่ใช่แค่เลข**

---

## 🔴 FAQ-01 — FAQ บอกว่า OT เสาร์-อาทิตย์ได้ ×3.0 แต่โค้ดจริงให้แค่ ×1.5 (ไม่เช็ควันหยุดสัปดาห์)

**FAQ text ที่พนักงานเห็น** (`app.js:10872-10874`):
> "OT starts counting from 17:30. Weekday OT pays ×1.5 of your hourly rate; **holiday/weekend OT pays ×3.0**."
> (ไทย: "OT วันธรรมดาจ่าย ×1.5 ... ส่วน**วันหยุด/เสาร์-อาทิตย์จ่าย ×3.0**")

**โค้ดจริงที่คำนวณเงิน** (`app.js:8010`, ฟังก์ชัน `submitOT()`):
```js
const otMultiplier = isPublicHoliday(date) ? 3 : 1.5;
```
`isPublicHoliday(dateStr)` เช็คแค่ `DATA_HOLIDAYS.some(h => h.date === dateStr)` (`:620-622`) — **ไม่เช็ควันเสาร์-อาทิตย์เลย** ถ้าพนักงานทำ OT วันเสาร์/อาทิตย์ธรรมดา (ไม่ใช่วันหยุดนักขัตฤกษ์ที่ประกาศ) จะได้ ×1.5 ไม่ใช่ ×3.0 ตามที่ FAQ บอกไว้ — **ยืนยันซ้ำใน `computePayroll()` ด้วย** (`:5459-5468`) ที่อ่าน `l.otMultiplier` ตรงจากค่าที่บันทึกไว้ตอนยื่นคำขอ (ไม่ได้คำนวณใหม่) เพราะฉะนั้นตัวเลขที่ผิด (ถ้าผิด) จะเข้า payroll จริงตั้งแต่ตอนยื่นคำขอเลย ไม่ใช่แค่จุดแสดงผล

**นี่คือ policy question ไม่ใช่บั๊กที่ชัดเจนว่าต้องแก้ทางไหน — ต้องถาม user ก่อนแก้:**
1. **ถ้านโยบายจริงคือ "เสาร์-อาทิตย์ก็ต้อง ×3.0 เหมือนวันหยุด"** → โค้ดผิด ต้องแก้ `submitOT()` (และจุดอื่นที่ใช้ otMultiplier เดียวกัน ถ้ามี — grep `isPublicHoliday(date) ? 3` ทั้งไฟล์เพื่อดูว่ามีกี่จุด) ให้เช็ค `d.getDay()===0||d.getDay()===6` ด้วย → **พนักงานที่เคยทำ OT เสาร์-อาทิตย์มาก่อนหน้านี้อาจได้รับเงินขาดไปจริง เป็นเรื่องย้อนหลังที่ต้องตัดสินใจว่าจะตรวจสอบ/จ่ายเพิ่มไหม (เหมือนเคส T-01 leave-balance ก่อนหน้านี้)**
2. **ถ้านโยบายจริงคือ "เฉพาะวันหยุดนักขัตฤกษ์เท่านั้นที่ ×3.0 เสาร์-อาทิตย์ปกติยังคง ×1.5"** → โค้ดถูกอยู่แล้ว แค่ต้องแก้ **ข้อความ FAQ** ให้ตรง (ลบคำว่า "weekend"/"เสาร์-อาทิตย์" ออกจากประโยคนี้ ทั้ง 3 ภาษา — EN/TH/JA)

**ห้าม Sonnet เลือกทางใดทางหนึ่งเอง** — ให้หยุดรอ user ตอบก่อนว่านโยบายจริงคือข้อ 1 หรือ 2 แล้วค่อยแก้ตามนั้น (ถ้าเป็นข้อ 2 แก้ได้เลยเพราะเป็นแค่แก้ข้อความ ไม่กระทบเงิน; ถ้าเป็นข้อ 1 ต้องคุยเรื่อง retroactive correction เพิ่มเหมือนที่เคยทำกับ T-01)

---

## ✅ ส่วนอื่นที่ตรวจแล้วไม่พบปัญหา
- **`_faqRulesItems()`** (`:10863-10938`): ค่าตัวเลขอื่นทั้งหมด (early/late allowance, SSO rate/cap, leave carry-forward, upcountry/personal-car/long-distance rate, payroll period start day) ดึงจาก `APP_SETTINGS` สดทุกจุด ไม่มี hardcode ค้าง, role filter (`roles: [...]`) ตรงกับ business rule จริงที่ยืนยันไว้ในโค้ดคำนวณ (accounting/marketing ไม่มี early/late/upcountry ตรงกับ `isAcctMkt` exclusion ใน computePayroll)
- **`_faqHowToItems()`** (`:10941-11010+`): เนื้อหาตรงกับ behavior จริงที่ยืนยันแล้วในรอบก่อนๆ (17:30 OT start ตรงกับ `submitOT()`, 5AM check-in/out boundary ตรงกับที่ยืนยันไว้แล้วว่า "ตั้งใจ" ในรอบ "Check-in/out" ก่อนหน้านี้)
- **Audit log display** (`renderAuditLog()`): escapeHtml ครบแล้วจากรอบก่อน (DA-01/LH-01 ชุดเดิม) ไม่มีจุดใหม่ที่ตกหล่น
- **`_faqSectionHtml()`** (`:11198-11212`, ไม่ได้แปะโค้ดแต่ตรวจแล้ว): แค่ประกอบ HTML จาก object ที่มาจาก `_faqRulesItems()`/`_faqHowToItems()` เอง (ไม่ใช่ user input) ไม่มีความเสี่ยง XSS

## หมายเหตุความครอบคลุม
"Misc/modal utilities" ตรวจแบบกว้างๆ (ไม่ได้ไล่ทุกฟังก์ชัน modal open/close ทีละบรรทัด) เพราะเวลาจำกัดและ pattern บั๊กที่เจอซ้ำๆ ในรอบก่อน (missing escapeHtml, missing blockIfObserver, hardcode ไม่ sync settings) ไม่พบเพิ่มในการ spot-check รอบนี้ — ถ้าต้องการความมั่นใจเต็มร้อย ต้องแยก review รอบใหม่ไล่ modal function ทีละตัว (ไม่รวมอยู่ในนี้)
