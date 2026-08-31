import paramiko, os

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect('192.168.100.100', port=22, username='Teerawat', password=os.environ.get('NAS_PASSWORD', ''), timeout=10)

cmd = """curl -s -A "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" \
  "https://www.smbctb.co.jp/common/xml/FX_INT.xml" | head -100"""
_, out, err = client.exec_command(cmd)
result = out.read().decode()
print(result if result else '(empty)')
print('ERR:', err.read().decode()[:200])

client.close()
