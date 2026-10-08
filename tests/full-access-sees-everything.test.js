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
// Why this exists as a test rather than a paragraph: tests/superadmin-reach.test.js can only stop
// the EXISTING superadmin branch from being deleted. It cannot know about a menu nobody has
// written yet, and the day this was written the gap had already happened -- Finalize Payroll and
// Payroll History were hidden from Full access while previewing Accounting showed them, because
// the superadmin branch was copied from the MD branch and inherited `.nav-no-md`. Full access saw
// 16 menus where Accounting saw 21, and the two missing ones were the payroll screens. Meanwhile
// navigateTo() had always named superadmin in its Finalize guard, so the page was reachable by URL
// while its own link was hidden. Nobody decided that; it was inherited.
//
// This check compares what EVERY role sees against what Full access sees, so a menu added for one
// role and forgotten for superadmin fails here on the day it is added -- which is the part R2.3
// could not otherwise close.
//
// How it runs: applyRolePermissions() is real browser code, and this repo's tests are plain Node
// with no DOM and no jsdom. So the suite builds a small stand-in document from the sidebar markup
// in app.js and runs the REAL function against it, once per role. Re-implementing the role logic
// here would only test a copy of it, and a copy drifts.
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
// The sidebar, read out of the markup app.js builds. Two entries share data-page="payslip" (My
// Payslip for an employee, the admin payslip browser for everyone else), which is why elements are
// kept as a list and only collapsed to page names at the end.
function navItemsFromSource(src) {
  const re = /class="(nav-item[^"]*)"\s+data-page="([^"]+)"/g;
  const out = [];
  let m;
  while ((m = re.exec(src)) !== null) out.push({ className: m[1], page: m[2] });
  return out;
}
const NAV_ITEMS = navItemsFromSource(APP_SRC);

// ---------------------------------------------------------------------------------------------
// A stand-in document. It models exactly what applyRolePermissions() touches: querySelectorAll,
// querySelector, getElementById, el.style.display and el.classList.contains. Visibility here is
// `style.display !== 'none'`, flat -- no parents, no CSS. That is enough, because the function
// decides a menu's fate by setting display on the element itself.
function makeElement(className, page) {
  const classes = className.split(/\s+/).filter(Boolean);
  return {
    className, page,
    classList: { contains: c => classes.includes(c) },
    style: { display: '' },
    getAttribute: a => (a === 'data-page' ? page : null),
  };
}

function makeDocument(items) {
  const els = items.map(it => makeElement(it.className, it.page));
  // Selector shapes this stand-in understands. Anything else is RECORDED and fails a test below,
  // rather than quietly matching nothing -- a silent no-match would look like "nothing to hide"
  // and could hide a real regression from this very suite.
  const unknown = new Set();
  const matches = (el, sel) => {
    sel = sel.trim();
    let m = /^\.([\w-]+)\[data-page="([^"]+)"\]$/.exec(sel);
    if (m) return el.classList.contains(m[1]) && el.page === m[2];
    m = /^\.([\w-]+)$/.exec(sel);
    if (m) return el.classList.contains(m[1]);
    // `[onclick="openOTModal()"]` and friends: real selectors, but they address buttons, not nav
    // items, so this document holds none of them. Known-and-empty, not unknown.
    if (/^\[[\w-]+="[^"]*"\]$/.test(sel)) return false;
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
function visiblePagesFor(preview, items) {
  const doc = makeDocument(items || NAV_ITEMS);
  const ctx = {
    console,
    document: doc,
    realUser: SUPER,
    currentUser: SUPER,
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
  return {
    pages: new Set(doc._elements.filter(e => e.style.display !== 'none').map(e => e.page)),
    effectiveRole: vm.runInContext('effectiveRole()', ctx),
    unknownSelectors: [...doc._unknownSelectors],
  };
}

const ROLES = { staff: 'user', driver: 'driver', manager: 'manager', accounting: 'accounting', md: 'md' };

// ---------------------------------------------------------------------------------------------
// The exception list. Every entry is a page that shows the VIEWER's own employee records, which
// the system account does not have. To look at one, impersonate a person -- that is what the
// feature is for. Adding a page here means writing down why it is personal; anything else that
// disappears from Full access is a bug, not a new entry.
const PERSONAL_TO_THE_VIEWER = new Map([
  ['checkin',     'clocking in is an act by an employee; this account has no timesheet to clock into (navigateTo refuses it outright too)'],
  ['leave',       "shows and spends the viewer's own leave balance, which this account does not have"],
  ['my-requests', "literally the viewer's own requests; this account cannot file one"],
]);

const full = visiblePagesFor('');
const perRole = Object.fromEntries(Object.entries(ROLES).map(([k, v]) => [k, visiblePagesFor(v)]));

console.log(`Full access reach — ${NAV_ITEMS.length} nav items, Full access shows ${full.pages.size}`);

test('the stand-in document understood every selector the real function used', () => {
  const unknown = [...new Set([full, ...Object.values(perRole)].flatMap(r => r.unknownSelectors))];
  assert.strictEqual(unknown.length, 0,
    '\n       applyRolePermissions() used a selector this harness cannot evaluate, so its effect was' +
    '\n       silently ignored and the numbers below cannot be trusted. Teach makeDocument() the' +
    '\n       new shape:\n       ' + unknown.join('\n       '));
});

test('the harness reproduces the real roles', () => {
  // If effectiveRole() stopped resolving, every role would read the same and the comparison would
  // be vacuously true.
  assert.strictEqual(full.effectiveRole, 'superadmin');
  Object.entries(ROLES).forEach(([k, v]) => assert.strictEqual(perRole[k].effectiveRole, v, k));
  assert.ok(full.pages.size > 5, `Full access shows only ${full.pages.size} menus — harness broken?`);
});

test('the checker itself catches a new menu that forgets superadmin', () => {
  // A guard that has never been seen to fail is not a guard. This is the exact shape of the bug
  // that prompted the suite: a page given a class the superadmin branch hides, for a reason that
  // was about some OTHER role. `.nav-no-md` on its own is that shape -- Accounting shows it, the
  // superadmin branch hides it, and nothing about it is personal to the viewer. (Writing this
  // fixture as `.nav-accounting-only .nav-no-md`, which is what Finalize Payroll actually carries,
  // would no longer fail: the fix re-shows .nav-accounting-only. The fixture has to be a bug the
  // code does not already prevent, or the guard proves nothing.)
  const items = NAV_ITEMS.concat([{ className: 'nav-item nav-no-md', page: 'training-budget' }]);
  const f = visiblePagesFor('', items);
  const acct = visiblePagesFor('accounting', items);
  const gap = [...acct.pages].filter(p => !f.pages.has(p) && !PERSONAL_TO_THE_VIEWER.has(p));
  assert.ok(gap.includes('training-budget'),
    `a menu hidden from Full access but shown to Accounting went unnoticed; gaps seen: ${JSON.stringify(gap)}`);
});

test('Full access sees every menu any role sees, except the viewer-personal ones', () => {
  const missing = [];
  Object.entries(perRole).forEach(([roleName, r]) => {
    r.pages.forEach(p => {
      if (!full.pages.has(p) && !PERSONAL_TO_THE_VIEWER.has(p)) missing.push(`${p} (seen by ${roleName})`);
    });
  });
  assert.strictEqual([...new Set(missing)].length, 0,
    '\n       Full access cannot reach a page another role can. Either add superadmin to that' +
    '\n       menu\'s visible side in applyRolePermissions() (see AGENTS.md section 7a, R2.3), or,' +
    '\n       if the page really does show the viewer\'s OWN employee records, add it to' +
    '\n       PERSONAL_TO_THE_VIEWER with the reason.\n       ' + [...new Set(missing)].join('\n       '));
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

console.log(`\n${passed} passed`);
