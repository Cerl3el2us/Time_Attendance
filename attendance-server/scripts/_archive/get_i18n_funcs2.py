import paramiko, os, sys

HOST='192.168.100.100'; USER='Teerawat'; PASS=os.environ.get('NAS_PASSWORD', '')
ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect(HOST, username=USER, password=PASS)

APP = '/volume1/web/attendance/js/app.js'
OUT = r'C:\Users\tairo\i18n_funcs.txt'

results = []

# L() function line 219
_, out, _ = ssh.exec_command(f'sed -n "215,225p" {APP}')
results.append('=== L() function ===\n' + out.read().decode('utf-8', errors='replace'))

# applyStaticI18n line number
_, out, _ = ssh.exec_command(f'grep -n "function applyStaticI18n" {APP}')
ln = out.read().decode().strip().split(':')[0]
if ln:
    _, out, _ = ssh.exec_command(f'sed -n "{ln},{int(ln)+35}p" {APP}')
    results.append('=== applyStaticI18n (line '+ln+') ===\n' + out.read().decode('utf-8', errors='replace'))

# applyLanguage line number
_, out, _ = ssh.exec_command(f'grep -n "function applyLanguage" {APP}')
ln2 = out.read().decode().strip().split(':')[0]
if ln2:
    _, out, _ = ssh.exec_command(f'sed -n "{ln2},{int(ln2)+50}p" {APP}')
    results.append('=== applyLanguage (line '+ln2+') ===\n' + out.read().decode('utf-8', errors='replace'))

# currentLang declaration
_, out, _ = ssh.exec_command(f"grep -n 'let currentLang\\|var currentLang\\|const currentLang' {APP} | head -5")
results.append('=== currentLang decl ===\n' + out.read().decode('utf-8', errors='replace'))

# lang toggle button in sidebar
_, out, _ = ssh.exec_command(f"grep -n 'toggleLang\\|lang.*btn\\|EN.*TH\\|TH.*EN\\|applyLanguage()' {APP} | head -20")
results.append('=== lang toggle refs ===\n' + out.read().decode('utf-8', errors='replace'))

# sidebar footer in index.html
_, out, _ = ssh.exec_command(f"grep -n 'sidebar-footer\\|lang-btn\\|flag\\|EN.*TH' /volume1/web/attendance/index.html | head -15")
results.append('=== sidebar footer html ===\n' + out.read().decode('utf-8', errors='replace'))

# lang/ja.js inclusion check
_, out, _ = ssh.exec_command(f"grep -n 'lang/' /volume1/web/attendance/index.html | head -10")
results.append('=== existing lang files ===\n' + out.read().decode('utf-8', errors='replace'))

ssh.close()

with open(OUT, 'w', encoding='utf-8') as f:
    f.write('\n\n'.join(results))

print('Done. Written to', OUT)
