// Person impersonation: the real account vs the rendered one (2026-10-05).
// Spec: docs/superpowers/specs/2026-10-05-superadmin-inspector-design.md
//
// GUARD tests for the invariant the whole feature rests on: `currentUser` is who the screen is
// rendering as, `realUser` is who logged in, and three things must follow the REAL one. Each of
// them fails quietly and dangerously if it ever reads the impersonated record instead:
//   isSuperAdmin() — the write gate and banner vanish, so writes stop being gated at all
//   saveSession()  — a reload comes back logged in as the person being inspected
//   the auth token — the server would stop seeing who is really calling
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const APP_SRC = fs.readFileSync(path.join(ROOT, 'attendance/js/app.js'), 'utf8');

function extractFunction(src, name) {
  const re = new RegExp(`^(async )?function ${name}\\(`, 'm');
  const m = re.exec(src);
  if (!m) throw new Error(`function ${name} not found`);
  let i = src.indexOf('(', m.index);
  let paren = 0;
  for (; i < src.length; i++) {
    if (src[i] === '(') paren++;
    else if (src[i] === ')') { paren--; if (paren === 0) { i++; break; } }
  }
  const bodyStart = src.indexOf('{', i);
  let depth = 0;
  for (let j = bodyStart; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (depth === 0) return src.slice(m.index, j + 1); }
  }
  throw new Error(`unbalanced ${name}`);
}

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok  ${name}`); }
  catch (e) { process.exitCode = 1; console.log(`  FAIL  ${name}\n        ${e.message}`); }
}

const SYS = { id: 99, role: 'superadmin', isSystemAccount: true, startDate: '' };
const STAFF = { id: 7, role: 'user', startDate: '2024-01-15' };

function world(real, rendered) {
  const ctx = { console, realUser: real, currentUser: rendered };
  vm.createContext(ctx);
  ['loggedInUser', 'isSuperAdmin'].forEach(n => vm.runInContext(extractFunction(APP_SRC, n), ctx));
  return ctx;
}

console.log('Impersonation: who the system is talking about');

test('with nobody impersonated, the two are the same account', () => {
  const w = world(SYS, SYS);
  assert.strictEqual(w.isSuperAdmin(), true);
});
test('while rendering as an employee, isSuperAdmin still answers for the real account', () => {
  const w = world(SYS, STAFF);
  assert.strictEqual(w.isSuperAdmin(), true,
    'reading the impersonated record here would remove the write gate from every write in the app');
});
test('an ordinary login is never mistaken for the system account', () => {
  const w = world(STAFF, STAFF);
  assert.strictEqual(w.isSuperAdmin(), false);
});
test('a staff account cannot become the system account by being impersonated', () => {
  // The direction that matters least today but would matter most if it ever broke.
  const w = world(STAFF, SYS);
  assert.strictEqual(w.isSuperAdmin(), false,
    'authority must come from who logged in, never from what is on screen');
});
test('loggedInUser falls back to currentUser before a session exists', () => {
  const w = world(null, SYS);
  assert.strictEqual(w.loggedInUser(), SYS);
});

console.log('\nImpersonation: what gets persisted and what decides authority');

test('isSuperAdmin reads the real account, not currentUser', () => {
  const fn = extractFunction(APP_SRC, 'isSuperAdmin');
  assert.ok(/loggedInUser\(\)/.test(fn), 'isSuperAdmin must go through loggedInUser()');
  assert.ok(!/currentUser/.test(fn),
    'isSuperAdmin must not read currentUser — it would follow the impersonated person');
});
test('the session stores the real account', () => {
  const fn = extractFunction(APP_SRC, 'saveSession');
  assert.ok(/ta_user[\s\S]{0,80}loggedInUser\(\)/.test(fn),
    'saveSession must persist the real account — otherwise a reload returns logged in as the person being inspected');
});
test('currentUser only diverges from realUser where impersonation says it may', () => {
  // Drift between the two is the failure mode this whole design has to avoid, and it happens by
  // somebody adding an assignment and not noticing the others came in pairs. Three right-hand sides
  // are legitimate on their own; everything else must move realUser with it.
  //   null      — the declaration and logout
  //   realUser  — putting the screen back to the real account
  //   target    — applyPreviewUser(), the one place impersonation is MEANT to diverge
  const lines = APP_SRC.split('\n');
  const offenders = [];
  lines.forEach((line, i) => {
    const m = /^\s*(?:let\s+)?currentUser = (.+);\s*$/.exec(line);
    if (!m) return;
    const rhs = m[1].trim();
    if (rhs === 'null' || rhs === 'realUser' || rhs === 'target') return;
    const near = lines.slice(Math.max(0, i - 3), i + 3).join('\n');
    if (!/realUser = /.test(near)) offenders.push(i + 1);
  });
  assert.deepStrictEqual(offenders, [],
    `currentUser is assigned without realUser at line(s) ${offenders.join(', ')} — the two must move together`);
});
test('the one deliberate divergence is inside applyPreviewUser and nowhere else', () => {
  const fn = extractFunction(APP_SRC, 'applyPreviewUser');
  assert.ok(/currentUser = target/.test(fn), 'applyPreviewUser is where the screen becomes somebody else');
  assert.ok(!/realUser = /.test(fn),
    'applyPreviewUser must never touch realUser — that is what keeps authority with the real account');
  const elsewhere = APP_SRC.replace(fn, '');
  assert.ok(!/currentUser = target/.test(elsewhere),
    'only applyPreviewUser may point currentUser at another employee');
});

console.log('\nImpersonation: a person on screen means nothing is written');

function gateWorld(real, rendered, previewId) {
  const ctx = {
    console, Response, Date,
    realUser: real, currentUser: rendered,
    previewUserId: previewId || 0,
    previewRole: '',
    currentLang: 'en',
    L: (en) => en,
    prompts: 0,
  };
  ctx.prompt = () => { ctx.prompts++; return 'CONFIRM'; };
  vm.createContext(ctx);
  vm.runInContext('let _gestureSeq = 0; let _confirmedGesture = -1; let _confirmedGestureAt = 0;' +
    'const CONFIRMED_GESTURE_TTL_MS = 120000;', ctx);
  ['loggedInUser', 'isSuperAdmin', 'isImpersonatingPerson', 'gestureAlreadyConfirmed',
   'requireSuperAdminConfirm', 'writeGateLabel', 'gateRefusal', 'writeGateRefusal']
    .forEach(n => vm.runInContext(extractFunction(APP_SRC, n), ctx));
  return ctx;
}

test('isImpersonatingPerson is true only when the screen really is that person', async () => {
  assert.strictEqual(gateWorld(SYS, STAFF, STAFF.id).isImpersonatingPerson(), true);
  assert.strictEqual(gateWorld(SYS, SYS, 0).isImpersonatingPerson(), false);
  // A stale id that does not match who is actually rendered must not count — half-applied
  // impersonation is the state where the screen and the rules disagree.
  assert.strictEqual(gateWorld(SYS, SYS, STAFF.id).isImpersonatingPerson(), false);
  // An ordinary account can never be impersonating, whatever is in localStorage.
  assert.strictEqual(gateWorld(STAFF, STAFF, STAFF.id).isImpersonatingPerson(), false);
});

(async () => {
  const atest = async (name, fn) => {
    try { await fn(); passed++; console.log(`  ok  ${name}`); }
    catch (e) { process.exitCode = 1; console.log(`  FAIL  ${name}\n        ${e.message}`); }
  };

  await atest('a write while impersonating becomes a dry run, without even asking', async () => {
    const c = gateWorld(SYS, STAFF, STAFF.id);
    const verdict = await c.writeGateRefusal('/api/leaves', 'POST');
    assert.strictEqual(verdict, 'dry-run',
      'the request goes out for real so the SERVER can judge it — most of the rules that refuse a ' +
      'request live there, and that is where the bugs worth finding are');
    assert.strictEqual(c.prompts, 0,
      'no CONFIRM may be offered — typing it cannot fix the record being stamped with the wrong name');
  });
  await atest('the same write at Full access only asks', async () => {
    const c = gateWorld(SYS, SYS, 0);
    assert.strictEqual(await c.writeGateRefusal('/api/leaves', 'POST'), null);
    assert.strictEqual(c.prompts, 1);
  });
  await atest('machine housekeeping is exempt from CONFIRM but never from the person block', async () => {
    // systemSync skips the prompt; it must not skip this. Checked at the apiFetch call site.
    const fn = extractFunction(APP_SRC, 'apiFetch');
    assert.ok(/!isSystemSyncWrite\(opts\)\s*\|\|\s*isImpersonatingPerson\(\)/.test(fn),
      'while the screen is somebody else, nothing this tab does may write — housekeeping included');
  });

  console.log('\nImpersonation: leaving, and coming back');

  test('exiting drops the person before the role', () => {
    const fn = extractFunction(APP_SRC, 'exitRolePreview');
    const personIdx = fn.indexOf('applyPreviewUser(0)');
    const roleIdx = fn.indexOf('onRolePreviewChange');
    assert.ok(personIdx > -1 && roleIdx > personIdx,
      'clearing the role first would show Full access over a screen still rendering as somebody else');
  });
  test('login clears the person as well as the role', () => {
    const fn = extractFunction(APP_SRC, 'resetRolePreview');
    assert.ok(/previewUserId = 0/.test(fn), 'resetRolePreview must clear the impersonated person');
    assert.ok(/ta_preview_user/.test(fn), 'and must not leave it in localStorage to come back');
    assert.ok(/currentUser = realUser/.test(fn), 'and must put the screen back to the real account');
  });
  test('the picker never offers the system account', () => {
    const fn = extractFunction(APP_SRC, 'renderPreviewUserOptions');
    assert.ok(/isEmployeeRecord\(u\)/.test(fn),
      'the system account is not an employee and must never appear in a staff list');
  });
  test('a missing employee falls back to the real account rather than half-applying', () => {
    const fn = extractFunction(APP_SRC, 'applyPreviewUser');
    assert.ok(/return false/.test(fn), 'it must report the failure');
    const notFound = fn.slice(fn.indexOf('if (!target)'));
    assert.ok(/previewUserId = 0/.test(notFound) && /currentUser = realUser/.test(notFound),
      'a half-applied impersonation is the state where the screen and the rules disagree');
  });

  console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ', 0 failed'}`);
})();
