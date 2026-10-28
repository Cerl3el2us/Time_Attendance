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
// 2026-10-28: the row gained a second way to show this icon -- a Holiday Work record whose
// location is filled in earns the Upcountry allowance too (owner: "ถ้าเกิดเขามีต่างจังหวัดต้องขึ้น
// สัญลักษณ์ upcountry ด้วย แต่อย่าคิดเงินเบิ้ล"), so the snippet now also reads hwRow, APP_SETTINGS
// and targetUser. The marker moved with it; the cases below cover BOTH ways in.
// 2026-10-28 (รีวิวรอบ 5): มาร์กเกอร์ขยับ เพราะบรรทัดนี้เลิกอ่าน `hwRow` ตรงๆ แล้วไปอ่าน
// `_hwDisp.takesDay` (คนละคำถามกับ "มีเรคอร์ดไหม" — ดูเหตุผลที่ holidayWorkDisplayFor) และเลิกใช้
// `targetUser.role` ที่ถอยไปเป็น role ของคนดูได้ มาเป็น `_attOwner`
const BADGE_SNIPPET = between(
  APP_SRC,
  "    const upcountryShown = (canUpcountryTarget && row.upcountry && row.status !== 'company-trip' && !_hwDisp.takesDay)",
  "        : attAllowIcon('🗺️', L('Upcountry', 'Upcountry'));");

// ค่าคงที่หลายบรรทัดที่ isAllowanceEligible() อ่าน — ดึงประกาศจริงออกมา ไม่พิมพ์ซ้ำในเทสต์
function constDecl(src, name) {
  const a = src.search(new RegExp('^const ' + name + ' = \\{', 'm'));
  assert.ok(a >= 0, 'const ' + name + ' not found');
  const i = src.indexOf('{', a);
  let d = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') d++;
    else if (src[j] === '}') { d--; if (!d) return src.slice(a, j + 1) + ';\n'; }
  }
  throw new Error('unbalanced ' + name);
}

const ELIG_ALL = { upcountry: ['user'], holidayWork: ['user'] };

function makeSandbox(leaves, elig) {
  const ctx = {
    DATA_LEAVES: leaves,
    currentLang: 'en',
    L: (en) => en,
    escapeHtml: (s) => String(s == null ? '' : s),
    attAllowIcon: (emoji) => 'PLAIN:' + emoji,
    attAllowIconButton: (emoji, title, onclick) => 'CLICKABLE:' + emoji + '|' + onclick,
    APP_SETTINGS: { allowanceEligibility: elig || ELIG_ALL },
    isCompanyTripDay: (d) => d === '2026-12-25',
  };
  vm.createContext(ctx);
  vm.runInContext(
    constDecl(APP_SRC, 'DEFAULT_ALLOWANCE_ELIGIBILITY')
    + topLevelFn(APP_SRC, 'isAllowanceEligible')
    + topLevelFn(APP_SRC, 'hasUpcountryLocation')
    + topLevelFn(APP_SRC, 'holidayWorkEarnsUpcountry')
    + topLevelFn(APP_SRC, 'upcountryLocationsOf')
    + topLevelFn(APP_SRC, 'upcountryDayRecord')
    + topLevelFn(APP_SRC, 'upcountryDayStops')
    + topLevelFn(APP_SRC, 'holidayWorkDisplayFor')
    // hwRow / targetUser default to the "no Holiday Work record" case, so every assertion written
    // before 2026-10-28 keeps asking exactly what it asked then.
    // 2026-10-28 (รีวิวรอบ 5): รีวิวชี้ว่าการรับ `targetUser` เป็นพารามิเตอร์ทำให้ไม่มีเทสต์ไหน
    // เห็นได้เลยว่าโค้ดจริงหยิบอ็อบเจกต์ไหนมาใช้ · และ `_hwDisp` ถ้าฉีดเข้ามาเองก็จะเป็นการเขียนกฎ
    // ซ้ำในเทสต์ ⇒ harness เรียก holidayWorkDisplayFor() **ตัวจริง** โดยยัดเรคอร์ดที่เทสต์ส่งมา
    // เข้า DATA_LEAVES ชั่วคราว ให้มันค้นเจอเองตามทางปกติ · `hwRow` ที่บรรทัด badge ใช้ จึงเป็น
    // ผลลัพธ์ของฟังก์ชันกลาง ไม่ใช่สิ่งที่เทสต์ยัดให้ ⇒ กฎมีที่มาเดียวทั้งในโค้ดและในเทสต์
    + 'function badgeFor(canUpcountryTarget, row, targetUserId, hwRow, targetUser) {\n'
    + '  const _attOwner = targetUser || { role: "user" };\n'
    + '  if (hwRow) DATA_LEAVES.push(hwRow);\n'
    + '  const _hwDisp = holidayWorkDisplayFor(targetUserId, row.date, row.status, _attOwner.role, APP_SETTINGS);\n'
    + '  if (hwRow) DATA_LEAVES.pop();\n'
    + '  hwRow = _hwDisp.rec;\n'
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

// --- 2026-10-28: the second way in, a Holiday Work record with a location ---
// The owner's rule, in his words: the location field is for an upcountry site. Work at the office
// on a holiday and you leave it blank, which is also how you end up with no allowance. So the
// icon follows the field, and tests/holiday-work-upcountry-badge.test.js is what proves the field
// follows the money.
const REST_ROW = { date: '2026-10-18', upcountry: false, status: 'rest' };
const HW = { id: 9, userId: 7, type: 'holiday-work', status: 'approved', dateFrom: '2026-10-18',
  compensationMode: 'paid', locations: [{ name: 'NGK' }] };
const USER7 = { role: 'user' };

test('a Holiday Work day with a location shows the icon although the row flag is off', () => {
  const s = makeSandbox([]);
  assert.strictEqual(s.badgeFor(true, REST_ROW, 7, HW, USER7), 'PLAIN:🗺️');
});

test('both compensation modes show it — the allowance does not care which one', () => {
  const s = makeSandbox([]);
  ['paid', 'annual-leave'].forEach(mode => {
    assert.strictEqual(s.badgeFor(true, REST_ROW, 7, { ...HW, compensationMode: mode }, USER7),
      'PLAIN:🗺️', mode);
  });
});

test('worked at the office: location left blank, so no icon', () => {
  const s = makeSandbox([]);
  [[], undefined, [{ name: '   ' }]].forEach(locations => {
    assert.strictEqual(s.badgeFor(true, REST_ROW, 7, { ...HW, locations }, USER7), '',
      JSON.stringify(locations));
  });
});

test('a Holiday Work record that is not approved, is Abroad, or is a Company Trip shows nothing', () => {
  const s = makeSandbox([]);
  assert.strictEqual(s.badgeFor(true, REST_ROW, 7, { ...HW, status: 'pending' }, USER7), '');
  assert.strictEqual(s.badgeFor(true, { ...REST_ROW, status: 'abroad' }, 7, HW, USER7), '');
  assert.strictEqual(s.badgeFor(true, REST_ROW, 7, { ...HW, dateFrom: '2026-12-25' }, USER7), '');
});

test('a role with no Upcountry right sees no icon from a Holiday Work record either', () => {
  const noUpc = makeSandbox([], { upcountry: ['md'], holidayWork: ['user'] });
  assert.strictEqual(noUpc.badgeFor(true, REST_ROW, 7, HW, USER7), '');
  const noHw = makeSandbox([], { upcountry: ['user'], holidayWork: ['md'] });
  assert.strictEqual(noHw.badgeFor(true, REST_ROW, 7, HW, USER7), '');
});

// 2026-10-28, found in review: payroll hands the whole day to an approved Holiday Work record
// (upcountryCount skips every date in holidayWorkDates) and then counts the record. A record with
// no location takes the day and claims nothing, so the day's own flag must not light the icon --
// and that flag is sticky: attendanceLog[..].upcountry stays true after an approval is revoked.
test('a Holiday Work record with no location takes the day: the row flag must not light it alone', () => {
  const s = makeSandbox([]);
  const blank = { ...HW, dateFrom: '2026-10-20', locations: [] };
  assert.strictEqual(s.badgeFor(true, { ...ROW, upcountry: true }, 7, blank, USER7), '',
    'payroll pays ฿0 for this day — the icon must not claim otherwise');
});

test('with no Holiday Work record the day flag still works exactly as before', () => {
  const s = makeSandbox([APPROVED]);
  assert.ok(s.badgeFor(true, { ...ROW, upcountry: true }, 7, null, USER7).includes('🗺️'));
});

// ชื่อเดิมอ้างว่าทดสอบด่าน canHolidayWorkTarget ซึ่ง **ไม่จริง** (รีวิว 2026-10-28): harness รับ
// hwRow เป็นพารามิเตอร์ ด่านนั้นอยู่นอก snippet ที่ยกมา ⇒ ส่ง null เข้าไปตรงๆ คือการจำลองผลของด่าน
// ไม่ใช่การตรวจด่าน · ตั้งชื่อใหม่ให้ตรงกับสิ่งที่มันตรวจจริง ส่วนด่านตัวนั้นถูกตรวจแบบพฤติกรรม
// ใน tests/holiday-work-upcountry-badge.test.js (T2b) ซึ่งเทียบกับ computePayroll จริง
test('hwRow เป็น null (ไม่ว่าด้วยเหตุใด) ⇒ ไอคอนมาจากธงรายวันตามเดิม', () => {
  const s = makeSandbox([APPROVED], { upcountry: ['user'], holidayWork: ['md'] });
  assert.ok(s.badgeFor(true, { ...ROW, upcountry: true }, 7, null, USER7).includes('🗺️'));
});

test('one icon, not two, when the day qualifies both ways', () => {
  const s = makeSandbox([APPROVED]);
  const out = s.badgeFor(true, { ...ROW, upcountry: true }, 7, { ...HW, dateFrom: '2026-10-20' }, USER7);
  assert.strictEqual((out.match(/🗺️/g) || []).length, 1, 'the row must print the icon once: ' + out);
});

console.log(`upcountry-day-view: ${passed} passed`);
