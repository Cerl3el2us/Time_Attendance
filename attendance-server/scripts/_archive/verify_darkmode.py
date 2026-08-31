import paramiko, os
HOST='192.168.100.100'; USER='Teerawat'; PASS=os.environ.get('NAS_PASSWORD', '')
ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect(HOST, username=USER, password=PASS)

# Check ja.js for Dark Mode / Light Mode entries
_, out, _ = ssh.exec_command('grep -n "Dark Mode\\|Light Mode\\|Early Morning" /volume1/web/attendance/lang/ja.js')
r1 = out.read().decode('utf-8', errors='replace').strip()

# Check app.js dark mode line
_, out, _ = ssh.exec_command('grep -n "lbl.textContent.*isDark" /volume1/web/attendance/js/app.js')
r2 = out.read().decode('utf-8', errors='replace').strip()

# Check index.html version
_, out, _ = ssh.exec_command('grep -o "app.js?v=[0-9a-z]*" /volume1/web/attendance/index.html | head -3')
r3 = out.read().decode('utf-8', errors='replace').strip()

ssh.close()
with open(r'C:\Users\tairo\verify_darkmode.txt', 'w', encoding='utf-8') as f:
    f.write(f'=== ja.js Dark/Light/Early ===\n{r1}\n\n=== app.js dark toggle ===\n{r2}\n\n=== index.html version ===\n{r3}\n')
print('Done')
