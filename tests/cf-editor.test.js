// PUT /api/leave-carry-forward -- the manual per-employee carry-forward override (2026-09-24).
// Static assertions against server.js / app.js, the same style as the other suites here.
//
// The range test exists because the first version shipped `year < firstYear + 1`, which on a
// 2026 go-live made the accepted range [2027, 2027] and refused EVERY real request -- including
// the one row that actually exists (2026_4, carried in from 2025, i.e. from before the system).
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SERVER_SRC = fs.readFileSync(path.join(ROOT, 'attendance-server/backend/server.js'), 'utf8');
const APP_SRC = fs.readFileSync(path.join(ROOT, 'attendance/js/app.js'), 'utf8');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok ', name); }
  catch (e) { process.exitCode = 1; console.log('  FAIL', name, '\n      ', e.message); }
}

const ROUTE_START = SERVER_SRC.indexOf("app.put('/api/leave-carry-forward'");
const route = SERVER_SRC.slice(ROUTE_START, ROUTE_START + 4000);

console.log('CF editor: PUT /api/leave-carry-forward');

test('route exists and is gated to md + accounting', () => {
  assert.ok(ROUTE_START > 0, 'route not found');
  assert.ok(/requireRole\('md', 'accounting'\)/.test(route), 'must be requireRole(md, accounting)');
  assert.ok(/withLeavesLock/.test(route), 'must hold the same lock as runYearEndCarryForward');
});

test('the go-live year itself is accepted (regression: range was [firstYear+1, ...])', () => {
  assert.ok(/year < firstYear \|\|/.test(route),
    'lower bound must be firstYear, not firstYear + 1 -- the go-live year holds real carry-forward');
  assert.ok(!/year < firstYear \+ 1/.test(route), 'firstYear + 1 lower bound is the shipped bug');
  assert.ok(/year > thisYear \+ 1/.test(route), 'next year stays editable after a January run');
  // Reproduce the comparison the route makes, for a 2026 go-live in 2026.
  const inRange = (y, firstYear, thisYear) => Number.isInteger(y) && y >= firstYear && y <= thisYear + 1;
  assert.strictEqual(inRange(2026, 2026, 2026), true, '2026 must be editable');
  assert.strictEqual(inRange(2027, 2026, 2026), true, '2027 must be editable');
  assert.strictEqual(inRange(2025, 2026, 2026), false, 'before go-live must be refused');
  assert.strictEqual(inRange(2028, 2026, 2026), false, 'two years ahead must be refused');
  assert.strictEqual(inRange(2026.5, 2026, 2026), false, 'non-integer must be refused');
});

test('days are bounded by the same cap the year-end run uses', () => {
  assert.ok(/carryForwardMax \?\? 5/.test(route), '?? not || -- a configured 0 means zero');
  assert.ok(/Math\.min\(60, Number\.isFinite\(rawMax\) \? rawMax : 5\)/.test(route), 'hard 60 ceiling');
  assert.ok(/days < 0 \|\| days > maxCF/.test(route));
  assert.ok(/Math\.round\(days \* 1000\) \/ 1000/.test(route), '3 dp = 1-minute resolution');
});

test('writes only the one key, and records who changed it', () => {
  assert.ok(/\[key\]: value/.test(route), 'must merge a single key, never replace the map');
  assert.ok(/leaveCarryForwardEdits/.test(route), 'an override must leave an audit entry');
  assert.ok(/prevDays/.test(route), 'the audit must keep the previous value');
  assert.ok(/isSystemAccount/.test(route), 'system accounts are not employees');
});

test('the audit is server-owned and never leaves the admin boundary', () => {
  const put = SERVER_SRC.slice(SERVER_SRC.indexOf("app.put('/api/settings'"));
  assert.ok(put.slice(0, 5000).includes("'leaveCarryForwardEdits'"),
    'PUT /api/settings must refuse it -- otherwise an editor could erase their own entry');
  const strip = SERVER_SRC.slice(SERVER_SRC.indexOf('function stripSensitiveSettingsForRole'));
  assert.ok(/delete out\.leaveCarryForwardEdits/.test(strip.slice(0, 2000)),
    'it names who edited whose balance -- must be stripped below admin');
});

test('client sends only changed rows and confirms first', () => {
  const fn = APP_SRC.slice(APP_SRC.indexOf('async function saveCarryForwardFromUI'),
                           APP_SRC.indexOf('async function saveOpeningLeaveBalancesFromUI'));
  assert.ok(fn.length > 100, 'saveCarryForwardFromUI not found');
  assert.ok(/confirm\(/.test(fn), 'a leave-balance change is never silent');
  assert.ok(/Math\.round\(after \* 1000\) !== Math\.round/.test(fn),
    'unchanged rows must not be resent (they would create spurious audit entries)');
  assert.ok(/DATA_USERS/.test(fn) && !/\(USERS \|\|/.test(fn), 'USERS is not a global; DATA_USERS is');
  assert.ok(!/\bloadSettings\(\)/.test(fn) && !/\brenderSettings\(\)/.test(fn),
    'those two do not exist -- the real names are loadSettingsFromBackend / renderSettingsPage');
});

test('one Save button, and carry-forward is written BEFORE opening balances', () => {
  const panel = APP_SRC.slice(APP_SRC.indexOf('async function saveOpeningPanel'),
                              APP_SRC.indexOf('async function saveOpeningLeaveBalancesFromUI'));
  assert.ok(panel.length > 100, 'saveOpeningPanel not found');
  const cfAt = panel.indexOf('saveCarryForwardFromUI');
  const opAt = panel.indexOf('saveOpeningLeaveBalancesFromUI');
  assert.ok(cfAt > -1 && opAt > -1, 'the panel must drive both saves');
  // The opening figure is derived from pool - used - typed remaining, and the pool includes
  // carry-forward. Written the other way round, the opening value is calibrated against the OLD
  // carry-forward and is silently wrong.
  assert.ok(cfAt < opAt, 'carry-forward must be saved first -- the opening figure depends on it');
  assert.ok(/LEAVE_CARRY_FORWARD\[getCarryForwardKey\(year, c\.userId\)\] = Number\(data\.days\)/
    .test(APP_SRC), 'the in-memory map must be refreshed before the opening calc reads it');
  // Exactly one save button in the panel, wired to the combined handler.
  const section = APP_SRC.slice(APP_SRC.indexOf('function openingLeaveBalancesSectionHtml'),
                                APP_SRC.indexOf('async function saveCarryForwardFromUI'));
  const buttons = section.match(/onclick="save[A-Za-z]+\(/g) || [];
  assert.deepStrictEqual(buttons, ['onclick="saveOpeningPanel('], 'exactly one save button');
});

test('a manual override survives the snapshot refresher (Opus review HIGH)', () => {
  const fn = SERVER_SRC.slice(SERVER_SRC.indexOf('function refreshSnapshottedCarryForward'));
  const body = fn.slice(0, fn.indexOf('\n}') + 2);
  assert.ok(/leaveCarryForwardEdits/.test(body),
    'refreshSnapshottedCarryForward fires on every annual-leave create/edit/approve/cancel; without ' +
    'this guard it recomputed a figure a human had just corrected, while the audit still named them');
  // Match the statements exactly: `cf[nextKey] =` also matches the `cf[nextKey] === undefined`
  // precondition several lines ABOVE the guard, which made this assertion fail on correct code.
  const guardAt = body.indexOf('if (plainObj(settings.leaveCarryForwardEdits)[nextKey]) return;');
  const writeAt = body.indexOf('cf[nextKey] = Math.min(');
  assert.ok(guardAt > -1, 'guard statement not found');
  assert.ok(writeAt > -1, 'write statement not found');
  assert.ok(guardAt < writeAt, 'the guard must return before the write');
  // The once-a-year run is deliberately NOT guarded: it is the authoritative recomputation and its
  // confirm dialog already says existing values are overwritten.
  const run = SERVER_SRC.slice(SERVER_SRC.indexOf('function runYearEndCarryForward'));
  assert.ok(!/leaveCarryForwardEdits/.test(run.slice(0, run.indexOf('\n}') + 2)),
    'the year-end run must keep overwriting -- only the per-leave refresher is guarded');
});

test('carry-forward cannot be edited after it has expired (owner: block)', () => {
  assert.ok(/cf-after-expiry/.test(route), 'server must refuse it');
  assert.ok(/carryForwardExpiryEnabled\(\) && bangkokDateStr\(\) > expiryStr/.test(route),
    'refusal must be keyed on the configured expiry date, not a hardcoded month');
  const section = APP_SRC.slice(APP_SRC.indexOf('function openingLeaveBalancesSectionHtml'),
                                APP_SRC.indexOf('async function saveCarryForwardFromUI'));
  assert.ok(/const cfLocked =/.test(section) && /cfLocked \? ' disabled' : ''/.test(section),
    'the inputs must render disabled once expired');
  const save = APP_SRC.slice(APP_SRC.indexOf('async function saveCarryForwardFromUI'));
  assert.ok(/businessDateStr\(\) > carryForwardExpiryDateStr\(year\)/.test(save.slice(0, 2000)),
    'the stale-tab case must be refused client-side too');
});

test('the editable box binds to carry-forward only, never carry-forward + comp (Opus review HIGH)', () => {
  const section = APP_SRC.slice(APP_SRC.indexOf('function openingLeaveBalancesSectionHtml'),
                                APP_SRC.indexOf('async function saveCarryForwardFromUI'));
  assert.ok(/const aCfEditable = getCarryForwardDays\(year, u\.id\);/.test(section),
    'the box needs its own value without the comp days');
  assert.ok(/data-cf-initial="\$\{escapeHtml\(String\(aCfEditable\)\)\}"/.test(section)
         && /value="\$\{escapeHtml\(String\(aCfEditable\)\)\}"/.test(section),
    'both the value and the change-detection baseline must use it');
  // aCf (cf + comp) is still right for the pool column -- it must not leak back into the input.
  assert.ok(!/data-cf-initial="\$\{escapeHtml\(String\(aCf\)\)\}"/.test(section),
    'pre-filling with cf + comp made every save fold the comp days into carry-forward');
});

test('opening balances stay locked to the go-live year', () => {
  assert.ok(/opening-go-live-year-only/.test(SERVER_SRC), 'server must enforce it, not just the UI');
  assert.ok(/function openingBalancesEditableYear/.test(APP_SRC));
  const save = APP_SRC.slice(APP_SRC.indexOf('async function saveOpeningLeaveBalancesFromUI'));
  assert.ok(/year !== openingBalancesEditableYear\(\)/.test(save.slice(0, 1200)),
    'the stale-tab case (button clicked after midnight on 31 Dec) must be refused client-side too');
});

console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ', 0 failed'}`);
