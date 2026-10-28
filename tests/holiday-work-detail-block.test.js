// บล็อกรายละเอียด Holiday Work: ตรวจ "สิ่งที่เรนเดอร์ออกมาจริง" ไม่ใช่ตรวจว่าซอร์สมีข้อความอะไร
// (2026-10-28)
//
// **ที่มาของไฟล์นี้ — รีวิวจับได้ว่าเทสต์ของผมอ้างมากกว่าที่ตรวจจริง:** ข้อที่ชื่อว่า "เงินคิดด้วย
// สูตรเดียวกับ otPayAmountFromLeave" ตรวจแค่ว่าซอร์สมีข้อความนั้น ไม่เคยเรียกสองฟังก์ชันมาเทียบเลข ·
// ข้อที่ชื่อว่า "ไม่มีทศนิยมของชั่วโมงหลงเหลือ" เป็น negative regex 3 รูปแบบ ⇒ ทศนิยมที่เขียนรูปอื่น
// ผ่านฉลุย · ยามแบบนั้นจะเขียวต่อไปแม้พฤติกรรมเปลี่ยน และจะแดงเวลาแค่เปลี่ยนชื่อตัวแปร
// ⇒ ไฟล์นี้ประกอบฟังก์ชันจริงขึ้นมาใน vm แล้วอ่าน HTML ที่มันคืนออกมา
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const APP_SRC = fs.readFileSync(path.join(ROOT, 'attendance/js/app.js'), 'utf8');
const JA_SRC = fs.readFileSync(path.join(ROOT, 'attendance/lang/ja.js'), 'utf8');

function extractFunction(src, name) {
  const re = new RegExp(`^(?:async )?function ${name}\\(`, 'm');
  const m = re.exec(src);
  assert.ok(m, `ไม่พบฟังก์ชัน ${name}`);
  const i = src.indexOf('{', m.index);
  let d = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') d++;
    else if (src[j] === '}') { d--; if (!d) return src.slice(m.index, j + 1); }
  }
  throw new Error('unbalanced ' + name);
}
const constLine = (src, n) => {
  const m = src.match(new RegExp(`^const ${n} = .*$`, 'm'));
  assert.ok(m, `ไม่พบ const ${n}`);
  return m[0];
};

const FNS = ['parseHHMMToMins', 'lateNightCheckoutMins', 'holidayWorkEndMins',
  'splitHolidayWorkOtMinutes', 'holidayWorkOtSegments', 'holidayWorkSegmentTimeLabel',
  'holidayWorkDurationLabel', 'escapeHtml', 'holidayWorkLocationLabel', 'holidayWorkTimesLabel',
  'round2HalfUp', 'otPayAmountFromLeave', 'effectiveOtMultiplier', 'otMultiplierLabel',
  'holidayWorkDetailBlockHtml'];

const SETTINGS = { workSchedule: { standardStartHour: 8, standardStartMinute: 30 } };

function makeCtx(lang, settings) {
  const ctx = {
    currentLang: lang || 'th',
    APP_SETTINGS: settings || SETTINGS,
    L: (en, th) => (ctx.currentLang === 'en' ? en : ctx.currentLang === 'ja' ? (ctx._ja[en] || en) : th),
    _ja: {},
    fmt2dp: n => Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
    console,
  };
  vm.createContext(ctx);
  vm.runInContext(constLine(APP_SRC, 'HHMM_RE') + '\n' + constLine(APP_SRC, 'BUSINESS_DAY_START_MINS') + '\n' +
    FNS.map(n => extractFunction(APP_SRC, n)).join('\n'), ctx);
  return ctx;
}
const CTX = makeCtx('th');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok  ${name}`); }
  catch (e) { process.exitCode = 1; console.log(`  FAIL  ${name}\n        ${e.message}`); }
}
// ข้อความที่ตาเห็น (ถอด tag ออก) — ตรวจผลลัพธ์ ไม่ใช่ตรวจซอร์ส
const text = html => html.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
// ทุกสตริงอังกฤษที่บล็อกนี้ส่งเข้า L() — **ดึงจากโค้ด ไม่พิมพ์มือ** เพื่อให้รายการล้าสมัยไม่ได้
function englishStrings() {
  const fn = extractFunction(APP_SRC, 'holidayWorkDetailBlockHtml');
  const out = [];
  for (const m of fn.matchAll(/\bL\(\s*'((?:[^'\\]|\\.)*)'/g)) out.push(m[1].replace(/\\'/g, "'"));
  assert.ok(out.length >= 6, `ดึงสตริงได้แค่ ${out.length} ตัว ⇒ รูปแบบการเรียก L() เปลี่ยนไปแล้ว`);
  return [...new Set(out)];
}
function realJaDict() {
  const box = { window: {}, out: {} };
  vm.runInNewContext(JA_SRC + '\nout.d = window.LANG_JA;', box);
  return box.out.d;
}
function makeJaCtx() {
  const ja = makeCtx('ja');
  ja._ja = realJaDict();
  return ja;
}

const rec = over => Object.assign({
  type: 'holiday-work', compensationMode: 'paid', dateFrom: '2026-10-18',
  workStartTime: '09:00', workEndTime: '16:20', otHours20: 6.33, otHours30: 0,
  locations: [{ name: 'NGK' }],
}, over);

console.log('T1 เงินตรงกับ otPayAmountFromLeave เป๊ะ (เรียกจริงทั้งสองตัว ไม่ใช่จับข้อความ)');

// รีวิวติงว่าข้อเดิมตรวจแค่ซอร์ส ⇒ ข้อนี้เรียกทั้งสองฟังก์ชันมาเทียบตัวเลขที่เรนเดอร์จริง
test('บาทในบล็อกเท่ากับที่ otPayAmountFromLeave คืน ทุกฐานเงินเดือนและทุกคู่ชั่วโมง', () => {
  let checked = 0;
  [7777, 12000, 15500, 23750, 30000, 41333].forEach(salary => {
    const hourly = salary / 30 / 8;
    [[6.33, 0], [8, 2], [0, 4.5], [1.13, 0.87], [12.25, 3.75]].forEach(([h20, h30]) => {
      const l = rec({ otHours20: h20, otHours30: h30 });
      const html = CTX.holidayWorkDetailBlockHtml(l, hourly);
      const expected = CTX.otPayAmountFromLeave(l, hourly);
      const shown = (text(html).match(/฿([\d,]+\.\d\d)/g) || []).map(s => Number(s.replace(/[฿,]/g, '')));
      assert.ok(shown.length > 0, `ไม่มีเงินแสดงเลย salary=${salary} ${h20}/${h30}`);
      // ตัวสุดท้ายคือ "รวมของวันนี้"
      assert.strictEqual(shown[shown.length - 1], CTX.round2HalfUp(expected),
        `salary=${salary} ×2=${h20} ×3=${h30}: บล็อกโชว์ ${shown[shown.length - 1]} แต่สูตรคืน ${expected}`);
      // **แต่ละแถวเงินด้วย ไม่ใช่แค่ยอดรวม** — รีวิวรอบ 3 พิสูจน์ด้วย mutation ว่าถ้าตรวจแค่ยอดรวม
      // การถอด round2HalfUp ออกจาก bucket ×2 หรือสลับชั่วโมงของแถว (×2 โชว์ชั่วโมงของ ×3)
      // จะผ่านฉลุย เพราะยอดรวมถูกปัดซ้ำอีกครั้งจนกลบความต่าง
      const rows = text(html).match(/×[23][^×]*?฿[\d,]+\.\d\d/g) || [];
      rows.forEach(row => {
        const rate = row[1] === '2' ? 2 : 3;
        const hrs = rate === 2 ? h20 : h30;
        const baht = Number((row.match(/฿([\d,]+\.\d\d)/) || [])[1].replace(/,/g, ''));
        assert.strictEqual(baht, CTX.round2HalfUp(hourly * rate * hrs),
          `แถว ×${rate} ของ salary=${salary}: โชว์ ${baht} แต่ควรเป็น ${CTX.round2HalfUp(hourly * rate * hrs)}`);
        // ชั่วโมงบนแถวเงินต้องเป็นของอัตรานั้นจริง
        const want = CTX.holidayWorkDurationLabel(Math.round(hrs * 60)).hm;
        assert.ok(row.includes(want), `แถว ×${rate} ควรบอก "${want}" : ${row}`);
      });
      checked++;
    });
  });
  assert.ok(checked >= 30, `ตรวจแค่ ${checked} เคส`);
});

test('ไม่มีเงินเดือนให้อ่าน ⇒ ตัดเงินออก ไม่โชว์ ฿0 และไม่โชว์ NaN', () => {
  [0, undefined, null, NaN, -1].forEach(rate => {
    const html = CTX.holidayWorkDetailBlockHtml(rec({}), rate);
    assert.ok(!/NaN|undefined/.test(html), `rate=${rate} มี NaN/undefined`);
    assert.ok(!/฿/.test(html), `rate=${rate} ไม่ควรโชว์เงินเลย`);
    assert.ok(/ชม\.|น\./.test(text(html)), `rate=${rate} ชั่วโมงต้องยังอยู่`);
  });
});

console.log('T2 ไม่มีทศนิยมของชั่วโมงโผล่บนจอ (อ่านผลลัพธ์ ไม่ใช่ negative regex ในซอร์ส)');

// ข้อเดิมเป็น negative regex 3 รูปแบบในซอร์ส ⇒ ทศนิยมที่เขียนรูปอื่นหลุดได้ · ข้อนี้อ่าน HTML จริง
test('ข้อความที่เรนเดอร์ออกมาไม่มี "ตัวเลข.ตัวเลข ชม." เลย ไม่ว่าอินพุตใด', () => {
  const cases = [[6.33, 0], [8, 2], [0, 0.87], [1.13, 0.87], [4.25, 0], [10, 0.08]];
  cases.forEach(([h20, h30]) => {
    const t = text(CTX.holidayWorkDetailBlockHtml(
      rec({ otHours20: h20, otHours30: h30, workStartTime: '07:22', workEndTime: '18:22' }), 125));
    assert.ok(!/\d+\.\d+\s*(ชม\.|h\b)/.test(t), `ยังมีทศนิยมชั่วโมง: ${t}`);
    assert.ok(/ชม\.|น\./.test(t), 'ต้องมีหน่วยชั่วโมง/นาที');
  });
});

console.log('T3 ป้ายพักเที่ยงบอกจำนวนที่หักจริง');

// รีวิว: "(หักพักเที่ยง)" เฉยๆ อ่านเหมือนหักเต็มชั่วโมงทุกกรณี ทั้งที่หักเฉพาะส่วนที่ ×2 คร่อมเที่ยง
test('หัก 60 นาที กับ หัก 30 นาที ต้องเขียนไม่เหมือนกัน', () => {
  const full = text(CTX.holidayWorkDetailBlockHtml(
    rec({ workStartTime: '09:00', workEndTime: '16:20', otHours20: 6.33 }), 0));
  assert.ok(/หักพักเที่ยง −1 ชม\./.test(full), 'กะที่คร่อมเที่ยงเต็มต้องบอก −1 ชม. : ' + full);
  const half = text(CTX.holidayWorkDetailBlockHtml(
    rec({ workStartTime: '12:30', workEndTime: '17:30', otHours20: 4.5 }), 0));
  assert.ok(/หักพักเที่ยง −30 น\./.test(half), 'กะที่เริ่ม 12:30 หักแค่ 30 นาที : ' + half);
});

test('กะที่เลิกไม่เกิน 13:00 ไม่มีป้ายหักพักเที่ยงเลย', () => {
  const t = text(CTX.holidayWorkDetailBlockHtml(
    rec({ workStartTime: '09:00', workEndTime: '12:45', otHours20: 3.75 }), 0));
  assert.ok(!/หักพักเที่ยง/.test(t), 'ไม่ควรมีป้าย : ' + t);
});

console.log('T4 เตือนเมื่อแถวเวลากับเงินมาจากคนละยุค');

// ความเสี่ยงหลักที่สเปกเขียนไว้เอง: แถวคิดจาก settings ปัจจุบัน เงินปักไว้ตอนอนุมัติ
test('ค่าที่เก็บไว้ตรงกับที่คำนวณใหม่ ⇒ ไม่มีคำเตือน', () => {
  const t = text(CTX.holidayWorkDetailBlockHtml(rec({ otHours20: 6.33, otHours30: 0 }), 125));
  assert.ok(!/ไม่ตรงกันแล้ว/.test(t), 'ไม่ควรเตือน : ' + t);
});

test('เปลี่ยนเวลาเริ่มงานมาตรฐานหลังอนุมัติ ⇒ ต้องเตือนว่าไม่ตรงกัน', () => {
  const moved = makeCtx('th', { workSchedule: { standardStartHour: 10, standardStartMinute: 0 } });
  const l = rec({ workStartTime: '09:00', workEndTime: '16:20', otHours20: 6.33, otHours30: 0 });
  const t = text(moved.holidayWorkDetailBlockHtml(l, 125));
  assert.ok(/ไม่ตรงกันแล้ว/.test(t), 'ต้องเตือน เพราะแถวขยับแต่เงินไม่ขยับ : ' + t);
});

test('ค่าที่เก็บเพี้ยนจากของจริง (เรคอร์ดเก่า/ย้ายข้อมูล) ⇒ เตือนเหมือนกัน', () => {
  const t = text(CTX.holidayWorkDetailBlockHtml(rec({ otHours20: 99, otHours30: 0 }), 125));
  assert.ok(/ไม่ตรงกันแล้ว/.test(t), 'ต้องเตือน : ' + t);
});

// รีวิวรอบ 3: mutation `(drift20 > 1 || drift30 > 1)` → `(drift20 > 1)` ผ่านทุกเทสต์ เพราะไม่มี
// เคสไหนที่เพี้ยนเฉพาะ ×3 เลย ⇒ ครึ่งหนึ่งของเงื่อนไขไม่มียามคุ้ม
test('เพี้ยนเฉพาะฝั่ง ×3 ก็ต้องเตือน (ไม่ใช่เตือนแต่ฝั่ง ×2)', () => {
  // 18:00–22:00 เป็น ×3 ล้วน 4 ชม. แต่เก็บไว้ 0 ⇒ แถวโชว์ 4 ชม. สลิปจ่าย 0
  const t = text(CTX.holidayWorkDetailBlockHtml(
    rec({ workStartTime: '18:00', workEndTime: '22:00', otHours20: 0, otHours30: 0 }), 125));
  assert.ok(/ไม่ตรงกันแล้ว/.test(t), 'ต้องเตือนทั้งที่ ×2 ตรงกันอยู่ : ' + t);
});

test('เพี้ยนแค่ 1 นาทีก็ต้องเตือน ไม่มีช่วงผ่อน', () => {
  // 09:00–16:20 = 380 นาที · เก็บไว้ 6.35 ชม. = 381 นาที ⇒ ต่างกัน 1 นาที
  const t = text(CTX.holidayWorkDetailBlockHtml(
    rec({ workStartTime: '09:00', workEndTime: '16:20', otHours20: 6.35, otHours30: 0 }), 125));
  assert.ok(/ไม่ตรงกันแล้ว/.test(t), 'ต่าง 1 นาทีก็ยังเป็นการโชว์สองค่าโดยไม่บอก : ' + t);
});

console.log('T4b แถวอัตราต้องบอก "ชั่วโมงที่จ่าย" ไม่ใช่ "ความยาวช่วงบนนาฬิกา"');

// รีวิวรอบ 3: mutation `holidayWorkDurationLabel(s.mins)` → `(s.endMin - s.startMin)` ผ่านทุกเทสต์
// ทั้งที่ทำให้แถวโชว์ 7 ชม. 20 น. (ความยาวช่วง) ขณะที่แถวเงินโชว์ 6 ชม. 20 น. (ที่จ่ายจริง)
// ⇒ คือการอ่านผิดแบบเดิมที่งานนี้ทั้งงานมีไว้กัน
test('09:00–16:20 แถวอัตราต้องเป็น 6 ชม. 20 น. ไม่ใช่ 7 ชม. 20 น.', () => {
  const t = text(CTX.holidayWorkDetailBlockHtml(
    rec({ workStartTime: '09:00', workEndTime: '16:20', otHours20: 6.33, otHours30: 0 }), 0));
  assert.ok(/09:00–16:20 \(หักพักเที่ยง −1 ชม\.\) ?6 ชม\. 20 น\./.test(t),
    'แถวอัตราต้องบอกชั่วโมงที่จ่าย ไม่ใช่ความยาวช่วง : ' + t);
  assert.ok(!/7 ชม\. 20 น\./.test(t), 'ห้ามมีความยาวช่วงดิบโผล่เป็นชั่วโมง : ' + t);
});

console.log('T5 ครบ 3 ภาษา — ตรวจจากข้อความที่เรนเดอร์ในโหมด ja จริง');

test('โหมดญี่ปุ่นไม่มีอังกฤษคาอยู่ในบล็อก', () => {
  const ja = makeJaCtx();
  const t = text(ja.holidayWorkDetailBlockHtml(rec({ otHours20: 6.33, otHours30: 2 }), 125));
  // **รายการคำถูกดึงจากโค้ดเอง ไม่ได้พิมพ์ไว้** — รีวิวรอบ 3 และ 4 หักล้างรายการที่พิมพ์มือได้สองครั้ง
  // (รอบ 3: ค้างคำเก่า 'lunch deducted' · รอบ 4: ลืม 'Estimate' กับประโยคคำเตือน ⇒ เปลี่ยนข้อความ
  // อังกฤษโดยไม่แตะ ja.js แล้วทุกเทสต์ยังเขียว) ⇒ รายการที่พิมพ์มือจะล้าสมัยเสมอ เลิกพิมพ์
  englishStrings().forEach(w => assert.ok(!t.includes(w), `ยังมีอังกฤษหลุด "${w}" : ` + t));
  assert.ok(/合計|時間|分/.test(t), 'ควรมีญี่ปุ่นจริง : ' + t);
});

test('โหมดญี่ปุ่นของสาขา "ไม่มีเงินเดือนให้อ่าน" ก็ต้องไม่มีอังกฤษคา', () => {
  // รีวิวรอบ 4: เทสต์ ja เดิมส่ง hourlyRate 125 เสมอ ⇒ สาขา else (ซึ่งเป็นที่เดียวที่ใช้คีย์
  // "Paid on the payslip") ไม่เคยถูกเรนเดอร์เลย · ลบคีย์นั้นออกจาก ja.js แล้วเทสต์ยังเขียว
  const ja = makeJaCtx();
  const t = text(ja.holidayWorkDetailBlockHtml(rec({ otHours20: 6.33, otHours30: 2 }), 0));
  englishStrings().forEach(w => assert.ok(!t.includes(w), `ยังมีอังกฤษหลุด "${w}" : ` + t));
});

test('ทุกสตริงอังกฤษในบล็อกมีคำแปลญี่ปุ่นอยู่จริงใน lang/ja.js', () => {
  const dict = realJaDict();
  englishStrings().forEach(w => assert.ok(
    Object.prototype.hasOwnProperty.call(dict, w), `ไม่มีคีย์ "${w}" ใน lang/ja.js`));
});

test('เงินในป๊อปอัปอ่านเงินเดือนจากเจ้าของเรคอร์ด ไม่ใช่จาก targetUserObj', () => {
  // รีวิวรอบ 4: เปลี่ยนกลับเป็น targetUserObj แล้วทั้ง 65 ไฟล์ยังเขียว ⇒ บั๊กที่เคยแก้ไปกลับมาได้เงียบๆ
  const fn = extractFunction(APP_SRC, 'showAttendanceDetail');
  assert.ok(/const _hwSalary = Number\(_ownerUser && _ownerUser\.salary\) \|\| 0;/.test(fn),
    'เงินเดือนต้องอ่านจาก _ownerUser เท่านั้น');
  assert.ok(!/_hwSalary = Number\(targetUserObj/.test(fn), 'ยังอ่านจาก targetUserObj อยู่');
});

console.log('T6 โหมดแลกวันหยุดต้องไม่มีเงินโผล่ แม้เรคอร์ดเก่าจะมีชั่วโมงติดมา');

// รีวิวรอบ 4 (T5): ตั้งแต่ด่านปล่อยโหมดแลกวันหยุดผ่าน ด่าน `paid` สองตัวกลายเป็นสิ่งเดียวที่กันเงิน
// ไม่ให้รั่วออกประตูนั้น และทั้งสองไม่มียามคุ้ม (ถอดออกแล้วทุกเทสต์ยังเขียว)
test('เรคอร์ดแลกวันหยุดที่มี otHours ติดมา ยังต้องไม่โชว์เงินและไม่โชว์แถวอัตรา', () => {
  const t = text(CTX.holidayWorkDetailBlockHtml(
    rec({ compensationMode: 'annual-leave', workStartTime: '09:00', workEndTime: '20:00',
          otHours20: 7.5, otHours30: 2.5 }), 125));
  assert.ok(!/฿/.test(t), 'โหมดแลกวันหยุดต้องไม่มีเงินเลย : ' + t);
  assert.ok(!/×2|×3/.test(t), 'โหมดแลกวันหยุดต้องไม่มีแถวอัตรา : ' + t);
  assert.ok(/สถานที่|เวลาที่ยื่น/.test(t), 'แต่ยังต้องบอกสถานที่และเวลาที่ยื่น : ' + t);
});

test('badge ของโหมดแลกวันหยุดต้องไม่ติดจำนวนเงิน', () => {
  const fn = extractFunction(APP_SRC, 'showAttendanceDetail');
  assert.ok(/const _hwAmt = \(paid && _hwHourly > 0\)/.test(fn),
    'ยอดเงินบน badge ต้องผูกกับโหมด paid ไม่งั้นใบแลกวันหยุดจะขึ้น "แลกวันหยุด ≈ ฿…"');
});

console.log('T7 สีคำเตือนต้องผ่านเกณฑ์คอนทราสต์ทั้งสองธีม (ยามของ CSS แบบคลาส)');

// รีวิวรอบ 4 (T6): tests/theme-aware-colors.test.js กวาดเฉพาะสี inline ใน index.html/app.js
// ⇒ กฎแบบคลาสใน style.css ไม่มียามเลย · เปลี่ยนกลับเป็นสีที่อ่านไม่ออกแล้วทุกเทสต์ยังเขียว
test('.hw-ot-drift ผ่าน 4.5:1 บนพื้นจริงของทั้งธีมสว่างและธีมมืด', () => {
  const CSS = fs.readFileSync(path.join(ROOT, 'attendance/css/style.css'), 'utf8');
  const hex = s => { const m = /#([0-9a-fA-F]{6})/.exec(s); assert.ok(m, 'หาสีไม่เจอ: ' + s); return m[1]; };
  const base = /\.hw-ot-detail \.hw-ot-drift \{[^}]*?color:\s*(#[0-9a-fA-F]{6})/.exec(CSS);
  const dark = /\[data-theme="dark"\] \.hw-ot-detail \.hw-ot-drift \{[^}]*color:\s*(#[0-9a-fA-F]{6})/.exec(CSS);
  assert.ok(base, 'ไม่พบสีของ .hw-ot-drift (หรือกลับไปใช้ var() ซึ่งวัดไม่ได้ที่นี่)');
  assert.ok(dark, 'ไม่พบสีของธีมมืด ⇒ ธีมมืดจะตกไปใช้สีของธีมสว่าง');
  // พื้นของบล็อกคือ var(--bg) ของแต่ละธีม อ่านจาก style.css เองเพื่อไม่ให้ค่าค้าง
  const lightBg = hex(/:root \{[\s\S]*?--bg:\s*(#[0-9a-fA-F]{6})/.exec(CSS)[0].split('--bg:')[1]);
  const darkBg = hex(/\[data-theme="dark"\] \{[\s\S]*?--bg:\s*(#[0-9a-fA-F]{6})/.exec(CSS)[0].split('--bg:')[1]);
  const lin = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  const lum = h => { const c = [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16));
    return 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]); };
  const ratio = (a, b) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);
  const rLight = ratio(hex(base[1]), lightBg), rDark = ratio(hex(dark[1]), darkBg);
  assert.ok(rLight >= 4.5, `ธีมสว่างได้ ${rLight.toFixed(2)} (ต้อง >= 4.5)`);
  assert.ok(rDark >= 4.5, `ธีมมืดได้ ${rDark.toFixed(2)} (ต้อง >= 4.5)`);
});

console.log(`\n${passed} passed, ${process.exitCode ? 'มีข้อที่ล้มเหลว' : '0 failed'}`);
