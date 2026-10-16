// Long Distance: entering the mileage in two goes (2026-10-16, owner's decision).
// Design: docs/superpowers/specs/2026-10-16-long-distance-two-step-mileage-design.md
//
// The driver can save the starting odometer reading on its own and come back for the end later,
// including after midnight. A saved start is NOT a request -- it is a small record of its own, so
// approval, both payroll engines and the badges learn nothing new.
//
// The rule the owner asked for in the same breath, and the one these tests exist to keep: a
// REQUEST still cannot be sent without both readings. The server derives distanceKm from the pair
// rather than trusting the client -- the fix made on 2026-08-13 after an audit found a forged
// distance could claim the allowance for a trip that never cleared the threshold. Adding a button
// that saves half an entry is exactly the kind of change that could quietly open that back up, so
// the rule is pinned here on BOTH engines.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const SOURCES = {
  'app.js': fs.readFileSync(path.join(ROOT, 'attendance/js/app.js'), 'utf8'),
  'server.js': fs.readFileSync(path.join(ROOT, 'attendance-server/backend/server.js'), 'utf8'),
};

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok  ${name}`); }
  catch (e) { process.exitCode = 1; console.log(`  FAIL  ${name}\n        ${e.message}`); }
}

function extractFunction(src, name) {
  const re = new RegExp(`^function ${name}\\(`, 'm');
  const m = re.exec(src);
  if (!m) throw new Error(`function ${name} not found`);
  const i = src.indexOf('{', m.index);
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (depth === 0) return src.slice(m.index, j + 1); }
  }
  throw new Error(`unbalanced ${name}`);
}

// Single-line `const NAME = ...;` declarations the lifted functions depend on. Taken from the real
// source rather than retyped here, so a changed regex cannot leave this file testing a stale copy.
function extractConstLine(src, name) {
  const m = new RegExp(`^const ${name} = .*$`, 'm').exec(src);
  if (!m) throw new Error(`const ${name} not found`);
  return m[0];
}

function load(file, names, consts) {
  const sandbox = { console };
  vm.createContext(sandbox);
  for (const c of consts || []) vm.runInContext(extractConstLine(SOURCES[file], c), sandbox, { filename: file });
  for (const n of names) vm.runInContext(extractFunction(SOURCES[file], n), sandbox, { filename: file });
  const out = {};
  for (const n of names) out[n] = vm.runInContext(n, sandbox);
  return out;
}

console.log('long distance: two-step mileage');

// ---------------------------------------------------------------------------------------------
// 1. The pinned rule: a request needs BOTH readings, on both engines.
// ---------------------------------------------------------------------------------------------
function bothEngines(start, end) {
  const out = {};
  for (const file of Object.keys(SOURCES)) {
    const { longDistanceMileageError } = load(file, ['longDistanceMileageError']);
    out[file] = longDistanceMileageError(start, end);
  }
  assert.strictEqual(
    out['app.js'] === null, out['server.js'] === null,
    `the engines disagree for (${start}, ${end}): app.js=${JSON.stringify(out['app.js'])} server.js=${JSON.stringify(out['server.js'])}`);
  return out['server.js'];
}

test('เลขครบคู่และเลขจบมากกว่าเลขเริ่ม: ผ่าน', () => {
  assert.strictEqual(bothEngines(48210, 48335), null);
});

test('ขาดเลขเริ่ม: ส่งคำขอไม่ได้', () => {
  assert.ok(bothEngines(undefined, 48335), 'ควรมีข้อความปฏิเสธ');
  assert.ok(bothEngines(NaN, 48335));
  assert.ok(bothEngines(null, 48335));
});

test('ขาดเลขจบ: ส่งคำขอไม่ได้ — นี่คือสิ่งที่ปุ่มบันทึกเลขเริ่มต้องไม่เปิดช่องให้', () => {
  assert.ok(bothEngines(48210, undefined), 'ควรมีข้อความปฏิเสธ');
  assert.ok(bothEngines(48210, NaN));
  assert.ok(bothEngines(48210, null));
});

test('ขาดทั้งคู่: ส่งคำขอไม่ได้', () => {
  assert.ok(bothEngines(undefined, undefined));
});

test('เลขจบเท่ากับหรือน้อยกว่าเลขเริ่ม: ส่งคำขอไม่ได้', () => {
  assert.ok(bothEngines(48210, 48210), 'เท่ากันต้องไม่ผ่าน');
  assert.ok(bothEngines(48210, 48000), 'น้อยกว่าต้องไม่ผ่าน');
});

test('ค่าที่ไม่ใช่ตัวเลขจำกัด: ส่งคำขอไม่ได้', () => {
  assert.ok(bothEngines('abc', 48335));
  assert.ok(bothEngines(Infinity, 48335));
  assert.ok(bothEngines(48210, Infinity));
});

// A reading of 0 is a real odometer value, not "missing" -- the falsy trap recorded in memory
// feedback_attendance_falsy_zero_settings.md, in a field where it would silently refuse a claim.
test('เลขเริ่มเป็น 0: ถือว่ากรอกแล้ว ไม่ใช่ว่างเปล่า', () => {
  assert.strictEqual(bothEngines(0, 125), null);
});

// ---------------------------------------------------------------------------------------------
// 2. Saving a start on its own: the format checks the server applies before anything is written.
// ---------------------------------------------------------------------------------------------
function saveError(body) {
  const { mileageOpenSaveError } = load(
    'server.js', ['isValidDateStr', 'isFiniteNonNegNumber', 'mileageOpenSaveError'], ['DATE_RE']);
  return mileageOpenSaveError(body);
}

test('บันทึกเลขเริ่ม: ข้อมูลถูกต้องผ่าน', () => {
  assert.strictEqual(saveError({ date: '2026-10-16', mileageStart: 48210 }), null);
});

test('บันทึกเลขเริ่ม: เลข 0 ผ่าน (เป็นค่าจริงของมาตรวัด)', () => {
  assert.strictEqual(saveError({ date: '2026-10-16', mileageStart: 0 }), null);
});

test('บันทึกเลขเริ่ม: วันที่ผิดรูปแบบไม่ผ่าน', () => {
  assert.ok(saveError({ date: '16/10/2026', mileageStart: 1 }));
  assert.ok(saveError({ date: '', mileageStart: 1 }));
  assert.ok(saveError({ mileageStart: 1 }));
});

test('บันทึกเลขเริ่ม: เลขติดลบหรือไม่ใช่ตัวเลขไม่ผ่าน', () => {
  assert.ok(saveError({ date: '2026-10-16', mileageStart: -1 }));
  assert.ok(saveError({ date: '2026-10-16', mileageStart: 'abc' }));
  assert.ok(saveError({ date: '2026-10-16', mileageStart: Infinity }));
  assert.ok(saveError({ date: '2026-10-16' }));
});

// ---------------------------------------------------------------------------------------------
// 3. One row per person per day, and one person's row is not another's.
// ---------------------------------------------------------------------------------------------
test('คีย์ของที่เก็บ: หนึ่งแถวต่อ (คน, วัน) และของคนละคนไม่ชนกัน', () => {
  const { mileageOpenKey } = load('server.js', ['mileageOpenKey']);
  assert.strictEqual(mileageOpenKey(12, '2026-10-16'), '12_2026-10-16');
  assert.notStrictEqual(mileageOpenKey(12, '2026-10-16'), mileageOpenKey(13, '2026-10-16'));
  assert.notStrictEqual(mileageOpenKey(12, '2026-10-16'), mileageOpenKey(12, '2026-10-17'));
});

console.log(`\nlong-distance-two-step: ${passed} passed${process.exitCode ? ', some failed' : ''}`);
