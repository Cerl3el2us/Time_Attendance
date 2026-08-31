import paramiko, os, base64, time

HOST='192.168.100.100'; USER='Teerawat'; PASS=os.environ.get('NAS_PASSWORD', '')
APP  = '/volume1/web/attendance/js/app.js'
HTML = '/volume1/web/attendance/index.html'
OLD_VER = '20260714f'
NEW_VER = '20260714g'

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

app = read_file(APP).decode('utf-8', errors='replace')
log(f'app.js: {len(app)} chars')

# Add date input lang update to applyLanguage()
# Insert after "document.documentElement.lang = ..." line in applyLanguage()
OLD = "    document.documentElement.lang = currentLang === 'en' ? 'en' : currentLang === 'ja' ? 'ja' : 'th';"
NEW = """    document.documentElement.lang = currentLang === 'en' ? 'en' : currentLang === 'ja' ? 'ja' : 'th';
    const _dLang = currentLang === 'en' ? 'en' : currentLang === 'ja' ? 'ja' : 'th';
    document.querySelectorAll('input[type="date"]').forEach(inp => inp.setAttribute('lang', _dLang));"""

cnt = app.count(OLD)
log(f'applyLanguage lang line: found {cnt}')

if cnt == 1:
    app = app.replace(OLD, NEW)
    log('  Applied: date input lang update in applyLanguage()')
else:
    log('  NOT FOUND - checking alternative...')
    _, out, _ = ssh.exec_command('grep -n "document.documentElement.lang" ' + APP)
    log(out.read().decode('utf-8', errors='replace').strip())

# Also update date inputs in fixStaticText() for the pre-login state
# Find fixStaticText and add the same update there
_, out2, _ = ssh.exec_command('grep -n "function fixStaticText" ' + APP)
fix_line = out2.read().decode('utf-8', errors='replace').strip()
log(f'fixStaticText location: {fix_line}')

# Find "document.documentElement.lang = currentLang === 'en' ? 'en' : 'th';" - the initial one on line 3
OLD2 = "document.documentElement.lang = currentLang === 'en' ? 'en' : currentLang === 'ja' ? 'ja' : 'th';\nconst i18n = {"
NEW2 = "document.documentElement.lang = currentLang === 'en' ? 'en' : currentLang === 'ja' ? 'ja' : 'th';\nconst i18n = {"
# Already fixed in previous patch, just verify

cnt2 = app.count("document.documentElement.lang = currentLang === 'en' ? 'en' : currentLang === 'ja' ? 'ja' : 'th';")
log(f'Total occurrences of full ja lang line: {cnt2}')

log(f'\nWriting app.js ({len(app.encode("utf-8"))} bytes)...')
written = write_file(APP, app.encode('utf-8'))
log(f'  Written: {written} bytes')

# Version bump in index.html
html = read_file(HTML).decode('utf-8', errors='replace')
html = html.replace(f'app.js?v={OLD_VER}', f'app.js?v={NEW_VER}')
html = html.replace(f'ja.js?v={OLD_VER}', f'ja.js?v={NEW_VER}')
log(f'\nWriting index.html ({len(html.encode("utf-8"))} bytes)...')
written_h = write_file(HTML, html.encode('utf-8'))
log(f'  Written: {written_h} bytes')

ssh.close()
with open(r'C:\Users\tairo\patch_dateinput.log', 'w', encoding='utf-8') as f:
    f.write('\n'.join(log_lines))
print('\nDone')
