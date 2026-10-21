// บังคับกรอกเหตุผลเฉพาะ "ลากิจ" เท่านั้น (2026-10-21, เจ้าของตัดสินสองจังหวะในวันเดียวกัน:
// ครั้งแรก "ลาป่วยอย่างเดียวพอ ที่เหลือบังคับเหมือนเดิม" แล้วแก้เป็น "เพิ่มลาพักร้อนไม่ต้องบังคับ
// ด้วย บังคับแค่ลากิจ" -- ฉบับหลังคือฉบับที่ใช้ และเป็นที่มาของชื่อเทสต์ที่เหลือในไฟล์นี้)
//
// ทำไมกฎนี้ต้องมียาม: ข้อบังคับ "ต้องกรอกเหตุผล" มีอยู่ฝั่งหน้าจอฝ่ายเดียว -- `POST /api/leaves`
// ในเซิร์ฟเวอร์บังคับ reason เฉพาะ type 'excused' กับ 'late-out' เท่านั้น ไม่เคยบังคับกับการลา
// ที่พนักงานยื่นเอง ⇒ ด่านของหน้าจอเข้มกว่าเซิร์ฟเวอร์อยู่ก่อนแล้ว และคนที่มาอ่าน server.js
// ทีหลังจะไม่มีทางรู้ว่ามีด่านนี้ซ่อนอยู่ในหน้าจอ การถอดด่านนี้ออกจึงเป็นการทำให้สองฝั่งเข้าใกล้กัน
// ไม่ใช่ทำให้หลวมลง -- แต่ถ้าวันหน้ามีคนมาแก้ submitLeave() แล้วเผลอคืนด่านเดิมกลับมา อาการจะ
// เงียบสนิท (พนักงานลาป่วยไม่ได้ แล้วไม่มีใครรู้ว่าทำไม)
//
// ยามนี้รัน submitLeave() ตัวจริงที่ดึงออกมาจาก app.js ไม่ได้ค้นหาข้อความในซอร์ส -- ด้วยเหตุผล
// เดียวกับที่ tests/role-allowance-rates.test.js เขียนไว้: การจับข้อความพิสูจน์ได้แค่ว่าตัวอักษร
// ยังอยู่ ไม่ได้พิสูจน์ว่าโค้ดจริงเดินผ่านเส้นทางไหน
//
// วิธีแยกแยะว่า "ผ่านด่านเหตุผลไปแล้วหรือยัง": ไม่ใส่วันที่ลาไว้ด้วย ⇒ คำขอที่ผ่านด่านเหตุผลไปได้
// จะไปสะดุดด่านถัดไปคือ "กรุณาระบุวันที่เริ่มลา" แทน ⇒ ข้อความที่ผู้ใช้เห็นบอกเราได้ว่าหยุดที่ด่านไหน
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const APP_SRC = fs.readFileSync(path.join(ROOT, 'attendance/js/app.js'), 'utf8');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ', name); }
  catch (e) { process.exitCode = 1; console.log('  FAIL', name, '\n      ', e.message); }
}

function extractFunction(src, name) {
  const re = new RegExp('^(async )?function ' + name + '\\(', 'm');
  const m = re.exec(src);
  assert.ok(m, 'function ' + name + ' not found in app.js');
  const i = src.indexOf('{', m.index);
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (depth === 0) return src.slice(m.index, j + 1); }
  }
  throw new Error('unbalanced ' + name);
}

const SUBMIT_LEAVE = extractFunction(APP_SRC, 'submitLeave');

// รัน submitLeave() ตัวจริงหนึ่งครั้ง แล้วคืนข้อความเตือนตัวแรกที่ผู้ใช้จะเห็น (null = ไม่เตือนเลย)
// ทุกอย่างที่ฟังก์ชันหยิบจากหน้าจอถูกป้อนผ่าน fields -- ช่องที่ไม่ได้ระบุถือว่าว่าง เหมือนผู้ใช้
// ที่ยังไม่ได้กรอก
function firstWarning(fields) {
  const warnings = [];
  const sandbox = {
    _leaveSubmitInFlight: false,
    _leaveMode: 'days',
    blockIfObserver: () => false,
    // L(en, th) -- ยามนี้อ่านฝั่งอังกฤษ เพื่อให้ assert ไม่ผูกกับการแก้คำไทยในอนาคต
    L: (en) => en,
    showToast: (msg) => { warnings.push(String(msg)); },
    document: {
      getElementById: (id) => (
        Object.prototype.hasOwnProperty.call(fields, id) ? { value: fields[id] } : { value: '' }
      ),
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(SUBMIT_LEAVE + '\nsubmitLeave();', sandbox);
  return warnings.length ? warnings[0] : null;
}

const sickNoReason   = () => firstWarning({ 'leave-form-type': 'sick' });
const annualNoReason = () => firstWarning({ 'leave-form-type': 'annual' });

console.log('ลาป่วยไม่บังคับเหตุผล — ประเภทอื่นยังบังคับ');

test('ลาป่วยที่ไม่กรอกเหตุผล ผ่านด่านเหตุผลไปสะดุดที่ด่านวันที่แทน', () => {
  const w = sickNoReason();
  assert.ok(w, 'คาดว่าจะสะดุดที่ด่านวันที่ แต่ไม่มีคำเตือนเลย');
  assert.ok(!/reason/i.test(w), 'ลาป่วยยังถูกบังคับให้กรอกเหตุผลอยู่: ' + w);
  assert.ok(/start date/i.test(w), 'คาดว่าจะเป็นคำเตือนเรื่องวันที่ แต่ได้: ' + w);
});

test('ลาพักร้อนที่ไม่กรอกเหตุผล ก็ผ่านด่านเหตุผลไปได้เช่นกัน', () => {
  const w = annualNoReason();
  assert.ok(w, 'คาดว่าจะสะดุดที่ด่านวันที่ แต่ไม่มีคำเตือนเลย');
  assert.ok(!/reason/i.test(w), 'ลาพักร้อนยังถูกบังคับให้กรอกเหตุผลอยู่: ' + w);
  assert.ok(/start date/i.test(w), 'คาดว่าจะเป็นคำเตือนเรื่องวันที่ แต่ได้: ' + w);
});

test('ลากิจที่ไม่กรอกเหตุผล ยังถูกบังคับเหมือนเดิม', () => {
  const w = firstWarning({ 'leave-form-type': 'business' });
  assert.ok(w && /reason/i.test(w), 'ลากิจควรยังบังคับเหตุผล แต่ได้: ' + w);
});

test('ลาป่วยที่กรอกเหตุผลมาด้วย ก็ไม่ถูกขวางที่ด่านเหตุผล', () => {
  const w = firstWarning({ 'leave-form-type': 'sick', 'leave-form-reason': 'ไข้สูง' });
  assert.ok(!w || !/reason/i.test(w), 'ไม่ควรถูกขวางที่ด่านเหตุผล แต่ได้: ' + w);
});

test('ด่านนี้ตัดสินจาก "เป็นลากิจหรือไม่" ไม่ใช่จาก "ไม่ใช่ลาป่วย"', () => {
  // สำคัญกว่าที่เห็น: ถ้าเขียนเงื่อนไขเป็น type !== 'sick' (ของเดิมรอบแรก) การเพิ่มลาพักร้อนเข้า
  // ฝั่งไม่บังคับจะต้องไล่เติมชื่อประเภทไปเรื่อยๆ และประเภทใหม่ที่เพิ่มวันหน้าจะตกไปอยู่ฝั่ง
  // "บังคับ" เงียบๆ โดยไม่มีใครตัดสินใจ · เกณฑ์ของเจ้าของคือ "บังคับแค่ลากิจ" ⇒ เงื่อนไขต้องระบุ
  // ลากิจตรงๆ · ค่าว่างตกเป็น 'annual' ตามค่าตั้งต้นของ submitLeave() จึงไม่บังคับ
  const w = firstWarning({});
  assert.ok(w && !/reason/i.test(w), 'ค่าว่างควรตกเป็น annual และไม่บังคับเหตุผล แต่ได้: ' + w);
  const unknown = firstWarning({ 'leave-form-type': 'maternity-ที่ยังไม่มีจริง' });
  assert.ok(unknown && !/reason/i.test(unknown), 'ประเภทที่ไม่ใช่ลากิจไม่ควรถูกบังคับ แต่ได้: ' + unknown);
});

// ---- หน้าจอต้องไม่โกหก: ดอกจันแดงที่แปลว่า "ต้องกรอก" ต้องหายไปเมื่อเลือกลาป่วย ----
//
// ถ้าแก้แค่ตัวตรวจแล้วปล่อยดอกจันไว้ ผู้ใช้จะยังเชื่อว่าต้องกรอก แล้วก็กรอกต่อไปเหมือนเดิม ⇒ สิ่งที่
// เจ้าของขอ (ไม่ต้องถูกบังคับ) จะไม่เกิดขึ้นจริงในสายตาคนใช้ แม้โค้ดจะ "แก้แล้ว" ก็ตาม
// บทเรียนนี้มาจาก memory: วัดสิ่งที่ผู้ใช้เห็น ไม่ใช่ธงภายใน
const SET_LEAVE_TYPE = extractFunction(APP_SRC, 'setLeaveType');

function starDisplayAfterSelecting(type) {
  const els = {};
  const el = (id) => (els[id] = els[id] || { id, value: '', textContent: '', style: {} });
  const sandbox = {
    editingLeaveId: null,
    currentUser: { id: 1, role: 'user' },
    canUseAnnualLeave: () => true,
    annualLeaveLockedToast: () => '',
    approvalRouteNoteText: () => '',
    showToast: () => {},
    L: (en) => en,
    document: {
      getElementById: el,
      documentElement: { getAttribute: () => 'light' },
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(SET_LEAVE_TYPE + `\nsetLeaveType(${JSON.stringify(type)});`, sandbox);
  const star = els['leave-reason-required'];
  assert.ok(star, 'ไม่มี element id="leave-reason-required" -- setLeaveType() ไม่ได้แตะดอกจันเลย');
  return star.style.display;
}

test('เลือกลาป่วย แล้วดอกจัน "ต้องกรอก" หายไปจากหน้าจอ', () => {
  assert.strictEqual(starDisplayAfterSelecting('sick'), 'none');
});

test('เลือกลาพักร้อน ดอกจันก็หายไปเช่นกัน', () => {
  assert.strictEqual(starDisplayAfterSelecting('annual'), 'none');
});

test('เลือกลากิจ ดอกจันกลับมา เพราะลากิจยังบังคับ', () => {
  assert.strictEqual(starDisplayAfterSelecting('business'), '');
});

console.log(`\nsick-leave-reason: ${passed} passed`);
