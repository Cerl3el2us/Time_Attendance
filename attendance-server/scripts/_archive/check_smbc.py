import paramiko, os

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect('192.168.100.100', port=22, username='Teerawat', password=os.environ.get('NAS_PASSWORD', ''), timeout=10)

# Fetch SMBC page and look for JS data or API patterns
cmd = """curl -s -A "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" \
  "https://www.smbctb.co.jp/en/about_interest_rate/exchange_list.html" | \
  grep -i -E "(fetch|xhr|ajax|api|json|thb|thai|4\\.7)" | head -30"""
_, out, err = client.exec_command(cmd)
result = out.read().decode()
print('[GREP]', result[:3000] if result else '(empty)')

# Try guessing common API endpoints
cmd2 = """curl -s -o /dev/null -w "%{http_code}" \
  "https://www.smbctb.co.jp/en/about_interest_rate/exchange_rate.json" """
_, out, _ = client.exec_command(cmd2)
print('[JSON endpoint]', out.read().decode().strip())

cmd3 = """curl -s -o /dev/null -w "%{http_code}" \
  "https://www.smbctb.co.jp/api/exchange" """
_, out, _ = client.exec_command(cmd3)
print('[API endpoint]', out.read().decode().strip())

client.close()
print('[DONE]')
