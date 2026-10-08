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
//   1. A "can I do this?" gate that reads the raw role judges the superadmin ACCOUNT, not the role
//      being previewed. The button layer asks effectiveRole() (previewing Staff -> the button is
//      shown) while the gate reads the account's own role ('superadmin', in no eligibility list ->
//      every date refused). Visible buttons, dead pickers. tests/preview-role.test.js guards the
//      gates that exist today; this file guards against new ones appearing.
//
//   2. A write sent with a bare fetch() skips apiFetch, and apiFetch is where the whole dry-run
//      mechanism hangs: writeGateRefusal() -> the X-Dry-Run header -> the server throwing the write
//      away. A bare fetch() while impersonating a PERSON really writes, and the record is stamped
//      with that employee's name. With no activity log there is nothing to show it was the system
//      account. They would be answerable for something they did not do. This is the worst outcome
//      any rule in this file prevents.
//
// ---------------------------------------------------------------------------------------------
// 2026-10-08, second pass after review. The first version of this file enforced a SPELLING, not a
// rule, and a review proved it by slipping real violations past it while the suite stayed green:
//
//   window.fetch(url, { method: 'POST' })   -- the first version's own comment advertised this as
//                                              a feature ("neither apiFetch( nor window.fetch( is
//                                              picked up by accident"). window.fetch IS a raw
//                                              fetch; the exclusion written to dodge apiFetch
//                                              dodged the violation too.
//   realUser.role === 'md'                  -- realUser is BY DEFINITION the unimpersonated
//                                              account, so this is a worse version of the banned
//                                              read, and it was invisible.
//   currentUser?.role, currentUser['role'], loggedInUser().role, const { role } = currentUser
//   /* comment */ fetch(...)                -- a leading block comment on the line hid it.
//   a violation placed just AFTER an allowlisted function, or nested inside one, inherited that
//                                              function's permission, because "which function am I
//                                              in" was answered by scanning backwards for the
//                                              nearest `function name(` rather than by containment.
//
// Two changes fix the class of problem rather than the instances:
//
//   * Comments and string literals are blanked out before scanning, so a match is real code.
//   * The known-good call sites are PINNED exactly, instead of whole functions being allowlisted.
//     A pinned entry is one line of code with a written reason. Anything the scan finds that is
//     not pinned fails, wherever it sits -- nested, adjacent, or in a function that happens to be
//     allowed for its own line. There are no shadows to hide in because nothing is allowed by
//     location any more.
//
// Not covered here, on purpose: whether a NEW menu lists superadmin among the roles that may see
// it (R2.3). That is behaviour, not spelling, and it lives in
// tests/full-access-sees-everything.test.js, which runs applyRolePermissions() for real. This file
// deliberately no longer keeps its own source-level copy of that check: the first version matched
// `else if (role === 'superadmin')` literally, which went red on a change of quote style and green
// on the branch being emptied -- brittle where it should be strict and lax where it should not.
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

// ---------------------------------------------------------------------------------------------
// Replace every comment and every string/template body with spaces, keeping the text the same
// length so line numbers still line up with the original file. Scanning the result means a match
// is code: not prose in a comment block (this repo writes long ones, several of which discuss
// `fetch(` and `currentUser.role` by name), and not an error message quoting the thing it forbids.
// Quote, backtick and slash DELIMITERS are kept; only what is between them is blanked. Keeping
// them is what makes `currentUser['role']` still detectable after scrubbing — the key name is
// gone, but `currentUser['` is signal enough, and a dynamic lookup on that object deserves a look
// either way.
//
// Regular-expression literals get their own state. Without it the apostrophe in
// `.replace(/'/g, '&#39;')` (escapeHtml, app.js) opens a string that never closes correctly, the
// scrubber desynchronises, and everything after it is blanked — which looked exactly like "the
// file contains almost no fetch calls". A scrubber that fails that way makes every check in this
// file pass while reading nothing, so the pinned lists below are also what proves it is working.
function blankNonCode(src) {
  const out = src.split('');
  const blank = (from, to) => { for (let k = from; k < to; k++) if (out[k] !== '\n') out[k] = ' '; };
  // A `/` starts a regex only where a value may begin. After an identifier, a number, or a closing
  // bracket it is division. This is the usual heuristic and it is sufficient here.
  const prevSignificant = (at) => { let k = at - 1; while (k >= 0 && /\s/.test(src[k])) k--; return k >= 0 ? src[k] : ''; };
  const regexCanStart = (at) => {
    const p = prevSignificant(at);
    if (p === '') return true;
    if (/[)\]}]/.test(p)) return false;
    if (/[\w$]/.test(p)) {
      let k = at - 1; while (k >= 0 && /\s/.test(src[k])) k--;
      let e = k; while (k >= 0 && /[\w$]/.test(src[k])) k--;
      return /^(?:return|typeof|case|in|of|new|delete|void|do|else|yield|await)$/.test(src.slice(k + 1, e + 1));
    }
    return true;
  };
  // `stack` tracks template-literal nesting: inside `${ ... }` we are back in code, and that code
  // may open another template.
  const stack = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i], d = src[i + 1];
    const inTemplate = stack.length > 0 && stack[stack.length - 1] === 'tpl';
    if (inTemplate) {
      if (c === '\\') { blank(i, i + 2); i += 2; continue; }
      if (c === '`') { stack.pop(); i++; continue; }           // delimiter kept
      if (c === '$' && d === '{') { stack.push('code'); i += 2; continue; }
      blank(i, i + 1); i++; continue;
    }
    if (c === '/' && d === '/') { let j = src.indexOf('\n', i); if (j < 0) j = src.length; blank(i, j); i = j; continue; }
    if (c === '/' && d === '*') { let j = src.indexOf('*/', i + 2); j = j < 0 ? src.length : j + 2; blank(i, j); i = j; continue; }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < src.length && src[j] !== c && src[j] !== '\n') { if (src[j] === '\\') j++; j++; }
      blank(i + 1, Math.min(j, src.length));                    // delimiters kept
      i = Math.min(j + 1, src.length); continue;
    }
    if (c === '/' && regexCanStart(i)) {
      let j = i + 1, inClass = false, closed = false;
      while (j < src.length && src[j] !== '\n') {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === '[') inClass = true;
        else if (src[j] === ']') inClass = false;
        else if (src[j] === '/' && !inClass) { closed = true; break; }
        j++;
      }
      if (closed) { blank(i + 1, j); i = j + 1; continue; }     // delimiters kept
      i++; continue;                                            // not a regex after all: division
    }
    if (c === '`') { stack.push('tpl'); i++; continue; }        // delimiter kept
    if (c === '{' && stack.length && stack[stack.length - 1] === 'code') { stack.push('code'); i++; continue; }
    if (c === '}' && stack.length && stack[stack.length - 1] === 'code') { stack.pop(); i++; continue; }
    i++;
  }
  return out.join('');
}

const APP_CODE = blankNonCode(APP_SRC);
const HTML_LINES = HTML_SRC.split('\n');
const APP_LINES = APP_SRC.split('\n');

// Where a match sits, reported with the ORIGINAL line so a failure is readable.
function hitsOf(code, originalLines, re) {
  const found = [];
  let m;
  re.lastIndex = 0;
  while ((m = re.exec(code)) !== null) {
    const line = code.slice(0, m.index).split('\n').length;
    found.push({ line, match: m[0].replace(/\s+/g, ' '), code: (originalLines[line - 1] || '').trim() });
  }
  return found;
}

// ---------------------------------------------------------------------------------------------
// 1. Reading the raw role
//
// Every spelling that answers "what role is the ACCOUNT?" rather than "what role am I acting as?".
// `realUser` and `loggedInUser()` are included because they are the unimpersonated account by
// definition, which makes them a stronger version of the same mistake, not a way around it.
const RAW_ROLE_RE = new RegExp([
  String.raw`(?:currentUser|realUser|loggedInUser\s*\(\s*\))\s*\??\s*\.\s*role\b`,
  // After scrubbing, `currentUser['role']` reads `currentUser['']` — the key is gone but the
  // lookup is not. Any computed access to these objects is worth a human look, so match them all.
  String.raw`(?:currentUser|realUser)\s*\[`,
  String.raw`\{[^{}]*\brole\b[^{}]*\}\s*=\s*(?:currentUser|realUser|loggedInUser\s*\(\s*\))`,
].join('|'), 'g');

// 2. Writing without apiFetch
//
// The lookbehind lets `apiFetch(` through (it is the wrapper) while `window.fetch(` and friends are
// named explicitly, because a dot before `fetch` is exactly how the first version was fooled.
const RAW_FETCH_RE = new RegExp([
  String.raw`(?<![\w$.])fetch\s*\(`,
  String.raw`\b(?:window|globalThis|self)\s*\.\s*fetch\s*\(`,
  String.raw`\bsendBeacon\s*\(`,
  String.raw`\bnew\s+XMLHttpRequest\b`,
].join('|'), 'g');

// ---------------------------------------------------------------------------------------------
// The pins. Each is a call site that exists today and is NOT the mistake the rule is about, with
// the reason it is allowed. `code` is matched after collapsing runs of whitespace.
//
// A pin is a line, not a function. That is the point: allowing a whole function would also allow
// anything written next to or nested inside it, which is how the first version let a new raw gate
// into saveEmployee() and a new raw POST into getVapidPublicKey()'s shadow.
//
// To add one you have to say which of these it is, in writing. If it is a GATE, it does not get a
// pin -- it gets effectiveRole() or gateRoleFor(user, uid).
const ROLE_PINS = [
  { code: "if (isImpersonatingPerson()) return currentUser.role || 'user';",
    why: 'inside effectiveRole(): the function that DEFINES the rule has to read the raw value' },
  { code: "if (!isSuperAdmin()) return currentUser?.role || 'user';",
    why: 'also effectiveRole(): the non-superadmin path, same reason' },
  { code: '? `${currentUser.name || (\'#\' + currentUser.id)} · ${roleLabel(currentUser.role)}`',
    why: 'updateSystemAccountUI(): a label on screen, not a permission decision' },
  { code: "if (u.id === currentUser.id) { currentUser.role = uSnapshot.role; updateUserUI(); }",
    why: 'saveEmployee(): WRITES the role back after a failed save; not a read that decides anything' },
  { code: 'badge.className = `role-badge role-${isSuperAdmin() && previewRole ? previewRole : currentUser.role}`;',
    why: 'updateUserUI(): picks the pill\'s COLOUR class. Previewing already wins here, and nothing is gated on it' },
  { code: "const roleText = roleLabels[currentUser.role] || currentUser.role || '';", times: 2,
    why: "updateUserUI(): the pill's TEXT. A label; the account's own role is the honest thing to name " +
         'there, and when a role is being previewed the suffix beside it says so separately' },
];

const FETCH_PINS = [
  { code: 'res = await fetch(`${NAS_BACKEND}${path}`, { ...opts, headers });',
    why: 'apiFetch() itself -- the one every other write is supposed to come through' },
  { code: 'const res = await fetch(`${NAS_BACKEND}/api/login`, {',
    why: 'login(): runs before a session exists, so it cannot pass through the gate' },
  { code: 'const res = await fetch(`${NAS_BACKEND}/api/push/vapid-public-key`);',
    why: 'getVapidPublicKey(): GET' },
  { code: '_gpsCartoStyleLoading = fetch(url)', why: 'loadGpsCartoStyle(): GET, a map stylesheet' },
  { code: 'fetch(`https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json&accept-language=th`)',
    why: 'reverseGeocode(): GET, and to OpenStreetMap, not to our backend' },
];

const squash = s => s.replace(/\s+/g, ' ').trim();

// 2026-10-08 (review): this compared SETS, so a verbatim copy of a pinned line was a free pass.
// A review pasted `if (!isSuperAdmin()) return currentUser?.role || 'user';` into a brand-new
// gate and `res = await fetch(...)` into a brand-new POST helper, and the suite stayed green at
// 9 passed while the hit count quietly rose. Counts are compared now: each pinned text must
// appear exactly as many times as it is pinned, so the second copy is reported as new.
function comparePins(hits, pins, label) {
  const tally = arr => arr.reduce((m, t) => m.set(t, (m.get(t) || 0) + 1), new Map());
  // `times` is how many matches that one line legitimately contains — roleText's line reads
  // currentUser.role twice (`roleLabels[currentUser.role] || currentUser.role`). Default 1.
  const wanted = pins.reduce((m, p) => m.set(squash(p.code), (m.get(squash(p.code)) || 0) + (p.times || 1)), new Map());
  const got = tally(hits.map(h => squash(h.code)));
  const seen = new Map();
  const unexpected = hits.filter(h => {
    const k = squash(h.code);
    const n = (seen.get(k) || 0) + 1;
    seen.set(k, n);
    return n > (wanted.get(k) || 0);   // the 1st copy is the pin; the 2nd onwards is new code
  });
  const missing = pins.filter(p => (got.get(squash(p.code)) || 0) < (wanted.get(squash(p.code)) || 0)
    || !got.has(squash(p.code)));
  return { unexpected, missing, label };
}

const roleHits = hitsOf(APP_CODE, APP_LINES, RAW_ROLE_RE);
const fetchHits = hitsOf(APP_CODE, APP_LINES, RAW_FETCH_RE);

console.log(`Superadmin reach — ${roleHits.length} raw role reads, ${fetchHits.length} raw fetch calls (pins: ${ROLE_PINS.length}/${FETCH_PINS.length})`);

// ---------------------------------------------------------------------------------------------
// Self-tests. A guard that has never been seen to fail is not a guard, and every case below is one
// that the FIRST version of this file let through.
function scanFake(src, re) { return hitsOf(blankNonCode(src), src.split('\n'), re); }

test('the scrubber keeps code and loses only comments and string bodies', () => {
  // If this is wrong, everything below reads a mangled file and passes for the wrong reason. The
  // regex-literal case is here because its absence silently blanked most of app.js on the first
  // run of this rewrite: one apostrophe inside /'/g desynchronised the whole scan.
  const src = [
    "const re = /'/g;",                       // an apostrophe inside a regex must not open a string
    "const s = 'fetch( in a string';",
    '// fetch( in a line comment',
    '/* fetch( in a block comment */',
    'const t = `a ${currentUser.role} b`;',   // code inside ${} survives
    "doIt(a / b, c / d);",                    // division, not a regex
    "const u = currentUser['role'];",
  ].join('\n');
  const out = blankNonCode(src);
  assert.strictEqual(out.split('\n').length, src.split('\n').length, 'line count changed');
  assert.ok(out.includes('const re ='), 'code before a regex was eaten');
  assert.ok(!/fetch\s*\(/.test(out), `a fetch( in prose or a string survived:\n${out}`);
  assert.ok(out.includes('currentUser.role'), 'code inside ${} was eaten');
  assert.ok(out.includes('doIt(a / b, c / d)'), 'division was mistaken for a regex');
  assert.ok(/currentUser\s*\[/.test(out), 'the bracket lookup was eaten');
});

test('the scrubber did not quietly eat the file', () => {
  // 2026-10-08 (review): the pins only reach app.js line ~12800 of 24000+, so a desync starting
  // after that would blank arbitrary code with every pin still present and every check green.
  // A ratio is crude but it covers the whole file: a tokenizer that loses its place blanks to the
  // next matching delimiter or to EOF, which craters this number. It sits near 47% today.
  const nonSpace = s => (s.match(/\S/g) || []).length;
  const ratio = nonSpace(APP_CODE) / nonSpace(APP_SRC);
  assert.ok(ratio > 0.35 && ratio < 0.65,
    `blankNonCode() kept ${(ratio * 100).toFixed(1)}% of app.js's non-space characters, outside the\n` +
    '       35-65% band this file has always sat in. Either a lot of prose was added at once, or the\n' +
    '       scrubber lost its place and is blanking real code — in which case every scan below is\n' +
    '       reading a file that is mostly spaces, and passing for that reason.');
});

test('the scanner catches every spelling of a raw role read', () => {
  const cases = {
    'plain': "if (currentUser.role === 'md') return true;",
    'optional chaining': "if (currentUser?.role === 'md') return true;",
    'bracket access': "if (currentUser['role'] === 'md') return true;",
    'realUser (the unimpersonated account)': "if (realUser && realUser.role === 'md') return true;",
    'loggedInUser()': "if (loggedInUser().role === 'accounting') return true;",
    'destructured': 'const { role } = currentUser; if (role === "md") return true;',
    'split across lines': 'if (currentUser\n    .role === "md") return true;',
    'behind a leading block comment': "/* gate */ if (currentUser.role === 'md') return true;",
  };
  const missed = Object.entries(cases).filter(([, src]) => scanFake(src, RAW_ROLE_RE).length === 0)
    .map(([name]) => name);
  assert.strictEqual(missed.length, 0, `these slipped through: ${missed.join(', ')}`);
});

test('the scanner catches every spelling of a write that skips apiFetch', () => {
  const cases = {
    'plain': "return fetch('/api/x', { method: 'POST' });",
    'window.fetch': "return window.fetch('/api/x', { method: 'POST' });",
    'globalThis.fetch': "return globalThis.fetch('/api/x', { method: 'POST' });",
    'self.fetch': "return self.fetch('/api/x', { method: 'POST' });",
    'sendBeacon': "navigator.sendBeacon('/api/x', body);",
    'XMLHttpRequest': 'const x = new XMLHttpRequest(); x.open("POST", url); x.send(b);',
    'paren on the next line': "return fetch\n  ('/api/x', { method: 'POST' });",
    'behind a leading block comment': "/* queued */ fetch('/api/x', { method: 'POST' });",
  };
  const missed = Object.entries(cases).filter(([, src]) => scanFake(src, RAW_FETCH_RE).length === 0)
    .map(([name]) => name);
  assert.strictEqual(missed.length, 0, `these slipped through: ${missed.join(', ')}`);
});

test('the scanner does not fire on apiFetch, on prose, or on an error message', () => {
  const quiet = {
    'apiFetch': "return apiFetch('/api/x', { method: 'POST' });",
    'a comment mentioning fetch(': '// everything goes through apiFetch; a bare fetch( would bypass the gate',
    'a comment mentioning currentUser.role': '// the gate used to ask currentUser.role, which was the bug',
    'an error message quoting the rule': "throw new Error('do not call fetch( directly; use apiFetch');",
    'a block comment': '/*\n * fetch( and currentUser.role are discussed here\n */',
  };
  const noisy = Object.entries(quiet).filter(([, src]) =>
    scanFake(src, RAW_FETCH_RE).length || scanFake(src, RAW_ROLE_RE).length).map(([name]) => name);
  assert.strictEqual(noisy.length, 0, `false positives on: ${noisy.join(', ')}`);
});

test('a violation nested inside, or sitting next to, a pinned call site is still caught', () => {
  // The shadow problem. Both of these were green against the first version of this file.
  const nested = [
    'function saveEmployee() {',
    "  const canEditSalary = () => currentUser.role === 'md';",
    '}',
  ].join('\n');
  const adjacent = [
    'function getVapidPublicKey() { return 1; }',
    "const submitTheNewThing = (b) => fetch('/api/new-thing', { method: 'POST', body: b });",
  ].join('\n');
  assert.ok(scanFake(nested, RAW_ROLE_RE).length === 1, 'nested raw role read not seen');
  assert.ok(scanFake(adjacent, RAW_FETCH_RE).length === 1, 'adjacent raw fetch not seen');
  // and neither matches a pin, so both would be reported
  assert.strictEqual(comparePins(scanFake(nested, RAW_ROLE_RE), ROLE_PINS, 'x').unexpected.length, 1);
  assert.strictEqual(comparePins(scanFake(adjacent, RAW_FETCH_RE), FETCH_PINS, 'x').unexpected.length, 1);
});

// ---------------------------------------------------------------------------------------------
// The rules themselves.
function reportPins(hits, pins, what, advice) {
  const { unexpected, missing } = comparePins(hits, pins, what);
  const lines = [];
  if (unexpected.length) {
    lines.push(`NEW ${what} not on the pinned list:`);
    unexpected.forEach(h => lines.push(`  app.js:${h.line}  ${h.code.slice(0, 100)}`));
    lines.push(advice);
  }
  if (missing.length) {
    lines.push(`PINNED ${what} no longer found — the pin is stale, or the scanner stopped seeing it:`);
    missing.forEach(p => lines.push(`  ${p.code.slice(0, 100)}`));
    lines.push('  If the line was legitimately removed, delete its pin. If it was only reformatted,');
    lines.push('  re-pin the new text. If the SCANNER broke, every other check here is worthless.');
  }
  assert.strictEqual(lines.length, 0, '\n       ' + lines.join('\n       '));
}

test('a "can I do this?" gate asks effectiveRole(), never the account\'s own role', () => {
  reportPins(roleHits, ROLE_PINS, 'raw role reads',
    '  A gate reading the raw role judges the superadmin ACCOUNT, not the role being previewed,\n' +
    '  so "view as Staff" shows the button and then refuses every date. Use effectiveRole(), or\n' +
    '  gateRoleFor(user, uid) when the subject may be someone else. If this really is a label or\n' +
    '  a write rather than a gate, add a pin above saying which.');
});

test('every write goes through apiFetch, so the dry run can intercept it', () => {
  reportPins(fetchHits, FETCH_PINS, 'raw network calls',
    '  A bare fetch() skips writeGateRefusal(), so while superadmin is impersonating a PERSON the\n' +
    '  write really happens — stamped with that employee\'s name, with nothing to show it was not\n' +
    '  them. Call apiFetch() instead. A genuinely session-less or read-only call gets a pin above\n' +
    '  saying which.');
});

test('index.html carries no role gate or network call of its own', () => {
  // The rules above read app.js. This keeps that scope honest: if logic starts appearing in the
  // page, this fails and the scanner gets widened rather than quietly covering less than it says.
  const htmlCode = blankNonCode(HTML_SRC);
  assert.strictEqual(hitsOf(htmlCode, HTML_LINES, RAW_ROLE_RE).length, 0, 'a raw role read appeared in index.html');
  assert.strictEqual(hitsOf(htmlCode, HTML_LINES, RAW_FETCH_RE).length, 0, 'a network call appeared in index.html');
});

test('the service worker is still out of scope for a reason', () => {
  // sw.js makes its own fetch calls; it is a cache layer, and nothing there writes to the API.
  // If that ever changes, a background replay would be a write outside apiFetch and outside every
  // rule in this file, so the day sw.js gains a write method this must fail and be dealt with.
  // 2026-10-08 (review): this read blankNonCode(sw.js) and then looked for a STRING LITERAL in it
  // — which the scrubber has already erased by construction, so the check could never fire. The
  // comment above promised the opposite. Read the raw file; a mention inside a comment here is a
  // false alarm worth having, given what it guards.
  const sw = fs.readFileSync(path.join(ROOT, 'attendance/sw.js'), 'utf8');
  const writes = sw.match(/method\s*:\s*['"](?:POST|PUT|PATCH|DELETE)['"]/gi) || [];
  assert.strictEqual(writes.length, 0,
    `attendance/sw.js now issues ${writes.length} write request(s) of its own. Those bypass apiFetch\n` +
    '       entirely — decide how the dry run and the impersonation block apply to them.');
});

console.log(`\n${passed} passed`);
