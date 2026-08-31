import paramiko, os
HOST='192.168.100.100'; USER='Teerawat'; PASS=os.environ.get('NAS_PASSWORD', '')
ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect(HOST, username=USER, password=PASS)
APP = '/volume1/web/attendance/js/app.js'
_, out, _ = ssh.exec_command('grep -n "function applyLanguage\|function toggleLang" ' + APP)
lns = out.read().decode().strip().split('\n')
for ln_info in lns:
    ln = ln_info.split(':')[0]
    _, out2, _ = ssh.exec_command('sed -n "' + ln + ',' + str(int(ln)+20) + 'p" ' + APP)
    print(ln_info)
    c = out2.read().decode('utf-8', errors='replace')
    with open(r'C:\Users\tairo\check_applylang.txt', 'a', encoding='utf-8') as f:
        f.write(f'=== {ln_info} ===\n{c}\n\n')
ssh.close()
print('Done')
