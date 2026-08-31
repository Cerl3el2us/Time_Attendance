import paramiko, os
HOST='192.168.100.100'; USER='Teerawat'; PASS=os.environ.get('NAS_PASSWORD', '')
ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect(HOST, username=USER, password=PASS)
APP  = '/volume1/web/attendance/js/app.js'
HTML = '/volume1/web/attendance/index.html'
JA   = '/volume1/web/attendance/lang/ja.js'

results = {}

_, out, _ = ssh.exec_command("grep -c \"role !== 'driver'\" " + APP)
results['P1_driver_bug_fixed'] = out.read().decode().strip()

_, out, _ = ssh.exec_command("grep -c \"role_marketing\" " + APP)
results['P2_role_marketing_in_app'] = out.read().decode().strip()

_, out, _ = ssh.exec_command("grep -c \"t('role_md')\" " + APP)
results['P3_t_role_md_count'] = out.read().decode().strip()

_, out, _ = ssh.exec_command("grep -c \"md:'Managing Director'\" " + APP)
results['P3_old_hardcoded_remain'] = out.read().decode().strip()

_, out, _ = ssh.exec_command("grep -n 'option.*Level' " + HTML)
results['H1_emp_options'] = out.read().decode('utf-8', errors='replace').strip()

_, out, _ = ssh.exec_command("grep -n 'Level 1\|Level 2\|Level 3' " + JA + " | head -10")
results['JA_level'] = out.read().decode('utf-8', errors='replace').strip()

_, out, _ = ssh.exec_command("grep -o 'app.js?v=[^\"]*' " + HTML)
results['version'] = out.read().decode().strip()

ssh.close()
with open('/c/Users/tairo/verify_patch.txt', 'w', encoding='utf-8') as f:
    for k, v in results.items():
        f.write(f'\n=== {k} ===\n{v}\n')
print('Done')
