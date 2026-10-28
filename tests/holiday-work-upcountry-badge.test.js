// ไอคอน 🗺️ Upcountry ของวันทำงานวันหยุด ต้องขึ้นเมื่อ "payroll จ่ายจริง" เท่านั้น (2026-10-28)
//
// ที่มา: เจ้าของเปิดป๊อปอัปของวันที่ 27 ก.ย. 2026 (ใบทำงานวันหยุด โหมดแลกวันหยุด กรอกสถานที่ไว้)
// แล้วถามว่า *"ปกติ holiday work ถ้ากรอกข้อมูลช่องสถานที่ต้องได้เงินเบี้ยเลี้ยงด้วยถูกต้องไหม
// หากว่าได้ ทำไมตอนนี้ในนี้ไม่มีเขียนไว้ว่าได้"* · วัดกับ computePayroll จริงแล้ว: ได้จริง —
// holidayWorkUpcountryCount = 1, allowance1 = 2,160 = 9 × ฿240 โดยมีวันนั้นรวมอยู่ — แต่หน้าจอ
// ไม่เขียนอะไรเลย · และเขาสั่งพ่วงมาว่า "ต้องขึ้นสัญลักษณ์ upcountry ด้วย **แต่อย่าคิดเงินเบิ้ล**"
//
// **เงื่อนไขที่ payroll ใช้จ่าย (holidayWorkUpcountryCount) ไม่มีเรื่องโหมดชดเชยอยู่ในนั้น**
// ซึ่งเป็นข้อที่คนอ่านโค้ดเดาผิดได้ง่ายที่สุด เพราะเบี้ย ฿500 ค่าเดินทางวันหยุดที่อยู่ข้างๆ กัน
// (holidayTransportForRecord) จ่ายเฉพาะโหมด paid ⇒ ใบแลกวันหยุดได้ ฿240 แต่ไม่ได้ ฿500
//
// ยามนี้จึงไม่ตรวจว่า "โค้ดหน้าตาเหมือนกันไหม" แต่ตรวจว่า **ไอคอนกับเงินตอบตรงกันทุกเคส**:
// ยิง computePayroll ตัวจริงใส่ข้อมูลชุดเดียวกัน แล้วเทียบว่า holidayWorkEarnsUpcountry() ตอบ true
// เมื่อ และเฉพาะเมื่อ payroll นับวันนั้นเป็นเบี้ย Upcountry · ถ้าวันหนึ่งกฎเงินเปลี่ยนข้างเดียว
// ไอคอนจะกลายเป็นคำโฆษณาเงินที่สลิปไม่จ่าย ซึ่งเป็นบั๊กที่โปรเจกต์นี้เคยโดนมาแล้ว (2026-10-16)
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const APP_SRC = fs.readFileSync(path.join(ROOT, 'attendance/js/app.js'), 'utf8');

// 2026-10-28 (รีวิวรอบ 5): ของเดิมหาเนื้อฟังก์ชันด้วย `src.indexOf('{', m.index)` ซึ่งกับฟังก์ชันที่
// รับพารามิเตอร์แบบ destructuring — `function f({ a, b })` — จะไปเจอปีกกาของ **พารามิเตอร์** ก่อน
// แล้วนับจบที่นั่น ⇒ คืนมาแค่บรรทัดลายเซ็น · `buildAttendancePrintView` เป็นแบบนั้นทั้งตัว
// ⇒ ยามใดที่ assert ว่า "ไม่มีสิ่งนี้ในหน้าพิมพ์" จึงเขียวฟรี เพราะมันไม่เคยเห็นหน้าพิมพ์
// ตอนนี้เดินจากวงเล็บ `(` ของพารามิเตอร์ไปหาตัวปิดของมันก่อน แล้วจึงเริ่มนับที่ปีกกาถัดไป
function extractFunction(src, name) {
  const re = new RegExp(`^(?:async )?function ${name}\\(`, 'm');
  const m = re.exec(src);
  assert.ok(m, `ไม่พบฟังก์ชัน ${name} ใน attendance/js/app.js`);
  const open = src.indexOf('(', m.index);
  let p = 0, afterParams = -1;
  for (let j = open; j < src.length; j++) {
    if (src[j] === '(') p++;
    else if (src[j] === ')') { p--; if (p === 0) { afterParams = j + 1; break; } }
  }
  assert.ok(afterParams > 0, `หาวงเล็บปิดของพารามิเตอร์ ${name} ไม่เจอ`);
  const i = src.indexOf('{', afterParams);
  assert.ok(i > 0, `หาเนื้อฟังก์ชัน ${name} ไม่เจอ`);
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (depth === 0) return src.slice(m.index, j + 1); }
  }
  throw new Error(`วงเล็บไม่สมดุลใน ${name}`);
}
function constDecl(src, name) {
  // ต้องเช็กว่าบรรทัดเดียวจบจริง: `const X = {` ของอ็อบเจกต์หลายบรรทัดก็ตรงกับ regex นี้เหมือนกัน
  // แล้วจะได้ประโยคที่ขาดกลางคันกลับไป ซึ่งพังเป็น SyntaxError ที่ชี้ไปผิดที่
  const m = src.match(new RegExp(`^const ${name} = .*$`, 'm'));
  if (m && /;\s*$/.test(m[0])) return m[0].replace(/^const /, '');
  // ค่าคงที่แบบหลายบรรทัด (อ็อบเจกต์)
  const o = new RegExp(`^const ${name} = \\{`, 'm').exec(src);
  assert.ok(o, `ไม่พบ const ${name}`);
  const i = src.indexOf('{', o.index);
  let d = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') d++;
    else if (src[j] === '}') { d--; if (!d) return src.slice(o.index, j + 1).replace(/^const /, '') + ';'; }
  }
  throw new Error(`unbalanced const ${name}`);
}

const TRIPS = ['2026-10-03'];                       // เสาร์ที่ถูกประกาศเป็น Company Trip
const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const BUSINESS_DAY_START_MINS = Number(/const BUSINESS_DAY_START_MINS = (\d+);/.exec(APP_SRC)[1]);
const RATE_UPCOUNTRY = 240;
const SETTINGS = {
  allowances: {
    earlyMorning1: 240, earlyMorning2: 480, earlyThreshold1Min: 450, earlyThreshold2Min: 390,
    lateNight1: 100, lateNight2: 200, lateNightThreshold1Hour: 19, lateNightThreshold2Hour: 20,
    upcountry: RATE_UPCOUNTRY, holidayTransport: 500, abroad: 1100, personalCar: 1000, phone: 1000, diligence: 0,
  },
  sso: { rate: 5, maxAmount: 875, minSalary: 1650 },
  tax: { personalAllowanceAnnual: 60000 },
  workSchedule: { standardStartHour: 8, standardStartMinute: 30 },
  // ตั้งชัดเจน ไม่พึ่งค่าตั้งต้น เพราะเคสล่างทดสอบการปิดสิทธิ์ทีละตัว
  allowanceEligibility: { upcountry: ['user'], holidayWork: ['user'] },
  payroll: { periodStartDay: 21 },
};
const USER = { id: 1, role: 'user', salary: 24000, active: true };

const SHARED = ['earlyLateRateFor', 'isVoidLeaveStatus', 'round2HalfUp', 'round1HalfUp',
  'deriveOfficeOtFromEndTime', 'lateNightCheckoutMins', 'lateNightThresholdMins', 'lateNightThresholdHourOf',
  'parseHHMMToMins', 'isHolidayWorkDay', 'isNonWorkDayForComp', 'isHolidayWorkOtRecord', 'companyTripDateInRange',
  'isFullDayPersonalLeaveStatus', 'isRestAttendanceDay', 'isDeviceScanSource', 'isEarlyMorningDayStatus',
  'deviceScanQualifiesForEarlyMorning', 'earlyMorningAutoPayEnabled', 'earlyMorningCheckInOk',
  'deviceScanQualifiesForLateNight', 'lateNightCheckoutOk', 'addOtHours', 'accumulateApprovedOtHours',
  'otPayFromHourBuckets', 'effectiveOtMultiplier', 'computePayroll', 'splitHolidayWorkOtMinutes',
  'holidayWorkEndMins', 'hasUpcountryLocation', 'holidayTransportForRecord', 'lateNightPoints',
  'holidayWorkTooLong', 'scanWindowError', 'getApprovedHolidayWorkDays', 'abroadTravelCreditDays',
  'otEndCrossesMidnight', 'loggedInUser', 'isSuperAdmin', 'effectiveRole', 'gateRoleFor',
  'canSubmitHolidayWorkForDate', 'standardOtMultiplier', 'otPayAmountFromLeave',
  // ตัวจริงของสองตัวนี้ ไม่ใช่ stub — เคสล่างปิดสิทธิ์ทีละ role จึงต้องใช้ตัวตัดสินจริง
  'isAllowanceEligible',
  // ตัวที่ไฟล์นี้มีไว้ตรวจ
  'holidayWorkEarnsUpcountry'];

function makeClient(world) {
  const ctx = {
    HHMM_RE, APP_SETTINGS: SETTINGS, DATA_LEAVES: world.leaves, DATA_COMPANY_TRIP_DATES: TRIPS,
    DATA_USERS: [world.user], currentUser: world.user, realUser: world.user, editingLeaveId: null, finalizeData: {},
    isCompanyTripDay: d => TRIPS.includes(d), isPublicHoliday: () => false,
    isApprovedAbroadDate: () => false, isAbroadTravelDay: () => false,
    payPeriodBlockedForDate: () => ({ blocked: false }), bangkokDateStr: () => '2026-12-31',
    attendanceTimesForDate: d => ({ checkIn: null, checkOut: null, lastScan: null, ...(world.att[d] || {}) }),
    generatePeriodDays: () => world.pDays, getFinalizeKey: () => 'k', calcAnnualTax: () => 0,
    L: en => en, console,
  };
  ctx.BUSINESS_DAY_START_MINS = BUSINESS_DAY_START_MINS;
  vm.createContext(ctx);
  vm.runInContext(constDecl(APP_SRC, 'EARLY_LATE_RATE_KEYS') + '\n' +
    constDecl(APP_SRC, 'DEFAULT_ALLOWANCE_ELIGIBILITY') + '\n' +
    SHARED.map(n => extractFunction(APP_SRC, n)).join('\n'), ctx);
  return ctx;
}

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok  ${name}`); }
  catch (e) { process.exitCode = 1; console.log(`  FAIL  ${name}\n        ${e.message}`); }
}

const START = new Date(2026, 8, 21), END = new Date(2026, 9, 20);
const SUNDAY = '2026-09-27';                        // อยู่ในรอบ และเป็นวันหยุดสุดสัปดาห์
const hwRec = over => ({
  id: 99, userId: USER.id, type: 'holiday-work', status: 'approved', dateFrom: SUNDAY,
  compensationMode: 'paid', workStartTime: '09:00', workEndTime: '12:00',
  otHours20: 0, otHours30: 0, locations: [{ name: 'Dainichi' }], ...over,
});
const days = (dateStatus = {}) => {
  const out = [];
  for (let d = new Date(2026, 8, 21); d <= new Date(2026, 9, 20); d.setDate(d.getDate() + 1)) {
    const s = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const wd = d.getDay();
    out.push({ date: s, status: dateStatus[s] || (wd === 0 || wd === 6 ? 'rest' : 'present'), upcountry: false });
  }
  return out;
};

// หัวใจของไฟล์นี้: ไอคอนกับเงินต้องตอบเหมือนกัน · ไม่ยืนยันตัวเลขที่เขียนมือ แต่ยืนยันว่า
// สองฝั่ง "เห็นด้วยกัน" ซึ่งเป็นสิ่งเดียวที่ยังจริงอยู่เมื่อเรตหรือกฎเปลี่ยนในอนาคต
function agree(label, recOver, { role = 'user', dateStatus = {}, elig } = {}) {
  const S = elig ? { ...SETTINGS, allowanceEligibility: elig } : SETTINGS;
  const rec = hwRec(recOver);
  const user = { ...USER, role };
  const world = { user, leaves: [rec], pDays: days(dateStatus), att: {} };
  const ctx = makeClient(world);
  ctx.APP_SETTINGS = S;
  const calc = ctx.computePayroll(user, START, END, 1);
  const จ่ายจริง = calc.holidayWorkUpcountryCount > 0;
  const ไอคอนขึ้น = ctx.holidayWorkEarnsUpcountry(rec, S, role, (dateStatus[rec.dateFrom] === 'abroad'));
  assert.strictEqual(ไอคอนขึ้น, จ่ายจริง,
    `${label}: ไอคอน=${ไอคอนขึ้น} แต่ payroll นับ=${calc.holidayWorkUpcountryCount}`);
  return { จ่ายจริง, allowance1: calc.allowance1 };
}

console.log('T1 ไอคอนกับเงินต้องตอบตรงกันทุกเคส');

test('โหมดรับเป็นเงิน + กรอกสถานที่ ⇒ ได้เบี้ย และไอคอนขึ้น', () => {
  const r = agree('paid+loc', { compensationMode: 'paid' });
  assert.strictEqual(r.จ่ายจริง, true);
});

// เคสของเจ้าของ: ใบแลกวันหยุดก็ได้เบี้ย Upcountry — เป็นข้อที่หน้าจอเคยเงียบ
test('โหมดแลกวันหยุด + กรอกสถานที่ ⇒ ได้เบี้ยเหมือนกัน (เคส 27 ก.ย. ของเจ้าของ)', () => {
  const r = agree('annual-leave+loc', { compensationMode: 'annual-leave' });
  assert.strictEqual(r.จ่ายจริง, true, 'โหมดแลกวันหยุดต้องได้เบี้ย Upcountry');
  assert.strictEqual(r.allowance1, RATE_UPCOUNTRY, 'และต้องเป็นเงินจริงหนึ่งวัน');
});

test('ไม่กรอกสถานที่ ⇒ ไม่ได้เบี้ย และไอคอนต้องไม่ขึ้น (ทั้งสองโหมด)', () => {
  ['paid', 'annual-leave'].forEach(mode => {
    const r = agree('ไม่มีสถานที่ ' + mode, { compensationMode: mode, locations: [] });
    assert.strictEqual(r.จ่ายจริง, false);
  });
  const r2 = agree('locations ไม่มีเลย', { locations: undefined });
  assert.strictEqual(r2.จ่ายจริง, false);
  const r3 = agree('ชื่อสถานที่ว่าง', { locations: [{ name: '   ' }] });
  assert.strictEqual(r3.จ่ายจริง, false);
});

test('คำขอยังไม่อนุมัติ ⇒ ไม่ได้เบี้ย และไอคอนต้องไม่ขึ้น', () => {
  ['pending', 'rejected', 'cancelled'].forEach(st => {
    const r = agree('status=' + st, { status: st });
    assert.strictEqual(r.จ่ายจริง, false, st);
  });
});

// เบี้ยต่างประเทศครอบวันนั้นอยู่แล้ว (เจ้าของตัดสิน 2026-09-23)
test('วันที่เป็น Abroad ⇒ ไม่ได้เบี้ย Upcountry และไอคอนต้องไม่ขึ้น', () => {
  const r = agree('abroad', {}, { dateStatus: { [SUNDAY]: 'abroad' } });
  assert.strictEqual(r.จ่ายจริง, false);
});

// วัน Company Trip ไม่จ่ายเบี้ยใดๆ (เจ้าของตัดสิน 2026-09-24)
test('วัน Company Trip ⇒ ไม่ได้เบี้ย และไอคอนต้องไม่ขึ้น', () => {
  const r = agree('company trip', { dateFrom: TRIPS[0] });
  assert.strictEqual(r.จ่ายจริง, false);
});

test('ปิดสิทธิ์ upcountry ของ role ⇒ ไม่ได้เบี้ย และไอคอนต้องไม่ขึ้น', () => {
  const r = agree('ไม่มีสิทธิ์ upcountry', {}, { elig: { upcountry: ['md'], holidayWork: ['user'] } });
  assert.strictEqual(r.จ่ายจริง, false);
});

test('ปิดสิทธิ์ holidayWork ของ role ⇒ ไม่ได้เบี้ย และไอคอนต้องไม่ขึ้น', () => {
  const r = agree('ไม่มีสิทธิ์ holidayWork', {}, { elig: { upcountry: ['user'], holidayWork: ['md'] } });
  assert.strictEqual(r.จ่ายจริง, false);
});

console.log('T2 ไม่คิดเงินเบิ้ล');

// เจ้าของสั่งตรงๆ ว่า "อย่าคิดเงินเบิ้ล" · payroll กันไว้แล้วที่ upcountryCount ซึ่งตัดวันที่มีใบ
// holiday work ออกก่อนนับ แล้วนับจากใบแทน · ข้อนี้ตรึงพฤติกรรมนั้นไว้ ไม่ให้ใครรื้อโดยไม่ตั้งใจ
test('วันเดียวกันมีทั้งธง upcountry ของวันและใบวันหยุด ⇒ จ่ายครั้งเดียว ไม่ใช่สองครั้ง', () => {
  const rec = hwRec({});
  const user = { ...USER };
  const pDays = days().map(d => d.date === SUNDAY ? { ...d, upcountry: true } : d);
  const ctx = makeClient({ user, leaves: [rec], pDays, att: {} });
  const calc = ctx.computePayroll(user, START, END, 1);
  assert.strictEqual(calc.upcountryCount, 1, 'ต้องนับวันนั้นครั้งเดียว');
  assert.strictEqual(calc.allowance1, RATE_UPCOUNTRY, 'และเป็นเงินหนึ่งวัน ไม่ใช่สองวัน');
});

test('วันธรรมดาที่มีธง upcountry และไม่มีใบวันหยุด ⇒ ยังได้เบี้ยตามเดิม', () => {
  const WEEKDAY = '2026-09-28';                      // จันทร์
  const user = { ...USER };
  const pDays = days().map(d => d.date === WEEKDAY ? { ...d, upcountry: true } : d);
  const ctx = makeClient({ user, leaves: [], pDays, att: {} });
  const calc = ctx.computePayroll(user, START, END, 1);
  assert.strictEqual(calc.upcountryCount, 1);
  assert.strictEqual(calc.allowance1, RATE_UPCOUNTRY);
});

console.log('T2b ป๊อปอัปต้องเงียบในวันที่ payroll จ่าย ฿0 เพราะ role ไม่มีสิทธิ์ Holiday Work');

// พบตอนรีวิว 2026-10-28: บล็อก hwRec ในป๊อปอัปมีด่านเดียวคือ Company Trip ⇒ role ที่ไม่มีสิทธิ์
// holidayWork เห็น badge, ชั่วโมง, ค่าเดินทาง ฿500 และ (หลังใส่เงิน) ยอดเป็นพันบาท ทั้งที่สลิปจ่าย ฿0
// · ข้อนี้ผูกสองอย่างเข้าด้วยกันเป็นพฤติกรรม: ถ้า payroll ไม่จ่าย ด่านของป๊อปอัปต้องปิด
test('ไม่มีสิทธิ์ holidayWork ⇒ payroll จ่าย 0 และด่านของป๊อปอัปต้องปิดพร้อมกัน', () => {
  const SUN = '2026-09-27';
  const paidRec = {
    id: 1, userId: USER.id, type: 'holiday-work', status: 'approved', dateFrom: SUN,
    compensationMode: 'paid', workStartTime: '09:00', workEndTime: '20:00',
    otHours20: 7.5, otHours30: 2.5, locations: [{ name: 'NGK' }],
  };
  [['มีสิทธิ์', { upcountry: ['user'], holidayWork: ['user'] }, true],
   ['ไม่มีสิทธิ์', { upcountry: ['user'], holidayWork: ['md'] }, false]].forEach(([label, elig, expect]) => {
    const S = { ...SETTINGS, allowanceEligibility: elig };
    const ctx = makeClient({ user: USER, leaves: [paidRec], pDays: days(), att: {} });
    ctx.APP_SETTINGS = S;
    const calc = ctx.computePayroll(USER, START, END, 1);
    const จ่ายจริง = (calc.otHourBuckets ? Object.keys(calc.otHourBuckets).length > 0 : false)
      || calc.holidayTransportTotal > 0 || calc.holidayWorkUpcountryCount > 0;
    const ด่านเปิด = ctx.isAllowanceEligible(elig, USER.role, 'holidayWork');
    assert.strictEqual(ด่านเปิด, expect, label + ': ด่านผิด');
    assert.strictEqual(ด่านเปิด, จ่ายจริง,
      `${label}: ด่านป๊อปอัป=${ด่านเปิด} แต่ payroll จ่าย=${จ่ายจริง} ⇒ จอกับสลิปพูดคนละเรื่อง`);
  });
});

// รีวิวรอบ 4 หักล้างยามเดิมของข้อนี้ได้ด้วย mutation สองแบบ (เปิดด่านให้ผ่านหมด / กลับด้านเงื่อนไข
// เจ้าของ) เพราะมันเป็นแค่ regex บนซอร์ส ⇒ ดึง "ตัวด่าน" ออกมารันจริงแล้วทดสอบพฤติกรรมแทน
// 2026-10-28 (เจ้าของสั่ง "ไล่แก้ต่อ"): ด่านนี้เลิกอ่าน `.role` ดิบ แล้วไปถาม `gateRoleFor()`
// ตามกฎของเจ้าของ (2026-10-08, AGENTS §7a: ด่านต้องถาม effectiveRole/gateRoleFor ไม่ใช่ role
// ของบัญชี เพื่อให้ superadmin พรีวิว role อื่นได้) ⇒ กล่องต้องมี `gateRoleFor` + `effectiveRole`
// ตัวจริง ไม่ใช่ stub และ `previewRole` / `isSuperAdmin` ส่งเข้าไปได้เพื่อทดสอบการพรีวิว
function makeOwnerGate(users, me, targetUserId, elig, opts) {
  const o = opts || {};
  const fn = extractFunction(APP_SRC, 'showAttendanceDetail');
  const m = fn.match(/const _ownerUser = [\s\S]*?const _ownerCan = [^\n]*\n/);
  assert.ok(m, 'หาบล็อกประกาศตัวด่านเจ้าของไม่เจอ ⇒ โครงเปลี่ยนไปแล้ว ให้ทบทวนยามนี้');
  const ctx = {
    DATA_USERS: users, currentUser: me, targetUserId,
    APP_SETTINGS: { allowanceEligibility: elig }, console,
    previewRole: o.previewRole || null,
    isSuperAdmin: () => !!o.superAdmin,
    isImpersonatingPerson: () => !!o.impersonating,
  };
  vm.createContext(ctx);
  vm.runInContext(constDecl(APP_SRC, 'DEFAULT_ALLOWANCE_ELIGIBILITY') + '\n' +
    extractFunction(APP_SRC, 'isAllowanceEligible') + '\n' +
    extractFunction(APP_SRC, 'effectiveRole') + '\n' +
    extractFunction(APP_SRC, 'gateRoleFor') + '\n' + m[0] +
    '\nout = { role: _ownerRole, hw: _ownerCan("holidayWork"), upc: _ownerCan("upcountry") };', ctx);
  return ctx.out;
}

// 2026-10-28: เหตุที่ด่านต้องถาม gateRoleFor() ไม่ใช่ `.role` ดิบ — กฎของเจ้าของข้อ "ฟีเจอร์ใหม่
// ต้องตรวจสอบผ่านบัญชี superadmin ได้ ทั้งในฐานะ role และในฐานะคน" · สองข้อนี้คือพฤติกรรมนั้น
test('ด่านเจ้าของ: superadmin ดูของตัวเองพร้อมพรีวิว role ⇒ ด่านเดินตาม role ที่พรีวิว', () => {
  const me = { id: 9, role: 'superadmin' };
  const elig = { holidayWork: ['user'], upcountry: ['user'] };
  const asUser = makeOwnerGate([me], me, 9, elig, { superAdmin: true, previewRole: 'user' });
  assert.strictEqual(asUser.role, 'user', 'พรีวิวเป็น user ⇒ ด่านต้องเห็น role เป็น user');
  assert.strictEqual(asUser.hw, true, 'พรีวิวเป็น user แล้วต้องเห็นสิ่งที่ user เห็น');
  const asAcct = makeOwnerGate([me], me, 9, elig, { superAdmin: true, previewRole: 'accounting' });
  assert.strictEqual(asAcct.role, 'accounting');
  assert.strictEqual(asAcct.hw, false, 'พรีวิวเป็น accounting แล้วต้องไม่เห็นเบี้ยที่ accounting ไม่ได้');
});

test('ด่านเจ้าของ: superadmin สวมเป็น "คน" ⇒ ใช้ role จริงของบัญชี ไม่ใช่ role ที่พรีวิว', () => {
  const me = { id: 9, role: 'superadmin' };
  const g = makeOwnerGate([me], me, 9, { holidayWork: ['superadmin'], upcountry: [] },
    { superAdmin: true, previewRole: 'user', impersonating: true });
  assert.strictEqual(g.role, 'superadmin',
    'effectiveRole() ให้คนมาก่อน role ⇒ สวมเป็นคนแล้วต้องใช้ rank จริงของบัญชี');
  assert.strictEqual(g.hw, true);
});

test('ด่านเจ้าของ: หาเจ้าของเจอและมีสิทธิ์ ⇒ เปิด', () => {
  const g = makeOwnerGate([{ id: 7, role: 'user' }], { id: 1, role: 'md' }, 7,
    { holidayWork: ['user'], upcountry: ['user'] });
  assert.strictEqual(g.role, 'user');
  assert.strictEqual(g.hw, true);
});

test('ด่านเจ้าของ: เจ้าของไม่มีสิทธิ์ แม้คนดูมี ⇒ ปิด', () => {
  const g = makeOwnerGate([{ id: 7, role: 'accounting' }], { id: 1, role: 'md' }, 7,
    { holidayWork: ['md'], upcountry: ['md'] });
  assert.strictEqual(g.role, 'accounting');
  assert.strictEqual(g.hw, false, 'ต้องตัดสินด้วย role ของเจ้าของ ไม่ใช่ของคนดู');
  assert.strictEqual(g.upc, false);
});

// เคสที่รีวิวรอบ 4 ชี้: หาเจ้าของไม่เจอ แล้วโค้ดถอยไปใช้ role ของคนดู ⇒ โชว์เบี้ยของวันที่จ่าย ฿0
test('ด่านเจ้าของ: หาเจ้าของไม่เจอ ⇒ ปิดทุกด่าน ไม่ถอยไปใช้คนดู', () => {
  const g = makeOwnerGate([], { id: 1, role: 'md' }, 7, { holidayWork: ['md'], upcountry: ['md'] });
  assert.strictEqual(g.role, null, 'ไม่รู้ว่าเจ้าของเป็น role อะไร ⇒ ต้องเป็น null');
  assert.strictEqual(g.hw, false);
  assert.strictEqual(g.upc, false);
});

test('ด่านเจ้าของ: ดูของตัวเองแม้ไม่อยู่ใน DATA_USERS ⇒ ยังใช้ได้', () => {
  const g = makeOwnerGate([], { id: 7, role: 'user' }, 7, { holidayWork: ['user'] });
  assert.strictEqual(g.role, 'user');
  assert.strictEqual(g.hw, true);
});

// ───────────────────────────────────────────────────────────────────────────────────────────────
// 2026-10-28 (รีวิวรอบ 5): สองข้อที่นี่เคยเป็น regex บนซอร์สของป๊อปอัป ซึ่ง (ก) เขียวต่อไปได้แม้
// พฤติกรรมเปลี่ยน (ข) ตรวจแค่จอเดียวจากสี่จอ — และนั่นคือเหตุที่รอบ 3 แก้ป๊อปอัปแล้วแถว/การ์ด/
// ใบพิมพ์ยังซ่อนวันที่ให้วันลาไปจริง · ตอนนี้กฎอยู่ใน holidayWorkDisplayFor() ตัวเดียว ⇒ รันตัวจริง
function makeDisplayFor({ leaves, trips = [], elig, ownerRole, rowStatus = 'holiday',
  date = '2026-10-18', userId = 7 }) {
  const ctx = { DATA_LEAVES: leaves, DATA_COMPANY_TRIP_DATES: trips, console };
  vm.createContext(ctx);
  vm.runInContext(
    constDecl(APP_SRC, 'DEFAULT_ALLOWANCE_ELIGIBILITY') + '\n' +
    extractFunction(APP_SRC, 'isAllowanceEligible') + '\n' +
    extractFunction(APP_SRC, 'isCompanyTripDay') + '\n' +
    extractFunction(APP_SRC, 'holidayWorkDisplayFor') + '\n' +
    'out = holidayWorkDisplayFor(' + userId + ', ' + JSON.stringify(date) + ', ' +
    JSON.stringify(rowStatus) + ', ' + JSON.stringify(ownerRole) + ', { allowanceEligibility: ' +
    JSON.stringify(elig) + ' });', ctx);
  return { rec: ctx.out.rec, takesDay: ctx.out.takesDay };
}
const REC_PAID = { userId: 7, type: 'holiday-work', dateFrom: '2026-10-18', status: 'approved', compensationMode: 'paid' };
const REC_LEAVE = { ...REC_PAID, compensationMode: 'annual-leave' };
const ELIG_USER = { holidayWork: ['user'], upcountry: ['user'] };

test('จอรวม: โหมดเงิน + เจ้าของมีสิทธิ์ ⇒ แสดง และวันถูกใบยึดไป', () => {
  const r = makeDisplayFor({ leaves: [REC_PAID], elig: ELIG_USER, ownerRole: 'user' });
  assert.ok(r.rec, 'ต้องแสดง');
  assert.strictEqual(r.takesDay, true);
});

test('จอรวม: โหมดเงิน + เจ้าของไม่มีสิทธิ์ ⇒ ไม่แสดง (สลิปจ่าย ฿0)', () => {
  const r = makeDisplayFor({ leaves: [REC_PAID], elig: ELIG_USER, ownerRole: 'accounting' });
  assert.strictEqual(r.rec, null);
  assert.strictEqual(r.takesDay, false);
});

// หัวใจของรอบ 5 — และเป็นครึ่งที่แถวเคยพลาดเพราะรวมสองค่าไว้ในตัวแปรเดียว:
// โหมดแลกวันหยุดต้อง **แสดง** เพราะ getApprovedHolidayWorkDays() ให้วันลาโดยไม่มีด่าน role
// แต่ต้อง **ไม่ยึดวัน** เพราะ payroll สร้าง holidayWorkDates จาก approvedHolidayWork ที่ gate
// ด้วยสิทธิ์ holidayWork ⇒ role ที่ไม่มีสิทธิ์ ลิสต์นั้นว่าง แปลว่าธง upcountry ของวันนั้นยังถูกนับ
test('จอรวม: โหมดแลกวันหยุด + เจ้าของไม่มีสิทธิ์ ⇒ แสดง แต่ห้ามยึดวัน', () => {
  const r = makeDisplayFor({ leaves: [REC_LEAVE], elig: ELIG_USER, ownerRole: 'accounting' });
  assert.ok(r.rec, 'วันลาได้จริงโดยไม่มีด่าน role ⇒ ซ่อน = ปฏิเสธวันลาที่ระบบให้ไปแล้ว');
  assert.strictEqual(r.takesDay, false,
    'payroll ไม่ได้ยึดวันนี้ (approvedHolidayWork ว่าง) ⇒ ธง upcountry ของวันนั้นยังถูกนับ ห้ามกดทิ้ง');
  assert.notStrictEqual(r.rec !== null, r.takesDay,
    'สองค่านี้ต่างกันในเคสนี้ — ถ้าใครรวมกลับเป็นค่าเดียว บั๊กของรอบ 5 กลับมาทันที');
});

test('จอรวม: โหมดแลกวันหยุด + เจ้าของมีสิทธิ์ ⇒ แสดง และยึดวัน', () => {
  const r = makeDisplayFor({ leaves: [REC_LEAVE], elig: ELIG_USER, ownerRole: 'user' });
  assert.ok(r.rec);
  assert.strictEqual(r.takesDay, true);
});

test('จอรวม: หาเจ้าของไม่เจอ (role = null) ⇒ ปิดทางเงิน แต่วันลายังแสดง', () => {
  const paid = makeDisplayFor({ leaves: [REC_PAID], elig: ELIG_USER, ownerRole: null });
  assert.strictEqual(paid.rec, null);
  assert.strictEqual(paid.takesDay, false);
  const leave = makeDisplayFor({ leaves: [REC_LEAVE], elig: ELIG_USER, ownerRole: null });
  assert.ok(leave.rec, 'โหมดวันลาไม่ต้องรู้ role');
  assert.strictEqual(leave.takesDay, false);
});

test('จอรวม: Company Trip ปิดทั้งสองค่า ทั้งทางสถานะแถวและทางรายการวันทริป', () => {
  const byStatus = makeDisplayFor({ leaves: [REC_PAID], elig: ELIG_USER, ownerRole: 'user', rowStatus: 'company-trip' });
  assert.strictEqual(byStatus.rec, null);
  assert.strictEqual(byStatus.takesDay, false);
  const byList = makeDisplayFor({ leaves: [REC_PAID], elig: ELIG_USER, ownerRole: 'user', trips: ['2026-10-18'] });
  assert.strictEqual(byList.rec, null, 'ป๊อปอัปเดิมถามผ่าน isCompanyTripDay() ส่วนแถวถามผ่าน row.status ⇒ ต้องรับทั้งสองทาง');
  assert.strictEqual(byList.takesDay, false);
});

test('จอรวม: ไม่มีเรคอร์ด / ยังไม่อนุมัติ / คนละวัน ⇒ ไม่แสดง', () => {
  assert.strictEqual(makeDisplayFor({ leaves: [], elig: ELIG_USER, ownerRole: 'user' }).rec, null);
  assert.strictEqual(makeDisplayFor({ leaves: [{ ...REC_PAID, status: 'pending' }], elig: ELIG_USER, ownerRole: 'user' }).rec, null);
  assert.strictEqual(makeDisplayFor({ leaves: [{ ...REC_PAID, dateFrom: '2026-10-17' }], elig: ELIG_USER, ownerRole: 'user' }).rec, null);
  assert.strictEqual(makeDisplayFor({ leaves: [{ ...REC_PAID, userId: 8 }], elig: ELIG_USER, ownerRole: 'user' }).rec, null);
});

// ข้อนี้เป็นยามเชิงโครงสร้าง ไม่ใช่คำกล่าวอ้างเรื่องพฤติกรรม: พฤติกรรมถูกตรวจข้างบนแล้ว ที่นี่กัน
// ไม่ให้จอใดจอหนึ่ง **งอกกฎของตัวเองขึ้นมาใหม่** ซึ่งคือวิธีที่สามจอหลุดออกจากกันมาแล้วสองรอบ
test('ทั้งสี่จอถามฟังก์ชันกลางตัวเดียว และมีนิยามเดียวในไฟล์', () => {
  const defs = APP_SRC.match(/^function holidayWorkDisplayFor\(/gm) || [];
  assert.strictEqual(defs.length, 1, 'ต้องมีนิยามเดียว');
  // แถวบนจอ + การ์ดมือถือใช้สตริง badge ชุดเดียวกัน จึงนับเป็นจอเดียวกันที่นี่ (ยืนยันด้วยข้อถัดไป)
  for (const fname of ['renderAttendanceTable', 'buildAttendancePrintView', 'showAttendanceDetail']) {
    assert.ok(/holidayWorkDisplayFor\(/.test(extractFunction(APP_SRC, fname)),
      fname + ' ไม่ได้ถามฟังก์ชันกลาง ⇒ มันกำลังตัดสินเอง');
  }
});

// 2026-10-28 (รีวิวรอบ 6): ยามข้อบนตรวจแค่ว่า **มีการเรียก** ฟังก์ชันกลาง ไม่เคยดูว่าเรียกถาม
// ถึง "เรคอร์ดของใคร" ⇒ รอบ 5 ส่ง `targetUser.id` ในใบพิมพ์ (ตัวที่ถอยไปเป็นคนที่กำลังดู) ทั้งที่
// คอมเมนต์ที่ตัวเองเขียนไว้สามบรรทัดเหนือมันบอกว่าห้ามใช้ `targetUser` — และทุกเทสต์เขียว
// นี่คือความผิดพลาดรูปแบบเดียวกับการนับ `const locErr =`: ตรึงชื่อ แต่ไม่ตรึงสิ่งที่มันพูดถึง
test('ทุกจุดเรียกฟังก์ชันกลาง ถามถึงเรคอร์ดของเจ้าของแถว ไม่ใช่ของคนที่กำลังดู', () => {
  // ตัดคอมเมนต์บรรทัดและนิยามของฟังก์ชันออกก่อน ไม่งั้นจะนับประโยคที่แค่ *พูดถึง* มัน และนับ
  // `function holidayWorkDisplayFor(userId, …)` เป็นจุดเรียกด้วย (บทเรียนเดียวกับยามนับจุดเรียก
  // ของ validateUpcountryLocations ข้างล่าง — ผมพลาดซ้ำรูปแบบเดิมตอนเขียนข้อนี้ครั้งแรก)
  const SRC = APP_SRC.replace(/^[ \t]*\/\/[^\n]*$/gm, '').replace(/^function holidayWorkDisplayFor\(/m, 'function __def__(');
  const calls = [...SRC.matchAll(/holidayWorkDisplayFor\(([^,]+),/g)].map(m => m[1].trim());
  assert.strictEqual(calls.length, 3,
    `คาดว่ามี 3 จุดเรียก (แถว, ใบพิมพ์, ป๊อปอัป) แต่เจอ ${calls.length}: ${calls.join(' | ')} ⇒ ` +
    'ถ้าเพิ่มจอใหม่จริง ให้เพิ่มในข้อนี้ด้วย');
  // ชื่อที่ยอมรับได้: id ที่ `days`/`generatePeriodDays` ใช้สร้างตาราง หรือพารามิเตอร์ที่ส่งค่านั้นมา
  const OK = new Set(['targetUserId', 'ownerUserId']);
  calls.forEach(arg => {
    assert.ok(OK.has(arg),
      `จุดเรียกถามถึง "${arg}" ซึ่งไม่ใช่ id ของเจ้าของแถว · ` +
      '`targetUser.id` / `targetUserObj.id` / `currentUser.id` ถอยไปเป็นคนที่กำลังดูได้ ' +
      '⇒ ตารางเป็นของคนหนึ่ง ไอคอนเบี้ยเป็นของอีกคน');
  });
});

// รีวิวรอบ 6 (test gap 2): ยามเดิมตรึงไว้ครึ่งเดียว — ตรวจว่าตัวให้วันลา **ไม่มี** ด่าน role
// แต่ไม่มีใครตรึงว่าลิสต์ที่สร้าง holidayWorkDates **มี** ด่าน ⇒ ถอด `canHolidayWork ?` ออกจาก
// computePayroll แล้ว `takesDay` ผิดทั้งสี่จอ โดยไม่มีอะไรแดง · สมมติฐานของฟังก์ชันกลางมีสองขา
// ต้องตรึงทั้งสองขา
test('ลิสต์ที่สร้าง holidayWorkDates ยังมีด่านสิทธิ์ ⇒ สมมติฐานของ takesDay ยังใช้ได้', () => {
  const fn = extractFunction(APP_SRC, 'computePayroll');
  assert.ok(/const approvedHolidayWork = canHolidayWork \?/.test(fn),
    'approvedHolidayWork ไม่ได้ gate ด้วย canHolidayWork แล้ว ⇒ `takesDay` ของ holidayWorkDisplayFor ' +
    'ซึ่งสะท้อนลิสต์นี้ กลายเป็นคนละเรื่องกับ payroll ให้กลับไปทบทวนทั้งสี่จอ');
  assert.ok(/holidayWorkDates\s*=\s*new Set\(approvedHolidayWork/.test(fn),
    'holidayWorkDates ไม่ได้สร้างจาก approvedHolidayWork แล้ว ⇒ ทบทวน takesDay');
});

// ───────────────────────────────────────────────────────────────────────────────────────────────
// 2026-10-28 (เจ้าของสั่ง "ไล่แก้ต่อ"): ชุดวันที่ปลดล็อกเบี้ยเข้าเช้า/ดึกของวันหยุด · ของเดิมมี
// สำเนา 11 ที่ และทุกที่สร้างแบบไม่มีด่านสิทธิ์ ขณะที่ payroll ส่งชุดที่ gate ด้วย `holidayWork`
// ⇒ role ที่มี `earlyLate` แต่ไม่มี `holidayWork` เห็น 🌙 พร้อมเงิน แต่สลิปจ่าย ฿0
function unlockDates({ leaves, trips = [], elig, role, userId = 7 }) {
  const ctx = { DATA_LEAVES: leaves, DATA_COMPANY_TRIP_DATES: trips, console };
  vm.createContext(ctx);
  vm.runInContext(
    constDecl(APP_SRC, 'DEFAULT_ALLOWANCE_ELIGIBILITY') + '\n' +
    extractFunction(APP_SRC, 'isAllowanceEligible') + '\n' +
    extractFunction(APP_SRC, 'isCompanyTripDay') + '\n' +
    extractFunction(APP_SRC, 'holidayWorkUnlockDates') + '\n' +
    'out = Array.from(holidayWorkUnlockDates(' + userId + ', ' + JSON.stringify(role) +
    ', { allowanceEligibility: ' + JSON.stringify(elig) + ' })).sort();', ctx);
  return Array.from(ctx.out);
}
const HW_DAYS = [
  { userId: 7, type: 'holiday-work', status: 'approved', dateFrom: '2026-10-17' },
  { userId: 7, type: 'holiday-work', status: 'approved', dateFrom: '2026-10-18' },
  { userId: 8, type: 'holiday-work', status: 'approved', dateFrom: '2026-10-19' },
  { userId: 7, type: 'holiday-work', status: 'pending', dateFrom: '2026-10-20' },
];

test('ชุดปลดล็อก: role มีสิทธิ์ holidayWork ⇒ ได้วันของคนนั้นที่อนุมัติแล้ว', () => {
  assert.deepStrictEqual(
    unlockDates({ leaves: HW_DAYS, elig: { holidayWork: ['user'] }, role: 'user' }),
    ['2026-10-17', '2026-10-18'],
    'ต้องได้เฉพาะวันของ userId นั้นที่สถานะ approved');
});

test('ชุดปลดล็อก: role ไม่มีสิทธิ์ holidayWork ⇒ ชุดว่าง (เหมือน payroll)', () => {
  assert.deepStrictEqual(
    unlockDates({ leaves: HW_DAYS, elig: { holidayWork: ['user'] }, role: 'driver' }), [],
    'driver มีสิทธิ์ earlyLate แต่ไม่มี holidayWork ⇒ payroll ไม่ปลดล็อกให้ จอก็ต้องไม่ปลดล็อก');
});

test('ชุดปลดล็อก: หา role ไม่ได้ (null) ⇒ ชุดว่าง', () => {
  assert.deepStrictEqual(unlockDates({ leaves: HW_DAYS, elig: { holidayWork: ['user'] }, role: null }), []);
});

test('ชุดปลดล็อก: วัน Company Trip ถูกตัดออก เหมือน approvedHolidayWork ของ payroll', () => {
  assert.deepStrictEqual(
    unlockDates({ leaves: HW_DAYS, trips: ['2026-10-18'], elig: { holidayWork: ['user'] }, role: 'user' }),
    ['2026-10-17']);
});

// ยามเชิงโครงสร้าง: ห้ามมีจอไหนสร้างชุดนี้เองอีก · นับ "ชุดวัน holiday-work ที่สร้างจาก DATA_LEAVES"
// ทั้งไฟล์ แล้วอนุญาตเฉพาะสองที่ — ตัวฟังก์ชันกลางเอง และ computePayroll
test('ไม่มีจอไหนสร้างชุดวัน Holiday Work เองอีก นอกจากฟังก์ชันกลางและ payroll', () => {
  const SRC = APP_SRC.replace(/^[ \t]*\/\/[^\n]*$/gm, '');
  const sets = [...SRC.matchAll(/DATA_LEAVES\s*\n?\s*\.?filter\(l\s*=>[\s\S]{0,220}?'holiday-work'[\s\S]{0,220}?\)\s*\n?\s*\)?\s*\.map\(l\s*=>\s*l\.dateFrom\)/g)];
  assert.ok(sets.length <= 2,
    `เจอ ${sets.length} ที่ที่สร้างชุดวัน Holiday Work จาก DATA_LEAVES · อนุญาตได้ไม่เกิน 2 ` +
    '(holidayWorkUnlockDates และ computePayroll) ⇒ มีจอที่สร้างกฎของตัวเองขึ้นมาใหม่:\n       ' +
    sets.map(m => m[0].replace(/\s+/g, ' ').slice(0, 120)).join('\n       '));
  // และทุกจอที่ใช้ชุดนี้ต้องเรียกฟังก์ชันกลาง
  const calls = (SRC.match(/holidayWorkUnlockDates\(/g) || []).length;
  assert.ok(calls >= 9,
    `คาดว่ามีจุดเรียกฟังก์ชันกลางอย่างน้อย 9 จุด (แถว · ใบพิมพ์ · Dashboard · สรุปงวด · การ์ดรายงาน ` +
    `· รายงานละเอียด 4 จุด · การ์ดเทียบเงิน) แต่เจอ ${calls} ⇒ มีจออะไรเลิกใช้มันไปแล้ว`);
});

// ───────────────────────────────────────────────────────────────────────────────────────────────
// 2026-10-28 (เจ้าของสั่ง "ไล่แก้ต่อ"): badge ⏱️ OT และ 🚙 รถส่วนตัว ในป๊อปอัปรายวัน · ทั้งสอง
// พิมพ์จำนวนเงิน และของเดิม ⏱️ มีด่านเดียว (Company Trip) ส่วน 🚙 **ไม่มีด่านเลย** ขณะที่ payroll
// มีสี่ชั้นทั้งคู่ · ดึงตัวเงื่อนไขของ `if` ออกมารันกับค่าที่ฉีดเข้าไป จึงเป็นการตรวจพฤติกรรมจริง
function popupCond(marker, vars, preludeRe) {
  const fn = extractFunction(APP_SRC, 'showAttendanceDetail');
  const i = fn.indexOf(marker);
  assert.ok(i > 0, `หาเงื่อนไขของ badge ไม่เจอ (${marker}) ⇒ โครงเปลี่ยน ให้ทบทวนยามนี้`);
  // ตัดจาก `if (` ถึงวงเล็บปิดที่สมดุล
  const open = fn.indexOf('(', i);
  let p = 0, end = -1;
  for (let j = open; j < fn.length; j++) {
    if (fn[j] === '(') p++;
    else if (fn[j] === ')') { p--; if (p === 0) { end = j; break; } }
  }
  const expr = fn.slice(open + 1, end);
  const ctx = Object.assign({
    console,
    isFullDayPersonalLeaveStatus: s => ['leave-annual', 'leave-sick', 'leave-business'].includes(s),
  }, vars);
  vm.createContext(ctx);
  // บาง badge มีบรรทัดคำนวนอยู่ก่อน `if` ⇒ ดึงมาด้วย ไม่ใช่การฉีดค่าเอง
  // (ฉีดค่าเอง = เขียนกฎนั้นซ้ำในเทสต์ แล้วเทสต์ก็จะเขียวแม้โค้ดจริงเปลี่ยน)
  let prelude = '';
  if (preludeRe) {
    const pm = fn.match(preludeRe);
    assert.ok(pm, 'หาบรรทัดคำนวณที่อยู่ก่อนเงื่อนไขไม่เจอ ⇒ โครงเปลี่ยน ให้ทบทวนยามนี้');
    prelude = pm[0] + ';\n';
  }
  vm.runInContext(prelude + 'out = !!(' + expr + ');', ctx);
  return { shown: ctx.out, expr };
}
const OT_MARK = 'if (approvedOT && row.status !== ';
const PC_MARK = 'if (pcRecord && _ownerCan(';
const PC_PRELUDE = /const _pcOwnerFlag = .*/;

test('ป๊อปอัป ⏱️: เจ้าของไม่มีสิทธิ์ ot ⇒ ไม่ขึ้น badge เลย', () => {
  const base = { approvedOT: { id: 1 }, row: { status: 'present' }, _hwDisp: { rec: null, takesDay: false } };
  assert.strictEqual(popupCond(OT_MARK, Object.assign({}, base, { _ownerCan: () => true })).shown, true);
  assert.strictEqual(popupCond(OT_MARK, Object.assign({}, base, { _ownerCan: () => false })).shown, false,
    'payroll สร้าง approvedOTs เป็น [] เมื่อไม่มีสิทธิ์ ot ⇒ จอต้องไม่ขึ้น badge ที่พิมพ์ชั่วโมงและอัตรา');
});

test('ป๊อปอัป ⏱️: วัน Company Trip ไม่ขึ้น', () => {
  assert.strictEqual(popupCond(OT_MARK, {
    approvedOT: { id: 1 }, row: { status: 'company-trip' },
    _hwDisp: { rec: null, takesDay: false }, _ownerCan: () => true }).shown, false);
});

// สองชั้นที่เหลือของ payroll ไม่ซ่อน badge แต่ต้องทำให้ไม่อ่านว่าได้เงิน ⇒ ตรวจที่ `_otNotCounted`
function otNotCounted(vars) {
  const fn = extractFunction(APP_SRC, 'showAttendanceDetail');
  const m = fn.match(/const _otPaidHwDay = [^\n]*\n\s*const _otNotCounted = [\s\S]*?;\n/);
  assert.ok(m, 'หาบล็อก _otNotCounted ไม่เจอ ⇒ โครงเปลี่ยน ให้ทบทวนยามนี้');
  const ctx = Object.assign({
    console,
    isFullDayPersonalLeaveStatus: s => ['leave-annual', 'leave-sick', 'leave-business'].includes(s),
  }, vars);
  vm.createContext(ctx);
  vm.runInContext(m[0] + '\nout = _otNotCounted;', ctx);
  return ctx.out;
}

test('ป๊อปอัป ⏱️: วันลาเต็มวัน และวันหยุดโหมดรับเงิน ⇒ ต้องเขียนว่าไม่ถูกนับ', () => {
  const noHw = { rec: null, takesDay: false };
  const paidHw = { rec: { compensationMode: 'paid' }, takesDay: true };
  const leaveHw = { rec: { compensationMode: 'annual-leave' }, takesDay: true };
  assert.strictEqual(otNotCounted({ row: { status: 'present' }, approvedOT: { id: 1 }, _hwDisp: noHw }), false,
    'วันปกติต้องนับตามเดิม');
  assert.strictEqual(otNotCounted({ row: { status: 'leave-annual' }, approvedOT: { id: 1 }, _hwDisp: noHw }), true,
    'payroll ตัดใบ OT ของวันลาเต็มวันออก (fullLeaveDates)');
  assert.strictEqual(otNotCounted({ row: { status: 'present' }, approvedOT: { id: 1 }, _hwDisp: paidHw }), true,
    'วันหยุดโหมดรับเงินกินทั้งวันไปแล้ว ⇒ ใบ OT ของออฟฟิศไม่ถูกนับซ้ำ');
  assert.strictEqual(otNotCounted({ row: { status: 'present' }, approvedOT: { id: 1, isDriverOT: true }, _hwDisp: paidHw }), false,
    'OT ของคนขับจ่ายแยกอิสระ — payroll ไม่ตัดมัน');
  assert.strictEqual(otNotCounted({ row: { status: 'present' }, approvedOT: { id: 1 }, _hwDisp: leaveHw }), false,
    'โหมดแลกวันหยุดไม่ได้จ่ายเงินของวันนั้น ⇒ ใบ OT ยังถูกนับปกติ');
});

test('ป๊อปอัป 🚙: ต้องผ่านทั้งสิทธิ์ role, ธงรายบุคคลของเจ้าของ, Company Trip และวันลาเต็มวัน', () => {
  const ok = { pcRecord: { id: 5 }, _ownerCan: () => true, _ownerUser: { personalCarEligible: true },
    row: { status: 'present' } };
  assert.strictEqual(popupCond(PC_MARK, ok, PC_PRELUDE).shown, true);
  assert.strictEqual(popupCond(PC_MARK, Object.assign({}, ok, { _ownerCan: () => false }), PC_PRELUDE).shown, false,
    'ไม่มีสิทธิ์ personalCar ⇒ payroll จ่าย ฿0');
  assert.strictEqual(popupCond(PC_MARK, Object.assign({}, ok, { _ownerUser: { personalCarEligible: false } }), PC_PRELUDE).shown, false,
    'ธงรายบุคคลเป็น false ⇒ payroll จ่าย ฿0');
  assert.strictEqual(popupCond(PC_MARK, Object.assign({}, ok, { _ownerUser: {} }), PC_PRELUDE).shown, false,
    'ไม่มีธงเลย ⇒ payroll ใช้ === true จึงไม่จ่าย');
  assert.strictEqual(popupCond(PC_MARK, Object.assign({}, ok, { _ownerUser: null }), PC_PRELUDE).shown, false,
    'หาเจ้าของไม่เจอ ⇒ ไม่รู้ว่าสลิปจ่ายอะไร');
  assert.strictEqual(popupCond(PC_MARK, Object.assign({}, ok, { row: { status: 'company-trip' } }), PC_PRELUDE).shown, false);
  assert.strictEqual(popupCond(PC_MARK, Object.assign({}, ok, { row: { status: 'leave-sick' } }), PC_PRELUDE).shown, false,
    'payroll ตัดวันลาเต็มวันออกจาก approvedPC');
});

test('การ์ดมือถือใช้ badge ชุดเดียวกับแถวบนจอ จึงไม่มีกฎของตัวเอง', () => {
  const row = extractFunction(APP_SRC, 'renderAttendanceTable');
  const uses = (row.match(/\[holidayWorkBadge, earlyBadge, lateBadge, otBadge, upcountryBadge,/g) || []);
  assert.strictEqual(uses.length, 2,
    'ต้องมีสองที่ (ตารางเดสก์ท็อปและการ์ดมือถือ) ที่ต่อ badge ชุดเดียวกัน — ถ้าเหลือหนึ่ง การ์ดแยกไปสร้างเองแล้ว');
});

// รีวิวรอบ 3 (C2): ด่านนั้นปิดเกิน — getApprovedHolidayWorkDays() ให้วันลาโดย **ไม่มีด่าน role เลย**
// ⇒ โหมดแลกวันหยุดต้องผ่านด่านเสมอ · ถ้าวันหนึ่งตัวให้วันลามีด่าน role ข้อนี้จะแดงเพื่อให้กลับมาคิดใหม่
test('ตัวให้วันลายังไม่มีด่าน role ⇒ สมมติฐานของฟังก์ชันกลางยังใช้ได้', () => {
  const credit = extractFunction(APP_SRC, 'getApprovedHolidayWorkDays');
  assert.ok(!/isAllowanceEligible|canHolidayWork|allowanceEligibility/.test(credit),
    'ถ้าวันหนึ่งตัวให้วันลามีด่าน role แล้ว ให้กลับมาทบทวน holidayWorkDisplayFor() ด้วย');
});

// รีวิวรอบ 3 (C1): แถวตารางกับป๊อปอัปเป็น "เรคอร์ดเดียวกัน เงินก้อนเดียวกัน" ⇒ ต้องหาเจ้าของแบบเดียวกัน
test('ทั้งสองที่ที่คิดเงินของวันนี้ ห้ามถอยไปใช้เงินเดือนของคนที่กำลังดู', () => {
  assert.ok(!/DATA_USERS\.find\(u => u\.id == uid\) \|\| currentUser/.test(APP_SRC),
    'แถวตารางยังถอยไปใช้ currentUser อยู่ ⇒ คิดเงินจากเงินเดือนคนดู');
  const row = extractFunction(APP_SRC, 'renderAttendanceTable');
  // 2026-10-28 (รีวิวรอบ 5): เกณฑ์เดิมคือ `>= 2` ขณะที่ของจริงมี 3 จุด ⇒ ถอยจุดใดจุดหนึ่งกลับไปเป็น
  // `|| currentUser` ก็ยังเหลือ 2 และเทสต์ทั้งชุดยังเขียว — คือ regression ที่ข้อนี้ตั้งใจกันไว้
  // กลับมาได้เงียบๆ · ตอนนี้ตรึงทั้งจำนวนและ **ชื่อตัวแปรของแต่ละจุด** แยกกัน
  const both = (APP_SRC.match(/\|\| \(currentUser && currentUser\.id === (uid|targetUserId) \? currentUser : null\)/g) || []);
  assert.strictEqual(both.length, 3,
    `ต้องมี 3 จุดที่หาเจ้าของด้วยสำนวนนี้ (_attOwner, empUser, _ownerUser) แต่เจอ ${both.length} ⇒ ` +
    'ถ้าเพิ่มจุดใหม่จริง ให้เพิ่มชื่อมันในข้อนี้ด้วย ไม่ใช่ผ่อนตัวเลข');
  for (const [name, re] of [
    ['_attOwner (แถวตาราง)', /const _attOwner = DATA_USERS\.find\(u => u\.id === targetUserId\)\s*\n\s*\|\| \(currentUser/],
    ['empUser (ทูลทิป OT ของแถว)', /const empUser = DATA_USERS\.find\(u => u\.id === uid\)\s*\n\s*\|\| \(currentUser/],
    ['_ownerUser (ป๊อปอัป)', /const _ownerUser = DATA_USERS\.find\(u => u\.id === targetUserId\)\s*\n\s*\|\| \(currentUser/],
  ]) {
    assert.ok(re.test(APP_SRC), `${name} ไม่ได้หาเจ้าของด้วยสำนวนนี้แล้ว ⇒ อาจถอยไปใช้ currentUser`);
  }
});

console.log('T3 ช่องสถานที่ไม่ใช่ช่องบังคับ และรูปแบบที่ส่งต้องเป็นรูปแบบที่เซิร์ฟเวอร์รับ');

// เจ้าของสั่ง 2026-10-28: "ตอนนี้บังคับกรอกสถานที่ จริงๆแล้วไม่ได้บังคับ แต่ถ้าไม่กรอก จะไม่ได้
// เบี้ยเลี้ยง upcountry กับ เงินค่าเดินทางวันหยุด" และ "ถ้าทำงานที่ office ไม่ให้กรอกช่องสถานที่"
//
// **ความผิดพลาดที่ไฟล์นี้เกิดมาเพื่อไม่ให้เกิดซ้ำ (2026-10-28):** รอบแรกผมเทสต์
// `validateUpcountryLocations` แล้วสรุปว่าเซิร์ฟเวอร์ไม่บังคับสถานที่ · **ผิดตัว** — เส้นทาง
// holiday-work ถูกตรวจด้วย `validateHolidayWorkLocation` ซึ่งตอนนั้นบังคับ "ต้องมีพอดี 1 รายการ"
// ⇒ ของที่ขึ้นเว็บไปแล้วทำให้ยื่นแบบไม่กรอกสถานที่ได้ 400 · บทเรียน: หาให้ครบว่าใครตรวจ
// เส้นทางนี้บ้าง ไม่ใช่เจอตัวแรกแล้วหยุด
const SERVER_SRC = fs.readFileSync(path.join(ROOT, 'attendance-server/backend/server.js'), 'utf8');
const vctx = { HHMM_RE, LOCATION_NAME_MAX: 200, console };
vm.createContext(vctx);
vm.runInContext(extractFunction(SERVER_SRC, 'validateHolidayWorkLocation') + '\n' +
  extractFunction(SERVER_SRC, 'validateUpcountryLocations'), vctx);

test('ตัวตรวจของ holiday-work ยอมรับ "ไม่มีสถานที่" ทุกรูปแบบที่ฝั่งเว็บส่งได้', () => {
  assert.strictEqual(vctx.validateHolidayWorkLocation([]), null, '[] (ทำงานที่ออฟฟิศ) ต้องผ่าน');
  assert.strictEqual(vctx.validateHolidayWorkLocation(undefined), null, 'undefined ต้องผ่าน');
  assert.strictEqual(vctx.validateHolidayWorkLocation(null), null, 'null ต้องผ่าน');
});

test('ตัวตรวจของ holiday-work ยังปฏิเสธสถานที่ที่กรอกมาครึ่งๆ', () => {
  assert.ok(vctx.validateHolidayWorkLocation([{ name: '' }]), 'ชื่อว่างต้องถูกปฏิเสธ');
  assert.ok(vctx.validateHolidayWorkLocation([{ name: '   ' }]), 'ชื่อที่มีแต่ช่องว่างต้องถูกปฏิเสธ');
  assert.ok(vctx.validateHolidayWorkLocation([{ name: 'A' }, { name: 'B' }]), 'สองรายการต้องถูกปฏิเสธ');
  assert.ok(vctx.validateHolidayWorkLocation([{ name: 'x'.repeat(201) }]), 'ชื่อยาวเกินต้องถูกปฏิเสธ');
  assert.strictEqual(vctx.validateHolidayWorkLocation([{ name: 'NGK' }]), null, 'ชื่อจริงต้องผ่าน');
});

// ตัวตรวจของ upcountry ยังเข้มเท่าเดิม — การผ่อนของ holiday-work ต้องไม่รั่วไปหามัน
test('ตัวตรวจของ upcountry ยังไม่ยอมรับของว่าง (ไม่ถูกผ่อนตามไปด้วย)', () => {
  assert.ok(vctx.validateUpcountryLocations([]), 'upcountry ยังต้องปฏิเสธ []');
  assert.ok(vctx.validateUpcountryLocations([{ name: '' }]), "upcountry ยังต้องปฏิเสธ [{name:''}]");
  assert.strictEqual(vctx.validateUpcountryLocations(undefined), null, 'undefined ยังผ่านเหมือนเดิม');
});

// **ทั้ง POST และ PUT** — ข้อนี้เคยเขียนไว้ตรวจแต่ POST แล้วปล่อย PUT หลุดไปขึ้นเว็บจริง
// ซึ่งเป็นความผิดพลาดแบบเดียวกับที่ไฟล์นี้เขียนบทเรียนไว้ข้างบน ห่างกันไม่กี่ชั่วโมง
// ⇒ ยามนี้จึงนับว่า "ทุกที่ที่เรียกตัวตรวจของ upcountry ต้องยกเว้น holiday-work" ไม่ใช่เช็กทีละบรรทัด
test('ไม่มีที่ไหนเอาตัวตรวจของ upcountry มาตรวจ holiday-work — ทั้ง POST และ PUT', () => {
  // จับทั้งประโยคจนถึง `;` เพราะฝั่ง PUT เขียนเป็น ternary สองบรรทัด
  // 2026-10-28 (รีวิวรอบ 5): ของเดิมนับด้วย `const locErr =` คือนับ **ชื่อตัวแปร** ไม่ใช่จุดเรียก ⇒
  // มองไม่เห็นจุดที่สามที่ชื่อ `const upcountryLocErr = …` ซึ่งเป็นจุดที่ถูกเพิ่มทีหลังด้วยชื่ออื่น
  // และนั่นคือรูปแบบเดียวกับที่ทำให้จุด PUT หลุดไปตั้งแต่ต้น · ตอนนี้นับจาก **ชื่อฟังก์ชันที่ถูกเรียก**
  // แล้วไล่ดูทุกจุดว่าจุดนั้นเอื้อม holiday-work ได้หรือไม่ ⇒ จุดที่สี่ชื่ออะไรก็หลุดไม่ได้
  // ตัดคอมเมนต์บรรทัดออกก่อน ไม่งั้นจะนับประโยคที่แค่ *พูดถึง* ตัวตรวจ (มีสองแห่ง) และตัดนิยาม
  // ของฟังก์ชันเองออกด้วย · เหลือแต่จุดที่ "เรียกมันจริง"
  const SRC_NOCMT = SERVER_SRC.replace(/^[ \t]*\/\/[^\n]*$/gm, '');
  const sites = [];
  const callRe = /validateUpcountryLocations\(/g;
  let mm;
  while ((mm = callRe.exec(SRC_NOCMT)) !== null) {
    const before = SRC_NOCMT.slice(Math.max(0, mm.index - 9), mm.index);
    if (before.endsWith('function ')) continue;            // นิยาม ไม่ใช่จุดเรียก
    // เอา **ประโยคทั้งประโยค** ไม่ใช่แค่บรรทัดที่มีการเรียก: จุด PUT เขียนเงื่อนไข
    // `(updates.type || leave.type) === 'holiday-work'` ไว้บรรทัดก่อนหน้า ⇒ ถ้าตัดแค่บรรทัดเดียว
    // จะมองไม่เห็นการยกเว้น แล้วข้อนี้จะฟ้องผิดว่า PUT ไม่ยกเว้น holiday-work
    const stStart = Math.max(
      SRC_NOCMT.lastIndexOf(';', mm.index),
      SRC_NOCMT.lastIndexOf('{', mm.index),
      SRC_NOCMT.lastIndexOf('}', mm.index)) + 1;
    const end = SRC_NOCMT.indexOf(';', mm.index);
    sites.push({ idx: mm.index, stmt: SRC_NOCMT.slice(stStart, end + 1).trim() });
  }
  assert.strictEqual(sites.length, 3,
    `จำนวนจุดเรียก validateUpcountryLocations เปลี่ยนไป (เจอ ${sites.length}) ⇒ ไล่ดูทุกจุดใหม่ ` +
    'ว่าจุดใหม่ holiday-work เอื้อมถึงไหม แล้วอัปเดตข้อนี้พร้อมเหตุผล');
  // สองจุดที่ holiday-work เดินผ่านได้ (POST, PUT) ต้องยกเว้นมันที่ตัวประโยคเอง
  const exempt = sites.filter(s => /'holiday-work'/.test(s.stmt));
  assert.strictEqual(exempt.length, 2,
    'จุดที่ holiday-work เดินผ่านได้ต้องยกเว้นมันเอง — เจอ ' + exempt.length + ' จุด:\n       ' +
    sites.map(s => s.stmt.replace(/\s+/g, ' ')).join('\n       '));
  // จุดที่สาม (resolvedLocations) ไม่ต้องยกเว้น เพราะมันอยู่ใต้ `if (newType === 'upcountry')`
  // holiday-work จึงเอื้อมไม่ถึง · ถ้าวันหนึ่งกำแพงนั้นหาย ข้อนี้ต้องแดง
  const third = sites.find(s => !/'holiday-work'/.test(s.stmt));
  assert.ok(/validateUpcountryLocations\(resolvedLocations\)/.test(third.stmt),
    'จุดที่ไม่ยกเว้น holiday-work เปลี่ยนไปจากที่เคยไล่ไว้: ' + third.stmt.replace(/\s+/g, ' '));
  const guard = SRC_NOCMT.lastIndexOf("if (newType === 'upcountry')", third.idx);
  assert.ok(guard > 0 && third.idx - guard < 1200,
    'จุด resolvedLocations ไม่ได้อยู่ใต้ `if (newType === \'upcountry\')` อีกแล้ว ⇒ holiday-work ' +
    'เอื้อมถึงตัวตรวจของ upcountry ได้ ต้องยกเว้นที่จุดนั้นด้วย');
  assert.ok(/\(updates\.type \|\| leave\.type\) === 'holiday-work'/.test(SERVER_SRC),
    'PUT ต้องคำนวณชนิดเอง ไม่ใช้ newType ซึ่งประกาศอยู่ใต้จุดนั้น (TDZ)');
});

// newType ประกาศหลังจุดที่ใช้ ⇒ อ้างถึงที่นั่นจะเป็น ReferenceError ตอนรัน ซึ่ง node --check กับ
// eslint ผ่านทั้งคู่ · ข้อนี้ตรึงลำดับไว้ไม่ให้ใครเผลอ "ทำให้สั้นลง" ภายหลัง
test('PUT ไม่อ้าง newType ก่อนที่มันจะถูกประกาศ', () => {
  const useIdx = SERVER_SRC.search(/const locErr = \(updates\.type \|\| leave\.type\)/);
  const declIdx = SERVER_SRC.search(/^\s*const newType = /m);
  assert.ok(useIdx > 0 && declIdx > 0, 'หาจุดใช้/จุดประกาศไม่เจอ');
  assert.ok(useIdx < declIdx, 'จุดใช้ต้องอยู่ก่อนจุดประกาศ newType จริง (ยืนยันว่าห้ามใช้ newType ที่นั่น)');
});

test('submitHolidayWork ส่ง locations เสมอ และใช้ [] แทนการตัดคีย์ทิ้ง', () => {
  const fn = extractFunction(APP_SRC, 'submitHolidayWork');
  assert.ok(/locations: location \? \[\{ name: location \}\] : \[\],/.test(fn),
    'ต้องส่ง locations เสมอ ([] เมื่อเว้นว่าง) ไม่งั้นตอนแก้ไขจะลบสถานที่ออกไม่ได้');
  assert.ok(!/\.\.\.\(location \? \{ locations:/.test(fn),
    'ยังมีการตัดคีย์ทิ้งแบบเดิมอยู่');
});

console.log('T4 Working Report แนบเฉพาะเมื่อกรอกสถานที่');

test('เซิร์ฟเวอร์บังคับแนบเฉพาะเมื่อมีสถานที่ ทั้ง POST และ PUT', () => {
  // 2026-10-28 (รีวิวรอบ 5): ของเดิมบังคับให้มี `\n` คั่นระหว่างสองเงื่อนไข ⇒ ถ้าใครรวมเป็นบรรทัด
  // เดียว (พฤติกรรมเท่าเดิมทุกประการ) ข้อนี้จะแดง · ตอนนี้ยุบช่องว่างทั้งหมดก่อนเทียบ แล้วเทียบ
  // ที่ *ตัวเงื่อนไข* ไม่ใช่ที่การจัดบรรทัด
  const flat = SERVER_SRC.replace(/\s+/g, ' ');
  const hits = flat.match(/hasUpcountryLocation\(\{ locations: [^}]+\}\) && !\w+(?:\.attachment)?/g) || [];
  assert.strictEqual(hits.length, 2,
    `ต้องผูกกับ hasUpcountryLocation ทั้งสองเส้นทาง (POST/PUT) แต่เจอ ${hits.length}`);
  assert.ok(!/if \(!body\.attachment && !\(Number\(body\.fileCount\) > 0\)\)/.test(SERVER_SRC),
    'POST ยังบังคับแนบทุกกรณีอยู่');
  assert.ok(!/if \(!resolvedAttachment && !\(Number\(resolvedFileCount\) > 0\)\)/.test(SERVER_SRC),
    'PUT ยังบังคับแนบทุกกรณีอยู่');
});

test('ฝั่งเว็บบังคับแนบเฉพาะเมื่อกรอกสถานที่ (ตรงกับเซิร์ฟเวอร์)', () => {
  const fn = extractFunction(APP_SRC, 'submitHolidayWork');
  assert.ok(/if \(location && !attachment && !_hwStoredFile\)/.test(fn),
    'ด่านแนบไฟล์ต้องมีเงื่อนไข location');
});

// เคสที่เพิ่งเป็นไปได้เพราะสถานที่กลายเป็นช่องไม่บังคับ: ใบที่ยื่นตอนทำงานที่ออฟฟิศไม่มีไฟล์แนบเลย
// ⇒ ถ้าแก้ไขใบนั้นเพิ่มสถานที่เข้าไป เงื่อนไขเดิม `!editingLeaveId` จะปล่อยผ่าน แล้วเซิร์ฟเวอร์
// ตีกลับเป็นข้อความอังกฤษดิบ · ฝั่งเว็บต้องถามคำถามเดียวกับเซิร์ฟเวอร์ คือ "ใบนี้มีไฟล์อยู่แล้วไหม"
// ไม่ใช่ "นี่เป็นการแก้ไขหรือเปล่า"
test('ตอนแก้ไข ฝั่งเว็บดูว่าใบนั้นมีไฟล์อยู่แล้วไหม ไม่ใช่ยกเว้นเพราะเป็นการแก้ไข', () => {
  const fn = extractFunction(APP_SRC, 'submitHolidayWork');
  assert.ok(!/!attachment && !editingLeaveId/.test(fn),
    'ยังยกเว้นทุกการแก้ไขอยู่ ⇒ เพิ่มสถานที่โดยไม่มีไฟล์จะหลุดไปโดนเซิร์ฟเวอร์ปฏิเสธ');
  assert.ok(/_hwEditing[\s\S]*DATA_LEAVES\.find\(l => l\.id === editingLeaveId\)/.test(fn),
    'ต้องหาเรคอร์ดที่กำลังแก้จาก DATA_LEAVES');
  assert.ok(/_hwStoredFile = !!\(_hwEditing && \(_hwEditing\.attachment \|\| Number\(_hwEditing\.fileCount\) > 0\)\)/.test(fn),
    'ต้องเช็กทั้ง attachment และ fileCount แบบเดียวกับที่เซิร์ฟเวอร์เช็ก resolvedAttachment/resolvedFileCount');
});

test('ฟอร์ม: ดอกจันของ Working Report ซ่อนไว้ก่อน และผูกกับช่องสถานที่', () => {
  const HTML = fs.readFileSync(path.join(ROOT, 'attendance/index.html'), 'utf8');
  assert.ok(/id="hw-report-star"[^>]*display:none/.test(HTML), 'ดอกจันต้องซ่อนเป็นค่าตั้งต้น');
  const fn = extractFunction(APP_SRC, 'refreshHolidayWorkPayCompare');
  assert.ok(/hw-report-star/.test(fn) && /holiday-work-location/.test(fn),
    'ต้องมีตัวสลับดอกจันตามช่องสถานที่ในฟังก์ชันที่รันตอนพิมพ์');
  const JA = fs.readFileSync(path.join(ROOT, 'attendance/lang/ja.js'), 'utf8');
  const en = /data-en="(Required only when a work location is given[^"]*)"/.exec(HTML);
  assert.ok(en, 'ไม่พบคำอธิบายภาษาอังกฤษใต้ช่องแนบไฟล์');
  assert.ok(JA.includes(en[1]), 'คำอธิบายนี้ยังไม่มีคำแปลญี่ปุ่น');
});

test('ไม่มีการบล็อกการยื่นเมื่อสถานที่ว่างแล้ว', () => {
  const fn = extractFunction(APP_SRC, 'submitHolidayWork');
  assert.ok(!/if \(!location\)\s*\{\s*showToast/.test(fn),
    'ยังมีด่านที่ปฏิเสธการยื่นเมื่อไม่กรอกสถานที่');
});

test('ฟอร์มไม่ติดดอกจันบังคับที่ช่องสถานที่ และมีคำอธิบายครบ 3 ภาษา', () => {
  const HTML = fs.readFileSync(path.join(ROOT, 'attendance/index.html'), 'utf8');
  const JA = fs.readFileSync(path.join(ROOT, 'attendance/lang/ja.js'), 'utf8');
  const block = HTML.slice(HTML.indexOf('data-en="Location (Upcountry)"'),
    HTML.indexOf('id="holiday-work-start-time"'));
  assert.ok(block.indexOf('holiday-work-location') > 0, 'ตัดบล็อกผิดที่');
  assert.ok(!/color:#ef4444">\*<\/span><\/label>/.test(block.slice(0, block.indexOf('<input'))),
    'ยังมีดอกจันบังคับอยู่ที่ป้ายช่องสถานที่');
  const en = /data-en="(Fill this in only if you worked upcountry[^"]*)"/.exec(block);
  assert.ok(en, 'ไม่พบคำอธิบายภาษาอังกฤษใต้ช่องสถานที่');
  assert.ok(/ต่างจังหวัด/.test(block) && /ออฟฟิศ/.test(block), 'คำอธิบายภาษาไทยไม่ครบ');
  assert.ok(JA.includes(en[1]), 'คำอธิบายนี้ยังไม่มีคำแปลญี่ปุ่นใน lang/ja.js');
});

console.log(`\n${passed} passed, ${process.exitCode ? 'มีข้อที่ล้มเหลว' : '0 failed'}`);
