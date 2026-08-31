import paramiko, os
HOST='192.168.100.100'; USER='Teerawat'; PASS=os.environ.get('NAS_PASSWORD', '')
ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect(HOST, username=USER, password=PASS)
APP = '/volume1/web/attendance/js/app.js'
JA  = '/volume1/web/attendance/lang/ja.js'

results = {}

# Check "Early Morning" in app.js
_, out, _ = ssh.exec_command('grep -n "Early Morning\\|Late Night\\|Early morning\\|late night" ' + APP)
results['early_morning'] = out.read().decode('utf-8', errors='replace').strip()

# Check "National ID" usage
_, out, _ = ssh.exec_command('grep -n "National ID\\|idType.*passport" ' + APP + ' | head -10')
results['national_id'] = out.read().decode('utf-8', errors='replace').strip()

# Check "Employee No" header
_, out, _ = ssh.exec_command('grep -n "Employee No\\|employeeNo\\|th-empno" ' + APP + ' | head -10')
results['employee_no'] = out.read().decode('utf-8', errors='replace').strip()

# Check dashboard role/position rendering
_, out, _ = ssh.exec_command('grep -n "function renderDashboard\\|function renderTodayAttn\\|dashboard.*role\\|badge.*role" ' + APP + ' | head -10')
results['dashboard_role'] = out.read().decode('utf-8', errors='replace').strip()

# Check Early Morning in ja.js
_, out, _ = ssh.exec_command('grep -n "Early Morning\\|Late Night\\|National ID\\|Employee No" ' + JA)
results['ja_missing'] = out.read().decode('utf-8', errors='replace').strip()

# Check lines around "Early Morning" in app.js
_, out, _ = ssh.exec_command('grep -n "Early Morning" ' + APP)
em_line = out.read().decode('utf-8', errors='replace').strip()
if em_line:
    ln = int(em_line.split(':')[0])
    _, out, _ = ssh.exec_command(f'sed -n "{max(1,ln-2)},{ln+2}p" ' + APP)
    results['early_morning_ctx'] = out.read().decode('utf-8', errors='replace')

ssh.close()
with open(r'C:\Users\tairo\remaining_check.txt', 'w', encoding='utf-8') as f:
    for k, v in results.items():
        f.write(f'\n=== {k} ===\n{v}\n')
print('Done')
