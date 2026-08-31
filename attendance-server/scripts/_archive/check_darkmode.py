import paramiko, os
HOST='192.168.100.100'; USER='Teerawat'; PASS=os.environ.get('NAS_PASSWORD', '')
ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect(HOST, username=USER, password=PASS)
APP = '/volume1/web/attendance/js/app.js'

results = {}

# Find Dark Mode button
_, out, _ = ssh.exec_command('grep -n "Dark Mode\\|dark mode\\|toggleDarkMode\\|darkMode" ' + APP + ' | head -20')
results['dark_mode'] = out.read().decode('utf-8', errors='replace').strip()

# Find "not checked in" and "not yet"
_, out, _ = ssh.exec_command('grep -n "not checked in\\|not yet\\|7 in\\|X in\\|in.*not" ' + APP + ' | head -10')
results['not_checked'] = out.read().decode('utf-8', errors='replace').strip()

# Find Employee No. header
_, out, _ = ssh.exec_command('grep -n "Employee No\\.\\|th-empno\\|>Employee No" ' + APP + ' | head -10')
results['emp_no_hdr'] = out.read().decode('utf-8', errors='replace').strip()

# Find Leave Balance (Year)
_, out, _ = ssh.exec_command('grep -n "Leave Balance\\|leave.*balance.*year\\|Leave.*Year" ' + APP + ' | head -10')
results['leave_balance'] = out.read().decode('utf-8', errors='replace').strip()

ssh.close()
with open(r'C:\Users\tairo\darkmode_check.txt', 'w', encoding='utf-8') as f:
    for k, v in results.items():
        f.write(f'\n=== {k} ===\n{v}\n')
print('Done')
