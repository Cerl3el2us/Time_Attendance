// Binds STATUS.md to the check registry of `npm run backlog`, in BOTH directions (2026-10-12).
//
// `npm run backlog` re-checks each open item of STATUS.md against the real code. That only works
// while the two sides name the same things:
//   - an id in STATUS.md that the registry does not know would be an item the command can never
//     check, so it would sit in the backlog forever reporting nothing;
//   - an id in the registry that no item uses is a dead check: it still runs and still prints a
//     verdict, for work nobody is tracking any more.
// Either drift is silent without this test, so each direction is its own case below.
//
// Layout of this file:
//   1. fixture cases for scripts/lib/backlog-status.js (parseStatus): small inline STATUS.md
//      strings, with the expected line numbers worked out from the fixture itself. These are green
//      as soon as the parser exists, and each one fails if the thing it names is not captured.
//   2. the cases that read the REAL STATUS.md and the REAL scripts/lib/backlog-checks.js. They are
//      the point of the file, and they say so loudly when the registry file is missing: a missing
//      file is a failure, never a skipped case, or the guard could be defeated by deleting the
//      thing it guards.
//
// Format of STATUS.md is NOT checked here; tests/status-structure.test.js owns that. The only format
// facts used are the ones parseStatus has to rely on to find a marker at all.
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { parseStatus } = require('../scripts/lib/backlog-status');

const ROOT = path.join(__dirname, '..');
const STATUS_PATH = path.join(ROOT, 'STATUS.md');
const REGISTRY_REL = 'scripts/lib/backlog-checks.js';
const REGISTRY_PATH = path.join(ROOT, 'scripts', 'lib', 'backlog-checks.js');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok ', name); }
  catch (e) { failed++; process.exitCode = 1; console.log('  FAIL', name, '\n      ', e.message); }
}

// ---------------------------------------------------------------------------------------------
// 1. parseStatus on fixtures
// ---------------------------------------------------------------------------------------------

// 1-indexed line of the first fixture line equal to `text`: the expected value is derived from the
// fixture, not typed in, so adding a line to a fixture cannot leave a stale number behind.
const lineOf = (lines, text) => {
  const i = lines.indexOf(text);
  if (i === -1) throw new Error(`fixture has no line ${JSON.stringify(text)}`);
  return i + 1;
};

// The header quotes the marker syntax the way the real STATUS.md does (mid-line, in prose), and the
// closed index carries a marker-shaped line it must not read. Neither is an item's id.
const FIXTURE = [
  '# STATUS',                                                       // 1
  '',
  'ข้อใน "เปิดอยู่" ต้องมี `· ตรวจ: <ไอดี>` หรือ `· รอเจ้าของ: <รออะไร>`',    // header prose, mid-line
  '  · ตรวจ: header-decoy',                                         // indented marker above any section
  '',
  '## ส่งต่อรอบหน้า',
  '',
  '> คำอธิบายของหัวข้อ',
  '',
  '- **ทำแผนที่ 2 ต่อ**',
  '  · **ให้ทำอะไร:** อ่านสเปกแล้วทำข้อ 4–6',
  '  · **ที่มา:** เจ้าของสั่ง 2026-10-12',
  '  · **หลักฐาน:** `git log --oneline`',
  '',
  '## เปิดอยู่',
  '',
  '- **ข้อที่มีแต่ไอดี**',
  '  · ตรวจ 2026-10-12 / grep ไม่เจอ',                              // "ตรวจ" with no colon: not a marker
  '  · ตรวจ: abc-def',
  '',
  '- **ข้อที่มีแต่รอเจ้าของ**',
  '  · รายละเอียด',
  '  · รอเจ้าของ: จะกลับมาใช้ Cursor อีกหรือไม่',
  '',
  '- **ข้อที่มีทั้งสองอย่าง**',
  '  · ตรวจ: both-half',
  '  · รอเจ้าของ: เปลี่ยนรหัสผ่านที่ DSM',
  '',
  '- **ข้อที่ไม่มีเครื่องหมายเลย**',
  '  · รายละเอียดอย่างเดียว',
  '',
  '## ปิดแล้ว (สารบัญ)',
  '',
  '- **2026-10-12** — เรื่องที่ปิดแล้ว',
  '  · ตรวจ: closed-decoy',
  '',
];
const FIXTURE_TEXT = FIXTURE.join('\n');

test('parse: a check id is captured with the real line number of its item', () => {
  const { open } = parseStatus(FIXTURE_TEXT);
  const item = open.find(o => o.subject === 'ข้อที่มีแต่ไอดี');
  assert.ok(item, `item not found among: ${open.map(o => o.subject).join(' | ')}`);
  assert.strictEqual(item.checkId, 'abc-def');
  assert.strictEqual(item.line, lineOf(FIXTURE, '- **ข้อที่มีแต่ไอดี**'));
  assert.strictEqual(item.waitingOwner, null);
});

test('parse: only ids that belong to an open item are read, nothing from the header or the closed index', () => {
  const ids = parseStatus(FIXTURE_TEXT).open.map(o => o.checkId).filter(Boolean).sort();
  assert.deepStrictEqual(ids, ['abc-def', 'both-half']);
});

test('parse: a "· รอเจ้าของ:" line alone is captured and the item is not treated as empty', () => {
  const item = parseStatus(FIXTURE_TEXT).open.find(o => o.subject === 'ข้อที่มีแต่รอเจ้าของ');
  assert.ok(item, 'item not found');
  assert.strictEqual(item.waitingOwner, 'จะกลับมาใช้ Cursor อีกหรือไม่');
  assert.strictEqual(item.checkId, null);
  assert.strictEqual(item.line, lineOf(FIXTURE, '- **ข้อที่มีแต่รอเจ้าของ**'));
});

test('parse: an item with both lines yields both checkId and waitingOwner', () => {
  const item = parseStatus(FIXTURE_TEXT).open.find(o => o.subject === 'ข้อที่มีทั้งสองอย่าง');
  assert.ok(item, 'item not found');
  assert.strictEqual(item.checkId, 'both-half');
  assert.strictEqual(item.waitingOwner, 'เปลี่ยนรหัสผ่านที่ DSM');
  assert.strictEqual(item.line, lineOf(FIXTURE, '- **ข้อที่มีทั้งสองอย่าง**'));
});

test('parse: an item with no marker stays in the list with both fields null', () => {
  // Dropping it would make the backlog look emptier than it is.
  const { open } = parseStatus(FIXTURE_TEXT);
  assert.strictEqual(open.length, 4);
  const bare = open.find(o => o.subject === 'ข้อที่ไม่มีเครื่องหมายเลย');
  assert.ok(bare, 'item not found');
  assert.strictEqual(bare.checkId, null);
  assert.strictEqual(bare.waitingOwner, null);
});

test('parse: a handoff item yields its subject, line and the three fields', () => {
  const { handoff } = parseStatus(FIXTURE_TEXT);
  assert.strictEqual(handoff.length, 1);
  assert.deepStrictEqual(handoff[0], {
    subject: 'ทำแผนที่ 2 ต่อ',
    line: lineOf(FIXTURE, '- **ทำแผนที่ 2 ต่อ**'),
    fields: { action: 'อ่านสเปกแล้วทำข้อ 4–6', source: 'เจ้าของสั่ง 2026-10-12', evidence: '`git log --oneline`' },
  });
});

test('parse: CRLF line endings give the same lines and the same ids', () => {
  const crlf = parseStatus(FIXTURE.join('\r\n'));
  assert.deepStrictEqual(crlf, parseStatus(FIXTURE_TEXT));
});

// A handoff field is its label's text through every continuation line, up to the next label of the
// item. The first version kept only the label's own line, so "start with 3 commands" arrived with
// the three commands cut off -- the pointer-with-no-payload failure the four-field rule exists for.
const MULTI = [
  '## ส่งต่อรอบหน้า',
  '',
  '- **หัวข้อ**',
  '  · **ให้ทำอะไร:** เริ่มจาก 2 คำสั่งนี้',
  '    (1) `git pull`',
  '    (2) `npm run check` — ถ้าไม่ผ่าน **หยุด** ·',                  // a `·` that ends a line is a separator
  '    ต่อจากเครื่องหมายคั่น',
  '  · **ที่มา:** เจ้าของสั่ง',
  '    ต่อบรรทัดที่สอง',
  '  · **หลักฐาน:** `ls plan.md` ต้องพบไฟล์ ·',                      // trailing `·` at the very end of the field
];
const multiFields = () => parseStatus(MULTI.join('\n')).handoff[0].fields;

test('parse: a handoff field keeps all of its continuation lines, numbered list included', () => {
  assert.strictEqual(multiFields().action,
    'เริ่มจาก 2 คำสั่งนี้ (1) `git pull` (2) `npm run check` — ถ้าไม่ผ่าน **หยุด** · ต่อจากเครื่องหมายคั่น');
  assert.strictEqual(multiFields().source, 'เจ้าของสั่ง ต่อบรรทัดที่สอง');
});

test('parse: a field stops at the next label on a LATER line and does not swallow it', () => {
  const f = multiFields();
  assert.ok(!f.action.includes('ที่มา') && !f.action.includes('เจ้าของสั่ง'), `action swallowed the next field: ${f.action}`);
  assert.ok(!f.source.includes('หลักฐาน') && !f.source.includes('plan.md'), `source swallowed the next field: ${f.source}`);
  assert.ok(!f.evidence.includes('ต่อบรรทัดที่สอง'), `evidence took the previous field's text: ${f.evidence}`);
  // and on ONE line, each label still gets its own value
  const one = parseStatus('## ส่งต่อรอบหน้า\n- **h**\n  · **ให้ทำอะไร:** A · **ที่มา:** B · **หลักฐาน:** C').handoff[0].fields;
  assert.deepStrictEqual(one, { action: 'A', source: 'B', evidence: 'C' });
});

test('parse: the middle dots at the two ends of a field are trimmed, those inside are kept', () => {
  assert.strictEqual(multiFields().evidence, '`ls plan.md` ต้องพบไฟล์');           // trailing `·` gone
  const lead = parseStatus('## ส่งต่อรอบหน้า\n- **h**\n  · **ให้ทำอะไร:** · A\n  · **ที่มา:** B\n  · **หลักฐาน:** C').handoff[0].fields;
  assert.strictEqual(lead.action, 'A');                                              // leading `·` gone
  // a continuation line that starts with `·` loses that dot, its indentation and nothing else
  const cont = parseStatus('## ส่งต่อรอบหน้า\n- **h**\n  · **ให้ทำอะไร:** A\n    · B · C\n  · **ที่มา:** s\n  · **หลักฐาน:** e').handoff[0].fields;
  assert.strictEqual(cont.action, 'A B · C');
});

test('parse: the last item of the file is returned, with or without a final newline', () => {
  // The final flush is the only thing that emits an item no later line closes.
  for (const tail of ['', '\n']) {
    const o = parseStatus(`## เปิดอยู่\n- **ท้ายไฟล์**\n  · ตรวจ: tail-id${tail}`).open;
    assert.deepStrictEqual(o, [{ subject: 'ท้ายไฟล์', line: 2, checkId: 'tail-id', waitingOwner: null }]);
  }
  const h = parseStatus('## ส่งต่อรอบหน้า\n- **h**\n  · **ให้ทำอะไร:** a\n  · **ที่มา:** b\n  · **หลักฐาน:** c').handoff;
  assert.strictEqual(h.length, 1);
});

// parseStatus does not re-validate the format, but it must not hide what it cannot read.
test('parse: a malformed marker or a stray line throws and names the line', () => {
  const at = (extra, n) => {
    const text = ['## เปิดอยู่', '- **x**', ...extra].join('\n');
    assert.throws(() => parseStatus(text), new RegExp(`STATUS\\.md:${n}:`), `no throw naming line ${n} for ${JSON.stringify(extra)}`);
  };
  at(['  · ตรวจ: Bad_ID'], 3);                                  // not a lower-case id
  at(['  · ตรวจ: a', '  · ตรวจ: b'], 4);                        // two ids
  at(['  · รอเจ้าของ:'], 3);                                    // bare owner label
  at(['  · รอเจ้าของ: ก', '  · รอเจ้าของ: ข'], 4);              // two owner lines
  at(['· ตรวจ: a'], 3);                                         // marker at column one: would be dropped
  assert.throws(() => parseStatus('## เปิดอยู่\n  · ตรวจ: a\n'), /STATUS\.md:2:/); // no item above it
  assert.throws(() => parseStatus('## ส่งต่อรอบหน้า\n- **x**\n  · **ที่มา:** a\n  · **หลักฐาน:** b'),
    /STATUS\.md:2: .*\*\*ให้ทำอะไร:\*\*/);                      // handoff field missing
  assert.throws(() => parseStatus('## ส่งต่อรอบหน้า\n- ไม่มีตัวหนา'), /STATUS\.md:2:/);
});

// 2026-10-13 (final review): prose between a handoff item's subject and its first label used to be
// dropped without a word, although the parser promises to throw on anything it cannot read.
const LABELS = ['  · **ให้ทำอะไร:** a', '  · **ที่มา:** b', '  · **หลักฐาน:** c'];
test('parse: prose above the first label of a handoff item throws and names its line', () => {
  const at = (extra, n) => {
    const text = ['## ส่งต่อรอบหน้า', '- **h**', ...extra, ...LABELS].join('\n');
    assert.throws(() => parseStatus(text), new RegExp(`STATUS\\.md:${n}: text before the first field label`),
      `no throw naming line ${n} for ${JSON.stringify(extra)}`);
  };
  at(['  เนื้อหาจริงที่อยู่เหนือป้ายแรก'], 3);
  at(['  · เนื้อหาจริงที่อยู่เหนือป้ายแรก'], 3);
  at(['', '  บรรทัดแรกที่มีเนื้อหา'], 4);                              // a blank line does not hide it
  const head = ['## ส่งต่อรอบหน้า', '- **h** และข้อความหลังหัวข้อ', ...LABELS].join('\n');
  assert.throws(() => parseStatus(head), /STATUS\.md:2: text before the first field label/);
});

test('parse: a legal handoff item (bold subject, quote, blank and bare-dot lines above the labels) still parses', () => {
  const text = ['## ส่งต่อรอบหน้า', '> คำอธิบายของหัวข้อ', '', '- **h**', '', '  >  อ้างอิง', '  ·', ...LABELS].join('\n');
  const { handoff } = parseStatus(text);
  assert.strictEqual(handoff.length, 1);
  assert.strictEqual(handoff[0].subject, 'h');
  assert.deepStrictEqual(handoff[0].fields, { action: 'a', source: 'b', evidence: 'c' });
  // and the labels may share the head line with the subject
  const same = parseStatus('## ส่งต่อรอบหน้า\n- **h** **ให้ทำอะไร:** a · **ที่มา:** b · **หลักฐาน:** c').handoff[0];
  assert.deepStrictEqual(same.fields, { action: 'a', source: 'b', evidence: 'c' });
});

// 2026-10-13 (final review): the owner gate finds an item by check id with .find(), so a second item
// with the same id would be answered with the first one's owner-wait text, or never at all.
test('parse: the same check id on two open items throws, naming both lines', () => {
  const text = ['## เปิดอยู่', '- **ก**', '  · ตรวจ: same-id', '', '- **ข**', '  · ตรวจ: same-id', '  · รอเจ้าของ: อะไรสักอย่าง'].join('\n');
  assert.throws(() => parseStatus(text), e => /STATUS\.md:5:/.test(e.message) && /line 2\b/.test(e.message) && /same-id/.test(e.message),
    'no throw naming line 5 and line 2');
  // different ids are fine, and so are several items with no id
  const ok = parseStatus(['## เปิดอยู่', '- **ก**', '  · ตรวจ: one', '- **ข**', '  · ตรวจ: two', '- **ค**', '  · รอเจ้าของ: x', '- **ง**', '  · รอเจ้าของ: y'].join('\n'));
  assert.strictEqual(ok.open.length, 4);
  // the same id in the closed index is not an open item, so it is not a duplicate
  parseStatus(['## เปิดอยู่', '- **ก**', '  · ตรวจ: one', '## ปิดแล้ว (สารบัญ)', '- **x**', '  · ตรวจ: one'].join('\n'));
});

// ---------------------------------------------------------------------------------------------
// 2. The real STATUS.md against the real registry
// ---------------------------------------------------------------------------------------------

// A missing registry is a failure with its own words, because "id X is missing from CHECKS" would
// send the reader hunting through a registry that is not there.
function loadRegistry() {
  if (!fs.existsSync(REGISTRY_PATH)) {
    throw new Error(`${REGISTRY_REL} does not exist, so the registry cannot be compared with STATUS.md.`
      + ' Create it: it must export CHECKS = { [id]: { describe, run } }.');
  }
  const mod = require(REGISTRY_PATH);
  const checks = mod && mod.CHECKS;
  if (checks === null || typeof checks !== 'object' || Array.isArray(checks)) {
    throw new Error(`${REGISTRY_REL} must export CHECKS as an object keyed by check id`);
  }
  return checks;
}

function realStatus() {
  const text = fs.readFileSync(STATUS_PATH, 'utf8');
  // If the section is not there, parseStatus would return an empty list and both directions below
  // would pass with nothing compared -- the parser or the file is wrong, not the backlog empty.
  if (!/^## เปิดอยู่\s*$/m.test(text)) throw new Error('STATUS.md has no "## เปิดอยู่" section, so there is nothing to compare');
  return parseStatus(text);
}

// The truncation case on the real file: the first handoff item's action is a short first line and
// the steps live on continuation lines. Each substring below sits on a LATER line than the label,
// so this goes red the moment a field is cut back to its first line. (Reworded 2026-10-13 when the
// handoff section was rewritten: these strings pin whatever the first item says, not the old plan.)
test('parse (real STATUS.md): the first handoff item keeps the text on its continuation lines', () => {
  const { handoff } = realStatus();
  assert.ok(handoff.length >= 1, 'STATUS.md has no handoff item, so there is nothing to read');
  const f = handoff[0].fields;
  assert.ok(f.action.includes('`npm run check`'), `action lost its (2) command: ${f.action}`);
  assert.ok(f.action.includes('หยุดและรายงาน'), `action lost the stop-and-report condition: ${f.action}`);
  assert.ok(f.action.includes('`scripts/status.js`'), `action lost its last line: ${f.action}`);
  assert.ok(f.source.includes('จึงเป็นการตัดสินใจของเจ้าของ'), `source lost its second line: ${f.source}`);
  assert.ok(f.evidence.includes('ปลายสุดคือ commit'), `evidence lost its second line: ${f.evidence}`);
  // and it still stops where the next label begins
  assert.ok(!f.action.includes('เจ้าของสั่ง 2026-10-12 ให้ทำแผนที่ 3'), `action swallowed the source field: ${f.action}`);
});

// Own properties only: an id such as `constructor` or `toString` is "in" every object, so `in` or a
// bare `checks[id]` would call a check defined that the registry never wrote.
const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
const idsMissingFrom = (open, checks) => open
  .filter(o => o.checkId !== null && !has(checks, o.checkId))
  .map(o => `${o.checkId} (STATUS.md:${o.line})`);
const idsUnused = (open, checks) => {
  const used = new Set(open.map(o => o.checkId).filter(id => id !== null));
  return Object.keys(checks).filter(id => !used.has(id));
};

test('registry: the comparison is by own property and goes red in both directions', () => {
  const run = () => {};
  const open = [{ checkId: 'constructor', line: 7 }, { checkId: 'real-one', line: 9 }, { checkId: null, line: 11 }];
  // `constructor` is inherited by {} and must not count as defined
  assert.deepStrictEqual(idsMissingFrom(open, { 'real-one': { describe: 'x', run } }), ['constructor (STATUS.md:7)']);
  assert.deepStrictEqual(idsMissingFrom(open, { constructor: { describe: 'x', run }, 'real-one': { describe: 'x', run } }), []);
  assert.deepStrictEqual(idsUnused(open, { 'real-one': { describe: 'x', run }, ghost: { describe: 'x', run } }), ['ghost']);
  assert.deepStrictEqual(idsUnused(open, { 'real-one': { describe: 'x', run } }), []);
});

test('registry: every check id used in STATUS.md exists in CHECKS', () => {
  const checks = loadRegistry();
  const missing = idsMissingFrom(realStatus().open, checks);
  assert.deepStrictEqual(missing, [],
    `STATUS.md names check ids that ${REGISTRY_REL} does not define: ${missing.join(', ')}`);
});

test('registry: every id in CHECKS is used by some item of STATUS.md', () => {
  const checks = loadRegistry();
  const dead = idsUnused(realStatus().open, checks);
  assert.deepStrictEqual(dead, [],
    `${REGISTRY_REL} defines checks that no item of STATUS.md uses: ${dead.join(', ')}`);
});

// The pure half is proven on fixtures so the rule is shown to go red; the real registry is then
// held to it. When the registry file is absent the real half has nothing to read -- that situation
// is already red in the two cases above, so the suite cannot be green with the file missing.
function checksWithoutDescribe(checks) {
  return Object.keys(checks).filter(id => {
    const c = checks[id];
    return !c || typeof c.describe !== 'string' || c.describe.trim() === '';
  });
}

test('registry: every check has a non-empty describe', () => {
  const run = () => {};
  assert.deepStrictEqual(checksWithoutDescribe({
    good: { describe: 'says what it checks', run },
    empty: { describe: '', run },
    blank: { describe: '   ', run },
    absent: { run },
    notText: { describe: 42, run },
    notAnObject: null,
  }), ['empty', 'blank', 'absent', 'notText', 'notAnObject']);
  assert.deepStrictEqual(checksWithoutDescribe({ good: { describe: 'x', run } }), []);

  if (!fs.existsSync(REGISTRY_PATH)) return;
  const bad = checksWithoutDescribe(loadRegistry());
  assert.deepStrictEqual(bad, [], `${REGISTRY_REL}: checks with no describe: ${bad.join(', ')}`);
});

console.log(`backlog-registry: ${passed} passed, ${failed} failed`);
