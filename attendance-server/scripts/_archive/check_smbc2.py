import paramiko, os

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect('192.168.100.100', port=22, username='Teerawat', password=os.environ.get('NAS_PASSWORD', ''), timeout=10)

# Get 10 lines around the thb row
cmd = """curl -s -A "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" \
  "https://www.smbctb.co.jp/en/about_interest_rate/exchange_list.html" | \
  grep -A 20 'data-country-code="thb"'"""
_, out, _ = client.exec_command(cmd)
print('[THB ROW]')
print(out.read().decode())

# Look for JS files referenced
cmd2 = """curl -s -A "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" \
  "https://www.smbctb.co.jp/en/about_interest_rate/exchange_list.html" | \
  grep -E 'script src|data-url|data-endpoint' | head -20"""
_, out, _ = client.exec_command(cmd2)
print('[SCRIPTS]')
print(out.read().decode())

client.close()
