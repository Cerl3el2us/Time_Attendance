import paramiko, os, base64, time, re

HOST='192.168.100.100'; USER='Teerawat'; PASS=os.environ.get('NAS_PASSWORD', '')
APP  = '/volume1/web/attendance/js/app.js'
HTML = '/volume1/web/attendance/index.html'
JA   = '/volume1/web/attendance/lang/ja.js'
NEW_VER = '20260714d'
OLD_VER = '20260714c'

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect(HOST, username=USER, password=PASS)

def read_file(path):
    _, out, _ = ssh.exec_command(f'cat "{path}"')
    return out.read()

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

log_lines = []
def log(m): log_lines.append(m); print(m.encode('ascii','replace').decode())

# ===== app.js patches =====
app = read_file(APP).decode('utf-8', errors='replace')
log(f'app.js: {len(app)} chars')

patches = []

# P1: Dashboard stat card "Early Morning" label
patches.append(('P1 dash Early Morning label',
    '<div style="font-size:11px;color:#718096">Early Morning</div>',
    "${t('rpt_early')}</div>".replace('${', '<div style="font-size:11px;color:#718096">${'), 1))

# Better approach - direct string replace
A1_OLD = '<div style="font-size:11px;color:#718096">Early Morning</div>'
A1_NEW = '<div style="font-size:11px;color:#718096">${t(\'rpt_early\')}</div>'
A2_OLD = '<div style="font-size:11px;color:#718096">Late Night</div>'
A2_NEW = '<div style="font-size:11px;color:#718096">${t(\'rpt_latenight\')}</div>'

# P2: payslip early/late detail text
B1_OLD = '`Early ${earlyCount} + Late Night ${lateNightCount} ${t(\'pay_times\')}`'
B1_NEW = '`${t(\'rpt_early\')} ${earlyCount} + ${t(\'rpt_latenight\')} ${lateNightCount} ${t(\'pay_times\')}`'

# P3: Section header "Early Morning —" in detail view (attendance detail)
# Line 4672: html += `<div ...>☀️ Early Morning — ${totalEarly} ...`
# Line 4683: html += `<div ...>🌙 Late Night — ${totalLN} ...`
# Line 4865: html+=`<div ...>🌅 Early Morning — ${tot} ...`
# Line 4875: html+=`<div ...>🌙 Late Night — ${tot} ...`
C1_OLD = '>☀️ Early Morning — '
C1_NEW = '>☀️ ${t(\'rpt_early\')} — '
C2_OLD = '>🌙 Late Night — '
C2_NEW = '>🌙 ${t(\'rpt_latenight\')} — '
C3_OLD = '>🌅 Early Morning — '
C3_NEW = '>🌅 ${t(\'rpt_early\')} — '

# P4: "🪪 National ID" in renderMyProfile at line 3969
D1_OLD = "L('🪪 National ID', '🪪 เลขบัตรประชาชน')"
D1_NEW = "'🪪 ' + L('National ID', 'เลขบัตรประชาชน')"

# P5: sb() calls with 'Early Morning'/'Late Night' as parameter (lines 4835/4836)
E1_OLD = "sb('🌅','Early Morning',"
E1_NEW = "sb('🌅', t('rpt_early'),"
E2_OLD = "sb('🌙','Late Night',"
E2_NEW = "sb('🌙', t('rpt_latenight'),"

# P6: version bump
F1_OLD = f'app.js?v={OLD_VER}'
F1_NEW = f'app.js?v={NEW_VER}'

all_patches = [
    ('A1 dash Early Morning', A1_OLD, A1_NEW, 1),
    ('A2 dash Late Night', A2_OLD, A2_NEW, 1),
    ('B1 payslip early+late', B1_OLD, B1_NEW, 1),
    ('C1 detail hdr ☀️Early', C1_OLD, C1_NEW, None),
    ('C2 detail hdr 🌙Late', C2_OLD, C2_NEW, None),
    ('C3 detail hdr 🌅Early', C3_OLD, C3_NEW, None),
    ('D1 National ID emoji', D1_OLD, D1_NEW, 1),
    ('E1 sb Early Morning', E1_OLD, E1_NEW, None),
    ('E2 sb Late Night', E2_OLD, E2_NEW, None),
]

log('\nPATCH PLAN:')
for name, old, new, expected in all_patches:
    cnt = app.count(old)
    log(f'  {name}: found {cnt}' + ('' if expected is None else f' (expected {expected})'))

log('\nApplying...')
for name, old, new, expected in all_patches:
    if app.count(old) > 0:
        app = app.replace(old, new)
        log(f'  Applied: {name}')
    else:
        log(f'  SKIP: {name}')

log(f'\nWriting app.js ({len(app.encode("utf-8"))} bytes)...')
written = write_file(APP, app.encode('utf-8'))
log(f'  Written: {written} bytes')

# ===== index.html patches =====
html = read_file(HTML).decode('utf-8', errors='replace')

# Version bump
html = html.replace(f'app.js?v={OLD_VER}', f'app.js?v={NEW_VER}')

# Find and fix reports TH "Early Morning" and "Late Night" headers in HTML
# Search for them with regex
em_count = html.count('>Early Morning<')
ln_count = html.count('>Late Night<')
log(f'\nindex.html: Early Morning TH={em_count}, Late Night TH={ln_count}')

# These TH headers use data-en, so applyStaticI18n would handle them IF they have data-en
# Let's add data-en to them
if em_count > 0:
    html = re.sub(
        r'(<th[^>]*class="[^"]*col-hide-mobile[^"]*"[^>]*)>Early Morning</th>',
        r'\1 data-en="Early Morning" data-th="ก่อน 07:30">Early Morning</th>',
        html
    )
    log('  Patched Early Morning TH with data-en')

if ln_count > 0:
    html = re.sub(
        r'(<th[^>]*class="[^"]*col-hide-mobile[^"]*"[^>]*)>Late Night</th>',
        r'\1 data-en="Late Night" data-th="กลับดึก">Late Night</th>',
        html
    )
    log('  Patched Late Night TH with data-en')

log(f'\nWriting index.html ({len(html.encode("utf-8"))} bytes)...')
written_h = write_file(HTML, html.encode('utf-8'))
log(f'  Written: {written_h} bytes')

# ===== lang/ja.js patches =====
ja = read_file(JA).decode('utf-8', errors='replace')
log(f'\nja.js: {len(ja)} chars')

# Add missing translations that L() needs for LANG_JA lookup
ja_additions = []
if '"Early Morning": "' not in ja:
    ja_additions.append('"Early Morning": "早出"')
if '"Late Night": "深夜",' not in ja and '"Late Night": "深夜"' not in ja:
    # Check if it exists in different form
    if '"Late Night"' not in ja:
        ja_additions.append('"Late Night": "深夜"')

log(f'  ja.js additions needed: {ja_additions}')

if ja_additions:
    # Find a safe anchor to insert after
    anchor = '"Upcountry": "'
    anchor_m = re.search(r'"Upcountry"\s*:\s*"[^"]*"', ja)
    if anchor_m:
        old_anchor = anchor_m.group(0)
        new_block = old_anchor + ',\n  ' + ',\n  '.join(ja_additions)
        ja = ja.replace(old_anchor + ',', new_block + ',', 1)
        log('  Added missing LANG_JA entries after Upcountry')
    else:
        log('  Upcountry anchor not found, trying Managing Director')
        anchor_m = re.search(r'"Managing Director"\s*:\s*"[^"]*"', ja)
        if anchor_m:
            old_anchor = anchor_m.group(0)
            new_block = old_anchor + ',\n  ' + ',\n  '.join(ja_additions)
            ja = ja.replace(old_anchor + ',', new_block + ',', 1)
            log('  Added missing LANG_JA entries after Managing Director')

    log(f'\nWriting ja.js ({len(ja.encode("utf-8"))} bytes)...')
    written_ja = write_file(JA, ja.encode('utf-8'))
    log(f'  Written: {written_ja} bytes')

    # Also update ja.js version in index.html
    html2 = read_file(HTML).decode('utf-8', errors='replace')
    html2 = html2.replace('ja.js?v=20260714b', 'ja.js?v=20260714d')
    written_h2 = write_file(HTML, html2.encode('utf-8'))
    log(f'  index.html updated with new ja.js ver: {written_h2} bytes')
else:
    log('  No ja.js changes needed')

ssh.close()
with open(r'C:\Users\tairo\patch_final.log', 'w', encoding='utf-8') as f:
    f.write('\n'.join(log_lines))
print('\nAll done - see patch_final.log')
