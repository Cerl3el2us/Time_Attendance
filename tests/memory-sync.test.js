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
  const patterns = stubOpts.patterns
    || "$Patterns = @(\n  'feedback_attendance*.md',\n  'MEMORY.md'\n)\n";
  const copy = stubOpts.copy
    ? `foreach ($f in @(Get-ChildItem -Path (Join-Path '${mem}' '*') -File -Include $Patterns)) {\n`
      + `  Copy-Item -LiteralPath $f.FullName -Destination '${nas}' -Force\n}\n`
    : '';
  fs.writeFileSync(path.join(nas, 'sync_memory.ps1'),
    'param([Parameter(Position=0)][string]$Mode, [string]$ProjectDir)\n'
    + decl
    + patterns
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

// 2026-10-13, found while fixing the drive-root bug and deliberately left for its own case: the
// name Claude Code gives a project folder replaces dots too, not only ":" and "\". The evidence is
// on this machine -- the project at \\192.168.100.100\web has the folder --192-168-100-100-web --
// while the script replaced only ":" and "\", which would have derived --192.168.100.100-web and
// found nothing. The hook only ever passes Z:\, so this never fired; it was a trap waiting for the
// day anyone pointed -ProjectDir at a path with a dot in it. The case uses an unmapped drive on
// purpose: the real UNC folder EXISTS here, so deriving it correctly would send the script on to
// push another project's memory, which a test must never do.
test('sync_if_dirty: a dot in the project path becomes a dash, as it does in the folder Claude Code made', () => {
  if (!SLOW) skip('--slow only');
  requireScript(DIRTY_SCRIPT);
  const dir = tmp('dotpath');
  const log = path.join(dir, 'dot.log');
  const r = ps(DIRTY_SCRIPT, ['-ProjectDir', 'Q:\\a.b', '-LogFile', log]);
  if (r.code !== 0) throw new Error(`a hook must never fail the session: exit ${r.code} ${r.err}`);
  if (r.out !== 'UNREACHABLE') throw new Error(`expected UNREACHABLE, got: ${JSON.stringify(r.out)}`);
  const body = fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '';
  const m = /memorydir=(.+)$/m.exec(body);
  if (!m) throw new Error(`no memorydir line logged; log was ${JSON.stringify(body)}`);
  const got = m[1].trim();
  if (!got.endsWith('\\projects\\Q--a-b\\memory')) {
    throw new Error(`derived ${got} -- it must end in \\projects\\Q--a-b\\memory`);
  }
});

// The file's own header promises "-WhatIf writes nothing at all (neither the marker nor the log)".
// That was true of the push path, which is inside `if (-not $WhatIf)`, but not of the UNREACHABLE,
// listing-failed and ERROR paths, which logged regardless. A dry run that writes to the NAS log is
// both a false promise and a line in the record for a run that did nothing -- and sync.log is now
// read back at session start, so a stray line there is a sentence in the owner's face.
test('sync_if_dirty: -WhatIf writes no log line either, as the file promises', () => {
  if (!SLOW) skip('--slow only');
  requireScript(DIRTY_SCRIPT);
  const dir = tmp('whatif-log');
  const log = path.join(dir, 'should-stay-absent.log');
  const r = ps(DIRTY_SCRIPT, ['-ProjectDir', 'Q:\\', '-LogFile', log, '-WhatIf']);
  if (r.code !== 0) throw new Error(`a hook must never fail the session: exit ${r.code} ${r.err}`);
  if (r.out !== 'UNREACHABLE') throw new Error(`expected UNREACHABLE, got: ${JSON.stringify(r.out)}`);
  if (fs.existsSync(log)) {
    throw new Error(`-WhatIf wrote the log: ${JSON.stringify(fs.readFileSync(log, 'utf8'))}`);
  }
});

// The two scripts derive the memory folder name from -ProjectDir with the same expression, and
// sync_if_dirty.ps1 says so in a comment ("ต้องเหมือน sync_memory.ps1 เป๊ะ"). Nothing enforced it.
// 2026-10-13: adding the dot rule to one of them put the two out of step for the length of one
// commit, which is exactly the silent disagreement the rest of this work is about -- one script
// would push into ...\Q--a-b\memory while the other judged ...\Q--a.b\memory. Neither script has a
// dry run, so a behavioural case would have to perform a real pull or push; what is asserted here
// is the invariant itself, that the one line is identical in both files.
test('sync_memory.ps1 and sync_if_dirty.ps1 derive the folder name with the same expression', () => {
  requireScript(DIRTY_SCRIPT);
  requireScript(SYNC_SCRIPT);
  const lineOf = (p) => {
    const hit = fs.readFileSync(p, 'utf8').split(/\r?\n/).find(l => /^\s*\$sanitized\s*=/.test(l));
    if (!hit) throw new Error(`no $sanitized assignment in ${path.basename(p)}`);
    return hit.replace(/\s+/g, ' ').trim();
  };
  const a = lineOf(DIRTY_SCRIPT);
  const b = lineOf(SYNC_SCRIPT);
  if (a !== b) throw new Error(`the two scripts disagree:\n  sync_if_dirty.ps1: ${a}\n  sync_memory.ps1:   ${b}`);
  for (const needle of ["-replace ':', '-'", "-replace '\\\\', '-'", "-replace '\\.', '-'"]) {
    if (!a.includes(needle)) throw new Error(`the shared expression is missing ${needle}: ${a}`);
  }
});

// -----------------------------------------------------------------------------------------------
// 2026-10-13, asked for after the fact ("is the bug checking comprehensive?"): the five cases above
// all use files at the top level, so the archive\ branch of the placement rule -- the one piece of
// Test-DirtyInStep with a condition in it -- had no case at all. sync_memory.ps1 copies the top
// level and archive\ with two calls of Copy-MemoryFiles, neither recursive, so archive\x.md travels
// and archive\old\x.md never can. These pin both sides of that, and the pattern reader's refusal.
// -----------------------------------------------------------------------------------------------

function writeIn(dir, rel, body) {
  const p = path.join(dir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body, 'utf8');
  return p;
}

test('sync_if_dirty: a file in archive\\ counts as proven when the NAS has it, like a top-level one', () => {
  if (!SLOW) skip('--slow only');
  requireScript(DIRTY_SCRIPT);
  const mem = tmp('archive-mem');
  writeIn(mem, path.join('archive', 'feedback_attendance_old.md'), 'archived note');
  const nas = fakeNas('archive-nas', mem, summary(1, 0, 0, 0));
  // The stub copies only the top level, so put the archive copy in place the way a real push would.
  writeIn(nas, path.join('archive', 'feedback_attendance_old.md'), 'archived note');
  const r = runDirty(nas, mem);
  if (r.code !== 0) throw new Error(`a hook must never fail the session: exit ${r.code} ${r.err}`);
  if (/unsynced=/.test(r.log)) throw new Error(`archive\\ is synced, so it is not unsyncable: ${r.log}`);
  if (!/verified=1/.test(r.log)) throw new Error(`the archive file was not counted as proven: ${r.log}`);
  if (!/push=ok/.test(r.log)) throw new Error(`everything dirty is in step, so this is a success: ${r.log}`);
  if (!r.markerExists) throw new Error('a proven push must write the marker');
});

test('sync_if_dirty: a file in archive\\ that the NAS lacks blocks the marker, like a top-level one', () => {
  if (!SLOW) skip('--slow only');
  requireScript(DIRTY_SCRIPT);
  const mem = tmp('archive-missing-mem');
  writeIn(mem, path.join('archive', 'feedback_attendance_old.md'), 'archived note');
  const nas = fakeNas('archive-missing-nas', mem, summary(1, 0, 0, 0));
  const r = runDirty(nas, mem);
  if (r.code !== 0) throw new Error(`a hook must never fail the session: exit ${r.code} ${r.err}`);
  if (!/not-in-step=/.test(r.log)) throw new Error(`an archive file missing on the NAS is left behind: ${r.log}`);
  if (!r.log.includes('archive')) throw new Error(`the name must carry its folder, not just the file: ${r.log}`);
  if (r.markerExists) throw new Error('the marker was written, so the archived file is now forgotten');
});

test('sync_if_dirty: a file deeper than archive\\ can never be copied, so it is named and does not block', () => {
  if (!SLOW) skip('--slow only');
  requireScript(DIRTY_SCRIPT);
  const mem = tmp('deep-mem');
  write(mem, 'feedback_attendance_x.md', 'this one travels');
  writeIn(mem, path.join('archive', 'old', 'feedback_attendance_buried.md'), 'nothing copies this');
  const nas = fakeNas('deep-nas', mem, summary(1, 0, 0, 0), { copy: true });
  const r = runDirty(nas, mem);
  if (r.code !== 0) throw new Error(`a hook must never fail the session: exit ${r.code} ${r.err}`);
  if (!/unsynced=/.test(r.log)) throw new Error(`neither Copy-MemoryFiles call recurses, so this file can never travel: ${r.log}`);
  if (!r.log.includes('feedback_attendance_buried.md')) throw new Error(`the buried file is not named: ${r.log}`);
  if (!r.markerExists) throw new Error('pushing again can never copy it, so it must not block the marker');
});

test('sync_if_dirty: a $Patterns list it cannot read whole is UNREADABLE, not a guess', () => {
  if (!SLOW) skip('--slow only');
  requireScript(DIRTY_SCRIPT);
  const mem = tmp('badpat-mem');
  write(mem, 'feedback_attendance_x.md', 'written in this session');
  // A variable in the list: the reader cannot know what it expands to, so the list is not complete.
  const nas = fakeNas('badpat-nas', mem, summary(1, 0, 0, 0), {
    copy: false,
    patterns: "$Patterns = @(\n  'feedback_attendance*.md',\n  $extra,\n  'MEMORY.md'\n)\n",
  });
  const r = runDirty(nas, mem);
  if (r.code !== 0) throw new Error(`a hook must never fail the session: exit ${r.code} ${r.err}`);
  if (!/verify=UNREADABLE/.test(r.log)) throw new Error(`a partial pattern list must not be used: ${r.log}`);
  if (/push=ok/.test(r.log)) throw new Error(`it proved nothing, so it must not claim ok: ${r.log}`);
  if (r.markerExists) throw new Error('"cannot tell" must not be treated as done');
});

// -----------------------------------------------------------------------------------------------
// 2026-10-13: the four -PushStatus cases above each used a line I wrote by hand, with the field
// under test last. Run against the shape sync_if_dirty.ps1 actually writes, the reader broke: a
// field's value can contain a space (names are joined with ", "), and it was read with [^\s]+, so
// "needs-eyes=x.md, y.md" came back as "x.md," -- one file and a dangling comma, where two files
// were waiting. Fields are separated by TWO spaces, so that is the boundary to read to.
//
// The same run showed a judgement error: a push with conflicts was reported without a WARNING. The
// field is called needs-eyes; it means a file did not reach the NAS and a person has to look. The
// heartbeat exists to surface exactly that, so it warns.
// -----------------------------------------------------------------------------------------------

// The shape sync_if_dirty.ps1 writes: fields separated by two spaces, names inside a field by ", ".
const RUN = (proof, extra = {}) => [
  '2026-10-13T18:00:00+07:00',
  `DIRTY ${extra.dirty || 2}`,
  `push=${extra.push || 'ok'}`,
  'rc=0',
  'copied=0 same=5 conflict=0 failed=0',
  proof,
  `needs-eyes=${extra.eyes || 'none'}`,
  'snapshot=ABSENT',
  `marker=${extra.marker || 'written'}`,
  'files=a.md, b.md',
].join('  ');

test('session_start -PushStatus: every name in a field is reported, not just the first', () => {
  if (!SLOW) skip('--slow only');
  requireScript(START_SCRIPT);
  const dir = tmp('pushstatus-names');
  const log = writeLog(dir, [RUN('verified=0  unsynced=a.md, b.md')]);
  const r = ps(START_SCRIPT, ['-PushStatus', '-LogFile', log]);
  if (r.code !== 0) throw new Error(`a hook must never fail the session: exit ${r.code} ${r.err}`);
  if (!/WARNING/.test(r.out)) throw new Error(`files left behind must warn: ${r.out}`);
  for (const name of ['a.md', 'b.md']) {
    if (!r.out.includes(name)) throw new Error(`${name} is missing from the warning: ${r.out}`);
  }
  if (/,\s*\./.test(r.out)) throw new Error(`the list was cut mid-way, leaving a dangling comma: ${r.out}`);
});

test('session_start -PushStatus: a push that left files for a human to look at warns and names them', () => {
  if (!SLOW) skip('--slow only');
  requireScript(START_SCRIPT);
  const dir = tmp('pushstatus-eyes');
  const log = writeLog(dir, [RUN('verified=0 conflicted=2', { eyes: 'x.md, y.md' })]);
  const r = ps(START_SCRIPT, ['-PushStatus', '-LogFile', log]);
  if (r.code !== 0) throw new Error(`a hook must never fail the session: exit ${r.code} ${r.err}`);
  if (!/WARNING/.test(r.out)) throw new Error(`needs-eyes means a person has to look, so it warns: ${r.out}`);
  for (const name of ['x.md', 'y.md']) {
    if (!r.out.includes(name)) throw new Error(`${name} is missing from the warning: ${r.out}`);
  }
});

test('session_start -PushStatus: a push that left a file behind names the file, not just "FAILED"', () => {
  if (!SLOW) skip('--slow only');
  requireScript(START_SCRIPT);
  const dir = tmp('pushstatus-notinstep');
  const log = writeLog(dir, [RUN('verified=0  not-in-step=a.md, b.md', { push: 'FAILED', marker: 'kept-old' })]);
  const r = ps(START_SCRIPT, ['-PushStatus', '-LogFile', log]);
  if (r.code !== 0) throw new Error(`a hook must never fail the session: exit ${r.code} ${r.err}`);
  if (!/WARNING/.test(r.out)) throw new Error(`a failed push must warn: ${r.out}`);
  for (const name of ['a.md', 'b.md']) {
    if (!r.out.includes(name)) throw new Error(`${name} is missing from the warning: ${r.out}`);
  }
});

test('session_start -PushStatus: a run that could not check the NAS says so, not just "FAILED"', () => {
  if (!SLOW) skip('--slow only');
  requireScript(START_SCRIPT);
  const dir = tmp('pushstatus-unreadable');
  const log = writeLog(dir, [RUN('verify=UNREADABLE', { push: 'FAILED', marker: 'kept-old' })]);
  const r = ps(START_SCRIPT, ['-PushStatus', '-LogFile', log]);
  if (r.code !== 0) throw new Error(`a hook must never fail the session: exit ${r.code} ${r.err}`);
  if (!/WARNING/.test(r.out)) throw new Error(`a run that proved nothing must warn: ${r.out}`);
  if (!/could not check|UNREADABLE/i.test(r.out)) {
    throw new Error(`the reason must survive into the warning, not become a bare FAILED: ${r.out}`);
  }
});

// -----------------------------------------------------------------------------------------------
// 2026-10-13: sync_memory.ps1 reports conflicts by BASE NAME, with no folder, because it copies the
// top level and archive\ in two separate calls and pools the names. So one name can mean either of
// two dirty files. Exempting by name alone marked a file that had never reached the NAS as settled
// -- measured: conflicted=2 for one real conflict, marker written, and the new work at the top level
// forgotten for good. That is the loss this whole change exists to prevent.
//
// A file that really conflicted must EXIST on the NAS -- that is why it conflicted. So the exemption
// needs the name AND a counterpart on the far side. Nothing loops: the file that is merely missing
// is reported, the marker is withheld, and the next push copies it for real.
// -----------------------------------------------------------------------------------------------
test('sync_if_dirty: a conflict name shared by two dirty files only excuses the one the NAS holds', () => {
  if (!SLOW) skip('--slow only');
  requireScript(DIRTY_SCRIPT);
  const mem = tmp('ambiguous-mem');
  write(mem, 'feedback_attendance_dup.md', 'this session wrote this, and the NAS has never seen it');
  writeIn(mem, path.join('archive', 'feedback_attendance_dup.md'), 'old copy');
  const nas = fakeNas('ambiguous-nas', mem, summary(0, 0, 1, 0, 'feedback_attendance_dup.md'));
  // Only the archived one exists on the far side, so only it can be the conflict that was reported.
  writeIn(nas, path.join('archive', 'feedback_attendance_dup.md'), 'the NAS copy, newer');
  const r = runDirty(nas, mem);
  if (r.code !== 0) throw new Error(`a hook must never fail the session: exit ${r.code} ${r.err}`);
  if (!/not-in-step=/.test(r.log)) {
    throw new Error(`the top-level file is on no NAS at all, so it is not excused by a name: ${r.log}`);
  }
  if (!/conflicted=1\b/.test(r.log)) throw new Error(`exactly one file conflicted, not two: ${r.log}`);
  if (r.markerExists) {
    throw new Error('the marker was written, so work that never left this machine is now forgotten');
  }
});

// Deliberate limit, pinned so nobody later reads "verified" as "the contents match". sync_memory.ps1
// compares content with a hash before it copies, so by the time this runs, equal size on both sides
// is the cheap end of a check that already happened. Hashing every dirty file again on the NAS would
// pay for it twice, over SMB, on the path that already costs seconds.
test('sync_if_dirty: verified means same size, not same content, and says so by counting it', () => {
  if (!SLOW) skip('--slow only');
  requireScript(DIRTY_SCRIPT);
  const mem = tmp('samesize-mem');
  write(mem, 'feedback_attendance_x.md', 'AAAA');
  const nas = fakeNas('samesize-nas', mem, summary(1, 0, 0, 0));
  fs.writeFileSync(path.join(nas, 'feedback_attendance_x.md'), 'BBBB', 'utf8'); // same length, other bytes
  const r = runDirty(nas, mem);
  if (r.code !== 0) throw new Error(`a hook must never fail the session: exit ${r.code} ${r.err}`);
  if (!/verified=1/.test(r.log)) throw new Error(`equal size counts as proven by design: ${r.log}`);
  if (!/push=ok/.test(r.log)) throw new Error(`so the push is a success: ${r.log}`);
});