/*
 * One-time migration / safety check for the 2026-08-01 "freeze paid payroll periods" feature.
 *
 * Finds any md_YYYYMMDD_userId record in finalize.json with approved===true that has no
 * matching snap_YYYYMMDD_userId snapshot (i.e. was approved before this feature existed), and
 * backfills a frozen snapshot for it using TODAY's config -- which is exactly what that payslip
 * already displays right now, so backfilling is behavior-neutral on day one and simply stops
 * all further drift from this moment forward. See project memory
 * project_time_attendance_payroll_snapshot_immutability.md for the full design rationale.
 *
 * SAFE-BY-CONSTRUCTION NOTE: this script deliberately does NOT `require('./server.js')` to reuse
 * getPayrollView()/computePayroll() -- server.js has no module.exports, registers routes and a
 * websocket server, and calls server.listen()/httpsServer.listen() unconditionally at the top
 * level. Safely importing just its pure functions would require monkey-patching net.Server's
 * listen method and hoping nothing else in that 2800-line file has an unexpected side effect
 * (secret-file creation, interval timers, Hikvision polling) when loaded outside its normal
 * single-process lifecycle -- not a risk worth taking on a live NAS for a one-off maintenance
 * script. Instead this script only ever READS finalize.json and REPORTS. If it finds anything
 * to backfill, it deliberately does NOT compute the numbers itself -- it prints exactly which
 * records need it and refuses to proceed, so a human decides how to backfill safely (the
 * cleanest real path: temporarily call POST /api/md-approve with action 'revoke' then 'approve'
 * again on the ALREADY-RUNNING server for just that record, accepting that this resets
 * approvedAt/approvedBy to now -- or extend this script to hit a purpose-built one-off internal
 * endpoint on the live server if that resets is unacceptable).
 *
 * Verified 2026-08-01: production finalize.json is `{}` -- this script is expected to report
 * zero records needing backfill. Still run it before/after deploying the lock-enforcing changes,
 * in case an approval happened in between.
 *
 * Usage (on the NAS, in this directory): node migrate_snapshot_approved.js
 */
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const FINALIZE_FILE = path.join(DATA_DIR, 'finalize.json');

function readJSON(name, fallback) {
  try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, name), 'utf8')); }
  catch (e) { return fallback; }
}

function main() {
  const data = readJSON('finalize.json', {});
  const mdKeys = Object.keys(data).filter(k => k.startsWith('md_') && data[k]?.approved === true);

  const needsBackfill = mdKeys.filter(mdKey => {
    const suffix = mdKey.slice(3); // strip "md_" -> "YYYYMMDD_userId"
    return !data[`snap_${suffix}`];
  });

  console.log(`[migrate_snapshot_approved] Checked ${Object.keys(data).length} finalize.json keys.`);
  console.log(`[migrate_snapshot_approved] ${mdKeys.length} approved record(s) found.`);

  if (needsBackfill.length === 0) {
    console.log('[migrate_snapshot_approved] Nothing to backfill -- every approved record already has a snapshot (or there are no approved records at all). Safe to proceed with deploy.');
    process.exit(0);
  }

  console.error('[migrate_snapshot_approved] The following approved record(s) have NO snapshot yet:');
  needsBackfill.forEach(mdKey => {
    const suffix = mdKey.slice(3);
    console.error(`  - ${mdKey}  (approvedBy: ${data[mdKey].approvedBy}, approvedAt: ${data[mdKey].approvedAt})`);
  });
  console.error('');
  console.error('[migrate_snapshot_approved] STOPPING -- do not deploy the lock-enforcing server.js changes');
  console.error('until these are backfilled, or a subsequent Settings/salary change will silently alter what');
  console.error('these already-approved payslips show. Safest path with the tools this script has:');
  console.error('  1. Back up data/finalize.json first.');
  console.error('  2. For EACH record above, once the new server.js is deployed, call:');
  console.error('       POST /api/md-approve  { userId, periodIndex, action: "revoke" }');
  console.error('       POST /api/md-approve  { userId, periodIndex, action: "approve" }');
  console.error('     as MD, via the app UI (Payslip page -> Revoke -> Approve again). This captures a');
  console.error('     fresh snapshot at TODAY\'s numbers (identical to what is showing right now) but resets');
  console.error('     approvedAt/approvedBy to this moment -- acceptable given today\'s numbers are unchanged,');
  console.error('     but confirm with the user first since it does rewrite the approval audit trail.');
  process.exit(1);
}

main();
