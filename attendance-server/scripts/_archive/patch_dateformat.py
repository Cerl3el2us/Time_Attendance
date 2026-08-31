import paramiko, os, base64, time

HOST='192.168.100.100'; USER='Teerawat'; PASS=os.environ.get('NAS_PASSWORD', '')
APP  = '/volume1/web/attendance/js/app.js'
HTML = '/volume1/web/attendance/index.html'
OLD_VER = '20260714e'
NEW_VER = '20260714f'

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

app = read_file(APP).decode('utf-8', errors='replace')
log(f'app.js: {len(app)} chars')

patches = []

# P1: Fix document.documentElement.lang on line 3 (initial load)
patches.append(('P1 html lang init',
    "document.documentElement.lang = currentLang === 'en' ? 'en' : 'th';",
    "document.documentElement.lang = currentLang === 'en' ? 'en' : currentLang === 'ja' ? 'ja' : 'th';",
    1))

# P2: fmtDate - add Japanese year-month-day format
patches.append(('P2 fmtDate JA',
    "  const dt = typeof d === 'string' ? new Date(d + 'T12:00:00') : d;\n  return `${dt.getDate()} ${_monthShort()[dt.getMonth()]} ${dt.getFullYear()}`;\n}",
    "  const dt = typeof d === 'string' ? new Date(d + 'T12:00:00') : d;\n  if (currentLang === 'ja') return `${dt.getFullYear()}年${dt.getMonth()+1}月${dt.getDate()}日`;\n  return `${dt.getDate()} ${_monthShort()[dt.getMonth()]} ${dt.getFullYear()}`;\n}",
    1))

# P3: fmtDateLong - add Japanese format
patches.append(('P3 fmtDateLong JA',
    "  const dt = typeof d === 'string' ? new Date(d + 'T12:00:00') : d;\n  return `${dt.getDate()} ${_monthNames()[dt.getMonth()]} ${dt.getFullYear()}`;\n}",
    "  const dt = typeof d === 'string' ? new Date(d + 'T12:00:00') : d;\n  if (currentLang === 'ja') return `${dt.getFullYear()}年${dt.getMonth()+1}月${dt.getDate()}日`;\n  return `${dt.getDate()} ${_monthNames()[dt.getMonth()]} ${dt.getFullYear()}`;\n}",
    1))

# P4: fmtDateShort - add Japanese format
patches.append(('P4 fmtDateShort JA',
    "  const dt = typeof d === 'string' ? new Date(d + 'T12:00:00') : d;\n  return `${dt.getDate()} ${_monthShort()[dt.getMonth()]}`;\n}",
    "  const dt = typeof d === 'string' ? new Date(d + 'T12:00:00') : d;\n  if (currentLang === 'ja') return `${dt.getMonth()+1}月${dt.getDate()}日`;\n  return `${dt.getDate()} ${_monthShort()[dt.getMonth()]}`;\n}",
    1))

# P5: Add _fmtDtStr helper before showApprovalDetail (line ~6076)
# Insert after closeApprovalDetail or before showApprovalDetail
patches.append(('P5 add _fmtDtStr helper',
    "function showApprovalDetail(id) {",
    "function _fmtDtStr(s) { if (!s) return '—'; const d = new Date(s); return isNaN(d.getTime()) ? s : fmtDateTime(d); }\n\nfunction showApprovalDetail(id) {",
    1))

# P6: Fix submittedAt display in showApprovalDetail (line 6151)
patches.append(('P6 approval submittedAt',
    "${row(L('Submitted', 'ยื่นเมื่อ'), l.submittedAt)}",
    "${row(L('Submitted', 'ยื่นเมื่อ'), _fmtDtStr(l.submittedAt))}",
    1))

# P7: Fix approvedAt display in showApprovalDetail (line 6140)
patches.append(('P7 approval approvedAt',
    "${l.approvedAt ? row(L('Handled at', 'เวลาดำเนินการ'), l.approvedAt) : ''}",
    "${l.approvedAt ? row(L('Handled at', 'เวลาดำเนินการ'), _fmtDtStr(l.approvedAt)) : ''}",
    1))

# P8: Fix submittedAt in requests list (line 3802) - 🕐 display
patches.append(('P8 req list submittedAt (1st)',
    "<span>🕐 ${r.submittedAt}</span>",
    "<span>🕐 ${_fmtDtStr(r.submittedAt)}</span>",
    None))  # may appear multiple times

# P9: Fix submittedAt in profile leave history (line 5390)
patches.append(('P9 profile leave submittedAt',
    "${L('Submitted', 'ยื่นเมื่อ')} ${l.submittedAt}",
    "${L('Submitted', 'ยื่นเมื่อ')} ${_fmtDtStr(l.submittedAt)}",
    None))

# P10: Fix periodLabel for payslip to use locale-aware formatting
patches.append(('P10 periodLabel locale',
    "const periodLabel = start.toLocaleDateString('th-TH', { month: 'long', year: 'numeric' });",
    "const periodLabel = start.toLocaleDateString(currentLang === 'ja' ? 'ja-JP' : currentLang === 'en' ? 'en-US' : 'th-TH', { year: 'numeric', month: 'long' });",
    1))

log('\nPATCH PLAN:')
for name, old, new, expected in patches:
    cnt = app.count(old)
    log(f'  {name}: found {cnt}' + ('' if expected is None else f' (expected {expected})'))

log('\nApplying...')
for name, old, new, expected in patches:
    cnt = app.count(old)
    if cnt > 0:
        app = app.replace(old, new)
        log(f'  Applied: {name} ({cnt} occurrences)')
    else:
        log(f'  SKIP (not found): {name}')

log(f'\nWriting app.js ({len(app.encode("utf-8"))} bytes)...')
written = write_file(APP, app.encode('utf-8'))
log(f'  Written: {written} bytes')

# Version bump in index.html
html = read_file(HTML).decode('utf-8', errors='replace')
html = html.replace(f'app.js?v={OLD_VER}', f'app.js?v={NEW_VER}')
html = html.replace(f'ja.js?v={OLD_VER}', f'ja.js?v={NEW_VER}')
log(f'\nWriting index.html ({len(html.encode("utf-8"))} bytes)...')
written_h = write_file(HTML, html.encode('utf-8'))
log(f'  Written: {written_h} bytes')

ssh.close()
with open(r'C:\Users\tairo\patch_dateformat.log', 'w', encoding='utf-8') as f:
    f.write('\n'.join(log_lines))
print('\nDone - see patch_dateformat.log')
