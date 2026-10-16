// สวิตช์ปิด/เปิด การจ่ายเบี้ยมาเช้าอัตโนมัติ (2026-10-16, owner's decision).
//
// Early Morning used to pay by itself whenever the face scanner recorded an early enough pass.
// The owner asked for an off switch: with it off nobody is paid automatically, and an employee
// who qualifies asks for the allowance with the button instead, like every other request, and it
// goes through the normal approval. Days that were already paid automatically keep their money --
// the switch only decides what happens to a day that has not been paid yet (owner, 2026-10-16).
//
// The switch ships ON, so deploying it must change nothing.
//
// Both payroll engines must honour it. attendance/js/app.js and attendance-server/backend/server.js
// each hold a full copy of the payroll rules on purpose (memory feedback_attendance_payroll_engine_
// dual_sync.md), and a rule added to one and forgotten in the other makes the payslip and the
// server's own verification disagree silently. So every case below runs TWICE -- once against the
// real function lifted out of each file -- and the engines are also required to agree with each
// other, which is what actually catches a half-applied change.
//
// The functions are lifted from source and run in a vm, the same technique
// tests/web-clock-switch.test.js uses, because a hand-built settings object proves nothing about
// whether the real code ever reads the setting.
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

const NEEDED = [
  'deviceScanQualifiesForEarlyMorning',
  'earlyMorningAutoPayEnabled',
  'isEarlyMorningDayStatus',
  'isDeviceScanSource',
  'isRestAttendanceDay',
  'earlyMorningCheckInOk',
];

// One sandbox per engine, holding that engine's REAL predicates. Each engine reaches settings its
// own way -- the browser reads the APP_SETTINGS global, the server calls getAppSettings() -- so the
// sandbox supplies both names and the test is indifferent to which one the code picks.
function engineGate(file, allowances) {
  const settings = { allowances: Object.assign({ earlyThreshold1Min: 450, earlyThreshold2Min: 390 }, allowances) };
  const sandbox = {
    APP_SETTINGS: settings,
    getAppSettings: () => settings,
    console,
  };
  vm.createContext(sandbox);
  for (const name of NEEDED) vm.runInContext(extractFunction(SOURCES[file], name), sandbox, { filename: file });
  return (day, hwDates) => vm.runInContext('deviceScanQualifiesForEarlyMorning', sandbox)(day, hwDates);
}

// A plain working day whose check-in came from the face scanner early enough to be paid.
function qualifyingDay(over) {
  return Object.assign({
    date: '2026-10-16',
    status: 'present',
    checkIn: '06:30',
    checkInSource: 'device',
    morningReviewNeeded: false,
  }, over);
}

// Runs one case against both engines and requires the same answer from each.
function bothEngines(allowances, day, hwDates) {
  const out = {};
  for (const file of Object.keys(SOURCES)) out[file] = engineGate(file, allowances)(day, hwDates);
  assert.strictEqual(out['app.js'], out['server.js'],
    `the two payroll engines disagree: app.js=${out['app.js']} server.js=${out['server.js']} ` +
    '-- a rule was added to one copy and not the other');
  return out['app.js'];
}

console.log('early-morning auto switch');

test('ชิปมาพร้อมสวิตช์เปิด: ไม่ตั้งค่าอะไรเลย วันที่เข้าเกณฑ์ยังได้อัตโนมัติเหมือนเดิม', () => {
  assert.strictEqual(bothEngines({}, qualifyingDay()), true);
});

test('สวิตช์เปิดไว้ชัดเจน: ยังได้อัตโนมัติ', () => {
  assert.strictEqual(bothEngines({ earlyMorningAutoEnabled: true }, qualifyingDay()), true);
});

test('สวิตช์ปิด: วันเดียวกันนั้นไม่ได้อัตโนมัติอีกต่อไป', () => {
  assert.strictEqual(bothEngines({ earlyMorningAutoEnabled: false }, qualifyingDay()), false);
});

// `setting || default` would read 0 and '' as "unset" -- the trap recorded in memory
// feedback_attendance_falsy_zero_settings.md. Only an explicit false may turn the switch off, so a
// settings.json that somehow holds 0 must not silently stop everyone's allowance.
test('ค่าที่ไม่ใช่ false ไม่ปิดสวิตช์ (กับดัก falsy)', () => {
  for (const v of [0, '', null, undefined]) {
    assert.strictEqual(bothEngines({ earlyMorningAutoEnabled: v }, qualifyingDay()), true,
      `earlyMorningAutoEnabled=${JSON.stringify(v)} ไม่ควรปิดการจ่ายอัตโนมัติ`);
  }
});

// The switch must not become a second way to pay a day the existing rules already refuse.
test('สวิตช์เปิด แต่เช็กอินไม่ได้มาจากเครื่องสแกน: ยังไม่ได้ (กฎเดิมไม่ถูกทับ)', () => {
  assert.strictEqual(bothEngines({ earlyMorningAutoEnabled: true }, qualifyingDay({ checkInSource: 'web' })), false);
});

test('สวิตช์เปิด แต่เช้าวันนั้นถูกตั้งธงรอ Accounting: ยังไม่ได้ (กฎเดิมไม่ถูกทับ)', () => {
  assert.strictEqual(bothEngines({ earlyMorningAutoEnabled: true }, qualifyingDay({ morningReviewNeeded: true })), false);
});

// ---------------------------------------------------------------------------------------------
// The other half of the switch: being allowed to ASK.
//
// Both engines refuse an Early Morning request for a day whose check-in came from the face
// scanner, with the words "automatic when you check in at the face scanner -- no request needed".
// That is true only while the automatic payment is on. Left as it was, turning the switch off
// would take the allowance away AND refuse the request that is supposed to replace it, which is
// the one outcome the owner's rule must not produce.
// ---------------------------------------------------------------------------------------------
function engineScanBlocks(file, allowances) {
  const settings = { allowances: Object.assign({ earlyThreshold1Min: 450, earlyThreshold2Min: 390 }, allowances) };
  const sandbox = { APP_SETTINGS: settings, getAppSettings: () => settings, console };
  vm.createContext(sandbox);
  for (const name of ['isDeviceScanSource', 'earlyMorningAutoPayEnabled', 'earlyMorningScanBlocksRequest']) {
    vm.runInContext(extractFunction(SOURCES[file], name), sandbox, { filename: file });
  }
  return src => vm.runInContext('earlyMorningScanBlocksRequest', sandbox)(src);
}

function bothEnginesScanBlocks(allowances, checkInSource) {
  const out = {};
  for (const file of Object.keys(SOURCES)) out[file] = engineScanBlocks(file, allowances)(checkInSource);
  assert.strictEqual(out['app.js'], out['server.js'],
    `the two engines disagree about refusing the request: app.js=${out['app.js']} server.js=${out['server.js']}`);
  return out['app.js'];
}

test('สวิตช์เปิด: วันที่สแกนหน้ายังยื่นขอไม่ได้ เพราะได้อัตโนมัติอยู่แล้ว', () => {
  assert.strictEqual(bothEnginesScanBlocks({ earlyMorningAutoEnabled: true }, 'device'), true);
});

test('สวิตช์ปิด: วันที่สแกนหน้ายื่นขอได้แล้ว — ไม่งั้นเบี้ยหายโดยขอไม่ได้', () => {
  assert.strictEqual(bothEnginesScanBlocks({ earlyMorningAutoEnabled: false }, 'device'), false);
});

test('เช็กอินที่ไม่ได้มาจากเครื่องสแกน: ยื่นขอได้เสมอ ไม่ว่าสวิตช์จะเปิดหรือปิด', () => {
  assert.strictEqual(bothEnginesScanBlocks({ earlyMorningAutoEnabled: true }, 'web'), false);
  assert.strictEqual(bothEnginesScanBlocks({ earlyMorningAutoEnabled: false }, 'web'), false);
});

// ---------------------------------------------------------------------------------------------
// A guard bought with a real mistake, 2026-10-16.
//
// The Settings toggle for this switch was written with an HTML comment above it, and that comment
// contained a backtick -- inside a JavaScript template literal, where a backtick ENDS the string
// and everything after it is parsed as code. `node --check` passed, because what comes out is
// still valid JavaScript; it simply means something else. Every one of the 44 test files passed
// too, because none of them renders the Settings page. The whole Settings screen threw
// "false is not a function" and only a browser run found it.
//
// This lives in this file rather than a general one because this feature is what paid for it. It
// checks the two files that build HTML inside template literals.
// ---------------------------------------------------------------------------------------------
test('ไม่มี backtick ในคอมเมนต์ HTML ของไฟล์ที่ประกอบ HTML ด้วย template literal', () => {
  const offenders = [];
  for (const [file, src] of Object.entries(SOURCES)) {
    const lines = src.split('\n');
    let inComment = false;
    lines.forEach((line, i) => {
      let rest = line;
      if (!inComment) {
        const open = rest.indexOf('<!--');
        if (open === -1) return;
        rest = rest.slice(open);
        inComment = true;
      }
      const close = rest.indexOf('-->');
      const body = close === -1 ? rest : rest.slice(0, close + 3);
      if (body.includes('`')) offenders.push(`${file}:${i + 1}: ${body.trim().slice(0, 70)}`);
      if (close !== -1) inComment = false;
    });
  }
  assert.deepStrictEqual(offenders, [],
    'a backtick inside an HTML comment closes the surrounding template literal:\n  ' + offenders.join('\n  '));
});

console.log(`\nearly-morning-auto-switch: ${passed} passed${process.exitCode ? ', some failed' : ''}`);
