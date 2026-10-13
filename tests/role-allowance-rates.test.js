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
// 2026-10-13: matches a PROPERTY READ of any of the four rate keys through any object, not just
// `S.allowances.x` -- the first version of this sweep looked for the two spellings it happened to
// know and walked straight past the legend's `_legA.earlyMorning2` and the modal's `_dA.lateNight1`
// aliases. Pinning the key name instead of the holder is what makes it complete.
// `\b` after the digit keeps the local counters (lateNight2Count, early2Amount) out of it, and the
// reader's own `S.allowances[key]` is bracket form, so it is not a property read of a literal key.
const DIRECT_RATE_READ_RE = /\.(earlyMorning1|earlyMorning2|lateNight1|lateNight2)\b/;
function directRateReads(src) {
  const offenders = [];
  src.split('\n').forEach((line, i) => {
    if (line.trim().startsWith('//')) return;
    if (SETTINGS_FIELD_RE.test(line)) return;
    if (DIRECT_RATE_READ_RE.test(line)) offenders.push(`${i + 1}: ${line.trim()}`);
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

// ---- the legend and the FAQ ----
test('the legend is built after targetUser exists', () => {
  const fn = extractFunction(APP_SRC, 'renderAttendanceTable');
  const tgt = fn.indexOf('const targetUser ');
  const legend = fn.indexOf('att-legend-early');
  assert.ok(tgt > -1 && legend > -1, 'renderAttendanceTable changed shape -- re-point this test');
  assert.ok(tgt < legend, 'targetUser must be declared BEFORE the legend reads its role (TDZ: the legend used to run first, and ESLint does not catch this)');
});

test('the legend labels the table it sits above, so it uses the viewed employee\'s rate', () => {
  const fn = extractFunction(APP_SRC, 'renderAttendanceTable');
  const legend = fn.slice(fn.indexOf('att-legend-early') - 500, fn.indexOf('att-legend-late') + 700);
  assert.ok(/_elRateLegend\(|earlyLateRateFor\(\s*targetUser\.role/.test(legend),
    'the legend must use the viewed employee\'s rate');
  assert.ok(!/_legA\.(earlyMorning1|earlyMorning2|lateNight1|lateNight2)\b/.test(legend),
    'the legend still reads the company-wide amount directly');
});

test('the legend still reads thresholds (times) centrally -- only money is per role', () => {
  const fn = extractFunction(APP_SRC, 'renderAttendanceTable');
  const legend = fn.slice(fn.indexOf('att-legend-early') - 500, fn.indexOf('att-legend-late') + 700);
  assert.ok(/_legA\.earlyThreshold2Min/.test(legend), 'thresholds are company-wide and must stay so');
});

test('the FAQ answer carries the rate in all three languages', () => {
  const faq = between(APP_SRC, 'Check in at the face scanner before', '_faqNotEligibleText(\'earlyLate\')', 600);
  for (const marker of ['Check in at the face scanner', 'สแกนเข้าที่เครื่องก่อน', '顔認証端末で']) {
    assert.ok(faq.includes(marker), `the ${marker} language variant went missing -- all three ship together`);
  }
  assert.ok(!/S\.allowances\.(earlyMorning1|earlyMorning2)\b/.test(faq),
    'the FAQ still quotes the company-wide amount directly');
});

// The file-wide sweep, deferred here by the Task 3 ruling: with the legend and the FAQ routed,
// NOTHING outside the Settings page may read the four amounts directly any more.
test('nothing in app.js outside the Settings page reads an early/late amount directly', () => {
  const offenders = directRateReads(APP_SRC);
  assert.deepStrictEqual(offenders, [], `these app.js lines still read the amount directly:\n  ${offenders.join('\n  ')}`);
});

// ---- the server accepts the section, and never silently drops it ----
// Review Focus 5: the save path rebuilds current.appSettings from ALLOWED_APPSETTINGS_KEYS, so a
// section missing from that list is DELETED from disk by the next unrelated Settings save -- and
// a section in the request body but not in the list makes the whole page refuse to save, which is
// the trap the spec warns about from the morningReviewEnabled incident.
test('allowanceRoleRates is on both server allowlists', () => {
  const allow = /const ALLOWED_APPSETTINGS_KEYS = (\[[^\]]*\]);/.exec(SERVER_SRC);
  assert.ok(allow, 'ALLOWED_APPSETTINGS_KEYS not found');
  assert.ok(/'allowanceRoleRates'/.test(allow[1]),
    'without this, saving Settings once wipes the rate table off disk');
  const objList = /for \(const sub of (\[[^\]]*'allowanceEligibility'[^\]]*\])\)/.exec(SERVER_SRC);
  assert.ok(objList, 'the must-be-an-object list not found');
  assert.ok(/'allowanceRoleRates'/.test(objList[1]),
    'a client could otherwise store a scalar where every reader expects an object');
});

test('the carry-forward filter really is driven by that allowlist', () => {
  // Pins WHY the allowlist entry matters, so the entry cannot be removed as "redundant".
  assert.ok(/for \(const k of ALLOWED_APPSETTINGS_KEYS\)[\s\S]{0,200}cleanCurrentAppSettings\[k\] = current\.appSettings\[k\]/.test(SERVER_SRC),
    'the save path no longer rebuilds appSettings from the allowlist -- re-check what keeps a section on disk');
});

test('the saved shape is validated: known roles, the four keys, money in range', () => {
  const block = /if \(A\.allowanceRoleRates !== undefined\) \{[\s\S]*?\n    \}\n/.exec(SERVER_SRC);
  assert.ok(block, 'no validation block for allowanceRoleRates');
  const b = block[0];
  assert.ok(/ROLE_KEYS\.includes/.test(b), 'an unknown role must be refused');
  assert.ok(/EARLY_LATE_RATE_KEYS\.includes/.test(b), 'a key outside the four must be refused');
  assert.ok(/100000/.test(b), 'the same 0-100000 money cap as the rest of allowances');
  assert.ok(/typeof RR\.enabled !== 'boolean'/.test(b), 'enabled must be a boolean');
});

test('the rate table is NOT nested inside allowances, which demands a number from every key', () => {
  // The spec's reason: allowances' validator requires a number (or a boolean for ...Enabled) from
  // every key, so a nested object there makes EVERY Settings save fail until an exception is added.
  assert.ok(!/allowances\.allowanceRoleRates/.test(SERVER_SRC));
  assert.ok(!/allowances\.allowanceRoleRates/.test(APP_SRC));
  const defaults = /allowances: \{[\s\S]*?\n  \},/.exec(SERVER_SRC);
  assert.ok(defaults && !/byRole/.test(defaults[0]), 'allowanceRoleRates must be its own section');
});

// The validator is inline in a route handler, so run the REAL block rather than a hand-copied
// mirror of its rules: extract its text, wrap it in a function, and give it a stub res. A mirror
// would keep passing after the real rule changed.
const RR_VALIDATOR_SRC = (() => {
  const start = SERVER_SRC.indexOf('if (A.allowanceRoleRates !== undefined) {');
  assert.ok(start > -1, 'the allowanceRoleRates validation block was not found');
  let depth = 0;
  const open = SERVER_SRC.indexOf('{', start);
  for (let j = open; j < SERVER_SRC.length; j++) {
    if (SERVER_SRC[j] === '{') depth++;
    else if (SERVER_SRC[j] === '}') { depth--; if (depth === 0) return SERVER_SRC.slice(start, j + 1); }
  }
  throw new Error('unbalanced allowanceRoleRates block');
})();

function runRRValidator(payload) {
  const ctx = {
    ROLE_KEYS: ['md', 'manager', 'accounting', 'user', 'marketing', 'driver'],
    EARLY_LATE_RATE_KEYS: JSON.parse(extractKeys(SERVER_SRC).replace(/'/g, '"')),
    Object, Number, Array, JSON,
  };
  vm.createContext(ctx);
  // `res.status(400).json(x)` is the refusal path; returning it ends the handler.
  vm.runInContext(
    'this.check = function (A) {\n' +
    '  const res = { status: () => ({ json: (x) => ({ refused: true, message: x.message }) }) };\n' +
    `  ${RR_VALIDATOR_SRC}\n` +
    '  return { refused: false, normalized: A.allowanceRoleRates };\n' +
    '};', ctx);
  return ctx.check({ allowanceRoleRates: payload });
}

test('a Settings save carrying the new section is accepted and normalised', () => {
  // Compared through JSON: the validator runs in a vm realm, so an object literal it creates has
  // that realm's prototype and deepStrictEqual rejects it on identity, not on content.
  const plain = (x) => JSON.parse(JSON.stringify(x));
  const ok = runRRValidator({ enabled: false, byRole: {} });
  assert.strictEqual(ok.refused, false, ok.message);
  assert.deepStrictEqual(plain(ok.normalized), { enabled: false, byRole: {} });
  // byRole omitted entirely is filled in, so later readers never meet undefined.
  const filled = runRRValidator({ enabled: true });
  assert.strictEqual(filled.refused, false, filled.message);
  assert.deepStrictEqual(plain(filled.normalized.byRole), {});
  // a real-shaped table, with 0 accepted as a deliberate "do not pay"
  const real = runRRValidator({ enabled: true, byRole: { manager: { earlyMorning1: 1, lateNight2: 0 } } });
  assert.strictEqual(real.refused, false, real.message);
});

test('the validator refuses what would corrupt the table', () => {
  const cases = [
    [{ enabled: 'yes', byRole: {} }, 'enabled must be true or false'],
    [{ enabled: true, byRole: [] }, 'byRole must be an object'],
    [{ enabled: true, byRole: { nosuchrole: { earlyMorning1: 1 } } }, 'not a known role'],
    [{ enabled: true, byRole: { manager: { upcountry: 1 } } }, 'not an early-morning or late-night rate'],
    [{ enabled: true, byRole: { manager: { earlyMorning1: -1 } } }, 'must be a number 0-100000'],
    [{ enabled: true, byRole: { manager: { earlyMorning1: 100001 } } }, 'must be a number 0-100000'],
    [{ enabled: true, byRole: { manager: { earlyMorning1: '360' } } }, 'must be a number 0-100000'],
    [{ enabled: true, byRole: { manager: null } }, 'must be an object'],
    [{ enabled: true, byRole: {}, somethingElse: 1 }, 'accepts only enabled and byRole'],
  ];
  for (const [payload, needle] of cases) {
    const got = runRRValidator(payload);
    assert.strictEqual(got.refused, true, `should have been refused: ${JSON.stringify(payload)}`);
    assert.ok(String(got.message).includes(needle),
      `refusal for ${JSON.stringify(payload)} said "${got.message}", expected to mention "${needle}"`);
  }
});

console.log(`\n${passed} assertions passed`);
module.exports = { between, previewPassesRole };
