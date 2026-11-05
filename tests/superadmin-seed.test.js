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
const fs = require('fs');

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

// ข้อ 10-11 มาจากการรีวิวโค้ดตัวเองเมื่อ 2026-11-05: การกู้คืนทำงานเฉพาะเมื่อ "ไม่มีเรคอร์ด"
// แต่โจทย์ของเจ้าของคือ "บัญชีนี้จะต้องไม่มีปัญหาในการใช้งาน" ⇒ เรคอร์ดที่ยังอยู่แต่แฮชใช้ไม่ได้
// (ว่าง หรือไม่ใช่รูป bcrypt จากการเขียนไม่ครบ/แก้มือ) คือบัญชีที่ล็อกอินไม่ได้และไม่มีอะไรซ่อมมัน
// ทั้งที่ seed ถือแฮชที่ใช้ได้อยู่ · ต้องซ่อมให้ด้วย ไม่ใช่รอให้เรคอร์ดหายทั้งอัน
test('10. บัญชีอยู่แต่แฮชใช้ไม่ได้ + มี seed -> ซ่อมแฮชจาก seed และดัน tokenVersion ขึ้น', () => {
  const good = bcrypt.hashSync('rememberedPassword');
  const seed = fakeSeedStore({ version: 1, password: good, tokenVersion: 4, mustChangePassword: false, updatedAt: 'x' });
  const input = [employee(1), superadminRecord('', { tokenVersion: 9 })];
  const out = withEnv(undefined, () => systemAccount.ensureSystemAccounts(input, bcrypt, ROUNDS, seed));

  const su = findSuper(out.users);
  assert.ok(su, 'บัญชีต้องยังอยู่');
  assert.strictEqual(su.password, good, 'แฮชต้องถูกซ่อมจาก seed ⇒ ล็อกอินด้วยรหัสเดิมได้');
  assert.strictEqual(out.changed, true, 'ต้องบอกให้ผู้เรียกเขียน users.json กลับลงไฟล์');
  // ใช้ค่าที่สูงกว่าระหว่างเรคอร์ดกับ seed แล้วบวกหนึ่ง เพราะรหัสผ่านของบัญชีเปลี่ยนไปจริง
  // ⇒ token ทุกใบที่ออกไปก่อนหน้านี้ต้องใช้ไม่ได้ ไม่ว่าจะออกตอน tokenVersion ของฝั่งไหน
  assert.strictEqual(su.tokenVersion, 10, 'tokenVersion ต้องเป็น max(9, 4) + 1 = 10');
  assert.strictEqual(seed.writes.length, 0, 'seed ถูกอยู่แล้ว ไม่ต้องเขียนทับ');
});

test('11. บัญชีอยู่ แฮชใช้ไม่ได้ และไม่มี seed -> ไม่แกล้งซ่อม ไม่ล้ม', () => {
  const seed = fakeSeedStore();
  const input = [superadminRecord('', { tokenVersion: 2 })];
  let out;
  assert.doesNotThrow(() => {
    out = withEnv(undefined, () => systemAccount.ensureSystemAccounts(input, bcrypt, ROUNDS, seed));
  });
  assert.strictEqual(findSuper(out.users).password, '', 'ไม่มีแฮชที่ใช้ได้ให้เอามาใส่ จึงต้องไม่แตะ');
  assert.strictEqual(seed.writes.length, 0, 'ห้ามเขียนแฮชที่ใช้ไม่ได้ลง seed (จะทำลาย seed ที่ดี)');
});

// ข้อ 12 มาจากการรีวิวเดียวกัน: ฝั่ง server.js แคชไฟล์ seed ไว้ในหน่วยความจำ ⇒ readSeed() จะ
// ตรวจ "ของเสียชิ้นเดิม" ซ้ำทุก request และเดิมพิมพ์ error ทุกครั้ง ⇒ server.log บวมหนึ่งบรรทัด
// ต่อหนึ่ง request ตลอดไปเมื่อ seed เสียและบัญชีหายพร้อมกัน (เส้นทางนั้นคืนค่าออกก่อนถึงจุดซ่อม)
test('12. seed ที่ใช้ไม่ได้ต้องบ่นครั้งเดียว ไม่ใช่ทุกครั้งที่ถูกเรียก', () => {
  const store = fakeSeedStore({ version: 2, password: '$2b$10$abc' });
  const origErr = console.error;
  const seen = [];
  console.error = (...a) => seen.push(a.join(' '));
  try {
    withEnv(undefined, () => {
      for (let i = 0; i < 5; i++) systemAccount.ensureSystemAccounts([employee(1)], bcrypt, ROUNDS, store);
    });
  } finally { console.error = origErr; }
  const aboutVersion = seen.filter(l => l.includes('seed has version'));
  assert.strictEqual(aboutVersion.length, 1,
    `เรียก 5 ครั้ง ควรบ่นเรื่องเดิมครั้งเดียว แต่บ่น ${aboutVersion.length} ครั้ง`);
});

test('13. บ่นซ้ำได้ถ้าเคยกลับมาปกติแล้วเสียอีก (ไม่ใช่เงียบถาวร)', () => {
  const good = bcrypt.hashSync('ok');
  const goodSeed = () => fakeSeedStore({ version: 1, password: good, tokenVersion: 0, mustChangePassword: false, updatedAt: 'x' });
  const badSeed = () => fakeSeedStore({ version: 2, password: good });
  const origErr = console.error;
  const seen = [];
  // สถานะ "เคยบ่นเรื่องนี้แล้ว" เป็นตัวแปรระดับโมดูล ⇒ เทสต์ข้ออื่นทิ้งค่าไว้ได้
  // จึงเริ่มด้วยการอ่าน seed ที่ใช้ได้หนึ่งครั้งเพื่อรีเซ็ต แล้วค่อยเริ่มนับ
  withEnv(undefined, () => systemAccount.ensureSystemAccounts([employee(1)], bcrypt, ROUNDS, goodSeed()));
  console.error = (...a) => seen.push(a.join(' '));
  try {
    withEnv(undefined, () => {
      systemAccount.ensureSystemAccounts([employee(1)], bcrypt, ROUNDS, badSeed());   // บ่นครั้งที่ 1
      systemAccount.ensureSystemAccounts([employee(1)], bcrypt, ROUNDS, goodSeed());  // กลับมาปกติ -> รีเซ็ต
      systemAccount.ensureSystemAccounts([employee(1)], bcrypt, ROUNDS, badSeed());   // บ่นครั้งที่ 2
    });
  } finally { console.error = origErr; }
  assert.strictEqual(seen.filter(l => l.includes('seed has version')).length, 2,
    'เสีย -> ปกติ -> เสีย ต้องได้ 2 บรรทัด');
});

// ---------------------------------------------------------------------------------------------
// ยามสำหรับฝั่ง server.js · **ยามนี้อ่านตัวอักษร ไม่ได้รันโค้ด** เพราะ require('server.js')
// จะเปิดเซิร์ฟเวอร์จริงและจับพอร์ต ⇒ รันในเทสต์ไม่ได้ · มันกันได้แค่การ "แก้กลับ" สองข้อที่
// เจอจากการรีวิวโค้ดตัวเองเมื่อ 2026-11-05 ไม่ได้พิสูจน์ว่าพฤติกรรมถูก
// (บทเรียนของโปรเจกต์: การจับข้อความไม่ใช่ความครบถ้วน)
const SERVER_SRC = fs.readFileSync(path.join(__dirname, '..', 'attendance-server/backend/server.js'), 'utf8');
const STORE_SRC = (SERVER_SRC.match(/const superadminSeedStore = \{[\s\S]*?\n\};/) || [''])[0];

test('server.js: ที่เก็บ seed ต้องไม่อัปเดตแคชตอน dry-run', () => {
  assert.ok(STORE_SRC, 'หาบล็อก superadminSeedStore ใน server.js ไม่เจอ');
  assert.ok(/isDryRun\(\)/.test(STORE_SRC),
    'write() ไม่ตรวจ isDryRun() อีกแล้ว · atomicWrite() ไม่เขียนอะไรตอน dry-run แต่ถ้ายังอัปเดต '
    + 'แคช โปรเซสนี้จะเชื่อว่ามี seed ทั้งที่ไฟล์ยังไม่เกิด แล้วจะไม่เขียนอีกเลยจนรีสตาร์ต '
    + '(server.js ~บรรทัด 101 เตือนไว้เองว่าสถานะข้ามรีเควสต์ทำให้ dry-run ไม่ปลอดภัย)');
});

test('server.js: เขียน seed ไม่สำเร็จต้องไม่ลองใหม่ทุก request', () => {
  assert.ok(STORE_SRC, 'หาบล็อก superadminSeedStore ใน server.js ไม่เจอ');
  assert.ok(/catch[\s\S]*superadminSeedCache = obj/.test(STORE_SRC),
    'เมื่อ atomicWrite() โยน error แล้วไม่จำ seed ไว้ในหน่วยความจำ แคชจะค้างเป็น null ⇒ '
    + 'ทุก request ถัดไปจะลองเขียนใหม่และพิมพ์ error ซ้ำไม่สิ้นสุด เพราะ readUsers() วิ่งแทบทุก request');
  assert.ok(/atomicWrite\(SUPERADMIN_SEED_FILE[\s\S]*?,\s*true\s*\)/.test(STORE_SRC),
    'ธง sensitive หายไป ⇒ ไฟล์ seed จะกลายเป็น 644 ทุกครั้งที่เขียน (atomicWrite rename ทับ '
    + 'ปลายทางจึงรับ mode ของไฟล์ชั่วคราว) ⇒ แฮชของบัญชีหลังบ้านจะอ่านได้ทุกบัญชีบนเครื่อง');
});

console.log(`\nsuperadmin-seed: ${passed} passed`);
