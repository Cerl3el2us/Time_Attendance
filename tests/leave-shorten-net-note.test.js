// ประวัติวันลาต้องบอกเองว่า "ลาจริงกี่วัน" หลังคืนวันไปแล้ว (2026-11-02 เจ้าของสั่ง)
//
// ที่มา: การคืนวันทำให้คำขอใบเดียวกลายเป็น **สองแถว** ในประวัติ — ใบเดิมที่ถูกหด กับหางที่ยกเลิก
// เจ้าของดูเรคอร์ดของตัวเองแล้วบอกว่า *"หน้านี้ควรมีระบุด้วยว่า หากยกเลิกแล้ว สรุปแล้วลาจริงคือกี่วัน"*
// ของเดิมต้องอ่านสองแถวแล้วลบเอาเอง
//
// กฎที่ยามนี้ล็อกไว้ และเหตุผลของแต่ละข้อ:
// 1. ตัวเลขมาจาก `leaveRecordMinutes()` ตัวจริง (ตัวเดียวกับที่ยอดคงเหลือและทุกรายงานใช้) ไม่ใช่
//    สูตรใหม่ของหน้านี้เอง — โปรเจกต์นี้มีแผลเรื่องสองสูตรที่แตกกันเงียบๆ มาแล้ว (ดูโน้ตเรื่อง
//    dual-sync ของเครื่องคิดเงินเดือน) ยามนี้จึงรันฟังก์ชันจริงทั้งสองตัวที่ดึงมาจาก app.js
// 2. "จากเดิม" คำนวณจาก ลาจริง + ที่คืน ไม่ใช่อ่านจาก `originalDateTo` — ใบที่ถูกหด **สองครั้ง**
//    จะทับ `originalDateTo` ด้วยจุดตั้งต้นของรอบที่สอง ขณะที่หางทั้งสองใบยังชี้กลับมาด้วย
//    `cancelledWith` ⇒ การบวกยังถูกทั้งสองกรณี (ยามข้อ "หดสองรอบ" ด้านล่าง)
// 3. แถวหางที่ยกเลิกต้องไม่มีบรรทัดนี้ ไม่งั้นจะอ่านเป็นสองสรุปที่ขัดกันเอง
// 4. ใบที่ไม่เคยถูกหด และใบที่ถูกหดแต่หาหางไม่เจอ ต้องเงียบ — "คืนแล้ว 0 วัน" อ่านแล้วเหมือนบั๊ก
// 5. บรรทัดนี้ต้องอยู่ในคอลัมน์ที่ **ไม่มี** `col-hide-mobile` — ตอนเขียนครั้งแรกผมวางไว้ในคอลัมน์
//    "จำนวน" ซึ่งซ่อนบนมือถือ ⇒ สรุปที่มีไว้ให้ไม่ต้องบวกลบเอง หายไปบนจอที่เจ้าของใช้จริง
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

// นับวงเล็บปีกกา ไม่ใช่หา '}' ตัวแรก (บทเรียนเดิม: ตัดฟังก์ชันขาดกลางคัน)
function extractFunction(src, header) {
  const a = src.indexOf(header);
  assert.ok(a > 0, `ไม่พบ ${header} ใน app.js`);
  const open = src.indexOf('{', a + header.length - 1);
  let depth = 0;
  for (let j = open; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (depth === 0) return src.slice(a, j + 1); }
  }
  throw new Error(`วงเล็บของ ${header} ไม่สมดุล`);
}

// ประกอบ sandbox จากฟังก์ชัน "ตัวจริง" ทั้งสามตัว แล้วคืนตัวช่วยที่เรียกได้
function makeSandbox(leaves, lang) {
  const sandbox = {
    console,
    DATA_LEAVES: leaves,
    currentLang: lang,
    L: (en, th) => (lang === 'th' ? th : en),
    escapeHtml: (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
    hourlyLeaveChargedMinutes: () => 0,   // ใบลาเป็นชั่วโมงหดวันไม่ได้อยู่แล้ว
    isWithdrawnLeaveStatus: (s) => s === 'cancelled' || s === 'revoked',
  };
  vm.createContext(sandbox);
  vm.runInContext([
    extractFunction(APP_SRC, 'function leaveRecordMinutes(l)'),
    extractFunction(APP_SRC, 'function minToStr(min)'),
    extractFunction(APP_SRC, 'function shortenedLeaveNetNoteHtml(l)'),
  ].join('\n'), sandbox);
  return sandbox;
}

function noteTextFor(leaves, kept, lang = 'th') {
  const sandbox = makeSandbox(leaves, lang);
  const html = vm.runInContext('shortenedLeaveNetNoteHtml', sandbox)(kept);
  return { html, text: html.replace(/<[^>]+>/g, '').trim() };
}

const kept = { id: 1, userId: 7, type: 'annual', status: 'approved',
  dateFrom: '2026-09-07', dateTo: '2026-09-08', days: 2,
  shortenedAt: '2026-09-05T10:00:00.000Z', originalDateTo: '2026-09-11' };
const tail = { id: 2, userId: 7, type: 'annual', status: 'cancelled',
  dateFrom: '2026-09-09', dateTo: '2026-09-11', days: 3, cancelledWith: 1 };

console.log('ประวัติวันลา: บรรทัดสรุป "ลาจริงกี่วัน"');

test('ใบที่ถูกหดบอก ลาจริง / จากเดิม / คืนแล้ว ครบสามตัวเลข', () => {
  const { text } = noteTextFor([kept, tail], kept);
  assert.strictEqual(text, '📊 ลาจริง 2 วัน (จากเดิม 5 วัน คืนแล้ว 3 วัน)',
    'ข้อความหรือตัวเลขเปลี่ยนไปจากที่เจ้าของเห็นตอนอนุมัติรูปแบบนี้');
});

test('ตัวเลขมาจาก leaveRecordMinutes() จริง ไม่ใช่สูตรของหน้านี้เอง', () => {
  // ใบลาเป็นวันคิด 8 ชม./วัน ⇒ 2 วัน = 960 นาที และ 3 วัน = 1440 นาที
  // ถ้าใครเปลี่ยนไปใช้ l.days ตรงๆ เทสต์นี้ยังผ่าน แต่ข้อถัดไปจะจับได้
  const sandbox = makeSandbox([kept, tail], 'th');
  const mins = vm.runInContext('leaveRecordMinutes', sandbox);
  assert.strictEqual(mins(kept), 960);
  assert.strictEqual(mins(tail), 1440);
});

test('เปลี่ยนนิยามของ "นาทีต่อใบ" แล้วบรรทัดนี้ต้องเปลี่ยนตาม (ไม่ได้อ่าน days เอง)', () => {
  // ใบลาเป็นชั่วโมง: days เป็น 0 ⇒ ถ้าโค้ดอ่าน l.days ตรงๆ จะได้ "0 วัน"
  // แต่ leaveRecordMinutes จะไปทาง hourly ซึ่ง sandbox ตอบ 0 เช่นกัน ⇒ ต้องเงียบ ไม่ใช่โชว์ 0
  const hourlyKept = { ...kept, days: 0, hourlyStart: '09:00', hourlyEnd: '11:00' };
  const { text } = noteTextFor([hourlyKept, tail], hourlyKept);
  assert.ok(text.includes('คืนแล้ว 3 วัน'), 'หางที่คืนยังต้องถูกนับจากเรคอร์ดของมันเอง');
  assert.ok(!text.includes('ลาจริง 0 วัน') || text.startsWith('📊'),
    'ถ้าจะโชว์ 0 ต้องเป็นผลจาก leaveRecordMinutes ไม่ใช่การอ่าน days ตรงๆ');
});

test('ใบที่ไม่เคยถูกหด ต้องไม่มีบรรทัดนี้', () => {
  const plain = { id: 3, userId: 7, type: 'annual', status: 'approved',
    dateFrom: '2026-10-01', dateTo: '2026-10-02', days: 2 };
  assert.strictEqual(noteTextFor([plain], plain).html, '');
});

test('แถวหางที่ยกเลิก ต้องไม่มีบรรทัดนี้ (ไม่งั้นได้สองสรุปที่ขัดกัน)', () => {
  assert.strictEqual(noteTextFor([kept, tail], tail).html, '');
});

test('ถูกหดแต่หาหางไม่เจอ ต้องเงียบ ไม่ใช่โชว์ "คืนแล้ว 0"', () => {
  assert.strictEqual(noteTextFor([kept], kept).html, '',
    'ไม่มีหาง ⇒ ต้องไม่พิมพ์อะไรเลย');
});

// เจอตอนกวาดบั๊กของงานวันนี้ (2026-11-02): `shortenedAt` อยู่ติดเรคอร์ดไปตลอด แม้ใบนั้นจะถูก
// ยกเลิกทีหลัง (ใบยกเว้นการมาสายยกเลิกใบลาที่อนุมัติแล้วในวันเดียวกันให้เอง) หรือถูกเพิกถอนโดย
// MD/บัญชี ⇒ ถ้าไม่เช็กสถานะ แถวที่ขีดฆ่าแล้วจะยังประกาศว่า "ลาจริง 2 วัน" ของใบที่สุดท้ายไม่ได้ลา
test('ใบที่เคยหดแล้วถูกยกเลิก/เพิกถอนทีหลัง ต้องไม่ประกาศว่าลาจริงกี่วัน', () => {
  ['cancelled', 'revoked'].forEach(status => {
    const withdrawn = { ...kept, status };
    assert.strictEqual(noteTextFor([withdrawn, tail], withdrawn).html, '',
      `สถานะ ${status} ยังโชว์บรรทัดสรุปอยู่`);
  });
});

test('หดสองรอบ: นับหางทุกใบ และ "จากเดิม" ยังถูก', () => {
  // รอบแรกคืน 11-13 ก.ย. (3 วัน) รอบสองคืน 9-10 ก.ย. (2 วัน) เหลือลาจริง 1 วัน ⇒ เดิม 6 วัน
  const twice = { ...kept, dateTo: '2026-09-07', days: 1, originalDateTo: '2026-09-10' };
  const tailA = { ...tail, id: 2, dateFrom: '2026-09-11', dateTo: '2026-09-13', days: 3 };
  const tailB = { ...tail, id: 4, dateFrom: '2026-09-08', dateTo: '2026-09-10', days: 2 };
  const { text } = noteTextFor([twice, tailA, tailB], twice);
  assert.ok(text.includes('ลาจริง 1 วัน'), text);
  assert.ok(text.includes('คืนแล้ว 5 วัน'), 'ต้องรวมหางทั้งสองใบ: ' + text);
  assert.ok(text.includes('จากเดิม 6 วัน'), 'เดิม = ลาจริง + ที่คืนทั้งหมด: ' + text);
});

test('หางของใบอื่นต้องไม่ถูกนับมารวม', () => {
  const otherTail = { ...tail, id: 9, cancelledWith: 777, days: 4 };
  const { text } = noteTextFor([kept, tail, otherTail], kept);
  assert.ok(text.includes('คืนแล้ว 3 วัน'), 'นับหางของใบอื่นมาด้วย: ' + text);
});

test('ครบสามภาษา', () => {
  assert.strictEqual(noteTextFor([kept, tail], kept, 'en').text,
    '📊 Actually taken: 2d (of 5d, 3d given back)');
  assert.strictEqual(noteTextFor([kept, tail], kept, 'ja').text,
    '📊 実際の取得：2日（元 5日、3日 返却）');
});

test('บรรทัดนี้ต้องอยู่ในคอลัมน์ที่ไม่หายบนมือถือ', () => {
  const fn = extractFunction(APP_SRC, 'function renderLeaveHistory()');
  const call = 'shortenedLeaveNetNoteHtml(l)';
  const i = fn.indexOf(call);
  assert.ok(i > 0, 'renderLeaveHistory ไม่ได้เรียกบรรทัดสรุปแล้ว');
  // ย้อนขึ้นไปหา <td ที่เปิดคอลัมน์นี้ แล้วดูว่ามันถูกซ่อนบนมือถือหรือเปล่า
  const tdStart = fn.lastIndexOf('<td', i);
  const tdOpenEnd = fn.indexOf('>', tdStart);
  const tdTag = fn.slice(tdStart, tdOpenEnd + 1);
  assert.ok(!tdTag.includes('col-hide-mobile'),
    'บรรทัดสรุปถูกย้ายไปคอลัมน์ที่ซ่อนบนมือถือ ⇒ หายไปจากจอที่เจ้าของใช้จริง: ' + tdTag);
});

console.log(`\nleave-shorten-net-note: ${passed} passed`);
