import paramiko, os, re

HOST='192.168.100.100'; USER='Teerawat'; PASS=os.environ.get('NAS_PASSWORD', '')
ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect(HOST, username=USER, password=PASS)

APP = '/volume1/web/attendance/js/app.js'
IDX = '/volume1/web/attendance/index.html'

# Count L() calls
_, out, _ = ssh.exec_command(f'grep -c "L(" {APP}')
l_count = out.read().decode().strip()

# Count data-en
_, out, _ = ssh.exec_command(f'grep -c "data-en" {IDX}')
dataen_count = out.read().decode().strip()

# L() function definition
_, out, _ = ssh.exec_command(f'grep -n "^function L(" {APP}')
l_def = out.read().decode().strip()

# currentLang usage
_, out, _ = ssh.exec_command(f'grep -n "currentLang" {APP} | head -15')
lang_vars = out.read().decode().strip()

# applyStaticI18n
_, out, _ = ssh.exec_command(f'grep -n "applyStaticI18n\|applyLanguage\|lang-toggle\|langToggle" {APP} | head -10')
apply_i18n = out.read().decode().strip()

# language toggle in index.html
_, out, _ = ssh.exec_command(f'grep -n "lang\|toggle.*lang\|EN.*TH" {IDX} | head -10')
html_lang = out.read().decode().strip()

# File sizes
_, out, _ = ssh.exec_command(f'wc -l {APP} {IDX}')
sizes = out.read().decode().strip()

# Sample a few L() calls to understand pattern
_, out, _ = ssh.exec_command(f"grep -o \"L('[^']*', '[^']*')\" {APP} | head -20")
samples = out.read().decode().strip()

ssh.close()

print('=== L() calls in app.js:', l_count)
print('=== data-en in index.html:', dataen_count)
print('=== L() definition:', l_def)
print('=== currentLang refs:', lang_vars)
print('=== i18n functions:', apply_i18n)
print('=== lang in index.html:', html_lang)
print('=== File sizes:', sizes)
print('=== Sample L() calls:')
print(samples)
