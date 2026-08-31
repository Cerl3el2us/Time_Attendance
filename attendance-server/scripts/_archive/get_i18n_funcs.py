import paramiko, os

HOST='192.168.100.100'; USER='Teerawat'; PASS=os.environ.get('NAS_PASSWORD', '')
ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect(HOST, username=USER, password=PASS)

APP = '/volume1/web/attendance/js/app.js'

# Get L() function (line 219 from earlier)
_, out, _ = ssh.exec_command(f'sed -n "215,225p" {APP}')
print('=== L() function area ===')
print(out.read().decode('utf-8', errors='replace'))

# Get applyStaticI18n
_, out, _ = ssh.exec_command(f'grep -n "function applyStaticI18n\|function applyLanguage\|currentLang\s*=" {APP} | head -20')
print('=== applyStaticI18n / applyLanguage / currentLang ===')
print(out.read().decode('utf-8', errors='replace'))

# Get the lang toggle button area
_, out, _ = ssh.exec_command(f'grep -n "lang-btn\|langBtn\|lang-toggle\|EN.*TH\|toggleLang\|applyLanguage" {APP} | head -20')
print('=== lang toggle ===')
print(out.read().decode('utf-8', errors='replace'))

# Get applyStaticI18n body
_, out, _ = ssh.exec_command(f'grep -n "function applyStaticI18n" {APP}')
line = out.read().decode().strip().split(':')[0]
if line:
    _, out, _ = ssh.exec_command(f'sed -n "{line},{int(line)+30}p" {APP}')
    print('=== applyStaticI18n body ===')
    print(out.read().decode('utf-8', errors='replace'))

# Get applyLanguage body
_, out, _ = ssh.exec_command(f'grep -n "function applyLanguage" {APP}')
line2 = out.read().decode().strip().split(':')[0]
if line2:
    _, out, _ = ssh.exec_command(f'sed -n "{line2},{int(line2)+30}p" {APP}')
    print('=== applyLanguage body ===')
    print(out.read().decode('utf-8', errors='replace'))

ssh.close()
