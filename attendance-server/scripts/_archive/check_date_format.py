import paramiko, os
HOST='192.168.100.100'; USER='Teerawat'; PASS=os.environ.get('NAS_PASSWORD', '')
ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect(HOST, username=USER, password=PASS)
APP = '/volume1/web/attendance/js/app.js'

results = {}

# Find date formatting functions
_, out, _ = ssh.exec_command('grep -n "function.*[Ff]ormat.*[Dd]ate\\|function.*[Dd]ate.*[Ff]ormat\\|fmtDate\\|formatDate\\|toLocaleDateString\\|Intl.DateTimeFormat" ' + APP + ' | head -20')
results['fmt_fn'] = out.read().decode('utf-8', errors='replace').strip()

# Find how 7月 is generated (month display)
_, out, _ = ssh.exec_command('grep -n "7月\\|月.*年\\|日.*月\\|toLocale\\|new Date.*locale" ' + APP + ' | head -20')
results['month_ja'] = out.read().decode('utf-8', errors='replace').strip()

# Find the approval detail modal render / correction detail modal
_, out, _ = ssh.exec_command('grep -n "function.*[Aa]pproval.*[Dd]etail\\|申請済み\\|申請者情報\\|correction.*detail\\|openApproval" ' + APP + ' | head -15')
results['approval_detail'] = out.read().decode('utf-8', errors='replace').strip()

# Find input type="date" in HTML
_, out, _ = ssh.exec_command('grep -n "type.*date\\|input.*date" /volume1/web/attendance/index.html | head -15')
results['date_inputs'] = out.read().decode('utf-8', errors='replace').strip()

ssh.close()
with open(r'C:\Users\tairo\date_format_check.txt', 'w', encoding='utf-8') as f:
    for k, v in results.items():
        f.write(f'\n=== {k} ===\n{v}\n')
print('Done')
