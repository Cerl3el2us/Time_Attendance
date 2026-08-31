import paramiko, os, io

REMOTE = '/volume1/Teerawat/attendance-backend/server.js'

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect('192.168.100.100', port=22, username='Teerawat', password=os.environ.get('NAS_PASSWORD', ''), timeout=10)
sftp = client.open_sftp()

# Read current server.js
with sftp.open(REMOTE, 'r') as f:
    src = f.read().decode('utf-8')

EXCHANGE_CACHE = '''
// ===== EXCHANGE RATE API =====
let _exRateCache = { data: null, ts: 0 };
'''

EXCHANGE_ENDPOINT = '''
app.get('/api/exchange-rate', (req, res) => {
  const TTL = 60 * 60 * 1000; // 1 hour cache
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
        const thbM = xml.match(/タイバーツ \(THB\)<\\/col>\\s*<col[^>]*>([\\d.]+)<\\/col>\\s*<col[^>]*>([\\d.]+)<\\/col>\\s*<col[^>]*>([\\d.]+)<\\/col>/);
        const timeM = xml.match(/<caption>現在 : ([^<]+)<\\/caption>/);
        if (!thbM) return res.status(500).json({ error:'THB not found' });
        const data = { tts:parseFloat(thbM[1]), mid:parseFloat(thbM[2]), ttb:parseFloat(thbM[3]),
          smbcUpdatedAt: timeM ? timeM[1].trim() : '', fetchedAt: new Date().toISOString() };
        _exRateCache = { data, ts: now };
        res.json(data);
      } catch(e) { res.status(500).json({ error:e.message }); }
    });
  }).on('error', e => res.status(500).json({ error:e.message }));
});
'''

# Insert cache var after LEAVES section
if "// ===== EXCHANGE RATE API =====" not in src:
    src = src.replace(
        "// ===== LEAVES API =====",
        EXCHANGE_CACHE + "\n// ===== LEAVES API ====="
    )
    # Insert endpoint before app.use(express.static)
    src = src.replace(
        "app.use(express.static('/volume1/web/attendance'));",
        EXCHANGE_ENDPOINT + "\napp.use(express.static('/volume1/web/attendance'));"
    )
    print('[PATCH] Exchange rate code added')
else:
    print('[SKIP] Already patched')

# Write back
with sftp.open(REMOTE, 'w') as f:
    f.write(src.encode('utf-8'))
print('[WRITE] server.js updated')

sftp.close()

# Restart
import time
_, out, _ = client.exec_command('kill $(ps aux | grep "node server.js" | grep -v grep | awk \'{print $2}\') 2>/dev/null; echo done')
print('[KILL]', out.read().decode().strip())
time.sleep(3)
NODE = '/volume1/@appstore/Node.js_v22/usr/local/bin/node'
cmd = f'cd /volume1/Teerawat/attendance-backend && HOME=/volume1/Teerawat nohup {NODE} server.js > server.log 2>&1 & echo pid:$!'
_, out, _ = client.exec_command(cmd)
print('[START]', out.read().decode().strip())
time.sleep(4)
_, out, _ = client.exec_command('ps aux | grep "node server.js" | grep -v grep')
print('[VERIFY]', out.read().decode().strip())
client.close()
print('[DONE]')
