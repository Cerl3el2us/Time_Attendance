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

test('the start command still carries the same working directory, HOME and nohup as the boot script', () => {
  const m = CODE.match(/start_sh\s*=\s*\(([\s\S]*?)\)\nstarted/);
  assert.ok(m, 'start_sh is not built where this guard expects it');
  const built = m[1];
  ['cd "/volume1/web/Time_Attendance/attendance-server/backend"',
   'HOME="/volume1/web/Time_Attendance/attendance-server"',
   'nohup', 'server.js', 'server.log'].forEach(bit =>
    assert.ok(built.includes(bit), `the start command no longer contains: ${bit}`));
  assert.ok(built.includes('env_prefix'), 'SUPERADMIN_PASSWORD would stop being passed through');
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
