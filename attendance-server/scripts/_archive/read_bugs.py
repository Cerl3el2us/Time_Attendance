import paramiko, os
HOST='192.168.100.100'; USER='Teerawat'; PASS=os.environ.get('NAS_PASSWORD', '')
ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect(HOST, username=USER, password=PASS)
APP = '/volume1/web/attendance/js/app.js'

sections = {}

# 1. openEditMyProfile full function
_, out, _ = ssh.exec_command('grep -n "function openEditMyProfile" ' + APP)
ln = int(out.read().decode().strip().split(':')[0])
_, out, _ = ssh.exec_command(f'sed -n "{ln},{ln+30}p" ' + APP)
sections['openEditMyProfile'] = f'line {ln}:\n' + out.read().decode('utf-8', errors='replace')

# 2. roleLabels in renderEmployeesTable
_, out, _ = ssh.exec_command('grep -n "roleLabels\|role_labels\|Managing Director\|Level 1" ' + APP)
sections['roleLabels_all'] = out.read().decode('utf-8', errors='replace').strip()

# 3. fixStaticText function
_, out, _ = ssh.exec_command('grep -n "function fixStaticText" ' + APP)
ln2 = int(out.read().decode().strip().split(':')[0])
_, out, _ = ssh.exec_command(f'sed -n "{ln2},{ln2+40}p" ' + APP)
sections['fixStaticText'] = f'line {ln2}:\n' + out.read().decode('utf-8', errors='replace')

# 4. renderEmployeesTable roleLabels context
_, out, _ = ssh.exec_command('grep -n "function renderEmployeesTable" ' + APP)
ln3 = int(out.read().decode().strip().split(':')[0])
_, out, _ = ssh.exec_command(f'sed -n "{ln3},{ln3+80}p" ' + APP)
sections['renderEmployeesTable'] = f'line {ln3}:\n' + out.read().decode('utf-8', errors='replace')

# 5. role dropdown in emp-modal (select#emp-role options)
_, out, _ = ssh.exec_command('grep -n "emp-role\|option.*Level\|option.*Managing\|option.*Driver" ' + APP)
sections['emp_role_options'] = out.read().decode('utf-8', errors='replace').strip()

# 6. openEmployeeProfile roleLabels
_, out, _ = ssh.exec_command('grep -n "function openEmployeeProfile" ' + APP)
ln4 = int(out.read().decode().strip().split(':')[0])
_, out, _ = ssh.exec_command(f'sed -n "{ln4},{ln4+60}p" ' + APP)
sections['openEmployeeProfile'] = f'line {ln4}:\n' + out.read().decode('utf-8', errors='replace')

ssh.close()
with open(r'C:\Users\tairo\read_bugs.txt', 'w', encoding='utf-8') as f:
    for k, v in sections.items():
        f.write(f'\n{"="*60}\n{k}\n{"="*60}\n{v}\n')
print('Done')
