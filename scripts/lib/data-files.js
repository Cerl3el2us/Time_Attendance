// Describing attendance-server/backend/data for `npm run status` (2026-10-09).
//
// Why this is its own module and not a loop inside status.js: on Z: the live backend writes these
// files continuously, and atomicWrite() replaces a file through a temp name. status.js used to
// call fs.readdirSync() and then fs.statSync() on each name with only JSON.parse() guarded, so a
// file that existed at listing time and was gone a moment later threw out of the loop and took
// the whole report down -- including every section printed after it. A status tool that dies
// mid-report is worse than one that reports a gap: the sections it never reached look like
// "nothing to say" rather than "not measured".
//
// Rule here: one file can only ever cost you that one file's line. Nothing throws.
// tests/status-data-files.test.js covers the race directly by naming a file that is not there.
'use strict';
const fs = require('fs');
const path = require('path');

// `names` exists so a caller -- and the test -- can supply the listing instead of reading it.
// Passing a name that no longer exists is exactly the race this module is here for.
function describeDataFiles(dir, names) {
  let list = names;
  if (!list) {
    try {
      list = fs.readdirSync(dir);
    } catch (e) {
      return [`  the directory could not be listed: ${e.message}`];
    }
  }
  const jsonNames = list.filter(n => n.endsWith('.json')).sort();
  if (jsonNames.length === 0) return ['  no .json files here'];
  return jsonNames.map(f => describeOne(dir, f));
}

function describeOne(dir, f) {
  const full = path.join(dir, f);
  let count = '?';
  try {
    const j = JSON.parse(fs.readFileSync(full, 'utf8'));
    count = Array.isArray(j) ? `${j.length} records` : `${Object.keys(j).length} top-level keys`;
  } catch (e) {
    // ENOENT here means the backend replaced or removed the file while we were reading it. Say so
    // in those words: "unreadable" would send someone looking for corruption that is not there.
    if (e && e.code === 'ENOENT') return `  ${f}: vanished while reading (the backend was writing)`;
    count = 'unreadable';
  }
  let when = 'mtime unavailable';
  try {
    when = `modified ${fs.statSync(full).mtime.toISOString().slice(0, 16).replace('T', ' ')}`;
  } catch (e) {
    if (e && e.code === 'ENOENT') return `  ${f}: ${count}, then vanished (the backend was writing)`;
  }
  return `  ${f}: ${count}, ${when}`;
}

module.exports = { describeDataFiles };
