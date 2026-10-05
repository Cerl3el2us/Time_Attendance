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
test('every place that sets currentUser also sets realUser', () => {
  // Drift between the two is the failure mode this whole design has to avoid, and it happens by
  // somebody adding a sixth assignment and not noticing the first five came in pairs.
  const assigns = [...APP_SRC.matchAll(/^\s*(?:let\s+)?currentUser = (.+);/gm)];
  const lines = assigns.map(m => APP_SRC.slice(0, m.index).split('\n').length);
  const unpaired = lines.filter(line => {
    const near = APP_SRC.split('\n').slice(Math.max(0, line - 4), line + 2).join('\n');
    return !/realUser = /.test(near) && !/let currentUser = null/.test(near);
  });
  assert.deepStrictEqual(unpaired, [],
    `currentUser is assigned without realUser at line(s) ${unpaired.join(', ')} — the two must move together`);
});

console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ', 0 failed'}`);
