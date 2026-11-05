// ช่องตั้งค่าที่ค่า 0 ใช้ไม่ได้ ต้องถูกปฏิเสธตอนบันทึก ไม่ใช่เก็บ 0 แล้วแอบใช้ค่าอื่น
//
// **ที่มา (เจ้าของตัดสิน 2026-11-05):** `fi()` ในหน้าตั้งค่าคือ `parseInt(...) || 0` ⇒ **ช่องว่าง
// กลายเป็น 0** ไม่ใช่ "ไม่เปลี่ยนค่า" · ใครเปิดหน้าตั้งค่า ลบเลขในช่องออกเพราะจะพิมพ์ใหม่ แล้วเผลอ
// กดบันทึกก่อน ค่าจะกลายเป็น 0 ทันที · แต่ฝั่งที่เอาค่าไปใช้ดักด้วย `|| <ค่าปริยาย>` ทุกที่
// ⇒ หน้าตั้งค่าโชว์ 0 และ FAQ โชว์ 0 ให้พนักงานอ่าน **แต่เครื่องคิดเงินใช้ค่าปริยายต่อไป**
// และตัวเลขเงินที่ออกมาก็ยังถูกเหมือนเดิม ⇒ ไม่มีอะไรดูผิด จับได้ยากมาก
//
// ตัวที่กระทบ: `sso.minSalary` (เก็บ 0 แต่ใช้ 1650) · `allowances.longDistanceThresholdKm`
// (เก็บ 0 แต่ใช้ 250) · `sso.maxSalary` (เก็บ 0 แต่ใช้ 17500 ในไฟล์ส่งประกันสังคม)
//
// **ทางที่เจ้าของเลือกคือ "ปฏิเสธ 0 ตอนบันทึก"** ไม่ใช่ "ให้ 0 มีความหมายจริง" เพราะทางหลัง
// ทำให้การพิมพ์ 0 ผิดมือกลายเป็นการเปลี่ยนเงินของพนักงานจริง · ทางนี้ไม่แตะสูตรเงินเลย
// แค่ไม่ให้บันทึกค่าที่ระบบใช้ไม่ได้ · `sso.rate` กับ `sso.maxAmount` ถูกปฏิเสธอยู่แล้วก่อนหน้านี้
// ⇒ รอบนี้คือการทำให้อีกสามช่องเหมือนกัน และย้ายกฎทั้งห้าไปอยู่ที่เดียวที่เทสต์ได้
//
// **ต้องเงียบเมื่อช่องนั้นไม่มีอยู่** (undefined/null) ตามกฎที่ review finding 5 ของ 2026-10-02
// เขียนไว้ในเซิร์ฟเวอร์: ไฟล์ตั้งค่าที่ไม่มีคีย์นั้นไม่ได้ "ผิด" มันแค่ไม่มีอะไรให้ตรวจ และการ
// ปฏิเสธจะไปขัดการบันทึกเรื่องอื่นด้วยข้อความเกี่ยวกับส่วนที่คนนั้นอาจมองไม่เห็นด้วยซ้ำ
//
// ดึงฟังก์ชันจริงจากทั้งสองไฟล์มารันใน sandbox — ยืนยันพฤติกรรม ไม่ใช่ grep
// `node tests/settings-positive-fields.test.js`
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const APP_SRC = fs.readFileSync(path.join(ROOT, 'attendance/js/app.js'), 'utf8');
const SRV_SRC = fs.readFileSync(path.join(ROOT, 'attendance-server/backend/server.js'), 'utf8');
const JA_SRC = fs.readFileSync(path.join(ROOT, 'attendance/lang/ja.js'), 'utf8');

function extractFunction(src, name) {
  const re = new RegExp(`^(async )?function ${name}\\(`, 'm');
  const m = re.exec(src);
  if (!m) throw new Error(`function ${name} not found`);
  const i = src.indexOf('{', m.index);
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (depth === 0) return src.slice(m.index, j + 1); }
  }
  throw new Error(`unbalanced ${name}`);
}

function sandbox(src, name) {
  const ctx = vm.createContext({});
  vm.runInContext(extractFunction(src, name), ctx);
  return vm.runInContext(name, ctx);
}

const clientErr = sandbox(APP_SRC, 'settingsPositiveFieldError');
const serverErr = sandbox(SRV_SRC, 'appSettingsPositiveError');

// คำแปลญี่ปุ่นอยู่ในพจนานุกรมที่คีย์ด้วยข้อความอังกฤษ (L(en, th) อ่าน window.LANG_JA[en])
const jaCtx = vm.createContext({ window: {} });
vm.runInContext(JA_SRC, jaCtx);
const LANG_JA = vm.runInContext('window.LANG_JA', jaCtx);

const ok = () => ({
  sso: { rate: 5, maxAmount: 875, minSalary: 1650, maxSalary: 17500 },
  allowances: { longDistanceThresholdKm: 250 },
});

// ช่องทั้งห้าที่ค่า 0 ใช้ไม่ได้ · id คือช่องกรอกในหน้าตั้งค่าที่ต้องถูกไฮไลต์
const FIELDS = [
  { sec: 'sso', key: 'rate', id: 'set-sso-rate' },
  { sec: 'sso', key: 'maxAmount', id: 'set-sso-max' },
  { sec: 'sso', key: 'minSalary', id: 'set-sso-min-sal' },
  { sec: 'sso', key: 'maxSalary', id: 'set-sso-max-sal' },
  { sec: 'allowances', key: 'longDistanceThresholdKm', id: 'set-longdistance-threshold' },
];

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ', name); }
  catch (e) { process.exitCode = 1; console.log('  FAIL', name, '\n       ', e.message); }
}

function withValue(sec, key, value) {
  const s = ok();
  if (value === '__delete__') delete s[sec][key];
  else s[sec][key] = value;
  return s;
}

console.log('ช่องตั้งค่าที่ 0 ใช้ไม่ได้: ปฏิเสธตอนบันทึก ทั้งหน้าเว็บและเซิร์ฟเวอร์');

test('ค่าปกติทั้งชุด -> ทั้งสองฝั่งไม่ร้อง', () => {
  assert.strictEqual(clientErr(ok()), null, 'ฝั่งหน้าเว็บไม่ควรร้องกับค่าปกติ');
  assert.strictEqual(serverErr(ok()), '', 'ฝั่งเซิร์ฟเวอร์ไม่ควรร้องกับค่าปกติ');
});

test('ค่า 0 ในแต่ละช่อง -> ทั้งสองฝั่งร้อง และหน้าเว็บชี้ช่องที่ถูกต้อง', () => {
  for (const f of FIELDS) {
    const s = withValue(f.sec, f.key, 0);
    const c = clientErr(s);
    assert.ok(c, `[${f.sec}.${f.key}] ฝั่งหน้าเว็บต้องร้องเมื่อค่าเป็น 0`);
    assert.strictEqual(c.id, f.id, `[${f.sec}.${f.key}] ต้องไฮไลต์ช่อง ${f.id}`);
    assert.ok(serverErr(s), `[${f.sec}.${f.key}] ฝั่งเซิร์ฟเวอร์ต้องร้องเมื่อค่าเป็น 0`);
  }
});

test('ช่องกรอกที่ยามอ้างถึง มีอยู่จริงใน app.js (กัน id พิมพ์ผิด)', () => {
  for (const f of FIELDS) {
    assert.ok(APP_SRC.includes(`'${f.id}'`), `ไม่พบช่อง ${f.id} ใน app.js`);
  }
});

test('ค่าติดลบ -> ทั้งสองฝั่งร้อง', () => {
  for (const f of FIELDS) {
    const s = withValue(f.sec, f.key, -1);
    assert.ok(clientErr(s), `[${f.sec}.${f.key}] หน้าเว็บต้องร้องกับค่าติดลบ`);
    assert.ok(serverErr(s), `[${f.sec}.${f.key}] เซิร์ฟเวอร์ต้องร้องกับค่าติดลบ`);
  }
});

test('ไม่ใช่ตัวเลข (สตริง หรือ NaN) -> ทั้งสองฝั่งร้อง', () => {
  for (const bad of ['1650', NaN, Infinity, true, {}, []]) {
    const s = withValue('sso', 'minSalary', bad);
    assert.ok(clientErr(s), `หน้าเว็บต้องร้องกับค่า ${JSON.stringify(String(bad))}`);
    assert.ok(serverErr(s), `เซิร์ฟเวอร์ต้องร้องกับค่า ${JSON.stringify(String(bad))}`);
  }
});

// กฎจาก review finding 5 ของ 2026-10-02 ที่เขียนไว้ในเซิร์ฟเวอร์: ของที่ไม่มี ไม่ใช่ของที่ผิด
test('ช่องที่ไม่มีอยู่ (undefined / null) -> ทั้งสองฝั่งเงียบ', () => {
  for (const f of FIELDS) {
    const gone = withValue(f.sec, f.key, '__delete__');
    assert.strictEqual(clientErr(gone), null, `[${f.sec}.${f.key}] คีย์ที่ไม่มี ไม่ใช่ความผิด`);
    assert.strictEqual(serverErr(gone), '', `[${f.sec}.${f.key}] คีย์ที่ไม่มี ไม่ใช่ความผิด`);
    const nulled = withValue(f.sec, f.key, null);
    assert.strictEqual(clientErr(nulled), null, `[${f.sec}.${f.key}] null ก็คือไม่มี`);
    assert.strictEqual(serverErr(nulled), '', `[${f.sec}.${f.key}] null ก็คือไม่มี`);
  }
});

test('ส่งมาแค่บางส่วน (ไม่มีทั้งก้อน sso หรือ allowances) -> เงียบ', () => {
  for (const partial of [{}, { sso: {} }, { allowances: {} }, { company: { name: 'x' } }, null, undefined]) {
    assert.strictEqual(clientErr(partial), null, `หน้าเว็บต้องเงียบกับ ${JSON.stringify(partial) || String(partial)}`);
    assert.strictEqual(serverErr(partial), '', `เซิร์ฟเวอร์ต้องเงียบกับ ${JSON.stringify(partial) || String(partial)}`);
  }
});

// ด่าน "อัตรา SSO ไม่เกิน 100" เป็นของฝั่งเซิร์ฟเวอร์มาตลอด (หน้าเว็บตรวจแค่ > 0)
// ห้ามหายไปตอนย้ายกฎมารวมกัน · และไม่เปลี่ยนพฤติกรรมฝั่งหน้าเว็บในรอบนี้ เพื่อไม่ต้องแก้ข้อความ
// เตือนที่ผู้ใช้เห็นอยู่แล้ว · กรณีเกิน 100 ผู้ใช้จะเห็นเหตุผลจากเซิร์ฟเวอร์ผ่านข้อความ
// "ไม่สำเร็จ — <เหตุผล>" ซึ่งเป็นเส้นทางเดิมที่มีอยู่ก่อนแล้ว
test('อัตรา SSO เกิน 100 ยังถูกเซิร์ฟเวอร์ปฏิเสธเหมือนเดิม', () => {
  const s = withValue('sso', 'rate', 150);
  assert.ok(serverErr(s), 'เซิร์ฟเวอร์ต้องร้องกับอัตราเกิน 100');
  assert.strictEqual(clientErr(s), null, 'หน้าเว็บไม่เคยตรวจเพดานนี้ และรอบนี้ไม่เปลี่ยน');
  const okRate = withValue('sso', 'rate', 100);
  assert.strictEqual(clientErr(okRate), null, '100 พอดียังใช้ได้');
  assert.strictEqual(serverErr(okRate), '', '100 พอดียังใช้ได้');
});

test('ทั้งสองฝั่งตรวจชุดช่องเดียวกันเป๊ะ (ไม่มีฝั่งไหนตรวจน้อยกว่า)', () => {
  // ไล่ทุกช่องใน sso และ allowances ที่ค่าปกติเป็นตัวเลข แล้วดูว่าฝั่งไหนร้องบ้างเมื่อตั้งเป็น 0
  const base = ok();
  const clientCatches = [], serverCatches = [];
  for (const sec of Object.keys(base)) {
    for (const key of Object.keys(base[sec])) {
      const s = withValue(sec, key, 0);
      if (clientErr(s)) clientCatches.push(`${sec}.${key}`);
      if (serverErr(s)) serverCatches.push(`${sec}.${key}`);
    }
  }
  assert.deepStrictEqual(serverCatches.sort(), clientCatches.sort(),
    'สองฝั่งตรวจไม่ตรงกัน ⇒ ค่าที่หน้าเว็บห้าม จะเข้าทาง API ได้ หรือกลับกัน');
  assert.deepStrictEqual(clientCatches.sort(), FIELDS.map(f => `${f.sec}.${f.key}`).sort(),
    'ชุดช่องที่ถูกตรวจไม่ตรงกับที่ยามนี้ประกาศไว้');
});

// กฎของโปรเจกต์: ข้อความต้องมาพร้อมกันทั้งสามภาษา · ญี่ปุ่นอยู่ใน LANG_JA คีย์ด้วยข้อความอังกฤษ
test('ข้อความเตือนทุกข้อมีคำแปลภาษาญี่ปุ่นใน lang/ja.js', () => {
  const missing = [];
  for (const f of FIELDS) {
    const c = clientErr(withValue(f.sec, f.key, 0));
    assert.ok(c.en && c.th, `[${f.sec}.${f.key}] ต้องมีข้อความทั้งอังกฤษและไทย`);
    if (!LANG_JA[c.en]) missing.push(c.en);
  }
  assert.deepStrictEqual(missing, [], 'ข้อความเหล่านี้ยังไม่มีคำแปลญี่ปุ่นใน attendance/lang/ja.js');
});

test('saveSettingsPage() เรียกยามตัวนี้จริง และไม่เหลือด่านเดิมที่ตรวจทีละช่อง', () => {
  const m = APP_SRC.match(/^async function saveSettingsPage\(\)[\s\S]*?\n\}/m);
  assert.ok(m, 'หา saveSettingsPage() ไม่เจอ');
  const body = m[0].split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
  assert.ok(/settingsPositiveFieldError\(/.test(body),
    'saveSettingsPage() ไม่ได้เรียก settingsPositiveFieldError() ⇒ กฎที่เทสต์ไว้ไม่มีผลกับผู้ใช้จริง');
  assert.ok(!/APP_SETTINGS\.sso\.rate > 0/.test(body),
    'ยังเหลือด่านเดิมที่ตรวจ sso.rate แยก ⇒ กฎอยู่สองที่ แก้ที่เดียวแล้วอีกที่ค้าง');
});

console.log(`\nsettings-positive-fields: ${passed} passed`);
