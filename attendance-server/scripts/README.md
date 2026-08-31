# Scripts — Time Attendance Backend

## `deploy/` — reusable operational scripts
Scripts meant to be run again, on purpose, to manage the live backend:
- `deploy_backend.py` — restarts the Node.js backend on the NAS via SSH (kills port 3000, relaunches `server.js`, verifies it's listening). Path already updated (2026-08-16 migration to `/volume1/web/Time_Attendance/attendance-server/`, before that 2026-07-14's move to `/volume1/web/attendance-server/`). This is the only script in this folder — earlier `restart_backend.py`/`restart2.py` helpers referenced in older notes no longer exist.

## `_archive/` — one-off historical scripts
`check_*`, `verify_*`, `patch_*`, `qa_*`, `get_*`, `read_*`, `analyze_*`, `extract_*`, `node_check.py` — throwaway scripts written during specific past debugging/patch sessions (i18n audits, dark-mode sweeps, date-format fixes, QA test-user setup, etc.). Each did its job once against `server.js`/`app.js` at the time and generally shouldn't be re-run as-is (the codebase has moved on since). Kept for reference/history, not active tooling.

Not sure if a specific archived script is still relevant? Check `project_time_attendance.md` in Claude's memory (`Z:\claude_memory\`) for the session narrative — it explains what most of these were for and when.
