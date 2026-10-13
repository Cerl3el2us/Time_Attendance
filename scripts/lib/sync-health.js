// The sync-health block of `npm run backlog` (2026-10-12).
//
// `npm run backlog` answers "what is still open?" with evidence. This block says how far that
// answer can be trusted: does THIS machine's memory and git state agree with the NAS and the other
// machine? It composes strings and prints nothing; scripts/backlog.js lays them out.
//
//   describeSyncHealth(deps?) -> { lines: string[], unmeasured: string[], elapsedMs: number }
//   compareListings(localList, nasList, patterns) -> { differing, localOnly, nasOnly, outsidePatterns }
//
// THE RULE, and the reason this block exists: never print a reassuring line that was not measured.
// Anything that could not be measured goes into `unmeasured` with the reason and the path tried,
// and never into `lines` as if it were a result. Nothing printed here says "in sync" or
// "identical" -- not even on a clean run, because a name-and-size comparison cannot prove equal
// content and the other machine cannot be seen at all.
//
// For the printer (Task 4), the contract of `lines`:
//   * a line starting "WARNING: " is a finding that needs a human; every other line is information;
//   * the last line starts "LIMIT: " and is ALWAYS present, success or failure;
//   * the lines are already in display order; do not sort or re-derive them.
//
// Nothing here throws. A reader that fails puts its reason in `unmeasured`.
//
// KNOWN LIMIT, stated rather than solved (2026-10-12 review): the time is only partly bounded. Each
// git call has a timeout (GIT_TIMEOUT_MS), but Node's synchronous `fs` has none, so a listing or a
// read of Z: that hangs (a dropped VPN can leave an SMB share that blocks instead of failing) blocks
// this block, and the whole command, for as long as Windows takes to give up. Moving the NAS reads
// into a worker or child process was judged far too much machinery for a status block. What is done
// instead: the block measures its own elapsed milliseconds and returns them as `elapsedMs`, so the
// printer can show the number, and a slow run is visible rather than promised away.
//
// All text is English on purpose: this runs in a plain Windows console where Thai prints as `?`.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { readSyncPatterns, wildcardToRegExp } = require('./backlog-checks');

const ROOT = path.join(__dirname, '..', '..');
// Two calls at this value reach 3.0 s at worst; the budget for the whole command is 5 s. A timeout
// lands in `unmeasured`. Both git calls here are lock-free (see gitSection), so being killed leaves
// nothing behind.
const GIT_TIMEOUT_MS = 1500;

// The NAS side is Z:\claude_memory. The local side is the memory folder Claude Code derives from the
// project directory Z:\ by replacing ":" and "\" with "-" (sync_memory.ps1 computes
// `$sanitized = ($ProjectDir -replace ':','-' -replace '\\','-')`), which gives `Z--`. It is
// hardcoded on purpose, the way the hook hardcodes -ProjectDir "Z:\\": this session's own working
// directory would sanitise differently, and another machine may keep its memory under another
// name. When the folder is missing the comparison says so instead of guessing a different one.
const NAS_DIR = 'Z:\\claude_memory';
const LOCAL_DIR = path.join(os.homedir(), '.claude', 'projects', 'Z--', 'memory');
// sync_memory.ps1 syncs this subfolder too, with the same patterns ($ArchiveName). Its other
// subfolders (plans\, .sync_backup\, .git\) are not synced. The name, and the claim in the printed
// memory line that these two are the synced folders, were read from the script on 2026-10-12 and are
// NOT re-read at run time (that would be a second parser of the script); the printed line says "as of
// 2026-10-12" for that reason. If the script gains a folder, this constant and that line change together.
const ARCHIVE = 'archive';

const errText = e => (e && e.message ? e.message : String(e));
// Console-safe: a plain Windows console renders anything outside printable ASCII as `?`.
const ascii = s => String(s).replace(/[^\x20-\x7e]/g, '?');
const isMissing = e => !!e && (e.code === 'ENOENT' || e.code === 'ENOTDIR');
// A byte count, not "size": the unit is part of the claim.
const bytes = n => `${n} bytes`;

// ---------------------------------------------------------------------------------------------
// The pure part: no disk, no git, no Z:
// ---------------------------------------------------------------------------------------------
// localList / nasList: arrays of { name, size }. patterns: PowerShell -Include wildcards, as read
// from sync_memory.ps1. Names are compared the way NTFS and -Include compare them, ignoring case.
//
//   differing      { name, localSize, nasSize } -- a pattern-matching name on both sides, sizes differ
//   localOnly      names of pattern-matching files present on this machine only
//   nasOnly        names of pattern-matching files present on the NAS only
//   outsidePatterns { name, side } -- files whose name matches NO pattern, so sync_memory.ps1
//                   never copies them. side is 'local', 'nas' or 'both'.
//
// Names starting with "." (.sync_backup, .sync_marker, .gitignore) are infrastructure and are
// ignored entirely. Nothing here decides what to do about a difference; it only reports.
function compareListings(localList, nasList, patterns) {
  const res = (Array.isArray(patterns) ? patterns : []).map(wildcardToRegExp);
  const matches = name => res.some(r => r.test(name));
  const index = list => {
    const m = new Map();
    for (const f of Array.isArray(list) ? list : []) {
      if (!f || typeof f.name !== 'string' || f.name === '' || f.name.startsWith('.')) continue;
      m.set(f.name.toLowerCase(), { name: f.name, size: f.size });
    }
    return m;
  };
  const local = index(localList);
  const nas = index(nasList);

  const differing = [];
  const localOnly = [];
  const nasOnly = [];
  const outsidePatterns = [];
  for (const [key, l] of local) {
    const n = nas.get(key);
    if (!matches(l.name)) { outsidePatterns.push({ name: l.name, side: n ? 'both' : 'local' }); continue; }
    if (!n) localOnly.push(l.name);
    else if (l.size !== n.size) differing.push({ name: l.name, localSize: l.size, nasSize: n.size });
  }
  for (const [key, n] of nas) {
    if (!matches(n.name)) { if (!local.has(key)) outsidePatterns.push({ name: n.name, side: 'nas' }); continue; }
    if (!local.has(key)) nasOnly.push(n.name);
  }
  const byName = (a, b) => (a.name || a).toString().toLowerCase().localeCompare((b.name || b).toString().toLowerCase());
  return {
    differing: differing.sort(byName),
    localOnly: localOnly.sort(byName),
    nasOnly: nasOnly.sort(byName),
    outsidePatterns: outsidePatterns.sort(byName),
  };
}

// ---------------------------------------------------------------------------------------------
// The thin readers (each one injectable through describeSyncHealth's argument)
// ---------------------------------------------------------------------------------------------
// Files directly inside `dir` as [{ name, size }]. Throws when the directory cannot be listed. A
// file that vanishes between the listing and its stat (the NAS is being written to) is skipped:
// it is the one file that was moving, not a reason to lose the others.
function listDir(dir) {
  const out = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!ent.isFile()) continue;
    try { out.push({ name: ent.name, size: fs.statSync(path.join(dir, ent.name)).size }); }
    catch (e) { if (!isMissing(e)) throw e; }
  }
  return out;
}

// The last non-empty line of sync.log, read from its tail so a long log costs one small read.
// The file begins with a UTF-8 byte-order mark; `^(\S+)` does not match U+FEFF, so it is stripped.
function readLogLastLine(dir) {
  const file = path.join(dir, 'sync.log');
  const fd = fs.openSync(file, 'r');
  try {
    const CHUNK = 16384;
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - CHUNK);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    let text = buf.toString('utf8');
    if (start === 0) text = text.replace(/^\uFEFF/, '');
    let all = text.split(/\r?\n/).filter(l => l.trim() !== '');
    // When only the tail was read, its first line may be cut in half: it is never the last line
    // unless the tail holds nothing else, and then the real last line is longer than the chunk.
    if (start > 0) all = all.slice(1);
    if (all.length === 0) throw new Error(start > 0 ? `the last line of sync.log is longer than ${CHUNK} bytes` : 'sync.log is empty');
    return all[all.length - 1];
  } finally { fs.closeSync(fd); }
}

// One git call, run from the repository root. Throws with git's own message on failure.
function runGit(args, exec = execFileSync) {
  try {
    return exec('git', args, {
      cwd: ROOT, encoding: 'utf8', timeout: GIT_TIMEOUT_MS, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    const stderr = e && e.stderr ? String(e.stderr).trim() : '';
    throw new Error(stderr || errText(e));
  }
}

// ---------------------------------------------------------------------------------------------
// The sections
// ---------------------------------------------------------------------------------------------
const names = (list, label) => {
  const MAX = 8;
  const shown = list.slice(0, MAX).map(label);
  return shown.join(', ') + (list.length > MAX ? `, ... (+${list.length - MAX} more)` : '');
};

// Both folders (top level and archive\) of one side, or a reason it could not be listed. A missing
// archive\ is an empty archive (sync_memory.ps1 creates it on demand); a missing top level means the
// folder is unreachable and nothing can be said.
function listSide(read, dir) {
  const top = read(dir);
  let archive = [];
  try { archive = read(path.join(dir, ARCHIVE)); }
  catch (e) { if (!isMissing(e)) throw e; }
  return { top, archive };
}

function memorySection(nasDir, localDir, deps, out) {
  const read = deps.listDir || listDir;
  const readPatterns = deps.readPatterns || readSyncPatterns;

  let nas;
  try { nas = listSide(read, nasDir); }
  catch (e) {
    out.unmeasured.push(`memory comparison NOT done: the NAS memory folder ${nasDir} could not be listed (${errText(e)}); this machine cannot reach it, so nothing is known about how the two memory folders compare`);
    return;
  }
  let local;
  try { local = listSide(read, localDir); }
  catch (e) {
    out.unmeasured.push(isMissing(e)
      ? `memory comparison NOT done: this machine's memory folder ${localDir} does not exist (Z-- is the folder Claude Code uses for the project Z:\\; another machine, or a project opened from a different directory, uses another name)`
      : `memory comparison NOT done: this machine's memory folder ${localDir} could not be listed (${errText(e)})`);
    return;
  }
  const patterns = readPatterns(nasDir);
  if (!Array.isArray(patterns) || patterns.length === 0) {
    out.unmeasured.push(`memory comparison NOT done: the $Patterns list could not be read from ${path.join(nasDir, 'sync_memory.ps1')}, and without it there is no telling which files are meant to be synced or which names are never synced (the "outside the patterns" result is unknown, not empty)`);
    return;
  }

  const top = compareListings(local.top, nas.top, patterns);
  const arc = compareListings(local.archive, nas.archive, patterns);
  const tag = (folder, items) => items.map(i => (typeof i === 'string' ? { name: i } : i)).map(i => ({ ...i, name: folder + i.name }));
  const prefix = { top: '', arc: `${ARCHIVE}\\` };
  const differing = [...tag(prefix.top, top.differing), ...tag(prefix.arc, arc.differing)];
  const localOnly = [...tag(prefix.top, top.localOnly), ...tag(prefix.arc, arc.localOnly)];
  const nasOnly = [...tag(prefix.top, top.nasOnly), ...tag(prefix.arc, arc.nasOnly)];
  const outside = [...tag(prefix.top, top.outsidePatterns), ...tag(prefix.arc, arc.outsidePatterns)];

  const res = patterns.map(wildcardToRegExp);
  const count = side => [...side.top, ...side.archive].filter(f => !f.name.startsWith('.') && res.some(r => r.test(f.name))).length;
  out.lines.push(`memory: compared file names and sizes only (no content hash) between this machine (${localDir}) and the NAS (${nasDir}), in the top-level folder and in ${ARCHIVE}\\ (the two folders sync_memory.ps1 syncs as of 2026-10-12; its other subfolders were not looked at); ${count(local)} pattern-matching file(s) here, ${count(nas)} on the NAS`);
  out.lines.push(`memory: sync patterns, read from sync_memory.ps1: ${patterns.join(', ')}`);

  if (differing.length) {
    out.lines.push(`WARNING: ${differing.length} pattern-matching file(s) differ in size between this machine and the NAS: `
      + names(differing, d => `${ascii(d.name)} (here ${bytes(d.localSize)}, NAS ${bytes(d.nasSize)})`)
      + '; the sizes alone do not say which side is newer, or why they differ');
  }
  if (localOnly.length) {
    out.lines.push(`WARNING: ${localOnly.length} pattern-matching file(s) exist on this machine only: ${names(localOnly, d => ascii(d.name))}; report only, whether to copy, delete or leave them is the owner's call (sync_memory.ps1 never deletes, on purpose)`);
  }
  if (nasOnly.length) {
    out.lines.push(`WARNING: ${nasOnly.length} pattern-matching file(s) exist on the NAS only: ${names(nasOnly, d => ascii(d.name))}; report only, whether to copy, delete or leave them is the owner's call (sync_memory.ps1 never deletes, on purpose)`);
  }
  if (!differing.length && !localOnly.length && !nasOnly.length) {
    out.lines.push('memory: no pattern-matching file differs in name or size between the two sides (equal sizes do not prove equal content)');
  }

  const here = outside.filter(o => o.side !== 'nas');
  const nasSide = outside.filter(o => o.side === 'nas');
  if (here.length) {
    out.lines.push(`WARNING: ${here.length} file(s) in this machine's memory folder match none of the sync patterns, so sync_memory.ps1 never copies them to the NAS or the other machine: ${names(here, d => ascii(d.name))}`);
  } else {
    out.lines.push(`memory: every non-dot file in this machine's memory folder (top level and ${ARCHIVE}\\) matches a sync pattern`);
  }
  if (nasSide.length) {
    out.lines.push(`memory: ${nasSide.length} file(s) on the NAS match none of the sync patterns, so sync_memory.ps1 never copies them to a local memory folder: ${names(nasSide, d => ascii(d.name))}`);
  }
}

// Age of a sync.log line from the ISO timestamp it starts with: { text } or { why }. The timestamp must
// carry its UTC offset (sync_if_dirty.ps1 writes one): without it the instant is a guess.
function lastLineAge(line, nowMs) {
  const m = String(line).match(/^\s*(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))(?=\s|$)/);
  if (!m) return { why: 'the line does not start with a timestamp of the form 2026-10-12T21:10:36+07:00' };
  const then = Date.parse(m[1]);
  if (!Number.isFinite(then) || !Number.isFinite(nowMs)) return { why: `the timestamp ${m[1]} could not be parsed` };
  const mins = Math.floor((nowMs - then) / 60000);
  if (mins < 0) return { why: `the timestamp ${m[1]} is ${-mins} min in the future of this machine's clock` };
  const text = mins < 60 ? `${mins} min` : `${Math.floor(mins / 60)} h ${mins % 60} min`;
  return { text: `about ${text}` };
}

// The last line of sync.log, and the things the owner asked to be warned about.
function logSection(nasDir, deps, out) {
  const readLast = deps.readLogLastLine || readLogLastLine;
  let line;
  try { line = readLast(nasDir); }
  catch (e) {
    out.unmeasured.push(`sync.log NOT read: ${path.join(nasDir, 'sync.log')} (${errText(e)})`);
    return;
  }
  line = String(line);
  const shown = ascii(line).slice(0, 300) + (line.length > 300 ? ' ...' : '');
  out.lines.push(`sync.log, last line: ${shown}`);
  // How old that line is, from its own timestamp against this machine's clock. A line that records an
  // open defect reads very differently at 2 minutes and at 29 hours, and the line alone does not say.
  const age = lastLineAge(line, deps.now === undefined ? Date.now() : deps.now);
  if (age.text) out.lines.push(`sync.log: that line is ${age.text} old (by its own timestamp, against this machine's clock)`);
  else out.unmeasured.push(`age of the last sync.log line NOT computed: ${age.why}`);
  // Only what the line itself says. `DIRTY n` is NOT compared with copied+same+conflict+failed: those
  // counts cover every pattern-matching file in the folder, not only the dirty ones.
  const conflict = line.match(/\bconflict=(\d+)/);
  if (conflict && Number(conflict[1]) > 0) {
    out.lines.push(`WARNING: the last sync.log line records conflict=${conflict[1]}: the script did not copy at least one file; the needs-eyes= field of that line is where sync_if_dirty.ps1 records which files`);
  } else if (!conflict) {
    out.lines.push('sync.log: that line has no conflict= field, so no conflict count was read from it');
  }
  if (line.includes('FAILED')) {
    out.lines.push('WARNING: the last sync.log line contains FAILED');
  }
  // The one run shape the owner's open item (sync-push-false-success) is about, read from the line's
  // own fields and nothing else: it does not say WHY nothing was copied, and the judgement of the
  // code behind it stays in backlog-checks.js. Without this the same line that item calls a false
  // success sat under a "0 warning(s)" heading.
  const dirty = line.match(/\bDIRTY (\d+)\b/);
  if (dirty && Number(dirty[1]) > 0 && /\bcopied=0\b/.test(line) && /\bpush=ok\b/.test(line) && /\bmarker=written\b/.test(line)) {
    out.lines.push(`WARNING: the last sync.log line records DIRTY ${dirty[1]} with copied=0, push=ok and marker=written: nothing was copied to the NAS, yet the folder was marked clean (the open item sync-push-false-success; this line cannot say why nothing was copied)`);
  }
  const eyes = line.match(/\bneeds-eyes=(.*?)(?:\s+snapshot=|$)/);
  if (eyes && eyes[1].trim() !== '' && eyes[1].trim() !== 'none') {
    out.lines.push(`WARNING: the last sync.log line has needs-eyes=${ascii(eyes[1].trim())}`);
  }
}

// At most one `git status` and two `git rev-list` (a git process costs ~0.3 s on Windows). The
// second rev-list was added 2026-10-13 and is worth its ~0.3 s: without it the block could not tell
// a reader that the STATUS.md it just summarised belongs to a checkout that is behind main.
function gitSection(deps, out) {
  const git = deps.git || (args => runGit(args, deps.execFile));
  try {
    // --no-optional-locks: a plain `git status` opportunistically takes index.lock to refresh the
    // index, and a reader that is killed by its timeout while holding it leaves a stale lock that
    // blocks every later `git add` and `git commit` (this happened on 2026-10-12 while building
    // this very file). A report must not take a write lock it does not need.
    const status = String(git(['--no-optional-locks', 'status', '--porcelain', '--', 'STATUS.md'])).trim();
    out.lines.push(status === ''
      ? 'git: STATUS.md has no uncommitted changes in this checkout'
      : `WARNING: git: STATUS.md has uncommitted changes in this checkout (${ascii(status)}); no other machine can see them`);
  } catch (e) {
    out.unmeasured.push(`git status of STATUS.md NOT read: ${ascii(errText(e)).split('\n')[0]}`);
  }
  try {
    const raw = String(git(['rev-list', '--count', '@{u}..HEAD'])).trim();
    if (!/^\d+$/.test(raw)) {
      out.unmeasured.push(`unpushed commits NOT counted: git rev-list answered ${JSON.stringify(ascii(raw).slice(0, 80))}, not a number`);
    } else if (Number(raw) > 0) {
      out.lines.push(`WARNING: git: ${raw} commit(s) on this branch are not on its upstream as of the last fetch; the other machine cannot see them`);
    } else {
      out.lines.push('git: 0 commits ahead of the upstream as of the last fetch (the remote itself was not contacted, so it may have moved)');
    }
  } catch (e) {
    const msg = ascii(errText(e)).split('\n')[0];
    out.unmeasured.push(/upstream|@\{u\}|no such branch|unknown revision/i.test(msg)
      ? `unpushed commits NOT counted: this branch has no upstream to compare with (${msg}); that is not the same as zero`
      : `unpushed commits NOT counted: ${msg}`);
  }
  // 2026-10-13: `npm run backlog` reads the STATUS.md of the checkout it runs in, so a worktree
  // behind main reports items that were closed days ago and says nothing about reading an old file
  // -- the "another machine redid finished work" failure arriving through the tool built to stop it.
  // Behind MAIN is the direction that matters: a stale branch can be level with its own upstream and
  // still carry a months-old STATUS.md, which is why this is a second question, not the one above.
  try {
    const raw = String(git(['rev-list', '--count', 'HEAD..origin/main'])).trim();
    if (!/^\d+$/.test(raw)) {
      out.unmeasured.push(`commits behind main NOT counted: git rev-list answered ${JSON.stringify(ascii(raw).slice(0, 80))}, not a number`);
    } else if (Number(raw) > 0) {
      out.lines.push(`WARNING: git: this checkout is ${raw} commit(s) behind origin/main as of the last fetch, so the STATUS.md read above may be older than the one on main; bring this worktree up to date before trusting what it says is open`);
    } else {
      out.lines.push('git: level with origin/main as of the last fetch (the remote itself was not contacted, so it may have moved)');
    }
  } catch (e) {
    out.unmeasured.push(`commits behind main NOT counted: ${ascii(errText(e)).split('\n')[0]}`);
  }
}

// Printed on EVERY run, not only on failure. It is the one thing no measurement here can remove.
const LIMIT = 'LIMIT: if the other machine has not pushed, this machine cannot know what is waiting there; the comparisons above, where they were made, involve only this machine, the NAS and the last-fetched upstream';

// `deps` exists so the readers can be pointed at fixtures: { nasDir, localDir, listDir(dir),
// readPatterns(dir), readLogLastLine(dir), git(args), execFile, now (ms since the epoch, for the log age) }. Every one has a real default, so
// describeSyncHealth() with no argument measures the real thing.
function describeSyncHealth(deps) {
  const started = process.hrtime.bigint();
  const out = { lines: [], unmeasured: [] };
  try {
    const d = deps || {};
    const nasDir = d.nasDir || NAS_DIR;
    const localDir = d.localDir || LOCAL_DIR;
    memorySection(nasDir, localDir, d, out);
    logSection(nasDir, d, out);
    gitSection(d, out);
  } catch (e) {
    out.unmeasured.push(`sync health NOT fully measured: unexpected error (${ascii(errText(e))}); anything not listed above was not checked`);
  }
  out.lines.push(LIMIT);
  // One scrub for everything that leaves this module: a directory, a file name, an error message or a
  // log line may carry Thai, and a plain Windows console renders it as `?` without warning.
  out.lines = out.lines.map(ascii);
  out.unmeasured = out.unmeasured.map(ascii);
  out.elapsedMs = Math.round(Number(process.hrtime.bigint() - started) / 1e6);
  return out;
}

module.exports = { describeSyncHealth, compareListings };
