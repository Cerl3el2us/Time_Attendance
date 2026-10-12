# sync memory เองโดยไม่ต้องสั่ง และเปิด session ให้เร็วขึ้นจริง — Implementation Plan (แผนที่ 2 จาก 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ให้ memory ขึ้น NAS เองโดยไม่ต้องรอใครสั่ง และให้การเปิด session ไม่เสียเวลาไปกับการ hash ไฟล์ทั้งโฟลเดอร์ข้าม SMB

**Architecture:** แยก "ตัวตัดสินว่าต้อง push ไหม" ออกมาเป็นสคริปต์เล็กตัวเดียว (`sync_if_dirty.ps1`)
ที่อ่านแต่ดิสก์ในเครื่องแล้วออกทันทีถ้าไม่มีอะไรเปลี่ยน · hook สองตัว (`Stop`, `SessionEnd`) เรียกสคริปต์นั้น
⇒ ตรรกะที่ต้องทดสอบอยู่ในไฟล์เดียว ไม่ใช่กระจายอยู่ใน `settings.json` · ส่วนความเร็วของการเทียบไฟล์
แก้ที่ `Test-SameContent` ใน `sync_memory.ps1` ให้เทียบขนาด+เวลาก่อนแล้ว hash เฉพาะที่ต่าง

**Tech Stack:** Windows PowerShell 5.1 (`powershell.exe`) · Node.js สำหรับไฟล์เทสต์ (ไม่มี dependency ใหม่)
· ไฟล์ปลายทางอยู่บน NAS **นอก git repo ของโปรเจกต์**

## Global Constraints

- แก้โค้ดของโปรเจกต์ใน worktree `C:\Users\tairo\ta-work` branch `chore/memory-sync-automation` เท่านั้น · **ห้ามแก้ `Z:\Time_Attendance` ตรงๆ**
- ไฟล์สามตัวที่ต้องแก้ **อยู่นอก repo ของโปรเจกต์ และเป็นของจริงที่ทั้งสองเครื่องใช้ร่วมกันทันทีที่เซฟ**: `Z:\claude_memory\sync_memory.ps1` · `Z:\claude_memory\.gitignore` · `Z:\.claude\settings.json`
- **ต้องสำรองก่อนแก้ทุกไฟล์** ตามแบบที่โปรเจกต์นี้ใช้อยู่: `<ชื่อไฟล์>.bak-2026-10-12` (มีตัวอย่างแล้วคือ `settings.json.bak-2026-10-09`) · `Z:\claude_memory` เป็น git repo ⇒ commit สภาพก่อนแก้ด้วย
- **ห้ามทดสอบกับโฟลเดอร์ memory จริง** — ทดสอบด้วยโฟลเดอร์ชั่วคราวเสมอ · โฟลเดอร์ memory จริงของเครื่องนี้คือ `C:\Users\tairo\.claude\projects\Z--\memory` และ NAS คือ `Z:\claude_memory`
- `settings.json` คุมการเปิด session ของ **ทั้งสองเครื่อง** ⇒ ทุก hook ต้องมี `-NoProfile -NonInteractive -ExecutionPolicy Bypass` ตามคอมเมนต์ `_why_noprofile` ที่อยู่ในไฟล์นั้น (ไม่มี `-NoProfile` แล้ว banner จาก PowerShell profile จะปนเข้า output ของ hook และพังเฉพาะเครื่องนั้น = บั๊กที่ตามยากที่สุด)
- hook ต้อง **ไม่พิมพ์อะไรเข้า context ของ Claude** และต้อง `exit 0` แม้ NAS เข้าไม่ถึง
- งบเวลา: เทิร์นที่ memory ไม่เปลี่ยน ≤ **0.1 วิ** · เทิร์นที่เปลี่ยน ≤ **1 วิ** · เปิด session (pull) ≤ **1 วิ** บน LAN
- `-ProjectDir "Z:\"` **ต้องส่งทุกครั้ง** ห้ามพึ่ง default (`$PWD.Path`) — incident 2026-08-16: cwd ไหลไปโฟลเดอร์อื่น แล้ว push "สำเร็จ" พร้อมรายชื่อไฟล์ที่ดูน่าเชื่อ แต่ข้ามไฟล์จริงทั้งหมด
- ของเดิมใน `sync_memory.ps1` ที่ห้ามทำหาย: เทียบเนื้อหาก่อนเวลา · `-ge` (ไม่ใช่ `-gt`) · `-ErrorAction Stop` ทุกจุด · สำรองลง `.sync_backup\` ก่อนทับขา pull · ข้ามไฟล์ที่ปลายทางมีใน `archive\` แล้ว · **คำเตือนต้องพิมพ์ก่อนบรรทัดสรุป** และบรรทัดสุดท้ายต้องสรุปครบในตัวเอง เพราะ `session_start.ps1` หยิบบรรทัดสุดท้ายที่ไม่ว่างไปใส่ hook
- ปิดงานด้วย `node --check attendance/js/app.js` และ `npm run check` (ต้องได้ `36/36 test files passed` หลังเพิ่มไฟล์เทสต์ใหม่ 1 ไฟล์)

---

## File Structure

| ไฟล์ | หน้าที่ |
|---|---|
| `Z:\claude_memory\sync_memory.ps1` | **แก้** — `Test-SameContent` เทียบขนาด+เวลาก่อน hash · เพิ่ม `feedback_pending_task_format.md` เข้า `$Patterns` |
| `Z:\claude_memory\.gitignore` | **แก้** — เปิด whitelist ให้ไฟล์เดียวกัน (ต้องแก้คู่กัน ไม่งั้น sync ได้แต่ไม่มีประวัติ) + ลบคำอ้างที่ล้าสมัยเรื่องรหัสผ่าน |
| `Z:\claude_memory\sync_if_dirty.ps1` | **สร้างใหม่** — ตัวตัดสินว่าต้อง push ไหม อ่านแต่ดิสก์ในเครื่อง · เป็นที่เดียวที่มีตรรกะให้ทดสอบ |
| `Z:\.claude\settings.json` | **แก้** — เพิ่ม hook `Stop` และ `SessionEnd` เรียก `sync_if_dirty.ps1` |
| `C:\Users\tairo\ta-work\tests\memory-sync.test.js` | **สร้างใหม่** — เทสต์ตรรกะทั้งสองตัวด้วยโฟลเดอร์ชั่วคราว ผ่าน `powershell.exe` |

**ทำไมต้องมี `sync_if_dirty.ps1` แยก:** ถ้าเอาตรรกะ "เปลี่ยนหรือยัง" ไปใส่ใน `settings.json` เป็น one-liner
มันจะทดสอบไม่ได้เลย และพลาดแล้วพังทั้งสองเครื่อง · แยกเป็นไฟล์ ⇒ เทสต์ยิงตรงได้ และ hook เหลือแค่บรรทัดเรียก

---

### Task 1: เทสต์ที่ยังแดง สำหรับตรรกะทั้งสองตัว

**Files:**
- Create: `tests/memory-sync.test.js`

**Interfaces:**
- Consumes: ไม่มี
- Produces: สัญญาที่ Task 2 และ 3 ต้องทำให้ผ่าน —
  - `sync_if_dirty.ps1 -ProjectDir <dir> -MemoryDir <dir> -MarkerFile <file> -LogFile <file> -WhatIf`
    พิมพ์บรรทัดเดียวว่า `DIRTY <จำนวนไฟล์>` หรือ `CLEAN` แล้ว `exit 0` **โดยไม่ push**
  - ไม่มีหมุด (`-MarkerFile` ชี้ไฟล์ที่ยังไม่มี) ⇒ ถือว่า `DIRTY`
  - หมุดใหม่กว่าไฟล์ทุกไฟล์ ⇒ `CLEAN`
  - ไฟล์ใด ๆ ใน memory dir ใหม่กว่าหมุด ⇒ `DIRTY`
  - memory dir เข้าไม่ถึง ⇒ พิมพ์ `UNREACHABLE` และ `exit 0` (ห้าม throw ห้าม exit ไม่ใช่ศูนย์)
  - `Test-SameContent` ของ `sync_memory.ps1`: ขนาดต่าง ⇒ ต่าง **โดยไม่เรียก hash** · ขนาดเท่าและเวลาเท่าระดับ tick ⇒ เหมือน · ขนาดเท่าเวลาต่าง ⇒ ตัดสินด้วย hash

- [ ] **Step 1: เขียนไฟล์เทสต์**

สร้าง `tests/memory-sync.test.js` ตามโครงนี้ (รูปแบบเดียวกับ `tests/backup-bundle.test.js` ที่มี flag `--slow`):

```js
// The memory folder is how one machine tells the other what it learned. Two failures made this
// test necessary.
//
// 2026-10-12: opening a session spent 4.2s hashing 135 files across SMB before Claude could say
// anything, because Test-SameContent hashed both sides of every file -- while reading every file's
// size and timestamp in one directory listing costs 0.18s. The owner's complaint was the delay.
//
// The second failure is older and quieter: memory only reached the other machine when someone
// remembered to say "จบงาน". The fix is a hook, and a hook that misjudges "did anything change?"
// either pushes on every turn or never pushes at all -- so that judgement lives in one script with
// this test on it, not in a one-liner inside settings.json where nothing can reach it.
//
// Both scripts live on the NAS, outside this repo (Z:\claude_memory\). When Z: is not mapped these
// cases cannot run; they are reported as SKIPPED with a reason, never silently passed.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SYNC_DIR = 'Z:\\claude_memory';
const DIRTY_SCRIPT = path.join(SYNC_DIR, 'sync_if_dirty.ps1');
const SYNC_SCRIPT = path.join(SYNC_DIR, 'sync_memory.ps1');
const SLOW = process.argv.includes('--slow');

let passed = 0, skipped = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ', name); }
  catch (e) {
    if (e && e.skip) { skipped++; console.log('  SKIP', name, '-', e.message); return; }
    process.exitCode = 1; console.log('  FAIL', name, '\n       ', e.message);
  }
}
function skip(msg) { const e = new Error(msg); e.skip = true; throw e; }

function requireScript(p) {
  if (!fs.existsSync(p)) skip(`not reachable: ${p} (Z: not mapped?)`);
}

function ps(scriptPath, args) {
  const r = spawnSync('powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, ...args],
    { encoding: 'utf8', timeout: 60000 });
  return { code: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}

// A temp tree per case; never the real memory folder.
function tmp(name) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `memsync-${name}-`));
  return d;
}
function write(dir, file, body, mtime) {
  const p = path.join(dir, file);
  fs.writeFileSync(p, body, 'utf8');
  if (mtime) fs.utimesSync(p, mtime, mtime);
  return p;
}
```

ต่อด้วยเคสเหล่านี้ (ทุกเคสที่ต้องเรียก PowerShell ให้ห่อด้วย `if (!SLOW) skip('--slow only')`
เพราะการเรียก `powershell.exe` ครั้งละ ~0.3 วิ ทำให้ชุดเทสต์ปกติช้าลงโดยไม่จำเป็น):

```js
console.log('memory-sync:');

test('sync_if_dirty: no marker yet means dirty', () => {
  if (!SLOW) skip('--slow only');
  requireScript(DIRTY_SCRIPT);
  const mem = tmp('nomarker');
  write(mem, 'feedback_attendance_x.md', 'hello');
  const r = ps(DIRTY_SCRIPT, ['-ProjectDir', 'Z:\\', '-MemoryDir', mem,
    '-MarkerFile', path.join(mem, '..', 'no-such-marker'), '-LogFile', path.join(mem, 'sync.log'), '-WhatIf']);
  if (r.code !== 0) throw new Error(`exit ${r.code}: ${r.err}`);
  if (!/^DIRTY \d+$/m.test(r.out)) throw new Error(`expected DIRTY <n>, got: ${r.out}`);
});

test('sync_if_dirty: marker newer than every file means clean', () => {
  if (!SLOW) skip('--slow only');
  requireScript(DIRTY_SCRIPT);
  const mem = tmp('clean');
  const past = new Date(Date.now() - 60000) / 1000;
  write(mem, 'feedback_attendance_x.md', 'hello', past);
  const marker = write(mem, '.marker', '');            // written now, so newer
  const r = ps(DIRTY_SCRIPT, ['-ProjectDir', 'Z:\\', '-MemoryDir', mem,
    '-MarkerFile', marker, '-LogFile', path.join(mem, 'sync.log'), '-WhatIf']);
  if (r.out !== 'CLEAN') throw new Error(`expected CLEAN, got: ${r.out}`);
});

test('sync_if_dirty: one file newer than the marker means dirty', () => {
  if (!SLOW) skip('--slow only');
  requireScript(DIRTY_SCRIPT);
  const mem = tmp('dirty');
  const marker = write(mem, '.marker', '', new Date(Date.now() - 60000) / 1000);
  write(mem, 'feedback_attendance_x.md', 'changed');   // now
  const r = ps(DIRTY_SCRIPT, ['-ProjectDir', 'Z:\\', '-MemoryDir', mem,
    '-MarkerFile', marker, '-LogFile', path.join(mem, 'sync.log'), '-WhatIf']);
  if (!/^DIRTY 1$/m.test(r.out)) throw new Error(`expected DIRTY 1, got: ${r.out}`);
});

test('sync_if_dirty: an unreachable memory folder exits 0 and says so', () => {
  if (!SLOW) skip('--slow only');
  requireScript(DIRTY_SCRIPT);
  const r = ps(DIRTY_SCRIPT, ['-ProjectDir', 'Z:\\', '-MemoryDir', 'Q:\\nope\\nothing',
    '-MarkerFile', 'Q:\\nope\\marker', '-LogFile', 'Q:\\nope\\sync.log', '-WhatIf']);
  if (r.code !== 0) throw new Error(`a hook must never fail the session: exit ${r.code}`);
  if (r.out !== 'UNREACHABLE') throw new Error(`expected UNREACHABLE, got: ${r.out}`);
});

test('sync_if_dirty: -WhatIf never writes the marker', () => {
  if (!SLOW) skip('--slow only');
  requireScript(DIRTY_SCRIPT);
  const mem = tmp('whatif');
  write(mem, 'feedback_attendance_x.md', 'hello');
  const marker = path.join(mem, '.marker');
  ps(DIRTY_SCRIPT, ['-ProjectDir', 'Z:\\', '-MemoryDir', mem, '-MarkerFile', marker,
    '-LogFile', path.join(mem, 'sync.log'), '-WhatIf']);
  if (fs.existsSync(marker)) throw new Error('-WhatIf wrote the marker; a dry run must not change state');
});

test('sync_memory.ps1: $Patterns covers the pending-task-format note', () => {
  requireScript(SYNC_SCRIPT);
  const src = fs.readFileSync(SYNC_SCRIPT, 'utf8');
  const block = src.slice(src.indexOf('$Patterns'), src.indexOf('$Patterns') + 400);
  if (!block.includes('feedback_pending_task_format.md')) {
    throw new Error('the owner instruction in that file has never synced into this project');
  }
});

test('.gitignore whitelists the same file as $Patterns', () => {
  const gi = path.join(SYNC_DIR, '.gitignore');
  requireScript(gi);
  const txt = fs.readFileSync(gi, 'utf8');
  if (!txt.includes('feedback_pending_task_format.md')) {
    throw new Error('synced but no git history, or the reverse -- these two must be edited together');
  }
});

console.log(`memory-sync: ${passed} passed, ${skipped} skipped`);
```

- [ ] **Step 2: รันให้เห็นว่าแดง**

```bash
node tests/memory-sync.test.js --slow
```

คาดหวัง: เคส `sync_if_dirty` ทุกเคส **SKIP** พร้อมเหตุผล `not reachable: Z:\claude_memory\sync_if_dirty.ps1`
(เพราะยังไม่ได้สร้าง) และ **สองเคสสุดท้าย FAIL** เพราะยังไม่ได้แก้ `$Patterns` กับ `.gitignore`

ถ้าสองเคสสุดท้าย **ผ่าน** ให้หยุด: แปลว่าอ่านไฟล์ผิดตัว ไม่ใช่ว่าแก้ไปแล้ว

- [ ] **Step 3: commit**

```bash
git add tests/memory-sync.test.js package.json
git commit -m "test(sync): pin the two judgements that decide whether memory ever leaves this machine

เทสต์แดงไว้ก่อนสองเรื่อง: ตัวตัดสิน 'เปลี่ยนหรือยัง' ที่ hook จะเรียก (ยังไม่มีไฟล์)
และ \$Patterns กับ .gitignore ที่ยังไม่รับ feedback_pending_task_format.md ซึ่งเป็นเหตุผลที่
คำสั่งของเจ้าของเรื่องรูปแบบตารางงานค้าง ไม่เคย sync เข้าโปรเจกต์นี้เลย

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

เพิ่ม script ใน `package.json` ด้วย: `"test:sync": "node tests/memory-sync.test.js --slow"`
(เข้าชุดกับ `test:backup` ที่มีอยู่) และต้องแน่ใจว่า `npm test` ยังเรียกไฟล์นี้แบบไม่ `--slow` ได้

---

### Task 2: อุด `$Patterns` และเร่ง `Test-SameContent`

**Files:**
- Modify: `Z:\claude_memory\sync_memory.ps1` (บรรทัด 34 `$Patterns`, และ `Test-SameContent` ~บรรทัด 90)
- Modify: `Z:\claude_memory\.gitignore`
- Test: `tests/memory-sync.test.js` (จาก Task 1 ไม่แก้)

**Interfaces:**
- Consumes: สัญญาจาก Task 1
- Produces: `sync_memory.ps1` ที่เร็วพอให้ Task 3 เรียกได้ทุกเทิร์น

- [ ] **Step 1: สำรองก่อนแตะ**

```bash
cp "/z/claude_memory/sync_memory.ps1" "/z/claude_memory/sync_memory.ps1.bak-2026-10-12"
cp "/z/claude_memory/.gitignore"      "/z/claude_memory/.gitignore.bak-2026-10-12"
git -C /z/claude_memory add -A && git -C /z/claude_memory commit -q -m "chore: snapshot before the 2026-10-12 sync speedup" || echo "(ไม่มีอะไรให้ commit)"
git -C /z/claude_memory log --oneline -1
```

- [ ] **Step 2: เพิ่ม pattern ทั้งสองที่**

ใน `$Patterns` ของ `sync_memory.ps1` เพิ่มรายการ `'feedback_pending_task_format.md'`
พร้อมคอมเมนต์บรรทัดเดียวว่าทำไม (คำสั่งของเจ้าของเรื่องรูปแบบตาราง `ขนาด | งาน` อยู่ในไฟล์นี้
และชื่อไม่เข้า pattern เดิมทั้งสองอัน จึงไม่เคยเข้าโปรเจกต์นี้ — พบ 2026-10-12)

ใน `.gitignore` เพิ่ม `!feedback_pending_task_format.md` ไว้กลุ่มเดียวกับ `!project_time_attendance*.md`

**และแก้คำอ้างที่ล้าสมัยในคอมเมนต์ของ `.gitignore`**: บล็อกคำเตือนบอกว่ารหัส NAS ยังอยู่ในไฟล์
`.md` ที่ whitelist ปล่อยผ่าน "4 ไฟล์ 5 บรรทัด" และ "แจ้งเจ้าของแล้ว รอการตัดสินใจ" — ของจริงคือ
**5 ไฟล์ 6 ครั้ง** และถูกล้างออกทั้งไฟล์และประวัติไปแล้วเมื่อ 2026-10-11 (ยืนยันด้วยการสแกน 152
ออบเจกต์) สิ่งที่ยังค้างคือการเปลี่ยนรหัสที่ DSM ซึ่งเป็นงานของเจ้าของ · เขียนให้ตรงกับความจริงวันนี้
และคงข้อความที่ยังจริงไว้ คือการแก้จริงคือเปลี่ยนรหัส ไม่ใช่แก้ไฟล์นี้

- [ ] **Step 3: รันสองเคสท้ายของเทสต์ให้เขียว**

```bash
node tests/memory-sync.test.js --slow
```

คาดหวัง: สองเคสท้าย `ok` · เคส `sync_if_dirty` ยัง `SKIP` (Task 3 สร้างไฟล์นั้น)

- [ ] **Step 4: เร่ง `Test-SameContent`**

เปลี่ยนให้ตัดสินสามชั้น ตามลำดับนี้ และ **คงพฤติกรรม "อ่านไม่ได้ ⇒ คืน `$null` และผู้เรียกถือเป็น conflict" ไว้เหมือนเดิม**

```powershell
function Test-SameContent {
  param([string]$A, [string]$B)
  # คืน $true/$false ตามปกติ และคืน $null เมื่อ "อ่านไม่ได้" ซึ่งผู้เรียกต้องถือเป็น conflict
  #
  # 2026-10-12: เดิมฟังก์ชันนี้ hash ทั้งสองฝั่งทุกไฟล์ = 4.2 วินาทีทุกครั้งที่เปิด session
  # (วัดบน LAN: hash 57 ไฟล์ 1.96 วิ + archive 78 ไฟล์ 2.28 วิ) ขณะที่การอ่านขนาดและเวลา
  # ทั้งโฟลเดอร์ทีเดียวใช้ 0.18 วิ · บน VPN ประเมินไว้ 40-100 วิ ซึ่งชน timeout 120 วิของ hook
  # รีวิว 2026-10-08 สั่งเรื่องนี้ไว้แล้วแต่ไม่เคยถูกทำ จึงยังจ่ายอยู่ทุกวันจนถึงวันนี้
  try {
    $fa = Get-Item -LiteralPath $A -ErrorAction Stop
    $fb = Get-Item -LiteralPath $B -ErrorAction Stop
  } catch { return $null }

  # 1. ขนาดต่าง = ต่างแน่ ไม่ต้อง hash
  if ($fa.Length -ne $fb.Length) { return $false }

  # 2. ขนาดเท่าและเวลาเท่าถึงระดับ tick = ถือว่าเหมือน
  #    เทียบที่ระดับ tick ไม่ใช่วินาที เพราะ Copy-Item รักษา mtime ของต้นทาง ⇒ หลัง sync
  #    สองฝั่งมี stamp ตรงกันเป๊ะ ซึ่งคือเคสที่พบมากที่สุดและเป็นเคสที่เนื้อหาเหมือนกันจริง
  #    ข้อแลกเปลี่ยนที่ยอมรับแล้ว: ไฟล์ที่ถูกแก้แล้วได้ขนาดเท่าเดิม *และ* tick ตรงกันพอดี
  #    จะถูกมองว่าเหมือน · ตาข่ายรองคือ .sync_backup\ ฝั่งเครื่อง และ git บน NAS
  if ($fa.LastWriteTimeUtc.Ticks -eq $fb.LastWriteTimeUtc.Ticks) { return $true }

  # 3. ขนาดเท่าแต่เวลาต่าง = เคสเดียวที่ยังต้อง hash
  try {
    $ha = (Get-FileHash -LiteralPath $A -Algorithm SHA256 -ErrorAction Stop).Hash
    $hb = (Get-FileHash -LiteralPath $B -Algorithm SHA256 -ErrorAction Stop).Hash
    return ($ha -eq $hb)
  } catch { return $null }
}
```

- [ ] **Step 5: วัดว่าเร็วขึ้นจริง และ pull ยังทำงานถูก**

```powershell
$t = Measure-Command { & 'Z:\claude_memory\sync_memory.ps1' pull -ProjectDir 'Z:\' }
"pull: $([math]::Round($t.TotalSeconds,2)) วินาที"
```

คาดหวัง: **≤ 1 วินาที** (ของเดิม ~4.2) และบรรทัดสรุปสุดท้ายยังอ่านรู้เรื่องในตัวเอง
· ถ้าเกิน 1 วิ ให้รายงานตัวเลขจริงไว้ ห้ามแก้เกณฑ์เงียบๆ

**แล้วพิสูจน์ว่ายังตัดสินถูก** ด้วยโฟลเดอร์ชั่วคราวสองโฟลเดอร์ (ห้ามใช้ของจริง): ไฟล์เนื้อหาเดียวกัน
ขนาดเท่าเวลาเท่า ⇒ รายงานว่าเหมือน · ไฟล์ขนาดต่าง ⇒ ก๊อป · ไฟล์ขนาดเท่าเนื้อหาต่างและเวลาต่าง ⇒
ก๊อปหรือเตือนตามกฎเดิม · ปลายทางใหม่กว่า ⇒ **ไม่ทับ และเตือนพร้อมชื่อไฟล์** · ใส่ผลทั้งหมดในรายงาน

- [ ] **Step 6: commit**

```bash
git -C /z/claude_memory add -A && git -C /z/claude_memory commit -q -m "perf(sync): compare size and timestamp before hashing, and let one owner instruction through

ทุกครั้งที่เปิด session จ่าย 4.2 วินาทีไปกับการ hash 135 ไฟล์ข้าม SMB ทั้งที่อ่านขนาด+เวลา
ทั้งโฟลเดอร์ทีเดียวใช้ 0.18 วินาที · รีวิว 2026-10-08 สั่งไว้แล้วแต่ไม่เคยถูกทำ

และ feedback_pending_task_format.md ไม่เข้า \$Patterns ทั้งสองอัน จึงไม่เคยเข้าโปรเจกต์นี้
= กับดักชื่อไม่ตรง pattern ครั้งที่สี่ คราวนี้กินคำสั่งของเจ้าของเอง"
cd /c/Users/tairo/ta-work && git commit -am "chore(sync): record the speedup and the pattern fix" --allow-empty -m "ไฟล์ที่แก้อยู่บน NAS นอก repo นี้ commit นี้มีไว้ให้ประวัติของโปรเจกต์ชี้ไปถึง"
```

---

### Task 3: `sync_if_dirty.ps1` และ hook สองตัว

**Files:**
- Create: `Z:\claude_memory\sync_if_dirty.ps1`
- Modify: `Z:\.claude\settings.json`
- Test: `tests/memory-sync.test.js` (จาก Task 1 ไม่แก้)

**Interfaces:**
- Consumes: `sync_memory.ps1` ที่เร่งแล้วจาก Task 2 · สัญญาพารามิเตอร์จาก Task 1
- Produces: hook ที่ทำงานบนทั้งสองเครื่องผ่าน `Z:\.claude\settings.json`

- [ ] **Step 1: เขียน `sync_if_dirty.ps1`**

ข้อกำหนด (เขียนคอมเมนต์หัวไฟล์เป็นภาษาไทยอธิบายว่าทำไมมีไฟล์นี้):

1. พารามิเตอร์: `-ProjectDir` (บังคับ) · `-MemoryDir` · `-MarkerFile` · `-LogFile` · `-WhatIf` (switch)
   · ค่า default ของสามตัวกลางให้คำนวณจาก `-ProjectDir` แบบเดียวกับที่ `sync_memory.ps1` ทำ
   (`Z:\` ⇒ `...\projects\Z--\memory`, **สองขีด**) และวางหมุดไว้ **นอก** โฟลเดอร์ memory
   (`...\projects\Z--\.sync_marker`) เพื่อไม่ให้ไปโผล่ในรายงานของแผนที่ 3
2. ถ้า `-MemoryDir` เข้าไม่ถึง ⇒ พิมพ์ `UNREACHABLE` แล้ว `exit 0`
3. อ่าน `Get-ChildItem` ครั้งเดียวทั้งโฟลเดอร์ (รวม `archive\`) เทียบ `LastWriteTimeUtc` กับหมุด
   · ไม่มีหมุด ⇒ ถือว่า dirty ทั้งหมด
4. ไม่มีอะไรใหม่กว่าหมุด ⇒ พิมพ์ `CLEAN` แล้ว `exit 0` **ห้ามแตะ NAS เลยในเส้นทางนี้**
5. มีของใหม่ ⇒ ถ้า `-WhatIf` พิมพ์ `DIRTY <n>` แล้วออกโดยไม่ทำอะไรต่อและ **ไม่เขียนหมุด** ·
   ถ้าไม่ใช่ `-WhatIf` ให้เรียก `sync_memory.ps1 push -ProjectDir <ProjectDir>` แล้ว **เขียนหมุดใหม่
   เฉพาะเมื่อ push สำเร็จ** (ถ้าล้มเหลวต้องปล่อยหมุดเดิมไว้ ไม่งั้นงานที่ยังไม่ขึ้นจะถูกลืม)
6. เขียน log ต่อท้าย `-LogFile` หนึ่งบรรทัดต่อครั้ง: เวลา ISO · ผลลัพธ์ · จำนวนไฟล์ · และถ้า push
   รายงานว่ามีไฟล์ชนกันไหมพร้อมชื่อ (ข้อมูลนี้คือสิ่งที่แผนที่ 3 จะเอาไปแสดง)
7. **ห้ามพิมพ์อะไรนอกจากบรรทัดสถานะเดียว** และต้อง `exit 0` ทุกเส้นทาง รวมทั้งเมื่อ push ล้มเหลว
   (hook ที่ exit ไม่ใช่ศูนย์จะไปรบกวนเซสชันของเจ้าของ)

- [ ] **Step 2: รันเทสต์ให้เขียวทั้งไฟล์**

```bash
node tests/memory-sync.test.js --slow
```

คาดหวัง: ทุกเคส `ok` ไม่มี SKIP (เพราะ Z: map อยู่บนเครื่องนี้) · ถ้าเคสไหนยัง SKIP ให้บอกว่าเคสไหนและเพราะอะไร

- [ ] **Step 3: วัดต้นทุนเส้นทาง CLEAN ซึ่งจะวิ่งทุกเทิร์น**

```powershell
$t = Measure-Command { & 'Z:\claude_memory\sync_if_dirty.ps1' -ProjectDir 'Z:\' -WhatIf }
"CLEAN path: $([math]::Round($t.TotalSeconds,3)) วินาที"
```

คาดหวัง: **≤ 0.1 วินาที** ไม่นับเวลาเริ่ม `powershell.exe` เอง · รายงานตัวเลขจริง
ถ้าเกิน ให้หาสาเหตุก่อนไปต่อ — ตัวเลขนี้คือเหตุผลเดียวที่ hook ตัวนี้ยอมให้วิ่งทุกเทิร์น

- [ ] **Step 4: สำรอง `settings.json` แล้วเพิ่ม hook**

```bash
cp "/z/.claude/settings.json" "/z/.claude/settings.json.bak-2026-10-12"
```

เพิ่มสองบล็อกนี้เข้า `hooks` (คงของเดิมทั้ง `SessionStart` และ `UserPromptSubmit` ไว้ครบ)

```json
"Stop": [
  {
    "hooks": [
      {
        "type": "command",
        "command": "powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File \"Z:/claude_memory/sync_if_dirty.ps1\" -ProjectDir \"Z:\\\"",
        "timeout": 20
      }
    ]
  }
],
"SessionEnd": [
  {
    "hooks": [
      {
        "type": "command",
        "command": "powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File \"Z:/claude_memory/sync_if_dirty.ps1\" -ProjectDir \"Z:\\\"",
        "timeout": 60
      }
    ]
  }
]
```

`SessionEnd` ต้องตั้ง `timeout` เอง เพราะงบเริ่มต้นของมันคือ 1.5 วินาที (ขยายได้ถึง 60)
· `Stop` ตั้ง 20 ก็พอเพราะเส้นทางปกติคือ CLEAN แล้วออกทันที

- [ ] **Step 5: พิสูจน์ว่า JSON ยังใช้ได้ และของเดิมไม่หาย**

```powershell
$j = Get-Content 'Z:\.claude\settings.json' -Raw | ConvertFrom-Json
"SessionStart: $($j.hooks.SessionStart.Count) · UserPromptSubmit: $($j.hooks.UserPromptSubmit.Count) · Stop: $($j.hooks.Stop.Count) · SessionEnd: $($j.hooks.SessionEnd.Count)"
$j.hooks.PSObject.Properties.Name
```

คาดหวัง: ได้ 1 ทั้งสี่ตัว และเห็นชื่อ hook ครบสี่ · ถ้า `ConvertFrom-Json` พัง **ให้คืนไฟล์จาก
`.bak-2026-10-12` ทันที** เพราะไฟล์นี้คุมการเปิด session ของทั้งสองเครื่อง

- [ ] **Step 6: ทดสอบ hook ของจริงแบบปลอดภัย**

แก้ไฟล์ memory ของจริงหนึ่งไฟล์แบบไม่มีผล (เช่นเติมบรรทัดว่างท้ายไฟล์แล้วลบออก ให้ mtime ขยับ)
แล้วรัน `sync_if_dirty.ps1 -ProjectDir "Z:\"` ด้วยมือหนึ่งครั้ง (ไม่ใส่ `-WhatIf`) จากนั้น

```bash
tail -3 /z/claude_memory/sync.log
ls -la "C:/Users/tairo/.claude/projects/Z--/.sync_marker"
```

คาดหวัง: log มีบรรทัดใหม่ · หมุดถูกสร้าง · และ **ไฟล์ที่แก้ขึ้น NAS จริง** (ไล่เช็คชื่อไฟล์ด้วย
`ls /z/claude_memory | grep <ชิ้นส่วนของชื่อ>` — ผลลัพธ์ที่ดูสะอาดไม่ใช่หลักฐาน, incident 2026-08-16)

- [ ] **Step 7: commit**

```bash
git -C /z/claude_memory add -A && git -C /z/claude_memory commit -q -m "feat(sync): push memory when it changes, without anyone remembering to ask"
cd /c/Users/tairo/ta-work && git commit -am "test(sync): the hook path is green, with the measured cost of the clean path"
```

---

### Task 4: ลบ `session_handoff.md` ที่ตายแล้ว

**Files:**
- Delete: `Z:\claude_memory\session_handoff.md`

**Interfaces:**
- Consumes: ไม่มี
- Produces: ไม่มี

- [ ] **Step 1: ยืนยันว่าตายจริงก่อนลบ**

```bash
head -20 /z/claude_memory/session_handoff.md
grep -rln "session_handoff" /z/claude_memory --include=*.md | grep -v session_handoff.md
grep -rln "session_handoff" /c/Users/tairo/ta-work --include=*.md
ls "C:/Users/tairo/.claude/projects/Z--/memory/session_handoff.md" 2>/dev/null || echo "ไม่มีสำเนาในเครื่อง (ตรวจแล้ว 2026-10-12)"
```

คาดหวัง: เนื้อหาเป็นของ 2026-07-03 ยุค `E:\claude\` · **ไม่มีไฟล์อื่นอ้างถึงมัน** · ไม่มีสำเนาในเครื่องนี้
ถ้ามีไฟล์อื่นอ้างถึง **ให้หยุดและรายงาน** อย่าลบ

- [ ] **Step 2: ลบผ่าน git เพื่อให้ย้อนดูได้**

ไฟล์นี้ไม่เข้า `$Patterns` และไม่เข้า whitelist ของ `.gitignore` ⇒ ไม่เคยอยู่ใน git เลย
⇒ `git rm` จะไม่ทำงาน ให้ลบด้วย `rm` ธรรมดา **แต่ต้องเก็บสำเนาไว้ก่อน**

```bash
cp /z/claude_memory/session_handoff.md /z/claude_memory/session_handoff.md.deleted-2026-10-12
rm /z/claude_memory/session_handoff.md
ls /z/claude_memory/session_handoff* 2>/dev/null
```

เหตุผลที่เก็บสำเนาไว้แทนการลบทิ้งเลย: เจ้าของอนุมัติให้ลบ แต่สคริปต์ sync ไม่เคยลบไฟล์
⇒ ถ้าอีกเครื่องมีสำเนาและ push ขึ้นมา ไฟล์จะกลับมาเอง · สำเนาที่ตั้งชื่อชัดทำให้รู้ว่าเกิดอะไรขึ้น
และไม่เข้า pattern ใด ๆ จึงไม่เดินทางไปไหน

- [ ] **Step 3: บันทึกว่าอีกเครื่องต้องทำอะไร**

เพิ่มข้อใน `## ส่งต่อรอบหน้า` ของ `STATUS.md` (ครบ 4 ช่อง) ว่าเครื่องบ้าน (`Teerawat`) ต้องลบ
สำเนาของตัวเองด้วย ไม่งั้น sync ครั้งถัดไปจะดันไฟล์กลับขึ้น NAS · `STATUS.md` มีลิมิต 150 บรรทัด
และรูปแบบถูกบังคับด้วย `tests/status-structure.test.js` ⇒ รันเทสต์นั้นหลังแก้

- [ ] **Step 4: commit**

```bash
cd /c/Users/tairo/ta-work && npm run check 2>&1 | tail -2
git commit -am "docs(status): hand the other machine the one deletion it has to repeat"
```

---

## Self-Review

**ความครอบคลุมเทียบสเปก:** ข้อ 4 (`$Patterns` + `.gitignore`) → Task 2 · ข้อ 5 (เร่งการเทียบไฟล์)
→ Task 2 Step 4-5 · ข้อ 6 (hook `Stop`/`SessionEnd` + `sync.log` + งบเวลา) → Task 3 ·
ข้อ 9 (ลบ `session_handoff.md`) → Task 4 · **ข้อ 7-8 (`backlog.js`) ไม่อยู่ในแผนนี้โดยเจตนา** = แผนที่ 3

**Placeholder:** ไม่มี · ทุกสเต็ปมีคำสั่งจริงและผลที่คาดหวังจริง

**ความสอดคล้องของชื่อ:** `sync_if_dirty.ps1` · พารามิเตอร์ `-ProjectDir/-MemoryDir/-MarkerFile/-LogFile/-WhatIf`
· หมุด `C:\Users\<user>\.claude\projects\Z--\.sync_marker` · log `Z:\claude_memory\sync.log`
· ใช้ชื่อเดียวกันทั้ง Task 1 (เทสต์), Task 3 (ของจริง) และแผนที่ 3 (ตัวอ่าน log)

**ความเสี่ยงที่ยอมรับและทางถอย:** `settings.json` และ `sync_memory.ps1` มี `.bak-2026-10-12` และ
`Z:\claude_memory` เป็น git repo ⇒ คืนสภาพได้ทั้งสองไฟล์ · ถ้า `Stop` hook ทำให้ทุกเทิร์นช้า
ให้ลบบล็อก `Stop` ออกเหลือ `SessionEnd` ตัวเดียว ซึ่งยังได้ประโยชน์หลักไว้
