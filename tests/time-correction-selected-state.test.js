// ปุ่ม "เวลาเข้างาน / เวลาออกงาน" ต้องบอกด้วยสายตาได้ว่ากำลังเลือกอันไหนอยู่ (2026-11-03)
//
// ที่มา: เจ้าของรายงานว่า "ปุ่มแก้ไขเวลาเข้า ออกงาน ไม่สามารถใช้งานได้" แล้วอธิบายต่อว่า
// "คลิกที่เวลาเข้างาน เวลาออกงานแล้วไม่มีสีหรืออะไรบอกเลยว่ากำลังคลิกตัวไหนอยู่" ·
// วัดบนเว็บจริง (build 179, ธีมสว่าง) ขณะที่ `tc-field` มีค่า `checkIn` แล้ว:
//   ปุ่มที่ถูกเลือก   → background rgb(248,250,252) · border rgb(226,232,240)
//   ปุ่มที่ไม่ถูกเลือก → background rgb(248,250,252) · border rgb(226,232,240)
// เหมือนกันทุกค่า ⇒ ระบบรู้ว่าเลือกอะไรอยู่ แต่ผู้ใช้ไม่รู้ จึงเข้าใจว่าปุ่มเสีย
//
// **ต้นเหตุ:** 2026-10-21 ย้ายสีของสถานะ "ถูกเลือก" จาก JS ไปไว้ใน CSS
// (`.tc-field-btn.tc-field-selected`) ซึ่งถูกต้องแล้วสำหรับเรื่องโหมดมืด · แต่
// `openTimeCorrectionModal()` ยังเขียน `b.style.borderColor` / `b.style.background` ลงบนปุ่ม
// ทั้งสองตัวทุกครั้งที่เปิดโมดัล ซึ่งเป็น **inline style ที่ชนะ class เสมอ** (กฎ CSS ตัวนั้น
// ไม่มี `!important`) ⇒ class ที่ `selectCorrectionField()` ใส่ให้ไม่มีผลทางสายตาเลย
// ทั้งธีมสว่างและธีมมืด · สังเกตว่ากฎที่แก้ "สีตัวหนังสือ" ในธีมมืด (style.css บรรทัด
// `[data-theme="dark"] .tc-field-btn.tc-field-selected > div`) ใส่ `!important` ไว้พร้อม
// คอมเมนต์ว่าต้องทับ inline ⇒ ตอนนั้นเห็นปัญหา inline ของ `div` ข้างใน แต่ไม่เห็นว่า
// **ตัวปุ่มเองก็ถูกเขียน inline เหมือนกัน**
//
// **ทำไมยามเดิมไม่จับ:** `tests/theme-aware-colors.test.js` รัน `selectCorrectionField()`
// แยกเดี่ยวๆ แล้วตรวจว่า "ใส่ class ถูกปุ่ม" ซึ่งผ่านจริง · บั๊กอยู่ที่ **การประกอบกัน**
// ของสองฟังก์ชัน ไม่มีเทสต์ไหนรันทั้งคู่ต่อกันแบบที่ผู้ใช้เจอ ⇒ ยามนี้รันตามลำดับจริง:
// เปิดโมดัล → เลือกช่อง → ตรวจว่าสถานะที่เลือกยังมีผล
//
// **ข้อที่สองที่เจอระหว่างทาง:** `openTimeCorrectionModal()` ล้างค่า `tc-field` เป็นค่าว่าง
// แต่ไม่เคยถอด class `tc-field-selected` ออกจากปุ่ม ⇒ เปิดโมดัลรอบที่สอง ปุ่มเดิมจะยัง
// "ดูเหมือนถูกเลือก" ทั้งที่ฟอร์มถือว่ายังไม่ได้เลือกอะไร · ของเดิมมองไม่เห็นเพราะ inline
// บังอยู่ แต่พอถอด inline ออกมันจะโผล่ทันที จึงต้องปิดพร้อมกันในรอบเดียว
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const APP_SRC = fs.readFileSync(path.join(ROOT, 'attendance/js/app.js'), 'utf8');
const CSS_SRC = fs.readFileSync(path.join(ROOT, 'attendance/css/style.css'), 'utf8');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ', name); }
  catch (e) { process.exitCode = 1; console.log('  FAIL', name, '\n      ', e.message); }
}

// นับวงเล็บ ไม่ใช่หาเครื่องหมายปิดตัวแรก -- วิธีเดียวกับ theme-aware-colors.test.js
function extractFunction(src, name) {
  const re = new RegExp('^(?:async )?function ' + name + '\\(', 'm');
  const m = re.exec(src);
  assert.ok(m, 'ไม่พบฟังก์ชัน ' + name + ' ใน app.js');
  const i = src.indexOf('{', m.index);
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (depth === 0) return src.slice(m.index, j + 1); }
  }
  throw new Error('วงเล็บไม่สมดุลใน ' + name);
}

function fakeEl(id) {
  const classes = new Set();
  return {
    id,
    value: '',
    textContent: '',
    innerHTML: '',
    className: '',
    style: new Proxy({}, { set(t, k, v) { t[k] = v; return true; }, get(t, k) { return t[k]; } }),
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
      toggle: (c, on) => {
        if (on === undefined) { classes.has(c) ? classes.delete(c) : classes.add(c); }
        else if (on) classes.add(c); else classes.delete(c);
        return classes.has(c);
      },
    },
    _classes: classes,
  };
}

// สองฟังก์ชันนี้คือลำดับที่ผู้ใช้เดินจริง: กด ✏️ แล้วกดปุ่มเลือกช่อง
const OPEN_MODAL = extractFunction(APP_SRC, 'openTimeCorrectionModal');
const SELECT_FIELD = extractFunction(APP_SRC, 'selectCorrectionField');

// theme: 'light' | 'dark' -- ปุ่มต้องแยกออกได้ทั้งสองธีม (state contrast parity)
function runUserFlow(theme, { selectField = 'checkIn', preSelected = null } = {}) {
  const els = {};
  const el = (id) => (els[id] = els[id] || fakeEl(id));
  if (preSelected) el(preSelected).classList.add('tc-field-selected');

  const sandbox = {
    document: {
      getElementById: el,
      documentElement: { getAttribute: () => theme },
    },
    // ของรอบข้างที่ฟังก์ชันเรียก -- สตั๊บให้น้อยที่สุดเท่าที่จะรันผ่าน
    clearScanPicks: () => {},
    getApprovalRoute: () => ['md'],
    L: (en, th) => th || en,
    currentLang: 'th',
    _tcQuickFixTarget: null,
  };
  vm.createContext(sandbox);
  vm.runInContext(
    OPEN_MODAL + '\n' + SELECT_FIELD +
    `\nopenTimeCorrectionModal('2026-10-22','08:29','16:49');` +
    (selectField ? `\nselectCorrectionField(${JSON.stringify(selectField)});` : ''),
    sandbox
  );
  return els;
}

// สีที่ฝังลงบนปุ่มโดยตรง = สิ่งที่ทำให้กฎ CSS ของสถานะ "ถูกเลือก" ไม่มีผล
const DEFEATING_PROPS = ['background', 'backgroundColor', 'borderColor', 'border', 'color'];
function inlineColorsOn(el) {
  return DEFEATING_PROPS
    .filter(p => typeof el.style[p] === 'string' && /#[0-9a-f]{3,8}|rgb|hsl/i.test(el.style[p]))
    .map(p => p + '=' + el.style[p]);
}

console.log('ปุ่มเลือกช่องในโมดัลแก้ไขเวลา ต้องบอกด้วยสายตาได้ว่าเลือกอันไหน');

for (const theme of ['light', 'dark']) {
  test(`[${theme}] เปิดโมดัลแล้วเลือกช่อง — ไม่มี inline style มาทับ class สถานะ`, () => {
    const els = runUserFlow(theme);
    const bad = [];
    for (const id of ['tc-btn-in', 'tc-btn-out']) {
      const hits = inlineColorsOn(els[id]);
      if (hits.length) bad.push(id + ': ' + hits.join(', '));
    }
    assert.deepStrictEqual(bad, [],
      'openTimeCorrectionModal() ฝังสีลงบนปุ่มโดยตรง ⇒ inline ชนะ .tc-field-selected เสมอ\n' +
      '       ผู้ใช้จึงไม่เห็นว่าเลือกอันไหนอยู่:\n       ' + bad.join('\n       '));
  });

  test(`[${theme}] หลังเลือกแล้ว ปุ่มสองตัวต้องอยู่คนละสถานะ`, () => {
    const els = runUserFlow(theme, { selectField: 'checkIn' });
    assert.ok(els['tc-btn-in']._classes.has('tc-field-selected'),
      'ปุ่มที่ถูกเลือกต้องมี class tc-field-selected');
    assert.ok(!els['tc-btn-out']._classes.has('tc-field-selected'),
      'ปุ่มที่ไม่ถูกเลือกต้องไม่มี class นั้น');
    // ถ้าทั้งคู่ถูกฝังสีเหมือนกัน class ก็ไม่ช่วยอะไร -- ตรวจซ้ำอีกชั้นให้ชัด
    assert.deepStrictEqual(
      inlineColorsOn(els['tc-btn-in']), inlineColorsOn(els['tc-btn-out']).length ? inlineColorsOn(els['tc-btn-out']) : [],
      'ปุ่มที่ถูกเลือกกับไม่ถูกเลือกถูกเซ็ต inline เหมือนกัน ⇒ แยกด้วยตาไม่ได้');
  });
}

test('เปิดโมดัลใหม่ ต้องล้างสถานะที่เลือกไว้รอบก่อนออกให้หมด', () => {
  // รอบก่อนผู้ใช้เลือก "เวลาออกงาน" ค้างไว้ แล้วปิดโมดัล · รอบนี้เปิดใหม่โดยยังไม่เลือกอะไร
  const els = runUserFlow('light', { selectField: null, preSelected: 'tc-btn-out' });
  assert.strictEqual(els['tc-field'].value, '', 'ฟอร์มต้องถือว่ายังไม่ได้เลือกช่องไหน');
  for (const id of ['tc-btn-in', 'tc-btn-out']) {
    assert.ok(!els[id]._classes.has('tc-field-selected'),
      `${id} ยังค้างสถานะ "ถูกเลือก" จากรอบก่อน ทั้งที่ ${'tc-field'} ว่าง ⇒ ` +
      'ผู้ใช้เห็นปุ่มสว่างแต่กดยื่นแล้วโดนเตือนว่ายังไม่ได้เลือก');
  }
});

test('CSS ยังมีกฎของสถานะถูกเลือกครบทั้งสองธีม (ไม่ได้แก้โดยลบกฎทิ้ง)', () => {
  assert.ok(/\.tc-field-btn\.tc-field-selected\s*\{/.test(CSS_SRC),
    'ไม่มีกฎ .tc-field-btn.tc-field-selected ในธีมสว่าง');
  assert.ok(/\[data-theme="dark"\]\s*\.tc-field-btn\.tc-field-selected\s*\{/.test(CSS_SRC),
    'ไม่มีกฎของโหมดมืดสำหรับ .tc-field-btn.tc-field-selected');
  assert.ok(/\.tc-field-btn\s*\{/.test(CSS_SRC),
    'ไม่มีกฎสถานะปกติของ .tc-field-btn ⇒ ถอด inline ออกแล้วปุ่มจะไม่มีสีตั้งต้น');
  assert.ok(/\[data-theme="dark"\]\s*\.tc-field-btn\s*\{/.test(CSS_SRC),
    'ไม่มีกฎสถานะปกติของโหมดมืด ⇒ ถอด inline ออกแล้วโหมดมืดจะได้สีของโหมดสว่าง');
});

console.log(`\n${passed} passed, ${process.exitCode ? 'บางข้อล้มเหลว' : '0 failed'}`);
