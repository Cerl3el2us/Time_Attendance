// สลิป: บรรทัดรายได้โชว์เมื่อ "มีเงิน" ไม่ใช่เมื่อ "มีสิทธิ์" (2026-10-28)
//
// **กฎนี้เจ้าของพูดเอง** หลังผมอธิบายเรื่องเงิน OT วันหยุดผิดไปสองรอบ:
//   "โดยปกติ ถ้าไม่ได้รับเงินส่วนไหน ชื่อส่วนนั้นจะไม่โชว์ในสลิป แต่ถ้าได้รับเงินก็จะโชว์ชื่อส่วนนั้น
//    ในสลิปด้วย และถ้าได้รับเงินนั่นหมายความว่าต้องได้รับสิทธิ์ OT"
//
// ก่อนหน้านี้สองใบขัดกันเอง: Excel ตัดบรรทัดยอดศูนย์ออกตั้งแต่ 2026-09-15 (ตามที่เจ้าของขอ)
// ส่วนเว็บโชว์เป็น "—" ตามคอมเมนต์ 2026-08-02 ที่อ้างว่า "mirrors payslipXlsx.js's canShow()
// exactly" — ซึ่งเลิกจริงไปตั้งแต่ 2026-09-15 · และทั้งสองใบเอา **สิทธิ์** มากรองซ้ำอีกชั้น
// ซึ่งมีผลเดียวคือ **ซ่อนบรรทัดที่มีเงินอยู่**
//
// ทำไมใช้ยอดเงินเป็นด่านเดียวได้: `computePayroll` ทำยอดเป็น 0 ให้เองเมื่อ role ไม่มีสิทธิ์ ·
// วัดกับพนักงานจริง 10 คน × 9 เบี้ยเมื่อ 2026-10-28: 8 เบี้ยได้ 0 ทันทีที่ถอดสิทธิ์ เหลือแต่ `ot`
// ที่ยังมีเงิน เพราะช่อง OT ×2/×3 รับเงินจาก **สองสิทธิ์** — ใบ OT ปกติ (`ot`) และใบทำงานวันหยุด
// (`holidayWork`) ⇒ "มีเงิน = มีสิทธิ์" เป็นจริง และการกรองด้วย `ot` อย่างเดียวคือการกรองผิดตัว
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const APP_SRC = fs.readFileSync(path.join(ROOT, 'attendance/js/app.js'), 'utf8');
const XLSX_SRC = fs.readFileSync(path.join(ROOT, 'attendance-server/backend/payslipXlsx.js'), 'utf8');

let pass = 0;
const fails = [];
function test(name, fn) {
  try { fn(); console.log('  ok  ' + name); pass++; }
  catch (e) { console.log('  FAIL  ' + name + ' \n        ' + e.message); fails.push(name); }
}

// ตัดคอมเมนต์บรรทัดออกก่อนตรวจทุกครั้ง — คอมเมนต์ของกฎนี้เอ่ยชื่อสิ่งที่มันห้าม
const noCmt = s => s.replace(/^[ \t]*\/\/[^\n]*$/gm, '');

function extractFunction(src, name) {
  const re = new RegExp(`^(?:async )?function ${name}\\(`, 'm');
  const m = re.exec(src);
  assert.ok(m, `ไม่พบฟังก์ชัน ${name}`);
  const open = src.indexOf('(', m.index);
  let p = 0, after = -1;
  for (let j = open; j < src.length; j++) {
    if (src[j] === '(') p++;
    else if (src[j] === ')') { p--; if (p === 0) { after = j + 1; break; } }
  }
  const i = src.indexOf('{', after);
  let d = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') d++;
    else if (src[j] === '}') { d--; if (!d) return src.slice(m.index, j + 1); }
  }
  throw new Error('unbalanced ' + name);
}

console.log('T1 สลิปบนเว็บ: ทุกบรรทัดรายได้ผูกกับยอดเงินของตัวเอง');

// บรรทัด → ค่าที่ต้องเป็นด่าน · ค่าที่เลือกคือ **ตัวเดียวกับที่โค้ดใช้ตัดสินว่าจะพิมพ์ยอดหรือ "—"**
// จึงเป็นไปไม่ได้ที่บรรทัดจะโชว์แล้วข้างในว่าง
const WEB_ROWS = [
  ['payslip-diligence-row', 'diligenceAllowance'],
  ['payslip-ot15-row', 'ot15Amount'],
  ['payslip-ot20-row', 'ot20Amount'],
  ['payslip-ot30-row', 'ot30Amount'],
  ['payslip-a1-row', 'allowance1'],
  ['payslip-a2-row', 'earlyLateBonus'],
  ['payslip-a3-row', 'allowance3'],
];

test('บรรทัดที่คุมด้วย rowVis() ผูกกับยอดเงิน ไม่ใช่สิทธิ์', () => {
  const fn = noCmt(extractFunction(APP_SRC, 'renderPayslip'));
  for (const [id, amountVar] of WEB_ROWS) {
    const re = new RegExp(`rowVis\\('${id}',\\s*${amountVar} > 0\\)`);
    assert.ok(re.test(fn),
      `${id} ไม่ได้ผูกกับ \`${amountVar} > 0\` ⇒ อาจกลับไปใช้สิทธิ์เป็นด่าน`);
  }
});

test('บรรทัดที่คุม style.display เองก็ผูกกับยอดเงิน', () => {
  const fn = noCmt(extractFunction(APP_SRC, 'renderPayslip'));
  for (const [label, re] of [
    ['Long Distance', /ldRowEl\.style\.display = longDistanceTotal > 0/],
    ['Personal Car', /pcRowEl\.style\.display = personalCarTotal > 0/],
    ['Holiday Transport', /htRowEl\.style\.display = holidayTransportTotal > 0/],
    ['Abroad', /abRowEl\.style\.display = abTotal > 0/],
    ['Bonus', /bonusRowEl\.style\.display = bonus > 0/],
  ]) {
    assert.ok(re.test(fn), `บรรทัด ${label} ไม่ได้ผูกกับยอดเงินของตัวเอง`);
  }
});

// ข้อนี้คือตัวที่จะแดงถ้าใครเอาสิทธิ์กลับมาเป็นด่านของบรรทัดรายได้ ไม่ว่าจะเขียนรูปแบบไหน
test('ไม่มีบรรทัดรายได้ไหนถูกซ่อนด้วย view.eligibility อีก', () => {
  const fn = noCmt(extractFunction(APP_SRC, 'renderPayslip'));
  const EARNING_IDS = WEB_ROWS.map(r => r[0]).concat([
    'payslip-longdistance-row', 'payslip-personalcar-row',
    'payslip-holidaytransport-row', 'payslip-abroad-row', 'payslip-bonus-row',
  ]);
  for (const id of EARNING_IDS) {
    // ดูประโยคที่เอ่ยถึง id นั้น (หรือตัวแปร element ของมัน) แล้วห้ามมี view.eligibility อยู่ในนั้น
    const idx = fn.indexOf(id);
    assert.ok(idx > 0, `หาบรรทัด ${id} ไม่เจอในสลิป ⇒ โครงเปลี่ยน ให้ทบทวนยามนี้`);
    const stmtEnd = fn.indexOf(';', idx);
    const stmt = fn.slice(Math.max(0, fn.lastIndexOf('\n', idx)), stmtEnd + 1);
    assert.ok(!/view\.eligibility/.test(stmt),
      `${id} ยังถูกกรองด้วยสิทธิ์: ${stmt.replace(/\s+/g, ' ').trim()}`);
  }
});

console.log('T2 สลิป Excel: รายการรายได้ไม่มี canShow() แล้ว และยังตัดยอดศูนย์ออก');

function earningsItemsSrc() {
  const i = XLSX_SRC.indexOf('const earningsItems = [');
  assert.ok(i > 0, 'หา earningsItems ไม่เจอ');
  const end = XLSX_SRC.indexOf('.filter(([, amount]) => (amount || 0) > 0);', i);
  assert.ok(end > i, 'ตัวกรอง "ยอดศูนย์ไม่โชว์" หายไปจาก earningsItems ⇒ กฎของเจ้าของถูกถอดออก');
  return XLSX_SRC.slice(i, end);
}

test('รายการรายได้ของ Excel ไม่มี canShow() เหลืออยู่', () => {
  const src = noCmt(earningsItemsSrc());
  assert.ok(!/canShow\(/.test(src),
    'ยังมี canShow() ในรายการรายได้ ⇒ บรรทัดที่มีเงินอาจถูกซ่อน:\n       ' +
    (src.match(/[^\n]*canShow\([^\n]*/g) || []).join('\n       '));
});

test('ตัวกรอง "ไม่มีเงินไม่โชว์" ยังอยู่ และฝั่งหักเงินยังโชว์ทุกเดือน', () => {
  assert.ok(/\.filter\(\(\[, amount\]\) => \(amount \|\| 0\) > 0\);/.test(XLSX_SRC),
    'ตัวกรองยอดศูนย์ของรายการรายได้หายไป');
  // SSF/PVD/PIT ต้องไม่ถูกกรองด้วยยอด — เจ้าของตัดสินไว้ 2026-07-31 ว่ามีทุกเดือนอยู่แล้ว
  const d = XLSX_SRC.indexOf('const deductionItems = [');
  assert.ok(d > 0, 'หา deductionItems ไม่เจอ');
  const dEnd = XLSX_SRC.indexOf('];', d);
  const dSrc = noCmt(XLSX_SRC.slice(d, dEnd));
  assert.ok(!/\(amount \|\| 0\) > 0/.test(dSrc),
    'ฝั่งหักเงินถูกกรองด้วยยอดเงินแล้ว ⇒ ขัดกับที่เจ้าของตัดสินไว้ว่า deduct มีทุกเดือน');
});

console.log('T3 เชิงพฤติกรรม: มีเงิน ⇒ บรรทัดต้องขึ้น แม้ role ไม่มีสิทธิ์นั้น');

// ประกอบ earningsItems ตัวจริงขึ้นมาใหม่ในกล่อง แล้วดูว่าได้บรรทัดอะไรออกมา
function earningsFor(calc, fin, eligibility) {
  const src = earningsItemsSrc() + '.filter(([, amount]) => (amount || 0) > 0);';
  const ctx = { calc, fin, console, eligibility,
    canShow: k => (eligibility ? !!eligibility[k] : true), Math, Number, Object, Array };
  vm.createContext(ctx);
  vm.runInContext('const otTotal = Math.round((((calc.ot15Amount||0)+(calc.ot20Amount||0)+(calc.ot30Amount||0))*100)+1e-9)/100;\n'
    + src.replace('const earningsItems =', 'out =').replace(/^\s*const earningsItems\s*=/, 'out ='), ctx);
  // `Array.from` ก่อน map — อาเรย์ที่สร้างในกล่อง vm มี prototype ของกล่อง ถ้า map ตรงๆ
  // ผลลัพธ์จะยังถือ prototype นั้นไว้ แล้ว deepStrictEqual จะไม่ผ่านแม้ค่าจะตรงกันทุกตัว
  return Array.from(ctx.out).map(([label, amount]) => label + '=' + amount);
}
const ZERO_CALC = {
  base: 0, posAllowance: 0, housingAllowance: 0, transport: 0, diligenceAllowance: 0,
  ot15Amount: 0, ot20Amount: 0, ot30Amount: 0, allowance1: 0, allowance2: 0, allowance3: 0,
  longDistanceTotal: 0, personalCarTotal: 0, holidayTransportTotal: 0, abroadTotal: 0,
};

test('เงิน OT วันหยุดของคนที่ไม่มีสิทธิ์ ot ⇒ บรรทัด Overtime Pay ยังขึ้น', () => {
  const calc = Object.assign({}, ZERO_CALC, { base: 30000, ot20Amount: 2000 });
  const items = earningsFor(calc, { bonus: 0, manualAllowances: [] }, { ot: false, holidayWork: true });
  assert.ok(items.some(x => x.startsWith('Overtime Pay=')),
    'เงิน ฿2,000 อยู่ในยอดรวมแต่ไม่มีบรรทัดอธิบาย ⇒ สลิปบวกไม่ลงตัว: ' + items.join(' · '));
  assert.ok(items.includes('Overtime Pay=2000'), items.join(' · '));
});

test('ไม่มีเงินในส่วนไหน ชื่อส่วนนั้นไม่โชว์', () => {
  const items = earningsFor(Object.assign({}, ZERO_CALC, { base: 30000 }),
    { bonus: 0, manualAllowances: [] }, { ot: true, upcountry: true, earlyLate: true, phone: true });
  assert.deepStrictEqual(items, ['Basic Salary=30000'],
    'มีแต่เงินเดือน แต่ยังมีบรรทัดอื่นโผล่: ' + items.join(' · '));
});

test('มีเงินหลายส่วน ⇒ โชว์ครบทุกส่วนที่มีเงิน', () => {
  const calc = Object.assign({}, ZERO_CALC, {
    base: 30000, ot30Amount: 1500, allowance1: 240, holidayTransportTotal: 500 });
  const items = earningsFor(calc, { bonus: 0, manualAllowances: [] }, {});
  assert.deepStrictEqual(items.sort(), [
    'Allowance 1 (Upcountry)=240', 'Basic Salary=30000',
    'Holiday Transport Allowance=500', 'Overtime Pay=1500',
  ], items.join(' · '));
});

console.log('');
if (fails.length) {
  console.log(pass + ' passed, ' + fails.length + ' failed');
  process.exit(1);
}
console.log(pass + ' passed, 0 failed');
