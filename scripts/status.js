#!/usr/bin/env node
// `npm run status` -- a reporter of measured facts, not a judge (2026-10-08).
//
// Spec: Z:\claude_memory\plans\2026-10-02-cross-machine-state-design.md section 4.4. The owner set the
// rule himself: "I cannot remember it and I do not know which one to run", so there is exactly ONE
// command to remember, and it prints the others at the bottom.
//
// It prints only what it can actually measure, and says plainly what it could not. A status tool that
// prints a confident number it did not really measure becomes a new source of wrong answers -- the
// exact problem it exists to solve. In particular `data/` is gitignored and lives only on the NAS, so
// in a worktree there is nothing to count; that is reported as "NOT measured", never as zero.
//
// Output is English on purpose: this runs in a plain Windows console, and Thai in a console without
// UTF-8 prints as question marks. The tests in this repo are English for the same reason.
//
// Deliberately NOT here (spec 4.4): a per-item "recorded vs real" table -- it is a machine for
// producing green lines nobody verifies -- and a per-commit warning for "no Closes: trailer", because
// most commits (typo, cache-buster bump, lint) should not have one and the noise would teach people
// to stop reading.
'use strict';
const fs = require('fs');
const path = require('path');
const m = require('./lib/cache-markers');

const { ROOT, git } = m;
const out = (s = '') => console.log(s);
const run = (args) => { const r = git(args); return r.status === 0 ? r.stdout.trim() : null; };
// Line lists must NOT be trimmed as one block: `git status --short` starts a line with a space
// (" M file"), and trimming the block eats the first line's leading column, so one file would read
// differently from the rest. Strip only the trailing newline and indent each line ourselves.
const lines = (args) => {
  const r = git(args);
  return r.status === 0 ? r.stdout.replace(/\r?\n$/, '').split('\n').filter(Boolean) : [];
};

const MAX_SINCE = 20;

out('=== Time Attendance status ===');
out();

if (!m.isGitCheckout()) {
  out('Measured from: ' + ROOT);
  out('This is not a git checkout, so nothing below could be measured. Run it from a worktree.');
  process.exit(0);
}

// --- where this was measured from, and what it therefore cannot see -------------------------------
const branch = run(['rev-parse', '--abbrev-ref', 'HEAD']) || '(unknown)';
const head = run(['log', '-1', '--format=%h %s']) || '(no commits)';
out(`Measured from: ${ROOT}`);
out(`  branch ${branch}, at ${head}`);
out();

// --- uncommitted work ----------------------------------------------------------------------------
const dirty = lines(['status', '--short']);
out(`Uncommitted: ${dirty.length === 0 ? 'none' : dirty.length + ' file(s)'}`);
for (const line of dirty.slice(0, 10)) out('  ' + line);
if (dirty.length > 10) out(`  ...and ${dirty.length - 10} more`);

// --- position against the remote -----------------------------------------------------------------
const upstream = run(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
if (!upstream) {
  out(`Remote: this branch tracks nothing (${branch}); compare against origin/main by hand`);
} else {
  const counts = run(['rev-list', '--left-right', '--count', `HEAD...${upstream}`]);
  const [ahead, behind] = (counts || '0 0').split(/\s+/);
  out(`Remote: ${upstream} -- ${ahead} ahead, ${behind} behind`);
}
// main matters more than the current branch: it is what the live site serves.
const aheadMain = run(['rev-list', '--count', 'origin/main..main']);
const behindMain = run(['rev-list', '--count', 'main..origin/main']);
if (aheadMain !== null && behindMain !== null) {
  out(`  main vs origin/main: ${aheadMain} ahead, ${behindMain} behind`);
}
out();

// --- what was done lately ------------------------------------------------------------------------
out('Latest commits (what was last worked on):');
const latest = lines(['log', '-10', '--format=%h %ad %s', '--date=short']);
for (const l of latest) out('  ' + l);
if (!latest.length) out('  (none)');
out();

// --- commits since STATUS.md was last touched ----------------------------------------------------
// With titles, not a bare count: the last 40 commits of this repo share one author and committer, so
// work that came from another editor or another machine cannot be told apart by metadata. A count
// would hide it; reading the titles is how you notice "I did not do that one".
const statusSha = run(['log', '-1', '--format=%H', '--', 'STATUS.md']);
if (!statusSha) {
  out('Since STATUS.md was last updated: STATUS.md has no history here, nothing to compare against');
} else {
  const stamp = run(['log', '-1', '--format=%h %ad', '--date=short', statusSha]);
  const since = lines(['log', `${statusSha}..HEAD`, '--format=%h %s']);
  out(`Since STATUS.md was last updated (${stamp}): ${since.length} commit(s)`);
  for (const line of since.slice(0, MAX_SINCE)) out('  ' + line);
  if (since.length > MAX_SINCE) out(`  ...and ${since.length - MAX_SINCE} more`);

  // `Closes:` trailers: work that says it finished something STATUS.md may still list as open.
  const closes = (run(['log', `${statusSha}..HEAD`, '--format=%h%n%B']) || '')
    .split('\n').filter(l => /^Closes:/i.test(l.trim())).map(l => l.trim());
  if (closes.length) {
    out('Closed since then (STATUS.md may still list these as open):');
    for (const c of closes) out('  ' + c);
  }
}
out();

// --- cache-buster vs the assets ------------------------------------------------------------------
// The bug this project hit again and again: an edit that is live but not visible because the browser
// is still running the old file. The same rules as `npm run check`, read from one shared list.
out('Cache-buster (has each asset changed since its marker last moved?):');
let stale = 0;
for (const g of m.GUARDED) {
  const label = `${g.asset} vs ${g.markerPattern.replace(/\\/g, '')} in ${g.markerFile}`;
  const sha = m.lastCommitTouchingMarker(g.markerPattern, g.markerFile);
  if (!sha) { out(`  ?  ${label}: marker never committed, cannot compare`); continue; }
  let changed;
  try { changed = m.assetChangedSince(sha, g.asset); }
  catch (e) { out(`  ?  ${label}: could not ask git (${e.message})`); continue; }
  if (changed) { stale++; out(`  STALE  ${label} -- ${g.fix}`); }
  else out(`  ok     ${label}`);
}
if (stale) out(`  ${stale} marker(s) behind the code: users will keep the old file until they move.`);
out();

// --- data files: only when the folder is actually here --------------------------------------------
const dataDir = path.join(ROOT, 'attendance-server', 'backend', 'data');
if (!fs.existsSync(dataDir)) {
  out('Data files: NOT measured here.');
  out('  attendance-server/backend/data/ is gitignored and exists only on the NAS, so a worktree');
  out('  has no records to count. Read it on Z:\\Time_Attendance if you need the numbers.');
} else {
  out('Data files (attendance-server/backend/data):');
  for (const f of fs.readdirSync(dataDir).filter(n => n.endsWith('.json')).sort()) {
    const full = path.join(dataDir, f);
    let n = '?';
    try {
      const j = JSON.parse(fs.readFileSync(full, 'utf8'));
      n = Array.isArray(j) ? j.length + ' records' : Object.keys(j).length + ' top-level keys';
    } catch (e) { n = 'unreadable'; }
    out(`  ${f}: ${n}, modified ${fs.statSync(full).mtime.toISOString().slice(0, 16).replace('T', ' ')}`);
  }
}
out();

// --- the commands, so only this one has to be remembered -----------------------------------------
out('Commands (you only need to remember the first):');
out('  npm run status   this report');
out('  npm run check    lint + every test; must end "N/N test files passed"');
out('Before you answer "what is still open": this report is facts, STATUS.md is claims -- verify each');
out('open item against the code, and say what you could not measure.');
