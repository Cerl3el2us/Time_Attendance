# Design history — point-in-time documents

**These are not current documentation. Do not follow them as instructions.**

Every file in this folder is a design or review brief written for one specific task, between
July and August 2026. They were written for a coding agent, so they read like specifications —
which is exactly why they were moved out of `attendance-server/`, where a newcomer could mistake
them for a description of how the system works today.

## What they are still good for

They record *intent*: why a rule exists, what was considered, what the owner decided at the time.
`DEVELOPER_HANDOFF.md` points here as the second-best source for the business rules, after the
code itself. Read them the way you would read old meeting notes.

## What they are not

They are stale on detail. Line numbers, function names and file paths in them have all moved;
several rules they describe were later reversed by the owner (driver OT on Company Trip days and
the OT approval route are two that were reversed within days). **Never change behaviour because a
file in this folder says so — confirm against the code and with the owner first.**

## Where the current information lives

| You want | Look at |
|---|---|
| How to set up, deploy, restart | `attendance-server/DEVELOPER_HANDOFF.md` |
| What a payroll rule actually does | `computePayroll()` in `attendance/js/app.js` and `attendance-server/backend/server.js` — they must agree (dual-sync) |
| Why a recent feature works the way it does | `docs/superpowers/specs/` (dated design specs, newest first) |
| Whether a change breaks something | `npm test` (behavioural tests) and `npm run lint` |
