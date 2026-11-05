// บัญชี superadmin ต้องกลับมาเองถ้าหาย — ยามของกลไก "ไฟล์เมล็ด" (seed)
//
// โจทย์จากเจ้าของ 2026-11-05: "บัญชีนี้จะต้องไม่มีปัญหาในการใช้งาน และหากบัญชีถูกลบไปด้วย
// ความผิดพลาดอะไรสักอย่าง บัญชีนี้จะต้องกลับมาได้" + "หากวันข้างหน้าเปลี่ยนคอมเครื่องใหม่
// ต้องสามารถใช้งานบัญชีนี้ได้" · เจ้าของเลือกให้ "กลับเองเงียบๆ" และบอกว่ารหัสผ่านอยู่ในหัว
// ไม่ได้เก็บไว้ที่ไหน ⇒ ระบบเก็บได้แค่ **แฮช** ไม่ใช่รหัสจริง
// แบบเต็ม: docs/superpowers/specs/2026-11-05-superadmin-account-durability-design.md
//
// ทำไมต้องมีกลไกนี้: ตรวจบน NAS จริงเมื่อ 2026-11-05 แล้วพบว่า
// /usr/local/etc/rc.d/attendance-autostart.sh **ไม่ส่ง SUPERADMIN_PASSWORD เลย** (grep ไม่เจอ
// คำนี้ในสคริปต์) และตัวเฝ้าตัวนั้นคือคนสตาร์ต backend มาเป็นเดือน ⇒ คำโฆษณาเดิมที่หัวไฟล์
// systemAccount.js ว่า "re-created automatically on every backend start" **ไม่จริง**ในทางปฏิบัติ
// มันจริงเฉพาะเมื่อ deploy ด้วยสคริปต์จากเครื่องที่ตั้งตัวแปรไว้
//
// ยามนี้รันจริงทั้งหมดด้วย seedStore ปลอมในหน่วยความจำ ไม่แตะดิสก์ ไม่แตะ NAS
'use strict';
const assert = require('assert');
const path = require('path');

const systemAccount = require(path.join(__dirname, '..', 'attendance-server/backend/systemAccount.js'));

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ', name); }
  catch (e) { process.exitCode = 1; console.log('  FAIL', name, '\n       ', e.message); }
}

// bcrypt ปลอม: ต้องคืนแฮชที่ "หน้าตาเหมือน bcrypt" เพราะสเปกบังคับให้ตรวจรูปร่างแฮชก่อนเชื่อ
const bcrypt = {
  hashSync: (s) => '$2b$10$' + Buffer.from(String(s)).toString('hex'),
};
const ROUNDS = 10;

function fakeSeedStore(initial) {
  let data = initial === undefined ? null : initial;
  const writes = [];
  return {
    read: () => (data == null ? null : JSON.parse(JSON.stringify(data))),
    write: (obj) => { writes.push(JSON.parse(JSON.stringify(obj))); data = JSON.parse(JSON.stringify(obj)); },
    writes,
    peek: () => data,
  };
}

function employee(id) {
  return { id, username: 'emp' + id, password: '$2b$10$whatever', role: 'employee', active: true };
}

function superadminRecord(hash, extra) {
  const rec = systemAccount.buildSystemAccountRecord(hash);
  return Object.assign(rec, extra || {});
}

function findSuper(users) {
  return users.find(u => systemAccount.isSystemAccountUser(u));
}

// เทสต์หลายข้อต้องการให้ env ว่าง — คุมให้ชัด ไม่ให้เครื่องที่ตั้งตัวแปรไว้ทำผลเพี้ยน
function withEnv(value, fn) {
  const had = Object.prototype.hasOwnProperty.call(process.env, 'SUPERADMIN_PASSWORD');
  const old = process.env.SUPERADMIN_PASSWORD;
  if (value === undefined) delete process.env.SUPERADMIN_PASSWORD;
  else process.env.SUPERADMIN_PASSWORD = value;
  try { return fn(); }
  finally {
    if (had) process.env.SUPERADMIN_PASSWORD = old;
    else delete process.env.SUPERADMIN_PASSWORD;
  }
}

console.log('superadmin seed: บัญชีกลับมาเองได้ และระบบไม่เก็บรหัสจริง');

test('1. บัญชีมีอยู่ + ยังไม่มี seed -> เขียน seed ให้ตรงกับบัญชี และไม่แตะ users.json', () => {
  const hash = bcrypt.hashSync('rememberedPassword');
  const seed = fakeSeedStore();
  const input = [employee(1), superadminRecord(hash, { tokenVersion: 7 })];
  const out = withEnv(undefined, () => systemAccount.ensureSystemAccounts(input, bcrypt, ROUNDS, seed));

  assert.strictEqual(seed.writes.length, 1, 'ควรเขียน seed หนึ่งครั้ง');
  assert.strictEqual(seed.peek().password, hash, 'seed ต้องเก็บแฮชเดียวกับบัญชี');
  assert.strictEqual(seed.peek().tokenVersion, 7, 'seed ต้องเก็บ tokenVersion ปัจจุบันไว้ด้วย');
  assert.strictEqual(seed.peek().version, 1, 'seed ต้องมีเลขรุ่นของรูปแบบไฟล์');
  assert.ok(!('plaintext' in seed.peek()) && !('passwordPlain' in seed.peek()),
    'seed ห้ามมีรหัสจริง');
  assert.strictEqual(out.changed, false, 'บัญชีมีอยู่ครบแล้ว จึงไม่ควรบอกให้เขียน users.json');
  assert.strictEqual(findSuper(out.users).password, hash, 'แฮชของบัญชีต้องไม่ถูกเปลี่ยน');
});

test('2. บัญชีมีอยู่ + seed ตรงกันแล้ว -> ไม่เขียนไฟล์เลย (กัน I/O ทุก request)', () => {
  const hash = bcrypt.hashSync('rememberedPassword');
  const seed = fakeSeedStore({ version: 1, password: hash, tokenVersion: 3, mustChangePassword: false, updatedAt: 'x' });
  const input = [superadminRecord(hash, { tokenVersion: 3 })];
  withEnv(undefined, () => systemAccount.ensureSystemAccounts(input, bcrypt, ROUNDS, seed));
  assert.strictEqual(seed.writes.length, 0, 'แฮชตรงกันแล้วไม่ควรเขียนซ้ำ');
});

test('3. เจ้าของเปลี่ยนรหัสหน้าเว็บ (แฮชในบัญชีใหม่กว่า) -> seed ตามให้ บัญชีไม่ถูกแตะ', () => {
  const oldHash = bcrypt.hashSync('old');
  const newHash = bcrypt.hashSync('new');
  const seed = fakeSeedStore({ version: 1, password: oldHash, tokenVersion: 3, mustChangePassword: false, updatedAt: 'x' });
  const input = [superadminRecord(newHash, { tokenVersion: 4 })];
  const out = withEnv(undefined, () => systemAccount.ensureSystemAccounts(input, bcrypt, ROUNDS, seed));

  assert.strictEqual(seed.peek().password, newHash, 'seed ต้องอัปเดตเป็นแฮชใหม่');
  assert.strictEqual(seed.peek().tokenVersion, 4, 'และเก็บ tokenVersion ที่คู่กัน');
  assert.strictEqual(findSuper(out.users).password, newHash, 'users.json ชนะ seed เสมอ');
});

test('4. บัญชีหาย + มี seed -> กลับมาด้วยแฮชเดิม และ tokenVersion ต้องมากกว่าใน seed 1', () => {
  const hash = bcrypt.hashSync('rememberedPassword');
  const seed = fakeSeedStore({ version: 1, password: hash, tokenVersion: 5, mustChangePassword: false, updatedAt: 'x' });
  const input = [employee(1), employee(2)];
  const out = withEnv(undefined, () => systemAccount.ensureSystemAccounts(input, bcrypt, ROUNDS, seed));

  const su = findSuper(out.users);
  assert.ok(su, 'บัญชี superadmin ต้องกลับมา');
  assert.strictEqual(su.password, hash, 'ต้องกลับมาด้วยแฮชเดิม ⇒ รหัสที่เจ้าของจำได้ใช้ได้ทันที');
  assert.strictEqual(su.role, 'superadmin', 'ต้องได้ role เดิม');
  assert.strictEqual(su.isSystemAccount, true, 'ต้องถูกทำเครื่องหมายเป็นบัญชีระบบ');
  assert.strictEqual(out.changed, true, 'ต้องบอกให้ผู้เรียกเขียน users.json กลับลงไฟล์');
  // tokenVersion คือกลไกเพิกถอน token (server.js:1049, 1076-1078) ถ้าคืนค่าเก่าตรงๆ
  // token ที่เคยถูกเพิกถอนด้วยการเปลี่ยนรหัสผ่านจะกลับมาใช้ได้อีก
  assert.strictEqual(su.tokenVersion, 6,
    'tokenVersion ต้องเป็น seed+1 ไม่ใช่ค่าเดิม ไม่งั้น token ที่เคยถูกเพิกถอนจะใช้ได้อีก');
  assert.strictEqual(out.users.filter(u => systemAccount.isSystemAccountUser(u)).length, 1,
    'ต้องได้บัญชีระบบตัวเดียว');
  assert.strictEqual(out.users.length, 3, 'พนักงานเดิมต้องอยู่ครบ');
});

test('5. ติดตั้งใหม่: บัญชีหาย + ไม่มี seed + มี env -> สร้างจาก env แล้วเขียน seed ทันที', () => {
  const seed = fakeSeedStore();
  const out = withEnv('freshInstallPass',
    () => systemAccount.ensureSystemAccounts([employee(1)], bcrypt, ROUNDS, seed));

  const su = findSuper(out.users);
  assert.ok(su, 'ต้องสร้างบัญชีจาก env');
  assert.strictEqual(su.password, bcrypt.hashSync('freshInstallPass'), 'ต้องแฮชรหัสจาก env');
  assert.strictEqual(out.changed, true);
  assert.strictEqual(seed.writes.length, 1, 'ต้องเขียน seed ทันที ไม่ต้องรอรอบถัดไป');
  assert.strictEqual(seed.peek().password, su.password);
});

test('6. บัญชีหาย + ไม่มี seed + ไม่มี env -> เตือน ไม่สร้าง ไม่โยน error', () => {
  const seed = fakeSeedStore();
  const out = withEnv(undefined,
    () => systemAccount.ensureSystemAccounts([employee(1)], bcrypt, ROUNDS, seed));
  assert.strictEqual(findSuper(out.users), undefined, 'ไม่มีอะไรให้สร้างจาก จึงไม่ควรสร้าง');
  assert.strictEqual(out.changed, false);
  assert.strictEqual(seed.writes.length, 0, 'ไม่มีอะไรจะเขียน');
});

test('7. seed ใช้ไม่ได้ทุกแบบ -> ถือว่าไม่มี seed ไม่โยน error และไม่ทับไฟล์เดิม', () => {
  const badSeeds = [
    { label: 'read() โยน error (JSON พัง)', store: { read() { throw new Error('bad json'); }, write() { throw new Error('ไม่ควรเขียน'); } } },
    { label: 'version ไม่ใช่ 1', seed: { version: 2, password: '$2b$10$abc' } },
    { label: 'ไม่มีฟิลด์ password', seed: { version: 1, tokenVersion: 1 } },
    { label: 'แฮชไม่ใช่รูป bcrypt', seed: { version: 1, password: 'plain-text-password' } },
    { label: 'password เป็นค่าว่าง', seed: { version: 1, password: '' } },
  ];
  for (const c of badSeeds) {
    const store = c.store || fakeSeedStore(c.seed);
    const out = withEnv(undefined,
      () => systemAccount.ensureSystemAccounts([employee(1)], bcrypt, ROUNDS, store));
    assert.strictEqual(findSuper(out.users), undefined, `[${c.label}] ห้ามสร้างบัญชีจาก seed ที่ใช้ไม่ได้`);
    assert.strictEqual(out.changed, false, `[${c.label}] ไม่ควรบอกให้เขียน users.json`);
    if (store.writes) {
      assert.strictEqual(store.writes.length, 0, `[${c.label}] ไม่ควรทับไฟล์ seed เดิม`);
    }
  }
});

test('8. เขียน seed ไม่สำเร็จ -> ยังคืนผู้ใช้ได้ปกติ (readUsers ถูกเรียกทุก request ห้ามล้ม)', () => {
  const hash = bcrypt.hashSync('rememberedPassword');
  const store = { read: () => null, write() { throw new Error('EACCES'); } };
  const input = [employee(1), superadminRecord(hash, { tokenVersion: 2 })];
  let out;
  assert.doesNotThrow(() => {
    out = withEnv(undefined, () => systemAccount.ensureSystemAccounts(input, bcrypt, ROUNDS, store));
  }, 'การเขียน seed ล้มเหลวต้องไม่ทำให้การอ่านผู้ใช้ล้ม');
  assert.strictEqual(findSuper(out.users).password, hash, 'ผู้ใช้ต้องถูกคืนตามปกติ');
});

test('9. ไม่ส่ง seedStore มาเลย -> พฤติกรรมเหมือนเดิมทุกอย่าง (ผู้เรียกเก่าไม่พัง)', () => {
  const hash = bcrypt.hashSync('rememberedPassword');
  const out1 = withEnv(undefined, () => systemAccount.ensureSystemAccounts([superadminRecord(hash)], bcrypt, ROUNDS));
  assert.strictEqual(findSuper(out1.users).password, hash);

  const out2 = withEnv(undefined, () => systemAccount.ensureSystemAccounts([employee(1)], bcrypt, ROUNDS));
  assert.strictEqual(findSuper(out2.users), undefined, 'ไม่มี seed ไม่มี env ⇒ ไม่สร้าง เหมือนเดิม');

  const out3 = withEnv('envOnly', () => systemAccount.ensureSystemAccounts([employee(1)], bcrypt, ROUNDS));
  assert.ok(findSuper(out3.users), 'ทางเดิมที่สร้างจาก env ต้องยังใช้ได้');
});

console.log(`\nsuperadmin-seed: ${passed} passed`);
