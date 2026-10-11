#!/usr/bin/env node
// Migration, one-off: Holiday Work id 18 keeps hours computed under the OLD lunch rule.
//
// 2026-10-08 (owner, commit 2417762) changed splitHolidayWorkOtMinutes(): a shift that ENDS by
// 13:00 no longer has the lunch hour deducted, because that person worked through lunch and then
// went home -- they never took it. Payroll reads the STORED otHours20 off the record rather than
// recomputing from workStartTime/workEndTime, so the rule change does not reach records already
// on file. Record id 18 (08:30-12:45) is the only Holiday Work record in the system, and it still
// carries 3.5 hours from the old rule instead of 4.25.
//
// 2026-10-11 (owner): fix it by writing the value, NOT by reopening the request. The record is
// `status: approved`, approved by MD on 2026-10-05 through approvalRoute ["md"] -- reopening and
// resubmitting it would need MD a second time and would overwrite that approval trail. This
// script therefore touches `otHours20` and nothing else: status, approver, approvedAt,
// submittedAt and every other field are left exactly as they are.
//
// The correct value is not hardcoded here. It is computed by running the real
// splitHolidayWorkOtMinutes() out of BOTH server.js and app.js against the live settings, and the
// script refuses to write unless the two copies agree -- the DUAL-SYNC rule in AGENTS.md section 7
// says a difference between them is a bug, and a migration is the worst place to paper over one.
//
// Usage:  node scripts/migrations/2026-10-11-holiday-work-18-lunch.js            (report only)
//         node scripts/migrations/2026-10-11-holiday-work-18-lunch.js --write    (apply)

'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = process.env.TA_ROOT || 'Z:/Time_Attendance';
const DATA = path.join(ROOT, 'attendance-server/backend/data');
const LEAVES = path.join(DATA, 'leaves.json');
const TARGET_ID = 18;
const WRITE = process.argv.includes('--write');

// Pull a top-level `function name(...) {...}` out of a source file by counting brackets.
// Deliberately no regex with escapes: writing this file through a shell heredoc has mangled
// backslashes here before (see memory: heredoc-backslash-bell).
function extractFunction(src, name, where) {
  const start = src.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('ไม่พบฟังก์ชัน ' + name + ' ใน ' + where);
  let parens = 0, afterParams = -1;
  for (let j = src.indexOf('(', start); j < src.length; j++) {
    if (src[j] === '(') parens++;
    else if (src[j] === ')') { parens--; if (parens === 0) { afterParams = j; break; } }
  }
  let depth = 0;
  for (let j = src.indexOf('{', afterParams); j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (depth === 0) return src.slice(start, j + 1); }
  }
  throw new Error('วงเล็บไม่สมดุลที่ ' + name + ' ใน ' + where);
}

const FNS = ['parseHHMMToMins', 'holidayWorkEndMins', 'splitHolidayWorkOtMinutes'];
function loadRule(file, label) {
  const body = FNS.map(n => extractFunction(fs.readFileSync(file, 'utf8'), n, label)).join('\n');
  // HHMM_RE is a file-level constant parseHHMMToMins() closes over; same literal as
  // server.js:5739 and tests/payroll-rules.test.js:35.
  return new Function('HHMM_RE', body + '; return { ' + FNS.join(', ') + ' };')(
    /^([01]\d|2[0-3]):[0-5]\d$/
  );
}

function die(msg) { console.error('หยุด: ' + msg); process.exit(1); }

const settings = JSON.parse(fs.readFileSync(path.join(DATA, 'settings.json'), 'utf8'));
const S = settings.appSettings;

// A finalized or locked period means the number was already paid under the old rule; changing the
// record would then disagree with a snapshot that is supposed to be immutable. Refuse instead.
const finalize = JSON.parse(fs.readFileSync(path.join(DATA, 'finalize.json'), 'utf8'));
const finalizeKeys = Array.isArray(finalize) ? finalize : Object.keys(finalize);
const locks = settings.periodLocks || {};
if ((Array.isArray(finalizeKeys) ? finalizeKeys.length : 0) > 0) {
  die('finalize.json ไม่ว่าง (' + JSON.stringify(finalizeKeys).slice(0, 200) + ') — ตรวจด้วยมือก่อน');
}
if (Object.keys(locks).length > 0) {
  die('มี periodLocks อยู่ (' + JSON.stringify(locks).slice(0, 200) + ') — ตรวจด้วยมือก่อน');
}

const raw = fs.readFileSync(LEAVES, 'utf8');
const rows = JSON.parse(raw);
if (!Array.isArray(rows)) die('leaves.json ไม่ใช่ array');

const idx = rows.findIndex(r => r.id === TARGET_ID);
if (idx < 0) die('ไม่พบเรคคอร์ด id ' + TARGET_ID);
const rec = rows[idx];

if (rec.type !== 'holiday-work') die('id ' + TARGET_ID + ' ไม่ใช่ holiday-work (เป็น ' + rec.type + ')');
if (rec.status !== 'approved') die('id ' + TARGET_ID + ' สถานะไม่ใช่ approved (เป็น ' + rec.status + ')');

const fromServer = loadRule(path.join(ROOT, 'attendance-server/backend/server.js'), 'server.js')
  .splitHolidayWorkOtMinutes(rec.workStartTime, rec.workEndTime, S);
const fromClient = loadRule(path.join(ROOT, 'attendance/js/app.js'), 'app.js')
  .splitHolidayWorkOtMinutes(rec.workStartTime, rec.workEndTime, S);
if (JSON.stringify(fromServer) !== JSON.stringify(fromClient)) {
  die('server.js กับ app.js คำนวณไม่ตรงกัน (DUAL-SYNC พัง) — ' +
      JSON.stringify(fromServer) + ' vs ' + JSON.stringify(fromClient));
}

const want = fromServer.otHours20;
console.log('เรคคอร์ด id ' + TARGET_ID + ': ' + rec.workStartTime + '-' + rec.workEndTime +
            ' (' + rec.dateFrom + ', ' + rec.compensationMode + ', status ' + rec.status + ')');
console.log('  otHours20 ที่เก็บอยู่ : ' + rec.otHours20);
console.log('  otHours20 ตามกฎปัจจุบัน: ' + want + '  (server.js และ app.js ตรงกัน)');
console.log('  otHours30 ที่เก็บอยู่ : ' + rec.otHours30 + ' / ตามกฎ: ' + fromServer.otHours30);

if (rec.otHours30 !== fromServer.otHours30) {
  die('otHours30 ก็ไม่ตรงด้วย — สคริปต์นี้ออกแบบมาแก้เฉพาะ otHours20 ตรวจด้วยมือก่อน');
}
if (rec.otHours20 === want) {
  console.log('\nไม่ต้องแก้อะไร ค่าตรงกับกฎอยู่แล้ว');
  process.exit(0);
}

if (!WRITE) {
  console.log('\n(รายงานอย่างเดียว) สั่งด้วย --write เพื่อเขียนจริง');
  process.exit(0);
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const bak = path.join(DATA, 'leaves.backup-' + stamp + '.json');
fs.writeFileSync(bak, raw);
console.log('\nสำรองไว้ที่: ' + path.basename(bak) + ' (' + fs.statSync(bak).size + ' ไบต์)');

const before = rows.map(r => JSON.stringify(r));
rows[idx].otHours20 = want;

// Prove that exactly one field on exactly one record moved before anything is written.
const changed = rows.map((r, i) => (JSON.stringify(r) === before[i] ? null : i)).filter(i => i !== null);
if (changed.length !== 1 || changed[0] !== idx) {
  die('มีแถวเปลี่ยนไม่ใช่แค่แถวเดียว: ' + JSON.stringify(changed));
}
const a = JSON.parse(before[idx]), b = rows[idx];
const diffKeys = Object.keys({ ...a, ...b }).filter(k => JSON.stringify(a[k]) !== JSON.stringify(b[k]));
if (diffKeys.length !== 1 || diffKeys[0] !== 'otHours20') {
  die('ฟิลด์ที่เปลี่ยนไม่ใช่ otHours20 อย่างเดียว: ' + JSON.stringify(diffKeys));
}

const tmp = LEAVES + '.tmp-' + process.pid;
fs.writeFileSync(tmp, JSON.stringify(rows, null, 2));
fs.renameSync(tmp, LEAVES);

const after = JSON.parse(fs.readFileSync(LEAVES, 'utf8'));
if (after.length !== rows.length) die('จำนวนแถวหลังเขียนไม่ตรง');
const rec2 = after.find(r => r.id === TARGET_ID);
console.log('เขียนแล้ว: otHours20 = ' + rec2.otHours20 +
            ' | status = ' + rec2.status +
            ' | approver = ' + rec2.approver +
            ' | approvedAt = ' + rec2.approvedAt);
console.log('แถวทั้งไฟล์: ' + after.length + ' (เท่าเดิม)');
