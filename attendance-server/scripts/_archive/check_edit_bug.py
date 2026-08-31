import paramiko, os
HOST='192.168.100.100'; USER='Teerawat'; PASS=os.environ.get('NAS_PASSWORD', '')
ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect(HOST, username=USER, password=PASS)
APP = '/volume1/web/attendance/js/app.js'

results = {}

# 1. blockIfObserver inside openEditEmployee?
_, out, _ = ssh.exec_command('grep -n "blockIfObserver" ' + APP)
results['blockIfObserver_calls'] = out.read().decode('utf-8', errors='replace').strip()

# 2. saveEmployee blockIfObserver?
_, out, _ = ssh.exec_command('grep -n "function saveEmployee" ' + APP)
ln = out.read().decode().strip().split(':')[0]
if ln:
    _, out, _ = ssh.exec_command('sed -n "' + ln + ',' + str(int(ln)+10) + 'p" ' + APP)
    results['saveEmployee_start'] = 'line ' + ln + ':\n' + out.read().decode('utf-8', errors='replace')

# 3. driver role in openEditEmployee
_, out, _ = ssh.exec_command('grep -n "emp-guaranteed-ot\|emp-longdistance" ' + APP)
results['driver_fields'] = out.read().decode('utf-8', errors='replace').strip()

# 4. Does the profile modal "edit" button get rebuilt with right ID each time?
_, out, _ = ssh.exec_command('grep -n "closeProfileModal.*openEditEmployee\|情報を編集\|Edit Info" ' + APP)
results['profile_edit_btn'] = out.read().decode('utf-8', errors='replace').strip()

# 5. marketing role check in openEditMyProfile
_, out, _ = ssh.exec_command('grep -n "function openEditMyProfile\|marketing" ' + APP + ' | head -20')
results['openEditMyProfile'] = out.read().decode('utf-8', errors='replace').strip()

ssh.close()
with open(r'C:\Users\tairo\check_edit_bug.txt', 'w', encoding='utf-8') as f:
    for k, v in results.items():
        f.write(f'=== {k} ===\n{v}\n\n')
print('Done')
