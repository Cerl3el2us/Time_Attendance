// ลากย่อ-ขยายหน้าต่างข้ามเส้น 768px แล้วตาราง Finalize ต้องสลับรูปแบบ "ครั้งแรก" ด้วย (2026-10-21)
//
// ที่มา: เจ้าของสั่งไว้ตอนออกแบบว่าต้อง "ยืดหยุ่นตามขนาดที่ผู้ใช้งานใช้จริง เพราะบางคนก็ปรับขนาด
// browser เล็ก บางคนก็ปรับใหญ่" ⇒ การย้ายแถวปุ่มต้องเกิดตอนลากเปลี่ยนขนาด ไม่ใช่แค่ตอนเปิดหน้า
//
// ของเดิมเขียนว่า `let _finLastIsMobile = null` แล้วให้ resize ครั้งแรกทำหน้าที่แค่จดค่าปัจจุบัน
// แล้ว return ⇒ **การข้ามเส้นครั้งแรกถูกกลืนหายไปเสมอ** วัดบนเว็บจริงแล้วพังทั้งสองทิศ:
//   - เปิดหน้าที่ 1280 แล้วย่อไป 390: แถวปุ่มของมือถือไม่ถูกสร้าง (0 แถว) และตารางล้น 26px
//   - เปิดหน้าที่ 390 แล้วขยายไป 1280: แถวปุ่มมือถือค้างอยู่ 9 แถว หัวคอลัมน์สถานะกลับมาแสดง
//     แต่เซลล์ข้อมูลถูกย้ายไปแล้ว ⇒ หัวตาราง 10 ช่อง ข้อมูล 9 ช่อง (อาการเดียวกับที่เจ้าของ
//     เคยเจอเองตอนทดลอง และเป็นเหตุผลที่ยาม tests/responsive-table-layout.test.js มีอยู่)
//
// ยามนี้ดึง "โค้ดจริง" ออกจาก app.js มารันใน sandbox ไม่ใช่จับข้อความ -- ถ้าใครเขียนตัวดักใหม่
// ด้วยรูปแบบอื่นแต่ยังกลืนการข้ามครั้งแรก ยามนี้ก็ยังจับได้
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const APP = fs.readFileSync(path.join(ROOT, 'attendance/js/app.js'), 'utf8');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ', name); }
  catch (e) { process.exitCode = 1; console.log('  FAIL', name, '\n      ', e.message); }
}

// ตัดบล็อกออกมาโดยนับวงเล็บปีกกาให้คู่กัน ไม่ใช่หาเครื่องหมายปิดตัวแรก
// (บทเรียนเดิมของโปรเจกต์: การหาเครื่องหมายปิดตัวแรกเคยทำให้ย้ายบล็อกผิดที่)
function blockAround(src, needle) {
  const at = src.indexOf(needle);
  assert.ok(at > 0, `หาไม่เจอใน app.js: ${needle}`);
  const open = src.indexOf('{', src.lastIndexOf('if (', at));
  let depth = 1, i = open + 1;
  while (i < src.length && depth > 0) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') depth--;
    i++;
  }
  return src.slice(src.lastIndexOf('if (', at), i);
}

const constLine = /const FINALIZE_MOBILE_MAX_WIDTH = \d+;/.exec(APP);
assert.ok(constLine, 'ไม่พบ FINALIZE_MOBILE_MAX_WIDTH ใน app.js');
const fnStart = APP.indexOf('function _finalizeMobileLayout()');
assert.ok(fnStart > 0, 'ไม่พบ _finalizeMobileLayout() ใน app.js');
const fnSrc = APP.slice(fnStart, APP.indexOf('\n}', fnStart) + 2);
const listenerSrc = blockAround(APP, '_finLastIsMobile');

// สร้างหน้าต่างปลอมที่ความกว้างเปลี่ยนได้ แล้วรันโค้ดจริงบนนั้น
function run(startWidth) {
  const state = { width: startWidth, renders: 0, handlers: [] };
  const fakeWindow = {
    addEventListener(ev, fn) { if (ev === 'resize') state.handlers.push(fn); },
    matchMedia(q) {
      const m = /max-width:\s*(\d+)px/.exec(q);
      const limit = m ? +m[1] : 0;
      return { matches: state.width <= limit };
    }
  };
  const sandbox = {
    window: fakeWindow,
    currentPage: 'finalize',
    renderFinalize() { state.renders++; }
  };
  vm.runInNewContext(`${constLine[0]}\n${fnSrc}\n${listenerSrc}`, sandbox);
  state.resizeTo = w => { state.width = w; state.handlers.forEach(h => h()); };
  return state;
}

console.log('Finalize: ลากย่อ-ขยายข้าม 768px แล้วต้องวาดใหม่ รวมถึงครั้งแรก');

test('เปิดหน้าที่จอคอมฯ แล้วย่อข้ามเส้นครั้งแรก ต้องวาดใหม่', () => {
  const s = run(1280);
  s.resizeTo(390);
  assert.strictEqual(s.renders, 1,
    'การข้ามเส้น 768px ครั้งแรกไม่ทำให้วาดใหม่ ⇒ ผู้ใช้ที่เปิดหน้าบนจอคอมฯ แล้วย่อหน้าต่าง' +
    ' จะเห็นตารางแบบจอคอมฯ ค้างอยู่บนจอแคบ (วัดบนเว็บจริง: แถวปุ่มมือถือ 0 แถว ตารางล้น 26px)');
});

test('เปิดหน้าที่มือถือ แล้วขยายข้ามเส้นครั้งแรก ต้องวาดใหม่', () => {
  const s = run(390);
  s.resizeTo(1280);
  assert.strictEqual(s.renders, 1,
    'การข้ามเส้นครั้งแรกจากมือถือไปจอคอมฯ ไม่ทำให้วาดใหม่ ⇒ แถวปุ่มของมือถือค้างอยู่' +
    ' และหัวตารางกับข้อมูลจะเหลื่อมกัน (วัดบนเว็บจริง: หัว 10 ช่อง ข้อมูล 9 ช่อง)');
});

test('ย่อ-ขยายโดยไม่ข้ามเส้น ต้องไม่วาดใหม่ (ไม่งั้นตารางจะวาดรัวๆ ระหว่างลาก)', () => {
  const s = run(1280);
  s.resizeTo(1100);
  s.resizeTo(900);
  s.resizeTo(1920);
  assert.strictEqual(s.renders, 0,
    'วาดใหม่ทั้งที่ยังอยู่ฝั่งเดิมของเส้น 768px ⇒ การลากหน้าต่างจะวาดตารางซ้ำทุกพิกเซล');
});

test('ข้ามไป-กลับ ต้องวาดใหม่ทุกครั้งที่ข้าม', () => {
  const s = run(1280);
  s.resizeTo(500);
  s.resizeTo(1280);
  s.resizeTo(400);
  assert.strictEqual(s.renders, 3, 'การข้ามเส้นแต่ละครั้งต้องวาดใหม่หนึ่งครั้ง');
});

test('ถ้าผู้ใช้ไม่ได้อยู่หน้า Finalize ต้องไม่วาดใหม่', () => {
  const state = { width: 1280, renders: 0, handlers: [] };
  const sandbox = {
    window: {
      addEventListener(ev, fn) { if (ev === 'resize') state.handlers.push(fn); },
      matchMedia(q) { const m = /max-width:\s*(\d+)px/.exec(q); return { matches: state.width <= (m ? +m[1] : 0) }; }
    },
    currentPage: 'dashboard',
    renderFinalize() { state.renders++; }
  };
  vm.runInNewContext(`${constLine[0]}\n${fnSrc}\n${listenerSrc}`, sandbox);
  state.width = 390;
  state.handlers.forEach(h => h());
  assert.strictEqual(state.renders, 0, 'วาดตาราง Finalize ใหม่ทั้งที่ผู้ใช้อยู่หน้าอื่น');
});

console.log(`\nfinalize-resize-switch: ${passed} passed`);
