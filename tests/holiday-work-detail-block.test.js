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
  const ja = makeCtx('ja');
  // โหลดดิกชันนารีจริงจาก lang/ja.js
  const dict = {};
  vm.runInNewContext(JA_SRC + '\nout.d = window.LANG_JA;', { window: {}, out: dict });
  ja._ja = dict.d;
  const t = text(ja.holidayWorkDetailBlockHtml(rec({ otHours20: 6.33, otHours30: 2 }), 125));
  // รายการนี้ต้องเป็น **คำที่โค้ดส่งเข้า L() จริงในวันนี้** · รีวิวรอบ 3 พิสูจน์ว่ารายการเดิมยังเขียน
  // 'lunch deducted' ซึ่งถูกเปลี่ยนเป็น 'lunch' ไปแล้ว ⇒ ลบคีย์ "lunch" ออกจาก ja.js แล้วเทสต์ยังเขียว
  // ⇒ สตริงเดียวที่คอมมิตนั้นเพิ่ม ไม่มียามคุ้มเลย
  ['Total for this day', 'Estimate', 'lunch', 'Claimed hours', 'Location', 'no longer match']
    .forEach(w => assert.ok(!t.includes(w), `ยังมีอังกฤษหลุด "${w}" : ` + t));
  assert.ok(/合計|時間|分/.test(t), 'ควรมีญี่ปุ่นจริง : ' + t);
});

// ยามของยาม: รายการคำข้างบนต้องตรงกับคำที่โค้ดใช้จริง ไม่ใช่คำที่เคยใช้
test('ทุกคำในรายการคำต้องห้ามยังถูกส่งเข้า L() จริงในโค้ดวันนี้', () => {
  const fn = extractFunction(APP_SRC, 'holidayWorkDetailBlockHtml');
  ['Total for this day', 'lunch', 'Claimed hours', 'Location']
    .forEach(w => assert.ok(fn.includes(`L('${w}'`), `'${w}' ไม่ได้ถูกใช้ในโค้ดแล้ว ⇒ รายการคำล้าสมัย`));
});

console.log(`\n${passed} passed, ${process.exitCode ? 'มีข้อที่ล้มเหลว' : '0 failed'}`);
