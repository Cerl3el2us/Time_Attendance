import paramiko, os
HOST='192.168.100.100'; USER='Teerawat'; PASS=os.environ.get('NAS_PASSWORD', '')
ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect(HOST, username=USER, password=PASS)
APP = '/volume1/web/attendance/js/app.js'

results = {}

# Read fmtDate and related functions (lines 2724-2760)
_, out, _ = ssh.exec_command('sed -n "2724,2760p" ' + APP)
results['fmtDate_fn'] = out.read().decode('utf-8', errors='replace')

# Read showApprovalDetail (lines 6076-6170)
_, out, _ = ssh.exec_command('sed -n "6076,6170p" ' + APP)
results['approval_detail_fn'] = out.read().decode('utf-8', errors='replace')

# Check periodLabel (line 1545 context)
_, out, _ = ssh.exec_command('sed -n "1540,1555p" ' + APP)
results['period_label'] = out.read().decode('utf-8', errors='replace')

# Check leave date input lang attribute
_, out, _ = ssh.exec_command('grep -n "lang.*ja\\|html.*lang\\|document.documentElement.lang" /volume1/web/attendance/js/app.js | head -10')
results['html_lang'] = out.read().decode('utf-8', errors='replace').strip()

_, out, _ = ssh.exec_command('grep -n "lang=" /volume1/web/attendance/index.html | head -5')
results['html_lang_attr'] = out.read().decode('utf-8', errors='replace').strip()

ssh.close()
with open(r'C:\Users\tairo\fmtdate_check.txt', 'w', encoding='utf-8') as f:
    for k, v in results.items():
        f.write(f'\n=== {k} ===\n{v}\n')
print('Done')
