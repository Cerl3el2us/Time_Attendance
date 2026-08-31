import paramiko, os, base64, time

HOST='192.168.100.100'; USER='Teerawat'; PASS=os.environ.get('NAS_PASSWORD', '')
HTML = '/volume1/web/attendance/index.html'
JA   = '/volume1/web/attendance/lang/ja.js'
APP  = '/volume1/web/attendance/js/app.js'

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect(HOST, username=USER, password=PASS)

def read_file(path):
    _, out, _ = ssh.exec_command(f'cat "{path}"')
    return out.read()

def write_file(path, content_bytes):
    b64 = base64.b64encode(content_bytes).decode()
    chunk = 60000
    ssh.exec_command(f'> "{path}"')
    time.sleep(0.3)
    for i in range(0, len(b64), chunk):
        ssh.exec_command(f'echo -n "{b64[i:i+chunk]}" | base64 -d >> "{path}"')
        time.sleep(0.2)
    _, out, _ = ssh.exec_command(f'wc -c < "{path}"')
    return int(out.read().decode().strip())

log_lines = []
def log(m):
    log_lines.append(m)
    print(m.encode('ascii', errors='replace').decode())

# ===== Check exact content of index.html lines 1673-1685 =====
_, out, _ = ssh.exec_command('sed -n "1673,1685p" /volume1/web/attendance/index.html')
raw_html_section = out.read()
log(f'Raw HTML section (hex of first 20 bytes): {raw_html_section[:20].hex()}')
html_section_text = raw_html_section.decode('utf-8', errors='replace')
log('HTML lines 1673-1685:')
for i, line in enumerate(html_section_text.split('\n')):
    log(f'  {1673+i}: {repr(line[:80])}')

# ===== Check exact content of ja.js around Managing Director =====
_, out, _ = ssh.exec_command("grep -n 'Managing Director' /volume1/web/attendance/lang/ja.js | head -5")
ja_grep = out.read().decode('utf-8', errors='replace').strip()
log(f'\nja.js Managing Director lines:\n{ja_grep}')

# ===== Check what 2 old md:'Managing Director' remain in app.js =====
_, out, _ = ssh.exec_command("grep -n \"md:'Managing Director'\" /volume1/web/attendance/js/app.js")
app_grep = out.read().decode('utf-8', errors='replace').strip()
log(f'\napp.js remaining md:\'Managing Director\':\n{app_grep}')

# ===== FIX: index.html emp-role options =====
log('\n--- Patching index.html ---')
html_bytes = read_file(HTML)
html = html_bytes.decode('utf-8', errors='replace')

# Try to find the exact string from the actual file
# Search for the emp-role select section
import re
# Find option block inside emp-role select
option_block_match = re.search(
    r'(<option value="md">Level 1 [^<]*</option>\s*'
    r'<option value="manager">Level 2 [^<]*</option>\s*'
    r'<option value="accounting">Level 3 [^<]*</option>\s*'
    r'<option value="user">Level 4 [^<]*</option>\s*'
    r'<option value="marketing">Level 4 [^<]*</option>\s*'
    r'<option value="driver"[^>]*>[^<]*</option>)',
    html
)

if option_block_match:
    old_block = option_block_match.group(0)
    log(f'Found option block ({len(old_block)} chars):')
    log(repr(old_block[:200]))

    # Get indentation from first line
    start_pos = option_block_match.start()
    line_start = html.rfind('\n', 0, start_pos) + 1
    indent = html[line_start:start_pos]
    log(f'Indent: {repr(indent)}')

    # Build replacement with data-en and data-th
    new_block = (
        f'{indent}<option value="md" data-en="Level 1 — Managing Director" data-th="ระดับ 1 — กรรมการผู้จัดการ">Level 1 — Managing Director</option>\n'
        f'{indent}<option value="manager" data-en="Level 2 — Manager" data-th="ระดับ 2 — ผู้จัดการ">Level 2 — Manager</option>\n'
        f'{indent}<option value="accounting" data-en="Level 3 — Accounting" data-th="ระดับ 3 — บัญชี">Level 3 — Accounting</option>\n'
        f'{indent}<option value="user" data-en="Level 4 — Staff" data-th="ระดับ 4 — พนักงาน">Level 4 — Staff</option>\n'
        f'{indent}<option value="marketing" data-en="Level 4 — Marketing" data-th="ระดับ 4 — การตลาด">Level 4 — Marketing</option>\n'
        f'{indent}<option value="driver" data-en="Level 5 — Driver (no clock-in)" data-th="ระดับ 5 — คนขับ (ไม่มีเวลาเข้างาน)">Level 5 — Driver (no clock-in)</option>'
    )

    html = html.replace(old_block, new_block, 1)
    log(f'Replaced option block. New count: {html.count("data-en=\"Level 1")}')

    written_h = write_file(HTML, html.encode('utf-8'))
    log(f'Written index.html: {written_h} bytes')
else:
    log('ERROR: option block not found in index.html')

# ===== FIX: ja.js Level labels =====
log('\n--- Patching lang/ja.js ---')
ja_bytes = read_file(JA)
ja = ja_bytes.decode('utf-8', errors='replace')
log(f'ja.js size: {len(ja_bytes)} bytes')

# Find the Managing Director entry
ja_md_match = re.search(r"'Managing Director'\s*:\s*'[^']*'", ja)
if ja_md_match:
    log(f'Found: {ja_md_match.group(0)}')
    # Check if Level labels already exist
    if "'Level 1 — Managing Director'" in ja:
        log('Level 1 already exists in ja.js')
    else:
        old_md = ja_md_match.group(0)
        new_md = (
            old_md + ',\n'
            "  'Level 1 — Managing Director': 'レベル1 — 専務取締役',\n"
            "  'Level 2 — Manager': 'レベル2 — マネージャー',\n"
            "  'Level 3 — Accounting': 'レベル3 — 経理',\n"
            "  'Level 4 — Staff': 'レベル4 — スタッフ',\n"
            "  'Level 4 — Marketing': 'レベル4 — マーケティング',\n"
            "  'Level 5 — Driver (no clock-in)': 'レベル5 — ドライバー（打刻なし）'"
        )
        # Remove trailing comma from old_md to avoid double
        ja = ja.replace(old_md + ',', new_md + ',', 1)
        if new_md not in ja:
            # Try without trailing comma
            ja = ja.replace(old_md, new_md, 1)
        log(f'Added Level labels. Check: {"Level 1" in ja}')
        written_ja = write_file(JA, ja.encode('utf-8'))
        log(f'Written ja.js: {written_ja} bytes')
else:
    log('ERROR: Managing Director not found in ja.js')
    # Search for any similar pattern
    lines = ja.split('\n')
    for i, line in enumerate(lines[:100]):
        if 'Director' in line or 'Manager' in line or 'director' in line:
            log(f'  Line {i}: {repr(line[:100])}')

ssh.close()
with open(r'C:\Users\tairo\patch_remaining.log', 'w', encoding='utf-8') as f:
    f.write('\n'.join(log_lines))
print('Done - see patch_remaining.log')
