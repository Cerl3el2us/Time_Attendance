# Scripts — Time Attendance Backend

## `deploy/` — reusable operational scripts
Scripts meant to be run again, on purpose, to manage the live backend:
- `deploy_backend.py` — restarts the Node.js backend on the NAS via SSH (kills port 3000, relaunches `server.js`, verifies it's listening). Path already updated (2026-08-16 migration to `/volume1/web/Time_Attendance/attendance-server/`, before that 2026-07-14's move to `/volume1/web/attendance-server/`). **Run it as `py <path>`, never bare `python`** — see the note in `DEVELOPER_HANDOFF.md` ("Restarting the backend"): on Windows the Microsoft Store app execution alias for `python.exe` wins on `PATH` and exits 49 without deploying anything.
- `setup_deploy.ps1` + `setup_deploy.cmd` — one-time, interactive setup on a new machine (double-click the `.cmd`). Stores `NAS_USER` / `NAS_PASSWORD` in the current Windows user's environment and optionally tests the login. Added 2026-09-24, when the account stopped being hard-coded in `deploy_backend.py`.
- `check_nas_account.py` — read-only probe: can this account log in over SSH, and is it in the DSM `administrators` group (which the restart's `sudo` needs)? Called by `setup_deploy.ps1`, also runnable on its own.
- `nas_known_hosts` — the pinned NAS SSH host key, so the deploy doesn't trust whatever answers on port 22.
- `nginx/` — the deny rule registered in Web Station's nginx config that blocks HTTP access to `/attendance-server/` and `/claude_memory/`, which both sit inside the `/volume1/web` document root (the file's own header explains why file permissions cannot fix that).

Older notes mention `restart_backend.py` / `restart2.py` helpers; those no longer exist.

## `_archive/` — one-off historical scripts
`check_*`, `verify_*`, `patch_*`, `qa_*`, `get_*`, `read_*`, `analyze_*`, `extract_*`, `node_check.py` — throwaway scripts written during specific past debugging/patch sessions (i18n audits, dark-mode sweeps, date-format fixes, QA test-user setup, etc.). Each did its job once against `server.js`/`app.js` at the time and generally shouldn't be re-run as-is (the codebase has moved on since). Kept for reference/history, not active tooling.

Not sure if a specific archived script is still relevant? Check `project_time_attendance.md` in Claude's memory (`Z:\claude_memory\`) for the session narrative — it explains what most of these were for and when.
