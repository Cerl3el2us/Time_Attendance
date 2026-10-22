// Driver OT in the approval card view is one card per DAY (2026-10-22, owner).
//
// A driver files OT per rate, so one Saturday with 8 hours at ×2 and 2 hours at ×3 is two records
// and was therefore two approval cards, each saying only its own slice. The owner's words:
// "ไม่ควรแยกเป็น x2 x3 แบบนี้ ควรจะเป็นวันสิ แต่ระบุเป็นว่าวันนั้นยื่นขอ x2 และ x3 มากี่ชั่วโมง แล้ว
// approve ทีเดียวเป็นวันๆ".
//
// Nothing about the stored data changes -- the rates must stay separate records because they are
// paid at different rates. Only the card view groups them, which is why the whole decision lives
// in one pure function and is tested here rather than through the DOM.
//
// The rules that matter:
//   - only driver OT groups. A regular employee's OT cannot repeat on a date anyway, and grouping
//     it would be a silent behaviour change on a path nobody asked about;
//   - grouping is per employee AND per date AND per status: a card acts on everything it shows,
//     so two records that are not in the same state must never sit under one button;
//   - a day with a single rate stays exactly the card it is today;
//   - the order of the list does not jump around: a group takes the position of its first record.
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const APP_SRC = fs.readFileSync(path.join(ROOT, 'attendance/js/app.js'), 'utf8');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok ', name); }
  catch (e) { process.exitCode = 1; console.log('  FAIL', name, '\n      ', e.message); }
}

function topLevelFn(src, name) {
  const a = src.indexOf('function ' + name + '(');
  assert.ok(a > 0, 'function ' + name + ' not found in app.js');
  const b = src.indexOf('\n}', a);
  assert.ok(b > a, 'end of ' + name + ' not found');
  return src.slice(a, b + 2);
}

const USERS = [
  { id: 1, name: 'Driver A', role: 'driver' },
  { id: 2, name: 'Driver B', role: 'driver' },
  { id: 3, name: 'Office C', role: 'user' },
];

function sandbox() {
  const ctx = {
    DATA_USERS: USERS,
    // the real multiplier helper reads holiday settings; the grouping only needs the stored rate,
    // and pinning it here keeps this suite about grouping
    effectiveOtMultiplier: l => Number(l.otMultiplier) || 1.5,
  };
  vm.createContext(ctx);
  vm.runInContext(topLevelFn(APP_SRC, 'isDriverOtLeave') + topLevelFn(APP_SRC, 'groupApprovalItems'), ctx);
  return ctx;
}

let nextId = 100;
const ot = (o) => ({ id: nextId++, type: 'ot', status: 'pending-accounting', isDriverOT: true,
  userId: 1, dateFrom: '2026-10-18', dateTo: '2026-10-18', otHours: 2, otMultiplier: 2, ...o });

test('two rates on the same day for the same driver become one day entry', () => {
  const s = sandbox();
  const a = ot({ otMultiplier: 3, otHours: 2 });
  const b = ot({ otMultiplier: 2, otHours: 8 });
  const items = s.groupApprovalItems([a, b]);
  assert.strictEqual(items.length, 1, JSON.stringify(items.map(i => i.kind)));
  assert.strictEqual(items[0].kind, 'day');
  assert.strictEqual(items[0].leaves.length, 2);
  assert.strictEqual(items[0].totalHours, 10);
  // the rates read low to high, so the card does not reorder itself between renders.
  // (joined, not deepStrictEqual: an array built inside the vm context has that context's own
  // Array.prototype, which deepStrictEqual rejects on the prototype check alone.)
  assert.strictEqual(items[0].tiers.map(t => t.multiplier).join(','), '2,3');
  assert.strictEqual(items[0].tiers.map(t => t.hours).join(','), '8,2');
  assert.strictEqual(items[0].userId, 1);
  assert.strictEqual(items[0].dateFrom, '2026-10-18');
});

test('a day with one rate is left as the single card it is today', () => {
  const s = sandbox();
  const only = ot({});
  const items = s.groupApprovalItems([only]);
  assert.strictEqual(items.length, 1);
  assert.strictEqual(items[0].kind, 'single');
  assert.strictEqual(items[0].leave.id, only.id);
});

test('different days, different drivers and different statuses never share a card', () => {
  const s = sandbox();
  const sameDay = ot({ otMultiplier: 2 });
  const otherDay = ot({ otMultiplier: 3, dateFrom: '2026-10-19', dateTo: '2026-10-19' });
  const otherDriver = ot({ otMultiplier: 3, userId: 2 });
  const otherStatus = ot({ otMultiplier: 3, status: 'pending-md' });
  const items = s.groupApprovalItems([sameDay, otherDay, otherDriver, otherStatus]);
  assert.strictEqual(items.length, 4, items.map(i => i.kind).join(','));
  assert.ok(items.every(i => i.kind === 'single'));
});

test('a regular employee OT is never grouped, even on the same date', () => {
  const s = sandbox();
  const a = { id: 900, type: 'ot', status: 'pending-md', userId: 3, dateFrom: '2026-10-18', dateTo: '2026-10-18', otHours: 2, otMultiplier: 1.5 };
  const b = { ...a, id: 901, otMultiplier: 2 };
  const items = s.groupApprovalItems([a, b]);
  assert.strictEqual(items.length, 2);
  assert.ok(items.every(i => i.kind === 'single'));
});

test('the driver is recognised by the record flag OR by the employee role', () => {
  const s = sandbox();
  // flag set, role not a driver
  const flagged = ot({ userId: 3, isDriverOT: true, otMultiplier: 2 });
  const flagged2 = ot({ userId: 3, isDriverOT: true, otMultiplier: 3 });
  assert.strictEqual(s.groupApprovalItems([flagged, flagged2]).length, 1);
  // role is a driver, flag missing (older records)
  const byRole = ot({ userId: 1, isDriverOT: undefined, otMultiplier: 2 });
  const byRole2 = ot({ userId: 1, isDriverOT: undefined, otMultiplier: 3 });
  assert.strictEqual(s.groupApprovalItems([byRole, byRole2]).length, 1);
});

test('other request types pass through untouched, and the order never jumps', () => {
  const s = sandbox();
  const leave = { id: 500, type: 'annual', status: 'pending', userId: 1, dateFrom: '2026-10-18' };
  const d1 = ot({ otMultiplier: 2 });
  const upcountry = { id: 501, type: 'upcountry', status: 'pending', userId: 1, dateFrom: '2026-10-18' };
  const d2 = ot({ otMultiplier: 3 });
  const items = s.groupApprovalItems([leave, d1, upcountry, d2]);
  // the group takes the position of its FIRST record, so the list reads in the same order
  assert.strictEqual(items.map(i => i.kind).join(','), 'single,day,single');
  assert.strictEqual(items[0].leave.id, 500);
  assert.strictEqual(items[1].leaves.length, 2);
  assert.strictEqual(items[2].leave.id, 501);
});

test('hours that are missing or not numbers do not poison the total', () => {
  const s = sandbox();
  const a = ot({ otMultiplier: 2, otHours: undefined });
  const b = ot({ otMultiplier: 3, otHours: '3' });
  const items = s.groupApprovalItems([a, b]);
  assert.strictEqual(items[0].kind, 'day');
  assert.strictEqual(items[0].totalHours, 3);
});

// ---- Quick Mode (2026-10-22, owner: "อย่าลืมทำส่วนนี้ด้วย ไม่ให้แยกกัน") ----
// The table groups like the cards do. Two things have to follow, or the table would contradict the
// decision the cards already implement:
//   - one row per day needs one line of text that says every rate AND the day's total;
//   - a day selected by its checkbox must be rejected under ONE reason, not asked once per rate,
//     which is what the batch path would do if it still walked raw record ids.
function sandbox2() {
  const ctx = {
    DATA_USERS: USERS,
    DATA_LEAVES: [],
    effectiveOtMultiplier: l => Number(l.otMultiplier) || 1.5,
    L: (en) => en,
    currentLang: 'en',
    otMultiplierLabel: m => Number(m) === 3 ? '×3 (Holiday)' : Number(m) === 2 ? '×2 (Holiday)' : '×1.5 (Weekday)',
  };
  vm.createContext(ctx);
  vm.runInContext(
    topLevelFn(APP_SRC, 'isDriverOtLeave')
    + topLevelFn(APP_SRC, 'groupApprovalItems')
    + topLevelFn(APP_SRC, 'driverOtDayDetailText')
    + topLevelFn(APP_SRC, 'groupSelectedForReject'),
    ctx);
  return ctx;
}

test('a day row states every rate and the day total in one line', () => {
  const s = sandbox2();
  const group = s.groupApprovalItems([ot({ otMultiplier: 3, otHours: 2 }), ot({ otMultiplier: 2, otHours: 8 })])[0];
  const text = s.driverOtDayDetailText(group);
  assert.ok(/×2/.test(text) && /8/.test(text), text);
  assert.ok(/×3/.test(text) && /\b2\b/.test(text), text);
  assert.ok(/10/.test(text), 'the day total is missing: ' + text);
});

test('selecting a day rejects it under one reason, not one per rate', () => {
  const s = sandbox2();
  const a = ot({ otMultiplier: 2, otHours: 8 });
  const b = ot({ otMultiplier: 3, otHours: 2 });
  const other = ot({ otMultiplier: 2, dateFrom: '2026-10-19', dateTo: '2026-10-19' });
  const leave = { id: 777, type: 'annual', status: 'pending', userId: 1, dateFrom: '2026-10-18' };
  s.DATA_LEAVES.push(a, b, other, leave);

  const asked = s.groupSelectedForReject([a.id, b.id, other.id, leave.id]);
  // three questions for four records: the two rates of the 18th are one
  assert.strictEqual(asked.length, 3, JSON.stringify(asked));
  const sizes = asked.map(g => g.length).sort().join(',');
  assert.strictEqual(sizes, '1,1,2', JSON.stringify(asked));
  const pair = asked.find(g => g.length === 2);
  assert.strictEqual([...pair].sort((x, y) => x - y).join(','), [a.id, b.id].sort((x, y) => x - y).join(','));
});

test('an id that no longer exists is dropped instead of asking about nothing', () => {
  const s = sandbox2();
  const a = ot({ otMultiplier: 2 });
  s.DATA_LEAVES.push(a);
  const asked = s.groupSelectedForReject([a.id, 999999]);
  assert.strictEqual(asked.length, 1);
  assert.strictEqual(asked[0].length, 1);
});

// ---- the one-line summary the read-only lists show (2026-10-22, owner) ----
// "อยากให้ show details มากกว่านี้ด้วย ไม่ใช่แค่ต้องกดเท่านั้น": the info boxes and the approval
// history showed a name, a date and a badge, so a row said nothing about what was requested until
// it was opened. One function now produces that line for every list, including Quick Mode, so the
// four places cannot drift into saying different things about the same record.
function sandbox3() {
  const ctx = {
    DATA_USERS: USERS,
    DATA_LEAVES: [],
    effectiveOtMultiplier: l => Number(l.otMultiplier) || 1.5,
    L: (en) => en,
    currentLang: 'en',
    otMultiplierLabel: m => Number(m) === 3 ? '×3 (Holiday)' : Number(m) === 2 ? '×2 (Holiday)' : '×1.5 (Weekday)',
    otHoursRateDetail: l => `${l.otHours} h ${Number(l.otMultiplier) === 3 ? '×3' : '×2'}`,
    formatTimePart: l => l.timePart || '',
  };
  vm.createContext(ctx);
  vm.runInContext(
    topLevelFn(APP_SRC, 'isDriverOtLeave')
    + topLevelFn(APP_SRC, 'groupApprovalItems')
    + topLevelFn(APP_SRC, 'driverOtDayDetailText')
    + topLevelFn(APP_SRC, 'approvalSummaryText'),
    ctx);
  return ctx;
}

test('a driver day summarises every rate and the total', () => {
  const s = sandbox3();
  const group = s.groupApprovalItems([ot({ otMultiplier: 2, otHours: 8 }), ot({ otMultiplier: 3, otHours: 2 })])[0];
  const text = s.approvalSummaryText(group);
  assert.ok(/×2/.test(text) && /×3/.test(text) && /10/.test(text), text);
});

test('a leave counted in days says the days', () => {
  const s = sandbox3();
  const item = { kind: 'single', leave: { id: 1, type: 'annual', days: 2, userId: 1, dateFrom: '2026-10-18' } };
  assert.ok(/2/.test(s.approvalSummaryText(item)) && /day/i.test(s.approvalSummaryText(item)), s.approvalSummaryText(item));
});

test('a single OT keeps the hours-and-rate wording the rest of the app uses', () => {
  const s = sandbox3();
  const item = { kind: 'single', leave: { id: 2, type: 'ot', otHours: 3, otMultiplier: 3, userId: 1, dateFrom: '2026-10-18' } };
  assert.strictEqual(s.approvalSummaryText(item), '3 h ×3');
});

test('long distance says the mileage and the distance', () => {
  const s = sandbox3();
  const item = { kind: 'single', leave: { id: 3, type: 'long-distance', mileageStart: 1000, mileageEnd: 1180, distanceKm: 180, userId: 1, dateFrom: '2026-10-18' } };
  const text = s.approvalSummaryText(item);
  assert.ok(/1,000/.test(text) && /1,180/.test(text) && /180/.test(text), text);
});

test('a request with nothing to measure never renders as blank', () => {
  const s = sandbox3();
  const withReason = { kind: 'single', leave: { id: 4, type: 'upcountry', reason: 'ไปหาลูกค้า', userId: 1, dateFrom: '2026-10-18' } };
  assert.strictEqual(s.approvalSummaryText(withReason), 'ไปหาลูกค้า');
  const empty = { kind: 'single', leave: { id: 5, type: 'upcountry', userId: 1, dateFrom: '2026-10-18' } };
  assert.strictEqual(s.approvalSummaryText(empty), '—');
});

// ---- My Requests: filter by category (2026-10-22, owner) ----
// "อยากให้มีปุ่มที่สามารถคลิกดูเฉพาะหมวดได้เช่น all upcountry": the page lists every request the
// employee has ever filed, with no limit, so finding their upcountry history meant scrolling past
// everything else. The buttons are built from what the person actually has -- a category with
// nothing in it would be a dead end -- and a stale selection falls back to showing everything
// rather than an empty page.
function sandbox4() {
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(
    topLevelFn(APP_SRC, 'myRequestsTypeCounts') + topLevelFn(APP_SRC, 'filterMyRequests'),
    ctx);
  return ctx;
}
const REQS = [
  { id: 1, type: 'upcountry' }, { id: 2, type: 'upcountry' }, { id: 3, type: 'upcountry' },
  { id: 4, type: 'ot' }, { id: 5, type: 'ot' },
  { id: 6, type: 'late-out' },
];

test('the buttons are the categories this person actually has, busiest first', () => {
  const s = sandbox4();
  const counts = s.myRequestsTypeCounts(REQS);
  assert.strictEqual(counts.map(c => c.type + ':' + c.count).join(','), 'upcountry:3,ot:2,late-out:1');
  // a category nobody filed is not offered
  assert.ok(!counts.some(c => c.type === 'holiday-work'));
});

test('an empty list offers no buttons rather than throwing', () => {
  const s = sandbox4();
  assert.strictEqual(s.myRequestsTypeCounts([]).length, 0);
  assert.strictEqual(s.myRequestsTypeCounts(undefined).length, 0);
});

test('picking a category shows only it, and "all" shows everything', () => {
  const s = sandbox4();
  assert.strictEqual(s.filterMyRequests(REQS, 'upcountry').length, 3);
  assert.strictEqual(s.filterMyRequests(REQS, 'ot').length, 2);
  assert.strictEqual(s.filterMyRequests(REQS, 'all').length, 6);
  assert.strictEqual(s.filterMyRequests(REQS, null).length, 6);
});

test('a selection that no longer matches anything falls back to everything', () => {
  const s = sandbox4();
  assert.strictEqual(s.filterMyRequests(REQS, 'personal-car').length, 6);
});

// ---- approval history buckets (2026-10-22, owner asked whether rejections are kept here) ----
// They are kept, but the list shows only the newest 20 decided records and production already
// has 66, so the single rejection sat at position 27 and could never appear. Filtering happens
// BEFORE that window, or picking "rejected" would still show nothing.
function sandbox5() {
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(topLevelFn(APP_SRC, 'isVoidLeaveStatus') + topLevelFn(APP_SRC, 'isWithdrawnLeaveStatus')
    + topLevelFn(APP_SRC, 'decidedOutcomeCounts') + topLevelFn(APP_SRC, 'filterDecidedByOutcome'), ctx);
  return ctx;
}
const DECIDED = [{ id: 9, status: 'approved' }, { id: 8, status: 'approved' }, { id: 7, status: 'rejected' },
  { id: 6, status: 'cancelled' }, { id: 5, status: 'revoked' }];

test('the history counts each outcome, and zero is still reported', () => {
  const s = sandbox5();
  const c = s.decidedOutcomeCounts(DECIDED);
  assert.strictEqual(c.all, 5);
  assert.strictEqual(c.approved, 2);
  assert.strictEqual(c.rejected, 1);
  assert.strictEqual(c.withdrawn, 2, JSON.stringify(c));
  const empty = s.decidedOutcomeCounts([]);
  assert.strictEqual(empty.all, 0);
  assert.strictEqual(empty.rejected, 0);
});

test('each bucket returns its own records, and an unknown bucket shows everything', () => {
  const s = sandbox5();
  assert.strictEqual(s.filterDecidedByOutcome(DECIDED, 'rejected').map(l => l.id).join(','), '7');
  assert.strictEqual(s.filterDecidedByOutcome(DECIDED, 'approved').map(l => l.id).join(','), '9,8');
  assert.strictEqual(s.filterDecidedByOutcome(DECIDED, 'withdrawn').map(l => l.id).join(','), '6,5');
  assert.strictEqual(s.filterDecidedByOutcome(DECIDED, 'all').length, 5);
  assert.strictEqual(s.filterDecidedByOutcome(DECIDED, 'nonsense').length, 5);
});

console.log(`driver-ot-day-grouping: ${passed} passed`);
