import paramiko, os, sys
sys.stdout.reconfigure(encoding='utf-8')
client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect('192.168.100.100', port=22, username='Teerawat', password=os.environ.get('NAS_PASSWORD', ''), timeout=10)
# Check TTL line near exchange-rate endpoint
_, out, _ = client.exec_command(r"grep -n 'TTL\|60000\|60 \* 60\|dedup' /volume1/Teerawat/attendance-backend/server.js")
print(out.read().decode('utf-8', errors='replace'))
client.close()
