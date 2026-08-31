# F-16 — Full backend payroll engine port (2026-07-22, Opus, user chose full-duplication)

> User เลือกวิธีเต็มรูปแบบ (ไม่ใช่ snapshot) โดยรู้ tradeoff แล้ว: ต้องดูแล logic 2 ชุดให้ตรงกันตลอดไป
> (บันทึกเป็น standing rule ไว้ที่ memory [[feedback_attendance_payroll_engine_dual_sync]] แล้ว)
> เป้าหมาย: `POST /api/send-payslip` **คำนวณตัวเลขเงินเองจากข้อมูลจริงฝั่ง server** ไม่เชื่อตัวเลขจาก client อีกต่อไป

## ภาพรวม dependency chain ที่ต้องพอร์ต (เรียงจากล่างขึ้นบน)
```
calcAnnualTax()          — pure function, ไม่มี dependency
isPublicHoliday()        — ✅ มีอยู่แล้วใน server.js (จาก F-02 port) ใช้ได้เลย
isCompanyTripDay()       — ต้องเพิ่มใหม่ (อ่าน settings.companyTripDates)
getCurrentPeriodStart()  — ใหม่
getPeriodBounds()        — ใหม่ (ใช้ getCurrentPeriodStart)
attendance derivation    — ใหม่ (ย่อยจาก loadAttendanceFromBackend(), ดูหัวข้อด้านล่าง)
generatePeriodDays()     — ใหม่ (ใช้ทุกตัวข้างบน + readLeaves())
computePayroll()         — ใหม่ (ใช้ generatePeriodDays + readSettings + readLeaves)
```

ทุกฟังก์ชันอ้างอิงจาก `Z:\attendance\js\app.js` ตัวจริง — **อ่านโค้ดต้นฉบับในไฟล์จริงก่อนพอร์ต อย่าพิมพ์จากสเปกนี้ตรงๆ เพราะเลขบรรทัดอาจขยับไปแล้ว** ใช้ grep หาชื่อฟังก์ชันเอาเอง

## 1. `isCompanyTripDay()` (server-side, ใหม่)
Frontend: `DATA_COMPANY_TRIP_DATES = data.companyTripDates || []` (โหลดจาก `GET /api/settings`), `isCompanyTripDay(dateStr) { return DATA_COMPANY_TRIP_DATES.includes(dateStr); }`
```js
function isCompanyTripDay(dateStr) {
  return (readSettings().companyTripDates || []).includes(dateStr);
}
```

## 2. `getCurrentPeriodStart()` + `getPeriodBounds()` (server-side, ใหม่)
พอร์ตตรงจาก `app.js` (grep `function getCurrentPeriodStart`, `function getPeriodBounds`) — ใช้ `readSettings().appSettings?.payroll?.periodStartDay || 21` แทน `APP_SETTINGS.payroll.periodStartDay` (ตรวจ path ที่ถูกต้องจริงจาก `loadSettingsFromBackend()` ใน app.js — จำได้จาก F-02 ว่าเป็น `settings.appSettings.payroll.periodStartDay`, verify อีกทีก่อนใช้)

## 3. Attendance derivation (server-side, ใหม่ — ย่อยจาก `loadAttendanceFromBackend()`)
Frontend โหลด **ทุก event ทั้งระบบ** มา derive attendanceLog ทั้งก้อนในหน่วยความจำ (เหมาะกับ UI ที่ render หลายคน) — ฝั่ง backend สำหรับ send-payslip **แค่คนเดียว ช่วงเดียว** เขียนเป็นฟังก์ชันที่ query เฉพาะที่ต้องใช้แทน:

```js
// Derives { [businessDateStr]: { checkIn, checkOut, status } } for ONE user across a date range,
// mirroring loadAttendanceFromBackend()'s event-grouping logic exactly (5am business-day boundary,
// late threshold 08:30, employeeNo '6344' emergency-account exclusion, same first/last-scan rules).
// Fetch events from (start - 1 day) through (end + 1 day) to catch late-night checkouts that spill
// past midnight into the next calendar day but still belong to the previous business date.
function buildAttendanceLogForUser(user, start, end) {
  const events = readEvents().filter(ev => String(ev.employeeNo) === String(user.employeeNo));
  events.sort((a, b) => (a.event_time || '').localeCompare(b.event_time || ''));
  const log = {};
  events.forEach(ev => {
    if (String(ev.employeeNo) === '6344') return;
    const raw = ev.event_time || '';
    if (!raw) return;
    const datePart = raw.substring(0, 10);
    const timePart = raw.substring(11, 16);
    const hour = parseInt(timePart.substring(0, 2), 10);
    let businessDate = datePart;
    if (hour < 5) {
      const d = new Date(datePart + 'T00:00:00');
      d.setDate(d.getDate() - 1);
      const p2 = n => String(n).padStart(2, '0');
      businessDate = `${d.getFullYear()}-${p2(d.getMonth()+1)}-${p2(d.getDate())}`;
    }
    if (!log[businessDate]) log[businessDate] = {};
    const rec = log[businessDate];
    if (hour < 5) {
      if (!rec.checkOut || timePart > rec.checkOut) rec.checkOut = timePart;
    } else if (!rec.checkIn && timePart >= '17:00') {
      if (!rec.checkOut || timePart > rec.checkOut) rec.checkOut = timePart;
    } else if (!rec.checkIn) {
      rec.checkIn = timePart;
      rec.status = (user.role !== 'driver' && timePart > '08:30') ? 'late' : 'present';
    } else if (timePart >= '12:00' && (!rec.checkOut || timePart > rec.checkOut)) {
      rec.checkOut = timePart;
    }
  });
  return log;
}
```
(ตัดส่วน `checkInSource`/`checkOutSource`/`checkInGPS`/`checkOutGPS`/`source` ออกได้ — `computePayroll()` ไม่ได้ใช้ field พวกนี้เลย ใช้แค่ `checkIn`/`checkOut`/`status`)

**สำคัญ:** ต้อง verify ด้วยตัวเองว่า `readEvents()`/`ev.employeeNo`/`ev.event_time` ชื่อ field ตรงกับที่ frontend คาดหวังจริง (grep การใช้งานจริงใน backend ที่จุดอื่น เช่น `saveEvent`/`/api/hikvision/event` handler เพื่อยืนยัน shape ของ event object ที่บันทึกจริง)

## 4. `generatePeriodDays()` (server-side, ใหม่)
พอร์ตจาก `app.js` — **เอาเฉพาะส่วนที่ `computePayroll()` ใช้จริง** (ไม่ต้อง port ส่วนแสดงผล UI เช่น `dayName`/`isToday` ที่ไม่มีผลต่อเงิน แต่ port ให้ครบโครงสร้าง object เพื่อความชัวร์ก็ได้ถ้าไม่ยุ่งยากเกิน):
- status precedence: company-trip > weekend > (holiday if future) > future > real-record > absent
- overlay `DATA_LEAVES`-เทียบเท่า (`readLeaves()`) กรองเฉพาะ `l.userId === user.id && l.status === 'approved'`: annual/sick/business เปลี่ยน status, upcountry/long-distance ตั้ง flag, time-correction override checkIn/checkOut + recompute late/present, late-out ตั้ง `lateApproved`+`lateOut`
- **ใช้ `buildAttendanceLogForUser()` จากข้อ 3 แทน `attendanceLog[key]`**

## 5. `computePayroll(user, start, end, periodIndex)` (server-side, ใหม่)
พอร์ตสูตรทั้งชุดตรงๆ จาก `app.js` — ใช้:
- `readSettings()` แทน `APP_SETTINGS` (allowances/sso/tax/lateDeductPolicy config อยู่ใน settings.json โครงสร้างเดียวกับที่ frontend cache ไว้ — verify path ให้ตรง เช่น `settings.allowances`, `settings.sso`, `settings.tax` ไม่ใช่ nested ใต้ `appSettings` เสมอไป ต้องเทียบกับที่ `loadSettingsFromBackend()` ใน app.js เขียนไว้ตอน merge)
- `readLeaves()` แทน `DATA_LEAVES`
- `getFinalizeKey(start, user.id)` (พอร์ตมาด้วย ตรงไปตรงมา) + `readJSON('finalize.json', {})` แทน `finalizeData` สำหรับเช็ค `diligencePaid`
- `generatePeriodDays()` จากข้อ 4

**ต้อง unit-verify สูตรให้ตรง 100%** — ทุกบรรทัดของสูตร (base/transport/allowance1/allowance2/allowance3/OT tiers/guaranteedOT/SSO/PVD/PIT estimate) ต้อง copy ตรรกะเป๊ะ ไม่ใช่เขียนใหม่จากความเข้าใจ

## 6. เปลี่ยน `POST /api/send-payslip`
**ก่อน:** รับ `{to, payslip}` (payslip = object ตัวเลขทั้งหมดจาก client)
**หลัง:** รับ `{to, userId, periodIndex}` เท่านั้น
```js
app.post('/api/send-payslip', requireRole('md', 'accounting'), async (req, res) => {
  try {
    const { to, userId, periodIndex } = parseBody(req);
    if (!to || userId === undefined || periodIndex === undefined) {
      return res.status(400).json({ success:false, message:'to, userId, periodIndex required' });
    }
    const users = readUsers() || [];
    const user = users.find(u => u.id === userId);
    if (!user) return res.status(404).json({ success:false, message:'User not found' });

    const { start, end } = getPeriodBounds(periodIndex);
    const calc = computePayroll(user, start, end, periodIndex);
    const finKey = getFinalizeKey(start, user.id);
    const saved = readJSON('finalize.json', {})[finKey] || {};

    // Only send a payslip that's actually been confirmed by Accounting — this is the real
    // security gate: server refuses to email numbers nobody has reviewed/approved.
    if (!saved.confirmed) {
      return res.status(400).json({ success:false, message:'Payroll for this period has not been confirmed yet' });
    }

    const pit = saved.pit !== undefined ? saved.pit : calc.autoPit;
    const bonus = saved.bonus || 0;
    const mas = saved.manualAllowances || [];
    const manualNet = mas.reduce((s, ma) => s + (ma.amount || 0) - (ma.advance || 0), 0);
    const netIncome = calc.grossIncome + bonus + manualNet - calc.ssf - calc.pvd - pit;

    const p2 = n => String(n).padStart(2,'0');
    const periodLabel = `${p2(start.getDate())}/${p2(start.getMonth()+1)}/${start.getFullYear()} — ${p2(end.getDate())}/${p2(end.getMonth()+1)}/${end.getFullYear()}`;

    const payslip = {
      employeeName: user.name, periodLabel,
      baseSalary: calc.base, diligence: calc.diligenceAllowance, otPay: calc.otAmount, bonus,
      grossIncome: calc.grossIncome, ssf: calc.ssf, pvd: calc.pvd, pit, netIncome,
    };

    const transport = getEmailTransport();
    if (!transport) return res.status(503).json({ success:false, message:'Email not configured' });
    const cfg = readSettings().emailConfig || {};
    await transport.sendMail({
      from: `"${cfg.fromName || 'Time Attendance Application'}" <${cfg.user}>`,
      to: String(to),
      subject: `สลิปเงินเดือน ${periodLabel} — ${user.name}`,
      html: buildPayslipHtml(payslip)  // buildPayslipHtml() already exists + already escapes (F-17)
    });
    console.log('[EMAIL] payslip sent to', to);
    res.json({ success:true });
  } catch(e) {
    console.error('[EMAIL] send-payslip error:', e.message);
    res.status(500).json({ success:false, message: e.message });
  }
});
```
(`buildPayslipHtml()` **ไม่ต้องแก้** — มีอยู่แล้ว escape ครบจาก F-17)

## 7. Frontend — เปลี่ยนจุดที่เรียก send-payslip
หา caller ของ `/api/send-payslip` ใน `app.js` (grep `sendPayslipEmail`/`/api/send-payslip`) — เปลี่ยนจากส่ง `{to, payslip: {...ตัวเลขที่คำนวณเอง}}` เป็นส่งแค่ `{to, userId, periodIndex}` (frontend ไม่ต้องคำนวณอะไรส่งไปแล้ว เพราะ server คำนวณเอง) **เก็บ error message ที่ server ส่งกลับ** (เช่น "ยังไม่ confirm") ไปโชว์ user ให้เข้าใจว่าทำไมส่งไม่ได้

## Verify — ต้องพิสูจน์ว่าตัวเลขตรงกันจริง (สำคัญที่สุด)
1. `node --check server.js` ผ่าน
2. **เลือกพนักงานจริง 2-3 คน (role ต่างกัน เช่น user, driver) ที่มี attendance/leave/OT จริงในรอบปัจจุบันหรือรอบก่อน** — คำนวณด้วย `computePayroll()` ฝั่ง frontend (เปิดเว็บจริง ดูเลขในหน้า Finalize/Payslip) เทียบกับผลจากฟังก์ชัน backend ที่พอร์ตมา (เขียน script เรียกฟังก์ชันตรงๆ หรือ endpoint ทดสอบชั่วคราว) — **grossIncome/ssf/pvd/autoPit ต้องตรงกันเป๊ะทุกตัว** ถ้าไม่ตรง หยุดแล้วหาสาเหตุ ห้าม deploy จนกว่าจะตรง
3. ทดสอบ `send-payslip` end-to-end: confirm payroll ของพนักงาน test ก่อน (ผ่าน UI จริงหรือ API) → เรียก send-payslip ด้วย `{to, userId, periodIndex}` → ต้องได้อีเมล/success ตรง → ทดสอบ negative case (ยังไม่ confirm) → ต้องได้ 400 "not confirmed yet"
4. Playwright regression: login `sirintorn`/`takiuchi` → หน้า Payslip → กด "ส่งอีเมล" (ถ้ามีปุ่มนี้จริง) → ยืนยันไม่มี error, flow เดิมยังทำงาน
5. **Deploy backend + frontend พร้อมกัน** (เปลี่ยน API contract ทั้งสองฝั่งเหมือน F-12) — **เช็ค process start time vs file mtime หลัง deploy ก่อน live-test ทุกครั้ง** (บทเรียนจาก incident F-12 วันนี้ — ดู [[feedback_attendance_verify_deploy_before_test]])
6. อย่าทดสอบด้วยการส่งอีเมลจริงไปหาพนักงานจริงโดยไม่ได้รับอนุญาต — ใช้ `to` เป็นอีเมลทดสอบของตัวเอง/ผู้พัฒนาแทนตอนทดสอบจริง

## Report
รายงานเป็นภาษาไทย: ฟังก์ชันที่พอร์ตแต่ละตัว (พร้อม diff-check ว่า logic ตรงกับต้นฉบับ), ผลเทียบตัวเลข frontend vs backend สำหรับพนักงานจริงที่เลือกมา (ต้องตรงกันเป๊ะ ไม่ใช่ "ใกล้เคียง"), ผล deploy + health check + process-timing verify, ผล Playwright. ไม่ต้อง push memory (รอสัญญาณ "จบงาน")
