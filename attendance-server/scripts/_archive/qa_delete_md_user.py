import paramiko, os, json, base64, time

HOST='192.168.100.100'; USER='Teerawat'; PASS=os.environ.get('NAS_PASSWORD', '')
USERS_PATH='/volume1/Teerawat/attendance-backend/data/users.json'

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect(HOST, username=USER, password=PASS)

stdin, stdout, _ = ssh.exec_command(f'cat {USERS_PATH}')
data = json.loads(stdout.read().decode())

before = len(data)
data = [u for u in data if u.get('username') != 'qaverify_md4']
after = len(data)

if before == after:
    print('ERROR: user not found')
else:
    json_str = json.dumps(data, ensure_ascii=False)
    encoded = base64.b64encode(json_str.encode('utf-8')).decode()
    chunk_size = 2000
    chunks = [encoded[i:i+chunk_size] for i in range(0, len(encoded), chunk_size)]
    ssh.exec_command(f'echo "{chunks[0]}" > /tmp/users_b64.txt')
    time.sleep(0.3)
    for chunk in chunks[1:]:
        ssh.exec_command(f'echo "{chunk}" >> /tmp/users_b64.txt')
        time.sleep(0.1)
    time.sleep(0.5)
    ssh.exec_command(f'cat /tmp/users_b64.txt | tr -d "\\n" | base64 -d > {USERS_PATH}')
    time.sleep(0.5)

    # Verify
    stdin2, stdout2, _ = ssh.exec_command(f'cat {USERS_PATH}')
    verify = json.loads(stdout2.read().decode())
    remaining = [u for u in verify if u.get('username') == 'qaverify_md4']
    if not remaining:
        print(f'OK: temp user deleted. users.json now has {len(verify)} users.')
    else:
        print('ERROR: user still present after delete')

ssh.close()
