import paramiko, os
HOST='192.168.100.100'; USER='Teerawat'; PASS=os.environ.get('NAS_PASSWORD', '')
ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect(HOST, username=USER, password=PASS)
APP = '/volume1/web/attendance/js/app.js'

results = {}

# Line 688 context
_, out, _ = ssh.exec_command('sed -n "680,700p" ' + APP)
results['line688_ctx'] = out.read().decode('utf-8', errors='replace')

# Lines 3455-3475 (hardcoded Early Morning / Late Night in detail view)
_, out, _ = ssh.exec_command('sed -n "3455,3480p" ' + APP)
results['line3462_ctx'] = out.read().decode('utf-8', errors='replace')

# Reports table TH header code
_, out, _ = ssh.exec_command('grep -n "rpt_early\\|rpt_latenight\\|col-hide-mobile" ' + APP + ' | head -15')
results['reports_th'] = out.read().decode('utf-8', errors='replace').strip()

# Find where Early Morning/Late Night used in reports render
_, out, _ = ssh.exec_command('grep -n "function renderReports\\|function renderMonthly" ' + APP)
results['reports_fn'] = out.read().decode('utf-8', errors='replace').strip()

# Payslip early morning detail line
_, out, _ = ssh.exec_command('sed -n "5186,5195p" ' + APP)
results['payslip_early'] = out.read().decode('utf-8', errors='replace')

# Check if 'Accounting' (plain) is in ja.js
_, out, _ = ssh.exec_command('grep -c "\"Accounting\"" /volume1/web/attendance/lang/ja.js')
results['ja_accounting'] = out.read().decode('utf-8', errors='replace').strip()

ssh.close()
with open(r'C:\Users\tairo\final_check.txt', 'w', encoding='utf-8') as f:
    for k, v in results.items():
        f.write(f'\n=== {k} ===\n{v}\n')
print('Done')
