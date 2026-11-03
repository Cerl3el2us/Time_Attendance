// ช่องวันที่ที่ตั้งใจล็อก ต้องล็อกได้จริงหลัง flatpickr เข้ามาแทนที่ (2026-11-03)
//
// ที่มา: ไล่บั๊ก "ปุ่มแก้ไขเวลาใช้งานไม่ได้" เมื่อ 2026-11-03 แล้วเจอของแถมที่ร้ายกว่า —
// ช่อง "วันที่ที่ต้องการแก้ไข" (`#tc-date`) ถูกตรึงไว้ให้เป็นวันของแถวที่กด ✏️ โดยใส่
// `pointer-events:none` เป็น inline style ไว้ที่ตัว input แต่ **ล็อกไม่อยู่จริง**
//
// **ทำไมถึงล็อกไม่อยู่:** `initDatePickers()` ผูก flatpickr แบบ `altInput:true` ให้ทุก
// `input[type="date"]` ที่มี id และไม่ได้อยู่ใน `RESTRICTED_DATE_IDS` · flatpickr จะ
//   1. เปลี่ยน input ตัวจริงเป็น `type="hidden"` (ยังถือค่า ISO ไว้ให้โค้ดอ่าน)
//   2. **สร้าง input ตัวใหม่** วางไว้ข้างๆ เพื่อให้ผู้ใช้เห็นและพิมพ์ ในรูปแบบ d/m/Y
// input ตัวใหม่นั้นสร้างจาก `createElement` ⇒ **ไม่สืบทอด inline style ของตัวเดิมเลย**
// ⇒ `pointer-events:none` หายไป ⇒ ช่องที่ผู้ใช้เห็นคลิกได้ เปิดปฏิทินได้ และเปลี่ยนวันได้
//
// **วัดเองในเบราว์เซอร์ 2026-11-03** (เสิร์ฟ worktree ที่ 127.0.0.1): กด ✏️ ที่แถว 15/10/2026
// แล้วคลิกช่องวันที่ เลือกวันที่ 28 ในปฏิทิน — ค่าที่จะถูกส่งไปกับคำร้องเปลี่ยนจาก
// `2026-10-15` เป็น `2026-10-28` โดยไม่มีอะไรเตือน ⇒ ยื่นคำร้องผิดวันได้โดยไม่ตั้งใจ
//
// **กลไกที่เลือกใช้ และทำไมไม่ใช่อย่างอื่น** (ทดลองกับ flatpickr 4.6.13 ในเบราว์เซอร์จริง
// ก่อนเลือก ไม่ได้เดาจากเอกสาร):
//   - `disabled` บน input ตัวเดิม → flatpickr คัดลอกไปให้ช่องใหม่ด้วย (`altInput.disabled`
//     = `input.disabled` ในขั้น setupInputs) · วัดได้ `altDisabled: true` ⇒ **ใช้ได้**
//   - `readonly` → ไม่ช่วย เพราะ flatpickr ตั้ง readOnly ให้ทุกช่องอยู่แล้วเมื่อ
//     `allowInput:false` และ `attachTypedDateEntry()` ก็สั่ง `el.readOnly = false` ทับทีหลัง
//   - ใส่ `tc-date` ลงใน `RESTRICTED_DATE_IDS` → ผิดความหมายของลิสต์นั้น (มันแปลว่า
//     "มีฟังก์ชัน init ของตัวเอง" ซึ่งช่องนี้ไม่มี) และจะทำให้ช่องกลับไปเป็น date input
//     ของเบราว์เซอร์ ซึ่งรูปแบบวันที่ขึ้นกับ locale ของเครื่อง ไม่ใช่ d/m/Y ที่แอปนี้ใช้ทั้งแอป
//
// `attachTypedDateEntry()` แตะแค่ `readOnly` ไม่เคยแตะ `disabled` ⇒ กลไกนี้ไม่ถูกปลดทีหลัง
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'attendance/index.html'), 'utf8');
const APP_SRC = fs.readFileSync(path.join(ROOT, 'attendance/js/app.js'), 'utf8');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ', name); }
  catch (e) { process.exitCode = 1; console.log('  FAIL', name, '\n      ', e.message); }
}

// <input ...> ทุกตัวใน index.html พร้อมข้อความเต็มของแท็ก
function inputTags() {
  return HTML.match(/<input\b[^>]*>/g) || [];
}
const attrOf = (tag, name) => {
  const m = new RegExp(name + '\\s*=\\s*"([^"]*)"', 'i').exec(tag);
  return m ? m[1] : null;
};
const hasBareAttr = (tag, name) =>
  new RegExp('\\s' + name + '(?=[\\s>=])', 'i').test(tag);

console.log('ช่องวันที่ที่ตั้งใจล็อก ต้องล็อกได้จริงหลัง flatpickr เข้ามาแทนที่');

test('#tc-date ถูกล็อกด้วย disabled ไม่ใช่แค่ pointer-events:none', () => {
  const tag = inputTags().find(t => attrOf(t, 'id') === 'tc-date');
  assert.ok(tag, 'ไม่พบ input#tc-date ใน index.html');
  assert.ok(
    hasBareAttr(tag, 'disabled') || attrOf(tag, 'disabled') !== null,
    'ช่องวันที่ของโมดัลแก้ไขเวลาไม่มี disabled ⇒ flatpickr สร้างช่องใหม่ที่คลิกได้ ' +
    'และผู้ใช้เปลี่ยนวันของคำร้องได้ ทั้งที่วันถูกกำหนดจากแถวที่กด ✏️ มาแล้ว\n' +
    '       แท็กปัจจุบัน: ' + tag
  );
});

test('ทุกช่องวันที่ที่เขียน pointer-events:none ไว้ ต้องมี disabled คู่กันเสมอ', () => {
  const offenders = inputTags()
    .filter(t => /type\s*=\s*"date"/i.test(t))
    .filter(t => /pointer-events\s*:\s*none/i.test(attrOf(t, 'style') || ''))
    .filter(t => !(hasBareAttr(t, 'disabled') || attrOf(t, 'disabled') !== null))
    .map(t => attrOf(t, 'id') || '(ไม่มี id)');
  assert.deepStrictEqual(offenders, [],
    'ช่องวันที่เหล่านี้พึ่ง pointer-events:none อย่างเดียว ซึ่ง flatpickr ไม่คัดลอกไปยัง\n' +
    '       ช่องที่มันสร้างขึ้นมาแทน ⇒ ล็อกไม่อยู่จริง: ' + offenders.join(', '));
});

test('โค้ดยังอ่าน-เขียนวันที่ผ่าน #tc-date ตัวเดิม (disabled จึงไม่ทำให้ค่าหาย)', () => {
  // input ที่ disabled จะไม่ถูกส่งไปกับการ submit ฟอร์มแบบปกติ -- ที่นี่ปลอดภัยเพราะทั้งสองทาง
  // อ่าน/เขียนด้วย JS ผ่าน .value ไม่ได้พึ่งการ submit ของเบราว์เซอร์ ยามข้อนี้ตรึงข้อเท็จจริงนั้นไว้
  assert.ok(/getElementById\('tc-date'\)\.value\s*=/.test(APP_SRC),
    'ไม่พบการเขียนค่าลง #tc-date ด้วย .value แล้ว ⇒ ต้องทบทวนว่า disabled ยังปลอดภัยไหม');
  assert.ok(/const\s+date\s*=\s*document\.getElementById\('tc-date'\)\.value/.test(APP_SRC),
    'ไม่พบการอ่านค่าจาก #tc-date ด้วย .value แล้ว ⇒ ต้องทบทวนว่า disabled ยังปลอดภัยไหม');
  // ขอบเขตของโมดัล: จากแท็กเปิดของมัน ถึง .modal-overlay ตัวถัดไป ซึ่งเป็นพี่น้องระดับเดียวกัน
  const start = HTML.indexOf('<div class="modal-overlay" id="time-correction-modal"');
  assert.ok(start !== -1, 'ไม่พบโมดัลแก้ไขเวลาใน index.html');
  const after = HTML.indexOf('<div class="modal-overlay"', start + 1);
  const modalHtml = HTML.slice(start, after === -1 ? HTML.length : after);
  assert.ok(modalHtml.includes('id="tc-date"'), 'ขอบเขตโมดัลที่ตัดมาไม่ครอบ #tc-date');
  assert.ok(!/<form\b/i.test(modalHtml),
    'โมดัลนี้มี <form> ครอบอยู่ ⇒ input ที่ disabled จะไม่ถูกส่งไปกับการ submit ' +
    'ต้องตรวจซ้ำว่าค่าวันที่ยังไปถึงปลายทาง');
});

test('tc-date ยังไม่ถูกยัดเข้า RESTRICTED_DATE_IDS (ต้องคงรูปแบบวันที่ d/m/Y ของแอป)', () => {
  const m = /const RESTRICTED_DATE_IDS = new Set\(\[([\s\S]*?)\]\)/.exec(APP_SRC);
  assert.ok(m, 'ไม่พบ RESTRICTED_DATE_IDS ใน app.js');
  assert.ok(!m[1].includes("'tc-date'"),
    'tc-date ถูกใส่ใน RESTRICTED_DATE_IDS ⇒ flatpickr จะไม่ผูกช่องนี้ และวันที่จะแสดง\n' +
    '       ตาม locale ของเบราว์เซอร์แทน d/m/Y ที่แอปนี้ใช้ทั้งแอป');
});

console.log(`\n${passed} passed, ${process.exitCode ? 'บางข้อล้มเหลว' : '0 failed'}`);
