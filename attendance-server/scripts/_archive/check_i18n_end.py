import paramiko, os
HOST='192.168.100.100'; USER='Teerawat'; PASS=os.environ.get('NAS_PASSWORD', '')
ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect(HOST, username=USER, password=PASS)
APP = '/volume1/web/attendance/js/app.js'
_, out, _ = ssh.exec_command('sed -n "205,222p" ' + APP)
content = out.read().decode('utf-8', errors='replace')
ssh.close()
with open(r'C:\Users\tairo\check_i18n_end.txt', 'w', encoding='utf-8') as f:
    f.write(content)
print('Done')
