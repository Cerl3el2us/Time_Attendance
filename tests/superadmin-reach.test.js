// A new feature must still be inspectable through superadmin (2026-10-08).
//
// Spec: docs/superpowers/specs/2026-10-08-superadmin-reach-rules-design.md
// Rule: AGENTS.md section 7a (R2).
//
// 2026-10-08 (owner): the superadmin account exists so a bug can be found by looking at the app as
// a role, or as a specific person. That only keeps working if every feature written AFTER it obeys
// two mechanical habits. Neither is obvious, both are easy to get wrong while writing something
// else, and the damage is silent -- which is why they are a test and not only a paragraph.
//
// These are GUARD tests. They are not here to catch an ordinary bug. They exist so that the day
// someone adds the wrong kind of call, `npm run check` goes red and they have to decide,
// deliberately, to widen an allowlist that says in writing why each entry is allowed.
//
// What goes wrong without them:
//
//   1. A "can I do this?" gate that reads currentUser.role instead of effectiveRole() judges the
//      superadmin account itself, not the role being previewed. The button layer asks
//      effectiveRole() (previewing Staff -> the button is shown) while the gate asks the raw role
//      ('superadmin', which appears in no eligibility list -> every date refused). Visible buttons,
//      dead pickers. tests/preview-role.test.js guards the gates that exist today; this file guards
//      against new ones appearing.
//
//   2. A write sent with a bare fetch() skips apiFetch, and apiFetch is where the whole dry-run
//      mechanism hangs: writeGateRefusal() -> the X-Dry-Run header -> the server throwing the write
//      away. A bare fetch() while impersonating a PERSON really writes, and the record is stamped
//      with that employee's name. With no activity log there is nothing to show it was the system
//      account. They would be answerable for something they did not do. This is the worst outcome
//      any rule in this file prevents.
//
// Not covered here, on purpose: a NEW menu that forgets to list superadmin among the roles that can
// see it (R2.3). A test cannot know about a menu nobody has written yet. The third check below only
// keeps the branch that exists today from being deleted. R2.3 otherwise rests on AGENTS.md and on
// human review -- see the spec, which says so plainly rather than implying this file closes it.
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const APP_SRC = fs.readFileSync(path.join(ROOT, 'attendance/js/app.js'), 'utf8');
const HTML_SRC = fs.readFileSync(path.join(ROOT, 'attendance/index.html'), 'utf8');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok ', name); }
  catch (e) { process.exitCode = 1; console.log('  FAIL', name, '\n      ', e.message); }
}

// The top-level function a line sits inside. Scanning backwards for a `function name(` written hard
// against the left margin is what makes this answer "top-level": a nested helper is indented, so it
// is skipped and its enclosing declaration is reported instead. That is the granularity the
// allowlists below are written at.
function enclosingFn(lines, lineNo) {
  for (let i = lineNo - 1; i >= 0; i--) {
    const m = /^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/.exec(lines[i]);
    if (m) return m[1];
  }
  return '(top level)';
}

// Lines matching `re`, skipping ones that are entirely a comment. Same simple rule the rest of the
// suite uses: a line whose first non-space character starts a `//` or continues a `/* */` block.
// A match tucked after code on the same line as a trailing comment would still be reported, which
// is the safe direction to be wrong in -- a false alarm is read by a human, a miss is not.
function scan(src, re) {
  const lines = src.split('\n');
  const hits = [];
  lines.forEach((line, i) => {
    if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
    if (re.test(line)) hits.push({ line: i + 1, fn: enclosingFn(lines, i + 1), text: line.trim() });
  });
  return hits;
}

function offenders(hits, allowed) {
  return hits.filter(h => !allowed.has(h.fn))
    .map(h => `app.js:${h.line} in ${h.fn}()  ${h.text.slice(0, 90)}`);
}

// Brace-balanced body of a top-level function, the same way the other source-reading suites do it.
function extractFunction(src, name) {
  const re = new RegExp(`^(?:async\\s+)?function ${name}\\(`, 'm');
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

// ---------------------------------------------------------------------------------------------
// 1. Raw currentUser.role
//
// Every entry here is a place that is NOT a "can I do this?" gate, which is the only kind of read
// the rule is about. Adding a name to this list means writing down which of these it is.
const ALLOW_RAW_ROLE = new Set([
  'effectiveRole',          // defines the rule; it is the one place that must read the raw role
  'updateSystemAccountUI',  // a label on screen, not a permission decision
  'updateUserUI',           // the sidebar role badge -- and it handles previewRole explicitly
  'saveEmployee',           // WRITES currentUser.role back (rollback after a failed save), not a read
]);
const RAW_ROLE_RE = /currentUser\.role/;

// 2. Raw fetch()
//
// `apiFetch(` does not match: the regex wants a lowercase `fetch` not preceded by a word character
// or a dot, so neither apiFetch( nor window.fetch( is picked up by accident.
const ALLOW_RAW_FETCH = new Set([
  'apiFetch',            // the real one; every other write is supposed to come through here
  'login',               // runs before a session exists, so it cannot pass through the gate
  'getVapidPublicKey',   // GET
  'loadGpsCartoStyle',   // GET
  'reverseGeocode',      // GET, and to a third party (OpenStreetMap), not to our backend
]);
const RAW_FETCH_RE = /(^|[^.\w$])fetch\s*\(/;

const roleHits = scan(APP_SRC, RAW_ROLE_RE);
const fetchHits = scan(APP_SRC, RAW_FETCH_RE);

console.log(`Superadmin reach — ${roleHits.length} raw currentUser.role reads, ${fetchHits.length} raw fetch() calls`);

test('the scanner still finds the call sites it is supposed to be watching', () => {
  // If either count falls to zero the suite is silently checking nothing -- far more likely the
  // source moved under it than that every call site disappeared.
  assert.ok(roleHits.length > 0, 'no currentUser.role found at all — has the scanner broken?');
  assert.ok(fetchHits.length > 0, 'no fetch( found at all — has the scanner broken?');
});

test('the checker itself actually catches a new raw role gate', () => {
  // A guard that has never been seen to fail is not a guard.
  const fake = [
    'function canDoTheNewThing() {',
    "  if (currentUser.role === 'md') return true;",
    '  return false;',
    '}',
  ].join('\n');
  const found = offenders(scan(fake, RAW_ROLE_RE), ALLOW_RAW_ROLE);
  assert.strictEqual(found.length, 1, `expected one offender, got ${JSON.stringify(found)}`);
  assert.ok(found[0].includes('canDoTheNewThing'), found[0]);
});

test('the checker itself actually catches a new raw fetch', () => {
  const fake = [
    'function submitTheNewThing() {',
    "  return fetch('/api/new-thing', { method: 'POST' });",
    '}',
  ].join('\n');
  const found = offenders(scan(fake, RAW_FETCH_RE), ALLOW_RAW_FETCH);
  assert.strictEqual(found.length, 1, `expected one offender, got ${JSON.stringify(found)}`);
  assert.ok(found[0].includes('submitTheNewThing'), found[0]);
});

test('the checker does not mistake apiFetch() for a raw fetch', () => {
  const fake = [
    'function submitProperly() {',
    "  return apiFetch('/api/new-thing', { method: 'POST' });",
    '}',
  ].join('\n');
  assert.strictEqual(scan(fake, RAW_FETCH_RE).length, 0, 'apiFetch( was read as a raw fetch(');
});

test('a "can I do this?" gate asks effectiveRole(), never currentUser.role', () => {
  const bad = offenders(roleHits, ALLOW_RAW_ROLE);
  assert.strictEqual(bad.length, 0,
    '\n       A gate reading the raw role judges the superadmin ACCOUNT, not the role being' +
    '\n       previewed, so "view as Staff" shows the button and then refuses every date.' +
    '\n       Use effectiveRole(), or gateRoleFor(user, uid) when the subject may be someone else.' +
    '\n       If this really is a label or a write rather than a gate, add it to ALLOW_RAW_ROLE' +
    '\n       with a comment saying which.\n       ' + bad.join('\n       '));
});

test('every write goes through apiFetch, so the dry run can intercept it', () => {
  const bad = offenders(fetchHits, ALLOW_RAW_FETCH);
  assert.strictEqual(bad.length, 0,
    '\n       A bare fetch() skips writeGateRefusal(), so while superadmin is impersonating a' +
    '\n       PERSON this write really happens — stamped with that employee\'s name, with nothing' +
    '\n       to show it was not them. Call apiFetch() instead. A genuinely session-less or' +
    '\n       read-only call goes in ALLOW_RAW_FETCH with a comment saying which.\n       ' +
    bad.join('\n       '));
});

// ---------------------------------------------------------------------------------------------
// 3. Full access still reaches the menus
test('applyRolePermissions() still has a superadmin branch', () => {
  const body = extractFunction(APP_SRC, 'applyRolePermissions');
  assert.ok(/role === 'superadmin'/.test(body),
    '\n       Without its own branch, Full-access superadmin falls through to the else and loses' +
    '\n       menus it is supposed to inspect. See AGENTS.md section 7a (R2.3).');
});

test('index.html carries no role gate or fetch of its own', () => {
  // Nothing in the page does either today. The rules above only read app.js, so this keeps that
  // scope honest: if logic starts appearing in the HTML, this fails and the scanner gets widened
  // rather than quietly covering less than it claims.
  assert.strictEqual(scan(HTML_SRC, RAW_ROLE_RE).length, 0, 'currentUser.role appeared in index.html');
  assert.strictEqual(scan(HTML_SRC, RAW_FETCH_RE).length, 0, 'a raw fetch( appeared in index.html');
});

console.log(`\n${passed} passed`);
