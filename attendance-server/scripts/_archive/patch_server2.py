import paramiko, os, time, base64

REMOTE = '/volume1/Teerawat/attendance-backend/server.js'
NODE = '/volume1/@appstore/Node.js_v22/usr/local/bin/node'

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect('192.168.100.100', port=22, username='Teerawat', password=os.environ.get('NAS_PASSWORD', ''), timeout=10)
print('[SSH] connected')

# Read current file
_, out, _ = client.exec_command(f'cat {REMOTE}')
src = out.read().decode('utf-8')
print(f'[READ] {len(src)} bytes')

EXCHANGE_CACHE = '''
// ===== EXCHANGE RATE API =====
let _exRateCache = { data: null, ts: 0 };
'''

EXCHANGE_ENDPOINT = r"""
app.get('/api/exchange-rate', (req, res) => {
  const TTL = 60 * 60 * 1000;
  const now = Date.now();
  if (_exRateCache.data && (now - _exRateCache.ts) < TTL) return res.json(_exRateCache.data);
  const https = require('https');
  const opts = { hostname:'www.smbctb.co.jp', path:'/common/xml/FX_INT.xml',
    headers:{'User-Agent':'Mozilla/5.0 (compatible)'} };
  https.get(opts, (resp) => {
    let xml = '';
    resp.on('data', c => xml += c);
    resp.on('end', () => {
      try {
        const thbM = xml.match(/タイバーツ \(THB\)<\/col>\s*<col[^>]*>([\d.]+)<\/col>\s*<col[^>]*>([\d.]+)<\/col>\s*<col[^>]*>([\d.]+)<\/col>/);
        const timeM = xml.match(/<caption>現在 : ([^<]+)<\/caption>/);
        if (!thbM) return res.status(500).json({ error:'THB not found' });
        const data = { tts:parseFloat(thbM[1]), mid:parseFloat(thbM[2]), ttb:parseFloat(thbM[3]),
          smbcUpdatedAt: timeM ? timeM[1].trim() : '', fetchedAt: new Date().toISOString() };
        _exRateCache = { data, ts: now };
        res.json(data);
      } catch(e) { res.status(500).json({ error:e.message }); }
    });
  }).on('error', e => res.status(500).json({ error:e.message }));
});
"""

if '// ===== EXCHANGE RATE API =====' not in src:
    src = src.replace(
        '// ===== LEAVES API =====',
        EXCHANGE_CACHE + '\n// ===== LEAVES API ====='
    )
    src = src.replace(
        "app.use(express.static('/volume1/web/attendance'));",
        EXCHANGE_ENDPOINT + "\napp.use(express.static('/volume1/web/attendance'));"
    )
    print('[PATCH] Exchange rate code added')
else:
    print('[SKIP] Already patched')

# Write via base64
encoded = base64.b64encode(src.encode('utf-8')).decode('ascii')
# Split into chunks to avoid command line length limits
chunk_size = 10000
chunks = [encoded[i:i+chunk_size] for i in range(0, len(encoded), chunk_size)]

# Write first chunk
_, out, err = client.exec_command(f'echo "{chunks[0]}" > /tmp/srv_b64.txt')
out.read(); err.read()
# Append remaining chunks
for chunk in chunks[1:]:
    _, out, err = client.exec_command(f'echo "{chunk}" >> /tmp/srv_b64.txt')
    out.read(); err.read()

# Decode and write to server.js
_, out, err = client.exec_command(f'base64 -d /tmp/srv_b64.txt > {REMOTE} && echo OK')
print('[WRITE]', out.read().decode().strip(), err.read().decode().strip()[:100])

# Verify
_, out, _ = client.exec_command('grep -c "EXCHANGE RATE" /volume1/Teerawat/attendance-backend/server.js')
print('[VERIFY lines]', out.read().decode().strip())

# Restart
_, out, _ = client.exec_command('kill $(ps aux | grep "node server.js" | grep -v grep | awk \'{print $2}\') 2>/dev/null; echo done')
print('[KILL]', out.read().decode().strip())
time.sleep(3)
cmd = f'cd /volume1/Teerawat/attendance-backend && HOME=/volume1/Teerawat nohup {NODE} server.js > server.log 2>&1 & echo pid:$!'
_, out, _ = client.exec_command(cmd)
print('[START]', out.read().decode().strip())
time.sleep(5)
_, out, _ = client.exec_command('ps aux | grep "node server.js" | grep -v grep')
print('[VERIFY proc]', out.read().decode().strip())
client.close()
print('[DONE]')
