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

HOLIDAYS_CODE = r"""
// ===== HOLIDAYS API =====
const holidaysPath = path.join(__dirname, 'data/holidays.json');
let holidays = [];
if (fs.existsSync(holidaysPath)) {
  try { holidays = JSON.parse(fs.readFileSync(holidaysPath, 'utf8')); } catch(e) { holidays = []; }
} else {
  fs.writeFileSync(holidaysPath, '[]');
}
let nextHolidayId = holidays.length > 0 ? Math.max(...holidays.map(h => h.id || 0)) + 1 : 1;

app.get('/api/holidays', (req, res) => {
  res.json({ success: true, holidays });
});

app.post('/api/holidays', (req, res) => {
  const { date, name } = req.body;
  if (!date || !name) return res.status(400).json({ success: false, message: 'date and name required' });
  if (holidays.find(h => h.date === date)) return res.status(400).json({ success: false, message: 'วันนี้มีอยู่แล้ว' });
  const h = { id: nextHolidayId++, date, name, year: parseInt(date.split('-')[0]) };
  holidays.push(h);
  holidays.sort((a, b) => a.date.localeCompare(b.date));
  fs.writeFileSync(holidaysPath, JSON.stringify(holidays, null, 2));
  res.json({ success: true, holiday: h });
});

app.delete('/api/holidays/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const idx = holidays.findIndex(h => h.id === id);
  if (idx < 0) return res.status(404).json({ success: false, message: 'not found' });
  holidays.splice(idx, 1);
  fs.writeFileSync(holidaysPath, JSON.stringify(holidays, null, 2));
  res.json({ success: true });
});
"""

ANCHOR = "// ===== LEAVES API ====="

if '// ===== HOLIDAYS API =====' not in src:
    src = src.replace(ANCHOR, HOLIDAYS_CODE + '\n' + ANCHOR)
    print('[PATCH] Holidays API added')
else:
    print('[SKIP] Already patched')

# Write via base64 chunks
encoded = base64.b64encode(src.encode('utf-8')).decode('ascii')
chunk_size = 10000
chunks = [encoded[i:i+chunk_size] for i in range(0, len(encoded), chunk_size)]

_, out, err = client.exec_command(f'echo "{chunks[0]}" > /tmp/srv_b64.txt')
out.read(); err.read()
for chunk in chunks[1:]:
    _, out, err = client.exec_command(f'echo "{chunk}" >> /tmp/srv_b64.txt')
    out.read(); err.read()

_, out, err = client.exec_command(f'base64 -d /tmp/srv_b64.txt > {REMOTE} && echo OK')
print('[WRITE]', out.read().decode().strip(), err.read().decode().strip()[:100])

_, out, _ = client.exec_command('grep -c "HOLIDAYS API" /volume1/Teerawat/attendance-backend/server.js')
print('[VERIFY]', out.read().decode().strip(), 'matches')

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
