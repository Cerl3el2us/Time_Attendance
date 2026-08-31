import paramiko, os
HOST='192.168.100.100'; USER='Teerawat'; PASS=os.environ.get('NAS_PASSWORD', '')
ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect(HOST, username=USER, password=PASS)
APP = '/volume1/web/attendance/js/app.js'

results = {}

# Find _monthShort and _monthNames functions
_, out, _ = ssh.exec_command('grep -n "_monthShort\\|_monthNames\\|function _month" ' + APP + ' | head -10')
results['month_fn'] = out.read().decode('utf-8', errors='replace').strip()

# Read them (search around line 2700-2725)
_, out, _ = ssh.exec_command('sed -n "2700,2730p" ' + APP)
results['month_fn_code'] = out.read().decode('utf-8', errors='replace')

# Check fmtDate line 3 vs 326 context (lang setting)
_, out, _ = ssh.exec_command('sed -n "1,10p" ' + APP)
results['line3'] = out.read().decode('utf-8', errors='replace')

_, out, _ = ssh.exec_command('sed -n "320,335p" ' + APP)
results['line326'] = out.read().decode('utf-8', errors='replace')

# Check submittedAt usage in approval detail
_, out, _ = ssh.exec_command('grep -n "submittedAt\\|approvedAt" ' + APP + ' | head -15')
results['submitted_at'] = out.read().decode('utf-8', errors='replace').strip()

# periodLabel in payslip (line 1545)
_, out, _ = ssh.exec_command('sed -n "1542,1548p" ' + APP)
results['period_label_code'] = out.read().decode('utf-8', errors='replace')

ssh.close()
with open(r'C:\Users\tairo\monthfn_check.txt', 'w', encoding='utf-8') as f:
    for k, v in results.items():
        f.write(f'\n=== {k} ===\n{v}\n')
print('Done')
