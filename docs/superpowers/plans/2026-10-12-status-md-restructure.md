# หั่น STATUS.md และบังคับรูปแบบข้อส่งต่อ — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ทำให้ `STATUS.md` อ่านจบในรอบเดียว และทำให้ข้อส่งต่อระหว่างเครื่อง "ไม่มีเนื้อหาในตัวเอง" commit ไม่ผ่าน

**Architecture:** ย้ายรายละเอียดของงานที่ปิดแล้วออกไป `docs/STATUS_CLOSED.md` แบบคัดลอกตรงตัว เหลือสารบัญ
1 บรรทัดต่อข้อไว้ใน `STATUS.md` เพื่อรักษาหน้าที่ "อย่าเสนอซ้ำ" · เพิ่มหัวข้อ `## ส่งต่อรอบหน้า` ที่บังคับ
4 ช่อง · ทุกข้อใน `## เปิดอยู่` ต้องมีบรรทัด `· ตรวจ: <check-id>` เพื่อให้แผนที่ 3 (`backlog.js`)
ผูกการตรวจอัตโนมัติเข้ากับมันได้ · ทั้งหมดมีเทสต์เดียวเป็นยามเฝ้า และเทสต์นั้นต้องแดงก่อน

**Tech Stack:** Node.js (ไม่มี dependency ใหม่) · `tests/*.test.js` รูปแบบเดิมของโปรเจกต์
(`'use strict'`, ฟังก์ชัน `test()` ในไฟล์ที่ตั้ง `process.exitCode = 1` เมื่อแดง, รันผ่าน `tests/run-all.js`)

## Global Constraints

- แก้ในworktree ของเครื่องนี้เท่านั้น: `C:\Users\tairo\ta-work` branch `chore/faster-startup-and-sync` · **ห้ามแก้ `Z:\Time_Attendance` ตรงๆ** (นั่นคือเว็บจริง)
- `STATUS.md` ≤ **150 บรรทัด** และ ≤ **20 KB (20480 ไบต์)**
- `MEMORY.md` และโฟลเดอร์ memory อยู่ที่ `C:\Users\tairo\.claude\projects\Z--\memory\` **ไม่ได้อยู่ใน git repo** ⇒ งานที่แตะไฟล์นั้นไม่มี commit และไม่มีเทสต์ครอบ
- ห้ามแก้เนื้อหาของหัวข้อที่ปิดแล้วตอนย้าย — **คัดลอกตรงตัว** เท่านั้น
- ไม่ต้องบัมพ์ cache-buster เพราะไม่แตะไฟล์ frontend
- ข้อความใน `STATUS.md` เขียนภาษาไทยตามเดิม · คอมเมนต์ในไฟล์เทสต์เขียนภาษาอังกฤษตามไฟล์เทสต์เดิมของโปรเจกต์
- ปิดงานด้วย `npm run check` (lint + test ทั้งชุด) ต้องผ่านครบ

---

## File Structure

| ไฟล์ | หน้าที่ |
|---|---|
| `tests/status-structure.test.js` | **สร้างใหม่** — ยามเฝ้ารูปแบบของ `STATUS.md` อย่างเดียว ไม่รู้เรื่อง `backlog.js` |
| `docs/STATUS_CLOSED.md` | **สร้างใหม่** — รายละเอียดงานที่ปิดแล้ว ย้ายมาตรงตัว |
| `STATUS.md` | **เขียนใหม่ทั้งไฟล์** — เหลือ 3 หัวข้อ |
| `C:\Users\tairo\.claude\projects\Z--\memory\MEMORY.md` | **แก้ (นอก git)** — ย่อพิธีกรรมเปิดงานให้จบในตัวเอง |

**ทำไมแยก `tests/status-structure.test.js` ออกจากชื่อ `tests/backlog.test.js` ที่สเปกเขียนไว้:**
ไฟล์นี้ตรวจ *รูปแบบเอกสาร* ซึ่งยืนได้เองโดยไม่มี `backlog.js` ส่วนการตรวจว่า `check-id` มีอยู่ใน
registry จริงต้องรอ `backlog.js` ⇒ ไปอยู่ใน `tests/backlog-registry.test.js` ตอนแผนที่ 3
สเปกต้องถูกแก้ให้ตรงด้วยใน Task 4

---

### Task 1: ยามเฝ้ารูปแบบ `STATUS.md` (แดงก่อน)

**Files:**
- Create: `tests/status-structure.test.js`

**Interfaces:**
- Consumes: ไม่มี
- Produces: ข้อตกลงเรื่องรูปแบบที่ Task 2 ต้องทำให้ผ่าน —
  - หัวข้อบังคับสามอัน: `## ส่งต่อรอบหน้า`, `## เปิดอยู่`, `## ปิดแล้ว (สารบัญ)`
  - ข้อในหัวข้อ = บรรทัดที่ขึ้นต้นด้วย `- ` ที่คอลัมน์แรก เนื้อหาของข้อคือบรรทัดนั้นจนถึงข้อถัดไป
  - ข้อใน `## เปิดอยู่` ต้องมีบรรทัดที่ตรง `/^\s*·\s*ตรวจ:\s*([a-z0-9-]+)\s*$/`
  - ข้อใน `## ส่งต่อรอบหน้า` ต้องมีทั้ง `**ให้ทำอะไร:**`, `**ที่มา:**`, `**หลักฐาน:**` และหัวข้อตัวหนาในบรรทัดแรก
  - บรรทัดในสารบัญต้องตรง `/^- \*\*(\d{4}-\d{2}-\d{2})\*\* — (.+)$/` และข้อความหลัง `—` ต้องปรากฏใน heading ของ `docs/STATUS_CLOSED.md`

- [ ] **Step 1: เขียนไฟล์เทสต์ที่ยังแดง**

สร้าง `tests/status-structure.test.js`:

```js
// STATUS.md is the one file that tells the other machine what is still open, so its shape is
// load-bearing. Two failures made this test necessary.
//
// 2026-10-12: the file had grown to 498 lines / 80 KB, which is past the size a session can read
// in one pass -- so every session paid two round trips before it could say what was open. 81% of
// those lines were details of work already closed.
//
// The other failure cost more. A handoff note that said only "next session, remind me about
// superadmin" reached the other machine intact, but the knowledge of what to remind about and what
// to do did not travel with it, so that machine could not act on it. A pointer with no payload.
// This test refuses the shape that allowed it: every handoff item must carry an action, a source
// and evidence.
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const STATUS_PATH = path.join(ROOT, 'STATUS.md');
const CLOSED_PATH = path.join(ROOT, 'docs', 'STATUS_CLOSED.md');

const STATUS = fs.readFileSync(STATUS_PATH, 'utf8');
const LINES = STATUS.split(/\r?\n/);

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok ', name); }
  catch (e) { process.exitCode = 1; console.log('  FAIL', name, '\n      ', e.message); }
}

// Lines belonging to one `## ` section, excluding the heading itself.
function section(title) {
  const start = LINES.findIndex(l => l.trim() === `## ${title}`);
  if (start === -1) return null;
  const rest = LINES.slice(start + 1);
  const end = rest.findIndex(l => /^## /.test(l));
  return end === -1 ? rest : rest.slice(0, end);
}

// An item starts at a `- ` in column one and owns every line until the next one.
function items(lines) {
  const blocks = [];
  for (const l of lines) {
    if (/^- /.test(l)) blocks.push([l]);
    else if (blocks.length) blocks[blocks.length - 1].push(l);
  }
  return blocks.map(b => b.join('\n'));
}

function firstLine(block) { return block.split('\n')[0]; }

test('STATUS.md stays small enough to read in one pass', () => {
  const bytes = Buffer.byteLength(STATUS, 'utf8');
  if (LINES.length > 150) throw new Error(`${LINES.length} lines, limit is 150`);
  if (bytes > 20480) throw new Error(`${bytes} bytes, limit is 20480`);
});

test('the three required sections are present', () => {
  for (const t of ['ส่งต่อรอบหน้า', 'เปิดอยู่', 'ปิดแล้ว (สารบัญ)']) {
    if (section(t) === null) throw new Error(`missing section: ## ${t}`);
  }
});

test('every open item names a check id', () => {
  const open = items(section('เปิดอยู่') || []);
  if (open.length === 0) throw new Error('no items under ## เปิดอยู่ -- the parser or the file is wrong');
  for (const block of open) {
    const m = block.match(/^\s*·\s*ตรวจ:\s*([a-z0-9-]+)\s*$/m);
    if (!m) throw new Error(`no "· ตรวจ: <id>" line in: ${firstLine(block).slice(0, 70)}`);
  }
});

test('every handoff item carries an action, a source and evidence', () => {
  const handoff = items(section('ส่งต่อรอบหน้า') || []);
  for (const block of handoff) {
    const head = firstLine(block);
    if (!/^- \*\*.+\*\*/.test(head)) {
      throw new Error(`handoff item has no bold subject: ${head.slice(0, 70)}`);
    }
    for (const label of ['**ให้ทำอะไร:**', '**ที่มา:**', '**หลักฐาน:**']) {
      if (!block.includes(label)) {
        throw new Error(`handoff item is missing ${label}: ${head.slice(0, 70)}`);
      }
    }
  }
});

test('every closed-index line points at a heading that exists', () => {
  const index = items(section('ปิดแล้ว (สารบัญ)') || []);
  if (index.length === 0) throw new Error('the closed index is empty -- "do not propose this again" has no teeth');
  const closed = fs.readFileSync(CLOSED_PATH, 'utf8');
  const headings = closed.split(/\r?\n/).filter(l => /^#{2,4} /.test(l));
  for (const block of index) {
    const m = firstLine(block).match(/^- \*\*(\d{4}-\d{2}-\d{2})\*\* — (.+)$/);
    if (!m) throw new Error(`index line is not "- **YYYY-MM-DD** — <title>": ${firstLine(block).slice(0, 70)}`);
    const title = m[2].trim();
    if (!headings.some(h => h.includes(title))) {
      throw new Error(`no heading in docs/STATUS_CLOSED.md contains: ${title}`);
    }
  }
});

console.log(`status-structure: ${passed} passed`);
```

- [ ] **Step 2: รันให้เห็นว่าแดง และแดงด้วยเหตุผลที่ถูก**

```bash
node tests/status-structure.test.js
```

คาดหวัง: **FAIL** และต้องเห็นอย่างน้อยสามข้อนี้แดง
- `STATUS.md stays small enough to read in one pass` → `498 lines, limit is 150`
- `the three required sections are present` → `missing section: ## ส่งต่อรอบหน้า`
- `every closed-index line points at a heading that exists` → โยน `ENOENT` เพราะยังไม่มี `docs/STATUS_CLOSED.md`

ข้อสุดท้ายจะล้มด้วย exception ไม่ใช่ assert — **ยอมรับได้ในสเต็ปนี้** เพราะ Task 2 สร้างไฟล์นั้น
แต่ถ้ารันแล้ว **ผ่านหมด** ให้หยุด: แปลว่า parser อ่านหัวข้อไม่เจอแล้วเงียบ ไม่ใช่ไฟล์ถูกต้อง

- [ ] **Step 3: commit เทสต์ที่ยังแดง**

```bash
git add tests/status-structure.test.js
git commit -m "test(status): refuse the two shapes that cost us a round trip and a handoff

498 บรรทัด/80KB ทำให้ทุกเซสชันอ่าน STATUS.md สองรอบก่อนตอบได้ และโน้ตส่งต่อที่พูดแค่
'รอบหน้าเตือนเรื่อง superadmin' เดินทางไปถึงอีกเครื่องแต่ความรู้ว่าให้ทำอะไรไม่ได้ไปด้วย
เทสต์นี้แดงอยู่จนกว่าไฟล์จะถูกหั่นและข้อส่งต่อจะมีช่อง 'ให้ทำอะไร'

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: ย้ายรายละเอียดออก และเขียน `STATUS.md` ใหม่

**Files:**
- Create: `docs/STATUS_CLOSED.md`
- Modify: `STATUS.md` (เขียนใหม่ทั้งไฟล์)
- Test: `tests/status-structure.test.js` (จาก Task 1 ไม่แก้)

**Interfaces:**
- Consumes: ข้อตกลงรูปแบบจาก Task 1
- Produces: `check-id` สี่ตัวที่แผนที่ 3 ต้องลงทะเบียนใน registry ของ `backlog.js` —
  `nas-password-scrubbed` · `superadmin-dryrun-pass-reasons` · `cursor-rules-file` · `backlog-command`
  (`ask-owner` เป็น id สงวนสำหรับข้อที่ตรวจอัตโนมัติไม่ได้)

> **แก้สัญญาข้อนี้ (2026-10-12, รีวิวก่อน merge) — รายการสี่ตัวข้างบนล้าสมัยแล้ว** · วันเดียวกันนั้น
> เจ้าของสั่งปิดสองข้อ ⇒ **`nas-password-scrubbed` และ `cursor-rules-file` ถูกปิดเมื่อ 2026-10-12
> และไม่มีข้อไหนใน `STATUS.md` ใช้แล้ว ⇒ แผนที่ 3 ต้อง *ไม่* ลงทะเบียนสองตัวนี้** (เทสต์สองทางของแผนที่ 3
> แดงที่ "id ใน registry ที่ไม่มีข้อไหนใช้") · id ที่มีจริงตอนนี้เหลือ **3 ตัว**:
> `superadmin-dryrun-pass-reasons` · `backlog-command` · `sync-push-false-success` (ตัวท้ายเกิดหลังเขียนแผนนี้)
> · และ id สงวน `ask-owner` ถูกยกเลิกไปแล้ว บรรทัดชนิด `· รอเจ้าของ:` ทำหน้าที่นั้นแทน · **รายการที่เชื่อได้
> คือผลของ `grep -n '· ตรวจ:' STATUS.md` ตอนลงมือ ไม่ใช่รายการในแผน**

- [ ] **Step 1: สร้าง `docs/STATUS_CLOSED.md` โดยคัดลอกตรงตัว**

หัวข้อ `## ปิดไปแล้ว...` ทั้งหมดใน `STATUS.md` ปัจจุบันเริ่มที่บรรทัด 93 จนจบไฟล์ (หัวข้อของวันที่
2026-10-12, 2026-10-11, 2026-10-09, 2026-10-08, 2026-10-05 และหัวข้อ "กฎพิกัด")

> **แก้เลขบรรทัด 2026-10-12 (รีวิวรอบสุดท้าย): 95 → 93** · ของเดิมเขียน 95 ทั้งในย่อหน้านี้และใน
> คำสั่ง replay ด้านล่าง แต่หัวข้อ `## ปิดไปแล้ว 2026-10-12` อยู่ที่บรรทัด **93** ของ `STATUS.md`
> ก่อนย้าย (ตรวจได้ด้วย `git show 45526da~1:STATUS.md | grep -n '^## ปิดไปแล้ว'`) ⇒ ใครก็ตามที่
> replay ตามเลขเดิมจะคัดลอกขาดไป 2 บรรทัด **ขั้นตอน `sed -n '<n>p'` ที่ให้ตรวจก่อนคือสิ่งที่
> กันความเสียหายไว้ตอนทำจริง** — จึงเก็บขั้นตอนนั้นไว้ และแก้เลขให้ถูก

```bash
# ตรวจก่อนว่าบรรทัด 93 คือหัวข้อ "ปิดไปแล้ว" จริง ถ้าไฟล์ขยับไปแล้วต้องหาเลขใหม่
sed -n '93p' STATUS.md
```

คาดหวัง: `## ปิดไปแล้ว 2026-10-12 — อย่าเสนอซ้ำ`

```bash
{
  printf '%s\n' '# STATUS_CLOSED — รายละเอียดงานที่ปิดแล้ว'
  printf '%s\n' ''
  printf '%s\n' 'ย้ายออกจาก `STATUS.md` เมื่อ 2026-10-12 เพราะ 81% ของไฟล์นั้นเป็นหัวข้อที่ปิดแล้ว'
  printf '%s\n' 'จนอ่านรอบเดียวไม่จบ · **เนื้อหาคัดลอกมาตรงตัว ไม่ได้แก้** · สารบัญอยู่ใน `STATUS.md`'
  printf '%s\n' 'หัวข้อ "ปิดแล้ว (สารบัญ)" และ `tests/status-structure.test.js` บังคับว่าทุกบรรทัดในสารบัญ'
  printf '%s\n' 'ต้องมีหัวข้อปลายทางอยู่จริงในไฟล์นี้'
  printf '%s\n' ''
  printf '%s\n' '---'
  printf '%s\n' ''
  sed -n '93,$p' STATUS.md
} > docs/STATUS_CLOSED.md
```

- [ ] **Step 2: ตรวจว่าย้ายครบ ไม่หล่นหาย**

```bash
# จำนวนหัวข้อ "ปิดไปแล้ว" ต้องเท่ากับที่เคยมีใน STATUS.md
grep -c '^## ปิดไปแล้ว' docs/STATUS_CLOSED.md
grep -c '^## ปิดไปแล้ว' STATUS.md
# เทียบเนื้อหาช่วงที่ย้ายว่าตรงกันทุกไบต์
diff <(sed -n '93,$p' STATUS.md) <(sed -n '/^---$/,$p' docs/STATUS_CLOSED.md | tail -n +3) && echo "ตรงกันทุกบรรทัด"
```

คาดหวัง: สองคำสั่งแรกได้เลขเท่ากัน (5) · `diff` พิมพ์ `ตรงกันทุกบรรทัด`
ถ้า `diff` ไม่ว่าง **ห้ามไปต่อ** ให้แก้คำสั่งคัดลอกก่อน เพราะข้อมูลที่หล่นหายคือหลักฐานว่างานไหนปิดแล้ว

- [ ] **Step 3: เขียน `STATUS.md` ใหม่**

เขียนทับทั้งไฟล์ด้วยโครงนี้ — หัวข้อ "เปิดอยู่" เอาเฉพาะ 4 ข้อที่ **ตรวจกับโค้ดแล้วเมื่อ 2026-10-12**
ว่ายังเปิดจริง (ข้อที่ขีดฆ่าไปแล้วในไฟล์เดิมไม่ต้องยกมา — มันอยู่ในสารบัญที่ปิดแล้ว)

> **แก้โครงด้านล่าง 2026-10-12 (รีวิวรอบสุดท้าย)**: บรรทัดหัวไฟล์เดิมในโครงนี้สั่งว่า
> "ไล่ตรวจทุกข้อพร้อมหลักฐานด้วย `npm run backlog`" ทั้งที่ **คำสั่งนั้นยังไม่มี** — commit
> `3eafdd4` ถอดออกจาก `STATUS.md` ไปแล้วเพราะเป็นข้อความที่ไม่จริง (ตัวคำสั่งเป็นข้อเปิดอยู่
> `backlog-command` ในไฟล์เดียวกัน) ⇒ โครงในแผนนี้แก้ตามแล้ว เพื่อให้ใครที่ replay ไม่เขียน
> ประโยคเท็จกลับเข้าไปอีก

```markdown
# STATUS — งานที่เปิดอยู่

ไฟล์เดียวที่บอกว่า "ตอนนี้ค้างอะไร" **ประวัติว่าทำอะไรไปแล้วอยู่ใน `git log` ไม่ใช่ที่นี่**
(`git -C Z:/Time_Attendance log --oneline`) · รายละเอียดของงานที่ปิดแล้วอยู่ใน
[`docs/STATUS_CLOSED.md`](docs/STATUS_CLOSED.md) · **ห้ามเชื่อไฟล์นี้โดยไม่ตรวจกับโค้ด**

รูปแบบของไฟล์นี้ถูกบังคับด้วย `tests/status-structure.test.js` — ขนาดเกิน 150 บรรทัดหรือ 20 KB
เทสต์แดง, ข้อใน "เปิดอยู่" ที่ไม่มีบรรทัด `· ตรวจ:` เทสต์แดง, ข้อส่งต่อที่ไม่บอกว่าให้ทำอะไรเทสต์แดง
· ทุกข้อบันทึกวันที่ตรวจล่าสุดไว้ และต้องตรวจซ้ำกับโค้ดจริงก่อนเชื่อ

---

## ส่งต่อรอบหน้า

ข้อในหัวข้อนี้ต้องอ่านรู้เรื่องจากอีกเครื่องโดยไม่ต้องรู้บทสนทนาเดิม **ต้องมี 4 ช่อง**:
หัวข้อตัวหนา · `**ให้ทำอะไร:**` · `**ที่มา:**` · `**หลักฐาน:**`

> ที่มาของกฎนี้: โน้ตที่เคยเขียนว่า "รอบหน้าเตือนเรื่อง superadmin" เดินทางไปถึงอีกเครื่องจริง
> แต่ความรู้ว่าเตือนเรื่องอะไรและให้ทำอะไร ไม่ได้ไปด้วย ⇒ อีกเครื่องรับโน้ตแล้วทำอะไรไม่ได้

- **ทำแผนที่ 2 และ 3 ของงาน "เปิดงานเร็วขึ้น" ต่อ**
  · **ให้ทำอะไร:** อ่าน `docs/superpowers/specs/2026-10-12-faster-startup-and-cross-machine-state-design.md`
    แล้วทำข้อ 4–6 (แผนที่ 2: `$Patterns`, เร่ง `sync_memory.ps1`, hook `Stop`/`SessionEnd`, ลบ
    `session_handoff.md`) และข้อ 7–8 (แผนที่ 3: `scripts/backlog.js`, `/backlog`, บล็อกสุขภาพ sync)
  · **ที่มา:** เจ้าของสั่ง 2026-10-12 ว่า "ทำได้ทั้งหมด" หลังอนุมัติสเปก 9 ข้อ
  · **หลักฐาน:** `docs/superpowers/plans/2026-10-12-status-md-restructure.md` คือแผนที่ 1 ที่ทำเสร็จแล้ว
    · `git log --oneline chore/faster-startup-and-sync`

## เปิดอยู่

- 🔴 **รหัสผ่าน NAS — ล้างออกจากไฟล์และประวัติแล้ว แต่ยังไม่ได้เปลี่ยนรหัส**
  · การล้างเสร็จแล้ว 2026-10-11 (แทนด้วย `<ขอรหัสจากเจ้าของ>` ทั้งบน NAS และสำเนาในเครื่อง,
    เขียนประวัติ git ใหม่, สแกน 152 ออบเจกต์ไม่เหลือรหัส) · เครื่อง `tairo` ตรวจแล้ว 2026-10-12
    ว่าสำเนาสะอาด placeholder ครบ 4/4 ไฟล์
  · **สิ่งที่ยังเปิด: เจ้าของต้องเปลี่ยนรหัสที่ DSM เอง** รหัสเดิมยังใช้งานได้ ⇒ ที่ทำไปคือเก็บกวาด
    ไม่ใช่ลดความเสี่ยง · เครื่องบ้าน (`Teerawat`) ต้องตรวจสำเนาของตัวเองซ้ำ เครื่องนี้มองไม่เห็น
  · ตรวจ 2026-10-12 / `grep` เทียบ placeholder สองฝั่ง + เทียบ hash ทุกไฟล์
  · ตรวจ: nas-password-scrubbed

- **ข้อความโหมดซ้อมของ superadmin — ฝั่ง "ผ่าน" ไม่ไล่เงื่อนไข**
  · ฝั่งไม่ผ่านบอกเหตุผลแล้ว (`reportDryRun()` ดึง `d.message` จาก server มาต่อท้าย) ฝั่งผ่าน
    พูดแค่ "ตรวจผ่านทุกเงื่อนไข" ไม่ได้ไล่ว่าเงื่อนไขไหนบ้าง
  · **เกณฑ์เป็นของเจ้าของ ห้ามปิดเอง** ถ้าที่ต้องการคือ "ไม่ผ่านต้องรู้เพราะอะไร" ข้อนี้ปิดได้แล้ว
  · ข้อจำกัดเดิมยังอยู่: ห้ามโชว์ตัวเลขระยะทาง ดู
    `docs/superpowers/specs/2026-10-05-superadmin-inspector-design.md` คำตัดสินข้อ 2
  · ตรวจล่าสุด 2026-10-08 / `attendance/js/app.js` `reportDryRun()` + `server.js` `webScanGateReason()`
  · ตรวจ: superadmin-dryrun-pass-reasons

- **ไฟล์กฎให้ Cursor (สเปกเก็บสถานะข้ามเครื่อง ข้อ 4.5)**
  · ให้ Cursor อัปเดต `STATUS.md` และใส่ `Closes:` ตอนปิดงาน · ช่องทางที่พิสูจน์แล้วว่า Cursor
    เคารพคือ `.cursor/rules/` ซึ่งมี `superadmin-do-not-touch.mdc` อยู่แล้ว ⇒ เพิ่มอีกไฟล์ที่เดียวกัน
  · เจ้าของหยุดใช้ Cursor แล้วแต่อาจกลับมาใช้ ⇒ **จงใจไม่ทำในรอบ 2026-10-12** (สเปกข้อ "ไม่อยู่ในขอบเขต")
  · ตรวจ 2026-10-12 / `ls .cursor/rules/` มีไฟล์เดียว
  · ตรวจ: cursor-rules-file

- **`npm run backlog` และ `/backlog` (สเปกเก็บสถานะข้ามเครื่อง ข้อ 4.6)**
  · ต้องเป็นคำสั่งที่ห้ามตอบก่อนไล่ตรวจพร้อมหลักฐาน `ไฟล์:บรรทัด` ครบทุกข้อ
  · ออกแบบไว้แล้วใน `docs/superpowers/specs/2026-10-12-faster-startup-and-cross-machine-state-design.md`
    ข้อ 7–8 ⇒ เป็นเนื้อหาของแผนที่ 3
  · ตรวจ 2026-10-12 / ไม่มีโฟลเดอร์ `.claude/commands` ทั้งที่ `Z:\`, repo root และ user profile
  · ตรวจ: backlog-command

## ปิดแล้ว (สารบัญ)

1 บรรทัดต่อข้อ · รายละเอียดอยู่ใน [`docs/STATUS_CLOSED.md`](docs/STATUS_CLOSED.md)
**หน้าที่ของหัวข้อนี้คือกันการเสนองานที่ทำเสร็จแล้วซ้ำ** ซึ่งเคยเกิดจริง

- **2026-10-12** — ไทล์สถิติ dashboard — กฎสำหรับแท็บเล็ตตายมาตั้งแต่วันที่เขียน
- **2026-10-12** — ของที่รู้ไว้ ไม่ได้แก้ — บันทึกไว้ให้เครื่องอื่นเห็น
- **2026-10-11** — (เติมชื่อหัวข้อจากไฟล์จริงตอนทำ Step 4)
- **2026-10-09** — (เติมชื่อหัวข้อจากไฟล์จริงตอนทำ Step 4)
- **2026-10-08** — (เติมชื่อหัวข้อจากไฟล์จริงตอนทำ Step 4)
- **2026-10-05** — (เติมชื่อหัวข้อจากไฟล์จริงตอนทำ Step 4)
```

- [ ] **Step 4: เติมสารบัญจากชื่อหัวข้อจริง ไม่ใช่จากความจำ**

```bash
grep -n '^#\{2,4\} ' docs/STATUS_CLOSED.md
```

เอาชื่อหัวข้อที่พิมพ์ออกมา **คัดลอกตรงตัว** ไปแทนที่วงเล็บ `(เติมชื่อหัวข้อจากไฟล์จริง...)` ทุกอัน
ในหัวข้อ "ปิดแล้ว (สารบัญ)" · หัวข้อย่อย (`###`) ที่อยู่ใต้หัวข้อวันที่ ไม่ต้องยกมาเป็นบรรทัดสารบัญ
ยกมาเฉพาะหัวข้อระดับที่เป็น "เรื่อง" ของวันนั้น · **ข้อความหลัง `—` ต้องเป็นสตริงย่อยของ heading จริง**
ไม่งั้นเทสต์ข้อสุดท้ายแดง (นั่นคือสิ่งที่มันมีไว้จับ)

- [ ] **Step 5: รันเทสต์ให้ผ่าน**

```bash
node tests/status-structure.test.js
```

คาดหวัง: `ok` ทุกข้อ และบรรทัดท้าย `status-structure: <n> passed, 0 failed`

> **แก้ตัวเลขที่คาดหวัง 2026-10-12 (รีวิวรอบสุดท้าย)**: เดิมเขียน "`ok` ทั้ง 5 ข้อ และ
> `status-structure: 5 passed`" ซึ่งเป็นตัวเลขของตอนร่างแผน (เทสต์ 5 ข้อแรกที่ยืนยันกับไฟล์จริง)
> ของจริงมี fixture ต่อข้อละเอียดกว่านั้นมาก และ **จำนวนข้อเพิ่มทุกครั้งที่ปิดรูใหม่** —
> รอบนี้จบที่ **93 ข้อ** ⇒ อย่าผูกแผนกับตัวเลข ให้ดู `0 failed` เป็นเกณฑ์แทน

ถ้าข้อ `STATUS.md stays small enough` ยังแดง ให้ตัดคำอธิบายในหัวข้อ "เปิดอยู่" ให้สั้นลง
**ห้ามแก้ลิมิตในเทสต์** — ลิมิตคือสิ่งที่เจ้าของอนุมัติไว้

- [ ] **Step 6: รันชุดเต็มกันของพัง**

```bash
npm run check
```

คาดหวัง: lint ผ่าน และบรรทัดสรุปของเทสต์ขึ้นจำนวนไฟล์เพิ่มจากเดิม 1 ไฟล์ (เดิม 34/34)
⇒ ต้องได้ `35/35 test files passed`

ถ้ามีเทสต์เดิมแดงเพราะอ่าน `STATUS.md` อยู่ ให้แก้เทสต์นั้นให้อ่านจาก `docs/STATUS_CLOSED.md`
แทน **ห้ามย้อนการหั่นไฟล์** · ตรวจก่อนด้วย `grep -rln "STATUS.md" tests/`

- [ ] **Step 7: commit**

```bash
git add STATUS.md docs/STATUS_CLOSED.md
git commit -m "docs(status): cut the file 80KB -> readable, and give handoffs a required shape

406 ของ 498 บรรทัดเป็นรายละเอียดงานที่ปิดแล้ว ย้ายไป docs/STATUS_CLOSED.md ตรงตัว
เหลือสารบัญบรรทัดเดียวต่อข้อ ซึ่งยังทำหน้าที่ 'อย่าเสนอซ้ำ' ได้ครบ

หัวข้อ 'เปิดอยู่' เหลือ 4 ข้อที่ตรวจกับโค้ดจริงแล้วว่ายังเปิดอยู่ ทุกข้อมี check-id ให้
backlog.js ผูกการตรวจอัตโนมัติในแผนถัดไป และหัวข้อ 'ส่งต่อรอบหน้า' บังคับช่อง
'ให้ทำอะไร' ซึ่งเป็นช่องที่โน้ตเตือน superadmin ขาดไปจนอีกเครื่องทำอะไรไม่ได้

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: ย่อพิธีกรรมเปิดงานใน `MEMORY.md`

**Files:**
- Modify: `C:\Users\tairo\.claude\projects\Z--\memory\MEMORY.md` (**นอก git repo — ไม่มี commit**)

**Interfaces:**
- Consumes: `STATUS.md` รูปแบบใหม่จาก Task 2 (เพื่ออ้างชื่อหัวข้อให้ตรง)
- Produces: ไม่มีอะไรให้ task อื่นใช้

- [ ] **Step 1: วัดของเดิมไว้ก่อน**

```bash
wc -l "C:/Users/tairo/.claude/projects/Z--/memory/MEMORY.md"
```

จดเลขไว้ (ตอนวัด 2026-10-12 ได้ 77 บรรทัด / 12 KB)

- [ ] **Step 2: แทนที่หัวข้อ "⚠️ เปิด session ใหม่ — ทำ 2 ข้อนี้ก่อนตอบอะไร"**

หัวข้อเดิมชี้ไปไฟล์ยาวสองไฟล์ ⇒ ต้องเปิดอ่านก่อนพูดประโยคแรกทุกครั้ง เปลี่ยนเป็นเนื้อหาที่จบในตัวเอง

```markdown
## ⚠️ เปิด session ใหม่ — 6 บรรทัดนี้พอ ไม่ต้องเปิดไฟล์อื่นก่อนตอบ

1. **ประกาศตอนเรียก skill** เขียนบรรทัดภาษาไทยว่าเรียกตัวไหนเพื่ออะไร — ตอนเรียก ไม่ใช่ตอนสรุปจบ
   ถ้าไม่เรียกก็บอกว่าเพราะอะไร
2. **เครื่องนี้คือเครื่องไหน** ดูที่ windows user: `tairo` = ออฟฟิศ (worktree `C:\Users\tairo\ta-work`) ·
   `Teerawat` = บ้าน (worktree `C:\Users\Teerawat\ta-office`) — **ชื่อ worktree หลงยุค อย่าเดาจากชื่อ**
3. **ห้ามแก้ `Z:\Time_Attendance` ตรงๆ** นั่นคือเว็บจริง เซฟปุ๊บผู้ใช้เห็นปั๊บ — แก้ใน worktree เท่านั้น
   และขอสิทธิ์โฟลเดอร์ worktree เข้าเซสชันก่อนเขียนไฟล์แรก ไม่งั้นเจ้าของกดเปิดไฟล์จากแชตไม่ได้
4. **งานค้างอยู่ใน `Z:\Time_Attendance\STATUS.md`** ไม่ใช่ไฟล์นี้ — เรื่องที่ต้องส่งต่อรอบหน้าอยู่ใต้หัวข้อ
   `## ส่งต่อรอบหน้า` (ถัดไปคือ `## เปิดอยู่` และ `## ปิดแล้ว (สารบัญ)`; รายละเอียดของที่ปิดแล้วอยู่ใน
   `docs/STATUS_CLOSED.md`) — ห้ามตอบว่า "ไม่รู้ว่าอีกเครื่องค้างอะไร"
5. **ตรวจกับโค้ดจริงก่อนรายงานทุกครั้ง** `STATUS.md` บอกได้แค่ว่าเคยค้างอะไร
6. **สื่อสารภาษาไทย เล่าทุกขั้นตอน** และห้ามถือว่าเงียบ = อนุมัติ

รายละเอียดและที่มาของทั้ง 6 ข้ออยู่ในไฟล์ด้านล่าง — **อ่านเมื่อข้อนั้นมีปัญหา ไม่ใช่อ่านทุกครั้งที่เปิดเครื่อง**
```

> **แก้บล็อกด้านบน 2026-10-12 (รีวิวรอบสุดท้าย) ให้ตรงกับไฟล์ที่ส่งมอบจริง** สองจุด:
> ข้อ 5 เดิมสั่งให้เขียน "ไล่ตรวจด้วย `npm run backlog`" — **คำสั่งนั้นยังไม่มี** (ข้อเปิดอยู่
> `backlog-command`) commit `3eafdd4` ถอดประโยคเดียวกันออกจาก `STATUS.md` เพราะเป็นข้อความเท็จ
> ⇒ ไฟล์ที่ส่งมอบไม่มีมัน และแผนนี้ก็ไม่ควรสั่งให้ใส่กลับ · ข้อ 4 ของไฟล์ที่ส่งมอบบอกชื่อสามหัวข้อ
> ของ `STATUS.md` ด้วย (โครงเดิมในแผนไม่มี) ซึ่งเป็นสิ่งที่ทำให้ "เรื่องที่ส่งต่อรอบหน้าอยู่ที่ไหน"
> เดินทางไปถึงอีกเครื่องได้ · **ของจริงคือไฟล์ ไม่ใช่แผน** เทียบได้ที่
> `C:\Users\tairo\.claude\projects\Z--\memory\MEMORY.md`

- [ ] **Step 3: ตรวจว่ากฎของไฟล์นี้ไม่ถูกละเมิด**

```bash
grep -nE 'ยังไม่|ค้าง[^อ]|pending|NEXT SESSION|untested|[0-9]+ ไฟล์|[0-9]+ บรรทัด' "C:/Users/tairo/.claude/projects/Z--/memory/MEMORY.md"
```

คาดหวัง: ไม่มีผลลัพธ์จากบรรทัดที่เพิ่งเขียน (คำว่า "งานค้าง" ในข้อ 4 เป็นชื่อเรื่อง ไม่ใช่การอ้างสถานะ —
ถ้า grep จับ ให้ดูด้วยตาว่าเป็นการอ้างสถานะจริงไหม) · กฎที่หัวไฟล์ห้ามอ้างสถานะและห้ามใส่ตัวเลข
จำนวนไฟล์/บรรทัด เพราะไฟล์นี้เข้า context ก่อนที่จะมีโอกาสไปตรวจของจริง

- [ ] **Step 4: บอกเจ้าของหนึ่งบรรทัดว่าแก้ memory อะไรไว้**

ตามข้อตกลง 2026-10-12: Claude พูดเองหนึ่งบรรทัดในเทิร์นที่เขียน memory ว่าเขียนอะไร
(hook จะ push ให้เองเมื่อแผนที่ 2 เสร็จ — ก่อนหน้านั้นยังไม่มี hook ⇒ **รอบนี้ต้องรอเจ้าของสั่ง "จบงาน"**)

---

### Task 4: แก้ชื่อไฟล์เทสต์ในสเปกให้ตรงกับของจริง

**Files:**
- Modify: `docs/superpowers/specs/2026-10-12-faster-startup-and-cross-machine-state-design.md`

**Interfaces:**
- Consumes: ชื่อไฟล์จริงจาก Task 1 (`tests/status-structure.test.js`)
- Produces: สเปกที่อ้างชื่อไฟล์ถูก เพื่อให้แผนที่ 3 ไม่สร้างไฟล์ซ้ำชื่อผิด

- [ ] **Step 1: แก้ตารางการทดสอบในสเปก**

ในหัวข้อ "การทดสอบ" เปลี่ยนประโยคนำจาก `tests/backlog.test.js` เป็น

```markdown
`tests/status-structure.test.js` (ข้อ 1, 3, 4, 5 — รูปแบบเอกสาร ยืนได้เองไม่ต้องมี `backlog.js`)
และ `tests/backlog-registry.test.js` (ข้อ 2 — ต้องรอ registry ของ `backlog.js` จึงอยู่ในแผนที่ 3)
— เขียนแบบเทสต์ต้องแดงก่อน (TDD) ตามกฎโปรเจกต์ และต้องดัก **รูปแบบ** ของความผิดพลาด
ไม่ใช่เคสที่เจอวันนี้ (บทเรียนจาก `tests/dashboard-grid.test.js`)
```

- [ ] **Step 2: commit**

```bash
git add docs/superpowers/specs/2026-10-12-faster-startup-and-cross-machine-state-design.md
git commit -m "docs(spec): name the test files the way the code actually names them

สเปกเขียนไว้ว่า tests/backlog.test.js ตัวเดียว แต่การตรวจรูปแบบเอกสารยืนได้เองโดยไม่มี
backlog.js ส่วนการตรวจ check-id ต้องรอ registry ⇒ แยกเป็นสองไฟล์ตามของที่มันพึ่งพาจริง

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## แผนที่ 2 และ 3 — ยังไม่เขียน และตั้งใจไม่เขียนตอนนี้

| แผน | ครอบสเปกข้อ | ส่งมอบอะไรเองได้ |
|---|---|---|
| **แผนที่ 2 — กลไก sync** | 4, 5, 6, 9 | memory ขึ้น NAS เองโดยไม่ต้องสั่ง และเปิด session เร็วขึ้นจริง |
| **แผนที่ 3 — `backlog.js`** | 7, 8 | ไล่งานค้างได้ด้วยคำสั่งเดียวพร้อมหลักฐาน |

**ทำไมไม่เขียนทั้งสามแผนตอนนี้:** แผนที่ 3 ต้องอ้างชื่อ `check-id` และโครงหัวข้อที่ Task 2
เพิ่งสร้างขึ้นจริง ถ้าเขียนล่วงหน้าจะกลายเป็นแผนที่อ้างของที่ยังไม่มี แล้วต้องมาแก้ซ้ำ
⇒ เขียนแผนถัดไปหลังแผนนี้ผ่าน `npm run check` แล้ว

---

## Self-Review

**ความครอบคลุมเทียบสเปก:** ข้อ 1 → Task 2 · ข้อ 2 → Task 1 (เทสต์) + Task 2 (หัวข้อจริง) ·
ข้อ 3 → Task 3 · เกณฑ์รับ "ทุกข้อใน เปิดอยู่ มีบรรทัด `· ตรวจ:`" → Task 1 Step 1 + Task 2 Step 3 ·
เทสต์ข้อ 1, 3, 4, 5 ของสเปก → Task 1 · **ข้อ 4–9 ของสเปกไม่อยู่ในแผนนี้โดยเจตนา** (แผนที่ 2 และ 3)

**Placeholder:** วงเล็บ `(เติมชื่อหัวข้อจากไฟล์จริงตอนทำ Step 4)` ใน Task 2 Step 3 **ไม่ใช่
placeholder ที่ต้องลบ** — เป็นคำสั่งโดยเจตนาว่าห้ามเขียนชื่อหัวข้อจากความจำ ต้องคัดจาก
`grep` ของไฟล์จริง และ Step 4 กับเทสต์ข้อสุดท้ายบังคับว่าถ้าไม่เติมให้ตรง เทสต์จะแดง

**ความสอดคล้องของชื่อ:** `tests/status-structure.test.js` ใช้ชื่อเดียวกันทั้ง Task 1, 2, 4 ·
`docs/STATUS_CLOSED.md` ใช้ชื่อเดียวกันทั้ง Task 1 (เทสต์อ่าน) และ Task 2 (สร้าง) ·
`check-id` สี่ตัวที่ Task 2 ประกาศ ตรงกับที่เขียนไว้ในบล็อก Interfaces เพื่อให้แผนที่ 3 หยิบไปใช้ได้
