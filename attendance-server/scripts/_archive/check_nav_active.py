import paramiko, os
HOST='192.168.100.100'; USER='Teerawat'; PASS=os.environ.get('NAS_PASSWORD', '')
ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect(HOST, username=USER, password=PASS)
APP = '/volume1/web/attendance/js/app.js'

results = {}

# Find setActivePage / active nav item logic
_, out, _ = ssh.exec_command('grep -n "setActive\\|activePage\\|active.*nav\\|nav.*active\\|sidebar.*active\\|current.*page\\|showPage\\|showSection" ' + APP + ' | head -20')
results['active_page'] = out.read().decode('utf-8', errors='replace').strip()

# Find payslip nav link
_, out, _ = ssh.exec_command('grep -n "payslip\\|pay-slip\\|nav_payslip\\|nav.*pay" ' + APP + ' | head -15')
results['payslip_nav'] = out.read().decode('utf-8', errors='replace').strip()

# Find nav-item active class
_, out, _ = ssh.exec_command('grep -n "nav-item.*active\\|class.*active.*nav\\|nav-link.*active\\|sidebar.*link.*active" ' + APP + ' | head -10')
results['nav_active'] = out.read().decode('utf-8', errors='replace').strip()

# Find switchLang or function that does not exist
_, out, _ = ssh.exec_command('grep -n "function switchLang\|function changeLang\|function toggleLang" ' + APP)
results['switch_lang'] = out.read().decode('utf-8', errors='replace').strip()

# Find what function comes before toggleDarkMode
_, out, _ = ssh.exec_command('sed -n "8275,8295p" ' + APP)
results['before_toggleDarkMode'] = out.read().decode('utf-8', errors='replace')

ssh.close()
with open(r'C:\Users\tairo\nav_active_check.txt', 'w', encoding='utf-8') as f:
    for k, v in results.items():
        f.write(f'\n=== {k} ===\n{v}\n')
print('Done')
