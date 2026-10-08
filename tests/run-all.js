#!/usr/bin/env node
// Runs every tests/*.test.js in its own process and prints one summary line at the end.
// Each test file sets process.exitCode on failure, so a non-zero exit is the failure signal.
const { readdirSync } = require('fs');
const { join } = require('path');
const { spawnSync } = require('child_process');

const dir = __dirname;
const files = readdirSync(dir).filter(f => f.endsWith('.test.js')).sort();
const failed = [];

for (const f of files) {
  // Forward our own arguments so `npm test -- --slow` reaches the files that honour a flag.
  // Without this, tests/backup-bundle.test.js could only run its slow cases through a second,
  // separate command nobody is told to run -- the same "remember an extra step" failure the
  // cache-buster guard exists to remove.
  const r = spawnSync(process.execPath, [join(dir, f), ...process.argv.slice(2)], { stdio: 'inherit' });
  if (r.status !== 0) failed.push(f);
}

console.log(`\n=== ${files.length - failed.length}/${files.length} test files passed ===`);
if (failed.length) {
  console.log(`FAILED: ${failed.join(', ')}`);
  process.exitCode = 1;
}
