// Full access must see every menu some role can see (2026-10-08).
//
// Spec: docs/superpowers/specs/2026-10-08-superadmin-reach-rules-design.md
// Rule: AGENTS.md section 7a (R2.3).
//
// 2026-10-08 (owner): "it is full access, so it should see everything" -- with one honest
// exception. A handful of pages show the VIEWER's own employee records: their check-in, their
// leave, their requests. The system account has no employee record, so those pages have nothing
// to show, and the way to look at them is to impersonate a person. Everything else it must be
// able to reach, or it cannot inspect what it is there to inspect.
//
// Why a test and not a paragraph: tests/superadmin-reach.test.js can only police how code is
// SPELLED. This is behaviour, and on the day the rule was written the behaviour was already
// wrong -- Finalize Payroll and Payroll History were hidden from Full access while previewing
// Accounting showed them, because the superadmin branch had been copied from the MD branch and
// inherited `.nav-no-md`. navigateTo() had always named superadmin in its Finalize guard, so the
// page was reachable by URL while its own link was hidden. Nobody decided that; it was inherited.
//
// How it runs: applyRolePermissions() is real browser code, and this repo's tests are plain Node
// with no DOM and no jsdom. So the suite builds a stand-in document from the sidebar markup in
// app.js and runs the REAL function against it, once per role. Re-implementing the role logic
// here would only test a copy, and a copy drifts.
//
// ---------------------------------------------------------------------------------------------
// 2026-10-08, second pass after review. The first version could be made to pass while the rule it
// protects was broken. Every hardening below answers a mutation that was demonstrated green:
//
//   * A nav item written `<div data-page="x" class="nav-item ...">` (attributes the other way
//     round) fell out of the fixture entirely and no number moved. Tags are now parsed per tag,
//     attribute order and quote style do not matter, and THE FIXTURE IS PINNED -- an item that
//     stops being scraped fails instead of leaving quietly.
//   * `document.querySelectorAll('[data-page="finalize"]')` was swallowed by a branch written for
//     `[onclick=...]` buttons, so that one line could re-hide the payroll pages with the suite
//     still green. Only `[onclick=...]` is waved through now; `[data-page=]` is really evaluated.
//   * `el.hidden = true` and `el.style.visibility = 'hidden'` really hide a menu and were scored
//     as visible, because the stand-in was a plain object that accepted any property. It is
//     hostile now: anything it cannot model throws instead of being ignored.
//   * The self-test owned a private copy of the comparison, so commenting out the real assertion
//     left every test green. Both now call the same function.
//   * `marketing` is a real role and was not in the list of roles consulted.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const APP_SRC = fs.readFileSync(path.join(ROOT, 'attendance/js/app.js'), 'utf8');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok ', name); }
  catch (e) { process.exitCode = 1; console.log('  FAIL', name, '\n      ', e.message); }
}

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
// The sidebar, read out of the markup app.js builds. Parsed tag by tag, then each attribute is
// looked for independently, so `class` and `data-page` may appear in either order, in either
// quote style, with anything between them. The first version matched one fixed order and a menu
// written the other way simply vanished from the fixture.
//
// Two entries share data-page="payslip" (My Payslip for an employee, the admin payslip browser
// for everyone else), which is why elements are kept as a list.
// 2026-10-08 (review): this matched `<div …>` only and read the raw text, so a menu written as
// `<a class="nav-item …" data-page="…">` was invisible to the fixture — a review added exactly
// that, carrying `.nav-no-md`, the shape of the original bug, and the suite still reported
// "22 nav items" and passed. The mirror case was as bad: a menu parked inside an HTML comment
// still counted, so the suite certified Full access could reach a menu that no longer rendered.
// Any tag now, and comments are stripped first.
function navItemsFromSource(rawSrc) {
  const src = rawSrc.replace(/<!--[\s\S]*?-->/g, '');
  const out = [];
  const computed = [];
  const tags = src.match(/<[a-zA-Z][a-zA-Z0-9]*\b[^>]*>/g) || [];
  tags.forEach(tag => {
    const cls = /class\s*=\s*(['"])([\s\S]*?)\1/.exec(tag);
    const page = /data-page\s*=\s*(['"])([\s\S]*?)\1/.exec(tag);
    if (!cls || !page) return;
    if (!/\bnav-item\b/.test(cls[2])) return;
    // A class list built by interpolation cannot be modelled: the fixture would carry the literal
    // `${...}` and score as a class nobody has, i.e. visible to everyone, silently.
    if (cls[2].includes('${')) { computed.push(page[2]); return; }
    out.push({ className: cls[2].trim(), page: page[2] });
  });
  return { items: out, computed };
}
const SCRAPE = navItemsFromSource(APP_SRC);
const NAV_ITEMS = SCRAPE.items;

// How a menu is named in the sets below.
//
// `data-page` alone is not an identity: two different menus carry data-page="payslip" — My
// Payslip for an employee, and the admin payslip browser for everyone else. Collapsing both to
// "payslip" made them one entry, so the suite could not tell "Full access can reach the payslip
// pages" from "Full access can reach ONE of the two and the other role can reach the other".
// Where a page name is shared, the class list disambiguates; where it is unique — twenty of the
// twenty-two — the plain name is kept, so the lists here stay readable.
function keyMaker(items) {
  const count = {};
  items.forEach(i => { count[i.page] = (count[i.page] || 0) + 1; });
  return el => (count[el.page] > 1 ? `${el.page} [${el.className}]` : el.page);
}

// The fixture, pinned. If a nav item stops being scraped — renamed attribute, computed class,
// moved to a different markup shape — coverage for it silently drops to nothing, and the only
// symptom is a number in this file's own log line that nobody is watching. So the number is
// watched here. Adding or removing a menu is expected to update this list, deliberately.
const EXPECTED_NAV_KEYS = [
  'approval', 'archive', 'attendance', 'audit-log', 'calendar', 'checkin', 'dashboard',
  'employees', 'faq', 'finalize', 'holidays', 'leave', 'leave-summary', 'my-requests',
  'myattendance', 'payroll-history',
  'payslip [nav-item nav-admin nav-payslip]',
  'payslip [nav-item nav-emp-only]',
  'profile', 'reports', 'settings', 'tawi50',
];

// ---------------------------------------------------------------------------------------------
// A stand-in document. It models what applyRolePermissions() touches — querySelectorAll,
// querySelector, getElementById, el.style.display, el.classList.contains — and REFUSES everything
// else loudly. Visibility is `style.display !== 'none'`, flat, no parents and no stylesheet: that
// is enough while display is the only mechanism in use, and the refusals below are what keep that
// assumption true instead of merely hoped for.
function makeElement(className, page) {
  const classes = className.split(/\s+/).filter(Boolean);
  const boom = what => () => {
    throw new Error(
      `applyRolePermissions() hid or changed a menu with ${what}, which this stand-in cannot ` +
      'model, so the effect would be invisible here and the suite would pass blind. Teach ' +
      'makeElement() and the visibility rule about it.');
  };
  // 2026-10-08 (review): the first hostile version named the mechanisms it knew about, and a
  // review walked straight past it. `el.style.cssText = 'display:none'` hid Finalize Payroll and
  // Payroll History from Full access and this suite reported 10 passed — including the test
  // called "the payroll pages the inspector needs are reachable at Full access". So did
  // textContent='', innerHTML='', inert, className+=' is-hidden', and opacity/height/position
  // tricks. A list of known-bad properties can only ever be as long as the last review.
  // It is a deny-by-default Proxy now: `display` is the one property this model understands, and
  // every other write to style or to the element throws by name.
  const style = new Proxy({ display: '' }, {
    get: (t, k) => (k === 'display' ? t.display : (typeof k === 'string' ? boom(`style.${k}`)() : t[k])),
    set: (t, k, v) => { if (k === 'display') { t.display = v; return true; } return boom(`style.${k}`)(); },
  });
  const el = new Proxy({
    className, page, style,
    classList: {
      contains: c => classes.includes(c),
      add: boom('classList.add'), remove: boom('classList.remove'), toggle: boom('classList.toggle'),
    },
    setAttribute: boom('setAttribute'), removeAttribute: boom('removeAttribute'), remove: boom('remove'),
    replaceChildren: boom('replaceChildren'), append: boom('append'), appendChild: boom('appendChild'),
    getAttribute: a => (a === 'data-page' ? page : null),
    get hidden() { return false; },
    set hidden(v) { boom('the hidden property')(); },
  }, {
    // Reading an unknown property is fine (feature detection does it); WRITING one is a hiding
    // mechanism this model cannot see, so it fails by name instead of being swallowed.
    set: (t, k, v) => {
      if (k === 'className') return boom('className (assigning it also leaves classList stale)')();
      if (!(k in t)) return boom(`the "${String(k)}" property`)();
      t[k] = v; return true;
    },
  });
  return el;
}

function makeDocument(items) {
  const els = items.map(it => makeElement(it.className, it.page));
  const unknown = new Set();
  const matches = (el, sel) => {
    sel = sel.trim();
    let m = /^\.([\w-]+)\[data-page=(['"])([^'"]*)\2\]$/.exec(sel);
    if (m) return el.classList.contains(m[1]) && el.page === m[3];
    m = /^\[data-page=(['"])([^'"]*)\1\]$/.exec(sel);
    if (m) return el.page === m[2];                 // really evaluated, not waved through
    m = /^\.([\w-]+)$/.exec(sel);
    if (m) return el.classList.contains(m[1]);
    // `[onclick="openOTModal()"]` and friends address BUTTONS, of which this document holds none.
    // Known-and-empty. Deliberately narrow: the first version allowed any `[attr="value"]`, which
    // quietly included `[data-page="finalize"]` — a selector that hides a menu.
    if (/^\[onclick=(['"])[^'"]*\1\]$/.test(sel)) return false;
    unknown.add(sel);
    return false;
  };
  const all = sel => {
    const parts = String(sel).split(',');
    return els.filter(el => parts.some(p => matches(el, p)));
  };
  return {
    _elements: els,
    _unknownSelectors: unknown,
    querySelectorAll: all,
    querySelector: sel => all(sel)[0] || null,
    getElementById: () => null,   // every getElementById caller in the function is null-guarded
  };
}

const SUPER = { id: 900001, role: 'superadmin', isSystemAccount: true };

// Run the real applyRolePermissions() as superadmin previewing `preview` ('' = Full access).
function visiblePagesFor(preview, opts) {
  const o = opts || {};
  const doc = makeDocument(o.items || NAV_ITEMS);
  const me = Object.assign({}, SUPER, o.isObserver ? { isObserver: true } : {});
  const ctx = {
    console,
    document: doc,
    realUser: me,
    currentUser: me,
    previewRole: preview || '',
    previewUserId: 0,
    APP_SETTINGS: { allowanceEligibility: {} },
    // Not part of what is being measured: these adjust request BUTTONS, not nav items.
    isAllowanceEligible: () => true,
    updateLateOutEntryVisibility: () => {},
    refreshHolidayWorkCheckinBtn: () => {},
    updateEarlyMorningEntryVisibility: () => {},
    updateAbroadEntryVisibility: () => {},
    updateAnnualLeaveEntryVisibility: () => {},
  };
  vm.createContext(ctx);
  ['loggedInUser', 'isSuperAdmin', 'isImpersonatingPerson', 'effectiveRole', 'applyRolePermissions']
    .forEach(n => vm.runInContext(extractFunction(APP_SRC, n), ctx));
  vm.runInContext('applyRolePermissions()', ctx);
  const key = keyMaker(o.items || NAV_ITEMS);
  return {
    pages: new Set(doc._elements.filter(e => e.style.display !== 'none').map(key)),
    effectiveRole: vm.runInContext('effectiveRole()', ctx),
    unknownSelectors: [...doc._unknownSelectors],
  };
}

const ROLES = {
  staff: 'user', driver: 'driver', manager: 'manager',
  accounting: 'accounting', marketing: 'marketing', md: 'md',
};

// ---------------------------------------------------------------------------------------------
// The exception list. Every entry is a page that shows the VIEWER's own employee records, which
// the system account does not have. To look at one, impersonate a person -- that is what the
// feature is for. Adding a page here means writing down why it is personal; anything else that
// disappears from Full access is a bug, not a new entry.
const PERSONAL_TO_THE_VIEWER = new Map([
  ['checkin',     'clocking in is an act by an employee; this account has no timesheet to clock into (navigateTo refuses it outright too)'],
  ['leave',       "shows and spends the viewer's own leave balance, which this account does not have"],
  ['my-requests', "literally the viewer's own requests; this account cannot file one"],
  // Surfaced by keying on class as well as page name: this one was previously indistinguishable
  // from the admin payslip browser, so the pair cancelled out and neither was ever examined.
  ['payslip [nav-item nav-emp-only]',
    "My Payslip — the viewer's own pay record, which this account does not have. The admin " +
    'payslip browser is a separate menu (payslip [nav-item nav-admin nav-payslip]) and Full ' +
    'access keeps that one; if it ever disappears, the rule below will say so.'],
]);

// The one comparison, used by the real check AND by the self-test that is supposed to vouch for
// it. The first version let each have its own copy, so disabling the real one left the self-test
// green and the suite enforcing nothing.
function gapsAgainstFullAccess(full, perRole) {
  const out = [];
  Object.entries(perRole).forEach(([roleName, r]) => {
    r.pages.forEach(p => {
      if (!full.pages.has(p) && !PERSONAL_TO_THE_VIEWER.has(p)) out.push(`${p} (seen by ${roleName})`);
    });
  });
  return [...new Set(out)];
}

let full, perRole;

test('the sidebar fixture is the one this suite was written against', () => {
  assert.strictEqual(SCRAPE.computed.length, 0,
    `these nav items build their class list by interpolation, so the stand-in cannot model them: ${SCRAPE.computed.join(', ')}`);
  const got = NAV_ITEMS.map(keyMaker(NAV_ITEMS)).sort();
  assert.deepStrictEqual(got, EXPECTED_NAV_KEYS.slice().sort(),
    '\n       The set of nav items scraped out of app.js changed.' +
    '\n       If you added or removed a menu, update EXPECTED_NAV_KEYS.' +
    '\n       If you did not, an item is no longer being scraped — it has silently left every' +
    '\n       check in this file, which is exactly the failure this pin exists to catch.' +
    `\n       got:      ${JSON.stringify(got)}` +
    `\n       expected: ${JSON.stringify(EXPECTED_NAV_KEYS.slice().sort())}`);
});

test('the harness runs the real function and reproduces the real roles', () => {
  full = visiblePagesFor('');
  perRole = Object.fromEntries(Object.entries(ROLES).map(([k, v]) => [k, visiblePagesFor(v)]));
  // If effectiveRole() stopped resolving, every role would read the same and the comparison below
  // would be vacuously true.
  assert.strictEqual(full.effectiveRole, 'superadmin');
  Object.entries(ROLES).forEach(([k, v]) => assert.strictEqual(perRole[k].effectiveRole, v, k));
  console.log(`      (${NAV_ITEMS.length} nav items; Full access shows ${full.pages.size})`);
});

test('the stand-in understood every selector the real function used', () => {
  const unknown = [...new Set([full, ...Object.values(perRole)].flatMap(r => r.unknownSelectors))];
  assert.strictEqual(unknown.length, 0,
    '\n       applyRolePermissions() used a selector this harness cannot evaluate, so its effect was' +
    '\n       silently ignored and every number here is untrustworthy. Teach makeDocument() the' +
    '\n       new shape:\n       ' + unknown.join('\n       '));
});

test('the checker itself catches a new menu that forgets superadmin', () => {
  // A guard that has never been seen to fail is not a guard. `.nav-no-md` on its own is the shape
  // of the original bug AND a shape the fix does not already prevent — writing the fixture with
  // `.nav-accounting-only` would no longer fail, and would prove nothing.
  const items = NAV_ITEMS.concat([{ className: 'nav-item nav-no-md', page: '__guard_probe__' }]);
  const f = visiblePagesFor('', { items });
  const byRole = Object.fromEntries(Object.entries(ROLES).map(([k, v]) => [k, visiblePagesFor(v, { items })]));
  const gaps = gapsAgainstFullAccess(f, byRole);   // the SAME function the real check uses
  assert.ok(gaps.some(g => g.startsWith('__guard_probe__')),
    `a menu hidden from Full access but shown to other roles went unnoticed; gaps seen: ${JSON.stringify(gaps)}`);
});

test('the stand-in refuses a hiding mechanism it cannot model', () => {
  // el.hidden and style.visibility really hide a menu in a browser. The first version accepted
  // both as ordinary property writes and scored the element visible.
  const el = makeElement('nav-item nav-admin', 'x');
  assert.throws(() => { el.hidden = true; }, /cannot\s+model/);
  assert.throws(() => { el.style.visibility = 'hidden'; }, /cannot\s+model/);
  assert.throws(() => { el.classList.add('is-hidden'); }, /cannot\s+model/);
  assert.throws(() => { el.setAttribute('style', 'display:none'); }, /cannot\s+model/);
});

test('a data-page selector is evaluated, not waved through as a button selector', () => {
  // `[data-page="finalize"]` matched the old "any [attr=value] is a button" branch, so one line
  // could re-hide the payroll pages with the suite still green.
  const doc = makeDocument(NAV_ITEMS);
  assert.strictEqual(doc.querySelectorAll('[data-page="finalize"]').length, 1, 'data-page selector not evaluated');
  assert.strictEqual(doc._unknownSelectors.size, 0, 'a known selector was filed as unknown');
  assert.strictEqual(doc.querySelectorAll('[onclick="openOTModal()"]').length, 0, 'button selector should match no nav item');
  assert.strictEqual(doc._unknownSelectors.size, 0, 'the onclick selector should be known-and-empty');
  doc.querySelectorAll('.a .b');
  assert.strictEqual(doc._unknownSelectors.size, 1, 'an unmodelled selector shape must be recorded');
});

test('Full access sees every menu any role sees, except the viewer-personal ones', () => {
  const missing = gapsAgainstFullAccess(full, perRole);
  assert.strictEqual(missing.length, 0,
    '\n       Full access cannot reach a page another role can. Either add superadmin to that' +
    '\n       menu\'s visible side in applyRolePermissions() (see AGENTS.md section 7a, R2.3), or,' +
    '\n       if the page really does show the viewer\'s OWN employee records, add it to' +
    '\n       PERSONAL_TO_THE_VIEWER with the reason.\n       ' + missing.join('\n       '));
});

test('every exception is still really an exception', () => {
  // Keeps the list from rotting. If a page stops being hidden, its entry is stale and the reason
  // written next to it is no longer true of the code.
  const everRendered = new Set(Object.values(perRole).flatMap(r => [...r.pages]));
  const stale = [...PERSONAL_TO_THE_VIEWER.keys()].filter(p => full.pages.has(p) || !everRendered.has(p));
  assert.strictEqual(stale.length, 0,
    '\n       These are listed as hidden-because-personal, but Full access can now see them (or no' +
    '\n       role can). Remove the entry rather than leaving a reason that no longer holds.\n       ' +
    stale.join(', '));
});

test('the payroll pages the inspector needs are reachable at Full access', () => {
  // Named explicitly, not because the rule above misses them, but because this is the regression
  // that started it and a named test says so in the output.
  ['finalize', 'payroll-history'].forEach(p =>
    assert.ok(full.pages.has(p), `${p} is hidden from Full access again`));
});

test('an Observer superadmin would keep them too', () => {
  // The Observer pass runs last and re-hides every `.nav-no-md`, which these two carry. No such
  // account can exist today — the server refuses every write that could set the flag on a system
  // account — so this is not a bug report, it is the reason the show-pass sits after that block
  // instead of inside the role branch. If someone moves it back, this goes red.
  const obs = visiblePagesFor('', { isObserver: true });
  ['finalize', 'payroll-history'].forEach(p =>
    assert.ok(obs.pages.has(p), `${p} is lost when the account is also an Observer — the accounting show-pass has moved back above the Observer block`));
  assert.ok(!obs.pages.has('checkin'), 'an Observer must still not see Check-in');
});

console.log(`\n${passed} passed`);
