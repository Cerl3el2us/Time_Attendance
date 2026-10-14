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
test('server.js names the four amounts nowhere outside their declaration and defaults', () => {
  const offenders = strayRateKeyNames(SERVER_SRC);
  assert.deepStrictEqual(offenders, [], `these server.js lines reach for an early/late amount by name instead of going through earlyLateRateFor():\n  ${offenders.join('\n  ')}`);
});

test('the sweep itself catches the shapes a review got past the old one', () => {
  // Guards the guard. Each sample is a real bypass that the previous line-regex sweep missed.
  const samples = [
    "x = S.allowances['earlyMorning1'];",
    'x = S.allowances[`lateNight2`];',
    'const { earlyMorning1, lateNight2 } = S.allowances;',
    'const { earlyMorning1: a } = S.allowances;',
    'x = appSettings.allowances.earlyMorning2;',
    'x = raw.allowances?.["lateNight1"];',
    "x = Object.entries(S.allowances).find(([k]) => k === 'lateNight1')[1];",
    'inp(\'set-early1-amt\', s.allowances.earlyMorning1);',
  ];
  for (const line of samples) {
    assert.ok(strayRateKeyNames(line).length > 0, `the sweep does not catch: ${line}`);
  }
  // and it must not fire on the legitimate forms
  for (const ok of [
    "x = earlyLateRateFor(role, 'earlyMorning2', S);",
    'x = S.allowances[EARLY_LATE_RATE_KEYS[i]];',
    '// earlyMorning1 mentioned only in prose',
    "const EARLY_LATE_RATE_KEYS = ['earlyMorning1', 'earlyMorning2', 'lateNight1', 'lateNight2'];",
  ]) {
    assert.deepStrictEqual(strayRateKeyNames(ok), [], `false positive on: ${ok}`);
  }
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
// 2026-10-13 (test-quality review): the sweep below used to be a line regex for ONE spelling of
// one holder (`S.allowances.earlyMorning1`). A review demonstrated ten ways past it -- bracket
// notation in any quote style, a template-literal or computed or variable key, plain and renamed
// destructuring, optional chaining, an Object.entries scan, a read split across two lines, and
// (server-side) any holder name other than the literal `S`. Patching the regex would just invite
// an eleventh. So the invariant is now absolute and holder-agnostic:
//
//   after comments and string/template literals are removed, THE FOUR KEY NAMES MUST NOT APPEAR
//   ANYWHERE in either source, except in their own EARLY_LATE_RATE_KEYS declaration and in the
//   `allowances:` defaults block (where they are property definitions, not reads).
//
// Every read therefore has to go through earlyLateRateFor() or index EARLY_LATE_RATE_KEYS, which
// is exactly the thing being enforced. The Settings page's legitimate reads of the company-wide
// amounts were converted to that bracket form (centralEarlyLateRate / SETTINGS_EARLY_LATE_FIELDS)
// for the same reason: a name-based exemption is a hole, so there are no exemptions.
// Blanks out // comments, /* */ comments, '...', "..." and `...` so that a key name mentioned in
// prose or passed as a string argument is not mistaken for a property read.
function stripCommentsAndStrings(src, opts) {
  const keepStrings = !!(opts && opts.keepStrings);
  let out = '';
  let i = 0;
  while (i < src.length) {
    const two = src.slice(i, i + 2);
    if (two === '//') { const n = src.indexOf('\n', i); const end = n < 0 ? src.length : n; out += ' '.repeat(end - i); i = end; continue; }
    if (two === '/*') { const n = src.indexOf('*/', i + 2); const end = n < 0 ? src.length : n + 2; out += src.slice(i, end).replace(/[^\n]/g, ' '); i = end; continue; }
    const c = src[i];
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < src.length) {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === c) { j++; break; }
        if (c !== '`' && src[j] === '\n') break; // unterminated: a regex or division, bail out
        j++;
      }
      out += keepStrings ? src.slice(i, j) : src.slice(i, j).replace(/[^\n]/g, ' ');
      i = j;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}
// The one place each source is allowed to spell the four names: their own declaration, and the
// `allowances:` defaults object where they are property definitions rather than reads.
function stripLegitimateDeclarations(src) {
  let s = src.replace(/const EARLY_LATE_RATE_KEYS = \[[^\]]*\];/g, m => ' '.repeat(m.length));
  s = s.replace(/allowances: \{[\s\S]*?\n  \},/g, m => m.replace(/[^\n]/g, ' '));
  return s;
}
// Two passes, because a key name inside quotes means opposite things in the two places it can
// appear: `x[`'earlyMorning1'`]` is a READ of the amount, while
// `earlyLateRateFor(role, 'earlyMorning1', S)` is the legitimate way to ask for it. So bracket
// subscripts are matched BEFORE strings are blanked out, and everything else after.
//
// Known limit, stated rather than papered over: a key assembled at runtime
// (`allowances[`earlyMorning${tier}`]`) contains no complete key name and no textual rule can see
// it. That shape is covered instead by tests/payroll-rules.test.js, which runs both engines with
// the table SWITCHED ON and asserts the override amount -- any engine that reaches the
// company-wide amount by any means answers the central number there and goes red.
function strayRateKeyNames(src) {
  // Built per call: a shared /g/ regex carries lastIndex between calls, and a const declared here
  // would be in its temporal dead zone for the tests that run above this point in the file.
  const bareName = /\b(earlyMorning[12]|lateNight[12])\b/;
  // A quoted key name is legitimate ONLY in argument position -- `earlyLateRateFor(role,
  // 'lateNight2', S)` or `_elRateTarget('earlyMorning1')` -- so the test is what comes before the
  // opening quote. `(` or `,` means "being passed to the reader"; anything else (`[`, `===`, `:`)
  // means the code is reaching for the amount itself. `?` and `:` are allowed too, for a ternary
  // sitting in argument position (`earlyLateRateFor(r, t === 2 ? 'lateNight2' : 'lateNight1', S)`);
  // a quoted OBJECT KEY cannot hide behind that, because there the quote comes before the colon.
  const quotedNotArgument = /(^|[^(,?:\s])\s*(['"`])(earlyMorning[12]|lateNight[12])\2/;
  const original = src.split('\n');
  const noComments = stripLegitimateDeclarations(stripCommentsAndStrings(src, { keepStrings: true }));
  const noStrings = stripLegitimateDeclarations(stripCommentsAndStrings(src));
  const hits = [];
  const n = Math.max(noComments.split('\n').length, noStrings.split('\n').length);
  const a = noComments.split('\n'), b = noStrings.split('\n');
  for (let i = 0; i < n; i++) {
    if (quotedNotArgument.test(a[i] || '') || bareName.test(b[i] || '')) {
      hits.push(`${i + 1}: ${(original[i] || '').trim()}`);
    }
  }
  return hits;
}

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

test('the Settings page still reads and writes the four company-wide amounts', () => {
  // The sweep has no name-based exemption, so the Settings page reaches the company-wide amounts
  // by POSITION. This proves it still reaches all four of them in both directions -- otherwise an
  // accidental deletion would read as "sweep clean" rather than "a Settings field stopped working".
  const fields = /const SETTINGS_EARLY_LATE_FIELDS = \{([^}]*)\}/.exec(APP_SRC);
  assert.ok(fields, 'SETTINGS_EARLY_LATE_FIELDS not found');
  for (const id of ['set-early1-amt', 'set-early2-amt', 'set-late1-amt', 'set-late2-amt']) {
    assert.ok(fields[1].includes(id), `${id} is not mapped to a rate position`);
  }
  for (let i = 0; i < 4; i++) {
    assert.ok(APP_SRC.includes(`centralEarlyLateRate(s, ${i})`), `the Settings form does not render rate position ${i}`);
  }
  assert.ok(/APP_SETTINGS\.allowances\[EARLY_LATE_RATE_KEYS\[i\]\] = fi\(fieldId\)/.test(APP_SRC),
    'the Settings save no longer writes the four amounts through the field map');
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
  // 2026-10-13 (test-quality review): this had a `|| APP_SRC.includes('c.' + f)` disjunct, a
  // file-wide substring search that a COMMENT satisfied. Scoped to the four calc lines only.
  // Window = the four calc lines exactly: from the _slipRate helper they all use, to the legacy
  // blended line that follows them.
  const calc = between(APP_SRC, 'const _slipRate =', '_legacyA2Count', 0);
  for (const f of ['early2Rate', 'early1Rate', 'lateNight2Rate', 'lateNight1Rate']) {
    assert.ok(calc.includes(f), `the payslip lines must print ${f}, the rate the engine actually used`);
  }
});

test('an old payroll snapshot still prints the figure it was paid', () => {
  // Snapshots are immutable (project rule). One computed before this change carries no *Rate
  // field, so the payslip line must derive the rate from the stored amount and count instead of
  // printing undefined. Run the real _slipRate rather than grepping for `!= null ?` in a window:
  // that window already contains an unrelated pre-existing `earlyThreshold2Min != null ?`, so the
  // old assertion could never fail (test-quality review 2026-10-13).
  const ctx = { Number };
  vm.createContext(ctx);
  vm.runInContext(`${/const _slipRate = [^;]+;/.exec(APP_SRC)[0]}\nthis.f = _slipRate;`, ctx);
  assert.strictEqual(ctx.f(360, 720, 2), 360, 'a stored rate is printed as-is');
  assert.strictEqual(ctx.f(0, 0, 2), 0, 'a deliberate 0 rate is printed as 0, not re-derived');
  assert.strictEqual(ctx.f(undefined, 720, 3), 240, 'a pre-change snapshot derives the rate it was paid');
  assert.strictEqual(ctx.f(undefined, 0, 0), 0, 'no days: no division by zero');
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

// 2026-10-13 (test-quality review): the old version of this test asserted that three language
// marker strings still existed and that one spelling was absent. It never asserted that a RATE
// APPEARS AT ALL -- deleting the amounts from all three answers, or hardcoding them, left it
// green. This runs the real _faqRulesItems() in each language with sentinel rates and reads the
// answer it produces.
function faqEarlyAnswer(lang, em1, em2) {
  const ctx = {
    currentLang: lang,
    APP_SETTINGS: {
      // Every numeric allowance the other FAQ answers interpolate. The four early/late AMOUNTS are
      // deliberately absent: the FAQ must get those from earlyMorningAllowanceForTier /
      // lateOutAllowanceForHour (stubbed with sentinels below), never from here.
      allowances: {
        earlyThreshold1Min: 450, earlyThreshold2Min: 390, lateNightThreshold1Hour: 19, lateNightThreshold2Hour: 20,
        upcountry: 240, holidayTransport: 500, diligence: 200, longDistance: 150,
        longDistanceThresholdKm: 250, personalCar: 1000, phone: 1000, abroad: 1100,
      },
      lateDeductPolicy: { tiers: [{ fromMin: 1, toMin: 10, deductMin: 10 }, { fromMin: 11, toMin: 20, deductMin: 20 }] },
      workSchedule: { standardStartHour: 8, standardStartMinute: 30 },
      allowanceEligibility: {},
      sso: { rate: 5, minSalary: 1650, maxSalary: 17500, maxAmount: 875 },
      tax: { personalAllowanceAnnual: 60000, brackets: [{ upTo: 150000, rate: 0 }] },
      leave: { carryForwardMax: 5, carryForwardExpiryEnabled: true, carryForwardExpiryMonth: 3, carryForwardExpiryDay: 31, annualLeaveMinMonths: 6, annualLeaveTiers: [{ afterMonths: 0, days: 6 }], sickLeaveDays: 30, businessLeaveDays: 3 },
      payroll: { periodStartDay: 21 },
      geofence: { enabled: true, radiusM: 150 },
      company: { name: 'X' },
    },
    ROLE_KEYS: ['md', 'manager', 'accounting', 'user', 'marketing', 'driver'],
    isAllowanceEligible: () => true,
    // Sentinels: whatever the FAQ prints for the early-morning tiers must come from here.
    earlyMorningAllowanceForTier: (tier) => (tier === 2 ? em2 : em1),
    lateOutThresholdHour: (tier) => (tier === 2 ? 20 : 19),
    lateOutAllowanceForHour: (h) => (h >= 20 ? 8888 : 7777),
    L: (en, th) => (lang === 'th' ? th : en),
    Object, Array, Number, Math, String, JSON,
  };
  // _faqRulesItems() builds the WHOLE FAQ list, so it reaches for a dozen helpers belonging to
  // other answers (leave quotas, carry-forward text, late deductions). Rather than stub each one
  // and have this test break whenever an unrelated FAQ entry is added, any identifier not named
  // above resolves to a harmless empty-string function. Everything the assertions depend on --
  // the rates, the thresholds, L() and currentLang -- IS named above, so nothing under test is
  // being faked away.
  const sandbox = new Proxy(ctx, {
    has: () => true,
    // Returns [] rather than '': an array has .map/.join/.length for the helpers that chain off
    // them, and still interpolates into a template as the empty string.
    get: (t, k) => (k in t ? t[k] : (typeof k === 'symbol' ? undefined : () => [])),
  });
  vm.createContext(sandbox);
  vm.runInContext(
    ['minsToTime', 'officeOtStdStartHHMM', '_faq', '_faqEligibleRoles', '_faqNotEligibleText', '_faqRulesItems']
      .map(n => extractFunction(APP_SRC, n)).join('\n') + '\n' +
    `const _faqRoleLabel = ${/const _faqRoleLabel = (\{[\s\S]*?\});/.exec(APP_SRC)[1]};\n` +
    'this.items = _faqRulesItems();', sandbox);
  const early = ctx.items.find(it => /Early Morning|มาเช้า|早朝|face scanner|顔認証|สแกนเข้า/.test(String(it.a)) && /🌅|face scanner|顔認証|สแกนเข้า/.test(String(it.a)));
  assert.ok(early, `no early-morning FAQ answer found for lang=${lang}`);
  return String(early.a);
}

test('the FAQ quotes the reader\'s own early-morning rate, in each of the three languages', () => {
  for (const lang of ['en', 'th', 'ja']) {
    const a = faqEarlyAnswer(lang, 1234, 5678);
    assert.ok(a.includes('1234'), `lang=${lang}: the x1 rate is missing from the FAQ answer: ${a.slice(0, 160)}`);
    assert.ok(a.includes('5678'), `lang=${lang}: the x2 rate is missing from the FAQ answer: ${a.slice(0, 160)}`);
  }
});

test('the FAQ\'s three early-morning answers are genuinely different text', () => {
  // Guards against one language variant being deleted and another silently standing in for it.
  const [en, th, ja] = ['en', 'th', 'ja'].map(l => faqEarlyAnswer(l, 1234, 5678));
  assert.notStrictEqual(en, th);
  assert.notStrictEqual(th, ja);
  assert.notStrictEqual(en, ja);
  assert.ok(/[฀-๿]/.test(th), 'the Thai answer contains no Thai');
  assert.ok(/[぀-ヿ一-龯]/.test(ja), 'the Japanese answer contains no Japanese');
});

// The file-wide sweep, deferred here by the Task 3 ruling: with the legend and the FAQ routed,
// NOTHING outside the Settings page may read the four amounts directly any more.
test('app.js names the four amounts nowhere outside their declaration and defaults', () => {
  const offenders = strayRateKeyNames(APP_SRC);
  assert.deepStrictEqual(offenders, [], `these app.js lines reach for an early/late amount by name instead of going through earlyLateRateFor() or EARLY_LATE_RATE_KEYS:\n  ${offenders.join('\n  ')}`);
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
    // 2026-10-13 (test-quality review): ROLE_KEYS used to be retyped here. A review removed
    // 'manager' from the real list -- which would 400 every manager row, the one role this feature
    // was built for -- and this harness stayed green. Both lists now come from the real source.
    ROLE_KEYS: JSON.parse(/const ROLE_KEYS = (\[[^\]]*\]);/.exec(SERVER_SRC)[1].replace(/'/g, '"')),
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

// ---- the Settings page ----
const JA_SRC = fs.readFileSync(path.join(ROOT, 'attendance/lang/ja.js'), 'utf8');

// 2026-10-14: the ROWS now come from what is actually overridden (the table is exceptions only).
// It is the ADD PICKER that must follow live eligibility, so granting a role the allowance later
// makes it offerable without anyone editing this file.
test('the add picker comes from live eligibility, never a hardcoded role list', () => {
  assert.ok(/_roleRateRoles/.test(APP_SRC), 'no per-role rate table in the Settings page');
  const seg = extractFunction(APP_SRC, 'roleRateRolesFrom');
  assert.ok(/allowanceEligibility/.test(seg),
    'the addable roles must be derived from allowanceEligibility.earlyLate');
  // Scoped to the rate table and its row source. A file-wide scan catches unrelated legitimate
  // defaults such as DEFAULT_ALLOWANCE_ELIGIBILITY.abroad, which are not this feature's business.
  const rowSource = extractFunction(APP_SRC, 'roleRateRolesFrom') + extractFunction(APP_SRC, 'renderRoleRateTable');
  assert.ok(!/\[\s*'(md|manager|accounting|user|marketing|driver)'/.test(rowSource),
    'the rate table must not hardcode a role list -- it follows allowanceEligibility.earlyLate');
});

test('the switch and every cell round-trip through the save path', () => {
  assert.ok(/APP_SETTINGS\.allowanceRoleRates\s*=/.test(APP_SRC), 'the save path must write the section');
  assert.ok(/set-rolerate-enabled/.test(APP_SRC), 'the on/off switch field is missing');
  const save = between(APP_SRC, 'set-rolerate-enabled', 'APP_SETTINGS.allowanceRoleRates =', 2500);
  assert.ok(/EARLY_LATE_RATE_KEYS/.test(save), 'the save loop must cover all four keys');
});

// The blank-vs-zero rule and the carry-forward of hidden rows were asserted here by grepping the
// save block's source. Both are now proven by running the real readRoleRateTableFromForm()
// against a fake DOM further down ("the form reader keeps blanks out, keeps 0 in, and carries
// forward hidden rows"), so the source-grep versions were deleted rather than re-anchored: they
// could pass while the code did the wrong thing, and they broke on a rename that changed nothing.

test('toggling the switch does not re-render the page and discard unsaved edits', () => {
  assert.ok(!/onchange="renderSettingsPage\(\)"[^>]*set-rolerate-enabled|set-rolerate-enabled[^>]*onchange="renderSettingsPage\(\)"/.test(APP_SRC),
    'the switch must not re-render the whole Settings page -- other fields may hold unsaved edits');
  assert.ok(/function onRoleRateToggle\(/.test(APP_SRC), 'the switch needs its own handler');
});

// 2026-10-13 (test-quality review): this used to assert the absence of the literals 360/240/480,
// which protects nothing the day the owner's rate becomes 500 -- and wrote a real rate into a test
// file. It now requires every rate cell's `value=` to be interpolated from the stored table, which
// is the actual rule: no amount ships in the markup, whatever the amount happens to be.
test('no amount is baked into the rate table markup', () => {
  assert.ok(!/byRole:\s*\{\s*[^}\s]/.test(APP_SRC), 'a non-empty byRole ships in the source');
  const fn = extractFunction(APP_SRC, 'renderRoleRateTable');
  for (const m of fn.matchAll(/value="([^"]*)"/g)) {
    assert.ok(/^\$\{/.test(m[1]), `a rate cell ships a literal value="${m[1]}" instead of the stored one`);
  }
});

// A real render, not a grep: runs renderRoleRateTable() -- a pure string function -- and reads the
// HTML it produces. This is the shape the review asked the display-group tests to take.
function renderTable(settings) {
  const ctx = {
    L: (en) => en, currentLang: 'en',
    escapeHtml: (s) => String(s == null ? '' : s),
    escapeJsAttr: (s) => String(s == null ? '' : s),
    Number, Object, Array, String, Set,
  };
  vm.createContext(ctx);
  vm.runInContext(
    `const EARLY_LATE_RATE_KEYS = ${extractKeys(APP_SRC)};\n` +
    // `_roleRateAdded` holds rows the owner added but has not saved yet; a fresh render starts empty.
    'let _roleRateAdded = [];\n' +
    ['roleRateRolesFrom', 'roleRateShownRoles', 'renderRoleRateTable']
      .map(n => extractFunction(APP_SRC, n)).join('\n') + '\n' +
    `this.html = renderRoleRateTable(${JSON.stringify(settings)});`, ctx);
  return ctx.html;
}

// ---- 2026-10-14: the table lists EXCEPTIONS, not every eligible role ----
// The owner enabled this for the first time and typed a value into every cell, because a table
// listing every eligible role reads as "fill these in". That cut staff's x2 tier in half until it
// was caught. Their own words: the central boxes above already cover everyone, so a row per role
// is redundant. The table now holds only the roles that actually differ from the company-wide
// amount; a role with no row simply uses the amount above, and says so in the help line.
test('the table lists only roles that actually override, not every eligible role', () => {
  const html = renderTable({
    allowances: { earlyMorning1: 11, earlyMorning2: 22, lateNight1: 33, lateNight2: 44 },
    allowanceEligibility: { earlyLate: ['manager', 'user'] },
    allowanceRoleRates: { enabled: true, byRole: { manager: { earlyMorning1: 7 } } },
  });
  assert.ok(/set-rolerate-manager-/.test(html), 'the overriding role must have a row');
  assert.ok(!/set-rolerate-user-/.test(html),
    'a role with no override must NOT get an empty row to type into -- that is what caused the pay cut');
  assert.ok(/ยอดกลาง|company-wide/.test(html),
    'the table must say that roles not listed use the company-wide amount');
});

test('a role can be added to, and removed from, the exceptions', () => {
  const html = renderTable({
    allowances: { earlyMorning1: 11, earlyMorning2: 22, lateNight1: 33, lateNight2: 44 },
    allowanceEligibility: { earlyLate: ['manager', 'user'] },
    allowanceRoleRates: { enabled: true, byRole: { manager: { earlyMorning1: 7 } } },
  });
  assert.ok(/id="set-rolerate-add"/.test(html), 'there must be a picker for adding a role');
  assert.ok(/<option value="user"/.test(html), 'an eligible role with no row must be offered in the picker');
  assert.ok(!/<option value="manager"/.test(html), 'a role already listed must not be offered again');
  assert.ok(/onRoleRateAdd\(\)/.test(html) && /onRoleRateRemove\('manager'\)/.test(html),
    'add and remove must be wired per row');
});

test('a role that has lost eligibility still shows, so its leftover amounts can be removed', () => {
  const html = renderTable({
    allowances: { earlyMorning1: 11, earlyMorning2: 22, lateNight1: 33, lateNight2: 44 },
    allowanceEligibility: { earlyLate: ['manager'] },
    allowanceRoleRates: { enabled: true, byRole: { driver: { earlyMorning1: 5 } } },
  });
  assert.ok(/set-rolerate-driver-/.test(html),
    'a configured role outside the eligibility list must stay visible, or its row is invisible and unremovable');
  assert.ok(!/<option value="driver"/.test(html), 'it must not also be offered for adding');
});

test('with no exceptions at all the table says so instead of showing an empty grid', () => {
  const html = renderTable({
    allowances: { earlyMorning1: 11, earlyMorning2: 22, lateNight1: 33, lateNight2: 44 },
    allowanceEligibility: { earlyLate: ['manager', 'user'] },
    allowanceRoleRates: { enabled: true, byRole: {} },
  });
  assert.ok(!/set-rolerate-\w+-earlyMorning1/.test(html), 'no rate cells when nothing is overridden');
  assert.ok(/ทุกตำแหน่งใช้ยอดกลาง|every role uses the company-wide/i.test(html),
    'the empty state must say every role is on the company-wide amount');
  assert.ok(/id="set-rolerate-add"/.test(html), 'it must still be possible to add the first exception');
});

test('the rendered table shows each role its own stored amount, and the central one as placeholder', () => {
  const html = renderTable({
    allowances: { earlyMorning1: 11, earlyMorning2: 22, lateNight1: 33, lateNight2: 44 },
    allowanceEligibility: { earlyLate: ['manager', 'user'] },
    allowanceRoleRates: { enabled: true, byRole: { manager: { earlyMorning1: 7, lateNight2: 0 } } },
  });
  assert.ok(/id="set-rolerate-manager-earlyMorning1"[^>]*value="7"/.test(html), 'the manager cell must show its stored 7');
  assert.ok(/id="set-rolerate-manager-lateNight2"[^>]*value="0"/.test(html), 'a stored 0 must render as 0, not as blank');
  assert.ok(/id="set-rolerate-manager-earlyMorning2"[^>]*value=""/.test(html), 'an unset cell must render blank');
  assert.ok(!/set-rolerate-user-/.test(html), 'a role with no override gets no row at all');
  // 2026-10-14: the placeholder must say WHERE the number comes from, not just the number. A bare
  // grey "22" reads as a value already typed in: the owner overwrote every cell believing he had
  // to fill them, which halved a staff member's x2 early-morning step and was caught by luck
  // before the period closed. Owner decided the wording "ตามยอดกลาง <amount>" on 2026-10-14.
  assert.ok(/id="set-rolerate-manager-earlyMorning2"[^>]*placeholder="(?:ตามยอดกลาง|company-wide) 22"/.test(html),
    'a blank cell must name the company-wide amount as the source, not show a bare number');
  assert.ok(!/placeholder="\d+"/.test(html),
    'no cell may fall back to a bare number again — that is what looked like typed-in data');
  assert.ok(!/disabled/.test(html), 'with the switch on, no cell is disabled');
  assert.ok(/checked/.test(html), 'the switch must render ticked when enabled');
});

// ---- 2026-10-14 (owner): why the add-a-role dropdown is short ----
// The owner saw a dropdown offering only `user` and read it as the system limiting him to one
// role. It is not: the list is the roles eligible for the early/late allowance, and it grows by
// itself the day another role is made eligible. Nothing on screen said so, so the table now says
// where eligibility is granted -- and says it even when there is nothing left to add, which is
// exactly when the dropdown disappears and the question gets louder.
test('the table says where the addable roles come from', () => {
  const html = renderTable({
    allowances: { earlyMorning1: 11, earlyMorning2: 22, lateNight1: 33, lateNight2: 44 },
    allowanceEligibility: { earlyLate: ['manager', 'user'] },
    allowanceRoleRates: { enabled: true, byRole: { manager: { earlyMorning1: 7 } } },
  });
  assert.ok(/id="set-rolerate-add"/.test(html), 'precondition: this case still has a role to add');
  assert.ok(/eligible .*(early|late)|สิทธิ์รับเบี้ยมาเช้า/i.test(html),
    'the table must say that only roles eligible for the allowance can be added');
  assert.ok(/eligibility table above|ตารางสิทธิ์เบี้ยเลี้ยงด้านบน/i.test(html),
    'it must point at where eligibility is granted, or the owner cannot act on it');
});

test('that explanation is still there when every eligible role already has a row', () => {
  const html = renderTable({
    allowances: { earlyMorning1: 11, earlyMorning2: 22, lateNight1: 33, lateNight2: 44 },
    allowanceEligibility: { earlyLate: ['manager'] },
    allowanceRoleRates: { enabled: true, byRole: { manager: { earlyMorning1: 7 } } },
  });
  assert.ok(!/id="set-rolerate-add"/.test(html), 'precondition: nothing is addable, so the dropdown is gone');
  assert.ok(/eligible .*(early|late)|สิทธิ์รับเบี้ยมาเช้า/i.test(html),
    'with the dropdown gone the explanation matters more, not less');
});

test('the rendered table is disabled and dimmed while the switch is off, without losing amounts', () => {
  const html = renderTable({
    allowances: { earlyMorning1: 11, earlyMorning2: 22, lateNight1: 33, lateNight2: 44 },
    allowanceEligibility: { earlyLate: ['manager'] },
    allowanceRoleRates: { enabled: false, byRole: { manager: { earlyMorning1: 7 } } },
  });
  assert.ok(/value="7"/.test(html), 'switching off must not erase what the owner typed');
  for (const k of ['earlyMorning1', 'earlyMorning2', 'lateNight1', 'lateNight2']) {
    assert.ok(new RegExp(`id="set-rolerate-manager-${k}"[^>]*disabled`).test(html), `${k} must be disabled`);
  }
  assert.ok(!/class="rolerate-cell"(?![^>]*disabled)/.test(html),
    'every control in the block (cells, remove buttons, the add picker) must be disabled while the switch is off');
  assert.ok(!/checked/.test(html), 'the switch must render unticked');
  assert.ok(/opacity:\.55/.test(html), 'the block must read as inactive');
});

test('a broken or empty eligibility list leaves nothing to add, and does not crash', () => {
  // The empty state itself is covered by "with no exceptions at all..." above. This pins the
  // shapes allowanceEligibility.earlyLate can arrive in from a hand-edited settings file.
  for (const elig of [[], undefined, 'nonsense']) {
    const html = renderTable({
      allowances: { earlyMorning1: 11, earlyMorning2: 22, lateNight1: 33, lateNight2: 44 },
      allowanceEligibility: { earlyLate: elig },
      allowanceRoleRates: { enabled: true, byRole: {} },
    });
    assert.ok(!/set-rolerate-\w+-earlyMorning1/.test(html), 'no rate cells should be rendered');
    assert.ok(!/id="set-rolerate-add"/.test(html), `eligibility ${JSON.stringify(elig)} offers no role to add`);
  }
});

test('the new Settings labels have Japanese entries', () => {
  // This page has no currentLang === 'ja' branches at all: L(en, th) resolves JA by looking the
  // English string up in window.LANG_JA, so a missing entry is a silent English leak in JA mode.
  const needed = [
    'Use a different early-morning / late-night rate per role',
    'Only roles that differ are listed. A role not in this table uses the company-wide amount above, and follows it when you change it.',
    'No exceptions — every role uses the company-wide amount above.',
    '+ Add a role that differs',
    'Put this role back on the company-wide amount',
    'Role',
    'Early ×1', 'Early ×2', 'Late ×1', 'Late ×2',
    '⚠️ A per-role allowance rate must be a number between 0 and 100000',
  ];
  // 2026-10-13 (test-quality review): this used to be a bare substring search, so the needle
  // 'Role' was already satisfied by the pre-existing "Allowance Eligibility by Role" entry -- a
  // pure tautology. It now requires the string to be a KEY, and requires the Japanese value to
  // differ from the English, since an entry whose value is the English text is the very silent
  // leak this test exists to prevent.
  const entries = {};
  for (const m of JA_SRC.matchAll(/^\s*"((?:[^"\\]|\\.)*)":\s*"((?:[^"\\]|\\.)*)"/gm)) {
    entries[JSON.parse(`"${m[1]}"`)] = JSON.parse(`"${m[2]}"`);
  }
  for (const en of needed) {
    assert.ok(Object.prototype.hasOwnProperty.call(entries, en),
      `attendance/lang/ja.js has no entry keyed "${en}" -- JA mode would show English`);
    assert.notStrictEqual(entries[en], en,
      `the Japanese entry for "${en}" is still the English text`);
    assert.ok(/[぀-ヿ一-龯]/.test(entries[en]),
      `the Japanese entry for "${en}" contains no Japanese: ${entries[en]}`);
  }
});

// ---- THE PLUMBING: does the saved section actually reach either engine? ----
// 2026-10-13: added after review. Everything above this point fed earlyLateRateFor() an `S` built
// by hand in this file, which proved the reader and proved NOTHING about whether the real code
// ever puts allowanceRoleRates into an `S`. It did not: the server rebuilt its settings from a
// fixed key list that omitted the section, and the browser never read it back from the API. The
// feature was unreachable while 46 assertions here were green. These tests run the REAL
// getAppSettings() and the REAL load block instead.

// Slices `const NAME = {...};` out of a source, braces balanced -- for injecting object constants
// that extractFunction cannot carry.
function constBlock(src, name) {
  const m = new RegExp(`^const ${name} = `, 'm').exec(src);
  if (!m) throw new Error(`const ${name} not found`);
  const open = src.indexOf('{', m.index);
  let depth = 0;
  for (let j = open; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (depth === 0) return src.slice(m.index, j + 1) + ';'; }
  }
  throw new Error(`unbalanced ${name}`);
}
// Slices a statement that starts with `startsWith` and ends at its matching closing brace.
function statementBlock(src, startsWith) {
  const i = src.indexOf(startsWith);
  if (i < 0) throw new Error(`statement not found: ${startsWith}`);
  const open = src.indexOf('{', i);
  let depth = 0;
  for (let j = open; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (depth === 0) return src.slice(i, j + 1); }
  }
  throw new Error(`unbalanced statement: ${startsWith}`);
}

const SAVED_TABLE = { enabled: true, byRole: { manager: { earlyMorning1: 7, earlyMorning2: 8, lateNight1: 9, lateNight2: 10 } } };

test('the server hands payroll the saved rate table, not a settings object without it', () => {
  const ctx = {
    DEFAULT_ANNUAL_LEAVE_TIERS: [{ afterMonths: 0, days: 6 }],
    DEFAULT_SICK_LEAVE_DAYS: 30,
    DEFAULT_BUSINESS_LEAVE_DAYS: 3,
    normalizeAnnualLeaveTiers: (t) => t,
    normalizeQuotaDays: (v, d) => (v == null ? d : v),
    Object, Array, Infinity, Number,
    // The real file on disk, as an owner who has saved the table would have it.
    readSettings: () => ({ appSettings: { allowances: { earlyMorning1: 240, earlyMorning2: 480, lateNight1: 240, lateNight2: 480 }, allowanceRoleRates: SAVED_TABLE } }),
  };
  vm.createContext(ctx);
  vm.runInContext(
    constBlock(SERVER_SRC, 'DEFAULT_APP_SETTINGS') + '\n' +
    `const EARLY_LATE_RATE_KEYS = ${extractKeys(SERVER_SRC)};\n` +
    extractFunction(SERVER_SRC, 'earlyLateRateFor') + '\n' +
    extractFunction(SERVER_SRC, 'getAppSettings') + '\n' +
    'this.S = getAppSettings();\nthis.rate = earlyLateRateFor;', ctx);
  assert.ok(ctx.S.allowanceRoleRates,
    'getAppSettings() dropped allowanceRoleRates -- the engine that pays can never see the table, so turning the switch on changes nothing');
  assert.strictEqual(ctx.rate('manager', 'earlyMorning1', ctx.S), 7,
    'payroll must pay the configured role rate');
  assert.strictEqual(ctx.rate('user', 'earlyMorning1', ctx.S), 240,
    'an unconfigured role must still get the company-wide amount');
});

test('the browser loads the saved rate table back from the API', () => {
  const block = statementBlock(APP_SRC, 'if (data.appSettings) {');
  const ctx = {
    data: { appSettings: { allowances: { earlyMorning1: 240 }, allowanceRoleRates: SAVED_TABLE } },
    APP_SETTINGS: { company: {}, payroll: {}, sso: {}, allowances: {}, workSchedule: {}, geofence: {}, leave: {}, map: {}, allowanceEligibility: {}, tax: { brackets: [] }, allowanceRoleRates: { enabled: false, byRole: {} } },
    normalizeAnnualLeaveTiers: (t) => t || [],
    _settingsSectionsOnServer: { allowanceRoleRates: false, webClock: false },
    sickLeaveEntitlementDays: () => 30,
    businessLeaveEntitlementDays: () => 3,
    Object, Array, Infinity, Number,
  };
  vm.createContext(ctx);
  vm.runInContext(block, ctx);
  assert.ok(ctx.APP_SETTINGS.allowanceRoleRates && ctx.APP_SETTINGS.allowanceRoleRates.enabled === true,
    'the load path dropped allowanceRoleRates -- the Settings page would show an empty table and the next save would erase the stored amounts');
  assert.deepStrictEqual(JSON.parse(JSON.stringify(ctx.APP_SETTINGS.allowanceRoleRates)), SAVED_TABLE);
});

// The structural guard: this bug class is "a new appSettings section is added and one of the two
// plumbing paths is not told about it". Keyed off DEFAULT_APP_SETTINGS so it catches the NEXT
// section too, not just this one.
test('every appSettings section survives both plumbing paths', () => {
  const defaults = constBlock(SERVER_SRC, 'DEFAULT_APP_SETTINGS');
  const sections = [...defaults.matchAll(/^\s{2}(\w+):/gm)].map(m => m[1]).filter(k => k !== 'updatedAt');
  assert.ok(sections.length >= 10, `expected to find the appSettings sections, found ${sections.join(',')}`);
  const serverRead = extractFunction(SERVER_SRC, 'getAppSettings');
  const clientRead = statementBlock(APP_SRC, 'if (data.appSettings) {');
  const missingServer = sections.filter(k => !new RegExp(`\\b${k}\\b`).test(serverRead));
  const missingClient = sections.filter(k => !new RegExp(`\\b${k}\\b`).test(clientRead));
  assert.deepStrictEqual(missingServer, [],
    `getAppSettings() never reads these sections, so the server's engines cannot see them: ${missingServer.join(', ')}`);
  assert.deepStrictEqual(missingClient, [],
    `the browser's settings load never reads these sections, so the page cannot show them and the next save erases them: ${missingClient.join(', ')}`);
});

// Review finding I1.
test('a late-out record shows the requester\'s rate, not the approver\'s', () => {
  const fn = extractFunction(APP_SRC, 'formatTimePart');
  assert.ok(/l\.userId/.test(fn),
    'formatTimePart must resolve the role from the record owner -- approval cards render other people\'s late-out requests');
  const ctx = {
    APP_SETTINGS: { allowances: { lateNight1: 240, lateNight2: 480, lateNightThreshold1Hour: 19, lateNightThreshold2Hour: 20 }, allowanceRoleRates: SAVED_TABLE },
    DATA_USERS: [{ id: 1, role: 'manager' }, { id: 2, role: 'user' }],
    currentUser: { id: 1, role: 'manager' }, realUser: { id: 1, role: 'manager' },
    previewRole: '', previewUserId: 0, currentLang: 'en',
    L: (en) => en, escapeHtml: (s) => String(s == null ? '' : s),
    // Read out of the real source, so the business-day boundary cannot drift from the app's.
    BUSINESS_DAY_START_MINS: Number(/const BUSINESS_DAY_START_MINS = (\d+);/.exec(APP_SRC)[1]),
    Object, Array, Number, Math, String, isNaN, parseInt,
  };
  vm.createContext(ctx);
  vm.runInContext(
    `const EARLY_LATE_RATE_KEYS = ${extractKeys(APP_SRC)};\n` +
    ['earlyLateRateFor', 'parseHHMMToMins', 'lateNightCheckoutMins', 'lateNightThresholdMins',
      'lateNightThresholdHourOf', 'lateOutThresholdHour', 'lateOutAllowanceForHour',
      'loggedInUser', 'isSuperAdmin', 'isImpersonatingPerson', 'effectiveRole', 'formatTimePart']
      .map(n => extractFunction(APP_SRC, n)).join('\n') +
    '\nthis.fmt = formatTimePart;', ctx);
  // userId 2 is a `user`: unconfigured, so the company-wide 240/480 -- NOT the manager's 9/10,
  // even though the signed-in viewer (currentUser) is a manager.
  const asUser = ctx.fmt({ type: 'late-out', lateOutTime: '21:00', userId: 2 });
  assert.ok(/฿480|฿240/.test(asUser), `expected the viewed employee's company-wide rate, got: ${asUser}`);
  assert.ok(!/฿9\b|฿10\b/.test(asUser), `showed the approver's own configured rate on someone else's record: ${asUser}`);
  // The manager's own record does get the configured rate.
  const asManager = ctx.fmt({ type: 'late-out', lateOutTime: '21:00', userId: 1 });
  assert.ok(/฿10\b|฿9\b/.test(asManager), `expected the manager's configured rate, got: ${asManager}`);
});

// Review finding I4: an out-of-range cell was dropped silently and the save still said "saved",
// so the owner's typo left that role quietly on the company-wide rate. Every other money field on
// this page comes back with a specific refusal. Runs the real form reader against a fake DOM.
function runFormReader(cells, enabled, prevByRole, opts) {
  const el = (id) => (Object.prototype.hasOwnProperty.call(cells, id) ? { id, value: String(cells[id]) } : null);
  // The reader walks the RENDERED cells, so the fake DOM has to answer querySelectorAll too, and
  // has to be able to pretend the block was never rendered at all.
  const blockRendered = !(opts && opts.noBlock);
  const ctx = {
    document: {
      getElementById: (id) => {
        if (id === 'rolerate-block') return blockRendered ? { id } : null;
        if (id === 'set-rolerate-enabled') return blockRendered ? { checked: !!enabled } : null;
        return blockRendered ? el(id) : null;
      },
      querySelectorAll: () => (blockRendered ? Object.keys(cells).map(id => ({ id, value: String(cells[id]) })) : []),
    },
    APP_SETTINGS: { allowanceEligibility: { earlyLate: ['manager', 'user'] }, allowanceRoleRates: { enabled: false, byRole: prevByRole || {} } },
    L: (en) => en,
    Object, Number, Array,
  };
  vm.createContext(ctx);
  vm.runInContext(
    `const EARLY_LATE_RATE_KEYS = ${extractKeys(APP_SRC)};\n` +
    extractFunction(APP_SRC, 'roleRateRolesFrom') + '\n' +
    extractFunction(APP_SRC, 'readRoleRateTableFromForm') + '\n' +
    'this.out = readRoleRateTableFromForm();', ctx);
  return ctx.out;
}

test('an out-of-range or non-numeric cell is refused, naming the field', () => {
  for (const bad of ['200000', '-360', 'abc']) {
    const got = runFormReader({ 'set-rolerate-manager-earlyMorning1': bad }, true);
    assert.strictEqual(got.ok, false, `"${bad}" should be refused, not silently dropped`);
    assert.strictEqual(got.fieldId, 'set-rolerate-manager-earlyMorning1',
      'the refusal must name the offending cell so settingsFieldError can highlight it');
    assert.ok(got.message && /0.*100000|number/i.test(got.message), `unhelpful message: ${got.message}`);
  }
});

test('the form reader keeps blanks out and keeps 0 in', () => {
  const got = runFormReader({
    'set-rolerate-manager-earlyMorning1': '0',
    'set-rolerate-manager-earlyMorning2': '',
    'set-rolerate-user-lateNight1': '123',
  }, true);
  assert.strictEqual(got.ok, true, got.message);
  const v = JSON.parse(JSON.stringify(got.value));
  assert.strictEqual(v.enabled, true);
  assert.strictEqual(v.byRole.manager.earlyMorning1, 0, '0 is a real rate and must be stored');
  assert.ok(!('earlyMorning2' in v.byRole.manager), 'a blank cell must be omitted, not stored as 0');
  assert.strictEqual(v.byRole.user.lateNight1, 123);
});

// 2026-10-14: with the table holding only exceptions, REMOVING a row is how a role goes back to
// the company-wide amount -- so an absent row must be absent from the payload, not carried
// forward. Every configured role is rendered, so nothing can go missing by accident.
test('a role whose row was removed is dropped, which is how it returns to the central amount', () => {
  const got = runFormReader({ 'set-rolerate-manager-earlyMorning1': '7' }, true);
  assert.strictEqual(got.ok, true, got.message);
  const v = JSON.parse(JSON.stringify(got.value));
  assert.deepStrictEqual(Object.keys(v.byRole), ['manager'], 'only the rendered row survives');
});

// ---- 2026-10-14 (owner): ticking a role eligible must reach the dropdown immediately ----
// The dropdown reads the eligibility list, which is right, but it read the SAVED one -- so
// ticking a role eligible in the table above left the dropdown unchanged until the owner saved
// and came back. That is indistinguishable from "the list is fixed", which is what the owner
// concluded. It reads the ticks that are on screen now. Runs the real refreshRoleRateTable()
// against a fake DOM, so this cannot pass while the code does the wrong thing.
function extractConst(src, name) {
  const m = new RegExp(`const ${name} = (\\[[^\\]]*\\]);`).exec(src);
  if (!m) throw new Error(`${name} not found`);
  return m[1];
}
function runRefresh({ savedElig, tickedElig, byRole, typed }) {
  let rendered = null;
  // The refresh re-reads the cells that are ON SCREEN, so the fake DOM must actually contain the
  // rendered row for every stored role -- answering [] here would simulate a table that is not
  // rendered at all and would quietly drop the amounts under test.
  const cells = {};
  for (const [role, row] of Object.entries(byRole || {})) {
    for (const [k, v] of Object.entries(row)) cells[`set-rolerate-${role}-${k}`] = String(v);
  }
  // `typed` overlays what the owner has keyed in but not saved, including values the save path
  // would refuse.
  for (const [id, v] of Object.entries(typed || {})) cells[id] = String(v);
  const ctx = {
    document: {
      getElementById: (id) => {
        if (id === 'rolerate-block') return { set outerHTML(v) { rendered = v; } };
        if (id === 'set-rolerate-enabled') return { checked: true };
        if (id.startsWith('set-elig-earlyLate-')) {
          if (tickedElig === null) return null; // the eligibility table is not on screen
          return { checked: tickedElig.includes(id.slice('set-elig-earlyLate-'.length)) };
        }
        return Object.prototype.hasOwnProperty.call(cells, id) ? { id, value: cells[id] } : null;
      },
      querySelectorAll: () => Object.keys(cells).map(id => ({ id, value: cells[id] })),
    },
    APP_SETTINGS: {
      allowances: { earlyMorning1: 11, earlyMorning2: 22, lateNight1: 33, lateNight2: 44 },
      allowanceEligibility: { earlyLate: savedElig },
      allowanceRoleRates: { enabled: true, byRole: byRole || {} },
    },
    L: (en) => en,
    escapeHtml: (s) => String(s == null ? '' : s),
    escapeJsAttr: (s) => String(s == null ? '' : s),
    Object, Number, Array, String, Set,
  };
  vm.createContext(ctx);
  vm.runInContext(
    `const EARLY_LATE_RATE_KEYS = ${extractKeys(APP_SRC)};\n` +
    `const ROLE_KEYS = ${extractConst(APP_SRC, 'ROLE_KEYS')};\n` +
    'let _roleRateAdded = [];\n' +
    ['roleRateRolesFrom', 'roleRateShownRoles', 'renderRoleRateTable',
      'readRoleRateTableFromForm', 'readEarlyLateEligFromForm', 'readRoleRateCellsRaw',
      'refreshRoleRateTable']
      .map(n => extractFunction(APP_SRC, n)).join('\n') + '\n' +
    'refreshRoleRateTable();', ctx);
  return rendered;
}

test('ticking a role eligible offers it in the dropdown before anything is saved', () => {
  const html = runRefresh({ savedElig: ['manager'], tickedElig: ['manager', 'marketing'], byRole: {} });
  assert.ok(/<option value="marketing"/.test(html),
    'marketing was just ticked eligible on screen, so it must be addable without saving first');
});

test('un-ticking a role withdraws it from the dropdown just as fast', () => {
  const html = runRefresh({ savedElig: ['manager', 'marketing'], tickedElig: ['manager'], byRole: {} });
  assert.ok(!/<option value="marketing"/.test(html),
    'a role no longer ticked eligible must stop being offered');
});

test('a role that already has stored amounts keeps its row even after losing eligibility', () => {
  const html = runRefresh({
    savedElig: ['manager', 'marketing'], tickedElig: ['manager'],
    byRole: { marketing: { earlyMorning1: 7 } },
  });
  assert.ok(/id="set-rolerate-marketing-earlyMorning1"/.test(html),
    'its leftover amount must stay visible and removable, or it is impossible to clear');
});

// 2026-10-14 (review of this same change): a re-render is cosmetic and must never cost the owner
// the cells they already typed. readRoleRateTableFromForm() refuses an out-of-range cell -- right
// for a SAVE, wrong here, because falling back to the saved settings silently reverted every
// OTHER unsaved cell too. Ticking a role eligible made that fire during ordinary editing, which
// is what turned a pre-existing sharp edge into a likely one.
test('one bad cell does not revert the other cells the owner has typed', () => {
  const html = runRefresh({
    savedElig: ['manager', 'user'],
    tickedElig: ['manager', 'user', 'marketing'],
    byRole: { manager: { earlyMorning1: 11, earlyMorning2: 22 } },
    typed: {
      'set-rolerate-manager-earlyMorning1': '360',    // good, typed, unsaved
      'set-rolerate-manager-earlyMorning2': '200000', // out of range: the save path must refuse it
    },
  });
  assert.ok(/id="set-rolerate-manager-earlyMorning1"[^>]*value="360"/.test(html),
    'the good typed value must survive a re-render triggered by an unrelated tick');
  assert.ok(!/id="set-rolerate-manager-earlyMorning1"[^>]*value="11"/.test(html),
    'it must not silently revert to the last saved amount');
  assert.ok(/<option value="marketing"/.test(html),
    'and the tick that triggered the re-render must still take effect');
});

test('with the eligibility table off screen it falls back to the saved list, not to nothing', () => {
  const html = runRefresh({ savedElig: ['manager', 'user'], tickedElig: null, byRole: {} });
  assert.ok(/<option value="manager"/.test(html) && /<option value="user"/.test(html),
    'reading no checkboxes must mean "not rendered", never "nobody is eligible"');
});

// The one way rows could vanish by accident: the block not being rendered at all. Then the save
// must leave the stored section untouched rather than rebuild it from an empty DOM.
test('if the block was never rendered the stored rates are left exactly as they are', () => {
  const got = runFormReader({}, false, null, { noBlock: true });
  assert.strictEqual(got.ok, true);
  const v = JSON.parse(JSON.stringify(got.value));
  assert.deepStrictEqual(v, { enabled: false, byRole: {} },
    'it must hand back APP_SETTINGS.allowanceRoleRates untouched, not an empty rebuild');
});

test('the save path aborts on a refused cell instead of reporting success', () => {
  const save = between(APP_SRC, 'readRoleRateTableFromForm()', 'APP_SETTINGS.allowanceRoleRates =', 300);
  assert.ok(/settingsFieldError\(/.test(save), 'a refused cell must go through settingsFieldError');
  assert.ok(/return;/.test(save), 'the save must abort, not continue and report success');
});

// ---- deploy ordering: the frontend goes live before the backend restarts ----
// 2026-10-14: Z:\Time_Attendance IS the live site, so merging publishes app.js immediately while
// the running Node process keeps the OLD server.js until someone restarts it over SSH. An old
// server rejects an unknown appSettings field with a 400 for the WHOLE request, so a new client
// that always sent allowanceRoleRates would break every Settings save during that window -- the
// same whole-page-refusal the spec warns about from the morningReviewEnabled incident.
// So the inert default is not sent at all: nothing is configured, there is nothing to persist, and
// 2026-10-14: renamed to omitUnstoredDefaults() and generalised when the web-clock switch hit the
// same deploy window. The rule also changed -- it now omits only a section the SERVER has never
// stored, because "omit while it looks inert" made turning a feature back off impossible to save.
// The fuller cases live in tests/web-clock-switch.test.js; these keep covering the rate table.
// an old server never meets the key. Once the owner configures anything it is sent as normal.
function runSaveFilter(appSettings) {
  const fn = extractFunction(APP_SRC, 'omitUnstoredDefaults');
  const ctx = { Object, Array };
  vm.createContext(ctx);
  vm.runInContext(`${fn}
this.out = omitUnstoredDefaults(${JSON.stringify(appSettings)}, { allowanceRoleRates: false, webClock: false });`, ctx);
  return ctx.out;
}

test('an unconfigured rate table is not sent to the server at all', () => {
  const out = runSaveFilter({ allowances: { upcountry: 240 }, allowanceRoleRates: { enabled: false, byRole: {} } });
  assert.ok(!Object.prototype.hasOwnProperty.call(out, 'allowanceRoleRates'),
    'the inert default must be omitted, so a server that predates this feature still accepts the save');
  assert.deepStrictEqual(JSON.parse(JSON.stringify(out.allowances)), { upcountry: 240 },
    'nothing else may be dropped');
});

test('anything the owner has actually configured IS sent', () => {
  const cases = [
    { enabled: true, byRole: {} },
    { enabled: false, byRole: { manager: { earlyMorning1: 7 } } },
    { enabled: true, byRole: { manager: { earlyMorning1: 7 } } },
  ];
  for (const rr of cases) {
    const out = runSaveFilter({ allowanceRoleRates: rr });
    assert.ok(Object.prototype.hasOwnProperty.call(out, 'allowanceRoleRates'),
      `${JSON.stringify(rr)} is a real setting and must be sent`);
  }
});

test('a missing or malformed section is simply omitted, never sent as garbage', () => {
  for (const rr of [undefined, null, 'x', []]) {
    const out = runSaveFilter(rr === undefined ? {} : { allowanceRoleRates: rr });
    assert.ok(!Object.prototype.hasOwnProperty.call(out, 'allowanceRoleRates'),
      `${JSON.stringify(rr)} must not be sent`);
  }
});

test('the save path routes through the filter', () => {
  const fn = extractFunction(APP_SRC, 'savePayrollSettings');
  assert.ok(/omitUnstoredDefaults\(/.test(fn),
    'savePayrollSettings must send the filtered object, or the deploy window breaks Settings saves');
});

console.log(`\n${passed} assertions passed`);
module.exports = { between, previewPassesRole };
