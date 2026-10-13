// Per-role early-morning / late-night rates (2026-10-13, owner's decision).
//
// The rates themselves are DATA, not code: this file must never assert a real rate for a real
// role, or the owner editing a rate on the Settings page turns a test red. Everything below uses
// invented numbers and proves the mechanism.
//
// Both copies of earlyLateRateFor() are extracted from the real sources, so the dual-sync rule
// (app.js and server.js must agree about money) is proven here and not assumed.
//
// 2026-10-13 (plan pre-flight ruling): every locator in this file anchors on a distinctive STRING
// in the source, never on a line number. The tasks that follow insert lines into app.js above the
// regions being inspected, so a line-indexed slice would silently start reading the wrong code.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const APP_SRC = fs.readFileSync(path.join(ROOT, 'attendance/js/app.js'), 'utf8');
const SERVER_SRC = fs.readFileSync(path.join(ROOT, 'attendance-server/backend/server.js'), 'utf8');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok  ${name}`); }
  catch (e) { process.exitCode = 1; console.log(`  FAIL  ${name}\n        ${e.message}`); }
}

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

function extractKeys(src) {
  const m = /const EARLY_LATE_RATE_KEYS = (\[[^\]]*\]);/.exec(src);
  if (!m) throw new Error('EARLY_LATE_RATE_KEYS not found');
  return m[1];
}

// Pulls a region out of a source by two anchor strings instead of line numbers, so inserting
// lines elsewhere in the file cannot move the window off the code under test.
function between(src, startAnchor, endAnchor, pad) {
  const a = src.indexOf(startAnchor);
  assert.ok(a > -1, `anchor not found: ${startAnchor}`);
  const b = src.indexOf(endAnchor, a);
  assert.ok(b > -1, `anchor not found after ${startAnchor}: ${endAnchor}`);
  return src.slice(Math.max(0, a - (pad || 0)), b + endAnchor.length + (pad || 0));
}

function load(src) {
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(
    `const EARLY_LATE_RATE_KEYS = ${extractKeys(src)};\n${extractFunction(src, 'earlyLateRateFor')}\n` +
    'this.rate = earlyLateRateFor; this.KEYS = EARLY_LATE_RATE_KEYS;', ctx);
  return { rate: ctx.rate, KEYS: ctx.KEYS };
}

const CLIENT = load(APP_SRC);
const SERVER = load(SERVER_SRC);

// Invented amounts. Nothing here is anyone's real rate.
const CENTRAL = { earlyMorning1: 11, earlyMorning2: 22, lateNight1: 33, lateNight2: 44 };
const S = (roleRates) => ({ allowances: { ...CENTRAL }, allowanceRoleRates: roleRates });

// Every assertion runs through BOTH copies, so a drift cannot pass.
function both(role, key, settings) {
  const a = CLIENT.rate(role, key, settings);
  const b = SERVER.rate(role, key, settings);
  assert.deepStrictEqual(a, b, `app.js gave ${a} but server.js gave ${b} for ${role}/${key}`);
  return a;
}

console.log('per-role early/late rates: the switch, the fallback, and the two engines agreeing');

test('the two copies of the function are identical text', () => {
  assert.strictEqual(extractFunction(APP_SRC, 'earlyLateRateFor'), extractFunction(SERVER_SRC, 'earlyLateRateFor'));
  assert.strictEqual(extractKeys(APP_SRC), extractKeys(SERVER_SRC));
});

test('switch off: every role gets the company-wide amount', () => {
  const s = S({ enabled: false, byRole: { manager: { earlyMorning1: 999, earlyMorning2: 999, lateNight1: 999, lateNight2: 999 } } });
  for (const k of CLIENT.KEYS) {
    assert.strictEqual(both('manager', k, s), CENTRAL[k], `${k} must ignore byRole while the switch is off`);
    assert.strictEqual(both('user', k, s), CENTRAL[k]);
  }
});

test('switch on: the configured role gets its amount, everyone else the company-wide one', () => {
  const s = S({ enabled: true, byRole: { manager: { earlyMorning1: 7, earlyMorning2: 8, lateNight1: 9, lateNight2: 10 } } });
  assert.strictEqual(both('manager', 'earlyMorning1', s), 7);
  assert.strictEqual(both('manager', 'lateNight2', s), 10);
  assert.strictEqual(both('user', 'earlyMorning1', s), CENTRAL.earlyMorning1);
  assert.strictEqual(both('driver', 'lateNight2', s), CENTRAL.lateNight2);
});

// Review Focus 1: 0 means "do not pay this tier" and must survive.
test('a configured rate of 0 pays 0, it does not fall back', () => {
  const s = S({ enabled: true, byRole: { manager: { earlyMorning1: 0 } } });
  assert.strictEqual(both('manager', 'earlyMorning1', s), 0);
});

// Review Focus 2: a half-filled row must not poison the keys it does not mention.
test('a partly filled row takes the company-wide amount for its missing keys', () => {
  const s = S({ enabled: true, byRole: { manager: { earlyMorning1: 5 } } });
  assert.strictEqual(both('manager', 'earlyMorning1', s), 5);
  assert.strictEqual(both('manager', 'earlyMorning2', s), CENTRAL.earlyMorning2);
  assert.strictEqual(both('manager', 'lateNight1', s), CENTRAL.lateNight1);
  assert.strictEqual(both('manager', 'lateNight2', s), CENTRAL.lateNight2);
});

test('a broken value falls back to the company-wide amount, never to 0 or NaN', () => {
  for (const bad of [-1, NaN, Infinity, '360', null, undefined, {}, []]) {
    const s = S({ enabled: true, byRole: { manager: { earlyMorning1: bad } } });
    assert.strictEqual(both('manager', 'earlyMorning1', s), CENTRAL.earlyMorning1, `${JSON.stringify(bad)} should fall back`);
  }
});

test('a missing or malformed section falls back to the company-wide amount', () => {
  const cfgs = [undefined, null, {}, [], 'x', { enabled: true }, { enabled: true, byRole: null },
    { enabled: true, byRole: [] }, { enabled: 'yes', byRole: { manager: { earlyMorning1: 5 } } }];
  for (const cfg of cfgs) {
    assert.strictEqual(both('manager', 'earlyMorning1', S(cfg)), CENTRAL.earlyMorning1, `${JSON.stringify(cfg)} should fall back`);
  }
});

test('no role, or a key outside the four, takes the company-wide amount', () => {
  const s = S({ enabled: true, byRole: { manager: { earlyMorning1: 5 }, '': { earlyMorning1: 6 } } });
  assert.strictEqual(both(undefined, 'earlyMorning1', s), CENTRAL.earlyMorning1);
  assert.strictEqual(both('', 'earlyMorning1', s), CENTRAL.earlyMorning1);
  const s2 = { allowances: { ...CENTRAL, upcountry: 240 }, allowanceRoleRates: { enabled: true, byRole: { manager: { upcountry: 1 } } } };
  assert.strictEqual(both('manager', 'upcountry', s2), 240, 'only the four early/late keys may be overridden');
});

test('the four keys are exactly the early-morning and late-night amounts', () => {
  assert.deepStrictEqual([...CLIENT.KEYS].sort(), ['earlyMorning1', 'earlyMorning2', 'lateNight1', 'lateNight2']);
});

test('both files ship the section switched off with no role configured', () => {
  for (const [label, src] of [['app.js', APP_SRC], ['server.js', SERVER_SRC]]) {
    const m = /allowanceRoleRates:\s*\{\s*enabled:\s*(true|false),\s*byRole:\s*\{\s*\}\s*\}/.exec(src);
    assert.ok(m, `${label} must default allowanceRoleRates to { enabled: <bool>, byRole: {} }`);
    assert.strictEqual(m[1], 'false', `${label} must ship the switch OFF`);
  }
});

test('no role rate is hardcoded anywhere in either source', () => {
  for (const [label, src] of [['app.js', APP_SRC], ['server.js', SERVER_SRC]]) {
    assert.ok(!/byRole:\s*\{\s*[^}\s]/.test(src), `${label} ships a non-empty byRole -- rates are data, not code`);
  }
});

// ---- the payer: server.js must not read the four amounts directly any more ----
// A read that bypasses earlyLateRateFor() is the failure the spec calls most likely: it pays the
// company-wide rate while the web shows the role rate, and no test would otherwise notice.
// Dot notation only -- earlyLateRateFor's own `S.allowances[key]` is the one legitimate read.
test('server.js payroll reads no early/late amount directly', () => {
  const offenders = [];
  SERVER_SRC.split('\n').forEach((line, i) => {
    if (line.trim().startsWith('//')) return;
    if (/S\.allowances\.(earlyMorning1|earlyMorning2|lateNight1|lateNight2)\b/.test(line)) {
      offenders.push(`${i + 1}: ${line.trim()}`);
    }
  });
  assert.deepStrictEqual(offenders, [], `these server.js lines still read the amount directly instead of calling earlyLateRateFor():\n  ${offenders.join('\n  ')}`);
});

// Review Focus 3: a rate row must never become permission to be paid.
test('a rate row for an ineligible role is not a licence to pay', () => {
  // accounting is absent from allowanceEligibility.earlyLate, so the eligibility gate -- which is
  // a different function and runs first -- must still refuse. earlyLateRateFor() answers only
  // "how much", and is allowed to return a number for a role that will never be asked about.
  const s = S({ enabled: true, byRole: { accounting: { earlyMorning1: 5 } } });
  assert.strictEqual(both('accounting', 'earlyMorning1', s), 5, 'the reader answers how much, nothing else');
  const eligSrc = extractFunction(SERVER_SRC, 'isAllowanceEligible');
  assert.ok(!/allowanceRoleRates/.test(eligSrc), 'eligibility must not consult the rate table');
});

test('server payroll takes the rate for the employee being paid, not a global', () => {
  // computePayroll receives `user`; the rate helper it builds must close over user.role, or an
  // admin running payroll would pay everyone at the admin's rate.
  const fn = extractFunction(SERVER_SRC, 'computePayroll');
  assert.ok(/earlyLateRateFor\(\s*user\.role/.test(fn),
    'server computePayroll must resolve rates against user.role');
});

// ---- the web engine ----
// The Settings page legitimately reads and writes the COMPANY-WIDE amounts: those are the values
// the role table overrides, not a bypass of it. Pre-flight ruling 2026-10-13: identify those
// lines by the `set-*-amt` field id they carry, not by a line range -- this task and Task 7 both
// insert lines into app.js, and a range would drift off the code it means to exempt.
const SETTINGS_FIELD_RE = /set-(early|late)[12]-amt/;
function directRateReads(src) {
  const offenders = [];
  src.split('\n').forEach((line, i) => {
    if (line.trim().startsWith('//')) return;
    if (SETTINGS_FIELD_RE.test(line)) return;
    if (/(S|APP_SETTINGS)\.allowances\.(earlyMorning1|earlyMorning2|lateNight1|lateNight2)\b/.test(line)) {
      offenders.push(`${i + 1}: ${line.trim()}`);
    }
  });
  return offenders;
}

// 2026-10-13 (ruling): scoped to the two money regions this task owns. The file-wide version of
// this sweep lands with the last app.js routing task, because until then the display and FAQ
// lines legitimately still read the company-wide amount and a file-wide assertion here would be
// a test that is expected to fail -- which teaches the executor to ignore red.
test('app.js payroll and the payslip lines read no early/late amount directly', () => {
  const regions = [
    ['computePayroll', extractFunction(APP_SRC, 'computePayroll')],
    ['payslip calc lines', between(APP_SRC, 'Allowance 2 (Early Morning, before', 'Allowance 2 (Late Night):', 400)],
  ];
  for (const [label, src] of regions) {
    const offenders = directRateReads(src);
    assert.deepStrictEqual(offenders, [], `${label} still reads the amount directly:\n  ${offenders.join('\n  ')}`);
  }
});

test('the Settings page is still allowed to read the company-wide amounts', () => {
  // Guards the exemption above: if these inputs ever stop reading `allowances`, the Settings page
  // has been rewired and the exemption is hiding something.
  const count = APP_SRC.split('\n').filter(l => SETTINGS_FIELD_RE.test(l) && /allowances\./.test(l)).length;
  assert.ok(count >= 8, `expected the 8 Settings read/save lines to keep using allowances, found ${count}`);
});

test('app computePayroll resolves rates against the employee being paid', () => {
  const fn = extractFunction(APP_SRC, 'computePayroll');
  assert.ok(/earlyLateRateFor\(\s*user\.role/.test(fn),
    'app computePayroll must resolve rates against user.role, not the signed-in viewer');
});

test('computePayroll reports the rate it used, so the payslip cannot print a different one', () => {
  const fn = extractFunction(APP_SRC, 'computePayroll');
  for (const f of ['early1Rate', 'early2Rate', 'lateNight1Rate', 'lateNight2Rate']) {
    assert.ok(new RegExp(`\\b${f}\\b`).test(fn), `computePayroll must return ${f}`);
  }
});

test('the payslip calculation lines print the engine\'s rate, not a fresh lookup', () => {
  const calc = between(APP_SRC, 'Allowance 2 (Early Morning, before', 'Allowance 2 (Late Night)', 200);
  for (const f of ['early2Rate', 'early1Rate', 'lateNight2Rate', 'lateNight1Rate']) {
    assert.ok(calc.includes(f) || APP_SRC.includes(`c.${f}`), `the payslip lines must use ${f}`);
  }
});

test('an old payroll snapshot still prints the figure it was paid', () => {
  // Snapshots are immutable (project rule). One computed before this change carries no *Rate
  // field, so the payslip line must derive the rate from the stored amount and count instead of
  // printing undefined.
  const calc = between(APP_SRC, 'Allowance 2 (Early Morning, before', 'Allowance 2 (Late Night):', 400);
  assert.ok(/!=\s*null\s*\?/.test(calc) || /\?\?/.test(calc),
    'the payslip rate must fall back for a snapshot that predates the *Rate fields');
});

// ---- what people see ----
// Review Focus 1 again, at the display sites: seven of these lines were written `(x || 480)`, and
// keeping the `||` after routing them re-breaks the one value that means "stop paying".
test('no rate is wrapped in || default anywhere', () => {
  const offenders = [];
  APP_SRC.split('\n').forEach((line, i) => {
    if (/earlyLateRateFor\([^)]*\)\s*\|\|/.test(line)) offenders.push(`${i + 1}: ${line.trim()}`);
    if (/(earlyMorningAllowanceForTier|lateOutAllowanceForHour)\([^)]*\)\s*\|\|/.test(line)) offenders.push(`${i + 1}: ${line.trim()}`);
  });
  assert.deepStrictEqual(offenders, [], `a rate must never be wrapped in "|| default" -- 0 is a legal rate:\n  ${offenders.join('\n  ')}`);
});

test('the self-service helpers take an optional role and default to the signed-in user', () => {
  assert.ok(/function earlyMorningAllowanceForTier\(tier, role\)/.test(APP_SRC),
    'earlyMorningAllowanceForTier must accept a role');
  assert.ok(/function lateOutAllowanceForHour\(hour, role\)/.test(APP_SRC),
    'lateOutAllowanceForHour must accept a role');
});

// 2026-10-13: this started out asserting a helper that read currentUser.role directly. The
// project's superadmin-reach guard rejected it, correctly: a superadmin previewing as Manager
// would have been quoted the superadmin account's rate. The requirement is effectiveRole().
test('the self-service default is effectiveRole(), not the account\'s own role', () => {
  for (const name of ['earlyMorningAllowanceForTier', 'lateOutAllowanceForHour']) {
    const fn = extractFunction(APP_SRC, name);
    assert.ok(/role === undefined \? effectiveRole\(\)/.test(fn),
      `${name} must default to effectiveRole() so a previewed role is quoted its own rate`);
    assert.ok(!/currentUser\s*&&\s*currentUser\.role/.test(fn),
      `${name} must not read the raw account role`);
  }
  assert.ok(!/function selfRateRole\(/.test(APP_SRC),
    'selfRateRole was removed in favour of effectiveRole() -- do not reintroduce a second answer');
});

test('the self-service default survives a pre-login render', () => {
  // effectiveRole() is the default, and it must not throw when nobody is signed in.
  const fns = ['loggedInUser', 'isSuperAdmin', 'isImpersonatingPerson', 'effectiveRole']
    .map(n => extractFunction(APP_SRC, n)).join('\n');
  const ctx = { currentUser: null, realUser: null, previewRole: '', previewUserId: 0 };
  vm.createContext(ctx);
  vm.runInContext(`${fns}\nthis.out = effectiveRole();`, ctx);
  assert.strictEqual(ctx.out, 'user', 'pre-login effectiveRole() must answer, not throw');
});

// Review Focus 4: an admin must see the row owner's rate, not their own.
test('the attendance table badges use the viewed employee\'s rate', () => {
  const table = between(APP_SRC, 'const _ATallowances = APP_SETTINGS.allowances;', 'deviceScanQualifiesForLateNight(row, _lnHwDates)', 1200);
  assert.ok(/_elRateTarget\(/.test(table) || /earlyLateRateFor\(\s*targetUser\.role/.test(table),
    'renderAttendanceTable badges must take the rate for targetUser.role');
  assert.ok(!/earlyLateRateFor\(\s*(currentUser|selfRateRole\(\))/.test(table),
    'renderAttendanceTable must not use the viewer\'s role');
  const offenders = directRateReads(table);
  assert.deepStrictEqual(offenders, [], `the table still reads the amount directly:\n  ${offenders.join('\n  ')}`);
});

test('the attendance detail modal uses the viewed employee\'s rate', () => {
  const modal = between(APP_SRC, "const _dA = APP_SETTINGS.allowances || {};", 'buildCheckoutReviewHtml(row, targetUserObj, false)', 400);
  assert.ok(/earlyLateRateFor\(\s*targetRole/.test(modal) || /_elRateTarget\(/.test(modal),
    'the attendance detail modal must take the rate for targetRole');
  assert.ok(!/_dA\.(earlyMorning1|earlyMorning2|lateNight1|lateNight2)/.test(modal),
    'the modal still reads the company-wide amount directly');
});

test('the request detail shows the requester\'s rate, not the approver\'s', () => {
  const req = between(APP_SRC, "} else if (l.type === 'early-morning') {", "} else if (l.type === 'long-distance') {", 0);
  assert.ok(/earlyLateRateFor\(/.test(req), 'the early-morning request detail must use the reader');
  assert.ok(/l\.userId/.test(req), 'it must resolve the role from the record owner (l.userId)');
  assert.ok(!/APP_SETTINGS\.allowances\.(earlyMorning1|earlyMorning2)/.test(req),
    'the request detail still reads the company-wide amount directly');
});

// 2026-10-13: found while fixing the day-pay-preview sandbox. estimateDayEarnings() is the pay
// preview inside a request form, and `user` there may be someone an admin is filing on behalf of
// (the function already carries a comment about exactly this trap for isApprovedAbroadDate).
// Both allowance lines must therefore pass that employee's role, not fall back to the viewer.
function previewPassesRole(src) {
  const fn = (() => {
    const re = /^function estimateDayEarnings\(/m;
    const m = re.exec(src);
    if (!m) throw new Error('estimateDayEarnings not found');
    const i = src.indexOf('{', m.index);
    let depth = 0;
    for (let j = i; j < src.length; j++) {
      if (src[j] === '{') depth++;
      else if (src[j] === '}') { depth--; if (depth === 0) return src.slice(m.index, j + 1); }
    }
    throw new Error('unbalanced estimateDayEarnings');
  })();
  return {
    early: /earlyMorningAllowanceForTier\(tier,\s*role\)/.test(fn),
    late: /lateOutAllowanceForHour\(Number\(o\.lateOutHour\),\s*role\)/.test(fn),
  };
}

test('the in-form pay preview quotes the form employee\'s rate, not the viewer\'s', () => {
  const got = previewPassesRole(APP_SRC);
  assert.ok(got.early, 'the early-morning preview line must pass the form employee\'s role');
  assert.ok(got.late, 'the late-night preview line must pass the form employee\'s role');
});

console.log(`\n${passed} assertions passed`);
module.exports = { between, previewPassesRole };
