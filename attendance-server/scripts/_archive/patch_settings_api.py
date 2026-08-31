import paramiko, os, time, base64, json

HOST   = '192.168.100.100'
USER   = 'Teerawat'
PASS   = os.environ.get('NAS_PASSWORD', '')
REMOTE = '/volume1/Teerawat/attendance-backend/server.js'
DATA   = '/volume1/Teerawat/attendance-backend/data/settings.json'
NODE   = '/volume1/@appstore/Node.js_v22/usr/local/bin/node'

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, port=22, username=USER, password=PASS, timeout=10)
print('[SSH] connected')

# Read server.js
_, out, _ = client.exec_command(f'cat {REMOTE}')
src = out.read().decode('utf-8')
print(f'[READ] {len(src)} bytes')

MARKER = "// GET /api/settings"

if MARKER in src:
    print('[SKIP] Settings API already patched')
else:
    # Find insertion point: after holidays DELETE endpoint
    INSERT_AFTER = "app.delete('/api/holidays/:id'"
    idx = src.find(INSERT_AFTER)
    if idx == -1:
        print('[ERROR] Cannot find insertion point')
        client.close()
        exit(1)

    # Find end of that block (closing });)
    end_idx = src.find('\n});', idx)
    if end_idx == -1:
        print('[ERROR] Cannot find end of holidays delete block')
        client.close()
        exit(1)

    insert_at = end_idx + len('\n});')

    SETTINGS_API = """

// GET /api/settings
app.get('/api/settings', (req, res) => {
  const settings = readJSON('settings.json', {});
  res.json(settings);
});

// PUT /api/settings
app.put('/api/settings', (req, res) => {
  const body = parseBody(req);
  if (!body || typeof body !== 'object') {
    return res.status(400).json({ success: false, message: 'invalid body' });
  }
  const current = readJSON('settings.json', {});
  const updated = Object.assign({}, current, body);
  writeJSON('settings.json', updated);
  res.json({ success: true, settings: updated });
});"""

    src = src[:insert_at] + SETTINGS_API + src[insert_at:]
    print('[PATCH] Added GET+PUT /api/settings')

    # Write back via base64
    encoded = base64.b64encode(src.encode('utf-8')).decode('ascii')
    chunk_size = 10000
    chunks = [encoded[i:i+chunk_size] for i in range(0, len(encoded), chunk_size)]
    client.exec_command(f'echo "{chunks[0]}" > /tmp/srv_b64.txt')[1].read()
    for chunk in chunks[1:]:
        client.exec_command(f'echo "{chunk}" >> /tmp/srv_b64.txt')[1].read()
    _, out, _ = client.exec_command(f'base64 -d /tmp/srv_b64.txt > {REMOTE} && echo OK')
    print('[WRITE]', out.read().decode().strip())

# Create default settings.json if not exists
_, out, _ = client.exec_command(f'test -f {DATA} && echo EXISTS || echo MISSING')
exists = out.read().decode().strip()
if exists == 'MISSING':
    default_settings = json.dumps({
        "approvalRouting": {
            "annual": False,
            "sick": False,
            "business": False,
            "offsite": False,
            "late-out": False,
            "time-correction": False,
            "ot": False,
            "comp": False
        }
    }, indent=2)
    encoded = base64.b64encode(default_settings.encode('utf-8')).decode('ascii')
    client.exec_command(f'echo "{encoded}" | base64 -d > {DATA} && echo OK')[1].read()
    print('[CREATE] data/settings.json with defaults')
else:
    print('[SKIP] data/settings.json already exists')

# Restart Node
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
