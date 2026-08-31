import paramiko, os, base64, time, re

HOST='192.168.100.100'; USER='Teerawat'; PASS=os.environ.get('NAS_PASSWORD', '')
APP  = '/volume1/web/attendance/js/app.js'
HTML = '/volume1/web/attendance/index.html'
OLD_VER = '20260714g'
NEW_VER = '20260714h'

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

# ===== index.html: add flatpickr CDN =====
html = read_file(HTML).decode('utf-8', errors='replace')
log(f'index.html: {len(html)} chars')

# Add CSS in <head> before </head>
FP_CSS = '  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/flatpickr@4.6.13/dist/flatpickr.min.css">\n'
if 'flatpickr' not in html:
    html = html.replace('</head>', FP_CSS + '</head>', 1)
    log('  Added flatpickr CSS')
else:
    log('  flatpickr already present')

# Add JS before app.js script tag
FP_JS = (
    '  <script src="https://cdn.jsdelivr.net/npm/flatpickr@4.6.13/dist/flatpickr.min.js"></script>\n'
    '  <script src="https://cdn.jsdelivr.net/npm/flatpickr@4.6.13/dist/l10n/ja.js"></script>\n'
    '  <script src="https://cdn.jsdelivr.net/npm/flatpickr@4.6.13/dist/l10n/th.js"></script>\n'
)
if 'flatpickr.min.js' not in html:
    html = re.sub(r'(\s*<script src="js/app\.js)', FP_JS + r'\1', html, count=1)
    log('  Added flatpickr JS before app.js')

# Version bump
html = html.replace(f'app.js?v={OLD_VER}', f'app.js?v={NEW_VER}')
html = html.replace(f'ja.js?v={OLD_VER}', f'ja.js?v={NEW_VER}')

log(f'\nWriting index.html ({len(html.encode("utf-8"))} bytes)...')
written_h = write_file(HTML, html.encode('utf-8'))
log(f'  Written: {written_h} bytes')

# ===== app.js: add initDatePickers() and call it =====
app = read_file(APP).decode('utf-8', errors='replace')
log(f'\napp.js: {len(app)} chars')

# 1. Add initDatePickers() function after applyLanguage() function
#    Find the closing brace of applyLanguage() by looking for the date input lang line we added
INIT_FN = """
let _fpInstances = [];
function initDatePickers() {
  if (typeof flatpickr === 'undefined') return;
  const loc = currentLang === 'ja' ? flatpickr.l10ns.ja : currentLang === 'th' ? flatpickr.l10ns.th : flatpickr.l10ns.default;
  _fpInstances.forEach(fp => { try { fp.set('locale', loc); } catch(e){} });
  document.querySelectorAll('input[type="date"]:not(#tc-date)').forEach(inp => {
    _fpInstances.push(flatpickr(inp, { dateFormat: 'Y-m-d', locale: loc, allowInput: true, disableMobile: true }));
  });
}
"""

# Insert after applyLanguage closing brace
# The applyLanguage function ends after the dark mode label line
# Find the dark mode label line and the next function definition
ANCHOR_FOR_FN = "function switchLang() {"
cnt_anchor = app.count(ANCHOR_FOR_FN)
log(f'switchLang anchor: found {cnt_anchor}')

if cnt_anchor == 1 and 'initDatePickers' not in app:
    app = app.replace(ANCHOR_FOR_FN, INIT_FN + '\n' + ANCHOR_FOR_FN, 1)
    log('  Added initDatePickers() function before switchLang()')
else:
    log('  Skipped (already exists or anchor not found)')

# 2. Call initDatePickers() at end of applyLanguage()
# Find the dark mode toggle label update line (last line in applyLanguage body)
OLD_APPLY = ("  if (lbl)  lbl.textContent  = isDark ? (currentLang==='th' ? 'โหมดสว่าง' : currentLang==='ja' ? 'ライトモード' : 'Light Mode') "
             ": (currentLang==='th' ? 'โหมดมืด' : currentLang==='ja' ? 'ダークモード' : 'Dark Mode');")
NEW_APPLY = (OLD_APPLY + "\n    initDatePickers();")

cnt2 = app.count(OLD_APPLY)
log(f'applyLanguage dark mode line: found {cnt2}')
if cnt2 == 1:
    app = app.replace(OLD_APPLY, NEW_APPLY)
    log('  Added initDatePickers() call in applyLanguage()')
else:
    log('  NOT FOUND - searching...')
    _, out, _ = ssh.exec_command("grep -n 'lbl.textContent.*isDark' " + APP)
    log(out.read().decode('utf-8', errors='replace').strip())

# 3. Call initDatePickers() at end of fixStaticText() so it runs on page load too
#    Find fixStaticText closing area - look for a recognizable pattern near its end
_, out3, _ = ssh.exec_command('grep -n "function fixStaticText\|function toggleDarkMode" ' + APP)
fix_info = out3.read().decode('utf-8', errors='replace').strip()
log(f'\nfixStaticText/toggleDarkMode: {fix_info}')

# fixStaticText ends just before toggleDarkMode
OLD_FIX_END = "function toggleDarkMode() {"
NEW_FIX_END = "  initDatePickers();\n}\n\nfunction toggleDarkMode() {"

# Find the closing brace of fixStaticText before toggleDarkMode
# Pattern: end of fixStaticText which should be "}\n\nfunction toggleDarkMode"
FIX_CLOSE_OLD = "}\n\nfunction toggleDarkMode() {"
FIX_CLOSE_NEW = "  initDatePickers();\n}\n\nfunction toggleDarkMode() {"

cnt3 = app.count(FIX_CLOSE_OLD)
log(f'fixStaticText close + toggleDarkMode: found {cnt3}')
if cnt3 == 1:
    app = app.replace(FIX_CLOSE_OLD, FIX_CLOSE_NEW)
    log('  Added initDatePickers() call at end of fixStaticText()')
else:
    log(f'  Pattern not found ({cnt3}x) - try alternate')
    # Try with different whitespace
    alt = "}\nfunction toggleDarkMode() {"
    cnt3b = app.count(alt)
    log(f'  Alt pattern: found {cnt3b}')

log(f'\nWriting app.js ({len(app.encode("utf-8"))} bytes)...')
written = write_file(APP, app.encode('utf-8'))
log(f'  Written: {written} bytes')

ssh.close()
with open(r'C:\Users\tairo\patch_flatpickr.log', 'w', encoding='utf-8') as f:
    f.write('\n'.join(log_lines))
print('\nDone - see patch_flatpickr.log')
