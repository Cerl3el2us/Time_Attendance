// สคริปต์ deploy ต้องสตาร์ต backend เป็น root เหมือนที่ NAS ทำเอง (2026-11-02 เจ้าของสั่งให้แก้)
//
// อาการที่เคยเกิด: 2026-11-02 บ่าย รีสตาร์ตผ่านสคริปต์นี้แล้ว **ทั้งเว็บตอบ 503** พนักงานทุกคน
// ล็อกอินไม่ได้ และทุกหน้าว่างเปล่าเหมือนข้อมูลหายหมด · ไม่เกี่ยวกับโค้ดที่ deploy วันนั้นเลย
// จะ deploy อะไรก็เกิดเหมือนกัน
//
// ต้นเหตุ: backend มีเจ้าของได้สองแบบ แล้วแต่ว่าใครรีสตาร์ตล่าสุด
//   · `/usr/local/etc/rc.d/attendance-autostart.sh` ทั้งตอนบูตและทุกครั้งที่ watchdog ของมัน
//     (วนเช็กทุก 5 นาที) เห็นว่า backend ล้ม จะเรียก `start_backend()` ที่ **ไม่มี su/sudo -u**
//     และ rc.d รันเป็น root ⇒ ได้โปรเซส **root**
//   · สคริปต์นี้ฆ่าตัวเก่าด้วย sudo แต่สตาร์ตตัวใหม่ด้วยบัญชี SSH ⇒ ได้โปรเซส **Teerawat**
// สองอย่างนี้แทนกันไม่ได้ เพราะความไม่สมมาตรไปทางเดียว: root อ่านไฟล์ของ Teerawat ได้ แต่ Teerawat
// อ่านไฟล์ 0600 ของ root ไม่ได้ ⇒ วันนั้นมีไฟล์ 0600 สี่ตัวเป็นของ root อยู่ `readUsers()` คืน null
// แล้วทุกเส้นทางตอบ 503
//
// ยามนี้อ่าน "ตัวอักษรในสคริปต์" ไม่ได้รันมัน — มันเป็น Python ที่ต้อง SSH เข้า NAS จริงจึงจะทำงาน
// ⇒ รันในเทสต์ไม่ได้โดยไม่แตะเครื่องจริง · สิ่งที่ยามนี้กันได้คือการ "แก้กลับ" ให้สตาร์ตแบบไม่ sudo
// ซึ่งเป็นสิ่งเดียวที่เคยทำเว็บล่ม · การพิสูจน์ว่ามันสตาร์ตเป็น root จริงทำโดยรันสคริปต์กับ NAS
// (2026-11-02: ได้ `[OK] running as root` + health 200 + ล็อกอินจริง 200)
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'attendance-server/scripts/deploy/deploy_backend.py'), 'utf8');
// ตัดคอมเมนต์บรรทัดทิ้งก่อน: คำอธิบายเหนือโค้ดพูดถึงทั้งวิธีเก่าและวิธีใหม่ ถ้าอ่านคอมเมนต์เป็นโค้ด
// ยามจะรายงานผิดทันที (เคยพลาดแบบนี้มาแล้ว 3 รอบในวันเดียวกัน)
const CODE = SRC.split('\n').filter(l => !l.trim().startsWith('#')).join('\n');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ', name); }
  catch (e) { process.exitCode = 1; console.log('  FAIL', name, '\n      ', e.message); }
}

console.log('deploy: the backend is started as root');

test('the start goes through run_sudo(), not a plain run()', () => {
  assert.ok(/started\s*=\s*run_sudo\(/.test(CODE),
    'the start must use run_sudo() -- a plain run() starts it as the SSH account, which cannot read '
    + 'a root-owned 0600 file in backend/data and makes every route answer 503');
  assert.ok(!/started\s*=\s*run\(/.test(CODE), 'the non-sudo start is back');
});

test('the start command still carries the same working directory, HOME, stdio and env prefix', () => {
  const m = CODE.match(/start_sh\s*=\s*\(([\s\S]*?)\)\nstarted/);
  assert.ok(m, 'start_sh is not built where this guard expects it');
  const built = m[1];
  ['cd "/volume1/web/Time_Attendance/attendance-server/backend"',
   'HOME="/volume1/web/Time_Attendance/attendance-server"',
   'server.js', 'server.log', '< /dev/null'].forEach(bit =>
    assert.ok(built.includes(bit), `the start command no longer contains: ${bit}`));
  assert.ok(built.includes('env_prefix'), 'SUPERADMIN_PASSWORD would stop being passed through');
});

// 2026-11-05 (ตามขั้นต่อไปที่เขียนไว้ใน STATUS.md หลังการวัดรอบ 17:04 ของ 2026-11-03):
// สคริปต์นี้สตาร์ต backend ไม่สำเร็จเลยตั้งแต่ 530e03a — ทุกครั้งที่รัน ตัวเฝ้า rc.d เป็นคนกู้ให้
// ภายใน 5 นาที (หลักฐาน: `backend down, restarting` เพิ่มใน watchdog.log ทุกรอบ)
// สิ่งที่ถูกตัดออกด้วยการวัดบน NAS จริงแล้ว: กลไกปล่อยงานของ run_sudo (`sleep` ที่ background ใต้
// sudo+PTY รอดทั้ง 4 แบบ) · node เอง (`node --version` ใต้ sudo ด้วย cd/HOME/env เดียวกัน เขียนผลได้) ·
// env_prefix · การเขียนต่อท้าย server.log · สิทธิ์ไฟล์ (777 ทั้งคู่)
// หลักฐานชี้ขาด: สตาร์ตด้วย `sudo sh -c 'cd … && HOME=… exec node server.js'` **แบบไม่ nohup ไม่ &**
// ขึ้นปกติ พิมพ์ `[HTTP] port 3000` / `[HTTPS] port 3443 ready` และโปรเซสรอดหลังปิดช่อง SSH
// ⇒ ข้อแตกต่างเดียวที่เหลือระหว่างแบบที่ได้ผลกับแบบที่ไม่ได้ผลคือการ background (`&`) เอง
// ยามนี้จึงกันการ "แก้กลับ" ไปใส่ nohup/setsid/`&` ซึ่งเป็นสิ่งเดียวที่วัดแล้วว่าทำให้สตาร์ตไม่ขึ้น
test('node is started in the foreground: no nohup, no setsid, no backgrounding &', () => {
  const m = CODE.match(/start_sh\s*=\s*\(([\s\S]*?)\)\nstarted/);
  assert.ok(m, 'start_sh is not built where this guard expects it');
  const built = m[1];
  ['nohup', 'setsid'].forEach(bit =>
    assert.ok(!built.includes(bit),
      `the start command puts \`${bit}\` back -- measured on the NAS as the one shape that never `
      + 'starts, while the plain foreground `exec` starts and survives the channel closing'));
  // `2>&1` และตัวเชื่อม `&&` ก็มี & เหมือนกัน เอาสองอย่างนั้นออกก่อน แล้วค่อยดูว่ามี `&` ที่เป็น
  // การ background เหลืออยู่ไหม — ยามรุ่นแรกของข้อนี้ลืมตัด `&&` แล้วรายงานโค้ดที่ถูกว่าผิด
  assert.ok(!built.replace(/2>&1/g, '').replace(/&&/g, '').includes('&'),
    'the start command backgrounds node again (a bare `&`) -- that is the shape that never starts');
  assert.ok(/\bexec\b/.test(built),
    'the start must `exec` node so the pid the shell reports is node itself, not a wrapper shell');
});

test('the command is wrapped for sh -c with quote-safe escaping', () => {
  assert.ok(/sh -c \{_single_quoted\(start_sh\)\}/.test(CODE),
    'the compound command must be handed to sh -c, or sudo would only run its first word');
  // ' inside the string must close and reopen the quote, or a value containing one ends it early
  assert.ok(CODE.includes(`"'" + s.replace("'", "'\\\\''") + "'"`),
    'the single-quote escaping in _single_quoted() changed -- a password containing an apostrophe '
    + 'could end the quoted string and change what runs as root');
});

test('after starting, root is the expected owner and anything else is a warning', () => {
  assert.ok(/new_owner\.strip\(\)\s*!=\s*'root'/.test(CODE),
    "the post-start check must expect root; it used to expect the SSH account, which is the state "
    + 'that took the site down');
  assert.ok(/503/.test(CODE), 'the warning should say what goes wrong, so the next reader acts on it');
});

test('killing the old process still handles a root-owned one', () => {
  assert.ok(/run_sudo\(f?'kill -9/.test(CODE) || /run_sudo\(f"kill -9/.test(CODE),
    'the sudo kill path is gone -- a root-owned process could no longer be replaced');
});

console.log(`\ndeploy-starts-as-root: ${passed} passed`);
