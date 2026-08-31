import paramiko, os, base64, time, re

HOST='192.168.100.100'; USER='Teerawat'; PASS=os.environ.get('NAS_PASSWORD', '')
JA = '/volume1/web/attendance/lang/ja.js'

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect(HOST, username=USER, password=PASS)

_, out, _ = ssh.exec_command(f'cat "{JA}"')
ja_bytes = out.read()
ja = ja_bytes.decode('utf-8', errors='replace')

with open(r'C:\Users\tairo\ja_snippet.txt', 'w', encoding='utf-8') as f:
    # find Managing Director in ja.js
    for i, line in enumerate(ja.split('\n')):
        if 'Managing' in line or 'Director' in line or 'Level 1' in line:
            f.write(f'line {i+1}: {line}\n')

# The file uses double quotes: "Managing Director": "代表取締役"
# Search for it with regex
m = re.search(r'"Managing Director"\s*:\s*"[^"]*"', ja)
if m:
    found = m.group(0)
    with open(r'C:\Users\tairo\ja_snippet.txt', 'a', encoding='utf-8') as f:
        f.write(f'\nFound anchor: {found}\n')
        f.write(f'Level 1 already present: {"Level 1" in ja}\n')

    if 'Level 1 — Managing Director' not in ja and 'Level 1' not in ja:
        # Add level labels after this line
        new_block = (
            found + ',\n'
            '  "Level 1 — Managing Director": "レベル1 — 専務取締役",\n'
            '  "Level 2 — Manager": "レベル2 — マネージャー",\n'
            '  "Level 3 — Accounting": "レベル3 — 経理",\n'
            '  "Level 4 — Staff": "レベル4 — スタッフ",\n'
            '  "Level 4 — Marketing": "レベル4 — マーケティング",\n'
            '  "Level 5 — Driver (no clock-in)": "レベル5 — ドライバー（打刻なし）"'
        )
        # Replace carefully - don't replace trailing comma from original
        ja_new = ja.replace(found + ',', new_block + ',', 1)
        if ja_new == ja:  # no change, try without comma
            ja_new = ja.replace(found, new_block, 1)

        # write
        def write_file(path, content_bytes):
            b64 = base64.b64encode(content_bytes).decode()
            chunk = 60000
            ssh.exec_command(f'> "{path}"')
            time.sleep(0.3)
            for i in range(0, len(b64), chunk):
                ssh.exec_command(f'echo -n "{b64[i:i+chunk]}" | base64 -d >> "{path}"')
                time.sleep(0.2)
            _, o, _ = ssh.exec_command(f'wc -c < "{path}"')
            return int(o.read().decode().strip())

        written = write_file(JA, ja_new.encode('utf-8'))
        with open(r'C:\Users\tairo\ja_snippet.txt', 'a', encoding='utf-8') as f:
            f.write(f'Written: {written} bytes (was {len(ja_bytes)})\n')
            f.write(f'Level 1 in result: {"Level 1" in ja_new}\n')
        print(f'Written ja.js: {written} bytes')
    else:
        with open(r'C:\Users\tairo\ja_snippet.txt', 'a', encoding='utf-8') as f:
            f.write('Level labels already present\n')
        print('Level labels already present in ja.js')
else:
    with open(r'C:\Users\tairo\ja_snippet.txt', 'a', encoding='utf-8') as f:
        f.write('\nERROR: Managing Director anchor not found\n')
    print('ERROR: anchor not found')

ssh.close()
print('Done - see ja_snippet.txt')
