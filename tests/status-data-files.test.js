// `npm run status` must not die halfway through because a data file moved under it (2026-10-09).
//
// Found by review on 2026-10-08, fixed here. status.js listed attendance-server/backend/data by
// calling fs.readdirSync() and then fs.statSync() on each name, with only JSON.parse() inside a
// try. That is a race, and the one machine where it matters is the one where it will happen:
// on Z: the live backend writes those files continuously through atomicWrite(), which replaces a
// file via a temp name. A file present at readdir time and gone at stat time threw out of the
// loop and killed the whole report -- including the sections printed AFTER it.
//
// A status tool that dies while reporting is worse than one that reports a gap: the person running
// it is trying to find out what is going on, and gets a stack trace plus a truncated report whose
// missing sections look like "nothing to say".
//
// So: every file is described independently, a file that vanishes is reported as vanished, and an
// unreadable directory is reported as unreadable. The function never throws.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const { describeDataFiles } = require('../scripts/lib/data-files');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok ', name); }
  catch (e) { process.exitCode = 1; console.log('  FAIL', name, '\n      ', e.message); }
}

function tmpdir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ta-status-'));
  return d;
}

console.log('status report: listing data files cannot crash the report');

test('counts records in an array file and keys in an object file', () => {
  const d = tmpdir();
  fs.writeFileSync(path.join(d, 'events.json'), JSON.stringify([1, 2, 3]));
  fs.writeFileSync(path.join(d, 'settings.json'), JSON.stringify({ a: 1, b: 2 }));
  const lines = describeDataFiles(d);
  assert.ok(lines.some(l => /events\.json: 3 records/.test(l)), lines.join('\n'));
  assert.ok(lines.some(l => /settings\.json: 2 top-level keys/.test(l)), lines.join('\n'));
});

test('THE BUG: a file that disappears between listing and reading does not kill the report', () => {
  const d = tmpdir();
  fs.writeFileSync(path.join(d, 'alive.json'), JSON.stringify([1]));
  // Exactly the race: the name was there at readdir time and is gone by the time we stat it.
  let lines;
  assert.doesNotThrow(() => { lines = describeDataFiles(d, ['alive.json', 'vanished.json']); },
    'the whole report died because one file moved while the backend was writing');
  assert.ok(lines.some(l => /alive\.json: 1 records/.test(l)),
    'the files that survived must still be reported');
  assert.ok(lines.some(l => /vanished\.json/.test(l) && /vanished|gone/i.test(l)),
    'the missing file must be named, not silently dropped:\n' + lines.join('\n'));
});

test('a malformed file is reported as unreadable, and the rest still counted', () => {
  const d = tmpdir();
  fs.writeFileSync(path.join(d, 'broken.json'), '{ not json');
  fs.writeFileSync(path.join(d, 'fine.json'), JSON.stringify([1, 2]));
  const lines = describeDataFiles(d);
  assert.ok(lines.some(l => /broken\.json: unreadable/.test(l)), lines.join('\n'));
  assert.ok(lines.some(l => /fine\.json: 2 records/.test(l)), lines.join('\n'));
});

test('a directory that cannot be listed is reported, not thrown', () => {
  const missing = path.join(tmpdir(), 'no-such-dir');
  let lines;
  assert.doesNotThrow(() => { lines = describeDataFiles(missing); });
  assert.ok(lines.length > 0 && /could not be listed|unreadable/i.test(lines.join('\n')),
    'an unlistable directory must say so:\n' + lines.join('\n'));
});

test('only .json files are listed', () => {
  const d = tmpdir();
  fs.writeFileSync(path.join(d, 'keep.json'), JSON.stringify([]));
  fs.writeFileSync(path.join(d, 'skip.log'), 'noise');
  const lines = describeDataFiles(d);
  assert.ok(lines.some(l => /keep\.json/.test(l)));
  assert.ok(!lines.some(l => /skip\.log/.test(l)), 'non-JSON files should not be listed');
});

// The point of the fix is that status.js uses it. A lib nobody calls fixes nothing.
test('status.js actually uses the shared helper instead of its own loop', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'status.js'), 'utf8');
  assert.ok(/describeDataFiles/.test(src), 'status.js does not call describeDataFiles()');
  assert.ok(!/fs\.statSync\(full\)/.test(src),
    'status.js still has the unguarded statSync loop this fix removed');
});

console.log(`  ${passed} passed`);
