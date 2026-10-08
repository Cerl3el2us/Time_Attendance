// A frontend asset must not change without its cache-buster moving too (2026-10-08).
//
// AGENTS.md section 5 has said "bump the ?v= after any frontend edit" since the beginning, and
// section 9 lists it as a finishing step. Nothing enforced it. On 2026-10-08 alone app.js was
// edited four times and the markers had to be moved by hand all four times, with nothing to catch a
// miss -- and one of those times the bump was nearly skipped on the reasoning that "it is only a
// comment, users are not affected". The owner's rule is to bump on EVERY edit, and the reason is
// that a stale cache already cost a real debugging session on 2026-07-23: the fix was live, the
// browser was running the old file, and the hunt went looking for a bug that was not there.
//
// So this suite asks git a question no human has to remember to ask: has the asset changed since the
// last commit that moved its version marker? If it has, the marker is stale and this fails.
//
// Why git rather than a checked-in hash: a recorded hash is one more thing to update by hand, which
// is the same forgetting this test exists to stop. git already knows when each line last moved.
//
// Working-tree changes count. `git diff <sha> -- <file>` compares the commit to what is on disk, so
// this goes red while the edit is still uncommitted -- which is when it is cheap to fix.
'use strict';
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok ', name); }
  catch (e) { process.exitCode = 1; console.log('  FAIL', name, '\n      ', e.message); }
}

function git(args) {
  return spawnSync('git', ['-C', ROOT, ...args], { encoding: 'utf8' });
}

// The newest commit whose diff touched a line matching `pattern` inside `file`.
// -G takes a regex and matches added/removed lines, so a commit that edited the marker line shows up
// (both its - and its + side match), while a commit that merely left the line alone does not.
function lastCommitTouchingMarker(pattern, file) {
  const r = git(['log', '-1', '--format=%H', `-G${pattern}`, '--', file]);
  if (r.status !== 0) return null;
  return r.stdout.trim() || null;
}

// git diff exits 1 when there are differences, 0 when there are none. Anything else is git failing,
// which must not be read as "nothing changed".
function assetChangedSince(sha, file) {
  const r = git(['diff', '--quiet', sha, '--', file]);
  if (r.status === 0) return false;
  if (r.status === 1) return true;
  throw new Error(`git diff failed for ${file}: ${(r.stderr || '').trim()}`);
}

// Each asset, and the marker that has to move whenever that asset does.
// The three ?v= strings are the ones AGENTS.md section 5 lists; APP_BUILD is the number shown in the
// UI, which drifted to 10 commits stale before anyone noticed.
const GUARDED = [
  {
    asset: 'attendance/js/app.js',
    markerFile: 'attendance/js/app.js',
    markerPattern: 'const APP_BUILD',
    fix: 'bump the number in `const APP_BUILD = N;` (attendance/js/app.js)',
  },
  {
    asset: 'attendance/js/app.js',
    markerFile: 'attendance/index.html',
    markerPattern: 'js/app\\.js\\?v=',
    fix: 'bump `<script src="js/app.js?v=...">` in attendance/index.html',
  },
  {
    asset: 'attendance/css/style.css',
    markerFile: 'attendance/index.html',
    markerPattern: 'css/style\\.css\\?v=',
    fix: 'bump `<link href="css/style.css?v=...">` in attendance/index.html',
  },
  {
    asset: 'attendance/lang/ja.js',
    markerFile: 'attendance/index.html',
    markerPattern: 'lang/ja\\.js\\?v=',
    fix: 'bump `<script src="lang/ja.js?v=...">` in attendance/index.html',
  },
];

console.log('Cache-buster guard: every frontend asset must move its marker when it changes');

// A checkout with no git history cannot answer the question. Say so and fail, rather than printing a
// green line that means nothing -- a guard that silently passes when it cannot check is worse than
// no guard, because it is trusted.
const inRepo = git(['rev-parse', '--is-inside-work-tree']).stdout.trim() === 'true';

test('git history is available to check against', () => {
  assert.ok(inRepo, 'not a git checkout -- this guard cannot run, and must not be read as passing');
});

if (inRepo) {
  for (const g of GUARDED) {
    const name = `${g.asset} is unchanged since its marker in ${g.markerFile} last moved`;
    test(name, () => {
      const sha = lastCommitTouchingMarker(g.markerPattern, g.markerFile);
      assert.ok(sha, `no commit in history ever touched /${g.markerPattern}/ in ${g.markerFile}`);
      assert.ok(
        !assetChangedSince(sha, g.asset),
        `${g.asset} has changed since ${sha.slice(0, 7)}, the last commit that moved its marker.\n` +
        `       The browser and the service worker will keep serving the old file.\n` +
        `       Fix: ${g.fix}`
      );
    });
  }
}

console.log(`\n${passed} passed, ${process.exitCode ? 'some failed' : '0 failed'}`);
