#!/usr/bin/env node
// `npm run backup` -- write a git bundle of the whole repository and prove it restores (2026-10-08).
//
// Spec: Z:\claude_memory\plans\2026-10-02-cross-machine-state-design.md sections 4.4 and 8.1.
//
// What a bundle is for here: Hyper Backup / Synology C2 already protect the FILES (confirmed from the
// DSM screen on 2026-10-02: daily, 256 versions, ~9 months). A bundle is the git-level net -- one file
// that `git clone` can restore from, far simpler than reconstructing a git state out of a snapshot.
// Since the GitHub remote exists this is a second copy, not the only one.
//
// Where it writes is the OWNER's decision (spec section 9.2: "not the NAS, and not a single machine
// on its own") and has not been made, so there is deliberately NO default. Give folders as arguments:
//
//     npm run backup -- D:/backups E:/other-disk
//
// or set TA_BACKUP_DIRS (separated by ; on Windows, : elsewhere) and run `npm run backup` bare. With
// neither it refuses -- it never quietly writes somewhere nobody chose. A folder that does not exist
// is refused too, not created: a typo in a drive letter must not make a folder on the wrong disk and
// report success.
//
// A backup nobody has restored is a hope, not a backup. So this does not stop at writing the file:
// it runs `git bundle verify`, clones from the bundle, and checks the clone lands on the same commit.
// Only then does it say it worked.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { bundleBaseName, pickFreeName } = require('./lib/backup-name');

const ROOT = path.join(__dirname, '..');

function git(cwd, args) {
  return spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}
// Throw, do not process.exit(): `process.exit` skips `finally`, so every failure used to leave the
// temp folder behind holding a full bundle of this repo AND a full clone of it. A backup tool that
// fills up the disk it is protecting, a little more on each failed run, is its own outage.
class Refused extends Error {}
function fail(msg) { throw new Refused(msg); }

const fromArgs = process.argv.slice(2).filter(Boolean);
const fromEnv = (process.env.TA_BACKUP_DIRS || '').split(path.delimiter).filter(Boolean);
// Everything below runs inside one guard so a refusal prints its written explanation instead of a
// raw stack trace, no matter which check rejected first. The inner try/finally still owns the temp
// folder; this outer one owns how a refusal reaches the user.
function main() {
  const dests = fromArgs.length ? fromArgs : fromEnv;

  if (dests.length === 0) {
    fail([
      'No backup destination given, so nothing was written.',
      '',
      'Where bundles go is the owner\'s decision (spec 9.2: not the NAS, not one machine alone), so there',
      'is no default. Pass folders:',
      '    npm run backup -- D:/backups E:/other-disk',
      'or set TA_BACKUP_DIRS and run `npm run backup`.',
    ].join('\n'));
  }

  for (const d of dests) {
    if (!fs.existsSync(d) || !fs.statSync(d).isDirectory()) {
      fail(`Destination does not exist: ${d}\nNothing was written. Create it first, or check the path for a typo.`);
    }
  }

  const head = git(ROOT, ['rev-parse', 'HEAD']);
  if (head.status !== 0) fail('Not a git checkout, nothing to bundle: ' + (head.stderr || '').trim());
  const headSha = head.stdout.trim();

  // 2026-10-09: the name used to stop at the minute, so two runs in the same minute at the same
  // commit produced the same path and copyFileSync() overwrote the first backup without a word.
  // pickFreeName() refuses any name already present in ANY destination. See scripts/lib/backup-name.js.
  const name = pickFreeName(bundleBaseName(new Date(), headSha), dests);

  // Build once in a temp folder, verify THAT, then copy it to each destination and compare sizes --
  // so a destination that fills up halfway is caught instead of leaving a truncated file behind.
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ta-backup-'));
  try {
    const bundle = path.join(work, name);
    const made = git(ROOT, ['bundle', 'create', bundle, '--all']);
    if (made.status !== 0) fail('git bundle create failed:\n' + (made.stderr || made.stdout));

    const ver = git(ROOT, ['bundle', 'verify', bundle]);
    if (ver.status !== 0) fail('git bundle verify failed -- the file is not a usable backup:\n' + (ver.stderr || ver.stdout));

    const restore = path.join(work, 'restore');
    const clone = spawnSync('git', ['clone', '-q', bundle, restore], { encoding: 'utf8' });
    if (clone.status !== 0) fail('Could not clone from the bundle -- it does not restore:\n' + (clone.stderr || ''));
    const restored = git(restore, ['rev-parse', 'HEAD']).stdout.trim();
    if (restored !== headSha) fail(`The restored copy is at ${restored.slice(0, 7)}, not ${headSha.slice(0, 7)}. Not a usable backup.`);

    const size = fs.statSync(bundle).size;
    const written = [];
    for (const d of dests) {
      const target = path.resolve(d, name);
      try {
        // copyFileSync THROWS on a full disk or a dropped share; it does not quietly return a short
        // file. But on Windows it can leave a partial or zero-byte file behind, which would then sit
        // in the backup folder named like a good backup and fail only when someone needs it. So the
        // partial is removed before reporting, and the destinations that did succeed are named --
        // otherwise a failure on the second disk hides that the first one is fine.
        fs.copyFileSync(bundle, target);
        if (fs.statSync(target).size !== size) throw new Error(`copied ${fs.statSync(target).size} of ${size} bytes`);
        written.push(target);
      } catch (e) {
        try { fs.rmSync(target, { force: true }); } catch (_) { /* nothing usable to remove */ }
        const ok = written.length ? `\nGood copies already written:\n  ${written.join('\n  ')}` : '\nNo destination was written.';
        fail(`Could not write ${target}: ${e.message}\nThe partial file was removed.${ok}`);
      }
    }

    console.log(`Backed up ${headSha.slice(0, 7)} (${(size / 1024 / 1024).toFixed(2)} MiB).`);
    console.log('Verified by cloning the bundle and checking it restores to the same commit.');
    console.log('Written to:');
    for (const w of written) console.log('  ' + w);
    console.log('Not included: uncommitted work, and commits of other worktrees that sit on no branch.');
  } catch (e) {
    if (!(e instanceof Refused)) throw e;
    console.error(e.message);
    process.exitCode = 1;
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }

}

try {
  main();
} catch (e) {
  if (!(e instanceof Refused)) throw e;
  console.error(e.message);
  process.exitCode = 1;
}
