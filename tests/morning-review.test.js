// Morning review unit tests (2026-10-02). No framework: `node tests/morning-review.test.js`.
//
// The rule being pinned here: Early Morning used to pay off a face scan alone, so a night spent
// at the office and a walk through the door at 06:30 paid exactly what driving in to work at
// 06:30 paid. The scanner records a pass with no direction, and people pass through it several
// times a day, so nothing in the data proves someone left. A later pass inside the working
// morning is the one usable signal; it raises a flag for Accounting and holds the money until a
// person decides, which is why none of these tests assert that the allowance is *cut*.
//
// Same approach as tests/checkout-review.test.js: every function is extracted from the real
// source files and run in a sandbox, so the tests also prove the two DUAL-SYNC copies agree.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const APP_SRC = fs.readFileSync(path.join(ROOT, 'attendance/js/app.js'), 'utf8');
const SERVER_SRC = fs.readFileSync(path.join(ROOT, 'attendance-server/backend/server.js'), 'utf8');

function balancedFrom(src, start, label) {
  const i = src.indexOf('{', start);
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (depth === 0) return src.slice(start, j + 1); }
  }
  throw new Error(`unbalanced ${label}`);
}
function extractFunction(src, name) {
  const m = new RegExp(`^(async )?function ${name}\\(`, 'm').exec(src);
  if (!m) throw new Error(`function ${name} not found`);
  return balancedFrom(src, m.index, name);
}
function extractConstObject(src, name) {
  const m = new RegExp(`^const ${name} = \\{`, 'm').exec(src);
  if (!m) throw new Error(`const ${name} not found`);
  return balancedFrom(src, m.index, name).replace(/^const /, 'var ') + ';';
}

const FNS = ['isAllowanceEligible', 'isDeviceScanSource', 'isEarlyMorningDayStatus',
  'isFullDayPersonalLeaveStatus', 'isRestAttendanceDay', 'parseHHMMToMins',
  'morningReviewWindowOf', 'morningReviewTrigger', 'morningReviewDecisionFor',
  'earlyMorningCheckInOk', 'deviceScanQualifiesForEarlyMorning'];
function load(src) {
  const ctx = { HHMM_RE: /^([01][0-9]|2[0-3]):[0-5][0-9]$/ };
  vm.createContext(ctx);
  vm.runInContext(extractConstObject(src, 'DEFAULT_ALLOWANCE_ELIGIBILITY') + '\n' +
    FNS.map(n => extractFunction(src, n)).join('\n'), ctx);
  return ctx;
}
const SIDES = [['client', load(APP_SRC)], ['server', load(SERVER_SRC)]];

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok  ${name}`); }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; }
}
function sameSource(name) {
  const norm = s => s.replace(/\s+/g, ' ').trim();
  assert.strictEqual(norm(extractFunction(APP_SRC, name)), norm(extractFunction(SERVER_SRC, name)),
    `${name} differs between app.js and server.js`);
}

// Live Settings values: the allowance is paid up to 07:30, and these roles are eligible today.
const S = {
  allowances: { earlyThreshold1Min: 450, earlyThreshold2Min: 390 },
  allowanceEligibility: { earlyLate: ['manager', 'user'] },
};
const USER = { role: 'user' };
const day = o => ({ date: '2026-09-22', status: 'present', checkIn: '06:30',
  checkInSource: 'device', isFuture: false, ...o });

console.log('Morning review: when Accounting is asked to look');

test('an early scan followed by a door pass in the working morning is flagged', () => {
  for (const [side, X] of SIDES) {
    // the owner's own example: scanned at 07:30, came through again at 08:31
    assert.strictEqual(X.morningReviewTrigger(day({ checkIn: '07:30' }), USER, S, ['07:30', '08:31']), true, `${side} 07:30 then 08:31`);
    // and the blunter one: scanned at 06:30, not seen again until 11:00
    assert.strictEqual(X.morningReviewTrigger(day({ checkIn: '06:30' }), USER, S, ['06:30', '11:00']), true, `${side} 06:30 then 11:00`);
  }
});

test('an early scan with no later pass is left alone -- this is the ordinary early start', () => {
  for (const [side, X] of SIDES) {
    assert.strictEqual(X.morningReviewTrigger(day(), USER, S, ['06:30']), false, `${side} one pass only`);
    assert.strictEqual(X.morningReviewTrigger(day(), USER, S, ['06:30', '12:30', '17:40']), false, `${side} lunch and home are outside the window`);
    assert.strictEqual(X.morningReviewTrigger(day(), USER, S, []), false, `${side} no scans recorded`);
    assert.strictEqual(X.morningReviewTrigger(day(), USER, S, null), false, `${side} nothing passed at all`);
  }
});

test('a pass at or before the check-in is not a return', () => {
  for (const [side, X] of SIDES) {
    // 08:00 opens the window, but this day started at 08:00 -- the check-in is not its own return
    assert.strictEqual(X.morningReviewTrigger(day({ checkIn: '08:00' }), USER, S, ['08:00']), false, `${side} the check-in itself`);
  }
});

test('a day that earns nothing is never flagged -- there is no money to hold', () => {
  for (const [side, X] of SIDES) {
    assert.strictEqual(X.morningReviewTrigger(day({ checkIn: '07:31' }), USER, S, ['07:31', '09:00']), false, `${side} past the 07:30 threshold`);
    assert.strictEqual(X.morningReviewTrigger(day({ checkIn: '08:25' }), USER, S, ['08:25', '09:00']), false, `${side} an ordinary arrival`);
    assert.strictEqual(X.morningReviewTrigger(day({ checkIn: '07:30' }), USER, S, ['07:30', '09:00']), true, `${side} exactly 07:30 still earns`);
  }
});

test('only a face-scanner check-in is reviewed; a web check-in never paid this way', () => {
  for (const [side, X] of SIDES) {
    assert.strictEqual(X.morningReviewTrigger(day({ checkInSource: 'web' }), USER, S, ['06:30', '08:31']), false, `${side} web`);
    assert.strictEqual(X.morningReviewTrigger(day({ checkInSource: null }), USER, S, ['06:30', '08:31']), false, `${side} no source`);
  }
});

test('days that pay no allowance at all are skipped: leave, Company Trip, Abroad, future', () => {
  for (const [side, X] of SIDES) {
    const scans = ['06:30', '08:31'];
    assert.strictEqual(X.morningReviewTrigger(day({ status: 'leave-annual' }), USER, S, scans), false, `${side} annual leave`);
    assert.strictEqual(X.morningReviewTrigger(day({ status: 'company-trip' }), USER, S, scans), false, `${side} company trip`);
    assert.strictEqual(X.morningReviewTrigger(day({ status: 'abroad' }), USER, S, scans), false, `${side} abroad`);
    assert.strictEqual(X.morningReviewTrigger(day({ isFuture: true }), USER, S, scans), false, `${side} future`);
    assert.strictEqual(X.morningReviewTrigger(day({ checkIn: null }), USER, S, scans), false, `${side} no check-in`);
  }
});

// The point of this one is the second half. Eligibility is a Settings table the owner edits, so a
// rule that reads a role list written in code would silently stop covering a role the day it is
// switched on -- and nobody would notice, because the flag simply never appears.
test('eligibility comes from Settings, not from a role list in the code', () => {
  for (const [side, X] of SIDES) {
    const scans = ['06:30', '08:31'];
    assert.strictEqual(X.morningReviewTrigger(day(), { role: 'driver' }, S, scans), false, `${side} driver is not eligible today`);
    const opened = { ...S, allowanceEligibility: { earlyLate: ['manager', 'user', 'driver'] } };
    assert.strictEqual(X.morningReviewTrigger(day(), { role: 'driver' }, opened, scans), true, `${side} driver flagged the moment Settings says so`);
  }
});

test('the review window is configurable, and the defaults are 08:00-12:00', () => {
  for (const [side, X] of SIDES) {
    // compared field by field: an object built inside the sandbox has that realm's prototype,
    // which deepStrictEqual counts as a difference even when every value matches.
    const def = X.morningReviewWindowOf({});
    assert.strictEqual(def.start, 480, `${side} default start 08:00`);
    assert.strictEqual(def.end, 720, `${side} default end 12:00`);
    const set = X.morningReviewWindowOf({ morningReviewWindowStartMin: 540, morningReviewWindowEndMin: 600 });
    assert.strictEqual(set.start, 540, `${side} configured start`);
    assert.strictEqual(set.end, 600, `${side} configured end`);
    const narrow = { ...S, allowances: { ...S.allowances, morningReviewWindowStartMin: 540 } };
    assert.strictEqual(X.morningReviewTrigger(day(), USER, narrow, ['06:30', '08:31']), false, `${side} 08:31 is outside a 09:00 window`);
    assert.strictEqual(X.morningReviewTrigger(day(), USER, narrow, ['06:30', '09:10']), true, `${side} 09:10 is inside it`);
  }
});

console.log('Morning review: what the decision does to the money');

test('a decision only counts while it still describes the day it was made about', () => {
  for (const [side, X] of SIDES) {
    const r = { checkIn: '06:30', decision: 'allow' };
    assert.strictEqual(X.morningReviewDecisionFor(r, '06:30'), 'allow', `${side} same check-in`);
    // Accounting allowed a 06:30 morning; a time correction then made it 08:31. The old decision
    // described a day that no longer exists, so the day goes back to pending rather than paying.
    assert.strictEqual(X.morningReviewDecisionFor(r, '08:31'), null, `${side} check-in changed`);
    assert.strictEqual(X.morningReviewDecisionFor(r, null), null, `${side} check-in gone`);
    assert.strictEqual(X.morningReviewDecisionFor(null, '06:30'), null, `${side} never reviewed`);
    assert.strictEqual(X.morningReviewDecisionFor({ checkIn: '06:30', decision: 'maybe' }, '06:30'), null, `${side} junk decision`);
  }
});

test('an unflagged day pays; a flagged one pays only once it is allowed', () => {
  for (const [side, X] of SIDES) {
    assert.strictEqual(X.earlyMorningCheckInOk({ morningReviewNeeded: false }), true, `${side} never flagged`);
    assert.strictEqual(X.earlyMorningCheckInOk({}), true, `${side} a day from before this rule existed`);
    assert.strictEqual(X.earlyMorningCheckInOk({ morningReviewNeeded: true }), false, `${side} flagged, undecided -- held, not lost`);
    assert.strictEqual(X.earlyMorningCheckInOk({ morningReviewNeeded: true, morningReview: 'allow' }), true, `${side} allowed`);
    assert.strictEqual(X.earlyMorningCheckInOk({ morningReviewNeeded: true, morningReview: 'deny' }), false, `${side} denied`);
    assert.strictEqual(X.earlyMorningCheckInOk(null), false, `${side} no day`);
  }
});

test('the scan path stops paying while a flag is open, and resumes when it is allowed', () => {
  for (const [side, X] of SIDES) {
    const base = { date: '2026-09-22', status: 'present', checkIn: '06:30', checkInSource: 'device', isWeekend: false, isPubHoliday: false };
    assert.strictEqual(X.deviceScanQualifiesForEarlyMorning(base, new Set()), true, `${side} unflagged`);
    assert.strictEqual(X.deviceScanQualifiesForEarlyMorning({ ...base, morningReviewNeeded: true }, new Set()), false, `${side} flagged`);
    assert.strictEqual(X.deviceScanQualifiesForEarlyMorning({ ...base, morningReviewNeeded: true, morningReview: 'allow' }, new Set()), true, `${side} allowed`);
    assert.strictEqual(X.deviceScanQualifiesForEarlyMorning({ ...base, morningReviewNeeded: true, morningReview: 'deny' }, new Set()), false, `${side} denied`);
  }
});

test('every new rule is byte-identical in app.js and server.js', () => {
  ['morningReviewWindowOf', 'morningReviewTrigger', 'morningReviewDecisionFor',
   'earlyMorningCheckInOk', 'deviceScanQualifiesForEarlyMorning'].forEach(sameSource);
});

console.log(`  ${passed} passed, ${process.exitCode ? 'FAILURES' : '0 failed'}`);
