import paramiko, os
HOST='192.168.100.100'; USER='Teerawat'; PASS=os.environ.get('NAS_PASSWORD', '')
ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect(HOST, username=USER, password=PASS)
HTML = '/volume1/web/attendance/index.html'

_, out, _ = ssh.exec_command(f'sed -n "1670,1700p" ' + HTML)
content = out.read().decode('utf-8', errors='replace')

ssh.close()
with open(r'C:\Users\tairo\html_options.txt', 'w', encoding='utf-8') as f:
    f.write(content)
print('Done')
