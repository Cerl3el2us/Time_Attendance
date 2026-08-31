import paramiko, os, json, base64, time

HOST='192.168.100.100'; USER='Teerawat'; PASS=os.environ.get('NAS_PASSWORD', '')
USERS_PATH='/volume1/Teerawat/attendance-backend/data/users.json'

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect(HOST, username=USER, password=PASS)

# Read current users.json
stdin, stdout, stderr = ssh.exec_command(f'cat {USERS_PATH}')
data = json.loads(stdout.read().decode())

# Check if temp user already exists
existing = [u for u in data if u.get('username') == 'qaverify_md4']
if existing:
    print(f'TEST USER ALREADY EXISTS (id={existing[0]["id"]})')
else:
    max_id = max(u['id'] for u in data)
    new_user = {
        "id": max_id + 1,
        "employeeNo": "qa4",
        "username": "qaverify_md4",
        "password": "QaTest123",
        "name": "QA Verify MD4",
        "role": "md",
        "active": True,
        "position": "QA Tester",
        "email": "",
        "annualLeave": 0,
        "transport": 0,
        "salary": 0
    }
    data.append(new_user)

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
    cmd = f'cat /tmp/users_b64.txt | tr -d "\\n" | base64 -d > {USERS_PATH}'
    stdin, stdout, stderr = ssh.exec_command(cmd)
    time.sleep(0.5)
    err = stderr.read().decode()

    # Verify
    stdin2, stdout2, _ = ssh.exec_command(f'cat {USERS_PATH}')
    verify = json.loads(stdout2.read().decode())
    found = [u for u in verify if u.get('username') == 'qaverify_md4']
    if found:
        print(f'OK: temp user created (id={found[0]["id"]})')
    else:
        print(f'ERROR: user not found after write. err={err}')

ssh.close()
