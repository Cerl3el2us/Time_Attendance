// บังคับลาเป็นชั่วโมงเต็ม (เจ้าของตัดสิน 2026-11-03 เริ่มใช้รอบมกราคม 2027)
// แบบเต็ม: docs/superpowers/specs/2026-11-03-whole-hour-leave-design.md
//
// ไม่มี framework: `node tests/whole-hour-leave.test.js`
// ฟังก์ชันถูกดึงออกมาจากซอร์สจริงทั้งสองไฟล์ แล้วรันในกระบะทราย (แบบเดียวกับ leave-rules.test.js)
// ⇒ เทสต์นี้พิสูจน์ด้วยว่าสำเนา DUAL-SYNC ของกฎใหม่ "เหมือนกันจริง" ไม่ใช่แค่ทำงานคล้ายกัน
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const APP_SRC = fs.readFileSync(path.join(ROOT, 'attendance/js/app.js'), 'utf8');
const SERVER_SRC = fs.readFileSync(path.join(ROOT, 'attendance-server/backend/server.js'), 'utf8');

let pass = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { console.error('  FAIL ' + name + '\n       ' + e.message); process.exitCode = 1; }
}

function extractFunction(src, name) {
  const re = new RegExp(`^(async )?function ${name}\\(`, 'm');
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
function extractConst(src, name) {
  // ยอมให้มีเว้นวรรคหลายตัวรอบ `=` -- ค่าคงที่ของ leaveDayCoverage จัดคอลัมน์ไว้ (`LUNCH_END_MIN   =`)
  const re = new RegExp(`^const ${name} *= *[^;]+;`, 'm');
  const m = re.exec(src);
  if (!m) throw new Error(`const ${name} not found`);
  return m[0];
}

// กฎที่ต้องเหมือนกันทุกตัวอักษรทั้งสองฝั่ง
const RULE_CONSTS = ['WHOLE_HOUR_LEAVE_MAX_HOURS', 'WHOLE_HOUR_LEAVE_GRID_MIN', 'WHOLE_HOUR_LEAVE_DAY_END_MIN'];
const RULE_FNS = ['wholeHourLeaveRequired', 'hourlyLeaveEndFromHours', 'wholeHourLeaveError'];
// ตัวอ่านค่าตั้ง -- ตั้งใจให้ต่างกันสองฝั่ง (APP_SETTINGS vs getAppSettings()) เหมือนที่
// carryForwardExpiryEnabled ทำอยู่แล้ว จึงไม่อยู่ในรายการที่ตรวจว่าเหมือนกัน
const SIDE_FNS = ['wholeHourLeaveSettings', 'wholeHourLeaveDayStartMin'];
const SUPPORT_FNS = ['hourlyLeaveChargedMinutes', 'parseHHMMToMins'];
const SUPPORT_CONSTS = ['HHMM_RE']; // parseHHMMToMins พึ่งตัวนี้

const DEFAULT_WS = { standardStartHour: 8, standardStartMinute: 30 };

// world = { from: 'YYYY-MM-DD' | '' , ws }
function makeSide(which, world) {
  const src = which === 'client' ? APP_SRC : SERVER_SRC;
  const settings = {
    leave: { wholeHourLeaveFrom: world.from },
    workSchedule: world.ws || DEFAULT_WS,
  };
  const ctx = which === 'client'
    ? { APP_SETTINGS: settings }
    : { getAppSettings: () => settings };
  ctx.console = console;
  vm.createContext(ctx);
  const code = [
    ...[...RULE_CONSTS, ...SUPPORT_CONSTS].map(n => extractConst(src, n)),
    ...[...SIDE_FNS, ...RULE_FNS, ...SUPPORT_FNS].map(n => extractFunction(src, n)),
  ].join('\n');
  vm.runInContext(code, ctx);
  return ctx;
}
// กระบะทรายถูกสร้างใน test() เสมอ ไม่ใช่ตอนไล่ลูป -- ถ้าฟังก์ชันยังไม่มีในซอร์ส การดึงจะโยน error
// และต้องกลายเป็น "ข้อที่ตก" หนึ่งข้อ ไม่ใช่หยุดทั้งไฟล์จนไม่รู้ว่าอะไรพังอีกบ้าง
const _sideCache = new Map();
function sideFor(which, from, ws) {
  const key = which + '|' + from + '|' + JSON.stringify(ws || DEFAULT_WS);
  if (!_sideCache.has(key)) _sideCache.set(key, makeSide(which, { from, ws }));
  return _sideCache.get(key);
}

// ===== 1. DUAL-SYNC: กฎต้องเหมือนกันทุกตัวอักษร =====
console.log('\n[1] DUAL-SYNC app.js <-> server.js');
for (const n of RULE_FNS) {
  test(`ฟังก์ชัน ${n} เหมือนกันทุกตัวอักษร`, () => {
    assert.strictEqual(extractFunction(APP_SRC, n), extractFunction(SERVER_SRC, n));
  });
}
for (const n of RULE_CONSTS) {
  test(`ค่าคงที่ ${n} เหมือนกันทุกตัวอักษร`, () => {
    assert.strictEqual(extractConst(APP_SRC, n), extractConst(SERVER_SRC, n));
  });
}

// ===== 2. คำนวณเวลาสิ้นสุดจาก "เริ่ม + จำนวนชั่วโมง" =====
// ตารางนี้คือข้อ 2 ของเอกสารแบบ -- ถ้าแก้ที่นี่ต้องแก้ที่นั่นด้วย
const END_TABLE = [
  ['08:30', 3, '11:30'],
  ['08:30', 4, '13:30'],   // = ลาครึ่งวันเช้าแบบใหม่ (เจ้าของตัดสิน 2026-11-03)
  ['13:30', 4, '17:30'],   // = ลาครึ่งวันบ่ายแบบใหม่
  ['10:00', 3, '14:00'],   // ข้ามพักเที่ยง -- ไม่ใช่ 13:00
  ['11:30', 1, '13:30'],   // เริ่มก่อนเที่ยง 30 นาที แล้วข้ามพักเที่ยงทั้งชั่วโมง
  ['09:00', 1, '10:00'],
  ['13:00', 1, '14:00'],
  ['08:30', 7, '16:30'],   // เพดาน
];
console.log('\n[2] hourlyLeaveEndFromHours()');
for (const side of ['client', 'server']) {
  for (const [start, hours, want] of END_TABLE) {
    test(`${side}: ${start} + ${hours} ชม. = ${want}`, () => {
      assert.strictEqual(sideFor(side, '2027-01-01').hourlyLeaveEndFromHours(start, hours), want);
    });
  }
  // ย้อนกลับได้: เวลาที่คิดได้จริงต้องเท่ากับจำนวนชั่วโมงที่ขอ เป๊ะ
  for (const [start, hours, want] of END_TABLE) {
    test(`${side}: ${start}–${want} คิดได้ ${hours} ชม.จริง (ตรงกับสูตรเดิม)`, () => {
      assert.strictEqual(sideFor(side, '2027-01-01').hourlyLeaveChargedMinutes(start, want), hours * 60);
    });
  }
  test(`${side}: จำนวนชั่วโมงที่ไม่ถูกต้อง คืน null`, () => {
    const S = sideFor(side, '2027-01-01');
    assert.strictEqual(S.hourlyLeaveEndFromHours('09:00', 0), null);
    assert.strictEqual(S.hourlyLeaveEndFromHours('09:00', 1.5), null);
    assert.strictEqual(S.hourlyLeaveEndFromHours('09:00', 8), null);
    assert.strictEqual(S.hourlyLeaveEndFromHours('ไม่ใช่เวลา', 2), null);
  });
}

// ===== 3. ด่านตรวจ =====
console.log('\n[3] wholeHourLeaveError()');
for (const side of ['client', 'server']) {
  const ok = (s, e, why) => test(`${side}: ผ่าน ${s}–${e} (${why})`, () => {
    assert.strictEqual(sideFor(side, '2027-01-01').wholeHourLeaveError(s, e), null);
  });
  const bad = (s, e, code) => test(`${side}: ปฏิเสธ ${s}–${e} => ${code}`, () => {
    assert.strictEqual(sideFor(side, '2027-01-01').wholeHourLeaveError(s, e), code);
  });

  ok('08:30', '13:30', 'ครึ่งวันเช้า 4 ชม.');
  ok('13:30', '17:30', 'ครึ่งวันบ่าย 4 ชม.');
  ok('10:00', '14:00', '3 ชม. คร่อมพักเที่ยง');
  ok('09:00', '10:00', '1 ชม.');
  ok('08:30', '16:30', '7 ชม. เท่าเพดานพอดี');

  bad('08:30', '12:00', 'not-whole-hour');     // 3.5 ชม. = ครึ่งวันเช้าแบบเก่า
  bad('13:00', '17:30', 'not-whole-hour');     // 4.5 ชม. = ครึ่งวันบ่ายแบบเก่า
  bad('08:30', '09:08', 'not-whole-hour');     // ใบจริงที่ยังค้างอยู่ 38 นาที
  bad('08:30', '17:30', 'exceeds-max');        // 8 ชม. -- ต้องใช้โหมดลาเป็นวัน
  bad('09:15', '10:15', 'off-grid');           // เริ่มไม่ตรงครึ่งชั่วโมง
  bad('12:30', '14:30', 'starts-in-lunch');    // เริ่มกลางพักเที่ยง
  bad('08:00', '09:00', 'outside-work-hours'); // ก่อนเวลาเริ่มงาน
  bad('16:30', '18:30', 'outside-work-hours'); // เลยเวลาเลิกงาน
}

// ===== 4. วันเริ่มบังคับ =====
console.log('\n[4] wholeHourLeaveRequired()');
for (const side of ['client', 'server']) {
  test(`${side}: ค่าตั้งว่าง = ปิดสนิท`, () => {
    const S = sideFor(side, '');
    assert.strictEqual(S.wholeHourLeaveRequired('2027-06-01'), false);
    assert.strictEqual(S.wholeHourLeaveRequired('2026-01-01'), false);
  });
  test(`${side}: ไม่มีคีย์เลย = ปิดสนิท`, () => {
    const S = sideFor(side, undefined);
    assert.strictEqual(S.wholeHourLeaveRequired('2027-06-01'), false);
  });
  test(`${side}: วันลาก่อนวันเริ่ม = ไม่บังคับ`, () => {
    const S = sideFor(side, '2027-01-01');
    assert.strictEqual(S.wholeHourLeaveRequired('2026-12-31'), false);
  });
  test(`${side}: วันลาตรงวันเริ่มพอดี = บังคับ`, () => {
    const S = sideFor(side, '2027-01-01');
    assert.strictEqual(S.wholeHourLeaveRequired('2027-01-01'), true);
  });
  test(`${side}: วันลาหลังวันเริ่ม = บังคับ`, () => {
    const S = sideFor(side, '2027-01-01');
    assert.strictEqual(S.wholeHourLeaveRequired('2027-03-15'), true);
  });
  test(`${side}: วันที่พังหรือว่าง = ไม่บังคับ (ไม่โยน error)`, () => {
    const S = sideFor(side, '2027-01-01');
    assert.strictEqual(S.wholeHourLeaveRequired(''), false);
    assert.strictEqual(S.wholeHourLeaveRequired(null), false);
    assert.strictEqual(S.wholeHourLeaveRequired('ไม่ใช่วันที่'), false);
  });
}

// ===== 5. ด่านฝั่ง server ต้องเรียกใช้กฎใหม่จริง =====
// hourlyLeaveShapeError() คือด่านที่ทั้ง POST /api/leaves และ PUT (แก้ใบ) เรียกใช้
console.log('\n[5] hourlyLeaveShapeError() เอากฎใหม่ไปใช้จริง');
function makeServerShape(from) {
  const settings = { leave: { wholeHourLeaveFrom: from }, workSchedule: DEFAULT_WS };
  const ctx = { getAppSettings: () => settings, console };
  vm.createContext(ctx);
  const names = [...SIDE_FNS, ...RULE_FNS, ...SUPPORT_FNS, 'hourlyLeaveShapeError'];
  const code = [
    ...[...RULE_CONSTS, ...SUPPORT_CONSTS].map(n => extractConst(SERVER_SRC, n)),
    ...names.map(n => extractFunction(SERVER_SRC, n)),
  ].join('\n');
  vm.runInContext(code, ctx);
  return ctx;
}
test('วันลาปี 2027: ใบ 38 นาที ถูกปฏิเสธ', () => {
  const S = makeServerShape('2027-01-01');
  assert.ok(S.hourlyLeaveShapeError('08:30', '09:08', '2027-02-10', '2027-02-10'));
});
test('วันลาปี 2027: ครึ่งวันเช้าแบบใหม่ 08:30–13:30 ผ่าน', () => {
  const S = makeServerShape('2027-01-01');
  assert.strictEqual(S.hourlyLeaveShapeError('08:30', '13:30', '2027-02-10', '2027-02-10'), null);
});
test('วันลาปี 2026: ใบ 38 นาที ยังผ่านเหมือนเดิม (ไม่ตรวจย้อน)', () => {
  const S = makeServerShape('2027-01-01');
  assert.strictEqual(S.hourlyLeaveShapeError('08:30', '09:08', '2026-11-02', '2026-11-02'), null);
});
test('วันลาปี 2026: ครึ่งวันเช้าแบบเก่า 08:30–12:00 ยังผ่าน', () => {
  const S = makeServerShape('2027-01-01');
  assert.strictEqual(S.hourlyLeaveShapeError('08:30', '12:00', '2026-12-15', '2026-12-15'), null);
});
test('ค่าตั้งว่าง: ปี 2027 ก็ยังลาเป็นนาทีได้ (สวิตช์ยังไม่เปิด)', () => {
  const S = makeServerShape('');
  assert.strictEqual(S.hourlyLeaveShapeError('08:30', '09:08', '2027-02-10', '2027-02-10'), null);
});
test('ด่านเดิมยังทำงาน: 12:00–13:00 ยังถูกปฏิเสธเรื่องพักเที่ยง', () => {
  const S = makeServerShape('');
  assert.ok(/lunch/.test(S.hourlyLeaveShapeError('12:00', '13:00', '2026-10-01', '2026-10-01')));
});

// ===== 6. ครึ่งวันแบบใหม่ต้องถูกจัดประเภทเป็นครึ่งวันจริง ไม่ใช่ 'partial' =====
// บั๊กที่เจอตอนรีวิว 2026-11-03: ครึ่งวันบ่ายแบบใหม่ 13:30–17:30 เคยได้ 'partial' เพราะสาขา pm
// ของ leaveDayCoverage() บังคับให้เวลาเริ่มอยู่ใน 12:00–13:00 ⇒ ทุกที่ที่เช็ก coverage === 'pm'
// (ป้าย "ลา" ในช่องเวลาออกงาน) เงียบไป คนที่ลาบ่ายแล้วไม่สแกนออกจะดูเหมือนลืมสแกน
const COVERAGE_CONSTS = ['LUNCH_START_MIN', 'LUNCH_END_MIN', 'STD_END_MIN', 'HALFDAY_TOL_MIN', 'PM_HALFDAY_LATEST_START_MIN'];
const COVERAGE_CASES = [
  ['ครึ่งวันเช้า แบบเก่า', '08:30', '12:00', 'am'],
  ['ครึ่งวันบ่าย แบบเก่า', '13:00', '17:30', 'pm'],
  ['ครึ่งวันเช้า แบบใหม่', '08:30', '13:30', 'am'],
  ['ครึ่งวันบ่าย แบบใหม่', '13:30', '17:30', 'pm'],
  ['ลาทั้งวันแบบชั่วโมง', '08:30', '17:30', 'full'],
  ['ลาสั้นๆ ตอนบ่าย', '15:00', '16:00', 'partial'],
];
console.log('\n[6] leaveDayCoverage() กับครึ่งวันแบบใหม่');
test('ค่าคงที่ PM_HALFDAY_LATEST_START_MIN เหมือนกันทุกตัวอักษร', () => {
  assert.strictEqual(extractConst(APP_SRC, 'PM_HALFDAY_LATEST_START_MIN'),
    extractConst(SERVER_SRC, 'PM_HALFDAY_LATEST_START_MIN'));
});
// leaveDayCoverage() ไม่ได้ถูกบังคับให้เหมือนกันทุกตัวอักษร (คอมเมนต์ข้างในสองสำเนาต่างกันมาแต่เดิม)
// กฎของมันคือ "ต้องจำแนกเหมือนกัน" ⇒ ยามคือเคสพฤติกรรมด้านล่างที่รันทั้งสองฝั่งด้วยชุดเดียวกัน
for (const [side, src] of [['client', APP_SRC], ['server', SERVER_SRC]]) {
  for (const [name, s, e, want] of COVERAGE_CASES) {
    test(`${side}: ${name} ${s}–${e} => ${want}`, () => {
      const ctx = {};
      vm.createContext(ctx);
      vm.runInContext(COVERAGE_CONSTS.map(n => extractConst(src, n)).join('\n')
        + '\n' + extractFunction(src, 'leaveDayCoverage'), ctx);
      const l = { type: 'annual', dateFrom: '2027-02-10', dateTo: '2027-02-10', days: 0, hourlyStart: s, hourlyEnd: e };
      assert.strictEqual(ctx.leaveDayCoverage(l, '2027-02-10', 8 * 60 + 30), want);
    });
  }
}

console.log(`\n${pass} ผ่าน` + (process.exitCode ? ' — มีข้อที่ตก' : ''));
