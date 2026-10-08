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
const assert = require('assert');
// One list of what-moves-what, shared with `npm run status` so the report cannot describe different
// rules than this gate enforces. Edit scripts/lib/cache-markers.js to add an asset.
const { GUARDED, lastCommitTouchingMarker, assetChangedSince, isGitCheckout } = require('../scripts/lib/cache-markers');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok ', name); }
  catch (e) { process.exitCode = 1; console.log('  FAIL', name, '\n      ', e.message); }
}

console.log('Cache-buster guard: every frontend asset must move its marker when it changes');

// A checkout with no git history cannot answer the question. Say so and fail, rather than printing a
// green line that means nothing -- a guard that silently passes when it cannot check is worse than
// no guard, because it is trusted.
const inRepo = isGitCheckout();

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
