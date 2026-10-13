// The memory folder is how one machine tells the other what it learned. Two failures made this
// test necessary.
//
// 2026-10-12: opening a session was slow enough that the owner complained about the delay, and
// Test-SameContent hashed both sides of every file it was handed without looking at size first --
// while reading every file's size and timestamp in one directory listing costs 0.18s.
//
// CORRECTED 2026-10-12 (whole-branch review): the "4.2s / 4.86s before" figure this header used to
// quote was a cost the old script never paid. `git show f49b493:sync_memory.ps1` (2026-10-08) shows
// the CALLER already skipped any file whose size and mtime matched, so hashing was never reached
// for the common case; 4.2s was measured by calling Test-SameContent on every file directly. The
// real win is tier 1 (different size => no hash). Tier 2 (same size, same ticks) is unreachable
// from the only caller, which filters that case out first -- do not cite it as a measured saving.
//
// The second failure is older and quieter: memory only reached the other machine when someone
// remembered to say "จบงาน". The fix is a hook, and a hook that misjudges "did anything change?"
// either pushes on every turn or never pushes at all -- so that judgement lives in one script with
// this test on it, not in a one-liner inside settings.json where nothing can reach it.
//
// Both scripts live on the NAS, outside this repo (Z:\claude_memory\). When Z: is not mapped these
// cases cannot run; they are reported as SKIPPED with a reason, never silently passed.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SYNC_DIR = 'Z:\\claude_memory';
const DIRTY_SCRIPT = path.join(SYNC_DIR, 'sync_if_dirty.ps1');
const SYNC_SCRIPT = path.join(SYNC_DIR, 'sync_memory.ps1');
const START_SCRIPT = path.join(SYNC_DIR, 'session_start.ps1');
const SLOW = process.argv.includes('--slow');

let passed = 0, skipped = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ', name); }
  catch (e) {
    if (e && e.skip) { skipped++; console.log('  SKIP', name, '-', e.message); return; }
    process.exitCode = 1; console.log('  FAIL', name, '\n       ', e.message);
  }
}
function skip(msg) { const e = new Error(msg); e.skip = true; throw e; }

function requireScript(p) {
  if (!fs.existsSync(p)) skip(`not reachable: ${p} (Z: not mapped?)`);
}

function ps(scriptPath, args) {
  const r = spawnSync('powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, ...args],
    { encoding: 'utf8', timeout: 60000 });
  return { code: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}

// A temp tree per case; never the real memory folder.
function tmp(name) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `memsync-${name}-`));
  return d;
}
// mtime is in SECONDS since the epoch (what fs.utimesSync takes). The clean/dirty cases below are
// meaningless if the file does not carry the timestamp the case claims, so write() reads it back
// instead of trusting the arithmetic at the call site.
function write(dir, file, body, mtime) {
  const p = path.join(dir, file);
  fs.writeFileSync(p, body, 'utf8');
  if (mtime) {
    fs.utimesSync(p, mtime, mtime);
    const got = fs.statSync(p).mtimeMs;
    if (Math.abs(got - mtime * 1000) > 1000) {
      throw new Error(`fixture bug: asked for mtime ${mtime * 1000} ms, file has ${got} ms`);
    }
  }
  return p;
}
const secondsAgo = (n) => (Date.now() - n * 1000) / 1000;

console.log('memory-sync:');

// Runs always (no PowerShell, no Z:): proves the timestamp fixture sets what it says, so a bad
// helper cannot make the clean/dirty cases below pass or fail for the wrong reason.
test('fixture: write() really sets the mtime it is given', () => {
  const dir = tmp('fixture');
  const asked = secondsAgo(60);
  const old = write(dir, 'old', 'x', asked);
  const fresh = write(dir, 'fresh', 'x');
  const oldMs = fs.statSync(old).mtimeMs, freshMs = fs.statSync(fresh).mtimeMs;
  if (Math.abs(oldMs - asked * 1000) > 1000) throw new Error(`old file mtime is off: ${oldMs}`);
  if (!(freshMs - oldMs > 55000)) throw new Error(`fresh file is not ~60s newer: ${freshMs - oldMs} ms`);
});

test('sync_if_dirty: no marker yet means dirty', () => {
  if (!SLOW) skip('--slow only');
  requireScript(DIRTY_SCRIPT);
  const mem = tmp('nomarker');
  write(mem, 'feedback_attendance_x.md', 'hello');
  const r = ps(DIRTY_SCRIPT, ['-ProjectDir', 'Z:\\', '-MemoryDir', mem,
    '-MarkerFile', path.join(mem, '..', 'no-such-marker'), '-LogFile', path.join(mem, 'sync.log'), '-WhatIf']);
  if (r.code !== 0) throw new Error(`exit ${r.code}: ${r.err}`);
  if (!/^DIRTY \d+$/m.test(r.out)) throw new Error(`expected DIRTY <n>, got: ${r.out}`);
});

test('sync_if_dirty: marker newer than every file means clean', () => {
  if (!SLOW) skip('--slow only');
  requireScript(DIRTY_SCRIPT);
  const mem = tmp('clean');
  write(mem, 'feedback_attendance_x.md', 'hello', secondsAgo(60));
  const marker = write(mem, '.marker', '');            // written now, so newer
  const r = ps(DIRTY_SCRIPT, ['-ProjectDir', 'Z:\\', '-MemoryDir', mem,
    '-MarkerFile', marker, '-LogFile', path.join(mem, 'sync.log'), '-WhatIf']);
  if (r.out !== 'CLEAN') throw new Error(`expected CLEAN, got: ${r.out}`);
});

test('sync_if_dirty: one file newer than the marker means dirty', () => {
  if (!SLOW) skip('--slow only');
  requireScript(DIRTY_SCRIPT);
  const mem = tmp('dirty');
  const marker = write(mem, '.marker', '', secondsAgo(60));
  write(mem, 'feedback_attendance_x.md', 'changed');   // now
  const r = ps(DIRTY_SCRIPT, ['-ProjectDir', 'Z:\\', '-MemoryDir', mem,
    '-MarkerFile', marker, '-LogFile', path.join(mem, 'sync.log'), '-WhatIf']);
  if (!/^DIRTY 1$/m.test(r.out)) throw new Error(`expected DIRTY 1, got: ${r.out}`);
});

test('sync_if_dirty: an unreachable memory folder exits 0 and says so', () => {
  if (!SLOW) skip('--slow only');
  requireScript(DIRTY_SCRIPT);
  const r = ps(DIRTY_SCRIPT, ['-ProjectDir', 'Z:\\', '-MemoryDir', 'Q:\\nope\\nothing',
    '-MarkerFile', 'Q:\\nope\\marker', '-LogFile', 'Q:\\nope\\sync.log', '-WhatIf']);
  if (r.code !== 0) throw new Error(`a hook must never fail the session: exit ${r.code}`);
  if (r.out !== 'UNREACHABLE') throw new Error(`expected UNREACHABLE, got: ${r.out}`);
});

test('sync_if_dirty: -WhatIf never writes the marker', () => {
  if (!SLOW) skip('--slow only');
  requireScript(DIRTY_SCRIPT);
  const mem = tmp('whatif');
  write(mem, 'feedback_attendance_x.md', 'hello');
  const marker = path.join(mem, '.marker');
  ps(DIRTY_SCRIPT, ['-ProjectDir', 'Z:\\', '-MemoryDir', mem, '-MarkerFile', marker,
    '-LogFile', path.join(mem, 'sync.log'), '-WhatIf']);
  if (fs.existsSync(marker)) throw new Error('-WhatIf wrote the marker; a dry run must not change state');
});

// 2026-10-13: this case exists because the hook on the home machine printed UNREACHABLE on every
// turn and pushed nothing for a whole day, silently (the script exits 0 on that path on purpose).
// settings.json passes -ProjectDir "Z:\\" -- two backslashes, chosen on 2026-10-12 because
// cmd.exe eats the one before the closing quote. The home machine launches the hook through
// PowerShell instead, which eats nothing, so the script received 'Z:\\' and derived
// ...\projects\Z---\memory (three dashes). That folder does not exist, so there was nothing to
// decide and nothing was ever copied. Measured both ways on 2026-10-13: through cmd.exe the script
// receives Z:\ and derives Z--, through PowerShell it receives Z:\\ and derives Z---.
//
// The folder name must therefore not depend on which shell started the hook. Q: is used on purpose
// (not mapped): the derived NAME is what is under test, so every run must end in UNREACHABLE and
// log the path it derived, with the real memory folder taking no part in the case.
test('sync_if_dirty: every way a shell can deliver the drive root names the same memory folder', () => {
  if (!SLOW) skip('--slow only');
  requireScript(DIRTY_SCRIPT);
  const dir = tmp('projectdir');
  const forms = ['Q:', 'Q:\\', 'Q:\\\\', 'Q:"'];
  for (const form of forms) {
    const log = path.join(dir, 'derive.log');
    if (fs.existsSync(log)) fs.unlinkSync(log);
    const r = ps(DIRTY_SCRIPT, ['-ProjectDir', form, '-LogFile', log]);
    if (r.code !== 0) {
      throw new Error(`-ProjectDir ${JSON.stringify(form)}: a hook must never fail the session: exit ${r.code} ${r.err}`);
    }
    if (r.out !== 'UNREACHABLE') {
      throw new Error(`-ProjectDir ${JSON.stringify(form)}: expected UNREACHABLE, got: ${JSON.stringify(r.out)}`);
    }
    const body = fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '';
    const m = /memorydir=(.+)$/m.exec(body);
    if (!m) {
      throw new Error(`-ProjectDir ${JSON.stringify(form)}: no memorydir line logged; log was ${JSON.stringify(body)}`);
    }
    const got = m[1].trim();
    if (!got.endsWith('\\projects\\Q--\\memory')) {
      throw new Error(`-ProjectDir ${JSON.stringify(form)}: derived ${got} -- it must end in \\projects\\Q--\\memory, `
        + 'or the hook looks for a folder that does not exist and pushes nothing');
    }
  }
});
test('sync_memory.ps1: $Patterns covers the pending-task-format note', () => {
  requireScript(SYNC_SCRIPT);
  const src = fs.readFileSync(SYNC_SCRIPT, 'utf8');
  const block = src.slice(src.indexOf('$Patterns'), src.indexOf('$Patterns') + 400);
  if (!block.includes('feedback_pending_task_format.md')) {
    throw new Error('the owner instruction in that file has never synced into this project');
  }
});

test('.gitignore whitelists the same file as $Patterns', () => {
  const gi = path.join(SYNC_DIR, '.gitignore');
  requireScript(gi);
  const txt = fs.readFileSync(gi, 'utf8');
  if (!txt.includes('feedback_pending_task_format.md')) {
    throw new Error('synced but no git history, or the reverse -- these two must be edited together');
  }
});

console.log(`memory-sync: ${passed} passed, ${skipped} skipped`);

// -----------------------------------------------------------------------------------------------
// 2026-10-13, owner asked for this after the hook pushed nothing for a whole day without a word:
// the only trace a broken push leaves is a line in sync.log, and nobody reads sync.log. So
// session_start.ps1 gained -PushStatus: one line about the LAST run, which the hook path puts into
// the session's context. It is the heartbeat -- if it is wrong, a silent failure goes unseen again,
// so it gets its own cases. -PushStatus takes a -LogFile and must not pull, map a drive, or touch
// the NAS: these cases run against fixture logs in a temp folder.
// -----------------------------------------------------------------------------------------------

// A fixture log line for a run that pushed cleanly.
const OK_RUN = '2026-10-13T16:55:41+07:00  DIRTY 2  push=ok  rc=0  copied=2 same=129 conflict=0 '
  + 'failed=0  needs-eyes=none  snapshot=ok:946cb8f  marker=written  files=a.md, MEMORY.md';

function writeLog(dir, lines) {
  const p = path.join(dir, 'sync.log');
  fs.writeFileSync(p, lines.join('\n') + '\n', 'utf8');
  return p;
}

test('session_start -PushStatus: a clean push is reported with its time and count, and does not warn', () => {
  if (!SLOW) skip('--slow only');
  requireScript(START_SCRIPT);
  const dir = tmp('pushstatus-ok');
  const log = writeLog(dir, ['2026-10-13T16:10:03+07:00  UNREACHABLE  memorydir=C:\\x\\Z---\\memory', OK_RUN]);
  const r = ps(START_SCRIPT, ['-PushStatus', '-LogFile', log]);
  if (r.code !== 0) throw new Error(`a hook must never fail the session: exit ${r.code} ${r.err}`);
  if (!r.out.includes('2026-10-13T16:55:41+07:00')) throw new Error(`the last run's time is missing: ${r.out}`);
  if (!/copied=2/.test(r.out)) throw new Error(`the count of files that moved is missing: ${r.out}`);
  if (/WARNING/.test(r.out)) throw new Error(`a clean push must not warn: ${r.out}`);
});

test('session_start -PushStatus: a run that never reached the memory folder warns', () => {
  if (!SLOW) skip('--slow only');
  requireScript(START_SCRIPT);
  const dir = tmp('pushstatus-unreachable');
  const log = writeLog(dir, [OK_RUN, '2026-10-13T17:02:00+07:00  UNREACHABLE  memorydir=C:\\x\\Z---\\memory']);
  const r = ps(START_SCRIPT, ['-PushStatus', '-LogFile', log]);
  if (r.code !== 0) throw new Error(`a hook must never fail the session: exit ${r.code} ${r.err}`);
  if (!/WARNING/.test(r.out)) throw new Error(`an UNREACHABLE last run must warn: ${r.out}`);
  if (!r.out.includes('2026-10-13T17:02:00+07:00')) throw new Error(`the warning must name when it happened: ${r.out}`);
});

test('session_start -PushStatus: a run that left files behind by name warns and names them', () => {
  if (!SLOW) skip('--slow only');
  requireScript(START_SCRIPT);
  const dir = tmp('pushstatus-unsynced');
  const log = writeLog(dir, [OK_RUN.replace('needs-eyes=none', 'needs-eyes=none  unsynced=notes_scratch.md')]);
  const r = ps(START_SCRIPT, ['-PushStatus', '-LogFile', log]);
  if (r.code !== 0) throw new Error(`a hook must never fail the session: exit ${r.code} ${r.err}`);
  if (!/WARNING/.test(r.out)) throw new Error(`a run with unsynced files must warn: ${r.out}`);
  if (!r.out.includes('notes_scratch.md')) throw new Error(`the warning must name the file: ${r.out}`);
});

test('session_start -PushStatus: no log yet says so instead of claiming a push', () => {
  if (!SLOW) skip('--slow only');
  requireScript(START_SCRIPT);
  const dir = tmp('pushstatus-nolog');
  const r = ps(START_SCRIPT, ['-PushStatus', '-LogFile', path.join(dir, 'absent.log')]);
  if (r.code !== 0) throw new Error(`a hook must never fail the session: exit ${r.code} ${r.err}`);
  if (/push=ok/.test(r.out)) throw new Error(`with no log there is no push to report: ${r.out}`);
  if (r.out.trim() === '') throw new Error('it must say something; silence is what hid the bug');
});

// -----------------------------------------------------------------------------------------------
// 2026-10-13, owner asked for this: `push=ok` used to mean only "exit 0 and failed=0". It never
// asked whether the files that changed are now on the NAS, so a run could report ok, write the
// marker and move on having copied nothing -- after which the work was forgotten, because the
// marker says it is done. The new rule: every dirty file that CAN be synced must be in step on the
// NAS afterwards, or the marker is kept and the next turn tries again.
//
// The harness is a temp folder standing in for Z:\claude_memory: a copy of sync_if_dirty.ps1 next
// to a stub sync_memory.ps1 we control. sync_if_dirty.ps1 finds its sibling through $PSScriptRoot
// and reads $NasMemoryDir and $Patterns out of it, so the stub decides both what gets reported and
// what actually moves. The stub's summary is ASCII on purpose: the real script parses the first
// four numbers of the last line, so the words carry no meaning and Thai text would only add an
// encoding variable to the case.
// -----------------------------------------------------------------------------------------------

// copied / same / conflict / failed, plus optional " :: name, name" for files needing eyes.
function summary(copied, same, conflict, failed, names) {
  const base = `copied ${copied} / same ${same} / conflict ${conflict} / failed ${failed}`;
  return names ? `${base} :: ${names}` : base;
}

// stubOpts: { nasDir: false to omit $NasMemoryDir, copy: true to really copy matching files }
function fakeNas(name, mem, summaryLine, stubOpts = {}) {
  const nas = tmp(name);
  fs.copyFileSync(DIRTY_SCRIPT, path.join(nas, 'sync_if_dirty.ps1'));
  const decl = stubOpts.nasDir === false ? '' : `$NasMemoryDir = '${nas}'\n`;
  const copy = stubOpts.copy
    ? `foreach ($f in @(Get-ChildItem -Path (Join-Path '${mem}' '*') -File -Include $Patterns)) {\n`
      + `  Copy-Item -LiteralPath $f.FullName -Destination '${nas}' -Force\n}\n`
    : '';
  fs.writeFileSync(path.join(nas, 'sync_memory.ps1'),
    'param([Parameter(Position=0)][string]$Mode, [string]$ProjectDir)\n'
    + decl
    + "$Patterns = @(\n  'feedback_attendance*.md',\n  'MEMORY.md'\n)\n"
    + copy
    + `Write-Host '${summaryLine}'\n`, 'utf8');
  return nas;
}

// Runs the copied script against a temp memory folder; returns { out, code, log }.
function runDirty(nas, mem, extra = []) {
  const side = tmp('side');
  const marker = path.join(side, 'marker');
  const log = path.join(side, 'sync.log');
  const r = ps(path.join(nas, 'sync_if_dirty.ps1'),
    ['-ProjectDir', 'Z:\\', '-MemoryDir', mem, '-MarkerFile', marker, '-LogFile', log, ...extra]);
  return {
    out: r.out, code: r.code, err: r.err, marker,
    markerExists: fs.existsSync(marker),
    log: fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim() : '',
  };
}

test('sync_if_dirty: a push that copied nothing to the NAS is not ok and keeps the old marker', () => {
  if (!SLOW) skip('--slow only');
  requireScript(DIRTY_SCRIPT);
  const mem = tmp('notinstep-mem');
  write(mem, 'feedback_attendance_x.md', 'written in this session');
  // The stub claims one file was copied; it copies nothing. This is the 2026-10-13 bug exactly.
  const nas = fakeNas('notinstep-nas', mem, summary(1, 0, 0, 0));
  const r = runDirty(nas, mem);
  if (r.code !== 0) throw new Error(`a hook must never fail the session: exit ${r.code} ${r.err}`);
  if (!/push=FAILED/.test(r.log)) throw new Error(`a push that moved nothing must not say ok: ${r.log}`);
  if (!/not-in-step=/.test(r.log)) throw new Error(`the log must name what is not on the NAS: ${r.log}`);
  if (!r.log.includes('feedback_attendance_x.md')) throw new Error(`the file left behind is not named: ${r.log}`);
  if (r.markerExists) throw new Error('the marker was written, so this session\'s file is now forgotten');
});

test('sync_if_dirty: a push whose files really reached the NAS is ok and writes the marker', () => {
  if (!SLOW) skip('--slow only');
  requireScript(DIRTY_SCRIPT);
  const mem = tmp('instep-mem');
  write(mem, 'feedback_attendance_x.md', 'written in this session');
  const nas = fakeNas('instep-nas', mem, summary(1, 0, 0, 0), { copy: true });
  const r = runDirty(nas, mem);
  if (r.code !== 0) throw new Error(`a hook must never fail the session: exit ${r.code} ${r.err}`);
  if (!/push=ok/.test(r.log)) throw new Error(`the file is on the NAS, so this is a success: ${r.log}`);
  if (!/verified=1/.test(r.log)) throw new Error(`the log must say how many files it proved: ${r.log}`);
  if (!r.markerExists) throw new Error('a proven push must write the marker, or it repeats every turn');
});

test('sync_if_dirty: a dirty file no pattern can ever copy is named, and does not block the marker', () => {
  if (!SLOW) skip('--slow only');
  requireScript(DIRTY_SCRIPT);
  const mem = tmp('unsynced-mem');
  write(mem, 'feedback_attendance_x.md', 'this one travels');
  write(mem, 'notes_scratch.md', 'this one never matches a pattern');
  const nas = fakeNas('unsynced-nas', mem, summary(1, 0, 0, 0), { copy: true });
  const r = runDirty(nas, mem);
  if (r.code !== 0) throw new Error(`a hook must never fail the session: exit ${r.code} ${r.err}`);
  if (!/unsynced=/.test(r.log)) throw new Error(`a file the patterns never copy must be shouted: ${r.log}`);
  if (!r.log.includes('notes_scratch.md')) throw new Error(`the unsyncable file is not named: ${r.log}`);
  if (!r.markerExists) {
    throw new Error('pushing again can never copy that file, so withholding the marker only pushes every turn forever');
  }
});

test('sync_if_dirty: a file the NAS holds a newer copy of does not count as left behind', () => {
  if (!SLOW) skip('--slow only');
  requireScript(DIRTY_SCRIPT);
  const mem = tmp('conflict-mem');
  write(mem, 'feedback_attendance_x.md', 'mine');
  // Reported as a conflict: sync_memory.ps1 refused it because the NAS copy is newer. That is the
  // case a human has to look at, not a failure, and the marker is written on purpose -- pushing
  // again would reach the same answer every turn.
  const nas = fakeNas('conflict-nas', mem, summary(0, 0, 1, 0, 'feedback_attendance_x.md'));
  const r = runDirty(nas, mem);
  if (r.code !== 0) throw new Error(`a hook must never fail the session: exit ${r.code} ${r.err}`);
  if (/not-in-step=/.test(r.log)) throw new Error(`a conflict is not a file left behind: ${r.log}`);
  if (!/push=ok/.test(r.log)) throw new Error(`a conflict was already a success before this change: ${r.log}`);
  if (!r.markerExists) throw new Error('the marker is written on a conflict; that behaviour predates this change');
});

test('sync_if_dirty: when it cannot read where the NAS folder is, it says so and keeps the marker', () => {
  if (!SLOW) skip('--slow only');
  requireScript(DIRTY_SCRIPT);
  const mem = tmp('noverify-mem');
  write(mem, 'feedback_attendance_x.md', 'written in this session');
  const nas = fakeNas('noverify-nas', mem, summary(1, 0, 0, 0), { nasDir: false, copy: true });
  const r = runDirty(nas, mem);
  if (r.code !== 0) throw new Error(`a hook must never fail the session: exit ${r.code} ${r.err}`);
  if (!/verify=UNREADABLE/.test(r.log)) throw new Error(`not knowing must be said out loud: ${r.log}`);
  if (/push=ok/.test(r.log)) throw new Error(`it proved nothing, so it must not claim ok: ${r.log}`);
  if (r.markerExists) throw new Error('"cannot tell" must not be treated as done');
});