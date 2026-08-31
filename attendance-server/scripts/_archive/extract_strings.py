import paramiko, os, re, json

HOST='192.168.100.100'; USER='Teerawat'; PASS=os.environ.get('NAS_PASSWORD', '')
ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect(HOST, username=USER, password=PASS)

APP = '/volume1/web/attendance/js/app.js'
IDX = '/volume1/web/attendance/index.html'

_, out, _ = ssh.exec_command(f'cat {APP}')
app_content = out.read().decode('utf-8', errors='replace')

_, out, _ = ssh.exec_command(f'cat {IDX}')
idx_content = out.read().decode('utf-8', errors='replace')

ssh.close()

# Extract EN strings from L('en', 'th') calls
# Pattern: L('...', '...') or L("...", "...")
l_pattern = re.compile(r"L\(\s*['\"](.+?)['\"],\s*['\"]", re.DOTALL)
en_from_L = set()
for m in l_pattern.finditer(app_content):
    s = m.group(1).strip()
    if s and len(s) < 200:
        en_from_L.add(s)

# Extract data-en values from index.html
dataen_pattern = re.compile(r'data-en="([^"]+)"')
en_from_html = set()
for m in dataen_pattern.finditer(idx_content):
    s = m.group(1).strip()
    if s:
        en_from_html.add(s)

# Also data-en-title
dataen_title_pattern = re.compile(r'data-en-title="([^"]+)"')
for m in dataen_title_pattern.finditer(idx_content):
    s = m.group(1).strip()
    if s:
        en_from_html.add(s)

all_strings = sorted(en_from_L | en_from_html)
print(f'L() unique EN strings: {len(en_from_L)}')
print(f'data-en unique strings: {len(en_from_html)}')
print(f'Total unique: {len(all_strings)}')

# Save to file for review
with open(r'C:\Users\tairo\en_strings.json', 'w', encoding='utf-8') as f:
    json.dump(all_strings, f, ensure_ascii=False, indent=2)
print('Saved to C:\\Users\\tairo\\en_strings.json')
