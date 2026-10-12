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

const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

test('registry: every check id used in STATUS.md exists in CHECKS', () => {
  const checks = loadRegistry();
  const missing = realStatus().open
    .filter(o => o.checkId !== null && !has(checks, o.checkId))
    .map(o => `${o.checkId} (STATUS.md:${o.line})`);
  assert.deepStrictEqual(missing, [],
    `STATUS.md names check ids that ${REGISTRY_REL} does not define: ${missing.join(', ')}`);
});

test('registry: every id in CHECKS is used by some item of STATUS.md', () => {
  const checks = loadRegistry();
  const used = new Set(realStatus().open.map(o => o.checkId).filter(id => id !== null));
  const dead = Object.keys(checks).filter(id => !used.has(id));
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
