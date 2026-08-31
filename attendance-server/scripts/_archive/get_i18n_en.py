import paramiko, os

HOST='192.168.100.100'; USER='Teerawat'; PASS=os.environ.get('NAS_PASSWORD', '')
ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect(HOST, username=USER, password=PASS)
APP = '/volume1/web/attendance/js/app.js'

# Get i18n from line 4 to ~220 (should include both th and en sections)
_, out, _ = ssh.exec_command(f'sed -n "4,220p" {APP}')
content = out.read().decode('utf-8', errors='replace')
ssh.close()

with open(r'C:\Users\tairo\i18n_full.txt', 'w', encoding='utf-8') as f:
    f.write(content)
print('Done')
