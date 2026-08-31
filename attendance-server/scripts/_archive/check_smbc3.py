import paramiko, os

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect('192.168.100.100', port=22, username='Teerawat', password=os.environ.get('NAS_PASSWORD', ''), timeout=10)

base = "https://www.smbctb.co.jp"
headers = '-A "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"'

for js in ['/assets/js/exchange_list.js', '/assets/js/rates_common.js']:
    cmd = f'curl -s {headers} "{base}{js}"'
    _, out, _ = client.exec_command(cmd)
    content = out.read().decode()
    print(f'\n=== {js} ===')
    print(content[:4000])

client.close()
