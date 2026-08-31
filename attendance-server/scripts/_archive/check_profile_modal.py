import paramiko, os
HOST='192.168.100.100'; USER='Teerawat'; PASS=os.environ.get('NAS_PASSWORD', '')
ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect(HOST, username=USER, password=PASS)
APP = '/volume1/web/attendance/js/app.js'

# openEmployeeProfile function - lines around 4220-4250
_, out, _ = ssh.exec_command('grep -n "function openEmployeeProfile" ' + APP)
ln = int(out.read().decode().strip().split(':')[0])
_, out, _ = ssh.exec_command('sed -n "' + str(ln) + ',' + str(ln+25) + 'p" ' + APP)
content = out.read().decode('utf-8', errors='replace')

# Also check openEditMyProfile full function
_, out, _ = ssh.exec_command('sed -n "4047,4080p" ' + APP)
open_edit_my = out.read().decode('utf-8', errors='replace')

ssh.close()
with open(r'C:\Users\tairo\check_profile_modal.txt', 'w', encoding='utf-8') as f:
    f.write('=== openEmployeeProfile start ===\nline ' + str(ln) + ':\n' + content)
    f.write('\n=== openEditMyProfile ===\n' + open_edit_my)
print('Done')
