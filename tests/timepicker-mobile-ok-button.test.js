// ปุ่ม "✓ ตกลง" ของตัวเลือกเวลา ต้องไม่ระเบิดบนมือถือ (2026-10-21)
//
// อาการ: เปิด modal ที่มีช่องเวลาบนจอมือถือ ⇒ `TypeError: Cannot read properties of undefined
// (reading 'appendChild')` **12 ครั้งต่อการเปิดหนึ่งครั้ง** (วัดเองที่ viewport 375px เทียบกับ
// เดสก์ท็อปที่ได้ 0) · บนเดสก์ท็อปไม่มีอาการเลย
//
// ต้นเหตุ: flatpickr ในโหมดมือถือไม่สร้างปฏิทินของตัวเอง มันยกให้ตัวเลือกเวลาของระบบปฏิบัติการ
// แทน ⇒ `fp.calendarContainer` เป็น undefined · แต่ onReady ของเรา (initDatePickers ใน app.js)
// แปะปุ่ม "✓ ตกลง" ลงบนมันทุกครั้งโดยไม่เคยถามว่ามีอยู่ไหม เพราะตอนเขียนปุ่มนี้ (2026-08-06)
// มองจากเดสก์ท็อปซึ่งมีปฏิทินเสมอ
//
// ผลกระทบที่วัดได้จริง และที่วัดแล้วพบว่า "ไม่ใช่": ช่องเวลาทั้ง 6 แถวยัง**ได้ตัวเลือกครบ** ทั้งบน
// มือถือและเดสก์ท็อป ⇒ ผู้ใช้ยังใช้งานได้ · สิ่งที่เสียคือ console เต็มไปด้วย error ปลอม ซึ่ง
// โปรเจกต์นี้มีบทเรียนของตัวเองแล้วว่าอันตราย: 2026-10-17 บั๊ก WebSocket จริงถูกมองข้ามทั้งวัน
// เพราะเสียงรบกวนแบบนี้ (ดู docs/STATUS_CLOSED.md หัวข้อ GET /api/mileage-open)
//
// ยามนี้เรียก onReady ตัวจริงที่ดึงออกมาจาก app.js ด้วย fp สองแบบ: แบบมือถือ (ไม่มี
// calendarContainer) และแบบเดสก์ท็อป (มี) -- ไม่ได้ค้นหาข้อความในซอร์ส
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

// ดึงตัวฟังก์ชัน onReady ของตัวเลือก "เวลา" ออกมาตรงๆ จากซอร์ส แล้วคอมไพล์เป็นฟังก์ชันจริง
function extractTimeOnReady(src) {
  const marker = 'onReady: (selectedDates, dateStr, fp) => {';
  const a = src.indexOf(marker);
  assert.ok(a > 0, 'ไม่พบ onReady ของตัวเลือกเวลาใน app.js (ถ้าโครงสร้างเปลี่ยน ยามนี้ต้องตามแก้)');
  const open = src.indexOf('{', a + marker.length - 1);
  let depth = 0;
  for (let j = open; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (depth === 0) return src.slice(a + 'onReady: '.length, j + 1); }
  }
  throw new Error('วงเล็บของ onReady ไม่สมดุล');
}

const ON_READY_SRC = extractTimeOnReady(APP_SRC);

// เรียก onReady ด้วย fp ที่กำหนดเอง แล้วคืนว่าระเบิดไหม และปุ่มถูกแปะหรือเปล่า
function runOnReady({ withCalendar }) {
  const appended = [];
  const calendarContainer = withCalendar ? { appendChild: (el) => appended.push(el) } : undefined;
  const made = [];
  const sandbox = {
    L: (en) => en,
    document: {
      createElement: (tag) => {
        const el = { tagName: tag, type: '', className: '', textContent: '', onclick: null };
        made.push(el);
        return el;
      },
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(`globalThis.__onReady = ${ON_READY_SRC};`, sandbox);
  let threw = null;
  try {
    sandbox.__onReady([], '', { calendarContainer, close: () => {} });
  } catch (e) { threw = e; }
  return { threw, appended, made };
}

console.log('ตัวเลือกเวลา: ปุ่ม "ตกลง" บนมือถือ');

test('โหมดมือถือ (ไม่มีปฏิทินของตัวเอง) ต้องไม่ระเบิด', () => {
  const r = runOnReady({ withCalendar: false });
  assert.strictEqual(r.threw, null,
    'onReady ระเบิดเมื่อไม่มี calendarContainer: ' + (r.threw && r.threw.message));
});

test('โหมดมือถือ ไม่แปะปุ่มไปไว้ที่ไหนทั้งนั้น', () => {
  const r = runOnReady({ withCalendar: false });
  assert.strictEqual(r.appended.length, 0);
});

test('โหมดเดสก์ท็อป ยังได้ปุ่ม "ตกลง" เหมือนเดิม', () => {
  const r = runOnReady({ withCalendar: true });
  assert.strictEqual(r.threw, null, 'ไม่ควรระเบิดบนเดสก์ท็อป');
  assert.strictEqual(r.appended.length, 1, 'ปุ่มตกลงต้องถูกแปะลงปฏิทิน 1 ปุ่ม');
  assert.strictEqual(r.appended[0].className, 'flatpickr-time-ok-btn');
  assert.strictEqual(typeof r.appended[0].onclick, 'function', 'ปุ่มต้องกดแล้วปิดได้');
});

console.log(`\ntimepicker-mobile-ok-button: ${passed} passed`);
