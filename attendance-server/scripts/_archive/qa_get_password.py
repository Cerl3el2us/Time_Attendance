import paramiko, os, json

HOST='192.168.100.100'; USER='Teerawat'; PASS=os.environ.get('NAS_PASSWORD', '')
USERS_PATH='/volume1/Teerawat/attendance-backend/data/users.json'

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect(HOST, username=USER, password=PASS)

stdin, stdout, _ = ssh.exec_command(f'cat {USERS_PATH}')
data = json.loads(stdout.read().decode())

for u in data:
    if u.get('role') == 'accounting':
        print(f"username: {u['username']}, password: {u.get('password','(hashed)')[:20]}, active: {u.get('active')}")

ssh.close()
