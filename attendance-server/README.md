# Time Attendance — NAS Folder Map

Quick reference for what lives where across the NAS (`\\192.168.100.100\web\`, mapped as `Z:` on dev machines). Four categories, per request 2026-07-16.

**2026-08-16**: this project moved from `Z:\attendance` / `Z:\attendance-server` to
`Z:\Time_Attendance\attendance` / `Z:\Time_Attendance\attendance-server`, for separation from
an unrelated "Company Website" project on the same share. Compatibility symlinks are left at
the old paths as a safety net during a soak period — see
`Z:\claude_memory\project_time_attendance_2026_08_16_folder_migration.md` for the full record.

**New developer, or picking this project up after Teerawat?** Read
[`DEVELOPER_HANDOFF.md`](./DEVELOPER_HANDOFF.md) first — credentials, deploy
gotchas, and where the business rules actually live.

## 1. Web app (the actual product)
| Path | What |
|---|---|
| `Z:\Time_Attendance\attendance\` | Frontend — static HTML/CSS/JS served directly, **git-tracked** as of 2026-07-16. Edit here, changes are live immediately. |
| `Z:\Time_Attendance\attendance-server\backend\` | Backend — `server.js` (Express + WS), `data\*.json` (users/leaves/events/settings — live production data, not in git), `node_modules\`. |

## 2. Tools (third-party binaries, not our code)
| Path | What |
|---|---|
| `Z:\Time_Attendance\attendance-server\cloudflared\` | cloudflared binary — **live**, runs the Named Tunnel that serves `https://attendance.tozaiboeki.co.th` (domain bought, DNS/DNSSEC on Cloudflare, confirmed working). This is the production public URL. |
| `Z:\Time_Attendance\attendance-server\ngrok\` | ngrok binary + config — dormant fallback tunnel (`jittery-impulsive-pennant.ngrok-free.dev`, forwards to port 3000). Not the live URL; kept in case cloudflared/the domain has an issue. |

## 3. Memory (Claude's own context, not app code)
| Path | What |
|---|---|
| `Z:\claude_memory\` | Everything Claude needs to recall between sessions/machines — project history (`project_time_attendance.md`), feedback rules (`feedback_attendance_*.md`), sync script (`sync_memory.ps1`). See `HOW_TO_USE_memory_sync.txt` there for the pull/push workflow. Deliberately NOT moved as part of the 2026-08-16 reorg — shared across projects. |

## 4. Scripts (operational tooling, not the app itself)
| Path | What |
|---|---|
| `Z:\Time_Attendance\attendance-server\scripts\deploy\` | Reusable — restart the live backend (`deploy_backend.py`). Safe to run again. |
| `Z:\Time_Attendance\attendance-server\scripts\_archive\` | One-off historical patch/check/QA scripts from past sessions. Reference only, not meant to be re-run. See that folder's own `README.md`. |

## Auto-start / watchdog (not a "script" you run by hand)
`/usr/local/etc/rc.d/attendance-autostart.sh` on the NAS itself (not visible from `Z:`, it's outside the `web` share) — starts the backend + cloudflared (+ ngrok as fallback) on boot and watches every 300s, restarting whichever has died. **Runs as root** (registered as a DSM rc.d service) — this matters for backend restarts, see `DEVELOPER_HANDOFF.md`. See `project_time_attendance.md` for full detail.
