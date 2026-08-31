import paramiko, os, base64

UPLOAD_CODE = r"""
// ===== FILE UPLOADS =====
const UPLOADS_DIR = path.join(__dirname, 'data', 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

app.post('/api/upload', (req, res) => {
  try {
    const orig = (req.headers['x-filename'] || 'attachment').replace(/[^a-zA-Z0-9.\-_]/g, '_').substring(0, 80);
    const filename = `${Date.now()}_${orig}`;
    fs.writeFileSync(path.join(UPLOADS_DIR, filename), req.body);
    res.json({ success: true, filename, originalName: req.headers['x-filename'] || orig });
  } catch(e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

app.get('/api/upload/:filename', (req, res) => {
  try {
    const fp = path.join(UPLOADS_DIR, req.params.filename);
    if (!fs.existsSync(fp)) return res.status(404).send('Not found');
    res.sendFile(fp);
  } catch(e) {
    res.status(500).send('Error');
  }
});

"""

ANCHOR = "app.use(express.static('/volume1/web/attendance'));"
SERVER_JS = '/volume1/Teerawat/attendance-backend/server.js'

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect('192.168.100.100', port=22, username='Teerawat', password=os.environ.get('NAS_PASSWORD', ''), timeout=10)

# Read via cat
_, out, _ = client.exec_command(f'cat {SERVER_JS}')
src = out.read().decode('utf-8')
print(f'[READ] {len(src)} chars')

if '/api/upload' in src:
    print('SKIP: upload endpoint already exists')
    client.close()
    exit(0)

new_src = src.replace(ANCHOR, UPLOAD_CODE + ANCHOR)
if new_src == src:
    print('ERROR: anchor not found')
    client.close()
    exit(1)

# Write via base64 decode trick
b64 = base64.b64encode(new_src.encode('utf-8')).decode('ascii')
# Write in chunks to avoid command length limits
CHUNK = 4000
parts = [b64[i:i+CHUNK] for i in range(0, len(b64), CHUNK)]

# First chunk: create file
_, out, err = client.exec_command(f'echo -n "{parts[0]}" > /tmp/server_b64.txt')
out.read(); err.read()

# Remaining chunks: append
for p in parts[1:]:
    _, out, err = client.exec_command(f'echo -n "{p}" >> /tmp/server_b64.txt')
    out.read(); err.read()

# Decode and write
_, out, err = client.exec_command(f'base64 -d /tmp/server_b64.txt > {SERVER_JS} && echo OK')
result = out.read().decode().strip()
errmsg = err.read().decode().strip()
print(f'[WRITE] result={result} err={errmsg}')

_, out, _ = client.exec_command(f'grep -c "api/upload" {SERVER_JS}')
print(f'[VERIFY] upload lines={out.read().decode().strip()}')

client.close()
print('[DONE]')
