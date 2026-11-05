"""
ตรวจสภาพ backend บน NAS แบบ **อ่านเฉยๆ** — ไม่ฆ่า ไม่สตาร์ต ไม่เขียนไฟล์ของแอป

    python nas_inspect.py            # รายงานสุขภาพ + ความครบถ้วนของข้อมูล
    python nas_inspect.py --seed     # เพิ่มการตรวจไฟล์ seed ของบัญชี superadmin (ต้อง sudo)

ต้องมี NAS_PASSWORD ใน env เหมือน deploy_backend.py (NAS_USER ไม่ใส่ = Teerawat)

ทำไมไฟล์นี้มีอยู่ (2026-11-05): วันนั้นใช้เวลาไปมากกับการพิสูจน์ว่า deploy สำเร็จจริงหรือไม่ และ
ทุกคำตอบมาจากการ "ถาม NAS" ไม่ใช่การอ่านโค้ด · บทเรียนสามข้อที่ฝังอยู่ในไฟล์นี้:

1. **ห้ามเชื่อว่าโปรเซสที่เห็นคือตัวที่เราสตาร์ต** — NAS นี้มีตัวเฝ้า rc.d
   (`attendance-autostart.sh watchdog-loop`) ที่กู้ backend ให้เองทุก 5 นาที ⇒ "มีโปรเซสอยู่"
   กับ "ของเราสตาร์ตสำเร็จ" เป็นคนละเรื่อง · ตัวชี้ขาดคือ **จำนวนบรรทัด
   `backend down, restarting` ใน watchdog.log ต้องไม่เพิ่ม** เทียบกับก่อน deploy
   (2026-11-05 เคยเชื่อผิดแล้วเสียเวลาไปครึ่งวัน และทำเว็บล่ม ~2.5 นาที)

2. **sudo ไม่ต้องมี pty** — `sudo -S` อ่านรหัสผ่านจาก stdin ได้ · การเปิด pty แล้วปิดช่องคือ
   ต้นเหตุที่ `deploy_backend.py` สตาร์ต backend ไม่ขึ้นเลยตั้งแต่ `530e03a` (pty ถูกรื้อแล้วลาก
   โปรเซสที่เพิ่งสตาร์ตไปด้วย) ดู run_sudo() ในสคริปต์นั้น

3. **การเปิดคอนเนกชัน SSH ถี่ๆ ติดกันทำให้ paramiko โยน EOFError ตอนขอ channel**
   (connect() ผ่าน แต่ transport ตายแล้ว) ⇒ ใช้คอนเนกชันเดียวซ้ำ เว้นจังหวะ และต่อใหม่ให้เอง

และ: ทุก output ถูกกรองรหัสผ่านออกก่อนพิมพ์ (`scrub()`) เพราะกฎของโปรเจกต์คือห้ามพิมพ์ค่าลับ
· `ps aux | grep <คำ>` จับ argv ของตัวเองได้ (กับดักเดียวกับ `pkill -f` ที่บันทึกไว้ใน memory)
⇒ ต่อ `| grep -v grep` ทุกครั้ง ไม่งั้นจะนับเกินและสรุปผิด
"""
import os
import sys
import time

import paramiko

PW = os.environ.get('NAS_PASSWORD')
USER = os.environ.get('NAS_USER') or 'Teerawat'
SUPER = os.environ.get('SUPERADMIN_PASSWORD', '')
HOST = '192.168.100.100'
KNOWN_HOSTS = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'nas_known_hosts')

NODE = '/volume1/@appstore/Node.js_v22/usr/local/bin/node'
BASE = '/volume1/web/Time_Attendance/attendance-server'
BACKEND = BASE + '/backend'
DATA = BACKEND + '/data'
# เสียงรบกวนที่ติดมากับทุกคำสั่ง เพราะบัญชี SSH ไม่มีโฮมไดเรกทอรีบน NAS นี้
NOISE = 'Could not chdir to home directory /var/services/homes/%s: No such file or directory' % USER

if not PW:
    raise SystemExit('[ABORT] NAS_PASSWORD env var not set -- see deploy_backend.py for how to set it')

_client = None


def scrub(s):
    """ห้ามให้ค่าลับหลุดลง stdout เด็ดขาด"""
    s = (s or '').replace(PW, '***')
    if SUPER:
        s = s.replace(SUPER, '***')
    return s.replace(NOISE, '').replace('Password:', '').strip()


def _connect():
    global _client
    if _client is not None:
        try:
            _client.close()
        except Exception:
            pass
    c = paramiko.SSHClient()
    if not os.path.exists(KNOWN_HOSTS):
        raise SystemExit('[ABORT] no pinned host key at %s -- run deploy_backend.py once first' % KNOWN_HOSTS)
    c.load_host_keys(KNOWN_HOSTS)
    c.set_missing_host_key_policy(paramiko.RejectPolicy())
    c.connect(HOST, port=22, username=USER, password=PW, timeout=15)
    _client = c
    return c


def _live():
    global _client
    if _client is None or _client.get_transport() is None or not _client.get_transport().is_active():
        return _connect()
    return _client


def _retry(fn, tries=3):
    last = None
    for i in range(tries):
        try:
            return fn(_live())
        except (EOFError, paramiko.SSHException, OSError) as e:   # ดูเหตุผลข้อ 3 ที่หัวไฟล์
            last = e
            time.sleep(1.0 + i)
            try:
                _connect()
            except Exception as e2:
                last = e2
                time.sleep(1.5 + i)
    raise last


def run(cmd, timeout=30):
    """คำสั่งธรรมดา (ไม่ sudo)"""
    def go(c):
        _, out, err = c.exec_command(cmd, timeout=timeout)
        return scrub(out.read().decode('utf-8', 'replace') + err.read().decode('utf-8', 'replace'))
    result = _retry(go)
    time.sleep(0.15)
    return result


def sudo(cmd, timeout=40):
    """sudo **โดยไม่เปิด pty** -- ดูเหตุผลข้อ 2 ที่หัวไฟล์"""
    def go(c):
        ch = c.get_transport().open_session()
        ch.settimeout(timeout)
        ch.exec_command('sudo -S ' + cmd)
        time.sleep(0.4)
        ch.sendall(PW + '\n')
        try:
            ch.shutdown_write()
        except Exception:
            pass
        buf = b''
        deadline = time.time() + timeout
        while time.time() < deadline:
            while ch.recv_ready():
                buf += ch.recv(4096)
            while ch.recv_stderr_ready():
                buf += ch.recv_stderr(4096)
            if ch.exit_status_ready():
                break
            time.sleep(0.1)
        while ch.recv_ready():
            buf += ch.recv(4096)
        while ch.recv_stderr_ready():
            buf += ch.recv_stderr(4096)
        ch.close()
        return scrub(buf.decode('utf-8', 'replace'))
    result = _retry(go)
    time.sleep(0.15)
    return result


def put_script(remote_path, text):
    """วางสคริปต์ลง /tmp ผ่าน base64 -- เลี่ยงปัญหา quoting ทุกชนิด"""
    import base64
    b64 = base64.b64encode(text.encode('utf-8')).decode()
    return run('echo %s | base64 -d > %s && wc -c < %s' % (b64, remote_path, remote_path))


INTEGRITY_JS = r'''
const fs = require('fs');
const BASE = '/volume1/web/Time_Attendance/attendance-server';
const rd = f => JSON.parse(fs.readFileSync(BASE + '/backend/data/' + f, 'utf8'));
const s = rd('settings.json'); const A = s.appSettings || s;
const u = rd('users.json');
const ev = rd('events.json'); const rows = Array.isArray(ev) ? ev : (ev.events || []);
const lv = rd('leaves.json'); const lrows = Array.isArray(lv) ? lv : (lv.leaves || []);
console.log('  users.json                = ' + u.length + ' ราย (superadmin ' +
  u.filter(x => x.username === 'superadmin').length + ' ใบ)');
console.log('  events.json               = ' + rows.length + ' แถว');
console.log('  leaves.json               = ' + lrows.length + ' แถว');
console.log('  sso rate/min/max/amount   = ' + [A.sso.rate, A.sso.minSalary, A.sso.maxSalary, A.sso.maxAmount].join(' / '));
console.log('  longDistanceThresholdKm   = ' + A.allowances.longDistanceThresholdKm);
console.log('  wholeHourLeaveFrom        = ' + JSON.stringify(A.leave && A.leave.wholeHourLeaveFrom));
// เลขพนักงานทุกคนต้องผ่านด่านเดียวกับที่เส้นทางรับข้อมูลจากเครื่องสแกนใช้ ไม่งั้นการสแกนถูกทิ้งเงียบๆ
const isSafeEmpNo = x => typeof x === 'string' && /^[A-Za-z0-9_-]{1,16}$/.test(x);
const badNo = u.filter(x => x.isSystemAccount !== true && x.username !== 'superadmin')
               .filter(x => !isSafeEmpNo(String(x.employeeNo == null ? '' : x.employeeNo)));
console.log('  employeeNo ที่ด่านจะทิ้ง    = ' + badNo.length + (badNo.length ? '  <-- ' + badNo.map(x => x.id).join(',') : '  (ดี)'));
const known = new Set(u.map(x => String(x.employeeNo)));
const orphan = new Set(rows.map(r => String(r.employeeNo == null ? '' : r.employeeNo)).filter(e => e && !known.has(e)));
console.log('  employeeNo ใน events ที่ไม่มีในทะเบียน = ' + orphan.size + (orphan.size ? '  <-- ' + [...orphan].join(',') : '  (ดี)'));
'''

SEED_JS = r'''
const fs = require('fs');
const BASE = '/volume1/web/Time_Attendance/attendance-server';
const j = JSON.parse(fs.readFileSync(BASE + '/backend/data/superadmin-seed.json', 'utf8'));
const u = JSON.parse(fs.readFileSync(BASE + '/backend/data/users.json', 'utf8'));
const a = u.find(x => x.username === 'superadmin');
console.log('  keys              = ' + JSON.stringify(Object.keys(j)));
console.log('  version           = ' + j.version);
console.log('  เป็นแฮช bcrypt      = ' + /^\$2[aby]\$/.test(j.password) + ' (ยาว ' + String(j.password).length + ')');
console.log('  ตรงกับ users.json   = ' + (!!a && a.password === j.password));
console.log('  มีฟิลด์ที่ส่อว่าเก็บรหัสจริง = ' + Object.keys(j).some(k => /plain|secret|raw/i.test(k)));
'''


def main():
    want_seed = '--seed' in sys.argv
    print('=== เวลาบน NAS ===', run("date '+%F %T'"))
    print()
    print('=== backend ===')
    pid = run("ps aux | grep 'node server.js' | grep -v grep | awk '{print $2}' | tail -1")
    print('  pid (ตัวท้าย = node จริง) =', pid or '(ไม่มี!)')
    print('  ps เต็ม:')
    print(run("ps -eo pid=,ppid=,user=,lstart=,args= | grep 'server.js' | grep -v grep"))
    print('  /api/health              =', run('curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/api/health'))
    print('  /api/login (400 = ปกติ)   =', run('curl -s -o /dev/null -w "%{http_code}" -X POST http://localhost:3000/api/login'))
    print('  หน้าเว็บจาก DSM            =', run('curl -s -o /dev/null -w "%{http_code}" http://localhost/Time_Attendance/attendance/'))
    print()
    print('=== ตัวเฝ้า rc.d (ตัวชี้ขาดว่าใครสตาร์ต backend) ===')
    print('  watchdog.log บรรทัด       =', run('wc -l < "%s/watchdog.log"' % BASE))
    print('  นับ backend down          =', run('grep -c "backend down, restarting" "%s/watchdog.log"' % BASE))
    print('  2 บรรทัดท้าย:')
    print(run('tail -2 "%s/watchdog.log"' % BASE))
    print('  >> จดสองเลขนี้ไว้ก่อน deploy · ถ้าหลัง deploy "นับ backend down" เพิ่ม = ตัวเฝ้ากู้ให้')
    print('     ไม่ใช่สคริปต์สตาร์ตเอง')
    print()
    print('=== ความลับไม่หลุดใน ps ===')
    leak = run("ps -eo args= | grep SUPERADMIN_PASSW''ORD | grep -v grep")
    print('  บรรทัดที่มีรหัส superadmin =', repr(leak), '(ว่าง = ดี)')
    print()
    print('=== ความครบถ้วนของข้อมูล ===')
    put_script('/tmp/ta_inspect_integrity.js', INTEGRITY_JS)
    print(sudo('%s /tmp/ta_inspect_integrity.js' % NODE))
    print()
    print('=== log ท้ายสุดที่น่าสนใจ ===')
    print(run("""tail -300 "%s/server.log" | grep -E '\\[CRASH\\]|\\[ERROR\\]|\\[SYSTEM\\]' | tail -6""" % BACKEND))
    if want_seed:
        print()
        print('=== ไฟล์ seed ของบัญชี superadmin (ต้อง 600 root) ===')
        print('  stat:', sudo('stat -c "mode=%%a owner=%%U size=%%s" "%s/superadmin-seed.json"' % DATA))
        put_script('/tmp/ta_inspect_seed.js', SEED_JS)
        print(sudo('%s /tmp/ta_inspect_seed.js' % NODE))
    print()
    print('[DONE] ไม่มีคำสั่งใดในรอบนี้ที่เขียนไฟล์ของแอป ฆ่า หรือสตาร์ตโปรเซส')


if __name__ == '__main__':
    try:
        main()
    finally:
        if _client is not None:
            try:
                _client.close()
            except Exception:
                pass
