import paramiko, os, time, base64

REMOTE = '/volume1/Teerawat/attendance-backend/server.js'
NODE = '/volume1/@appstore/Node.js_v22/usr/local/bin/node'

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect('192.168.100.100', port=22, username='Teerawat', password=os.environ.get('NAS_PASSWORD', ''), timeout=10)

_, out, _ = client.exec_command(f'cat {REMOTE}')
src = out.read().decode('utf-8')
print(f'[READ] {len(src)} bytes')

OLD = """app.get('/api/exchange-rate', (req, res) => {
  const TTL = 60 * 60 * 1000;
  const now = Date.now();
  if (_exRateCache.data && (now - _exRateCache.ts) < TTL) return res.json(_exRateCache.data);"""

NEW = """app.get('/api/exchange-rate', (req, res) => {
  const now = Date.now();
  // 60-second dedup cache — prevents hammering SMBC when multiple users open dashboard simultaneously
  if (_exRateCache.data && (now - _exRateCache.ts) < 60000) return res.json(_exRateCache.data);"""

if OLD in src:
    src = src.replace(OLD, NEW)
    print('[PATCH] Cache changed from 1 hour to 60 seconds')
elif '60-second dedup cache' in src:
    print('[SKIP] Already patched')
else:
    print('[ERROR] Pattern not found')

encoded = base64.b64encode(src.encode('utf-8')).decode('ascii')
chunks = [encoded[i:i+10000] for i in range(0, len(encoded), 10000)]
_, out, _ = client.exec_command(f'echo "{chunks[0]}" > /tmp/srv_b64.txt')
out.read()
for chunk in chunks[1:]:
    _, out, _ = client.exec_command(f'echo "{chunk}" >> /tmp/srv_b64.txt')
    out.read()
_, out, err = client.exec_command(f'base64 -d /tmp/srv_b64.txt > {REMOTE} && echo OK')
print('[WRITE]', out.read().decode().strip())

_, out, _ = client.exec_command('kill $(ps aux | grep "node server.js" | grep -v grep | awk \'{print $2}\') 2>/dev/null; echo done')
print('[KILL]', out.read().decode().strip())
time.sleep(3)
_, out, _ = client.exec_command(f'cd /volume1/Teerawat/attendance-backend && HOME=/volume1/Teerawat nohup {NODE} server.js > server.log 2>&1 & echo pid:$!')
print('[START]', out.read().decode().strip())
time.sleep(4)
_, out, _ = client.exec_command('ps aux | grep "node server.js" | grep -v grep')
print('[VERIFY]', out.read().decode().strip())
client.close()
print('[DONE]')
