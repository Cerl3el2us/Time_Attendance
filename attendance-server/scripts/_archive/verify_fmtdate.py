import paramiko, os
HOST='192.168.100.100'; USER='Teerawat'; PASS=os.environ.get('NAS_PASSWORD', '')
ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect(HOST, username=USER, password=PASS)
APP = '/volume1/web/attendance/js/app.js'

_, out, _ = ssh.exec_command('grep -n "fmtDate\|_fmtDtStr\|年.*月.*日\|periodLabel" ' + APP + ' | grep -v "//\|fmtDateTime\|fmtDateL\|fmtDateS\|fmtDateF" | head -20')
r1 = out.read().decode('utf-8', errors='replace').strip()

_, out, _ = ssh.exec_command('sed -n "2724,2745p" ' + APP)
r2 = out.read().decode('utf-8', errors='replace')

_, out, _ = ssh.exec_command('grep -o "app.js?v=[0-9a-z]*" /volume1/web/attendance/index.html | head -2')
r3 = out.read().decode('utf-8', errors='replace').strip()

# Check _fmtDtStr added
_, out, _ = ssh.exec_command('grep -n "_fmtDtStr" ' + APP + ' | head -10')
r4 = out.read().decode('utf-8', errors='replace').strip()

ssh.close()
with open(r'C:\Users\tairo\verify_fmtdate.txt', 'w', encoding='utf-8') as f:
    f.write(f'=== fmtDate function ===\n{r2}\n\n=== matches ===\n{r1}\n\n=== version ===\n{r3}\n\n=== _fmtDtStr ===\n{r4}\n')
print('Done')
