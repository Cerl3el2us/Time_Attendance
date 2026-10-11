// Checking users.json against the roster rules, for `npm run status` (2026-10-11).
//
// `active` is the payroll roster flag: Finalize, the bank export and the MD count all filter on
// it (see the comment on canOpenDoor() in server.js). app.js and server.js now read it the same
// way -- absent means nobody ever recorded a departure, so the person is still here -- which keeps
// a record with no `active` key from falling between two screens. It does not make that record
// correct, and nothing in `npm run check` can see it: users.json is gitignored and a worktree has
// no data directory, so a test reading it could never go red. This runs where the data is.
//
// Same promise as the sibling data-files module: nothing here throws. On Z: the live backend is
// rewriting these files while the report runs, and a status tool that dies mid-report makes every
// section after it look like "nothing to say" rather than "not measured".
//
// Reports ids, never names. This reads the real roster.
'use strict';

function describeRosterHealth(users) {
  if (!Array.isArray(users)) return ['  the roster could not be read'];
  const rows = users.filter(u => u && typeof u === 'object' && !u.isSystemAccount);
  const idOf = u => (u.id === undefined || u.id === null ? '(no id)' : String(u.id));

  const noFlag = rows.filter(u => typeof u.active !== 'boolean').map(idOf);
  // Observer means the person resigned and kept a badge and a read-only login. Taking them off the
  // roster is `active:false`; Observer with active:true is a resigned person still being paid.
  const observerOnRoster = rows.filter(u => u.isObserver === true && u.active !== false).map(idOf);

  const lines = [`  ${rows.length} records (the system account is not one)`];
  if (noFlag.length) {
    lines.push(`  ${noFlag.length} with no boolean \`active\`, so nobody ever recorded whether they left: id ${noFlag.join(', ')}`);
  }
  if (observerOnRoster.length) {
    lines.push(`  ${observerOnRoster.length} Observer still on the payroll roster (Observer means resigned, so \`active\` must be false): id ${observerOnRoster.join(', ')}`);
  }
  if (!noFlag.length && !observerOnRoster.length) lines.push('  every record says whether the person is still here');
  return lines;
}

module.exports = { describeRosterHealth };
