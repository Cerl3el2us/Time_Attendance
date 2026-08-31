import paramiko, os
HOST='192.168.100.100'; USER='Teerawat'; PASS=os.environ.get('NAS_PASSWORD', '')
ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect(HOST, username=USER, password=PASS)
HTML = '/volume1/web/attendance/index.html'
APP  = '/volume1/web/attendance/js/app.js'

sections = {}

# Find emp-role select in index.html
_, out, _ = ssh.exec_command('grep -n "emp-role\\|emp-modal" ' + HTML + ' | head -30')
sections['html_emp_role'] = out.read().decode('utf-8', errors='replace').strip()

# Find lines around emp-modal in HTML
_, out, _ = ssh.exec_command('grep -n "id=\"emp-modal\"" ' + HTML)
ln = out.read().decode('utf-8', errors='replace').strip()
sections['emp_modal_line'] = ln

# Find emp-role select options in app.js (maybe it's in a template string)
_, out, _ = ssh.exec_command('grep -n "emp-role.*option\\|option.*emp-role\\|select.*emp-role" ' + APP)
sections['app_emp_role_template'] = out.read().decode('utf-8', errors='replace').strip()

# Lines 8850-8870 (openEditEmployee template generation area)
_, out, _ = ssh.exec_command(f'sed -n "8840,8870p" ' + APP)
sections['app_8840_8870'] = out.read().decode('utf-8', errors='replace')

# Also check if there is a buildEmpModal or similar function
_, out, _ = ssh.exec_command('grep -n "function buildEmpModal\\|function openNewEmployee\\|function setupEmpModal\\|emp-modal.*innerHTML" ' + APP)
sections['emp_modal_builder'] = out.read().decode('utf-8', errors='replace').strip()

ssh.close()
with open(r'C:\Users\tairo\read_html_emp_role.txt', 'w', encoding='utf-8') as f:
    for k, v in sections.items():
        f.write(f'\n{"="*60}\n{k}\n{"="*60}\n{v}\n')
print('Done')
