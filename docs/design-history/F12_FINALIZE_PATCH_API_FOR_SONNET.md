# F-12 — Redesign PUT /api/finalize to per-key PATCH (2026-07-22, Opus, best-fix chosen by user)

> User ขอวิธีที่ดีที่สุด ไม่ใช่แค่บรรเทา — นี่คือ full fix ที่ปิด race condition ได้จริง 100% ไม่ใช่แค่ atomic write (F-18 ทำไปแล้ว แค่กัน "ไฟล์พังกลางคัน" ไม่ได้กัน "2 คนเซฟพร้อมกันทับข้อมูลกัน")

## ปัญหาปัจจุบัน (ยืนยันจากโค้ดจริง)
`server.js` — `app.put('/api/finalize', ...)`:
```js
app.put('/api/finalize', requireRole('md', 'accounting'), (req, res) => {
  const data = parseBody(req);
  atomicWrite(FINALIZE_FILE, JSON.stringify(data, null, 2));
  ...
});
```
`app.js` — `saveFinalizeData()`:
```js
async function saveFinalizeData() {
  await apiFetch(`/api/finalize`, { method:'PUT', body: JSON.stringify(finalizeData) });
}
```
Client เก็บ `finalizeData` ทั้งก้อน (ทุก period × ทุกพนักงาน × md-approval) ในตัวแปรฝั่ง browser แล้วส่ง**ทั้งก้อน**ทุกครั้งที่เซฟ **แม้จะแก้แค่ 1 คน 1 period** → ถ้า accounting คนที่ 1 โหลดข้อมูลมา, accounting คนที่ 2 (หรือ MD) แก้/เซฟคนอื่นสำเร็จก่อน, แล้วคนที่ 1 เซฟทับ (ข้อมูลเก่าที่ตัวเองถืออยู่ครอบคลุมของคนที่ 2 ไปด้วย) → **ข้อมูลที่คนที่ 2 เพิ่งเซฟหายไป (lost update)**

**ยืนยันแล้วว่าทุก caller ของ `saveFinalizeData()` แก้แค่ 1 key เท่านั้นก่อนเรียก** (grep `saveFinalizeData()` ทั้งไฟล์ยืนยัน 7 จุดเรียก ทุกจุด pattern เดียวกัน: `finalizeData[key] = {...}` หรือ `delete finalizeData[key]` แล้วค่อยเรียก) — เหมาะสมบูรณ์แบบสำหรับเปลี่ยนเป็น **PATCH ต่อ key** ซึ่งแก้ race ได้เต็มรูปแบบเพราะ server จะ merge เฉพาะ key ที่ request นี้ตั้งใจแก้เข้ากับ**สถานะปัจจุบันจริงบนดิสก์** ไม่ใช่ทับด้วยสำเนาเก่าของ client

**Bonus:** มี WS broadcast (`FINALIZE_UPDATED`) + client listener ที่ `app.js:10000-10005` (`renderPayslipApprovalCard()`/`renderFinalize()` re-fetch ผ่าน `loadFinalizeData()` ทุกครั้งที่ได้ broadcast) อยู่แล้ว — แปลว่า client อื่นที่เปิดหน้าทิ้งไว้จะเห็นข้อมูลสดอัตโนมัติอยู่แล้ว ไม่ต้องแก้ตรงนี้เพิ่ม

## การแก้ (ทำทั้ง backend + frontend คู่กัน)

### 1. `server.js` — เปลี่ยน `PUT /api/finalize`
```js
app.put('/api/finalize', requireRole('md', 'accounting'), (req, res) => {
  try {
    const { key, value } = parseBody(req);
    if (!key || typeof key !== 'string') {
      return res.status(400).json({ success:false, message:'key required' });
    }
    // Read CURRENT on-disk state fresh (not the client's possibly-stale copy) — this is
    // the actual fix: merge only the one key this request intends to change, so a slow
    // client with a stale full snapshot can never silently wipe someone else's concurrent edit.
    const data = readJSON('finalize.json', {});
    if (value === null || value === undefined) {
      delete data[key];
    } else {
      data[key] = value;
    }
    atomicWrite(FINALIZE_FILE, JSON.stringify(data, null, 2));
    broadcast({ type: 'FINALIZE_UPDATED', key });
    res.json({ success: true });
  } catch(e) {
    console.error('[FINALIZE] save failed:', e.message);
    res.status(500).json({ success: false, message: e.message });
  }
});
```
(ใช้ `readJSON('finalize.json', {})` ตัวเดียวกับที่ไฟล์อื่นในนี้ใช้อยู่แล้วสำหรับอ่าน — grep `readJSON(` เพื่อยืนยัน pattern เดิม; `GET /api/finalize` ไม่ต้องแก้ ยังคืนทั้งก้อนเหมือนเดิมเพราะ client ต้อง cache ทั้งก้อนไว้ render หลายคนพร้อมกันอยู่ดี)

### 2. `app.js` — เปลี่ยน `saveFinalizeData()` ให้รับ `key` แล้วส่งแค่ key เดียว
```js
async function saveFinalizeData(key) {
  try {
    await apiFetch(`/api/finalize`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key, value: finalizeData[key] !== undefined ? finalizeData[key] : null })
    });
  } catch(e) {
    console.error('saveFinalizeData failed', e);
    throw e;
  }
}
```

### 3. แก้ทุก caller ให้ส่ง `key` เข้าไป (grep `saveFinalizeData()` หาทั้ง 7 จุดเรียก แล้วเปลี่ยนเป็น `saveFinalizeData(key)` — ตัวแปร `key` มีอยู่ในสโคปของทุกจุดเรียกอยู่แล้วจากโค้ดที่อ่านมา ไม่ต้องเพิ่มตัวแปรใหม่)

## Verify
1. `node --check` ทั้ง `server.js` (ถ้าแตะ) — ต้องผ่าน
2. `node --check "Z:\attendance\js\app.js"` ต้องผ่าน
3. **Race condition test จริง** (สำคัญสุด ต้องพิสูจน์ว่าแก้ได้จริง ไม่ใช่แค่ syntax ผ่าน): เขียน script จำลอง 2 คำขอ PUT พร้อมกันไปคนละ key (เช่น key A จาก request 1, key B จาก request 2) → GET กลับมาต้องมีทั้ง key A และ key B ครบ (ไม่มีใครทับใคร) — ใช้ backend ตรงๆ ผ่าน token จริงของ md/accounting ก็ได้ (ทดสอบผ่าน API ไม่ใช่ UI)
4. ทดสอบ regression ผ่าน Playwright: login `sirintorn` (accounting)/`takiuchi` (md) → เข้าหน้า Finalize/Payslip → แก้ bonus/PIT/manual allowance/confirm → เซฟ → reload → ค่ายังอยู่ถูกต้อง (ไม่มีอะไรหายไปจากการเปลี่ยน wire format)
5. **ต้องแก้ทั้ง server.js และ app.js พร้อมกัน แล้ว deploy backend ครั้งเดียว** (เปลี่ยน API contract พร้อมกันทั้งสองฝั่ง ถ้า deploy ไม่พร้อมกันจะพังชั่วคราว — backend เก่า+frontend ใหม่ หรือกลับกัน จะส่ง/รับ format ไม่ตรงกัน)

## Report
รายงานเป็นภาษาไทย: โค้ดก่อน/หลังทั้ง 2 ไฟล์, ผลทดสอบ race condition จำลอง, ผล Playwright regression, ผล deploy+health check. ไม่ต้อง push memory (รอสัญญาณ "จบงาน")
