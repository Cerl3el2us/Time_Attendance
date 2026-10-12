// The registry of `npm run backlog` against fixtures (2026-10-12).
//
// tests/backlog-registry.test.js only proves that STATUS.md and the registry name the same ids. It
// says nothing about what the checks DO, and three promises live nowhere else:
//   - rule 2: an item carrying a `· รอเจ้าของ:` line is WAITING-OWNER whatever the code check said.
//     STATUS.md has no such item today, so without this file that path has no live case and could
//     rot without a single red line;
//   - rule 3: a check never throws; an I/O failure becomes NOT-VERIFIED with the reason;
//   - the sync check answers FAIL only for the exact code shape it knows. A review tried six
//     plausible fixes of sync_if_dirty.ps1 and three of them still read FAIL, with the old defect
//     text, because the check looked for a line number's worth of text rather than a shape.
// Plus the evidence rules from the same review: a sentence about what was (not) written is printed
// only when the log fields support it.
//
// Every fixture is built here; nothing reads Z:. Fixtures go to one fixed folder under the OS temp
// directory whose files are overwritten on each run, so nothing accumulates and nothing is deleted.
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  CHECKS, checkBacklogCommand, checkSyncPushFalseSuccess, applyOwnerGate, guarded, readSyncPatterns,
} = require('../scripts/lib/backlog-checks');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok ', name); }
  catch (e) { failed++; process.exitCode = 1; console.log('  FAIL', name, '\n      ', e.message); }
}

const BASE = path.join(os.tmpdir(), 'ta-backlog-checks-test');
function dirFor(name) {
  const d = path.join(BASE, name);
  fs.mkdirSync(d, { recursive: true });
  return d;
}
function put(dir, rel, text) {
  const p = path.join(dir, ...rel.split('/'));
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
  return p;
}

// ---------------------------------------------------------------------------------------------
// rule 2: the owner gate
// ---------------------------------------------------------------------------------------------
const STATUS_FIXTURE = [
  '## เปิดอยู่',
  '',
  '- **ข้อที่รอเจ้าของ**',
  '  · ตรวจ: owner-item',
  '  · รอเจ้าของ: เลือกทาง A หรือ B',
  '',
  '- **ข้อที่ไม่รอใคร**',
  '  · ตรวจ: plain-item',
  '',
].join('\n');
const statusFile = put(dirFor('gate'), 'STATUS.md', STATUS_FIXTURE);

test('owner gate: PASS, FAIL and NOT-VERIFIED all become WAITING-OWNER for an item awaiting the owner', () => {
  for (const verdict of ['PASS', 'FAIL', 'NOT-VERIFIED']) {
    const r = applyOwnerGate('owner-item', { verdict, evidence: `inner evidence for ${verdict}` }, statusFile);
    assert.strictEqual(r.verdict, 'WAITING-OWNER', `${verdict} was not turned into WAITING-OWNER: ${JSON.stringify(r)}`);
    assert.ok(r.evidence.includes(`inner evidence for ${verdict}`), `the inner evidence was lost for ${verdict}`);
    assert.ok(r.evidence.includes(`says ${verdict}`), `the inner verdict is not visible for ${verdict}`);
    assert.ok(r.evidence.includes('STATUS.md:3'), `the item line is not cited: ${r.evidence}`);
    assert.ok(r.evidence.includes('เลือกทาง A หรือ B'), 'the owner\'s own words were dropped');
  }
});

test('owner gate: an item that awaits nobody, and an id STATUS.md does not know, are left untouched', () => {
  const inner = { verdict: 'PASS', evidence: 'e' };
  assert.deepStrictEqual(applyOwnerGate('plain-item', inner, statusFile), inner);
  assert.deepStrictEqual(applyOwnerGate('no-such-id', inner, statusFile), inner);
});

test('owner gate: with STATUS.md unreadable, PASS is held back and FAIL/NOT-VERIFIED say the wait was never checked', () => {
  const missing = path.join(dirFor('gate'), 'no-such-STATUS.md');
  const pass = applyOwnerGate('owner-item', { verdict: 'PASS', evidence: 'e' }, missing);
  assert.strictEqual(pass.verdict, 'NOT-VERIFIED');
  assert.ok(pass.evidence.includes('owner-wait state NOT checked'), pass.evidence);
  for (const verdict of ['FAIL', 'NOT-VERIFIED']) {
    const r = applyOwnerGate('owner-item', { verdict, evidence: 'e' }, missing);
    assert.strictEqual(r.verdict, verdict);
    assert.ok(r.evidence.includes('owner-wait state NOT checked'), `no hint for ${verdict}: ${r.evidence}`);
  }
});

test('owner gate: it is wired into the registry, so a check cannot skip it', () => {
  const gated = guarded('owner-item', { describe: 'd', run: () => ({ verdict: 'PASS', evidence: 'e' }) }, statusFile).run();
  assert.strictEqual(gated.verdict, 'WAITING-OWNER');
});

// ---------------------------------------------------------------------------------------------
// rule 3: run() never throws
// ---------------------------------------------------------------------------------------------
test('rule 3: a check whose I/O throws returns NOT-VERIFIED with the reason, and does not throw', () => {
  const c = guarded('boom', { describe: 'd', run() { throw new Error('disk fell off'); } }, statusFile);
  let r;
  assert.doesNotThrow(() => { r = c.run(); });
  assert.strictEqual(r.verdict, 'NOT-VERIFIED');
  assert.ok(r.evidence.includes('disk fell off'), r.evidence);
});

test('rule 3: a bad verdict, no result, or a PASS without evidence is NOT-VERIFIED', () => {
  const run = result => guarded('x', { describe: 'd', run: () => result }, statusFile).run();
  assert.strictEqual(run({ verdict: 'GREEN', evidence: 'e' }).verdict, 'NOT-VERIFIED');
  assert.strictEqual(run(undefined).verdict, 'NOT-VERIFIED');
  assert.strictEqual(run({ verdict: 'PASS', evidence: '  ' }).verdict, 'NOT-VERIFIED');
  assert.strictEqual(run({ verdict: 'PASS' }).verdict, 'NOT-VERIFIED');
});

test('rule 3: an unreadable path never throws out of the gate or the sync check', () => {
  const dir = dirFor('gate'); // a directory where a file is expected: readFileSync throws EISDIR
  assert.doesNotThrow(() => applyOwnerGate('owner-item', { verdict: 'PASS', evidence: 'e' }, dir));
  assert.doesNotThrow(() => checkSyncPushFalseSuccess(statusFile));
});

test('the real registry: every check runs, answers with one of the four verdicts and has evidence', () => {
  for (const id of Object.keys(CHECKS)) {
    const r = CHECKS[id].run(); // reads the real STATUS.md; reads Z: if it is mapped, else NOT-VERIFIED
    assert.ok(['PASS', 'FAIL', 'NOT-VERIFIED', 'WAITING-OWNER'].includes(r.verdict), `${id}: ${r.verdict}`);
    assert.ok(typeof r.evidence === 'string' && r.evidence.trim() !== '', `${id} has no evidence`);
  }
});

// ---------------------------------------------------------------------------------------------
// sync-push-false-success
// ---------------------------------------------------------------------------------------------
const PATTERNS_PS1 = "$Patterns = @(\n  'feedback_attendance*.md',\n  # 'old.md',\n  'MEMORY.md'\n)\n";
const DIRTY_LINE = (extra = {}) => {
  const f = Object.assign({ dirty: 3, push: 'ok', rc: 0, copied: 0, same: 9, conflict: 0, failed: 0, marker: 'written', files: 'MEMORY.md' }, extra);
  return `2026-10-12T20:00:00+07:00  DIRTY ${f.dirty}  push=${f.push}  rc=${f.rc}  copied=${f.copied} same=${f.same} conflict=${f.conflict} failed=${f.failed}  needs-eyes=none  snapshot=x  marker=${f.marker}  files=${f.files}\n`;
};
// A tiny stand-in for sync_if_dirty.ps1 around the part the check reads. `decide` replaces the
// success decision, `guard` the guard line.
function syncDir(name, { decide = '$pushOk = ($rc -eq 0) -and ($null -ne $failed) -and ($failed -eq 0)', guard = 'if ($pushOk) {', log = DIRTY_LINE(), patterns = PATTERNS_PS1 } = {}) {
  const d = dirFor(name);
  put(d, 'sync_if_dirty.ps1', ['$rc = 0', decide, "$markerState = 'kept-old'", guard, '  Set-Content -LiteralPath $markerFull -Value "pushed $stamp" -Encoding UTF8', '}', ''].join('\n'));
  put(d, 'sync_memory.ps1', patterns);
  put(d, 'sync.log', log);
  return d;
}
const NEVER_PASS = r => assert.notStrictEqual(r.verdict, 'PASS', `PASS without proof: ${r.evidence}`);

// Declared above every case that calls it: each test() runs as the file is read, so a helper
// defined further down would be in its temporal dead zone -- which eslint does not report.
const HAND = 'read sync_if_dirty.ps1 by hand';
const CLOSE = 'close the STATUS.md item (sync-push-false-success) and delete this check in the same commit';
function assertShapeChanged(r, why) {
  NEVER_PASS(r);
  assert.strictEqual(r.verdict, 'NOT-VERIFIED', `${why}: expected NOT-VERIFIED, got ${r.verdict}\n${r.evidence}`);
  assert.ok(r.evidence.includes('not the one this check knows'), `${why}: no shape-changed statement: ${r.evidence}`);
  assert.ok(r.evidence.includes(HAND) && r.evidence.includes(CLOSE), `${why}: no hand-read instruction: ${r.evidence}`);
  assert.ok(!r.evidence.includes('push counts as ok on the exit code'), `${why}: the old defect text survived: ${r.evidence}`);
}

test('sync: the known old shape is FAIL, citing the decision line, the marker line and the guard', () => {
  const r = checkSyncPushFalseSuccess(syncDir('old-shape'));
  assert.strictEqual(r.verdict, 'FAIL', r.evidence);
  assert.ok(r.evidence.includes('sync_if_dirty.ps1:2: $pushOk = '), r.evidence);
  assert.ok(r.evidence.includes('sync_if_dirty.ps1:5:'), `marker line not cited: ${r.evidence}`);
  assert.ok(r.evidence.includes('inside the block opened by the exact "if ($pushOk) {" at :4'), `guard line not cited: ${r.evidence}`);
});

// 2026-10-12 (re-review): a FAIL claims the defect is live, and this check reads three places only.
// An upstream fix (`if ($copied -eq 0) { $failed = 1 }` before the decision) cannot be seen by
// shape, so the FAIL has to say so where it will be read rather than imply full coverage.
test('sync: the FAIL states the limit of what it read, so an upstream fix is not implied away', () => {
  const r = checkSyncPushFalseSuccess(syncDir('limit-stated'));
  assert.strictEqual(r.verdict, 'FAIL', r.evidence);
  assert.ok(r.evidence.includes('LIMIT of this check'), r.evidence);
  assert.ok(/reads only the \$pushOk decision, its guard and the marker write/.test(r.evidence), r.evidence);
  assert.ok(/a fix made elsewhere in the script/.test(r.evidence), r.evidence);
  assert.ok(/read sync_if_dirty\.ps1 by hand before trusting this FAIL/.test(r.evidence), r.evidence);
  // and the same limit is on the registry entry, which is what a reader of the backlog sees first
  assert.ok(/reads nothing but those three places/.test(CHECKS['sync-push-false-success'].describe),
    CHECKS['sync-push-false-success'].describe);
});

// The marker write has to be INSIDE the guard's block, not merely below its line. Keeping the guard
// line, closing its block and writing the marker under another `if` left this FAIL while the
// evidence said "guarded only by the exact if ($pushOk)" -- a sentence that was then false.
test('sync: the marker write moved out of the if ($pushOk) block is NOT-VERIFIED, with no "guarded by" claim', () => {
  const d = dirFor('marker-outside');
  put(d, 'sync_if_dirty.ps1', [
    '$rc = 0',
    '$pushOk = ($rc -eq 0) -and ($null -ne $failed) -and ($failed -eq 0)',
    'if ($pushOk) {',
    "  $markerState = 'would-write'",
    '}',
    'if ($rc -eq 0) {',
    '  Set-Content -LiteralPath $markerFull -Value "pushed $stamp" -Encoding UTF8',
    '}',
    '',
  ].join('\n'));
  put(d, 'sync_memory.ps1', PATTERNS_PS1);
  put(d, 'sync.log', DIRTY_LINE());
  const r = checkSyncPushFalseSuccess(d);
  assertShapeChanged(r, 'marker outside the guard block');
  assert.ok(!/guarded only by|inside the block opened/.test(r.evidence), `a guard claim survived: ${r.evidence}`);
  assert.ok(r.evidence.includes('is not inside the "if ($pushOk) {" block'), r.evidence);
});

test('sync: one more condition on the known expression is NOT-VERIFIED, however it is worded', () => {
  for (const [name, decide] of [
    ['extended-unknown-var', '$pushOk = ($rc -eq 0) -and ($null -ne $failed) -and ($failed -eq 0) -and ($pushedN -gt 0)'],
    ['extended-front', '$pushOk = ($copiedAny) -and ($rc -eq 0) -and ($null -ne $failed) -and ($failed -eq 0)'],
    ['narrowed', '$pushOk = ($rc -eq 0) -and ($failed -eq 0)'],
  ]) {
    assertShapeChanged(checkSyncPushFalseSuccess(syncDir(name, { decide })), name);
  }
});

test('sync: a second assignment carrying a scope prefix is NOT-VERIFIED, not invisible', () => {
  for (const prefix of ['$script:', '$global:', '$private:']) {
    const d = syncDir(`scoped-${prefix.replace(/[$:]/g, '')}`, {
      decide: `$pushOk = ($rc -eq 0) -and ($null -ne $failed) -and ($failed -eq 0)\n${prefix}pushOk = $pushOk -and ($copied -gt 0)`,
    });
    const r = checkSyncPushFalseSuccess(d);
    assertShapeChanged(r, `${prefix}pushOk second assignment`);
    assert.ok(r.evidence.includes('2 assignments to $pushOk'), `the scoped assignment was not counted: ${r.evidence}`);
  }
});

test('sync: a second $pushOk assignment (a plausible real fix) is NOT-VERIFIED, not FAIL', () => {
  const d = syncDir('two-assignments', { decide: '$pushOk = ($rc -eq 0) -and ($failed -eq 0)\n$pushOk = $pushOk -and ($copied -gt 0)' });
  assertShapeChanged(checkSyncPushFalseSuccess(d), 'second assignment');
});

test('sync: a changed marker guard is NOT-VERIFIED, not FAIL', () => {
  const d = syncDir('changed-guard', { guard: 'if ($pushOk -and $copied -gt 0) {' });
  assertShapeChanged(checkSyncPushFalseSuccess(d), 'changed guard');
});

test('sync: a $pushOk split across lines with a backtick is NOT-VERIFIED, not FAIL', () => {
  const d = syncDir('backtick', { decide: '$pushOk = ($rc -eq 0) -and `\n  ($failed -eq 0)' });
  assertShapeChanged(checkSyncPushFalseSuccess(d), 'backtick continuation');
});

test('sync: a decision that now mentions copied/dirty is NOT-VERIFIED, not PASS and not FAIL', () => {
  const d = syncDir('mentions-copied', { decide: '$pushOk = ($rc -eq 0) -and ($failed -eq 0) -and ($copied + $same -ge $dirtyCount)' });
  assertShapeChanged(checkSyncPushFalseSuccess(d), 'accounting mentioned');
});

test('sync: no $pushOk assignment at all is NOT-VERIFIED', () => {
  assertShapeChanged(checkSyncPushFalseSuccess(syncDir('no-assignment', { decide: '# decision moved elsewhere' })), 'no assignment');
});

test('sync: an unreachable memory folder is NOT-VERIFIED, naming the path tried, never PASS', () => {
  const nowhere = path.join(BASE, 'no-such-folder');
  const r = checkSyncPushFalseSuccess(nowhere);
  assert.strictEqual(r.verdict, 'NOT-VERIFIED');
  assert.ok(r.evidence.includes(path.join(nowhere, 'sync_if_dirty.ps1')), `path not named: ${r.evidence}`);
});

// Evidence honesty (I1): each sentence needs the log fields that make it true.
test('sync evidence: a FAILED push with copied=0 does not claim the folder was marked clean or the NAS identical', () => {
  const log = DIRTY_LINE({ push: 'FAILED', rc: 1, marker: 'kept-old' });
  const r = checkSyncPushFalseSuccess(syncDir('failed-push', { log }));
  assert.ok(!/marked clean|identical|already held/.test(r.evidence), r.evidence);
  assert.ok(r.evidence.includes('did not mark the folder clean'), r.evidence);
  const w = checkSyncPushFalseSuccess(syncDir('write-failed', { log: DIRTY_LINE({ marker: 'WRITE-FAILED' }) }));
  assert.ok(!/marked clean|identical|already held/.test(w.evidence), w.evidence);
});

test('sync evidence: push=ok marker=written with copied=0 says so, and calls same a size-and-mtime count, not identical copies', () => {
  const r = checkSyncPushFalseSuccess(syncDir('cleared'));
  assert.ok(r.evidence.includes('yet the folder was marked clean'), r.evidence);
  assert.ok(r.evidence.includes('size and mtime, not a hash'), r.evidence);
  assert.ok(!/identical|already held/.test(r.evidence), r.evidence);
});

test('sync evidence: a dirty name no pattern matches is reported; matching names are "not excluded by name", with the unlisted tail', () => {
  const bad = checkSyncPushFalseSuccess(syncDir('unmatched', { log: DIRTY_LINE({ files: 'MEMORY.md, lesson_x.md (+4)' }) }));
  assert.ok(bad.evidence.includes('match none of the sync patterns') && bad.evidence.includes('lesson_x.md'), bad.evidence);
  assert.ok(bad.evidence.includes('4 more dirty name(s) are not listed in the log and were not tested'), bad.evidence);
  const ok = checkSyncPushFalseSuccess(syncDir('matched', { log: DIRTY_LINE({ files: 'MEMORY.md, feedback_attendance_x.md' }) }));
  assert.ok(ok.evidence.includes('no listed name is excluded by name'), ok.evidence);
  assert.ok(!ok.evidence.includes('no skipped file'), 'overstated claim came back');
});

// The caveat is the whole reason the sentence above is allowed to exist: sync_if_dirty.ps1 counts a
// file in any non-dot SUBFOLDER as dirty, while sync_memory.ps1 copies only the top level and
// archive\, so a name that passes the pattern test can still never be copied. Without this case,
// deleting the caveat left the suite green (mutation testing, 2026-10-12).
test('sync evidence: the name test carries its subfolder caveat, so it is not read as "nothing was skipped"', () => {
  const r = checkSyncPushFalseSuccess(syncDir('caveat', { log: DIRTY_LINE({ files: 'MEMORY.md' }) }));
  assert.ok(/subfolder/.test(r.evidence), `no subfolder caveat: ${r.evidence}`);
  assert.ok(/names alone cannot show/.test(r.evidence), `the caveat lost its point: ${r.evidence}`);
  assert.ok(/dirty but never copied/.test(r.evidence), `the caveat lost its consequence: ${r.evidence}`);
});

test('sync evidence: a sync.log with a byte-order mark and a single DIRTY run on line 1 is still read', () => {
  const r = checkSyncPushFalseSuccess(syncDir('bom', { log: '﻿' + DIRTY_LINE() }));
  assert.ok(r.evidence.includes('sync.log:1: 2026-10-12T20:00:00'), r.evidence);
  assert.ok(!r.evidence.includes('has no DIRTY run'), r.evidence);
});

test('sync evidence: the DIRTY count is never compared with the sum of the four counts', () => {
  const r = checkSyncPushFalseSuccess(syncDir('sum', { log: DIRTY_LINE({ dirty: 3, same: 129 }) }));
  assert.ok(r.evidence.includes('cannot show a skipped file'), r.evidence);
  assert.ok(!r.evidence.includes('LIVE INSTANCE') && !r.evidence.includes('silently'), r.evidence);
});

test('readSyncPatterns: reads the quoted patterns, skips commented ones, null when absent', () => {
  assert.deepStrictEqual(readSyncPatterns(syncDir('patterns')), ['feedback_attendance*.md', 'MEMORY.md']);
  assert.strictEqual(readSyncPatterns(path.join(BASE, 'no-such-folder')), null);
});

// ---------------------------------------------------------------------------------------------
// backlog-command
// ---------------------------------------------------------------------------------------------
const PKG = '{\n  "name": "x",\n  "scripts": {\n    "test": "t",\n    "backlog": "node scripts/backlog.js"\n  }\n}\n';
function rootWith(name, { script = 'console.log(1);\n', pkg = PKG, cmd = '# backlog\n' } = {}) {
  const d = dirFor(name);
  // Files are overwritten, never removed, so a missing deliverable is a name nobody writes: each
  // case below uses its own folder.
  if (script !== null) put(d, 'scripts/backlog.js', script);
  if (pkg !== null) put(d, 'package.json', pkg);
  if (cmd !== null) put(d, '.claude/commands/backlog.md', cmd);
  return d;
}

test('backlog-command: all three missing is FAIL naming each of them', () => {
  const r = checkBacklogCommand(rootWith('bc-none', { script: null, pkg: '{"scripts":{}}', cmd: null }));
  assert.strictEqual(r.verdict, 'FAIL');
  for (const s of ['scripts/backlog.js does not exist', 'no "backlog" entry', '.claude/commands/backlog.md does not exist']) {
    assert.ok(r.evidence.includes(s), `${s} missing from: ${r.evidence}`);
  }
});

test('backlog-command: any one of the three missing is FAIL', () => {
  assert.strictEqual(checkBacklogCommand(rootWith('bc-no-script', { script: null })).verdict, 'FAIL');
  assert.strictEqual(checkBacklogCommand(rootWith('bc-no-entry', { pkg: '{"scripts":{"test":"t"}}' })).verdict, 'FAIL');
  assert.strictEqual(checkBacklogCommand(rootWith('bc-no-cmd', { cmd: null })).verdict, 'FAIL');
});

test('backlog-command: an empty script, or an entry that does not run it, is FAIL', () => {
  assert.strictEqual(checkBacklogCommand(rootWith('bc-empty', { script: '' })).verdict, 'FAIL');
  const echo = checkBacklogCommand(rootWith('bc-echo', { pkg: PKG.replace('node scripts/backlog.js', 'echo hi') }));
  assert.strictEqual(echo.verdict, 'FAIL');
  assert.ok(echo.evidence.includes('does not run scripts/backlog.js'), echo.evidence);
});

test('backlog-command: PASS only with all three, citing the real package.json line of the key', () => {
  const r = checkBacklogCommand(rootWith('bc-all'));
  assert.strictEqual(r.verdict, 'PASS', r.evidence);
  const want = PKG.split('\n').findIndex(l => l.includes('"backlog"')) + 1;
  assert.ok(r.evidence.includes(`package.json:${want} `), `expected package.json:${want} in: ${r.evidence}`);
  assert.ok(r.evidence.includes('scripts/backlog.js exists') && r.evidence.includes('.claude/commands/backlog.md exists'), r.evidence);
});

test('backlog-command: a package.json that is not JSON is NOT-VERIFIED, not a throw', () => {
  const r = checkBacklogCommand(rootWith('bc-badjson', { pkg: '{ not json' }));
  assert.strictEqual(r.verdict, 'NOT-VERIFIED');
});

console.log(`backlog-checks: ${passed} passed, ${failed} failed`);
