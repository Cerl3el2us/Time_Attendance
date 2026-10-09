// Naming a backup bundle so a new one can never replace an older one (2026-10-09).
//
// scripts/backup.js used to build the name from the clock truncated to the MINUTE plus the short
// HEAD sha, then fs.copyFileSync() it into each destination. Two runs in the same minute at the
// same commit produced the same path, and copyFileSync overwrites in silence -- while the script
// printed the same "Backed up ..., verified by cloning" both times. The run most likely to collide
// is the one someone starts because they are not sure the first worked.
//
// tests/backup-name.test.js covers this without touching git or the disk.
'use strict';
const path = require('path');
const fs = require('fs');

// How many suffixed names to try before giving up. Past this something is wrong with the
// destination, and inventing a 101st name would hide it.
const MAX_ATTEMPTS = 100;

// 2026-10-09T14:05:07Z -> "20261009-140507". Seconds are included so an ordinary repeat already
// differs by name; pickFreeName() is what actually guarantees it.
function bundleBaseName(date, headSha) {
  const iso = date.toISOString();
  const stamp = iso.slice(0, 19).replace(/[-:]/g, '').replace('T', '-');
  return `time-attendance-${stamp}-${String(headSha).slice(0, 7)}.bundle`;
}

// Returns a name free in EVERY destination. One backup keeps one name everywhere -- choosing per
// destination would write the same bundle under two names and leave nobody able to tell they are
// the same backup. `exists` is injectable so the test does not need real files.
function pickFreeName(baseName, dests, exists) {
  const taken = exists || (p => fs.existsSync(p));
  const free = n => !dests.some(d => taken(path.resolve(d, n)));
  if (free(baseName)) return baseName;
  for (let i = 2; i <= MAX_ATTEMPTS; i++) {
    const candidate = baseName.replace(/\.bundle$/, `-${i}.bundle`);
    if (free(candidate)) return candidate;
  }
  throw new Error(
    `${MAX_ATTEMPTS} names starting from ${baseName} are already taken in the destination(s). ` +
    'Refusing to overwrite an existing backup -- check the destination folder.');
}

module.exports = { bundleBaseName, pickFreeName, MAX_ATTEMPTS };
