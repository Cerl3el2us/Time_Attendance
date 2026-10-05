# Developer Handoff Guide — Time Attendance System

Written 2026-08-13 for continuity: if the current maintainer (Teerawat) becomes
unavailable, this file plus the NAS folder itself should be enough for a new
developer to get productive without needing anything that only lived in a
Claude Code chat history.

**2026-08-16 update**: the project folders moved from `Z:\attendance` /
`Z:\attendance-server` to `Z:\Time_Attendance\attendance` /
`Z:\Time_Attendance\attendance-server` (separation from an unrelated "Company
Website" project on the same share). Compatibility symlinks remain at the old
paths during a soak period. All paths below reflect the new location.

## What this system is

Internal Time Attendance web app for the company (attendance/check-in-out,
leave requests + multi-role approval routing, payroll calculation, payslips,
Hikvision face-recognition door access sync). Single Node.js backend + a
static HTML/CSS/JS frontend, both served from one Synology NAS.

- **Live URL**: https://attendance.tozaiboeki.co.th (Cloudflare Named Tunnel →
  `localhost:3000` on the NAS; domain registered via THNIC, DNS/DNSSEC on
  Cloudflare)
- **LAN fallback**: `http://192.168.100.100/Time_Attendance/attendance/` (nginx, same NAS —
  URL changed 2026-08-16 as part of the folder move, the same day the compatibility symlinks
  were removed entirely; the nginx config has a dedicated allow-exception carved into the
  `/Time_Attendance/` blanket deny for this specific path, see
  `scripts/deploy/nginx/www.attendance-server-deny.conf`'s "second addition" comment)
- **API/WebSocket**: `http://192.168.100.100:3000/api/*`, `ws://192.168.100.100:3000/ws`

## Where the code lives

| Path (on NAS, mapped as `Z:\` via Samba) | What | Version control |
|---|---|---|
| `Z:\Time_Attendance\attendance\` | Frontend — static HTML/CSS/JS, served directly, edits are live immediately (no build step) | **git-tracked**, `master` branch, this checkout |
| `Z:\Time_Attendance\attendance-server\backend\` | Backend — `server.js` (Express + WS), `data\*.json` (live production data: users/leaves/events/settings — **not sample data**), `node_modules\` | **In git since 2026-08-31** (`33e1994`, "Initial commit") — `server.js` is ~11,800 lines and now has real commit history; corrected here 2026-10-05, this cell used to say the opposite. What is still **not** in git is `data/*.json`: it is gitignored and lives only on the NAS, so the live data has no version history. That is now the biggest risk in this setup — see the Backups section. |
| `Z:\claude_memory\` | Claude Code's own working memory (project history, decisions, gotchas) — useful background reading even without Claude Code itself, but not authoritative once this file exists | n/a |
| `Z:\Time_Attendance\attendance-server\scripts\deploy\` | `deploy_backend.py` — the only supported way to restart the backend after editing `server.js` | n/a |
| `Z:\Time_Attendance\attendance-server\ngrok\`, `Z:\Time_Attendance\attendance-server\cloudflared\` | Tunnel binaries. cloudflared is what's actually live now; ngrok is a dormant fallback | n/a |

See `Z:\Time_Attendance\attendance-server\README.md` for the fuller folder map (tools/scripts breakdown).

## Access & credentials — READ BEFORE YOU TOUCH ANYTHING

Everything below authenticates as a Synology DSM account — Samba share, SSH,
and the deploy script. There is no dedicated service account; the deploy
script simply uses whichever account you give it.

### Setting up deployment on a new machine (or for a new person)

`deploy_backend.py` reads two environment variables. Set them **once** in
**cmd.exe** (not PowerShell), then **close and reopen the terminal** — an
already-open window keeps its old copy of the environment:

```
setx NAS_PASSWORD "the-account-password"
setx NAS_USER "the-account-name"
```

- `NAS_USER` is optional. If it is not set the script uses **`Teerawat`**, so
  existing machines keep working with no change.
- Whichever account you use **must be in the DSM `administrators` group** —
  the restart step runs `sudo -S kill -9`. A plain user account will connect
  over SSH and then fail at the restart.
- The account also needs SSH enabled in DSM (Control Panel → Terminal & SNMP).

If `NAS_PASSWORD` is missing the script stops immediately and prints the exact
`setx` command to run, so a newcomer does not have to find this document first.

- Ask the current NAS administrator for: the DSM account username/password
  (for `net use Z:` and SSH), and the `NAS_PASSWORD` value `deploy_backend.py`
  expects as an environment variable.
- **On any handoff (Teerawat leaving, or credentials otherwise changing
  hands), rotate everything below immediately** — don't just keep using the
  old values indefinitely:
  - The DSM account password itself
  - JWT signing secret (`server.js`)
  - VAPID keys (web push)
  - SMTP/Resend API key (email sending)
  - Hikvision device password (door access, `192.168.100.4`)
  
  (All of these were already rotated once, 2026-08-04, after a prior secret-exposure
  audit — see `project_time_attendance.md` in `claude_memory` for what that covered.)
- The app code directories themselves (`attendance`, `attendance-server`) are
  deliberately `777` (world-writable) on the NAS so any account with NAS
  access can edit without friction — this was an intentional tradeoff, not an
  oversight. The one exception is
  `Time_Attendance/.python-packages/lib/python3.8/site-packages` (used
  by the exchange-rate fetch script; **moved here from `/volume1/web/.local`
  on 2026-09-24** — the web share root is shared with a second project, and a
  bare `~/.local` there gave no clue which project owned it. `server.js`'s
  `PYTHONPATH` points at the new path; the move used `cp -a`, so the hardened
  permissions below came across intact — verified `drwxrwxr-x` /
  `Teerawat:administrators` afterwards) — it sits on Python's import search path,
  so being world-writable there was a real code-execution risk, unlike the
  app code itself. As of 2026-08-13 the whole subtree (not just the top
  directory — the first pass only fixed that and missed the packages inside
  it, caught by a follow-up review) is `775`/`664`, group-owned recursively by
  `administrators` (not by `Teerawat` personally) — confirmed group members at
  the time: `admin`, `nasadmin`, `Teerawat`, `Takiuchi`. Any of those accounts
  can still write to it even after Teerawat's account is gone, without
  needing `sudo`/`chown` first. This is the one piece of the personal-account
  problem that's actually solved; Samba/SSH/`deploy_backend.py` access below
  is not.
  **Residual risk, not yet fixed**: `/volume1/web` itself (the Web Station
  doc root, shared with other apps — WordPress, phpMyAdmin, MediaWiki) is
  `777` with no sticky bit. Any account with NAS write access could still
  `rm`/`mv` the `.local` directory tree and recreate it under their own
  ownership, bypassing the fix above entirely. A sticky bit on `/volume1/web`
  would close this, but wasn't applied because it's shared with other
  services and the blast radius of that change wasn't evaluated as part of
  this fix — flag this to whoever has DSM admin authority before deciding.

## Restarting the backend — do NOT skip the gotchas below

`server.js` does not hot-reload. After any edit, run
`Z:\Time_Attendance\attendance-server\scripts\deploy\deploy_backend.py` (needs `NAS_PASSWORD`
env var set first, via `setx NAS_PASSWORD "..."` in **cmd.exe**, not
PowerShell) — don't hand-roll your own restart, this script encodes real
scar tissue from this specific NAS:

- **`fuser` and `ss` do not exist on this DSM 7.3 box** (`netstat` does, but
  the script still doesn't use it). The script finds the running backend's PID via
  `ps aux | grep 'node server.js' | grep -v grep | awk '{print $2}'` — process
  pattern matching, not a port lookup. (If you're used to "kill by port, not
  by command-line pattern" as the safer general rule — it's the right
  instinct, it just isn't available here; the tools it needs aren't
  installed.)
- **A root-owned watchdog can silently steal ownership of the backend
  process.** `/usr/local/etc/rc.d/attendance-autostart.sh` runs as a DSM
  rc.d service (as root) and every 300s checks whether a `node server.js`
  process is running (pattern match, not a port check), respawning it if not. If this script's `kill -9` happens to race
  the watchdog's check, the watchdog can win and respawn the replacement
  process as **root** instead of as `Teerawat`. Every subsequent restart
  attempt then gets "Operation not permitted" trying to kill it as a normal
  user — this has actually happened and left stale pre-fix code silently
  serving for over an hour. `deploy_backend.py` already detects this (checks
  the PID's owner) and falls back to `sudo -S kill -9` automatically; you
  don't need to do anything extra, just know it's why the script sometimes
  prompts for a sudo password mid-run.
- **Don't trust `/api/health` alone to prove your restart worked** — it
  answers from whatever process is listening on the port, old or new. The
  script also checks that the PID actually changed; when testing your own
  change, additionally hit an endpoint whose behavior your edit changed and
  confirm the new behavior is there (Node doesn't hot-reload, so a "healthy"
  response can still be pre-your-edit code if the restart silently failed).

## The one rule that causes silent data bugs if you forget it

Payroll/attendance-rule logic is implemented **twice** — once in the frontend
(`Z:\Time_Attendance\attendance\js\app.js`, for on-screen previews) and once in the backend
(`Z:\Time_Attendance\attendance-server\backend\server.js`, for the numbers that actually get
saved/paid). Core functions exist under the same names in both files —
`computePayroll()`, `getPayrollView()`, `deriveAttendanceCounts()` — and must
be changed together, or the two will silently diverge and someone's payslip
will be wrong. (`app.js` also has a third, frontend-only variant,
`calcFinalizeEmployee()`, with no backend counterpart by that name — don't
assume every payroll-shaped function has a twin, check both files directly.)
There is no shared module; this is a manual-discipline rule, not something
the code enforces.

The Excel payslip export (`Z:\Time_Attendance\attendance-server\backend\payslipXlsx.js`,
backend-side) is a **third** place payroll numbers get rendered — it's fed by
the already-computed values rather than recomputing from scratch, but it has
independently drifted from the web payslip before (a past bug: negative
Manual Allowances rendered differently on the web page vs. the Excel export).
When changing anything payroll-related, check whether this file's output
needs re-verifying too, not just app.js/server.js.

Related: after editing `app.js` or any `lang/*.js` file, bump the `?v=`
cache-buster query string on that script tag in `index.html`, or browsers
will keep serving the old file even on a hard reload.

## Backups — there is no real procedure, know this before your first mistake

Production data (`data/*.json` — users, leaves, attendance events, settings)
is not in git and has no scheduled backup. What exists is ad-hoc: occasional
manually-made copies like `server.js.bak_20260810_*` and
`data/_backup_20260731\` left behind from specific past sessions, not a
routine. If you break live data, there is currently **no documented recovery
path** beyond "hope one of these one-off snapshots is recent enough and
covers what you touched." Until this is fixed properly (e.g. a scheduled
`rsync`/tar snapshot of `data/` to somewhere off this NAS), manually copy
`data/*.json` somewhere safe before any change that touches production data
directly (SSH edits, migrations, bulk fixes) — not just before code deploys.

## Where to learn the business rules

There is no single spec document. The most reliable sources, in order:

1. **The code itself** — `computePayroll()` / `getPayrollView()` /
   `deriveAttendanceCounts()` in both `app.js` and `server.js` for payroll
   (see the dual-sync section above); `APPROVAL_ROUTING` / `computeNextStatus`
   / `STATUS_TO_ROLE` in `app.js` for the leave-approval state machine.
2. **`docs/superpowers/specs/`** — dated design specs for individual features,
   newest first. Each one records what was decided and why, and is written
   against the code as it was on that date.
3. **`docs/design-history/`** (moved there 2026-09-28 from this folder, where
   they were easy to mistake for current documentation) — the `*_FOR_SONNET.md`
   point-in-time design/review documents written for a coding agent, covering
   payroll calc, security review, frontend logic, leave submission/balance
   rules, etc. Dated, stale on details, but generally right on intent. Read
   that folder's own README first — several rules they describe were later
   reversed by the owner.
4. **`Z:\claude_memory\project_time_attendance.md`** and the other
   `project_time_attendance_*.md` files there — a running log of every
   session's changes, decisions, and the reasoning behind them, going back to
   the project's start. Extremely detailed but written for an AI assistant to
   resume context, not as onboarding prose — treat it as an archive to search,
   not something to read front-to-back.

## One caution about this file itself

This document lives inside the same world-writable (`777`) tree it warns you
about, which means anyone with NAS access can edit it — including an
attacker redirecting "ask the administrator" instructions somewhere bad. Cross-check
anything security-sensitive here (credential handling, who to contact)
against `README.md` and, if in doubt, against a second source before acting
on it blindly.

## Recommended next steps for whoever inherits this

1. Get the history off this one disk. (Superseded 2026-10-05: the original
   item here was "`git init` the backend" — that is **done**, the backend has
   been committed since 2026-08-31.) What remains is that `main` is far ahead
   of its only remote and nothing has been pushed in a long time — check with
   `git -C Z:/Time_Attendance rev-list --count origin/main..main`. Until that
   is resolved, every commit ever made exists on exactly one disk.
2. Set up a real backup schedule for `data/*.json` — see the Backups section
   above, currently there is none.
3. Decide whether to move Samba/SSH/`deploy_backend.py` access off the
   personal-account model too (shared NAS service account, or at minimum a
   documented rotation runbook) — the one NAS directory that mattered most for
   this was already fixed (see Access & credentials above), but the rest of
   NAS access is still tied to one person's account.
4. Read the security-audit trail before making backend changes — this
   codebase has been through many rounds of security hardening (auth, XSS,
   settings-endpoint merge safety, leave-data scoping); it's easy to
   reintroduce an already-fixed class of bug if you're not aware of the
   history. The part that travels with the code is `git log` — the commit
   messages here are written to be read. The fuller trail sits in
   `Z:\claude_memory\` on the NAS, but **be aware it contains real
   credentials, so it cannot simply be handed to an outside party**; anything
   in there that a future maintainer genuinely needs (why a business rule is
   the way it is, what was tried and reverted) has to be moved into this repo
   as documentation rather than left there. Treat that migration as part of
   handing over, not an afterthought.

## Developer system account (`superadmin`)

A protected **non-employee** login for post-handoff QA/debugging. It does **not**
appear in employee lists, payslips, reports, or the login page hint text.

| Item | Detail |
|---|---|
| Username | `superadmin` (fixed — cannot be renamed or deleted via API) |
| Password | Set on your **Windows dev machine** via `setx SUPERADMIN_PASSWORD "..."` in **cmd.exe** (not PowerShell), then restart backend with `deploy_backend.py` — the deploy script forwards this env var to the NAS Node process. Change later only by logging in as `superadmin` → Profile → Change Password |
| Protection | `backend/systemAccount.js` — re-created on every backend start if removed from `users.json`; API blocks role/password/admin edits by others |
| Can do | View every page (incl. Finalize + 50 ทวิ), export payslip/50-Tawi xlsx, approve requests (with CONFIRM prompt), edit employees/settings, role preview dropdown |
| Cannot do, acting as itself | Finalize confirm, MD payroll approve, email payslip, save 50-Tawi overrides |
| Can exercise while writing nothing | Since 2026-10-05 it can impersonate a **specific employee**, not just a role. While impersonating, the pages closed to superadmin itself — check-in and Leave — open, because the page gate reads the impersonated person's role. Every write is then refused by the server and turned into a dry run that reports what would have happened. So check-in and submitting leave can be walked end to end without one row changing. (This row replaces an older one that listed check-in and submitting leave as flatly impossible.) |

**Secret:** staff must not know this login exists. Never show it in employee
lists, the login page, role dropdowns, or API errors (use generic
`Not allowed` / `Username is already taken`).

**AI / developer policy:** no AI (Claude, Cursor, GPT, Gemini, or other) may
edit the superadmin path or change `isSuperAdmin*` branches while fixing an
unrelated bug. Ask the human first. Superadmin is **not an employee** — never
add it to รายชื่อพนักงาน or other staff lists (keep `isEmployeeRecord` /
`employeeRecords` filters). See `.cursor/rules/superadmin-do-not-touch.mdc`
and the header in `backend/systemAccount.js`.

**Do not delete `systemAccount.js` or remove its hooks in `server.js`.** If an AI
or another developer removes the account from `users.json`, restart the backend
(with `SUPERADMIN_PASSWORD` still set) to restore it.

To set the password on the NAS process, add `SUPERADMIN_PASSWORD` to whatever
environment the backend starts with, then restart via `deploy_backend.py`.
