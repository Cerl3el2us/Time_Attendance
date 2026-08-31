import paramiko, os

HOST='192.168.100.100'; USER='Teerawat'; PASS=os.environ.get('NAS_PASSWORD', '')
ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect(HOST, username=USER, password=PASS)
APP = '/volume1/web/attendance/js/app.js'

results = []

# toggleLang full body (lines 228-234)
_, out, _ = ssh.exec_command(f'sed -n "228,234p" {APP}')
results.append('=== toggleLang ===\n' + out.read().decode('utf-8', errors='replace'))

# i18n dictionary - find it
_, out, _ = ssh.exec_command(f'grep -n "^const i18n\|^let i18n\|^var i18n" {APP}')
ln = out.read().decode().strip().split(':')[0]
if ln:
    _, out, _ = ssh.exec_command(f'sed -n "{ln},{int(ln)+80}p" {APP}')
    results.append('=== i18n dict (line '+ln+') ===\n' + out.read().decode('utf-8', errors='replace'))

# DAY_NAMES arrays
_, out, _ = ssh.exec_command(f'grep -n "DAY_NAMES_EN\|DAY_NAMES_TH\|MONTH_NAMES_EN\|MONTH_NAMES_TH\|MONTH_SHORT_EN\|MONTH_SHORT_TH" {APP} | head -15')
results.append('=== day/month arrays ===\n' + out.read().decode('utf-8', errors='replace'))

# script src lines in index.html (to find where to insert ja.js)
_, out, _ = ssh.exec_command('grep -n "script src" /volume1/web/attendance/index.html')
results.append('=== script tags in index.html ===\n' + out.read().decode('utf-8', errors='replace'))

# sidebar footer content
_, out, _ = ssh.exec_command('sed -n "144,165p" /volume1/web/attendance/index.html')
results.append('=== sidebar footer (html) ===\n' + out.read().decode('utf-8', errors='replace'))

ssh.close()
with open(r'C:\Users\tairo\i18n_more.txt', 'w', encoding='utf-8') as f:
    f.write('\n\n'.join(results))
print('Done')
