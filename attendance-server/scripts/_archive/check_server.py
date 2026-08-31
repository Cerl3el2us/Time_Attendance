import paramiko, os

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect('192.168.100.100', port=22, username='Teerawat', password=os.environ.get('NAS_PASSWORD', ''), timeout=10)

_, out, _ = client.exec_command('grep -c "LEAVES_FILE" /volume1/Teerawat/attendance-backend/server.js')
print('[REAL leaves count]', out.read().decode().strip())

_, out, _ = client.exec_command('grep -c "LEAVES_FILE" /volume1/web/attendance/volume1/Teerawat/attendance-backend/server.js 2>&1')
print('[Z-DRIVE leaves count]', out.read().decode().strip())

# Copy the Z-drive version (which has our edits) to the real backend
_, out, err = client.exec_command('cp /volume1/web/attendance/volume1/Teerawat/attendance-backend/server.js /volume1/Teerawat/attendance-backend/server.js && echo OK')
print('[COPY]', out.read().decode().strip(), err.read().decode().strip())

# Verify
_, out, _ = client.exec_command('grep -c "LEAVES_FILE" /volume1/Teerawat/attendance-backend/server.js')
print('[REAL after copy]', out.read().decode().strip())

client.close()
print('[DONE]')
