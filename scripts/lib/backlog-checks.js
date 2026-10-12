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

// The live memory-sync scripts. They live on the NAS (Z: is production), not in this repo, so a
// machine without the drive mapped cannot check them -- and says so rather than guessing.
const NAS_MEMORY_DIR = 'Z:\\claude_memory';

const lines = (...parts) => parts.join('\n');
const errText = e => (e && e.message ? e.message : String(e));
// Console-safe: a quoted line of code may carry Thai in a trailing comment.
const ascii = s => String(s).replace(/[^\x20-\x7e]/g, '?');
const isFile = p => { try { return fs.statSync(p).isFile(); } catch (e) { return false; } };
const sizeOf = p => { try { return fs.statSync(p).size; } catch (e) { return 0; } };
// 2026-10-12 (review): sync.log on the NAS starts with a byte-order mark. `^(\S+)` does not match
// U+FEFF, so a log whose only DIRTY run was line 1 read as "no DIRTY run". Strip it from every text
// this file parses.
const readText = p => fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '');

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
  const scriptBytes = sizeOf(scriptPath);
  const hasCmd = isFile(cmdPath);

  let entry = null;       // the value of scripts.backlog, or null when there is none
  let entryLine = null;
  try {
    const text = readText(pkgPath);
    const scripts = JSON.parse(text).scripts;
    if (scripts && typeof scripts === 'object' && Object.prototype.hasOwnProperty.call(scripts, 'backlog')) {
      entry = String(scripts.backlog);
      // The line of the `"backlog"` key inside the scripts block (not any other mention of the word).
      const all = text.split(/\r?\n/);
      const from = all.findIndex(l => /^\s*"scripts"\s*:/.test(l));
      const at = from === -1 ? -1 : all.findIndex((l, i) => i > from && /^\s*"backlog"\s*:/.test(l));
      if (at !== -1) entryLine = at + 1;
    }
  } catch (e) {
    return { verdict: 'NOT-VERIFIED', evidence: `${pkgRel} could not be read as JSON: ${errText(e)}` };
  }

  // 2026-10-12 (review): existence alone passed an empty scripts/backlog.js wired to
  // `"backlog": "echo hi"`. The script must have content and the package.json entry must run it.
  const missing = [];
  if (!hasScript) missing.push(`${scriptRel} does not exist`);
  else if (scriptBytes === 0) missing.push(`${scriptRel} is empty`);
  if (entry === null) missing.push(`${pkgRel} has no "backlog" entry in its "scripts" block`);
  else if (!entry.includes(scriptRel)) missing.push(`${pkgRel} "backlog" script is ${JSON.stringify(entry)}, which does not run ${scriptRel}`);
  if (!hasCmd) missing.push(`${cmdRel} does not exist`);
  if (missing.length) {
    return { verdict: 'FAIL', evidence: `${missing.length} of 3 deliverables missing or unusable: ${missing.join('; ')}` };
  }
  if (entryLine === null) {
    return { verdict: 'NOT-VERIFIED', evidence: `${pkgRel} has a "backlog" script but its line could not be located, so there is nothing to cite` };
  }
  return {
    verdict: 'PASS',
    evidence: lines(
      `${pkgRel}:${entryLine} "backlog": ${JSON.stringify(entry)}`,
      `${scriptRel} exists (${scriptBytes} bytes)`,
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

// The last DIRTY run in sync.log, as { no, lastNo, raw, dirty, push, rc, copied, same, conflict,
// failed, marker, names, more } -- or { error } when there is none to read.
function readLastRun(dir) {
  let text;
  try { text = readText(path.join(dir, 'sync.log')); }
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

// What the latest DIRTY run in sync.log says, stating only what its fields support.
function describeLastRun(dir) {
  const run = readLastRun(dir);
  if (run.error) return `sync.log: ${run.error}`;
  const out = [];
  const where = run.no === run.lastNo ? `sync.log:${run.no}` : `sync.log:${run.no} (latest DIRTY run; the last line, ${run.lastNo}, is a different kind of entry)`;
  out.push(`${where}: ${ascii(run.raw).slice(0, 400)}${run.raw.length > 400 ? ' ...' : ''}`);
  if (run.copied === null) {
    out.push('the run summary was unreadable, so the log does not say what reached the NAS');
    return out.join('\n');
  }
  const total = run.copied + run.same + run.conflict + run.failed;
  // 2026-10-12: the four counts are over EVERY file matching $Patterns, not only the dirty ones
  // (sync_memory.ps1 walks the whole folder), so `DIRTY n == copied+same+conflict+failed` is true
  // only when every file happened to be dirty. It cannot prove or disprove a skipped file, and
  // reading a mismatch as "files were skipped" would invent a defect on every ordinary run.
  out.push(`DIRTY ${run.dirty}; the run counted ${total} pattern-matching files in all (copied=${run.copied} same=${run.same} conflict=${run.conflict} failed=${run.failed}), which is every matching file, not only the dirty ones, so the totals cannot show a skipped file`);

  // 2026-10-12 (review): these sentences used to print whenever copied=0, even on a failed push whose
  // marker was kept. They are about a run that CLEARED the dirty state, so they need push=ok and
  // marker=written. And "identical copies" was never measured: `same` also counts files skipped
  // because they sit in the NAS archive\ and files judged equal by size and mtime without a hash.
  const cleared = run.push === 'ok' && run.marker === 'written';
  if (run.copied === 0 && run.dirty > 0) {
    if (cleared) {
      out.push(`copied=0 with ${run.dirty} dirty file(s), push=ok and marker=written: nothing was copied to the NAS, yet the folder was marked clean`
        + (run.conflict === 0 && run.failed === 0 ? '; with no conflict and no failure the files were counted as same (size and mtime, not a hash)' : ''));
    } else {
      out.push(`copied=0 with ${run.dirty} dirty file(s), but push=${run.push} marker=${run.marker}: this run did not mark the folder clean`);
    }
  }

  // What the log CAN show: a dirty file whose NAME matches no sync pattern is never copied. The log
  // lists at most the first five dirty names, and a name test cannot see the subfolders:
  // sync_if_dirty.ps1 scans every non-dot subfolder while sync_memory.ps1 copies only the top level
  // and archive\, so a matching name inside another subfolder would be dirty and never copied.
  const patterns = readSyncPatterns(dir);
  if (!patterns) {
    out.push('the $Patterns list of sync_memory.ps1 could not be read, so the dirty file names were not tested against it');
  } else {
    const res = patterns.map(wildcardToRegExp);
    const excluded = run.names.filter(n => !res.some(r => r.test(n)));
    const unseen = run.more > 0 ? `; ${run.more} more dirty name(s) are not listed in the log and were not tested` : '';
    if (excluded.length) {
      out.push(excluded.length + ' listed dirty name(s) match none of the sync patterns, so sync_memory.ps1 never copies them: '
        + excluded.map(ascii).join(', ')
        + (cleared ? `; the run still ended with marker=${run.marker}, a live instance of the defect` : `; this run ended with push=${run.push} marker=${run.marker}`)
        + unseen);
    } else {
      out.push(`no listed name is excluded by name (${run.names.length} dirty name(s) tested against the sync patterns)${unseen}; names alone cannot show a file in a subfolder that is dirty but never copied`);
    }
  }
  return out.join('\n');
}

// The shape this check knows (2026-10-12): ONE single-line `$pushOk = ...` whose expression is
// complete on that line and says nothing about copied/dirty/conflict, ONE `if ($pushOk)` guard
// after it, and the marker write inside that guard. Anything else -- a second assignment, a
// continuation, a changed guard -- means somebody has touched the logic, and this check cannot say
// whether the defect is still there. The verdict is FAIL only when the old shape is positively
// matched; otherwise the caller returns NOT-VERIFIED and asks for a human read.
function matchPushShape(all) {
  const codeOf = l => l.split('#')[0];
  const assigns = [];
  all.forEach((l, i) => { if (/\$pushOk\s*[-+*/]?=(?!=)/.test(codeOf(l))) assigns.push(i); });
  const guards = [];
  const markers = [];
  const firstAssign = assigns.length ? assigns[0] : -1;
  all.forEach((l, i) => {
    if (i <= firstAssign) return;
    if (/^\s*if\s*\(\s*\$pushOk\s*\)\s*\{?\s*(#.*)?$/.test(l)) guards.push(i);
    if (/Set-Content\b.*"pushed\b/.test(l)) markers.push(i);
  });

  const problems = [];
  if (assigns.length !== 1) problems.push(`${assigns.length} assignments to $pushOk (the known shape has exactly 1)`);
  let decideAt = -1;
  if (assigns.length === 1) {
    decideAt = assigns[0];
    const code = codeOf(all[decideAt]).trimEnd();
    const opens = (code.match(/\(/g) || []).length;
    const closes = (code.match(/\)/g) || []).length;
    if (!/^\s*\$pushOk\s*=/.test(code)) problems.push('the $pushOk assignment is not a statement of its own');
    if (opens !== closes || /(`|-and|-or|-not|,|\+|\|)$/.test(code)) problems.push('the $pushOk expression is not complete on its own line');
    if (/copied|dirty|conflict|same/i.test(code)) problems.push('the $pushOk expression now mentions copied/dirty/conflict/same');
  }
  if (guards.length !== 1) problems.push(`${guards.length} exact "if ($pushOk)" guard line(s) after it (the known shape has exactly 1)`);
  if (markers.length !== 1) problems.push(`${markers.length} marker write(s) of the form Set-Content ... "pushed ..." after it (the known shape has exactly 1)`);
  else if (guards.length === 1 && markers[0] < guards[0]) problems.push('the marker write comes before the guard');
  return {
    matched: problems.length === 0, problems, assigns, guards, markers, decideAt,
    guardAt: guards.length === 1 ? guards[0] : -1,
    markerAt: markers.length === 1 ? markers[0] : -1,
  };
}

function checkSyncPushFalseSuccess(dir = NAS_MEMORY_DIR) {
  const scriptName = 'sync_if_dirty.ps1';
  const scriptPath = path.join(dir, scriptName);
  let src;
  try { src = readText(scriptPath); }
  catch (e) {
    return {
      verdict: 'NOT-VERIFIED',
      evidence: `could not read ${scriptPath} (${errText(e)}): this machine cannot reach the NAS memory folder (another machine, or the drive is not mapped), so the sync code was not checked`,
    };
  }

  const all = src.split(/\r?\n/);
  const shape = matchPushShape(all);
  const logPart = describeLastRun(dir);
  const cite = i => `${scriptName}:${i + 1}: ${ascii(all[i].trim())}`;

  if (!shape.matched) {
    // I2 (review): the old FAIL text was printed after real fixes too. A FAIL here would be a claim
    // that the defect is still present, which this check can make only for the shape it knows.
    const found = shape.assigns.length
      ? shape.assigns.slice(0, 6).map(cite)
      : [`${scriptName} has no assignment to $pushOk`];
    const around = [];
    if (shape.guards.length) around.push(...shape.guards.slice(0, 3).map(cite));
    if (shape.markers.length) around.push(...shape.markers.slice(0, 3).map(cite));
    return {
      verdict: 'NOT-VERIFIED',
      evidence: lines(
        `the shape of the success decision in ${scriptName} is not the one this check knows: ${shape.problems.join('; ')}`,
        ...found, ...around, logPart,
        `read ${scriptName} by hand around its $pushOk logic; if the defect is gone, close the STATUS.md item (sync-push-false-success) and delete this check in the same commit`),
    };
  }
  return {
    verdict: 'FAIL',
    evidence: lines(
      cite(shape.decideAt),
      'push counts as ok on the exit code and failed=0 alone: it never requires that anything was copied or that every dirty file was accounted for',
      `marker written at ${cite(shape.markerAt)}, guarded only by the exact "if ($pushOk)" at :${shape.guardAt + 1}`,
      logPart),
  };
}

// ---------------------------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------------------------
const RAW_CHECKS = {
  'backlog-command': {
    describe: 'The command that checks this backlog: scripts/backlog.js (non-empty), a "backlog" script in package.json that runs it, and .claude/commands/backlog.md must all exist.',
    run: () => checkBacklogCommand(),
  },
  'sync-push-false-success': {
    describe: 'Whether the automatic memory push (sync_if_dirty.ps1) can still write its clean marker after copying nothing: reads its success decision, the marker write and the latest sync.log run on the NAS; FAIL only while the known old shape of that code is still there.',
    run: () => checkSyncPushFalseSuccess(),
  },
};

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

// Everything after CHECKS is exported so tests/backlog-checks.test.js can drive the pieces with
// fixtures; `npm run backlog` itself only reads CHECKS. readSyncPatterns and wildcardToRegExp are
// exported for the sync-health block, which needs the same pattern list.
module.exports = {
  CHECKS, checkBacklogCommand, checkSyncPushFalseSuccess, applyOwnerGate, guarded,
  readSyncPatterns, wildcardToRegExp,
};
