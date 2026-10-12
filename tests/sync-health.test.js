// The sync-health block of `npm run backlog`, against fixtures (2026-10-12).
//
// scripts/lib/sync-health.js says how far the backlog answer can be trusted: whether this machine's
// memory and git state agree with the NAS and the other machine. Its one rule is that it never
// prints a reassuring line it did not measure, and this file keeps that rule red-able:
//   - compareListings is pure and is driven by plain arrays, so it runs on a machine with no Z:;
//   - describeSyncHealth is driven against fixture folders with an injected git, including the live
//     situation that motivated it (Z: dropped twice on 2026-10-12): an unreachable NAS must land in
//     `unmeasured` with the path tried, and no line may claim agreement;
//   - the sync patterns in the fixtures are NOT the real four, so a module that hardcoded the real
//     list instead of reading sync_memory.ps1 goes red.
//
// Fixtures go to one fixed folder under the OS temp directory whose files are overwritten on each
// run, so nothing accumulates and nothing is deleted. One folder per case: an absence in a case is
// an absence nobody ever wrote there.
//
// Helpers and constants are declared ABOVE their first caller on purpose: every test() in this file
// runs as the file is read, so a const declared below a case that uses it throws "Cannot access X
// before initialization" and eslint does not warn.
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { describeSyncHealth, compareListings } = require('../scripts/lib/sync-health');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok ', name); }
  catch (e) { failed++; process.exitCode = 1; console.log('  FAIL', name, '\n      ', e.message); }
}

const BASE = path.join(os.tmpdir(), 'ta-sync-health-test');
function put(dir, rel, text) {
  const p = path.join(dir, ...rel.split('/'));
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
  return p;
}
// A file of exactly `size` bytes.
const sized = size => 'x'.repeat(size);

// What the printer must never see when something was not measured.
const REASSURING = /in sync|identical|agree|up to date|all good|no pattern-matching file differs|every file/i;
const CLEAN_GIT = args => (args.includes('status') ? '' : '0\n');

// A NAS folder as sync_memory.ps1 leaves it. The patterns are not the real ones on purpose.
const SCRIPT = [
  '$Patterns = @(',
  "  'note_*.md',",
  '  # a commented-out pattern is not a pattern',
  "  # 'ignored_*.md',",
  "  'MEMORY.md'",
  ')',
  '',
].join('\n');
const LOG_CLEAN = '2026-10-12T21:10:36+07:00  DIRTY 3  push=ok  rc=0  copied=0 same=129 conflict=0 failed=0  needs-eyes=none  snapshot=ok:a792d84,nothing-to-commit  marker=written  files=MEMORY.md';

// Builds { nasDir, localDir } for one case. `nas` and `local` map a relative path to a size.
function fixture(name, { nas = {}, local = {}, script = SCRIPT, log = LOG_CLEAN } = {}) {
  const root = path.join(BASE, name);
  const nasDir = path.join(root, 'nas');
  const localDir = path.join(root, 'local');
  fs.mkdirSync(nasDir, { recursive: true });
  fs.mkdirSync(localDir, { recursive: true });
  if (script !== null) put(nasDir, 'sync_memory.ps1', script);
  if (log !== null) put(nasDir, 'sync.log', log);
  for (const [rel, size] of Object.entries(nas)) put(nasDir, rel, sized(size));
  for (const [rel, size] of Object.entries(local)) put(localDir, rel, sized(size));
  return { nasDir, localDir };
}

// Every result a case produces, so the last test can check the line that must be on all of them.
const RESULTS = [];
function run(deps) {
  const r = describeSyncHealth({ git: CLEAN_GIT, ...deps });
  RESULTS.push(r);
  return r;
}
const warnings = r => r.lines.filter(l => l.startsWith('WARNING: '));
const has = (r, text) => r.lines.some(l => l.includes(text));

// ---------------------------------------------------------------------------------------------
// compareListings: pure
// ---------------------------------------------------------------------------------------------
const PATTERNS = ['project_time_attendance*.md', 'feedback_attendance*.md', 'MEMORY.md'];

test('compareListings: the same name with a different size is "differing", with both sizes', () => {
  const r = compareListings(
    [{ name: 'MEMORY.md', size: 100 }, { name: 'feedback_attendance_a.md', size: 5 }],
    [{ name: 'MEMORY.md', size: 90 }, { name: 'feedback_attendance_a.md', size: 5 }], PATTERNS);
  assert.deepStrictEqual(r.differing, [{ name: 'MEMORY.md', localSize: 100, nasSize: 90 }]);
  assert.deepStrictEqual([r.localOnly, r.nasOnly, r.outsidePatterns], [[], [], []]);
});

test('compareListings: a name on one side only is reported in the right direction, in both directions', () => {
  const r = compareListings(
    [{ name: 'feedback_attendance_local.md', size: 1 }, { name: 'MEMORY.md', size: 2 }],
    [{ name: 'feedback_attendance_nas.md', size: 3 }, { name: 'MEMORY.md', size: 2 }], PATTERNS);
  assert.deepStrictEqual(r.localOnly, ['feedback_attendance_local.md']);
  assert.deepStrictEqual(r.nasOnly, ['feedback_attendance_nas.md']);
  assert.deepStrictEqual(r.differing, []);
});

test('compareListings: a name matching no pattern is outsidePatterns with its side, and is never also "one side only"', () => {
  const r = compareListings(
    [{ name: 'lesson_a.md', size: 1 }, { name: 'shared_b.md', size: 2 }],
    [{ name: 'RECOVERY_2026-10-12_appdata_loss.md', size: 9 }, { name: 'shared_b.md', size: 3 }], PATTERNS);
  assert.deepStrictEqual(r.outsidePatterns, [
    { name: 'lesson_a.md', side: 'local' },
    { name: 'RECOVERY_2026-10-12_appdata_loss.md', side: 'nas' },
    { name: 'shared_b.md', side: 'both' },
  ]);
  assert.deepStrictEqual([r.localOnly, r.nasOnly, r.differing], [[], [], []]);
});

test('compareListings: a name starting with a dot is ignored whatever side it is on', () => {
  const r = compareListings(
    [{ name: '.sync_marker', size: 1 }, { name: '.hidden_feedback_attendance.md', size: 1 }],
    [{ name: '.sync_backup', size: 1 }, { name: '.sync_marker', size: 2 }], PATTERNS);
  assert.deepStrictEqual(r, { differing: [], localOnly: [], nasOnly: [], outsidePatterns: [] });
});

test('compareListings: an empty list on either side makes every matching file one-sided, and both empty is empty', () => {
  const files = [{ name: 'MEMORY.md', size: 1 }, { name: 'feedback_attendance_x.md', size: 2 }];
  const noLocal = compareListings([], files, PATTERNS);
  assert.deepStrictEqual(noLocal.nasOnly, ['feedback_attendance_x.md', 'MEMORY.md']);
  assert.deepStrictEqual([noLocal.localOnly, noLocal.differing], [[], []]);
  const noNas = compareListings(files, [], PATTERNS);
  assert.deepStrictEqual(noNas.localOnly, ['feedback_attendance_x.md', 'MEMORY.md']);
  assert.deepStrictEqual([noNas.nasOnly, noNas.differing], [[], []]);
  assert.deepStrictEqual(compareListings([], [], PATTERNS), { differing: [], localOnly: [], nasOnly: [], outsidePatterns: [] });
});

test('compareListings: names are compared and matched without regard to case (PowerShell -Include and NTFS do the same)', () => {
  const r = compareListings(
    [{ name: 'memory.md', size: 10 }, { name: 'FEEDBACK_ATTENDANCE_X.MD', size: 4 }],
    [{ name: 'MEMORY.md', size: 20 }, { name: 'feedback_attendance_x.md', size: 4 }], PATTERNS);
  assert.deepStrictEqual(r.differing.map(d => [d.localSize, d.nasSize]), [[10, 20]]);
  assert.deepStrictEqual([r.localOnly, r.nasOnly, r.outsidePatterns], [[], [], []]);
});

test('compareListings: equal sizes are no difference, and garbage input or no patterns does not throw', () => {
  const same = [{ name: 'MEMORY.md', size: 7 }];
  assert.deepStrictEqual(compareListings(same, same, PATTERNS).differing, []);
  assert.doesNotThrow(() => compareListings(null, undefined, null));
  assert.doesNotThrow(() => compareListings([null, {}, { name: 5 }], 'nope', PATTERNS));
  // With no pattern list nothing is meant to be synced, so every name is outside it.
  assert.deepStrictEqual(compareListings(same, [], []).outsidePatterns, [{ name: 'MEMORY.md', side: 'local' }]);
});

// ---------------------------------------------------------------------------------------------
// describeSyncHealth: memory
// ---------------------------------------------------------------------------------------------
test('memory: two sides with the same names and sizes produce no WARNING, say what was compared, and never say "in sync"', () => {
  const dirs = fixture('agree', {
    nas: { 'note_a.md': 10, 'MEMORY.md': 5, 'archive/note_old.md': 3, 'plans/note_plan.md': 8 },
    local: { 'note_a.md': 10, 'MEMORY.md': 5, 'archive/note_old.md': 3 },
  });
  const r = run(dirs);
  assert.deepStrictEqual(r.unmeasured, []);
  assert.deepStrictEqual(warnings(r), [], r.lines.join('\n'));
  assert.ok(has(r, 'names and sizes only (no content hash)'), 'the line does not say what was compared');
  assert.ok(has(r, 'archive\\'), 'the archive folder is not named among the compared folders');
  assert.ok(has(r, 'other subfolders are not synced and were not looked at'), 'the folders left out are not named');
  assert.ok(has(r, 'equal sizes do not prove equal content'), 'the limit of a size comparison is not stated');
  assert.ok(has(r, '3 pattern-matching file(s) here, 3 on the NAS'), `the counts are wrong or missing: ${r.lines[0]}`);
  assert.ok(!r.lines.some(l => /in sync|identical/i.test(l)), r.lines.join('\n'));
  // plans\ is not synced, so its pattern-matching file must not be reported as "NAS only".
  assert.ok(!has(r, 'note_plan.md'), 'a file in an unsynced subfolder was compared');
});

test('memory: the patterns come from sync_memory.ps1 (not hardcoded), and a commented-out one is not a pattern', () => {
  const r = run(fixture('patterns', {
    nas: { 'note_a.md': 1, 'ignored_x.md': 2 },
    local: { 'note_a.md': 1, 'project_time_attendance_real.md': 4 },
  }));
  assert.ok(has(r, 'sync patterns, read from sync_memory.ps1: note_*.md, MEMORY.md'), r.lines.join('\n'));
  // With the REAL patterns project_time_attendance_real.md would be a sync file; with this script's it is outside.
  assert.ok(warnings(r).some(w => w.includes('match none of the sync patterns') && w.includes('project_time_attendance_real.md')), r.lines.join('\n'));
  assert.ok(has(r, 'ignored_x.md'), 'a commented-out pattern was treated as a pattern, or the NAS-side outsider was lost');
  assert.ok(!warnings(r).some(w => w.includes('ignored_x.md')), 'a NAS-only outsider must be information, not a warning');
});

test('memory: differing size, one side only (both directions), archive, and outside the patterns are each reported', () => {
  const r = run(fixture('differences', {
    nas: { 'note_diff.md': 20, 'note_nas_only.md': 1, 'archive/note_arch_nas.md': 6, 'RECOVERY_x.md': 9, 'plans/note_plan.md': 2 },
    local: { 'note_diff.md': 10, 'note_local_only.md': 2, 'archive/note_arch_diff.md': 4, 'lesson_new.md': 3 },
  }));
  const w = warnings(r).join('\n');
  assert.ok(w.includes('differ in size') && w.includes('note_diff.md (here 10 bytes, NAS 20 bytes)'), w);
  assert.ok(w.includes('exist on this machine only') && w.includes('note_local_only.md') && w.includes('archive\\note_arch_diff.md'), w);
  assert.ok(w.includes('exist on the NAS only') && w.includes('note_nas_only.md') && w.includes('archive\\note_arch_nas.md'), w);
  assert.ok(w.includes('match none of the sync patterns') && w.includes('lesson_new.md'), w);
  assert.ok(w.includes("owner's call") && w.includes('never deletes'), 'the one-sided warning does not leave the decision to the owner');
  assert.ok(has(r, 'RECOVERY_x.md') && !w.includes('RECOVERY_x.md'), 'the NAS-side outsider must be an information line');
  assert.ok(!w.includes('note_plan.md'), 'a file in plans\\ was compared');
  assert.ok(!r.lines.some(l => l.includes('no pattern-matching file differs')), 'a clean line was printed next to real differences');
});

test('memory: one side only is REPORT ONLY -- the module has no way to delete or copy', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'lib', 'sync-health.js'), 'utf8');
  assert.ok(!/\b(unlinkSync|rmSync|rmdirSync|writeFileSync|copyFileSync|renameSync|appendFileSync)\b/.test(src), 'sync-health.js calls a function that writes or deletes');
});

test('memory: a missing archive\\ folder is an empty one, and the other side\'s archive files are reported', () => {
  const r = run(fixture('no-archive-local', {
    nas: { 'note_a.md': 1, 'archive/note_old.md': 2 },
    local: { 'note_a.md': 1 },
  }));
  assert.deepStrictEqual(r.unmeasured, []);
  assert.ok(warnings(r).some(w => w.includes('exist on the NAS only') && w.includes('archive\\note_old.md')), r.lines.join('\n'));
});

test('memory: a non-ASCII file name is printed as "?" (a plain Windows console cannot render it)', () => {
  const r = run(fixture('thai-name', { nas: { 'note_a.md': 1 }, local: { 'note_a.md': 1, 'note_ไทย.md': 2 } }));
  assert.ok(r.lines.every(l => /^[\x20-\x7e]*$/.test(l)), r.lines.filter(l => /[^\x20-\x7e]/.test(l)).join('\n'));
  assert.ok(has(r, 'note_???.md'), r.lines.join('\n'));
});

// ---------------------------------------------------------------------------------------------
// describeSyncHealth: what could not be measured
// ---------------------------------------------------------------------------------------------
test('unreachable NAS: the reason and the path tried land in unmeasured, and no line claims agreement', () => {
  const missingNas = path.join(BASE, 'no-such-nas', 'claude_memory');
  const dirs = fixture('nas-down', { local: { 'note_a.md': 1, 'MEMORY.md': 2 } });
  const r = run({ nasDir: missingNas, localDir: dirs.localDir });
  const memory = r.unmeasured.filter(u => u.startsWith('memory comparison NOT done'));
  assert.strictEqual(memory.length, 1, JSON.stringify(r.unmeasured));
  assert.ok(memory[0].includes(missingNas), `the path tried is missing: ${memory[0]}`);
  assert.ok(/ENOENT|no such file/i.test(memory[0]), `the reason is missing: ${memory[0]}`);
  assert.ok(r.unmeasured.some(u => u.startsWith('sync.log NOT read') && u.includes(path.join(missingNas, 'sync.log'))), JSON.stringify(r.unmeasured));
  const claims = [...r.lines, ...r.unmeasured].filter(l => REASSURING.test(l));
  assert.deepStrictEqual(claims, [], `a line claims agreement while the NAS was unreachable:\n${claims.join('\n')}`);
  assert.ok(!r.lines.some(l => l.startsWith('memory:') || l.startsWith('sync.log')), `a memory or sync.log line was printed: ${r.lines.join('\n')}`);
  assert.ok(r.lines.some(l => l.startsWith('LIMIT: ')), 'the limitation line is missing');
});

test('missing local memory folder (another machine): unmeasured, naming Z-- and the path tried', () => {
  const dirs = fixture('local-missing', { nas: { 'note_a.md': 1 } });
  const missingLocal = path.join(BASE, 'local-missing', 'no-such-local');
  const r = run({ nasDir: dirs.nasDir, localDir: missingLocal });
  const m = r.unmeasured.find(u => u.startsWith('memory comparison NOT done'));
  assert.ok(m && m.includes(missingLocal) && m.includes('Z--') && m.includes('does not exist'), JSON.stringify(r.unmeasured));
  assert.ok(!r.lines.some(l => l.startsWith('memory:')), r.lines.join('\n'));
  assert.deepStrictEqual(r.lines.filter(l => REASSURING.test(l)), []);
  // The NAS was reachable, so the log is still read.
  assert.ok(has(r, 'sync.log, last line:'), r.lines.join('\n'));
});

test('unreadable $Patterns: unmeasured, and "outside the patterns" is not presented as empty', () => {
  for (const [name, script] of [['no-script', null], ['no-block', '# no pattern block in this script\n'], ['empty-block', '$Patterns = @(\n)\n']]) {
    const r = run(fixture(`patterns-${name}`, { nas: { 'note_a.md': 1 }, local: { 'note_a.md': 1, 'lesson_x.md': 2 }, script }));
    const m = r.unmeasured.find(u => u.startsWith('memory comparison NOT done'));
    assert.ok(m && m.includes('$Patterns') && m.includes('sync_memory.ps1') && m.includes('unknown, not empty'), `${name}: ${JSON.stringify(r.unmeasured)}`);
    assert.ok(!r.lines.some(l => l.startsWith('memory:') || l.startsWith('WARNING: ') && /pattern|differ/.test(l)), `${name}: ${r.lines.join('\n')}`);
    assert.deepStrictEqual(r.lines.filter(l => REASSURING.test(l)), [], name);
  }
});

test('an unexpected error never throws: it lands in unmeasured, and the limitation line still prints', () => {
  const hostile = {};
  Object.defineProperty(hostile, 'nasDir', { get() { throw new Error('boom from a getter'); } });
  let r;
  // Not through run(): its object spread would read the getter itself, outside the call under test.
  assert.doesNotThrow(() => { r = describeSyncHealth(hostile); });
  RESULTS.push(r);
  assert.ok(r.unmeasured.some(u => u.includes('boom from a getter')), JSON.stringify(r.unmeasured));
  assert.ok(r.lines[r.lines.length - 1].startsWith('LIMIT: '));
  // A reader that throws something that is not an Error (no .message) is described, not crashed on.
  const dirs = fixture('throwing-reader', { nas: { 'note_a.md': 1 }, local: { 'note_a.md': 1 } });
  assert.doesNotThrow(() => { r = run({ ...dirs, listDir: () => { throw 'a plain string'; } }); });
  assert.ok(r.unmeasured.some(u => u.includes('a plain string')), JSON.stringify(r.unmeasured));
});

// ---------------------------------------------------------------------------------------------
// describeSyncHealth: sync.log
// ---------------------------------------------------------------------------------------------
const BOM = '﻿';
const withLog = (name, log) => run({ ...fixture(name, { nas: { 'note_a.md': 1 }, local: { 'note_a.md': 1 }, log }) });

test('sync.log: the last line is read, behind a byte-order mark, and a clean one raises no warning', () => {
  const r = withLog('log-bom', BOM + LOG_CLEAN + '\n');
  assert.ok(has(r, `sync.log, last line: ${LOG_CLEAN}`), r.lines.join('\n'));
  assert.ok(!r.lines.some(l => l.includes('﻿')), 'the byte-order mark leaked into a line');
  assert.deepStrictEqual(warnings(r), [], r.lines.join('\n'));
});

test('sync.log: only the LAST line counts -- an old conflict does not warn, and a new one does', () => {
  const old = LOG_CLEAN.replace('conflict=0', 'conflict=5').replace('needs-eyes=none', 'needs-eyes=MEMORY.md');
  const r1 = withLog('log-old-conflict', `${BOM}${old}\r\n${LOG_CLEAN}\r\n\r\n`);
  assert.deepStrictEqual(warnings(r1), [], r1.lines.join('\n'));
  const r2 = withLog('log-new-conflict', `${BOM}${LOG_CLEAN}\n${LOG_CLEAN.replace('conflict=0', 'conflict=2')}\n`);
  assert.ok(warnings(r2).some(w => w.includes('conflict=2')), r2.lines.join('\n'));
});

test('sync.log: FAILED in the last line warns, and so does a needs-eyes the script raised', () => {
  const r1 = withLog('log-failed', `${LOG_CLEAN} FAILED to snapshot\n`);
  assert.ok(warnings(r1).some(w => w.includes('FAILED')), r1.lines.join('\n'));
  const r2 = withLog('log-eyes', `${LOG_CLEAN.replace('needs-eyes=none', 'needs-eyes=MEMORY.md')}\n`);
  assert.ok(warnings(r2).some(w => w.includes('needs-eyes=MEMORY.md')), r2.lines.join('\n'));
});

test('sync.log: lowercase failed=0 is not FAILED, and DIRTY n is never compared with copied+same+conflict+failed', () => {
  // The real shape: DIRTY 3 beside same=129. Comparing them would fire on almost every real run.
  const r = withLog('log-counts', LOG_CLEAN + '\n');
  assert.ok(LOG_CLEAN.includes('DIRTY 3') && LOG_CLEAN.includes('same=129') && LOG_CLEAN.includes('failed=0'));
  assert.deepStrictEqual(warnings(r), [], r.lines.join('\n'));
});

test('sync.log: a last line with no conflict= field is shown but says no conflict count was read', () => {
  const r = withLog('log-other-entry', LOG_CLEAN + '\n2026-10-12T22:00:00+07:00  CLEAN\n');
  assert.ok(has(r, 'sync.log, last line: 2026-10-12T22:00:00+07:00  CLEAN'), r.lines.join('\n'));
  assert.ok(has(r, 'no conflict= field, so no conflict count was read'), r.lines.join('\n'));
});

test('sync.log: a long log is read from its tail, and a missing or empty one is unmeasured', () => {
  const body = Array.from({ length: 400 }, (_, i) => `${LOG_CLEAN} #${i}`).join('\n');
  const r = withLog('log-long', `${BOM}${body}\n${LOG_CLEAN.replace('conflict=0', 'conflict=7')}\n`);
  assert.ok(warnings(r).some(w => w.includes('conflict=7')), r.lines.join('\n'));
  const none = run(fixture('log-absent', { nas: { 'note_a.md': 1 }, local: { 'note_a.md': 1 }, log: null }));
  assert.ok(none.unmeasured.some(u => u.startsWith('sync.log NOT read') && u.includes('sync.log')), JSON.stringify(none.unmeasured));
  const empty = withLog('log-empty', BOM + '\n');
  assert.ok(empty.unmeasured.some(u => u.startsWith('sync.log NOT read') && u.includes('empty')), JSON.stringify(empty.unmeasured));
});

// ---------------------------------------------------------------------------------------------
// describeSyncHealth: git
// ---------------------------------------------------------------------------------------------
const withGit = (name, git) => {
  const calls = [];
  const r = run({ ...fixture(name, { nas: { 'note_a.md': 1 }, local: { 'note_a.md': 1 } }), git: args => { calls.push(args.join(' ')); return git(args); } });
  return { r, calls };
};

test('git: exactly one status call and one rev-list call, with the arguments that were asked for', () => {
  const { r, calls } = withGit('git-calls', CLEAN_GIT);
  // --no-optional-locks keeps the read-only `status` from taking index.lock (a killed holder leaves a stale one).
  assert.deepStrictEqual(calls, ['--no-optional-locks status --porcelain -- STATUS.md', 'rev-list --count @{u}..HEAD']);
  assert.ok(has(r, 'STATUS.md has no uncommitted changes'), r.lines.join('\n'));
  assert.ok(has(r, '0 commits ahead of the upstream as of the last fetch'), r.lines.join('\n'));
  assert.deepStrictEqual(warnings(r), []);
});

test('git: no upstream is unmeasured and is not reported as zero', () => {
  const { r } = withGit('git-no-upstream', args => {
    if (args[0] === 'rev-list') throw new Error('fatal: no upstream configured for branch \'feat/x\'');
    return '';
  });
  assert.ok(r.unmeasured.some(u => u.includes('unpushed commits NOT counted') && u.includes('no upstream')), JSON.stringify(r.unmeasured));
  assert.ok(!r.lines.some(l => /0 commits|ahead|not on its upstream/.test(l)), `a count was printed: ${r.lines.join('\n')}`);
});

test('git: unpushed commits and an uncommitted STATUS.md warn; an unreadable answer is unmeasured', () => {
  const { r } = withGit('git-dirty', args => (args.includes('status') ? ' M STATUS.md\n' : '3\n'));
  const w = warnings(r).join('\n');
  assert.ok(w.includes('STATUS.md has uncommitted changes') && w.includes('M STATUS.md'), w);
  assert.ok(w.includes('3 commit(s)') && w.includes('not on its upstream'), w);
  const odd = withGit('git-odd', args => (args.includes('status') ? '' : 'banana\n')).r;
  assert.ok(odd.unmeasured.some(u => u.includes('unpushed commits NOT counted') && u.includes('banana')), JSON.stringify(odd.unmeasured));
  const broken = withGit('git-broken', () => { throw new Error('git is not installed'); }).r;
  assert.strictEqual(broken.unmeasured.length, 2, JSON.stringify(broken.unmeasured));
  assert.ok(broken.unmeasured.every(u => u.includes('git is not installed')), JSON.stringify(broken.unmeasured));
});

// ---------------------------------------------------------------------------------------------
// The limitation, the call style, and the shape
// ---------------------------------------------------------------------------------------------
test('describeSyncHealth() with no argument works, and has the documented shape on any machine', () => {
  const r = describeSyncHealth();
  assert.deepStrictEqual(Object.keys(r).sort(), ['lines', 'unmeasured']);
  assert.ok(Array.isArray(r.lines) && r.lines.every(l => typeof l === 'string'));
  assert.ok(Array.isArray(r.unmeasured) && r.unmeasured.every(l => typeof l === 'string'));
  // With the NAS mapped it measured something; without, it said it could not. Never neither.
  assert.ok(r.lines.length + r.unmeasured.length > 1);
  assert.ok(r.lines.every(l => /^[\x20-\x7e]*$/.test(l)) && r.unmeasured.every(l => /^[\x20-\x7e]*$/.test(l)), 'a line is not console-safe ASCII');
  RESULTS.push(r);
});

test('the limitation about the other machine is the last line of EVERY result, success or failure', () => {
  assert.ok(RESULTS.length >= 15, `only ${RESULTS.length} results were collected`);
  RESULTS.forEach((r, i) => {
    const last = r.lines[r.lines.length - 1];
    assert.ok(last && last.startsWith('LIMIT: ') && last.includes('if the other machine has not pushed, this machine cannot know what is waiting there'),
      `result #${i} does not end with the limitation line: ${last}`);
    assert.strictEqual(r.lines.filter(l => l.startsWith('LIMIT: ')).length, 1, `result #${i}`);
  });
});

console.log(`\n${passed} passed, ${failed} failed`);
