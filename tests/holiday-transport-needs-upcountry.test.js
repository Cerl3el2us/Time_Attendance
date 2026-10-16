// Holiday Work: no upcountry location means no money for the trip (2026-10-16, owner's decision).
//
// A Holiday Work record carries an optional upcountry field. The upcountry allowance itself has
// always depended on it -- hasUpcountryLocation() is what the count is filtered by. The holiday
// transport allowance did not: holidayTransportForRecord() paid it to every paid-mode record,
// upcountry field or not. The owner asked for both to follow the same condition: leave the field
// empty and neither is paid.
//
// Both engines are checked, and required to agree. app.js and server.js each hold a full copy of
// the payroll rules on purpose (memory feedback_attendance_payroll_engine_dual_sync.md), and the
// two copies of this function are marked DUAL-SYNC (identical text) in both files.
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

function transportOf(file, leave, settings, abroadDates) {
  const sandbox = { console };
  vm.createContext(sandbox);
  for (const n of ['hasUpcountryLocation', 'holidayTransportForRecord']) {
    vm.runInContext(extractFunction(SOURCES[file], n), sandbox, { filename: file });
  }
  return vm.runInContext('holidayTransportForRecord', sandbox)(leave, settings, abroadDates);
}

function bothEngines(leave, settings, abroadDates) {
  const out = {};
  for (const file of Object.keys(SOURCES)) out[file] = transportOf(file, leave, settings, abroadDates);
  assert.strictEqual(out['app.js'], out['server.js'],
    `the two payroll engines disagree: app.js=${out['app.js']} server.js=${out['server.js']}`);
  return out['server.js'];
}

const S = { allowances: { holidayTransport: 500 } };
function paidRecord(over) {
  return Object.assign({
    type: 'holiday-work', status: 'approved', compensationMode: 'paid', dateFrom: '2026-10-17',
    locations: [{ name: 'ระยอง' }],
  }, over);
}

console.log('holiday transport needs an upcountry location');

test('กรอก upcountry แล้ว: ได้เบี้ยเดินทางตามที่ตั้งไว้', () => {
  assert.strictEqual(bothEngines(paidRecord(), S, new Set()), 500);
});

test('ไม่กรอก upcountry (ไม่มีคีย์ locations): ไม่ได้เบี้ยเดินทาง', () => {
  assert.strictEqual(bothEngines(paidRecord({ locations: undefined }), S, new Set()), 0);
});

test('ไม่กรอก upcountry (อาเรย์ว่าง): ไม่ได้เบี้ยเดินทาง', () => {
  assert.strictEqual(bothEngines(paidRecord({ locations: [] }), S, new Set()), 0);
});

test('กรอกแต่เว้นว่าง: ไม่ได้เบี้ยเดินทาง', () => {
  assert.strictEqual(bothEngines(paidRecord({ locations: [{ name: '   ' }] }), S, new Set()), 0);
  assert.strictEqual(bothEngines(paidRecord({ locations: [{ name: '' }] }), S, new Set()), 0);
});

// The rules that were already there must survive the new condition.
test('โหมดแลกวันหยุด: ยังไม่ได้เบี้ยเดินทางเหมือนเดิม', () => {
  assert.strictEqual(bothEngines(paidRecord({ compensationMode: 'annual-leave' }), S, new Set()), 0);
});

test('วัน abroad: ยังไม่ได้เบี้ยเดินทางเหมือนเดิม', () => {
  assert.strictEqual(bothEngines(paidRecord(), S, new Set(['2026-10-17'])), 0);
});

// `!= null` rather than `||`, so an admin who deliberately set the rate to 0 keeps 0 instead of
// falling back to 500 (memory feedback_attendance_falsy_zero_settings.md).
test('ตั้งอัตราเป็น 0 ไว้เอง: ได้ 0 ไม่ใช่ตกกลับไป 500', () => {
  assert.strictEqual(bothEngines(paidRecord(), { allowances: { holidayTransport: 0 } }, new Set()), 0);
});

test('ไม่ได้ตั้งอัตรา: ใช้ค่าตั้งต้น 500', () => {
  assert.strictEqual(bothEngines(paidRecord(), { allowances: {} }, new Set()), 500);
});

console.log(`\nholiday-transport-needs-upcountry: ${passed} passed${process.exitCode ? ', some failed' : ''}`);
