// A backup must never quietly replace an older backup (2026-10-09).
//
// Found by review on 2026-10-08, fixed here. scripts/backup.js named the bundle from the clock
// truncated to the MINUTE plus the short HEAD sha, then fs.copyFileSync()'d it into each
// destination. Two runs in the same minute at the same commit therefore produced the same path,
// and copyFileSync overwrites without a word. The second run printed the same confident
// "Backed up ..., verified by cloning" while destroying the first run's file.
//
// That matters most in exactly the situation backups are for: someone running it twice because
// they are not sure the first one worked, or re-running after fixing a destination path. The one
// copy they already had is the one that gets overwritten.
//
// Two changes, and the second is the one that actually guarantees it:
//   1. the stamp carries seconds, so ordinary repeats differ by name anyway;
//   2. a name that already exists in ANY destination is never reused -- the next free suffix is
//      taken instead, and one backup still lands under one name everywhere.
'use strict';
const assert = require('assert');
const path = require('path');
const { bundleBaseName, pickFreeName } = require('../scripts/lib/backup-name');

// pickFreeName() asks about path.resolve(dest, name), and on Windows that turns "/dest/a" into
// "C:\dest\a". A test that spelled the taken paths by hand with forward slashes would never match,
// and all three collision cases would go red while the code was right -- so build them the same way.
const at = (dest, name) => path.resolve(dest, name);

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok ', name); }
  catch (e) { process.exitCode = 1; console.log('  FAIL', name, '\n      ', e.message); }
}

const SHA = 'abcdef1234567890';
const AT = new Date(Date.UTC(2026, 9, 9, 14, 5, 7)); // 2026-10-09 14:05:07 UTC

console.log('backup: a new bundle never silently replaces an older one');

test('the name carries the date, the time to the second, and the commit', () => {
  const n = bundleBaseName(AT, SHA);
  assert.ok(/^time-attendance-20261009-140507-abcdef1\.bundle$/.test(n), `got ${n}`);
});

test('two runs one second apart already differ by name', () => {
  const a = bundleBaseName(AT, SHA);
  const b = bundleBaseName(new Date(AT.getTime() + 1000), SHA);
  assert.notStrictEqual(a, b);
});

test('THE BUG: a name already present in a destination is never reused', () => {
  const taken = new Set([at('/dest/a', 'time-attendance-20261009-140507-abcdef1.bundle')]);
  const picked = pickFreeName(bundleBaseName(AT, SHA), ['/dest/a'], p => taken.has(p));
  assert.notStrictEqual(picked, 'time-attendance-20261009-140507-abcdef1.bundle',
    'the existing backup would have been overwritten');
  assert.ok(/-2\.bundle$/.test(picked), `expected the next free suffix, got ${picked}`);
});

test('one backup gets ONE name across every destination', () => {
  // Free in the first destination, taken in the second: a per-destination choice would write the
  // same bundle under two different names and nobody could tell they are the same backup.
  const taken = new Set([at('/dest/b', 'time-attendance-20261009-140507-abcdef1.bundle')]);
  const picked = pickFreeName(bundleBaseName(AT, SHA), ['/dest/a', '/dest/b'], p => taken.has(p));
  assert.ok(/-2\.bundle$/.test(picked), `got ${picked}`);
});

test('it keeps counting past the first collision', () => {
  const base = bundleBaseName(AT, SHA);
  const taken = new Set([
    at('/d', base),
    at('/d', base.replace('.bundle', '-2.bundle')),
    at('/d', base.replace('.bundle', '-3.bundle')),
  ]);
  const picked = pickFreeName(base, ['/d'], p => taken.has(p));
  assert.ok(/-4\.bundle$/.test(picked), `got ${picked}`);
});

test('an untouched name is returned unchanged', () => {
  const base = bundleBaseName(AT, SHA);
  assert.strictEqual(pickFreeName(base, ['/d'], () => false), base);
});

test('it gives up loudly rather than looping forever or overwriting', () => {
  assert.throws(() => pickFreeName(bundleBaseName(AT, SHA), ['/d'], () => true),
    /\d+/, 'with every candidate taken it must throw, not return a name that exists');
});

// A helper nobody calls fixes nothing.
test('backup.js uses the helper and no longer builds its own minute-only name', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'backup.js'), 'utf8');
  assert.ok(/pickFreeName/.test(src), 'backup.js does not call pickFreeName()');
  assert.ok(!/slice\(0, 16\)/.test(src), 'backup.js still truncates the timestamp to the minute');
});

console.log(`  ${passed} passed`);
