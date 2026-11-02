// The login screen must not call a server fault a wrong password (2026-11-02).
//
// What happened: the backend was restarted under an account that could not read users.json, so
// readUsers() returned null and /api/login answered 503 for every account -- including usernames
// that do not exist. The login card showed "incorrect username or password" for that 503, so the
// owner, and then Claude, spent an hour checking passwords that had never changed and data that
// had never moved. The server had been saying exactly what was wrong the whole time; only the
// wording in the browser threw it away.
//
// No framework: `node tests/login-error-wording.test.js`.
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const APP_SRC = fs.readFileSync(path.join(ROOT, 'attendance/js/app.js'), 'utf8');
const JA_SRC = fs.readFileSync(path.join(ROOT, 'attendance/lang/ja.js'), 'utf8');
const SERVER_SRC = fs.readFileSync(path.join(ROOT, 'attendance-server/backend/server.js'), 'utf8');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok  ${name}`); }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; }
}

function loginBody() {
  const i = APP_SRC.indexOf('async function login()');
  assert.ok(i > 0, 'login() not found in app.js');
  return APP_SRC.slice(i, APP_SRC.indexOf('\nasync function ', i + 10));
}

console.log('login failures are told apart');

test('the server really can answer 503 and 500 on this route, not just 401', () => {
  const i = SERVER_SRC.indexOf("app.post('/api/login'");
  assert.ok(i > 0, 'the login route is missing');
  const route = SERVER_SRC.slice(i, SERVER_SRC.indexOf('\napp.', i + 10));
  assert.ok(route.includes('res.status(503)'), 'the route fails closed with 503 when users.json is unreadable');
  assert.ok(route.includes('res.status(500)'), 'the route answers 500 when it throws');
  assert.ok(route.includes('res.status(401)'), 'the route answers 401 for bad credentials');
});

test('the browser shows a different message for 503 than for bad credentials', () => {
  const body = loginBody();
  assert.ok(/res\.status === 503/.test(body), 'login() must branch on 503');
  assert.ok(/res\.status >= 500/.test(body), 'login() must branch on other 5xx');
  assert.ok(/res\.status === 429/.test(body), 'the rate-limit branch must stay');
});

test('the 5xx wording says it is not the password, in Thai and English', () => {
  const body = loginBody();
  // Comment lines are stripped: the note next to the fix quotes the old "(500)" literal, and a
  // scan that reads prose as code fails on the explanation of the very thing it is checking.
  const fiveXX = body.slice(body.indexOf('res.status === 503'))
    .split('\n').filter(line => !line.trim().startsWith('//')).join('\n');
  assert.ok(/not your password/i.test(fiveXX), 'the English must say it is not the password');
  assert.ok(fiveXX.includes('ไม่ใช่รหัสผ่านของคุณผิด'), 'the Thai must say it is not the password');
  assert.ok(/\(503\)/.test(fiveXX),
    'the status code belongs in the text so it can be reported without devtools');
  // 2026-11-02 (same-day review): the other 5xx branch used to carry the literal "(500)", which
  // told the administrator the wrong number for a 502 or a 504. It now appends the real status,
  // outside the translated string (ja.js is keyed by the English text, so interpolating into the
  // key would drop the Japanese). Assert the real thing: no hardcoded 500, and the code appended.
  assert.ok(!/\(500\)/.test(fiveXX),
    'a hardcoded (500) misreports a 502/504 -- append res.status instead');
  assert.ok(/\$\{res\.status\}/.test(fiveXX),
    'the non-503 5xx branch must show the status it actually got');
});

test('every message the login screen can show has a Japanese entry', () => {
  const body = loginBody();
  const strings = [...body.matchAll(/L\('([^']*?)',/g)].map(m => m[1]);
  assert.ok(strings.length >= 4, `expected several login messages, found ${strings.length}`);
  const missing = strings.filter(s => !JA_SRC.includes(s));
  assert.strictEqual(missing.length, 0,
    'no Japanese for: ' + missing.join(' | ') + ' (ja.js is keyed by the English string, so a new '
    + 'English message without an entry silently falls back to English in JA mode)');
});

console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ', 0 failed'}`);
