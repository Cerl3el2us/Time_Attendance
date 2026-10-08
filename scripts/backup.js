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

const ROOT = path.join(__dirname, '..');

function git(cwd, args) {
  return spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
}
function fail(msg) { console.error(msg); process.exit(1); }

const fromArgs = process.argv.slice(2).filter(Boolean);
const fromEnv = (process.env.TA_BACKUP_DIRS || '').split(path.delimiter).filter(Boolean);
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

const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '').replace(/^(\d{8})/, '$1-');
const name = `time-attendance-${stamp}-${headSha.slice(0, 7)}.bundle`;

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
    const target = path.join(d, name);
    fs.copyFileSync(bundle, target);
    if (fs.statSync(target).size !== size) {
      fail(`${target} is ${fs.statSync(target).size} bytes, expected ${size}: the destination may be full. Remove it and retry.`);
    }
    written.push(target);
  }

  console.log(`Backed up ${headSha.slice(0, 7)} (${(size / 1024 / 1024).toFixed(2)} MiB), verified by restoring it:`);
  for (const w of written) console.log('  ' + w);
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}
