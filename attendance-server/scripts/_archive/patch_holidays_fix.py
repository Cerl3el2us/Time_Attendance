import paramiko, os, time, base64

REMOTE = '/volume1/Teerawat/attendance-backend/server.js'
NODE   = '/volume1/@appstore/Node.js_v22/usr/local/bin/node'

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect('192.168.100.100', port=22, username='Teerawat', password=os.environ.get('NAS_PASSWORD', ''), timeout=10)
print('[SSH] connected')

_, out, _ = client.exec_command(f'cat {REMOTE}')
src = out.read().decode('utf-8')
print(f'[READ] {len(src)} bytes')

OLD = "app.post('/api/holidays', (req, res) => {\n  const { date, name } = req.body;"
NEW = "app.post('/api/holidays', (req, res) => {\n  const { date, name } = parseBody(req);"

if OLD in src:
    src = src.replace(OLD, NEW)
    print('[PATCH] Fixed req.body -> parseBody(req)')
elif 'parseBody(req)' in src and "app.post('/api/holidays'" in src:
    print('[SKIP] Already patched')
else:
    print('[ERROR] Pattern not found')
    client.close()
    exit(1)

# Write via base64
encoded = base64.b64encode(src.encode('utf-8')).decode('ascii')
chunk_size = 10000
chunks = [encoded[i:i+chunk_size] for i in range(0, len(encoded), chunk_size)]
_, out, err = client.exec_command(f'echo "{chunks[0]}" > /tmp/srv_b64.txt')
out.read(); err.read()
for chunk in chunks[1:]:
    _, out, err = client.exec_command(f'echo "{chunk}" >> /tmp/srv_b64.txt')
    out.read(); err.read()
_, out, err = client.exec_command(f'base64 -d /tmp/srv_b64.txt > {REMOTE} && echo OK')
print('[WRITE]', out.read().decode().strip())

# Restart
_, out, _ = client.exec_command('kill $(ps aux | grep "node server.js" | grep -v grep | awk \'{print $2}\') 2>/dev/null; echo done')
print('[KILL]', out.read().decode().strip())
time.sleep(3)
cmd = f'cd /volume1/Teerawat/attendance-backend && HOME=/volume1/Teerawat nohup {NODE} server.js > server.log 2>&1 & echo pid:$!'
_, out, _ = client.exec_command(cmd)
print('[START]', out.read().decode().strip())
time.sleep(4)
_, out, _ = client.exec_command('ps aux | grep "node server.js" | grep -v grep')
print('[VERIFY]', out.read().decode().strip())
client.close()
print('[DONE]')
