import paramiko, os, base64, time

HOST='192.168.100.100'; USER='Teerawat'; PASS=os.environ.get('NAS_PASSWORD', '')
APP = '/volume1/web/attendance/js/app.js'
NEW_VER = '20260714c'
OLD_VER = '20260714b'

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

print('Reading app.js...')
app = read_file(APP).decode('utf-8', errors='replace')

patches = []

# Patch 1: sidebar-role-badge — wrap position in L() for LANG_JA lookup
OLD1 = ("  document.getElementById('sidebar-role-badge').textContent = "
        "(currentUser.position || roleLabels[currentUser.role]) + "
        "(currentUser.isObserver ? ` — ${L('view only','ดูอย่างเดียว')} 👁️` : '');")
NEW1 = ("  document.getElementById('sidebar-role-badge').textContent = "
        "(currentUser.position ? L(currentUser.position, currentUser.position) : roleLabels[currentUser.role]) + "
        "(currentUser.isObserver ? ` — ${L('view only','ดูอย่างเดียว')} 👁️` : '');")
patches.append(('sidebar-role-badge L()', OLD1, NEW1, 1))

# Patch 2: renderMyProfile hero role badge — already uses t() via roleLabels
# (no change needed since renderMyProfile uses roleLabels which now uses t())

# Patch 3: version bump in index.html
# (app.js doesn't self-reference its version; version is in index.html)

print('\nPatches:')
for name, old, new, expected in patches:
    cnt = app.count(old)
    print(f'  [{("OK" if cnt==expected else "MISSING_"+str(cnt))}] {name}: found {cnt}')

for name, old, new, expected in patches:
    if app.count(old) > 0:
        app = app.replace(old, new)
        print(f'  Applied: {name}')

print(f'\nWriting app.js ({len(app.encode("utf-8"))} bytes)...')
written = write_file(APP, app.encode('utf-8'))
print(f'  Written: {written} bytes')

# Update index.html version
HTML = '/volume1/web/attendance/index.html'
html = read_file(HTML).decode('utf-8', errors='replace')
if f'app.js?v={OLD_VER}' in html:
    html = html.replace(f'app.js?v={OLD_VER}', f'app.js?v={NEW_VER}')
    written_h = write_file(HTML, html.encode('utf-8'))
    print(f'  index.html updated: {written_h} bytes (v={NEW_VER})')

ssh.close()
print('\nDone')
