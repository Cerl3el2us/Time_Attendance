// Reading STATUS.md for `npm run backlog` (2026-10-12).
//
// `npm run backlog` answers "what is still open?" by re-checking every open item against the real
// code and printing evidence. This module is the first half of that: it turns STATUS.md into data
// and nothing else. It decides no verdicts.
//
// It does NOT validate the file's format. tests/status-structure.test.js already enforces that
// (sections, indentation, one id per item, handoff fields), and repeating it here would give the
// project two copies of the rules to keep in step. This module assumes the format held and only
// extracts. But "assumes" is not "ignores": when it meets something it cannot read it throws, with
// the line number in the message, rather than returning a shorter list. A reader that silently
// drops an item it could not understand would make the backlog look emptier than it is, which is
// the one thing a command built to stop forgotten work must never do.
//
// Output shape (`line` is the real 1-indexed line of the item's `- **subject**` line, so a caller
// can print `STATUS.md:<line>` as evidence):
//   {
//     handoff: [{ subject, line, fields: { action, source, evidence } }],
//     open:    [{ subject, line, checkId | null, waitingOwner | null }],
//   }
//
// Only the two sections below are read. Everything above the first `## ` heading is header prose
// that quotes the marker syntax (`· ตรวจ: <ไอดี>`), and the closed index is history -- reading
// either as items would invent ids that do not exist.
'use strict';

const SEC_HANDOFF = 'ส่งต่อรอบหน้า';
const SEC_OPEN = 'เปิดอยู่';

// Same labels, same order as HANDOFF_LABELS in tests/status-structure.test.js.
const HANDOFF_FIELDS = [
  ['action', '**ให้ทำอะไร:**'],
  ['source', '**ที่มา:**'],
  ['evidence', '**หลักฐาน:**'],
];

// `· ตรวจ: <id>` and `· รอเจ้าของ: <text>` are continuation lines of an open item, not part of its
// `- **subject**` line. The "any label" patterns exist so that a malformed marker line is found and
// reported instead of being skipped because it failed the strict pattern.
const CHECK_ANY = /^[ \t]*·[ \t]*ตรวจ:/;
const CHECK_ID = /^[ \t]+·[ \t]*ตรวจ:[ \t]*([a-z0-9]+(?:-[a-z0-9]+)*)[ \t]*$/;
const OWNER_ANY = /^[ \t]*·[ \t]*รอเจ้าของ:/;
const OWNER_TEXT = /^[ \t]+·[ \t]*รอเจ้าของ:(.*)$/;
const HAS_CONTENT = /[\p{L}\p{N}]/u;

function snip(s) { return String(s).replace(/\s+/g, ' ').trim().slice(0, 70); }

// What follows `label` on one line, up to the next handoff label, with the separators trimmed off.
function fieldText(line, label) {
  const at = line.indexOf(label);
  if (at === -1) return null;
  let rest = line.slice(at + label.length);
  for (const [, other] of HANDOFF_FIELDS) {
    const cut = rest.indexOf(other);
    if (cut !== -1) rest = rest.slice(0, cut);
  }
  return HAS_CONTENT.test(rest) ? rest.replace(/^[\s·]+|[\s·]+$/g, '') : null;
}

// One item: `head` is { text, no } for the `- ` line, `cont` the continuation lines as { text, no }.
function readHandoff(head, cont) {
  const m = head.text.match(/^- +\*\*(.+?)\*\*/);
  if (!m) throw new Error(`STATUS.md:${head.no}: handoff item has no bold subject: ${snip(head.text)}`);
  const all = [head, ...cont];
  const fields = {};
  for (const [key, label] of HANDOFF_FIELDS) {
    const hit = all.map(l => fieldText(l.text, label)).find(t => t !== null);
    if (hit === undefined) {
      throw new Error(`STATUS.md:${head.no}: handoff item has no content after ${label}: ${snip(head.text)}`);
    }
    fields[key] = hit;
  }
  return { subject: m[1].trim(), line: head.no, fields };
}

function readOpen(head, cont) {
  // tests/status-structure.test.js does not require a bold subject on an open item, so a plain one
  // is read as-is rather than turned into a crash the structure test would not have predicted.
  const m = head.text.match(/^- +\*\*(.+?)\*\*/);
  const subject = m ? m[1].trim() : head.text.replace(/^- +/, '').trim();
  let checkId = null;
  let waitingOwner = null;
  for (const l of cont) {
    if (CHECK_ANY.test(l.text)) {
      const id = l.text.match(CHECK_ID);
      if (!id) throw new Error(`STATUS.md:${l.no}: "· ตรวจ:" does not name a single lower-case id: ${snip(l.text)}`);
      if (checkId !== null) throw new Error(`STATUS.md:${l.no}: a second "· ตรวจ:" line in the item at line ${head.no}`);
      checkId = id[1];
    } else if (OWNER_ANY.test(l.text)) {
      const own = l.text.match(OWNER_TEXT);
      if (!own || !HAS_CONTENT.test(own[1])) {
        throw new Error(`STATUS.md:${l.no}: "· รอเจ้าของ:" says nothing about what is awaited: ${snip(l.text)}`);
      }
      if (waitingOwner !== null) throw new Error(`STATUS.md:${l.no}: a second "· รอเจ้าของ:" line in the item at line ${head.no}`);
      waitingOwner = own[1].trim();
    }
  }
  return { subject, line: head.no, checkId, waitingOwner };
}

function parseStatus(text) {
  if (typeof text !== 'string') throw new TypeError('parseStatus needs the text of STATUS.md');
  const handoff = [];
  const open = [];
  let section = null;     // title of the current column-one `## ` section
  let current = null;     // { head, cont } of the item being collected

  const flush = () => {
    if (!current) return;
    if (section === SEC_HANDOFF) handoff.push(readHandoff(current.head, current.cont));
    else if (section === SEC_OPEN) open.push(readOpen(current.head, current.cont));
    current = null;
  };

  // A trailing newline yields one empty last element, which is skipped as a blank line below.
  text.split(/\r?\n/).forEach((raw, i) => {
    const no = i + 1;
    if (/^## /.test(raw)) {
      flush();
      section = raw.slice(3).trim();
      return;
    }
    const managed = section === SEC_HANDOFF || section === SEC_OPEN;
    if (!managed || raw.trim() === '') return;
    if (/^- +\S/.test(raw)) {
      flush();
      current = { head: { text: raw, no }, cont: [] };
      return;
    }
    // Blockquote lines are the section's standing explanation, not part of any item.
    if (/^\s*>/.test(raw)) return;
    // Anything else must be an indented continuation of an item. A column-one line, or an indented
    // one with no item above it, would have been skipped here without a word -- and if it was a
    // `· ตรวจ:` line, its item would then look like it had no check.
    if (!/^\s/.test(raw) || !current) {
      throw new Error(`STATUS.md:${no}: line under "## ${section}" is neither an item, a continuation nor a "> " line: ${snip(raw)}`);
    }
    current.cont.push({ text: raw, no });
  });
  flush();
  return { handoff, open };
}

module.exports = { parseStatus };
