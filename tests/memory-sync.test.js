// The memory folder is how one machine tells the other what it learned. Two failures made this
// test necessary.
//
// 2026-10-12: opening a session spent 4.2s hashing 135 files across SMB before Claude could say
// anything, because Test-SameContent hashed both sides of every file -- while reading every file's
// size and timestamp in one directory listing costs 0.18s. The owner's complaint was the delay.
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
