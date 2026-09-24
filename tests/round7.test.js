// 2026-09-24 round 7: notification inbox (T1), carry-forward expiry reminders + at-risk report
// (T2), expiry policy impact (T3), January-February run window / overdue reminder / reactivation
// (T4), MD + Accounting notice on a cancelled approved record (T7), Holiday Work dependents (T10).
// No framework: `node tests/round7.test.js`. Same approach as the other tests: the real functions
// are extracted from attendance/js/app.js and attendance-server/backend/server.js and run in a
// sandbox, so the DUAL-SYNC copies are proven to agree.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const APP_SRC = fs.readFileSync(path.join(ROOT, 'attendance/js/app.js'), 'utf8');
const SERVER_SRC = fs.readFileSync(path.join(ROOT, 'attendance-server/backend/server.js'), 'utf8');
const JA_SRC = fs.readFileSync(path.join(ROOT, 'attendance/lang/ja.js'), 'utf8');

function extractBraced(src, startIdx, openIdx, name) {
  let depth = 0;
  for (let j = openIdx; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (depth === 0) return src.slice(startIdx, j + 1); }
  }
  throw new Error(`unbalanced ${name}`);
}
function extractFunction(src, name) {
  const m = new RegExp(`^(async )?function ${name}\\(`, 'm').exec(src);
  if (!m) throw new Error(`function ${name} not found`);
  return extractBraced(src, m.index, src.indexOf(') {', m.index) + 2, name);
}
function extractConstObject(src, name) {
  const m = new RegExp(`^const ${name} = \\{`, 'm').exec(src);
  if (!m) throw new Error(`const ${name} not found`);
  return extractBraced(src, m.index, src.indexOf('{', m.index), name) + ';';
}
function constLine(src, name) {
  const m = src.match(new RegExp(`^const ${name} = [^\\n]*(?:\\n  [^\\n]*)*`, 'm'));
  if (!m) throw new Error(`const ${name} not found`);
  return m[0];
}
function sameSource(name) {
  const norm = s => s.replace(/\s+/g, ' ').trim();
  assert.strictEqual(norm(extractFunction(APP_SRC, name)), norm(extractFunction(SERVER_SRC, name)), `${name} differs between app.js and server.js`);
}
function sandbox(src, names, ctx, extra) {
  vm.createContext(ctx);
  vm.runInContext((extra || '') + '\n' + names.map(n => extractFunction(src, n)).join('\n'), ctx);
  return ctx;
}
const J = v => JSON.parse(JSON.stringify(v));

let passed = 0;
const pending = [];
function test(name, fn) {
  const ok = () => { passed++; console.log(`  ok  ${name}`); };
  const fail = e => { console.log(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; };
  try {
    const r = fn();
    if (r && typeof r.then === 'function') pending.push(r.then(ok, fail));
    else ok();
  } catch (e) { fail(e); }
}
const isWeekendStr = d => { const x = new Date(d + 'T12:00:00').getDay(); return x === 0 || x === 6; };

// ---------------------------------------------------------------------------------------------
console.log('T1 notification inbox (server pure parts)');
const NOTIFY_CONSTS = ['NOTIFICATION_RETENTION_DAYS', 'NOTIFICATION_MAX_PER_USER', 'NOTIFICATION_KINDS', 'NOTIFICATION_LINK_PAGES']
  .map(n => constLine(SERVER_SRC, n)).join('\n') + '\n' + extractConstObject(SERVER_SRC, 'NOTIFICATION_ROLE_KINDS');
const NOTIFY_FNS = ['pruneNotifications', 'sanitizeNotificationLink', 'buildNotificationItem', 'notificationsForViewer',
  'markNotificationsRead', 'unreadNotificationCount', 'notificationAllowedForRole', 'purgeRoleNotifications'];
const N = sandbox(SERVER_SRC, NOTIFY_FNS, {}, NOTIFY_CONSTS + '\nthis.KINDS = NOTIFICATION_KINDS; this.MAX = NOTIFICATION_MAX_PER_USER;');
const NOW = Date.parse('2027-11-01T03:00:00Z');
const iso = (daysAgo, extraMs = 0) => new Date(NOW - daysAgo * 86400000 + extraMs).toISOString();
test('prune: older than 90 days dropped, 300 newest kept per user, other users untouched', () => {
  const items = [];
  for (let i = 0; i < 310; i++) items.push({ id: `a${i}`, userId: 1, createdAt: iso(1, i * 1000), kind: 'request-approved' });
  items.push({ id: 'old', userId: 2, createdAt: iso(91), kind: 'request-approved' });
  items.push({ id: 'edge', userId: 2, createdAt: iso(89), kind: 'request-approved' });
  items.push({ id: 'junk', userId: 2 });
  const out = J(N.pruneNotifications(items, NOW));
  const u1 = out.filter(n => n.userId === 1);
  assert.strictEqual(u1.length, 300);
  assert.ok(!u1.some(n => ['a0', 'a9'].includes(n.id)), 'the 10 oldest of user 1 are gone');
  assert.ok(u1.some(n => n.id === 'a309'));
  assert.deepStrictEqual(out.filter(n => n.userId === 2).map(n => n.id), ['edge']);
  assert.ok(out[0].createdAt <= out[out.length - 1].createdAt, 'stored oldest first');
});
test('viewer scoping: own items only, newest first, unread count; mark read touches own only', () => {
  const items = [
    { id: 'x1', userId: 1, createdAt: iso(3), readAt: null, kind: 'k' },
    { id: 'x2', userId: 1, createdAt: iso(1), readAt: null, kind: 'k' },
    { id: 'x3', userId: 1, createdAt: iso(2), readAt: iso(1), kind: 'k' },
    { id: 'y1', userId: 2, createdAt: iso(1), readAt: null, kind: 'k' },
  ];
  const v = J(N.notificationsForViewer(items, 1));
  assert.deepStrictEqual(v.items.map(n => n.id), ['x2', 'x3', 'x1']);
  assert.strictEqual(v.unread, 2);
  assert.strictEqual(N.markNotificationsRead(items, 1, ['y1', 'x1'], false, 'T'), 1, 'someone else\'s id is ignored');
  assert.strictEqual(items[3].readAt, null);
  assert.strictEqual(items[0].readAt, 'T');
  assert.strictEqual(N.markNotificationsRead(items, 1, null, true, 'T2'), 1, 'all = every own unread');
  assert.strictEqual(N.unreadNotificationCount(items, 1), 0);
  assert.strictEqual(N.unreadNotificationCount(items, 2), 1);
});
test('final round: role-targeted kinds hidden after a role change; personal kinds always kept; purge per user', () => {
  const items = [
    { id: 'a', userId: 5, createdAt: iso(5), readAt: null, kind: 'approval-needed' },
    { id: 'b', userId: 5, createdAt: iso(4), readAt: null, kind: 'accounting-revoked' },
    { id: 'c', userId: 5, createdAt: iso(3), readAt: null, kind: 'approved-cancelled' },
    { id: 'd', userId: 5, createdAt: iso(2), readAt: null, kind: 'cf-run-overdue' },
    { id: 'e', userId: 5, createdAt: iso(1), readAt: null, kind: 'cf-manual-decision' },
    { id: 'f', userId: 5, createdAt: iso(1, 1), readAt: null, kind: 'request-approved' },
    { id: 'g', userId: 5, createdAt: iso(1, 2), readAt: null, kind: 'cf-expiry-reminder' },
    { id: 'h', userId: 6, createdAt: iso(1), readAt: null, kind: 'approval-needed' },
  ];
  const ids = role => J(N.notificationsForViewer(items, 5, undefined, role)).items.map(n => n.id).sort().join('');
  assert.strictEqual(ids(undefined), 'abcdefg', 'no role = no filter');
  assert.strictEqual(ids('md'), 'abcdefg');
  assert.strictEqual(ids('accounting'), 'acdefg', 'accounting-revoked is MD-only');
  assert.strictEqual(ids('manager'), 'afg', 'manager keeps approval-needed only');
  assert.strictEqual(ids('user'), 'fg', 'demoted to user: personal kinds only');
  assert.strictEqual(J(N.notificationsForViewer(items, 5, undefined, 'user')).unread, 2, 'unread counts visible items only');
  const purged = J(N.purgeRoleNotifications(items, 5, 'manager')).map(n => n.id).join('');
  assert.strictEqual(purged, 'afgh', 'other users untouched');
  assert.deepStrictEqual(J(N.purgeRoleNotifications(items, 5, 'md')).length, items.length);
  const g = SERVER_SRC.slice(SERVER_SRC.indexOf("app.get('/api/notifications'"));
  assert.ok(/const viewerRole = live && !isSuperAdminUser\(live\) \? live\.role : undefined;/.test(g.slice(0, 900)), 'GET uses the LIVE role');
  const role = extractFunction(SERVER_SRC, 'handleRoleUpdate');
  assert.ok(role.indexOf('purgeRoleNotificationsForUser(users[idx].id, role)') > role.indexOf('saveUsers(users)'), 'purged on role change');
});
test('item: kind + params stored (no rendered text), link whitelisted', () => {
  const it = J(N.buildNotificationItem('id1', '7', 'request-approved', { leaveId: 5, type: 'ot' }, { page: 'my-requests', leaveId: '5', x: 1 }, 'T'));
  assert.deepStrictEqual(it, { id: 'id1', userId: 7, createdAt: 'T', readAt: null, kind: 'request-approved', params: { leaveId: 5, type: 'ot' }, link: { page: 'my-requests', leaveId: 5 } });
  assert.strictEqual(N.sanitizeNotificationLink({ page: 'javascript:alert(1)' }), null);
  assert.deepStrictEqual(J(N.sanitizeNotificationLink({ page: 'approval-history', date: '2027-11-02', leaveId: -1 })), { page: 'approval-history', date: '2027-11-02' });
  assert.deepStrictEqual(J(N.buildNotificationItem('i', 1, 'k', ['bad'], null, 'T').params), {});
});
test('every kind the server writes is declared, and the test push stores nothing (static)', () => {
  const kinds = [...SERVER_SRC.matchAll(/\bkind: '([a-z-]+)'/g)].map(m => m[1]);
  const conditional = /kind: leave\.status === 'approved' \? 'request-approved' : 'request-rejected'/.test(SERVER_SRC);
  assert.ok(conditional, 'approve/reject kind');
  kinds.forEach(k => assert.ok(N.KINDS.includes(k), `kind ${k} not in NOTIFICATION_KINDS`));
  ['approval-needed', 'request-revoked', 'accounting-revoked', 'approved-cancelled', 'cf-expiry-reminder', 'cf-run-overdue', 'cf-manual-decision']
    .forEach(k => assert.ok(kinds.includes(k), `no call site writes ${k}`));
  const i = SERVER_SRC.indexOf("app.post('/api/push-test'");
  const body = SERVER_SRC.slice(i, SERVER_SRC.indexOf('\napp.', i + 10));
  assert.ok(/await sendPushToUser\(userId, \{[\s\S]*?\}\);/.test(body) && !/kind:/.test(body), 'test push has no inbox');
});
test('sendPushToUser records the inbox item even with no push subscription', () => {
  const recorded = [];
  const X = sandbox(SERVER_SRC, ['sendPushToUser', 'sendPushToRole'], {
    readPushSubs: () => [], writePushSubs: () => {}, webpush: { sendNotification: () => { throw new Error('no'); } },
    recordNotifications: e => recorded.push(...e), readUsers: () => [{ id: 1, role: 'md' }, { id: 2, role: 'md', active: false }, { id: 3, role: 'md' }],
    console,
  });
  return Promise.resolve(X.sendPushToUser(9, { title: 't' }, { kind: 'request-approved', params: { a: 1 }, link: { page: 'leave' } }))
    .then(() => X.sendPushToRole('md', { title: 't' }, { kind: 'approval-needed', params: {} }))
    .then(() => X.sendPushToUser(9, { title: 'test' }))
    .then(() => {
      assert.deepStrictEqual(J(recorded).map(r => [r.userId, r.kind]), [[9, 'request-approved'], [1, 'approval-needed'], [3, 'approval-needed']]);
    });
});
test('recordNotifications: fail closed on an unreadable file; per-user WS ping with the unread count', () => {
  let saved = null;
  const pings = [];
  const X = sandbox(SERVER_SRC, ['recordNotifications', ...NOTIFY_FNS], {
    readNotifications: () => null, saveNotifications: a => { saved = a; }, sendNotificationEvent: (u, n) => pings.push([u, n]),
    randomBytes: () => ({ toString: () => 'abcd' }), console: { error() {} },
  }, NOTIFY_CONSTS);
  assert.deepStrictEqual(J(X.recordNotifications([{ userId: 1, kind: 'k' }])), []);
  assert.strictEqual(saved, null, 'never overwrites an unreadable file');
  X.readNotifications = () => [{ id: 'o', userId: 1, createdAt: new Date().toISOString(), readAt: null, kind: 'k' }];
  const added = J(X.recordNotifications([{ userId: 1, kind: 'request-approved', params: {} }, { userId: 2, kind: 'request-rejected' }, { kind: 'x' }]));
  assert.strictEqual(added.length, 2);
  assert.strictEqual(saved.length, 3);
  assert.deepStrictEqual(pings, [[1, 2], [2, 1]]);
});
test('GET / POST routes: own items only, 503 on read failure, write lock (static)', () => {
  const g = SERVER_SRC.slice(SERVER_SRC.indexOf("app.get('/api/notifications'"));
  assert.ok(/notificationsForViewer\(items, req\.user\.sub, undefined, viewerRole\)/.test(g.slice(0, 900)));
  const p = SERVER_SRC.slice(SERVER_SRC.indexOf("app.post('/api/notifications/read'"));
  assert.ok(p.startsWith("app.post('/api/notifications/read', withNotificationsLock("));
  assert.ok(/markNotificationsRead\(items, req\.user\.sub, body\.ids, all/.test(p.slice(0, 1200)));
  assert.ok(/status\(503\)/.test(p.slice(0, 1200)));
});

console.log('T1 notification inbox (client renderers)');
const RENDER_FNS = ['notificationText', 'notifDateRange', 'notifTypeLabel', 'notifRecordsText', 'notifReasonText', 'minToStr'];
function clientRenderer(lang) {
  const ctx = {
    currentLang: lang, window: {},
    getApprovalTypeLabels: () => ({ annual: '🏖️ Annual Leave', ot: '⏱️ OT', 'holiday-work': '🔄 Holiday Work', 'late-out': '🌙 Late Night' }),
    fmtDate: d => d.toISOString().slice(0, 10),
  };
  vm.createContext(ctx);
  vm.runInContext(JA_SRC, ctx);
  ctx.LANG_JA = ctx.window.LANG_JA;
  return sandbox(APP_SRC, ['L', ...RENDER_FNS], ctx, extractConstObject(APP_SRC, 'NOTIFICATION_RENDERERS') + '\nthis.R = NOTIFICATION_RENDERERS;');
}
const SAMPLE = {
  'request-approved': { type: 'ot', dateFrom: '2027-11-02', dateTo: '2027-11-02', leaveId: 1 },
  'request-rejected': { type: 'annual', dateFrom: '2027-11-02', dateTo: '2027-11-04' },
  'approval-needed': { type: 'ot', dateFrom: '2027-11-02', employeeName: 'Somchai' },
  'request-revoked': { type: 'holiday-work', dateFrom: '2027-11-06', by: 'Acc', reason: 'wrong day', also: [{ type: 'late-out', dateFrom: '2027-11-06' }] },
  'accounting-revoked': { employeeName: 'Somchai', by: 'Acc', reason: '', records: [{ type: 'ot', dateFrom: '2027-11-02' }] },
  'approved-cancelled': { employeeName: 'Somchai', records: [{ type: 'annual', dateFrom: '2027-11-10', dateTo: '2027-11-11' }] },
  'cf-expiry-reminder': { minutes: 780, expiryDate: '2027-11-30' },
  'cf-run-overdue': { year: 2026 },
  'cf-manual-decision': { employeeName: 'Somchai', userId: 9, year: 2026, deactivatedAt: '2026-06-30T03:00:00.000Z' },
};
test('every server kind has a client renderer; texts differ per language; unknown kind -> generic', () => {
  const en = clientRenderer('en'), th = clientRenderer('th'), ja = clientRenderer('ja');
  assert.deepStrictEqual(Object.keys(en.R).sort(), [...N.KINDS].sort(), 'renderer keys == NOTIFICATION_KINDS');
  for (const k of N.KINDS) {
    const t = [en, th, ja].map(X => X.notificationText({ kind: k, params: SAMPLE[k] }).text);
    t.forEach(s => assert.ok(s && !/undefined|NaN/.test(s), `${k}: ${s}`));
    assert.strictEqual(new Set(t).size, 3, `${k}: TH/EN/JA must differ`);
  }
  assert.strictEqual(en.notificationText({ kind: 'cf-expiry-reminder', params: SAMPLE['cf-expiry-reminder'] }).text,
    'You have 1.63 carry-forward day(s) (1d 5h) that expire on 2027-11-30 — use them before then');
  assert.ok(en.notificationText({ kind: 'request-revoked', params: SAMPLE['request-revoked'] }).text.includes('together with: 🌙 Late Night (2027-11-06) — reason: wrong day'));
  assert.strictEqual(en.notificationText({ kind: 'nope', params: {} }).text, 'You have a new notification');
  assert.strictEqual(ja.notificationText({ kind: 'nope' }).text, '新しい通知があります');
  assert.strictEqual(en.notificationText({ kind: 'toString', params: {} }).text, 'You have a new notification', 'prototype names are not kinds');
});

// ---------------------------------------------------------------------------------------------
console.log('T2 carry-forward expiry reminders + at-risk list');
const LEAVE = { carryForwardMax: 20, carryForwardExpiryEnabled: true, carryForwardExpiryMonth: 11, carryForwardExpiryDay: 30 };
const CF_SHARED = ['carryForwardExpiryEnabled', 'carryForwardExpiryDateStr', 'leaveMinutesOnOrBefore', 'carryForwardForfeitMinutes',
  'isVoidLeaveStatus', 'hourlyLeaveChargedMinutes'];
function cfServer(w) {
  return sandbox(SERVER_SRC, [...CF_SHARED, 'leaveMinutesOf', 'carryForwardAtRiskList', 'cfNotifyDaysOf', 'cfExpiryReminderStages', 'cfExpiryReminderDue',
    'addDaysToDateStr', 'plainObj', 'pruneDatedMap', 'cfAmountText', 'carryForwardOverdueReminderYear', 'isCarryForwardRunMonth'], {
    HHMM_RE: /^([01]\d|2[0-3]):[0-5]\d$/,
    getAppSettings: () => ({ leave: w.leave || LEAVE }),
    readSettings: () => ({ leaveCarryForward: w.cf, leaveOpeningUsed: w.openingUsed || {} }),
    employeeActiveRecords: us => us.filter(u => !u.isSystemAccount && u.active !== false),
  }, constLine(SERVER_SRC, 'CF_REMINDER_MIN_HOUR'));
}
function cfClient(w) {
  const ctx = {
    APP_SETTINGS: { leave: { ...(w.leave || LEAVE) } }, DATA_USERS: w.users, DATA_LEAVES: w.leaves,
    LEAVE_CARRY_FORWARD: w.cf, LEAVE_OPENING_USED: w.openingUsed || {}, currentLang: 'en',
    isEmployeeRecord: u => !!(u && !u.isSystemAccount),
  };
  return sandbox(APP_SRC, [...CF_SHARED, 'leaveRecordMinutes', 'getCarryForwardKey', 'getCarryForwardDays', 'getCarryForwardCompDays',
    'getOpeningUsedKey', 'getOpeningUsedDays', 'cfAtRiskRows', 'cfExpiryPolicyImpact'], ctx);
}
let lid = 1;
const lv = (userId, dateFrom, days, status = 'approved', type = 'annual') => ({ id: lid++, userId, type, status, dateFrom, dateTo: dateFrom, days });
const USERS = [
  { id: 1, name: 'A', active: true }, { id: 2, name: 'B', active: true }, { id: 3, name: 'C', active: false },
  { id: 4, name: 'Sys', active: true, isSystemAccount: true },
];
const W = {
  users: USERS,
  cf: { '2027_1': 3, '2027_2': 1, comp_2027_2: 0, '2027_3': 5, '2027_4': 5 },
  leaves: [
    lv(1, '2027-03-01', 1), lv(1, '2027-11-15', 1, 'pending-manager'), lv(1, '2027-12-01', 1),
    lv(1, '2027-06-01', 1, 'cancelled'), lv(2, '2027-02-01', 1),
  ],
};
test('final round: stages = expiry - notifyDays and expiry - 7 (second skipped when notifyDays <= 7)', () => {
  const S = cfServer(W);
  assert.deepStrictEqual(J(S.cfExpiryReminderStages('2027-11-30', 30)), [{ stage: 'first', date: '2027-10-31' }, { stage: 'second', date: '2027-11-23' }]);
  assert.deepStrictEqual(J(S.cfExpiryReminderStages('2028-03-31', 14)), [{ stage: 'first', date: '2028-03-17' }, { stage: 'second', date: '2028-03-24' }]);
  assert.deepStrictEqual(J(S.cfExpiryReminderStages('2027-11-30', 7)), [{ stage: 'first', date: '2027-11-23' }], '7 -> one reminder');
  assert.deepStrictEqual(J(S.cfExpiryReminderStages('2027-11-30', 3)), [{ stage: 'first', date: '2027-11-27' }]);
  assert.deepStrictEqual(J(S.cfExpiryReminderStages('2027-11-30', undefined)), J(S.cfExpiryReminderStages('2027-11-30', 30)), 'missing = 30');
  assert.deepStrictEqual(J(S.cfExpiryReminderStages('2027-11-30', 0)), J(S.cfExpiryReminderStages('2027-11-30', 30)), 'invalid = 30');
  assert.strictEqual(S.cfNotifyDaysOf(9999), 365);
  assert.strictEqual(S.cfNotifyDaysOf('45'), 45);
});
test('final round: due from the stage date until the expiry date, from 09:00, once per (expiry, stage), catch-up', () => {
  const S = cfServer(W);
  const runs = { 2026: { at: 'x' }, 2027: { at: 'y' } };
  const cands = y => [{ year: y, expiry: `${y}-11-30` }, { year: y + 1, expiry: `${y + 1}-11-30` }];
  const due = (today, hour, sent, nd = 30, r = runs) => J(S.cfExpiryReminderDue(today, hour, cands(Number(today.slice(0, 4))), nd, sent, r, 2026));
  assert.strictEqual(due('2027-10-30', 12, {}), null, 'before the first stage');
  assert.deepStrictEqual(due('2027-10-31', 9, {}), { year: 2027, expiry: '2027-11-30', stage: 'first', markKeys: ['2027-11-30_first'] });
  assert.strictEqual(due('2027-10-31', 8, {}), null, 'before 09:00 Bangkok');
  assert.strictEqual(due('2027-10-31', 23, { '2027-11-30_first': 'x' }), null, 'already sent');
  assert.deepStrictEqual(due('2027-11-05', 10, {}).stage, 'first', 'catch-up: server was down on the due day');
  assert.strictEqual(due('2027-11-05', 10, { '2027-11-30_first': 'x' }), null);
  assert.deepStrictEqual(due('2027-11-23', 9, { '2027-11-30_first': 'x' }), { year: 2027, expiry: '2027-11-30', stage: 'second', markKeys: ['2027-11-30_second'] });
  assert.deepStrictEqual(due('2027-11-25', 9, {}), { year: 2027, expiry: '2027-11-30', stage: 'second', markKeys: ['2027-11-30_first', '2027-11-30_second'] },
    'both missed -> one message (second), first superseded');
  assert.strictEqual(due('2027-11-30', 9, {}).stage, 'second', 'the expiry day itself still counts');
  assert.strictEqual(due('2027-12-01', 9, {}), null, 'never after the expiry date');
  assert.strictEqual(due('2027-11-25', 9, {}, 7).stage, 'first', 'notifyDays 7: one stage only');
  assert.strictEqual(due('2027-11-25', 9, { '2027-11-30_first': 'x' }, 7), null);
  assert.strictEqual(due('2027-10-31', 9, {}, 30, { 2027: { at: 'y' } }), null, 'run for 2026 not recorded -> wait for it');
  assert.strictEqual(due('2026-11-05', 9, {}, 30, {}).year, 2026, 'a source year before the system start does not wait');
});
test('final round: an early-in-the-year expiry has its first reminder in the previous December', () => {
  const S = cfServer(W);
  const cands = (y, md) => [{ year: y, expiry: `${y}-${md}` }, { year: y + 1, expiry: `${y + 1}-${md}` }];
  const r26 = { 2026: { at: 'w' } }, r27 = { 2026: { at: 'w' }, 2027: { at: '2028-01-01T00:07:00Z' } };
  // 15 Jan expiry, 30 days: first reminder 16 Dec of the previous year (found through the NEXT-year candidate).
  assert.strictEqual(J(S.cfExpiryReminderDue('2027-12-16', 9, cands(2027, '01-15'), 30, {}, r26, 2026)), null,
    '16 Dec 2027: the 2028 expiry is due, but 2027 -> 2028 has not run yet -> wait');
  assert.deepStrictEqual(J(S.cfExpiryReminderDue('2027-12-16', 9, cands(2027, '01-15'), 30, {}, r27, 2026)),
    { year: 2028, expiry: '2028-01-15', stage: 'first', markKeys: ['2028-01-15_first'] }, 'previous-December date computed');
  assert.deepStrictEqual(J(S.cfExpiryReminderDue('2028-01-01', 9, cands(2028, '01-15'), 30, {}, r27, 2026)),
    { year: 2028, expiry: '2028-01-15', stage: 'first', markKeys: ['2028-01-15_first'] }, 'caught up once the run is recorded');
  assert.strictEqual(J(S.cfExpiryReminderDue('2028-01-08', 9, cands(2028, '01-15'), 30, { '2028-01-15_first': 'x' }, r27, 2026)).stage, 'second');
  // 1 Jan expiry: both stages fall in December, before the run can exist -> one catch-up message on 1 Jan.
  assert.strictEqual(J(S.cfExpiryReminderDue('2027-12-02', 9, cands(2027, '01-01'), 30, {}, r26, 2026)), null);
  assert.deepStrictEqual(J(S.cfExpiryReminderDue('2028-01-01', 9, cands(2028, '01-01'), 30, {}, r27, 2026)),
    { year: 2028, expiry: '2028-01-01', stage: 'second', markKeys: ['2028-01-01_first', '2028-01-01_second'] });
});
test('at-risk list: FIFO (leave on/before expiry incl. pending uses carry-forward), active employees only, both sides', () => {
  const S = cfServer(W);
  const list = J(S.carryForwardAtRiskList(W.leaves, W.users, 2027, W.cf)).map(x => [x.user.id, x.minutes]);
  // A: 3 days CF - (1 approved Mar + 1 pending Nov) = 1 day; the Dec leave is after expiry. B: 1 - 1 = 0.
  assert.deepStrictEqual(list, [[1, 480]]);
  const C = cfClient(W);
  assert.deepStrictEqual(J(C.cfAtRiskRows(2027)).map(r => [r.user.id, r.atRiskMin, r.cfMin]), [[1, 480, 1440]]);
  assert.deepStrictEqual(J(S.carryForwardAtRiskList(W.leaves, W.users, 2027, W.cf)), J(S.carryForwardAtRiskList(W.leaves, W.users, 2027, W.cf)));
  const off = cfServer({ ...W, leave: { ...LEAVE, carryForwardExpiryEnabled: false } });
  assert.deepStrictEqual(J(off.carryForwardAtRiskList(W.leaves, W.users, 2027, W.cf)), [], 'expiry off -> nothing at risk');
});
test('amount text "X day(s) (Xd Yh Zm)" in the email language', () => {
  const S = cfServer(W);
  assert.strictEqual(S.cfAmountText(780, 'en'), '1.63 day(s) (1d 5h)');
  assert.strictEqual(S.cfAmountText(780, 'th'), '1.63 วัน (1 วัน 5 ชม.)');
  assert.strictEqual(S.cfAmountText(780, 'ja'), '1.63日（1日5時間）');
});
test('reminder job: this year and next year candidates, notifyDays from Settings, Bangkok hour (static)', () => {
  const fn = extractFunction(SERVER_SRC, 'runCfExpiryReminders');
  assert.ok(fn.includes('[thisYear, thisYear + 1].map(y => ({ year: y, expiry: carryForwardExpiryDateStr(y) }))'));
  assert.ok(fn.includes('cfExpiryReminderDue(today, bangkokYmd().h, candidates, (getAppSettings().leave || {}).carryForwardNotifyDays'));
  assert.ok(extractFunction(SERVER_SRC, 'remindOverdueCarryForwardRun').includes('carryForwardFirstSourceYear(), bangkokYmd().h)'));
  assert.strictEqual(constLine(SERVER_SRC, 'CF_REMINDER_MIN_HOUR'), 'const CF_REMINDER_MIN_HOUR = 9;');
});
test('reminder job + settings keys are server-owned (static)', () => {
  assert.ok(/cron\.schedule\('7 \* \* \* \*', runHourlyLeaveJobs/.test(SERVER_SRC));
  const put = SERVER_SRC.slice(SERVER_SRC.indexOf("app.put('/api/settings'"));
  // 2026-09-24: was an exact match on the literal array, which broke the moment a THIRD server-owned
  // key was added (leaveCarryForwardEdits, the manual-override audit). Assert what actually matters
  // -- each key appears inside the refusal loop -- so adding another one does not fail this test
  // while still failing if a key is dropped from the guard.
  const head = put.slice(0, 5000);
  const guard = head.slice(head.indexOf('for (const k of ['), head.indexOf('for (const k of [') + 400);
  for (const k of ['cfExpiryRemindersSent', 'cfRunOverdueRemindersSent', 'leaveCarryForwardEdits']) {
    assert.ok(guard.includes(`'${k}'`), `${k} must be refused by PUT /api/settings`);
  }
  assert.ok(/is set by the server only/.test(guard));
  const fn = extractFunction(SERVER_SRC, 'runCfExpiryReminders');
  assert.ok(fn.indexOf('writeJSON') < fn.indexOf('sendPushToUser'), 'the day is recorded before anything is sent');
  assert.ok(/emailNotifyOnResult/.test(extractFunction(SERVER_SRC, 'sendCfExpiryEmail')));
  assert.ok(/escapeHtml\(t\.cfExpiryBody/.test(extractFunction(SERVER_SRC, 'sendCfExpiryEmail')));
});

console.log('T3 expiry policy change impact (client)');
test('forfeit this year under old vs new policy; settings restored afterwards', () => {
  const C = cfClient(W);
  const nov = { carryForwardExpiryEnabled: true, carryForwardExpiryMonth: 11, carryForwardExpiryDay: 30 };
  const feb = { carryForwardExpiryEnabled: true, carryForwardExpiryMonth: 2, carryForwardExpiryDay: 28 };
  const off = { carryForwardExpiryEnabled: false, carryForwardExpiryMonth: 11, carryForwardExpiryDay: 30 };
  const a = J(C.cfExpiryPolicyImpact(nov, feb, 2027));
  // Nov 30: A loses 1 day. 28 Feb: A has used nothing by then -> 3 days; B used 1 Feb -> 0.
  assert.deepStrictEqual(a.affected.map(r => [r.user.id, r.before, r.after]), [[1, 480, 1440]]);
  assert.strictEqual(a.beforeMin, 480);
  assert.strictEqual(a.afterMin, 1440);
  const b = J(C.cfExpiryPolicyImpact(nov, off, 2027));
  assert.deepStrictEqual([b.beforeMin, b.afterMin, b.affected.length], [480, 0, 1]);
  assert.deepStrictEqual(J(C.APP_SETTINGS.leave), J(LEAVE), 'APP_SETTINGS.leave restored');
});

// ---------------------------------------------------------------------------------------------
console.log('T4 January-February window, overdue reminder, reactivation');
test('isCarryForwardRunMonth / carryForwardRunRefusal identical in both files', () => {
  sameSource('isCarryForwardRunMonth');
  sameSource('carryForwardRunRefusal');
});
test('overdue reminder: from 15 Jan until the run is recorded (any month), 09:00+, once per day, never before system start', () => {
  const S = cfServer(W);
  assert.strictEqual(S.carryForwardOverdueReminderYear('2028-01-14', {}, {}, 2026), null, 'before 15 Jan');
  assert.strictEqual(S.carryForwardOverdueReminderYear('2028-01-15', {}, {}, 2026), 2027);
  assert.strictEqual(S.carryForwardOverdueReminderYear('2028-02-29', {}, {}, 2026), 2027, 'through February');
  assert.strictEqual(S.carryForwardOverdueReminderYear('2028-03-01', {}, {}, 2026), 2027, 'final round: continues after February');
  assert.strictEqual(S.carryForwardOverdueReminderYear('2028-12-31', {}, {}, 2026), 2027, 'until the end of the year');
  assert.strictEqual(S.carryForwardOverdueReminderYear('2028-03-01', {}, {}, 2026, 8), null, 'before 09:00 Bangkok');
  assert.strictEqual(S.carryForwardOverdueReminderYear('2028-03-01', {}, {}, 2026, 9), 2027, 'from 09:00');
  assert.strictEqual(S.carryForwardOverdueReminderYear('2028-09-01', { 2027: { at: 'x' } }, {}, 2026, 12), null, 'recorded later in the year -> stops');
  assert.strictEqual(S.carryForwardOverdueReminderYear('2028-01-20', { 2027: { at: 'x' } }, {}, 2026), null, 'done');
  assert.strictEqual(S.carryForwardOverdueReminderYear('2028-01-20', {}, { '2028-01-20': 'x' }, 2026), null, 'sent today');
  assert.strictEqual(S.carryForwardOverdueReminderYear('2028-01-21', {}, { '2028-01-20': 'x' }, 2026), 2027, 'next day again');
  assert.strictEqual(S.carryForwardOverdueReminderYear('2026-01-20', {}, {}, 2026), null, 'before the system started');
  assert.deepStrictEqual(J(S.pruneDatedMap({ '2025-01-15': 1, '2026-01-20': 2, '2026-01-22': 4, '2028-01-20': 3 }, '2028-01-21')), { '2026-01-22': 4, '2028-01-20': 3 }, 'about 2 years kept');
});
test('reactivation writes the missing carry-forward once (same computation as the run)', () => {
  let settings;
  const calls = [];
  const asked = [];
  const mk = () => sandbox(SERVER_SRC, ['carryForwardForReactivatedUser', 'reactivationCarryForwardAction', 'plainObj'], {
    notifyMdAccounting: (payload, inbox) => asked.push(inbox),
    readJSON: () => JSON.parse(JSON.stringify(settings)), writeJSON: (f, s) => { settings = s; },
    readLeaves: () => [], bangkokDateStr: () => '2027-03-05', isSystemAccountUser: u => !!u.isSystemAccount,
    getAppSettings: () => ({ leave: { carryForwardMax: 20 } }), console: { log() {} },
    computeYearEndCarryForward: (leaves, users, fromYear) => { calls.push([users.map(u => u.id), fromYear]); return { [`2027_${users[0].id}`]: 2.5, [`comp_2027_${users[0].id}`]: 0 }; },
  });
  settings = { leaveCarryForwardRuns: { 2026: { at: 'x' } }, leaveCarryForward: { '2027_1': 1 }, other: 'kept' };
  const X = mk();
  const THIS_YEAR = '2027-01-01T00:00:00+07:00'; // 00:00 Bangkok 1 Jan 2027 = 31 Dec 17:00 UTC
  assert.deepStrictEqual(J(X.carryForwardForReactivatedUser({ id: 9, active: true, deactivatedAt: new Date(Date.parse(THIS_YEAR)).toISOString() })), { '2027_9': 2.5, comp_2027_9: 0 });
  assert.deepStrictEqual(J(settings.leaveCarryForward), { '2027_1': 1, '2027_9': 2.5, comp_2027_9: 0 });
  assert.strictEqual(settings.other, 'kept', 'whole-file read-modify-write');
  assert.deepStrictEqual(J(calls), [[[9], 2026]]);
  assert.strictEqual(X.carryForwardForReactivatedUser({ id: 9, active: true, deactivatedAt: '2027-02-01T00:00:00Z' }), null, 'key exists -> never overwritten');
  assert.strictEqual(asked.length, 0);
  // Review M-1: not active at the end of 2026 (or unknown) -> nothing written, MD / Accounting asked.
  const before = JSON.stringify(settings);
  assert.deepStrictEqual(J(X.carryForwardForReactivatedUser({ id: 10, name: 'Left', active: true, deactivatedAt: '2026-12-31T16:59:59Z' })), { ask: true },
    '23:59:59 Bangkok 31 Dec 2026 = inactive at year end');
  assert.deepStrictEqual(J(X.carryForwardForReactivatedUser({ id: 11, name: 'NoDate', active: true })), { ask: true }, 'no deactivatedAt on record');
  assert.strictEqual(JSON.stringify(settings), before, 'nothing written');
  assert.deepStrictEqual(J(asked).map(a => [a.kind, a.params.employeeName, a.params.userId, a.params.year, a.link.page]),
    [['cf-manual-decision', 'Left', 10, 2026, 'settings'], ['cf-manual-decision', 'NoDate', 11, 2026, 'settings']]);
  assert.strictEqual(X.reactivationCarryForwardAction({ id: 12, active: true, deactivatedAt: '2026-12-31T17:00:00Z' }, '2027-03-05', { 2026: {} }, {}), 'write', '00:00 Bangkok 1 Jan');
  assert.strictEqual(X.reactivationCarryForwardAction({ id: 12, active: true, deactivatedAt: 'garbage' }, '2027-03-05', { 2026: {} }, {}), 'ask');
  assert.strictEqual(X.reactivationCarryForwardAction({ id: 12, active: true }, '2027-03-05', {}, {}), null, 'run not recorded -> the run itself covers it');
  assert.strictEqual(X.reactivationCarryForwardAction({ id: 12, active: true }, '2027-03-05', { 2026: {} }, { '2027_12': 0 }), null, 'key exists (even 0)');
  assert.strictEqual(X.carryForwardForReactivatedUser({ id: 8, active: true, isSystemAccount: true }), null);
  settings = { leaveCarryForwardRuns: {}, leaveCarryForward: {} };
  assert.strictEqual(mk().carryForwardForReactivatedUser({ id: 7, active: true }), null, 'run not recorded yet -> the run itself will do it');
  assert.ok(/if \(!wasActive && users\[idx\]\.active !== false\) \{\s*try \{ carryForwardForReactivatedUser\(users\[idx\]\); \}/.test(SERVER_SRC), 'hooked into handleUserUpdate');
  const upd = extractFunction(SERVER_SRC, 'handleUserUpdate');
  assert.ok(/if \(wasActive && users\[idx\]\.active === false\) \{[^}]*users\[idx\]\.deactivatedAt = new Date\(\)\.toISOString\(\);/.test(upd), 'deactivatedAt recorded');
  assert.ok(/if \(!wasActive && users\[idx\]\.active !== false\) users\[idx\]\.reactivatedAt = new Date\(\)\.toISOString\(\);/.test(upd), 'reactivatedAt recorded');
  assert.ok(upd.indexOf('reactivatedAt = ') < upd.indexOf('saveUsers(users)'), 'saved with the record');
  assert.ok(/const forbidden = \[[^\]]*'deactivatedAt', 'reactivatedAt'\]/.test(upd), 'not client-writable');
});

// ---------------------------------------------------------------------------------------------
console.log('T7 MD + Accounting notified when an approved record is cancelled');
test('notifyMdAccounting: active md + accounting, never the canceller, never a system account', () => {
  const sent = [];
  const X = sandbox(SERVER_SRC, ['notifyMdAccounting', 'notifyApprovedRecordCancelled'], {
    readUsers: () => [
      { id: 1, role: 'md' }, { id: 2, role: 'md', active: false }, { id: 3, role: 'accounting' }, { id: 4, role: 'accounting' },
      { id: 5, role: 'manager' }, { id: 6, role: 'md', isSystemAccount: true }, { id: 7, role: 'user' },
    ],
    isSystemAccountUser: u => !!u.isSystemAccount, badgeCountForUser: () => 0, getTypeLabel: t => t,
    sendPushToUser: (id, payload, inbox) => { sent.push({ id, payload, inbox }); }, console,
  });
  X.notifyApprovedRecordCancelled({ id: 4, name: 'Acc Self', role: 'accounting' }, [
    { id: 10, type: 'holiday-work', dateFrom: '2027-11-06', dateTo: '2027-11-06' }, { id: 11, type: 'late-out', dateFrom: '2027-11-06' }]);
  assert.deepStrictEqual(sent.map(s => s.id), [1, 3]);
  assert.strictEqual(sent[0].inbox.kind, 'approved-cancelled');
  assert.deepStrictEqual(J(sent[0].inbox.params), { employeeName: 'Acc Self', records: [
    { id: 10, type: 'holiday-work', dateFrom: '2027-11-06', dateTo: '2027-11-06' }, { id: 11, type: 'late-out', dateFrom: '2027-11-06', dateTo: '2027-11-06' }] });
  assert.ok(sent[0].payload.body.includes('holiday-work (2027-11-06), late-out (2027-11-06)'));
  const del = SERVER_SRC.slice(SERVER_SRC.indexOf("app.delete('/api/leaves/:id'"));
  assert.ok(/notifyApprovedRecordCancelled\(live, \[leaves\[idx\], \.\.\.cancelledDeps\]\)/.test(del.slice(0, 12000)), 'called on soft cancel');
});

// ---------------------------------------------------------------------------------------------
console.log('T10 Holiday Work dependents (revoke + owner cancel)');
function hwSides(tripDays = []) {
  const ctx = () => ({ isCompanyTripDay: d => tripDays.includes(d), isNonWorkDayForComp: isWeekendStr });
  const names = ['holidayWorkDependents', 'isHolidayWorkDay', 'isVoidLeaveStatus'];
  return [['client', sandbox(APP_SRC, names, ctx())], ['server', sandbox(SERVER_SRC, names, ctx())]];
}
const r = (id, type, dateFrom, status = 'approved', userId = 1, extra = {}) => ({ id, type, dateFrom, dateTo: dateFrom, status, userId, ...extra });
test('holidayWorkDependents identical in both files', () => sameSource('holidayWorkDependents'));
test('rest-day Late Night / early-morning of the same employee go with the Holiday Work', () => {
  const hw = r(1, 'holiday-work', '2027-11-06'); // Saturday
  const leaves = [hw, r(2, 'late-out', '2027-11-06'), r(3, 'early-morning', '2027-11-06'), r(4, 'late-out', '2027-11-06', 'pending-md'),
    r(5, 'upcountry', '2027-11-06'), r(6, 'late-out', '2027-11-06', 'approved', 2), r(7, 'late-out', '2027-11-07')];
  for (const [side, X] of hwSides()) {
    assert.deepStrictEqual(J(X.holidayWorkDependents(hw, leaves)).map(l => l.id), [2, 3], side);
    assert.deepStrictEqual(J(X.holidayWorkDependents(hw, [...leaves, r(8, 'holiday-work', '2027-11-06', 'pending-md')])), [], `${side}: another active HW keeps them valid`);
    assert.deepStrictEqual(J(X.holidayWorkDependents(hw, [...leaves, r(8, 'holiday-work', '2027-11-06', 'revoked')])).map(l => l.id), [2, 3], `${side}: a revoked HW does not`);
    const wd = r(9, 'holiday-work', '2027-11-08');
    assert.deepStrictEqual(J(X.holidayWorkDependents(wd, [wd, r(10, 'late-out', '2027-11-08')])), [], `${side}: weekday (no HW prerequisite)`);
  }
  for (const [side, X] of hwSides(['2027-11-06'])) assert.deepStrictEqual(J(X.holidayWorkDependents(hw, leaves)), [], `${side}: company trip`);
});
test('revoke + cancel routes use it, with the dependentIds cross-check and cancelledWith (static)', () => {
  const rev = SERVER_SRC.slice(SERVER_SRC.indexOf("app.post('/api/leaves/:id/revoke'"));
  const revBody = rev.slice(0, rev.indexOf('\napp.', 10));
  assert.ok(/let dependents = leave\.type === 'holiday-work' \? holidayWorkDependents\(leave, leaves\) : \[\];/.test(revBody));
  assert.ok(/dependentsMismatchOrGuardError\(body\.dependentIds, hwDeps, leaves, ownerUser\)/.test(revBody));
  const del = SERVER_SRC.slice(SERVER_SRC.indexOf("app.delete('/api/leaves/:id'"));
  const delBody = del.slice(0, del.indexOf('\napp.', 10));
  assert.ok(/holidayWorkDependents\(leave, leaves\)/.test(delBody));
  assert.ok(/cancelledWith: leave\.id/.test(delBody));
  assert.ok(/'cancel-dependents-changed'/.test(delBody));
});
test('dependentsMismatchOrGuardError: list mismatch -> 409 with the real list; a frozen dependent refuses all', () => {
  const X = sandbox(SERVER_SRC, ['dependentsMismatchOrGuardError'], {
    isValidDateStr: s => /^\d{4}-\d{2}-\d{2}$/.test(s || ''), mdApprovedPeriodInRange: (a, b, u) => u === 99,
    lockedPeriodInRange: () => false, accountingConfirmedInRange: () => false, earnedDayUsedError: () => null,
  });
  const deps = [r(2, 'late-out', '2027-11-06'), r(3, 'early-morning', '2027-11-06')];
  assert.strictEqual(X.dependentsMismatchOrGuardError([3, 2], deps, [], {}), null);
  assert.strictEqual(X.dependentsMismatchOrGuardError(undefined, deps, [], {}), null, 'old client: no cross-check');
  const mm = J(X.dependentsMismatchOrGuardError([2], deps, [], {}));
  assert.strictEqual(mm.status, 409);
  assert.deepStrictEqual(mm.body.dependents.map(d => d.id), [2, 3]);
  const fz = J(X.dependentsMismatchOrGuardError([4], [r(4, 'late-out', '2027-11-06', 'approved', 99)], [], {}));
  assert.deepStrictEqual([fz.status, fz.body.code, fz.body.dependentId], [409, 'period-frozen', 4]);
});

// ---------------------------------------------------------------------------------------------
console.log('Final round: Approvals view reset (review M-3), Late Night threshold after midnight (review LOW)');
test('navigateTo(approval) shows the queue; only openVoidHistoryForDate keeps the history view; logout resets', () => {
  const navs = [];
  const ctx = { isMdAccountingView: () => true, periodIndexForDateStr: () => 3, allowNav: true };
  ctx.navigateTo = page => { navs.push(page); if (ctx.allowNav && page === 'approval') ctx.resetApprovalViewOnNavigate(); };
  const X = sandbox(APP_SRC, ['resetApprovalViewOnNavigate', 'resetApprovalViewState', 'setApprovalView', 'openVoidHistoryForDate'], ctx,
    "let _approvalView = 'queue'; let _voidHistoryPeriod = 0; let _approvalViewKeepOnce = false; function renderApprovals() {}\n" +
    'this.st = () => [_approvalView, _voidHistoryPeriod, _approvalViewKeepOnce];');
  X.setApprovalView('void-history');
  X.navigateTo('approval');
  assert.deepStrictEqual(J(X.st()), ['queue', 0, false], 'plain navigation -> queue');
  X.openVoidHistoryForDate('2027-11-06');
  assert.deepStrictEqual(J(X.st()), ['void-history', 3, false], 'history link keeps the history view, flag consumed');
  X.navigateTo('approval');
  assert.strictEqual(X.st()[0], 'queue', 'the next plain visit is the queue again');
  ctx.allowNav = false; // role guard refuses the navigation
  X.openVoidHistoryForDate('2027-11-06');
  assert.strictEqual(X.st()[2], false, 'flag never leaks into a later visit');
  X.resetApprovalViewState();
  assert.deepStrictEqual(J(X.st()), ['queue', 0, false]);
  const nav = extractFunction(APP_SRC, 'navigateTo');
  assert.ok(nav.includes("if (page === 'approval')     { resetApprovalViewOnNavigate(); renderApprovals(); }"));
  assert.ok(/resetNotifications\(\);[\s\S]{0,120}resetApprovalViewState\(\);/.test(extractFunction(APP_SRC, 'logout')), 'logout');
});
test('lateNightThresholdMins / lateNightPoints identical both sides; a threshold before 05 is after midnight', () => {
  ['lateNightThresholdMins', 'lateNightPoints', 'checkoutReviewTrigger'].forEach(sameSource);
  const names = ['lateNightCheckoutMins', 'lateNightThresholdMins', 'lateNightThresholdHourOf', 'lateNightPoints'];
  for (const [side, X] of [['client', sandbox(APP_SRC, names, {})], ['server', sandbox(SERVER_SRC, names, {})]]) {
    assert.strictEqual(X.lateNightThresholdMins(19), 19 * 60, side);
    assert.strictEqual(X.lateNightThresholdMins(1), 25 * 60, side);
    assert.strictEqual(X.lateNightThresholdMins(0), 24 * 60, side);
    assert.strictEqual(X.lateNightThresholdMins(5), 5 * 60, side);
    assert.ok(Number.isNaN(X.lateNightThresholdMins('x')), side);
    // x2 from 20:00 (x1 from 19)
    assert.strictEqual(X.lateNightPoints('19:30', 20), 1, side);
    assert.strictEqual(X.lateNightPoints('20:00', 20), 2, side);
    assert.strictEqual(X.lateNightPoints('01:30', 20), 2, side);
    // x2 from 01:00 (= 25:00): the evening is x1, only after 01:00 is x2
    assert.strictEqual(X.lateNightPoints('19:00', 1), 1, `${side}: used to be 2 (19:00 >= 01:00)`);
    assert.strictEqual(X.lateNightPoints('23:59', 1), 1, side);
    assert.strictEqual(X.lateNightPoints('00:59', 1), 1, side);
    assert.strictEqual(X.lateNightPoints('01:00', 1), 2, side);
    assert.strictEqual(X.lateNightPoints('04:59', 1), 2, side);
  }
  const trig = ['client', 'server'].map(side => sandbox(side === 'client' ? APP_SRC : SERVER_SRC,
    ['lateNightCheckoutMins', 'lateNightThresholdMins', 'lateNightThresholdHourOf', 'checkoutReviewTrigger'], {
      isFullDayPersonalLeaveStatus: () => false, isAllowanceEligible: () => true }));
  const S1 = thr => ({ allowances: { lateNightThreshold1Hour: thr }, allowanceEligibility: {} });
  const day = out => ({ checkIn: '08:30', checkOut: out, checkOutSource: 'web', status: 'present' });
  for (const X of trig) {
    assert.strictEqual(X.checkoutReviewTrigger(day('19:00'), { role: 'user' }, S1(19)), true);
    assert.strictEqual(X.checkoutReviewTrigger(day('23:00'), { role: 'user' }, S1(1)), false, 'x1 from 01:00: 23:00 is not yet');
    assert.strictEqual(X.checkoutReviewTrigger(day('01:10'), { role: 'user' }, S1(1)), true);
  }
});

Promise.all(pending).then(() => console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ', 0 failed'}`));
