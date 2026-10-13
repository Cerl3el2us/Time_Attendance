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
  CHECKS, applyOwnerGate, guarded, readSyncPatterns,
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

test('rule 3: an unreadable path never throws out of the owner gate', () => {
  const dir = dirFor('gate'); // a directory where a file is expected: readFileSync throws EISDIR
  assert.doesNotThrow(() => applyOwnerGate('owner-item', { verdict: 'PASS', evidence: 'e' }, dir));
});

// 2026-10-13: the registry is empty, so this loop runs zero times -- and that is the real state,
// not a hole in the suite. It stays because it is the contract every future entry must meet, and
// tests/backlog-registry.test.js is what proves the empty registry and STATUS.md agree.
test('the real registry: every check runs, answers with one of the four verdicts and has evidence', () => {
  for (const id of Object.keys(CHECKS)) {
    const r = CHECKS[id].run(); // reads the real STATUS.md; reads Z: if it is mapped, else NOT-VERIFIED
    assert.ok(['PASS', 'FAIL', 'NOT-VERIFIED', 'WAITING-OWNER'].includes(r.verdict), `${id}: ${r.verdict}`);
    assert.ok(typeof r.evidence === 'string' && r.evidence.trim() !== '', `${id} has no evidence`);
  }
});

// ---------------------------------------------------------------------------------------------
// readSyncPatterns: the one piece of the retired sync check that is still in use
// ---------------------------------------------------------------------------------------------
// 2026-10-13: the sync-push-false-success check and its ~20 shape cases were deleted together with
// the item they tracked. The defect is fixed -- `push=ok` now requires that every dirty file a
// pattern can carry is in step on the NAS -- and the guard moved to tests/memory-sync.test.js,
// which runs the real script instead of matching its text. What stays here is the pattern reader,
// because scripts/lib/sync-health.js reads the same list to say which files the sync can carry.
const PATTERNS_PS1 = "$Patterns = @(\n  'feedback_attendance*.md',\n  # 'old.md',\n  'MEMORY.md'\n)\n";
function syncDir(name, { patterns = PATTERNS_PS1 } = {}) {
  const d = dirFor(name);
  put(d, 'sync_memory.ps1', patterns);
  return d;
}

test('readSyncPatterns: reads the quoted patterns, skips commented ones, null when absent', () => {
  assert.deepStrictEqual(readSyncPatterns(syncDir('patterns')), ['feedback_attendance*.md', 'MEMORY.md']);
  assert.strictEqual(readSyncPatterns(path.join(BASE, 'no-such-folder')), null);
});

// 2026-10-13 (final review): a pattern the reader cannot parse used to be skipped without a record, so
// the sync-health block printed "sync patterns, read from sync_memory.ps1" for a list missing members.
test('readSyncPatterns: a list with any pattern it cannot read is refused whole, not returned partial', () => {
  const ps1 = lines => `$Patterns = @(\n${lines.join('\n')}\n)\n`;
  const read = (name, lines) => readSyncPatterns(syncDir(name, { patterns: ps1(lines) }));
  // control: the same shape with every line readable still reads, comments and trailing comments included
  assert.deepStrictEqual(read('pat-ok', ["  'a*.md', # why", '  # "old*.md"', '', "  'MEMORY.md'"]), ['a*.md', 'MEMORY.md']);
  assert.strictEqual(read('pat-mixed', ["  'a*.md',", '  "b*.md",', "  'MEMORY.md'"]), null);       // double-quoted in the middle
  assert.strictEqual(read('pat-two-one-line', ["  'a*.md', 'b*.md',", "  'MEMORY.md'"]), null);     // second pattern on a line
  assert.strictEqual(read('pat-variable', ["  'a*.md',", '  $extra,', "  'MEMORY.md'"]), null);      // not a literal
  assert.strictEqual(readSyncPatterns(syncDir('pat-opening-line', { patterns: "$Patterns = @('a*.md',\n  'MEMORY.md'\n)\n" })), null);
  assert.strictEqual(read('pat-all-double', ['  "a*.md",', '  "MEMORY.md"']), null);                // the old all-or-nothing case
});

console.log(`backlog-checks: ${passed} passed, ${failed} failed`);
