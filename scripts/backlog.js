#!/usr/bin/env node
// `npm run backlog` -- "what is still open?", answered by re-checking, not by remembering (2026-10-13).
//
// Spec: docs/superpowers/specs/2026-10-12-faster-startup-and-cross-machine-state-design.md sections
// 7-8. The owner approved a per-item "recorded vs real" table on 2026-10-13; scripts/status.js (header
// comment) explains why that was refused before and the four guardrails that make it safe now.
//
// THIS FILE IS A PRINTER. It calls three libraries and lays out what they return:
//   scripts/lib/backlog-status.js   STATUS.md -> items
//   scripts/lib/backlog-checks.js   one check per item -> { verdict, evidence }
//   scripts/lib/sync-health.js      how far the answer can be trusted -> { lines, unmeasured, elapsedMs }
// It does not decide a verdict, does not decide WAITING-OWNER (the registry already did, for every
// check at once), and takes no measurement of its own except the one the header needs (branch and
// head of this checkout, one git call) and its own elapsed time. Anything it cannot read becomes a "NOT MEASURED"
// entry; it is never skipped, because a backlog that silently shrinks is the one failure this command
// exists to prevent.
//
// The layout rules, each of which has a case in tests/backlog-print.test.js:
//   * Items print FAIL, NOT-VERIFIED, WAITING-OWNER, PASS, in that order (STATUS.md order within one
//     verdict). The eye must land on what needs doing.
//   * A PASS item is ONE line, so a long list of green does not bury the rest. Every other verdict
//     prints its evidence in full, every line indented and none dropped: the NOT-VERIFIED evidence of
//     the sync check deliberately ends with the instruction that says what to do, and a clipped
//     evidence block would destroy exactly that line. A PASS line also keeps ALL of its evidence --
//     the lines are joined onto the one line, never cut.
//   * "NOT MEASURED" is loud when it has content, and is an explicit "none" line when it does not.
//     Nothing printed here ever says "all clear": a report that cannot see the other machine, or the
//     NAS, must not read as a clean bill of health.
//   * The time is printed as a number: sync health's own milliseconds and this process's total. The
//     budget is 5 s (BUDGET_MS); when a run is over it, the report says OVER BUDGET instead of moving
//     the line.
//   * The commands the owner can run are listed at the end ("I cannot remember it and I do not know
//     which one to run", 2026-10-02), and `npm run status` lists this one in return.
//
// Output is English on purpose: this runs in a plain Windows console where Thai prints as `?`. The
// exception is text that arrives from the owner's own files -- the Thai subjects of STATUS.md items
// and the owner's wait text inside a WAITING-OWNER evidence line. Those are printed as they come;
// translating them is not this script's job, it is Claude's when it reports to the owner.
//
// The formatting is in pure functions that take the libraries' data as arguments and return arrays
// of lines, so tests/backlog-print.test.js can drive them with fixtures. Only main() touches the disk.
'use strict';
const fs = require('fs');
const path = require('path');

const BUDGET_MS = 5000;

// Worst first. An unknown verdict is never ranked: resolveItem() turns it into NOT-VERIFIED before
// it can reach the sorter.
const ORDER = ['FAIL', 'NOT-VERIFIED', 'WAITING-OWNER', 'PASS'];
const KNOWN = new Set(ORDER);

const errText = e => (e && e.message ? e.message : String(e));
const pad = (text, prefix) => String(text).split(/\r?\n/).map(l => prefix + l);

// ---------------------------------------------------------------------------------------------
// open items: run the registry, order, lay out
// ---------------------------------------------------------------------------------------------

// One open item -> { subject, line, id, verdict, evidence }. Every way the check could be missing or
// unusable becomes a NOT-VERIFIED with the reason; an item is never dropped and never defaulted to PASS.
function resolveItem(item, checks) {
  const base = { subject: item.subject, line: item.line, id: item.checkId };
  const missing = (verdict, evidence) => ({ ...base, verdict, evidence });

  if (item.checkId === null || item.checkId === undefined) {
    // No code check is named. STATUS.md's own owner-wait line is then the whole answer, and this is
    // not a verdict being re-derived: it is the text the owner wrote, shown under the verdict the
    // registry uses for it. The structure test guarantees an item has a check, an owner wait, or both.
    if (item.waitingOwner) {
      return missing('WAITING-OWNER', `STATUS.md:${item.line}: awaiting the owner: ${item.waitingOwner}\nno code check is named for this item in STATUS.md`);
    }
    return missing('NOT-VERIFIED', `STATUS.md:${item.line}: this item names no check and no owner wait, so nothing was checked`);
  }
  if (!checks || !Object.prototype.hasOwnProperty.call(checks, item.checkId)) {
    return missing('NOT-VERIFIED', `STATUS.md:${item.line} names the check "${item.checkId}", but the registry has no such check, so nothing was checked`);
  }

  let r;
  try { r = checks[item.checkId].run(); }
  catch (e) { return missing('NOT-VERIFIED', `check "${item.checkId}" threw: ${errText(e)}`); }
  if (!r || !KNOWN.has(r.verdict)) {
    return missing('NOT-VERIFIED', `check "${item.checkId}" returned no usable verdict: ${JSON.stringify(r && r.verdict)}`);
  }
  const evidence = typeof r.evidence === 'string' ? r.evidence : '';
  // The registry already turns a PASS without evidence into NOT-VERIFIED. This is the same promise
  // kept a second time at the last place it could still be broken: the line that would say PASS.
  if (r.verdict === 'PASS' && evidence.trim() === '') {
    return missing('NOT-VERIFIED', `check "${item.checkId}" said PASS but gave no evidence, so it is not shown as a PASS`);
  }
  return { ...base, verdict: r.verdict, evidence };
}

const resolveOpen = (open, checks) => open.map(item => resolveItem(item, checks));

// Stable: Array.prototype.sort is stable, and ties keep STATUS.md order.
const sortItems = items => [...items].sort((a, b) => ORDER.indexOf(a.verdict) - ORDER.indexOf(b.verdict));

function formatItem(it) {
  const head = `  [${it.verdict}] STATUS.md:${it.line}  ${it.subject}`;
  const ev = it.evidence === '' ? '(the check gave no evidence)' : it.evidence;
  if (it.verdict === 'PASS') {
    // ONE line, nothing lost: the evidence lines are joined, not cut.
    return [`${head}  <-  ${ev.split(/\r?\n/).map(s => s.trim()).filter(Boolean).join(' | ')}`];
  }
  return [head, ...pad(ev, '        ')];
}

function formatOpen(items) {
  const counts = ORDER.map(v => `${items.filter(i => i.verdict === v).length} ${v}`).join(', ');
  const out = [`OPEN -- ${items.length} item(s): ${counts}`];
  if (!items.length) out.push('  (STATUS.md lists no open item)');
  for (const it of sortItems(items)) out.push(...formatItem(it));
  return out;
}

// ---------------------------------------------------------------------------------------------
// handoff
// ---------------------------------------------------------------------------------------------

// The handoff items carry no verdict: they are the previous session's instructions to this one, in
// STATUS.md's words. Printed whole -- a handoff clipped to a pointer is the failure the four-field
// rule exists to stop.
function formatHandoff(handoff) {
  const out = [`HANDOFF -- ${handoff.length} item(s) left for this session (claims from STATUS.md, not checked by this command)`];
  if (!handoff.length) out.push('  (none)');
  for (const h of handoff) {
    out.push(`  STATUS.md:${h.line}  ${h.subject}`);
    for (const key of ['action', 'source', 'evidence']) {
      const [first, ...rest] = String(h.fields[key]).split(/\r?\n/);
      out.push(`      ${(key + ':').padEnd(9)} ${first}`, ...rest.map(l => '                ' + l));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// sync health
// ---------------------------------------------------------------------------------------------

// `lines` is already in display order (sync-health.js says so) and is printed as given. A line that
// starts "WARNING: " is a finding for a human and is marked; they are counted in the heading so the
// number is visible without reading every line.
function formatSyncHealth(sync) {
  const warnings = sync.lines.filter(l => l.startsWith('WARNING: ')).length;
  const out = [`SYNC HEALTH -- how far this answer can be trusted (measured in ${sync.elapsedMs} ms; ${warnings} warning(s))`];
  if (!sync.lines.length) out.push('  (sync health produced no lines; see NOT MEASURED)');
  for (const l of sync.lines) out.push(l.startsWith('WARNING: ') ? `  !! ${l}` : `     ${l}`);
  return out;
}

// ---------------------------------------------------------------------------------------------
// not measured
// ---------------------------------------------------------------------------------------------

function formatNotMeasured(entries) {
  if (!entries.length) {
    return ['NOT MEASURED -- none reported by sync health or by this printer (NOT-VERIFIED items above are separate: their check ran and could not decide)'];
  }
  const bar = '!'.repeat(78);
  return [
    bar,
    `NOT MEASURED -- ${entries.length} thing(s) could not be measured. THIS REPORT IS NOT AN ALL-CLEAR.`,
    bar,
    ...entries.flatMap(e => String(e).split(/\r?\n/).map((l, k) => (k === 0 ? '  - ' : '    ') + l)),
    bar,
  ];
}

// ---------------------------------------------------------------------------------------------
// header, timing, commands
// ---------------------------------------------------------------------------------------------

function formatHeader(where, unmeasuredCount) {
  const out = [
    '=== Time Attendance backlog ===',
    `Measured from: ${where.root}`,
    `  branch ${where.branch === null ? '(NOT measured)' : where.branch}, at ${where.head === null ? '(NOT measured)' : where.head}`,
    'OPEN verdicts come from the check registry (scripts/lib/backlog-checks.js), run just now; STATUS.md only says which check belongs to which item.',
  ];
  if (unmeasuredCount) out.push(`WARNING: ${unmeasuredCount} thing(s) could not be measured -- read NOT MEASURED below before trusting any of this.`);
  return out;
}

function formatTiming(totalMs, syncMs) {
  const s = (totalMs / 1000).toFixed(2);
  const sync = syncMs === null ? 'sync health did not report a time' : `sync health took ${syncMs} ms of it`;
  const over = totalMs > BUDGET_MS ? ` -- OVER BUDGET by ${((totalMs - BUDGET_MS) / 1000).toFixed(2)} s` : '';
  return [`Elapsed: ${s} s for this process (${sync}); budget ${BUDGET_MS / 1000} s${over}. \`npm run\` adds its own start-up on top.`];
}

function formatCommands() {
  return [
    'Commands (you only need to remember the first):',
    '  npm run backlog   this report: what is still open, re-checked against the code, with evidence',
    '  npm run status    facts about this checkout: branch, uncommitted work, latest commits, cache-buster',
    '  npm run check     lint + every test; must end "N/N test files passed"',
  ];
}

// ---------------------------------------------------------------------------------------------
// the whole report
// ---------------------------------------------------------------------------------------------

// data = {
//   where:    { root, branch|null, head|null },
//   handoff:  [...] | null            null = STATUS.md could not be read (reason is in `failures`)
//   items:    [...] | null            resolved open items, same rule
//   sync:     { lines, unmeasured, elapsedMs } | null
//   failures: string[]                what the printer itself could not read, already worded
//   totalMs:  number
// }
// Returns the report as an array of lines. Pure.
function buildReport(data) {
  const unmeasured = [...(data.failures || []), ...(data.sync ? data.sync.unmeasured : [])];
  const out = [...formatHeader(data.where, unmeasured.length), ''];
  out.push(...(data.handoff ? formatHandoff(data.handoff) : ['HANDOFF -- NOT READ (see NOT MEASURED)']), '');
  out.push(...(data.items ? formatOpen(data.items) : ['OPEN -- NOT READ (see NOT MEASURED)']), '');
  out.push(...(data.sync ? formatSyncHealth(data.sync) : ['SYNC HEALTH -- NOT READ (see NOT MEASURED)']), '');
  out.push(...formatNotMeasured(unmeasured), '');
  out.push(...formatTiming(data.totalMs, data.sync ? data.sync.elapsedMs : null), '');
  out.push(...formatCommands());
  return out;
}

// ---------------------------------------------------------------------------------------------
// the only part that touches the machine
// ---------------------------------------------------------------------------------------------

function gather() {
  const { parseStatus } = require('./lib/backlog-status');
  const { CHECKS } = require('./lib/backlog-checks');
  const { describeSyncHealth } = require('./lib/sync-health');
  const m = require('./lib/cache-markers');
  const failures = [];

  // Where this was measured from. Identification only; git's refusal is reported, not papered over.
  // ONE git call, not three: on the NAS-hosted worktree every git call costs about half a second, and
  // the first version (is-inside-work-tree, branch, log) spent 1.55 s of the 5 s budget on a header.
  // `rev-parse HEAD --abbrev-ref HEAD` answers both questions, one per line. A failure (not a
  // checkout, git missing, no commits) leaves both null, which prints as "(NOT measured)".
  const where = { root: m.ROOT, branch: null, head: null };
  const r = m.git(['rev-parse', 'HEAD', '--abbrev-ref', 'HEAD']);
  const answer = r.status === 0 ? String(r.stdout).trim().split(/\r?\n/) : [];
  if (answer.length === 2 && /^[0-9a-f]{40}$/.test(answer[0]) && answer[1] !== '') {
    where.head = answer[0].slice(0, 7);
    where.branch = answer[1] === 'HEAD' ? '(detached HEAD)' : answer[1];
  } else {
    failures.push(`which branch and commit this was measured from: ${m.ROOT} is not a git checkout, or git could not answer`);
  }

  let handoff = null;
  let items = null;
  try {
    const raw = fs.readFileSync(path.join(m.ROOT, 'STATUS.md'), 'utf8');
    const text = raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw; // a byte-order mark would hide the first line's `## `
    const parsed = parseStatus(text);
    handoff = parsed.handoff;
    items = resolveOpen(parsed.open, CHECKS);
  } catch (e) {
    failures.push(`STATUS.md could not be read, so neither HANDOFF nor OPEN was produced: ${errText(e)}`);
  }

  let sync = null;
  try { sync = describeSyncHealth(); }
  catch (e) { failures.push(`sync health could not run: ${errText(e)}`); }

  return { where, handoff, items, sync, failures };
}

function main() {
  const data = gather();
  // performance.now() counts from the start of this process, so it includes loading the libraries.
  data.totalMs = Math.round(performance.now());
  process.stdout.write(buildReport(data).join('\n') + '\n');
}

if (require.main === module) main();

module.exports = {
  BUDGET_MS, ORDER,
  resolveItem, resolveOpen, sortItems,
  formatItem, formatOpen, formatHandoff, formatSyncHealth, formatNotMeasured,
  formatHeader, formatTiming, formatCommands, buildReport,
};
