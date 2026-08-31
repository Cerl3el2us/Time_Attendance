import paramiko, os, base64, time

HOST='192.168.100.100'; USER='Teerawat'; PASS=os.environ.get('NAS_PASSWORD', '')
APP  = '/volume1/web/attendance/js/app.js'
HTML = '/volume1/web/attendance/index.html'
JA   = '/volume1/web/attendance/lang/ja.js'
OLD_VER = '20260714d'
NEW_VER = '20260714e'

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
    _, o, _ = ssh.exec_command(f'wc -c < "{path}"')
    return int(o.read().decode().strip())

log_lines = []
def log(m): log_lines.append(m); print(m.encode('ascii','replace').decode())

# ===== app.js: Fix dark mode toggle label for Japanese =====
app = read_file(APP).decode('utf-8', errors='replace')
log(f'app.js: {len(app)} chars')

# Current line 8279:
# if (lbl)  lbl.textContent  = isDark ? (currentLang==='th' ? 'โหมดสว่าง' : 'Light Mode') : (currentLang==='th' ? 'โหมดมืด' : 'Dark Mode');

OLD_DM = "lbl.textContent  = isDark ? (currentLang==='th' ? 'โหมดสว่าง' : 'Light Mode') : (currentLang==='th' ? 'โหมดมืด' : 'Dark Mode');"
NEW_DM = "lbl.textContent  = isDark ? (currentLang==='th' ? 'โหมดสว่าง' : currentLang==='ja' ? 'ライトモード' : 'Light Mode') : (currentLang==='th' ? 'โหมดมืด' : currentLang==='ja' ? 'ダークモード' : 'Dark Mode');"

cnt = app.count(OLD_DM)
log(f'Dark mode toggle: found {cnt}')

if cnt > 0:
    app = app.replace(OLD_DM, NEW_DM)
    log('  Applied: dark mode JP label')
else:
    log('  NOT FOUND - searching partial...')
    # Try to find the actual string
    _, out, _ = ssh.exec_command('grep -n "lbl.textContent.*isDark" ' + APP)
    found = out.read().decode('utf-8', errors='replace').strip()
    log(f'  Partial match: {found}')

# Also check for "not checked in" text in the dashboard/sidebar
_, out, _ = ssh.exec_command('grep -n "not checked in\\|not yet in\\|X not\\|[0-9] not" ' + APP + ' | head -10')
found2 = out.read().decode('utf-8', errors='replace').strip()
log(f'\nDashboard "not checked in" occurrences:\n{found2}')

# Version bump in app.js (if present) — app.js version is set in index.html, not inside itself
# But let's bump index.html

log(f'\nWriting app.js ({len(app.encode("utf-8"))} bytes)...')
written = write_file(APP, app.encode('utf-8'))
log(f'  Written: {written} bytes')

# ===== index.html: version bump =====
html = read_file(HTML).decode('utf-8', errors='replace')
html = html.replace(f'app.js?v={OLD_VER}', f'app.js?v={NEW_VER}')
html = html.replace(f'ja.js?v={OLD_VER}', f'ja.js?v={NEW_VER}')
log(f'\nWriting index.html ({len(html.encode("utf-8"))} bytes)...')
written_h = write_file(HTML, html.encode('utf-8'))
log(f'  Written: {written_h} bytes')

# ===== ja.js: add ダークモード / ライトモード if not present =====
ja = read_file(JA).decode('utf-8', errors='replace')
log(f'\nja.js: {len(ja)} chars')

additions = []
if '"Dark Mode"' not in ja:
    additions.append('"Dark Mode": "ダークモード"')
if '"Light Mode"' not in ja:
    additions.append('"Light Mode": "ライトモード"')

log(f'  ja.js additions: {additions}')

if additions:
    # Insert after "Early Morning" or after first entry we know exists
    import re
    anchor_m = re.search(r'"Early Morning"\s*:\s*"[^"]*"', ja)
    if anchor_m:
        old_a = anchor_m.group(0)
        new_block = old_a + ',\n  ' + ',\n  '.join(additions)
        # Replace (the existing entry might already have a comma after it)
        # Find the comma context
        idx = ja.find(old_a)
        after = ja[idx + len(old_a):]
        if after.lstrip().startswith(','):
            # Already has comma, insert before it
            ja = ja[:idx + len(old_a)] + ',\n  ' + ',\n  '.join(additions) + after
        else:
            ja = ja[:idx + len(old_a)] + ',\n  ' + ',\n  '.join(additions) + after
        log(f'  Inserted after Early Morning entry')
    else:
        log('  Early Morning anchor not found!')

    log(f'\nWriting ja.js ({len(ja.encode("utf-8"))} bytes)...')
    written_ja = write_file(JA, ja.encode('utf-8'))
    log(f'  Written: {written_ja} bytes')
else:
    log('  No ja.js changes needed')

ssh.close()
with open(r'C:\Users\tairo\patch_darkmode.log', 'w', encoding='utf-8') as f:
    f.write('\n'.join(log_lines))
print('\nDone - see patch_darkmode.log')
