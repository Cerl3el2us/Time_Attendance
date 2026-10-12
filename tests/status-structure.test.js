// STATUS.md is the one file that tells the other machine what is still open, so its shape is
// load-bearing. Two failures made this test necessary.
//
// 2026-10-12: the file had grown to 498 lines / 80 KB, which is past the size a session can read
// in one pass -- so every session paid two round trips before it could say what was open. 81% of
// those lines were details of work already closed.
//
// The other failure cost more. A handoff note that said only "next session, remind me about
// superadmin" reached the other machine intact, but the knowledge of what to remind about and what
// to do did not travel with it, so that machine could not act on it. A pointer with no payload.
// This test refuses the shape that allowed it: every handoff item must carry an action, a source
// and evidence.
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const STATUS_PATH = path.join(ROOT, 'STATUS.md');
const CLOSED_PATH = path.join(ROOT, 'docs', 'STATUS_CLOSED.md');

const STATUS = fs.readFileSync(STATUS_PATH, 'utf8');
const LINES = STATUS.split(/\r?\n/);

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok ', name); }
  catch (e) { process.exitCode = 1; console.log('  FAIL', name, '\n      ', e.message); }
}

// Lines belonging to one `## ` section, excluding the heading itself.
function section(title) {
  const start = LINES.findIndex(l => l.trim() === `## ${title}`);
  if (start === -1) return null;
  const rest = LINES.slice(start + 1);
  const end = rest.findIndex(l => /^## /.test(l));
  return end === -1 ? rest : rest.slice(0, end);
}

// An item starts at a `- ` in column one and owns every line until the next one.
function items(lines) {
  const blocks = [];
  for (const l of lines) {
    if (/^- /.test(l)) blocks.push([l]);
    else if (blocks.length) blocks[blocks.length - 1].push(l);
  }
  return blocks.map(b => b.join('\n'));
}

function firstLine(block) { return block.split('\n')[0]; }

test('STATUS.md stays small enough to read in one pass', () => {
  const bytes = Buffer.byteLength(STATUS, 'utf8');
  if (LINES.length > 150) throw new Error(`${LINES.length} lines, limit is 150`);
  if (bytes > 20480) throw new Error(`${bytes} bytes, limit is 20480`);
});

test('the three required sections are present', () => {
  for (const t of ['ส่งต่อรอบหน้า', 'เปิดอยู่', 'ปิดแล้ว (สารบัญ)']) {
    if (section(t) === null) throw new Error(`missing section: ## ${t}`);
  }
});

test('every open item names a check id', () => {
  const open = items(section('เปิดอยู่') || []);
  if (open.length === 0) throw new Error('no items under ## เปิดอยู่ -- the parser or the file is wrong');
  for (const block of open) {
    const m = block.match(/^\s*·\s*ตรวจ:\s*([a-z0-9-]+)\s*$/m);
    if (!m) throw new Error(`no "· ตรวจ: <id>" line in: ${firstLine(block).slice(0, 70)}`);
  }
});

test('every handoff item carries an action, a source and evidence', () => {
  const handoff = items(section('ส่งต่อรอบหน้า') || []);
  for (const block of handoff) {
    const head = firstLine(block);
    if (!/^- \*\*.+\*\*/.test(head)) {
      throw new Error(`handoff item has no bold subject: ${head.slice(0, 70)}`);
    }
    for (const label of ['**ให้ทำอะไร:**', '**ที่มา:**', '**หลักฐาน:**']) {
      if (!block.includes(label)) {
        throw new Error(`handoff item is missing ${label}: ${head.slice(0, 70)}`);
      }
    }
  }
});

test('every closed-index line points at a heading that exists', () => {
  const index = items(section('ปิดแล้ว (สารบัญ)') || []);
  if (index.length === 0) throw new Error('the closed index is empty -- "do not propose this again" has no teeth');
  const closed = fs.readFileSync(CLOSED_PATH, 'utf8');
  const headings = closed.split(/\r?\n/).filter(l => /^#{2,4} /.test(l));
  for (const block of index) {
    const m = firstLine(block).match(/^- \*\*(\d{4}-\d{2}-\d{2})\*\* — (.+)$/);
    if (!m) throw new Error(`index line is not "- **YYYY-MM-DD** — <title>": ${firstLine(block).slice(0, 70)}`);
    const title = m[2].trim();
    if (!headings.some(h => h.includes(title))) {
      throw new Error(`no heading in docs/STATUS_CLOSED.md contains: ${title}`);
    }
  }
});

console.log(`status-structure: ${passed} passed`);
