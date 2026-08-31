import paramiko, os
HOST='192.168.100.100'; USER='Teerawat'; PASS=os.environ.get('NAS_PASSWORD', '')
ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect(HOST, username=USER, password=PASS)
APP = '/volume1/web/attendance/js/app.js'

sections = {}

# Lines around 2344 (roleLabels in some function)
_, out, _ = ssh.exec_command(f'sed -n "2330,2360p" ' + APP)
sections['context_2344'] = out.read().decode('utf-8', errors='replace')

# Lines around 3924 (roleLabels in some function)
_, out, _ = ssh.exec_command(f'sed -n "3910,3950p" ' + APP)
sections['context_3924'] = out.read().decode('utf-8', errors='replace')

# emp-role select full HTML (lines around 8975-9010)
_, out, _ = ssh.exec_command(f'sed -n "8970,9010p" ' + APP)
sections['emp_role_select'] = out.read().decode('utf-8', errors='replace')

# i18n.ja section (should be near i18n.en/th which are at lines ~25-200)
_, out, _ = ssh.exec_command(f'sed -n "200,280p" ' + APP)
sections['i18n_ja'] = out.read().decode('utf-8', errors='replace')

# Check if i18n.ja has role_md etc.
_, out, _ = ssh.exec_command('grep -n "i18n.ja\|LANG_JA\[.role" ' + APP + ' | head -20')
sections['i18n_ja_refs'] = out.read().decode('utf-8', errors='replace').strip()

# renderMyProfile function
_, out, _ = ssh.exec_command('grep -n "function renderMyProfile\|function renderSidebar\|function refreshUserInfo" ' + APP)
sections['render_fns'] = out.read().decode('utf-8', errors='replace').strip()

ssh.close()
with open(r'C:\Users\tairo\read_bugs2.txt', 'w', encoding='utf-8') as f:
    for k, v in sections.items():
        f.write(f'\n{"="*60}\n{k}\n{"="*60}\n{v}\n')
print('Done')
