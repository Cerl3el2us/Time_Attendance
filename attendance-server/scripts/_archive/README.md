# Archived one-off scripts

**Nothing here runs as part of the system. Nothing here is maintained.**

These are throwaway Python scripts written to carry out a single change during the project's first
months (June–August 2026): patch a file, check whether a string had been translated, verify a fix
had landed. They are kept because they show how a particular migration was done, not because they
still work — most of them do string surgery on `app.js` at line offsets that moved long ago, and
running one today would corrupt the file.

Names follow their purpose at the time: `patch_*` changed a file, `check_*` / `verify_*` inspected
one, `read_*` dumped part of it, `qa_*` set up or tore down a test account.

## If you are looking for something that runs

| You want | Use |
|---|---|
| Deploy the backend | `../deploy/deploy_backend.py` (see `attendance-server/DEVELOPER_HANDOFF.md`) |
| Set deployment up on a new machine | `../deploy/setup_deploy.cmd` or `setup_deploy.ps1` |
| Check the NAS account can deploy | `../deploy/check_nas_account.py` |
| Check the code is sound | `npm run lint` and `npm test` from the repository root |

## Before deleting this folder

It is safe to delete — git history keeps every version. It was left in place only so that someone
tracing *why* an old migration was done a certain way can still read the script that did it.
