// The registry of checks behind `npm run backlog` (2026-10-12).
//
// `npm run backlog` answers "what is still open?" by re-checking each open STATUS.md item against
// the real code instead of trusting what the item says. scripts/lib/backlog-status.js reads the
// items; this file holds the check behind every `· ตรวจ: <id>` marker. It is data and logic only:
// it prints nothing and knows nothing about how the verdicts are laid out (scripts/backlog.js does
// that).
//
//   CHECKS = { [id]: { describe: string, run: () => ({ verdict, evidence }) } }
//   verdict  one of 'PASS' | 'FAIL' | 'NOT-VERIFIED' | 'WAITING-OWNER'
//   evidence a human-readable string, one finding per line (separated by "\n")
//
// Three rules, from the plan's "conflict with status.js" section. They exist because the whole
// feature is pointless if it becomes a machine that prints green lines nobody checked:
//   1. No PASS without evidence. A PASS carries a real `file:line` or real command output. When a
//      check cannot find its evidence the verdict is NOT-VERIFIED, never PASS.
//   2. Never guess on the owner's behalf. An item whose STATUS.md text has a `· รอเจ้าของ:` line is
//      WAITING-OWNER even when the part this file can check passes. applyOwnerGate() below applies
//      that to every check, so no individual check can forget it.
//   3. run() never throws. Every read is guarded, and an unexpected error becomes NOT-VERIFIED with
//      the reason, the same promise scripts/lib/data-files.js makes for `npm run status`.
//
// A fourth rule came out of review (2026-10-12): evidence states only what was measured. A sentence
// such as "nothing was written" or "identical copies" is printed only when the fields it rests on
// say so; otherwise the check says what the log did record and stops there.
//
// The registry is bound to STATUS.md in both directions by tests/backlog-registry.test.js: an id
// used by an item but missing here, and an id here that no item uses, are both red. A check is
// therefore added in the same commit as its item and removed in the same commit that closes it.
// tests/backlog-checks.test.js keeps rules 2 and 3 and the shape matching below alive.
//
// All text here is English on purpose: this runs in a plain Windows console where Thai prints as
// question marks.
'use strict';
const fs = require('fs');
const path = require('path');
const { parseStatus } = require('./backlog-status');

const ROOT = path.join(__dirname, '..', '..');
const STATUS_PATH = path.join(ROOT, 'STATUS.md');

const lines = (...parts) => parts.join('\n');
const errText = e => (e && e.message ? e.message : String(e));
// 2026-10-12 (review): sync.log on the NAS starts with a byte-order mark. `^(\S+)` does not match
// U+FEFF, so a log whose only DIRTY run was line 1 read as "no DIRTY run". Strip it from every text
// this file parses.
const readText = p => fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '');

// ---------------------------------------------------------------------------------------------
// Reading the memory-sync contract off sync_memory.ps1
// ---------------------------------------------------------------------------------------------
// 2026-10-13: these two used to serve the sync-push-false-success check, which is gone (see the
// registry below). They stay because scripts/lib/sync-health.js reads the same pattern list to say
// which files the sync can and cannot carry, and that block is what surfaced the 2026-10-13 silent
// push failure in `npm run backlog`.
// Wildcard from a PowerShell -Include pattern ('feedback_attendance*.md') to a RegExp. -Include is
// case-insensitive.
function wildcardToRegExp(w) {
  const body = w.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${body}$`, 'i');
}

// The `$Patterns = @( ... )` array of sync_memory.ps1 in `dir`, or null when it cannot be read. Read
// from the script itself so nothing here keeps a second copy of the list that could drift from the
// real one. Exported so the sync-health block does not write a second parser.
function readSyncPatterns(dir) {
  try {
    const text = readText(path.join(dir, 'sync_memory.ps1'));
    const start = text.search(/\$Patterns\s*=\s*@\(/);
    if (start === -1) return null;
    const end = text.indexOf('\n)', start);
    if (end === -1) return null;
    const found = [];
    const rows = text.slice(start, end).split(/\r?\n/);
    if (!/@\(\s*(?:#.*)?$/.test(rows[0])) return null; // a pattern on the opening line would be skipped below
    for (const l of rows.slice(1)) {
      if (l.trim() === '' || /^\s*#/.test(l)) continue; // blank, or a commented-out pattern
      // One single-quoted pattern per line, optionally followed by a comma and a comment. Any other
      // non-comment line (a double-quoted pattern, two patterns on one line, a variable) is a pattern
      // this reader would otherwise skip without a record, and every caller then compares and counts
      // against a list that is not THE list. Refuse the whole list instead (2026-10-13 review).
      const m = l.match(/^\s*'([^']+)'\s*,?\s*(?:#.*)?$/);
      if (!m) return null;
      found.push(m[1]);
    }
    return found.length ? found : null;
  } catch (e) { return null; }
}

// ---------------------------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------------------------
// 2026-10-13: empty on purpose, and that is a real state, not a gap. The only entry was
// sync-push-false-success, whose own NOT-VERIFIED evidence said what to do once the shape of that
// code changed: read the script by hand, and if the defect is gone, close the item and delete the
// check in the same commit. It changed because the defect was fixed that day -- `push=ok` now
// requires that every dirty file a pattern can carry is in step on the NAS -- and the guard for
// that behaviour is tests/memory-sync.test.js, which exercises the real script instead of matching
// its text. A check belongs here only while it tracks a LIVE defect for an item in STATUS.md.
const RAW_CHECKS = {};

// Rule 2 for every check at once: if the item carries a `· รอเจ้าของ:` line the owner decides, so
// the verdict is WAITING-OWNER whatever the code check said. The check's own result stays in the
// evidence. If STATUS.md cannot be read the owner's state is unknown: a PASS is held back as
// NOT-VERIFIED, and a FAIL or NOT-VERIFIED keeps its verdict but says the owner-wait state was never
// checked (2026-10-12 review: it used to come back with no hint of that).
// `statusPath` is a parameter so the gate can be exercised on a fixture.
function applyOwnerGate(id, result, statusPath = STATUS_PATH) {
  let item;
  try {
    item = parseStatus(readText(statusPath)).open.find(o => o.checkId === id);
  } catch (e) {
    const note = `owner-wait state NOT checked: STATUS.md could not be read or parsed (${errText(e)})`;
    if (result.verdict === 'PASS') {
      return { verdict: 'NOT-VERIFIED', evidence: lines('the check passed, but ' + note, result.evidence) };
    }
    return { verdict: result.verdict, evidence: lines(result.evidence, note) };
  }
  if (!item || item.waitingOwner === null) return result;
  return {
    verdict: 'WAITING-OWNER',
    evidence: lines(`STATUS.md:${item.line}: awaiting the owner: ${item.waitingOwner}`,
      `the code check on its own says ${result.verdict}:`, result.evidence),
  };
}

const VERDICTS = ['PASS', 'FAIL', 'NOT-VERIFIED', 'WAITING-OWNER'];

// Rule 3, and a guard on the shape of what a check returns: a check that answers with a verdict
// outside the four, or a PASS with nothing to show, is reported as NOT-VERIFIED instead of being
// passed on.
function guarded(id, check, statusPath) {
  return {
    describe: check.describe,
    run() {
      let result;
      try { result = check.run(); }
      catch (e) { return { verdict: 'NOT-VERIFIED', evidence: `check "${id}" threw: ${errText(e)}` }; }
      if (!result || !VERDICTS.includes(result.verdict)) {
        return { verdict: 'NOT-VERIFIED', evidence: `check "${id}" returned no usable verdict` };
      }
      const evidence = typeof result.evidence === 'string' ? result.evidence : '';
      if (result.verdict === 'PASS' && evidence.trim() === '') {
        return { verdict: 'NOT-VERIFIED', evidence: `check "${id}" said PASS but gave no evidence` };
      }
      try { return applyOwnerGate(id, { verdict: result.verdict, evidence }, statusPath); }
      catch (e) { return { verdict: 'NOT-VERIFIED', evidence: `check "${id}" could not apply the owner gate: ${errText(e)}` }; }
    },
  };
}

const CHECKS = {};
for (const id of Object.keys(RAW_CHECKS)) CHECKS[id] = guarded(id, RAW_CHECKS[id]);

// What is exported is what tests/backlog-checks.test.js drives with fixtures; `npm run backlog`
// itself only reads CHECKS, which is empty as of 2026-10-13. readSyncPatterns and wildcardToRegExp are
// exported for the sync-health block, which needs the same pattern list.
module.exports = {
  CHECKS, applyOwnerGate, guarded,
  readSyncPatterns, wildcardToRegExp, VERDICTS,
};
