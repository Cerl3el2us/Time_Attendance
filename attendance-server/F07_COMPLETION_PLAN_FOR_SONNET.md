# F-07 Completion Plan — Findings for Sonnet (2026-07-19, Opus)

> Sonnet's first pass moved `HIK.pass`/`NAS_PASSWORD` to `process.env.HIK_PASS` etc. with a
> hardcoded fallback — this compiles and works, but **doesn't actually remove the secret from
> disk/memory anywhere**, and shell env vars set via an ad-hoc SSH session don't persist across
> the deploy script's own `nohup` restart (each `deploy_backend.py` run is a fresh SSH exec — the
> env var would need to be baked into the restart command every single deploy, which is fragile).
> **This plan replaces the env-var approach with the codebase's own existing secret pattern.**

## Existing pattern to copy (already in `server.js`)
```js
// JWT_SECRET_FILE (server.js:44-52) and VAPID_FILE (server.js:62-69) both do this:
// 1. Define a path inside DATA_DIR (data/ — NOT the public web root, NOT under Z:\attendance)
// 2. If the file exists, read the secret from it
// 3. If not, generate/seed it once, write it, log that it happened
// This survives NAS reboots and process restarts with zero deploy-script changes.
```

## Task 1 — Hikvision credentials → file-based secret (server-side, do this)
1. Revert the `process.env.HIK_PASS || '<redacted>'` pattern at `server.js:392-399`.
2. Add a `HIK_SECRET_FILE = path.join(DATA_DIR, 'hikvision-secret.json')` following the exact
   `JWT_SECRET_FILE`/`VAPID_FILE` style (check `fs.existsSync` → read; else seed once with the
   **current real values** `{host:'192.168.100.4', user:'admin', pass:'<redacted>'}` and
   `fs.writeFileSync`, log `[HIK] Seeded credentials file — consider rotating the Hikvision admin
   password now that it's isolated from source`).
3. `HIK = JSON.parse(fs.readFileSync(HIK_SECRET_FILE, 'utf8'))` (with the same host/user/pass keys
   the rest of the file already uses — grep `HIK\.` to confirm nothing else needs to change).
4. Confirm `data/` (i.e. `DATA_DIR`) is NOT served statically anywhere (check for `express.static`
   pointing at DATA_DIR or a parent of it) — it shouldn't be, matching how `jwt-secret.txt` already
   lives there safely, but verify before calling this done.
5. `node --check`, deploy, verify `/api/health` 200 and that Hikvision sync (`syncHikvisionEmployees`
   as md/accounting/manager) still works — this is the one thing that actually depends on `HIK.pass`
   being correct, so a real Hikvision-auth smoke test matters here (login as `takiuchi`, trigger sync,
   confirm no auth error in server logs / response).

## Task 2 — `scripts/deploy/*.py` NAS_PASSWORD → DO NOT auto-decide, ask the user first
The deploy scripts (`deploy_backend.py`, and the two legacy `restart_backend.py`/`restart2.py` Sonnet
already touched) run **on the Windows machine**, not the NAS — this is a different secret class from
Task 1. Project memory says deploy scripts must live on NAS (not left only on local disk), but a
plaintext password *inside* a NAS-hosted script is barely better than the current hardcode (same
blast radius — anyone with NAS filesystem access reads it either way).

**Do not silently pick a storage location for this one.** Leave `NAS_PASSWORD` as Sonnet's current
`os.environ.get('NAS_PASSWORD', '<redacted>')` fallback (already a strict improvement — override-able,
doesn't regress anything) and write one sentence in your final report flagging that a real fix here
needs the user to choose between: (a) a Windows-side env var set via `setx` (persists per-Windows-user,
never touches the NAS filesystem at all), or (b) a password manager / credential store, or (c) accept
the residual risk since this is a personal/single-admin NAS. Do not implement (a)/(b) speculatively.

## Task 3 — quick decision already flagged as open, resolve now with a safe default
From the Sprint 2 report: "admin reset password doesn't set mustChangePassword:true — spec only
required it for new users." **Default: leave as-is** (do not add it) — an admin-initiated reset is a
deliberate action by a trusted role, not the same risk class as a fresh default-`1234` account, and
forcing it could be disruptive without the user having asked for it. Just carry this forward as
explicitly decided-not-to-do in your report (not silently dropped) so it doesn't get re-flagged as an
oversight later.

## When done
Test per the same standard as before (5 QA roles, positive+negative, cleanup any test artifacts,
`node --check` before deploy, `/api/health` after). Report in Thai. **Push memory to NAS when finished**
(`powershell -File Z:\claude_memory\sync_memory.ps1 push -ProjectDir Z:\`) — the user explicitly asked
for this on completion, unlike prior rounds where it was deferred.
