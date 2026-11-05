// ด่านสลิปเงินเดือนต้อง fail-closed และลิสต์ role ใน server.js ต้องไม่หลุดจากกัน
//
// ที่มา (พบจากการกวาดหาบั๊ก 2026-11-05): ด่านของ `/api/payslip-xlsx` เคยตัดสินด้วย
// **ส่วนเติมเต็ม** ของลิสต์พนักงาน:
//
//     const isStaff = STAFF_ROLES.includes(role);                  // ['user','driver','manager','marketing']
//     if (isStaff && userId !== req.user.sub) return 403;           // พนักงาน -> ดูได้แต่ของตัวเอง
//     if (!isStaff && (live.isObserver || live.active === false)) return 403;
//     // ที่เหลือ (= ไม่อยู่ใน STAFF_ROLES) -> ดาวน์โหลดสลิปของ "ใครก็ได้"
//
// ⇒ **fail-open**: role ใดที่ไม่อยู่ใน STAFF_ROLES ถูกถือว่าเป็นผู้บริหารโดยปริยาย
// วันนั้นยังไม่เป็นช่องโหว่ เพราะส่วนที่เหลือคือ md / accounting / superadmin จริงๆ แต่ถ้าวันหน้า
// เพิ่ม role ใหม่เข้า ROLE_ENUM (ด่านตรวจค่า role ตอนสร้าง/แก้ผู้ใช้ ~บรรทัด 2401) แล้วลืมเพิ่ม
// ใน STAFF_ROLES role นั้นจะดาวน์โหลดเงินเดือน เบี้ยเลี้ยง และยอดสุทธิของพนักงานทุกคนได้ทันที
// โดยไม่มีใครแก้ด่านนั้นเลย — ความผิดพลาดแบบ "ลืมแก้อีกที่" ที่ไฟล์นี้มีประวัติมาแล้วหลายครั้ง
//
// แก้แล้วให้ตัดสินด้วย isPrivilegedAdmin(live) ซึ่งเป็น **allowlist ที่ระบุชื่อชัด** และมีอยู่ใน
// ไฟล์นี้ก่อนแล้ว (['md','accounting'] + superadmin) ⇒ role ใหม่จะได้สิทธิ์แค่ของตัวเองโดยปริยาย
// เทียบขั้วกับทุก role ที่มีอยู่วันนี้แล้วเท่ากันเป๊ะ (isStaff === !isPrivilegedAdmin)
// ⇒ พฤติกรรมไม่เปลี่ยน เปลี่ยนแต่ค่าปริยายของ role ที่ยังไม่มี
//
// **ยามนี้อ่านตัวอักษรของ server.js ไม่ได้รันมัน** (require จะเปิดเซิร์ฟเวอร์จริงและจับพอร์ต)
// ⇒ กันการแก้กลับและการเพิ่ม role แล้วลืมจัดประเภทได้ แต่ไม่ได้พิสูจน์ว่าด่านทำงานถูก
// (บทเรียนของโปรเจกต์: การจับข้อความไม่ใช่ความครบถ้วน)
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'attendance-server/backend/server.js'), 'utf8');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ', name); }
  catch (e) { process.exitCode = 1; console.log('  FAIL', name, '\n       ', e.message); }
}

// ดึงลิสต์ตามชื่อตัวแปร · คืน null ถ้าหาไม่เจอ เพื่อให้ยามบอกได้ว่า "ของถูกเปลี่ยนชื่อ/ย้าย"
// ไม่ใช่เงียบแล้วผ่าน
function roleList(name) {
  const m = SRC.match(new RegExp('const ' + name + "\\s*=\\s*\\[([^\\]]*)\\]"));
  if (!m) return null;
  return m[1].split(',').map(s => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
}
const sorted = a => a.slice().sort();

// บล็อกของ route /api/payslip-xlsx (ตั้งแต่บรรทัด app.get ไปจนก่อน app. ตัวถัดไป)
const XLSX_ROUTE_RAW = (SRC.match(/app\.get\('\/api\/payslip-xlsx'[\s\S]*?\n(?=app\.[a-z]+\()/) || [''])[0];
// ตัดคอมเมนต์ทิ้งก่อนตรวจ: คำอธิบายในด่านนั้นพูดถึงทั้งวิธีเก่าและวิธีใหม่ ถ้าอ่านคอมเมนต์เป็นโค้ด
// ยามจะรายงานผิดทันที — กับดักเดียวกับที่ tests/deploy-starts-as-root.test.js บันทึกไว้ว่าเคย
// พลาด 3 รอบในวันเดียว
const XLSX_ROUTE = XLSX_ROUTE_RAW.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');

console.log('payslip gate is fail-closed, and role lists stay in step');

test('หาบล็อกของ /api/payslip-xlsx เจอ', () => {
  assert.ok(XLSX_ROUTE_RAW.length > 500,
    'หา route /api/payslip-xlsx ใน server.js ไม่เจอ หรือสั้นผิดปกติ — ถ้าย้ายที่ ให้แก้ยามนี้ตามด้วย');
});

test('ด่านสลิปต้องตัดสินด้วย allowlist ที่ระบุชื่อ ไม่ใช่ส่วนเติมเต็มของลิสต์พนักงาน', () => {
  assert.ok(/isPrivilegedAdmin\(/.test(XLSX_ROUTE),
    'ด่านไม่ได้ใช้ isPrivilegedAdmin() แล้ว · ถ้ากลับไปตัดสินด้วยส่วนเติมเต็มของลิสต์ใดๆ '
    + 'role ใหม่ที่ยังไม่ถูกจัดประเภทจะกลายเป็นผู้บริหารโดยปริยาย และดาวน์โหลดสลิปของทุกคนได้');
  assert.ok(!/STAFF_ROLES/.test(XLSX_ROUTE),
    'STAFF_ROLES กลับมาอยู่ในด่านนี้แล้ว ⇒ กลับไป fail-open เหมือนก่อน 2026-11-05');
});

test('isPrivilegedAdmin ยังเป็น md/accounting + superadmin เท่านั้น', () => {
  const m = SRC.match(/function isPrivilegedAdmin\(live\)\s*\{([\s\S]*?)\n\}/);
  assert.ok(m, 'หา isPrivilegedAdmin() ไม่เจอ');
  const body = m[1];
  const roles = (body.match(/\[([^\]]*)\]/) || ['', ''])[1]
    .split(',').map(s => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
  assert.deepStrictEqual(sorted(roles), ['accounting', 'md'],
    'ชุด role ที่ถือว่าเป็นผู้บริหารเปลี่ยนไป ⇒ ชุดคนที่เห็นเงินของคนอื่นได้เปลี่ยนไปทั้งระบบ '
    + 'เพราะ predicate นี้ถูกใช้หลายที่ ไม่ใช่แค่ด่านสลิป');
  assert.ok(/isSuperAdminUser\(live\)/.test(body),
    'superadmin หลุดออกจาก isPrivilegedAdmin ⇒ บัญชีนักพัฒนาจะตรวจสลิปของคนอื่นไม่ได้');
});

test('ลิสต์ role ที่เหลือยังหาเจอ (ไม่ถูกเปลี่ยนชื่อหรือย้าย)', () => {
  for (const n of ['ROLE_ENUM', 'KNOWN_ROLES', 'ROLE_KEYS']) {
    assert.ok(roleList(n), `หา const ${n} = [...] ใน server.js ไม่เจอ — ถ้าย้ายที่ ให้แก้ยามนี้ตามด้วย`);
  }
});

test('ROLE_ENUM / KNOWN_ROLES / ROLE_KEYS ต้องมี role ชุดเดียวกัน', () => {
  const a = roleList('ROLE_ENUM'), b = roleList('KNOWN_ROLES'), c = roleList('ROLE_KEYS');
  assert.deepStrictEqual(sorted(b), sorted(a),
    'KNOWN_ROLES (ด่านตรวจ allowanceEligibility) ไม่ตรงกับ ROLE_ENUM (ด่านตรวจค่า role ของผู้ใช้) '
    + '⇒ role ที่ตั้งให้ผู้ใช้ได้ แต่ตั้งสิทธิ์เบี้ยเลี้ยงให้ไม่ได้ หรือกลับกัน');
  assert.deepStrictEqual(sorted(c), sorted(a),
    'ROLE_KEYS (อัตราเบี้ยรายวันต่อ role) ไม่ตรงกับ ROLE_ENUM ⇒ role ที่มีอยู่จริงแต่ไม่มีช่องอัตรา');
});

test('ทุก role ใน ROLE_ENUM ต้องไม่ใช่ผู้บริหารโดยบังเอิญ', () => {
  const all = roleList('ROLE_ENUM');
  assert.deepStrictEqual(sorted(all.filter(r => ['md', 'accounting'].includes(r))), ['accounting', 'md'],
    'ROLE_ENUM ต้องมี md และ accounting อยู่ (ถ้าหายไป ด่านทั้งระบบจะไม่มีใครผ่านได้)');
});

// พิสูจน์ว่าตรรกะของยามไม่ใช่ยามเปล่า
test('ยามจับการแก้กลับได้จริง (ทดสอบตรรกะกับข้อความสมมุติ)', () => {
  const fake = "const isStaff = STAFF_ROLES.includes(role); if (isStaff && x) return 403;";
  assert.ok(/STAFF_ROLES/.test(fake) && !/isPrivilegedAdmin\(/.test(fake),
    'ตรรกะของยามต้องจับรูปแบบเก่าได้');
  const fixed = "const canSeeOtherPeople = isPrivilegedAdmin(live);";
  assert.ok(!/STAFF_ROLES/.test(fixed) && /isPrivilegedAdmin\(/.test(fixed),
    'และต้องยอมรับรูปแบบใหม่');
});

console.log(`\nrole-lists-consistent: ${passed} passed`);
