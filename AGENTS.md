# AGENTS.md — how to work on this project

Read this before touching anything. It is written for AI coding agents (Cursor, Codex, Claude Code,
Copilot) and for any new developer. Everything here was verified against the running system on
2026-10-05; if something below contradicts what you actually observe, trust what you observe and fix
this file.

สำหรับเจ้าของโปรเจกต์: ไฟล์นี้คือคู่มือให้ AI ตัวอื่นอ่านก่อนเริ่มงาน ถ้าขั้นตอนไหนเปลี่ยน ให้แก้ไฟล์นี้ด้วย

---

## Before you answer anything — two steps

Added 2026-10-08 at the owner's request, after the second machine kept reporting that it did not
know what this one had left open. Sections are deliberately left unnumbered here so the existing
cross-references ("Section 3", "checklist item 9") keep pointing at the same places.

**1. Check your plugins/skills, and state in Thai which skill you are invoking and why.**
Write that line *at the moment you invoke it*, not in the closing summary. The owner's words:
*"คอมเครื่องนี้ก่อนทำอะไรจะเรียกใช้ skill ต่างๆ และบอกให้ผมรู้ อีกเครื่องเงียบ ไม่บอกอะไรเลย ไม่รู้ว่าใช้รึเปล่า"*
— silence means he cannot tell disciplined work from guessing, and silence is what he sees from
the other machine. The marketplaces and the seven plugins to install are listed in the memory file
`feedback_attendance_announce_skills_and_tooling.md`, pulled from `Z:\claude_memory` by the
SessionStart hook. `superpowers` and `playwright` are the two that actually matter here.

**2. Read `STATUS.md` in this folder before saying anything about what is or is not pending.**
It is the answer to "what is the other machine in the middle of?" — open work travels with the
code, not in Claude's memory, and not in `MEMORY.md`. Never answer that you do not know. Its first
section repeats these two steps, and every entry records when it was last checked against real
code, because an entry you do not re-verify is how a finished job gets reopened.

---

## 0. Where to point your editor — read this first

**Open your editor / agent on a worktree folder, not on `Z:\Time_Attendance`.**

A worktree is an ordinary local folder (e.g. `C:\Users\<your-windows-user>\ta-work`) that contains the whole
project, including this file. Working there means the live site is not even reachable from your
workspace, so no mistake you make can reach employees mid-edit. Section 3 has the four commands that
create one; the person setting you up normally runs them before opening the editor.

If you were started on `Z:\Time_Attendance` anyway: **stop, create a worktree, move there, and work
from it.** Do not start editing where you landed.

You can still drive the repo on `Z:` by path from inside your worktree — that is how merging works
(`git -C Z:/Time_Attendance merge ...`). You do not need it as your workspace for anything.

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
**far ahead of `origin/main`** and nothing has been pushed in a long time. Ask git for the number
rather than trusting one written here: `git -C Z:/Time_Attendance rev-list --count origin/main..main`.
If you clone or pull from `origin` you will get very old code.

**The authoritative source is `Z:\Time_Attendance`, branch `main`.** Branch from there.

Do not `git push` without asking the owner first — pushing that whole backlog to that remote is a
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

Start with `git -C Z:/Time_Attendance worktree list` and **use the row whose path matches the
machine you are sitting at.** If yours is missing, run these four, in order, substituting your own
Windows user for `<you>`:

```bash
git -C Z:/Time_Attendance worktree add C:/Users/<you>/ta-myfeature -b feat/my-feature main
```

```bash
git config --global --add safe.directory C:/Users/<you>/ta-myfeature
```

```bash
git -C C:/Users/<you>/ta-myfeature config core.autocrlf input
```

```bash
cd C:/Users/<you>/ta-myfeature && npm ci
```

Why the middle two are not optional on Windows:

- the worktree's gitdir lives on the SMB share, so git refuses it as "dubious ownership" without
  `safe.directory`
- without `core.autocrlf input` you will commit a diff where every line changed (it is already set
  at repo level and every worktree inherits it, so this one is belt-and-braces)

Finish by running `npm run check` in the brand-new worktree **before editing anything**. A fresh
checkout on Windows can come out as CRLF while the repo's blobs are LF, and roughly a dozen of this
project's tests read the source as text and slice it on `'\n'` — they fail on a tree
that is otherwise perfectly fine, and `git status` stays clean, so the failure looks like a real bug.

### Never point two machines at one worktree name

The repo lives on the NAS, so `.git/worktrees/<name>/` — which holds that worktree's **HEAD and
index** — sits on the share and is reachable from every machine that mounts `Z:`. Two folders on two
machines must never claim the same worktree name.

A worktree registered to another machine's path shows up here as `prunable`. **That is normal and is
not a reason to prune it.** Leave other machines' rows alone and add your own.

This has already bitten once (2026-10-05). A second machine had a folder whose `.git` pointed at the
first machine's worktree admin dir. Its files were a week-old checkout while the shared HEAD had
moved on, so `git status` there reported 33 files changed and 5,037 deletions — whole test files and
`CLAUDE.md` / `AGENTS.md` listed as deleted. None of it was real: `git diff <that commit>` was empty
and there were no untracked files. But `git add -A && git commit` in that folder would have silently
reverted a week of the other machine's work.

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

That runs `eslint` over the frontend and backend, then `node tests/run-all.js`. It must end with
`=== N/N test files passed ===` — every file, no failures. The count grows as tests are added, so
compare it against what the same command prints on `main`, not against a number written here.

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

## 7a. The `superadmin` account — do not touch it while fixing something else

There is a protected non-employee login, `superadmin`, whose whole purpose is post-handover QA: it
can look at the app as any role so a developer can test without borrowing a real employee's or the
MD's account.

**No AI (Claude, Cursor, Copilot, GPT, Gemini, or any other) may edit the superadmin path, the
role-preview UI, or any `isSuperAdmin()` / impersonation branch unless the human asked for a
superadmin change in that same message.** Fixing an unrelated bug is not permission. The reason is
blunt: this is developer access, and an agent that "tidies" it away locks the owner out of their own
diagnostic tooling.

Three properties that look like bugs but are deliberate, so do not "fix" them:

- **It is not an employee.** It must never appear in รายชื่อพนักงาน, payslips, reports, role
  dropdowns or the login hint. Keep every `isEmployeeRecord` / `employeeRecords` filter in place.
- **It writes nothing while impersonating a person.** Writes are refused by the *server*, not just
  hidden in the UI, and the client turns the attempt into a dry run that reports what would have
  happened. Both halves must stay: the client gate is a convenience, the server is the control.
- **Everything it does write goes through one gate** inside `apiFetch`, which is what asks for the
  typed CONFIRM. Do not add a `POST`/`PUT`/`DELETE` that bypasses it — a test asserts this by
  reading the source, and that test exists so the rule fails loudly instead of eroding.

### If superadmin itself is broken, fix it — that is not the "touching" this rule forbids

2026-10-08 (owner): the paragraph above was read back and it only ever said "do not change". Taken
literally, an agent that found superadmin unable to log in would stop and ask rather than repair it.
That is not the intent. This rule exists to stop an agent REMOVING or weakening the account while
busy with something else. It has never meant leave it broken.

So: a superadmin that cannot log in, a banner or role preview that will not appear, a dry run that
no longer reports, or a bug sitting in the page it is inspecting — repair it without waiting to be
asked. In one direction only:

- Repair towards the behaviour the spec describes. Do not take the opportunity to narrow what the
  account can do, to drop the write gate in `apiFetch`, to remove an `isEmployeeRecord` filter, or
  to let the account become visible to employees.
- The whole suite must be green afterwards. A red test means the repair went the wrong way, not
  that the test is wrong.
- Say what you changed in this path, every time.

### A new feature must be inspectable through superadmin

2026-10-08 (owner): this account earns its keep only if features written AFTER it can be looked at
through it too — as a role, and as a specific person. Three habits, all easy to miss while thinking
about something else:

1. **A "can I do this?" gate asks `effectiveRole()`, or `gateRoleFor(user, uid)` when the subject
   may be someone else — never `currentUser.role`.** The raw read judges the superadmin account
   instead of the role being previewed, so "view as Staff" shows the button and then refuses every
   date: visible buttons, dead pickers.
2. **Every write goes through `apiFetch()`.** The dry run hangs off it. A bare `fetch()` while a
   PERSON is being impersonated really writes, and the record carries that employee's name with no
   activity log to show it was not them. This is the worst outcome anything on this page prevents.
3. **A new page or menu lists `superadmin` among the roles allowed to see it.**
   `applyRolePermissions()` walks role by role, and `superadmin` is one of them — not a wildcard
   that sees everything. A menu written as `role === 'md' || role === 'accounting'` drops Full
   access into the `else` and hides itself from the one account meant to inspect it. Copy
   `canAddEmp` in that same function, which gets it right:
   `(role === 'md' || role === 'accounting' || role === 'superadmin')`.

`tests/superadmin-reach.test.js` goes red on 1 and 2, and on deleting the superadmin branch in
`applyRolePermissions()`.

`tests/full-access-sees-everything.test.js` goes red on 3. It runs `applyRolePermissions()` for
every role against a stand-in document built from the sidebar markup, and fails when Full access
cannot reach a page some other role can -- so a menu added for one role and forgotten here fails
on the day it is added, not whenever somebody next looks. The only way past it is to list the page
in `PERSONAL_TO_THE_VIEWER` with a reason, which is reserved for pages showing the VIEWER's own
employee records (their check-in, their leave, their requests). This account has none, and the way
to look at those is to impersonate a person.

2026-10-08: the first thing that test caught was already in the tree. Finalize Payroll and Payroll
History were hidden from Full access -- fewer menus than previewing Accounting showed -- because
this branch was copied from MD's and inherited `.nav-no-md`. navigateTo() had always named
superadmin in its Finalize guard, so the page was reachable by URL while its own link was hidden.

Authoritative copies, in order of detail: the header comment in `attendance/js/app.js` (search
`AI POLICY`), `attendance-server/backend/systemAccount.js`, `.cursor/rules/superadmin-do-not-touch.mdc`,
and the account's own section in `attendance-server/DEVELOPER_HANDOFF.md`. The design and the
owner's decisions behind the current behaviour are in
`docs/superpowers/specs/2026-10-05-superadmin-inspector-design.md`.

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
2. `npm run check` — every test file must pass (`=== N/N test files passed ===`)
3. bump the `?v=` cache-buster for anything you changed under `attendance/`
4. commit in your worktree
5. `git -C Z:/Time_Attendance status --short` — clear anything uncommitted
6. `git -C Z:/Time_Attendance merge --ff-only <your-branch>`
7. verify in the browser against the live URL, with evidence
8. tell the owner what changed, what you verified, and what you did **not** verify

Step 8 matters. Say plainly when something is untested rather than implying it works.
