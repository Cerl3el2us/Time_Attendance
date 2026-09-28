# Sprint 2 — Findings for Sonnet (verified against live code 2026-07-19)

> Opus review รอบ incremental (ก้อน "F-06 data exposure + Sprint 2 security"). อ่านโค้ดจริงที่ deploy แล้ว
> ทุกบรรทัดอ้างอิง ณ 2026-07-19 หลัง Sprint 1 deploy — verify เลขบรรทัดอีกครั้งก่อนแก้
> ไฟล์: `Z:\attendance-server\backend\server.js` · `Z:\attendance\js\app.js`
> **หลักการเดิม:** ทดสอบทุก 5 role ผ่าน QA accounts (positive = ไม่ regression + negative = ยิง API ตรงต้องโดนบล็อค/ไม่เห็นข้อมูล) · deploy backend ครั้งเดียวต่อ batch · อัปเดต memory เมื่อเสร็จ

---

## 🟠 F-06 — `GET /api/users` คืน salary/idCard/bankAccount ของทุกคนให้ทุก role

**ที่:** `server.js:455-458`
```js
app.get('/api/users', (req, res) => {
  const users = (readUsers() || DEFAULT_USERS).map(({ password, ...rest }) => rest);
  res.json(users);
});
```
**ยืนยัน exploit:** login เป็น `teerawat` (user) → `fetch('/api/users')` → อ่าน `salary`, `idCard`, `bankName`, `bankAccount`, `phone`, `address`, `emergencyPhone`, `transport`, `positionAllowance`, `housing`, `pvdRate` ฯลฯ **ของเพื่อนร่วมงานทุกคน** ได้ (strip แค่ `password` ตัวเดียว) = data breach เงินเดือน + PII

### ⚠️ กับดักสำคัญที่ต้องระวัง (ห้ามพลาด ไม่งั้นพังทั้งแอป)
**`currentUser` ของ non-admin ถูก set จาก `/api/users` ไม่ใช่จาก login response** — ดู `app.js`:
- `app.js:9073-9074` (boot): `loadUsersFromBackend().then(() => { const fresh = DATA_USERS.find(u => u.id === currentUser.id); if (fresh) { currentUser = fresh; ... } })` — เขียนทับ currentUser ด้วย record จาก `/api/users`
- `app.js:2397-2399` (`restoreSession`): `const fresh = DATA_USERS.find(u => u.id === parsed.id && u.active); currentUser = fresh;`

→ **ถ้ากรอง field ของ record ตัวเองออก currentUser จะไม่มี salary/bank/idCard → หน้าโปรไฟล์ "Financial Info" ของตัวเอง + payslip ตัวเองของ non-admin พังหมด**

### วิธีทำ (แนะนำ — server-side field projection ตาม requester role)
ใน `GET /api/users` re-fetch live role ของ requester (เหมือน pattern `requireRole`) แล้ว:
1. **md / accounting** → คืน full record (ลบแค่ password) เหมือนเดิม — เขาดูแล payroll ต้องเห็นครบ
2. **role อื่น (manager/user/driver/marketing)** → สำหรับแต่ละ user record:
   - **record ของตัว requester เอง** (`u.id === req.user.sub`) → คืน **full** (ลบ password) — จำเป็นเพราะ currentUser-overwrite ข้างบน
   - **record ของคนอื่น** → คืนเฉพาะ **public projection** (whitelist ด้านล่าง) — ตัด field การเงิน/PII ออก

**SENSITIVE fields ที่ต้องตัดออกจาก record คนอื่น** (ยืนยันจาก user shape จริง `server.js:225-236`):
`salary, idCard, phone, address, email, emergencyContact, emergencyPhone, emergencyRelation, bankName, bankAccount, transport, positionAllowance, housing, allowance3, pvdRate, dob` + ถ้ามี `personalCarRate, longDistanceRate, longDistanceThresholdKm, diligenceAllowance`

**PUBLIC projection ที่ปลอดภัยจะคืนให้คนอื่น** (ค่าเริ่มต้นที่แนะนำ): `id, employeeNo, name, facePhoto, role, dept, position, active, isObserver, annualLeave, sickLeave, businessLeave, startDate`
> ⚠️ **Sonnet ต้อง verify ก่อน finalize whitelist:** ไล่หาใน `app.js` ว่า view ที่ non-admin เห็น "คนอื่น" อ่าน field ไหนบ้าง (เช่น approval list, dashboard check-in widget, today-leave modal, calendar, reports) — ถ้ามี view ไหนอ่าน field ที่ไม่ได้อยู่ใน public projection ให้เพิ่ม field นั้น (ถ้าไม่ sensitive) หรือปรับ view. อย่าตัด field ที่ทำให้ชื่อ/รูป/ตำแหน่ง/ยอดวันลาหายไป

**ข้อควรพิจารณา:** `manager` — เดิมเห็นทีมได้ แต่ salary/bank/idCard ของทีมไม่ควรเห็น (frontend ให้แค่ md/accounting เปิดหน้า Employees/payroll จริง — ดู `canEdit`/`canSeeSalary` = md||accounting ที่ `app.js:4652-4653`). ดังนั้นจัด manager อยู่กลุ่ม "role อื่น" (public projection สำหรับคนอื่น) ปลอดภัยสุด

**Verify:** login `teerawat` → `GET /api/users` → record ของคนอื่นต้อง**ไม่มี** key `salary`/`idCard`/`bankAccount`; record ของ teerawat เอง**ต้องมี**ครบ. login `takiuchi` (md) → เห็นครบทุกคน. reload หน้าเว็บเป็น teerawat → หน้า Profile > Financial Info ของตัวเองต้องยังโชว์ bank/salary ได้ (ทดสอบ currentUser-overwrite ไม่พัง)

---

## 🟠 F-07 — Secrets hardcode ในซอร์ส

**ที่:**
- `server.js:359` — `const HIK = { host:'192.168.100.4', user:'admin', pass:'<redacted>' };` (Hikvision admin password)
- `server.js:225-235` — `DEFAULT_USERS` ทุกคน `password:'1234'` (seed เท่านั้น ใช้ครั้งเดียวตอน users.json ไม่มี — live users.json เป็น bcrypt hash แล้วหลัง auto-migrate ตอน login)
- `server.js:678` — sync-hikvision สร้าง user ใหม่ด้วย `password:'1234'` (โยงกับ F-09)
- (จาก memory) NAS deploy password อยู่ในสคริปต์ `scripts/deploy/` ด้วย

### วิธีทำ
1. ย้าย `HIK.pass` (และ user/host) ไป **environment variable** — อ่านจาก `process.env.HIK_PASS` มี fallback comment ว่าต้อง set ที่ไหน (เช่น ไฟล์ `.env` ที่ **ไม่ commit** หรือ set ใน service manager ของ NAS). อย่าทิ้ง default hardcode
2. NAS deploy password ในสคริปต์ → ย้ายไป env var / prompt เช่นกัน (ดู [[feedback_attendance_keep_scripts_on_nas]] — สคริปต์อยู่บน NAS ได้ แต่ password ไม่ควร plaintext ในไฟล์)
3. seed `1234` — จัดการผ่าน F-09 (บังคับเปลี่ยนรหัสครั้งแรก) แทนการแก้ค่า seed
> **Severity note (พูดตรงๆ):** แอปนี้ self-host บน NAS ส่วนตัว ซอร์สไม่ได้ public — F-07 จริงๆ ระดับกลาง/ต่ำกว่า F-06. อันตรายจริงคือถ้าซอร์ส/สคริปต์หลุด (เช่น push ขึ้น git สาธารณะ). แต่ Hikvision device คุมประตูจริง → creds หลุด = เปิดประตู/ดึงข้อมูลสแกนได้ ควรย้ายออกจากซอร์ส

---

## 🟠 F-08 — Token เพิกถอนไม่ได้ (30 วัน, ไม่มี tokenVersion)

**ที่:** `server.js:512` — `jwt.sign({ sub, username, role }, JWT_SECRET, { expiresIn: remember===true ? '30d' : '12h' })`
**ปัญหา:** payload ไม่มี `tokenVersion` → token ที่ออกไปแล้ว**เพิกถอนไม่ได้**จนหมดอายุ. คนถูกไล่ออก/ลดสิทธิ์/reset รหัส → token เก่ายังใช้ได้ถึง 30 วัน (F-01 requireRole ช่วยเรื่อง role changes สดแล้ว แต่ "ปิด session ทั้งหมด" ทำไม่ได้ และ observer/inactive check เป็น per-request ไม่ใช่ revoke)

### วิธีทำ (ขั้นต่ำ — tokenVersion)
1. เพิ่ม field `tokenVersion` (integer, default 0) ในทุก user record (lazy: ถือว่า undefined = 0)
2. `POST /api/login` (บรรทัด 512) → ใส่ `tokenVersion: user.tokenVersion || 0` ใน JWT payload
3. Global JWT middleware (`server.js:276` และ Hikvision branch `:408`) → หลัง `jwt.verify` เพิ่มเช็ค: re-fetch live user, ถ้า `(live.tokenVersion || 0) !== (req.user.tokenVersion || 0)` → 401. (ตอนนี้ middleware re-fetch users อยู่แล้วเฉพาะ non-GET สำหรับ observer check — F-08 ต้อง re-fetch **ทุก request** เพื่อเช็ค tokenVersion; พิจารณา performance: readUsers อ่านไฟล์ทุก request — ยอมรับได้ที่ scale นี้ (~10 users) แต่ comment ไว้)
4. เพิ่ม `tokenVersion++` ตอน: PUT `/api/users/:empNo/password` (reset รหัส = เตะ session เก่า), PUT `/api/users/:empNo/role` (ลดสิทธิ์), และปุ่ม "logout ทุกอุปกรณ์" (ถ้าจะเพิ่ม)
5. **ยืนยันกับ user ก่อน:** จะลด `expiresIn` remember จาก 30d → 7d ไหม (สมดุล UX/security) — อย่าเปลี่ยนถ้าไม่ถาม
> **โยงกับ F-14 (Sprint 3):** `readUsers()` fallback ไป DEFAULT_USERS ตอนอ่านไฟล์ fail — ถ้าทำ tokenVersion re-fetch ทุก request ต้องระวัง fallback ไป DEFAULT (tokenVersion undefined) จะทำให้ token ที่มี tokenVersion>0 ถูกเตะ 401 ตอนไฟล์อ่านพลาดชั่วคราว — จัดการ error case ให้ดี (อย่า fallback เป็น DEFAULT ใน auth path)

---

## 🟠 F-09 — รหัสผ่านอ่อน (min length 4, default 1234)

**ที่:** `server.js:589` — `if (!password || String(password).length < 4) return res.status(400)...` (PUT /api/users/:empNo/password)
**ที่:** `server.js:678` — user ใหม่จาก sync-hikvision ได้ `password:'1234'`

### วิธีทำ
1. เพิ่ม min length เป็น **8** ที่ `server.js:589` + policy ขั้นต่ำ (มีตัวเลข+ตัวอักษร) — sync กับ validation ฝั่ง frontend (`changePassword()` ใน app.js ถ้ามีเช็ค client-side ต้องแก้ให้ตรง)
2. เพิ่ม flag `mustChangePassword:true` ตอนสร้าง user ใหม่ (sync-hikvision line 678 + POST /api/users ถ้า admin สร้างด้วยรหัส default) → frontend บังคับหน้าเปลี่ยนรหัสก่อนใช้งานถ้า flag นี้ true (เพิ่ม UI gate หลัง login)
3. **ต้องระวัง i18n:** ถ้าเพิ่มหน้า/ข้อความบังคับเปลี่ยนรหัส ต้องมี TH/EN/JA ครบตั้งแต่แรก (ดู [[feedback_attendance_i18n_always_3_langs]])
4. **ต้องระวัง fixStaticText():** หน้าบังคับเปลี่ยนรหัสรันก่อน login เสร็จ — อย่าอ้าง currentUser ใน fixStaticText (ดู [[feedback_attendance_fixstatictext]])

---

## ลำดับแนะนำ
F-06 (data breach — impact สูงสุดในก้อนนี้) → F-08 (token revocation) → F-09 (password policy) → F-07 (secrets ย้าย env)
F-06 + F-08 แตะ backend + frontend, F-09 แตะทั้งคู่ + UI ใหม่, F-07 แตะ backend + สคริปต์ deploy. Deploy backend ครั้งเดียวหลังทำ backend ครบ
