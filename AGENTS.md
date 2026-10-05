# AGENTS.md — how to work on this project

Read this before touching anything. It is written for AI coding agents (Cursor, Codex, Claude Code,
Copilot) and for any new developer. Everything here was verified against the running system on
2026-10-05; if something below contradicts what you actually observe, trust what you observe and fix
this file.

สำหรับเจ้าของโปรเจกต์: ไฟล์นี้คือคู่มือให้ AI ตัวอื่นอ่านก่อนเริ่มงาน ถ้าขั้นตอนไหนเปลี่ยน ให้แก้ไฟล์นี้ด้วย

---

## 1. What this is, and where it lives

Time Attendance — an attendance / leave / payroll web app for Tozai Boeki Kaisha (Thailand) Ltd.

| Thing | Path |
|---|---|
| Git repo **and** live web root | `Z:\Time_Attendance` = `\\192.168.100.100\web\Time_Attendance` |
| Frontend (served directly, no build step) | `attendance/` |
| Backend (Node, runs on the NAS) | `attendance-server/backend/server.js` |
| Tests | `tests/` (plain node, no framework) |
| Live URL | https://attendance.tozaiboeki.co.th |

**The frontend has no build step.** `attendance/index.html` and `attendance/js/app.js` are served to
browsers exactly as they sit on disk. There is no bundler, no transpiler, no dist folder.

### The git remote is stale — do not work from it

`origin` points at `https://origin.cursor.com/teerawat-rungraung/Time_Attendance.git`, but `main` is
**ahead of `origin/main` by ~147 commits**. Nothing has been pushed in a long time. If you clone or
pull from `origin` you will get very old code.

**The authoritative source is `Z:\Time_Attendance`, branch `main`.** Branch from there.

Do not `git push` without asking the owner first — pushing ~147 commits to that remote is a
decision, not a chore.

---

## 2. The one rule that matters most

> ### Never edit files under `Z:\Time_Attendance\` directly.

That directory is what the web server serves. Every save is instantly live for real employees — your
half-finished edit, your typo, your broken function. This has caused real incidents: the live app
once briefly contained calls to functions that did not exist, and a check that refused every request.

**ห้ามแก้ไฟล์ใน `Z:\` ตรงๆ เด็ดขาด — มันคือเว็บจริง เซฟปุ๊บผู้ใช้เห็นปั๊บ**

Work in a git worktree. Merge into `main` only when the work is finished and verified.

---

## 3. Set up your workspace

Pick a folder name for your task. Run these four, in order:

```bash
git -C Z:/Time_Attendance worktree add C:/Users/tairo/ta-myfeature -b feat/my-feature main
```

```bash
git config --global --add safe.directory C:/Users/tairo/ta-myfeature
```

```bash
git -C C:/Users/tairo/ta-myfeature config core.autocrlf input
```

```bash
cd C:/Users/tairo/ta-myfeature && npm ci
```

Why the middle two are not optional on Windows:

- the worktree's gitdir lives on the SMB share, so git refuses it as "dubious ownership" without
  `safe.directory`
- without `core.autocrlf input` you will commit a diff where every line changed

`git -C Z:/Time_Attendance worktree list` shows what already exists — reuse one rather than piling up
stale worktrees.

---

## 4. Verify before you merge

Two gates. Both must pass.

```bash
node --check attendance/js/app.js
```

`app.js` is ~22k lines and loaded as a plain script. One syntax error takes the whole app down
(blank page, no error visible to the user). Run this after **every** edit to it.

```bash
npm run check
```

That runs `eslint` over the frontend and backend, then `node tests/run-all.js` (16 test files). It
should end with `=== 16/16 test files passed ===`.

ESLint will not catch a temporal-dead-zone error (`const` used above its declaration). `node --check`
will not either. If the app goes blank after your change, that is the first thing to look for.

**Verify in a real browser too.** Playwright is available. Claims like "the fix works" need evidence:
load the page, read the console, check the DOM. Do not tell the owner something works because the
code looks right.

---

## 5. Cache-busting — required after any frontend edit

Browsers and the service worker both cache aggressively. **If you edit a frontend asset and do not
bump its `?v=` string, users keep running the old file and will swear your fix did nothing.**

Three query strings live in `attendance/index.html`:

| You edited | Bump this in `index.html` |
|---|---|
| `attendance/js/app.js` | `<script src="js/app.js?v=...">` |
| `attendance/css/style.css` | `<link ... href="css/style.css?v=...">` |
| `attendance/lang/ja.js` | `<script src="lang/ja.js?v=...">` |

Format is `YYYYMMDD` plus a letter that increments within the day — e.g. `20261005d`. Just take the
current value and move it forward.

`attendance/sw.js` additionally holds `SHELL_CACHE` and `DATA_CACHE` version strings. The `?v=`
query already busts individual assets; bump `SHELL_CACHE` when you change which files the service
worker precaches, or its caching behaviour.

---

## 6. Deploying

### Frontend — merging **is** the deploy

There is no build and no upload step. Merging your branch into `main` writes the files into the
directory the web server serves, so they are live the moment the merge completes.

```bash
git -C Z:/Time_Attendance merge --ff-only feat/my-feature
```

The merge fails if `Z:\Time_Attendance` has uncommitted changes. Check with
`git -C Z:/Time_Attendance status --short` and clear them before merging.

Tell the owner to hard-reload (Ctrl+F5) when you are done.

### Backend — needs an explicit restart

`server.js` on the NAS is the file the Node process runs, but it only picks up changes on restart:

```bash
python Z:/Time_Attendance/attendance-server/scripts/deploy/deploy_backend.py
```

Requires the `NAS_PASSWORD` environment variable (`setx NAS_PASSWORD "..."` in cmd.exe), and the DSM
account must be an administrator because the restart uses `sudo`. `NAS_USER` optionally selects the
account. Full setup in `attendance-server/DEVELOPER_HANDOFF.md`.

**Deploy before testing anything that writes data.** Testing a write against a backend still running
the old code has destroyed real data here before.

---

## 7. Project-specific traps

### Payroll logic exists twice and must stay in sync

Pay and leave rules are implemented in **both** `attendance/js/app.js` (client preview) and
`attendance-server/backend/server.js` (authoritative). Change one without the other and the number
the employee sees quietly stops matching the number they are paid.

Search for `DUAL-SYNC` comments — they name the counterpart function explicitly. Tests in `tests/`
compare the two sides; that is what they are for.

### Every user-visible string needs three languages

Thai, English, Japanese. No exceptions, including toasts and error messages.

- In JS: `L('English text', 'ข้อความไทย')`
- Japanese: a key in `attendance/lang/ja.js`, read via `t('key')`, usually behind
  `currentLang === 'ja' ? ... : L(...)`
- In static HTML: Thai as the element's text, English in `data-en="..."`

### Content-Security-Policy is strict

`attendance/index.html` carries a `<meta>` CSP. A new CDN, font, tile server or API host will be
silently blocked until you add its origin to the right directive. `cdn.jsdelivr.net` is already
allowed for scripts; `blob:` is allowed for workers, objects and images.

### `setting || default` silently discards a legitimate `0`

A rate the owner deliberately set to 0 comes back as the default. Use
`setting != null ? setting : default`.

### `fixStaticText()` runs before login

It must never reference `currentUser` — that is null at the time it runs.

### Escape anything a user typed

`escapeHtml()` before interpolating into HTML or an attribute. Original uploaded filenames,
locations, reasons and names are all user-controlled.

### `users.json` is real employee data

Do not rewrite it casually. Test credentials are deliberately not stored in this repo — ask the owner.

### The NAS repo prints a scary error on every commit

```
fatal: could not write multi-pack-index: Permission denied
error: failed to perform geometric repack
```

This is git's background maintenance failing to write to the SMB share. **The commit itself
succeeds.** Verify with `git log --oneline -1` and move on.

---

## 8. Commit and comment conventions

Read `git log --oneline -20` before writing your first commit message. The house style is
`type(scope): plain-language subject` — a sentence that says what changed for the user, not what the
code does. Examples from the log:

```
fix(settings): put the allowance rates back in the allowance card
feat(ui): the scan-time buttons show which one is chosen, and keep up
fix(approvals): attachment link was dead on the approval card; preview in-app
```

Add whatever co-author / attribution line your own harness requires.

**Annotate business rules in code.** When you encode a rule, leave a comment with the date, who
decided it, and what was wrong before. The codebase is full of these and they are the reason the next
agent does not undo your work by accident. Example from `app.js`:

```js
// 2026-10-05 (owner): a holiday-work card must say WHERE the work was, and when. The location
// is required at submit time (l.locations[0].name) but the card never showed it.
```

---

## 9. Finishing

1. `node --check attendance/js/app.js`
2. `npm run check` — must be 16/16
3. bump the `?v=` cache-buster for anything you changed under `attendance/`
4. commit in your worktree
5. `git -C Z:/Time_Attendance status --short` — clear anything uncommitted
6. `git -C Z:/Time_Attendance merge --ff-only <your-branch>`
7. verify in the browser against the live URL, with evidence
8. tell the owner what changed, what you verified, and what you did **not** verify

Step 8 matters. Say plainly when something is untested rather than implying it works.
