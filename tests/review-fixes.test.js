// 2026-09-24 review-fix round: time-correction revoke cascade (dependent detection), Company Trip
// save guard, Accounting revoke -> MD push, colleagues' cancelled/revoked records hidden from plain
// users. No framework: `node tests/review-fixes.test.js`. Same approach as the other tests: the
// real functions are extracted from attendance/js/app.js and attendance-server/backend/server.js
// and run in a sandbox, so the DUAL-SYNC copies are proven to agree.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const APP_SRC = fs.readFileSync(path.join(ROOT, 'attendance/js/app.js'), 'utf8');
const SERVER_SRC = fs.readFileSync(path.join(ROOT, 'attendance-server/backend/server.js'), 'utf8');

function extractFunction(src, name) {
  const m = new RegExp(`^(async )?function ${name}\\(`, 'm').exec(src);
  if (!m) throw new Error(`function ${name} not found`);
  const open = src.indexOf(') {', m.index) + 2;
  let depth = 0;
  for (let j = open; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (depth === 0) return src.slice(m.index, j + 1); }
  }
  throw new Error(`unbalanced ${name}`);
}
function sameSource(name) {
  const norm = s => s.replace(/\s+/g, ' ').trim();
  assert.strictEqual(norm(extractFunction(APP_SRC, name)), norm(extractFunction(SERVER_SRC, name)), `${name} differs between app.js and server.js`);
}
// Values from a vm context carry that realm's prototypes -- compare plain JSON copies.
const J = v => JSON.parse(JSON.stringify(v));
const eq = (a, b, msg) => assert.deepStrictEqual(J(a), b, msg);
function sandbox(src, names, ctx) {
  vm.createContext(ctx);
  vm.runInContext(names.map(n => extractFunction(src, n)).join('\n'), ctx);
  return ctx;
}

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok  ${name}`); }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; }
}

const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const S = { allowances: { lateNightThreshold1Hour: 19, lateNightThreshold2Hour: 20, earlyThreshold1Min: 450, earlyThreshold2Min: 390 } };
const DEP_FNS = ['timeCorrectionDependents', 'lateNightCheckoutMins', 'lateNightCheckoutOk', 'isDeviceScanSource', 'parseHHMMToMins'];
const sides = () => [['client', sandbox(APP_SRC, DEP_FNS, { HHMM_RE })], ['server', sandbox(SERVER_SRC, DEP_FNS, { HHMM_RE })]];

console.log('Fix 4: time-correction revoke -- dependent detection (both sides)');
test('timeCorrectionDependents is identical in both files', () => sameSource('timeCorrectionDependents'));

const THU = '2026-09-17';
const SAT = '2026-09-19';
let id = 100;
const rec = (type, o) => ({ id: id++, userId: 7, status: 'approved', type, dateFrom: o.dateFrom || THU, dateTo: o.dateFrom || THU, ...o });
const corrOut = rec('time-correction', { correctionField: 'checkOut', correctedTime: '21:30' });
const row = o => ({ date: THU, status: 'present', isWeekend: false, isPubHoliday: false, checkIn: '08:20', checkInSource: 'device', checkOutSource: 'device', lastScan: null, ...o });

test('office OT ending after the real check-out depends on a check-out correction; one inside it does not', () => {
  const otLate = rec('ot', { otEndTime: '21:00' });
  const otEarly = rec('ot', { otEndTime: '18:00' });
  const driverOt = rec('ot', { isDriverOT: true, otHours: 3, otMultiplier: 1.5 });
  const other = { ...rec('ot', { otEndTime: '21:00' }), userId: 8 };
  const leaves = [corrOut, otLate, otEarly, driverOt, other];
  for (const [side, X] of sides()) {
    const deps = X.timeCorrectionDependents(corrOut, leaves, row({ checkOut: '21:30' }), row({ checkOut: '18:10' }), S);
    eq(deps.map(l => l.id), [otLate.id], side);
  }
});
test('Late Night: tier check-out, web check-out not allowed, return time later than the real check-out', () => {
  const ln = rec('late-out', { lateOutTime: '20:00' });
  const leaves = [corrOut, ln];
  for (const [side, X] of sides()) {
    // real check-out 18:00 < 19:00 -> dependent
    eq(X.timeCorrectionDependents(corrOut, leaves, row({ checkOut: '21:30' }), row({ checkOut: '18:00' }), S).map(l => l.id), [ln.id], side);
    // real check-out 19:30 (device) but the chosen 20:00 return is later -> dependent
    eq(X.timeCorrectionDependents(corrOut, leaves, row({ checkOut: '21:30' }), row({ checkOut: '19:30' }), S).map(l => l.id), [ln.id], side);
    // real check-out 01:30 after midnight (device) -> still valid, not dependent
    eq(X.timeCorrectionDependents(corrOut, leaves, row({ checkOut: '21:30' }), row({ checkOut: '01:30' }), S), [], side);
    // real 21:00 web check-out never allowed -> dependent
    eq(X.timeCorrectionDependents(corrOut, leaves, row({ checkOut: '21:30' }),
      row({ checkOut: '21:00', checkOutSource: 'web', checkOutReview: null }), S).map(l => l.id), [ln.id], side);
  }
});
test('early morning depends on a check-in correction only when the real check-in misses the tier', () => {
  const corrIn = rec('time-correction', { correctionField: 'checkIn', correctedTime: '06:20' });
  const em2 = rec('early-morning', { earlyMorningTier: 2 });
  const leaves = [corrIn, em2];
  for (const [side, X] of sides()) {
    const withRow = row({ checkIn: '06:20', checkOut: '17:40' });
    eq(X.timeCorrectionDependents(corrIn, leaves, withRow, row({ checkIn: '07:10', checkOut: '17:40' }), S).map(l => l.id), [em2.id], side);
    eq(X.timeCorrectionDependents(corrIn, leaves, withRow, row({ checkIn: '06:25', checkOut: '17:40' }), S), [], side);
    eq(X.timeCorrectionDependents(corrIn, leaves, withRow, row({ checkIn: null, checkOut: '17:40' }), S).map(l => l.id), [em2.id], side);
  }
});
test('a record already invalid WITH the correction is not blamed on it', () => {
  const otTooLate = rec('ot', { otEndTime: '23:00' }); // later than even the corrected 21:30
  for (const [side, X] of sides()) {
    eq(X.timeCorrectionDependents(corrOut, [corrOut, otTooLate], row({ checkOut: '21:30' }), row({ checkOut: '18:00' }), S), [], side);
  }
});
test('Holiday Work on a rest day takes that day\'s Late Night / early-morning claims with it', () => {
  const corrSat = rec('time-correction', { dateFrom: SAT, correctionField: 'checkOut', correctedTime: '22:00' });
  const hw = rec('holiday-work', { dateFrom: SAT, workStartTime: '09:00', workEndTime: '21:00', compensationMode: 'paid' });
  const ln = rec('late-out', { dateFrom: SAT, lateOutTime: '19:00' });
  const em = rec('early-morning', { dateFrom: SAT, earlyMorningTier: 1 });
  const leaves = [corrSat, hw, ln, em];
  const r = o => row({ date: SAT, isWeekend: true, status: 'weekend', checkIn: '07:00', ...o });
  for (const [side, X] of sides()) {
    // Without the correction the real check-out is 19:30: HW (ends 21:00) fails; the 19:00 Late
    // Night alone would still pass, but it loses its Holiday Work prerequisite -> revoked too.
    const deps = X.timeCorrectionDependents(corrSat, leaves, r({ checkOut: '22:00' }), r({ checkOut: '19:30' }), S);
    eq(deps.map(l => l.id).sort(), [hw.id, ln.id, em.id].sort(), side);
  }
});
test('approved Abroad day needs no scans -> OT / Holiday Work are never dependents; void records ignored', () => {
  const ot = rec('ot', { otEndTime: '21:00' });
  const cancelled = { ...rec('ot', { otEndTime: '21:00' }), status: 'cancelled' };
  for (const [side, X] of sides()) {
    eq(X.timeCorrectionDependents(corrOut, [corrOut, ot, cancelled], row({ checkOut: '21:30', status: 'abroad' }),
      row({ checkOut: null, checkIn: null, status: 'abroad' }), S), [], side);
    eq(X.timeCorrectionDependents(corrOut, [corrOut, cancelled], row({ checkOut: '21:30' }), row({ checkOut: '18:00' }), S), [], side);
    eq(X.timeCorrectionDependents(ot, [corrOut, ot], row({}), row({}), S), [], `${side}: not a time-correction`);
  }
});
test('no check-out at all: the last scan is the end limit (scanWindowError fallback)', () => {
  const ot = rec('ot', { otEndTime: '19:00' });
  for (const [side, X] of sides()) {
    eq(X.timeCorrectionDependents(corrOut, [corrOut, ot], row({ checkOut: '21:30' }), row({ checkOut: null, lastScan: '19:15' }), S), [], side);
    eq(X.timeCorrectionDependents(corrOut, [corrOut, ot], row({ checkOut: '21:30' }), row({ checkOut: null, lastScan: null }), S).map(l => l.id), [ot.id], side);
  }
});
test('server revoke: one write, revokedWith, same guards per dependent, dependentIds cross-check (static)', () => {
  const route = SERVER_SRC.slice(SERVER_SRC.indexOf("app.post('/api/leaves/:id/revoke'"));
  const body = route.slice(0, route.indexOf('\n}));'));
  assert.strictEqual((body.match(/saveLeaves\(leaves\)/g) || []).length, 1, 'exactly one leaves write');
  assert.ok(/revokedWith: leave\.id/.test(body));
  assert.ok(/timeCorrectionDependents\(leave, leaves, dayWith, dayWithout, getAppSettings\(\)\)/.test(body));
  for (const g of ['mdApprovedPeriodInRange(dep.dateFrom', 'lockedPeriodInRange(dep.dateFrom', 'accountingConfirmedInRange(dep.dateFrom', 'earnedDayUsedError(leaves, ownerUser, dep)']) {
    assert.ok(body.includes(g), g);
  }
  assert.ok(body.includes("code:'revoke-dependents-changed'"));
  assert.ok(body.includes('sendResultEmail(leaves[idx], undefined, undefined, alsoRevoked)'));
  assert.ok(body.includes('notifyMdsOfAccountingRevoke(live, ownerUser, [leaves[idx], ...alsoRevoked], reason)'));
});

console.log('Fix 6: Company Trip save guard');
test('companyTripConflicts is identical in both files', () => sameSource('companyTripConflicts'));
test('approved money records on newly added dates conflict; pending / void / other types do not', () => {
  const L = (type, dateFrom, dateTo, status = 'approved', userId = 1) => ({ id: id++, userId, type, dateFrom, dateTo: dateTo || dateFrom, status });
  const leaves = [
    L('holiday-work', '2026-11-28'), L('ot', '2026-11-27', null, 'approved', 2), L('abroad', '2026-11-25', '2026-11-30', 'approved', 3),
    L('early-morning', '2026-11-27', null, 'pending-md'), L('late-out', '2026-11-27', null, 'revoked'), L('upcountry', '2026-11-27', null, 'cancelled'),
    L('annual', '2026-11-27'), L('personal-car', '2026-12-05'),
  ];
  for (const [side, src] of [['client', APP_SRC], ['server', SERVER_SRC]]) {
    const X = sandbox(src, ['companyTripConflicts'], {});
    const got = X.companyTripConflicts(leaves, ['2026-11-28', '2026-11-27', '2026-11-27']);
    eq(got.map(c => [c.date, c.userId, c.type]), [
      ['2026-11-27', 2, 'ot'], ['2026-11-27', 3, 'abroad'], ['2026-11-28', 1, 'holiday-work'], ['2026-11-28', 3, 'abroad']], side);
    eq(X.companyTripConflicts(leaves, ['2026-12-01']), [], side);
    eq(X.companyTripConflicts(leaves, []), [], side);
    eq(X.companyTripConflicts(leaves, ['garbage']), [], side);
  }
});
test('server checks only NEWLY ADDED dates (removals and pre-existing dates never blocked) (static)', () => {
  assert.ok(/const addedTrip = cd\.filter\(d => !beforeTrip\.has\(d\)\);/.test(SERVER_SRC));
  assert.ok(/companyTripConflicts\(tripLeaves, addedTrip\)/.test(SERVER_SRC));
  assert.ok(SERVER_SRC.includes("code: 'company-trip-conflict'"));
  assert.ok(/const localConflicts = companyTripConflicts\(DATA_LEAVES, newDates\);/.test(APP_SRC), 'client pre-check on the new dates');
});

console.log('Fix 13: Accounting revoke -> push to every active MD');
test('only Accounting revokes notify; every active MD gets one push with employee, types, dates, revoker, reason', () => {
  const sent = [];
  const users = [{ id: 1, role: 'md', active: true, name: 'M1' }, { id: 2, role: 'md', active: false, name: 'M2' },
    { id: 3, role: 'md', name: 'M3' }, { id: 4, role: 'accounting', name: 'Acc' }, { id: 5, role: 'user', name: 'Emp' }];
  const X = sandbox(SERVER_SRC, ['accountingRevokeMdPushBody', 'notifyMdsOfAccountingRevoke'], {
    readUsers: () => users, sendPushToUser: (uid, p) => { sent.push([uid, p]); return Promise.resolve(); },
    badgeCountForUser: () => 0, getTypeLabel: t => ({ 'time-correction': 'Time Correction', ot: 'OT' })[t] || t, console,
  });
  const recs = [{ type: 'time-correction', userId: 5, dateFrom: THU, dateTo: THU }, { type: 'ot', userId: 5, dateFrom: THU, dateTo: THU }];
  X.notifyMdsOfAccountingRevoke(users[3], users[4], recs, 'wrong time');
  assert.deepStrictEqual(sent.map(s => s[0]), [1, 3]);
  const body = sent[0][1].body;
  for (const part of ['Acc', 'Emp', 'Time Correction (2026-09-17)', 'OT (2026-09-17)', 'wrong time']) assert.ok(body.includes(part), part);
  sent.length = 0;
  X.notifyMdsOfAccountingRevoke({ id: 1, role: 'md', name: 'M1' }, users[4], recs, '');
  assert.strictEqual(sent.length, 0, 'an MD revoke does not notify');
});

console.log('Fix 14: colleagues\' cancelled / revoked records hidden from plain users');
test('leaveVisibleToViewer: owner and full-access see everything; plain users do not see colleagues\' void records', () => {
  const X = sandbox(SERVER_SRC, ['isHiddenFromColleaguesStatus', 'leaveVisibleToViewer'], {});
  const own = { userId: 1, status: 'revoked' }, colRev = { userId: 2, status: 'revoked' }, colCan = { userId: 2, status: 'cancelled' };
  const colRej = { userId: 2, status: 'rejected' }, colOk = { userId: 2, status: 'approved' };
  assert.strictEqual(X.leaveVisibleToViewer(own, 1, false), true);
  assert.strictEqual(X.leaveVisibleToViewer(colRev, 1, false), false);
  assert.strictEqual(X.leaveVisibleToViewer(colCan, 1, false), false);
  assert.strictEqual(X.leaveVisibleToViewer(colRej, 1, false), true);
  assert.strictEqual(X.leaveVisibleToViewer(colOk, 1, false), true);
  assert.strictEqual(X.leaveVisibleToViewer(colRev, 1, true), true);
});
test('broadcastLeaveUpdated: plain colleague sockets get LEAVE_DELETED {id} only; owner / managers get the projection', () => {
  const mk = ctx => ({ readyState: 1, viewerCtx: ctx, got: [], send(m) { this.got.push(JSON.parse(m)); } });
  const owner = mk({ userId: 5, leaveFullAccess: false }), colleague = mk({ userId: 6, leaveFullAccess: false });
  const manager = mk({ userId: 9, leaveFullAccess: true }), anon = mk(null);
  const X = sandbox(SERVER_SRC, ['isHiddenFromColleaguesStatus', 'leaveVisibleToViewer', 'broadcastLeaveUpdated', 'toPublicLeaveProjection'], {
    clients: new Set([owner, colleague, manager, anon]), refreshWsViewers: () => {},
    PUBLIC_LEAVE_FIELDS: ['id', 'userId', 'type', 'status', 'dateFrom', 'dateTo', 'days', 'hourlyStart', 'hourlyEnd'],
  });
  X.broadcastLeaveUpdated({ id: 42, userId: 5, type: 'ot', status: 'revoked', dateFrom: THU, reason: 'secret', revokeReason: 'x' });
  assert.deepStrictEqual(colleague.got, [{ type: 'LEAVE_DELETED', id: 42 }]);
  assert.deepStrictEqual(anon.got, [{ type: 'LEAVE_DELETED', id: 42 }]);
  for (const ws of [owner, manager]) {
    assert.strictEqual(ws.got[0].type, 'LEAVE_UPDATED');
    assert.strictEqual(ws.got[0].leave.status, 'revoked');
    assert.strictEqual(ws.got[0].leave.reason, undefined, 'still the public projection');
  }
  X.broadcastLeaveUpdated({ id: 43, userId: 5, type: 'ot', status: 'approved', dateFrom: THU });
  assert.strictEqual(colleague.got[1].type, 'LEAVE_UPDATED', 'non-void updates still reach colleagues');
});
test('GET /api/leaves filters plain users; no raw LEAVE_UPDATED broadcast left (static)', () => {
  assert.ok(/leaves\.filter\(l => leaveVisibleToViewer\(l, live\.id, false\)\)/.test(SERVER_SRC));
  assert.strictEqual((SERVER_SRC.match(/type: 'LEAVE_UPDATED'/g) || []).length, 1, 'only inside broadcastLeaveUpdated');
  assert.ok(/isWithdrawnLeaveStatus\(data\.leave\?\.status\) && !seesAllLeaves/.test(APP_SRC), 'client drops a colleague\'s void record');
});

console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ', 0 failed'}`);
