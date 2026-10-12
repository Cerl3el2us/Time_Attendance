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
//      WAITING-OWNER even when the part this file can check passes. withOwnerGate() below applies
//      that to every check, so no individual check can forget it.
//   3. run() never throws. Every read is guarded, and an unexpected error becomes NOT-VERIFIED with
//      the reason, the same promise scripts/lib/data-files.js makes for `npm run status`.
//
// The registry is bound to STATUS.md in both directions by tests/backlog-registry.test.js: an id
// used by an item but missing here, and an id here that no item uses, are both red. A check is
// therefore added in the same commit as its item and removed in the same commit that closes it.
//
// All text here is English on purpose: this runs in a plain Windows console where Thai prints as
// question marks.
'use strict';
const fs = require('fs');
const path = require('path');
const { parseStatus } = require('./backlog-status');

const ROOT = path.join(__dirname, '..', '..');
const STATUS_PATH = path.join(ROOT, 'STATUS.md');

// The live memory-sync scripts. They live on the NAS (Z: is production), not in this repo, so a
// machine without the drive mapped cannot check them -- and says so rather than guessing.
const NAS_MEMORY_DIR = 'Z:\\claude_memory';

const lines = (...parts) => parts.join('\n');
const errText = e => (e && e.message ? e.message : String(e));
// Console-safe: a quoted line of code may carry Thai in a trailing comment.
const ascii = s => String(s).replace(/[^\x20-\x7e]/g, '?');
const isFile = p => { try { return fs.statSync(p).isFile(); } catch (e) { return false; } };

// ---------------------------------------------------------------------------------------------
// backlog-command: this feature's own deliverables
// ---------------------------------------------------------------------------------------------
// The item is the piece of work that builds this very command, so the check looks for what the
// work is supposed to leave behind. It reports FAIL, honestly, until all three exist. The task that
// closes the item deletes the STATUS.md entry and this check in the same commit.
function checkBacklogCommand(root = ROOT) {
  const scriptRel = 'scripts/backlog.js';
  const cmdRel = '.claude/commands/backlog.md';
  const pkgRel = 'package.json';
  const scriptPath = path.join(root, 'scripts', 'backlog.js');
  const cmdPath = path.join(root, '.claude', 'commands', 'backlog.md');
  const pkgPath = path.join(root, 'package.json');

  const hasScript = isFile(scriptPath);
  const hasCmd = isFile(cmdPath);

  let hasEntry = false;
  let entryLine = null;
  let pkgNote = null;
  try {
    const text = fs.readFileSync(pkgPath, 'utf8');
    const scripts = JSON.parse(text).scripts;
    hasEntry = !!scripts && typeof scripts === 'object'
      && Object.prototype.hasOwnProperty.call(scripts, 'backlog');
    if (hasEntry) {
      // The line of the `"backlog"` key inside the scripts block (not any other mention of the word).
      const all = text.split(/\r?\n/);
      const from = all.findIndex(l => /^\s*"scripts"\s*:/.test(l));
      const at = from === -1 ? -1 : all.findIndex((l, i) => i > from && /^\s*"backlog"\s*:/.test(l));
      if (at !== -1) entryLine = at + 1;
    }
  } catch (e) {
    pkgNote = `${pkgRel} could not be read as JSON: ${errText(e)}`;
  }

  if (pkgNote) return { verdict: 'NOT-VERIFIED', evidence: pkgNote };

  const missing = [];
  if (!hasScript) missing.push(`${scriptRel} does not exist`);
  if (!hasEntry) missing.push(`${pkgRel} has no "backlog" entry in its "scripts" block`);
  if (!hasCmd) missing.push(`${cmdRel} does not exist`);
  if (missing.length) {
    return { verdict: 'FAIL', evidence: `${missing.length} of 3 deliverables missing: ${missing.join('; ')}` };
  }
  if (entryLine === null) {
    return { verdict: 'NOT-VERIFIED', evidence: `${pkgRel} has a "backlog" script but its line could not be located, so there is nothing to cite` };
  }
  return {
    verdict: 'PASS',
    evidence: lines(
      `${pkgRel}:${entryLine} has the "backlog" script`,
      `${scriptRel} exists`,
      `${cmdRel} exists`),
  };
}

// ---------------------------------------------------------------------------------------------
// sync-push-false-success: the automatic memory push can report success while copying nothing
// ---------------------------------------------------------------------------------------------
// Failure scenario: docs/superpowers/notes/2026-10-12-memory-sync-known-limits.md items 1-2.
// sync_if_dirty.ps1 decides "the push worked" from the exit code and the failed count alone, then
// writes the marker that makes the folder read CLEAN. It never asks whether anything was copied or
// whether every dirty file was accounted for, so a push that left the NAS copy untouched still
// clears the marker -- and the next `pull` overwrites the newer local file with the older NAS one.

// Wildcard from a PowerShell -Include pattern ('feedback_attendance*.md') to a RegExp. -Include is
// case-insensitive.
function wildcardToRegExp(w) {
  const body = w.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${body}$`, 'i');
}

// The `$Patterns = @( ... )` array of sync_memory.ps1, or null when it cannot be read. Read from the
// script itself so this never keeps a second copy of the list that could drift from the real one.
function readSyncPatterns(dir) {
  try {
    const text = fs.readFileSync(path.join(dir, 'sync_memory.ps1'), 'utf8');
    const start = text.search(/\$Patterns\s*=\s*@\(/);
    if (start === -1) return null;
    const end = text.indexOf('\n)', start);
    if (end === -1) return null;
    const found = [];
    for (const l of text.slice(start, end).split(/\r?\n/).slice(1)) {
      const m = l.match(/^\s*'([^']+)'/); // a commented-out pattern starts with `#`, so it is skipped
      if (m) found.push(m[1]);
    }
    return found.length ? found : null;
  } catch (e) { return null; }
}

const DIRTY_RUN = new RegExp('^(\\S+)\\s+DIRTY (\\d+)\\s+push=(\\S+)\\s+rc=(\\S+)\\s+'
  + '(?:summary=UNREADABLE|copied=(\\d+) same=(\\d+) conflict=(\\d+) failed=(\\d+))'
  + '\\s+needs-eyes=(.*?)\\s+snapshot=\\S*\\s+marker=(\\S+)(?:\\s+files=(.*))?$');

// The last DIRTY run in sync.log, as { no, raw, dirty, push, rc, copied, same, conflict, failed,
// marker, names, more } -- or { error } when there is none to read.
function readLastRun(dir) {
  let text;
  try { text = fs.readFileSync(path.join(dir, 'sync.log'), 'utf8'); }
  catch (e) { return { error: `sync.log could not be read: ${errText(e)}` }; }
  const all = text.split(/\r?\n/);
  let lastNo = -1;
  for (let i = all.length - 1; i >= 0; i--) { if (all[i].trim() !== '') { lastNo = i + 1; break; } }
  if (lastNo === -1) return { error: 'sync.log is empty' };
  for (let i = lastNo - 1; i >= 0; i--) {
    const m = all[i].match(DIRTY_RUN);
    if (!m) continue;
    const files = m[11] || '';
    const more = files.match(/\s*\(\+(\d+)\)\s*$/);
    const names = files.replace(/\s*\(\+\d+\)\s*$/, '').split(',').map(s => s.trim()).filter(Boolean);
    const num = k => (m[k] === undefined ? null : Number(m[k]));
    return {
      no: i + 1, lastNo, raw: all[i], dirty: Number(m[2]), push: m[3], rc: m[4],
      copied: num(5), same: num(6), conflict: num(7), failed: num(8), marker: m[10],
      names, more: more ? Number(more[1]) : 0,
    };
  }
  return { error: `sync.log (${lastNo} lines) has no DIRTY run to read; its last line is not one` };
}

function describeLastRun(dir) {
  const run = readLastRun(dir);
  if (run.error) return `sync.log: ${run.error}`;
  const out = [];
  const where = run.no === run.lastNo ? `sync.log:${run.no}` : `sync.log:${run.no} (latest DIRTY run; the last line, ${run.lastNo}, is a different kind of entry)`;
  out.push(`${where}: ${ascii(run.raw).slice(0, 400)}${run.raw.length > 400 ? ' ...' : ''}`);
  if (run.copied === null) {
    out.push('the run summary was unreadable, so what reached the NAS is unknown');
    return out.join('\n');
  }
  const total = run.copied + run.same + run.conflict + run.failed;
  // 2026-10-12: the four counts are over EVERY file matching $Patterns, not only the dirty ones
  // (sync_memory.ps1 walks the whole folder), so `DIRTY n == copied+same+conflict+failed` is true
  // only when every file happened to be dirty. It cannot prove or disprove a skipped file, and
  // reading a mismatch as "files were skipped" would invent a defect on every ordinary run.
  out.push(`DIRTY ${run.dirty}; the run counted ${total} pattern-matching files in all (copied=${run.copied} same=${run.same} conflict=${run.conflict} failed=${run.failed}), which is every matching file, not only the dirty ones, so the totals cannot show a skipped file`);
  if (run.copied === 0 && run.dirty > 0) {
    out.push(`copied=0 with ${run.dirty} dirty file(s) and marker=${run.marker}: nothing was written to the NAS, yet the folder was marked clean`);
  }
  // What CAN be proven from the log: a dirty file whose NAME does not match the sync script's
  // patterns is never copied. The log lists at most the first five dirty names.
  const patterns = readSyncPatterns(dir);
  if (!patterns) {
    out.push('the $Patterns list of sync_memory.ps1 could not be read, so the dirty file names were not tested against it');
  } else {
    const res = patterns.map(wildcardToRegExp);
    const skipped = run.names.filter(n => !res.some(r => r.test(n)));
    const unseen = run.more > 0 ? ` (${run.more} more dirty name(s) are not listed in the log and were not tested)` : '';
    if (skipped.length) {
      out.push(`LIVE INSTANCE: ${skipped.length} dirty file(s) match none of the sync patterns and were never copied, yet marker=${run.marker}: ${skipped.map(ascii).join(', ')}${unseen}`);
    } else {
      out.push(`the ${run.names.length} dirty name(s) listed in the log all match a sync pattern, so the log shows no skipped file in this run${unseen}${run.copied === 0 && run.conflict === 0 && run.failed === 0 ? '; with no conflict and no failure, copied=0 here means the NAS already held identical copies' : ''}`);
    }
  }
  return out.join('\n');
}

function checkSyncPushFalseSuccess(dir = NAS_MEMORY_DIR) {
  const scriptPath = path.join(dir, 'sync_if_dirty.ps1');
  const scriptName = 'sync_if_dirty.ps1';
  let src;
  try { src = fs.readFileSync(scriptPath, 'utf8'); }
  catch (e) {
    return {
      verdict: 'NOT-VERIFIED',
      evidence: `could not read ${scriptPath} (${errText(e)}): this machine cannot reach the NAS memory folder (another machine, or the drive is not mapped), so the sync code was not checked`,
    };
  }

  const all = src.split(/\r?\n/);
  // Find the decision by what it is, not by a line number: the script is edited from other machines.
  const decideAt = all.findIndex(l => /^\s*\$pushOk\s*=/.test(l));
  if (decideAt === -1) {
    return { verdict: 'NOT-VERIFIED', evidence: `${scriptName} has no "$pushOk =" line any more, so the success decision could not be located; read the script by hand` };
  }
  const decide = all[decideAt];
  const code = decide.split('#')[0]; // a trailing comment is not logic
  const accounts = /copied|dirty|conflict/i.test(code);

  // The marker write that follows the decision, and the `if ($pushOk)` that guards it.
  const guardAt = all.findIndex((l, i) => i > decideAt && /^\s*if\s*\(\s*\$pushOk\s*\)/.test(l));
  const markerAt = all.findIndex((l, i) => i > decideAt && /Set-Content\b.*"pushed\b/.test(l));
  const markerCite = (guardAt !== -1 && markerAt !== -1)
    ? `marker written at ${scriptName}:${markerAt + 1} (${ascii(all[markerAt].trim())}), guarded only by "if ($pushOk)" at :${guardAt + 1}`
    : 'the marker write that follows could not be located in the script';
  const decideCite = `${scriptName}:${decideAt + 1}: ${ascii(decide.trim())}`;
  const logPart = describeLastRun(dir);

  if (accounts) {
    // The line now mentions accounting, which is not the same as a fix: a mention could be a log
    // string or a dead branch. Do not turn that into a green line.
    return {
      verdict: 'NOT-VERIFIED',
      evidence: lines(decideCite,
        'the success decision now mentions copied/dirty/conflict, so the defect may be fixed, but this check only looks for the old shape and will not call it fixed on a mention; read the code and the marker guard by hand',
        markerCite, logPart),
    };
  }
  return {
    verdict: 'FAIL',
    evidence: lines(decideCite,
      'push counts as ok on the exit code and failed=0 alone: it never requires that anything was copied or that every dirty file was accounted for',
      markerCite, logPart),
  };
}

// ---------------------------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------------------------
const RAW_CHECKS = {
  'backlog-command': {
    describe: 'The command that checks this backlog: scripts/backlog.js, a "backlog" script in package.json and .claude/commands/backlog.md must all exist.',
    run: () => checkBacklogCommand(),
  },
  'sync-push-false-success': {
    describe: 'The automatic memory push (sync_if_dirty.ps1) decides success from the exit code and failed=0 alone, so it can write its marker after copying nothing; reads the success line, the marker write and the last sync.log run on the NAS.',
    run: () => checkSyncPushFalseSuccess(),
  },
};

// Rule 2 for every check at once: if the item carries a `· รอเจ้าของ:` line the owner decides, so
// the verdict is WAITING-OWNER whatever the code check said. The check's own result stays in the
// evidence. If STATUS.md cannot be read the owner's state is unknown, so a PASS is held back as
// NOT-VERIFIED; a FAIL or NOT-VERIFIED is already not green and stays as it is.
// `statusPath` is a parameter so the gate can be exercised on a fixture.
function applyOwnerGate(id, result, statusPath = STATUS_PATH) {
  let item;
  try {
    item = parseStatus(fs.readFileSync(statusPath, 'utf8')).open.find(o => o.checkId === id);
  } catch (e) {
    if (result.verdict !== 'PASS') return result;
    return {
      verdict: 'NOT-VERIFIED',
      evidence: lines(`the check passed, but STATUS.md could not be read to see whether the item awaits the owner (${errText(e)})`, result.evidence),
    };
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
function guarded(id, check) {
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
      try { return applyOwnerGate(id, { verdict: result.verdict, evidence }); }
      catch (e) { return { verdict: 'NOT-VERIFIED', evidence: `check "${id}" could not apply the owner gate: ${errText(e)}` }; }
    },
  };
}

const CHECKS = {};
for (const id of Object.keys(RAW_CHECKS)) CHECKS[id] = guarded(id, RAW_CHECKS[id]);

// checkBacklogCommand, checkSyncPushFalseSuccess and applyOwnerGate are exported so a throwaway
// script can point them at a fixture; the command itself only reads CHECKS.
module.exports = { CHECKS, checkBacklogCommand, checkSyncPushFalseSuccess, applyOwnerGate };
