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
const where = { root: 'C:\\fixture\\tree', branch: 'some-branch', head: 'abc1234' };
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
  assert.ok(report().includes('branch some-branch, at abc1234\n'), 'the header line is "branch <name>, at <short sha>" and nothing after it');
  const lost = B.formatHeader({ root: 'C:\\x', branch: null, head: null }, 0).join('\n');
  assert.ok(lost.includes('(NOT measured)'), lost);
});

// ---------------------------------------------------------------------------------------------
// 2. the real script
// ---------------------------------------------------------------------------------------------

const wallStart = Date.now();
const real = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'backlog.js')], { encoding: 'utf8', cwd: ROOT });
const wallMs = Date.now() - wallStart;
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

// ---------------------------------------------------------------------------------------------
// 4. fix round 1 (2026-10-13 review)
// ---------------------------------------------------------------------------------------------

const { CHECKS: REAL_CHECKS, VERDICTS: REGISTRY_VERDICTS } = require('../scripts/lib/backlog-checks');

// 2026-10-13 (final review): guarded() accepts the registry's VERDICTS and the printer ranks only its own
// ORDER, so a verdict added to one list alone would be accepted and then silently printed as NOT-VERIFIED.
test('the verdict list of the registry and the ORDER of the printer name exactly the same verdicts', () => {
  assert.ok(Array.isArray(REGISTRY_VERDICTS) && REGISTRY_VERDICTS.length > 0, 'the registry exports no VERDICTS');
  assert.deepStrictEqual([...REGISTRY_VERDICTS].sort(), [...B.ORDER].sort(),
    `registry VERDICTS ${JSON.stringify(REGISTRY_VERDICTS)} vs printer ORDER ${JSON.stringify(B.ORDER)}`);
  assert.strictEqual(new Set(B.ORDER).size, B.ORDER.length, 'ORDER repeats a verdict');
});

// -- what an OPEN verdict is, and what the command says it does ---------------------------------

test('the header says what an OPEN verdict is, true for both kinds of item', () => {
  const h = B.formatHeader(where, 0).join('\n');
  for (const part of ['for an item that names a check', 'registered check', 'names only an owner wait', 'was not checked']) {
    assert.ok(h.includes(part), `the header does not say "${part}":\n${h}`);
  }
  assert.ok(!/verdicts come from the check registry/i.test(h), 'the header again claims every verdict comes from the registry');
  assert.ok(realOut.includes(B.OPEN_BASIS), 'the real run does not print the OPEN_BASIS sentence');
});

test('an item that names only an owner wait says nothing was run for it and that the line is STATUS.md text', () => {
  const r = B.resolveItem(open({ checkId: null, waitingOwner: 'owner text' }), {});
  assert.strictEqual(r.verdict, 'WAITING-OWNER');
  assert.ok(/nothing was run for it/.test(r.evidence) && /not a result/.test(r.evidence), r.evidence);
});

test('what the command claims to do is the same sentence everywhere and claims no more than it does', () => {
  const w = B.WHAT_IT_DOES;
  assert.ok(w.includes('re-runs the registered check for each open item that names one') && w.includes('prints what it could not measure'), w);
  assert.ok(B.formatCommands().some(l => l.includes('npm run backlog') && l.includes(w)), 'the command list does not use the sentence');
  const st = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'status.js')], { encoding: 'utf8', cwd: ROOT }).stdout;
  assert.ok(st.split(w).length - 1 >= 2, 'npm run status uses the sentence in its command list and in its closing text');
  assert.ok(/Say in your answer what it could not measure/.test(st), 'status.js lost the "say what you could not measure" half of the old closing sentence');
  for (const text of [st, realOut]) {
    for (const bad of ['re-checked against the code', 'checks each claim', 'every STATUS.md item']) {
      assert.ok(!text.includes(bad), `an advert still says "${bad}"`);
    }
  }
});

// -- never clip: the printed evidence is the registry's evidence, line for line -------------------

test('resolveItem keeps a long evidence line exactly (a clipping resolveItem is red)', () => {
  const ev = ['y'.repeat(1200) + ' END1', 'short', 'z'.repeat(800) + ' END2'].join('\n');
  const r = B.resolveItem(open(), checksOf({ verdict: 'FAIL', evidence: ev }));
  assert.strictEqual(r.evidence, ev);
  const lines = B.formatItem(r);
  assert.strictEqual(lines[1], '        ' + ev.split('\n')[0]);
  assert.ok(lines[3].endsWith(' END2'));
});

test('for every REAL registry check, the printed evidence equals what the check returns, line for line', () => {
  const ids = Object.keys(REAL_CHECKS);
  assert.ok(ids.length > 0, 'the registry is empty');
  for (const id of ids) {
    const want = REAL_CHECKS[id].run();
    const got = B.resolveItem({ subject: 's', line: 9, checkId: id, waitingOwner: null }, REAL_CHECKS);
    assert.strictEqual(got.verdict, want.verdict, id);
    assert.strictEqual(got.evidence, want.evidence, `${id}: the evidence changed between the registry and the printer`);
    const lines = B.formatItem(got);
    const evLines = want.evidence.split(/\r?\n/);
    if (want.verdict === 'PASS') {
      assert.strictEqual(lines.length, 1, id);
      for (const l of evLines.map(x => x.trim()).filter(Boolean)) assert.ok(lines[0].includes(l), `${id}: PASS line lost: ${l}`);
    } else {
      assert.deepStrictEqual(lines.slice(1), evLines.map(l => '        ' + l), `${id}: printed evidence differs from the check's`);
    }
  }
});

test('the real run prints every evidence line of every registered check on the real STATUS.md', () => {
  const parsed = parseStatus(fs.readFileSync(path.join(ROOT, 'STATUS.md'), 'utf8'));
  const printed = realOut.split('\n');
  let checked = 0;
  for (const it of parsed.open) {
    if (!it.checkId || !Object.prototype.hasOwnProperty.call(REAL_CHECKS, it.checkId)) continue;
    const r = REAL_CHECKS[it.checkId].run();
    for (const l of r.evidence.split(/\r?\n/)) {
      if (r.verdict === 'PASS') { if (l.trim()) assert.ok(realOut.includes(l.trim()), `PASS evidence line missing from the output: ${l}`); }
      else assert.ok(printed.includes('        ' + l), `evidence line of ${it.checkId} missing or changed in the output: ${l.slice(0, 80)}`);
      checked++;
    }
  }
  assert.ok(checked > 0, 'no registered check ran, so nothing was compared');
});

// -- the printed total is the measured one -------------------------------------------------------

test('main prints the total it measured: a known clock gives a known number', () => {
  const base = { where, handoff: [], items: [], sync: sync(), failures: [] };
  for (const [ms, text] of [[4321.4, 'Elapsed: 4.32 s'], [1234.4, 'Elapsed: 1.23 s'], [6400, 'OVER BUDGET by 1.40 s']]) {
    const out = [];
    B.main({ gather: () => ({ ...base }), now: () => ms, write: s => out.push(s) });
    assert.ok(out.join('').includes(text), `clock ${ms}: expected "${text}" in\n${out.join('')}`);
  }
});

test('the real run: its printed total lies between sync health\'s time and the wall clock of the whole child', () => {
  const m = realOut.match(/Elapsed: (\d+\.\d\d) s/);
  const s = realOut.match(/sync health took (\d+) ms of it/);
  assert.ok(m && s, realOut);
  const total = Number(m[1]) * 1000;
  assert.ok(total + 10 >= Number(s[1]), `total ${total} ms is less than sync health's own ${s[1]} ms`);
  assert.ok(total <= wallMs + 10, `total ${total} ms is more than the ${wallMs} ms the child really took`);
});

test('the Elapsed line is honest about npm run\'s start-up and what the budget is judged on', () => {
  const t = B.formatTiming(2500, 1500).join('\n');
  assert.ok(t.includes('judged on this process alone') && t.includes('`npm run` adds its own start-up time'), t);
  // 2026-10-13 (final review): the hardcoded "measured ... s at the terminal" range was wrong on re-measurement
  // (some runs fell below its floor, others went over the 5 s budget). No second, remembered number may sit
  // next to the one this process measured.
  assert.ok(!/measured 20\d\d-|\d\.\d+-\d\.\d+ s/.test(t), `a remembered timing range is back: ${t}`);
});

// -- gather: every failure branch, driven by a lib that throws -------------------------------------

const GOOD_SHA = '0123456789abcdef0123456789abcdef01234567';
const goodEnv = (over = {}) => ({
  root: 'C:\\fixture\\tree',
  git: () => ({ status: 0, stdout: `${GOOD_SHA}\nsome-branch\n` }),
  readStatus: () => 'status text',
  parseStatus: () => ({ handoff: [{ subject: 'h', line: 1, fields: { action: 'a', source: 's', evidence: 'e' } }], open: [open({ line: 4 })] }),
  checks: checksOf({ verdict: 'PASS', evidence: 'a:1' }),
  describeSyncHealth: () => sync(),
  ...over,
});

test('gather on a healthy fixture: sha shortened to 7, branch named, nothing in failures', () => {
  const d = B.gather(goodEnv());
  assert.deepStrictEqual(d.where, { root: 'C:\\fixture\\tree', branch: 'some-branch', head: '0123456' });
  assert.strictEqual(d.failures.length, 0);
  assert.strictEqual(d.items.length, 1);
});

test('gather: a STATUS.md that cannot be parsed is a NOT MEASURED entry, with no section invented', () => {
  const d = B.gather(goodEnv({ parseStatus: () => { throw new Error('STATUS.md:12: bad line'); } }));
  assert.strictEqual(d.handoff, null);
  assert.strictEqual(d.items, null);
  assert.ok(d.failures.some(f => f.includes('STATUS.md could not be read') && f.includes('STATUS.md:12: bad line')), JSON.stringify(d.failures));
  assert.ok(B.buildReport({ ...d, totalMs: 1 }).join('\n').includes('NOT MEASURED -- 1 thing(s)'));
});

test('gather: a STATUS.md that cannot be read at all is a NOT MEASURED entry too', () => {
  const d = B.gather(goodEnv({ readStatus: () => { throw new Error('EACCES'); } }));
  assert.ok(d.failures.some(f => f.includes('EACCES')) && d.items === null);
});

test('gather: sync health that throws is a NOT MEASURED entry, and the rest of the report survives', () => {
  const d = B.gather(goodEnv({ describeSyncHealth: () => { throw new Error('Z: hung'); } }));
  assert.strictEqual(d.sync, null);
  assert.ok(d.failures.some(f => f.includes('sync health could not run') && f.includes('Z: hung')), JSON.stringify(d.failures));
  const text = B.buildReport({ ...d, totalMs: 1 }).join('\n');
  assert.ok(text.includes('SYNC HEALTH -- NOT READ') && text.includes('[PASS]') && text.includes('Commands'), text);
});

test('gather: a malformed sync health result is a NOT MEASURED entry instead of a lost report', () => {
  for (const bad of [{}, { lines: [] }, { lines: [], unmeasured: [] }, { lines: 'x', unmeasured: [], elapsedMs: 1 }, { lines: [], unmeasured: null, elapsedMs: 1 }, null, 42, undefined]) {
    const d = B.gather(goodEnv({ describeSyncHealth: () => bad }));
    assert.strictEqual(d.sync, null, JSON.stringify(bad));
    assert.ok(d.failures.some(f => f.includes('sync health returned something the printer cannot use')), JSON.stringify(bad));
    assert.doesNotThrow(() => B.buildReport({ ...d, totalMs: 1 }), JSON.stringify(bad));
  }
});

test('gather: git that times out, fails, or throws leaves branch and head unmeasured and says why', () => {
  const cases = [
    [() => ({ status: null, error: { code: 'ETIMEDOUT' } }), 'ETIMEDOUT'],
    [() => ({ status: 128, stdout: '' }), 'git exited 128'],
    [() => { throw new Error('spawn blew up'); }, 'spawn blew up'],
    [() => ({ status: 0, stdout: 'not a sha\nmain\n' }), 'could not answer'],
  ];
  for (const [git, expect] of cases) {
    const d = B.gather(goodEnv({ git }));
    assert.strictEqual(d.where.branch, null);
    assert.strictEqual(d.where.head, null);
    assert.ok(d.failures.some(f => f.includes('which branch and commit') && f.includes(expect)), `${expect}: ${JSON.stringify(d.failures)}`);
  }
});

test('the header git call is bounded and takes no optional lock', () => {
  const seen = [];
  const git = B.makeGit('C:\\fixture\\tree', (cmd, args, opts) => { seen.push({ cmd, args, opts }); return { status: 0, stdout: '' }; });
  git(['rev-parse', 'HEAD']);
  assert.strictEqual(seen[0].cmd, 'git');
  assert.ok(seen[0].args.includes('--no-optional-locks'), seen[0].args.join(' '));
  assert.ok(Number.isFinite(seen[0].opts.timeout) && seen[0].opts.timeout > 0 && seen[0].opts.timeout <= 1500, `timeout ${seen[0].opts.timeout}`);
  assert.strictEqual(B.GIT_TIMEOUT_MS, seen[0].opts.timeout);
});

// -- smaller fixes -------------------------------------------------------------------------------

test('an item whose check is unknown, throws or is unusable keeps the owner\'s wait text', () => {
  const owner = 'จะกลับมาใช้ Cursor อีกหรือไม่';
  const cases = [
    B.resolveItem(open({ checkId: 'gone', waitingOwner: owner }), {}),
    B.resolveItem(open({ waitingOwner: owner }), checksOf(() => { throw new Error('boom'); })),
    B.resolveItem(open({ waitingOwner: owner }), checksOf(() => null)),
    B.resolveItem(open({ waitingOwner: owner }), checksOf({ verdict: 'PASS', evidence: '' })),
  ];
  for (const r of cases) {
    assert.strictEqual(r.verdict, 'NOT-VERIFIED');
    assert.ok(r.evidence.includes(owner) && r.evidence.includes('STATUS.md:7'), r.evidence);
  }
});

test('a sync health result without its LIMIT line says so, and points at NOT MEASURED only when something is listed there', () => {
  // sync-health.js promises a LIMIT line always; the printer checks the promise instead of trusting it.
  const empty = B.formatSyncHealth(sync([], [])).join('\n');
  assert.ok(/did not return its LIMIT line/.test(empty), empty);
  assert.ok(!/see NOT MEASURED|under NOT MEASURED/.test(empty), empty);
  const reasons = B.formatSyncHealth(sync(['memory: a line'], ['the NAS is unreachable'])).join('\n');
  assert.ok(/did not return its LIMIT line/.test(reasons) && /under NOT MEASURED/.test(reasons), reasons);
  // and a block that does carry LIMIT never prints the complaint
  assert.ok(!/did not return its LIMIT line/.test(B.formatSyncHealth(sync()).join('\n')));
});

test('the SYNC HEALTH heading counts warnings only "among what was measured" when anything was not measured', () => {
  // the re-reviewer's reproduction: every reader failed, only sync health's own unmeasured entries, LIMIT alone
  const four = ['a reason 1', 'a reason 2', 'a reason 3', 'a reason 4'];
  const head = B.formatSyncHealth(sync(['LIMIT: the limit'], four, 1))[0];
  assert.ok(head.includes('0 warning(s) among what was measured; 4 thing(s) not measured'), head);
  assert.ok(!/\(measured in 1 ms; 0 warning\(s\)\)/.test(head), 'the bare "0 warning(s)" reading is back: ' + head);
  const mixed = B.formatSyncHealth(sync(['WARNING: x', 'LIMIT: the limit'], ['one'], 5))[0];
  assert.ok(mixed.includes('1 warning(s) among what was measured; 1 thing(s) not measured'), mixed);
  // nothing unmeasured: the plain count, no claim about "what was measured" to qualify
  const clean = B.formatSyncHealth(sync(['LIMIT: the limit'], [], 5))[0];
  assert.ok(clean.endsWith('(measured in 5 ms; 0 warning(s))') && !/not measured/.test(clean), clean);
  // and it is the heading of the whole report, not just of the function
  const text = report({ sync: sync(['LIMIT: the limit'], four, 1) });
  assert.ok(text.includes('0 warning(s) among what was measured; 4 thing(s) not measured') && text.includes('NOT MEASURED -- 4 thing(s)'), text);
});

// -- the slash command: the five holes the review found --------------------------------------------

test('the slash command closes the five ways a reassuring table could be built', () => {
  const md = fs.readFileSync(path.join(ROOT, '.claude', 'commands', 'backlog.md'), 'utf8');
  const need = (cond, what) => assert.ok(cond, `backlog.md does not ${what}`);
  // 1. the size column has no source in the output
  need(/own estimate/.test(md) && md.includes('ประมาณเอง') && /not a measurement/.test(md), 'say the ขนาด value is the reporter\'s own estimate and require it to be marked');
  // 2. handoff caveat
  need(/HANDOFF/.test(md) && md.includes('ยังไม่ได้ตรวจโดยคำสั่งนี้') && /did not check/.test(md), 'require the "claim from STATUS.md, not checked" caveat on HANDOFF rows');
  // 3. warnings, limit, and the read-by-hand sentence
  need(/every line marked `WARNING`/.test(md) && /Never leave out the `LIMIT` line/.test(md) && /read\s+something by hand\s+before trusting the FAIL/.test(md) && /in Thai/.test(md), 'require the WARNING lines, the LIMIT line and the read-by-hand sentence, in Thai');
  // 4. "none reported" must be quoted as an attribution
  need(/none reported/.test(md) && /nothing was reported by/.test(md) && /nothing unmeasured/.test(md), 'forbid reading "none reported" as "nothing unmeasured"');
  // 5. a PASS carries its evidence
  need(/reported together with its evidence/.test(md) && /file\s+existing/.test(md), 'require a PASS to be reported with its evidence');
  // and it must not say the command checks more than it does
  need(/prints the HANDOFF items from `STATUS.md` without checking them/.test(md.replace(/\s+/g, ' ')), 'say HANDOFF items are not checked');
});

console.log(`\n${passed} passed`);
