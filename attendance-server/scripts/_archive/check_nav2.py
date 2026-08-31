import paramiko, os
HOST='192.168.100.100'; USER='Teerawat'; PASS=os.environ.get('NAS_PASSWORD', '')
ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect(HOST, username=USER, password=PASS)
APP = '/volume1/web/attendance/js/app.js'

results = {}

# navigateTo function (lines 2445-2480)
_, out, _ = ssh.exec_command('sed -n "2440,2480p" ' + APP)
results['navigate_fn'] = out.read().decode('utf-8', errors='replace')

# applyLanguage end (lines 330-380)
_, out, _ = ssh.exec_command('sed -n "330,385p" ' + APP)
results['apply_lang_end'] = out.read().decode('utf-8', errors='replace')

# applyDarkMode current state (8280-8300)
_, out, _ = ssh.exec_command('sed -n "8280,8302p" ' + APP)
results['apply_dark'] = out.read().decode('utf-8', errors='replace')

# Find payslip nav-item id
_, out, _ = ssh.exec_command('grep -n "nav-payslip\\|id.*payslip.*nav\\|nav.*id.*payslip\\|nav_payslip" /volume1/web/attendance/index.html | head -10')
results['payslip_nav_html'] = out.read().decode('utf-8', errors='replace').strip()

# Find sidebar payslip nav link rendering
_, out, _ = ssh.exec_command("grep -n \"'payslip'\\|\\\"payslip\\\"\" " + APP + ' | grep nav | head -15')
results['payslip_nav_js'] = out.read().decode('utf-8', errors='replace').strip()

ssh.close()
with open(r'C:\Users\tairo\nav2_check.txt', 'w', encoding='utf-8') as f:
    for k, v in results.items():
        f.write(f'\n=== {k} ===\n{v}\n')
print('Done')
