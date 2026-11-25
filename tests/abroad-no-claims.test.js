// 2026-11-25 (owner): วัน abroad เคลมอะไรไม่ได้เลย -- วันหยุดที่ทับจะเพิ่มวันลาให้อัตโนมัติแทน
// ของเดิมอนุญาตโดยเจตนา: 2026-09-21 ให้ OT เคลมได้ ("the user confirmed OT is the one claim that
// still applies while abroad") และ 2026-09-23 ให้ Holiday Work ยื่นได้โดยไม่ต้องสแกน
// เจ้าของกลับคำทั้งสองข้อเมื่อ 2026-11-25 ⇒ ยามชุดนี้ตรึงกฎใหม่ไว้
// ไม่มี framework: `node tests/abroad-no-claims.test.js`
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const APP_SRC = fs.readFileSync(path.join(ROOT, 'attendance/js/app.js'), 'utf8');
const SERVER_SRC = fs.readFileSync(path.join(ROOT, 'attendance-server/backend/server.js'), 'utf8');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok  ${name}`); }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; }
}

// อ่าน set ออกจากไฟล์จริง ไม่เขียนรายการซ้ำไว้ในเทสต์ ไม่งั้นเทสต์จะยืนยันแค่ตัวเอง
function noClaimTypes(src) {
  const m = /const ABROAD_NO_CLAIM_TYPES = new Set\(\[([^\]]*)\]\)/.exec(src);
  assert.ok(m, 'ไม่เจอ ABROAD_NO_CLAIM_TYPES');
  return new Set(m[1].split(',').map(s => s.trim().replace(/^'|'$/g, '')).filter(Boolean));
}

function functionBody(src, name) {
  const key = 'function ' + name + '(';
  const start = src.indexOf(key);
  assert.ok(start > -1, `ไม่เจอ ${name}`);
  let p = src.indexOf('(', start), depth = 0, i = -1;
  for (let j = p; j < src.length; j++) {
    if (src[j] === '(') depth++;
    else if (src[j] === ')') { depth--; if (depth === 0) { i = src.indexOf('{', j); break; } }
  }
  let d = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') d++;
    else if (src[j] === '}') { d--; if (d === 0) return src.slice(start, j + 1); }
  }
  throw new Error(`unbalanced ${name}`);
}

console.log('T1 วัน abroad เคลมอะไรไม่ได้เลย');

test('รายการห้ามเคลมครอบคลุมทุกชนิด รวม OT และ Holiday Work (ทั้งสองไฟล์)', () => {
  for (const [name, src] of [['app.js', APP_SRC], ['server.js', SERVER_SRC]]) {
    const s = noClaimTypes(src);
    for (const t of ['ot', 'holiday-work', 'early-morning', 'late-out',
      'upcountry', 'long-distance', 'personal-car']) {
      assert.ok(s.has(t), `${name}: ขาด '${t}' ในรายการห้ามเคลมของวัน abroad`);
    }
  }
});

test('รายการห้ามเคลมของสองไฟล์ต้องเหมือนกัน (dual-sync)', () => {
  assert.deepStrictEqual([...noClaimTypes(APP_SRC)].sort(), [...noClaimTypes(SERVER_SRC)].sort());
});

test('submitOT และ submitDriverOT ต้องเรียกด่าน abroad', () => {
  // Driver OT ไม่ใช่ประเภทใบแยก มันคือ type 'ot' + ธง isDriverOT ⇒ ฝั่ง server ครอบให้เองด้วย 'ot'
  // แต่ฝั่งเว็บสองฟอร์มนี้เรียกแค่ blockIfCompanyTrip() ไม่เคยเรียกด่าน abroad เลย
  for (const fn of ['submitOT', 'submitDriverOT']) {
    assert.ok(/blockIfAbroadDay\(\s*date\s*,\s*'ot'\s*\)/.test(functionBody(APP_SRC, fn)),
      `${fn}: ไม่ได้เรียก blockIfAbroadDay(date, 'ot')`);
  }
});

test('ข้อความบอกเหตุผลต้องไม่บอกว่ายังเคลม OT ได้ และต้องครบ 3 ภาษา', () => {
  assert.ok(!/only OT and Holiday Work can be claimed/.test(SERVER_SRC),
    'server.js: ยังมีข้อความเดิมที่บอกว่าเคลม OT ได้');
  const body = functionBody(APP_SRC, 'blockIfAbroadDay');
  assert.ok(/'ja'/.test(body) && /L\(/.test(body), 'blockIfAbroadDay: ข้อความไม่ครบ 3 ภาษา');
  assert.ok(!/เคลมได้เฉพาะ OT/.test(body), 'app.js: ยังมีข้อความไทยเดิม');
});


console.log('T2 ตัวคำนวณเงินไม่จ่ายของวัน abroad');

// ใบที่ถูกอนุมัติไว้ "ก่อน" ทริปถูกอนุมัติ ยังอยู่ในระบบและยัง status === 'approved'
// ด่านตอนยื่น (T1) ไม่ได้แตะมันเลย ถ้าไม่กรองที่ตัวคำนวณ เงินยังออกอยู่
// เช็กระดับข้อความในซอร์ส เพราะ computePayroll ใหญ่เกินกว่าจะดึงมารันในแซนด์บ็อกซ์
test('computePayroll กรองวัน abroad ออกจาก approvedOTs และ approvedHolidayWork (ทั้งสองไฟล์)', () => {
  for (const [name, src] of [['app.js', APP_SRC], ['server.js', SERVER_SRC]]) {
    for (const which of ['approvedOTs', 'approvedHolidayWork']) {
      const i = src.indexOf('const ' + which + ' = ');
      assert.ok(i > -1, `${name}: ไม่เจอ ${which}`);
      const end = src.indexOf(') : [];', i);
      assert.ok(end > i, `${name}: ${which} เปลี่ยนรูป -- ชี้เทสต์ใหม่`);
      const block = src.slice(i, end);
      assert.ok(block.includes('!abroadDates.has(l.dateFrom)'),
        `${name}: ${which} ไม่ได้กรองวัน abroad ออก เงินยังจ่ายอยู่`);
    }
  }
});

test('abroadDates ถูกประกาศก่อนที่ใครจะใช้ (TDZ ที่ lint จับไม่ได้)', () => {
  for (const [name, src] of [['app.js', APP_SRC], ['server.js', SERVER_SRC]]) {
    const decl = src.indexOf('const abroadDates = new Set(pDays');
    const firstUse = src.indexOf('const approvedHolidayWork = ');
    assert.ok(decl > -1 && firstUse > -1, `${name}: เปลี่ยนรูป -- ชี้เทสต์ใหม่`);
    assert.ok(decl < firstUse,
      `${name}: abroadDates ประกาศหลัง approvedHolidayWork ⇒ ReferenceError ตอนรันจริง`);
  }
});


console.log('T3 ด่านตอนยื่นทริป ดูทั้งช่วง และนับ OT ด้วย');

// กฎใหม่ห้ามทั้ง OT และ Holiday Work ทุกวันในทริป ไม่ใช่แค่วันเดินทาง ⇒ ด่านตอนยื่นต้องตามไปด้วย
// ไม่งั้นยื่นทริปทับใบที่มีอยู่ได้ แล้วใบนั้นกลายเป็นไม่จ่ายเงียบๆ โดยพนักงานไม่รู้ตัว
test('ด่านยื่นทริปดูใบ ot ด้วย ไม่ใช่แค่ holiday-work', () => {
  const body = functionBody(SERVER_SRC, 'abroadTravelDayHolidayWorkConflict');
  assert.ok(body.includes("'ot'"), "ยังไม่ดูใบ type 'ot'");
  assert.ok(body.includes("'holiday-work'"), "ต้องยังดูใบ holiday-work อยู่");
});

test('ด่านยื่นทริปดูทุกวันในช่วง ไม่ใช่แค่วันเริ่มกับวันจบ', () => {
  const body = functionBody(SERVER_SRC, 'abroadTravelDayHolidayWorkConflict');
  assert.ok(!body.includes('travel.has('), 'ยังเทียบเฉพาะวันเดินทางอยู่');
  assert.ok(body.includes('>= dateFrom') && body.includes('<= to'),
    'ต้องเทียบเป็นช่วง (dateFrom..dateTo)');
});

test('ฝั่งเว็บใน submitAbroad ตรรกะตรงกับฝั่ง server', () => {
  const sub = functionBody(APP_SRC, 'submitAbroad');
  assert.ok(sub.includes("l.type === 'ot'"), "ฝั่งเว็บยังไม่ดูใบ ot");
  assert.ok(sub.includes('l.dateFrom >= dateFrom') && sub.includes('l.dateFrom <= dateTo'),
    'ฝั่งเว็บยังเทียบเฉพาะวันเริ่ม/วันจบ');
});

test('ข้อความของด่านนี้ไม่พูดว่า "วันเริ่มหรือวันสิ้นสุด" อีกแล้ว และญี่ปุ่นยังผูกกับข้อความอังกฤษใหม่', () => {
  assert.ok(!SERVER_SRC.includes("exists on this trip's start or end date"),
    'server.js: ยังมีข้อความเดิมที่พูดถึงเฉพาะวันเริ่ม/วันจบ');
  const JA = fs.readFileSync(path.join(ROOT, 'attendance/lang/ja.js'), 'utf8');
  assert.ok(!JA.includes("exists on this trip's start or end date"),
    'ja.js: คีย์ญี่ปุ่นยังผูกกับข้อความอังกฤษเดิม ⇒ ภาษาญี่ปุ่นจะตกกลับไปเป็นอังกฤษเงียบๆ');
});

console.log(`\nabroad-no-claims: ${passed} passed${process.exitCode ? ', some FAILED' : ', 0 failed'}`);
