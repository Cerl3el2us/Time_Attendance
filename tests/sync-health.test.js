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
const REASSURING = /in sync|identical|agree|up to date|all good|no pattern-matching file differs|every (non-dot )?file/i;
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
// A run that copied what was dirty. (Until 2026-10-13 this fixture said copied=0 -- the very run the open
// item sync-push-false-success is about -- and the cases below called it clean.)
const LOG_CLEAN = '2026-10-12T21:10:36+07:00  DIRTY 3  push=ok  rc=0  copied=3 same=129 conflict=0 failed=0  needs-eyes=none  snapshot=ok:a792d84,nothing-to-commit  marker=written  files=MEMORY.md';

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
const asciiOnly = l => /^[\x20-\x7e]*$/.test(l);

// The behavioural proof that the block performs no writes. While `fn` runs, every function of `fs`
// (and `fs.promises`) that writes, deletes, renames, copies, creates, truncates or changes
// attributes, and `open` with any flag but read-only, RECORDS the attempt and throws; with
// `childProcess`, so does every way of starting a process (a `cmd /c del` would be one). The block
// swallows its own errors by design, so the attempts are counted here, not inferred from the result.
// Everything is restored in `finally`. Nothing may be logged while `fn` runs: console output can
// itself go through fs.writeSync. A source scan cannot do this job: it misses async fs.unlink,
// write-mode openSync, a spawned `del` and a computed method name.
const WRITE_NAME = /^(write|append|unlink|rm|rename|copy|mkdir|truncate|chmod|chown|symlink|link|utimes|futimes|lutimes|lchown|lchmod|ftruncate|fsync|fdatasync|mkdtemp|cp|fchmod|fchown|createWriteStream|writev|opendir)/;
const SPAWN_NAME = /^(exec|execSync|execFile|execFileSync|spawn|spawnSync|fork)$/;
function withWritesForbidden(fn, { childProcess = false } = {}) {
  const attempts = [];
  const saved = [];
  const swap = (obj, key, replacement) => { saved.push([obj, key, obj[key]]); obj[key] = replacement; };
  const forbid = (obj, label, key) => swap(obj, key, function () {
    attempts.push(`${label}.${key}`);
    throw new Error(`write attempted: ${label}.${key}`);
  });
  for (const key of Object.keys(fs)) if (typeof fs[key] === 'function' && WRITE_NAME.test(key)) forbid(fs, 'fs', key);
  for (const key of Object.keys(fs.promises)) if (typeof fs.promises[key] === 'function' && WRITE_NAME.test(key)) forbid(fs.promises, 'fs.promises', key);
  for (const key of ['open', 'openSync']) {
    const real = fs[key];
    swap(fs, key, function (p, flags) {
      if (flags !== undefined && flags !== 'r' && flags !== fs.constants.O_RDONLY) {
        attempts.push(`fs.${key}(${String(flags)})`);
        throw new Error(`write-mode open attempted: ${key}`);
      }
      return real.apply(this, arguments);
    });
  }
  if (childProcess) {
    const cp = require('child_process');
    for (const key of Object.keys(cp)) if (typeof cp[key] === 'function' && SPAWN_NAME.test(key)) forbid(cp, 'child_process', key);
  }
  try { fn(); }
  finally { for (let i = saved.length - 1; i >= 0; i--) saved[i][0][saved[i][1]] = saved[i][2]; }
  return attempts;
}

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
  assert.ok(has(r, 'its other subfolders were not looked at'), 'the folders left out are not named');
  assert.ok(has(r, 'as of 2026-10-12'), 'the hardcoded claim about which folders sync does not say when it was read');
  assert.ok(has(r, 'equal sizes do not prove equal content'), 'the limit of a size comparison is not stated');
  assert.ok(has(r, 'were not looked at); 3 pattern-matching file(s) here, 3 on the NAS'), `the counts are wrong or missing: ${r.lines[0]}`);
  assert.ok(has(r, "every non-dot file in this machine's memory folder"), 'the clean line does not scope itself to non-dot files');
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

test('memory: the "no writes" harness works -- it records and blocks writes, deletes, write-mode opens and spawns, then restores', () => {
  const realUnlink = fs.unlinkSync;
  const realOpen = fs.openSync;
  const gone = path.join(BASE, 'harness-self-check', 'no-such-file');
  const attempts = withWritesForbidden(() => {
    for (const f of [
      () => fs.unlinkSync(gone), () => fs.unlink(gone, () => {}), () => fs.writeFileSync(gone, 'x'),
      () => fs.appendFileSync(gone, 'x'), () => fs.rmSync(gone), () => fs.truncateSync(gone),
      () => fs.openSync(gone, 'w'), () => fs.openSync(gone, 'a+'), () => fs.promises.unlink(gone),
      () => require('child_process').execSync('cmd /c del x'), () => require('child_process').execFileSync('cmd', ['/c', 'del', 'x']),
    ]) { try { f(); } catch (e) { /* recorded */ } }
  }, { childProcess: true });
  assert.strictEqual(attempts.length, 11, `the harness missed an attempt: ${attempts.join(', ')}`);
  assert.strictEqual(fs.unlinkSync, realUnlink, 'fs.unlinkSync was not restored');
  assert.strictEqual(fs.openSync, realOpen, 'fs.openSync was not restored');
  // A read-only open still works inside the window.
  const reads = [];
  assert.deepStrictEqual(withWritesForbidden(() => { reads.push(fs.readFileSync(__filename, 'utf8').length > 0); }), []);
  assert.deepStrictEqual(reads, [true]);
});

test('memory: the block performs NO writes, deletes or spawns -- proved by running it with all of them forbidden', () => {
  // Fixtures are built BEFORE the window; inside it only the block runs, over folders that exercise
  // every reader: listing (both folders), patterns, sync.log, and the unreachable and missing paths.
  const both = fixture('no-writes-both', {
    nas: { 'note_a.md': 10, 'note_nas.md': 1, 'archive/note_old.md': 3, 'RECOVERY_x.md': 9 },
    local: { 'note_a.md': 20, 'note_local.md': 2, 'lesson_new.md': 3 },
    log: `﻿${LOG_CLEAN.replace('conflict=0', 'conflict=1')} FAILED\n`,
  });
  const noLog = fixture('no-writes-nolog', { nas: { 'note_a.md': 1 }, local: { 'note_a.md': 1 }, log: null, script: null });
  const results = [];
  const attempts = withWritesForbidden(() => {
    results.push(describeSyncHealth({ ...both, git: CLEAN_GIT }));
    results.push(describeSyncHealth({ ...noLog, git: CLEAN_GIT }));
    results.push(describeSyncHealth({ nasDir: path.join(BASE, 'no-such-nas'), localDir: both.localDir, git: CLEAN_GIT }));
    results.push(describeSyncHealth({ nasDir: both.nasDir, localDir: path.join(BASE, 'no-such-local'), git: CLEAN_GIT }));
  }, { childProcess: true });
  RESULTS.push(...results);
  assert.deepStrictEqual(attempts, [], `the block tried to write or spawn: ${attempts.join(', ')}`);
  // The run must really have measured things; a block whose every read threw would also make no attempts.
  assert.ok(warnings(results[0]).some(w => w.includes('differ in size')), results[0].lines.join('\n'));
  assert.ok(warnings(results[0]).some(w => w.includes('conflict=1')), results[0].lines.join('\n'));
  assert.ok(results.every(r => !r.unmeasured.some(u => u.includes('write attempted'))), JSON.stringify(results.map(r => r.unmeasured)));
  assert.ok(results[1].unmeasured.some(u => u.includes('$Patterns')) && results[1].unmeasured.some(u => u.startsWith('sync.log NOT read')));
});

test('memory: the zero-argument call (real default readers, real git) also performs no writes', () => {
  let r;
  // childProcess stays allowed here: the default git runner legitimately starts `git`, read-only.
  const attempts = withWritesForbidden(() => { r = describeSyncHealth(); });
  RESULTS.push(r);
  assert.deepStrictEqual(attempts, [], `the block tried to write: ${attempts.join(', ')}`);
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

// 2026-10-13 (final review): the line that records the open defect was printed under "0 warning(s)"
// with nothing saying it was 29 hours old.
const AGE_NOW = Date.parse('2026-10-13T02:14:36+07:00'); // 5 h 4 min after LOG_CLEAN's timestamp
const withLogAt = (name, log, now) => run({ ...fixture(name, { nas: { 'note_a.md': 1 }, local: { 'note_a.md': 1 }, log }), now });
const ageLine = r => r.lines.find(l => l.startsWith('sync.log: that line is '));

test('sync.log: the age of the last line is always printed, computed from its own timestamp', () => {
  const r = withLogAt('log-age', LOG_CLEAN + '\n', AGE_NOW);
  assert.strictEqual(ageLine(r), "sync.log: that line is about 5 h 4 min old (by its own timestamp, against this machine's clock)", r.lines.join('\n'));
  assert.deepStrictEqual(r.unmeasured, []);
  // the same line, a day later: the number follows the clock, it is not a constant
  const later = withLogAt('log-age-later', LOG_CLEAN + '\n', AGE_NOW + 24 * 3600 * 1000);
  assert.ok(ageLine(later).includes('about 29 h 4 min old'), later.lines.join('\n'));
  const young = withLogAt('log-age-young', LOG_CLEAN + '\n', Date.parse('2026-10-12T21:12:36+07:00'));
  assert.ok(ageLine(young).includes('about 2 min old'), young.lines.join('\n'));
  // with no injected clock the real one is used, and the line is still there
  assert.ok(ageLine(withLog('log-age-real', LOG_CLEAN + '\n')), 'no age line with the real clock');
});

test('sync.log: an age that cannot be computed lands in unmeasured and prints no age', () => {
  for (const [name, line] of [
    ['no-timestamp', 'DIRTY 3  push=ok  rc=0  copied=3 same=1 conflict=0 failed=0  needs-eyes=none  snapshot=ok:a  marker=written'],
    ['no-offset', LOG_CLEAN.replace('+07:00', '')],
    ['impossible-date', LOG_CLEAN.replace('2026-10-12T21:10:36', '2026-13-45T25:61:61')],
  ]) {
    const r = withLogAt(`log-age-${name}`, line + '\n', AGE_NOW);
    assert.strictEqual(ageLine(r), undefined, `${name}: ${r.lines.join('\n')}`);
    assert.ok(r.unmeasured.some(u => u.startsWith('age of the last sync.log line NOT computed')), `${name}: ${JSON.stringify(r.unmeasured)}`);
  }
  const future = withLogAt('log-age-future', LOG_CLEAN + '\n', Date.parse('2026-10-12T20:00:00+07:00'));
  assert.strictEqual(ageLine(future), undefined);
  assert.ok(future.unmeasured.some(u => u.includes('in the future')), JSON.stringify(future.unmeasured));
});

test('sync.log: DIRTY n with copied=0, push=ok and marker=written warns; no other combination does', () => {
  const defect = LOG_CLEAN.replace('copied=3', 'copied=0');
  const hit = withLogAt('log-nothing-copied', defect + '\n', AGE_NOW);
  const w = warnings(hit).filter(x => x.includes('copied=0'));
  assert.strictEqual(w.length, 1, hit.lines.join('\n'));
  assert.ok(w[0].includes('DIRTY 3') && w[0].includes('marker=written') && w[0].includes('cannot say why'), w[0]);
  for (const [name, line] of [
    ['copied', LOG_CLEAN],
    ['push-failed', defect.replace('push=ok', 'push=error')],
    ['marker-kept', defect.replace('marker=written', 'marker=kept-old')],
    ['nothing-dirty', defect.replace('DIRTY 3', 'DIRTY 0')],
  ]) {
    const r = withLogAt(`log-nc-${name}`, line + '\n', AGE_NOW);
    assert.deepStrictEqual(warnings(r), [], `${name}: ${r.lines.join('\n')}`);
  }
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

test('git: exactly one status call and two rev-list calls, with the arguments that were asked for', () => {
  const { r, calls } = withGit('git-calls', CLEAN_GIT);
  // --no-optional-locks keeps the read-only `status` from taking index.lock (a killed holder leaves a stale one).
  // The second rev-list (2026-10-13) asks a different question from the first: not "are my commits
  // pushed" but "is the STATUS.md this block just summarised older than the one on main".
  assert.deepStrictEqual(calls, [
    '--no-optional-locks status --porcelain -- STATUS.md',
    'rev-list --count @{u}..HEAD',
    'rev-list --count HEAD..origin/main',
  ]);
  assert.ok(has(r, 'STATUS.md has no uncommitted changes'), r.lines.join('\n'));
  assert.ok(has(r, '0 commits ahead of the upstream as of the last fetch'), r.lines.join('\n'));
  assert.deepStrictEqual(warnings(r), []);
});

// 2026-10-13: `npm run backlog` reads the STATUS.md of the checkout it runs in. A worktree that is
// behind main therefore reports items that were closed days ago, with no hint that it is reading an
// old file -- which is the "another machine redid finished work" failure this whole project guards
// against, arriving through the tool built to prevent it. Being behind MAIN is the direction that
// matters here, not being behind this branch's own upstream: a stale branch can be perfectly in step
// with its own remote and still read a months-old STATUS.md.
test('git: a checkout behind main warns, and says what it means for what was just read', () => {
  const { r } = withGit('git-behind', args => {
    if (args.includes('status')) return '';
    return args.join(' ').includes('@{u}..HEAD') ? '0\n' : '7\n';
  });
  const w = warnings(r).join('\n');
  assert.ok(/7 commit\(s\)/.test(w) && /behind/.test(w), `no behind-main warning: ${w}`);
  assert.ok(/STATUS\.md/.test(w), `the warning must say what it means for the reader: ${w}`);
});

test('git: level with main says so and does not warn', () => {
  const { r } = withGit('git-level', CLEAN_GIT);
  assert.ok(has(r, 'level with origin/main'), r.lines.join('\n'));
  assert.deepStrictEqual(warnings(r), []);
});

test('git: no origin/main to compare with is unmeasured, not reported as level', () => {
  const { r } = withGit('git-no-main', args => {
    if (args.includes('status')) return '';
    if (args.join(' ').includes('@{u}..HEAD')) return '0\n';
    throw new Error("fatal: ambiguous argument 'origin/main': unknown revision");
  });
  assert.ok(r.unmeasured.some(u => u.includes('behind main NOT counted')), JSON.stringify(r.unmeasured));
  assert.ok(!has(r, 'level with origin/main'), r.lines.join('\n'));
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
  assert.strictEqual(broken.unmeasured.length, 3, JSON.stringify(broken.unmeasured));
  assert.ok(broken.unmeasured.every(u => u.includes('git is not installed')), JSON.stringify(broken.unmeasured));
});

// ---------------------------------------------------------------------------------------------
// The limitation, the call style, and the shape
// ---------------------------------------------------------------------------------------------
test('git: the real runner is pinned -- command, 1500 ms timeout, cwd at the repo root, and git\'s own stderr is the reason', () => {
  const calls = [];
  const dirs = fixture('git-runner', { nas: { 'note_a.md': 1 }, local: { 'note_a.md': 1 } });
  const ok = run({ ...dirs, git: undefined, execFile: (cmd, args, opts) => { calls.push({ cmd, args, opts }); return args.includes('status') ? '' : '0\n'; } });
  assert.strictEqual(calls.length, 3);
  for (const c of calls) {
    assert.strictEqual(c.cmd, 'git');
    assert.strictEqual(c.opts.timeout, 1500, 'the git timeout is not the ruled 1.5 s');
    assert.strictEqual(path.resolve(c.opts.cwd), path.resolve(__dirname, '..'), 'git does not run from the repository root');
    assert.strictEqual(c.opts.encoding, 'utf8');
  }
  assert.deepStrictEqual(calls.map(c => c.args[c.args.length - 1]), ['STATUS.md', '@{u}..HEAD', 'HEAD..origin/main']);
  assert.ok(has(ok, '0 commits ahead'), ok.lines.join('\n'));
  // A timeout lands in unmeasured; git's stderr, not Node's generic text, is the reason when there is one.
  const slow = run({ ...dirs, git: undefined, execFile: () => { throw Object.assign(new Error('spawnSync git ETIMEDOUT'), { code: 'ETIMEDOUT' }); } });
  assert.strictEqual(slow.unmeasured.filter(u => u.includes('ETIMEDOUT')).length, 3, JSON.stringify(slow.unmeasured));
  assert.ok(!slow.lines.some(l => l.startsWith('git:') || /^WARNING: git:/.test(l)), slow.lines.join('\n'));
  const noUp = run({ ...dirs, git: undefined, execFile: (c, args) => {
    if (args[0] === 'rev-list') throw Object.assign(new Error('Command failed: git rev-list'), { stderr: 'fatal: no upstream configured for branch \'x\'\n' });
    return '';
  } });
  assert.ok(noUp.unmeasured.some(u => u.includes('no upstream to compare with') && u.includes('fatal: no upstream configured')), JSON.stringify(noUp.unmeasured));
});

test('the block reports its own elapsed milliseconds, as a whole number that grows with the work', () => {
  const dirs = fixture('elapsed', { nas: { 'note_a.md': 1 }, local: { 'note_a.md': 1 } });
  const fast = run(dirs);
  assert.ok(Number.isInteger(fast.elapsedMs) && fast.elapsedMs >= 0, String(fast.elapsedMs));
  const spin = () => { const t = Date.now(); while (Date.now() - t < 60); };
  const slow = run({ ...dirs, listDir: d => { spin(); return fs.readdirSync(d, { withFileTypes: true }).filter(e => e.isFile()).map(e => ({ name: e.name, size: 1 })); } });
  assert.ok(slow.elapsedMs >= 100, `4 listings of 60 ms were measured as ${slow.elapsedMs} ms`);
});

test('the conflict warning claims nothing it did not measure: no "the log does not say", and it points at needs-eyes=', () => {
  const conflict = LOG_CLEAN.replace('conflict=0', 'conflict=2').replace('needs-eyes=none', 'needs-eyes=MEMORY.md');
  const r = withLog('log-conflict-wording', `${conflict}\n`);
  const w = warnings(r).find(x => x.includes('conflict=2'));
  assert.ok(w, r.lines.join('\n'));
  assert.ok(!/does not say|newer|equally recent/.test(w), `the warning asserts a cause or a gap it did not measure: ${w}`);
  assert.ok(w.includes('needs-eyes='), w);
  // The names ARE in the log line, and the next warning prints them.
  assert.ok(warnings(r).some(x => x.includes('needs-eyes=MEMORY.md')), r.lines.join('\n'));
});

test('the differing-size warning gives no cause it did not measure', () => {
  const r = run(fixture('differ-wording', { nas: { 'note_a.md': 2 }, local: { 'note_a.md': 1 } }));
  const w = warnings(r).find(x => x.includes('differ in size'));
  assert.ok(w && !/pushed|pulled/.test(w) && w.includes('do not say which side is newer'), w);
});

test('the memory counts are per side: "here" is this machine, "on the NAS" is the NAS, and files outside the patterns are not counted', () => {
  const r = run(fixture('counts', {
    nas: { 'note_1.md': 1, 'note_2.md': 1, 'note_3.md': 1, 'note_4.md': 1, 'note_5.md': 1, 'lesson_nas.md': 1, '.sync_marker': 1 },
    local: { 'note_1.md': 1, 'note_2.md': 1, 'note_3.md': 1, 'archive/note_a.md': 1, 'lesson_a.md': 1, 'lesson_b.md': 1 },
  }));
  assert.ok(has(r, '4 pattern-matching file(s) here, 5 on the NAS'), r.lines[0]);
});

test('the sync.log line is console-safe and cut at 300 characters, with a mark only when it was cut', () => {
  const thai = withLog('log-thai', `${LOG_CLEAN} note_ไทย.md\n`);
  assert.ok(thai.lines.every(asciiOnly), thai.lines.filter(l => !asciiOnly(l)).join('\n'));
  assert.ok(has(thai, 'note_???.md'), thai.lines.join('\n'));
  const head = 'sync.log, last line: ';
  const exact = withLog('log-300', `${'a'.repeat(300)}\n`).lines.find(l => l.startsWith(head));
  assert.strictEqual(exact, head + 'a'.repeat(300), 'a line of exactly 300 characters was cut or marked');
  const longLine = withLog('log-301', `${'a'.repeat(300)}TAILMARK\n`).lines.find(l => l.startsWith(head));
  assert.strictEqual(longLine, `${head}${'a'.repeat(300)} ...`, 'a longer line was not cut at 300 and marked');
});

test('a Thai directory name never reaches the output raw (the no-argument call prints this machine\'s own path)', () => {
  const dirs = fixture('thai-ไทย-dir', { nas: { 'note_a.md': 1 }, local: { 'note_a.md': 1 } });
  const ok = run(dirs);
  assert.ok(ok.lines.every(asciiOnly) && ok.unmeasured.every(asciiOnly), ok.lines.filter(l => !asciiOnly(l)).join('\n'));
  assert.ok(ok.lines[0].includes('thai-???-dir'), ok.lines[0]);
  const down = run({ nasDir: path.join(dirs.nasDir, 'ไทย'), localDir: dirs.localDir });
  assert.ok(down.unmeasured.every(asciiOnly) && down.unmeasured.some(u => u.includes('???')), JSON.stringify(down.unmeasured));
});

test('the limitation line stays true when the NAS comparison never happened', () => {
  const down = run({ nasDir: path.join(BASE, 'no-such-nas-2'), localDir: path.join(BASE, 'no-such-local-2') });
  assert.ok(!down.lines.some(l => l.startsWith('memory:')));
  const last = down.lines[down.lines.length - 1];
  assert.ok(!/everything above/i.test(last), `the limitation claims a comparison that did not happen: ${last}`);
  assert.ok(last.includes('where they were made'), last);
});

test('a name shown in the NAS-only "outside the patterns" list is not blessed as expected', () => {
  const r = run(fixture('no-blessing', { nas: { 'note_a.md': 1, 'stray_note.md': 1 }, local: { 'note_a.md': 1 } }));
  const l = r.lines.find(x => x.includes('stray_note.md'));
  assert.ok(l && !/expected/i.test(l), l);
});

test('describeSyncHealth() with no argument works, and has the documented shape on any machine', () => {
  const r = describeSyncHealth();
  assert.deepStrictEqual(Object.keys(r).sort(), ['elapsedMs', 'lines', 'unmeasured']);
  assert.ok(Number.isInteger(r.elapsedMs) && r.elapsedMs >= 0);
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
