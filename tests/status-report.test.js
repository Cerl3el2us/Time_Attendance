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

test('says which tree and branch it measured', () => {
  assert.ok(/Measured from:/.test(out), 'no "Measured from:" line');
  assert.ok(/branch/i.test(out), 'no branch named');
});

test('reports uncommitted files and remote position', () => {
  assert.ok(/Uncommitted:/.test(out), 'no "Uncommitted:" line');
  assert.ok(/Remote:/.test(out), 'no "Remote:" line');
});

test('lists the latest commits', () => {
  assert.ok(/Latest commits/.test(out), 'no "Latest commits" section');
});

test('lists commits since STATUS.md was last touched, with titles not just a count', () => {
  assert.ok(/Since STATUS\.md was last updated/.test(out), 'no "Since STATUS.md" section');
});

test('compares the cache-buster against app.js', () => {
  assert.ok(/Cache-buster/.test(out), 'no "Cache-buster" section');
});

test('never claims a record count it could not measure', () => {
  const dataDir = path.join(ROOT, 'attendance-server', 'backend', 'data');
  if (fs.existsSync(dataDir)) {
    assert.ok(/Data files/.test(out), 'data/ exists here but no "Data files" section');
  } else {
    assert.ok(/NOT measured/.test(out), 'data/ is absent here and the report did not say so');
    assert.ok(!/\b\d+ records?\b/.test(out), 'printed a record count with no data folder to count');
  }
});

test('prints the other commands at the bottom so only one has to be remembered', () => {
  assert.ok(/npm run check/.test(out), 'footer does not mention `npm run check`');
  assert.ok(/npm run status/.test(out), 'footer does not mention `npm run status`');
});

console.log(`\n${passed} passed, ${process.exitCode ? 'some failed' : '0 failed'}`);
