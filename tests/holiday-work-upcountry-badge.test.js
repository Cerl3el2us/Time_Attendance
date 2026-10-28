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

test('POST ไม่เอาตัวตรวจของ upcountry มาตรวจ holiday-work', () => {
  assert.ok(/const locErr = type === 'holiday-work' \? null : validateUpcountryLocations\(body\.locations\);/.test(SERVER_SRC),
    'ตัวตรวจรวมยังตรวจ holiday-work อยู่ ⇒ [] ของ "ทำงานที่ออฟฟิศ" จะถูกปฏิเสธ');
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
  const hits = SERVER_SRC.match(/hasUpcountryLocation\(\{ locations: [^}]+\}\)\s*&&\s*\n\s*!\w+(?:\.attachment)?/g) || [];
  assert.strictEqual(hits.length, 2, `ต้องผูกกับ hasUpcountryLocation ทั้งสองเส้นทาง แต่เจอ ${hits.length}`);
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
