// ช่วงเวลาของ ×2/×3 ที่เอาไปโชว์ ต้องตรงกับนาทีที่สูตรเงินจ่ายเสมอ (2026-10-28)
// Spec: docs/superpowers/specs/2026-10-27-holiday-work-detail-design.md
//
// ที่มา: ป๊อปอัป Details ของวันที่มี Holiday Work โชว์แค่ผลรวม `8 ชม.` ซึ่งเป็น ×2+×3 บวกกัน
// ⇒ คนอนุมัติเทียบกับใบ working report ไม่ได้ · เจ้าของสั่งให้แยกให้เห็นว่าแต่ละอัตรากินช่วงไหน
//
// **ความเสี่ยงหลักของงานนี้ และเหตุผลที่ไฟล์นี้มีอยู่:** ตัวแสดงผลต้องรู้ "ขอบเขตของแต่ละอัตรา"
// ซึ่งเป็นความรู้ชุดเดียวกับที่สูตรเงิน `splitHolidayWorkOtMinutes` ใช้ · ถ้าวันหนึ่งสูตรเงินเปลี่ยน
// (ขยับ 17:30 · เปลี่ยนกฎพักเที่ยง · เปลี่ยนที่มาของ standardStartHour) แล้วตัวแสดงผลไม่เปลี่ยนตาม
// **หน้าจอจะโกหกอย่างมั่นใจ** — โชว์ช่วงเวลาชุดหนึ่งแต่จ่ายเงินตามอีกชุดหนึ่ง และไม่มีใครรู้
//
// สเปกห้ามแตะ `splitHolidayWorkOtMinutes` (เป็นสูตรเงิน มีฝาแฝดใน server.js ใต้กฎ dual-sync —
// memory `feedback_attendance_payroll_engine_dual_sync.md`) ⇒ แยกค่าคงที่ร่วมไม่ได้โดยไม่แก้มัน
// **ยามนี้คือมาตรการแทน**: กวาดอินพุตทุกคู่ (ไม่ใช่เคสตัวอย่าง) แล้วยืนยันว่าผลรวมนาทีต่ออัตรา
// จาก holidayWorkOtSegments() เท่ากับ otMins20/otMins30 ของสูตรเงิน **เป๊ะทุกคู่**
// ⇒ แก้สูตรเงินด้านเดียวแล้วไฟล์นี้แดงทันที · **ถ้าไฟล์นี้แดง ห้าม merge**
//
// ตามแบบของบ้านนี้: ดึงฟังก์ชันออกจากซอร์สจริงมารันใน vm sandbox ไม่ใช่ก๊อปโค้ดมาวางในเทสต์
// (ของที่ก๊อปมาจะไม่แดงตอนต้นฉบับเปลี่ยน ซึ่งคือบั๊กที่ไฟล์นี้ทั้งไฟล์มีไว้กัน)
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const APP_SRC = fs.readFileSync(path.join(ROOT, 'attendance/js/app.js'), 'utf8');

function extractFunction(src, name) {
  const re = new RegExp(`^(?:async )?function ${name}\\(`, 'm');
  const m = re.exec(src);
  assert.ok(m, `ไม่พบฟังก์ชัน ${name} ใน attendance/js/app.js`);
  const i = src.indexOf('{', m.index);
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (depth === 0) return src.slice(m.index, j + 1); }
  }
  throw new Error(`วงเล็บไม่สมดุลใน ${name}`);
}
// ค่าคงที่ที่ฟังก์ชันพวกนี้อ้างถึง ดึงบรรทัดประกาศจริงออกมา ไม่พิมพ์เลขซ้ำในเทสต์ —
// ถ้า 05:30 ย้าย sandbox นี้จะย้ายตาม ไม่ค้างกับค่าเก่า
function constLine(src, name) {
  const m = src.match(new RegExp(`^const ${name} = .*$`, 'm'));
  assert.ok(m, `ไม่พบ const ${name}`);
  return m[0];
}

const FNS = ['parseHHMMToMins', 'lateNightCheckoutMins', 'holidayWorkEndMins',
  'splitHolidayWorkOtMinutes', 'holidayWorkOtSegments'];
const ctx = { console };
vm.createContext(ctx);
vm.runInContext(
  constLine(APP_SRC, 'HHMM_RE') + '\n' +
  constLine(APP_SRC, 'BUSINESS_DAY_START_MINS') + '\n' +
  FNS.map(n => extractFunction(APP_SRC, n)).join('\n'), ctx);

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok  ${name}`); }
  catch (e) { process.exitCode = 1; console.log(`  FAIL  ${name}\n        ${e.message}`); }
}

const S = {};                                        // ไม่ตั้ง workSchedule ⇒ ใช้ค่าตั้งต้น 08:30
const S7 = { workSchedule: { standardStartHour: 7, standardStartMinute: 0 } };
const S9 = { workSchedule: { standardStartHour: 9, standardStartMinute: 45 } };

const seg = (a, b, s = S) => ctx.holidayWorkOtSegments(a, b, s);
// เทียบแบบ plain object: sandbox เป็น vm realm อื่น prototype ของ Object/Array ไม่ใช่ตัวเดียวกับ
// realm นี้ ⇒ deepStrictEqual จะพังที่ prototype อย่างเดียวแม้ค่าตรงกันหมด (บทเรียนเดียวกับ
// tests/checkin-status-leave.test.js)
// Array.from() ของ realm นี้เป็นตัวสร้างอาร์เรย์ใหม่ — ถ้าเรียก rows.map() ตรงๆ ผลลัพธ์ยังเป็น
// อาร์เรย์ของ sandbox และ deepStrictEqual ก็ยังพังที่ prototype เหมือนเดิม
const plain = rows => Array.from(rows).map(r => ({
  rate: r.rate, startMin: r.startMin, endMin: r.endMin, mins: r.mins, lunchDeducted: r.lunchDeducted,
}));
const hhmm = m => String(Math.floor((m % 1440) / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');

console.log('T1 เคสตามสเปก — แต่ละอัตรากินช่วงไหน');

// เคสจากภาพที่เจ้าของส่งมา (18 ต.ค. 2026) มีครบทั้งสามท่อน และเป็นตัวเลขที่สเปกวาดไว้:
// ×3 07:22–08:30 = 1.13 ชม. · ×2 08:30–17:30 (หักพักเที่ยง) = 8.00 ชม. · ×3 17:30–18:22 = 0.87 ชม.
test('07:22–18:22 แยกเป็น ×3 ท่อนหน้า → ×2 (หักพักเที่ยง) → ×3 ท่อนหลัง', () => {
  assert.deepStrictEqual(plain(seg('07:22', '18:22')), [
    { rate: 30, startMin: 442, endMin: 510, mins: 68, lunchDeducted: false },
    { rate: 20, startMin: 510, endMin: 1050, mins: 480, lunchDeducted: true },
    { rate: 30, startMin: 1050, endMin: 1102, mins: 52, lunchDeducted: false },
  ]);
});

test('09:00–16:00 เป็น ×2 ล้วน และหักพักเที่ยงจริง', () => {
  assert.deepStrictEqual(plain(seg('09:00', '16:00')), [
    { rate: 20, startMin: 540, endMin: 960, mins: 360, lunchDeducted: true },
  ]);
});

// กฎเจ้าของ 2026-10-08: กะที่เลิกไม่เกิน 13:00 ไม่ถูกหักพักเที่ยงเลย — คนนั้นทำงานยาวแล้วกลับบ้าน
// ไม่เคยได้พัก · ป้ายกำกับ "หักพักเที่ยง" จึงต้องไม่โผล่ ไม่ใช่โผล่ทุกกรณีที่คร่อมเที่ยง
test('09:00–12:30 เลิกก่อน 13:00 ⇒ ไม่หักพักเที่ยง และไม่ติดป้ายว่าหัก', () => {
  assert.deepStrictEqual(plain(seg('09:00', '12:30')), [
    { rate: 20, startMin: 540, endMin: 750, mins: 210, lunchDeducted: false },
  ]);
});

test('09:00–13:00 ขอบพอดีของกฎนั้น ⇒ ยังไม่หัก (4.00 ชม. ไม่ใช่ 3.00)', () => {
  assert.deepStrictEqual(plain(seg('09:00', '13:00')), [
    { rate: 20, startMin: 540, endMin: 780, mins: 240, lunchDeducted: false },
  ]);
});

test('18:00–22:00 เป็น ×3 ล้วน ไม่มีแถว ×2 ความยาว 0 โผล่', () => {
  assert.deepStrictEqual(plain(seg('18:00', '22:00')), [
    { rate: 30, startMin: 1080, endMin: 1320, mins: 240, lunchDeducted: false },
  ]);
});

test('06:00–08:00 เป็น ×3 ท่อนหน้าล้วน', () => {
  assert.deepStrictEqual(plain(seg('06:00', '08:00')), [
    { rate: 30, startMin: 360, endMin: 480, mins: 120, lunchDeducted: false },
  ]);
});

// ข้ามเที่ยงคืน: ทั้งกะจ่ายอัตราของวันที่เริ่ม และทุกชั่วโมงหลังเที่ยงคืนเป็น ×3
// endMin เกิน 1440 ได้ตามเจตนา (นาทีนับจาก 00:00 ของวันทำงาน) ตัวแสดงผลเป็นฝ่ายห่อ 24 ชม. เอง
test('20:00–02:00 ข้ามเที่ยงคืน ⇒ ×3 ทั้งกะ และ endMin ทะลุ 1440', () => {
  assert.deepStrictEqual(plain(seg('20:00', '02:00')), [
    { rate: 30, startMin: 1200, endMin: 1560, mins: 360, lunchDeducted: false },
  ]);
  assert.strictEqual(hhmm(1560), '02:00', 'ตัวห่อ 24 ชม. ของฝั่งแสดงผลต้องคืน 02:00');
});

// พิสูจน์ว่าอ่าน standardStartHour จาก settings จริง ไม่ได้ฝัง 08:30 ไว้:
// ถ้าเริ่มงานมาตรฐานคือ 07:00 แล้วพนักงานเริ่ม 07:22 ⇒ ไม่มี ×3 ท่อนหน้าอีกแล้ว เหลือ 2 ท่อน
test('standardStartHour 07:00 ⇒ 07:22 ไม่มี ×3 ท่อนหน้า (อ่านจาก settings ไม่ได้ฝังเลข)', () => {
  assert.deepStrictEqual(plain(seg('07:22', '18:22', S7)), [
    { rate: 20, startMin: 442, endMin: 1050, mins: 548, lunchDeducted: true },
    { rate: 30, startMin: 1050, endMin: 1102, mins: 52, lunchDeducted: false },
  ]);
});

test('standardStartHour 09:45 ⇒ ×3 ท่อนหน้ายาวขึ้นตาม settings', () => {
  const rows = plain(seg('07:22', '18:22', S9));
  assert.strictEqual(rows[0].rate, 30);
  assert.strictEqual(rows[0].endMin, 9 * 60 + 45, '×3 ท่อนหน้าต้องจบที่ standardStart ของ settings');
  assert.strictEqual(rows[1].startMin, 9 * 60 + 45, '×2 ต้องเริ่มที่ standardStart ของ settings');
});

console.log('T2 รูปร่างของผลลัพธ์');

test('อินพุตที่ใช้ไม่ได้คืนอาร์เรย์ว่าง ไม่ใช่ NaN หรือ throw', () => {
  [['', '17:00'], ['08:00', ''], [null, null], ['25:00', '26:00'], ['abc', 'def'],
   ['17:00', '17:00'], ['04:00', '03:00']].forEach(([a, b]) => {
    const r = seg(a, b);
    assert.ok(Array.isArray(r), `${a}–${b} ต้องคืนอาร์เรย์`);
    assert.strictEqual(r.length, 0, `${a}–${b} ต้องไม่มีท่อนใดเลย`);
  });
});

test('ไม่มีท่อนความยาว 0 นาทีหลุดออกมาเลย ไม่ว่าอินพุตใด', () => {
  for (let s = 0; s < 1440; s += 15) {
    for (let e = 0; e < 1440; e += 15) {
      seg(hhmm(s), hhmm(e)).forEach(r => {
        assert.ok(r.mins > 0, `${hhmm(s)}–${hhmm(e)} มีท่อน ${r.rate} ยาว ${r.mins} นาที`);
      });
    }
  }
});

test('ท่อนเรียงตามเวลาจริงเสมอ และไม่คาบเกี่ยวกัน', () => {
  for (let s = 0; s < 1440; s += 15) {
    for (let e = 0; e < 1440; e += 15) {
      const rows = seg(hhmm(s), hhmm(e));
      for (let i = 1; i < rows.length; i++) {
        assert.ok(rows[i].startMin >= rows[i - 1].endMin,
          `${hhmm(s)}–${hhmm(e)} ท่อนที่ ${i} เริ่ม ${rows[i].startMin} ก่อนท่อนก่อนจบ ${rows[i - 1].endMin}`);
      }
    }
  }
});

test('อัตราเป็น 20 หรือ 30 เท่านั้น และป้ายหักพักเที่ยงติดได้แค่กับ ×2', () => {
  for (let s = 0; s < 1440; s += 15) {
    for (let e = 0; e < 1440; e += 15) {
      seg(hhmm(s), hhmm(e)).forEach(r => {
        assert.ok(r.rate === 20 || r.rate === 30, `อัตราแปลก: ${r.rate}`);
        assert.strictEqual(typeof r.lunchDeducted, 'boolean', 'lunchDeducted ต้องเป็น boolean');
        if (r.rate === 30) assert.strictEqual(r.lunchDeducted, false, '×3 ไม่เคยถูกหักพักเที่ยง');
      });
    }
  }
});

console.log('T3 ยามกันค่าเพี้ยน — ผลรวมนาทีต้องเท่ากับสูตรเงินทุกคู่อินพุต');

// นี่คือข้อที่สำคัญที่สุดของไฟล์นี้ · ไม่ใช่เคสตัวอย่าง แต่กวาดทุกคู่ · ถ้าสูตรเงินถูกแก้ด้านเดียว
// (ขยับ 17:30 · เปลี่ยนกฎพักเที่ยง · เลิกอ่าน settings) ข้อนี้แดงทันที
[['ค่าตั้งต้น 08:30', S], ['standardStart 07:00', S7], ['standardStart 09:45', S9]].forEach(([label, cfg]) => {
  test(`ผลรวมนาทีต่ออัตราเท่ากับ splitHolidayWorkOtMinutes ทุกคู่ (${label})`, () => {
    let checked = 0, withWork = 0;
    for (let s = 0; s < 1440; s += 10) {
      for (let e = 0; e < 1440; e += 10) {
        const a = hhmm(s), b = hhmm(e);
        const money = ctx.splitHolidayWorkOtMinutes(a, b, cfg);
        const rows = ctx.holidayWorkOtSegments(a, b, cfg);
        const sum = r => rows.filter(x => x.rate === r).reduce((t, x) => t + x.mins, 0);
        assert.strictEqual(sum(20), money.otMins20, `${a}–${b}: ×2 รวม ${sum(20)} แต่สูตรเงินจ่าย ${money.otMins20}`);
        assert.strictEqual(sum(30), money.otMins30, `${a}–${b}: ×3 รวม ${sum(30)} แต่สูตรเงินจ่าย ${money.otMins30}`);
        checked++;
        if (money.otMins20 + money.otMins30 > 0) withWork++;
      }
    }
    // ยามที่กวาดแต่คู่ที่ไม่มีงานเลยจะเขียวโดยไม่ได้ตรวจอะไร — ยืนยันว่ากวาดของจริงพอ
    assert.ok(checked > 20000, `กวาดแค่ ${checked} คู่ น้อยเกินไป`);
    assert.ok(withWork > 5000, `มีแค่ ${withWork} คู่ที่มีชั่วโมงจ่ายจริง — ยามนี้แทบไม่ได้ตรวจอะไร`);
  });
});

// ป้าย "หักพักเที่ยง" ต้องไม่ใช่การเดา: มันต้องตรงกับการที่สูตรเงินหักจริงหรือไม่ · พิสูจน์โดย
// เทียบนาที ×2 ที่ได้ กับความยาวช่วงดิบ — หักจริงเมื่อไหร่ สองค่านั้นต่างกันเมื่อนั้น
test('ป้ายหักพักเที่ยงตรงกับการที่สูตรเงินหักจริง ทุกคู่อินพุต', () => {
  for (let s = 0; s < 1440; s += 10) {
    for (let e = 0; e < 1440; e += 10) {
      const rows = ctx.holidayWorkOtSegments(hhmm(s), hhmm(e), S);
      rows.filter(r => r.rate === 20).forEach(r => {
        const raw = r.endMin - r.startMin;
        assert.strictEqual(r.lunchDeducted, r.mins < raw,
          `${hhmm(s)}–${hhmm(e)}: ป้ายบอก ${r.lunchDeducted} แต่ช่วง ${raw} นาทีจ่าย ${r.mins} นาที`);
      });
    }
  }
});

console.log('T4 รูปแบบเวลาที่อ่านแล้วไม่เข้าใจผิด');

// ที่มา: เจ้าของอ่าน "6.33 ชม." บนหน้าจอตัวเองแล้วถามว่า "ทำไมถึงขึ้นว่า 6ชั่วโมง33นาที ถ้า
// 09-16.20 มันควรจะเป็น 6ชั่วโมง20 นาทีไม่ใช่เหรอ หักพักเที่ยงแล้ว" · ตัวเลขถูก (380 นาที = 6.33
// ชั่วโมง) แต่ป๊อปอัปเดียวกันเขียน "7 ชั่วโมง 23 นาที" อยู่สองบรรทัดเหนือมัน ⇒ ตาอ่านทศนิยมต่อ
// เป็นนาทีทันที · คนออกแบบกฎเงินเองยังอ่านผิด คนอนุมัติที่เทียบกับใบ working report ยิ่งอ่านผิด
const dctx = { currentLang: 'th', L: (en, th) => th, console };
vm.createContext(dctx);
vm.runInContext(extractFunction(APP_SRC, 'holidayWorkDurationLabel'), dctx);

// 2026-10-28 (รีวิวรอบ 5): สี่ข้อที่นี่เคยตรวจฟิลด์ `dec` และคอมเมนต์เหนือมันเขียนว่า "`dec` ยังถูก
// คืนและยังตรวจอยู่ เพราะมันคือการแปลงนาที→ชั่วโมงที่ใช้เทียบกับ otHours ที่เก็บไว้" — **ไม่จริง**
// ไล่ทั้ง 7 จุดที่เรียก holidayWorkDurationLabel() แล้ว ทุกจุดอ่าน `.hm` และยามกันค่าเพี้ยนคำนวณ
// นาทีของตัวเอง (`Math.round(h20 * 60)`) ไม่เคยแตะ `dec` ⇒ หกบรรทัดนั้นตรวจโค้ดตาย โดยมีคอมเมนต์
// รับรองว่ามันสำคัญ · ฟิลด์ถูกลบออกจาก app.js แล้ว และแทนด้วยข้อล่างที่ตรวจของที่ผู้ใช้เห็นจริง
test('380 นาที (เคสของเจ้าของ) อ่านว่า 6 ชม. 20 น.', () => {
  assert.strictEqual(dctx.holidayWorkDurationLabel(380).hm, '6 ชม. 20 น.');
});

test('ชั่วโมงลงตัวไม่ต้องมีคำว่านาที', () => {
  assert.strictEqual(dctx.holidayWorkDurationLabel(480).hm, '8 ชม.');
});

test('เศษน้อยๆ ก็ยังอ่านเป็นนาทีจริง ไม่ใช่ทศนิยม', () => {
  assert.strictEqual(dctx.holidayWorkDurationLabel(68).hm, '1 ชม. 8 น.');
  // ท่อนที่สั้นกว่าหนึ่งชั่วโมงอ่านว่า "52 น." ไม่ใช่ "0 ชม. 52 น."
  assert.strictEqual(dctx.holidayWorkDurationLabel(52).hm, '52 น.');
  assert.strictEqual(dctx.holidayWorkDurationLabel(0).hm, '0 น.');
});

// แทนข้อ "hm กับ dec ตรงกัน" ที่เทียบของที่ไม่มีใครเห็นกับของที่ไม่มีใครเห็น · ข้อนี้แกะสตริงที่
// **ผู้ใช้อ่านจริง** กลับเป็นจำนวนนาที แล้วบังคับให้ตรงเป๊ะกับที่ส่งเข้าไป ⇒ ป้ายโกหกเรื่องเวลาไม่ได้
// เลยแม้นาทีเดียว และยังกันทศนิยมหลุดกลับมาด้วย (รูปแบบที่แกะไม่ออกจะแดงทันที)
test('สตริงที่ผู้ใช้อ่าน แกะกลับเป็นจำนวนนาทีเดิมได้ตรงเป๊ะทุกค่า และไม่มีทศนิยมโผล่', () => {
  for (let m = 0; m <= 30 * 60; m++) {
    const hm = dctx.holidayWorkDurationLabel(m).hm;
    assert.ok(!/\d+\.\d+/.test(hm), `${m} นาที ได้สตริงที่มีทศนิยม: ${hm}`);
    const mo = /^(?:(\d+) ชม\.)?(?: )?(?:(\d+) น\.)?$/.exec(hm);
    assert.ok(mo, `${m} นาที ได้สตริงที่แกะไม่ออก: ${hm}`);
    const back = (Number(mo[1]) || 0) * 60 + (Number(mo[2]) || 0);
    assert.strictEqual(back, m, `${m} นาที อ่านออกมาเป็น ${back} นาที (${hm})`);
  }
});

test('ญี่ปุ่นใช้รูปแบบของตัวเอง', () => {
  const jctx = { currentLang: 'ja', L: (en) => en, console };
  vm.createContext(jctx);
  vm.runInContext(extractFunction(APP_SRC, 'holidayWorkDurationLabel'), jctx);
  assert.strictEqual(jctx.holidayWorkDurationLabel(380).hm, '6時間20分');
  assert.strictEqual(jctx.holidayWorkDurationLabel(480).hm, '8時間');
  assert.strictEqual(jctx.holidayWorkDurationLabel(52).hm, '52分');
});

console.log('T5 ทศนิยมบนจอต้องเป็นเลขเดียวกับที่สลิปจ่าย');

// พบตอนรีวิว 2026-10-28: ถ้าใส่ทศนิยมไว้ทีละแถว แต่ละแถวจะปัดของตัวเอง ขณะที่ payroll ปัด
// **ผลรวมของอัตรานั้น** (`round2(otMins30)`) ⇒ กะที่เลยทั้ง 08:30 และ 17:30 จะมี ×3 สองท่อน
// แล้วสองการปัดนั้นไม่ตรงกัน · วัดแล้ว: มีคู่เวลาที่ไม่ตรงอยู่หลายหมื่นคู่ · ข้อนี้พิสูจน์ว่าปัญหา
// มีอยู่จริง และพิสูจน์ว่าโค้ดเลิกทำแบบนั้นแล้ว
test('การปัดทีละท่อนไม่ตรงกับการปัดผลรวม — ปัญหามีจริง ไม่ใช่ความกังวลลอยๆ', () => {
  const round2 = n => Math.round(n / 60 * 100) / 100;
  let bad = 0, eg = null;
  for (let s = 0; s < 1440; s += 1) {
    for (let e = 0; e < 1440; e += 7) {
      const a = hhmm(s), b = hhmm(e);
      const money = ctx.splitHolidayWorkOtMinutes(a, b, S);
      const segs = Array.from(ctx.holidayWorkOtSegments(a, b, S)).filter(x => x.rate === 30);
      if (segs.length < 2) continue;
      const perRow = segs.reduce((t, x) => t + round2(x.mins), 0);
      if (Math.abs(perRow - money.otHours30) > 1e-9) {
        bad++;
        if (!eg) eg = `${a}–${b}: ทีละท่อนรวมได้ ${perRow.toFixed(2)} แต่สลิปจ่าย ${money.otHours30.toFixed(2)}`;
      }
    }
  }
  assert.ok(bad > 0, 'ไม่เจอคู่ที่ต่างกันเลย — สมมติฐานของข้อนี้ผิด ให้ตรวจใหม่');
  console.log(`        (คู่ที่ปัดทีละท่อนแล้วเพี้ยน: ${bad} · ตัวอย่าง ${eg})`);
});

// **สองข้อที่เคยอยู่ตรงนี้ถูกถอดออกเมื่อ 2026-10-28** — รีวิวชี้ว่าชื่อมันอ้างมากกว่าที่ตรวจจริง:
// ข้อ "ไม่มีทศนิยมหลงเหลือ" เป็น negative regex แค่ 3 รูปแบบ (ทศนิยมที่เขียนรูปอื่นผ่านฉลุย) และ
// ข้อ "เงินคิดด้วยสูตรเดียวกับ otPayAmountFromLeave" ตรวจแค่ว่าซอร์สมีข้อความนั้น ไม่เคยเรียกสอง
// ฟังก์ชันมาเทียบเลขเลย · ยามแบบนั้นเขียวต่อไปได้แม้พฤติกรรมเปลี่ยน และแดงเวลาแค่เปลี่ยนชื่อตัวแปร
// ⇒ ของจริงย้ายไป `tests/holiday-work-detail-block.test.js` ซึ่งเรนเดอร์บล็อกจริงแล้วอ่านผลลัพธ์:
// เทียบบาทกับ otPayAmountFromLeave 30 เคส · ตรวจว่าไม่มี "เลข.เลข ชม." โผล่บนจอ · และตรวจ 3 ภาษา

console.log(`\n${passed} passed, ${process.exitCode ? 'มีข้อที่ล้มเหลว' : '0 failed'}`);
