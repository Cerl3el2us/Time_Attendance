import paramiko, os
HOST='192.168.100.100'; USER='Teerawat'; PASS=os.environ.get('NAS_PASSWORD', '')
ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect(HOST, username=USER, password=PASS)
APP = '/volume1/web/attendance/js/app.js'

results = {}

# Find leave request modal / leave form
_, out, _ = ssh.exec_command('grep -n "specify the reason\\|reason for leave\\|leave-reason\\|leave-start\\|leave-end" ' + APP + ' | head -20')
results['leave_reason'] = out.read().decode('utf-8', errors='replace').strip()

# Find "will be sent to" / approval message
_, out, _ = ssh.exec_command('grep -n "will be sent to\\|sent.*approval\\|request.*approval" ' + APP + ' | head -10')
results['sent_to'] = out.read().decode('utf-8', errors='replace').strip()

# Find date input placeholders วว/ดด/ปปปป
_, out, _ = ssh.exec_command('grep -n "วว.*ดด\\|placeholder.*date\\|type.*date" ' + APP + ' | head -10')
results['date_placeholder'] = out.read().decode('utf-8', errors='replace').strip()

# Find the leave modal render function
_, out, _ = ssh.exec_command('grep -n "function openLeave\\|function renderLeave\\|leave-modal\\|leaveModal" ' + APP + ' | head -10')
results['leave_fn'] = out.read().decode('utf-8', errors='replace').strip()

ssh.close()
with open(r'C:\Users\tairo\leave_modal_check.txt', 'w', encoding='utf-8') as f:
    for k, v in results.items():
        f.write(f'\n=== {k} ===\n{v}\n')
print('Done')
