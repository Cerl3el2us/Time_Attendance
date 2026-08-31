import paramiko, os
HOST='192.168.100.100'; USER='Teerawat'; PASS=os.environ.get('NAS_PASSWORD', '')
ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect(HOST, username=USER, password=PASS)
APP = '/volume1/web/attendance/js/app.js'

# Read renderReports header area
_, out, _ = ssh.exec_command('sed -n "4508,4580p" ' + APP)
content = out.read().decode('utf-8', errors='replace')
ssh.close()
with open(r'C:\Users\tairo\reports_th.txt', 'w', encoding='utf-8') as f:
    f.write(content)
print('Done')
