// สีที่ JavaScript เซ็ตเอง ต้องมาจากธีม ไม่ใช่ค่าตายตัว (2026-10-21)
//
// ที่มา: เจ้าของรายงานพร้อมภาพว่า "dark mode มันดูแปลกๆ ทำไมมันขาวๆแบบนั้น มีจุดไหนในแอพเป็นบ้าง
// ก็ไม่รู้" · ไล่จนเจอว่าโปรเจกต์นี้**มีกลไกกันอยู่แล้ว**: `css/style.css` มีกฎราว 67 ข้อรูปแบบ
// `[data-theme="dark"] [style*="background:#f8fafc"] { background:#1e293b !important; }`
// ซึ่งดักข้อความใน attribute `style` แล้วทับด้วยสีเข้ม
//
// **จุดบอดของกลไกนั้น:** มันดักได้เฉพาะ inline style ที่เขียนไว้ใน HTML เท่านั้น · เมื่อ JavaScript
// เซ็ตสีด้วย `el.style.background = '#eff6ff'` เบราว์เซอร์จะเขียน attribute ใหม่เป็น
// `background: rgb(239, 246, 255)` ⇒ ไม่ตรงกับ selector ที่มองหา `background:#eff6ff` อีกต่อไป
// ⇒ กฎธีมหลุดทั้งหมด และสีสว่างโผล่กลางโหมดมืด
//
// วัดแล้วใน app.js: 75 บรรทัดเซ็ตสีผ่าน JS · 50 บรรทัดเช็คธีมเองอยู่แล้ว (ปลอดภัย) · เหลือ 25
// บรรทัดที่ไม่เช็ค · คำนวณ contrast ของทั้ง 25 เทียบพื้นโหมดมืดแล้ว พบว่าพังจริง 3 ฟังก์ชัน:
//
//   selectCorrectionField  — ปุ่มเลือกเข้า/ออกในโมดัลแก้ไขเวลา · contrast 1.13 (วัดในเบราว์เซอร์
//                            จริงได้ 1.01) = ตัวหนังสือขาวบนพื้นขาว อ่านไม่ออกเลย · นี่คือภาพที่
//                            เจ้าของส่งมา · พังเพราะเซ็ต "แค่พื้น" ไม่เซ็ตตัวหนังสือคู่ไปด้วย
//   updateSystemAccountUI  — แถบบัญชีระบบ พื้นขาวจ้ากลางโหมดมืด โผล่ใน 19 หน้า
//   calcLongDistance       — กล่องผลคำนวณระยะทาง พื้นสว่างกลางโหมดมืด
//
// อีก 5 ฟังก์ชันที่เหลือ (refreshAbroadSpanHint, refreshExcusedHint, _photoStatus,
// showAttendanceDetail, markTimeFieldInvalid, จุดสถานะ GPS) **วัดแล้วผ่านเกณฑ์** จึงไม่ถูกแตะ
// โดยตั้งใจ -- ยามนี้ไม่บังคับมัน เพราะการไล่แก้ของที่ไม่ได้พังคือการเปลี่ยนหน้าตาแอปโดยไม่มีใครขอ
//
// เกณฑ์ที่ใช้ มาจาก ui-ux-pro-max (references/pro-rules.md หัวข้อ Light/Dark Mode Contrast):
// ข้อความหลัก >= 4.5:1 · ข้อความรอง >= 3:1 · และ "state contrast parity" คือสถานะถูกเลือก/กด
// ต้องแยกแยะได้เท่ากันทั้งสองธีม ซึ่งเป็นชื่อทางการของบั๊กปุ่มตัวนั้นพอดี
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

// element ปลอมที่ "จำได้" ว่าถูกเซ็ตสีอะไรบ้าง และถูก toggle class อะไรบ้าง
function fakeEl(id) {
  const classes = new Set();
  return {
    id,
    style: new Proxy({}, {
      set(t, k, v) { t[k] = v; return true; },
      get(t, k) { return t[k]; },
    }),
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
      toggle: (c, on) => { if (on === undefined) { classes.has(c) ? classes.delete(c) : classes.add(c); } else if (on) classes.add(c); else classes.delete(c); return classes.has(c); },
    },
    _classes: classes,
  };
}

const COLOR_PROPS = ['background', 'backgroundColor', 'color', 'borderColor', 'borderBottomColor'];
function hardcodedColorsSetOn(el) {
  return COLOR_PROPS.filter(p => {
    const v = el.style[p];
    return typeof v === 'string' && /#[0-9a-f]{3,8}|rgb|hsl/i.test(v);
  }).map(p => p + '=' + el.style[p]);
}

console.log('สีจาก JavaScript ต้องมาจากธีม ไม่ใช่ค่าตายตัว');

// ---- 1) ปุ่มเลือกเข้า/ออก ในโมดัลแก้ไขเวลา (จุดที่เจ้าของถ่ายรูปมา) ----
const SELECT_FIELD = extractFunction(APP_SRC, 'selectCorrectionField');

function runSelectField(field) {
  const els = {};
  const el = (id) => (els[id] = els[id] || fakeEl(id));
  const sandbox = { document: { getElementById: el } };
  vm.createContext(sandbox);
  vm.runInContext(SELECT_FIELD + `\nselectCorrectionField(${JSON.stringify(field)});`, sandbox);
  return els;
}

test('เลือก "เวลาเข้างาน" แล้วไม่มีการฝังสีลงบนปุ่มเลย', () => {
  const els = runSelectField('checkIn');
  const bad = [];
  for (const id of ['tc-btn-in', 'tc-btn-out']) {
    const hits = hardcodedColorsSetOn(els[id]);
    if (hits.length) bad.push(id + ': ' + hits.join(', '));
  }
  assert.deepStrictEqual(bad, [], 'ยังมีการฝังสีไว้ในโค้ด ⇒ กฎของธีมเอื้อมไปแก้ไม่ได้:\n       ' + bad.join('\n       '));
});

test('ปุ่มที่ถูกเลือกได้ class บอกสถานะ และอีกปุ่มไม่ได้', () => {
  const a = runSelectField('checkIn');
  assert.ok(a['tc-btn-in']._classes.size > 0, 'ปุ่มที่ถูกเลือกต้องได้ class สักตัวไว้ให้ CSS เกาะ');
  const picked = [...a['tc-btn-in']._classes][0];
  assert.ok(!a['tc-btn-out']._classes.has(picked), 'ปุ่มที่ไม่ได้ถูกเลือกต้องไม่มี class เดียวกัน');
  const b = runSelectField('checkOut');
  assert.ok(b['tc-btn-out']._classes.has(picked) && !b['tc-btn-in']._classes.has(picked),
    'สลับข้างแล้ว class ต้องย้ายตาม');
});

test('ค่าที่ส่งไปยังฟอร์มยังเป็นค่าเดิม (ไม่ได้แก้พฤติกรรม แค่แก้สี)', () => {
  assert.strictEqual(runSelectField('checkIn')['tc-field'].value, 'checkIn');
  assert.strictEqual(runSelectField('checkOut')['tc-field'].value, 'checkOut');
});

test('CSS มีกฎรองรับปุ่มที่ถูกเลือกครบทั้งสองธีม', () => {
  const cls = [...runSelectField('checkIn')['tc-btn-in']._classes][0];
  assert.ok(cls, 'ยังไม่มี class');
  assert.ok(CSS_SRC.includes('.' + cls), `ไม่มีกฎ CSS สำหรับ .${cls}`);
  const darkRule = new RegExp('\\[data-theme="dark"\\][^{]*\\.' + cls);
  assert.ok(darkRule.test(CSS_SRC), `ไม่มีกฎของโหมดมืดสำหรับ .${cls} ⇒ โหมดมืดจะได้สีของโหมดสว่าง`);
});

// ---- 2) แถบบัญชีระบบ และ 3) กล่องผลคำนวณระยะทางไกล ----
// สองตัวนี้ฝังอยู่ในฟังก์ชันยาวที่เรียกของอื่นเยอะเกินกว่าจะรันทั้งก้อนได้อย่างซื่อสัตย์
// ⇒ ตรวจที่ "ตัวบทของฟังก์ชันนั้น" โดยตรง ซึ่งตรงประเด็นที่สุดสำหรับกฎที่ว่าด้วยวิธีเขียนโค้ด
// (หลักฐานฝั่งพฤติกรรมของสองตัวนี้คือการวัดสีจริงในเบราว์เซอร์ ซึ่งบันทึกไว้ใน commit)
function assertNoHardcodedColor(fnName) {
  const body = extractFunction(APP_SRC, fnName);
  const hits = [];
  const re = /\.style\.(background|backgroundColor|color|borderColor|borderBottomColor)\s*=\s*([^;\n]+)/g;
  let m;
  while ((m = re.exec(body))) {
    if (/#[0-9a-fA-F]{3,8}/.test(m[2])) hits.push(m[0].trim());
  }
  assert.deepStrictEqual(hits, [], `${fnName}() ยังฝังสีไว้:\n       ` + hits.join('\n       '));
}

test('แถบบัญชีระบบไม่ฝังสีเอง (พื้นขาวจ้ากลางโหมดมืด 19 หน้า)', () => {
  assertNoHardcodedColor('updateSystemAccountUI');
});

test('กล่องผลคำนวณระยะทางไกลไม่ฝังสีเอง', () => {
  assertNoHardcodedColor('calcLongDistance');
});

// ---- 2026-10-21 รอบสอง (กวาดบนเว็บจริงหลัง deploy) -------------------------------------
// สองข้อนี้เป็นคนละจุดบอดกับด้านบน: ด้านบนคือ "JS เซ็ตสีเอง" · ข้างล่างคือ "สีที่ฝังไว้ใน
// inline style ของ HTML" ซึ่งกลไกเดิมดักด้วย [style*="..."] -- กลไกนั้นมีรูสองรู

test('กฎแปลงสีโหมดมืดต้องไม่จับโดน border-color หรือ background-color', () => {
  const หลวม = [...CSS_SRC.matchAll(/\[style\*="color:(#[0-9a-fA-F]{6})"\]/g)].map(m => m[1]);
  assert.strictEqual(หลวม.length, 0,
    `กฎ ${หลวม.length} ข้อใช้ \`[style*="color:#xxxxxx"]\` ซึ่งเป็นการ "มีสตริงนี้อยู่" ⇒ มันจับ` +
    ' `border-color:#xxxxxx` และ `background-color:#xxxxxx` ไปด้วย เพราะคำว่า color: เป็นส่วนท้าย' +
    ' ของคำเหล่านั้น · เกิดขึ้นจริงกับปุ่ม "⏱️ ยื่นขอ OT" ที่มี style="background:#ea580c;' +
    'border-color:#ea580c" ⇒ โหมดมืดเปลี่ยนตัวอักษรเป็นส้มอ่อนบนพื้นส้ม วัดได้ 2.11 (ตาเห็นว่า' +
    ' อ่านยากกว่าปุ่มข้างๆ ชัดเจน) · ต้องเขียนเป็น [style^="color:#xxxxxx"] คู่กับ' +
    ` [style*=";color:#xxxxxx"] แทน · สีที่ยังหลวมอยู่: ${หลวม.slice(0, 6).join(', ')}`);
});

test('ทุกสีตัวอักษรที่ฝังใน inline style ต้องอ่านออกในโหมดมืด', () => {
  const INDEX_SRC = fs.readFileSync(path.join(ROOT, 'attendance/index.html'), 'utf8');
  const src = APP_SRC + INDEX_SRC;
  const ใช้ = new Set();
  for (const m of src.matchAll(/(?:^|;|style=")color:(#[0-9a-fA-F]{6})/gm)) ใช้.add(m[1].toLowerCase());
  const มีกฎ = new Set([...CSS_SRC.matchAll(/\[style[*^]="?;?color:(#[0-9a-fA-F]{6})"\]/g)].map(m => m[1].toLowerCase()));

  const hex = h => ({ r: parseInt(h.slice(1, 3), 16), g: parseInt(h.slice(3, 5), 16), b: parseInt(h.slice(5, 7), 16) });
  const lum = c => { const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
  const ratio = (a, b) => { const l1 = lum(hex(a)), l2 = lum(hex(b)), hi = Math.max(l1, l2), lo = Math.min(l1, l2);
    return (hi + 0.05) / (lo + 0.05); };
  const พื้นการ์ดโหมดมืด = '#1e293b';

  const ตก = [...ใช้].filter(c => !มีกฎ.has(c) && ratio(c, พื้นการ์ดโหมดมืด) < 4.5)
    .map(c => `${c} (${ratio(c, พื้นการ์ดโหมดมืด).toFixed(2)}:1)`);
  assert.deepStrictEqual(ตก, [],
    'สีเหล่านี้ถูกฝังเป็นสีตัวอักษรใน inline style แต่ไม่มีกฎโหมดมืดรองรับ และวัดบนพื้นการ์ด' +
    ' โหมดมืด (#1e293b) แล้วต่ำกว่า 4.5:1 ⇒ เป็นตัวหนังสือเข้มบนพื้นเข้ม · ที่เจอบนเว็บจริง:' +
    ' บรรทัดช่วยเหลือ "🛠️ ปุ่มคำขอแสดงตามพนักงานที่เลือก..." สี #9a3412 วัดได้ 2.00' +
    ` · รายการที่ยังไม่มีกฎ: ${ตก.join(', ')}`);
});

test('ปุ่มที่ฝังพื้นสีพร้อมตัวอักษรขาว ต้องไม่ต่ำกว่า 3:1', () => {
  const INDEX_SRC = fs.readFileSync(path.join(ROOT, 'attendance/index.html'), 'utf8');
  const src = APP_SRC + INDEX_SRC;
  const hex = h => ({ r: parseInt(h.slice(1, 3), 16), g: parseInt(h.slice(3, 5), 16), b: parseInt(h.slice(5, 7), 16) });
  const lum = c => { const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
  const ratio = (a, b) => { const l1 = lum(hex(a)), l2 = lum(hex(b)), hi = Math.max(l1, l2), lo = Math.min(l1, l2);
    return (hi + 0.05) / (lo + 0.05); };
  const พบ = {};
  for (const m of src.matchAll(/style="([^"]*background:\s*(#[0-9a-fA-F]{3,6})[^"]*)"/g)) {
    if (!/color:\s*(#fff(fff)?|white)\b/i.test(m[1])) continue;
    let b = m[2].toLowerCase();
    if (b.length === 4) b = '#' + b[1] + b[1] + b[2] + b[2] + b[3] + b[3];
    พบ[b] = (พบ[b] || 0) + 1;
  }
  // เส้นที่ใช้คือ 3:1 ไม่ใช่ 4.5:1 โดยตั้งใจ -- ช่วง 3-4.5 เจ้าของดูแล้วและตัดสินว่ารับได้
  // (#ef4444 = 3.76 ใช้ 5 จุด · #3b82f6 = 3.68 ใช้ 1 จุด) ⇒ ยามนี้กันเฉพาะของที่แย่กว่านั้น
  // ถ้าวันหนึ่งอยากยกเป็น 4.5 ต้องถามเจ้าของก่อน เพราะมันเปลี่ยนหน้าตาปุ่มที่ใช้อยู่จริงหลายจุด
  const ตก = Object.entries(พบ).filter(([b]) => ratio('#ffffff', b) < 3)
    .map(([b, n]) => `${b} x${n} (${ratio('#ffffff', b).toFixed(2)}:1)`);
  assert.deepStrictEqual(ตก, [],
    'ปุ่มเหล่านี้ฝังพื้นสีอ่อนคู่กับตัวอักษรสีขาว ⇒ ตัวอักษรจมหายไปกับพื้น' +
    ' · ที่เจอบนเว็บจริง: ปุ่ม "✅ Approve ทั้งหมด (6)" ในหน้าจัดการคำขอ พื้น #10b981 วัดได้ 2.54' +
    ` · รายการที่ตก: ${ตก.join(', ')}`);
});

console.log(`\ntheme-aware-colors: ${passed} passed`);
