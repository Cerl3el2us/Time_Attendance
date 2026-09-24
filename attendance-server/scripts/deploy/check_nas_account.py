"""Read-only check that the NAS_USER / NAS_PASSWORD in the environment can actually deploy.

Run on its own (`python check_nas_account.py`) or from setup_deploy.ps1. It logs in over SSH and
reports three things; it changes nothing on the NAS and never restarts the backend.

  1. SSH login works with these credentials
  2. the account is in the DSM `administrators` group (deploy_backend.py's restart step needs sudo
     whenever the watchdog has respawned the backend as root)
  3. the backend file it would deploy to is readable

Added 2026-09-24 together with NAS_USER: before this, the only way to find out a handover account
was wrong was to run a real deploy and watch it fail halfway.
"""
import os
import sys

try:
    import paramiko
except ImportError:
    sys.exit('[ERROR] paramiko is not installed. Run: python -m pip install --user paramiko')

HOST = '192.168.100.100'
SERVER_JS = '/volume1/web/Time_Attendance/attendance-server/backend/server.js'

user = os.environ.get('NAS_USER') or 'Teerawat'
password = os.environ.get('NAS_PASSWORD')
if not password:
    sys.exit('[ERROR] NAS_PASSWORD is not set. Run setup_deploy.cmd first.')

print(f'[..] connecting to {HOST} as "{user}"')
client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
try:
    client.connect(HOST, port=22, username=user, password=password, timeout=10)
except paramiko.AuthenticationException:
    sys.exit(f'[FAIL] wrong username or password for "{user}" (or SSH is off for this account in DSM).')
except Exception as exc:
    sys.exit(f'[FAIL] could not reach the NAS: {exc}')

print('[OK] SSH login works')


def run(cmd, timeout=15):
    _, out, _ = client.exec_command(cmd, timeout=timeout)
    return out.read().decode(errors='replace').strip()


groups = run('id -Gn')
is_admin = 'administrators' in groups.split()
print(f'[{"OK" if is_admin else "WARN"}] groups: {groups or "(none returned)"}')
if not is_admin:
    print('     This account is NOT a DSM administrator. Deploys will work only while the backend')
    print('     is owned by this same account; once the watchdog respawns it as root the restart')
    print('     step needs sudo and will fail. Add the account to "administrators" in DSM.')

readable = run(f'test -r {SERVER_JS} && echo yes || echo no')
print(f'[{"OK" if readable == "yes" else "FAIL"}] server.js readable at {SERVER_JS}')

client.close()
print()
print('Ready to deploy.' if (is_admin and readable == 'yes')
      else 'Fix the items above before deploying.')
