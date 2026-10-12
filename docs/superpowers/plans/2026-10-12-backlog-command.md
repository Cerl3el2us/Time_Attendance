# `npm run backlog` และ `/backlog` — Implementation Plan (แผนที่ 3 จาก 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ให้คำถาม "ตอนนี้ค้างอะไร" ตอบได้ด้วยคำสั่งเดียวที่ไล่ตรวจกับโค้ดจริงพร้อมหลักฐาน `ไฟล์:บรรทัด`
และบอกด้วยว่าคำตอบนั้นเชื่อได้แค่ไหน (memory กับ git ของสองเครื่องตรงกันหรือยัง)

**Architecture:** `scripts/backlog.js` อ่านหัวข้อ `## ส่งต่อรอบหน้า` และ `## เปิดอยู่` ของ `STATUS.md`
แล้วจับ `· ตรวจ: <id>` ของแต่ละข้อเข้ากับ **registry** ใน `scripts/lib/backlog-checks.js` ·
แต่ละ check คืนผลเป็นหนึ่งใน `PASS / FAIL / NOT-VERIFIED / WAITING-OWNER` **พร้อมสตริงหลักฐาน** ·
ปิดท้ายด้วยบล็อกสุขภาพการ sync · `.claude/commands/backlog.md` เป็นตัวบางที่สั่งรันแล้วห้ามสรุปก่อนเห็นผล

**Tech Stack:** Node.js ไม่มี dependency ใหม่ · เข้าชุดกับ `scripts/status.js` และ `scripts/lib/*`
ที่มีอยู่ (`cache-markers.js`, `data-files.js`, `roster-health.js`, `backup-name.js`)

## Global Constraints

- แก้ในworktree `C:\Users\tairo\ta-work` branch `chore/backlog-command` (แตกจาก `main` หลังแผนที่ 2 merge) · **ห้ามแก้ `Z:\Time_Attendance` ตรงๆ**
- **ผลลัพธ์ของสคริปต์เป็นภาษาอังกฤษ** ตามเหตุผลที่ `scripts/status.js` เขียนไว้: มันรันในคอนโซล Windows ธรรมดา ซึ่งภาษาไทยออกมาเป็นเครื่องหมายคำถาม · **ส่วนการรายงานให้เจ้าของเป็นภาษาไทย เป็นหน้าที่ของ Claude ที่อ่านผลไปเล่า** ไม่ใช่ของสคริปต์
- **รูปแบบที่เจ้าของสั่งไว้** (`Z:\claude_memory\feedback_pending_task_format.md`): ตอนเล่าให้เจ้าของฟัง ต้องเป็นตาราง Markdown `ขนาด | งาน` ⇒ `/backlog` ต้องสั่งเรื่องนี้ไว้ในตัวคำสั่ง
- **กฎ "คำสั่งเดียวที่ต้องจำ"** (เจ้าของกำหนด 2026-10-02: *"ผมจำไม่ได้หรอก และก็ไม่รู้ด้วยว่าต้องรันอันไหน"*) ⇒ ห้ามแจกคำสั่งใหม่ให้เจ้าของจำเฉยๆ · `npm run status` **ต้องพิมพ์ `npm run backlog` รวมอยู่ในรายการคำสั่งท้ายผลลัพธ์**
- **ข้อห้ามที่สืบทอดมาจาก `scripts/status.js` และต้องเคารพ:** ห้ามพิมพ์ตัวเลขหรือสถานะที่ไม่ได้วัดจริง · สิ่งที่วัดไม่ได้ต้องพิมพ์ว่า **ไม่ได้วัด** ไม่ใช่พิมพ์ศูนย์ · `status.js` จงใจไม่ทำ "ตารางเทียบรายข้อ" เพราะมันคือ *เครื่องผลิตบรรทัดสีเขียวที่ไม่มีใครตรวจ* ⇒ **ดูหัวข้อ "ความขัดแย้งกับ status.js" ด้านล่าง ต้องอ่านก่อนเขียนโค้ด**
- ห้าม `grep`/เดินไฟล์ทั้งรากโปรเจกต์โดยไม่ตัด `node_modules` (74 แพ็กเกจบน SMB — เคยทำคำสั่งตายที่ 120 วินาที)
- `STATUS.md` ≤150 บรรทัด / ≤20480 ไบต์ และรูปแบบถูกบังคับด้วย `tests/status-structure.test.js` (101 ข้อ): ในสามหัวข้อที่คุม ทุกบรรทัดต้องเป็นข้อ `- ` คอลัมน์แรก, บรรทัดต่อที่ย่อหน้า, หรือ blockquote · ข้อหนึ่งมี `· ตรวจ:` ได้ไม่เกินหนึ่ง และ `· รอเจ้าของ:` ได้ไม่เกินหนึ่ง และต้องมีอย่างน้อยหนึ่ง · **ห้ามแก้ blockquote ใต้ `## ส่งต่อรอบหน้า`** (ถูกตรึงไว้เป็นค่าคงที่ในเทสต์)
- งบเวลาของ `npm run backlog`: **≤ 5 วินาที** · ชิ้นส่วนที่วัดไว้ 2026-10-12: `node` เริ่ม 0.1 · อ่าน `STATUS.md` 0.15 · `git status`+นับ commit บน worktree ในเครื่อง **1.94** · เทียบรายชื่อ+ขนาด memory สองฝั่ง 0.22 · อ่านท้าย `sync.log` 0.02 ⇒ เหลือให้การตรวจรายข้อ ~2.5 วินาที · เรียก `git` ให้น้อยครั้งที่สุด (ค่าเริ่มโปรเซสบน Windows ~0.3 วิต่อครั้ง)
- ปิดงานด้วย `node --check attendance/js/app.js` และ `npm run check` (ต้องได้ `37/37 test files passed` หลังเพิ่มไฟล์เทสต์ใหม่ 1 ไฟล์)

---

## ความขัดแย้งกับ `scripts/status.js` — ต้องอ่านก่อนเขียนโค้ด

`scripts/status.js` เขียนไว้ในคอมเมนต์หัวไฟล์ว่า **จงใจไม่ทำ** "ตารางเทียบรายข้อว่าที่บันทึกไว้
ตรงกับของจริงไหม" โดยให้เหตุผลว่ามันคือ *"เครื่องผลิตบรรทัดสีเขียวที่ไม่มีใครตรวจ"* —
ซึ่งเป็นสิ่งที่สเปกข้อ 7 ของ `2026-10-12-faster-startup-and-cross-machine-state-design.md` สั่งให้ทำ

**ข้อนี้ไม่ใช่เรื่องที่ผู้ลงมือตัดสินเอง** — เจ้าของอนุมัติสเปกข้อ 7 ไว้แล้ว ⇒ ทำ แต่ต้องทำในแบบที่
คำเตือนของ `status.js` ยังเป็นจริง:

1. **ห้ามมีสถานะ "ผ่าน" ที่ไม่มีหลักฐาน** — ทุกผล `PASS` ต้องมาพร้อมสตริงหลักฐานที่พิมพ์ออกมาด้วย
   (`ไฟล์:บรรทัด` หรือผลคำสั่งจริง) ถ้า check หาหลักฐานไม่ได้ ⇒ ผลคือ `NOT-VERIFIED` ไม่ใช่ `PASS`
2. **ห้ามเดาแทนเจ้าของ** — ข้อที่มี `· รอเจ้าของ:` ให้ผล `WAITING-OWNER` และพิมพ์ข้อความที่เจ้าของรออยู่
   **ห้ามรายงานว่าผ่าน** แม้ฝั่งที่ตรวจได้จะผ่าน (เคสจริงที่ยังเปิดอยู่: `superadmin-dryrun-pass-reasons` —
   ฝั่งที่สคริปต์ตรวจได้คือ "โค้ดยังเป็นอย่างที่ `STATUS.md` บอก" ⇒ ผ่าน แต่เกณฑ์ของฝั่ง "ผ่าน" เป็นของเจ้าของ
   ⇒ ผลรวมต้องเป็น `WAITING-OWNER`)
3. **จำนวนบรรทัดต้องน้อยกว่าจำนวนข้อ** ไม่ใช่มากกว่า — ข้อที่ `PASS` พิมพ์บรรทัดเดียว
   ข้อที่ `FAIL`/`NOT-VERIFIED`/`WAITING-OWNER` พิมพ์รายละเอียด ⇒ สายตาไปตกที่ของที่ต้องทำ ไม่ใช่กองสีเขียว
4. **registry ที่ไม่มีใครใช้คือของตาย** — เทสต์ต้องแดงทั้งสองทาง: id ใน `STATUS.md` ที่ไม่มีใน registry
   **และ** id ใน registry ที่ไม่มีข้อไหนใช้

> **แก้ตัวอย่างของกฎข้อ 2 (2026-10-12, รีวิวก่อน merge) — ไม่ได้แก้ตัวกฎ** · ของเดิมยกตัวอย่างว่า
> *"(เคสจริง: `nas-password-scrubbed` ผ่าน แต่รหัสยังไม่เปลี่ยน)"* ⇒ ประโยคนั้นยืนยันสถานะรหัสผ่านเป็น
> ปัจจุบันกาล ซึ่ง **ไม่มีใครยืนยันได้** และข้อนั้นเจ้าของสั่งปิดเมื่อ 2026-10-12 พร้อมสั่งห้ามยกขึ้นมาอีก
> (`docs/STATUS_CLOSED.md` หัวข้อ "ปิดไปแล้ว 2026-10-12 (รอบที่สอง)") · **หลักการที่ตัวอย่างนั้นสอนยังใช้ได้
> ทุกตัวอักษร: ห้ามรายงานข้อว่าผ่าน เมื่อส่วนหนึ่งของข้อเป็นการตัดสินของเจ้าของ** เปลี่ยนเฉพาะตัวอย่าง
> ให้เป็นข้อที่ยังเปิดอยู่จริงและตรวจได้ทันที

---

## File Structure

| ไฟล์ | หน้าที่ |
|---|---|
| `scripts/lib/backlog-status.js` | **สร้างใหม่** — อ่าน `STATUS.md` คืนโครงสร้างของข้อ (id, หัวข้อ, บรรทัด `รอเจ้าของ`, เลขบรรทัดจริงในไฟล์) · ไม่รู้เรื่องการตรวจ |
| `scripts/lib/backlog-checks.js` | **สร้างใหม่** — registry: `id -> { describe, run() }` · แต่ละ `run()` คืน `{ verdict, evidence }` · ไม่รู้เรื่องการพิมพ์ |
| `scripts/lib/sync-health.js` | **สร้างใหม่** — เทียบ memory สองฝั่ง, ไฟล์ที่ลบฝั่งเดียว, ไฟล์ที่ไม่เข้า `$Patterns`, ท้าย `sync.log`, สถานะ git |
| `scripts/backlog.js` | **สร้างใหม่** — ตัวพิมพ์เท่านั้น เรียกสามตัวข้างบน |
| `.claude/commands/backlog.md` | **สร้างใหม่** — slash command บาง |
| `tests/backlog-registry.test.js` | **สร้างใหม่** — ผูก `STATUS.md` กับ registry สองทาง |
| `scripts/status.js` | **แก้** — เพิ่ม `npm run backlog` ในรายการคำสั่งท้ายผลลัพธ์ |
| `package.json` | **แก้** — เพิ่ม `"backlog": "node scripts/backlog.js"` |
| `STATUS.md` | **แก้** — ปิดข้อ `backlog-command` (ข้อนี้คือตัวงานนี้เอง) + บันทึกใน `docs/STATUS_CLOSED.md` |

**ทำไมแยกเป็น 4 ไฟล์:** ตัวอ่านเอกสาร ตัวตรวจ ตัววัดสุขภาพ และตัวพิมพ์ ต้องแก้คนละเวลาและ
ทดสอบแยกกันได้ · ถ้ารวมเป็นไฟล์เดียว การเพิ่ม check ใหม่จะต้องอ่านโค้ดพิมพ์ผลไปด้วยทุกครั้ง

---

### Task 1: ตัวอ่าน `STATUS.md` + เทสต์ที่ผูก registry สองทาง (แดงก่อน)

**Files:**
- Create: `scripts/lib/backlog-status.js`
- Create: `tests/backlog-registry.test.js`

**Interfaces:**
- Produces: `parseStatus(text)` คืน
  `{ handoff: [{ subject, line, fields:{action,source,evidence} }], open: [{ subject, line, checkId|null, waitingOwner|null }] }`
  — `line` คือเลขบรรทัดจริงในไฟล์ (1-indexed) เพื่อให้พิมพ์หลักฐาน `STATUS.md:<n>` ได้
- Produces: สัญญาว่า registry อยู่ที่ `scripts/lib/backlog-checks.js` และ export `CHECKS` เป็น object `{ [id]: { describe, run } }`

- [ ] **Step 1: เขียน `parseStatus` ให้เล็กและไม่ซ้ำกับเทสต์เดิม**

`tests/status-structure.test.js` ตรวจ *รูปแบบ* ของไฟล์แล้ว ⇒ `parseStatus` **ไม่ต้องตรวจรูปแบบซ้ำ**
ให้สมมติว่ารูปแบบถูก (เพราะเทสต์นั้นบังคับอยู่) แล้วทำหน้าที่ดึงข้อมูลเท่านั้น ·
ถ้าเจอสิ่งที่ผิดรูป ให้ `throw` พร้อมข้อความที่บอกเลขบรรทัด ไม่ใช่คืนค่าเงียบๆ

- [ ] **Step 2: เขียน `tests/backlog-registry.test.js` ให้แดง**

เคสที่ต้องมี (ทุกเคสใช้ fixture เป็นสตริงในไฟล์เทสต์ ยกเว้นสองเคสท้ายที่อ่านไฟล์จริง):

| เคส | แดงเมื่อ |
|---|---|
| parse: ดึง id ได้ตรง | `· ตรวจ: abc-def` ไม่ถูกจับ หรือเลขบรรทัดผิด |
| parse: ดึง `รอเจ้าของ` ได้ | ข้อที่มีแต่ `· รอเจ้าของ:` ถูกมองว่าไม่มีอะไร |
| parse: ข้อที่มีทั้งสองบรรทัด | ได้ทั้ง `checkId` และ `waitingOwner` |
| **registry ขาด id** | มี id ใน `STATUS.md` จริง ที่ไม่มีใน `CHECKS` |
| **registry มีของตาย** | มี id ใน `CHECKS` ที่ไม่มีข้อไหนใน `STATUS.md` ใช้ |
| ทุก check มี `describe` ที่ไม่ว่าง | เผื่อเพิ่ม check แล้วลืมอธิบาย |

สองเคสกลางคืออันที่ต้องอ่าน `STATUS.md` และ `scripts/lib/backlog-checks.js` ของจริง
⇒ ตอนนี้ต้องแดงเพราะยังไม่มีไฟล์ registry

- [ ] **Step 3: รันให้เห็นว่าแดงด้วยเหตุผลที่ถูก**

```bash
node tests/backlog-registry.test.js
```

คาดหวัง: เคส parse เขียว · สองเคส registry แดงด้วยข้อความว่าหาไฟล์ `backlog-checks.js` ไม่เจอ
ถ้าเคส registry **ผ่าน** ให้หยุด — แปลว่าเทสต์ไม่ได้อ่านไฟล์จริง

- [ ] **Step 4: commit**

---

### Task 2: registry ของการตรวจ

**Files:**
- Create: `scripts/lib/backlog-checks.js`
- Test: `tests/backlog-registry.test.js` (จาก Task 1 ไม่แก้)

**Interfaces:**
- Consumes: `parseStatus` จาก Task 1
- Produces: `CHECKS = { [id]: { describe: string, run: () => ({ verdict, evidence }) } }`
  โดย `verdict` เป็นหนึ่งใน `'PASS' | 'FAIL' | 'NOT-VERIFIED' | 'WAITING-OWNER'`
  และ `evidence` เป็นสตริงที่พิมพ์ให้คนอ่านได้ (ต้องมี `ไฟล์:บรรทัด` หรือผลคำสั่งจริง)

- [ ] **Step 1: อ่าน `STATUS.md` ของจริงก่อนเขียน registry**

```bash
grep -n '· ตรวจ:\|· รอเจ้าของ:' STATUS.md
```

เขียน check ให้ **ครบทุก id ที่เห็นจริง** ไม่ใช่ตามรายการในแผนนี้ (รายการอาจล้าสมัยเมื่อถึงเวลาลงมือ)
และห้ามเพิ่ม check ที่ไม่มีข้อไหนใช้ เพราะเทสต์จะแดง

- [ ] **Step 2: เขียนแต่ละ check ให้คืนหลักฐานจริง**

ตัวอย่างที่คาดว่าจะต้องมี (ยืนยันกับ `STATUS.md` ตอนลงมือ):

> **แก้รายการ id (2026-10-12, รีวิวก่อน merge)** · ตอนเขียนแผนนี้ `STATUS.md` มี 4 id · วันเดียวกันนั้น
> เจ้าของสั่งปิดสองข้อ ⇒ **`nas-password-scrubbed` และ `cursor-rules-file` ไม่มีข้อไหนใช้แล้ว
> ⇒ ห้ามลงทะเบียนทั้งสองตัวใน registry** (เทสต์สองทางของแผนนี้เองจะแดงที่ "id ใน registry ที่ไม่มีข้อไหนใช้")
> · id ที่มีจริงตอนนี้เหลือ **3 ตัว**: `superadmin-dryrun-pass-reasons` · `backlog-command` ·
> `sync-push-false-success` · ย่อหน้าของ `nas-password-scrubbed` ด้านล่างเก็บไว้เป็นบันทึกของการออกแบบ
> เท่านั้น **ไม่ใช่งานที่ต้องทำ** — และอย่าเขียนโค้ดหรือข้อความใดที่ยืนยันสถานะรหัสผ่าน · ยืนยันรายการจริง
> ด้วย `grep -n '· ตรวจ:' STATUS.md` ก่อนลงมือเสมอ

- ~~`nas-password-scrubbed`~~ **(ปิดแล้ว 2026-10-12 — ห้ามลงทะเบียน · เก็บไว้เป็นบันทึกการออกแบบ)** —
  นับไฟล์ที่มี placeholder `<ขอรหัสจากเจ้าของ>` ในโฟลเดอร์ memory ของเครื่องนี้
  และรายงานจำนวนพร้อม `ไฟล์:บรรทัด` ของแต่ละจุด · **ข้อนี้มี `· รอเจ้าของ:` ด้วย**
  ⇒ ผลรวมต้องเป็น `WAITING-OWNER` แม้ส่วนที่ตรวจได้จะผ่าน (ดูกฎข้อ 2 ของหัวข้อความขัดแย้ง)
  · โฟลเดอร์ memory คำนวณจาก `os.homedir()` + `.claude/projects/Z--/memory` และถ้าไม่มี ⇒ `NOT-VERIFIED`
  พร้อมบอกว่าเพราะโฟลเดอร์ไม่อยู่ที่นี่ (เครื่องอื่น path ต่างกัน)
- `sync-push-false-success` — **id ที่เพิ่มเข้ามาหลังเขียนแผนนี้ ต้องมี check** · เส้นทางเขียนหมุดใน
  `Z:\claude_memory\sync_if_dirty.ps1` + ท้าย `Z:\claude_memory\sync.log` · ฉากที่พังอยู่ใน
  `docs/superpowers/notes/2026-10-12-memory-sync-known-limits.md` ข้อ 1–2 · ถ้าอ่าน `Z:\` ไม่ได้ ⇒ `NOT-VERIFIED`
- `superadmin-dryrun-pass-reasons` — ยืนยันว่าโค้ดยังเป็นอย่างที่ `STATUS.md` บอก (ฝั่งไม่ผ่านดึง
  `d.message` มาต่อท้าย) ด้วยการค้นใน `attendance/js/app.js` และรายงานเลขบรรทัดที่เจอ
  · เกณฑ์ฝั่ง "ผ่าน" เป็นของเจ้าของ ⇒ `WAITING-OWNER`
- ~~`cursor-rules-file`~~ **(ปิดแล้ว 2026-10-12 — ไฟล์กฎถูกเขียนแล้ว ไม่มีข้อไหนใช้ id นี้ ⇒ ห้ามลงทะเบียน)** —
  ของเดิมเขียนว่า ถ้ามีแต่ `· รอเจ้าของ:` ไม่มี `· ตรวจ:` ก็ไม่ต้องมี check (เทสต์จะแดงถ้าเพิ่มเกิน)
- `backlog-command` — **ข้อนี้คือตัวงานนี้เอง** ⇒ Task 5 จะปิดมัน ไม่ต้องเขียน check ค้างไว้

- [ ] **Step 3: รันเทสต์ให้เขียวทั้งไฟล์ แล้ว commit**

---

### Task 3: บล็อกสุขภาพการ sync

**Files:**
- Create: `scripts/lib/sync-health.js`
- Modify: `tests/backlog-registry.test.js` (เพิ่มเคสของ pure function ที่แยกได้)

**Interfaces:**
- Produces: `describeSyncHealth()` คืน `{ lines: string[], unmeasured: string[] }`
- Produces: pure function ที่ทดสอบได้โดยไม่ต้องมี Z: — `compareListings(localList, nasList, patterns)`
  คืน `{ differing, localOnly, nasOnly, outsidePatterns }`

- [ ] **Step 1: แยกตรรกะที่ทดสอบได้ออกจาก I/O**

`compareListings` รับ array ของ `{ name, size }` สองชุด + รายการ pattern ⇒ **ทดสอบได้ด้วย fixture**
ส่วนตัวอ่านดิสก์เป็นอีกฟังก์ชันที่บาง · เหตุผล: เครื่องที่ไม่ได้ map `Z:` ต้องยังรันเทสต์ได้

- [ ] **Step 2: ตัววัดจริงต้องประกาศสิ่งที่วัดไม่ได้**

- memory: เทียบ **ชื่อ+ขนาด** (0.22 วิ) ไม่ hash · ถ้า `Z:\claude_memory` เข้าไม่ถึง ⇒ ใส่ใน `unmeasured`
  พร้อมเหตุผล **ห้ามพิมพ์ว่า "ตรงกัน"**
- ไฟล์ที่ลบฝั่งเดียว: รายงานเท่านั้น **ไม่ลบอัตโนมัติ** (`sync_memory.ps1` ไม่มี logic ลบโดยเจตนา
  และการให้สคริปต์ลบเองคือทางที่ข้อมูลหายถาวร) ⇒ พิมพ์ว่าให้เจ้าของตัดสิน
- ไฟล์ memory ที่ไม่เข้า `$Patterns`: อ่านรายการ pattern จาก `Z:\claude_memory\sync_memory.ps1` ของจริง
  (regex ที่บล็อก `$Patterns`) **ไม่ใช่ hardcode** เพราะถ้า hardcode แล้วของจริงเปลี่ยน รายงานจะโกหก
  · ข้ามไฟล์ที่ขึ้นต้นด้วยจุด (`.sync_backup`, `.sync_marker`)
- `sync.log`: อ่านบรรทัดสุดท้าย + เตือนถ้าบรรทัดนั้นมี `conflict=` ที่ไม่ใช่ 0 หรือมีคำว่า `FAILED`
  (รูปแบบ log ถูกกำหนดในแผนที่ 2 — อ่านของจริงก่อนเขียน parser)
- git: **เรียกครั้งเดียว** `git status --porcelain -- STATUS.md` และ `git rev-list --count @{u}..HEAD`
  · ถ้าไม่มี upstream ⇒ `unmeasured` ไม่ใช่ศูนย์
- **ข้อจำกัดที่ต้องพิมพ์ออกมาเสมอ**: ถ้าอีกเครื่องยังไม่ push เครื่องนี้ไม่มีทางรู้ว่ามีอะไรค้างที่นั่น

- [ ] **Step 3: วัดเวลา แล้ว commit**

---

### Task 4: ตัวพิมพ์ + คำสั่ง `/backlog` + `npm run backlog`

**Files:**
- Create: `scripts/backlog.js`
- Create: `.claude/commands/backlog.md`
- Modify: `package.json`, `scripts/status.js`

- [ ] **Step 1: `scripts/backlog.js`**

พิมพ์ตามลำดับนี้ (อังกฤษ): หัวเรื่องว่าวัดจาก tree ไหน branch ไหน · หัวข้อ `HANDOFF` ·
หัวข้อ `OPEN` โดยเรียง `FAIL` → `NOT-VERIFIED` → `WAITING-OWNER` → `PASS` ·
หัวข้อ `SYNC HEALTH` · หัวข้อ `NOT MEASURED` · ปิดท้ายด้วยรายการคำสั่งอื่นตามกฎ "คำสั่งเดียวที่ต้องจำ"

- [ ] **Step 2: `.claude/commands/backlog.md`**

เนื้อหาต้องบังคับ 3 อย่าง: (1) รัน `npm run backlog` ก่อนพูดอะไร (2) **ห้ามสรุปงานค้างก่อนเห็นผลลัพธ์จริง**
และห้ามเติมข้อที่ไม่อยู่ในผลลัพธ์จากความจำ (3) เล่าให้เจ้าของเป็น **ตาราง `ขนาด | งาน` ภาษาไทย**
พร้อมยกข้อที่เป็น `FAIL`/`NOT-VERIFIED`/`WAITING-OWNER` ขึ้นก่อน
· วางที่ `.claude/commands/` ของ repo เพื่อให้เดินทางไปอีกเครื่องด้วย git

- [ ] **Step 3: `npm run status` ต้องโฆษณาคำสั่งใหม่**

เพิ่ม `npm run backlog` เข้ารายการคำสั่งท้ายผลลัพธ์ของ `scripts/status.js` ตามกฎ
"คำสั่งเดียวที่ต้องจำ" · ถ้าไม่ทำ เจ้าของจะไม่รู้ว่ามีคำสั่งนี้

- [ ] **Step 4: วัดเวลารวม แล้ว commit**

```bash
powershell -NoProfile -Command "$t=Measure-Command { npm run backlog | Out-Null }; \"backlog: $([math]::Round($t.TotalSeconds,2)) s\""
```

คาดหวัง ≤5 วินาที · รายงานตัวเลขจริง ห้ามขยับเกณฑ์เงียบๆ

---

### Task 5: ปิดข้อ `backlog-command` ของตัวเอง

**Files:**
- Modify: `STATUS.md`, `docs/STATUS_CLOSED.md`

- [ ] **Step 1: ย้ายข้อออกจาก `## เปิดอยู่`** แล้วเขียนบันทึกในหัวข้อของวันนี้ใน `docs/STATUS_CLOSED.md`
  (ห้ามแก้ 406 บรรทัดที่ย้ายมา — ต่อท้ายหัวข้อใหม่ได้) พร้อมบรรทัดสารบัญใน `STATUS.md`
- [ ] **Step 2: ยืนยันว่าเทสต์ยังเขียวทั้งสองทาง** — `tests/status-structure.test.js` (สารบัญสองทาง)
  และ `tests/backlog-registry.test.js` (registry ต้องไม่มี id ตาย หลังข้อนี้หายไป)
- [ ] **Step 3: `npm run check` แล้ว commit**

---

## Self-Review

**ความครอบคลุมเทียบสเปก:** ข้อ 7 (`backlog.js` + `/backlog` + รูปแบบตาราง + `ask-owner`→`รอเจ้าของ`)
→ Task 1-4 · ข้อ 8 (บล็อกสุขภาพ sync + ไฟล์ที่ลบฝั่งเดียว + ไฟล์นอก pattern + ข้อจำกัดที่ต้องพูด)
→ Task 3 · เทสต์ข้อ 2 ของสเปก (registry) → Task 1 · **ไม่มีข้อไหนของสเปกเหลือหลังแผนนี้**

**Placeholder:** ไม่มี · รายการ check id ใน Task 2 เขียนกำกับไว้ว่าต้องยืนยันกับ `STATUS.md` ตอนลงมือ
เพราะไฟล์นั้นเปลี่ยนได้ระหว่างนี้ — นั่นเป็นคำสั่งโดยเจตนา ไม่ใช่ช่องว่าง

**ความสอดคล้องของชื่อ:** `parseStatus` · `CHECKS` · `describeSyncHealth` · `compareListings`
· `verdict` ∈ `PASS|FAIL|NOT-VERIFIED|WAITING-OWNER` — ใช้ชื่อเดียวกันทุก task
