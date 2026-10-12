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
// Deliberately NOT here (spec 4.4): a per-commit warning for "no Closes: trailer", because most
// commits (typo, cache-buster bump, lint) should not have one and the noise would teach people to
// stop reading.
//
// A per-item "recorded vs real" table used to be on that list too, because it is a machine for
// producing green lines nobody verifies. 2026-10-13: the owner approved spec section 7, so that table
// now exists -- in scripts/backlog.js (`npm run backlog`), NOT in this file, which stays a reporter
// of facts about the checkout. The warning above still stands; what makes the table safe is four
// guardrails, and removing any one of them brings the machine for green lines back:
//   1. no PASS without evidence -- a PASS carries a real file:line or real command output, and a
//      check that cannot find its evidence says NOT-VERIFIED;
//   2. WAITING-OWNER instead of guessing -- what only the owner can decide is shown as awaiting him,
//      never as passed;
//   3. fewer lines than items -- a PASS prints ONE line, so what needs doing is not buried in green;
//   4. a registry bound both ways -- tests/backlog-registry.test.js turns red when STATUS.md names a
//      check that does not exist, or a check exists that no item uses.
'use strict';
const fs = require('fs');
const path = require('path');
const m = require('./lib/cache-markers');
const { describeDataFiles } = require('./lib/data-files');
const { describeRosterHealth } = require('./lib/roster-health');
// One wording for what `npm run backlog` does, shared with its own command list (2026-10-13 review: the
// first adverts said "every item re-checked" and "checks each claim", which it does not do).
const { WHAT_IT_DOES } = require('./backlog');

const { ROOT, git } = m;
const out = (s = '') => console.log(s);
// UNMEASURED is returned whenever git could not answer. It exists because the first version of this
// file returned null/[] on failure, and every call site then printed a confident measurement that
// had never been taken: a failing `git status` printed "Uncommitted: none", a failing `rev-list`
// printed "0 ahead, 0 behind", a failing log printed "0 commit(s) since STATUS.md". Those are the
// most dangerous sentences this tool can produce -- the owner reads them as "clean, nothing new,
// safe to proceed". git itself distinguishes "exit 0 with empty output" from "exit 128", so the
// distinction is free; it was simply being thrown away.
const UNMEASURED = Symbol('unmeasured');
const why = (r) => r.error ? `git could not run: ${r.error.code || r.error.message}`
                           : `git exited ${r.status}: ${(r.stderr || '').trim().split('\n')[0]}`;

const run = (args) => { const r = git(args); return r.status === 0 ? String(r.stdout).trim() : UNMEASURED; };
// Line lists must NOT be trimmed as one block: `git status --short` starts a line with a space
// (" M file"), and trimming the block eats the first line's leading column, so one file would read
// differently from the rest. Strip only the trailing newline and indent each line ourselves.
const lines = (args) => {
  const r = git(args);
  if (r.status !== 0) return { failed: why(r), list: [] };
  return { failed: null, list: String(r.stdout).replace(/\r?\n$/, '').split('\n').filter(Boolean) };
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
const branch = run(['rev-parse', '--abbrev-ref', 'HEAD']);
const head = run(['log', '-1', '--format=%h %s']);
out(`Measured from: ${ROOT}`);
out(`  branch ${branch === UNMEASURED ? '(NOT measured)' : branch}, at ${head === UNMEASURED ? '(NOT measured)' : (head || '(no commits yet)')}`);
out();

// --- uncommitted work ----------------------------------------------------------------------------
const dirty = lines(['status', '--short']);
if (dirty.failed) {
  out(`Uncommitted: NOT measured -- ${dirty.failed}`);
} else {
  out(`Uncommitted: ${dirty.list.length === 0 ? 'none' : dirty.list.length + ' file(s)'}`);
  for (const line of dirty.list.slice(0, 10)) out('  ' + line);
  if (dirty.list.length > 10) out(`  ...and ${dirty.list.length - 10} more`);
}

// --- position against the remote -----------------------------------------------------------------
const upstream = run(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
if (upstream === UNMEASURED || !upstream) {
  out(`Remote: this branch tracks nothing (${branch === UNMEASURED ? '?' : branch}); compare against origin/main by hand`);
} else {
  const counts = run(['rev-list', '--left-right', '--count', `HEAD...${upstream}`]);
  if (counts === UNMEASURED) out(`Remote: ${upstream} -- NOT measured (git could not count it)`);
  else {
    const [ahead, behind] = counts.split(/\s+/);
    out(`Remote: ${upstream} -- ${ahead} ahead, ${behind} behind`);
  }
}
// main matters more than the current branch: it is what the live site serves. Never drop this line
// silently -- its absence reads as "nothing to report", which is the opposite of "could not check".
const aheadMain = run(['rev-list', '--count', 'origin/main..main']);
const behindMain = run(['rev-list', '--count', 'main..origin/main']);
if (aheadMain === UNMEASURED || behindMain === UNMEASURED) {
  out('  main vs origin/main: NOT measured (no local main, or origin/main not fetched here)');
} else {
  out(`  main vs origin/main: ${aheadMain} ahead, ${behindMain} behind`);
}
out();

// --- what was done lately ------------------------------------------------------------------------
out('Latest commits (what was last worked on):');
const latest = lines(['log', '-10', '--format=%h %ad %s', '--date=short']);
if (latest.failed) out(`  NOT measured -- ${latest.failed}`);
else if (!latest.list.length) out('  (none)');
else for (const l of latest.list) out('  ' + l);
out();

// --- commits since STATUS.md was last touched ----------------------------------------------------
// With titles, not a bare count: the last 40 commits of this repo share one author and committer, so
// work that came from another editor or another machine cannot be told apart by metadata. A count
// would hide it; reading the titles is how you notice "I did not do that one".
const statusSha = run(['log', '-1', '--format=%H', '--', 'STATUS.md']);
if (statusSha === UNMEASURED) {
  out('Since STATUS.md was last updated: NOT measured (git could not read its history)');
} else if (!statusSha) {
  out('Since STATUS.md was last updated: STATUS.md has no history here, nothing to compare against');
} else {
  const stamp = run(['log', '-1', '--format=%h %ad', '--date=short', statusSha]);
  const since = lines(['log', `${statusSha}..HEAD`, '--format=%h %s']);
  if (since.failed) {
    out(`Since STATUS.md was last updated (${stamp === UNMEASURED ? '?' : stamp}): NOT measured -- ${since.failed}`);
  } else {
    out(`Since STATUS.md was last updated (${stamp === UNMEASURED ? '?' : stamp}): ${since.list.length} commit(s)`);
    for (const line of since.list.slice(0, MAX_SINCE)) out('  ' + line);
    if (since.list.length > MAX_SINCE) out(`  ...and ${since.list.length - MAX_SINCE} more`);
  }

  // `Closes:` trailers: work that says it finished something STATUS.md may still list as open.
  // Keep the commit id on each line -- the point of seeing one is to go and look at that commit.
  const bodies = lines(['log', `${statusSha}..HEAD`, '--format=%h%x00%B%x00']);
  const closes = [];
  if (bodies.failed) {
    out(`Closed since then: NOT measured -- ${bodies.failed}`);
  } else {
    let current = null;
    for (const raw of String(bodies.list.join('\n')).split('\0')) {
      const t = raw.trim();
      if (/^[0-9a-f]{7,40}$/.test(t)) { current = t; continue; }
      for (const l of t.split('\n')) if (/^Closes:/i.test(l.trim())) closes.push(`${current || '???'} ${l.trim()}`);
    }
  }
  if (closes.length) {
    out('Closed since then (STATUS.md may still list these as open):');
    for (const c of closes.slice(0, MAX_SINCE)) out('  ' + c);
    if (closes.length > MAX_SINCE) out(`  ...and ${closes.length - MAX_SINCE} more`);
  }
}
out();

// --- cache-buster vs the assets ------------------------------------------------------------------
// The bug this project hit again and again: an edit that is live but not visible because the browser
// is still running the old file. The same rules as `npm run check`, read from one shared list.
out('Cache-buster (has each asset changed since its version value was last bumped?):');
if (m.isShallowCheckout()) {
  out('  NOT measured: this is a shallow clone, so every marker would look freshly bumped.');
  out('  Run `git fetch --unshallow` before trusting this section.');
} else {
  let stale = 0;
  for (const g of m.GUARDED) {
    const label = `${m.guardLabel(g)} vs ${g.markerName} in ${g.markerFile}`;
    try {
      m.assertAssetIsReal(g);
      const s = m.markerState(g);
      if (!s.ok) { stale++; out(`  STALE  ${label} = "${s.current}" -- ${g.fix}`); }
      else out(`  ok     ${label} = "${s.current}"${s.reason ? ` (${s.reason})` : ''}`);
    } catch (e) {
      // Report the failure, do not swallow it into a clean-looking line.
      out(`  ?      ${label}: ${e.message}`);
    }
  }
  if (stale) out(`  ${stale} marker(s) behind the code: users will keep the old file until they move.`);
}
out();

// --- data files: only when the folder is actually here --------------------------------------------
const dataDir = path.join(ROOT, 'attendance-server', 'backend', 'data');
if (!fs.existsSync(dataDir)) {
  out('Data files: NOT measured here.');
  out('  attendance-server/backend/data/ is gitignored and exists only on the NAS, so a worktree');
  out('  has no records to count. Read it on Z:\\Time_Attendance if you need the numbers.');
} else {
  // 2026-10-09: this used to be an inline loop whose statSync() sat outside the try. On Z: the
  // live backend rewrites these files through atomicWrite() while the report runs, so a file
  // could be listed and then gone a moment later -- which threw, and killed every section below
  // this one. describeDataFiles() gives up at most one line per file. See scripts/lib/data-files.js.
  out('Data files (attendance-server/backend/data):');
  describeDataFiles(dataDir).forEach(out);
  // 2026-10-11: the roster flag, checked where the data actually is. `npm run check` cannot see
  // this -- users.json is gitignored and a worktree has no data directory -- so a test there could
  // never go red. See scripts/lib/roster-health.js.
  out();
  out('Roster (users.json, the payroll `active` flag):');
  // 2026-10-11 (review): the first version of this held a `roster` sentinel and only printed when
  // it was not undefined, with a `raw && raw.users` fallback for a shape this system never writes
  // (users.json is always an array -- ensureSystemAccounts() requires it). A JSON object with no
  // `users` key therefore printed the heading above and then nothing at all, which reads as
  // "nothing to report" when the truth is "not measured" -- the exact failure the UNMEASURED
  // comment at the top of this file exists to prevent. There is no silent branch now:
  // describeRosterHealth() answers for every shape, and only an unreadable file short-circuits.
  let roster = null, readFailed = null;
  try {
    roster = JSON.parse(fs.readFileSync(path.join(dataDir, 'users.json'), 'utf8'));
  } catch (e) {
    readFailed = (e && e.message) ? e.message : 'unknown error';
  }
  if (readFailed) out(`  NOT measured -- users.json could not be read (${readFailed})`);
  else describeRosterHealth(roster).forEach(out);
}
out();

// --- the commands, so only this one has to be remembered -----------------------------------------
out('Commands (you only need to remember the first):');
out('  npm run status   this report');
out(`  npm run backlog  what is still open: ${WHAT_IT_DOES}`);
out('  npm run check    lint + every test; must end "N/N test files passed"');
// 2026-10-13: the closing sentence used to say "this report is facts, STATUS.md is claims -- verify
// each open item against the code", which left the verifying to whoever read it, by hand, every time.
// That is now `npm run backlog`'s job, so this points at it instead of asking for it. But it does not
// check every claim: a handoff item and an owner wait are not code-checked. The old sentence's second
// half, "say what you could not measure", was dropped in the first rewrite and is back.
out('Before you answer "what is still open": run `npm run backlog`. This report is facts about the');
out('checkout and STATUS.md is claims; `npm run backlog` ' + WHAT_IT_DOES + '.');
out('Say in your answer what it could not measure, and which items it did not check.');
