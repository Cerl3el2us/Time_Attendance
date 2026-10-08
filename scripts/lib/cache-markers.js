// Which frontend asset has to move which cache-buster marker, and how to ask git whether it did.
//
// Shared by tests/cache-buster-bump.test.js (the gate) and scripts/status.js (the report). One list,
// two readers: when a fourth asset gets a ?v= string, adding it here covers both, instead of the
// report quietly describing a different set of rules than the test enforces.
//
// See AGENTS.md section 5 for the rule itself and tests/cache-buster-bump.test.js for why it is
// checked against git rather than a recorded hash.
'use strict';
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');

function git(args) {
  return spawnSync('git', ['-C', ROOT, ...args], { encoding: 'utf8' });
}

// Each asset, and the marker that has to move whenever that asset does. The three ?v= strings are
// the ones AGENTS.md section 5 lists; APP_BUILD is the number shown in the UI, which once drifted to
// 62 commits stale before anyone noticed.
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

// The newest commit whose diff touched a line matching `pattern` inside `file`. -G matches
// added/removed lines, so a commit that edited the marker line shows up while one that merely left
// the line alone does not.
function lastCommitTouchingMarker(pattern, file) {
  const r = git(['log', '-1', '--format=%H', `-G${pattern}`, '--', file]);
  if (r.status !== 0) return null;
  return r.stdout.trim() || null;
}

// git diff exits 1 when there are differences and 0 when there are none. Anything else is git
// failing, which must never be read as "nothing changed".
function assetChangedSince(sha, file) {
  const r = git(['diff', '--quiet', sha, '--', file]);
  if (r.status === 0) return false;
  if (r.status === 1) return true;
  throw new Error(`git diff failed for ${file}: ${(r.stderr || '').trim()}`);
}

function isGitCheckout() {
  return git(['rev-parse', '--is-inside-work-tree']).stdout.trim() === 'true';
}

module.exports = { ROOT, GUARDED, git, lastCommitTouchingMarker, assetChangedSince, isGitCheckout };
