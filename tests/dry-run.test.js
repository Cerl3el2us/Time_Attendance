// Dry run: the system account presses the real buttons and nothing is left behind (2026-10-05).
// Spec: docs/superpowers/specs/2026-10-05-superadmin-inspector-design.md
//
// GUARD tests. A dry run that leaks is worse than no dry run at all: the person is told nothing
// happened while a request, a notification, or a row on a colleague's screen says otherwise. Each
// test below pins one of the three places a trace can escape, plus the rule that decides who may
// ask for a dry run in the first place.
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const APP_SRC = fs.readFileSync(path.join(ROOT, 'attendance/js/app.js'), 'utf8');
const SERVER_SRC = fs.readFileSync(path.join(ROOT, 'attendance-server/backend/server.js'), 'utf8');

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

console.log('Dry run: nothing is left behind');

test('persistence is skipped — atomicWrite is the one place every save goes through', () => {
  const fn = extractFunction(SERVER_SRC, 'atomicWrite');
  assert.ok(/if \(isDryRun\(\)\) return;/.test(fn), 'atomicWrite must return before writing');
  const gateIdx = fn.indexOf('isDryRun()');
  const writeIdx = fn.indexOf('fs.writeFileSync');
  assert.ok(gateIdx > -1 && writeIdx > gateIdx, 'the check must come before the write, not after');
});
test('nobody is notified about a request that does not exist', () => {
  const fn = extractFunction(SERVER_SRC, 'sendPushToUser');
  assert.ok(/if \(isDryRun\(\)\) return;/.test(fn), 'sendPushToUser must bail out');
  // It has to sit above recordNotifications(), or the inbox row is written even though the push
  // is not — a notification with nothing behind it is exactly the thing that alarms people.
  const gateIdx = fn.indexOf('isDryRun()');
  const inboxIdx = fn.indexOf('recordNotifications');
  assert.ok(gateIdx > -1 && inboxIdx > gateIdx,
    'the check must come before the inbox record, not just before the push send');
});
test('no live update reaches a colleague with the page open', () => {
  const fn = extractFunction(SERVER_SRC, 'broadcast');
  assert.ok(/if \(isDryRun\(\)\) return;/.test(fn), 'broadcast must bail out');
});

console.log('\nDry run: who may ask for one');

test('the identity grants it, not the header', () => {
  const mw = /const wantsDryRun[\s\S]{0,400}?runAsDryRun/.exec(SERVER_SRC);
  assert.ok(mw, 'the dry-run decision must live in the auth middleware');
  assert.ok(/isSystemAccountUser\(/.test(mw[0]),
    'the header alone must never be enough — otherwise anyone could have their writes discarded, ' +
    'or probe which requests would be accepted');
  assert.ok(/isWriteRequest\(req\)/.test(mw[0]), 'reads need no dry run and must not be wrapped');
});
test('the live record decides, not the token payload', () => {
  const fn = extractFunction(SERVER_SRC, 'liveUserForDryRun');
  assert.ok(/readUsers\(\)/.test(fn),
    'a frozen JWT payload would keep granting dry runs to an account that has since changed');
});
test('the scope is per request, not a module flag', () => {
  // Handlers are async and interleave; a shared flag set by one request would disarm another's
  // writes — a dry run silently eating a real save is the worst possible failure here.
  assert.ok(/AsyncLocalStorage/.test(SERVER_SRC), 'must use AsyncLocalStorage');
  assert.ok(!/^\s*let\s+_?dryRun\s*=/m.test(SERVER_SRC), 'must not keep a module-level dry-run flag');
});

console.log('\nDry run: the browser asks, the server answers');

test('the client only asks while impersonating a person', () => {
  const fn = extractFunction(APP_SRC, 'writeGateRefusal');
  assert.ok(/isImpersonatingPerson\(\)\) return 'dry-run'/.test(fn),
    'impersonating a person is the one state that turns a write into a dry run');
});
test('apiFetch sends the header and reports the verdict', () => {
  const fn = extractFunction(APP_SRC, 'apiFetch');
  assert.ok(/X-Dry-Run/.test(fn), 'the request must carry the header');
  assert.ok(/reportDryRun\(/.test(fn), 'the verdict must be shown');
  const sendIdx = fn.indexOf("headers['X-Dry-Run']");
  const fetchIdx = fn.indexOf('await fetch(');
  assert.ok(sendIdx > -1 && fetchIdx > sendIdx, 'the header must be set before the request goes out');
});
test('the verdict says it would have saved, and that it did not', () => {
  const fn = extractFunction(APP_SRC, 'reportDryRun');
  assert.ok(/res\.clone\(\)/.test(fn),
    'the body must be cloned — the caller still needs to read it, and a body can only be read once');
  assert.ok(/would really have saved|บันทึกได้/.test(fn), 'a pass must say the button genuinely works');
  assert.ok(/would have been refused|ถูกปฏิเสธ/.test(fn), 'a refusal must be reported as such');
  assert.ok(/d\.message/.test(fn),
    "the server's own reason must be shown — that reason is the bug being looked for");
});

console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ', 0 failed'}`);
