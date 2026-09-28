// Emoji the users' font cannot draw (2026-09-28).
//
// The UI leans on emoji as icons. A codepoint the operating system has no glyph for renders as an
// empty box, and nothing anywhere reports it: the code is valid, the tests pass, the page loads —
// the user simply sees ⬜ where an icon should be. Two got in that way and were only caught by
// looking at a screenshot: the Excused Attendance icon and the ID-card field icon.
//
// Windows 10, which every employee here uses, ships Segoe UI Emoji without the Unicode 13/14
// additions (2020-2021). This file blocks the ones proven missing from coming back.
//
// HOW TO CHECK A NEW EMOJI before using it (run in the browser console on the live app):
//
//   const draw = ch => { const c = document.createElement('canvas'); c.width = c.height = 48;
//     const x = c.getContext('2d'); x.font = '32px sans-serif'; x.textBaseline = 'top';
//     x.fillText(ch, 4, 4); return x.getImageData(0,0,48,48).data; };
//   const ink = d => { let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 20) n++; return n; };
//   ink(draw('YOUR_EMOJI')) === ink(draw('￿'))   // true  -> no glyph, do not use it
//
// Measuring text width alone is NOT enough -- a plain '✓' happens to have the same advance width as
// the box and looks like a false alarm.
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const FILES = ['attendance/index.html', 'attendance/js/app.js', 'attendance/lang/ja.js'];

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok ', name); }
  catch (e) { process.exitCode = 1; console.log('  FAIL', name, '\n      ', e.message); }
}

// Verified against the real font on a Windows 10 machine: each of these draws pixel-for-pixel
// identical to U+FFFF, the "no glyph" box.
const NO_GLYPH = [
  { ch: '\u{1F6DF}', name: 'ring buoy (U+1F6DF, Unicode 14.0)', use: 'was the Excused Attendance icon; use ⛑️' },
  { ch: '\u{1FAAA}', name: 'identification card (U+1FAAA, Unicode 14.0)', use: 'was the ID-card field icon; use 🆔' },
];

console.log('UI glyphs — emoji the users\' font cannot draw');

NO_GLYPH.forEach(({ ch, name, use }) => {
  test(`${name} appears nowhere in the UI`, () => {
    const hits = [];
    FILES.forEach(rel => {
      const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
      src.split('\n').forEach((line, i) => {
        if (line.includes(ch)) hits.push(`${rel}:${i + 1}`);
      });
    });
    assert.strictEqual(hits.length, 0,
      `renders as an empty box for every user — ${use}\n      found at: ${hits.join(', ')}`);
  });
});

console.log(`\n${passed} passed`);
