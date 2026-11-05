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

test('the start command still carries the same working directory, HOME and stdio', () => {
  const m = CODE.match(/start_sh\s*=\s*\(([\s\S]*?)\)\nstarted/);
  assert.ok(m, 'start_sh is not built where this guard expects it');
  const built = m[1];
  ['cd "/volume1/web/Time_Attendance/attendance-server/backend"',
   'HOME="/volume1/web/Time_Attendance/attendance-server"',
   'server.js', 'server.log', '< /dev/null'].forEach(bit =>
    assert.ok(built.includes(bit), `the start command no longer contains: ${bit}`));
});

// 2026-11-05: กลับด้านจากยามเดิมที่บังคับว่า start ต้องมี `env_prefix` (= ส่ง SUPERADMIN_PASSWORD
// ไปให้ node) · ตอนนี้ต้อง **ไม่มี** เพราะค่านั้นไปโผล่เป็นข้อความเปิดใน `ps aux` บน NAS:
// เชลล์ห่อ `sh -c` ค้างอยู่ถาวร (ppid 1) หลังคอมมิต 1380ccd เพราะไม่มี pty ให้รื้อ ⇒ บัญชีใด
// บนเครื่องที่สั่ง ps aux ได้ อ่านรหัส superadmin ได้ทันที · เป็นบั๊กประเภทเดียวกับที่
// attendance-autostart.sh เคยแก้ให้โทเคน Cloudflare เมื่อ 2026-08-13
// แทนที่ด้วยไฟล์ seed ที่เก็บแฮช (ดู systemAccount.js) ⇒ ไม่ต้องส่งรหัสผ่าน CLI อีกเลย
// ฝั่ง server.js ยังอ่าน process.env.SUPERADMIN_PASSWORD ต่อ สำหรับทางติดตั้งใหม่หมดเท่านั้น
test('the start command never carries the superadmin password on the command line', () => {
  const m = CODE.match(/start_sh\s*=\s*\(([\s\S]*?)\)\nstarted/);
  assert.ok(m, 'start_sh is not built where this guard expects it');
  const built = m[1];
  ['env_prefix', 'SUPERADMIN_PASSWORD', 'env_bits'].forEach(bit =>
    assert.ok(!built.includes(bit),
      `the start command carries \`${bit}\` again -- the password lands in argv, and the lingering `
      + '`sh -c` wrapper keeps it readable in `ps aux` until the next restart. The seed file in '
      + 'backend/data holds the bcrypt hash instead, so nothing needs to be passed here.'));
  assert.ok(!/SUPERADMIN_PASSWORD/.test(CODE),
    'deploy_backend.py reads SUPERADMIN_PASSWORD again -- it has no job here any more');
});

// ยามข้อนี้คุมต้นเหตุจริงของบั๊ก "สคริปต์ deploy สตาร์ต backend ไม่ขึ้นเลยตั้งแต่ 530e03a"
// ซึ่งหาเจอเมื่อ 2026-11-05: **run_sudo() เปิด pty** แล้วเมื่อช่องถูกปิด pty ถูกรื้อ และลาก
// โปรเซสที่เพิ่งถูกสตาร์ตไปด้วย · `sudo -S` อ่านรหัสผ่านจาก stdin ได้ ไม่ต้องมี pty เลย
//
// วัดบน NAS จริง 2026-11-05 ด้วยสคริปต์ทดสอบใน /tmp ที่ไม่จับพอร์ต (เว็บไม่ดับแม้วินาทีเดียว)
// ตรวจสถานะ 14 วินาทีหลังปิดช่องทุกเคส:
//   D  ไม่มี pty + `nohup … &`        -> รอด (ppid 1)   <- รูปแบบที่ตัวเฝ้า rc.d ใช้
//   E  ไม่มี pty + `setsid --fork`    -> รอด (ppid 1)
//   F  มี pty   + `exec` foreground   -> **ตาย** log หยุดที่วินาทีที่ปิดช่องพอดี
//   G  มี pty   + `nohup … &` แต่ถือช่องไว้ 5 วิก่อนปิด -> รอด
// เทียบ G กับรอบที่ปิดช่องทันทีที่ `sh` จบ (ไม่ถึง 1 วินาที) ซึ่งรูปแบบเดียวกันเป๊ะแต่ตาย และ
// **ไม่มีไฟล์ log เกิดขึ้นเลย** ⇒ pty ถูกรื้อก่อนที่เชลล์ลูกจะได้ตั้ง redirect ด้วยซ้ำ นั่นคือเหตุที่
// server.log ไม่เคยมีร่องรอยของการสตาร์ตจากสคริปต์นี้มาตลอด
//
// ของที่ถูกตัดออกไปก่อนหน้าแล้ว (อย่าไล่ซ้ำ): node เอง · env_prefix · การเขียนต่อท้าย server.log ·
// สิทธิ์ไฟล์ · และ `server.js` พังตอนเริ่ม (รอบ 2026-11-05 09:22 มันขึ้นจริง พิมพ์ `[HTTP] port 3000`
// `[HTTPS] port 3443 ready` รับ WebSocket ได้ 2 ราย แล้วค่อยตายตอนช่องถูกปิด)
//
// ⇒ สองข้อนี้คือสิ่งที่ห้ามแก้กลับ: ไม่เปิด pty · และสตาร์ตแบบ background ด้วย nohup เหมือนตัวเฝ้า
test('run_sudo() does not allocate a pty -- tearing one down is what killed every start', () => {
  const m = CODE.match(/def run_sudo\(([\s\S]*?)\ndef /);
  assert.ok(m, 'run_sudo() is not where this guard expects it');
  const body = m[1];
  assert.ok(!/get_pty\(\)/.test(body),
    'run_sudo() allocates a pty again -- when the channel closes, the pty is torn down and takes '
    + 'the freshly started backend with it. That is the measured cause of every failed restart '
    + 'from 530e03a to 2026-11-05. `sudo -S` reads the password from stdin, so no pty is needed.');
  assert.ok(/sudo -S/.test(body), 'the password must still go to `sudo -S`, not a prompt on a tty');
  assert.ok(/shutdown_write\(\)/.test(body),
    'stdin must be closed after the password, or sudo may keep waiting for more input');
});

// 2026-11-05 (เจ้าของสั่งให้แก้): เปลี่ยนจาก `nohup … &` เป็น `setsid --fork`
// **ของเดิมพังตรงไหน:** `sh -c '… nohup node … & echo pid:$!'` ทิ้งเชลล์ห่อ `sh -c` ค้างไว้ถาวร
// ข้างๆ node (ppid 1 ทั้งคู่) · สตริงคำสั่งของเชลล์ห่อมีคำว่า `node server.js` อยู่ ⇒ FIND_PID
// (`ps aux | grep 'node server.js'`) จับได้ทั้งคู่ ⇒ `[BEFORE]`/`[AFTER]` โชว์สอง pid และ kill
// รอบถัดไปต้องฆ่าสองตัว · ไม่เป็นอันตราย (การตรวจเจ้าของโปรเซสใช้ pid ตัวท้ายซึ่งเป็น node จริง)
// แต่ทำให้ผลอ่านยากและเป็นที่ซ่อนของค่าที่ไม่ควรอยู่ใน argv
// `setsid --fork` ให้ setsid แยกตัวไปเป็น session leader แล้วตัวแม่จบทันที ⇒ sh จบตาม
// ⇒ **เหลือโปรเซสเดียว ppid 1** และ deploy ไม่ค้างรอ
// วัดบน NAS นี้แล้วเมื่อ 2026-11-05 (เคส E ของการวัดชุดเดียวกับที่หาต้นเหตุ pty): ไม่มี pty +
// `setsid --fork` → รอด ppid 1 ตรวจ 14 วินาทีหลังปิดช่อง · `setsid` มีจริงที่ /usr/bin/setsid
// บนเครื่องนี้ และรับธง `--fork` (ไม่ใช่ busybox ที่ไม่มีธงนี้)
// **ห้ามกลับไปใช้ `exec` แบบ foreground** ซึ่งเป็นรูปเดียวที่วัดแล้วว่าตายตอนปิดช่อง (เคส F)
// และเคยทำเว็บล่มไป ~2.5 นาทีเมื่อ 09:22
test('the start detaches with setsid --fork and leaves no wrapper shell behind', () => {
  const m = CODE.match(/start_sh\s*=\s*\(([\s\S]*?)\)\nstarted/);
  assert.ok(m, 'start_sh is not built where this guard expects it');
  const built = m[1];
  assert.ok(/setsid --fork/.test(built),
    'the start no longer uses `setsid --fork` -- without it the `sh -c` wrapper lingers next to '
    + 'node and FIND_PID matches both, which is what this change removed');
  assert.ok(!/\bexec\b/.test(built),
    'the start runs node in the foreground again -- measured 2026-11-05 as the one shape that dies '
    + 'when the channel closes (case F), and it took the site down for ~2.5 minutes');
  assert.ok(!built.includes('nohup'),
    'nohup is back alongside setsid -- pick one; `setsid --fork` already detaches, and the pair is '
    + 'what the 2026-11-03 version had while it never once started successfully');
  // `2>&1` และตัวเชื่อม `&&` ก็มี & เหมือนกัน เอาสองอย่างนั้นออกก่อน จึงจะเหลือ & ที่เป็นการ
  // background จริง — ยามรุ่นก่อนลืมตัด `&&` แล้วรายงานโค้ดที่ถูกว่าผิด
  assert.ok(!built.replace(/2>&1/g, '').replace(/&&/g, '').includes('&'),
    'the start is backgrounded with `&` again -- that is what leaves the wrapper shell behind; '
    + '`setsid --fork` returns on its own without it');
  assert.ok(!built.includes('echo pid:$!'),
    'there is no background job to report a pid for any more -- `[AFTER]` and the health check are '
    + 'what decide whether the restart worked');
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
