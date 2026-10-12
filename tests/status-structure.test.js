// STATUS.md is the one file that tells the other machine what is still open, so its shape is
// load-bearing. Two failures made this test necessary.
//
// 2026-10-12: the file had grown to 498 lines (`wc -l`) / 78494 bytes (76.7 KiB), which is past the
// size a session can read in one pass -- so every session paid two round trips before it could say
// what was open. 81% of those lines were details of work already closed.
//
// The other failure cost more. A handoff note that said only "next session, remind me about
// superadmin" reached the other machine intact, but the knowledge of what to remind about and what
// to do did not travel with it, so that machine could not act on it. A pointer with no payload.
// This test refuses the shape that allowed it: every handoff item must carry an action, a source
// and evidence, each followed by non-empty text on the same line (a bare label is the same pointer
// again). What is verified is only that one letter or digit follows the label: `TBD` or `ดูในแชท`
// pass. No mechanical check can tell a real instruction from a placeholder, and a word-count rule
// would wrongly reject a legitimate value that is a single path or filename -- so telling those
// apart stays a human review job.
//
// Layout of this file:
//   1. pure validators over text (no file access) -- each returns a list of problems, [] = ok
//   2. fixture cases: small inline strings, one per bad shape, each of which MUST be rejected,
//      plus a well-formed positive for every validator. A negative case that is never asserted
//      to fail proves nothing, so these exist to show the validators can actually go red.
//   3. assertions against the real STATUS.md and docs/STATUS_CLOSED.md. STATUS.md has been
//      restructured to fit them, so all of these are green today. If one goes red, STATUS.md has
//      drifted: fix the file, do not loosen the validator. Two of them can be green with little
//      inspected: the handoff test passes when the section has no items (an empty handoff is a
//      legitimate state), and the section-shape test passes for any section that is absent.
//
// Item syntax the validators enforce inside the three managed sections:
//   - an item starts with `- ` in column one (one or more spaces, then text);
//   - every following non-blank line up to the next item is a continuation line and MUST be
//     indented; an indented line that starts with a list marker (`-`, `*`, `+`, `•`, `–`, `・`,
//     `1.`, `1)`) is a sub-list of the item above and is accepted as part of it -- EXCEPT when the
//     marker is followed by bold text, optionally after emoji/symbol decoration (`  - **b**`,
//     `  1. **b**`, `  - 🔴 **b**`) but NOT after real words. Every real item starts with a
//     bold subject, a bold date or an emoji plus bold, so that shape is an item that lost its
//     column-one indentation; accepting it would let it hide inside the item above and escape its
//     own check id / handoff labels / index lookup, so it is rejected;
//   - a list marker in column one that is not a `- ` item is rejected, and so is a table row;
//   - a line whose first non-space character is `>` is a markdown blockquote: section explanation
//     prose is allowed, but ONLY in that form. It is not part of any item, so it can never supply a
//     handoff label's content or a check id;
//   - any other prose in column one is rejected (that is how a loose handoff note is kept from
//     hiding), and nothing but a blockquote may come before the first item.
// Anything else is rejected rather than silently ignored or swallowed into the previous item.
//
// KNOWN LIMIT: blockquote text is never validated as content. A handoff section written entirely as
// `>` lines (`> รอบหน้าให้เตือนเรื่อง superadmin`) yields zero items, so the handoff assertion
// passes with nothing inspected. That is the one shape that escapes; it cannot be forbidden without
// also forbidding the explanation prose the carve-out exists for, and an empty section is legal.
// A section starts at a column-one `## <title>` heading and ends at the next column-one `## `.
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const STATUS_PATH = path.join(ROOT, 'STATUS.md');
const CLOSED_PATH = path.join(ROOT, 'docs', 'STATUS_CLOSED.md');

// Owner-approved limits (2026-10-12): exactly 150 lines and 20480 bytes.
const MAX_LINES = 150;
const MAX_BYTES = 20480;

const SEC_HANDOFF = 'ส่งต่อรอบหน้า';
const SEC_OPEN = 'เปิดอยู่';
const SEC_CLOSED = 'ปิดแล้ว (สารบัญ)';

const HANDOFF_LABELS = ['**ให้ทำอะไร:**', '**ที่มา:**', '**หลักฐาน:**'];

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok ', name); }
  catch (e) { failed++; process.exitCode = 1; console.log('  FAIL', name, '\n      ', e.message); }
}

function snip(s) { return String(s).replace(/\s+/g, ' ').slice(0, 70); }

// ---------------------------------------------------------------------------------------------
// 1. Pure validators
// ---------------------------------------------------------------------------------------------

// Lines as `wc -l` and an editor count them: one trailing newline ends the last line, it does not
// start another. A plain split() would count a 150-line file as 151.
function splitLines(text) {
  if (text === '') return [];
  return text.replace(/\r?\n$/, '').split(/\r?\n/);
}

function checkSize(text) {
  const problems = [];
  const lines = splitLines(text).length;
  const bytes = Buffer.byteLength(text, 'utf8');
  if (lines > MAX_LINES) problems.push(`${lines} lines, limit is ${MAX_LINES}`);
  if (bytes > MAX_BYTES) problems.push(`${bytes} bytes, limit is ${MAX_BYTES}`);
  return problems;
}

// Lines belonging to one `## ` section, excluding the heading itself. null if the section is absent.
// Start and end both require the heading at column one (trailing whitespace is tolerated), so an
// indented `  ## title` is neither the start of a section nor the end of one.
function sectionLines(text, title) {
  const lines = splitLines(text);
  const start = lines.findIndex(l => l.trimEnd() === `## ${title}`);
  if (start === -1) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex(l => /^## /.test(l));
  return end === -1 ? rest : rest.slice(0, end);
}

// ASCII markers plus the three bullet glyphs people paste in from other tools (U+2022, U+2013, U+30FB).
const LIST_MARKER = /^\s*([-*+•–・]|\d+[.)])(\s|$)/;
// An indented line whose list marker is followed by bold text: an item that lost its indentation.
// Decoration between the marker and the bold (emoji such as 🔴 or ⚠️, symbols, punctuation, extra
// asterisks) is skipped: `[^\p{L}\p{N}]*` consumes everything that is not a letter or digit, so the
// bold must be the first real content. `  - ดูไฟล์ **app.js**` has words first and stays accepted.
const INDENTED_BOLD_ITEM = /^\s+([-*+•–・]|\d+[.)])\s+[^\p{L}\p{N}]*\*\*/u;

// Split a section's lines into items. Returns { blocks, problems }: blocks are the items as
// newline-joined strings; problems lists every line that is none of: a column-one `- ` item, a
// continuation line of one (indented, including an indented sub-list), or a `>` blockquote line.
// Blockquote lines are explanation, not content: they are dropped from the blocks.
function itemsOf(lines) {
  const blocks = [];
  const problems = [];
  lines.forEach((l, i) => {
    if (l.trim() === '') return;
    const at = `section line ${i + 1}`;
    if (/^- +\S/.test(l)) { blocks.push([l]); return; }
    if (/^\s*>/.test(l)) return;
    // A list marker is only a problem in column one; indented, it is a sub-list of the item above
    // (and is caught below as "before the first item" if there is no item above).
    if (!/^\s/.test(l) && LIST_MARKER.test(l)) {
      problems.push(`${at}: list marker in a shape that is not a column-one "- " item: ${snip(l)}`);
    } else if (/^\s*\|/.test(l)) {
      problems.push(`${at}: table row is not an item: ${snip(l)}`);
    } else if (INDENTED_BOLD_ITEM.test(l)) {
      // Every item starts with bold text, so an indented marker + bold is an item that lost its
      // indentation. Attaching it to the item above would hide it from that item's own checks.
      problems.push(`${at}: an item must start at column one, this one is indented: ${snip(l)}`);
    } else if (!blocks.length) {
      problems.push(`${at}: text before the first item: ${snip(l)}`);
    } else if (!/^\s/.test(l)) {
      problems.push(`${at}: line is not indented, so it is neither an item nor a continuation: ${snip(l)}`);
    } else {
      blocks[blocks.length - 1].push(l);
    }
  });
  return { blocks: blocks.map(b => b.join('\n')), problems };
}

function firstLine(block) { return block.split('\n')[0]; }

// An item under ## เปิดอยู่ must say which check proves it is still open.
function validateOpenItem(block) {
  // Horizontal whitespace only: with the `m` flag a plain `\s` would let the id sit on the NEXT line.
  if (/^[ \t]*·[ \t]*ตรวจ:[ \t]*([a-z0-9-]+)[ \t]*$/m.test(block)) return [];
  return [`no "· ตรวจ: <id>" line in: ${snip(firstLine(block))}`];
}

// An item under ## ส่งต่อรอบหน้า must be readable from the other machine without the conversation.
function validateHandoffItem(block) {
  const problems = [];
  const head = firstLine(block);
  const subject = head.match(/^- \*\*(.+?)\*\*/);
  if (!subject) {
    problems.push(`handoff item has no bold subject: ${snip(head)}`);
  } else {
    const bare = subject[1].trim().replace(/[:：]$/, '');
    if (bare === '' || HANDOFF_LABELS.some(lab => lab === `**${bare}:**`)) {
      problems.push(`handoff item's bold subject is a label, not a subject: ${snip(head)}`);
    }
  }
  const lines = block.split('\n');
  for (const label of HANDOFF_LABELS) {
    // Content = something readable after the label on the same line, up to the next label (text
    // that belongs to the next label is not this label's content). Bare punctuation such as a
    // stray "·" is not content.
    const hasContent = lines.some(l => {
      const at = l.indexOf(label);
      if (at === -1) return false;
      let rest = l.slice(at + label.length);
      for (const other of HANDOFF_LABELS) {
        const cut = rest.indexOf(other);
        if (cut !== -1) rest = rest.slice(0, cut);
      }
      return /[\p{L}\p{N}]/u.test(rest);
    });
    if (!hasContent) {
      problems.push(`handoff item has no content after ${label}: ${snip(head)}`);
    }
  }
  return problems;
}

// A closed-index item must be "- **YYYY-MM-DD** — <title>" and the title must be a heading that
// exists in the closed-work file (headings = that file's `##`..`####` lines).
function validateIndexItem(block, headings) {
  const m = firstLine(block).match(/^- \*\*(\d{4}-\d{2}-\d{2})\*\* — (.+)$/);
  if (!m) return [`index line is not "- **YYYY-MM-DD** — <title>": ${snip(firstLine(block))}`];
  const title = m[2].trim();
  if (!headings.some(h => h.includes(title))) return [`no heading in docs/STATUS_CLOSED.md contains: ${title}`];
  return [];
}

function headingsOf(text) { return splitLines(text).filter(l => /^#{2,4} /.test(l)); }

// ---------------------------------------------------------------------------------------------
// 2. Fixture cases (independent of the real files)
// ---------------------------------------------------------------------------------------------

function expectClean(problems) {
  if (problems.length) throw new Error(`expected accepted, got: ${problems.join(' | ')}`);
}
function expectRejected(problems, reason) {
  if (!problems.length) throw new Error('expected rejected, but it was accepted');
  if (reason && !problems.some(p => reason.test(p))) {
    throw new Error(`rejected for the wrong reason (wanted ${reason}): ${problems.join(' | ')}`);
  }
}

const GOOD_HANDOFF = [
  '- **ทำแผนที่ 2 ต่อ**',
  '  · **ให้ทำอะไร:** อ่านสเปกแล้วทำข้อ 4–6',
  '  · **ที่มา:** เจ้าของสั่ง 2026-10-12',
  '  · **หลักฐาน:** `git log --oneline`',
].join('\n');
const GOOD_OPEN = [
  '- **ข้อความโหมดซ้อม**',
  '  · รายละเอียดอยู่ในสเปก',
  '  · ตรวจ: superadmin-dryrun-pass-reasons',
].join('\n');

// --- size -------------------------------------------------------------------------------------
test('fixture: splitLines counts lines like wc -l', () => {
  const eq = (a, b) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${JSON.stringify(a)} != ${JSON.stringify(b)}`); };
  eq(splitLines(''), []);
  eq(splitLines('a\n'), ['a']);
  eq(splitLines('a'), ['a']);
  eq(splitLines('a\r\nb\r\n'), ['a', 'b']);
  eq(splitLines('a\n\n'), ['a', '']); // only ONE trailing newline is stripped
});
test('fixture: checkSize accepts exactly 150 lines, with or without a final newline, LF or CRLF', () => {
  expectClean(checkSize('x\n'.repeat(150)));
  expectClean(checkSize('x\n'.repeat(149) + 'x'));
  expectClean(checkSize('x\r\n'.repeat(150)));
});
test('fixture: checkSize rejects a 151-line newline-terminated file', () => {
  expectRejected(checkSize('x\n'.repeat(151)), /151 lines/);
});
test('fixture: checkSize rejects 151 lines without a final newline and 151 CRLF lines', () => {
  expectRejected(checkSize('x\n'.repeat(150) + 'x'), /151 lines/);
  expectRejected(checkSize('x\r\n'.repeat(151)), /151 lines/);
});
test('fixture: checkSize accepts exactly 20480 bytes and rejects 20481', () => {
  expectClean(checkSize('a'.repeat(20480)));
  expectRejected(checkSize('a'.repeat(20481)), /20481 bytes/);
});
test('fixture: checkSize counts bytes, not characters (Thai is 3 bytes per character)', () => {
  expectClean(checkSize('ก'.repeat(6826)));                                // 20478 bytes
  expectRejected(checkSize('ก'.repeat(6827)), /20481 bytes/);              // 20481 bytes, 6827 chars
});

// --- sectionLines -----------------------------------------------------------------------------
test('fixture: sectionLines finds a section, stops at the next ## and reports a missing one as null', () => {
  const text = '# t\n## A\n- a1\n## B\n- b1\n- b2\n';
  const a = sectionLines(text, 'A');
  const b = sectionLines(text, 'B');
  if (JSON.stringify(a) !== JSON.stringify(['- a1'])) throw new Error(`A = ${JSON.stringify(a)}`);
  if (JSON.stringify(b) !== JSON.stringify(['- b1', '- b2'])) throw new Error(`B = ${JSON.stringify(b)}`);
  if (sectionLines(text, 'C') !== null) throw new Error('missing section should be null');
});
test('fixture: sectionLines needs the heading at column one to start AND to end a section', () => {
  if (sectionLines('# t\n  ## A\n- a1\n', 'A') !== null) throw new Error('an indented heading started a section');
  const a = sectionLines('## A\n- a1\n  ## B\n- a2\n', 'A');
  if (JSON.stringify(a) !== JSON.stringify(['- a1', '  ## B', '- a2'])) throw new Error(`indented heading ended the section: ${JSON.stringify(a)}`);
  const trailing = sectionLines('## A  \n- a1\n', 'A');
  if (JSON.stringify(trailing) !== JSON.stringify(['- a1'])) throw new Error('trailing whitespace on the heading should be tolerated');
});

// --- itemsOf ----------------------------------------------------------------------------------
test('fixture: itemsOf accepts column-one items with indented continuations and blank lines', () => {
  const r = itemsOf(['- one', '  · detail', '', '- two', '    deeper detail', '']);
  expectClean(r.problems);
  if (r.blocks.length !== 2) throw new Error(`expected 2 items, got ${r.blocks.length}`);
  if (!r.blocks[0].includes('· detail') || !r.blocks[1].includes('deeper detail')) {
    throw new Error('continuation lines were not attached to their item');
  }
});

test('fixture: itemsOf accepts indented sub-lists ("1.", "1)", "-", "*", "•") as part of the item above', () => {
  const lines = ['- ok', '  1. first step', '  2) second step', '    - nested', '  * starred', '  • bullet', '- next'];
  const r = itemsOf(lines);
  expectClean(r.problems);
  if (r.blocks.length !== 2) throw new Error(`expected 2 items, got ${r.blocks.length}`);
  for (const frag of ['1. first step', '2) second step', '- nested', '* starred', '• bullet']) {
    if (!r.blocks[0].includes(frag)) throw new Error(`sub-list line not attached to its item: ${frag}`);
  }
});
test('fixture: itemsOf accepts a ">" explanation line before, between and after items, and keeps it out of the blocks', () => {
  const lines = ['> สิ่งที่ต้องรู้ก่อนอ่านหัวข้อนี้', '', '- one', '  > indented note', '> note between items', '- two'];
  const r = itemsOf(lines);
  expectClean(r.problems);
  if (r.blocks.length !== 2) throw new Error(`expected 2 items, got ${r.blocks.length}`);
  if (r.blocks.some(b => b.includes('>'))) throw new Error('a blockquote line leaked into an item');
});
test('fixture: itemsOf accepts a ">" line but rejects the same sentence written as plain prose', () => {
  const sentence = 'รอบหน้าให้เตือนเรื่อง superadmin';
  expectClean(itemsOf([`> ${sentence}`, '- ok']).problems);
  expectClean(itemsOf(['- ok', `> ${sentence}`]).problems);
  expectRejected(itemsOf([sentence, '- ok']).problems, /before the first item/);
  expectRejected(itemsOf(['- ok', sentence]).problems, /not indented/);
});
test('fixture: a blockquote line cannot stand in for a handoff label', () => {
  // The label text is present with content; only dropping the `>` line from the block makes it fail.
  const noAction = GOOD_HANDOFF.replace('  · **ให้ทำอะไร:** อ่านสเปกแล้วทำข้อ 4–6', '  > **ให้ทำอะไร:** อ่านสเปกแล้วทำข้อ 4–6');
  expectRejected(validateHandoffItem(itemsOf(noAction.split('\n')).blocks[0]), /no content after \*\*ให้ทำอะไร:\*\*/);
  // There is deliberately no open-item twin of this case: the check-id regex needs a line that
  // STARTS with `·`, so a `>`-first line can never match whether or not it is kept in the block.
  // Such an assertion would be red for a reason unrelated to the blockquote rule.
});

// An item that lost its indentation must not be swallowed by the item above it. Each section's
// grammar is run: open (check id), handoff (three labels), closed index (date + title).
const LOST_INDENT_CASES = [
  ['open item', ['- **a**', '  · ตรวจ: id-a', '  - **b**']],
  ['handoff item', [...GOOD_HANDOFF.split('\n'), '  - **b**', '    · **ให้ทำอะไร:** x']],
  ['closed-index entry', ['- **2026-10-12** — A', '  - **2026-10-11** — B']],
  ['numbered "1. **b**"', ['- **a**', '  1. **b**']],
  ['"*" marker', ['- **a**', '  * **b**']],
  ['"•" marker', ['- **a**', '  • **b**']],
  ['deeper indent', ['- **a**', '      - **b**']],
  ['dated item', ['- **a**', '  - **2026-10-12** — B']],
  ['emoji + bold "- 🔴 **b**"', ['- **a**', '  - 🔴 **b**']],
  ['emoji with variation selector + bold "- ⚠️ **b**"', ['- **a**', '  - ⚠️ **b**']],
  ['numbered emoji + bold "1. 🔴 **b**"', ['- **a**', '  1. 🔴 **b**']],
];
for (const [name, lines] of LOST_INDENT_CASES) {
  test(`fixture: itemsOf rejects an indented ${name} and says it must start at column one`, () => {
    expectRejected(itemsOf(lines).problems, /must start at column one/);
  });
}
test('fixture: an indented "- **b**" is not left unvalidated inside the item above', () => {
  // `b` has no check id. Before the rule it was merged into `a`'s block and `a`'s id satisfied the
  // open-item check for both; now the section fails, so `b` can no longer hide.
  const r = itemsOf(['- **a**', '  · ตรวจ: id-a', '  - **b**']);
  if (!r.problems.length) throw new Error('mis-indented item was accepted');
  // The sibling written correctly at column one is validated on its own and fails on its own.
  const ok = itemsOf(['- **a**', '  · ตรวจ: id-a', '- **b**']);
  expectClean(ok.problems);
  expectClean(validateOpenItem(ok.blocks[0]));
  expectRejected(validateOpenItem(ok.blocks[1]), /ตรวจ/);
});
test('fixture: itemsOf still accepts indented sub-steps whose content is not bold', () => {
  const steps = itemsOf(['- **a**', '  1. ตรวจ log', '  2) ดูไฟล์ x', '  - ดูไฟล์ x', '  1. plain step', '  - plain sub-item']);
  expectClean(steps.problems);
  if (steps.blocks.length !== 1) throw new Error(`expected 1 item, got ${steps.blocks.length}`);
  for (const frag of ['1. plain step', '- plain sub-item', '1. ตรวจ log']) {
    if (!steps.blocks[0].includes(frag)) throw new Error(`sub-step not attached: ${frag}`);
  }
  // bold INSIDE a sub-step is fine; only a marker immediately followed by bold is an item
  expectClean(itemsOf(['- **a**', '  1. ทำ **สำคัญ** ก่อน']).problems);
  // bold after real words is a legitimate sub-step, with or without a leading emoji
  expectClean(itemsOf(['- **a**', '  - ดูไฟล์ **app.js**', '  - plain sub-item', '  - 🔴 ดูไฟล์ **app.js**']).problems);
  // the middle dot used for labels is not a list marker
  expectClean(itemsOf(['- **a**', '  · **ที่มา:** x']).problems);
});

const BAD_SHAPES = [
  ['"* " bullet before the first item', ['* foo'], /list marker/],
  ['"* " bullet after a valid item', ['- ok', '* foo'], /list marker/],
  ['"+ " bullet', ['- ok', '+ foo'], /list marker/],
  ['column-one "• " entry', ['- ok', '• foo'], /list marker/],
  ['column-one "• " entry before the first item', ['• foo'], /list marker/],
  ['column-one "– " entry', ['- ok', '– foo'], /list marker/],
  ['column-one "・ " entry', ['- ok', '・ foo'], /list marker/],
  ['indented "- " bullet before the first item', ['  - foo'], /before the first item/],
  ['indented "1. " step before the first item', ['  1. foo', '- ok'], /before the first item/],
  ['numbered entry "1. "', ['1. foo'], /list marker/],
  ['numbered entry "1) " after a valid item', ['- ok', '2) foo'], /list marker/],
  ['"-" with no space', ['-foo'], /before the first item/],
  ['table row before the first item', ['| a | b |'], /table row/],
  ['table row after a valid item', ['- ok', '| a | b |'], /table row/],
  ['stray prose before the first item', ['some intro prose', '- ok'], /before the first item/],
  ['indented prose before the first item', ['  some intro prose', '- ok'], /before the first item/],
  ['unindented prose after an item', ['- ok', 'prose that is not indented'], /not indented/],
  ['plain prose that would be fine as a ">" line', ['รอบหน้าให้เตือนเรื่อง superadmin', '- ok'], /before the first item/],
];
for (const [name, lines, reason] of BAD_SHAPES) {
  test(`fixture: itemsOf rejects ${name}`, () => {
    expectRejected(itemsOf(lines).problems, reason);
  });
}

// --- validateOpenItem -------------------------------------------------------------------------
test('fixture: validateOpenItem accepts an item with a "· ตรวจ: <id>" line', () => {
  expectClean(validateOpenItem(GOOD_OPEN));
});
test('fixture: validateOpenItem rejects an item with no check line', () => {
  expectRejected(validateOpenItem('- **x**\n  · detail only'), /ตรวจ/);
});
test('fixture: validateOpenItem rejects an id that sits on the line AFTER "ตรวจ:"', () => {
  // `\s` crossing the newline used to accept this; the id must be on the same line as the label.
  expectRejected(validateOpenItem('- **x**\n  · ตรวจ:\n  superadmin-dryrun-pass-reasons'), /ตรวจ/);
  expectRejected(validateOpenItem('- **x**\n  · ตรวจ:\n\n  some-id'), /ตรวจ/);
});
test('fixture: validateOpenItem rejects an empty id, an upper-case id and a prose "ตรวจ" line', () => {
  expectRejected(validateOpenItem('- **x**\n  · ตรวจ:'), /ตรวจ/);
  expectRejected(validateOpenItem('- **x**\n  · ตรวจ: Some_ID'), /ตรวจ/);
  expectRejected(validateOpenItem('- **x**\n  · ตรวจ 2026-10-12 / grep'), /ตรวจ/);
});

// --- validateHandoffItem ----------------------------------------------------------------------
test('fixture: validateHandoffItem accepts a well-formed item', () => {
  expectClean(validateHandoffItem(GOOD_HANDOFF));
});
for (const label of HANDOFF_LABELS) {
  test(`fixture: validateHandoffItem rejects a bare ${label} with nothing after it`, () => {
    const bare = GOOD_HANDOFF.split('\n').map(l => l.includes(label) ? `  · ${label}` : l).join('\n');
    expectRejected(validateHandoffItem(bare), /no content after/);
    // trailing whitespace and a lone separator are still "nothing"
    const spaced = GOOD_HANDOFF.split('\n').map(l => l.includes(label) ? `  · ${label}   ·` : l).join('\n');
    expectRejected(validateHandoffItem(spaced), /no content after/);
  });
  test(`fixture: validateHandoffItem rejects an item missing ${label} entirely`, () => {
    const gone = GOOD_HANDOFF.split('\n').filter(l => !l.includes(label)).join('\n');
    expectRejected(validateHandoffItem(gone), /no content after/);
  });
}
test('fixture: validateHandoffItem treats a label directly followed by another label as bare', () => {
  // two labels on one line: the text after the second label is the second label's, not the first's
  const chained = [
    '- **หัวข้อ**',
    '  · **ให้ทำอะไร:** **ที่มา:** เจ้าของสั่ง',
    '  · **หลักฐาน:** `git log`',
  ].join('\n');
  expectRejected(validateHandoffItem(chained), /no content after \*\*ให้ทำอะไร:\*\*/);
});
test('fixture: validateHandoffItem rejects a first line that is only a label (all three present elsewhere)', () => {
  // The later lines carry every label WITH content, so only the subject check can reject this.
  const labelAsSubject = [
    '- **ให้ทำอะไร:**',
    '  · **ให้ทำอะไร:** ทำข้อ 4',
    '  · **ที่มา:** เจ้าของสั่ง',
    '  · **หลักฐาน:** git log',
  ].join('\n');
  const p = validateHandoffItem(labelAsSubject);
  expectRejected(p, /is a label, not a subject/);
  if (p.some(x => /no content after/.test(x))) throw new Error('label check fired, so this fixture does not isolate the subject check');
});
test('fixture: validateHandoffItem rejects a label-with-content as the subject and the other two labels too', () => {
  for (const label of HANDOFF_LABELS) {
    const block = `- ${label} มีเนื้อหาแต่เป็นป้าย\n` + GOOD_HANDOFF.split('\n').slice(1).join('\n');
    expectRejected(validateHandoffItem(block), /is a label, not a subject/);
  }
});
test('fixture: validateHandoffItem rejects a missing or empty bold subject', () => {
  expectRejected(validateHandoffItem(GOOD_HANDOFF.replace('**ทำแผนที่ 2 ต่อ**', 'ทำแผนที่ 2 ต่อ')), /no bold subject/);
  expectRejected(validateHandoffItem(GOOD_HANDOFF.replace('**ทำแผนที่ 2 ต่อ**', '** **')), /is a label, not a subject/);
});

// --- validateIndexItem ------------------------------------------------------------------------
test('fixture: validateIndexItem accepts a line whose title is a real heading', () => {
  const headings = headingsOf('# t\n### 2026-10-12 — ไทล์สถิติ dashboard — กฎแท็บเล็ต\n');
  expectClean(validateIndexItem('- **2026-10-12** — ไทล์สถิติ dashboard', headings));
});
test('fixture: validateIndexItem rejects a malformed line and a title with no heading', () => {
  const headings = ['### 2026-10-12 — ไทล์สถิติ dashboard'];
  expectRejected(validateIndexItem('- 2026-10-12 ไทล์สถิติ dashboard', headings), /is not "- \*\*YYYY-MM-DD\*\*/);
  expectRejected(validateIndexItem('- **2026-10-12** — งานที่ไม่มีหัวข้อ', headings), /no heading/);
  expectRejected(validateIndexItem('- **2026-10-12** — ไทล์สถิติ dashboard', []), /no heading/);
});

// ---------------------------------------------------------------------------------------------
// 3. The real files (all green; a red here means STATUS.md drifted from the shape above)
// ---------------------------------------------------------------------------------------------

function realStatus() { return fs.readFileSync(STATUS_PATH, 'utf8'); }

// Managed-section items for the real file; throws if the section's lines have an unrecognised shape.
function realItems(title) {
  const lines = sectionLines(realStatus(), title);
  if (lines === null) return [];
  const r = itemsOf(lines);
  expectClean(r.problems);
  return r.blocks;
}

test('STATUS.md stays small enough to read in one pass', () => {
  expectClean(checkSize(realStatus()));
});

test('the three required sections are present', () => {
  const text = realStatus();
  for (const t of [SEC_HANDOFF, SEC_OPEN, SEC_CLOSED]) {
    if (sectionLines(text, t) === null) throw new Error(`missing section: ## ${t}`);
  }
});

test('every line in the three sections is a valid item or a continuation of one', () => {
  const text = realStatus();
  const problems = [];
  for (const t of [SEC_HANDOFF, SEC_OPEN, SEC_CLOSED]) {
    const lines = sectionLines(text, t);
    if (lines !== null) problems.push(...itemsOf(lines).problems.map(p => `## ${t}: ${p}`));
  }
  expectClean(problems);
});

test('every open item names a check id', () => {
  const open = realItems(SEC_OPEN);
  if (open.length === 0) throw new Error('no items under ## เปิดอยู่ -- the parser or the file is wrong');
  for (const block of open) expectClean(validateOpenItem(block));
});

test('every handoff item carries an action, a source and evidence', () => {
  for (const block of realItems(SEC_HANDOFF)) expectClean(validateHandoffItem(block));
});

test('every closed-index line points at a heading that exists', () => {
  const index = realItems(SEC_CLOSED);
  if (index.length === 0) throw new Error('the closed index is empty -- "do not propose this again" has no teeth');
  const headings = headingsOf(fs.readFileSync(CLOSED_PATH, 'utf8'));
  for (const block of index) expectClean(validateIndexItem(block, headings));
});

console.log(`status-structure: ${passed} passed, ${failed} failed`);
