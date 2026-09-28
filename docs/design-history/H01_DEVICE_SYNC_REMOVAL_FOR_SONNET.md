# H-01 — Remove dead Device Sync feature (2026-07-22, Opus, confirmed with user)

> **User ยืนยันแล้วผ่านการคุยหลายรอบ: ลบทิ้งทั้งชุด** ไม่ใช่ rework — เพราะระบบจริงที่ทำงานอยู่แล้วครอบคลุมหน้าที่นี้หมด:
> - นำเข้าพนักงานจาก Hikvision จริง → ปุ่ม "🔄 Sync จาก Hikvision" หน้า Employees → `syncHikvisionEmployees()` → backend endpoint จริง (ใช้งานได้จริง verify แล้วตอน F-01/F-07)
> - ข้อมูลเข้า-ออกงานจริง → Hikvision push ผ่าน `/api/hikvision/event` + WebSocket แบบ real-time อยู่แล้ว
>
> **สิ่งที่จะลบเป็น dead/mock code ที่ไม่มีใครเรียกใช้ได้เลย** — ยืนยันแล้วว่า `openDeviceSyncModal()` ไม่มี onclick ไหนเรียกจากที่ไหนเลยทั้ง `index.html` และ `app.js` (นอกจากเรียกตัวเองซ้ำ) แปลว่าโมดัลทั้ง 2 อัน (Device Sync + Import Confirm) **ไม่เคยแสดงผลบนหน้าจอเลยแม้แต่ครั้งเดียว** — ปุ่ม "⏱️ ดึงข้อมูลเวลาเข้า-ออก" ก็อยู่ข้างในโมดัลที่ไม่เคยเปิดนี้ด้วย ไม่ใช่ปุ่มที่แยกใช้งานได้จริงที่ไหน
>
> **⚠️ อย่าสับสนกับปุ่ม check-in/check-out จริงของพนักงาน** (`doScan()`, ปุ่มวงกลมเขียวหน้า "ลงเวลาทำงาน") — คนละจุดกันเลย ห้ามแตะ ยังใช้งานปกติ 100%

## สิ่งที่ต้องลบ

### 1. `Z:\attendance\js\app.js` — ลบทั้ง block บรรทัด 9792-9982
เริ่มจาก comment `// ===== HIKVISION DEVICE SYNC =====` (บรรทัด 9792) ถึงปิด `}` ของ `confirmImport()` (บรรทัด 9982) — **ก่อนคอมเมนต์ `// ===== TODAY LEAVE MODAL =====`** (บรรทัด 9984) ที่ต้องเหลือไว้

ลบตัวแปร/ฟังก์ชันทั้งหมดนี้ (อยู่ใน range เดียวกัน ลบพร้อมกันได้เลย):
- `const ROLE_LEVELS = {...}` (ยืนยันแล้วว่าไม่มีที่ไหนใช้นอกจากใน block นี้เอง — grep `ROLE_LEVELS` ทั้งไฟล์ก่อนลบเพื่อ double-check)
- `let importingDeviceUser = null;`
- `function openDeviceSyncModal() {...}`
- `function closeDeviceSyncModal() {...}`
- `const DEVICE_SCAN_EVENTS = [...]` (mock data พนักงานปลอม 3 คน)
- `function syncHikvisionAttendance() {...}`
- `function openImportConfirm(deviceId) {...}`
- `function closeImportConfirm() {...}`
- `function confirmImport() {...}`

**อย่าลืม:** `const DEVICE_USERS = [];` ประกาศแยกอยู่ที่บรรทัด ~598 (คนละที่กับ block หลัก ใกล้ๆ `DATA_LEAVES`/`DATA_HOLIDAYS`) — ต้องลบด้วย (grep `DEVICE_USERS` ทั้งไฟล์ยืนยันว่าไม่มีที่ไหนใช้นอกจาก block ที่กำลังลบ)

### 2. `Z:\attendance\index.html` — ลบทั้ง block บรรทัด 2115-2197
เริ่มจาก `<!-- Device Sync Modal -->` (บรรทัด 2115) ถึง `</div>` ปิดท้ายของ `#import-confirm-modal` (บรรทัด 2197) — ครอบคลุมทั้ง `#device-sync-modal` และ `#import-confirm-modal` สองโมดัลรวด

## ก่อนลบ — verify ให้ครบ (สำคัญ อย่าข้าม)
1. `grep -n "openDeviceSyncModal\|closeDeviceSyncModal\|DEVICE_USERS\|DEVICE_SCAN_EVENTS\|syncHikvisionAttendance\|openImportConfirm\|closeImportConfirm\|confirmImport\|importingDeviceUser\|ROLE_LEVELS\|device-sync-modal\|device-sync-tbody\|import-confirm-modal\|import-device-id\|import-name\|import-username\|import-password\|import-role\|import-face\|import-fp\|import-card" ทั้ง `app.js` และ `index.html` **ก่อนลบ** เพื่อยืนยัน reference ทั้งหมดอยู่ในขอบเขตที่ระบุไว้ข้างบนจริง ไม่มีจุดอื่นแอบอ้างถึง (ถ้าเจอจุดอื่นนอกขอบเขตที่ระบุ ให้หยุดและรายงานกลับมาก่อน อย่าลบเอง)
2. หลังลบ — grep ซ้ำอีกรอบด้วย pattern เดียวกัน ต้องไม่เจอผลลัพธ์เหลือเลยสักจุด (ยกเว้นถ้ามี id อื่นชื่อคล้ายกันโดยบังเอิญที่ไม่เกี่ยวข้อง ให้ตรวจสอบให้แน่ใจว่าไม่ใช่ของที่ต้องลบก่อนปล่อยผ่าน)

## Test
1. `node --check "Z:\attendance\js\app.js"` ต้องผ่าน
2. เปิดเว็บจริงผ่าน Playwright (login `takiuchi`/md หรือ `sirintorn`/accounting, password `1234`) → เข้าหน้า Employees → ยืนยันปุ่ม "🔄 Sync จาก Hikvision" ยังอยู่และกดได้ปกติ (ปุ่มนี้ไม่ได้อยู่ในขอบเขตที่ลบ) → ไม่มี console error หลังลบโค้ด (โดยเฉพาะเช็คว่าไม่มีจุดไหนยังเรียก `openDeviceSyncModal()`/`DEVICE_USERS` ที่หลงเหลือแล้วพัง)
3. เข้าหน้า "ลงเวลาทำงาน" (Check-in) ด้วย account จริงที่เป็น role `user`/`driver` (เช่น `teerawat`/`1234`) → ยืนยันปุ่ม check-in/check-out จริง (ปุ่มวงกลมเขียว) ยังทำงานปกติ 100% (คนละจุดกับที่ลบ แต่ verify เผื่อพลาด)
4. Frontend live-mounted files (`Z:\attendance\js\app.js`, `Z:\attendance\index.html`) — เห็นผลทันทีที่ reload browser ไม่ต้อง deploy backend (การลบนี้ไม่แตะ backend เลย)

## Report
รายงานเป็นภาษาไทย: บรรทัดที่ลบจริงในแต่ละไฟล์ (เผื่อเลขบรรทัดขยับจากที่ระบุ), ผล grep verify ก่อน/หลังลบ, ผล node --check, ผล Playwright smoke test. ไม่ต้อง push memory (รอสัญญาณ "จบงาน")
