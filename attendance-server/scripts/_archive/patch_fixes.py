import paramiko, os, base64, time

HOST='192.168.100.100'; USER='Teerawat'; PASS=os.environ.get('NAS_PASSWORD', '')
APP  = '/volume1/web/attendance/js/app.js'
HTML = '/volume1/web/attendance/index.html'
JA   = '/volume1/web/attendance/lang/ja.js'
NEW_VER    = '20260714b'
OLD_VER    = '20260713bq'
OLD_JA_VER = '20260714a'
NEW_JA_VER = '20260714b'

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect(HOST, username=USER, password=PASS)

def read_file(path):
    _, out, err = ssh.exec_command(f'cat "{path}"')
    data = out.read()
    e = err.read().decode('utf-8', errors='replace').strip()
    if e and 'chdir' not in e: print('STDERR:', e[:200])
    return data

def write_file(path, content_bytes):
    b64 = base64.b64encode(content_bytes).decode()
    chunk = 60000
    ssh.exec_command(f'> "{path}"')
    time.sleep(0.3)
    for i in range(0, len(b64), chunk):
        part = b64[i:i+chunk]
        cmd = f'echo -n "{part}" | base64 -d >> "{path}"'
        ssh.exec_command(cmd)
        time.sleep(0.2)
    _, out, _ = ssh.exec_command(f'wc -c < "{path}"')
    return int(out.read().decode().strip())

def log(msg):
    with open(r'C:\Users\tairo\patch_fixes.log', 'a', encoding='utf-8') as f:
        f.write(msg + '\n')
    print(msg.encode('ascii', errors='replace').decode())

open(r'C:\Users\tairo\patch_fixes.log', 'w', encoding='utf-8').close()

# ===== READ app.js =====
log('Reading app.js...')
app_bytes = read_file(APP)
app = app_bytes.decode('utf-8', errors='replace')
log(f'  app.js size: {len(app_bytes)} bytes')

# Patch strings: use backtick and dollar sign directly (not escaped)
BT = '`'    # backtick
DS = '$'    # dollar sign

patches = []

# Patch 1: openEditMyProfile driver bug
P1_OLD = "if (currentUser.role !== 'user' && currentUser.role !== 'marketing') {"
P1_NEW = "if (currentUser.role !== 'user' && currentUser.role !== 'marketing' && currentUser.role !== 'driver') {"
patches.append(('P1 driver bug', P1_OLD, P1_NEW, 1))

# Patch 2: Add role_marketing to i18n.ja
# note: using actual Japanese text, logging to file (not print)
P2_OLD = "role_user:'スタッフ', role_driver:'ドライバー',"
P2_NEW = "role_user:'スタッフ', role_driver:'ドライバー', role_marketing:'マーケティング',"
patches.append(('P2 i18n.ja role_marketing', P2_OLD, P2_NEW, 1))

# Patch 3: roleLabels x4 -> t()
P3_OLD = "const roleLabels = { md:'Managing Director', manager:'Manager', accounting:'Accounting', user:'Staff', driver:'Driver', marketing:'Marketing' }; // permission role"
P3_NEW = "const roleLabels = { md:t('role_md'), manager:t('role_manager'), accounting:t('role_accounting'), user:t('role_user'), driver:t('role_driver'), marketing:t('role_marketing') };"
patches.append(('P3 roleLabels x4', P3_OLD, P3_NEW, 4))

# Patch 4: openImportConfirm role select (MD branch)
# Find the exact string in the template literal
P4_OLD = (
    "      <option value=\"md\">Managing Director</option>\n"
    "      <option value=\"manager\">Manager</option>\n"
    "      <option value=\"accounting\">Accounting</option>\n"
    "      <option value=\"user\" selected>Staff</option>`;"
)
P4_NEW = (
    f"      <option value=\"md\">{DS}{{t('role_md')}}</option>\n"
    f"      <option value=\"manager\">{DS}{{t('role_manager')}}</option>\n"
    f"      <option value=\"accounting\">{DS}{{t('role_accounting')}}</option>\n"
    f"      <option value=\"user\" selected>{DS}{{t('role_user')}}</option>`;"
)
patches.append(('P4 import-role options (MD)', P4_OLD, P4_NEW, 1))

# Patch 5: openImportConfirm role select (non-MD branch)
P5_OLD = 'roleSelect.innerHTML = `<option value="user" selected>Staff</option>`;'
P5_NEW = f'roleSelect.innerHTML = `<option value="user" selected>{DS}{{t(\'role_user\')}}</option>`;'
patches.append(('P5 import-role options (non-MD)', P5_OLD, P5_NEW, 1))

# Patch 6: ROLE_LEVELS add driver/marketing
P6_OLD = (
    "  md:         { level:1, label:'Managing Director' },\n"
    "  manager:    { level:2, label:'Manager'           },\n"
    "  accounting: { level:3, label:'Accounting'        },\n"
    "  user:       { level:4, label:'Staff'             },"
)
P6_NEW = (
    "  md:         { level:1, label:'Managing Director' },\n"
    "  manager:    { level:2, label:'Manager'           },\n"
    "  accounting: { level:3, label:'Accounting'        },\n"
    "  user:       { level:4, label:'Staff'             },\n"
    "  driver:     { level:5, label:'Driver'            },\n"
    "  marketing:  { level:4, label:'Marketing'         },"
)
patches.append(('P6 ROLE_LEVELS driver/marketing', P6_OLD, P6_NEW, 1))

# Patch 7: version bump
P7_OLD = f'app.js?v={OLD_VER}'
P7_NEW = f'app.js?v={NEW_VER}'
patches.append(('P7 version bump', P7_OLD, P7_NEW, 1))

log('\nPATCH PLAN:')
for name, old, new, expected in patches:
    cnt = app.count(old)
    status = 'OK' if cnt == expected else ('FOUND_' + str(cnt) if cnt > 0 else 'MISSING')
    log(f'  [{status}] {name}: expected {expected}, found {cnt}')

log('\nApplying patches to app.js...')
for name, old, new, expected in patches:
    before = app.count(old)
    if before > 0:
        app = app.replace(old, new)
        after = app.count(old)
        log(f'  Applied {name}: {before} -> {after} remaining')
    else:
        log(f'  SKIP {name}: not found')

log(f'\nWriting app.js ({len(app.encode("utf-8"))} bytes)...')
written = write_file(APP, app.encode('utf-8'))
log(f'  Written: {written} bytes')

# ===== PATCH index.html =====
log('\nReading index.html...')
html_bytes = read_file(HTML)
html = html_bytes.decode('utf-8', errors='replace')
log(f'  size: {len(html_bytes)} bytes')

# H1: emp-role options with data-en/data-th
H1_OLD = ('<option value="md">Level 1 — Managing Director</option>\n'
          '                <option value="manager">Level 2 — Manager</option>\n'
          '                <option value="accounting">Level 3 — Accounting</option>\n'
          '                <option value="user">Level 4 — Staff</option>\n'
          '                <option value="marketing">Level 4 — Marketing</option>\n'
          '                <option value="driver" data-en="Level 5 — Driver (no clock-in)">Level 5 — Driver (ไม่มีเวลาเข้างาน)</option>')

H1_NEW = ('<option value="md" data-en="Level 1 — Managing Director" data-th="ระดับ 1 — กรรมการผู้จัดการ">Level 1 — Managing Director</option>\n'
          '                <option value="manager" data-en="Level 2 — Manager" data-th="ระดับ 2 — ผู้จัดการ">Level 2 — Manager</option>\n'
          '                <option value="accounting" data-en="Level 3 — Accounting" data-th="ระดับ 3 — บัญชี">Level 3 — Accounting</option>\n'
          '                <option value="user" data-en="Level 4 — Staff" data-th="ระดับ 4 — พนักงาน">Level 4 — Staff</option>\n'
          '                <option value="marketing" data-en="Level 4 — Marketing" data-th="ระดับ 4 — การตลาด">Level 4 — Marketing</option>\n'
          '                <option value="driver" data-en="Level 5 — Driver (no clock-in)" data-th="ระดับ 5 — คนขับ (ไม่มีเวลาเข้างาน)">Level 5 — Driver (no clock-in)</option>')

cnt_h1 = html.count(H1_OLD)
log(f'  [{"OK" if cnt_h1==1 else "MISSING_"+str(cnt_h1)}] H1 emp-role options: found {cnt_h1}')
if cnt_h1 > 0:
    html = html.replace(H1_OLD, H1_NEW)
    log('  Applied H1')

# H2: version bump app.js
H2_OLD = f'app.js?v={OLD_VER}'
H2_NEW = f'app.js?v={NEW_VER}'
cnt_h2 = html.count(H2_OLD)
log(f'  [{"OK" if cnt_h2==1 else "MISSING_"+str(cnt_h2)}] H2 version bump: found {cnt_h2}')
if cnt_h2 > 0:
    html = html.replace(H2_OLD, H2_NEW)
    log('  Applied H2')

# H3: ja.js version bump
H3_OLD = f'ja.js?v={OLD_JA_VER}'
H3_NEW = f'ja.js?v={NEW_JA_VER}'
cnt_h3 = html.count(H3_OLD)
log(f'  [{"OK" if cnt_h3==1 else "MISSING_"+str(cnt_h3)}] H3 ja.js version: found {cnt_h3}')
if cnt_h3 > 0:
    html = html.replace(H3_OLD, H3_NEW)
    log('  Applied H3')

log(f'\nWriting index.html ({len(html.encode("utf-8"))} bytes)...')
written_h = write_file(HTML, html.encode('utf-8'))
log(f'  Written: {written_h} bytes')

# ===== PATCH lang/ja.js =====
log('\nReading lang/ja.js...')
ja_bytes = read_file(JA)
ja = ja_bytes.decode('utf-8', errors='replace')
log(f'  size: {len(ja_bytes)} bytes')

# Add Level role label translations after 'Managing Director' line
JA_ANCHOR = "'Managing Director': '代表取締役',"
JA_CHECK   = "'Level 1 — Managing Director'"
if JA_CHECK not in ja and JA_ANCHOR in ja:
    JA_ADDITIONS = ("'Managing Director': '代表取締役',\n"
                    "  'Level 1 — Managing Director': 'レベル1 — 専務取締役',\n"
                    "  'Level 2 — Manager': 'レベル2 — マネージャー',\n"
                    "  'Level 3 — Accounting': 'レベル3 — 経理',\n"
                    "  'Level 4 — Staff': 'レベル4 — スタッフ',\n"
                    "  'Level 4 — Marketing': 'レベル4 — マーケティング',\n"
                    "  'Level 5 — Driver (no clock-in)': 'レベル5 — ドライバー（打刻なし）',")
    ja = ja.replace(JA_ANCHOR, JA_ADDITIONS)
    log('  Added Level label translations')
else:
    log('  Level labels already present or anchor not found')

log(f'\nWriting lang/ja.js ({len(ja.encode("utf-8"))} bytes)...')
written_ja = write_file(JA, ja.encode('utf-8'))
log(f'  Written: {written_ja} bytes')

ssh.close()
log('\n=== ALL PATCHES COMPLETE ===')
print('Check patch_fixes.log for details')
