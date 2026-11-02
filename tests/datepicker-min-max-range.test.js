// ช่องวันที่ที่ประกาศ min/max ต้องได้ปฏิทินที่ล็อกช่วงนั้นจริง (2026-11-02)
//
// อาการ: โมดัล "กลับมาทำงานก่อนกำหนด" ของใบลา 19–24 พ.ย. เปิดปฏิทินขึ้นมาแล้ว **ทุกวันของเดือน
// เป็นสีดำกดได้หมด** ทั้งที่กฎอนุญาตแค่ 20–24 พ.ย. · กดวันที่ 5 พ.ย. ได้ แล้วค่อยไปรู้ตอนที่ปุ่ม
// "ยืนยัน" ถูกปิดพร้อมข้อความว่าเลือกนอกช่วง ⇒ ทางตันที่ผู้ใช้ต้องเดาเอง
//
// ต้นเหตุ: `shortenLeave()` ตั้ง `input.min` / `input.max` ไว้ถูกต้องแล้ว แต่ **flatpickr ไม่ได้อ่าน
// attribute สองตัวนั้นเอง** มันรับช่วงวันผ่าน config `minDate` / `maxDate` เท่านั้น ซึ่ง
// `initDatePickers()` ไม่เคยส่งให้ ⇒ ข้อจำกัดมีอยู่แค่ในด่านตอนกดยืนยันกับฝั่งเซิร์ฟเวอร์
// (วัดเองในเบราว์เซอร์ 2026-11-02: พฤศจิกายนมี 30 วัน ถูกทำเป็นวันเทา 0 วัน และ
// `fp.config.minDate` / `maxDate` เป็น null ทั้งคู่ ทั้งที่ attribute เป็น 2026-11-20 / 2026-11-24)
//
// ทำไมแก้ที่ `initDatePickers()` ไม่ใช่ที่จุดเรียกเดียว: picker ถูก destroy แล้วสร้างใหม่ทุกครั้งที่
// สลับภาษา หรือเมื่อ MutationObserver เห็นช่องใหม่ ⇒ ถ้าช่วงวันถูกส่งตอนเปิดโมดัลครั้งเดียว มันจะ
// หายไปเงียบๆ ในการสร้างใหม่ · การอ่านจาก DOM ทำให้ช่วงวันกลับมาเองทุกครั้ง และ `fp.isEnabled()`
// ใน commitTypedDate() ก็เริ่มกันวันที่ "พิมพ์" นอกช่วงให้ด้วยโดยไม่ต้องเขียนด่านซ้ำ
//
// ขอบเขตที่ตั้งใจ: ตอนเขียนยามนี้ ทั้งแอปมีที่เดียวที่ตั้ง min/max บนช่องวันที่ คือ shortenLeave()
// ⇒ กฎนี้จับช่องเดียว ไม่ได้เปลี่ยนพฤติกรรมช่องอื่น และช่องใหม่ในอนาคตจะ "สมัครใจ" เข้ากฎเองด้วย
// การตั้ง attribute · ยามข้อที่ 2 ด้านล่างล็อกไว้ว่าช่องที่ไม่ประกาศ min/max ต้องไม่ถูกจำกัด
//
// ยามนี้รัน initDatePickers() ตัวจริงที่ดึงออกมาจาก app.js ด้วย flatpickr ปลอมที่บันทึก config
// ที่ได้รับ -- ไม่ได้ค้นหาข้อความในซอร์ส (ยกเว้นข้อสุดท้ายที่ตรวจ "ลำดับ" ซึ่งดูจากซอร์สอย่างเดียว)
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

// ดึงตัว initDatePickers ออกมาทั้งฟังก์ชัน โดยนับวงเล็บปีกกา ไม่ใช่หาเครื่องหมายปิดตัวแรก
// (บทเรียนเดิมของโปรเจกต์: การหา '}' ตัวแรกตัดฟังก์ชันขาดกลางคัน)
function extractFunction(src, header) {
  const a = src.indexOf(header);
  assert.ok(a > 0, `ไม่พบ ${header} ใน app.js (ถ้าโครงสร้างเปลี่ยน ยามนี้ต้องตามแก้)`);
  const open = src.indexOf('{', a + header.length - 1);
  let depth = 0;
  for (let j = open; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (depth === 0) return src.slice(a, j + 1); }
  }
  throw new Error(`วงเล็บของ ${header} ไม่สมดุล`);
}

const INIT_SRC = extractFunction(APP_SRC, 'function initDatePickers()');

// ช่องวันที่ปลอม: มีเท่าที่ initDatePickers แตะจริง
function fakeInput(id, attrs = {}) {
  const store = { ...attrs };
  return {
    id,
    _flatpickr: null,
    classList: { add() {} },
    getAttribute: (k) => (k in store ? store[k] : null),
    setAttribute: (k, v) => { store[k] = v; },
    remove() {},
  };
}

// รัน initDatePickers ตัวจริงกับชุดช่องที่กำหนด แล้วคืน config ที่ flatpickr ได้รับรายช่อง
function runInit(dateInputs) {
  const calls = [];
  const sandbox = {
    console,
    flatpickr: (inp, cfg) => { calls.push({ id: inp.id, cfg }); return { destroy() {} }; },
    currentLang: 'th',
    L: (en) => en,
    document: {
      querySelectorAll: (sel) => {
        if (sel.includes(':not([id])')) return [];              // ตัวล้าง altInput clone
        if (sel.includes('input[type="date"]')) return dateInputs;
        return [];                                              // ช่องเวลา: ไม่ใช้ในยามนี้
      },
    },
    // ตัว init ของ picker ที่มีกฎของตัวเอง และตัวผูกการพิมพ์ -- ไม่ใช่เรื่องของยามนี้
    initHolidayWorkDatePicker() {}, initEarlyMorningDatePicker() {}, initLateOutDatePicker() {},
    initOTDatePicker() {}, initLongDistanceDatePicker() {}, initUpcountryDatePicker() {},
    attachTypedDateEntryToAll() {}, attachTypedTimeEntry() {},
  };
  vm.createContext(sandbox);
  vm.runInContext(`${INIT_SRC}\ninitDatePickers();`, sandbox);
  return calls;
}

console.log('ช่องวันที่: ช่วงวันที่อนุญาตต้องไปถึงปฏิทิน');

test('ช่องที่ประกาศ min/max ส่งค่าเป็น minDate/maxDate ให้ flatpickr', () => {
  const calls = runInit([fakeInput('shorten-return-date', { min: '2026-11-20', max: '2026-11-24' })]);
  assert.strictEqual(calls.length, 1, 'ต้องสร้าง picker ให้ช่องนี้ 1 ตัว');
  assert.strictEqual(calls[0].cfg.minDate, '2026-11-20',
    'flatpickr ไม่ได้รับวันต่ำสุด ⇒ ปฏิทินจะเปิดให้เลือกวันก่อนช่วงที่อนุญาต');
  assert.strictEqual(calls[0].cfg.maxDate, '2026-11-24',
    'flatpickr ไม่ได้รับวันสูงสุด ⇒ ปฏิทินจะเปิดให้เลือกวันหลังช่วงที่อนุญาต');
});

test('ช่องที่ไม่ประกาศ min/max ต้องไม่ถูกจำกัดช่วงวัน', () => {
  const calls = runInit([fakeInput('leave-form-date')]);
  assert.strictEqual(calls.length, 1);
  assert.ok(!('minDate' in calls[0].cfg),
    'ช่องวันที่ทั่วไปถูกใส่ minDate โดยไม่มีใครขอ -- กฎจับกว้างเกินที่ตั้งใจ');
  assert.ok(!('maxDate' in calls[0].cfg),
    'ช่องวันที่ทั่วไปถูกใส่ maxDate โดยไม่มีใครขอ -- กฎจับกว้างเกินที่ตั้งใจ');
});

test('ช่องที่ประกาศข้างเดียวได้ข้างเดียว', () => {
  const calls = runInit([fakeInput('one-sided-date', { min: '2026-01-01' })]);
  assert.strictEqual(calls[0].cfg.minDate, '2026-01-01');
  assert.ok(!('maxDate' in calls[0].cfg), 'ไม่ควรเดา maxDate ให้เอง');
});

test('ค่าเดิมของ picker ยังอยู่ครบ (ไม่ได้เผลอทับ config อื่น)', () => {
  const calls = runInit([fakeInput('shorten-return-date', { min: '2026-11-20', max: '2026-11-24' })]);
  const cfg = calls[0].cfg;
  assert.strictEqual(cfg.dateFormat, 'Y-m-d', 'ค่าที่โค้ดอื่นทั้งแอปอ่านต้องยังเป็น ISO');
  assert.strictEqual(cfg.altInput, true);
  assert.strictEqual(cfg.altFormat, 'd/m/Y', 'ภาษาไทยต้องยังแสดงเป็น DD/MM/YYYY');
  assert.strictEqual(cfg.allowInput, false, 'ตัวแปลงวันที่ที่พิมพ์เองต้องยังเป็นของ attachTypedDateEntry');
});

test('shortenLeave() ต้องตั้ง min/max ก่อนเรียก initDatePickers() ไม่ใช่หลัง', () => {
  // ตัดบรรทัดคอมเมนต์ทิ้งก่อนเทียบลำดับ -- คอมเมนต์เหนือโค้ดพูดถึง initDatePickers() ด้วย
  // (รอบแรกที่เขียนยามนี้ มันจับคำในคอมเมนต์แล้วรายงานว่าลำดับผิดทั้งที่โค้ดถูก)
  const fn = extractFunction(APP_SRC, 'async function shortenLeave(id)')
    .split('\n').filter(line => !line.trim().startsWith('//')).join('\n');
  const iMin = fn.indexOf('input.min =');
  const iMax = fn.indexOf('input.max =');
  const iInit = fn.indexOf('initDatePickers()');
  assert.ok(iMin > 0 && iMax > 0, 'shortenLeave ไม่ได้ตั้ง min/max แล้ว ⇒ ปฏิทินจะไม่รู้ช่วงวัน');
  assert.ok(iInit > 0, 'shortenLeave ไม่ได้เรียก initDatePickers แล้ว ⇒ ช่องจะกลับไปเป็น ISO ดิบ');
  assert.ok(iMin < iInit && iMax < iInit,
    'ตั้ง min/max หลังสร้าง picker ⇒ flatpickr อ่านไม่ทัน ช่วงวันหายทั้งที่ attribute ถูก');
});

console.log(`\ndatepicker-min-max-range: ${passed} passed`);
