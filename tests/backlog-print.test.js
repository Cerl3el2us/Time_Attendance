// The printer of `npm run backlog` against fixtures (2026-10-13).
//
// scripts/backlog.js decides nothing; it lays out what scripts/lib/backlog-status.js,
// backlog-checks.js and sync-health.js return. That makes its failures quiet ones: a printer that
// sorts the wrong way, clips the last line of an evidence block, or hides an empty "NOT MEASURED"
// heading produces a plausible-looking report that is wrong. Nothing else in the suite would notice.
// The plan's Task 4 had no test step; the owner ruled on 2026-10-13 that one is required.
//
// Layout of this file:
//   1. the pure formatting functions, driven by small fixtures
//   2. the real script, run once, for what only a whole run can show (section order, no item dropped)
//   3. the two places that must advertise the command: `npm run status` and the slash command
//
// Shape of an item, as the printer receives it from resolveItem(): { subject, line, id, verdict, evidence }.
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const B = require('../scripts/backlog');
const { parseStatus } = require('../scripts/lib/backlog-status');

const ROOT = path.join(__dirname, '..');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok ', name); }
  catch (e) { process.exitCode = 1; console.log('  FAIL', name, '\n      ', e.message); }
}

console.log('backlog printer: layout of `npm run backlog`');

const item = (verdict, line, evidence, subject) =>
  ({ subject: subject || `item at ${line}`, line, id: `id-${line}`, verdict, evidence });
const where = { root: 'C:\\fixture\\tree', branch: 'some-branch', head: 'abc1234 a subject' };
const sync = (lines = ['memory: a line', 'LIMIT: the limit'], unmeasured = [], elapsedMs = 1234) => ({ lines, unmeasured, elapsedMs });
const report = (over = {}) => B.buildReport({
  where, handoff: [], items: [], sync: sync(), failures: [], totalMs: 2000, ...over,
}).join('\n');
const indexOfLine = (text, needle) => text.split('\n').findIndex(l => l.includes(needle));

// ---------------------------------------------------------------------------------------------
// 1. order
// ---------------------------------------------------------------------------------------------

test('items print FAIL, then NOT-VERIFIED, then WAITING-OWNER, then PASS', () => {
  const items = [
    item('PASS', 10, 'p'), item('WAITING-OWNER', 20, 'w'), item('NOT-VERIFIED', 30, 'n'), item('FAIL', 40, 'f'),
    item('PASS', 50, 'p'), item('FAIL', 60, 'f'),
  ];
  const text = B.formatOpen(items).join('\n');
  const seen = text.match(/\[(FAIL|NOT-VERIFIED|WAITING-OWNER|PASS)\]/g).map(s => s.slice(1, -1));
  assert.deepStrictEqual(seen, ['FAIL', 'FAIL', 'NOT-VERIFIED', 'WAITING-OWNER', 'PASS', 'PASS']);
});

test('inside one verdict the items keep STATUS.md order', () => {
  const items = [item('FAIL', 70, 'f'), item('PASS', 5, 'p'), item('FAIL', 12, 'f'), item('FAIL', 99, 'f')];
  const lines = B.formatOpen(items).filter(l => l.includes('[FAIL]'));
  assert.deepStrictEqual(lines.map(l => Number(l.match(/STATUS\.md:(\d+)/)[1])), [70, 12, 99]);
});

test('the heading counts every verdict, including the ones with zero items', () => {
  const head = B.formatOpen([item('FAIL', 1, 'f'), item('PASS', 2, 'p')])[0];
  assert.ok(head.includes('2 item(s)'), head);
  for (const part of ['1 FAIL', '0 NOT-VERIFIED', '0 WAITING-OWNER', '1 PASS']) assert.ok(head.includes(part), `${part} missing from: ${head}`);
});

// ---------------------------------------------------------------------------------------------
// 1b. one line for a PASS, the whole evidence for everything else
// ---------------------------------------------------------------------------------------------

test('a PASS item is exactly ONE line, and keeps every line of its evidence on it', () => {
  const lines = B.formatItem(item('PASS', 12, 'package.json:9 "backlog"\nscripts/backlog.js exists (4000 bytes)\n.claude/commands/backlog.md exists'));
  assert.strictEqual(lines.length, 1, `printed ${lines.length} lines:\n${lines.join('\n')}`);
  for (const part of ['package.json:9 "backlog"', 'scripts/backlog.js exists (4000 bytes)', '.claude/commands/backlog.md exists', 'STATUS.md:12']) {
    assert.ok(lines[0].includes(part), `${part} is missing from the PASS line: ${lines[0]}`);
  }
});

test('N PASS items print N item lines: green never grows the report', () => {
  const items = [1, 2, 3, 4, 5, 6, 7].map(n => item('PASS', n, `a:${n}\nb:${n}\nc:${n}`));
  const lines = B.formatOpen(items);
  assert.strictEqual(lines.length, items.length + 1, `${lines.length} lines for ${items.length} items (+1 heading expected)`);
});

for (const v of ['FAIL', 'NOT-VERIFIED', 'WAITING-OWNER']) {
  test(`a ${v} item prints every evidence line, indented, and the last one is not dropped`, () => {
    const ev = ['first finding', 'second finding', '', 'LIMIT: the limit', 'read the script by hand, then close the item'].join('\n');
    const lines = B.formatItem(item(v, 8, ev));
    assert.strictEqual(lines.length, 1 + 5, `expected a head and 5 evidence lines, got:\n${lines.join('\n')}`);
    assert.ok(lines[0].startsWith(`  [${v}] STATUS.md:8`), lines[0]);
    const body = lines.slice(1);
    ev.split('\n').forEach((e, i) => {
      assert.strictEqual(body[i], '        ' + e, `evidence line ${i + 1} was changed or lost: ${JSON.stringify(body[i])}`);
    });
    assert.strictEqual(body[body.length - 1].trim(), 'read the script by hand, then close the item');
  });
}

test('very long evidence lines are not clipped', () => {
  const long = 'x'.repeat(5000) + ' END';
  const lines = B.formatItem(item('FAIL', 3, long)).join('\n');
  assert.ok(lines.includes('x'.repeat(5000) + ' END'), 'a long evidence line was cut');
});

test('Thai text from STATUS.md and from the owner passes through untouched', () => {
  const subject = 'งานที่รอเจ้าของ (ข้อ 4.6)';
  const ev = 'STATUS.md:61: awaiting the owner: จะกลับมาใช้ Cursor อีกหรือไม่\nthe code check on its own says PASS:\na:1';
  const text = B.formatItem(item('WAITING-OWNER', 61, ev, subject)).join('\n');
  assert.ok(text.includes(subject) && text.includes('จะกลับมาใช้ Cursor อีกหรือไม่'), text);
});

test('a non-PASS item whose check gave no evidence says so instead of printing nothing', () => {
  const lines = B.formatItem(item('FAIL', 3, ''));
  assert.ok(lines.join('\n').includes('gave no evidence'), lines.join('\n'));
});

// ---------------------------------------------------------------------------------------------
// 1c. resolving an item: the printer never invents, drops or upgrades a verdict
// ---------------------------------------------------------------------------------------------

const open = (over = {}) => ({ subject: 's', line: 7, checkId: 'x', waitingOwner: null, ...over });
const checksOf = (result) => ({ x: { describe: 'd', run: typeof result === 'function' ? result : () => result } });

test('a registry verdict is shown as given, evidence untouched', () => {
  for (const v of ['PASS', 'FAIL', 'NOT-VERIFIED', 'WAITING-OWNER']) {
    const r = B.resolveItem(open(), checksOf({ verdict: v, evidence: 'e1\ne2' }));
    assert.strictEqual(r.verdict, v);
    assert.strictEqual(r.evidence, 'e1\ne2');
    assert.strictEqual(r.line, 7);
  }
});

test('the printer does not decide WAITING-OWNER itself: a PASS from the registry stays PASS', () => {
  const r = B.resolveItem(open({ waitingOwner: 'something the owner must say' }), checksOf({ verdict: 'PASS', evidence: 'a:1' }));
  assert.strictEqual(r.verdict, 'PASS');
});

test('a check that throws becomes NOT-VERIFIED with the reason, not a crash and not a PASS', () => {
  const r = B.resolveItem(open(), checksOf(() => { throw new Error('boom'); }));
  assert.strictEqual(r.verdict, 'NOT-VERIFIED');
  assert.ok(r.evidence.includes('boom'), r.evidence);
});

test('an unknown verdict, a missing result and a missing check all become NOT-VERIFIED', () => {
  for (const bad of [{ verdict: 'GREEN', evidence: 'e' }, null, undefined, { evidence: 'e' }]) {
    const r = B.resolveItem(open(), checksOf(() => bad));
    assert.strictEqual(r.verdict, 'NOT-VERIFIED', JSON.stringify(bad));
  }
  const none = B.resolveItem(open({ checkId: 'not-registered' }), {});
  assert.strictEqual(none.verdict, 'NOT-VERIFIED');
  assert.ok(none.evidence.includes('not-registered'), none.evidence);
  // "constructor" is on every object's prototype; it is still not a registered check.
  assert.strictEqual(B.resolveItem(open({ checkId: 'constructor' }), {}).verdict, 'NOT-VERIFIED');
});

test('a PASS with no evidence is never shown as a PASS', () => {
  for (const ev of ['', '   \n  ', undefined, 42]) {
    const r = B.resolveItem(open(), checksOf({ verdict: 'PASS', evidence: ev }));
    assert.strictEqual(r.verdict, 'NOT-VERIFIED', JSON.stringify(ev));
  }
});

test('an item with only an owner wait is WAITING-OWNER with the owner text; with nothing at all it is NOT-VERIFIED', () => {
  const w = B.resolveItem(open({ checkId: null, waitingOwner: 'จะใช้ Cursor หรือไม่' }), {});
  assert.strictEqual(w.verdict, 'WAITING-OWNER');
  assert.ok(w.evidence.includes('จะใช้ Cursor หรือไม่') && w.evidence.includes('STATUS.md:7'), w.evidence);
  const n = B.resolveItem(open({ checkId: null }), {});
  assert.strictEqual(n.verdict, 'NOT-VERIFIED');
});

test('resolveOpen keeps every item: the output is as long as the input', () => {
  const items = [open({ line: 1 }), open({ line: 2, checkId: 'gone' }), open({ line: 3, checkId: null })];
  assert.strictEqual(B.resolveOpen(items, checksOf({ verdict: 'PASS', evidence: 'e' })).length, 3);
});

// ---------------------------------------------------------------------------------------------
// 1d. NOT MEASURED
// ---------------------------------------------------------------------------------------------

test('NOT MEASURED with content is loud, lists every entry in full, and the header points at it', () => {
  const entries = ['the NAS (Z:\\claude_memory) could not be listed: ENOENT', 'git failed\nsecond line of the reason'];
  const text = report({ sync: sync(['LIMIT: l'], entries) });
  assert.ok(text.includes('NOT MEASURED -- 2 thing(s)'), text);
  assert.ok(text.includes('NOT AN ALL-CLEAR'), 'the section does not say it is not an all-clear');
  for (const part of ['the NAS (Z:\\claude_memory) could not be listed: ENOENT', 'git failed', 'second line of the reason']) {
    assert.ok(text.includes(part), `${part} is missing`);
  }
  assert.ok(!text.includes('none reported'), 'prints the empty-section line while entries exist');
  const header = text.split('\n').slice(0, 7).join('\n');
  assert.ok(/WARNING: 2 thing\(s\) could not be measured/.test(header), `the header does not warn:\n${header}`);
});

test('NOT MEASURED with nothing in it is an explicit line, and the header does not warn', () => {
  const text = report();
  assert.ok(text.includes('NOT MEASURED -- none reported'), text);
  assert.ok(!text.includes('NOT AN ALL-CLEAR'), text);
  assert.ok(!/WARNING: \d+ thing/.test(text), text);
});

test('nothing the printer adds ever says healthy, in sync or all clear', () => {
  const text = report({ items: [item('PASS', 5, 'a:1')], sync: sync(['LIMIT: l'], []) });
  assert.ok(!/in sync|all clear|all good|healthy|no problems/i.test(text), text);
});

test('what the printer itself could not read joins NOT MEASURED and replaces the section it cost', () => {
  const text = report({ handoff: null, items: null, sync: null, failures: ['STATUS.md could not be read: EACCES'] });
  assert.ok(text.includes('HANDOFF -- NOT READ') && text.includes('OPEN -- NOT READ') && text.includes('SYNC HEALTH -- NOT READ'), text);
  assert.ok(text.includes('NOT MEASURED -- 1 thing(s)') && text.includes('STATUS.md could not be read: EACCES'), text);
  assert.ok(!text.includes('OPEN -- 0 item(s)'), 'an unreadable STATUS.md must not read as an empty backlog');
});

// ---------------------------------------------------------------------------------------------
// 1e. sync health, handoff, timing, commands, order
// ---------------------------------------------------------------------------------------------

test('sync health lines print in the order given, WARNING lines are marked, the LIMIT line is last', () => {
  const lines = ['memory: one', 'WARNING: two', 'git: three', 'LIMIT: four'];
  const out = B.formatSyncHealth(sync(lines, [], 987));
  assert.ok(out[0].includes('987 ms') && out[0].includes('1 warning(s)'), out[0]);
  const body = out.slice(1);
  assert.deepStrictEqual(body.map(l => l.trim().replace(/^!! /, '')), lines);
  assert.ok(body[1].includes('!!') && !body[0].includes('!!') && !body[2].includes('!!'), body.join('\n'));
  assert.ok(body[body.length - 1].includes('LIMIT: four'));
});

test('a handoff item prints all three fields whole, with its STATUS.md line', () => {
  const long = 'ขั้นตอน ' + 'y'.repeat(3000) + ' จบ';
  const out = B.formatHandoff([{ subject: 'หัวข้อ', line: 31, fields: { action: long, source: 'src', evidence: 'ev' } }]).join('\n');
  assert.ok(out.includes('STATUS.md:31') && out.includes('หัวข้อ'), out);
  assert.ok(out.includes(long), 'the action field was clipped');
  assert.ok(/source:\s+src/.test(out) && /evidence:\s+ev/.test(out), out);
});

test('the time is printed as a number, and a run over the 5 s budget says so', () => {
  assert.strictEqual(B.BUDGET_MS, 5000);
  const ok = B.formatTiming(2870, 1494).join('\n');
  assert.ok(ok.includes('2.87 s') && ok.includes('1494 ms') && ok.includes('budget 5 s'), ok);
  assert.ok(!ok.includes('OVER BUDGET'), ok);
  const over = B.formatTiming(6400, 3000).join('\n');
  assert.ok(over.includes('OVER BUDGET by 1.40 s'), over);
  assert.ok(B.formatTiming(1000, null).join('\n').includes('did not report a time'));
});

test('the report has its sections in the specified order and ends with the command list', () => {
  const text = report({ items: [item('PASS', 5, 'a:1')], handoff: [{ subject: 'h', line: 2, fields: { action: 'a', source: 's', evidence: 'e' } }] });
  const marks = ['=== Time Attendance backlog ===', 'Measured from: C:\\fixture\\tree', 'branch some-branch', 'HANDOFF --', 'OPEN --', 'SYNC HEALTH --', 'NOT MEASURED --', 'Elapsed:', 'Commands'];
  const at = marks.map(m => indexOfLine(text, m));
  at.forEach((n, i) => assert.ok(n >= 0, `${marks[i]} is missing`));
  assert.deepStrictEqual([...at].sort((a, b) => a - b), at, `sections out of order: ${JSON.stringify(at)}`);
  const tail = text.split('\n').slice(indexOfLine(text, 'Commands'));
  for (const c of ['npm run backlog', 'npm run status', 'npm run check']) assert.ok(tail.some(l => l.includes(c)), `${c} is not in the command list`);
});

test('the header says which tree and branch, and says so when git could not tell', () => {
  assert.ok(report().includes('branch some-branch, at abc1234 a subject'));
  const lost = B.formatHeader({ root: 'C:\\x', branch: null, head: null }, 0).join('\n');
  assert.ok(lost.includes('(NOT measured)'), lost);
});

// ---------------------------------------------------------------------------------------------
// 2. the real script
// ---------------------------------------------------------------------------------------------

const real = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'backlog.js')], { encoding: 'utf8', cwd: ROOT });
const realOut = real.stdout || '';

test('the real run exits 0 and prints every section in order', () => {
  assert.strictEqual(real.status, 0, `exit ${real.status}: ${real.stderr}`);
  const marks = ['=== Time Attendance backlog ===', 'Measured from:', 'HANDOFF --', 'OPEN --', 'SYNC HEALTH --', 'NOT MEASURED --', 'Elapsed:', 'Commands'];
  const at = marks.map(m => indexOfLine(realOut, m));
  at.forEach((n, i) => assert.ok(n >= 0, `${marks[i]} is missing from the real output:\n${realOut}`));
  assert.deepStrictEqual([...at].sort((a, b) => a - b), at, `sections out of order: ${JSON.stringify(at)}`);
});

test('the real run shows one line per STATUS.md open item: none dropped, none invented', () => {
  const parsed = parseStatus(fs.readFileSync(path.join(ROOT, 'STATUS.md'), 'utf8'));
  const shown = realOut.split('\n').filter(l => /^ {2}\[(FAIL|NOT-VERIFIED|WAITING-OWNER|PASS)\] STATUS\.md:\d+ /.test(l));
  assert.deepStrictEqual(shown.map(l => Number(l.match(/STATUS\.md:(\d+)/)[1])).sort((a, b) => a - b),
    parsed.open.map(o => o.line).sort((a, b) => a - b));
  for (const h of parsed.handoff) assert.ok(realOut.includes(`STATUS.md:${h.line}  ${h.subject}`), `handoff item at line ${h.line} is not printed`);
});

test('the real run prints sync health once, with its time, and its own total time', () => {
  assert.strictEqual(realOut.split('\n').filter(l => l.startsWith('SYNC HEALTH --')).length, 1);
  assert.ok(/SYNC HEALTH --.*measured in \d+ ms/.test(realOut), realOut);
  assert.ok(/Elapsed: \d+\.\d\d s for this process/.test(realOut), realOut);
});

test('the real run either lists what it could not measure or says explicitly that nothing was', () => {
  assert.ok(/NOT MEASURED -- (none reported|\d+ thing\(s\))/.test(realOut), realOut);
});

// ---------------------------------------------------------------------------------------------
// 3. the places that must advertise the command
// ---------------------------------------------------------------------------------------------

test('npm run status lists `npm run backlog` and no longer tells the reader to verify by hand', () => {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'status.js')], { encoding: 'utf8', cwd: ROOT });
  assert.strictEqual(r.status, 0, r.stderr);
  const tail = r.stdout.split('\n').slice(r.stdout.split('\n').findIndex(l => l.startsWith('Commands')));
  assert.ok(tail.some(l => /npm run backlog/.test(l)), `the command list does not name npm run backlog:\n${tail.join('\n')}`);
  assert.ok(!/verify each/.test(r.stdout), 'status.js still tells the reader to verify each open item by hand');
});

test('scripts/status.js no longer forbids the table that scripts/backlog.js is', () => {
  const src = fs.readFileSync(path.join(ROOT, 'scripts', 'status.js'), 'utf8');
  assert.ok(!/Deliberately NOT here \(spec 4\.4\): a per-item/.test(src), 'the old prohibition is still in the header comment');
  assert.ok(src.includes('scripts/backlog.js'), 'the header comment does not point at scripts/backlog.js');
});

test('package.json has the backlog script', () => {
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).scripts.backlog, 'node scripts/backlog.js');
});

test('the slash command exists and enforces its three rules', () => {
  const p = path.join(ROOT, '.claude', 'commands', 'backlog.md');
  assert.ok(fs.existsSync(p), '.claude/commands/backlog.md is missing');
  const md = fs.readFileSync(p, 'utf8');
  assert.ok(md.includes('npm run backlog'), 'does not tell Claude to run npm run backlog');
  assert.ok(md.includes('NOT-VERIFIED') && md.includes('NOT MEASURED'), 'does not tell Claude to name NOT-VERIFIED and NOT MEASURED');
  assert.ok(md.includes('ขนาด | งาน'), 'does not require the ขนาด | งาน table');
});

console.log(`\n${passed} passed`);
