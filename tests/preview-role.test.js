// Role preview consistency (2026-10-05).
// Spec: docs/superpowers/specs/2026-10-05-superadmin-inspector-design.md
//
// These are GUARD tests. They are not here to catch an ordinary bug — they exist so that if anyone
// later makes a "can I do this?" gate read the raw role again, `npm run check` goes red and they
// have to decide, deliberately, to delete a test that says what it protects.
//
// The symptom they guard against: the button layer asks effectiveRole() (previewing Staff → the
// request button is shown) while the gate asked currentUser.role ('superadmin', which appears in no
// eligibility list → every date refused as 'ineligible'). Visible buttons, dead date pickers.
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
  let i = src.indexOf('{', m.index);
  let depth = 0;
  for (let j = i; j < src.length; j++) {
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

// A sandbox holding the real preview helpers plus gateRoleFor.
// `who` is the logged-in user; `preview` is what the role-preview dropdown is set to.
function world(who, preview) {
  const ctx = { console, currentUser: who, previewRole: preview || '' };
  vm.createContext(ctx);
  ['isSuperAdmin', 'effectiveRole', 'gateRoleFor'].forEach(n =>
    vm.runInContext(extractFunction(APP_SRC, n), ctx));
  return ctx;
}
const SUPER = { id: 99, role: 'superadmin', isSystemAccount: true };
const STAFF = { id: 7, role: 'user' };
const OTHER = { id: 5, role: 'driver' };

console.log('Role preview: a "can I" gate judges by the role being acted as');

test('superadmin previewing Staff is judged as Staff for their own gate', () => {
  const w = world(SUPER, 'user');
  assert.strictEqual(w.gateRoleFor(SUPER, SUPER.id), 'user');
});
test('superadmin with no preview is judged as superadmin', () => {
  const w = world(SUPER, '');
  assert.strictEqual(w.gateRoleFor(SUPER, SUPER.id), 'superadmin');
});
test('an ordinary user is judged by their real role, preview or not', () => {
  const w = world(STAFF, 'md');   // previewRole is ignored for non-superadmins
  assert.strictEqual(w.gateRoleFor(STAFF, STAFF.id), 'user');
});
test('asking about SOMEBODY ELSE always uses that person\'s own role', () => {
  const w = world(SUPER, 'user');
  assert.strictEqual(w.gateRoleFor(OTHER, OTHER.id), 'driver',
    'another employee\'s entitlement must never be reinterpreted through the viewer\'s preview');
});
test('a string id for the same person still counts as self', () => {
  const w = world(SUPER, 'manager');
  assert.strictEqual(w.gateRoleFor(SUPER, String(SUPER.id)), 'manager',
    'uid arrives from DOM attributes in places, so the self test must not be type-strict');
});

console.log('\nRole preview: the gates themselves are wired to gateRoleFor');

// Source-level guards. The eligibility read inside each of these gates must go through
// gateRoleFor(), not the raw `user.role` — that is the whole fix, and it is easy to undo by
// accident while editing a neighbouring line.
const GATES = [
  'canSubmitOTForDate',
  'canSubmitDriverOTForDate',
  'canSubmitUpcountryForDate',
  'canSubmitLongDistanceForDate',
  'canSubmitHolidayWorkForDate',
  'canSubmitEarlyMorningForDate',
  'canSubmitLateNightForDate',
];
GATES.forEach(name => {
  test(`${name} judges by gateRoleFor, not the raw role`, () => {
    const fn = extractFunction(APP_SRC, name);
    assert.ok(/gateRoleFor\(/.test(fn), `${name} must resolve its role through gateRoleFor()`);
    assert.ok(!/\buser\.role\b/.test(fn),
      `${name} still reads user.role directly — the self case would stop following the role preview`);
  });
});

test('geofenceUiState follows the preview like every other check-in gate', () => {
  const fn = extractFunction(APP_SRC, 'geofenceUiState');
  assert.ok(/effectiveRole\(\)/.test(fn), 'geofenceUiState must ask effectiveRole()');
  assert.ok(!/currentUser\s*&&\s*currentUser\.role/.test(fn),
    'geofenceUiState must not read the raw role — the geofence could then never be exercised from a preview');
});

console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ', 0 failed'}`);
