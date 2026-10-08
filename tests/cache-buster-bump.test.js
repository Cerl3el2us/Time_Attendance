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
// The question asked here is: has the asset changed since the version value users are being served
// was chosen? That is answered by comparing the CAPTURED VALUE at each commit, not by asking whether
// the marker's line was touched -- see the long comment on GUARDED in scripts/lib/cache-markers.js
// for the two ways the line-touched version of this got it wrong on the day it was written.
//
// Working-tree changes count, and so does an uncommitted bump: an edit with its marker already
// moved is green even before it is committed, so this gate is satisfiable at every moment of normal
// work. A gate nobody can satisfy is a gate people learn to ignore.
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { GUARDED, markerState, assertAssetIsReal, isGitCheckout, isShallowCheckout } = require('../scripts/lib/cache-markers');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok ', name); }
  catch (e) { process.exitCode = 1; console.log('  FAIL', name, '\n      ', e.message); }
}

console.log('Cache-buster guard: every frontend asset must move its marker when it changes');

// A checkout that cannot answer the question must FAIL, not pass quietly. A guard that goes green
// when it could not check is worse than no guard, because it is trusted. Three ways to be in that
// state, each of which used to read as "all clean":
//   - not a git checkout at all
//   - a shallow clone, where the one grafted commit looks like it introduced every line
//   - an empty GUARDED list, where the loop below simply runs zero times
const inRepo = isGitCheckout();

test('git history is available to check against', () => {
  assert.ok(inRepo, 'not a git checkout (or git is not on PATH) -- this guard cannot run, and must not be read as passing');
});

test('history is complete, not a shallow clone', () => {
  if (!inRepo) return;
  assert.ok(!isShallowCheckout(),
    'shallow clone: every marker would look freshly introduced, so this guard would pass no matter how stale it is. Run `git fetch --unshallow`.');
});

// Mirrors the guard in tests/inline-handlers.test.js: if the list this suite iterates ever empties,
// the loop checks nothing while still printing green.
test('the guarded list is populated and covers every asset AGENTS.md section 5 names', () => {
  const assets = new Set(GUARDED.map(g => g.asset));
  for (const required of ['attendance/js/app.js', 'attendance/css/style.css', 'attendance/lang/ja.js']) {
    assert.ok(assets.has(required), `${required} is not guarded -- AGENTS.md section 5 requires it`);
  }
  assert.ok(GUARDED.some(g => g.markerName === 'APP_BUILD'), 'APP_BUILD is not guarded');
  assert.ok(GUARDED.length >= 4, `only ${GUARDED.length} guarded pair(s) -- someone emptied the list`);
});

if (inRepo && !isShallowCheckout()) {
  for (const g of GUARDED) {
    test(`${g.asset} is unchanged since ${g.markerName} was last bumped`, () => {
      // A wrong asset path makes `git diff` report "no differences" forever, so check it is real
      // and tracked before trusting that answer.
      assertAssetIsReal(g.asset);

      const s = markerState(g);        // throws if the marker was renamed away
      assert.ok(
        s.ok,
        `${g.asset} has changed, but ${g.markerName} is still "${s.current}".\n` +
        `       The browser and the service worker will keep serving the old file.\n` +
        `       Fix: ${g.fix}`
      );
    });
  }
}

console.log(`\n${passed} passed, ${process.exitCode ? 'some failed' : '0 failed'}`);
