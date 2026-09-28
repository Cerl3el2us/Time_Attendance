# Frontend Logic Review — กลุ่มที่ 1 (ส่วนที่ยังไม่เคยตรวจ) — Handoff ให้ Sonnet

**ผู้ตรวจ:** Opus 4.8 (2026-07-22) — review only, **ไม่ได้แก้โค้ดเอง**
**ผู้ลงมือแก้:** Sonnet (อ่านไฟล์นี้แล้วทำตามแนวทางแต่ละข้อ)
**ไฟล์เป้าหมาย:** `Z:\attendance\js\app.js` (10,853 บรรทัด) — frontend ล้วน ไม่ต้อง deploy backend (live mount มีผลทันที) เว้นแต่ข้อที่ระบุว่าแตะ server.js

## ขอบเขต
ตรวจ 6 ก้อนย่อยที่ security/payroll review รอบก่อนไม่ได้ไล่ทีละบรรทัด:
1. Hikvision integration — ✅ ตรวจแล้ว (ด้านล่าง)
2. Notification / Push / Email trigger — ⏳
3. Settings page (render + save) — ⏳
4. Holidays + Calendar — ⏳
5. Profile + Employee management — ⏳
6. Reports detail — ⏳

**หลักการก่อนแก้ทุกข้อ:** verify กับโค้ดสดก่อน, ทดสอบทุก role ที่เกี่ยวข้องผ่าน QA accounts, ยิง Playwright ยืนยัน, i18n ครบ TH/EN/JA ตั้งแต่แรกถ้ามี string ใหม่ (ดู feedback memory). อย่าแตะ users.json/ข้อมูลจริง.

---

## ก้อนที่ 1 — Hikvision integration (ตรวจเสร็จ 2026-07-22)

**สรุป:** live path (WebSocket `initHikvisionLive` → `processLiveScanEvent`, และ `syncHikvisionEmployees` = POST /api/users/sync-hikvision) **ทำงานถูกต้อง ไม่พบบั๊กจ่ายผิด/ข้อมูลเพี้ยน**. ปัญหาหลักคือ **โค้ด mock ที่หลงเหลือจากยุค demo** ยังปนอยู่ในไฟล์ และมี innerHTML ที่ไม่ escape 1 จุด

### 🔴 H-01 (สำคัญ — cleanup, ต้องถาม user ก่อนลบ): Dead mock "Device Sync / Import" flow ที่เขียนทับ attendance จริงได้
**ตำแหน่ง:** `app.js`
- `DEVICE_SCAN_EVENTS` (บรรทัด ~9818–9832) = **hardcoded fake scans** ("Tanaka Hiroshi", "Somchai Jaidee", "Nattawan Srisuk" วันที่ 2026-06-23)
- `syncHikvisionAttendance()` (~9834–9883) — วนอ่าน `DEVICE_SCAN_EVENTS` (mock) แล้ว **เขียนลง `attendanceLog` จริง + `saveSession()`** ถ้าชื่อ mock ตรงกับ `DATA_USERS` จริงจะฉีด attendance ปลอมเข้าไป
- ปุ่มเรียก `syncHikvisionAttendance()` อยู่จริงใน `index.html:2125` ("⏱️ ดึงข้อมูลเวลาเข้า-ออก") **แต่** อยู่ใน `#device-sync-modal`
- `DEVICE_USERS` (บรรทัด 598) = `[]` **ว่างเปล่า ไม่เคยถูก populate ที่ไหนเลย**
- `openDeviceSyncModal()` (ตัวเดียวที่เปิด modal นี้) ถูกเรียก **ที่เดียว** คือจากใน `confirmImport()` เอง (9953) — **ไม่มี nav/ปุ่มใดเปิด modal นี้** → ทั้ง flow เข้าไม่ถึงจาก UI ปกติ
- `confirmImport()` (~9922–9956) สร้าง user ด้วย `DATA_USERS.push(newUser)` **ฝั่ง client ล้วน ไม่ยิง POST /api/users** → ถ้าเข้าถึงได้จะสร้าง "ghost user" ที่หายตอน reload + เก็บ `password` เป็น plaintext ใน object

**ความเสี่ยงตอนนี้:** ต่ำ (modal เปิดไม่ได้จาก UI) **แต่เป็นกับดัก** — ถ้าใครเผลอผูก nav ปุ่มเข้า `openDeviceSyncModal()` ในอนาคต ปุ่ม mock จะทำลายข้อมูล attendance จริงทันที และ import จะสร้าง user ผี

**แนวทางให้ Sonnet:** **อย่าลบเองทันที — ถาม user ก่อน** ว่าฟีเจอร์ "Import พนักงานจากเครื่องผ่าน modal" นี้ยังตั้งใจจะใช้ไหม
- ถ้า **เลิกใช้แล้ว** (live sync ผ่าน WS + `syncHikvisionEmployees` แทนที่หมดแล้ว) → ลบทิ้งทั้งชุด: `DEVICE_SCAN_EVENTS`, `syncHikvisionAttendance`, `openDeviceSyncModal`, `closeDeviceSyncModal`, `openImportConfirm`, `closeImportConfirm`, `confirmImport`, `DEVICE_USERS`, `importingDeviceUser` + `#device-sync-modal`/`#import-confirm-modal` ใน index.html
- ถ้า **ยังจะใช้** → ต้อง rework ให้ `syncHikvisionAttendance` ดึงจาก backend จริง (ไม่ใช่ mock array) และ `confirmImport` ยิง POST /api/users จริง (backend hash password + persist) ก่อนเปิดใช้งาน
- ทั้งสองทางเป็น **การตัดสินใจของ user** ไม่ใช่แค่แก้โค้ด

### 🟡 H-02 (low — hardening): `checkUnknownScans` ใส่ employeeNo ลง innerHTML โดยไม่ escape
**ตำแหน่ง:** `app.js:575–576`
```js
banner.innerHTML = `⚠️ ... <b>${unknownNos.join(', ')}</b> ...`;
```
`unknownNos` มาจาก `evs.map(e => String(e.employeeNo))` = ข้อมูลจากเครื่อง/events ดิบ ไม่ผ่าน `escapeHtml`. ความเสี่ยงต่ำ (ปกติเป็นตัวเลข) แต่ตามหลัก F-03 ทุก data ที่ไป innerHTML ควร escape

**แนวทางให้ Sonnet:** ห่อด้วย `escapeHtml()` → `<b>${escapeHtml(unknownNos.join(', '))}</b>`. เปลี่ยนบรรทัดเดียว, ทดสอบ banner ยังแสดงเลข ID ปกติ

### 🟡 H-03 (low — maintainability): magic number `'6344'` ใน processLiveScanEvent ไม่มี comment
**ตำแหน่ง:** `app.js:10018` — `if (String(ev.employeeNo) === '6344') return;`
hardcode ข้าม employeeNo 6344 (น่าจะเป็นบัญชี admin/test ของเครื่อง) แต่ไม่มี comment อธิบาย และเป็น magic number กลางโค้ด

**แนวทางให้ Sonnet:** ไม่ใช่บั๊ก — แค่เติม comment อธิบายว่า 6344 คืออะไรทำไมข้าม (ยืนยันกับ user ว่า ID นี้คือใครก่อนเขียน comment), หรือย้ายเป็น const ที่ตั้งชื่อชัดๆ ด้านบนไฟล์

**ไม่พบปัญหา** ใน: `syncHikvisionEmployees` (role-gate ถูก, observer skip ถูก), `processLiveScanEvent` business-date/checkin-checkout logic (ตรงกับ `loadAttendanceFromBackend` ที่รีวิวผ่านแล้ว), WS handlers ใน `initHikvisionLive` (USER_UPDATED merge ปลอดภัย — stripped record ไม่ทับ field เดิม), `syncNameToHikvision` (observer-gate ถูก)

---

## ก้อนที่ 2 — Notification / Push / Email trigger (ตรวจเสร็จ 2026-07-22)

**สรุป:** notification body ใช้ textContent ปลอดภัย, role-gate ถูกต้อง. ปัญหาหลักคือ **push poll timer รั่วหลัง logout** ทำให้ user คนถัดไปบนแท็บเดิมได้รับ notification ของ user เก่า

### 🔴 N-01 (สำคัญ — data leak): `logout()` ไม่ clear push poll timer และ snapshot

**ตำแหน่ง:** `app.js` — `logout()` (~2581), `_pushPollTimer`, `_leaveSnapshot`

`logout()` ไม่มี `clearInterval(_pushPollTimer)` และไม่ reset `_leaveSnapshot = null` → timer ยังวิ่งอยู่หลัง logout และเปรียบเทียบกับ snapshot ของ user เก่า ถ้ามีคนอีกคน login บนแท็บเดิมจะได้ notification ของคนก่อน

**แนวทางให้ Sonnet:** เพิ่มใน `logout()` ก่อน redirect:
```js
clearInterval(_pushPollTimer);
_pushPollTimer = null;
_leaveSnapshot = null;
```
verify: login → logout → login user อื่น → ไม่มี notification ของ user แรกโผล่

### 🟡 N-02 (low — optional hardening): poll ยิงแม้แท็บซ่อน

**ตำแหน่ง:** poll interval setup

ยิง API ทุก 3 นาทีแม้แท็บจะถูกซ่อน (ผู้ใช้ไม่เห็น notification บน background tab อยู่ดี) — เพิ่ม `if (document.hidden) return;` ต้นฟังก์ชัน poll เพื่อประหยัด server load (optional ไม่เร่ง)

**ไม่พบปัญหา:** notification body ใช้ textContent ไม่ใช่ innerHTML (ปลอดภัย XSS), role-gate ของ pending-alert checkbox ถูกต้อง, email trigger ไม่มี race condition

---

## ก้อนที่ 3 — Settings page render + save (ตรวจเสร็จ 2026-07-22)

**สรุป:** role-gate บน frontend + `requireRole` บน backend ครบ ไม่มีบั๊กร้ายแรง. ปัญหาคือ **validation ก่อน save แทบไม่มี** ทำให้ค่าผิดพลาดบันทึกลงเงียบๆ ได้

### 🟠 S-01 (medium — data integrity): `saveSettingsPage` ไม่ validate input ก่อน save

**ตำแหน่ง:** `app.js` — `saveSettingsPage()`

ค่าที่อันตรายถ้า save ผิด:
- `sso.maxAmount = 0` → SSF หักทุกคนเป็น 0 เงียบๆ (ค่าปกติ 875)
- `sso.rate = 0` → เช่นเดียวกัน
- tax brackets ไม่เช็คลำดับ (bracket ที่ 2 อาจมีเพดานต่ำกว่า bracket แรก)
- `periodStartDay` นอกช่วง 1–28 ทำ period คำนวณผิด

**แนวทางให้ Sonnet:** เพิ่ม validation guard ก่อน `apiFetch` ใน `saveSettingsPage()`:
```js
if (!APP_SETTINGS.sso.rate || APP_SETTINGS.sso.rate <= 0) { showToast('SSO rate ต้องมากกว่า 0'); return; }
if (!APP_SETTINGS.sso.maxAmount || APP_SETTINGS.sso.maxAmount <= 0) { showToast('SSO max ต้องมากกว่า 0'); return; }
const pd = APP_SETTINGS.payroll.periodStartDay;
if (!pd || pd < 1 || pd > 28) { showToast('Period start day ต้องอยู่ระหว่าง 1–28'); return; }
```
(tax bracket ordering check เพิ่มเป็น optional ถ้าใช้ bracket แบบ dynamic)

### 🟡 S-02 (low — i18n): hardcode ภาษาไทยใน app.js:1401

**ตำแหน่ง:** `app.js:1401`

มี string ภาษาไทย hardcode ไม่ผ่าน `L()` ใน Settings section — ห่อด้วย `L(en, th)` และเพิ่ม JA entry ตาม pattern เดิม

**ไม่พบปัญหา:** role-gate `requireRole` บน `PUT /api/settings` ถูกต้อง, Settings render ไม่รั่วข้อมูลข้าม role

---

## ก้อนที่ 4 — Holidays + Calendar (ตรวจเสร็จ 2026-07-22)

**สรุป:** holiday data ถูก apply ทั่ว codebase สม่ำเสมอ (payroll/OT/leave ทุกจุดเรียก `isPublicHoliday()` ตรงกัน). พบ **XSS จริง 1 จุด** ผ่าน calendar cell inline onclick และ **ขาด observer-gate** ใน company-trip date management

### 🔴 HOL-01 (สำคัญ — Stored XSS): ชื่อวันหยุดฝังลง `onclick` โดยไม่ escape ให้ครบ

**ตำแหน่ง:** `app.js:9700` — calendar cell render

ชื่อวันหยุดถูก embed ลง inline `onclick` attribute โดย escape แค่ single-quote เท่านั้น ไม่ป้องกัน double-quote หรือ `</script>` → ถ้าบันทึกชื่อวันหยุดที่มี `"` หรือ HTML พิเศษ จะ break attribute และ execute JS ได้

**แนวทางให้ Sonnet:** เปลี่ยนจากฝัง string ลง onclick เป็นส่ง index/id แทน:
```js
// แทนที่:
onclick="openHolidayPopup('${hol.name.replace(/'/g,"\\'")}', ...)"
// เปลี่ยนเป็น:
data-hol-idx="${holIdx}" onclick="openHolidayPopupByIdx(this.dataset.holIdx)"
```
แล้วใน `openHolidayPopupByIdx(idx)` ดึงชื่อจาก array + set ด้วย `textContent` ไม่ใช่ innerHTML

### 🔴 HOL-02 (สำคัญ — missing gate): `addCompanyTripDate` / `removeCompanyTripDate` ขาด `blockIfObserver()`

**ตำแหน่ง:** `app.js:9536, 9559`

`addHoliday()` / `deleteHoliday()` มี `blockIfObserver()` ครบ แต่ `addCompanyTripDate()` / `removeCompanyTripDate()` ไม่มี — company trip กระทบ payroll โดยตรง (block เบี้ยเลี้ยงทุกประเภท)

**แนวทางให้ Sonnet:** เพิ่ม `if (blockIfObserver()) return;` บรรทัดแรกของทั้ง 2 ฟังก์ชัน (เหมือน pattern ที่ addHoliday/deleteHoliday ใช้)

### 🟢 HOL-03 (low): Calendar render พึ่ง nav-admin guard ฝั่ง client อย่างเดียว

Backend `DELETE/POST /api/holidays` มี `requireRole('md','accounting')` กันจริงแล้ว → ความเสี่ยงต่ำ แต่ถ้าต้องการ defense-in-depth ฝั่ง frontend ให้เพิ่ม role check ก่อน render ปุ่ม add/delete

**ไม่พบปัญหา:** `isPublicHoliday()` / `isCompanyTripDay()` ถูกเรียกสม่ำเสมอทุกจุดที่เกี่ยวข้อง, holiday persist ถูกต้อง, calendar render ข้อมูลถูกต้องตาม role

---

## ก้อนที่ 5 — Profile + Employee management (ตรวจเสร็จ 2026-07-22)

**สรุป:** self-service PUT strip fields + GET public projection บน backend แข็งแรง. พบ **1 จุดที่ต้องถาม user** เรื่อง default role ตอน add employee และ 1 จุด XSS low severity

### ⚠️ P-01 (ต้องถาม user): `saveEmployee` add-branch hardcode `role: 'user'`

**ตำแหน่ง:** `app.js:5042` — `saveEmployee()` add branch

เมื่อ MD เพิ่มพนักงานใหม่ ฟอร์มมี dropdown เลือก role แต่ add-branch ส่ง `role: 'user'` hardcode ไม่ได้ใช้ค่าจาก `f('emp-role')` → MD เลือก driver/manager/accounting แต่ได้ role 'user' เสมอ

**แนวทางให้ Sonnet:** **ถาม user ก่อน** — ถ้าเป็น bug (ลืม wire) → เปลี่ยนเป็น `role: f('emp-role') || 'user'`. ถ้าตั้งใจให้ default เป็น user แล้วแก้ทีหลัง → ใส่ comment อธิบาย

### 🟢 P-02 (low): `relationLabel()` คืนค่าดิบถ้า value นอก map

**ตำแหน่ง:** `app.js` — `relationLabel()`

ถ้า `value` ไม่อยู่ใน map จะคืน `value` ดิบ ซึ่งปกติมาจาก select (ปลอดภัย) แต่ถ้า backend ยอมรับ free-string และค่านั้นไป innerHTML อาจ XSS ได้ — ห่อ `escapeHtml(value)` ใน default return

**ไม่พบปัญหา:** `PUT /api/users/:empNo` strip non-whitelist fields สำหรับ non-admin (server.js:792–807) แข็งแรง, `GET /api/users` คืน public projection สำหรับคนอื่น (server.js:560), observer flag ส่งผลต่อ payroll ถูกต้อง, password change ผ่าน backend hash (ปิดแล้วในรอบ security)

---

## ก้อนที่ 6 — Reports detail (ตรวจเสร็จ 2026-07-22)

**สรุป:** role-filtered data ถูกต้อง ผู้ใช้ไม่เห็น data ของคนอื่น. พบ **net formula diverge จาก computePayroll** และ **hardcode threshold** ที่ทำให้ report ไม่ตรงกับ Settings ที่ตั้งไว้

### 🔴 R-01 (สำคัญ — dead code อันตราย): `renderReports` คำนวณ `net` ด้วยสูตรต่างจาก `computePayroll()`

**ตำแหน่ง:** `app.js:5226–5232`

สูตร net ใน renderReports ไม่รวม OT/diligence/PIT และ SSO hardcode `875` ต่างจาก `computePayroll()` → ตัวเลขผิด โชคดีที่ column net ถูกซ่อนอยู่ (dead column) แต่ยังรันโค้ดอยู่

**แนวทางให้ Sonnet:** **ถาม user ก่อน** ว่า column net ในหน้า Reports เลิกใช้ถาวรแล้วหรือเปล่า → ถ้าใช่ ลบ net calculation ออก (หรือ comment out ทั้งชุด). ถ้าจะเปิดอีกครั้งต้องใช้ `computePayroll()` แทนสูตร inline

### 🟠 R-02 (medium — inconsistency): Reports hardcode threshold แทน APP_SETTINGS

**ตำแหน่ง:** `app.js` — functions ใน reports section

`showReportDetail` และฟังก์ชัน report อื่น hardcode `08:30` และ early/late-night threshold (`17:30`, `20:00`, ฯลฯ) แทนที่จะอ่านจาก `APP_SETTINGS` เหมือน `computePayroll()` → ถ้า admin เปลี่ยน threshold ใน Settings หน้า Report จะโชว์ตัวเลขไม่ตรงกับ payslip/Finalize

**แนวทางให้ Sonnet:** เปลี่ยน hardcode → อ่านจาก `APP_SETTINGS.workHours.startHour`/`startMin` และ `APP_SETTINGS.allowances.*` ให้ตรงกับที่ `computePayroll()` ใช้ (grep `_SA.` ในไฟล์เพื่อเห็น pattern ที่ใช้ถูกในบางส่วน แล้วทำให้ consistent ทั้งหมด)

### 🟢 R-03 (low): `showLateDetail` / `showOTDetail` อาจเป็น dead code

**ตำแหน่ง:** `app.js` — `showLateDetail()`, `showOTDetail()`

Report row ใช้ `onclick="showReportDetail(...)"` แต่ `showLateDetail`/`showOTDetail` ยังมีในไฟล์ — grep หา caller ก่อน ถ้าไม่มีใครเรียกให้ลบทิ้ง

**ไม่พบปัญหา:** role-filtered data ถูกต้อง (ผู้ใช้เห็นแค่ข้อมูลตัวเอง ยกเว้น md/accounting/manager ที่ควรเห็นทีม), export/print ข้อมูลครบถ้วน, `showReportDetail` calculation ใช้ `computePayroll()` จริง (ผ่าน `calcFinalizeEmployee`)

---

# กลุ่มที่ 2 — Dashboard / Attendance table / Leave history (ตรวจ 2026-07-22, Opus 4.8, review only)

**เป้าหมาย:** `renderDashboard()` + widgets, `renderAttendanceTable()` + `generatePeriodDays()`, `renderLeaveHistory()`. ตรวจแล้วเทียบกับ helper จริง (`computePayroll`/`computeLeaveBalance`/`APP_SETTINGS`).

---

## ก้อน A — Dashboard (ตรวจเสร็จ 2026-07-22)

**สรุป:** stat cards ส่วนใหญ่คำนวณถูก (ดึงจาก DATA_LEAVES/attendanceLog ตรง period bounds จริง). **แต่พบ Stored XSS 2 จุดผ่านชื่อ approver / ชื่อ user ที่ผู้ใช้แก้เองได้** และ **hardcode threshold** ที่ทำให้ label ไม่ตรง Settings. เรื่อง widget เห็นข้อมูลทั้งบริษัทเป็น "ต้องถาม user" ว่าตั้งใจไหม

### 🔴 DA-01 (สำคัญ — Stored XSS): `r.approver` render ดิบใน dashboard request panels
**ตำแหน่ง:** `app.js:4360, 4364` (`renderUserRequestsPanel`) + `app.js:4464, 4467` (`openMyRequestsModal`)
```js
if (r.approver) metaExtra = `<span>✅ ${L('Approved by','อนุมัติโดย')} ${r.approver}</span>`;   // 4360
if (r.approver) metaExtra = `<span>❌ ${L('Rejected by','ปฏิเสธโดย')} ${r.approver}</span>`;     // 4364
```
`approver` ถูก set = `currentUser.name` ตอน manager/MD อนุมัติ (ดู `app.js:6493, 6515, 7660, 8271`) และ `name` เป็น field ที่ผู้ใช้แก้เองได้ผ่าน profile → ถ้า manager ตั้งชื่อเป็น `<img src=x onerror=...>` แล้วอนุมัติคำขอ พนักงานเจ้าของคำขอเปิด dashboard จะโดน execute JS ทันที (stored XSS ข้าม user)

**แนวทางให้ Sonnet:** ห่อทุกจุดที่ render `approver` ด้วย `escapeHtml()`:
```js
metaExtra = `<span>✅ ${L('Approved by','อนุมัติโดย')} ${escapeHtml(r.approver)}</span>`;
```
grep `${r.approver}` / `${l.approver}` / `approver ||` ทั้งไฟล์แล้วห่อให้ครบ (มีที่ leave history ด้วย — ดู LH-01). ทดสอบ: ตั้งชื่อ QA manager เป็น string มี `<b>` → อนุมัติคำขอ → เปิด dashboard ของ user เจ้าของ → ต้องเห็น text ตรงๆ ไม่ตีความเป็น HTML

### 🟠 DA-02 (medium — inconsistency): hardcode `08:30` / early / late-night threshold ใน dashboard stat cards แทน APP_SETTINGS
**ตำแหน่ง:**
- `app.js:9108` — `${L('After 08:30','เกิน 08:30 น.')}` hardcode ในการ์ด "Late"
- `app.js:4107` — early count ใช้ `_S.earlyThreshold2Min||390` / `_S.earlyThreshold1Min||450` (อ่านจาก settings ✅ ถูก) **แต่** label การ์ดยัง hardcode
- ตัวเลข late/present เอง generatePeriodDays คำนวณจาก status ที่มาจาก backend (ถูก) แต่ label "08:30" คงที่

**หมายเหตุ:** ตัว count (early/latenight) ใน renderDashboard อ่าน `APP_SETTINGS.allowances` จริงแล้ว (บรรทัด 4100–4112) — ดี. ปัญหาแค่ **label ข้อความ** 08:30 hardcode → ถ้า admin เปลี่ยน start time ใน Settings การ์ดจะยังโชว์ 08:30

**แนวทางให้ Sonnet:** สร้าง helper อ่าน `APP_SETTINGS.workHours` (grep ดู field จริงว่าเป็น `startHour/startMin` หรือ `lateThreshold`) แล้ว format เป็น `HH:MM` ใช้ใน label แทน hardcode ให้ตรงกับ R-02/AT-02 (ทำพร้อมกันทีเดียว)

### ⚠️ DA-03 (ต้องถาม user): `renderCheckinStatusWidget()` โชว์ check-in ของ "ทั้งบริษัท" ให้ทุก role รวมถึง user/driver ธรรมดา
**ตำแหน่ง:** `app.js:4250` (เรียก unconditionally ท้าย `renderDashboard`) + `getCheckinStatusLists()` `app.js:8723`
`getCheckinStatusLists()` คืน active users **ทั้งหมด** (เว้น md) พร้อมเวลาเข้างาน + สถานะ late — ไม่กรองตาม role ผู้ดู. widget `#dash-checkin-widget` (`app.js:9089`) ไม่มี role-gate → **พนักงาน user/driver ธรรมดาเห็นว่าใครมาสาย/ใครยังไม่เข้า ทั้งบริษัท** รวม modal `showCheckinStatusModal` (8740) เห็นรายชื่อครบ

ความเสี่ยง: privacy — สถานะมาสายของเพื่อนร่วมงานเป็นข้อมูลอ่อนไหว. อาจตั้งใจ (transparency board) หรือไม่ก็ได้

**แนวทางให้ Sonnet:** **ถาม user ก่อน** ว่า widget "ใครอยู่ในออฟฟิศตอนนี้" ตั้งใจให้พนักงานทุกคนเห็นทั้งบริษัทไหม
- ถ้า **เฉพาะ md/manager/accounting** ควรเห็น → ครอบ `renderCheckinStatusWidget()` + `showCheckinStatusModal()` ด้วย role check (ซ่อน widget สำหรับ user/driver/marketing)
- ถ้า **ตั้งใจให้ทุกคนเห็น** → ไม่ต้องแก้ แค่ยืนยัน

### 🟡 DA-04 (low — hardening): `avatar()` ใส่ `u.facePhoto` ลง `src` โดยไม่ผ่าน sanitize
**ตำแหน่ง:** `app.js:8801–8803` (widget) + `app.js:8744–8746` (modal)
```js
`<img src="${u.facePhoto}" ...>`
```
`facePhoto` เป็น data URL/URL จาก backend. ถ้าค่านี้ควบคุมได้ (เช่น `"><script>`) จะ break attribute. ปกติเป็น base64/https ที่ backend คุม แต่ตามหลัก F-03 ควร escape attribute

**แนวทางให้ Sonnet:** ห่อ `escapeHtml(u.facePhoto)` ใน src ทั้ง 2 จุด (หรือ set ผ่าน property หลัง create element). low priority

### 🟢 DA-05 (low — dead stub): `renderPendingApprovalsPanel()` สร้าง card ว่างเปล่า
**ตำแหน่ง:** `app.js:4288–4303` — `const cardsHtml = '';` ตายตัว → panel "Pending Approval" ในฝั่ง manager/md แสดงกล่องว่างเสมอ (มีแต่ปุ่ม View all). ตรวจว่าตั้งใจไหม ถ้า panel นี้เลิกใช้ให้ลบ หรือถ้าต้องโชว์รายการจริงต้อง populate

**ไม่พบปัญหา:**
- stat cards period-based (early/latenight/upcountry/ot/otHours/longDistance/personalCar) filter ถูกต้องตาม `currentUser.id` + period bounds (`startStr`/`endStr` = localDateStr) ตรงกับ pattern computePayroll
- role-gated rows ถูก: driver เห็น OT/OT hours/Long Distance, user/manager เห็น +Personal Car, accounting/marketing ซ่อน row ทั้งหมด, md ซ่อน period stats ทั้ง wrap (4025)
- `pending count` แยกถูก: user เห็นเฉพาะของตัวเอง (4204–4209), role อื่นเห็นเฉพาะที่ถึงตาตัวเอง `isMyTurnOrDelegate` (4211)
- "Today's Check-ins" / "On Leave Today" count consistent (activeUsers เว้น md, onLeaveIds กันซ้ำ)
- Exchange rate widget (`fetchExchangeRate` 2341): error handling ครบ (try/catch → 'N/A'), stale date format ปลอดภัย, ค่าจาก `apiFetch` เท่านั้น (ไม่ fetch ข้าม origin ตรง). ไม่มี XSS (ใช้ textContent). **ข้อสังเกต:** ถ้า `/api/exchange-rate` ล่มจะค้าง 'N/A' ไม่มี retry — acceptable

---

## ก้อน B — Attendance table (ตรวจเสร็จ 2026-07-22)

**สรุป:** **role scoping แข็งแรงมาก** (user/manager เห็นเฉพาะตัวเอง, เฉพาะ md/accounting browse คนอื่นได้). พบ **Stored XSS ผ่าน holidayName** และ **hardcode threshold/bonus จำนวนมาก** ที่ไม่อ่าน APP_SETTINGS (ตรงกับ R-02)

### 🔴 AT-01 (สำคัญ — Stored XSS): `holidayName` render ดิบใน status badge + date cell
**ตำแหน่ง:** `app.js:3829–3830` (getStatusBadge) + `app.js:3926` (date cell)
```js
const name = row.holidayName || L('Public Holiday','วันหยุดราชการ');
return `<span class="badge badge-amber">🎌 ${name}</span>`;          // 3830
...
${row.holidayName ? `<div ...>🔴 ${row.holidayName}</div>` : ''}       // 3926
```
`holidayName` มาจาก `DATA_HOLIDAYS.find(...).name` (generatePeriodDays 2322) = ชื่อวันหยุดที่ MD/Accounting พิมพ์เอง → ถ้าตั้งชื่อวันหยุดมี HTML จะ execute ในตาราง attendance ของทุกคนที่มีวันหยุดนั้นในรอบ (stored XSS วงกว้าง). **เกี่ยวโยงกับ HOL-01** (ที่นั่นเป็น onclick attribute, ที่นี่เป็น innerHTML) — ต้นตอเดียวกันคือชื่อวันหยุดไม่ถูก sanitize

**แนวทางให้ Sonnet:** ห่อ `escapeHtml(row.holidayName)` ทั้ง 2 จุด (3830, 3926). ทำพร้อม HOL-01 — ถ้าแก้ที่ต้นทาง (sanitize ชื่อตอน save holiday) จะครอบทั้งคู่ แต่ escape ตอน render ปลอดภัยกว่า (defense at render). ทดสอบ: ตั้งชื่อวันหยุดมี `<b>` → เปิดหน้า attendance รอบที่มีวันนั้น → text ตรงๆ

### 🟠 AT-02 (medium — inconsistency): hardcode threshold + bonus amount ในตาราง attendance แทน APP_SETTINGS
**ตำแหน่ง:** `app.js:3856–3873`
```js
if (mins < 7 * 60 + 30) { ... const bonus = mins < 6*60+30 ? '฿480' : '฿240'; ... }   // 3856-3857 early
if (mins < 6 * 60) { ... }                                                              // 3862 verify-warn
if (h >= 20) '฿480' : '฿240'                                                            // 3873 late-out bonus
```
ทั้ง early threshold (07:30/06:30), verify threshold (06:00), late-out threshold (20:00) และ bonus amounts (240/480) hardcode ทั้งหมด ไม่อ่าน `APP_SETTINGS.allowances` ที่ `computePayroll()` ใช้ → ถ้า admin เปลี่ยน rate/threshold ใน Settings badge ในตารางจะโชว์เลขไม่ตรง payslip (ตรงกับ R-02 ในหน้า Reports — ปัญหาเดียวกันคนละหน้า)
- เพิ่มเติม `app.js:2310` (generatePeriodDays time-correction) hardcode `checkIn > '08:30'` สำหรับ recompute late status — ควรอ่านจาก settings เดียวกับ backend

**แนวทางให้ Sonnet:** เปลี่ยน hardcode → อ่าน `APP_SETTINGS.allowances.earlyThreshold1Min/2Min`, `earlyBonus1/2`, `lateNightThresholdHour`, `lateNightBonus1/2` (grep field จริงใน computePayroll เพื่อใช้ชื่อให้ตรง). รวมงานกับ AT-01-label/DA-02/R-02 ให้ threshold ทั้งแอป consistent จาก Settings จุดเดียว. **ระวัง:** อย่าเปลี่ยน logic การคำนวณจริง (นั่น backend/computePayroll ทำ) — แค่ทำให้ badge display อ่านค่าเดียวกัน

### 🟡 AT-03 (low — verify): OT amount ในตารางคำนวณ inline ต่างจาก computePayroll
**ตำแหน่ง:** `app.js:3888–3891`
```js
const amount = salary > 0 ? Math.round(salary/30/8 * mult * (approvedOT.otHours||0)) : 0;
```
คำนวณ OT amount แสดงใน badge ด้วยสูตร inline (salary/30/8) — เป็นแค่ display preview ไม่ใช่ตัวจ่ายจริง (payslip ใช้ computePayroll). ตรวจว่าสูตรตรงกับ computePayroll ไหม (โดยเฉพาะ divisor 30/8 และ mult default 1.5/3 บรรทัด 3889) ถ้าต่างจะสับสน user

**แนวทางให้ Sonnet:** verify กับ computePayroll OT formula — ถ้าตรงก็ปล่อย (แค่ preview), ถ้าต่างให้ align หรือเอา amount ออกจาก badge เหลือแค่ชั่วโมง. low

**ไม่พบปัญหา (จุดแข็ง):**
- **role scoping ถูกต้องสมบูรณ์:** `canViewOthers = md || accounting` (3773), non-admin บังคับ `targetUserId = currentUser.id` เสมอ (3774), `renderAttEmployeeSelector` คืน '' ถ้าไม่ใช่ md/accounting (3735) → **user/manager/driver/marketing เห็นเฉพาะข้อมูลตัวเอง** ไม่มี data leak
- status calculation (present/late/absent/holiday/weekend/company-trip/future) มาจาก generatePeriodDays ที่ overlay approved leaves ถูกต้อง (2288–2320), company-trip override ถูก
- escapeHtml ครบใน employee name/position (selector 3750/3753)
- GPS link: single-quote escaped (3911–3912) + ใช้ data-attr + reverseGeocode ผ่าน textContent (ปลอดภัย)
- timezone: event_time เป็น Thai local (+07:00) ตัด substring ตรง ไม่แปลง TZ ผิด (ยืนยันตาม loadAttendanceFromBackend ที่รีวิวผ่านแล้ว)

---

## ก้อน C — Leave / request history (ตรวจเสร็จ 2026-07-22)

**สรุป:** leave balance ตรงกับ `computeLeaveBalance` helper 100% (ผ่าน `renderLeaveBalanceSummary`), role filter ถูก (เห็นเฉพาะของตัวเอง), edit/cancel gate มี defense-in-depth. พบ **XSS ผ่าน approver** (จุดเดียวกับ DA-01) และ inconsistency เล็กน้อยของ edit-button gate

### 🔴 LH-01 (สำคัญ — Stored XSS): `l.approver` render ดิบใน leave history table
**ตำแหน่ง:** `app.js:8414`
```js
<td class="col-hide-mobile">${l.approver || '—'}</td>
```
เหมือน DA-01 — `approver` = ชื่อ manager/MD (user-editable) render ดิบเข้า innerHTML → stored XSS

**แนวทางให้ Sonnet:** `${escapeHtml(l.approver || '—')}` (หรือ `l.approver ? escapeHtml(l.approver) : '—'`). ทำพร้อม DA-01 (grep `approver` ทั้งไฟล์ให้ครบจุดเดียว)

### 🟡 LH-02 (low — unescaped fallback label): `cfg.label = l.type` ดิบเมื่อ type ไม่รู้จัก
**ตำแหน่ง:** `app.js:8387` (+ 8409 render) — fallback `{ label: l.type }` แล้ว render `${cfg.label}` ไม่ escape. `l.type` เป็น enum จาก backend (ปกติปลอดภัย) แต่ถ้ามี type แปลกปลอมจะ render ดิบ

**แนวทางให้ Sonnet:** ห่อ `escapeHtml(cfg.label)` ใน render (8409) เผื่อ fallback. low — ทำพร้อม LH-01

### 🟢 LH-03 (low — inconsistency, ไม่ใช่บั๊ก): edit-button ใน renderLeaveHistory ไม่เช็ค EDITABLE_LEAVE_TYPES
**ตำแหน่ง:** `app.js:8401` — แสดงปุ่ม Edit/Cancel เมื่อ `l.status.startsWith('pending')` เท่านั้น ไม่ได้เช็ค `EDITABLE_LEAVE_TYPES` เหมือนที่ my-requests list ทำ (`app.js:9348`)
**ทำไมไม่อันตราย:** renderLeaveHistory filter เฉพาะ `annual/sick/business` (8377) ซึ่งอยู่ใน EDITABLE_LEAVE_TYPES ทั้งหมด + `editLeaveRequest` เองมี guard `EDITABLE_LEAVE_TYPES.has(l.type)` (6977) + backend ก็กัน → defense-in-depth ครบ

**แนวทางให้ Sonnet:** optional — เพื่อ consistency เพิ่ม `&& EDITABLE_LEAVE_TYPES.has(l.type)` ที่ 8401 ให้เหมือน 9348 (ไม่เร่ง ไม่กระทบ behavior)

### 🟡 LH-04 (low — attachment href): `l.attachment` ต่อลง href ไม่ escape
**ตำแหน่ง:** `app.js:8412` — `<a href="${NAS_BACKEND}/api/upload/${l.attachment}">`. `attachment` เป็น filename จาก backend (ปกติ sanitized ตอน upload) แต่ถ้าหลุด `"` จะ break attribute
**แนวทางให้ Sonnet:** `encodeURIComponent(l.attachment)` ใน path (ปลอดภัยกว่า escapeHtml สำหรับ URL). low

**ไม่พบปัญหา (จุดแข็ง):**
- **leave balance ตรง helper 100%:** `renderLeaveHistory` → `renderLeaveBalanceSummary` → `computeLeaveBalance(u, type, max, thisYear)` ค่า remaining/used/carry-forward/comp/lateDeduct มาจาก helper เดียวกับที่ payroll ใช้ ไม่มีสูตร inline diverge
- **role filter ถูก:** `myLeaves = DATA_LEAVES.filter(l => l.userId === currentUser.id ...)` (8378) → เห็นเฉพาะของตัวเอง
- status badge (approved/rejected/pending) แสดงถูกทุก state
- date range: `dateFrom === dateTo` → วันเดียว, else range (8397) ถูกต้อง; ใช้ fmtDate ผ่าน string ไม่แปลง TZ ผิด
- reason/note escape ครบ (8412 reason, showLeaveDetail ใช้ textContent 8443/8447 — ปลอดภัย)
- cancel gate: `cancelLeave` เช็ค `l.userId !== currentUser.id` + `status.startsWith('pending')` + backend DELETE (8475–8487) — defense-in-depth ครบ
