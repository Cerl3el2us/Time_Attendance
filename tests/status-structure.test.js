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
// 2026-10-12, two rules the owner widened on purpose (each one's reasoning sits above its
// validator): an open item may carry `· ตรวจ: <id>`, `· รอเจ้าของ: <text>` or both, because two
// items in the file had an automatable half and an owner-decision half and one id per item could
// state only one of them; and a closed-index line's title may name a `##`..`####` heading OR the
// bold title of a column-one `- **…**` bullet of docs/STATUS_CLOSED.md, because every `## ` heading
// there reads "ปิดไปแล้ว <date> — อย่าเสนอซ้ำ", so a heading-only rule forced every index line to
// repeat the date and name no topic -- an index that cannot do its one job.
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
//     first real content on the line is bold (`**x**` or `__x__`), with or without a list marker
//     before it: `  **b**`, `  __b__`, `  - **b**`, `  1. **b**`, `  - 🔴 **b**`, `  - A. **b**`,
//     `  - (1) **b**`. Every real item starts with a bold subject, a bold date or an emoji plus
//     bold, so all of those are an item that lost its column-one indentation; accepting one would
//     let it hide inside the item above and escape its own check id / handoff labels / index
//     lookup, so it is rejected. Emoji, symbols, punctuation and a short enumerator token (`A.`,
//     `(1)`, `iv)`) are skipped while looking for that first real content, but real words are not:
//     `  - ดูไฟล์ **app.js**` is a legitimate sub-step and stays accepted, and so does this repo's
//     continuation shape `  · **ให้ทำอะไร:** <text>`, where `·` comes first;
//   - a list marker in column one that is not a `- ` item is rejected, and so is a table row;
//   - a line whose first non-space character is `>` is a markdown blockquote: section explanation
//     prose is allowed, but ONLY in that form. It is not part of any item, so it can never supply a
//     handoff label's content or a check id;
//   - any other prose in column one is rejected (that is how a loose handoff note is kept from
//     hiding), and nothing but a blockquote may come before the first item.
// Anything else is rejected rather than silently ignored or swallowed into the previous item.
//
// 2026-10-12, final review of this branch: blockquote text is still never validated as content, so
// a handoff section written entirely as `>` lines (`> รอบหน้าเตือนเรื่อง superadmin`) would have
// zero items and the handoff assertion would pass with nothing inspected -- the exact failure this
// file exists to stop. It is closed by pinning the rubric rather than by validating prose:
// HANDOFF_RUBRIC holds the exact `>` lines that `## ส่งต่อรอบหน้า` is allowed to contain, and the
// real-file assertion demands equality. Any NEW `>` prose under that heading is therefore red,
// which leaves writing the note as an item with the four fields as the only way through.
// A section starts at a column-one `## <title>` heading and ends at the next column-one `## `.
// Each managed heading must appear exactly once and no fourth `## ` heading may exist: with two
// `## เปิดอยู่` headings (what a bad merge of this file produces, and two machines edit it) the
// items under the second were never parsed, so nothing under it was checked.
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
const MANAGED_SECTIONS = [SEC_HANDOFF, SEC_OPEN, SEC_CLOSED];

// The standing explanation of the four required fields: the ONLY blockquote lines `## ส่งต่อรอบหน้า`
// may contain. Pinned here byte for byte because blockquote lines are dropped from item blocks, so
// a handoff written as `>` prose would be inspected by nothing. If the rubric in STATUS.md is
// reworded on purpose, update this constant in the same commit -- that is the point: the rubric
// changes only deliberately, and a new note cannot slip in beside it.
const HANDOFF_RUBRIC = [
  '> ข้อในหัวข้อนี้ต้องอ่านรู้เรื่องจากอีกเครื่องโดยไม่ต้องรู้บทสนทนาเดิม **ต้องมี 4 ช่อง**:',
  '> หัวข้อตัวหนา · `**ให้ทำอะไร:**` · `**ที่มา:**` · `**หลักฐาน:**`',
  '>',
  '> ที่มาของกฎนี้: โน้ตที่เคยเขียนว่า "รอบหน้าเตือนเรื่อง superadmin" เดินทางไปถึงอีกเครื่องจริง',
  '> แต่ความรู้ว่าเตือนเรื่องอะไรและให้ทำอะไร ไม่ได้ไปด้วย ⇒ อีกเครื่องรับโน้ตแล้วทำอะไรไม่ได้',
];

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

// 1-based file line number of a section's FIRST line (the line after its heading), or null if the
// section is absent. Only used to turn section-relative problem positions into real file lines.
function sectionFirstLine(text, title) {
  const i = splitLines(text).findIndex(l => l.trimEnd() === `## ${title}`);
  return i === -1 ? null : i + 2;
}

// Every column-one `## ` heading, trailing whitespace trimmed.
function topHeadings(text) { return splitLines(text).filter(l => /^## /.test(l)).map(l => l.trimEnd()); }

// `sectionLines` takes the FIRST match, so a second `## เปิดอยู่` hides every item under it: the
// parser never sees them, and no assertion ever runs on them. A duplicated heading is what a bad
// git merge of this file produces, and two machines edit it. A fourth section is rejected too:
// AGENTS.md states as a fact that this file holds exactly these three.
function validateHeadings(text) {
  const problems = [];
  const headings = topHeadings(text);
  for (const title of MANAGED_SECTIONS) {
    const n = headings.filter(h => h === `## ${title}`).length;
    if (n !== 1) problems.push(`"## ${title}" occurs ${n} times, it must occur exactly once`);
  }
  for (const h of headings) {
    if (!MANAGED_SECTIONS.some(t => h === `## ${t}`)) {
      problems.push(`unexpected "## " heading (this file has exactly three): ${snip(h)}`);
    }
  }
  return problems;
}

// ASCII markers plus the three bullet glyphs people paste in from other tools (U+2022, U+2013, U+30FB).
const LIST_MARKER = /^\s*([-*+•–・]|\d+[.)])(\s|$)/;
// An indented line whose first real content is bold: an item that lost its column-one indentation.
// Built from parts so each one can be read on its own:
//   BOLD  -- markdown's two bold markers. `__b__` used to slip through while `**b**` was caught.
//   DECOR -- what may sit between the start of the line and that bold: emoji (🔴, ⚠️ with its
//            variation selector), symbols, punctuation, a list marker, extra asterisks. Anything
//            that is not a letter or a digit, so the bold must be the FIRST REAL content.
//            `·` is deliberately EXCLUDED: `  · **ให้ทำอะไร:** x` is this repo's legitimate
//            continuation shape (the label comes after a middle dot) and must keep passing.
//   ENUM  -- a short enumerator token (`A.`, `(1)`, `iv)`). Skipped as decoration, because
//            `  - A. **b**` and `  - (1) **b**` are the same lost item; bounded to one letter or
//            up to three digits so that real words never match and `  - ดูไฟล์ **app.js**`
//            stays a sub-step.
// No list marker is required: `  **เตือนเรื่อง superadmin**` was appended to the item above and so
// inherited its labels / check id, which is the payload-free handoff shape all over again.
const BOLD = String.raw`(?:\*\*|__)`;
const DECOR = String.raw`[^\p{L}\p{N}·]*`;
const ENUM = String.raw`\(?(?:\d{1,3}|[A-Za-z]|[ivxIVX]{1,4})[.)]`;
const INDENTED_BOLD_ITEM = new RegExp(`^\\s+${DECOR}(?:${ENUM}${DECOR}){0,2}${BOLD}`, 'u');

// Split a section's lines into items. Returns { blocks, problems }: blocks are the items as
// newline-joined strings; problems lists every line that is none of: a column-one `- ` item, a
// continuation line of one (indented, including an indented sub-list), or a `>` blockquote line.
// Blockquote lines are explanation, not content: they are dropped from the blocks.
// `firstFileLine`, when given, is the real file line number of lines[0]; problem positions are then
// reported as real file lines instead of section-relative ones (a red that says "section line 7"
// with no section name sends the reader counting lines by hand).
function itemsOf(lines, firstFileLine) {
  const blocks = [];
  const starts = []; // real file line of each block's first line; null when the caller gave no start
  const problems = [];
  lines.forEach((l, i) => {
    if (l.trim() === '') return;
    const at = firstFileLine ? `line ${firstFileLine + i}` : `section line ${i + 1}`;
    if (/^- +\S/.test(l)) { blocks.push([l]); starts.push(firstFileLine ? firstFileLine + i : null); return; }
    if (/^\s*>/.test(l)) return;
    // A list marker is only a problem in column one; indented, it is a sub-list of the item above
    // (and is caught below as "before the first item" if there is no item above).
    if (!/^\s/.test(l) && LIST_MARKER.test(l)) {
      problems.push(`${at}: list marker in a shape that is not a column-one "- " item: ${snip(l)}`);
    } else if (/^\s*\|/.test(l)) {
      problems.push(`${at}: table row is not an item: ${snip(l)}`);
    } else if (INDENTED_BOLD_ITEM.test(l)) {
      // Every item starts with bold text, so an indented line whose first real content is bold is
      // an item that lost its indentation -- with or without a list marker in front of the bold.
      // Attaching it to the item above would hide it from that item's own checks.
      problems.push(`${at}: an item must start at column one, this one is indented: ${snip(l)}`);
    } else if (!blocks.length) {
      problems.push(`${at}: text before the first item: ${snip(l)}`);
    } else if (!/^\s/.test(l)) {
      problems.push(`${at}: line is not indented, so it is neither an item nor a continuation: ${snip(l)}`);
    } else {
      blocks[blocks.length - 1].push(l);
    }
  });
  return { blocks: blocks.map(b => b.join('\n')), starts, problems };
}

function firstLine(block) { return block.split('\n')[0]; }

// The blockquote lines of a section, in order and unchanged. `itemsOf` drops these, so they are the
// part of a section that no item-level validator ever sees.
function blockquotesOf(lines) { return lines.filter(l => /^\s*>/.test(l)); }

// `## ส่งต่อรอบหน้า` may hold exactly the standing rubric and nothing else as blockquote prose.
// Without this, `> รอบหน้าเตือนเรื่อง superadmin` alone gives the section zero items, and
// "every handoff item carries an action, a source and evidence" passes having inspected nothing.
function validateHandoffRubric(lines) {
  const got = blockquotesOf(lines);
  const same = got.length === HANDOFF_RUBRIC.length && got.every((l, i) => l === HANDOFF_RUBRIC[i]);
  if (same) return [];
  return [
    'the "> " lines under ## ' + SEC_HANDOFF + ' are not exactly the standing rubric. A new handoff'
    + ' note must be an ITEM with the four fields (bold subject, ' + HANDOFF_LABELS.join(' ')
    + '), not "> " prose -- blockquote lines are inspected by nothing. If the rubric itself was'
    + ' reworded on purpose, update HANDOFF_RUBRIC in this test in the same commit.'
    + `\n       expected ${HANDOFF_RUBRIC.length} line(s):\n         ` + HANDOFF_RUBRIC.join('\n         ')
    + `\n       got ${got.length} line(s):\n         ` + got.join('\n         '),
  ];
}

// An item under ## เปิดอยู่ must say what would settle it. Two line types do that, and an item may
// carry one of each (owner's decision 2026-10-12):
//   `· ตรวจ: <id>`       -- the half a script can decide: one id, run from scripts/backlog.js.
//   `· รอเจ้าของ: <text>` -- the half no script can decide: what is awaited from the owner.
// Why the second type exists: `nas-password-scrubbed` named only the automatable half of its item
// (the scrub) while the open half is a password the owner must change in the DSM admin UI, and
// `cursor-rules-file` named work that is deliberately out of scope. With one id per item, a
// registry check over those ids reports green or red opposite to the item's real state -- the one
// failure `npm run backlog` exists to prevent. At most one line of each type, so "which check owns
// this item" and "what is the owner holding" each have exactly one answer; at least one of the two,
// so an item can never be open for no stated reason. Both must be indented continuation lines: a
// column-one `· …` line is rejected by itemsOf too, but a block handed straight to this validator
// was never parsed by itemsOf, so the indentation is required here as well.
// Ids are `[a-z0-9]` words joined by single dashes: `[a-z0-9-]+` used to accept a lone `-`.
const CHECK_LINE = /^[ \t]*·[ \t]*ตรวจ:/;
const CHECK_ID_LINE = /^[ \t]+·[ \t]*ตรวจ:[ \t]*[a-z0-9]+(?:-[a-z0-9]+)*[ \t]*$/;
const OWNER_LINE = /^[ \t]*·[ \t]*รอเจ้าของ:/;
// Content = at least one letter or digit after the label on the SAME line, the same test the
// handoff labels use. A bare `· รอเจ้าของ:` is the payload-free pointer all over again.
const OWNER_CONTENT_LINE = /^[ \t]+·[ \t]*รอเจ้าของ:[^\n]*[\p{L}\p{N}]/u;
const INDENTED_LINE = /^[ \t]/;
function validateOpenItem(block) {
  const problems = [];
  const head = snip(firstLine(block));
  // Per line, so neither label can ever be satisfied across a newline (a plain `\s` with the `m`
  // flag used to let the id sit on the NEXT line).
  const lines = block.split('\n');
  const checkLines = lines.filter(l => CHECK_LINE.test(l));
  const ownerLines = lines.filter(l => OWNER_LINE.test(l));
  for (const l of checkLines) {
    if (CHECK_ID_LINE.test(l)) continue;
    problems.push(INDENTED_LINE.test(l)
      ? `"· ตรวจ:" names no single lower-case id: ${snip(l)}`
      : `"· ตรวจ:" must be an indented continuation line: ${snip(l)}`);
  }
  for (const l of ownerLines) {
    if (OWNER_CONTENT_LINE.test(l)) continue;
    problems.push(INDENTED_LINE.test(l)
      ? `"· รอเจ้าของ:" says nothing about what is awaited: ${snip(l)}`
      : `"· รอเจ้าของ:" must be an indented continuation line: ${snip(l)}`);
  }
  if (checkLines.length > 1) {
    problems.push(`${checkLines.length} "· ตรวจ:" lines, an item may carry exactly one: ${head}`);
  }
  if (ownerLines.length > 1) {
    problems.push(`${ownerLines.length} "· รอเจ้าของ:" lines, an item may carry exactly one: ${head}`);
  }
  if (!checkLines.length && !ownerLines.length) {
    problems.push(`no "· ตรวจ: <id>" line and no "· รอเจ้าของ: <text>" line in: ${head}`);
  }
  return problems;
}

// One check id belongs to one open item. scripts/lib/backlog-status.js (parseStatus) throws on a
// second item that reuses an id: the registry is keyed by id and the owner gate looks an item up by
// id, so two items sharing one would each be answered with the first item's text. That throw costs
// the whole `npm run backlog` report (HANDOFF and OPEN both print "NOT READ"), so the guard that
// governs the document says it first. `starts` are the real file lines of the blocks (itemsOf), so
// the message can name both lines; without them the position in the list is named instead.
// Only a well-formed id counts (a malformed one is validateOpenItem's complaint), and an item with
// two "· ตรวจ:" lines is validateOpenItem's complaint too, so only the first id of an item is read.
function validateUniqueCheckIds(blocks, starts) {
  const problems = [];
  const seen = new Map(); // id -> where the first item using it starts
  blocks.forEach((block, n) => {
    const where = starts && starts[n] ? `line ${starts[n]}` : `open item ${n + 1}`;
    const idLine = block.split('\n').find(l => CHECK_ID_LINE.test(l));
    if (!idLine) return;
    const id = idLine.match(/ตรวจ:[ \t]*(\S+)/)[1];
    if (seen.has(id)) {
      problems.push(`${where}: check id "${id}" is already used by the item at ${seen.get(id)}; one id may belong to only one item (npm run backlog refuses to read STATUS.md otherwise): ${snip(firstLine(block))}`);
    } else {
      seen.set(id, where);
    }
  });
  return problems;
}

// Text that belongs to no field. parseStatus (scripts/lib/backlog-status.js, readFields) reads a
// handoff field as the text after its label, so words that come BEFORE the item's first label are
// attached to nothing; rather than drop them it throws, and that throw costs the whole `npm run
// backlog` report. Two shapes, both found by the 2026-10-13 re-review of a9403d3 against fixtures
// this test used to accept:
//   - the head line carries text after its bold subject:  `- **หัวข้อ** (2026-10-13)`
//   - a continuation line before the first label carries text:  `  · อธิบายก่อน`
// Same split as readFields: every line is cut at the three labels and piece 0 is what precedes the
// first label on that line. Once a label has been seen, later lines belong to that field.
const LABEL_SPLIT = new RegExp('(' + HANDOFF_LABELS.map(l => l.replace(/[*]/g, '\\$&')).join('|') + ')');
const HAS_CONTENT = /[\p{L}\p{N}]/u;
function validateHandoffStray(block, firstFileLine) {
  const problems = [];
  const lines = block.split('\n');
  if (!/^- \*\*(.+?)\*\*/.test(lines[0])) return problems; // "no bold subject" is reported on its own
  let seenLabel = false;
  for (let i = 0; i < lines.length && !seenLabel; i++) {
    const before = lines[i].split(LABEL_SPLIT)[0];
    if (lines[i].split(LABEL_SPLIT).length > 1) seenLabel = true;
    const stray = i === 0 ? before.replace(/^- +\*\*.+?\*\*/, '') : before;
    if (!HAS_CONTENT.test(stray)) continue;
    const at = firstFileLine ? `line ${firstFileLine + i}` : `line ${i + 1} of the item`;
    problems.push(i === 0
      ? `${at}: text after the bold subject on the head line would be dropped by npm run backlog (it refuses to read STATUS.md): ${snip(stray)}`
      : `${at}: text before the item's first field label would be dropped by npm run backlog (it refuses to read STATUS.md): ${snip(stray)}`);
  }
  return problems;
}

// An item under ## ส่งต่อรอบหน้า must be readable from the other machine without the conversation.
// `firstFileLine` (optional) is the real file line of the item's first line, for the stray-text messages.
function validateHandoffItem(block, firstFileLine) {
  const problems = [];
  const head = firstLine(block);
  const subject = head.match(/^- \*\*(.+?)\*\*/);
  if (!subject) {
    problems.push(`handoff item has no bold subject: ${snip(head)}`);
  } else {
    const bare = subject[1].trim().replace(/[:：]$/, '');
    if (bare === '') {
      // Rejected for being empty, which is not the same defect as being one of the labels.
      problems.push(`handoff item's bold subject is empty: ${snip(head)}`);
    } else if (HANDOFF_LABELS.some(lab => lab === `**${bare}:**`)) {
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
  problems.push(...validateHandoffStray(block, firstFileLine));
  return problems;
}

// A closed-index item must be "- **YYYY-MM-DD** — <title>", the title must name something that
// really exists in the closed-work file, AND the `## ` section that something sits under must carry
// the index line's date. The date used to be captured and thrown away, so
// `- **1999-01-01** — ปิดไปแล้ว 2026-10-12 …` passed and the index could point at the wrong day.
//
// 2026-10-12 (owner's decision): what a title may name was widened from a heading alone to a
// heading (`##`..`####`) OR the bold title of a column-one `- **…**` bullet. Why: every `## `
// heading of the closed file reads "ปิดไปแล้ว <date> — อย่าเสนอซ้ำ", so a title that had to be a
// substring of a heading could only repeat the date, and each index line ended up saying nothing
// about its topic -- while the index's whole job is to stop finished work from being proposed
// again, which a line with no topic cannot do. The real topics are column-one bullets (`###` exists
// under one section only, so matching `###` headings instead does not reach them), and the moved
// text of docs/STATUS_CLOSED.md is kept byte-identical on purpose, so promoting those bullets to
// headings was not an option either.
//
// The date is checked against the SECTION, not the matched text: bullet titles carry no date, so
// the `## ` heading above a bullet is what files that topic under a day. For a `## ` heading the
// section is the heading itself, which is exactly the older rule.
const INDEX_LINE = /^- \*\*(\d{4}-\d{2}-\d{2})\*\* — (.+)$/;
// A column-one bullet whose first content is bold -- the shape itemsOf treats as an item, read here
// for its bold title only. The backreference makes `**x**` and `__x__` close with the marker they
// opened with, and the lazy body stops at that marker, so `- **a** และ **b**` has the title `a`.
// The body is not `[^*_]+` on purpose: `` `session_start.ps1` `` is a real title with an underscore.
const CLOSED_BULLET = /^- +(\*\*|__)(.+?)\1/;

// Everything an index line may point at: `{ title, section }` for every heading and every
// column-one bold bullet, where `section` is the `## ` heading it sits under (null above the first
// one, which no date can match -- a topic outside every section cannot be filed under a day).
function closedTargets(text) {
  const targets = [];
  let section = null;
  for (const raw of splitLines(text)) {
    const line = raw.trimEnd();
    if (/^## /.test(line)) section = line;
    if (/^#{2,4} /.test(line)) { targets.push({ title: line, section }); continue; }
    const m = line.match(CLOSED_BULLET);
    if (m) targets.push({ title: m[2].trim(), section });
  }
  return targets;
}

function validateIndexItem(block, targets) {
  const m = firstLine(block).match(INDEX_LINE);
  if (!m) return [`index line is not "- **YYYY-MM-DD** — <title>": ${snip(firstLine(block))}`];
  const [, date, rawTitle] = m;
  const title = rawTitle.trim();
  // An empty title is a substring of everything, so it would match every target and name none.
  if (title === '') return [`index line has no title after the em dash: ${snip(firstLine(block))}`];
  const matching = targets.filter(t => t.title.includes(title));
  if (!matching.length) {
    return [`no heading and no "- **…**" bullet title in docs/STATUS_CLOSED.md contains: ${title}`];
  }
  if (!matching.some(t => t.section && t.section.includes(date))) {
    return [`the docs/STATUS_CLOSED.md section holding what this index line names`
      + ` does not carry its date ${date}: ${snip(matching[0].section || matching[0].title)}`];
  }
  return [];
}

// The other direction, which nothing checked: every `## ` section of the closed-work file must be
// named by some index line. Append a `## ปิดไปแล้ว 2026-10-13` section with no index line and the
// work is invisible from STATUS.md -- so it can be proposed again, which is the one failure the
// index exists to prevent. The file's own `# ` title is not a `## ` heading, so it is not required
// to be indexed.
// A section counts as named when an index line names the section heading itself OR anything inside
// it (a bullet title, a `###` sub-heading). It has to: with titles widened to bullet titles, a
// section written as several topics is indexed by naming those topics, and demanding the heading
// text on top of that would make the two rules contradict each other.
function validateClosedCoverage(indexBlocks, closedText) {
  const titles = indexBlocks
    .map(b => firstLine(b).match(INDEX_LINE))
    .filter(Boolean)
    .map(m => m[2].trim())
    .filter(t => t !== '');
  const targets = closedTargets(closedText);
  const problems = [];
  for (const h of topHeadings(closedText)) {
    const named = targets.some(t => t.section === h && titles.some(x => t.title.includes(x)));
    if (!named) {
      problems.push(`no line in the closed index points at docs/STATUS_CLOSED.md heading: ${snip(h)}`);
    }
  }
  return problems;
}

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
// An item nothing can check: it is open only because the owner has not decided. No check id, so a
// registry cannot report it green or red -- it is reported as waiting on the owner.
const GOOD_OPEN_OWNER = [
  '- **ไฟล์กฎให้ Cursor**',
  '  · จงใจไม่ทำในรอบนี้',
  '  · รอเจ้าของ: จะกลับมาใช้ Cursor อีกหรือไม่',
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

// --- validateHeadings -------------------------------------------------------------------------
const THREE_HEADINGS = `## ${SEC_HANDOFF}\n## ${SEC_OPEN}\n## ${SEC_CLOSED}\n`;
test('fixture: validateHeadings accepts the three managed headings, once each', () => {
  expectClean(validateHeadings('# t\n\n' + THREE_HEADINGS));
});
test('fixture: validateHeadings rejects a duplicated heading (the shape a bad merge produces)', () => {
  expectRejected(validateHeadings('# t\n' + THREE_HEADINGS + `## ${SEC_OPEN}\n`), /occurs 2 times/);
  // Why it matters: sectionLines takes the FIRST match, so everything under the second heading is
  // never parsed and never validated -- `- **b**` below has no check id and nothing notices.
  const dup = `## ${SEC_OPEN}\n- **a**\n  · ตรวจ: id-a\n## ${SEC_CLOSED}\n- x\n## ${SEC_OPEN}\n- **b**\n`;
  const seen = sectionLines(dup, SEC_OPEN);
  if (JSON.stringify(seen) !== JSON.stringify(['- **a**', '  · ตรวจ: id-a'])) {
    throw new Error(`expected only the first section's lines, got ${JSON.stringify(seen)}`);
  }
  if (seen.includes('- **b**')) throw new Error('the duplicate section was parsed after all');
});
test('fixture: validateHeadings rejects a missing managed heading and a fourth section', () => {
  expectRejected(validateHeadings(`## ${SEC_HANDOFF}\n## ${SEC_OPEN}\n`), /occurs 0 times/);
  expectRejected(validateHeadings('# t\n' + THREE_HEADINGS + '## บันทึกเพิ่มเติม\n'), /unexpected "## " heading/);
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
  // 2026-10-12: the shapes the earlier rounds still let through.
  ['bold with NO list marker "  **b**"', ['- **a**', '  · ตรวจ: id-a', '  **เตือนเรื่อง superadmin**']],
  ['bold with no marker, deeper indent', ['- **a**', '      **b**']],
  ['bold with no marker under a handoff item', [...GOOD_HANDOFF.split('\n'), '  **b**', '    · **ให้ทำอะไร:** x']],
  ['bold with no marker in the closed index', ['- **2026-10-12** — A', '  **2026-10-11** — B']],
  ['emoji + bold with no marker "  🔴 **b**"', ['- **a**', '  🔴 **b**']],
  ['"__b__" as the bold marker, with no list marker', ['- **a**', '  __b__']],
  ['"__b__" as the bold marker, after a list marker', ['- **a**', '  - __b__']],
  ['letter enumerator "- A. **b**"', ['- **a**', '  - A. **b**']],
  ['parenthesised enumerator "- (1) **b**"', ['- **a**', '  - (1) **b**']],
  ['roman enumerator "- iv) **b**"', ['- **a**', '  - iv) **b**']],
  ['enumerator with no list marker "  A. **b**"', ['- **a**', '  A. **b**']],
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
  // bold after an enumerator AND real words is still a sub-step: the enumerator alone is decoration
  expectClean(itemsOf(['- **a**', '  - A) ดูที่ **app.js**', '  1. (ก) ดู **x**', '  - 2. ตรวจ **log**']).problems);
  // the middle dot used for labels is not a list marker, and it is what makes `· **label:**` legal
  expectClean(itemsOf(['- **a**', '  · **ที่มา:** x']).problems);
  expectClean(itemsOf(GOOD_HANDOFF.split('\n')).problems);
  expectClean(itemsOf(GOOD_OPEN.split('\n')).problems);
  // an indented continuation that merely STARTS with punctuation or a backtick is not an item
  expectClean(itemsOf(['- **a**', '  `app.js` ถูกแก้แล้ว', '  (ดูรายละเอียดในสเปก)', '  — ท้ายบรรทัด']).problems);
});
test('fixture: itemsOf reports real file line numbers when it is told where the section starts', () => {
  // Finding 8: a red that says "section line 2" with no section name makes the reader count lines.
  expectRejected(itemsOf(['- ok', 'prose that is not indented'], 41).problems, /^line 42:/);
  expectRejected(itemsOf(['- ok', 'prose that is not indented']).problems, /^section line 2:/);
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
test('fixture: validateOpenItem rejects an item with NEITHER "· ตรวจ:" nor "· รอเจ้าของ:"', () => {
  // An item open for no stated reason: no check can settle it and nobody is named as holding it.
  expectRejected(validateOpenItem('- **x**\n  · detail only'), /ตรวจ/);
  expectRejected(validateOpenItem('- **x**\n  · detail only'), /รอเจ้าของ/);
});
test('fixture: validateOpenItem accepts an item whose only settling line is "· รอเจ้าของ:"', () => {
  // `cursor-rules-file` is this shape: the work is deliberately out of scope, so there is nothing
  // for a script to check and a check id would be red for work nobody wants done.
  expectClean(validateOpenItem(GOOD_OPEN_OWNER));
  // and the two line types may coexist, which is the `nas-password-scrubbed` shape
  expectClean(validateOpenItem(`${GOOD_OPEN}\n  · รอเจ้าของ: เปลี่ยนรหัสผ่านที่ DSM`));
});
test('fixture: validateOpenItem rejects a bare "· รอเจ้าของ:" with nothing after it', () => {
  // Same defect as a bare handoff label: a pointer with no payload.
  expectRejected(validateOpenItem('- **x**\n  · รอเจ้าของ:'), /says nothing about what is awaited/);
  expectRejected(validateOpenItem('- **x**\n  · รอเจ้าของ:   '), /says nothing about what is awaited/);
  expectRejected(validateOpenItem('- **x**\n  · รอเจ้าของ: ·'), /says nothing about what is awaited/);
  // the id line being present does not excuse it: a malformed line of either type is a red
  expectRejected(validateOpenItem(`${GOOD_OPEN}\n  · รอเจ้าของ:`), /says nothing about what is awaited/);
});
test('fixture: validateOpenItem rejects either line type written at column one', () => {
  // itemsOf rejects such a line too, but a block handed straight to this validator never met it.
  expectRejected(validateOpenItem('- **x**\n· รอเจ้าของ: เจ้าของต้องเปลี่ยนรหัส'), /รอเจ้าของ:" must be an indented/);
  expectRejected(validateOpenItem('- **x**\n· ตรวจ: id-a'), /ตรวจ:" must be an indented/);
  // and the same line indented is accepted, so the fixture isolates the indentation rule
  expectClean(validateOpenItem('- **x**\n  · รอเจ้าของ: เจ้าของต้องเปลี่ยนรหัส'));
});
test('fixture: itemsOf also rejects a column-one "· รอเจ้าของ:" line as no continuation at all', () => {
  expectRejected(itemsOf(['- **x**', '  · ตรวจ: id-a', '· รอเจ้าของ: x']).problems, /not indented/);
});
test('fixture: validateOpenItem rejects an item carrying two "· รอเจ้าของ:" lines', () => {
  // Two answers to "what is the owner holding" is the same ambiguity as two check ids.
  expectRejected(validateOpenItem('- **x**\n  · รอเจ้าของ: เปลี่ยนรหัส\n  · รอเจ้าของ: ตัดสินขอบเขต'), /exactly one/);
  expectRejected(validateOpenItem(`${GOOD_OPEN}\n  · รอเจ้าของ: ก\n  · รอเจ้าของ: ข`), /"· รอเจ้าของ:" lines/);
  // "รอเจ้าของ" prose with no colon is not the label, so it does not count as a second line
  expectClean(validateOpenItem(`${GOOD_OPEN_OWNER}\n  · ข้อนี้รอเจ้าของ ตัดสิน 2026-10-12`));
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
test('fixture: validateOpenItem rejects an id that is a lone dash or dashes in the wrong places', () => {
  // `[a-z0-9-]+` admitted a bare `-`, which names no check at all.
  for (const id of ['-', '--', '-a', 'a-', 'a--b', '-a-']) {
    expectRejected(validateOpenItem(`- **x**\n  · ตรวจ: ${id}`), /ตรวจ/);
  }
  for (const id of ['a', 'id2', 'nas-password-scrubbed', 'superadmin-dryrun-pass-reasons', 'a1-b2-c3']) {
    expectClean(validateOpenItem(`- **x**\n  · ตรวจ: ${id}`));
  }
});
test('fixture: validateOpenItem rejects an item carrying two check ids', () => {
  // Two ids and no rule for which one owns the item; the second used to be free.
  expectRejected(validateOpenItem('- **x**\n  · ตรวจ: id-a\n  · ตรวจ: id-b'), /exactly one/);
  // a well-formed id plus a malformed second line is still two
  expectRejected(validateOpenItem('- **x**\n  · ตรวจ: id-a\n  · ตรวจ: -'), /exactly one/);
  // "ตรวจ <date>" lines (no colon) are the last-checked note, not a check id, so they do not count
  expectClean(validateOpenItem('- **x**\n  · ตรวจ 2026-10-12 / grep\n  · ตรวจ: id-a'));
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
  // Rejected because it is EMPTY. It used to be reported as "is a label", which it is not.
  expectRejected(validateHandoffItem(GOOD_HANDOFF.replace('**ทำแผนที่ 2 ต่อ**', '** **')), /bold subject is empty/);
});

// --- the three rules parseStatus enforces (re-review of a9403d3) -----------------------------------
// Each fixture below was ACCEPTED by this test before the rules existed and makes
// scripts/lib/backlog-status.js throw, which turns `npm run backlog` into "HANDOFF -- NOT READ" /
// "OPEN -- NOT READ" and `npm run check` red through backlog-registry. A guard that is looser than
// the reader it governs lets someone edit STATUS.md, see this file green, and lose the report.
test('fixture: validateHandoffItem rejects text after the bold subject on the head line', () => {
  const dated = GOOD_HANDOFF.replace('**ทำแผนที่ 2 ต่อ**', '**ทำแผนที่ 2 ต่อ** (2026-10-13)');
  expectRejected(validateHandoffItem(dated), /^line 1 of the item: text after the bold subject on the head line/);
  expectRejected(validateHandoffItem(dated, 31), /^line 31: text after the bold subject/);
  // the text may sit between the subject and the first label of the same line too
  const sameLine = '- **หัวข้อ** ดูข้างล่าง **ให้ทำอะไร:** ทำข้อ 4\n  · **ที่มา:** เจ้าของสั่ง\n  · **หลักฐาน:** git log';
  expectRejected(validateHandoffItem(sameLine), /text after the bold subject/);
  // bare punctuation is not text (the same test the field contents use)
  expectClean(validateHandoffItem(GOOD_HANDOFF.replace('**ทำแผนที่ 2 ต่อ**', '**ทำแผนที่ 2 ต่อ** ·')));
});
test('fixture: validateHandoffItem rejects text before the first field label on a continuation line', () => {
  const lead = [
    '- **หัวข้อ**',
    '  · อธิบายก่อนว่าทำไม',
    '  · **ให้ทำอะไร:** ทำข้อ 4',
    '  · **ที่มา:** เจ้าของสั่ง',
    '  · **หลักฐาน:** git log',
  ].join('\n');
  expectRejected(validateHandoffItem(lead), /^line 2 of the item: text before the item's first field label/);
  expectRejected(validateHandoffItem(lead, 40), /^line 41: text before the item's first field label/);
  // on the label's own line, before the label
  const sameLine = GOOD_HANDOFF.replace('  · **ให้ทำอะไร:**', '  · อธิบายก่อน **ให้ทำอะไร:**');
  expectRejected(validateHandoffItem(sameLine), /text before the item's first field label/);
  // after the first label, free text belongs to that field and is fine
  expectClean(validateHandoffItem(GOOD_HANDOFF.replace('git log --oneline', 'git log --oneline\n    ต่อบรรทัดที่สอง')));
});
test('fixture: validateUniqueCheckIds rejects a second open item that reuses an id, naming both lines', () => {
  const a = '- **a**\n  · ตรวจ: id-one';
  const b = '- **b**\n  · ตรวจ: id-two';
  const c = '- **c**\n  · รอเจ้าของ: อะไรบางอย่าง\n  · ตรวจ: id-one';
  expectClean(validateUniqueCheckIds([a, b], [10, 14]));
  expectClean(validateUniqueCheckIds([a, '- **d**\n  · รอเจ้าของ: x', '- **e**\n  · รอเจ้าของ: x'], [10, 14, 16]));
  expectRejected(validateUniqueCheckIds([a, b, c], [10, 14, 18]), /^line 18: check id "id-one" is already used by the item at line 10/);
  expectRejected(validateUniqueCheckIds([a, b, c]), /^open item 3: check id "id-one" is already used by the item at open item 1/);
});

// The three fixtures as whole documents: parseStatus must refuse each AND this file's validators must
// refuse it first. Fails if either side drifts (a validator loosened, or parseStatus gaining a rule
// that nothing here knows about for these shapes).
const { parseStatus } = require('../scripts/lib/backlog-status');
function documentProblems(text) {
  const problems = [];
  for (const t of [SEC_HANDOFF, SEC_OPEN]) {
    const lines = sectionLines(text, t);
    const r = itemsOf(lines, sectionFirstLine(text, t));
    problems.push(...r.problems);
    if (t === SEC_HANDOFF) r.blocks.forEach((b, n) => problems.push(...validateHandoffItem(b, r.starts[n])));
    else {
      r.blocks.forEach(b => problems.push(...validateOpenItem(b)));
      problems.push(...validateUniqueCheckIds(r.blocks, r.starts));
    }
  }
  return problems;
}
const docOf = (handoff, open) => `## ${SEC_HANDOFF}\n\n${handoff}\n\n## ${SEC_OPEN}\n\n${open}\n\n## ${SEC_CLOSED}\n`;
const REFUSED_BY_PARSER = [
  ['text after the bold subject', docOf(GOOD_HANDOFF.replace('**ทำแผนที่ 2 ต่อ**', '**ทำแผนที่ 2 ต่อ** (2026-10-13)'), GOOD_OPEN), /after the bold subject/],
  ['text before the first label', docOf(GOOD_HANDOFF.replace('  · **ให้ทำอะไร:**', '  · อธิบายก่อน\n  · **ให้ทำอะไร:**'), GOOD_OPEN), /before the item's first field label/],
  ['a check id used by two open items', docOf(GOOD_HANDOFF, GOOD_OPEN + '\n' + GOOD_OPEN.replace('ข้อความโหมดซ้อม', 'ข้อความที่สอง')), /already used by the item at line/],
];
test('fixture: the well-formed document is accepted by the validators and by parseStatus', () => {
  const ok = docOf(GOOD_HANDOFF, GOOD_OPEN);
  expectClean(documentProblems(ok));
  parseStatus(ok);
});
for (const [name, doc, reason] of REFUSED_BY_PARSER) {
  test(`fixture: ${name} is refused by parseStatus and by the validators, with the line named`, () => {
    let threw = null;
    try { parseStatus(doc); } catch (e) { threw = e; }
    if (!threw) throw new Error('parseStatus accepted it, so this fixture no longer shows a parse rule');
    const problems = documentProblems(doc);
    expectRejected(problems, reason);
    if (!problems.some(p => /^line \d+:/.test(p))) throw new Error('no problem names a file line: ' + problems.join(' | '));
  });
}

// --- validateHandoffRubric --------------------------------------------------------------------
test('fixture: validateHandoffRubric accepts exactly the standing rubric, items and blanks aside', () => {
  expectClean(validateHandoffRubric([...HANDOFF_RUBRIC, '', ...GOOD_HANDOFF.split('\n')]));
  expectClean(validateHandoffRubric(HANDOFF_RUBRIC));
});
test('fixture: validateHandoffRubric rejects a handoff written only as blockquote prose', () => {
  const note = '> รอบหน้าเตือนเรื่อง superadmin';
  // The hole: itemsOf accepts this line and produces NO item, so every item-level handoff
  // assertion passes with nothing inspected. Only the rubric check can see it.
  const r = itemsOf([note]);
  expectClean(r.problems);
  if (r.blocks.length !== 0) throw new Error('expected a blockquote-only section to have no items');
  expectRejected(validateHandoffRubric([note]), /must be an ITEM/);
  expectRejected(validateHandoffRubric([...HANDOFF_RUBRIC, '', note]), /must be an ITEM/);
  expectRejected(validateHandoffRubric([note, '', ...HANDOFF_RUBRIC]), /must be an ITEM/);
});
test('fixture: validateHandoffRubric rejects a rubric that is edited, trimmed or reordered', () => {
  expectRejected(validateHandoffRubric([]), /must be an ITEM/);
  expectRejected(validateHandoffRubric(HANDOFF_RUBRIC.slice(1)), /must be an ITEM/);
  expectRejected(validateHandoffRubric(HANDOFF_RUBRIC.map(l => `${l} `)), /must be an ITEM/);
  expectRejected(validateHandoffRubric([...HANDOFF_RUBRIC].reverse()), /must be an ITEM/);
  // the message has to tell the reader both ways out, or a red here gets "fixed" by deleting the rule
  expectRejected(validateHandoffRubric([]), /update HANDOFF_RUBRIC/);
});

// --- validateIndexItem ------------------------------------------------------------------------
// One closed-work file in miniature: a section whose topics are column-one bullets, a section whose
// topics are `###` sub-headings, and a bullet that sits above every `## ` heading.
const CLOSED_SAMPLE = [
  '# STATUS_CLOSED — รายละเอียด',
  '- **บูลเล็ตที่อยู่เหนือหัวข้อทุกอัน**',
  '',
  '## ปิดไปแล้ว 2026-10-12 — อย่าเสนอซ้ำ',
  '- **ไทล์สถิติ dashboard — กฎสำหรับแท็บเล็ตตาย**',
  '  · บรรทัดย่อย ไม่ใช่ชื่อเรื่อง',
  '- **`session_start.ps1` รอบสอง — ยามรอบแรกใช้ไม่ได้จริง**',
  '',
  '## กฎพิกัด — ตรวจบางส่วน (2026-10-11)',
  '### ✅ กฎ "ต้องมีพิกัด" — ตรวจแล้วผ่าน',
  '- ไม่ใช่บูลเล็ตตัวหนา',
].join('\n');

test('fixture: closedTargets collects headings and bullet titles, each with its "## " section', () => {
  const t = closedTargets(CLOSED_SAMPLE);
  const got = t.map(x => `${x.title} @ ${x.section}`);
  const want = [
    'บูลเล็ตที่อยู่เหนือหัวข้อทุกอัน @ null',
    '## ปิดไปแล้ว 2026-10-12 — อย่าเสนอซ้ำ @ ## ปิดไปแล้ว 2026-10-12 — อย่าเสนอซ้ำ',
    'ไทล์สถิติ dashboard — กฎสำหรับแท็บเล็ตตาย @ ## ปิดไปแล้ว 2026-10-12 — อย่าเสนอซ้ำ',
    '`session_start.ps1` รอบสอง — ยามรอบแรกใช้ไม่ได้จริง @ ## ปิดไปแล้ว 2026-10-12 — อย่าเสนอซ้ำ',
    '## กฎพิกัด — ตรวจบางส่วน (2026-10-11) @ ## กฎพิกัด — ตรวจบางส่วน (2026-10-11)',
    '### ✅ กฎ "ต้องมีพิกัด" — ตรวจแล้วผ่าน @ ## กฎพิกัด — ตรวจบางส่วน (2026-10-11)',
  ];
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    throw new Error(`targets differ:\n       got  ${got.join('\n       got  ')}`);
  }
});
test('fixture: validateIndexItem accepts a line whose title is a real heading', () => {
  const targets = closedTargets('# t\n## ปิดไปแล้ว 2026-10-12 — อย่าเสนอซ้ำ\n### 2026-10-12 — ไทล์สถิติ — กฎแท็บเล็ต\n');
  expectClean(validateIndexItem('- **2026-10-12** — ไทล์สถิติ', targets));
});
test('fixture: validateIndexItem accepts a title taken from a column-one "- **…**" bullet', () => {
  // The point of the 2026-10-12 widening: the topic is a bullet, not a heading, and the index line
  // names the topic instead of repeating the date. A heading-only rule rejected exactly this.
  const targets = closedTargets(CLOSED_SAMPLE);
  expectClean(validateIndexItem('- **2026-10-12** — ไทล์สถิติ dashboard', targets));
  // an underscore in the title is why the bullet body is not matched as `[^*_]+`
  expectClean(validateIndexItem('- **2026-10-12** — `session_start.ps1` รอบสอง', targets));
  // a sub-line under a bullet is not a title, and neither is a bullet with no bold
  expectRejected(validateIndexItem('- **2026-10-12** — บรรทัดย่อย ไม่ใช่ชื่อเรื่อง', targets), /no heading and no/);
  expectRejected(validateIndexItem('- **2026-10-11** — ไม่ใช่บูลเล็ตตัวหนา', targets), /no heading and no/);
});
test('fixture: validateIndexItem rejects a malformed line, an empty title and a title that names nothing', () => {
  const targets = closedTargets(CLOSED_SAMPLE);
  expectRejected(validateIndexItem('- 2026-10-12 ไทล์สถิติ dashboard', targets), /is not "- \*\*YYYY-MM-DD\*\*/);
  expectRejected(validateIndexItem('- **2026-10-12** — งานที่ไม่มีอยู่ในไฟล์ปิดแล้ว', targets), /no heading and no/);
  expectRejected(validateIndexItem('- **2026-10-12** — ไทล์สถิติ dashboard', []), /no heading and no/);
  // an empty title is a substring of every target, so it would otherwise match all of them
  expectRejected(validateIndexItem('- **2026-10-12** —  ', targets), /no title after the em dash/);
});
test('fixture: validateIndexItem rejects a date the section it points into does not carry', () => {
  // The date was captured and discarded, so an index line could date the work to any day at all.
  const targets = closedTargets(CLOSED_SAMPLE);
  expectRejected(validateIndexItem('- **1999-01-01** — ปิดไปแล้ว 2026-10-12 — อย่าเสนอซ้ำ', targets), /does not carry its date 1999-01-01/);
  expectRejected(validateIndexItem('- **2026-10-11** — ไทล์สถิติ dashboard', targets), /does not carry its date 2026-10-11/);
  expectClean(validateIndexItem('- **2026-10-12** — ไทล์สถิติ dashboard', targets));
  // a bullet carries no date of its own: the "## " heading above it is what files it under a day,
  // so a bullet that sits above every heading can be filed under none
  expectRejected(validateIndexItem('- **2026-10-12** — บูลเล็ตที่อยู่เหนือหัวข้อทุกอัน', targets), /does not carry its date/);
  // the date may sit anywhere in the section heading, including in brackets at the end
  expectClean(validateIndexItem('- **2026-10-11** — กฎ "ต้องมีพิกัด" — ตรวจแล้วผ่าน', targets));
  expectClean(validateIndexItem('- **2026-10-11** — กฎพิกัด — ตรวจบางส่วน', targets));
});

// --- validateClosedCoverage -------------------------------------------------------------------
test('fixture: validateClosedCoverage accepts a closed file whose every "## " section is indexed', () => {
  const closed = '# title\n\n## ปิดไปแล้ว 2026-10-12 — อย่าเสนอซ้ำ\n### ✅ a detail heading\n- x\n';
  expectClean(validateClosedCoverage(['- **2026-10-12** — ปิดไปแล้ว 2026-10-12 — อย่าเสนอซ้ำ'], closed));
});
test('fixture: validateClosedCoverage accepts a section named only through one of its bullets', () => {
  // The companion of the widened title rule: a section whose topics are bullets is covered by
  // naming a topic. Demanding the heading text as well would make the two rules contradict -- the
  // index would have to carry a topic-free line next to every topic line to stay green.
  expectClean(validateClosedCoverage([
    '- **2026-10-12** — ไทล์สถิติ dashboard',
    '- **2026-10-11** — กฎ "ต้องมีพิกัด" — ตรวจแล้วผ่าน',
  ], CLOSED_SAMPLE));
  // one of the two sections named, the other not, is still a red
  expectRejected(validateClosedCoverage(['- **2026-10-12** — ไทล์สถิติ dashboard'], CLOSED_SAMPLE), /กฎพิกัด/);
  // a bullet that sits under NO "## " heading covers nothing
  expectRejected(validateClosedCoverage(['- **2026-10-12** — บูลเล็ตที่อยู่เหนือหัวข้อทุกอัน'], CLOSED_SAMPLE), /ปิดไปแล้ว 2026-10-12/);
  // and naming a topic of one section does not cover a different section
  const twoSections = `${CLOSED_SAMPLE}\n\n## ปิดไปแล้ว 2026-10-13 — อย่าเสนอซ้ำ\n- **งานของวันที่ 13**\n`;
  expectRejected(validateClosedCoverage([
    '- **2026-10-12** — ไทล์สถิติ dashboard',
    '- **2026-10-11** — กฎพิกัด — ตรวจบางส่วน',
  ], twoSections), /2026-10-13/);
});
test('fixture: validateClosedCoverage rejects a "## " section that no index line points at', () => {
  // Appending a section with no index line leaves STATUS.md silent about it, so the work can be
  // proposed again -- the one failure the index exists to prevent.
  const closed = '# title\n## ปิดไปแล้ว 2026-10-12 — อย่าเสนอซ้ำ\n## ปิดไปแล้ว 2026-10-13 — อย่าเสนอซ้ำ\n';
  const index = ['- **2026-10-12** — ปิดไปแล้ว 2026-10-12 — อย่าเสนอซ้ำ'];
  expectRejected(validateClosedCoverage(index, closed), /2026-10-13/);
  expectClean(validateClosedCoverage([...index, '- **2026-10-13** — ปิดไปแล้ว 2026-10-13 — อย่าเสนอซ้ำ'], closed));
  // an empty index leaves every section uncovered; a malformed index line covers nothing
  expectRejected(validateClosedCoverage([], closed), /no line in the closed index/);
  expectRejected(validateClosedCoverage(['- 2026-10-12 ปิดไปแล้ว 2026-10-12 — อย่าเสนอซ้ำ'], closed), /no line in the closed index/);
});

// ---------------------------------------------------------------------------------------------
// 3. The real files (all green; a red here means STATUS.md drifted from the shape above)
// ---------------------------------------------------------------------------------------------

function realStatus() { return fs.readFileSync(STATUS_PATH, 'utf8'); }

// Managed-section items for the real file; throws if the section's lines have an unrecognised shape.
// Problems name their section and their real file line, so a red can be acted on without counting.
function realItemsAt(title) {
  const text = realStatus();
  const lines = sectionLines(text, title);
  if (lines === null) return { blocks: [], starts: [] };
  const r = itemsOf(lines, sectionFirstLine(text, title));
  expectClean(r.problems.map(p => `## ${title}: ${p}`));
  return r;
}
function realItems(title) { return realItemsAt(title).blocks; }

test('STATUS.md stays small enough to read in one pass', () => {
  expectClean(checkSize(realStatus()));
});

test('the three required sections are present', () => {
  const text = realStatus();
  for (const t of MANAGED_SECTIONS) {
    if (sectionLines(text, t) === null) throw new Error(`missing section: ## ${t}`);
  }
});

test('each managed heading occurs exactly once and there is no fourth "## " section', () => {
  expectClean(validateHeadings(realStatus()));
});

test('every line in the three sections is a valid item or a continuation of one', () => {
  const text = realStatus();
  const problems = [];
  for (const t of MANAGED_SECTIONS) {
    const lines = sectionLines(text, t);
    if (lines !== null) {
      problems.push(...itemsOf(lines, sectionFirstLine(text, t)).problems.map(p => `## ${t}: ${p}`));
    }
  }
  expectClean(problems);
});

test('every open item names a check id, a "รอเจ้าของ" line, or both', () => {
  const open = realItems(SEC_OPEN);
  if (open.length === 0) throw new Error('no items under ## เปิดอยู่ -- the parser or the file is wrong');
  for (const block of open) expectClean(validateOpenItem(block));
});

test('no two open items share a check id', () => {
  const r = realItemsAt(SEC_OPEN);
  expectClean(validateUniqueCheckIds(r.blocks, r.starts).map(p => `## ${SEC_OPEN}: ${p}`));
});

test('every handoff item carries an action, a source and evidence, and no text outside its fields', () => {
  const r = realItemsAt(SEC_HANDOFF);
  r.blocks.forEach((block, n) => expectClean(validateHandoffItem(block, r.starts[n])));
});

test('the handoff section holds the standing rubric and no other "> " prose', () => {
  const lines = sectionLines(realStatus(), SEC_HANDOFF);
  if (lines === null) throw new Error(`missing section: ## ${SEC_HANDOFF}`);
  expectClean(validateHandoffRubric(lines));
});

test('every closed-index line names a real heading or bullet title and sits under its date', () => {
  const index = realItems(SEC_CLOSED);
  if (index.length === 0) throw new Error('the closed index is empty -- "do not propose this again" has no teeth');
  const targets = closedTargets(fs.readFileSync(CLOSED_PATH, 'utf8'));
  if (targets.length === 0) throw new Error('docs/STATUS_CLOSED.md has no heading and no bullet title -- the parser or the file is wrong');
  for (const block of index) expectClean(validateIndexItem(block, targets));
});

test('every "## " section of docs/STATUS_CLOSED.md is named by a closed-index line', () => {
  const closed = fs.readFileSync(CLOSED_PATH, 'utf8');
  if (topHeadings(closed).length === 0) throw new Error('docs/STATUS_CLOSED.md has no "## " section -- the parser or the file is wrong');
  expectClean(validateClosedCoverage(realItems(SEC_CLOSED), closed));
});

console.log(`status-structure: ${passed} passed, ${failed} failed`);
