import paramiko, os
HOST='192.168.100.100'; USER='Teerawat'; PASS=os.environ.get('NAS_PASSWORD', '')
ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect(HOST, username=USER, password=PASS)
APP = '/volume1/web/attendance/js/app.js'

results = {}
# applyStaticI18n
_, out, _ = ssh.exec_command('grep -n "function applyStaticI18n" ' + APP)
ln = out.read().decode().strip().split(':')[0]
_, out, _ = ssh.exec_command('sed -n "' + ln + ',' + str(int(ln)+14) + 'p" ' + APP)
results['applyStaticI18n'] = 'line ' + ln + ':\n' + out.read().decode('utf-8', errors='replace')

# sidebar button line ~8202
_, out, _ = ssh.exec_command('grep -n "_lb.textContent" ' + APP)
results['sidebar_btn'] = out.read().decode('utf-8', errors='replace')

# applyLanguage html lang line
_, out, _ = ssh.exec_command("grep -n \"documentElement.lang\" " + APP)
results['lang_attr'] = out.read().decode('utf-8', errors='replace')

ssh.close()
with open(r'C:\Users\tairo\check_funcs.txt', 'w', encoding='utf-8') as f:
    for k, v in results.items():
        f.write(f'=== {k} ===\n{v}\n\n')
print('Done')
