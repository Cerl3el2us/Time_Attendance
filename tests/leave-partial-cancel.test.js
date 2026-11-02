// Partial cancellation of an approved leave (2026-11-02, owner's request): an employee may give
// back the days of an approved annual/sick/business leave that have not arrived yet. The record's
// dateTo shrinks and the cancelled tail becomes its own 'cancelled' row (cancelledWith -> the
// original). No framework: `node tests/leave-partial-cancel.test.js`. Same extraction approach as
// tests/cancel-revoke.test.js: real functions from both sources in a vm sandbox.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const APP_SRC = fs.readFileSync(path.join(ROOT, 'attendance/js/app.js'), 'utf8');
const SERVER_SRC = fs.readFileSync(path.join(ROOT, 'attendance-server/backend/server.js'), 'utf8');

function extractFunction(src, name) {
  const re = new RegExp(`^(async )?function ${name}\\(`, 'm');
  const m = re.exec(src);
  if (!m) throw new Error(`function ${name} not found`);
  const i = src.indexOf(') {', m.index) + 2;
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (depth === 0) return src.slice(m.index, j + 1); }
  }
  throw new Error(`unbalanced ${name}`);
}

// 2026-11-02: one public holiday inside the window on purpose -- a plain weekday count would
// pass every assertion below without ever exercising the holiday skip.
const HOLIDAYS = new Set(['2026-11-04']);
const localDateStr = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

function makeClientDays() {
  const ctx = { isPublicHoliday: s => HOLIDAYS.has(s), localDateStr };
  vm.createContext(ctx);
  vm.runInContext(extractFunction(APP_SRC, 'deriveLeaveDaysCount'), ctx);
  return ctx;
}
function makeServerDays() {
  const ctx = { isPublicHoliday: s => HOLIDAYS.has(s), ta_localDateStr: localDateStr };
  vm.createContext(ctx);
  vm.runInContext(extractFunction(SERVER_SRC, 'deriveLeaveDaysCount'), ctx);
  return ctx;
}

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok  ${name}`); }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; }
}

console.log('day counter: one function, both sides');
test('client and server count the same working days for every range', () => {
  const C = makeClientDays(), S = makeServerDays();
  const ranges = [
    ['2026-10-30', '2026-11-05'],  // Fri..Thu, spans a weekend and the 04 holiday
    ['2026-10-30', '2026-11-02'],  // the kept half of the owner's real case
    ['2026-11-03', '2026-11-05'],  // the cancelled half
    ['2026-10-31', '2026-11-01'],  // Sat..Sun only -> 0
    ['2026-11-04', '2026-11-04'],  // the holiday alone -> 0
    ['2026-11-03', '2026-11-03'],  // a single plain weekday -> 1
  ];
  for (const [from, to] of ranges) {
    assert.strictEqual(C.deriveLeaveDaysCount(from, to), S.deriveLeaveDaysCount(from, to), `${from}..${to}`);
  }
});
test('expected counts (weekend and the 04 holiday both skipped)', () => {
  const C = makeClientDays();
  assert.strictEqual(C.deriveLeaveDaysCount('2026-10-30', '2026-11-05'), 4); // 30, 02, 03, 05
  assert.strictEqual(C.deriveLeaveDaysCount('2026-10-30', '2026-11-02'), 2); // 30, 02
  assert.strictEqual(C.deriveLeaveDaysCount('2026-11-03', '2026-11-05'), 2); // 03, 05
  assert.strictEqual(C.deriveLeaveDaysCount('2026-10-31', '2026-11-01'), 0);
  assert.strictEqual(C.deriveLeaveDaysCount('2026-11-04', '2026-11-04'), 0);
});
test('a missing dateTo counts the single dateFrom', () => {
  const C = makeClientDays();
  assert.strictEqual(C.deriveLeaveDaysCount('2026-11-03', ''), 1);
  assert.strictEqual(C.deriveLeaveDaysCount('2026-11-03', undefined), 1);
});
test('submitLeave() uses the helper instead of keeping its own copy of the loop', () => {
  const i = APP_SRC.indexOf('async function submitLeave()');
  assert.ok(i > 0, 'submitLeave not found');
  const body = APP_SRC.slice(i, APP_SRC.indexOf('\nasync function ', i + 10));
  assert.ok(body.includes('deriveLeaveDaysCount('), 'submitLeave must call the shared helper');
  assert.ok(!/while \(d <= end\)/.test(body), 'the inline day-count loop must be gone from submitLeave');
});

function makePredicate(src, extra) {
  const ctx = Object.assign({
    DAY_BASED_LEAVE_TYPES: new Set(['annual', 'sick', 'business']),
    bangkokDateStr: () => '2026-11-02',
    isValidDateStr: s => /^\d{4}-\d{2}-\d{2}$/.test(s),
  }, extra || {});
  vm.createContext(ctx);
  vm.runInContext(extractFunction(src, 'isShortenableApprovedLeave'), ctx);
  return ctx;
}
const bothPredicate = () => [['client', makePredicate(APP_SRC)], ['server', makePredicate(SERVER_SRC)]];
const SICK = { id: 7, userId: 1, type: 'sick', status: 'approved', dateFrom: '2026-10-30', dateTo: '2026-11-05', days: 4 };

console.log('shortenable predicate: both sides agree');
test("the owner's real case is shortenable on 2026-11-02", () => {
  for (const [side, X] of bothPredicate()) {
    assert.strictEqual(X.isShortenableApprovedLeave(SICK, '2026-11-02'), true, side);
  }
});
test('a leave whose last day has passed is not shortenable', () => {
  for (const [side, X] of bothPredicate()) {
    assert.strictEqual(X.isShortenableApprovedLeave(SICK, '2026-11-05'), false, side + ' last day');
    assert.strictEqual(X.isShortenableApprovedLeave(SICK, '2026-11-09'), false, side + ' after');
  }
});
test('single-day, hourly, non-approved and out-of-scope types are not shortenable', () => {
  for (const [side, X] of bothPredicate()) {
    const no = (over, why) => assert.strictEqual(
      X.isShortenableApprovedLeave({ ...SICK, ...over }, '2026-11-02'), false, `${side} ${why}`);
    no({ dateTo: '2026-10-30' }, 'single day');
    no({ dateTo: undefined }, 'no dateTo');
    no({ hourlyStart: '09:00', hourlyEnd: '12:00' }, 'hourly mode');
    no({ status: 'pending' }, 'pending');
    no({ status: 'cancelled' }, 'already cancelled');
    no({ status: 'revoked' }, 'already revoked');
    no({ type: 'abroad' }, 'abroad is out of scope this round');
    no({ type: 'holiday-work' }, 'holiday-work is out of scope');
    no({ dateFrom: 'nope' }, 'malformed dateFrom');
    assert.strictEqual(X.isShortenableApprovedLeave(null, '2026-11-02'), false, side + ' null');
  }
});
test('a leave entirely in the future is shortenable too (not only one already running)', () => {
  for (const [side, X] of bothPredicate()) {
    assert.strictEqual(X.isShortenableApprovedLeave(
      { ...SICK, dateFrom: '2026-12-01', dateTo: '2026-12-04' }, '2026-11-02'), true, side);
  }
});
test('both copies carry the DUAL-SYNC note', () => {
  for (const [name, src] of [['app.js', APP_SRC], ['server.js', SERVER_SRC]]) {
    const fn = extractFunction(src, 'isShortenableApprovedLeave');
    // The whole comment block that sits directly above the function, however long it runs --
    // counting characters backwards would silently stop reading once a copy's comment grew.
    const before = src.slice(0, src.indexOf(fn)).split('\n');
    if (before.length && before[before.length - 1].trim() === '') before.pop(); // the newline the function starts after
    const block = [];
    for (let i = before.length - 1; i >= 0 && before[i].trim().startsWith('//'); i--) block.unshift(before[i]);
    assert.ok(block.length, `${name} has no comment above isShortenableApprovedLeave`);
    assert.ok(/DUAL-SYNC|Dual-sync/.test(block.join('\n')), `${name} needs the dual-sync comment`);
  }
});

console.log('shorten route');
function shortenRouteBody() {
  const i = SERVER_SRC.indexOf("app.post('/api/leaves/:id/shorten'");
  assert.ok(i > 0, 'the shorten route does not exist');
  return SERVER_SRC.slice(i, SERVER_SRC.indexOf('\napp.', i + 10));
}
test('the route is wrapped in the leaves lock and fails closed on an unreadable file', () => {
  const body = shortenRouteBody();
  assert.ok(SERVER_SRC.includes("app.post('/api/leaves/:id/shorten', withLeavesLock("), 'must use withLeavesLock');
  assert.ok(body.includes('if (leaves === null) return res.status(503)'), 'must fail closed on a read error');
});
test('only the employee the leave belongs to, never an approver', () => {
  const body = shortenRouteBody();
  assert.ok(body.includes("code:'shorten-not-owner'"), 'needs the not-owner refusal');
  assert.ok(/leave\.userId !== live\.id/.test(body), 'needs the owner check against the live user');
  assert.ok(!SERVER_SRC.includes("app.post('/api/leaves/:id/shorten', requireRole("),
    'this route is for the employee, so it must not be role-gated to md/accounting');
});
test('every guard from the design is present', () => {
  const body = shortenRouteBody();
  ['isShortenableApprovedLeave(leave)', "code:'shorten-bad-date'", "code:'shorten-past'",
   "code:'shorten-whole'", "code:'shorten-after-end'", "code:'shorten-empty-remainder'",
   // 2026-11-02 (same-day review): the mirror of empty-remainder. A request ending on a weekend
   // or holiday can have a tail with no working day at all, which returned nothing and stored a
   // day-mode record with days:0 -- read as HOURLY by leaveMinutesOf().
   "code:'shorten-empty-giveback'",
   'lockedPeriodInRange', 'mdApprovedPeriodInRange', 'accountingConfirmedInRange',
   "code:'period-locked'", "code:'period-frozen'", "code:'period-confirmed'"]
    .forEach(k => assert.ok(body.includes(k), `missing guard: ${k}`));
});
test('both records are written in one save, and the quota snapshot is refreshed', () => {
  const body = shortenRouteBody();
  ['splitLeaveForShorten(leave, returnDate, live)', 'givenBack.id = nextId(leaves)',
   'leaves[idx] = kept', 'leaves.push(givenBack)', 'saveLeaves(leaves)',
   'refreshSnapshottedCarryForward', 'broadcastLeaveUpdated(leaves[idx])']
    .forEach(k => assert.ok(body.includes(k), `missing write step: ${k}`));
  assert.ok(!/status: 'revoked'/.test(body), "the employee's own act is 'cancelled', never 'revoked'");
  // One save only: a half-applied split would leave a record whose days no longer match its range.
  assert.strictEqual((body.match(/saveLeaves\(/g) || []).length, 1, 'exactly one save');
  // The empty-remainder refusal has to come before the first write, or a refused call still
  // mutates the array it was handed.
  assert.ok(body.indexOf("code:'shorten-empty-remainder'") < body.indexOf('leaves[idx] = kept'),
    'the empty-remainder refusal must be checked before anything is written');
  assert.ok(body.indexOf("code:'shorten-empty-giveback'") < body.indexOf('leaves[idx] = kept'),
    'the empty-giveback refusal must be checked before anything is written');
});
// 2026-11-02 (same-day review): the given-back row is born 'cancelled', a status
// isHiddenFromColleaguesStatus() keeps out of a plain user's GET /api/leaves. It used to go out as
// a plain broadcast({type:'LEAVE_CREATED'}) copied from the create route -- whose record is
// pending/approved and therefore visible to colleagues -- so every connected socket was told who
// gave back which days. broadcastLeaveUpdated() asks leaveVisibleToViewer() per socket.
test('the cancelled tail is announced per viewer, never to every socket', () => {
  // Comment lines are stripped first: the note above the fixed call quotes the broken call, and a
  // scan that reads prose as code reports the bug it is standing next to.
  const body = shortenRouteBody().split('\n').filter(line => !line.trim().startsWith('//')).join('\n');
  assert.ok(body.includes('broadcastLeaveUpdated(givenBack)'),
    'the given-back row must be announced through the visibility-aware broadcaster');
  assert.ok(!/broadcast\(\{\s*type:\s*'LEAVE_CREATED'/.test(body),
    "a plain LEAVE_CREATED broadcast sends a colleague's cancelled record to every socket");
});
test('the shorten route never touches the approval fields of the kept record', () => {
  const body = shortenRouteBody();
  [/status:\s*'approved'/, /approver\s*:/, /approvedAt\s*:/].forEach(re =>
    assert.ok(!re.test(body), `must not rewrite the approval: ${re}`));
});

console.log('splitLeaveForShorten: what the route actually writes');
// The real split function, plus the two real minutes helpers the quota is built from, so these
// assertions run the shipped rule rather than a copy of it.
function makeSplit() {
  const ctx = {
    HHMM_RE: /^([01]\d|2[0-3]):[0-5]\d$/,
    isPublicHoliday: s => HOLIDAYS.has(s),
    ta_localDateStr: localDateStr,
    hourlyLeaveChargedMinutes: () => 0, // never reached: every record here is day-mode (days > 0)
  };
  vm.createContext(ctx);
  vm.runInContext([
    extractFunction(SERVER_SRC, 'addDaysToDateStr'),
    extractFunction(SERVER_SRC, 'deriveLeaveDaysCount'),
    extractFunction(SERVER_SRC, 'splitLeaveForShorten'),
    extractFunction(SERVER_SRC, 'leaveMinutesOf'),
    extractFunction(SERVER_SRC, 'isVoidLeaveStatus'),
  ].join('\n'), ctx);
  return ctx;
}
function makeClientMinutes() {
  const ctx = { hourlyLeaveChargedMinutes: () => 0 };
  vm.createContext(ctx);
  vm.runInContext([
    extractFunction(APP_SRC, 'leaveRecordMinutes'),
    extractFunction(APP_SRC, 'isVoidLeaveStatus'),
  ].join('\n'), ctx);
  return ctx;
}
const BY = { id: 1, name: 'Sirintorn' };

test("the owner's real case splits into 30/10-02/11 kept and 03-05/11 given back", () => {
  const S = makeSplit();
  const { kept, givenBack } = S.splitLeaveForShorten(SICK, '2026-11-03', BY, '2026-11-02T03:00:00.000Z');
  assert.strictEqual(kept.dateFrom, '2026-10-30');
  assert.strictEqual(kept.dateTo, '2026-11-02');
  assert.strictEqual(kept.days, 2);              // 30/10 and 02/11 (31/10-01/11 is a weekend)
  assert.strictEqual(kept.originalDateTo, '2026-11-05');
  assert.strictEqual(givenBack.dateFrom, '2026-11-03');
  assert.strictEqual(givenBack.dateTo, '2026-11-05');
  assert.strictEqual(givenBack.days, 2);         // 03/11 and 05/11 (04/11 is a public holiday)
  assert.strictEqual(givenBack.cancelledWith, SICK.id);
});
test('the kept record keeps its id and approval; the given-back one is cancelled and has no id yet', () => {
  const S = makeSplit();
  const approved = { ...SICK, approver: 'Takiuchi', approvedAt: '2026-10-29T02:00:00.000Z' };
  const { kept, givenBack } = S.splitLeaveForShorten(approved, '2026-11-03', BY);
  assert.strictEqual(kept.id, approved.id);
  assert.strictEqual(kept.status, 'approved');
  assert.strictEqual(kept.approver, 'Takiuchi');
  assert.strictEqual(kept.approvedAt, approved.approvedAt);
  assert.strictEqual(kept.shortenedBy, 'Sirintorn');
  assert.strictEqual(givenBack.status, 'cancelled');
  assert.strictEqual(givenBack.cancelledBy, 'Sirintorn');
  assert.strictEqual(givenBack.cancelledById, 1);
  // The caller allocates the id from the whole array; a copied id would collide with the original.
  assert.strictEqual(givenBack.id, approved.id, 'spread keeps the id until the route overwrites it');
  // The shortening marks belong to the kept record only.
  ['shortenedAt', 'shortenedBy', 'originalDateTo'].forEach(k =>
    assert.ok(!(k in givenBack), `givenBack must not carry ${k}`));
});
test('the split never loses or invents a day, at every split point', () => {
  const S = makeSplit();
  for (const ret of ['2026-10-31', '2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05']) {
    const { kept, givenBack } = S.splitLeaveForShorten(SICK, ret, BY);
    assert.strictEqual(kept.days + givenBack.days, SICK.days,
      `split at ${ret}: ${kept.days}+${givenBack.days} != ${SICK.days}`);
  }
});
test('the quota goes back by exactly the days given back -- same number on both sides', () => {
  const S = makeSplit(), C = makeClientMinutes();
  const { kept, givenBack } = S.splitLeaveForShorten(SICK, '2026-11-03', BY);
  // "Used" is what both balance readers sum: the non-void records of that type.
  const usedServer = ls => ls.filter(l => !S.isVoidLeaveStatus(l.status)).reduce((s, l) => s + S.leaveMinutesOf(l), 0);
  const usedClient = ls => ls.filter(l => !C.isVoidLeaveStatus(l.status)).reduce((s, l) => s + C.leaveRecordMinutes(l), 0);
  const before = [SICK];
  const after = [kept, { ...givenBack, id: 999 }];
  assert.strictEqual(usedServer(before) - usedServer(after), givenBack.days * 8 * 60, 'server');
  assert.strictEqual(usedClient(before) - usedClient(after), givenBack.days * 8 * 60, 'client');
  assert.strictEqual(usedServer(after), usedClient(after), 'both sides must agree after the split');
  // And the cancelled row really is the reason -- counting it would wipe the refund out.
  const naive = after.reduce((s, l) => s + S.leaveMinutesOf(l), 0);
  assert.strictEqual(naive, usedServer(before), 'the cancelled row still holds its own days');
});
test('a split that leaves no working day is reported as days:0 for the route to refuse', () => {
  const S = makeSplit();
  // Sat 31/10 .. Thu 05/11, coming back Mon 02/11 -> the kept span is Sat+Sun only.
  const { kept } = S.splitLeaveForShorten({ ...SICK, dateFrom: '2026-10-31', days: 2 }, '2026-11-02', BY);
  assert.strictEqual(kept.days, 0);
});
// 2026-11-02 (same-day review): the same thing on the other side, which nothing was checking.
test('a tail with no working day is reported as days:0 too (weekend-only give-back)', () => {
  const S = makeSplit();
  // Thu 05/11 .. Sun 08/11, coming back Sat 07/11 -> the tail is Sat+Sun = no working day.
  const { kept, givenBack } = S.splitLeaveForShorten(
    { ...SICK, dateFrom: '2026-11-05', dateTo: '2026-11-08', days: 2 }, '2026-11-07', BY);
  assert.strictEqual(givenBack.days, 0, 'the tail holds no working day');
  assert.ok(kept.days > 0, 'and the kept side is fine, so only the give-back guard can catch this');
});
// The modal must refuse it before the request is ever sent, for the same reason the kept side does.
test('the modal disables Confirm when the tail has no working day', () => {
  const fn = extractFunction(APP_SRC, 'updateShortenLeavePreview');
  const iBack = fn.indexOf('backDays === 0');
  const iEnable = fn.indexOf('btn.disabled = false');
  assert.ok(iBack > 0, 'updateShortenLeavePreview has no backDays === 0 guard');
  assert.ok(iEnable > 0, 'updateShortenLeavePreview no longer enables Confirm anywhere');
  assert.ok(iBack < iEnable,
    'the backDays guard must run before Confirm is enabled, or the user can still send it');
});

console.log('the arithmetic the route relies on');
test('kept days + given-back days = the original days, for every split point', () => {
  const S = makeServerDays();
  const from = '2026-10-30', to = '2026-11-05';
  const total = S.deriveLeaveDaysCount(from, to);
  const addDays = (s, n) => { const d = new Date(s + 'T12:00:00'); d.setDate(d.getDate() + n); return localDateStr(d); };
  for (const ret of ['2026-10-31', '2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05']) {
    const kept = S.deriveLeaveDaysCount(from, addDays(ret, -1));
    const back = S.deriveLeaveDaysCount(ret, to);
    assert.strictEqual(kept + back, total, `split at ${ret}: ${kept}+${back} != ${total}`);
  }
});
test('a split that would leave no working day on the record is detectable', () => {
  const S = makeServerDays();
  // Sat 31/10 .. Thu 05/11, coming back Mon 02/11 -> the kept span is Sat+Sun only.
  assert.strictEqual(S.deriveLeaveDaysCount('2026-10-31', '2026-11-01'), 0);
});

console.log('the button and its confirm');
function clientFnBody(name) {
  const i = APP_SRC.indexOf(`async function ${name}(`);
  assert.ok(i > 0, `${name}() does not exist`);
  const next = APP_SRC.indexOf('\n// ', i + 10);
  return APP_SRC.slice(i, next > 0 ? next : i + 6000);
}
test('shortenLeave() guards the owner and opens the modal', () => {
  const body = clientFnBody('shortenLeave');
  ['blockIfObserver()', 'isShortenableApprovedLeave(', 'currentUser.id',
   "getElementById('shorten-leave-modal')", 'initDatePickers()'].forEach(k =>
    assert.ok(body.includes(k), `shortenLeave is missing ${k}`));
});
test('confirmShortenLeave() posts to the shorten route', () => {
  const i = APP_SRC.indexOf('async function confirmShortenLeave()');
  assert.ok(i > 0, 'confirmShortenLeave() does not exist');
  const body = APP_SRC.slice(i, APP_SRC.indexOf('\n}', i) + 2);
  ['/shorten', "method: 'POST'", 'returnDate', 'shortenBlockMessage('].forEach(k =>
    assert.ok(body.includes(k), `confirmShortenLeave is missing ${k}`));
});
test('the summary states both day counts before anything is sent, in all three languages', () => {
  const i = APP_SRC.indexOf('function updateShortenLeavePreview()');
  assert.ok(i > 0, 'updateShortenLeavePreview() does not exist');
  const body = APP_SRC.slice(i, APP_SRC.indexOf('\n}\n', i));
  assert.ok(body.includes('deriveLeaveDaysCount('), 'the summary must compute the day counts');
  assert.ok(/currentLang === 'ja'/.test(body), 'Japanese wording is required');
  assert.ok(/L\(`The request becomes/.test(body), 'English/Thai wording via L() is required');
  assert.ok(body.includes('${backDays}') && body.includes('${keptDays}'),
    'the summary must state both day counts, not just the dates');
  assert.ok(body.includes("btn.disabled = true") && body.includes('btn.disabled = false'),
    'an impossible choice must disable Confirm rather than fail after a round trip');
});
// 2026-11-02 (owner): the date is asked for in a real date field, not a prompt(). prompt() can
// only take a typed YYYY-MM-DD, while every other date field in this app shows DD/MM/YYYY and
// parses a typed 3/11/2026 -- the owner reported this the first time the feature reached the site.
test('the return date is asked for with the app\'s own date field, never a prompt()', () => {
  const html = fs.readFileSync(path.join(ROOT, 'attendance/index.html'), 'utf8');
  assert.ok(/<input type="date" id="shorten-return-date"/.test(html),
    'the modal needs a real input[type=date] WITH AN id -- initDatePickers() only binds fields that have one');
  const fn = clientFnBody('shortenLeave');
  const code = fn.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
  assert.ok(!/\bprompt\s*\(/.test(code), 'shortenLeave must not ask for the date through prompt()');
  const confirmFn = APP_SRC.slice(APP_SRC.indexOf('async function confirmShortenLeave()'));
  assert.ok(!/\bconfirm\s*\(/.test(confirmFn.slice(0, confirmFn.indexOf('\n}\n')).replace(/confirmShortenLeave/g, '')),
    'the modal is the confirmation -- no second confirm() dialog on top of it');
});
test('every refusal code the server can send has wording on this side', () => {
  const i = APP_SRC.indexOf('function shortenBlockMessage(');
  assert.ok(i > 0, 'shortenBlockMessage() does not exist');
  const body = APP_SRC.slice(i, APP_SRC.indexOf('\n// ', i + 10));
  const routeBody = shortenRouteBody();
  const codes = [...routeBody.matchAll(/code:'([a-z-]+)'/g)].map(m => m[1]);
  assert.ok(codes.length >= 7, `expected the route to send several codes, saw ${codes.length}`);
  for (const c of new Set(codes)) {
    if (c.startsWith('period-')) continue; // shared with cancels; handled by the default branch
    assert.ok(body.includes(`case '${c}'`), `no wording for refusal code ${c}`);
  }
  assert.ok(body.includes('default: return cancelBlockMessage('), 'unknown codes must fall through');
});
test('the button is defined once and used by every list that shows an approved request', () => {
  assert.ok(APP_SRC.includes('function shortenLeaveButtonHtml(l)'), 'the shared button helper is missing');
  const uses = (APP_SRC.match(/shortenLeaveButtonHtml\(l\)/g) || []).length;
  assert.ok(uses >= 3, `every approved-request list must offer it, saw ${uses} uses`);
  const helper = APP_SRC.slice(APP_SRC.indexOf('function shortenLeaveButtonHtml(l)'));
  assert.ok(helper.includes('l.userId !== currentUser.id'), "a colleague's row must not offer the button");
  assert.ok(/class="btn btn-outline btn-sm"/.test(helper), 'btn-outline is the class that exists in style.css');
});
test('the button class actually exists in the stylesheet', () => {
  const css = fs.readFileSync(path.join(ROOT, 'attendance/css/style.css'), 'utf8');
  assert.ok(css.includes('.btn-outline'), '.btn-outline must be a real class, or the button renders unstyled');
});
test('the cache-buster was bumped past the value this work started from', () => {
  const html = fs.readFileSync(path.join(ROOT, 'attendance/index.html'), 'utf8');
  const m = /js\/app\.js\?v=(\d{8})/.exec(html);
  assert.ok(m, 'cache-buster not found');
  assert.ok(Number(m[1]) >= 20261102, `cache-buster ${m[1]} must be 20261102 or later`);
});

console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ', 0 failed'}`);
