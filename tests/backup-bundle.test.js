// `npm run backup` writes a git bundle and proves it can be restored (2026-10-08).
//
// Spec: Z:\claude_memory\plans\2026-10-02-cross-machine-state-design.md sections 4.4 and 8.1. A backup
// nobody has restored is a hope, not a backup, so the tool does not stop at writing the file: it runs
// `git bundle verify` and clones from the bundle, and only then says it worked. This test checks that
// the clone really lands on the same commit as the repository it came from.
//
// Where the bundle goes is the OWNER's decision (spec section 9.2 -- "not the NAS, and not a single
// machine on its own"), and nobody has made it yet. So the tool has no default destination: it takes
// folders as arguments or from TA_BACKUP_DIRS, and with neither it refuses and says why, instead of
// quietly writing somewhere the owner never chose. A destination folder that does not exist is also a
// refusal, not a mkdir -- a typo in a drive letter must not create a folder on the wrong disk and
// report success.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'backup.js');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok ', name); }
  catch (e) { process.exitCode = 1; console.log('  FAIL', name, '\n      ', e.message); }
}

function runBackup(args, env) {
  if (!fs.existsSync(SCRIPT)) return { status: -1, stdout: '', stderr: 'scripts/backup.js is missing' };
  const cleanEnv = { ...process.env, TA_BACKUP_DIRS: '' };
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8', cwd: ROOT, env: { ...cleanEnv, ...(env || {}) },
  });
}
const git = (cwd, args) => spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ta-backup-test-'));

// Bundling this repository takes ~45 seconds because the gitdir lives on the SMB share, and the
// cases below build three bundles. In `npm run check` -- which AGENTS.md says to run after EVERY edit
// -- that is two and a half minutes added to a loop people have to use constantly, and a slow gate is
// one people start skipping. So the slow cases are opt-in: `npm run test:backup`.
//
// They are SKIPPED LOUDLY, never quietly passed: the count below says how many did not run, so a
// green line can never be mistaken for a restore that was actually proven. The refusal cases stay in
// the default suite because they create no bundle and cost nothing -- and `npm run backup` itself
// clones from every bundle it writes, so the restore is proven on each real use regardless.
// A flag, not an env var: `npm run test:backup` has to work the same in cmd, PowerShell and bash, and
// setting an env var inline in an npm script is written three different ways across those three.
const SLOW = process.argv.includes('--slow') || process.env.TA_SLOW_TESTS === '1';
let skipped = 0;
function slowTest(name, fn) {
  if (!SLOW) { skipped++; console.log('  SKIP', name, '(slow: ~45s, run `npm run test:backup`)'); return; }
  test(name, fn);
}

console.log('backup: writes a bundle and proves it restores');

test('the script exists', () => {
  assert.ok(fs.existsSync(SCRIPT), 'scripts/backup.js is missing');
});

test('refuses to run with no destination, and says why', () => {
  const r = runBackup([]);
  assert.notStrictEqual(r.status, 0, 'exited 0 with nowhere to write -- it must not pretend it backed up');
  assert.ok(/destination/i.test(r.stdout + r.stderr), 'no explanation of what is missing');
});

test('refuses a destination folder that does not exist (no mkdir on a typo)', () => {
  const nowhere = path.join(os.tmpdir(), 'ta-backup-does-not-exist-' + Date.now());
  const r = runBackup([nowhere]);
  assert.notStrictEqual(r.status, 0, 'exited 0 for a folder that is not there');
  // A bare non-zero exit is not enough: a missing script exits non-zero too, which would let this pass
  // with the feature absent. It has to refuse FOR THIS REASON.
  assert.ok(/does not exist/i.test(r.stdout + r.stderr), 'refused, but not because the folder is missing');
  assert.ok(!fs.existsSync(nowhere), 'created the missing folder instead of refusing');
});

slowTest('writes a bundle that restores to the same commit', () => {
  const dest = tmp();
  try {
    const r = runBackup([dest]);
    assert.strictEqual(r.status, 0, `exit ${r.status}: ${r.stdout}${r.stderr}`);
    const bundles = fs.readdirSync(dest).filter(f => f.endsWith('.bundle'));
    assert.strictEqual(bundles.length, 1, `expected one .bundle in ${dest}, found ${bundles.length}`);

    const restore = path.join(dest, 'restored');
    const c = spawnSync('git', ['clone', '-q', path.join(dest, bundles[0]), restore], { encoding: 'utf8' });
    assert.strictEqual(c.status, 0, 'git could not clone from the bundle: ' + c.stderr);

    const original = git(ROOT, ['rev-parse', 'HEAD']).stdout.trim();
    const restored = git(restore, ['rev-parse', 'HEAD']).stdout.trim();
    assert.ok(original, 'could not read HEAD of the source repo');
    assert.strictEqual(restored, original, 'the restored repository is not at the same commit as the source');
  } finally {
    fs.rmSync(dest, { recursive: true, force: true });
  }
});

slowTest('writes to every destination given, not just the first', () => {
  const a = tmp(), b = tmp();
  try {
    const r = runBackup([a, b]);
    assert.strictEqual(r.status, 0, `exit ${r.status}: ${r.stdout}${r.stderr}`);
    for (const d of [a, b]) {
      assert.ok(fs.readdirSync(d).some(f => f.endsWith('.bundle')), `no bundle in ${d}`);
    }
  } finally {
    fs.rmSync(a, { recursive: true, force: true });
    fs.rmSync(b, { recursive: true, force: true });
  }
});

slowTest('reads destinations from TA_BACKUP_DIRS when none are passed', () => {
  const d = tmp();
  try {
    const r = runBackup([], { TA_BACKUP_DIRS: d });
    assert.strictEqual(r.status, 0, `exit ${r.status}: ${r.stdout}${r.stderr}`);
    assert.ok(fs.readdirSync(d).some(f => f.endsWith('.bundle')), 'no bundle written from the env var');
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

console.log(`\n${passed} passed, ${process.exitCode ? 'some failed' : '0 failed'}` +
  (skipped ? `, ${skipped} SKIPPED -- the restore is NOT proven here, run \`npm run test:backup\`` : ''));
