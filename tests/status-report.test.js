// `npm run status` reports measured facts and says what it could not measure (2026-10-08).
//
// Spec: Z:\claude_memory\plans\2026-10-02-cross-machine-state-design.md section 4.4. The owner's own
// words there: "I cannot remember it, and I do not know which one to run" -- so this one command has
// to print the other commands at the bottom, and it must never be a source of confident wrong
// answers. The failure the spec worries about most is a status tool that prints a number it could not
// really measure: `data/` is gitignored and lives only on the NAS, so in a worktree the record counts
// simply do not exist, and a tool that printed "0 records" there would be lying.
//
// This is a smoke test of the contract, not of every number: it runs the real script against the real
// repository and checks that each promised section is present and that the honest-absence rules hold.
'use strict';
const path = require('path');
const fs = require('fs');
const assert = require('assert');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'status.js');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok ', name); }
  catch (e) { process.exitCode = 1; console.log('  FAIL', name, '\n      ', e.message); }
}

console.log('status report: contract of `npm run status`');

test('the script exists', () => {
  assert.ok(fs.existsSync(SCRIPT), 'scripts/status.js is missing');
});

const run = fs.existsSync(SCRIPT)
  ? spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8', cwd: ROOT })
  : { status: -1, stdout: '', stderr: 'script missing' };
const out = run.stdout || '';

test('exits 0 -- a report is not a gate', () => {
  assert.strictEqual(run.status, 0, `exit ${run.status}: ${run.stderr}`);
});

// Every assertion below matches CONTENT, not a header. The first version of this file checked only
// for the literal section titles, all of which status.js prints unconditionally -- so deleting the
// loop that prints the commit list, or emptying the guarded-marker list entirely, still read as
// green. A test that passes with the feature removed is not a test.
test('names the branch and the commit it measured, not just the words', () => {
  assert.ok(/Measured from:/.test(out), 'no "Measured from:" line');
  assert.ok(/^\s+branch \S+, at (\(NOT measured\)|[0-9a-f]{7})/m.test(out),
    'no "branch <name>, at <sha>" line -- the header alone proves nothing');
});

test('reports uncommitted files and remote position', () => {
  assert.ok(/^Uncommitted: (none|NOT measured|\d+ file)/m.test(out), 'no usable "Uncommitted:" line');
  assert.ok(/^Remote: /m.test(out), 'no "Remote:" line');
  assert.ok(/main vs origin\/main: (\d+ ahead, \d+ behind|NOT measured)/.test(out),
    'the main-vs-origin line vanished -- its absence reads as "nothing to report", not "could not check"');
});

test('lists the latest commits as actual commit lines', () => {
  assert.ok(/Latest commits/.test(out), 'no "Latest commits" section');
  assert.ok(/^\s+[0-9a-f]{7} \d{4}-\d{2}-\d{2} \S/m.test(out) || /^\s+\(none\)$/m.test(out) || /NOT measured/.test(out),
    'the section is there but prints no commit lines');
});

test('lists commits since STATUS.md was last touched, with titles not just a count', () => {
  const m = /Since STATUS\.md was last updated \([^)]*\): (\d+) commit\(s\)/.exec(out);
  assert.ok(m || /Since STATUS\.md was last updated.*NOT measured/.test(out) || /no history here/.test(out),
    'no "Since STATUS.md" section');
  if (m && Number(m[1]) > 0) {
    assert.ok(/^\s+[0-9a-f]{7} \S/m.test(out),
      `says ${m[1]} commit(s) but printed no titles -- the count alone cannot show work that came from another machine`);
  }
});

test('compares each guarded asset, printing a verdict and the version value', () => {
  assert.ok(/Cache-buster/.test(out), 'no "Cache-buster" section');
  if (/NOT measured: this is a shallow clone/.test(out)) return;
  const rows = out.split('\n').filter(l => /^\s+(ok|STALE|\?)\s+attendance\//.test(l));
  assert.ok(rows.length >= 4, `only ${rows.length} asset row(s) -- the guarded list was emptied or the loop was removed`);
});

test('never claims a record count it could not measure', () => {
  const dataDir = path.join(ROOT, 'attendance-server', 'backend', 'data');
  // Match the branch-specific wording, not the shared prefix: `/Data files/` alone matched BOTH
  // branches, so the positive case could not fail even if the script claimed it could not measure.
  // And scope the record-count check to this section -- asserting it against the whole report made
  // it a tautology, since the only code that prints "N records" lives in the branch that provably
  // did not run.
  const section = (out.split(/^Data files/m)[1] || '').split('\n\n')[0];
  if (fs.existsSync(dataDir)) {
    assert.ok(/^Data files \(/m.test(out), 'data/ exists here but the report says it could not measure it');
    assert.ok(/\d+ (records|top-level keys)|unreadable|could not read/.test(section),
      'listed the data folder but reported nothing about any file in it');
  } else {
    assert.ok(/^Data files: NOT measured here\./m.test(out), 'data/ is absent here and the report did not say so');
    assert.ok(!/\d+ (records|top-level keys)/.test(section),
      'printed a count in the Data files section with no data folder to count');
  }
});

test('prints the other commands at the bottom so only one has to be remembered', () => {
  assert.ok(/npm run check/.test(out), 'footer does not mention `npm run check`');
  assert.ok(/npm run status/.test(out), 'footer does not mention `npm run status`');
});

console.log(`\n${passed} passed, ${process.exitCode ? 'some failed' : '0 failed'}`);
