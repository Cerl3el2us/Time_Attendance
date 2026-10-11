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
  // The wording matters: status.js's own rule is that a thing which was not measured says so.
  if (!Array.isArray(users)) return ['  NOT measured -- users.json is not a list of records'];

  const rows = [];
  let skipped = 0;
  for (const u of users) {
    if (u && typeof u === 'object' && !Array.isArray(u)) rows.push(u);
    else skipped++;
  }
  // 2026-10-11 (review round 2): exclude the way the SERVER excludes, not the way the screens do.
  // systemAccount.js:28 reads `isSystemAccount === true || username === 'superadmin'`, while
  // app.js's isEmployeeRecord reads the flag truthily. For a record carrying `isSystemAccount: 1`
  // those disagree: the server pays it as an employee, the screens hide it. Excluding truthily
  // here would have left exactly that record unchecked by everything below -- and then printed
  // the clean line. Follow the reading that decides money, and report the mismatch separately.
  const isSystemAccount = u =>
    u.isSystemAccount === true || String(u.username || '').toLowerCase() === 'superadmin';
  const employees = rows.filter(u => !isSystemAccount(u));
  const idOf = u => (u.id === undefined || u.id === null ? '(no id)' : String(u.id));

  const noFlag = employees.filter(u => typeof u.active !== 'boolean').map(idOf);
  // The mirror of the check above. server.js reads isObserver strictly in some gates
  // (`isObserver !== true`) and as a truthy value in others, so a non-boolean makes someone an
  // Observer for one gate and not for another.
  const badObserver = employees
    .filter(u => u.isObserver !== undefined && typeof u.isObserver !== 'boolean').map(idOf);
  // The same disease on the flag that decides whether someone is an employee at all.
  const badSystemFlag = employees
    .filter(u => u.isSystemAccount !== undefined && typeof u.isSystemAccount !== 'boolean').map(idOf);
  // Observer means the person resigned and kept a badge and a read-only login. Taking them off the
  // roster is `active:false`; Observer with active:true is a resigned person still being paid.
  const observerOnRoster = employees
    .filter(u => u.isObserver === true && u.active !== false).map(idOf);
  // Nothing else in this project guards this, and computeYearEndCarryForward() keys its output
  // `${year}_${u.id}` -- two records sharing an id overwrite each other's carry-forward silently.
  // Records with no id at all do not share one, and the missing-flag line already names them.
  const seen = new Map();
  employees.filter(u => u.id !== undefined && u.id !== null)
    .forEach(u => { const k = idOf(u); seen.set(k, (seen.get(k) || 0) + 1); });
  const duplicates = Array.from(seen.entries()).filter(([, n]) => n > 1).map(([k]) => k);

  const lines = [`  ${employees.length} records (the system account is not one)`];
  if (skipped) {
    lines.push(`  ${skipped} entr${skipped === 1 ? 'y was' : 'ies were'} not a record at all and could not be checked`);
  }
  if (noFlag.length) {
    lines.push(`  ${noFlag.length} with no boolean \`active\`, so nobody ever recorded whether they left: id ${noFlag.join(', ')}`);
  }
  if (badObserver.length) {
    lines.push(`  ${badObserver.length} with a non-boolean \`isObserver\`, which different gates read differently: id ${badObserver.join(', ')}`);
  }
  if (badSystemFlag.length) {
    lines.push(`  ${badSystemFlag.length} with a non-boolean \`isSystemAccount\`: the server pays this record as an employee while the screens hide it: id ${badSystemFlag.join(', ')}`);
  }
  if (observerOnRoster.length) {
    lines.push(`  ${observerOnRoster.length} Observer still on the payroll roster (Observer means resigned, so \`active\` must be false): id ${observerOnRoster.join(', ')}`);
  }
  if (duplicates.length) {
    lines.push(`  ${duplicates.length} id used by more than one record, which overwrites itself wherever id is a key: id ${duplicates.join(', ')}`);
  }
  // Nobody to check is not a clean bill of health -- the sibling module says "no .json files here"
  // rather than reporting on nothing.
  if (!employees.length) lines.push('  no employee records to check');
  else if (lines.length === 1) lines.push('  every record says whether the person is still here');
  return lines;
}

module.exports = { describeRosterHealth };
