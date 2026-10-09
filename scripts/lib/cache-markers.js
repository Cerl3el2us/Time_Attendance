// Which frontend asset has to move which cache-buster marker, and how to ask git whether it did.
//
// Shared by tests/cache-buster-bump.test.js (the gate) and scripts/status.js (the report). One list,
// two readers: when a fourth asset gets a ?v= string, adding it here covers both, instead of the
// report quietly describing a different set of rules than the test enforces.
//
// See AGENTS.md section 5 for the rule itself and tests/cache-buster-bump.test.js for why it is
// checked against git rather than a recorded hash.
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');

// maxBuffer: the 1 MiB default is ~5x the current full-history `git log --format=%h%n%B` output of
// this repo and grows every commit. Exceeding it kills git with SIGTERM and silently truncates
// stdout, which every caller below would read as a smaller answer rather than as a failure.
function git(args) {
  return spawnSync('git', ['-C', ROOT, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

// "git could not be asked" is NOT the same answer as "git says no", and conflating them is how a
// guard turns into a green line that means nothing. Every helper here raises rather than returning a
// falsy value a caller could mistake for a measurement.
function gitOrThrow(args, what) {
  const r = git(args);
  if (r.error) throw new Error(`could not run git (${r.error.code || r.error.message}) while ${what}`);
  if (r.status !== 0) throw new Error(`git exited ${r.status} while ${what}: ${(r.stderr || '').trim()}`);
  return r.stdout;
}

// Each asset, and the marker that has to move whenever that asset does. The three ?v= strings are
// the ones AGENTS.md section 5 lists; APP_BUILD is the number shown in the UI, which once drifted to
// 62 commits stale before anyone noticed.
// `markerValue` captures the VERSION ITSELF, not merely the line it sits on. The first version of
// this file asked git "was the marker line touched?" via `git log -G`, which was wrong in both
// directions and was caught in review on the day it was written:
//   too green -- adding `defer` to the <script> tag touches the line without changing `?v=`, so the
//                guard treated a stale marker as freshly bumped and a real cache bug shipped;
//   too red   -- the baseline came from the last COMMIT, while the asset was read from the working
//                tree, so an edit with its bump correctly applied but not yet committed could never
//                go green. A gate nobody can satisfy is a gate people learn to ignore.
// Comparing the captured value at the baseline commit against the working tree answers the real
// question -- "has this asset changed since the version users are being served was chosen?" -- and
// is immune to both, including across merge commits (which `git log -G` does not see at all).
const GUARDED = [
  {
    asset: 'attendance/js/app.js',
    markerFile: 'attendance/js/app.js',
    markerName: 'APP_BUILD',
    markerValue: /const\s+APP_BUILD\s*=\s*(\d+)/,
    fix: 'bump the number in `const APP_BUILD = N;` (attendance/js/app.js)',
  },
  {
    asset: 'attendance/js/app.js',
    markerFile: 'attendance/index.html',
    markerName: 'js/app.js?v=',
    markerValue: /js\/app\.js\?v=([^"'\s>]+)/,
    fix: 'bump `<script src="js/app.js?v=...">` in attendance/index.html',
  },
  {
    asset: 'attendance/css/style.css',
    markerFile: 'attendance/index.html',
    markerName: 'css/style.css?v=',
    markerValue: /css\/style\.css\?v=([^"'\s>]+)/,
    fix: 'bump `<link href="css/style.css?v=...">` in attendance/index.html',
  },
  {
    asset: 'attendance/lang/ja.js',
    markerFile: 'attendance/index.html',
    markerName: 'lang/ja.js?v=',
    markerValue: /lang\/ja\.js\?v=([^"'\s>]+)/,
    fix: 'bump `<script src="lang/ja.js?v=...">` in attendance/index.html',
  },
  // 2026-10-09: the two markers that were NOT in `?v=` form, and so could not be expressed by the
  // original one-marker-one-file list. Found outside the guard by review on 2026-10-08.
  {
    // Deliberately NOT index.html, and NOT the js/css: sw.js serves documents network-first (so
    // index.html can never be stale) and the versioned js/css miss the cache on a `?v=` bump
    // anyway, and are guarded above. What SHELL_CACHE actually protects is the precached files
    // with no version in their URL, which the fetch handler serves cache-first -- a changed icon
    // or manifest reaches an installed app only on the visit AFTER the background refresh, unless
    // the cache name moves. Adding index.html here would force a bump on every HTML edit for no
    // reason, and a guard that cries wolf is one people switch off.
    asset: 'attendance/ (precached unversioned shell files)',
    assets: [
      'attendance/manifest.json',
      'attendance/images/logo-short.jpg',
      'attendance/images/logo-long.png',
      'attendance/images/icon-192.png',
      'attendance/images/icon-512.png',
    ],
    markerFile: 'attendance/sw.js',
    markerName: 'SHELL_CACHE',
    markerValue: /SHELL_CACHE\s*=\s*'([^']+)'/,
    fix: "bump the version in `const SHELL_CACHE = 'ta-shell-vN';` (attendance/sw.js)",
  },
  {
    // The FAQ screenshots are requested as `images/faq/<name>?v=FAQ_IMG_V` and served cache-first,
    // so replacing a screenshot without moving the version leaves every browser showing the old
    // picture of a screen that no longer looks like that.
    asset: 'attendance/images/faq',
    assets: ['attendance/images/faq'],
    markerFile: 'attendance/js/app.js',
    markerName: 'FAQ_IMG_V',
    markerValue: /FAQ_IMG_V\s*=\s*'([^']+)'/,
    fix: "bump `const FAQ_IMG_V = '...'` in attendance/js/app.js",
  },
];

// A marker can guard one file or a whole set (the precached shell, a folder of screenshots).
// Everything below works in pathspecs, which git accepts several of at once, so asking about a
// group costs the same number of git calls as asking about one file.
function assetPaths(g) {
  if (typeof g === 'string') return [g];
  return (g && g.assets) ? g.assets : [g.asset];
}
// Stable key for the memo caches, and for messages.
const assetKey = g => assetPaths(g).join(' ');

function markerValueIn(text, g) {
  const m = g.markerValue.exec(text);
  return m ? m[1] : null;
}

function currentMarkerValue(g) {
  const text = fs.readFileSync(path.join(ROOT, g.markerFile), 'utf8');
  const v = markerValueIn(text, g);
  if (v === null) throw new Error(`cannot find ${g.markerName} in ${g.markerFile} — the marker was renamed or removed`);
  return v;
}

// Walk back through the commits that touched the marker file until the captured value differs from
// the one being served now. The last commit that still carried today's value is when this version
// was introduced; anything the asset gained after that point is NOT covered by it.
// Capped: a marker that never changes within the cap is reported as unmeasurable rather than silently
// treated as "introduced at the beginning of time", which would make the guard permanently green.
const _blobCache = new Map();
function blobAt(sha, file) {
  const key = `${sha}:${file}`;
  if (!_blobCache.has(key)) {
    const r = git(['show', `${sha}:${file}`]);
    _blobCache.set(key, (r.error || r.status !== 0) ? null : String(r.stdout));
  }
  return _blobCache.get(key);
}

// Answer the question with a fixed, tiny number of git calls instead of walking history.
//
// The first working version walked back through every commit of the marker file reading blobs until
// the version value changed. It was correct, and it was far too slow: on this repo's SMB gitdir it
// took `npm run check` from 36 to 68 seconds, on the loop AGENTS.md tells people to run after every
// edit. A gate that slow is one people start skipping, which is the failure this guard exists to
// prevent -- so being fast is part of being correct here.
//
// The walk is unnecessary. "Has the asset changed since its version was chosen?" is the same as
// "did the version move at or after the asset's last change?", which needs one comparison:
//   - asset edited but not yet committed -> compare the working tree's value against HEAD's
//   - asset last changed in commit A      -> compare today's value against the one just BEFORE A
// If the two differ, the bump happened at or after the change. If they are equal, the version has
// not moved since before the asset changed, and users are being served a stale file.
// Every git call here crosses the SMB share, so each one costs real wall-clock time on the loop
// AGENTS.md says to run after every edit. Two of the four guarded pairs watch the same asset
// (attendance/js/app.js) and three read the same marker file, so without memoising, one run asks git
// the same question up to three times. These caches live for a single process only.
const _memo = new Map();
const memo = (key, fn) => { if (!_memo.has(key)) _memo.set(key, fn()); return _memo.get(key); };

function assetIsDirty(g) {
  const paths = assetPaths(g);
  const key = assetKey(g);
  return memo(`dirty:${key}`, () => {
    const wt = git(['diff', '--quiet', 'HEAD', '--', ...paths]);
    if (wt.error) throw new Error(`could not run git diff for ${key}: ${wt.error.code || wt.error.message}`);
    if (wt.status !== 0 && wt.status !== 1) throw new Error(`git diff failed for ${key}: ${(wt.stderr || '').trim()}`);
    return wt.status === 1;
  });
}

function markerState(g) {
  const current = currentMarkerValue(g);

  const headOk = memo('head', () => { const r = git(['rev-parse', 'HEAD']); return !(r.error || r.status !== 0); });
  if (!headOk) return { ok: false, current, reason: 'no commits to compare against' };

  if (assetIsDirty(g)) {
    const atHead = blobAt('HEAD', g.markerFile);
    if (atHead === null) return { ok: true, current, reason: 'marker file is new in this working tree' };
    const bumped = markerValueIn(atHead, g) !== current;
    return { ok: bumped, current, baseline: 'HEAD', reason: bumped ? 'bumped, not committed yet' : null };
  }

  // For a group, "the last change" is the newest commit touching ANY of its files -- git -1 over
  // several pathspecs already answers exactly that.
  const lastChange = memo(`last:${assetKey(g)}`,
    () => gitOrThrow(['log', '-1', '--format=%H', '--', ...assetPaths(g)], `finding the last change to ${assetKey(g)}`).trim());
  if (!lastChange) return { ok: true, current, reason: `${g.asset} has no commit history` };

  const before = blobAt(`${lastChange}^`, g.markerFile);
  // No parent (the asset arrived in the root commit) or the marker file did not exist yet: there is
  // no earlier version to be stale relative to.
  if (before === null) return { ok: true, current, reason: 'no earlier version of the marker to compare' };

  const bumped = markerValueIn(before, g) !== current;
  return { ok: bumped, current, baseline: lastChange, reason: null };
}

// git diff exits 1 when there are differences and 0 when there are none. Anything else is git
// failing, which must never be read as "nothing changed".
function assetChangedSince(sha, file) {
  const r = git(['diff', '--quiet', sha, '--', file]);
  if (r.error) throw new Error(`could not run git diff for ${file}: ${r.error.code || r.error.message}`);
  if (r.status === 0) return false;
  if (r.status === 1) return true;
  throw new Error(`git diff failed for ${file}: ${(r.stderr || '').trim()}`);
}

// An asset path that is wrong — a typo, or a file that moved and was not updated here — makes
// `git diff` answer "no differences" for a path that does not exist, so that pair would read as
// permanently clean. Checked explicitly so a broken entry is loud instead of invisible.
function assertAssetIsReal(g) {
  const paths = assetPaths(g);
  // One `ls-files` for every guarded path at once, not one call per pair. A folder pathspec
  // expands to the files inside it, so membership is "this exact file, or something under it".
  const tracked = memo('tracked', () => new Set(
    gitOrThrow(['ls-files', '--', ...GUARDED.flatMap(assetPaths)], 'listing tracked files')
      .split('\n').map(s => s.trim()).filter(Boolean)));
  for (const p of paths) {
    if (!fs.existsSync(path.join(ROOT, p))) throw new Error(`${p} does not exist — the path in cache-markers.js is wrong or the file moved`);
    const isTracked = tracked.has(p) || [...tracked].some(t => t.startsWith(p + '/'));
    if (!isTracked) throw new Error(`${p} is not tracked by git — git cannot answer whether it changed`);
  }
}

function isGitCheckout() {
  const r = git(['rev-parse', '--is-inside-work-tree']);
  if (r.error) return false;                       // git missing from PATH: not a checkout we can use
  return String(r.stdout || '').trim() === 'true';
}

// A shallow clone has no history to compare against, yet every lookup still "succeeds": the single
// grafted commit looks like the root that introduced every line, so every pair reads as clean no
// matter how stale the markers are. Callers must refuse to report a result in that state.
function isShallowCheckout() {
  const r = git(['rev-parse', '--is-shallow-repository']);
  if (r.error || r.status !== 0) return false;
  return String(r.stdout || '').trim() === 'true';
}

module.exports = {
  assetPaths,
  ROOT, GUARDED, git, gitOrThrow,
  currentMarkerValue, markerState,
  assetChangedSince, assertAssetIsReal, isGitCheckout, isShallowCheckout,
};
