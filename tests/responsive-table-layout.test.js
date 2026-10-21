// ตารางต้องพอดีจอ และกฎต้องมีผลเฉพาะที่ตั้งใจ (2026-10-21)
//
// ที่มา: เจ้าของใช้โน้ตบุ๊ก 14 นิ้ว แล้วพบว่าตารางล้นขอบจนต้องเลื่อนแนวนอน และตัวหนังสือบางส่วน
// ถูกบัง · วัดบนเว็บจริงที่ viewport 1280 ได้: ตารางเวลาทำงานล้น 123px · Finalize 188px ·
// รายงานสรุปวันทำงาน 45px · เจ้าของสั่งว่า **ไม่ต้องการให้เลื่อน** และต้อง **ยืดหยุ่นตามจอของแต่ละคน**
//
// ต้นเหตุ: เซลล์และหัวตารางถูกตั้ง `white-space: nowrap` ไว้ ⇒ ความกว้างขั้นต่ำของตารางคงที่
// ไม่ว่าจอจะเล็กแค่ไหน · พอเนื้อในดันเกิน `.table-wrap` ที่มี `overflow-x:auto` ก็ให้เลื่อนแทนที่จะบีบ
//
// **ยามนี้มีไว้กันความผิดพลาดที่เกิดจริง 4 ครั้งระหว่างแก้งานนี้** -- ทุกครั้งเจ้าของเป็นคนเห็นก่อน
// ไม่ใช่ตัววัดของผม:
//   1. ใส่ `overflow-wrap: anywhere` ทั้งตาราง ⇒ ตัวเลขเงิน "32,500.00" ถูกตัดเป็นสองบรรทัด 16/16 ช่อง
//   2. ใส่กับคอลัมน์ชื่อ ⇒ ชื่อคนถูกตัดกลางคำ "Siributwong" เป็น "Siribut / wong"
//   3. เขียน `td:has(> .btn)` ⇒ เซลล์ชื่อที่มีปุ่มเดียวก็โดนด้วย ปุ่มเลยกระโดดไปอยู่ข้างชื่อ
//   4. ใส่กฎตารางโดยไม่จำกัดขอบเขต ⇒ มือถือแย่ลง (ล้นจาก 24px เป็น 40px)
//
// เพราะ CSS ตรวจด้วยการรันไม่ได้ในชุดเทสต์นี้ (ไม่มีเบราว์เซอร์) ยามนี้จึง **แยกวิเคราะห์โครงสร้าง
// ของไฟล์ CSS** ว่ากฎข้อไหนอยู่ใน @media อะไร ซึ่งตรงกับความผิดพลาดข้อ 3 และ 4 พอดี
// หลักฐานฝั่งพฤติกรรมคือตัวเลขที่วัดจากเบราว์เซอร์จริง บันทึกไว้ใน commit message
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CSS = fs.readFileSync(path.join(ROOT, 'attendance/css/style.css'), 'utf8');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ', name); }
  catch (e) { process.exitCode = 1; console.log('  FAIL', name, '\n      ', e.message); }
}

// แยก CSS เป็นรายการ { selector, body, media } โดยติดตามว่าอยู่ใน @media ชั้นไหน
function parseRules(src) {
  const rules = [];
  const stack = [];
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open < 0) break;
    const head = src.slice(i, open).replace(/\/\*[\s\S]*?\*\//g, '').trim();
    if (head.startsWith('@media') || head.startsWith('@supports')) {
      stack.push(head);
      i = open + 1;
      continue;
    }
    // หาปีกกาปิดที่คู่กัน
    let depth = 1, j = open + 1;
    while (j < src.length && depth > 0) {
      if (src[j] === '{') depth++;
      else if (src[j] === '}') depth--;
      j++;
    }
    if (head) rules.push({ selector: head, body: src.slice(open + 1, j - 1), media: stack.join(' && ') });
    i = j;
    // ปิด @media ที่จบแล้ว
    while (stack.length) {
      const next = src.slice(i).match(/^\s*\}/);
      if (!next) break;
      stack.pop();
      i += next[0].length;
    }
  }
  return rules;
}

const RULES = parseRules(CSS);
const find = (pred) => RULES.filter(pred);
const maxWidthOf = (media) => { const m = /max-width:\s*(\d+)px/.exec(media || ''); return m ? +m[1] : null; };
const minWidthOf = (media) => { const m = /min-width:\s*(\d+)px/.exec(media || ''); return m ? +m[1] : null; };

console.log('ตารางพอดีจอ และกฎมีผลเฉพาะที่ตั้งใจ');

// ---- 1) กฎกัน iOS ซูม ต้องไม่ถูกลบหรือถูกลดขนาด ----
test('กฎที่ให้ช่องกรอกเป็น 16px บนมือถือยังอยู่ (ถ้าเล็กกว่านี้ iPhone จะซูมหน้าเองทุกครั้งที่แตะ)', () => {
  const r = find(x => /\binput\b/.test(x.selector) && /\btextarea\b/.test(x.selector)
                      && /font-size:\s*16px/.test(x.body) && maxWidthOf(x.media));
  assert.ok(r.length > 0,
    'ไม่พบกฎ `input, select, textarea { font-size: 16px }` ในช่วงมือถือ — กฎนี้มีคอมเมนต์กำกับว่า' +
    ' iOS จะซูมหน้าเมื่อช่องกรอกเล็กกว่า 16px ห้ามลบ');
});

test('ถ้าลดขนาดตัวอักษรของ dropdown ต้องไม่ไปลดของ input/textarea ด้วย', () => {
  const ลด = find(x => /(^|,)\s*select\s*($|,)/.test(x.selector)
                      && /font-size:\s*(1[0-5]|[0-9])px/.test(x.body));
  for (const r of ลด) {
    assert.ok(!/\binput\b|\btextarea\b/.test(r.selector),
      `กฎ "${r.selector}" ลดขนาดตัวอักษรต่ำกว่า 16px และครอบ input/textarea ด้วย ⇒ iPhone จะซูมหน้า`);
  }
});

// ---- 2) กฎจัดตารางของจอคอมฯ ต้องไม่รั่วไปมือถือ ----
test('กฎที่จัดปุ่มในเซลล์ตารางต้องมีผลเฉพาะจอคอมพิวเตอร์', () => {
  const r = find(x => /\.table-wrap[^{]*\btd\b[^{]*:has\(/.test(x.selector) && /display:\s*flex/.test(x.body));
  assert.ok(r.length > 0, 'ยังไม่มีกฎจัดเรียงปุ่มในเซลล์ตาราง');
  for (const rule of r) {
    const min = minWidthOf(rule.media), max = maxWidthOf(rule.media);
    assert.ok((min && min >= 769) || (max && max >= 769),
      `กฎ "${rule.selector}" ไม่ได้จำกัดไว้ที่จอคอมพิวเตอร์ (media = "${rule.media || 'ไม่มี'}")` +
      ' ⇒ จะไปทับกฎ responsive ของมือถือ ซึ่งเคยทำให้ตาราง Finalize บนมือถือล้นจาก 24px เป็น 40px');
  }
});

// ---- 3) กฎจัดปุ่มต้องเจาะจงพอที่จะไม่โดนเซลล์ชื่อ ----
test('กฎจัดปุ่มต้องเล็งเซลล์ที่มีปุ่มหลายตัว ไม่ใช่เซลล์ที่มีปุ่มเดียว', () => {
  const r = find(x => /\.table-wrap[^{]*:has\(/.test(x.selector) && /display:\s*flex/.test(x.body));
  for (const rule of r) {
    assert.ok(/:has\(\s*>\s*\.btn\s*\+\s*\.btn\s*\)/.test(rule.selector),
      `กฎ "${rule.selector}" เล็งเซลล์ที่มีปุ่มอย่างน้อยหนึ่งตัว ⇒ เซลล์ชื่อพนักงานซึ่งมีปุ่ม` +
      ' "ปรับค่าเบี้ยฯ" อยู่ตัวเดียวจะโดนด้วย และปุ่มจะเด้งไปอยู่ข้างชื่อแทนที่จะอยู่บรรทัดล่าง' +
      ' (เกิดขึ้นจริงแล้วครั้งหนึ่ง) ⇒ ต้องใช้ `:has(> .btn + .btn)`');
  }
});

// ---- 4) ห้ามสั่งตัดบรรทัดแบบ anywhere กับทั้งตาราง ----
test('ห้ามใช้ overflow-wrap:anywhere กับทุกเซลล์ของตาราง (ตัวเลขเงินจะถูกตัดครึ่ง)', () => {
  const r = find(x => /\.table-wrap[^{]*\btd\b/.test(x.selector)
                      && /overflow-wrap:\s*anywhere/.test(x.body));
  for (const rule of r) {
    const เจาะจง = /:(first-child|last-child|nth-child)/.test(rule.selector) || /\.[a-z-]+\s*$/i.test(rule.selector.trim());
    assert.ok(เจาะจง,
      `กฎ "${rule.selector}" สั่งตัดบรรทัดได้ทุกตำแหน่งกับทุกเซลล์ ⇒ ตัวเลขเงินอย่าง "32,500.00"` +
      ' จะถูกตัดเป็นสองบรรทัด (วัดแล้วเกิดกับ 16 จาก 16 ช่อง) ⇒ ต้องเจาะจงเฉพาะคอลัมน์ข้อความ');
  }
});

// ---- 5) แถบบนสุดต้องไม่บีบชื่อหน้าจนตัวอักษรเรียงแนวตั้ง ----
test('แถบขวาบนสุดต้องหดได้ ไม่งั้นชื่อหน้าจะถูกบีบจนเหลือไม่กี่พิกเซล', () => {
  const r = find(x => /\.topbar-right/.test(x.selector) && /flex-shrink:\s*1/.test(x.body));
  assert.ok(r.length > 0,
    'ไม่พบกฎให้ .topbar-right หดได้ — ของเดิมตั้ง flex-shrink:0 ทำให้มันกิน 815 จาก 878px' +
    ' เหลือให้ชื่อหน้าแค่ 7px จนตัวอักษรไทยเรียงลงมาทีละตัว (วัดที่ viewport 1152)');
});

test('ถ้าสั่งให้แถบขวาหดได้ ลูกของมันต้องหดได้ด้วย ไม่งั้นเนื้อในทะลักออกนอกจอแทน', () => {
  const หดได้ = find(x => /\.topbar-right/.test(x.selector) && /flex-shrink:\s*1/.test(x.body));
  if (!หดได้.length) return; // ข้อก่อนหน้าจับกรณีที่ไม่มีกฎนี้แล้ว
  const ลูกหดได้ = find(x => /\.topbar-right\s*>\s*\*/.test(x.selector) && /min-width:\s*0/.test(x.body)
                            && !(maxWidthOf(x.media) && maxWidthOf(x.media) < 769));
  assert.ok(ลูกหดได้.length > 0,
    'ไม่พบกฎ `.topbar-right > * { min-width: 0 }` สำหรับจอคอมพิวเตอร์ — ค่าตั้งต้นของ flex item คือ' +
    ' min-width:auto ⇒ สั่งให้พ่อหดได้อย่างเดียว พ่อจะถูกบีบจริงแต่ลูกไม่ยอมหด เนื้อในเลยล้นออกนอกกรอบ' +
    ' (วัดบนเว็บจริงที่ viewport 1280 ด้วยบัญชีที่มี dropdown สวมบทบาท: ฝั่งขวาต้องการ 736px ได้ไป 660px' +
    ' ⇒ ป้ายชื่อผู้ใช้ยื่นไปถึง x=1321 บนจอกว้าง 1274 และทั้งหน้าเลื่อนแนวนอนได้ 47px)');
});

// ---- 5ข) ถ้าลดช่องไฟในเซลล์เพื่อให้ตารางพอดีจอแคบ ห้ามรั่วไปถึงมือถือ ----
test('กฎลดช่องไฟในเซลล์ตารางต้องจำกัดไว้ที่จอคอมพิวเตอร์เท่านั้น', () => {
  const ลดช่องไฟ = find(x => /\.table-wrap[^{]*\b(th|td)\b/.test(x.selector)
                            && /padding(-left|-right)?:\s*[0-7]px/.test(x.body));
  for (const r of ลดช่องไฟ) {
    const min = minWidthOf(r.media);
    assert.ok(min && min >= 769,
      `กฎ "${r.selector}" ลดช่องไฟของเซลล์ตารางโดยไม่ได้จำกัดไว้ที่จอคอมพิวเตอร์ (media = "${r.media || 'ไม่มี'}")` +
      ' ⇒ มือถือใช้ช่องไฟชุดของตัวเองอยู่แล้ว กฎนี้จะไปทับ ซึ่งเป็นความผิดพลาดแบบเดียวกับข้อ 4' +
      ' ในหัวไฟล์ที่เคยทำให้ตาราง Finalize บนมือถือล้นจาก 24px เป็น 40px');
  }
});

test('กฎช่องไฟของจอแคบต้องอยู่หลังกฎช่องไฟของจอคอมฯ ไม่งั้นมันไม่เคยชนะ', () => {
  const idxOf = pred => RULES.findIndex(pred);
  const กว้าง = idxOf(x => /\.table-wrap table th/.test(x.selector) && /padding-left:\s*8px/.test(x.body)
                          && minWidthOf(x.media) === 769 && !maxWidthOf(x.media));
  const แคบ = idxOf(x => /\.table-wrap table th/.test(x.selector) && /padding-left:\s*[0-7]px/.test(x.body)
                        && maxWidthOf(x.media));
  if (กว้าง < 0 || แคบ < 0) return; // ยังไม่มีคู่นี้ก็ไม่มีอะไรให้ตรวจ
  assert.ok(แคบ > กว้าง,
    'กฎช่องไฟของช่วงจอแคบถูกเขียนไว้ "ก่อน" กฎของจอคอมฯ ที่ตั้ง 8px — selector เหมือนกัน specificity' +
    ' เท่ากัน ผู้ชนะจึงตัดสินด้วยลำดับในไฟล์ ⇒ กฎของจอแคบจะไม่เคยมีผลที่ความกว้างใดเลย' +
    ' (เกิดขึ้นจริง 2026-10-21: เทสต์เขียว deploy ขึ้นเว็บแล้ว แต่ของที่ตั้งใจแก้ยังล้น 3px เท่าเดิม' +
    ' จับได้ตอนอ่าน CSSOM บนหน้าจริงเท่านั้น)');
});

// ---- 6) การจัดวางสองแบบของหน้า Finalize: JS กับ CSS ต้องใช้เส้นแบ่งเดียวกัน ----
const APP = fs.readFileSync(path.join(ROOT, 'attendance/js/app.js'), 'utf8');

test('ค่า breakpoint ของหน้า Finalize ใน app.js ต้องตรงกับที่ CSS ใช้', () => {
  const m = /const FINALIZE_MOBILE_MAX_WIDTH = (\d+);/.exec(APP);
  assert.ok(m, 'ไม่พบ FINALIZE_MOBILE_MAX_WIDTH ใน app.js');
  const jsBreak = +m[1];
  const cssRule = RULES.find(r => /#fin-th-status/.test(r.selector) && /display:\s*none/.test(r.body));
  assert.ok(cssRule, 'ไม่พบกฎที่ซ่อนหัวคอลัมน์สถานะบนมือถือ');
  assert.strictEqual(maxWidthOf(cssRule.media), jsBreak,
    `app.js ย้ายแถวที่ ${jsBreak}px แต่ CSS จัดรูปแบบที่ ${maxWidthOf(cssRule.media)}px` +
    ' ⇒ จะมีช่วงความกว้างที่แถวถูกย้ายแต่ CSS ไม่จัดให้ (หรือกลับกัน)');
});

test('ถ้าย้ายเซลล์สถานะออกไป หัวคอลัมน์ต้องถูกซ่อนด้วยในช่วงความกว้างเดียวกัน', () => {
  assert.ok(/statusCell\.style\.display\s*=\s*'none'/.test(APP),
    'app.js ไม่ได้ซ่อนเซลล์สถานะหลังย้ายเนื้อในออกไป ⇒ จะเหลือเซลล์ว่างค้างในตาราง');
  const ซ่อนหัว = RULES.find(r => /#fin-th-status/.test(r.selector) && /display:\s*none/.test(r.body));
  assert.ok(ซ่อนหัว,
    'เซลล์สถานะถูกซ่อนใน JS แต่หัวคอลัมน์ไม่ถูกซ่อนใน CSS ⇒ หัวตารางกับข้อมูลจะเลื่อนไม่ตรงกัน' +
    ' (เจ้าของเจอเองตอนทดลอง: หัวตารางเหลือ 2 คอลัมน์ ขณะที่ข้อมูลยังมี 4)');
});

test('ปุ่มยืนยันกับป้ายสถานะต้องถูกย้าย ไม่ใช่สร้างสำเนา (กัน id ซ้ำ)', () => {
  assert.ok(/actionRow\.className\s*=\s*'fin-mobile-actions'/.test(APP),
    'ไม่พบโค้ดสร้างแถวปุ่มของมือถือใน app.js');
  assert.ok(/while\s*\(statusCell\.firstChild\)\s*bar\.appendChild\(statusCell\.firstChild\)/.test(APP),
    'ต้องย้ายลูกของเซลล์สถานะมาทั้งหมด (appendChild ย้ายของจริง) ไม่ใช่ render ซ้ำ —' +
    ' ป้ายสถานะกับปุ่มยืนยันมี id finalize-status-N / finalize-btn-N ที่โค้ดอื่นอ้างถึง' +
    ' ถ้ามีสองชุด getElementById จะหยิบผิดตัว');
});

console.log(`\nresponsive-table-layout: ${passed} passed`);
