import paramiko, os, time
HOST='192.168.100.100'; USER='Teerawat'; PASS=os.environ.get('NAS_PASSWORD', '')
ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect(HOST, username=USER, password=PASS)
NODE = '/volume1/@appstore/Node.js_v22/usr/local/bin/node'
APP  = '/volume1/web/attendance/js/app.js'
_, out, err = ssh.exec_command(NODE + ' --check ' + APP)
time.sleep(4)
o = out.read().decode('utf-8', errors='replace').strip()
e = err.read().decode('utf-8', errors='replace').strip()
ssh.close()
result = (o + '\n' + e).strip()
with open(r'C:\Users\tairo\syntax_check.txt', 'w', encoding='utf-8') as f:
    f.write(result or 'OK - no syntax errors')
print(result or 'OK')
