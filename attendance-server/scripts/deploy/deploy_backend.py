"""
Deploy script for attendance backend.
- server.js lives at /volume1/web/Time_Attendance/attendance-server/backend/server.js (NAS)
- Edit it via SSH or directly on NAS; then run this script to restart Node.
- Moved 2026-07-14: was /volume1/Teerawat/attendance-backend/
- Moved 2026-08-16: was /volume1/web/attendance-server/ (folder reorg for project separation
  from an unrelated "Company Website" project on the same share). Compatibility symlinks were
  left at the old path (/volume1/web/attendance-server -> .../Time_Attendance/attendance-server).
- Fixed 2026-07-17: `fuser` and `ss` do not exist on this NAS (DSM 7.3, confirmed via
  `which fuser` -> "command not found") -- the old kill/verify steps were silent no-ops
  this whole time (`2>/dev/null` swallowed the "command not found", `; echo done` always
  printed regardless). A restart could silently leave the OLD process running with the
  OLD code still loaded in memory while claiming success. Kill now finds the PID via
  `ps`+`awk` and kills it directly (also avoids `pkill -f`'s self-match footgun --
  `pkill -f "node server.js"` matches its own argv and can kill its own wrapping shell
  before completing). Verify now confirms the PID actually changed and the health
  endpoint responds, instead of a command (`ss`) that never existed here.
- Also 2026-07-17: this NAS's SSH channel intermittently never sends EOF for the
  nohup-backgrounded start command even though it fully redirects stdio and the shell
  exits promptly -- confirmed via a follow-up connection that the command had in fact
  succeeded server-side every time this was seen, so it's a client-read quirk, not a
  real failure. `run()` now treats a read timeout as "unknown, verify below" instead of
  crashing the whole script.
- Fixed 2026-07-18: a root-owned `attendance-autostart.sh watchdog-loop` (registered as
  a DSM rc.d service, so it always runs as root) polls whether port 3000 is up and
  respawns `node server.js` itself if it's down. If this script's own `kill -9` races
  against that watchdog's check cycle -- old process dies, watchdog notices the gap
  before this script's own respawn lands, watchdog respawns first -- the replacement
  process ends up owned by **root**, not Teerawat. Every future run of this script from
  then on gets "Operation not permitted" trying to `kill -9` it (plain kill can't touch
  a root-owned process), silently leaving that stale root-owned process serving forever
  regardless of new deploys -- confirmed happening for real: a process sat there over an
  hour past its last legitimate restart, silently serving pre-fix code the whole time.
  Kill step now checks the PID's owner (`ps -o user=`) first and uses `sudo -S kill -9`
  (password piped over a PTY channel, mirroring the pattern already used elsewhere in
  this project for root file writes) whenever it isn't Teerawat's own process.
"""
import paramiko, time, socket, os

NODE = '/volume1/@appstore/Node.js_v22/usr/local/bin/node'
FIND_PID = "ps aux | grep 'node server.js' | grep -v grep | awk '{print $2}'"
# SECURITY FIX 2026-07-19 (F-07): password removed from source. Set once via:
#   setx NAS_PASSWORD "your-password"   (CMD, not PowerShell; takes effect on next terminal open)
NAS_PASSWORD = os.environ.get('NAS_PASSWORD')
if not NAS_PASSWORD:
    raise SystemExit('[ERROR] NAS_PASSWORD env var not set. Run: setx NAS_PASSWORD "your-password" in CMD, then reopen terminal.')

SUPERADMIN_PASSWORD = os.environ.get('SUPERADMIN_PASSWORD', '')

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect('192.168.100.100', port=22, username='Teerawat', password=NAS_PASSWORD, timeout=10)
print('[SSH] connected')

def run(cmd, timeout=20):
    try:
        _, out, err = client.exec_command(cmd, timeout=timeout)
        o = out.read().decode(errors='replace').strip()
        err.read()  # drain stderr so the channel closes cleanly
        return o
    except (socket.timeout, paramiko.buffered_pipe.PipeTimeout):
        print(f'  [NOTE] read timed out on: {cmd[:80]}... (command likely still ran server-side -- verifying below)')
        return None

def run_sudo(cmd, timeout=20):
    """For commands that need root (killing a root-owned process). Pipes the NAS password
    over a PTY, matching the pattern this project already uses for root file writes."""
    chan = client.get_transport().open_session()
    chan.settimeout(timeout)
    chan.get_pty()
    chan.exec_command(f'sudo -S {cmd}')
    time.sleep(0.5)
    chan.send(NAS_PASSWORD + '\n')
    time.sleep(1.5)
    out = b''
    while chan.recv_ready():
        out += chan.recv(4096)
    chan.close()
    return out.decode(errors='replace')

def kill_pids(pids):
    """Kills each PID as Teerawat first; falls back to sudo for any PID not owned by
    Teerawat (root-owned, e.g. the watchdog having respawned it -- see 2026-07-18 note above)."""
    for pid in pids:
        # SECURITY FIX 2026-08-13 (Opus audit, HIGH): pid came from an earlier separate SSH
        # round-trip (FIND_PID), and this never re-validated it was still an integer or still the
        # SAME process before handing it to `sudo kill -9` -- if that pid exited in the gap and got
        # recycled by the OS onto an unrelated root-owned daemon, this would kill -9 that daemon
        # with root privileges instead. Re-check right before the kill that (a) pid is a plain
        # integer (never trust it into a shell string otherwise) and (b) its current command line
        # still actually looks like this backend, not just its owner.
        if not str(pid).isdigit():
            print(f'  [WARN] skipping non-numeric pid {pid!r}')
            continue
        cmdline = run(f'ps -o args= -p {pid} 2>/dev/null')
        if not cmdline or 'server.js' not in cmdline:
            print(f'  [WARN] pid {pid} no longer looks like the backend (cmdline: {cmdline!r}) -- skipping kill, may have already exited or been recycled')
            continue
        owner = run(f'ps -o user= -p {pid} 2>/dev/null')
        if owner and owner.strip() != 'Teerawat':
            print(f'  [NOTE] pid {pid} is owned by "{owner.strip()}", not Teerawat -- using sudo to kill it')
            result = run_sudo(f'kill -9 {pid}')
            if result.strip():
                print(f'  [sudo kill output] {result.strip()}')
        else:
            run(f'kill -9 {pid} 2>/dev/null')

old_pid = run(FIND_PID)
print('[BEFORE] running pid(s):', old_pid or '(none)')

if old_pid:
    kill_pids(old_pid.split())
    time.sleep(2)
    still_alive = run(FIND_PID)
    if still_alive:
        print('[WARN] still alive after kill, retrying once:', still_alive)
        kill_pids(still_alive.split())
        time.sleep(2)

# Escape for a double-quoted shell string on the NAS (Synology sh/bash).
def _sh_escape(s):
    return s.replace('\\', '\\\\').replace('"', '\\"').replace('$', '\\$').replace('`', '\\`')

env_bits = []
if SUPERADMIN_PASSWORD:
    env_bits.append(f'SUPERADMIN_PASSWORD="{_sh_escape(SUPERADMIN_PASSWORD)}"')
env_prefix = (' '.join(env_bits) + ' ') if env_bits else ''
if not SUPERADMIN_PASSWORD:
    print('[NOTE] SUPERADMIN_PASSWORD not set on this machine — superadmin account will NOT be created until you set it (see DEVELOPER_HANDOFF.md)')

cmd = f'cd "/volume1/web/Time_Attendance/attendance-server/backend" && HOME="/volume1/web/Time_Attendance/attendance-server" {env_prefix}nohup {NODE} server.js >> server.log 2>&1 & echo pid:$!'
started = run(cmd)
print('[START]', started if started is not None else '(unknown -- read timed out)')
time.sleep(4)

new_pid = run(FIND_PID)
print('[AFTER] running pid(s):', new_pid or '(none -- FAILED TO START)')

if old_pid and new_pid and (set(old_pid.split()) & set(new_pid.split())):
    print('[WARN] new pid overlaps with the pre-restart pid -- restart may not have taken effect')

new_owner = run(f"ps -o user= -p {new_pid.split()[-1]} 2>/dev/null") if new_pid else None
if new_owner and new_owner.strip() != 'Teerawat':
    print(f'[WARN] the running process is owned by "{new_owner.strip()}", not Teerawat -- the watchdog likely respawned it as root; future restarts of this script will need sudo again until this is cleaned up')

health = run('curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/api/health')
print('[VERIFY] health check HTTP', health)
if health != '200':
    print('[ERROR] backend did not come up healthy after restart -- check server.log')

client.close()
print('[DONE]')
