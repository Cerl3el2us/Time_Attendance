// The dashboard period-summary grid, checked as a cascade rather than as five separate rules.
//
// 2026-10-12: the rule added on 2026-10-08 to give tablets two columns never applied at any
// width. A later rule with the same specificity -- `@media (max-width: 1279px)` asking for four --
// sits below it in the file, so for every width where both match, the later one wins. Measured on
// the live site at 834px the tiles were 112px wide and 176 tall, which is exactly the outcome the
// 2026-10-08 comment says the work "was not allowed to be". Nothing caught it: there was no test
// over this file at all, and reading the rules one at a time makes each look right.
//
// So this test does not read rules. It resolves the cascade the way a browser does -- last
// matching declaration of equal specificity wins -- and asserts the column count a person
// actually gets at the widths this app is used at. Those widths are not hypothetical: the owner
// works on a 14-inch laptop (1280 or 1536 CSS px depending on scaling), a 24-inch (1920) and
// 27/32-inch monitors (2560), and employees open it on phones and tablets.
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const RAW = fs.readFileSync(path.join(__dirname, '..', 'attendance/css/style.css'), 'utf8');
// Comments first. This file explains almost every rule it contains, and those explanations quote
// selectors and braces -- walking the raw text counted comment braces as real ones and found two
// of the five declarations.
const CSS = RAW.replace(/\/\*[\s\S]*?\*\//g, '');
const SELECTOR = '#dash-period-stats-wrap .card-body';

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok ', name); }
  catch (e) { process.exitCode = 1; console.log('  FAIL', name, '\n      ', e.message); }
}

// Walk the stylesheet tracking brace depth and the @media condition in force, collecting every
// declaration of `prop` on SELECTOR in source order. Deliberately not a regex over the whole file:
// the thing under test IS the order, so the order has to come from the walk.
function declarationsFor(prop, selector = SELECTOR) {
  const out = [];
  const mediaStack = [];
  let i = 0;
  while (i < CSS.length) {
    const open = CSS.indexOf('{', i);
    const close = CSS.indexOf('}', i);
    if (open < 0 && close < 0) break;
    // A `}` before the next `{` closes the at-rule block we are standing in.
    if (close >= 0 && (open < 0 || close < open)) {
      mediaStack.pop();
      i = close + 1;
      continue;
    }
    const head = CSS.slice(i, open).trim();
    if (head.startsWith('@')) {
      mediaStack.push(head.startsWith('@media') ? head.slice(6).trim() : null);
      i = open + 1;
      continue;
    }
    // A normal rule: consume it whole, including its closing brace, so the stack is untouched.
    let depth = 1, j = open + 1;
    while (j < CSS.length && depth > 0) {
      if (CSS[j] === '{') depth++;
      else if (CSS[j] === '}') depth--;
      j++;
    }
    const selectors = head.split(',').map(s => s.replace(/\s+/g, ' ').trim());
    if (selectors.includes(selector)) {
      const body = CSS.slice(open + 1, j - 1);
      const m = new RegExp('(?:^|;)\\s*' + prop + '\\s*:([^;}]+)').exec(body);
      if (m) out.push({ media: mediaStack.length ? mediaStack[mediaStack.length - 1] : null, value: m[1].trim() });
    }
    i = j;
  }
  return out;
}

const DECLS = declarationsFor('grid-template-columns');

// 2026-10-12 (review): a condition this model does not understand used to be treated as "applies
// at every width", so adding an ordinary `@media print` rule on this selector turned every
// assertion below red at once -- a guard that cries wolf gets switched off. We model the SCREEN,
// so a print-only rule is simply not ours to judge.
function appliesAt(d, width) {
  if (!d.media) return true;
  if (/\bprint\b/.test(d.media)) return false;
  const max = /max-width:\s*(\d+)/.exec(d.media);
  const min = /min-width:\s*(\d+)/.exec(d.media);
  if (max && width > Number(max[1])) return false;
  if (min && width < Number(min[1])) return false;
  return true;
}

function columnsAt(width) {
  const matches = DECLS.filter(d => appliesAt(d, width));
  const winner = matches[matches.length - 1];
  if (!winner) return null;
  const n = /repeat\(\s*(\d+)/.exec(winner.value);
  return n ? Number(n[1]) : null;
}

test('the stylesheet really does declare this grid more than once', () => {
  assert.ok(DECLS.length >= 4, `expected several declarations, found ${DECLS.length}`);
});

// Each entry is [width, columns, why that width matters].
const EXPECTED = [
  [2560, 4, '27/32-inch monitor'],
  [1920, 4, '24-inch monitor'],
  [1600, 4, 'just above the first step'],
  [1599, 3, 'just below it'],
  [1536, 3, '14-inch laptop at 125% scaling'],
  [1280, 3, '14-inch laptop at 150% scaling'],
  [1279, 4, 'the dashboard columns stack here, so the card has full width'],
  [1100, 4, 'same band'],
  [1025, 4, 'bottom of that band'],
  [1024, 2, 'tablet landscape -- the sidebar still takes 220px and gives nothing back'],
  [900, 2, 'small tablet'],
  [834, 2, 'iPad portrait: this is the width that measured 112px tiles'],
  [768, 2, 'where the sidebar undocks'],
  [767, 2, 'phone'],
  [390, 2, 'phone'],
];

for (const [width, cols, why] of EXPECTED) {
  test(`${width}px gets ${cols} columns (${why})`, () => {
    assert.strictEqual(columnsAt(width), cols,
      `at ${width}px the winning rule gives ${columnsAt(width)} columns, not ${cols}`);
  });
}

// 2026-10-12 (review): everything below models ONE selector, matched as an exact string. A rule
// written any other way -- `#dash-lower-b #dash-period-stats-wrap .card-body` (higher specificity,
// and style.css already uses that compound form a few lines away) or `… > .card-body` -- is
// invisible to this file, so it could force one column at every width while the suite stayed
// green. Rather than teach this test specificity, refuse to be silent about rules it cannot model.
test('nothing else in the stylesheet sets this grid behind the test\'s back', () => {
  const others = [];
  const re = /(?:^|[{}])\s*([^{}@]*#dash-period-stats-wrap[^{}]*)\{([^}]*)\}/g;
  let m;
  while ((m = re.exec(CSS))) {
    const sel = m[1].replace(/\s+/g, ' ').trim();
    if (!/grid-template-columns/.test(m[2])) continue;
    if (sel.split(',').map(s => s.trim()).includes(SELECTOR)) continue;
    others.push(sel);
  }
  assert.deepStrictEqual(others, [],
    `these also set grid-template-columns on this card and are not modelled here: ${others.join(' | ')}`);
});

test('no rule in this cascade is dead -- every one wins at some width it covers', () => {
  // A declaration nothing can reach is a decision someone made that the page never honours, which
  // is how the tablet rule sat broken for days while reading perfectly in the file.
  const widths = [];
  for (let w = 320; w <= 2600; w += 1) widths.push(w);
  const reachable = new Set();
  for (const w of widths) {
    // Same resolver as columnsAt(), not a second copy of it -- the first version of this test
    // carried its own inline filter, which is how two slightly different ideas of "applies" end
    // up in one file.
    const matches = DECLS.filter(d => appliesAt(d, w));
    if (matches.length) reachable.add(DECLS.indexOf(matches[matches.length - 1]));
  }
  const dead = DECLS.map((d, i) => (reachable.has(i) ? null : (d.media || '(no media)'))).filter(Boolean);
  assert.deepStrictEqual(dead, [], `these declarations never win anywhere: ${dead.join(' | ')}`);
});

// The tiles in the first row carry no sub-label and came out 24px shorter than the rest, so with
// three columns the top row sat visibly higher than the two below it. Owner, 2026-10-12: even them
// up. A floor, not a fixed height -- a tile whose content needs more room must still grow.
// 2026-10-12 (review): the first version of this asserted only that the words "min-height" appear
// somewhere on the selector. `min-height: 0` passed it, and so did wrapping the rule in
// `@media print` where it never applies on screen. Assert the floor itself, and where it applies.
// Reuse the walker rather than a second regex: the first attempt at this used its own pattern and
// its own backwards hunt for the enclosing @media, and both were wrong in different ways.
const TILE = '#dash-period-stats-wrap .card-body .stat-card';
function minHeightRules() { return declarationsFor('min-height', TILE); }

test('the tiles have a real height floor, not just the word', () => {
  const rules = minHeightRules();
  assert.ok(rules.length > 0, 'no min-height on the period-summary tiles');
  const px = rules.map(r => parseFloat(r.value)).filter(n => Number.isFinite(n));
  assert.ok(px.some(n => n >= 100), `the floor is not a floor: ${rules.map(r => r.value).join(', ')}`);
});

// 2026-10-12 (review): the floor was written unconditionally. The owner judged it at 1280 and
// 1536, where three columns put the three label-less tiles on one row and left it sitting high.
// Below 1025 the grid is two columns and the tiles are deliberately smaller -- `.stat-card` drops
// to 14px padding and a 28px value under max-width:480 -- so a 160px floor there is pure blank
// strip under the content, and with up to nine tiles over five rows on a phone that is a few
// hundred pixels of scroll nobody asked for. Keep the floor where it was judged.
test('the height floor does not reach the widths it was never judged at', () => {
  const rules = minHeightRules();
  assert.ok(rules.length > 0, 'no min-height rule found at all');
  for (const r of rules) {
    const cond = r.media;
    assert.ok(cond && /min-width:\s*(\d+)/.test(cond),
      `the floor applies at every width (condition: ${cond || 'none'}) -- phones get it too`);
    const min = Number(/min-width:\s*(\d+)/.exec(cond)[1]);
    assert.ok(min >= 1025, `the floor starts at ${min}px, below the band it was judged at`);
  }
});

console.log(`  ${passed} passed`);
