import paramiko, os
HOST='192.168.100.100'; USER='Teerawat'; PASS=os.environ.get('NAS_PASSWORD', '')
ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect(HOST, username=USER, password=PASS)
APP = '/volume1/web/attendance/js/app.js'

_, out, _ = ssh.exec_command("grep -n \"localStorage\" " + APP + " | head -40")
r = out.read().decode('utf-8', errors='replace').strip()
ssh.close()
with open(r'C:\Users\tairo\localstorage_keys.txt', 'w', encoding='utf-8') as f:
    f.write(r)
print('Done')
