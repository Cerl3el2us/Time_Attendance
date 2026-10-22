// Upcountry: reading back where the day went (2026-10-22, owner).
//
// The stops (time + place, up to 6) are collected when the request is filed, but once it was
// approved the employee had nowhere to see them again: the 🗺️ icon on the timetable row was a
// plain <span> whose tooltip said only "Upcountry". The owner asked for the icon to open the list.
//
// The rules pinned down here, because each one is a way the feature could mislead:
//   - only an APPROVED upcountry request for THAT person on THAT date is read. A pending or
//     rejected request must not describe a day the company never agreed to;
//   - a request with no usable stop yields nothing, and that is what keeps the icon un-clickable:
//     a press that opens an empty box is worse than no press at all;
//   - a record from before the structured stops (one free-text `reason`) still reads back, because
//     those records exist in production.
//
// The decision block for the icon is extracted from app.js and executed with stub renderers, so
// this asserts behaviour -- which markup the row gets -- rather than matching source text.
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const APP_SRC = fs.readFileSync(path.join(ROOT, 'attendance/js/app.js'), 'utf8');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok ', name); }
  catch (e) { process.exitCode = 1; console.log('  FAIL', name, '\n      ', e.message); }
}

function topLevelFn(src, name) {
  const a = src.indexOf('function ' + name + '(');
  assert.ok(a > 0, 'function ' + name + ' not found in app.js');
  const b = src.indexOf('\n}', a);
  assert.ok(b > a, 'end of ' + name + ' not found');
  return src.slice(a, b + 2);
}
function between(src, startMarker, endMarker) {
  const a = src.indexOf(startMarker);
  assert.ok(a > 0, 'not found: ' + startMarker);
  const b = src.indexOf(endMarker, a);
  assert.ok(b > a, 'end not found: ' + endMarker);
  return src.slice(a, b + endMarker.length);
}

// The icon decision, lifted out of the attendance-row renderer and wrapped in a function of its
// three inputs. `upcountryBadge` is what the row ends up printing.
const BADGE_SNIPPET = between(
  APP_SRC,
  "    const upcountryShown = canUpcountryTarget && row.upcountry && row.status !== 'company-trip';",
  "        : attAllowIcon('🗺️', L('Upcountry', 'Upcountry'));");

function makeSandbox(leaves) {
  const ctx = {
    DATA_LEAVES: leaves,
    currentLang: 'en',
    L: (en) => en,
    escapeHtml: (s) => String(s == null ? '' : s),
    attAllowIcon: (emoji) => 'PLAIN:' + emoji,
    attAllowIconButton: (emoji, title, onclick) => 'CLICKABLE:' + emoji + '|' + onclick,
  };
  vm.createContext(ctx);
  vm.runInContext(
    topLevelFn(APP_SRC, 'upcountryLocationsOf')
    + topLevelFn(APP_SRC, 'upcountryDayRecord')
    + topLevelFn(APP_SRC, 'upcountryDayStops')
    + 'function badgeFor(canUpcountryTarget, row, targetUserId) {\n'
    + BADGE_SNIPPET + '\n'
    + '  return upcountryBadge;\n}',
    ctx);
  return ctx;
}

const APPROVED = {
  id: 1, userId: 7, type: 'upcountry', status: 'approved', dateFrom: '2026-10-20', dateTo: '2026-10-20',
  locations: [
    { time: '08:30', name: 'ลูกค้า A ระยอง' },
    { time: '', name: 'ลูกค้า B' },
    { time: '15:00', name: '' },
  ],
};
const ROW = { date: '2026-10-20', upcountry: true, status: 'present' };

test('an approved request for that person and date gives its stops, dropping nameless entries', () => {
  const s = makeSandbox([APPROVED]);
  const stops = s.upcountryDayStops(7, '2026-10-20');
  assert.deepStrictEqual(stops.map(x => x.name), ['ลูกค้า A ระยอง', 'ลูกค้า B']);
  assert.strictEqual(stops[0].time, '08:30');
  assert.strictEqual(stops[1].time, '');
});

// Values that come back from the sandbox are built with the vm context's own Object/Array, so
// assert.deepStrictEqual() refuses them on the prototype check alone, whatever they contain.
// Lengths and fields are compared instead -- never deepStrictEqual across the two realms.
test('a request that is not approved never describes the day', () => {
  for (const status of ['pending', 'pending-md', 'rejected', 'cancelled', 'revoked']) {
    const s = makeSandbox([{ ...APPROVED, status }]);
    assert.strictEqual(s.upcountryDayStops(7, '2026-10-20').length, 0, status + ' leaked its stops');
  }
});

test('another person or another date gives nothing', () => {
  const s = makeSandbox([APPROVED]);
  assert.strictEqual(s.upcountryDayStops(8, '2026-10-20').length, 0);
  assert.strictEqual(s.upcountryDayStops(7, '2026-10-21').length, 0);
  // the id may arrive as a string from a dataset attribute; it must still match
  assert.strictEqual(s.upcountryDayStops('7', '2026-10-20').length, 2);
});

test('a record from before the structured stops still reads back', () => {
  const legacy = { id: 2, userId: 7, type: 'upcountry', status: 'approved', dateFrom: '2026-10-20',
    reason: 'ไปส่งของที่ชลบุรี' };
  const s = makeSandbox([legacy]);
  const stops = s.upcountryDayStops(7, '2026-10-20');
  assert.strictEqual(stops.length, 1);
  assert.strictEqual(stops[0].name, 'ไปส่งของที่ชลบุรี');
  assert.strictEqual(stops[0].time, '');
});

test('a request with nothing usable in it gives nothing', () => {
  for (const rec of [
    { ...APPROVED, locations: [] },
    { ...APPROVED, locations: [{ time: '09:00', name: '' }, { time: '', name: '   ' }] },
    { ...APPROVED, locations: undefined, reason: '' },
  ]) {
    const s = makeSandbox([rec]);
    const stops = s.upcountryDayStops(7, '2026-10-20');
    assert.strictEqual(stops.filter(x => x && String(x.name).trim()).length, 0, JSON.stringify(stops));
  }
});

test('the icon is clickable only when there is something to open', () => {
  const withStops = makeSandbox([APPROVED]);
  const clickable = withStops.badgeFor(true, ROW, 7);
  assert.ok(clickable.startsWith('CLICKABLE:🗺️'), clickable);
  assert.ok(clickable.includes("openUpcountryDayModal(7, '2026-10-20')"), clickable);

  // the same row, with the stops left empty -> the old plain icon, no click
  const noStops = makeSandbox([{ ...APPROVED, locations: [] }]);
  assert.strictEqual(noStops.badgeFor(true, ROW, 7), 'PLAIN:🗺️');

  // no approved request at all -> still the plain icon (the row says upcountry for its own reasons)
  const none = makeSandbox([]);
  assert.strictEqual(none.badgeFor(true, ROW, 7), 'PLAIN:🗺️');
});

test('the icon is absent exactly where it was absent before this change', () => {
  const s = makeSandbox([APPROVED]);
  assert.strictEqual(s.badgeFor(false, ROW, 7), '', 'a viewer without the right must see no icon');
  assert.strictEqual(s.badgeFor(true, { ...ROW, upcountry: false }, 7), '');
  assert.strictEqual(s.badgeFor(true, { ...ROW, status: 'company-trip' }, 7), '');
});

console.log(`upcountry-day-view: ${passed} passed`);
