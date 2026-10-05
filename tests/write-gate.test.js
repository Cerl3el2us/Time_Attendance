// The system account's write gate (2026-10-05).
// Spec: docs/superpowers/specs/2026-10-05-superadmin-inspector-design.md
//
// GUARD tests. The gate's whole value is that it is the ONE road out: every write in this app goes
// through apiFetch(), so a save button added next year inherits the rule without its author having
// to know the rule exists. These tests fail loudly if that stops being true — either because the
// gate moves out of apiFetch, or because somebody starts writing with a bare fetch().
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const APP_SRC = fs.readFileSync(path.join(ROOT, 'attendance/js/app.js'), 'utf8');

// Note: the copy of this helper in the other test files walks to the FIRST `{` after the name,
// which is the parameter list's own `{}` for a function like `apiFetch(path, opts = {})` -- it
// returns a truncated signature and every assertion about the body then silently passes or fails
// for the wrong reason. This one steps over the parameter list first.
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
async function atest(name, fn) {
  try { await fn(); passed++; console.log(`  ok  ${name}`); }
  catch (e) { process.exitCode = 1; console.log(`  FAIL  ${name}\n        ${e.message}`); }
}

console.log('Write gate: which methods it stands in front of');

const ctx = { console, Response, L: (en) => en, prompt: () => null, t: k => k };
vm.createContext(ctx);
['isWriteMethod'].forEach(n => vm.runInContext(extractFunction(APP_SRC, n), ctx));

test('every mutating method is gated', () => {
  ['POST', 'PUT', 'PATCH', 'DELETE', 'post', 'delete'].forEach(m =>
    assert.strictEqual(ctx.isWriteMethod(m), true, `${m} must be gated`));
});
test('reads are not gated', () => {
  [undefined, 'GET', 'HEAD', 'get'].forEach(m =>
    assert.strictEqual(ctx.isWriteMethod(m), false, `${m} must pass straight through`));
});

console.log('\nWrite gate: machine housekeeping is exempt, in the open');

test('apiFetch lets a declared system sync past the gate', () => {
  const fn = extractFunction(APP_SRC, 'apiFetch');
  assert.ok(/isSystemSyncWrite\(opts\)/.test(fn),
    'apiFetch must honour the systemSync opt-out — otherwise a modal CONFIRM pops over a page the ' +
    'person has only just opened, for a sync they never asked for');
});
test('only housekeeping is exempt, and every exemption is greppable', () => {
  // These run with nobody at the keyboard: both fire on login AND on restoring a session at load.
  // If this list grows, that is a decision someone should have to make on purpose.
  // Count real call sites only — the comment above isSystemSyncWrite() quotes the syntax.
  const sites = APP_SRC.split('\n')
    .filter(line => !/^\s*(\/\/|\*)/.test(line))
    .filter(line => /systemSync:\s*(true|silent)/.test(line)).length;
  assert.strictEqual(sites, 3,
    'expected exactly three system-sync writes (hikvision sync, push subscribe, push unsubscribe) — ' +
    'a new one means a write was quietly taken out of the gate');
});
test('the Auto-sync BUTTON is still gated', () => {
  const fn = extractFunction(APP_SRC, 'syncHikvisionEmployees');
  assert.ok(/systemSync:\s*silent/.test(fn),
    'the exemption must follow the silent flag — pressing Auto-sync is a real decision and must ask');
});

console.log('\nWrite gate: it lives in apiFetch, the single road out');

test('apiFetch gates writes before the request is sent', () => {
  const fn = extractFunction(APP_SRC, 'apiFetch');
  assert.ok(/isWriteMethod\(opts\.method\)/.test(fn), 'apiFetch must test the method');
  assert.ok(/writeGateRefusal\(/.test(fn), 'apiFetch must consult the gate');
  const gateIdx = fn.indexOf('writeGateRefusal');
  const fetchIdx = fn.indexOf('await fetch(');
  assert.ok(gateIdx > -1 && fetchIdx > gateIdx,
    'the gate must run BEFORE the network call — a refusal that still sent the request would be no gate at all');
});

test('nothing writes with a bare fetch(), bypassing the gate', () => {
  // Raw fetch() is legitimate for login (no token yet) and for GETs. A raw WRITE would skip the
  // gate entirely, which is the one thing this design cannot survive.
  const raw = [...APP_SRC.matchAll(/[^a-zA-Z]fetch\(([\s\S]{0,400}?)\)/g)];
  const offenders = raw
    .filter(m => /method:\s*'(POST|PUT|PATCH|DELETE)'/i.test(m[1]))
    // /api/login is the one legitimate raw write: it is how the token is obtained, so it cannot
    // go through apiFetch, and there is no session to gate yet.
    .filter(m => !/\/api\/login/.test(m[1]))
    .map(m => APP_SRC.slice(0, m.index).split('\n').length);
  assert.deepStrictEqual(offenders, [],
    `bare fetch() writes bypass the write gate — see line(s) ${offenders.join(', ')}; route them through apiFetch()`);
});

test('the one-off CONFIRM at the approval call site is gone', () => {
  // It would prompt twice for a single action now that the gate covers every write.
  const fn = extractFunction(APP_SRC, 'approveMockLeaveInternal');
  assert.ok(!/requireSuperAdminConfirm\(/.test(fn),
    'approveMockLeaveInternal must rely on the gate, not ask again itself');
});

// Read the TTL out of the source so the test cannot drift from the value that ships.
const CONFIRMED_TTL = Number(/const CONFIRMED_GESTURE_TTL_MS = (\d+);/.exec(APP_SRC)[1]);

console.log('\nWrite gate: what it does to a write');

(async () => {
  const mk = (isSuper, typed) => {
    const c = {
      console, Response, Date,
      L: (en) => en,
      isSuperAdmin: () => isSuper,
      previewUserId: 0,
      realUser: null,
      prompts: 0,
      t: k => k,
      currentLang: 'en',
    };
    c.prompt = () => { c.prompts++; return typed; };
    vm.createContext(c);
    // The gesture counter is module state in app.js, bumped by a capture-phase listener there.
    // There is no document here, so the tests drive it directly — which is also the point: the
    // decision must depend only on "which press is this", nothing else.
    vm.runInContext('let _gestureSeq = 0; let _confirmedGesture = -1; let _confirmedGestureAt = 0;' +
      'const CONFIRMED_GESTURE_TTL_MS = 120000;' +
      'function press() { _gestureSeq++; }' +
      'function ageConfirmation(ms) { _confirmedGestureAt -= ms; }', c);
    ['isImpersonatingPerson', 'gateRefusal', 'gestureAlreadyConfirmed', 'requireSuperAdminConfirm', 'writeGateLabel', 'writeGateRefusal']
      .forEach(n => vm.runInContext(extractFunction(APP_SRC, n), c));
    return c;
  };

  await atest('an ordinary user is never prompted', async () => {
    const c = mk(false, null);
    assert.strictEqual(await c.writeGateRefusal('/api/leaves', 'POST'), null);
  });
  await atest('the system account typing CONFIRM is let through', async () => {
    const c = mk(true, 'CONFIRM');
    assert.strictEqual(await c.writeGateRefusal('/api/leaves', 'POST'), null);
  });
  await atest('the system account cancelling is refused, and nothing is sent', async () => {
    const c = mk(true, null);
    const res = await c.writeGateRefusal('/api/leaves', 'POST');
    assert.ok(res, 'a cancel must produce a refusal');
    assert.strictEqual(res.status, 403);
    const body = await res.json();
    assert.strictEqual(body.success, false);
    assert.ok(body.message, 'the refusal must say something the caller can show');
  });
  await atest('a near-miss is not a confirmation', async () => {
    for (const typed of ['confirm', 'CONFIRM ', 'yes', '']) {
      const c = mk(true, typed);
      assert.ok(await c.writeGateRefusal('/api/leaves', 'POST'), `"${typed}" must not pass`);
    }
  });
  await atest('the prompt says which kind of write it is', async () => {
    const c = mk(true, 'CONFIRM');
    const pairs = [['/api/settings', 'settings'], ['/api/users/5', 'employee'], ['/api/upload', 'file']];
    for (const [p, word] of pairs) {
      assert.ok(c.writeGateLabel(p, 'PUT').toLowerCase().includes(word),
        `${p} should be described with "${word}" — a prompt that does not say what it is confirming trains people to type CONFIRM blind`);
    }
  });

  console.log('\nWrite gate: one press, one question');

  await atest('three writes from a single press ask once', async () => {
    const c = mk(true, 'CONFIRM');
    c.press();
    for (const p of ['/api/settings', '/api/settings', '/api/users/5']) {
      assert.strictEqual(await c.writeGateRefusal(p, 'PUT'), null, `${p} should pass`);
    }
    assert.strictEqual(c.prompts, 1,
      'saving Settings is three requests but one decision — asking three times trains people to type CONFIRM without reading');
  });
  await atest('a second press asks again', async () => {
    const c = mk(true, 'CONFIRM');
    c.press();
    await c.writeGateRefusal('/api/settings', 'PUT');
    c.press();
    await c.writeGateRefusal('/api/users/5', 'PUT');
    assert.strictEqual(c.prompts, 2, 'a CONFIRM must never carry over to the next thing pressed');
  });
  await atest('cancelling leaves nothing confirmed, so the next write asks again', async () => {
    const c = mk(true, null);
    c.press();
    assert.ok(await c.writeGateRefusal('/api/settings', 'PUT'), 'first write refused');
    assert.ok(await c.writeGateRefusal('/api/settings', 'PUT'), 'still refused within the same press');
    assert.strictEqual(c.prompts, 2, 'a cancel must not be remembered as an answer');
  });
  await atest('a confirmation expires, so a later background write is not covered by it', async () => {
    const c = mk(true, 'CONFIRM');
    c.press();
    await c.writeGateRefusal('/api/settings', 'PUT');
    c.ageConfirmation(CONFIRMED_TTL + 1);
    await c.writeGateRefusal('/api/settings', 'PUT');
    assert.strictEqual(c.prompts, 2,
      'a websocket or timer firing a write minutes later must not ride on an old CONFIRM');
  });

  console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ', 0 failed'}`);
})();
