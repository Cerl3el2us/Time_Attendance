process.on('uncaughtException',  err => console.error('[CRASH] uncaughtException:', err.message));
process.on('unhandledRejection', err => console.error('[CRASH] unhandledRejection:', err && err.message));

const express = require('express');
const { WebSocketServer } = require('ws');
const http  = require('http');
const https = require('https');
const path  = require('path');
const fs    = require('fs');
const { createHash, randomBytes } = require('crypto');
const bcrypt = require('bcryptjs');
const nodemailer = require('nodemailer');
const cron = require('node-cron');
const jwt = require('jsonwebtoken');
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const webpush = require('web-push');
const { buildPayslipWorkbook } = require('./payslipXlsx');
const { buildTawi50Workbook } = require('./tawi50Xlsx');
// AI POLICY: do not remove this require or the ensureSystemAccounts calls in
// readUsers / saveUsers / bootstrapSystemAccount. Superadmin is off-limits for
// unrelated bugfixes (any AI / any model). See systemAccount.js header.
const systemAccount = require('./systemAccount');
const { isSystemAccountUser, isSuperAdminUser, employeeRecords, employeeActiveRecords } = systemAccount;
const ExcelJS = require('exceljs'); // 2026-08-02: needed directly here too, for the shared multi-sheet workbook GET /api/payslip-xlsx-all builds before handing it to buildPayslipWorkbook() once per employee.
const BCRYPT_ROUNDS = 10;
function isHashed(p) { const s = String(p||''); return s.startsWith('$2b$') || s.startsWith('$2a$'); }

// F-18: Atomic write — write to a temp file then rename so a crash mid-write never leaves a
// partially-written (broken) JSON file. fs.renameSync is POSIX-atomic when source and
// destination are on the same filesystem, which they always are (same DATA_DIR).
function atomicWrite(filePath, str, sensitive) {
  const tmp = filePath + '.tmp' + process.pid;
  fs.writeFileSync(tmp, str, 'utf8');
  fs.renameSync(tmp, filePath);
  // SECURITY FIX 2026-08-04 (retrospective Opus audit, MEDIUM): the rename-over-target pattern
  // above makes the destination inherit the .tmp file's mode -- i.e. the default umask (644) --
  // on every single rewrite, silently undoing secureChmod() the moment anything reuses this
  // writer for a secret-bearing file. Pass sensitive:true at the call site for users.json,
  // settings.json, push-subscriptions.json (and any future secret file written through here).
  if (sensitive) secureChmod(filePath);
}

// SECURITY FIX 2026-08-04 (Medium, Hikvision audit): secret files (JWT signing key, VAPID
// private key, Hikvision device password, HTTPS private key) were world-readable (644) on disk.
// Best-effort -- NAS filesystems / non-POSIX targets may not support chmod, so failures are
// logged, not thrown.
function secureChmod(filePath) {
  try { fs.chmodSync(filePath, 0o600); } catch (e) { console.error('[SECURITY] chmod 600 failed for', filePath, '-', e.message); }
}

// F-17: Server-side HTML escaping — mirrors app.js's escapeHtml(). User-controlled text
// (names, reasons, leave type labels) must not be interpolated raw into email HTML.
// Email clients vary in sanitization; escape at construction, not at render.
function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// F-13: Safe ID helper — reduce so the result is always a number even when array is
// empty or has records with missing/NaN id fields (both make Math.max return -∞/NaN).
// Call this immediately before push+save with no awaits between.
function nextId(arr) {
  return arr.reduce((m, x) => Math.max(m, Number(x.id) || 0), 0) + 1;
}

const app    = express();
// Cloudflare sits in front of this server (see manifest/CORS headers) and is the only hop
// between clients and here -- without this, Express reads every request's IP as Cloudflare's
// own edge IP instead of the real client's, so express-rate-limit's default IP-keyed limiter
// (loginLimiter below) buckets ALL users behind Cloudflare into one shared quota. Confirmed
// happening for real 2026-07-18: automated testing on one account exhausted the 8-per-15min
// login limit, then a different real user's own correct-password login got rejected too.
app.set('trust proxy', 1);
const server = http.createServer(app);
const wss    = new WebSocketServer({ server, path: '/ws' });

const DATA_DIR    = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_FILE     = path.join(DATA_DIR, 'events.json');
const USERS_FILE  = path.join(DATA_DIR, 'users.json');
const LEAVES_FILE  = path.join(DATA_DIR, 'leaves.json');
const FINALIZE_FILE = path.join(DATA_DIR, 'finalize.json');
const PHOTOS_DIR  = '/volume1/web/Time_Attendance/attendance/images/employees';

if (!fs.existsSync(DATA_DIR))    fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(DB_FILE))     fs.writeFileSync(DB_FILE, '[]');
if (!fs.existsSync(LEAVES_FILE))  fs.writeFileSync(LEAVES_FILE, '[]');
if (!fs.existsSync(FINALIZE_FILE)) fs.writeFileSync(FINALIZE_FILE, '{}');

// Serialize finalize.json read-modify-write so Accounting confirm and MD approve in two tabs
// cannot overwrite each other's update. Handlers are still sync; the chain just runs them one
// at a time if a later change adds an await inside.
let _finalizeChain = Promise.resolve();
function withFinalizeLock(handler) {
  return (req, res, next) => {
    _finalizeChain = _finalizeChain.then(
      () => handler(req, res, next),
      () => handler(req, res, next)
    ).catch(err => {
      if (!res.headersSent) {
        console.error('[FINALIZE] lock handler failed:', err && err.message);
        res.status(500).json({ success:false, message: (err && err.message) || 'Server error' });
      }
    });
  };
}

function makeHandlerLock(label) {
  let chain = Promise.resolve();
  return function withLock(handler) {
    return (req, res, next) => {
      chain = chain.then(
        () => handler(req, res, next),
        () => handler(req, res, next)
      ).catch(err => {
        if (!res.headersSent) {
          console.error(`[${label}] lock handler failed:`, err && err.message);
          res.status(500).json({ success:false, message: (err && err.message) || 'Server error' });
        }
      });
    };
  };
}
const withLeavesLock = makeHandlerLock('LEAVES');
const withEventsLock = makeHandlerLock('EVENTS');
const withUploadOwnersLock = makeHandlerLock('UPLOAD_OWNERS');

// Serializes every users.json read-modify-write, including callbacks that persist after an
// await (bcrypt, Hikvision door push). Same chain as withUsersLock so a password reset cannot
// clobber a concurrent profile save, and a late doorSync stamp cannot clobber either.
function makeAsyncLock(label) {
  let chain = Promise.resolve();
  function runExclusive(fn) {
    const p = chain.then(() => fn(), () => fn());
    chain = p.catch(err => {
      console.error(`[${label}] lock task failed:`, err && err.message);
    });
    return p;
  }
  function withHandler(handler) {
    return (req, res, next) => {
      runExclusive(() => handler(req, res, next)).catch(err => {
        if (!res.headersSent) {
          console.error(`[${label}] lock handler failed:`, err && err.message);
          res.status(500).json({ success:false, message: (err && err.message) || 'Server error' });
        }
      });
    };
  }
  return { runExclusive, withHandler };
}
const usersLock = makeAsyncLock('USERS');
const withUsersLock = usersLock.withHandler;
const runUsersLocked = usersLock.runExclusive;

// ===== JWT SECRET (persisted -- regenerating would invalidate every outstanding token) =====
const JWT_SECRET_FILE = path.join(DATA_DIR, 'jwt-secret.txt');
let JWT_SECRET;
if (fs.existsSync(JWT_SECRET_FILE)) {
  JWT_SECRET = fs.readFileSync(JWT_SECRET_FILE, 'utf8').trim();
} else {
  JWT_SECRET = randomBytes(48).toString('hex');
  fs.writeFileSync(JWT_SECRET_FILE, JWT_SECRET);
  console.log('[AUTH] Generated new JWT secret');
}
secureChmod(JWT_SECRET_FILE);

// ===== PUSH NOTIFICATIONS (web-push / VAPID) =====
const PUSH_SUBS_FILE = path.join(DATA_DIR, 'push-subscriptions.json');
if (!fs.existsSync(PUSH_SUBS_FILE)) fs.writeFileSync(PUSH_SUBS_FILE, '[]');
// SECURITY FIX 2026-08-04 (retrospective Opus audit, MEDIUM): contains webpush endpoint +
// auth/p256dh keys per subscriber -- was never chmod'd like the other secret-bearing files.
secureChmod(PUSH_SUBS_FILE);
function readPushSubs() {
  try { return JSON.parse(fs.readFileSync(PUSH_SUBS_FILE, 'utf8')); } catch(e) { return []; }
}
function writePushSubs(arr) { atomicWrite(PUSH_SUBS_FILE, JSON.stringify(arr, null, 2), true); }

// SECURITY FIX 2026-08-13 (P-2, Opus audit): the `web-push` library (v3.6.7, checked directly)
// does NOT validate `endpoint` beyond "is it a non-empty string" -- it's parsed with `url.parse()`
// and used verbatim as the target of the server's own outbound HTTPS request when a push actually
// sends. Without this allowlist, a client could register any HTTPS host+port as its own "push
// endpoint" and the server would dutifully connect to it (carrying a VAPID Authorization JWT
// signed with the server's private key) every time that user gets a notification -- an internal-
// network reachability probe from an authenticated account. Real browser-generated endpoints only
// ever come from one of these 5 real push services; anything else is definitionally not a
// legitimate subscription.
const PUSH_ENDPOINT_HOSTS = ['fcm.googleapis.com', 'android.googleapis.com', 'push.services.mozilla.com', 'notify.windows.com', 'web.push.apple.com'];
const PUSH_ENDPOINT_MAX = 2048;
const PUSH_KEY_P256DH_MAX = 200;
const PUSH_KEY_AUTH_MAX = 100;
const PUSH_SUBS_PER_USER_MAX = 10;
function isValidPushEndpoint(endpoint) {
  if (typeof endpoint !== 'string' || endpoint.length === 0 || endpoint.length > PUSH_ENDPOINT_MAX) return false;
  let u;
  try { u = new URL(endpoint); } catch(e) { return false; }
  if (u.protocol !== 'https:') return false;
  return PUSH_ENDPOINT_HOSTS.some(h => u.hostname === h || u.hostname.endsWith('.' + h));
}
function isValidPushKeys(keys) {
  return !!keys && typeof keys.p256dh === 'string' && keys.p256dh.length > 0 && keys.p256dh.length <= PUSH_KEY_P256DH_MAX &&
         typeof keys.auth === 'string' && keys.auth.length > 0 && keys.auth.length <= PUSH_KEY_AUTH_MAX;
}
// HYGIENE FIX 2026-08-13 (P-5, Opus audit): rows written before this fix existed can't be
// re-validated on the fly (this project's established precedent for this exact situation is the
// 2026-08-12 periodLocks fix -- filter what's already on disk through the same check new entries
// must now pass). Real subscriptions from real browsers will always pass this (they're already
// one of the 5 real push services); anything that doesn't was never a legitimate registration.
(function cleanupInvalidPushSubs() {
  // HYGIENE FIX 2026-08-16 (Opus cron/scheduled-jobs audit, H-1 footnote): writePushSubs() ->
  // atomicWrite() has no try/catch of its own -- a disk-full/permission error here at boot (before
  // server.listen()) would kill the process the same way the unguarded vapid-keys.json parse did,
  // just lower-probability since it only fires when invalid subs are actually present. Cheap to
  // guard, same reasoning as the fix just above.
  try {
    const subs = readPushSubs();
    const valid = subs.filter(s => isValidPushEndpoint(s.endpoint) && isValidPushKeys(s.keys));
    if (valid.length !== subs.length) {
      console.log(`[PUSH] boot cleanup: removed ${subs.length - valid.length} invalid subscription(s) of ${subs.length}`);
      writePushSubs(valid);
    }
  } catch (e) {
    console.error('[PUSH] boot cleanup failed -- continuing without it --', e.message);
  }
})();

const VAPID_FILE = path.join(DATA_DIR, 'vapid-keys.json');
let VAPID_KEYS;
// CORRECTNESS FIX 2026-08-16 (Opus cron/scheduled-jobs audit, H-1): this was the only module-scope
// JSON.parse(fs.readFileSync(...)) in the whole file with no try/catch -- every other reader
// (readPushSubs, readLeaves, readUsers, readJSON) swallows a parse error and falls back to an
// empty/null value. A truncated vapid-keys.json (power loss during the old non-atomic
// fs.writeFileSync below, or a partial restore) threw here BEFORE server.listen() ever runs --
// combined with the NAS watchdog auto-respawn, a permanent boot-crash loop recoverable only by
// hand-editing/deleting the file over SSH. Same failure mode the 2026-08-12 CRITICAL-2 cron fix
// was written to prevent for a different file; this sibling never got the same treatment. On a
// parse failure, regenerate a fresh keypair rather than crash -- this only invalidates existing
// push subscriptions (a browser must re-subscribe), never data.
let vapidParseFailed = false;
if (fs.existsSync(VAPID_FILE)) {
  try {
    VAPID_KEYS = JSON.parse(fs.readFileSync(VAPID_FILE, 'utf8'));
    if (!VAPID_KEYS || typeof VAPID_KEYS.publicKey !== 'string' || typeof VAPID_KEYS.privateKey !== 'string') {
      throw new Error('vapid-keys.json is missing publicKey/privateKey');
    }
  } catch (e) {
    vapidParseFailed = true;
    console.error('[PUSH] failed to parse vapid-keys.json -- regenerating a new keypair --', e.message);
  }
}
if (!fs.existsSync(VAPID_FILE) || vapidParseFailed) {
  VAPID_KEYS = webpush.generateVAPIDKeys();
  // Also fixes the non-atomic write this replaced (fs.writeFileSync directly on the real path) --
  // atomicWrite() writes to a .tmp file and renames over the target, so a crash mid-write can never
  // leave a truncated file behind again, matching every other secret-bearing file in this project.
  atomicWrite(VAPID_FILE, JSON.stringify(VAPID_KEYS, null, 2), true);
  console.log('[PUSH] Generated new VAPID keypair -- public key:', VAPID_KEYS.publicKey);
} else {
  secureChmod(VAPID_FILE);
}
webpush.setVapidDetails('mailto:tairo.b@hotmail.co.jp', VAPID_KEYS.publicKey, VAPID_KEYS.privateKey);

const PUSH_STATUS_TO_ROLE = { pending: 'manager', 'pending-accounting': 'accounting', 'pending-md': 'md' };

async function sendPushToUser(userId, payload) {
  if (userId == null) return;
  const subs = readPushSubs().filter(s => Number(s.userId) === Number(userId));
  // CORRECTNESS FIX 2026-08-13 (P-4, Opus audit): was a read-modify-write PER dead subscription,
  // each one racing any concurrent push send or a POST /api/push-subscribe landing in between --
  // could drop a just-added subscription or resurrect one that was just correctly removed. Collect
  // dead endpoints locally and do a single read/filter/write after the loop instead.
  const deadEndpoints = new Set();
  for (const s of subs) {
    try {
      // SECURITY FIX 2026-08-13 (P-2, Opus audit): no timeout was ever passed -- a hostile or
      // simply unreachable endpoint (see the endpoint-validation fix on the subscribe handler
      // below) hangs the socket until the OS TCP timeout, and every send in this loop (and every
      // sendPushToRole() fan-out, which awaits this per user) runs serially, so one bad endpoint
      // could stall every later recipient's notification for that event.
      await webpush.sendNotification({ endpoint: s.endpoint, keys: s.keys }, JSON.stringify(payload), { timeout: 10000 });
    } catch (e) {
      if (e.statusCode === 404 || e.statusCode === 410) {
        deadEndpoints.add(s.endpoint);
      } else {
        console.error('[PUSH] send error:', e.message);
      }
    }
  }
  if (deadEndpoints.size) {
    writePushSubs(readPushSubs().filter(x => !deadEndpoints.has(x.endpoint)));
  }
}

async function sendPushToRole(role, payload) {
  const users = readUsers() || [];
  for (const u of users.filter(u => u.active !== false && u.role === role)) {
    await sendPushToUser(u.id, payload);
  }
}

// Same turn-check as app.js isMyTurnOrDelegate() — used for the home-screen badge count so
// Accounting stand-in and stored approvalRoute stay in sync with the in-app red number.
function isServerMyTurn(leave, user, users) {
  if (!leave || !user) return false;
  // Requester never approves their own request (Manager self-queue trap).
  if (Number(leave.userId) === Number(user.id)) return false;
  const owner = (users || []).find(u => u.id === leave.userId);
  const routeType = routeKeyForLeave(leave, owner && owner.role);
  const turnRole = STATUS_TO_ROLE[leave.status];
  if (!turnRole) return false;
  const route = (Array.isArray(leave.approvalRoute) && leave.approvalRoute.length)
    ? leave.approvalRoute
    : getApprovalRoute(routeType);
  if (turnRole === user.role && route.includes(user.role)) return true;
  if (user.role === 'accounting' && turnRole !== 'accounting' && isApprovalDelegationActiveForType(routeType)
      && delegationCoversLeaveDate(leave)) return true;
  return false;
}

function badgeCountForUser(user) {
  if (!user) return 0;
  const leaves = readLeaves() || [];
  if (['manager', 'md', 'accounting'].includes(user.role)) {
    const users = readUsers() || [];
    return leaves.filter(l => isServerMyTurn(l, user, users)).length;
  }
  return leaves.filter(l =>
    l.userId === user.id &&
    (l.status === 'pending' || l.status === 'pending-md' || l.status === 'pending-accounting')
  ).length;
}

function notifyLeaveStatusChange(oldStatus, leave) {
  const typeName = typeof getTypeLabel === 'function' ? getTypeLabel(leave.type, 'en') : leave.type;
  const users = readUsers() || [];
  if (leave.status === 'approved' || leave.status === 'rejected') {
    const emp = users.find(u => u.id === leave.userId);
    sendPushToUser(leave.userId, {
      title: leave.status === 'approved' ? 'Request Approved' : 'Request Rejected',
      body: `Your ${typeName} request has been ${leave.status}`,
      tag: 'ta-leave',
      url: '/',
      badge: badgeCountForUser(emp)
    });
    // Email is opt-in per user (emp.emailNotifyOnResult) — only fires on the FINAL outcome
    // (approved/rejected), never on intermediate multi-step approval transitions.
    sendResultEmail(leave).catch(e => console.error('[EMAIL] result notify error:', e.message));
  } else if (PUSH_STATUS_TO_ROLE[leave.status] && leave.status !== oldStatus) {
    const role = PUSH_STATUS_TO_ROLE[leave.status];
    users.filter(u => u.active !== false && u.role === role).forEach(u => {
      const n = badgeCountForUser(u);
      sendPushToUser(u.id, {
        title: 'New Approval Request',
        body: n > 1
          ? `${n} requests need your approval`
          : `A ${typeName} request needs your approval`,
        tag: 'ta-approval',
        url: '/',
        badge: n
      });
    });
  }
}

// lang stored on the user record ('th'/'en'/'ja') — anything else falls back to 'th'
function emailLangOf(v) { return (v === 'en' || v === 'ja') ? v : 'th'; }

// Builds the type-specific detail rows shown in the result email (and could be reused
// elsewhere later) — mirrors the frontend's leaveTypeLabel()/buildApprovalCard() field mapping
// in app.js so the email shows the same facts an approver sees in the app (late-out return
// time, upcountry location/client, long-distance mileage, etc.), not just the bare date range.
function buildResultDetailRows(leave, lang) {
  const t = EMAIL_I18N[lang];
  const rows = [];
  if (leave.type === 'late-out' && leave.lateOutTime) {
    rows.push([t.lblReturnTime, leave.lateOutTime]);
  } else if (leave.type === 'upcountry') {
    // 2026-08-06: up to 6 separate time+customer/location stops -- one row per stop actually
    // filled in. Falls back to the old single `reason` string for any pre-2026-08-06 record shape.
    const locs = Array.isArray(leave.locations) && leave.locations.length
      ? leave.locations.filter(x => x && x.name)
      : (leave.reason ? [{ time: '', name: leave.reason }] : []);
    locs.forEach(loc => rows.push([t.lblLocation, loc.time ? `${loc.time} — ${loc.name}` : loc.name]));
  } else if (leave.type === 'long-distance') {
    if (leave.mileageStart != null || leave.mileageEnd != null) {
      rows.push([t.lblMileage, `${(leave.mileageStart || 0).toLocaleString()} → ${(leave.mileageEnd || 0).toLocaleString()}`]);
    }
    if (leave.distanceKm != null) rows.push([t.lblDistance, `${leave.distanceKm.toLocaleString()} km`]);
  } else if (leave.type === 'holiday-work') {
    if (leave.workStartTime && leave.workEndTime) {
      rows.push([t.lblWorkedDate, `${leave.workStartTime} – ${leave.workEndTime}`]);
    }
    if (leave.compensationMode === 'annual-leave') rows.push([t.lblReason, 'Annual leave +1 day']);
    else if (leave.compensationMode === 'paid') rows.push([t.lblReason, 'Paid compensation']);
    const hwLocs = Array.isArray(leave.locations) ? leave.locations.filter(x => x && x.name) : [];
    hwLocs.forEach(loc => rows.push([t.lblLocation, loc.name]));
  } else if (leave.type === 'early-morning') {
    if (leave.earlyMorningTier != null) rows.push([t.lblRate, `×${leave.earlyMorningTier}`]);
  } else if (leave.type === 'ot' || leave.type === 'driver-ot') {
    const hrs20 = Number(leave.otHours20) || 0;
    const hrs30 = Number(leave.otHours30) || 0;
    if (hrs20 > 0 || hrs30 > 0) {
      if (hrs20 > 0) rows.push([t.lblOtHours, `${hrs20} h ×2`]);
      if (hrs30 > 0) rows.push([t.lblOtHours, `${hrs30} h ×3`]);
    } else if (leave.otHours != null) {
      const mult = leave.otMultiplier != null ? ` ×${leave.otMultiplier}` : '';
      rows.push([t.lblOtHours, `${leave.otHours}${mult}`]);
    }
    if (leave.otEndTime) rows.push([t.lblReturnTime, leave.otEndTime]);
  } else if (leave.type === 'time-correction') {
    if (leave.correctedTime) rows.push([t.lblCorrectedTime, leave.correctedTime]);
  } else if (leave.type === 'personal-car') {
    if (leave.personalCarRate != null) rows.push([t.lblRate, `฿${Number(leave.personalCarRate).toLocaleString()}`]);
  }
  // Generic free-text reason, shown for every type that has one EXCEPT upcountry (its `reason`
  // field IS the location, already shown above as lblLocation — showing it twice would be a
  // pointless duplicate line).
  if (leave.reason && leave.type !== 'upcountry') rows.push([t.lblReason, leave.reason]);
  return rows;
}

// 2026-08-06: optional overrideTo/overrideLang params, same pattern already used by
// runPendingApprovalNotification() -- lets a test-only caller (POST /api/test-result-notification)
// preview the real template/HTML for any request type, in any language, without needing a real
// user with emailNotifyOnResult enabled. Both default to null/unused so every existing call site
// (notifyLeaveStatusChange(), the only real caller) is completely unaffected.
// 2026-09-24: alsoRevoked = records revoked together with this one (time-correction cascade),
// listed in one extra row of the same email.
async function sendResultEmail(leave, overrideTo, overrideLang, alsoRevoked) {
  const users = readUsers() || [];
  const emp = users.find(u => u.id === leave.userId);
  if (!overrideTo && (!emp || !emp.email || !emp.emailNotifyOnResult)) return;
  const transport = getEmailTransport();
  if (!transport) return;
  const cfg = readSettings().emailConfig || {};
  // FIX 2026-08-13 (5th re-audit, then TWO follow-up re-audits): overrideLang comes straight from
  // POST /api/test-result-notification's body.lang with no validation. Round 1 added a fallback only
  // where `t` was read (still left buildResultDetailRows() below crashing on its own unguarded
  // lookup). Round 2 tried `EMAIL_I18N[overrideLang]` as a "does this key exist" truthy check --
  // but that's a property lookup on a plain object, so `overrideLang:"constructor"` (or toString/
  // valueOf/__proto__/hasOwnProperty/etc.) resolves to an inherited Object-prototype value, which is
  // truthy -- the exact same prototype-chain-lookup bug class as the `SETTINGS_KEY_ROLES[key]`
  // fix earlier this session, just re-introduced here. `emailLangOf()` already exists as a strict
  // th/en/ja equality whitelist with no property access at all -- reuse it for BOTH the override and
  // the stored-preference fallback in one call, immune to this bug class by construction.
  const lang = emailLangOf(overrideLang || emp?.notifyLangEmail);
  const t = EMAIL_I18N[lang];
  const C = EMAIL_COLORS;
  const approved = leave.status === 'approved';
  // 2026-09-24 (owner): MD/Accounting took an approval back (POST /api/leaves/:id/revoke) -- same
  // opt-in and language, amber "Approval revoked" with who revoked it and why (escaped below).
  const revoked = leave.status === 'revoked';
  const statusColor = approved ? C.success : (revoked ? C.amber : C.danger);
  const statusBg = approved ? C.successBg : (revoked ? C.amberBg : C.dangerBg);
  const statusIcon = approved ? '✅' : (revoked ? '↩️' : '❌');
  const statusText = approved ? t.resultApproved : (revoked ? t.resultRevoked : t.resultRejected);
  const subject = revoked ? t.resultSubjectRevoked : t.resultSubject(approved);
  const dateRange = leave.dateFrom === leave.dateTo
    ? fmtEmailDateLong(new Date(leave.dateFrom + 'T12:00:00').getTime(), lang)
    : `${fmtEmailDateLong(new Date(leave.dateFrom + 'T12:00:00').getTime(), lang)} \u2013 ${fmtEmailDateLong(new Date(leave.dateTo + 'T12:00:00').getTime(), lang)}`;
  const detailRows = [[t.lblDate, dateRange], ...buildResultDetailRows(leave, lang)];
  if (revoked) {
    detailRows.push([t.lblRevokedBy, String(leave.revokedBy || '—')]);
    if (leave.revokeReason) detailRows.push([t.lblRevokeReason, String(leave.revokeReason)]);
    if (Array.isArray(alsoRevoked) && alsoRevoked.length) {
      detailRows.push([t.lblAlsoRevoked, alsoRevoked.map(r => `${getTypeLabel(r.type, lang)} (${r.dateFrom})`).join(', ')]);
    }
  }
  const detailHtml = detailRows.map(([label, value], i) => `<tr>
    <td style="padding:9px 0;${i < detailRows.length - 1 ? `border-bottom:1px solid ${C.border};` : ''}font-size:12px;color:${C.textFaint};width:38%;vertical-align:top">${label}</td>
    <td style="padding:9px 0;${i < detailRows.length - 1 ? `border-bottom:1px solid ${C.border};` : ''}font-size:13px;font-weight:600;color:${C.text}">${escapeHtml(value)}</td>
  </tr>`).join('');
  const bodyHtml = `
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:16px"><tr>
      <td width="32" style="width:32px;height:32px;border-radius:50%;background:${statusBg};text-align:center;font-size:16px;line-height:32px">${TYPE_ICONS[leave.type] || '📋'}</td>
      <td style="padding-left:10px;vertical-align:middle;font-size:15px;font-weight:700;color:${C.text}">${getTypeLabel(leave.type, lang)}</td>
    </tr></table>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:18px">${detailHtml}</table>
    <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
      <td style="background:${statusBg};border-radius:10px;padding:12px 16px">
        <span style="font-size:13px;font-weight:600;color:${statusColor}">${statusIcon} ${statusText}</span>
      </td>
    </tr></table>`;
  const html = emailShell({
    headerBg: `${statusColor}`,
    headerIcon: statusIcon,
    // FIX 2026-08-13: resultSubject() already bakes the same emoji in as a prefix (it doubles as
    // the mail subject line, where that's wanted) -- emailShell renders headerIcon in its own
    // <td> right next to headerTitle, so passing the raw string showed the icon twice.
    headerTitle: revoked ? t.resultRevoked : t.resultSubject(approved).replace(/^[✅❌]\s*/, ''),
    headerSubtitle: null,
    bodyHtml,
    footerText: t.footer
  });
  await transport.sendMail({
    from: `"${cfg.fromName || 'Time Attendance Application'}" <${cfg.user}>`,
    to: overrideTo || emp.email,
    subject,
    html
  });
  // SECURITY/CORRECTNESS FIX 2026-08-13 (Opus audit, F-4): was `emp.email` unconditionally -- when
  // `overrideTo` is set (the test-only caller) and `leave.userId` doesn't resolve to a real user,
  // `emp` is undefined and this line threw AFTER the mail had already sent, aborting
  // test-result-notification's loop with a confusing raw TypeError and no record of where the
  // message actually went. Also just wrong on the success path: it printed `emp.email` even when
  // the mail was actually routed to `overrideTo`.
  console.log('[EMAIL] result notification sent to', overrideTo || emp?.email, 'leave', leave.id, leave.status);
}

// ===== EVENTS =====
function readEvents() {
  try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch(e) {
    console.error('[EVENTS] readEvents failed:', e && e.message);
    return null;
  }
}
// LOW fix 2026-08-04 (retrospective Opus audit): events.json was never pruned/rotated -- it gets
// fully JSON.parse'd on every scan write, every /api/events call, every WS connect, and every
// health check. Fine at ~1200 records today, but unbounded. Pruned by `created_at` (always a real
// server-generated UTC ISO string, set on every record below) rather than the device-supplied
// `event_time`, which isn't uniformly formatted across older records.
// Attendance scan history. Approved payslips do NOT depend on this — they read frozen
// snapshots in finalize.json. 25 months covers live recompute of recent unapproved periods
// (attendance table / current Finalize). Do not raise this just to keep old slips viewable.
const EVENTS_RETENTION_MONTHS = 25;
// periodIndex 0 = current period. Must stay in lockstep with app.js PAYSLIP_PERIOD_COUNT
// so an employee can reopen an approved slip years later (paper copy lost).
const MAX_PERIOD_INDEX = 240;
function pruneOldEvents(events) {
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - EVENTS_RETENTION_MONTHS);
  const cutoffIso = cutoff.toISOString();
  return events.filter(e => !e.created_at || e.created_at >= cutoffIso);
}
function saveEvent(ev) {
  let events = readEvents();
  if (events === null) {
    const err = new Error('Service temporarily unavailable');
    err.statusCode = 503;
    throw err;
  }
  const record = { id: nextId(events), ...ev, created_at: new Date().toISOString() };
  events.push(record);
  events = pruneOldEvents(events);
  atomicWrite(DB_FILE, JSON.stringify(events, null, 2));
  return record;
}

// SECURITY FIX 2026-08-04 (Opus audit -- Hikvision integration): raw scan events (gps,
// holderName) used to be sent to ANY authenticated user via GET /api/events and to ANY
// websocket client. REST uses projectEventsForViewer; WS TODAY_EVENTS/SCAN_EVENT now do the
// same per connection (owner + privileged admin get the full row; colleagues get this projection).
// 2026-09-24: `gpsTz` (display-only zone of the GPS position) is deliberately absent, same as `gps`.
const EVENT_PUBLIC_FIELDS = ['id', 'employeeNo', 'event_time', 'eventType', 'created_at'];
function toPublicEventProjection(e) {
  const out = {};
  EVENT_PUBLIC_FIELDS.forEach(f => { if (f in e) out[f] = e[f]; });
  return out;
}

// ===== LEAVES =====
// SECURITY FIX 2026-08-13 (Opus audit, C-2): was `catch(e) { return []; }` -- indistinguishable
// from "the file genuinely contains an empty array" to every caller. A mutating handler
// (POST/PUT/DELETE /api/leaves, attachments/clear) that does readLeaves() -> mutate ->
// saveLeaves() would, on a transient read error (EMFILE, a momentary I/O hiccup), silently
// overwrite leaves.json with the empty array it just "read" -- total data loss from a
// non-destructive-looking request. Mirrors readUsers()'s existing null-on-failure contract
// (see readUsers() below) so every mutating caller can fail closed (503) instead. Read-only
// callers (GET /api/leaves, computePayroll(), etc.) fall back to `readLeaves() || []` at their
// own call site -- a transient read error there just means "show nothing this one request",
// not data loss, so failing open is fine and matches this file's existing tolerance elsewhere
// (see readUsers()'s own callers in the auth middleware).
function readLeaves() {
  try { return JSON.parse(fs.readFileSync(LEAVES_FILE, 'utf8')); } catch(e) { return null; }
}
function saveLeaves(arr) { atomicWrite(LEAVES_FILE, JSON.stringify(arr, null, 2)); }

// ===== USERS =====
// IMPORTANT: DEFAULT_USERS is used ONLY as a one-time seed when users.json does not exist.
// The live source of truth is data/users.json — do NOT overwrite it or reset this array
// without first exporting the current users.json content. Last synced: 2026-06-29.
// L7 (2026-08-02 Opus audit): these used to be plaintext '1234' literals. Inert either way (only
// read if users.json is missing entirely, which never happens in production) but plaintext
// passwords in source are a code smell worth removing outright rather than leaving for later.
// Each hash below is bcrypt('1234', BCRYPT_ROUNDS) -- same seed password as before, login behavior
// unchanged (isHashed() already routes these through bcrypt.compare()).
const DEFAULT_USERS = [
  { id:1,  employeeNo:'7',  username:'katagiri',   password:'$2b$10$10EPswn1T26jZlvu7tjPJ.6W324yCbva599e5KoMb2.soAPgTS.IS', name:'Daiki Katagiri',           facePhoto:'images/employees/emp_7.jpg',  role:'md',         dept:'Management',  position:'Managing Director', salary:0, idCard:'', phone:'', email:'Katagiri@tozai-jpn.co.jp',    address:'', startDate:'2024-01-01', bankName:'', bankAccount:'', emergencyContact:'', emergencyPhone:'', annualLeave:10, sickLeave:30, businessLeave:3, transport:3000, positionAllowance:10000, housing:5000, allowance3:0, pvdRate:5, active:false },
  { id:2,  employeeNo:'10', username:'takiuchi',   password:'$2b$10$ZqIiwaVUN5FNH87Hn6sj9.0IbH9cNWzxsbGzLCROL93Lx/i1UI2iG', name:'Toshifumi Takiuchi',      facePhoto:'images/employees/emp_10.jpg', role:'md',         dept:'Management',  position:'Managing Director', salary:0, idCard:'', phone:'', email:'Takiuchi@tozai-jpn.co.jp',    address:'', startDate:'2024-01-01', bankName:'', bankAccount:'', emergencyContact:'', emergencyPhone:'', annualLeave:10, sickLeave:30, businessLeave:3, transport:3000, positionAllowance:10000, housing:5000, allowance3:0, pvdRate:5, active:true },
  { id:3,  employeeNo:'1',  username:'loesan',     password:'$2b$10$PZPzd6CYNDGuoTsBBC.xa.Oj7SxS3Lc/M24e71MlyMRhcXYoxVNCi', name:'Loesan Siributwong',      facePhoto:'images/employees/emp_1.jpg',  role:'manager',    dept:'Operations',  position:'Manager',           salary:0, idCard:'', phone:'', email:'loesan@tozaiboeki.co.th',     address:'', startDate:'2024-01-01', bankName:'', bankAccount:'', emergencyContact:'', emergencyPhone:'', annualLeave:8,  sickLeave:30, businessLeave:3, transport:3000, positionAllowance:5000,  housing:3000, allowance3:0, pvdRate:5, active:true },
  { id:4,  employeeNo:'5',  username:'sirintorn',  password:'$2b$10$JNJQEoxWwX./QyNUdytut.cc4mYAlTlIIhCvsQezEtboyHrV.7dWC', name:'Sirintorn Torcharoensap', facePhoto:'images/employees/emp_5.jpg',  role:'accounting', dept:'Finance',     position:'Accounting',        salary:0, idCard:'', phone:'', email:'sirintorn@tozai-jpn.co.jp',   address:'', startDate:'2024-01-01', bankName:'', bankAccount:'', emergencyContact:'', emergencyPhone:'', annualLeave:8,  sickLeave:30, businessLeave:3, transport:3000, positionAllowance:2000,  housing:0,    allowance3:0, pvdRate:5, active:true },
  { id:5,  employeeNo:'2',  username:'prida',      password:'$2b$10$lUPQ80xmUIzYrZ6Nd8CWNOuyI1XuDybBaotOnOg/hXvWVq5TfBU7e', name:'Prida Srikhaetrai',       facePhoto:'images/employees/emp_2.jpg',  role:'user',       dept:'Engineering', position:'Engineer',          salary:0, idCard:'', phone:'', email:'prida@tozaiboeki.co.th',      address:'', startDate:'2024-01-01', bankName:'', bankAccount:'', emergencyContact:'', emergencyPhone:'', annualLeave:8,  sickLeave:30, businessLeave:3, transport:3000, positionAllowance:0,     housing:0,    allowance3:0, pvdRate:5, active:true },
  { id:6,  employeeNo:'3',  username:'somrak',     password:'$2b$10$5LSlZs05nLilWbgB24Rw0.FZPro/t/J/uMHT2.SSvDi4Iv8FnBMuO', name:'Somrak Likham',           facePhoto:'images/employees/emp_3.jpg',  role:'user',       dept:'Engineering', position:'Engineer',          salary:0, idCard:'', phone:'', email:'somrak@tozaiboeki.co.th',     address:'', startDate:'2024-01-01', bankName:'', bankAccount:'', emergencyContact:'', emergencyPhone:'', annualLeave:8,  sickLeave:30, businessLeave:3, transport:3000, positionAllowance:0,     housing:0,    allowance3:0, pvdRate:5, active:true },
  { id:7,  employeeNo:'9',  username:'teerawat',   password:'$2b$10$52uzj3HdXsYlvHr2pJ7JT.0JcgaWGWtwUsl/K1bmWPVW.dMwUHaZy', name:'Teerawat Rungraung',      facePhoto:'images/employees/emp_9.jpg',  role:'user',       dept:'Sales',       position:'Sales Engineer',    salary:0, idCard:'', phone:'', email:'teerawat@tozai-jpn.co.jp',    address:'', startDate:'2024-01-01', bankName:'', bankAccount:'', emergencyContact:'', emergencyPhone:'', annualLeave:8,  sickLeave:30, businessLeave:3, transport:3000, positionAllowance:0,     housing:0,    allowance3:0, pvdRate:5, active:true },
  { id:8,  employeeNo:'4',  username:'thitima',    password:'$2b$10$DInqmpkIp4Mq77xcUG1ohOzKwixrQnOxi5DNmLPmD0zBIswPhTU9O', name:'Thitima Phutain',         facePhoto:'images/employees/emp_4.jpg',  role:'marketing',  dept:'Marketing',   position:'Marketing',         salary:0, idCard:'', phone:'', email:'Thitima@tozai-jpn.co.jp',     address:'', startDate:'2024-01-01', bankName:'', bankAccount:'', emergencyContact:'', emergencyPhone:'', annualLeave:10, sickLeave:30, businessLeave:3, transport:3000, positionAllowance:0,     housing:0,    allowance3:0, pvdRate:3, active:true },
  { id:9,  employeeNo:'6',  username:'ratanavalee',password:'$2b$10$9IG4mrU8YauKj9DJtm0wkeqojH/P1YoxaTSLVW7tDPRQLixv6I9na', name:'Ratanavalee Pratumsila',  facePhoto:'',                           role:'user',       dept:'Sales',       position:'Sales Engineer',    salary:0, idCard:'', phone:'', email:'ratanavalee@tozaiboeki.co.th', address:'', startDate:'2024-01-01', bankName:'', bankAccount:'', emergencyContact:'', emergencyPhone:'', annualLeave:8,  sickLeave:30, businessLeave:3, transport:3000, positionAllowance:0,     housing:0,    allowance3:0, pvdRate:5, active:true },
  { id:10, employeeNo:'8',  username:'jaraspong',  password:'$2b$10$OzcKvRGLSwT5W4xiS3pZAOth1gtvhYOHq1QHea84Jr7V5/0vaRvrq', name:'Jaraspong Thawonjarensukko', facePhoto:'',                        role:'driver',     dept:'',            position:'Driver',            salary:0, idCard:'', phone:'', email:'',                            address:'', startDate:'2026-06-26', bankName:'', bankAccount:'', emergencyContact:'', emergencyPhone:'', annualLeave:8,  sickLeave:30, businessLeave:3, transport:3000, positionAllowance:0,     housing:0,    allowance3:0, pvdRate:5, active:true },
];

function readUsersRaw() {
  try { return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')); } catch(e) { return null; }
}
function readUsers() {
  const raw = readUsersRaw();
  if (raw === null) return null;
  const { users, changed } = systemAccount.ensureSystemAccounts(raw, bcrypt, BCRYPT_ROUNDS);
  if (changed) {
    try {
      atomicWrite(USERS_FILE, JSON.stringify(users, null, 2), true);
      console.log('[SYSTEM] Restored superadmin system account in users.json');
    } catch (e) {
      console.error('[SYSTEM] failed to persist restored system account:', e.message);
    }
  }
  return users;
}
function saveUsers(u) {
  const ensured = systemAccount.ensureSystemAccounts(u, bcrypt, BCRYPT_ROUNDS);
  atomicWrite(USERS_FILE, JSON.stringify(ensured.users, null, 2), true);
}

// Seed users.json once
if (!fs.existsSync(USERS_FILE)) {
  saveUsers(DEFAULT_USERS);
  console.log('[USERS] Seeded users.json with', DEFAULT_USERS.length, 'employees');
}
// Ensure the protected superadmin system account exists (re-created if deleted from users.json).
// AI POLICY: do not delete this bootstrap or skip ensureSystemAccounts in readUsers/saveUsers.
(function bootstrapSystemAccount() {
  const raw = readUsersRaw();
  if (!raw) return;
  const { users, changed } = systemAccount.ensureSystemAccounts(raw, bcrypt, BCRYPT_ROUNDS);
  if (changed) {
    atomicWrite(USERS_FILE, JSON.stringify(users, null, 2), true);
    console.log('[SYSTEM] Restored superadmin system account in users.json');
  }
})();
// SECURITY FIX 2026-08-04 (retrospective Opus audit, MEDIUM): bcrypt hashes + salary + bank
// account + idCard + emergency contacts for the whole company -- was never chmod'd. saveUsers()
// now passes sensitive:true to atomicWrite() on every future rewrite, but this covers the file
// as it already exists on disk from before this fix.
secureChmod(USERS_FILE);

// ===== BODY PARSER =====
app.use(express.raw({ type: '*/*', limit: '10mb' }));

// F-10: CORS restricted to known origins. Bearer-token auth means CSRF risk is low, but
// wildcard * is broader than needed — limits which sites can make credentialed cross-origin
// requests to this API. Hikvision device and LAN direct-access don't send Origin headers
// so they're unaffected by this middleware.
const ALLOWED_ORIGINS = [
  'https://attendance.tozaiboeki.co.th',
  'http://192.168.100.100',
  'http://192.168.100.100:3000',
];
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.header('Access-Control-Allow-Origin', origin);
    res.header('Vary', 'Origin');
  }
  res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Authorization,Content-Type,X-Filename');
  // Content-Disposition carries the payslip .xlsx filename (GET /api/payslip-xlsx) -- without
  // exposing it, fetch()'s Headers object hides it from JS on a cross-origin response even
  // though the download itself succeeds, so the frontend can't read the real filename.
  res.header('Access-Control-Expose-Headers', 'Content-Disposition');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ===== JWT AUTH ENFORCEMENT =====
// Public (no token required): login, health check, and the Hikvision device push endpoint
// (guarded separately below by IP allowlist -- a physical access-control device cannot do a
// browser JWT flow). SECURITY FIX 2026-07-19 (F-04): /api/upload used to be public too --
// removed. Letting anyone (even logged-out visitors, since this app sits on a public Cloudflare
// domain) POST arbitrary files and have them served back from this same origin was both open
// file hosting and a same-origin stored-XSS vector (upload an .html with <script>, share the
// link -- see download route below for the matching Content-Disposition fix).
const PUBLIC_PATHS = ['/api/login', '/api/health', '/api/push/vapid-public-key'];
app.use((req, res, next) => {
  // SECURITY FIX 2026-08-05 (Opus audit, CRITICAL): this was `req.path.startsWith('/api/')`
  // (case-sensitive), but Express's own router matches routes case-INsensitively by default
  // (`case sensitive routing` is off unless explicitly set) -- a request to `/API/users/9` (any
  // differently-cased /api/ prefix) failed this check, skipped this ENTIRE auth middleware via
  // the early `return next()`, then still matched the real lowercase route handlers further down
  // the chain. Confirmed live-exploitable: GET /API/leaves and GET/POST /API/upload never
  // reference req.user at all, so they ran fully unauthenticated (every employee's leave records,
  // including attachment filenames, plus arbitrary file read/write via /upload). Other routes
  // failed closed with a 500 (req.user.sub throws) rather than actually enforcing anything.
  // toLowerCase() closes the gap without changing Express's own case-insensitive routing (a global
  // `case sensitive routing` toggle risks unrelated side effects elsewhere; this is the minimal,
  // targeted fix for the actual bypass).
  if (!req.path.toLowerCase().startsWith('/api/')) return next(); // static frontend files, not API
  if (req.path === '/api/hikvision/event') return next(); // guarded by its own IP allowlist below
  if (PUBLIC_PATHS.some(p => req.path === p || req.path.startsWith(p + '/'))) return next();
  const m = /^Bearer (.+)$/.exec(req.headers['authorization'] || '');
  if (!m) return res.status(401).json({ success:false, message:'Unauthorized' });
  try {
    req.user = jwt.verify(m[1], JWT_SECRET);
    // Observer accounts are read-only everywhere. The JWT payload itself never carries live
    // status (it's frozen at login time), so any write attempt re-fetches the current user
    // record and rejects it here -- one shared check instead of touching every mutating route.
    //
    // SECURITY FIX 2026-07-19 (F-08): token revocation via tokenVersion. Tokens issued by
    // /api/login carry the user's tokenVersion at login time; PUT /api/users/:empNo/password
    // (self-service and admin reset) and PUT /api/users/:empNo/role bump it whenever a
    // password or role changes, so any token minted before that change stops working here on
    // its very next request -- even though it's still cryptographically valid and unexpired
    // (30d/12h expiry is unchanged; this is what makes early revocation possible without
    // shortening it). Folded into the same readUsers() call the Observer check already made
    // (was previously non-GET only) so this now runs on every request incl. GET, at the cost of
    // one extra file read per request -- accepted at this app's scale (~10 users).
    //
    // IMPORTANT: readUsers() returns null on a transient file-read error. Falling back to
    // DEFAULT_USERS here (as other callers do) would give every live user tokenVersion
    // undefined/0, so any already-issued token with tokenVersion > 0 would suddenly "mismatch"
    // and 401 out on a purely transient glitch -- a false mass-logout, not a real revocation.
    // Fail closed with 503 on every method (including GET) so a deactivated/revoked session
    // cannot keep reading /api/users /api/leaves /api/payslip-xlsx during the glitch; the
    // frontend treats 401 as logout but not 503, so this does not mass-log people out.
    const users = readUsers();
    if (users === null) {
      console.error('[AUTH] readUsers() failed during tokenVersion check');
      return res.status(503).json({ success:false, message:'Service temporarily unavailable' });
    } else {
      const liveUser = users.find(u => u.id === req.user.sub);
      if (!liveUser) {
        return res.status(401).json({ success:false, message:'Session expired -- please log in again' });
      }
      {
        const liveVersion  = liveUser.tokenVersion || 0;
        const tokenVersion = req.user.tokenVersion || 0;
        if (liveVersion !== tokenVersion) {
          return res.status(401).json({ success:false, message:'Session expired -- please log in again' });
        }
        if (req.method !== 'GET' && liveUser.isObserver === true) {
          return res.status(403).json({ success:false, message:'Observer accounts are read-only' });
        }
        // 2026-08-02: this only ever blocked isObserver on writes -- a DEACTIVATED account
        // (active===false) kept full write access to every route not additionally wrapped in
        // requireRole (e.g. POST/PUT /api/leaves) for the remaining life of its token. Mirrors
        // the isObserver check immediately above.
        if (req.method !== 'GET' && liveUser.active === false) {
          return res.status(403).json({ success:false, message:'This account has been deactivated' });
        }
        // SECURITY FIX 2026-09-23 (Opus audit MEDIUM-4): reads were still allowed, so a
        // deactivated md/accounting token could read every salary/bank/ID record via
        // GET /api/users. Login already refuses these accounts; refuse their reads too. Observers
        // are stored active:false by design and system accounts are exempt at login, so both keep
        // the same exemption here.
        if (liveUser.active === false && liveUser.isObserver !== true && !isSystemAccountUser(liveUser)) {
          return res.status(401).json({ success:false, message:'This account has been deactivated' });
        }
        // SECURITY FIX 2026-08-04 (Batch C, Hikvision audit): mustChangePassword was checked
        // client-side only (app.js) -- an account still on a seed/default password (e.g.
        // Hikvision sync-created new hires, see POST /api/users/sync-hikvision below) had full
        // write access everywhere via devtools/curl regardless of whether the UI ever showed the
        // "change password" gate. Self-service password change itself must stay allowed, or the
        // account could never clear the flag. Same check duplicated inside hikAuth()'s webscan
        // branch below, since that route bypasses this middleware entirely (see H3 fix above).
        if (req.method !== 'GET' && liveUser.mustChangePassword === true && req.path !== '/api/users/me/password') {
          return res.status(403).json({ success:false, message:'Please change your password before continuing' });
        }
      }
    }
    next();
  } catch (e) {
    return res.status(401).json({ success:false, message:'Invalid or expired token' });
  }
});

// SECURITY FIX 2026-07-19 (F-01): nothing below this point checked req.user.role at all -- any
// logged-in account (including plain "user") could hit any mutating endpoint directly (devtools
// fetch(), not through the UI) and, e.g., PUT its own role to "md", reset the MD's password, or
// approve its own OT. requireRole() re-fetches the live role from users.json rather than trusting
// req.user.role from the JWT payload, because that payload is frozen at login time -- someone
// demoted mid-session would otherwise keep acting with their old (already-issued) token's role
// until it expires. Mirrors the Observer check above, which has the same "trust live state, not
// the token" reasoning.
function isPrivilegedAdmin(live) {
  return !!(live && (['md', 'accounting'].includes(live.role) || isSuperAdminUser(live)));
}
function isLeaveFullAccess(live) {
  return !!(live && (['md', 'accounting', 'manager'].includes(live.role) || isSuperAdminUser(live)));
}
function roleAllowedByRequireRole(live, roles) {
  if (!live) return false;
  if (roles.includes(live.role)) return true;
  // superadmin inherits md/accounting/manager gates for developer QA (payroll-lock routes opt out separately)
  if (isSuperAdminUser(live) && roles.some(r => ['md', 'accounting', 'manager'].includes(r))) return true;
  return false;
}

function requireRole(...roles) {
  return (req, res, next) => {
    const users = readUsers();
    if (users === null) {
      return res.status(503).json({ success:false, message:'Service temporarily unavailable' });
    }
    const live = users.find(u => u.id === req.user.sub);
    // 2026-08-02: previously fell back to the JWT's frozen role (`req.user.role`) when the user
    // record was genuinely missing (e.g. deleted), which also skipped the isObserver/active
    // check below entirely -- a deleted account's still-valid token could keep writing through
    // any requireRole-gated endpoint with its old role until the token expired. Trust the live
    // record or refuse outright; never fall back to the token's frozen claim.
    if (!live) {
      return res.status(403).json({ success:false, message:'Forbidden: user record not found' });
    }
    if (!roleAllowedByRequireRole(live, roles)) {
      return res.status(403).json({ success:false, message:'Forbidden: insufficient role' });
    }
    // 2026-08-01: this only ever checked `role`, never observer/active status -- an
    // observer-flagged or deactivated account holding role 'md'/'accounting' could still write
    // through any endpoint gated by requireRole (blockIfObserver() is client-only). Found while
    // hardening the payroll-approval endpoints; applies to every protected endpoint at once.
    if (!isSuperAdminUser(live) && (live.isObserver || live.active === false)) {
      return res.status(403).json({ success:false, message:'Forbidden: observer or inactive account' });
    }
    next();
  };
}

// Payroll-lock actions (Finalize confirm, MD approve, email payslip, 50-Tawi override save) stay
// disabled for the developer system account even though it can view/export those pages.
function blockSuperAdminPayrollLock(req, res, next) {
  const users = readUsers();
  if (users === null) {
    return res.status(503).json({ success:false, message:'Service temporarily unavailable' });
  }
  const live = users.find(u => u.id === req.user.sub);
  if (isSuperAdminUser(live)) {
    return res.status(403).json({ success:false, message:'System account: payroll lock actions are disabled' });
  }
  next();
}

function parseBody(req) {
  const ct = (req.headers['content-type'] || '').toLowerCase();
  const buf = req.body;
  if (!buf || buf.length === 0) return {};
  if (ct.includes('application/json') || ct.includes('text/')) {
    try { return JSON.parse(buf.toString('utf8')); } catch(e) {}
  }
  if (ct.includes('multipart/form-data')) {
    const match = ct.match(/boundary=([^;]+)/);
    if (match) {
      const boundary = match[1].trim();
      const text = buf.toString('latin1');
      const parts = text.split('--' + boundary);
      for (const part of parts) {
        if (part.toLowerCase().includes('application/json')) {
          const sep = part.indexOf('\r\n\r\n');
          if (sep >= 0) {
            const jsonStr = part.substring(sep + 4).split('\r\n')[0];
            try { return JSON.parse(jsonStr); } catch(e) {}
          }
        }
      }
    }
  }
  try { return JSON.parse(buf.toString('utf8')); } catch(e) {}
  return {};
}

// ===== WEBSOCKET =====
const clients = new Set();

// SECURITY FIX 2026-08-13 (CRITICAL, Opus audit): this socket had NO authentication at all --
// confirmed live-exploitable: an unauthenticated handshake from the public ngrok URL, with no
// token and a forged Origin header, was accepted (101) and immediately received today's real
// scan-event data, and every USER_CREATED/UPDATED/USERS_SYNCED/LEAVE_* broadcast since (usernames,
// leave balances, leave type incl. 'sick', employeeNo/name/role/dept) went to literally anyone who
// could open a WS connection -- no login required. The REST side of this app requires a Bearer
// JWT on every request; this socket never asked for one. Browsers can't set a custom
// `Authorization` header on a WebSocket handshake, so the token travels as a `?token=` query
// param on the connection URL instead (app.js's initHikvisionLive() was updated to send it).
// Verifies the same way the main REST auth middleware does (signature + tokenVersion), so a
// logged-out/password-reset/role-changed session's stale token is rejected here too, not just on
// REST calls.
function authenticateWsRequest(req) {
  try {
    const q = new URL(req.url, 'http://localhost').searchParams;
    const token = q.get('token');
    if (!token) return null;
    const payload = jwt.verify(token, JWT_SECRET);
    const users = readUsers();
    if (users === null) return null;
    const live = users.find(u => u.id === payload.sub);
    if (!live || (live.tokenVersion || 0) !== (payload.tokenVersion || 0)) return null;
    // Mirror REST: a deactivated (non-observer) account must not keep a live scan/leave feed
    // for the remaining life of a remember-me JWT.
    if (live.active === false && live.isObserver !== true) return null;
    return payload;
  } catch (e) {
    return null;
  }
}

function handleWsConnection(ws, req, logPrefix) {
  const user = authenticateWsRequest(req);
  if (!user) {
    ws.close(1008, 'Unauthorized');
    return;
  }
  const users = readUsers() || [];
  const live = users.find(u => u.id === user.sub);
  ws.viewerCtx = {
    isFullAccess: isPrivilegedAdmin(live),
    leaveFullAccess: isLeaveFullAccess(live),
    ownNo: live ? String(live.employeeNo || '') : '',
    userId: user.sub,
    tokenVersion: user.tokenVersion || 0,
  };
  clients.add(ws);
  console.log(`[${logPrefix}] +client total=${clients.size} user=${user.username}`);
  const today = bangkokDateStr();
  const yest = bangkokPrevDateStr();
  const todayEvs = (readEvents() || []).filter(e => {
    const t = String(e.event_time || '');
    return t.startsWith(today) || t.startsWith(yest);
  });
  if (ws.readyState === 1) {
    ws.send(JSON.stringify({ type: 'TODAY_EVENTS', events: projectEventsForViewer(todayEvs, ws.viewerCtx) }));
  }
  ws.on('close', () => { clients.delete(ws); console.log(`[${logPrefix}] -client total=${clients.size}`); });
  ws.on('error', err => console.error(`[${logPrefix}] err:`, err.message));
}

wss.on('connection', (ws, req) => handleWsConnection(ws, req, 'WS'));

// SECURITY FIX 2026-09-23 (Opus audit MEDIUM-3): viewerCtx was fixed at connect time, so a
// socket opened before a demotion, deactivation or password reset kept receiving full scan events
// (GPS + cardholder name) until it happened to drop. Re-check every open socket against the live
// user record before each send: close it on a revoked token or deactivated account, and
// re-derive isFullAccess so a demotion takes effect immediately. One readUsers() per send, not
// per socket; if the read fails, keep the previous context rather than dropping everyone.
function refreshWsViewers() {
  const users = readUsers();
  if (users === null) return;
  clients.forEach(ws => {
    const ctx = ws.viewerCtx;
    if (!ctx) return;
    const live = users.find(u => u.id === ctx.userId);
    const revoked = !live || (live.tokenVersion || 0) !== ctx.tokenVersion ||
      (live.active === false && live.isObserver !== true);
    if (revoked) {
      clients.delete(ws);
      try { ws.close(1008, 'Session revoked'); } catch (e) { /* already closing */ }
      return;
    }
    ctx.isFullAccess = isPrivilegedAdmin(live);
    ctx.leaveFullAccess = isLeaveFullAccess(live);
    ctx.ownNo = String(live.employeeNo || '');
  });
}

function broadcast(d) {
  refreshWsViewers();
  const m = JSON.stringify(d);
  clients.forEach(ws => { if (ws.readyState === 1) ws.send(m); });
}

// 2026-09-24 (owner): a colleague's cancelled / revoked record is not shown to plain users --
// only the owner and md/accounting/manager (isLeaveFullAccess) see it. Used by GET /api/leaves and
// by every LEAVE_UPDATED broadcast (broadcastLeaveUpdated). Pure.
function isHiddenFromColleaguesStatus(s) {
  return s === 'cancelled' || s === 'revoked';
}
function leaveVisibleToViewer(l, viewerId, leaveFullAccess) {
  if (!l) return false;
  return !!leaveFullAccess || l.userId === viewerId || !isHiddenFromColleaguesStatus(l.status);
}
// LEAVE_UPDATED with the public projection for everyone who may see the record; a plain-user
// socket that may not see it (a colleague's record just turned cancelled/revoked) gets
// LEAVE_DELETED {id} instead, so its local copy drops the record.
function broadcastLeaveUpdated(l) {
  refreshWsViewers();
  const shownMsg = JSON.stringify({ type: 'LEAVE_UPDATED', leave: toPublicLeaveProjection(l) });
  const hiddenMsg = JSON.stringify({ type: 'LEAVE_DELETED', id: l.id });
  clients.forEach(ws => {
    if (ws.readyState !== 1) return;
    const ctx = ws.viewerCtx;
    ws.send(ctx && leaveVisibleToViewer(l, ctx.userId, ctx.leaveFullAccess) ? shownMsg : hiddenMsg);
  });
}

function sendScanEvent(record) {
  refreshWsViewers();
  const pubMsg = JSON.stringify({ type: 'SCAN_EVENT', ...toPublicEventProjection(record) });
  const fullMsg = JSON.stringify({ type: 'SCAN_EVENT', ...record });
  clients.forEach(ws => {
    if (ws.readyState !== 1) return;
    const ctx = ws.viewerCtx;
    if (ctx && (ctx.isFullAccess || String(record.employeeNo) === String(ctx.ownNo))) {
      ws.send(fullMsg);
    } else {
      ws.send(pubMsg);
    }
  });
}

// ===== HIKVISION DIGEST AUTH HELPER =====
// SECURITY FIX 2026-07-19 (F-07): admin password for the physical access-control device was
// hardcoded in source. Moved to a file-based secret under DATA_DIR (same pattern as
// JWT_SECRET_FILE / VAPID_FILE above) -- persists across NAS reboots and process restarts with
// zero deploy-script changes, unlike an env var which the deploy script's own restart command
// would need to re-inject every single deploy.
const HIK_SECRET_FILE = path.join(DATA_DIR, 'hikvision-secret.json');
let HIK;
if (fs.existsSync(HIK_SECRET_FILE)) {
  HIK = JSON.parse(fs.readFileSync(HIK_SECRET_FILE, 'utf8'));
} else {
  HIK = { host: '192.168.100.4', user: 'admin', pass: '' };
  fs.writeFileSync(HIK_SECRET_FILE, JSON.stringify(HIK, null, 2));
  console.log('[HIK] Created empty credentials file -- edit data/hikvision-secret.json and set the correct password before using Hikvision features');
}
secureChmod(HIK_SECRET_FILE);

function md5(s){ return createHash('md5').update(s).digest('hex'); }

// SECURITY FIX 2026-08-04 (Medium, Hikvision audit): (1) cnonce was hardcoded ('abcdef01') --
// replaced with a fresh random value per request (nc stays fixed at '1' since the device issues
// a brand-new server nonce on every challenge, so an incrementing counter wouldn't add any real
// protection). (2) neither request had a socket timeout -- a stalled/unreachable device response
// used to hang the caller (notably sync-hikvision's batch) forever. All exits (success, error,
// timeout) now funnel through one finish(), guarded by a `done` flag so a timeout that fires after
// the response already arrived can't double-invoke cb().
// SECURITY FIX 2026-08-04 (retrospective Opus audit, MEDIUM): the per-socket setTimeout()s below
// are IDLE timeouts -- each received byte resets them, so a device that dribbles a response body
// can keep a request alive indefinitely, and neither timer starts until its own request begins
// (so a stalled CHALLENGE request leaves the eventual authenticated request's timer never even
// armed). `overall` is a hard wall-clock deadline covering the whole two-request exchange,
// declared here so every caller (sync-hikvision, sync-name, event ingestion) inherits it
// uniformly instead of needing its own watchdog.
function hikRequest(method, hikPath, bodyBuf, contentType, cb) {
  const emptyHeaders = { 'Content-Length': '0' };
  if (contentType) emptyHeaders['Content-Type'] = contentType;

  let done = false;
  let r1;
  const overall = setTimeout(() => {
    try { r0.destroy(new Error('Hikvision request exceeded overall deadline')); } catch(e) {}
    if (r1) { try { r1.destroy(new Error('Hikvision request exceeded overall deadline')); } catch(e) {} }
    finish(new Error('Hikvision request exceeded overall deadline'), null, null);
  }, 20000);
  function finish(err, status, buf) {
    if (done) return;
    done = true;
    clearTimeout(overall);
    cb(err, status, buf);
  }

  const r0 = http.request({ host:HIK.host, port:80, path:hikPath, method, headers:emptyHeaders }, resp0 => {
    const www = resp0.headers['www-authenticate'] || '';
    resp0.resume();
    if (resp0.statusCode !== 401 || !www) return finish(new Error(`No challenge: HTTP ${resp0.statusCode}`), null, null);

    const realm = (www.match(/realm="([^"]+)"/) || [])[1] || '';
    const nonce = (www.match(/nonce="([^"]+)"/) || [])[1] || '';
    const ha1   = md5(`${HIK.user}:${realm}:${HIK.pass}`);
    const ha2   = md5(`${method}:${hikPath}`);
    const nc='00000001', cnonce=randomBytes(8).toString('hex');
    const rsp   = md5(`${ha1}:${nonce}:${nc}:${cnonce}:auth:${ha2}`);
    const auth  = `Digest username="${HIK.user}", realm="${realm}", nonce="${nonce}", uri="${hikPath}", qop=auth, nc=${nc}, cnonce="${cnonce}", response="${rsp}"`;

    const headers2 = { 'Authorization': auth, 'Content-Length': bodyBuf ? String(bodyBuf.length) : '0' };
    if (contentType) headers2['Content-Type'] = contentType;

    // BUG FIX 2026-08-04 (retrospective audit round 3, MEDIUM): this was `const r1`, which
    // created a new block-scoped binding here instead of assigning the outer `let r1` declared
    // above for the `overall` deadline timeout to reach -- the outer `r1` stayed undefined
    // forever, so `overall`'s `if (r1) r1.destroy(...)` never actually fired, and a device that
    // dribbles bytes (resetting r1's own 8s idle timer on every chunk) could hold this socket and
    // its `chunks` buffer open indefinitely despite the 20s overall deadline appearing to work
    // (the caller WAS correctly unblocked via `finish()`, just the socket itself leaked).
    r1 = http.request({ host:HIK.host, port:80, path:hikPath, method, headers:headers2 }, resp1 => {
      const chunks = [];
      resp1.on('data', c => chunks.push(c));
      resp1.on('end', () => finish(null, resp1.statusCode, Buffer.concat(chunks)));
      // Destroying r1 mid-stream (from the overall-deadline timeout) makes Node emit 'error' on
      // this IncomingMessage; without a listener that would fall through to the process-level
      // uncaughtException handler.
      resp1.on('error', () => {});
    });
    r1.on('error', e => finish(e, null, null));
    r1.setTimeout(8000, () => r1.destroy(new Error('Hikvision request timed out')));
    if (bodyBuf) r1.write(bodyBuf);
    r1.end();
  });
  r0.on('error', e => finish(e, null, null));
  r0.setTimeout(8000, () => r0.destroy(new Error('Hikvision challenge request timed out')));
  r0.end();
}

// ===== HIKVISION HELPERS (event ingestion sanitization) =====
// SECURITY FIX 2026-08-04 (Opus audit): server-generated Thai-local timestamp in the exact
// format the frontend already produces (doScan(), app.js).
// SECURITY FIX 2026-08-04 (retrospective Opus audit, HIGH): the original version of this
// function shifted Date.now() by +7h and then read LOCAL getters (via ta_localDateStr(), which
// itself uses getFullYear()/getMonth()/getDate()) -- correct only if the Node process's own OS
// timezone happens to be UTC. Every OTHER Thai-time helper in this file (see the other
// "Date.now() + 7*3600000" call sites) instead reads UTC getters after the same shift, which is
// timezone-independent regardless of what the NAS is actually set to. Switched to that proven
// convention directly (no longer calls ta_localDateStr()) so this doesn't silently drift by
// whatever offset the NAS's local timezone happens to differ from UTC by.
function bangkokYmd() {
  const d = new Date(Date.now() + 7 * 3600000);
  return {
    y: d.getUTCFullYear(),
    m: d.getUTCMonth(),
    day: d.getUTCDate(),
    h: d.getUTCHours(),
    min: d.getUTCMinutes(),
    s: d.getUTCSeconds()
  };
}
function bangkokTodayDate() {
  const { y, m, day } = bangkokYmd();
  return new Date(y, m, day);
}
function bangkokDateStr() {
  const { y, m, day } = bangkokYmd();
  const p2 = n => String(n).padStart(2, '0');
  return `${y}-${p2(m + 1)}-${p2(day)}`;
}
function bangkokPrevDateStr() {
  const d = bangkokTodayDate();
  d.setDate(d.getDate() - 1);
  const p2 = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
}
const DEFAULT_TZ = 'Asia/Bangkok';
function isSafeTimeZone(tz) {
  if (typeof tz !== 'string' || tz.length < 3 || tz.length > 64) return false;
  if (tz === 'UTC') return true;
  return /^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)+$/.test(tz);
}
function formatTzOffset(offsetMin) {
  const sign = offsetMin >= 0 ? '+' : '-';
  const abs = Math.abs(Math.round(offsetMin));
  const oh = String(Math.floor(abs / 60)).padStart(2, '0');
  const om = String(abs % 60).padStart(2, '0');
  return `${sign}${oh}:${om}`;
}
function ymdInTimeZone(ms, timeZone) {
  const tz = isSafeTimeZone(timeZone) ? timeZone : DEFAULT_TZ;
  const date = new Date(ms);
  const opts = {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false
  };
  let parts;
  try {
    parts = new Intl.DateTimeFormat('en-US', { ...opts, hourCycle: 'h23' }).formatToParts(date);
  } catch (e) {
    try {
      parts = new Intl.DateTimeFormat('en-US', opts).formatToParts(date);
    } catch (e2) {
      if (tz !== DEFAULT_TZ) return ymdInTimeZone(ms, DEFAULT_TZ);
      const d = new Date(ms + 7 * 3600000);
      return {
        y: d.getUTCFullYear(), m: d.getUTCMonth(), day: d.getUTCDate(),
        h: d.getUTCHours(), min: d.getUTCMinutes(), s: d.getUTCSeconds(),
        offsetMin: 7 * 60, timeZone: DEFAULT_TZ
      };
    }
  }
  const get = type => {
    const p = parts.find(x => x.type === type);
    return p ? p.value : '0';
  };
  const y = +get('year');
  const month = +get('month');
  const day = +get('day');
  let h = +get('hour');
  if (h === 24) h = 0;
  const min = +get('minute');
  const s = +get('second');
  const asUtc = Date.UTC(y, month - 1, day, h, min, s);
  const offsetMin = Math.round((asUtc - ms) / 60000);
  return { y, m: month - 1, day, h, min, s, offsetMin, timeZone: tz };
}
function isoFromYmd(ymd) {
  const p2 = n => String(n).padStart(2, '0');
  return `${ymd.y}-${p2(ymd.m + 1)}-${p2(ymd.day)}T${p2(ymd.h)}:${p2(ymd.min)}:${p2(ymd.s)}${formatTzOffset(ymd.offsetMin)}`;
}
function businessDateFromYmd(ymd) {
  const d = new Date(ymd.y, ymd.m, ymd.day);
  if (ymd.h < 5) d.setDate(d.getDate() - 1);
  const p2 = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
}
// 2026-09-23: a web scan's time no longer depends on the client's GPS (see the HIGH-1 fix in
// POST /api/hikvision/event).
// 2026-09-24 (owner): parseGpsCoords/timezoneFromCoords restored for a DISPLAY-ONLY field
// (`gpsTz` on the stored event) -- attendance views show the local time at the scan location on
// approved Abroad days. It never feeds event_time/timezone or any payroll/late computation.
function parseGpsCoords(raw) {
  if (typeof raw !== 'string') return null;
  const m = raw.trim().match(/^(-?\d{1,3}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)$/);
  if (!m) return null;
  const lat = Number(m[1]);
  const lng = Number(m[2]);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return { lat, lng };
}
let geoTzFind = null;
// Returns an IANA zone, or '' when unknown (never a fallback zone -- '' means "show nothing").
function timezoneFromCoords(lat, lng) {
  try {
    // geo-tz's default dataset ("alike since 1970") maps Bangkok coords to Asia/Jakarta; the
    // comprehensive one returns Asia/Bangkok / Asia/Tokyo as expected.
    if (!geoTzFind) geoTzFind = require('geo-tz/all').find;
    const zones = geoTzFind(lat, lng);
    const tz = Array.isArray(zones) ? zones[0] : '';
    // 2026-09-24 (review): Etc/* zones (open sea, no country) are not stored -- the Abroad
    // local-time note would only show a meaningless "GMT-7 time". DUAL-SYNC: app.js
    // abroadLocalTimeText / stampAbroadScan hide them too (older stored events).
    if (typeof tz === 'string' && tz.startsWith('Etc/')) return '';
    return isSafeTimeZone(tz) ? tz : '';
  } catch (e) {
    return '';
  }
}
function eventInstantMs(raw) {
  if (!raw) return 0;
  const t = Date.parse(raw);
  return Number.isFinite(t) ? t : 0;
}
function compareEventsByInstant(a, b) {
  return eventInstantMs(a && a.event_time) - eventInstantMs(b && b.event_time);
}
function eventBusinessDate(raw) {
  if (typeof raw !== 'string' || raw.length < 16) return '';
  const datePart = raw.substring(0, 10);
  const timePart = raw.substring(11, 16);
  const hour = parseInt(timePart.substring(0, 2), 10);
  if (!Number.isFinite(hour)) return datePart;
  if (hour >= 5) return datePart;
  const d = new Date(datePart + 'T00:00:00');
  d.setDate(d.getDate() - 1);
  const p2 = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
}
function webScanTimezoneForDate(employeeNo, dateStr) {
  if (!employeeNo || !dateStr) return '';
  const events = readEvents();
  if (!events) return '';
  let tz = '';
  for (const ev of events) {
    if (String(ev.employeeNo) !== String(employeeNo)) continue;
    if (ev.eventType !== 'WebScan') continue;
    if (eventBusinessDate(ev.event_time) !== dateStr) continue;
    if (ev.timezone && isSafeTimeZone(ev.timezone)) tz = ev.timezone;
  }
  return (tz && tz !== DEFAULT_TZ) ? tz : '';
}
function taNowIso() {
  return isoFromYmd(ymdInTimeZone(Date.now(), DEFAULT_TZ));
}
// H1 fix: the device is the source of truth for its own scan timestamps -- coerce-and-fall-back
// (never reject) rather than bounce a real scan for an odd format. A non-string or malformed
// dateTime used to be stored as-is and later crashed every reader that assumes a string
// (.startsWith()/.substring() throughout server.js and app.js).
function normalizeEventTime(raw) {
  if (typeof raw !== 'string') return taNowIso();
  const s = raw.trim();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(s)) return taNowIso();
  return s.slice(0, 40);
}
// C2 fix (storage-layer half -- the frontend render sites are fixed separately): gps is free
// text from the request body, rendered into the DOM on multiple pages. Whitelist the two shapes
// this app actually produces ("lat, lng" or the one literal "unknown location" string) -- anything
// else becomes ''.
function sanitizeGps(raw) {
  if (typeof raw !== 'string') return '';
  const s = raw.trim().slice(0, 64);
  if (s === 'ไม่ทราบตำแหน่ง') return s;
  return /^-?\d{1,3}(\.\d+)?\s*,\s*-?\d{1,3}(\.\d+)?$/.test(s) ? s : '';
}
// 2026-08-06 (user request): badge numbers enrolled on the physical Hikvision device that are
// deliberately NOT real employees (e.g. a shared emergency-access badge, employeeNo "6344") --
// `POST /api/users/sync-hikvision`'s new-employee auto-detection must never create a login/
// employee account for these, even though the device itself still enrolls and honors the badge
// exactly as before (this list is read-only on the app side; it never touches the device). Add a
// badge's employeeNo here (string, matching what the device reports) to keep it out of the app
// permanently -- re-running Sync from Hikvision will keep skipping it every time.
const HIKVISION_SYNC_EXCLUDE_EMPNOS = new Set(['6344']);
// H5 fix: hu.employeeNo comes straight from the device's own UserInfo/Search response and used
// to be used with no character whitelist to build a filesystem path (path.join(PHOTOS_DIR,
// `emp_${empNo}.jpg`)) -- a compromised/spoofed device response could write to an arbitrary path
// under the writable, statically-served web root. Mirrors the sanitization POST /api/upload
// already applies to filenames.
function isSafeEmpNo(s) {
  return typeof s === 'string' && /^[A-Za-z0-9_-]{1,16}$/.test(s);
}

// ===== DOOR ACCESS SYNC (2026-08-05, Opus-designed, see project memory
// project_time_attendance_2026_08_04_door_access_design) =====
// Mirrors the login-eligibility predicate exactly (the login handler below uses
// `u.active !== false || u.isObserver === true`): active employees open the door, Observers
// (e.g. a resigned MD who still visits the office) also open the door, a plain deactivated
// account does not. Deliberately NOT keyed on `active` alone -- `active` is the payroll roster
// flag (Finalize/bank export/MD-count all filter on it), so forcing an exception to be
// active:true just to keep someone's badge would silently put a resigned person back into
// payroll. Verified 2026-08-05 (independent Opus audit): this predicate is read-only, touches no
// payroll/roster logic anywhere.
function canOpenDoor(u) { return u.active !== false || u.isObserver === true; }

const HIK_DEFAULT_END = '2029-12-31T23:59:59';
function repairEndTime(x) {
  const t = x ? Date.parse(x) : NaN;
  if (Number.isNaN(t) || t < Date.now()) {
    if (x) console.warn(`[DOOR] repairing expired/invalid endTime "${x}" -> ${HIK_DEFAULT_END}`);
    return HIK_DEFAULT_END;
  }
  return x;
}

// Shared UserInfo/Search caller: Search + parse + the HIGH-2 loud-empty guard, in one place.
// 2026-08-06 (Opus re-audit gap): the 2026-08-05 fixes for the UserInfoSearchResponse/
// UserInfoSearch key bug and the HIGH-2 "total emptiness must be a loud error, not a per-employee
// skip" guard were both only ever applied inside the old hikSearchOne() -- the door-access audit
// endpoint, sync-hikvision, and sync-name each kept their own COPY of this exact Search+parse
// block, so a future parsing regression would still surface as a silent "nothing enrolled" in
// three of the four call sites instead of a loud failure. Every Search caller now goes through
// this one function.
// 2026-08-05 (Opus audit, MEDIUM-3): `maxResults` bumped 100 -> 1000 -- none of the callers
// paginate, so anyone past the first page would have silently read as "not on device" (a false
// skip, same failure shape as HIGH-2). 11 real employees today; 1000 is cheap headroom, not a
// real fix for unbounded growth -- revisit with real pagination if this device is ever enrolled
// with hundreds of users.
function hikSearchAll(cb) {
  const searchBody = Buffer.from(JSON.stringify({
    UserInfoSearchCond: { searchID:'1', maxResults:1000, searchResultPosition:0 }
  }), 'utf8');
  hikRequest('POST', '/ISAPI/AccessControl/UserInfo/Search?format=json', searchBody, 'application/json', (err, status, buf) => {
    if (err || status !== 200) return cb(new Error(`Hikvision search failed: ${err ? err.message : 'HTTP '+status}`));
    let hikUsers = [];
    try {
      const data = JSON.parse(buf.toString('utf8'));
      // BUG FIX 2026-08-05: the device's actual JSON response wraps results under "UserInfoSearch"
      // (no "Response" suffix), NOT "UserInfoSearchResponse" as this code originally assumed.
      // Confirmed via a direct --digest curl against the device:
      // `{"UserInfoSearch":{"numOfMatches":11,"UserInfo":[...]}}`. Checking both keys is the safe
      // fix (works whether the device is on the assumed shape or the real one).
      const ui = (data.UserInfoSearchResponse || data.UserInfoSearch)?.UserInfo;
      hikUsers = Array.isArray(ui) ? ui : (ui ? [ui] : []);
    } catch(e) { return cb(new Error('Parse error: '+e.message)); }
    // BUG FIX 2026-08-05 (Opus audit, HIGH-2, defense-in-depth): a wholesale-empty result is
    // ambiguous between "this device genuinely has zero enrolled users" (never true in practice --
    // it has always had this company's real employees on it) and "the response parsing silently
    // broke again". Treating total emptiness as an error instead of quietly falling through to
    // "not found" means a future parsing regression surfaces as a loud failure everywhere, not a
    // false "revoked successfully" on a door push that never actually reached the device.
    if (hikUsers.length === 0) {
      return cb(new Error('Hikvision search returned zero users -- device unreachable or response format changed, refusing to treat this as "employee not enrolled"'));
    }
    cb(null, hikUsers);
  });
}
function hikSearchOne(empNo, cb) {
  hikSearchAll((err, hikUsers) => {
    if (err) return cb(err);
    cb(null, hikUsers.find(hu => String(hu.employeeNo) === empNo) || null);
  });
}

// Read-modify-write helper for any device UserInfo mutation, serialized per employeeNo (a Map of
// chained Promises) so a status flip can never race a future name-sync fix or a second concurrent
// door-sync call for the same person. `mutate(deviceUserInfo)` returns the full UserInfo body to
// PUT. On a successful disable, re-Searches once to confirm it actually stuck (skipped on enable
// to save latency -- a false "still enabled" is the dangerous direction, a false "still disabled"
// is not).
const _hikModifyQueue = new Map();
function hikModifyUser(empNo, mutate, cb) {
  const prior = _hikModifyQueue.get(empNo) || Promise.resolve();
  // BUG FIX 2026-08-05 (Opus audit, HIGH-3): every exit path used to call the caller's `cb` BEFORE
  // `resolve()`. If `cb` threw (e.g. the PUT handler's callback below calls `saveUsers()`, which
  // can throw on a real disk error -- ENOSPC/EACCES/EIO are realistic on a NAS share), the throw
  // happened synchronously inside this executor's nested callback chain, which the `.catch()`
  // below CANNOT catch (that only catches promise rejections, not a throw thrown from inside an
  // already-invoked callback) -- so `resolve()` on that line never ran. That permanently stuck
  // this employeeNo's entry in `_hikModifyQueue` pending forever: every future door-sync attempt
  // for that person (via this PUT or the retry endpoint) would await a promise that never
  // resolves, always time out at 12s, indefinitely, until the whole process restarts -- exactly
  // the "can't open the door tomorrow" failure mode this feature exists to prevent. Fixed by
  // always resolving the queue FIRST (via a local `finish()` that's synchronous and un-throwable),
  // then invoking `cb` -- a throw from `cb` can no longer prevent the queue from advancing.
  //
  // BUG FIX 2026-08-06 (Opus re-audit, N-5): that HIGH-3 fix only covered a throw from `cb`
  // itself. `settled`/`finish()` are hoisted OUTSIDE the executor (shared with the outer
  // `.catch()` below, which now routes through `finish()` too instead of calling `cb` directly --
  // previously able to bypass the `settled` guard and double-invoke `cb`).
  //
  // BUG FIX 2026-08-06 (Opus re-audit ROUND 2, F5): the first pass at this wrapped the executor
  // body in ONE outer try/catch and assumed that covered every throw path -- it doesn't. A plain
  // try/catch only catches SYNCHRONOUS throws during the block it wraps; `hikSearchOne()`'s
  // callback (and the PUT-modify callback nested inside it) always fire later, via the event loop,
  // after the outer try has already returned -- so a throw from anything between `mutate()`
  // succeeding and `hikRequest()` being called (building `bodyBuf`, or `hikRequest` itself
  // throwing synchronously while registering the request) was NOT actually covered, despite the
  // outer try/catch appearing to wrap that code textually. Every async callback body in this chain
  // now has its OWN try/catch routing to `finishAndResolve`, so a throw at any point -- sync or in
  // any later callback -- always still resolves the queue.
  let settled = false;
  const finish = (err, result) => {
    if (settled) return;
    settled = true;
    // BUG FIX 2026-08-06 (Opus re-audit round 3): a throw from `cb` used to propagate out of
    // `finish()` into whichever async callback called it, which would catch it and call
    // `finishAndResolve(e)` AGAIN -- but `settled` is already true by then, so that second call
    // was silently discarded with no logging at all (pre-2026-08-05 F5 fix, the same throw at
    // least reached the process-level uncaughtException handler and got logged). Wrapping the
    // real `cb()` invocation here restores that visibility without letting a callback's own bug
    // re-enter this function or affect the (already-settled) queue outcome.
    try { cb(err, result); } catch (e) { console.error(`[DOOR] hikModifyUser callback threw for empNo=${empNo}:`, e.message); }
  };
  const run = prior.then(() => new Promise(resolve => {
    const finishAndResolve = (err, result) => { resolve(); finish(err, result); };
    try {
      hikSearchOne(empNo, (err, deviceUser) => {
        try {
          if (err) return finishAndResolve(err);
          if (!deviceUser) return finishAndResolve(null, { skipped:'not-on-device' });
          const body = mutate(deviceUser);
          const bodyBuf = Buffer.from(JSON.stringify({ UserInfo: body }), 'utf8');
          hikRequest('PUT', '/ISAPI/AccessControl/UserInfo/Modify?format=json', bodyBuf, 'application/json', (err2, status2) => {
            try {
              if (err2) return finishAndResolve(err2);
              if (status2 < 200 || status2 >= 300) return finishAndResolve(new Error(`Hikvision modify failed: HTTP ${status2}`));
              const wantEnable = body.Valid ? body.Valid.enable : undefined;
              if (wantEnable === false) {
                hikSearchOne(empNo, (err3, verifyUser) => {
                  try {
                    if (err3) return finishAndResolve(null, { ok:true, want:wantEnable, verified:false, verifyError:err3.message });
                    finishAndResolve(null, { ok:true, want:wantEnable, verified: !!(verifyUser && verifyUser.Valid && verifyUser.Valid.enable === false) });
                  } catch (e) { finishAndResolve(e); }
                });
              } else {
                finishAndResolve(null, { ok:true, want:wantEnable });
              }
            } catch (e) { finishAndResolve(e); }
          });
        } catch (e) { finishAndResolve(e); }
      });
    } catch (e) {
      resolve();
      finish(e);
    }
  })).catch(e => finish(e));
  _hikModifyQueue.set(empNo, run);
}

// employeeNo/name/userType are read from the DEVICE's own record, never from users.json -- a
// status flip must never silently rewrite the badge's display name, that stays sync-name's job.
function pushDoorAccess(empNo, want, cb) {
  // BUG FIX 2026-08-05 (Opus audit, MEDIUM-2): this used to build the Modify body from only 4
  // named fields (employeeNo/name/userType/Valid) -- Hikvision's UserInfo/Modify is generally a
  // replace, not a merge, so RightPlan/doorRight/maxOpenDoorTime/gender/numOfCard etc. risked
  // being silently reset to device defaults on every status flip. Live-tested against the real
  // device same session (employeeNo 8, disable->re-enable) and those fields DID survive
  // unchanged -- but that was one empirical data point on this specific firmware, not a proof for
  // all cases. Spreading `...dv` first (then overriding only what this function actually intends
  // to change) removes the risk class entirely instead of relying on that one observation.
  hikModifyUser(empNo, (dv) => ({
    ...dv,
    employeeNo: dv.employeeNo, name: dv.name, userType: dv.userType || 'normal',
    Valid: {
      ...dv.Valid,
      enable: want,
      beginTime: (dv.Valid && dv.Valid.beginTime) || '2024-01-01T00:00:00',
      endTime: want ? repairEndTime(dv.Valid && dv.Valid.endTime) : ((dv.Valid && dv.Valid.endTime) || HIK_DEFAULT_END)
    }
  }), cb);
}

// ===== HIKVISION PUSH ENDPOINT =====
// This endpoint is hit two ways: (1) the physical access-control device posts scan events
// directly and cannot perform a browser login/token flow -- allowed by IP; (2) the web app's
// own GPS self-check-in feature (see app.js, submits eventType:'WebScan') posts here too from
// an ordinary browser -- that path is not the device, so it must present a valid JWT instead.
const HIKVISION_ALLOWED_IPS = ['192.168.100.4', '::ffff:192.168.100.4'];

// SECURITY FIX 2026-08-04 (Opus audit, CRITICAL): the WebScan (browser) branch used to trust
// body.AccessControllerEvent.employeeNoString/cardholderName/dateTime/eventType completely --
// any logged-in non-observer account could POST someone ELSE's employeeNo with an arbitrary
// time/gps and have it saved as a real scan, feeding straight into payroll
// (buildAttendanceLogForUser -> generatePeriodDays -> computePayroll). Mirrors the fix already
// applied to POST /api/leaves (server-forced userId -- see that endpoint's F-02 comment). The
// device branch is untouched: it has no req.user at all and remains the source of truth for its
// own employeeNo.
function hikAuth(req, res, next) {
  // F-11: Intentionally req.socket.remoteAddress (TCP peer IP), NOT req.ip.
  // app.set('trust proxy',1) above makes req.ip read from X-Forwarded-For which any
  // client can spoof — send X-Forwarded-For: 192.168.100.4 and bypass this allowlist.
  // socket.remoteAddress is the actual TCP connection IP; the Hikvision device is on the
  // LAN and its IP cannot be forged from outside regardless of headers. Do not change to
  // req.ip without removing trust-proxy or adding CF-Connecting-IP verification first.
  const ip = req.socket.remoteAddress;
  if (HIKVISION_ALLOWED_IPS.includes(ip)) { req.hikSource = 'device'; return next(); }
  const m = /^Bearer (.+)$/.exec(req.headers['authorization'] || '');
  if (!m) return res.status(401).json({ success:false, message:'Unauthorized' });
  try {
    req.user = jwt.verify(m[1], JWT_SECRET);
    // Fail CLOSED here (unlike the global middleware's fail-open on a transient read error) --
    // this branch derives identity from the live record, so a readUsers() glitch must not fall
    // back to trusting the client body, which is exactly the hole this fix closes.
    const users = readUsers();
    if (users === null) return res.status(503).json({ success:false, message:'Service temporarily unavailable' });
    const live = users.find(u => u.id === req.user.sub);
    if (!live) return res.status(403).json({ success:false, message:'Forbidden: user record not found' });
    if ((live.tokenVersion || 0) !== (req.user.tokenVersion || 0)) {
      return res.status(401).json({ success:false, message:'Session expired -- please log in again' });
    }
    // Same Observer read-only rule as the main middleware.
    if (live.isObserver === true) {
      return res.status(403).json({ success:false, message:'Observer accounts are read-only' });
    }
    // H3 fix: this route used to short-circuit past the global middleware entirely (see the
    // PUBLIC_PATHS-adjacent bypass a few lines above the middleware), so a deactivated account's
    // still-valid token could keep clocking in for up to 30 days after being revoked elsewhere.
    if (live.active === false) {
      return res.status(403).json({ success:false, message:'This account has been deactivated' });
    }
    // Batch C fix 2026-08-04: same mustChangePassword gate as the global middleware -- this
    // route bypasses that middleware entirely (see H3 fix above), so without this it would be
    // the one remaining way to use a Hikvision-sync seed-password account without ever changing
    // the password (a WebScan check-in is a write, but not through the global middleware's path).
    if (live.mustChangePassword === true) {
      return res.status(403).json({ success:false, message:'Please change your password before continuing' });
    }
    if (!live.employeeNo) {
      return res.status(400).json({ success:false, message:'Account not linked to a device employee number' });
    }
    req.hikSource = 'webscan';
    req.hikUser = live;
    next();
  } catch (e) {
    return res.status(401).json({ success:false, message:'Invalid or expired token' });
  }
}
// Only the WebScan (browser) branch is throttled -- the physical device must never be rate
// limited here. Keyed per-account, matching the reasoning already established for loginLimiter
// (this is a single-office app behind one NAT'd IP, so IP-keying would punish everyone for one
// person's clicks).
const webScanLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.hikSource === 'device',
  keyGenerator: (req) => req.user ? `hikwebscan:${req.user.sub}` : ipKeyGenerator(req.ip),
  message: { success:false, message:'Too many check-in attempts -- please wait a moment' }
});

app.post('/api/hikvision/event', hikAuth, webScanLimiter, withEventsLock((req, res) => {
  try {
    const ct   = req.headers['content-type'] || '';
    const body = parseBody(req);
    const keys = Object.keys(body);
    console.log(`[HIK] ct=${ct.split(';')[0]}  keys=${keys.join(',') || 'EMPTY'}`);

    if (keys.length === 0 || (keys.length <= 3 && !body.AccessControllerEvent)) {
      return res.json({ success: true, message: 'heartbeat' });
    }

    let employeeNo, holderName, eventTime, eventType;
    const gps = sanitizeGps(body.gps);
    if (req.hikSource === 'webscan') {
      // Every field the client could otherwise forge is derived from the authenticated user's
      // own live record instead -- see the CRITICAL fix comment above hikAuth().
      // Clock: NAS instant only, always recorded in Bangkok time.
      // SECURITY FIX 2026-09-23 (Opus audit HIGH-1): the timezone used to come from the GPS
      // coordinates the client sends, and attendance reads the wall-clock text of event_time
      // while ignoring its offset -- so a spoofed location moved the recorded check-in/out by
      // hours (a 09:40 arrival "in Dubai" stored as 06:40, never late). GPS is client-controlled
      // and there is no geofence, so it must not decide the time. Days abroad are covered by the
      // approved Abroad request instead.
      employeeNo = String(req.hikUser.employeeNo);
      holderName = String(req.hikUser.name || '');
      eventTime  = taNowIso();
      eventType  = 'WebScan';
      req.hikTimezone = DEFAULT_TZ;
    } else {
      // SECURITY FIX 2026-08-04 (retrospective Opus audit, HIGH): this employeeNo used to flow
      // straight into loadDoorEvents() (app.js)'s `Employee ${empNo}` fallback and the saved
      // record with no cap or charset check at all -- unlike sync-hikvision's inbound path,
      // which already gates through isSafeEmpNo(). Reuses the "no employeeNo" reject-and-log
      // branch just below for an unsafe value too, rather than a silent 500 or storing it
      // unbounded; this is safe for real device traffic since production employeeNo values are
      // plain digits. holderName gets the same control-char-strip + 64-char cap sync-hikvision
      // already applies to its own rawName.
      const ev = body.AccessControllerEvent || {};
      const rawEmployeeNo = String(ev.employeeNoString || ev.cardNo || '');
      employeeNo = isSafeEmpNo(rawEmployeeNo) ? rawEmployeeNo : '';
      holderName = String(ev.cardholderName || '').split('').filter(ch => ch.charCodeAt(0) >= 32).join('').trim().slice(0, 64);
      eventTime  = normalizeEventTime(body.dateTime);
      eventType  = String(body.eventType || 'AccessControllerEvent');
    }

    if (!employeeNo) {
      console.log('[HIK] no employeeNo  body:', JSON.stringify(body).substring(0, 200));
      return res.json({ success: false, message: 'no employee number' });
    }

    const tz = req.hikSource === 'webscan' ? (req.hikTimezone || DEFAULT_TZ) : '';
    // 2026-09-24 (owner): DISPLAY-ONLY zone of the GPS position (Abroad days show the local time
    // there). Never touches event_time/timezone above. Like `gps`, it is not in
    // EVENT_PUBLIC_FIELDS, so only the owner and privileged admins receive it (REST + WS).
    let gpsTz = '';
    if (req.hikSource === 'webscan' && gps) {
      const coords = parseGpsCoords(gps);
      if (coords) gpsTz = timezoneFromCoords(coords.lat, coords.lng);
    }
    const record = saveEvent({
      employeeNo, holderName, event_time: eventTime, eventType,
      ...(gps ? { gps } : {}),
      ...(gpsTz ? { gpsTz } : {}),
      ...(tz ? { timezone: tz } : {})
    });
    // Per-viewer SCAN_EVENT: owner and privileged admins get gps/holderName; everyone else
    // gets the public projection. WS is authenticated (authenticateWsRequest); do not put GPS
    // on a single global payload.
    sendScanEvent(record);
    console.log(`[HIK] SAVED  emp=${employeeNo}  time=${eventTime}  tz=${tz || 'device'}  id=${record.id}`);
    res.json({ success: true, id: record.id, event_time: eventTime, ...(tz ? { timezone: tz } : {}), ...(gpsTz ? { gpsTz } : {}) });
  } catch (err) {
    console.error('[HIK] error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
}));

// ===== USER API =====
// SECURITY FIX 2026-07-19 (F-06): this used to strip only `password` and return every other
// field (salary, idCard, bankAccount, phone, address, emergencyContact, etc.) for EVERY user to
// ANY logged-in role -- a plain `user` account could read the whole company's salary/PII via
// devtools fetch('/api/users'). Fix: md/accounting keep full access (they run payroll and need
// it); everyone else gets the full record for their OWN row only (see CRITICAL TRAP note below)
// and a stripped "public projection" for everyone else's row.
//
// CRITICAL TRAP -- do not strip the requester's own record: a non-admin's `currentUser` in the
// frontend is overwritten from THIS endpoint's response on every page load / session restore
// (app.js loadUsersFromBackend()/restoreSession(), not just the login response) -- if the
// requester's own row is filtered down to the public projection, their own Profile > Financial
// Info tab and their own payslip silently lose salary/bank/idCard after any reload.
//
// PUBLIC_USER_FIELDS was chosen by grepping every app.js view that renders OTHER users' records
// for a non-admin viewer (Employees list for `manager`, dashboard check-in widget, today-leave
// modal, approval list/detail, attendance employee selector) -- these only ever read name/photo/
// role/dept/position/status/leave balances/username, never salary or PII, so trimming to this
// whitelist doesn't break any of them. (manager's Employees > Profile modal DOES currently show
// coworker idCard/phone/email/dob in its Personal tab for ANY other employee -- that's exactly
// the over-exposure this fix removes; those fields will now render as "-" for manager viewing a
// colleague, which is the intended fix, not a regression -- salary/bank were already gated
// separately by canSeeSalary in that same modal.)
const PUBLIC_USER_FIELDS = ['id', 'employeeNo', 'username', 'name', 'facePhoto', 'role', 'dept', 'position', 'active', 'isObserver', 'annualLeave', 'sickLeave', 'businessLeave', 'startDate'];
function toPublicUserProjection(u) {
  const out = {};
  PUBLIC_USER_FIELDS.forEach(f => { if (f in u) out[f] = u[f]; });
  // FIX 2026-08-13: the Holiday Calendar's birthday badge (app.js renderCalendarPage()) reads
  // dob off every DATA_USERS row, but this projection deliberately excludes raw `dob` (F-06,
  // 2026-07-19 -- full birthdate/age is exactly the kind of coworker PII that fix removed from
  // every non-md/accounting viewer). That silently broke the badge for manager/user/driver roles
  // -- they'd only ever see their OWN birthday, never a colleague's. Expose month+day only (never
  // the year, so age/exact birthdate still isn't revealed) so the calendar works for every role.
  if (typeof u.dob === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(u.dob)) out.birthdayMonthDay = u.dob.slice(5);
  return out;
}
// SECURITY FIX 2026-08-13 (5th re-audit): toPublicUserProjection()'s output also feeds the
// USER_CREATED/USER_UPDATED/USERS_SYNCED websocket broadcasts below, but that socket has NO auth
// at all (see the wss.on('connection') fix elsewhere in this file) -- unlike GET /api/users, which
// only ever reaches a logged-in coworker. birthdayMonthDay was reasoned about for that
// authenticated-coworker audience; broadcasting it to anyone who can open /ws without logging in
// is a strictly wider audience than intended. Strip it for the broadcast path specifically.
function toBroadcastUserProjection(u) {
  const { birthdayMonthDay, ...rest } = toPublicUserProjection(u);
  return rest;
}
app.get('/api/users', (req, res) => {
  const all = readUsers() || [];
  const visible = systemAccount.filterEmployeeRecords(all, req.user.sub);
  const live = all.find(u => u.id === req.user.sub);
  const role = live ? live.role : req.user.role;
  const isFullAccess = isPrivilegedAdmin(live);
  const users = visible.map(({ password, ...rest }) => {
    if (isFullAccess) return rest;
    if (live && rest.id === live.id) return rest; // own record: always full (see CRITICAL TRAP above)
    return toPublicUserProjection(rest);
  });
  res.json(users);
});

// Keyed by username, not IP: this is a single-office app -- everyone logs in through the same
// NAT'd public IP, so an IP-keyed limiter here would lock out the 9th person clocking in during
// the same morning rush after 8 colleagues on the same connection already logged in within the
// window (confirmed happening for real 2026-07-18, see trust-proxy note above -- that fix made
// req.ip correct again, but correct-and-shared is still shared). Per-username keeps each
// individual account's own budget protected from brute force without punishing everyone else on
// the same connection. loginLimiterByIp below is a much larger backstop against a single client
// hammering many different usernames.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 8,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    const body = parseBody(req);
    return (body && body.username) ? `user:${String(body.username).toLowerCase()}` : ipKeyGenerator(req.ip);
  },
  message: { success:false, message:'Too many login attempts -- try again later' }
});
const loginLimiterByIp = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success:false, message:'Too many login attempts -- try again later' }
});

app.post('/api/login', loginLimiterByIp, loginLimiter, async (req, res) => {
  try {
    const { username, password, remember } = parseBody(req);
    if (!username || !password) return res.status(400).json({ success:false, message:'username and password required' });
    // F-14: fail-closed — if users.json is unreadable, return 503 rather than falling
    // back to DEFAULT_USERS (which have password '1234') and allowing login with stale data.
    const users = readUsers();
    if (users === null) return res.status(503).json({ success:false, message:'Service temporarily unavailable — please try again shortly' });
    // Observer accounts (isObserver:true) are stored with active:false (same exclusion
    // treatment as a fully inactive/terminated employee everywhere else — payroll, archive,
    // etc.) but must still be able to authenticate, since they're allowed to browse read-only.
    const requested = String(username).trim().toLowerCase();
    const user = users.find(u => String(u.username || '').toLowerCase() === requested && (u.active !== false || u.isObserver === true || isSystemAccountUser(u)));
    if (!user) return res.status(401).json({ success:false, message:'Invalid credentials' });
    let ok = false;
    if (isHashed(user.password)) {
      ok = await bcrypt.compare(String(password), user.password);
    } else {
      ok = user.password === String(password);
      if (ok) {
        const hash = await bcrypt.hash(String(password), BCRYPT_ROUNDS);
        const all = readUsers() || [];
        const idx = all.findIndex(u => u.id === user.id);
        if (idx >= 0) { all[idx].password = hash; saveUsers(all); }
        console.log('[AUTH] migrated password hash for', user.username);
      }
    }
    if (!ok) return res.status(401).json({ success:false, message:'Invalid credentials' });
    const { password: _, ...safeUser } = user;
    // F-08: tokenVersion is stamped into the token so it can be revoked early (password reset /
    // role change bump it) without touching expiresIn -- 8h matches the client inactivity timer.
    const token = jwt.sign({ sub: user.id, username: user.username, role: user.role, tokenVersion: user.tokenVersion || 0 }, JWT_SECRET, { expiresIn: remember === true ? '30d' : '8h' });
    res.json({ success:true, user: safeUser, token });
  } catch(e) {
    console.error('[LOGIN] error:', e.message);
    res.status(500).json({ success:false, message:'Server error' });
  }
});

// SECURITY FIX 2026-08-04 (4th Opus audit, CRITICAL): app.js used to hardcode the VAPID public
// key as a string literal -- when VAPID_FILE was rotated today, the frontend's copy went stale
// and every push subscription silently failed (browser binds to the old public key, backend
// signs with the new private key, the push service rejects every send). Public key, no auth
// needed -- it's meant to be handed to any browser that's about to subscribe.
app.get('/api/push/vapid-public-key', (req, res) => {
  res.json({ publicKey: VAPID_KEYS.publicKey });
});

// ===== PUSH SUBSCRIBE =====
// SECURITY FIX 2026-08-13 (P-1, Opus audit): no rate limit existed on this route at all -- mirrors
// testEmailLimiter/sendPayslipLimiter's per-account keying (this office sits behind one NAT, so
// IP-keying would punish everyone for one bad token).
const pushSubscribeLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.user ? `pushsub:${req.user.sub}` : ipKeyGenerator(req.ip),
  message: { success:false, message:'Too many subscription attempts -- please wait before trying again' }
});
// SECURITY FIX 2026-08-13 (P-0, Opus audit): the old comment ("userId is null here until the
// Stage 3 JWT-verify middleware is live -- temporary, closed in Stage 3") and the `req.user ?
// req.user.sub : null` ternary both described a state that no longer exists -- confirmed this
// route is NOT in PUBLIC_PATHS, so the global auth middleware (registered before every route in
// this file) always runs first and always populates req.user here. Left as-is, the stale comment
// actively misleads a future reader into thinking unauthenticated subscribes are expected; the
// dead `: null` branch is now replaced with an explicit fail-closed 401, so if this route is ever
// added to PUBLIC_PATHS later, it refuses instead of silently writing an orphaned, userId-less row
// (sendPushToUser() already no-ops on userId==null, so such a row would just be permanent litter).
app.post('/api/push-subscribe', pushSubscribeLimiter, (req, res) => {
  const userId = req.user && req.user.sub;
  if (userId == null) return res.status(401).json({ success:false, message:'Unauthorized' });
  const { subscription } = parseBody(req);
  if (!subscription) return res.status(400).json({ success:false, message:'subscription required' });
  // SECURITY FIX 2026-08-13 (P-2, Opus audit): endpoint must be an HTTPS URL on a real push
  // service host (see isValidPushEndpoint() above) -- otherwise the server's own outbound push-
  // send request goes wherever the client says. keys are shape/length-checked (P-1) and only the
  // two expected fields are ever stored -- never the raw client object -- matching this file's
  // "construct the literal, never spread the body" discipline used for every other write-bearing
  // endpoint today.
  if (!isValidPushEndpoint(subscription.endpoint)) {
    return res.status(400).json({ success:false, message:'subscription.endpoint must be a valid push service URL' });
  }
  if (!isValidPushKeys(subscription.keys)) {
    return res.status(400).json({ success:false, message:'subscription.keys is invalid or missing' });
  }
  const subs = readPushSubs();
  const idx = subs.findIndex(s => s.endpoint === subscription.endpoint);
  const entry = {
    userId,
    endpoint: subscription.endpoint,
    keys: { p256dh: subscription.keys.p256dh, auth: subscription.keys.auth },
    ua: String(req.headers['user-agent'] || '').substring(0, 300),
    createdAt: new Date().toISOString()
  };
  if (idx >= 0) {
    subs[idx] = entry;
  } else {
    // SECURITY FIX 2026-08-13 (P-1, Opus audit): no cap existed on how many subscriptions one
    // account could register -- evict the oldest of this user's own subscriptions past the cap
    // rather than growing push-subscriptions.json unboundedly (it's read synchronously on every
    // single push send, see sendPushToUser() above).
    const mine = subs.filter(s => s.userId === userId).sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));
    while (mine.length >= PUSH_SUBS_PER_USER_MAX) {
      const oldest = mine.shift();
      const oldIdx = subs.findIndex(s => s.endpoint === oldest.endpoint);
      if (oldIdx >= 0) subs.splice(oldIdx, 1);
    }
    subs.push(entry);
  }
  writePushSubs(subs);
  res.json({ success:true });
});

// SECURITY/CORRECTNESS FIX 2026-08-13 (P-3, Opus audit): no unsubscribe route existed anywhere --
// logout() only cleared client-side session state, so a shared/kiosk browser kept the previous
// user's endpoint bound in push-subscriptions.json forever (only a push-service 404/410 ever
// removed an entry). The next employee to use that browser would keep receiving the PREVIOUS
// user's notifications on their lock screen -- including sick/maternity-leave-adjacent wording
// from notifyLeaveStatusChange()'s push bodies. Ownership-scoped: only removes a row that belongs
// to the caller's own account, so this can't be used to unsubscribe someone else.
app.delete('/api/push-subscribe', pushSubscribeLimiter, (req, res) => {
  const userId = req.user && req.user.sub;
  if (userId == null) return res.status(401).json({ success:false, message:'Unauthorized' });
  const { endpoint } = parseBody(req);
  if (typeof endpoint !== 'string' || !endpoint) return res.status(400).json({ success:false, message:'endpoint required' });
  const subs = readPushSubs();
  const next = subs.filter(s => !(s.endpoint === endpoint && Number(s.userId) === Number(userId)));
  if (next.length !== subs.length) writePushSubs(next);
  res.json({ success:true });
});

app.post('/api/push-test', pushSubscribeLimiter, async (req, res) => {
  const userId = req.user && req.user.sub;
  if (userId == null) return res.status(401).json({ success:false, message:'Unauthorized' });
  const subs = readPushSubs().filter(s => Number(s.userId) === Number(userId));
  if (!subs.length) {
    return res.status(400).json({ success:false, message:'No push subscription for this account' });
  }
  try {
    const me = (readUsers() || []).find(u => u.id === userId);
    const n = badgeCountForUser(me);
    await sendPushToUser(userId, {
      title: '🔔 Test Notification',
      body: n > 0
        ? `Notification is working! ${n} request(s) waiting.`
        : 'Notification is working!',
      tag: 'test',
      badge: n
    });
    res.json({ success:true });
  } catch (e) {
    console.error('[PUSH] test send failed:', e.message);
    res.status(500).json({ success:false, message:'Could not send test notification' });
  }
});

// Was missing entirely — "Add Employee" in the frontend only pushed to in-memory MOCK_USERS
// and was lost on refresh. Backend now assigns the real id (client-side counters can collide
// across concurrent sessions).
app.post('/api/users', requireRole('md', 'accounting', 'manager'), withUsersLock((req, res) => {
  const body = parseBody(req);
  const sysErr = systemAccount.assertNotCreatingSystemAccount(body);
  if (sysErr) return res.status(400).json({ success:false, message: sysErr });
  if (!body.username || !body.name) {
    return res.status(400).json({ success:false, message:'username and name are required' });
  }
  // SECURITY FIX 2026-08-13 (Opus audit): the two password-CHANGE routes below both enforce
  // passwordPolicyError() (PASSWORD_MIN_LENGTH=8 + letters+numbers, added 2026-07-19 specifically
  // because the old 4-char minimum let '1234' through) -- creation never did, so a weak seed
  // password was live and usable until the mustChangePassword gate caught it on first login. The
  // frontend's own passwordPolicyError() is meant to already block this from the Add Employee
  // form, so this only matters for someone bypassing the UI (direct API call).
  if (body.password) {
    const policyErr = passwordPolicyError(body.password);
    if (policyErr) return res.status(400).json({ success:false, message: policyErr });
  }
  const users = readUsers();
  if (users === null) return res.status(503).json({ success:false, message:'Service temporarily unavailable' });
  if (users.find(u => String(u.username || '').toLowerCase() === String(body.username || '').trim().toLowerCase())) {
    return res.status(400).json({ success:false, message:'Username already exists' });
  }
  const live = users.find(u => u.id === req.user.sub);
  const isFullAdmin = isPrivilegedAdmin(live);
  // CRITICAL FIX 2026-08-03 (Opus audit): this endpoint used to spread the raw body with no
  // field/role filtering at all -- the "Add Employee" button is hidden from manager client-side,
  // but nothing stopped a manager from POSTing {role:'md', ...} directly and self-promoting to a
  // full Managing Director account. PUT /api/users/:empNo was already hardened this way
  // (2026-08-02) -- manager gets the same SELF_SERVICE_PROFILE_FIELDS whitelist there, so a new
  // account a manager creates gets it here too, plus the handful of fields genuinely needed to
  // bootstrap a brand-new record (username/password/name/dob/gender/position) that don't exist on
  // an edit. role is always forced to 'user' and every financial/leave field gets a safe default,
  // regardless of what the client sent.
  // SECURITY FIX 2026-08-13 (Opus audit): the full-admin branch below (isFullAdmin = md OR
  // accounting) passed `body` straight through with zero role validation -- the exact bug class
  // the 2026-08-03 fix above closed for `manager`, left wide open here. An `accounting` account
  // could POST {role:'md', ...} and mint itself (or anyone) a brand-new full Managing Director
  // account, bypassing the md-only gate on PUT /api/users/:empNo/role entirely. Mirrors that
  // route's own role whitelist (handleRoleUpdate, below) plus a stricter rule: only an existing MD
  // may create another MD account -- accounting can create any other role, but not 'md' itself.
  if (isFullAdmin) {
    const ROLE_ENUM = ['md', 'manager', 'accounting', 'user', 'driver', 'marketing'];
    if (body.role !== undefined && !ROLE_ENUM.includes(body.role)) {
      return res.status(400).json({ success:false, message:'Invalid role. Allowed: md, manager, accounting, user, driver, marketing' });
    }
    if (body.role === 'md' && live.role !== 'md' && !isSuperAdminUser(live)) {
      return res.status(403).json({ success:false, message:'Only a Managing Director can create another Managing Director account' });
    }
    // 2026-08-17: same enum/cap validation as handleUserUpdate()'s isFullAdmin branch -- there is
    // no prior record here, so `body` IS the resolved value (no merge needed). Reject with 400
    // rather than silently drop, matching this block's existing style for `role` above.
    if (body.namePrefix !== undefined) {
      if (!NAME_PREFIX_VALUES.includes(body.namePrefix ?? '')) {
        return res.status(400).json({ success:false, message:'Invalid namePrefix' });
      }
      // 2026-08-17 (review fix): `?? ''` above only widened the CHECK to accept null -- without
      // this, an explicit JSON null passed the check but was then stored verbatim as `null`
      // rather than the canonical `''` every other absent-value site in this codebase uses.
      if (body.namePrefix == null) body.namePrefix = '';
    }
    for (const [k, cap] of Object.entries(NEW_PROFILE_STRING_CAPS)) {
      if (body[k] !== undefined && (typeof body[k] !== 'string' || body[k].length > cap)) {
        return res.status(400).json({ success:false, message:`Invalid ${k}` });
      }
    }
  }
  let userData = body;
  if (!isFullAdmin) {
    const safeDefaults = {
      role: 'user', dept: '', position: 'Staff',
      salary: 0, idCard: '', phone: '', email: '', address: '',
      startDate: new Date(Date.now() + 7*3600000).toISOString().split('T')[0],
      endDate: '', bankName: '', bankAccount: '',
      emergencyContact: '', emergencyRelation: '', emergencyPhone: '',
      annualLeave: 6, sickLeave: sickLeaveEntitlementDays(), businessLeave: businessLeaveEntitlementDays(),
      transport: 0, positionAllowance: 0, housing: 0, allowance3: 0, pvdRate: 5,
      active: true
    };
    const MANAGER_CREATE_FIELDS = [...SELF_SERVICE_PROFILE_FIELDS, 'username', 'password', 'name', 'firstName', 'lastName', 'dob', 'gender', 'position'];
    userData = { ...safeDefaults };
    MANAGER_CREATE_FIELDS.forEach(k => { if (body[k] !== undefined) userData[k] = body[k]; });
    userData.role = 'user'; // never trust body.role, even though it's already excluded above
  }
  // F-09: any brand-new employee must change their password on first login, regardless of who
  // picked the initial one (admin-entered or default) -- lazy flag, no effect on existing users.
  const newUser = { ...userData, id: nextId(users), mustChangePassword: true };
  // BUG FIX 2026-08-06 (Opus re-audit, N-1, same fix as sync-hikvision's finalizeUser()): hash
  // whatever password was set (admin-entered or a manager's default) immediately instead of
  // leaving it in plaintext in users.json until the account's first login lazily migrates it.
  if (newUser.password && !isHashed(newUser.password)) {
    newUser.password = bcrypt.hashSync(String(newUser.password), BCRYPT_ROUNDS);
  }
  users.push(newUser);
  saveUsers(users);
  // SECURITY FIX 2026-08-04 (retrospective audit round 3, HIGH): the websocket has no auth at all
  // (see the SECURITY FIX comment above wss.on('connection')) -- broadcasting the full record
  // sent the plaintext seed password ('1234' or whatever the creating admin chose), salary,
  // idCard, bankAccount and emergencyPhone to every connected client, authenticated or not. The
  // HTTP response below still returns the full record to the admin who made this request.
  broadcast({ type: 'USER_CREATED', user: toBroadcastUserProjection(newUser) });
  res.json({ success:true, user: newUser });
}));

// FIX: lookup by employeeNo ONLY (previously also matched u.id which caused wrong user to be found)
// 2026-08-06 (round 4 of the door-access re-audit chain): shared by both role routes below, same
// reason as handleUserUpdate() -- an employeeNo-less employee (see that function's comment) had
// no way to have their role changed at all, silently, since only an :empNo-keyed route existed.
function handleRoleUpdate(req, res, users, idx) {
  if (isSystemAccountUser(users[idx])) {
    return res.status(403).json({ success:false, message:'Not allowed' });
  }
  const { role } = parseBody(req);
  const allowed = ['md', 'manager', 'accounting', 'user', 'driver', 'marketing'];
  if (!role || !allowed.includes(role)) {
    return res.status(400).json({ success:false, message:'Invalid role. Allowed: md, manager, accounting, user, driver, marketing' });
  }
  // Server-side safety net (mirrors the frontend check): never leave zero active MDs, since
  // that would remove anyone's ability to manage roles going forward.
  if (users[idx].role === 'md' && role !== 'md') {
    const activeMdCount = users.filter(u => u.role === 'md' && u.active !== false).length;
    if (activeMdCount <= 1) {
      return res.status(403).json({ success:false, message:'Cannot remove the last active Managing Director' });
    }
  }
  users[idx].role = role;
  // F-08: a role change (esp. a demotion) must not leave already-issued tokens acting with the
  // old role for up to 30 more days -- requireRole() already re-checks live role on every
  // mutating request, but bumping tokenVersion here also forces GET requests (e.g. /api/users
  // itself) to pick up the new role/projection immediately instead of waiting for expiry.
  users[idx].tokenVersion = (users[idx].tokenVersion || 0) + 1;
  saveUsers(users);
  // SECURITY FIX 2026-08-04 (retrospective audit round 3, HIGH): same unauthenticated-websocket
  // leak as USER_CREATED above -- this used to send the bcrypt hash and every other private field
  // to every connected client on a simple role change.
  broadcast({ type: 'USER_UPDATED', user: toBroadcastUserProjection(users[idx]) });
  // SECURITY FIX 2026-08-05 (Opus audit, F-1 sibling): this used to echo the full raw record
  // (bcrypt password hash, salary, bank account, idCard) back in the HTTP response too, not just
  // the (already-fixed) websocket broadcast above. No frontend caller reads anything from this
  // response besides `success` (updateUserRoleBackend() just returns the parsed JSON, and its own
  // caller only checks `.success`) -- nothing is lost by dropping `user` entirely.
  res.json({ success:true });
}

app.put('/api/users/:empNo/role', requireRole('md'), withUsersLock((req, res) => {
  const users = readUsers() || [];
  // SECURITY FIX 2026-08-13 (Opus audit, deferred LOW from the events/upload/users audit,
  // fixed now on request): a manager-created employee has NO `employeeNo` property at all until
  // Hikvision device sync assigns one (see the comment a few lines below this route) --
  // `String(undefined) === 'undefined'` meant a request to the literal path
  // `/api/users/undefined` matched the FIRST such employeeNo-less record via findIndex, silently
  // acting on the wrong person (e.g. an md/accounting password reset landing on someone else's
  // account) instead of 404ing. Currently 0 live records lack employeeNo, so this wasn't
  // exploitable against real data today, but the moment 2+ such records coexist it would be.
  // Requiring a real, non-empty employeeNo on the record closes the ambiguity outright -- an
  // employeeNo-less employee must be addressed via the /id/:id sibling route instead (the
  // frontend already does this correctly, app.js:6209).
  const idx = users.findIndex(u => u.employeeNo != null && u.employeeNo !== '' && String(u.employeeNo) === req.params.empNo);
  if (idx < 0) return res.status(404).json({ success:false, message:'User not found' });
  handleRoleUpdate(req, res, users, idx);
}));

app.put('/api/users/id/:id/role', requireRole('md'), withUsersLock((req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ success:false, message:'Invalid id' });
  const users = readUsers() || [];
  const idx = users.findIndex(u => u.id === id);
  if (idx < 0) return res.status(404).json({ success:false, message:'User not found' });
  handleRoleUpdate(req, res, users, idx);
}));

// SECURITY FIX 2026-07-19 (F-09): 4-char minimum (and the '1234' seed default it permitted) was
// trivially guessable. Same policy is enforced client-side in app.js passwordPolicyError()
// (shared by changePassword() and the forced first-login gate) -- keep both in sync if this
// changes again.
const PASSWORD_MIN_LENGTH = 8;
function passwordPolicyError(password) {
  const s = String(password || '');
  if (s.length < PASSWORD_MIN_LENGTH) return `Password must be at least ${PASSWORD_MIN_LENGTH} characters`;
  if (!/[A-Za-z]/.test(s) || !/[0-9]/.test(s)) return 'Password must include both letters and numbers';
  return null;
}

// SECURITY FIX 2026-07-19 (F-09): self-service password change. Previously there was NO backend
// endpoint for a user to change their own password at all -- app.js changePassword() only
// mutated an in-memory copy and never called the API, so it silently did nothing that survived a
// reload. Requires the current password (bcrypt-verified) so a hijacked/left-open session alone
// isn't enough to lock the real owner out. Also used by the forced first-login password-change
// gate (mustChangePassword) -- clears that flag on success. Bumps tokenVersion like the admin
// reset below (kills other devices' sessions on this account) and returns a freshly-signed token
// so the tab that just changed the password doesn't immediately 401 itself on its next request.
//
// MUST be registered BEFORE PUT /api/users/:empNo/password below -- Express matches routes in
// registration order and ':empNo' matches the literal string "me" too, so if the :empNo route
// came first every call here would instead hit that route with empNo="me", 404 (no such
// employeeNo) or worse, get rejected by its requireRole('md','accounting') gate before ever
// reaching this handler (confirmed happening during testing: manager/user tokens got a
// misleading "Forbidden: insufficient role" instead of changing their own password).
app.put('/api/users/me/password', withUsersLock(async (req, res) => {
  const { currentPassword, newPassword, remember } = parseBody(req);
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ success:false, message:'currentPassword and newPassword required' });
  }
  const policyErr = passwordPolicyError(newPassword);
  if (policyErr) return res.status(400).json({ success:false, message:policyErr });
  const users = readUsers() || [];
  const idx = users.findIndex(u => u.id === req.user.sub);
  if (idx < 0) return res.status(404).json({ success:false, message:'User not found' });
  const user = users[idx];
  const ok = isHashed(user.password) ? await bcrypt.compare(String(currentPassword), user.password) : user.password === String(currentPassword);
  // 2026-08-09 (Opus audit finding 6.2): was 401, which apiFetch()'s generic 401 handler (app.js)
  // reads as an EXPIRED SESSION -- showing "⏰ Session expired — please log in again" and
  // force-logging the user out 800ms later, before submitPasswordChange()'s own "Current password
  // is incorrect" message ever renders. Hits every new hire who mistypes their current password
  // on the forced-password-change gate. 401 should mean "your token/session is invalid"; a wrong
  // current password is a 400 (bad request content), not an auth/session problem.
  if (!ok) return res.status(400).json({ success:false, message:'Current password is incorrect' });
  const hash = await bcrypt.hash(String(newPassword), BCRYPT_ROUNDS);
  const fresh = readUsers();
  if (fresh === null) return res.status(503).json({ success:false, message:'Service temporarily unavailable' });
  const freshIdx = fresh.findIndex(u => u.id === req.user.sub);
  if (freshIdx < 0) return res.status(404).json({ success:false, message:'User not found' });
  fresh[freshIdx].password = hash;
  fresh[freshIdx].mustChangePassword = false;
  fresh[freshIdx].tokenVersion = (fresh[freshIdx].tokenVersion || 0) + 1;
  saveUsers(fresh);
  const { password: _pw, ...safeUser } = fresh[freshIdx];
  const token = jwt.sign({ sub: user.id, username: user.username, role: user.role, tokenVersion: fresh[freshIdx].tokenVersion }, JWT_SECRET, { expiresIn: remember === true ? '30d' : '8h' });
  res.json({ success:true, user: safeUser, token });
}));

// Password reset — separate endpoint (not the generic PUT above, which deliberately strips
// password) so MD/Accounting can reset a forgotten password without touching the rest of the profile.
// 2026-08-06 (round 4): shared by both routes below, same employeeNo-less-employee reason as
// handleUserUpdate()/handleRoleUpdate() -- an admin resetting such an employee's password used to
// silently no-op (app.js gated the whole call on `u.employeeNo`, no toast at all on failure).
async function handlePasswordReset(req, res, users, idx) {
  if (isSystemAccountUser(users[idx])) {
    return res.status(403).json({ success:false, message:'Not allowed' });
  }
  const userId = users[idx].id;
  const { password } = parseBody(req);
  const policyErr = passwordPolicyError(password);
  if (policyErr) return res.status(400).json({ success:false, message:policyErr });
  const hash = await bcrypt.hash(String(password), BCRYPT_ROUNDS);
  const fresh = readUsers();
  if (fresh === null) return res.status(503).json({ success:false, message:'Service temporarily unavailable' });
  const freshIdx = fresh.findIndex(u => u.id === userId);
  if (freshIdx < 0) return res.status(404).json({ success:false, message:'User not found' });
  if (isSystemAccountUser(fresh[freshIdx])) {
    return res.status(403).json({ success:false, message:'Not allowed' });
  }
  fresh[freshIdx].password = hash;
  // F-08: an admin-initiated password reset must kill any already-issued token for this user
  // (e.g. a stolen/shared device) -- otherwise the old password's session keeps working for up
  // to 30 more days even after the password was just changed out from under it.
  fresh[freshIdx].tokenVersion = (fresh[freshIdx].tokenVersion || 0) + 1;
  fresh[freshIdx].mustChangePassword = true;
  saveUsers(fresh);
  res.json({ success:true });
}

app.put('/api/users/:empNo/password', requireRole('md', 'accounting'), withUsersLock(async (req, res) => {
  const users = readUsers() || [];
  // SECURITY FIX 2026-08-13 (Opus audit, deferred LOW from the events/upload/users audit,
  // fixed now on request): a manager-created employee has NO `employeeNo` property at all until
  // Hikvision device sync assigns one (see the comment a few lines below this route) --
  // `String(undefined) === 'undefined'` meant a request to the literal path
  // `/api/users/undefined` matched the FIRST such employeeNo-less record via findIndex, silently
  // acting on the wrong person (e.g. an md/accounting password reset landing on someone else's
  // account) instead of 404ing. Currently 0 live records lack employeeNo, so this wasn't
  // exploitable against real data today, but the moment 2+ such records coexist it would be.
  // Requiring a real, non-empty employeeNo on the record closes the ambiguity outright -- an
  // employeeNo-less employee must be addressed via the /id/:id sibling route instead (the
  // frontend already does this correctly, app.js:6209).
  const idx = users.findIndex(u => u.employeeNo != null && u.employeeNo !== '' && String(u.employeeNo) === req.params.empNo);
  if (idx < 0) return res.status(404).json({ success:false, message:'User not found' });
  await handlePasswordReset(req, res, users, idx);
}));

app.put('/api/users/id/:id/password', requireRole('md', 'accounting'), withUsersLock(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ success:false, message:'Invalid id' });
  const users = readUsers() || [];
  const idx = users.findIndex(u => u.id === id);
  if (idx < 0) return res.status(404).json({ success:false, message:'User not found' });
  await handlePasswordReset(req, res, users, idx);
}));

// FIX: lookup by employeeNo ONLY (previously also matched u.id which caused wrong user to be found)
// SECURITY FIX 2026-07-19 (F-01): this endpoint is called from TWO different places in the
// frontend -- the admin Edit Employee form (any field) AND saveMyProfile() (self-service, own
// record only, personal-info fields only: phone/email/address/idCard/idType/emergency contact).
// requireRole('md','accounting','manager') alone would have broken every non-admin employee's
// ability to save their own profile -- a regression the plan's table didn't call out.
// 2026-08-05 (Opus audit F-3, F-4, F-6, F-7 -- fixes applied same session as the door-access
// feature and the F-1/F-2 critical fixes above):
// - F-3: the 2026-08-02 fix's own justification for a manager-wide-write tier ("manager can open
//   the Edit Employee modal for any employee") is not actually true in the current client -- both
//   real entry points (Employees table, Profile "Edit Info") gate full-modal access to
//   md/accounting only; a manager only ever reaches this modal for their OWN record via
//   openEditMyProfile(). The wide grant was backing zero functionality while being a real cross-
//   record PII-write hole (any manager could rewrite ANY employee's, including both MDs',
//   phone/email/idCard/emergency contact). Collapsed into isOwnRecord below -- isManager deleted.
// - F-6: isOwnRecord used to compare `String(live.employeeNo) === req.params.empNo` -- diverges
//   from `idx` (the actually-matched record) whenever two records stringify to the same
//   employeeNo, which is reachable today (manager-created accounts get employeeNo:undefined ->
//   "/api/users/undefined" matches all of them). Now compares resolved record identity directly.
// - F-4: notifyLangEmail/emailNotifyOnResult were never in this whitelist, so every non-admin
//   role's notification-preference save silently no-op'd (green "saved" toast, nothing persisted).
// - F-7: no body-shape validation -- a `null`/array/primitive JSON body crashed this handler with
//   a 500 (e.g. `Object.keys(null)` throws) before ever reaching the tier logic.
const SELF_SERVICE_PROFILE_FIELDS = ['phone','email','address','idType','idCard','emergencyContact','emergencyRelation','emergencyPhone','notifyLangEmail','emailNotifyOnResult'];
// 2026-08-17: namePrefix/firstNameTh/lastNameTh/idCardAddress are new HR-only fields (prefix,
// Thai name, ID-card address, for a future Excel export) -- deliberately NOT in
// SELF_SERVICE_PROFILE_FIELDS above, per an explicit user decision that only MD/Accounting may
// edit them (employees can view, not edit). Kept in one place; app.js has a matching
// NAME_PREFIXES const -- if a value is ever added, both must change together.
const NAME_PREFIX_VALUES = ['', 'mr', 'mrs', 'ms'];
const NEW_PROFILE_STRING_CAPS = { firstNameTh: 100, lastNameTh: 100, idCardAddress: 500 };
function persistDoorSyncLocked(empNo, doorSyncRecord) {
  return runUsersLocked(() => {
    const fresh = readUsers();
    if (!fresh) return;
    const idx = fresh.findIndex(u => String(u.employeeNo) === empNo);
    if (idx >= 0) {
      fresh[idx].doorSync = doorSyncRecord;
      saveUsers(fresh);
    }
  });
}

// 2026-08-06: shared by both PUT routes below (looked up by employeeNo or by internal id) --
// pulled out of the original single :empNo handler so the id-based route (added to fix
// employeeNo-less employees, see its comment) doesn't duplicate ~100 lines of permission/
// door-push logic.
function handleUserUpdate(req, res, users, idx, updates) {
  const live = users.find(u => u.id === req.user.sub);
  if (isSystemAccountUser(users[idx])) {
    const isOwnRecord = live && users[idx].id === live.id;
    if (!isOwnRecord) {
      return res.status(403).json({ success:false, message:'Not allowed' });
    }
    updates = systemAccount.stripSystemAccountFields(updates);
    if (Object.keys(updates).length === 0) {
      return res.json({ success:true, user: { employeeNo: users[idx].employeeNo || '', doorSync: users[idx].doorSync } });
    }
  }
  const isFullAdmin = live && (['md', 'accounting'].includes(live.role) || isSuperAdminUser(live));
  const isOwnRecord = live && users[idx].id === live.id;
  // 2026-08-02: manager used to be treated as full admin here (denylist-only: id/employeeNo/
  // role/password) -- could silently write salary, allowances, leave balances, bank info,
  // position/department, or active status for any employee via the same Edit Employee modal
  // MD/Accounting use, even though the UI's Employment/Financial Information sections are meant
  // to be MD/Accounting-only.
  // 2026-08-05 (F-3): the follow-up "manager gets the self-service whitelist for ANY employee's
  // record" grant is now REMOVED -- a manager falls through to the isOwnRecord branch just like
  // any other non-admin role, own-record-only. No UI path ever needed the cross-record grant (see
  // the comment above SELF_SERVICE_PROFILE_FIELDS).
  if (isFullAdmin) {
    // 2026-08-05: doorSync is server-managed bookkeeping (see pushDoorAccess() below) -- adding
    // it to the forbidden list stops a full-admin client from POSTing a forged doorSync status
    // directly (Opus flagged this during the door-access design's payroll-safety verification).
    // 2026-08-13 (Opus audit): added tokenVersion (writable meant a full-admin client could lock
    // out a victim by desyncing it, or UN-revoke a session a password-reset had just killed by
    // setting it back to the pre-reset value -- defeats the F-08 tokenVersion-bump-on-reset
    // safeguard) and username (writable with no uniqueness check let a full-admin create a
    // duplicate that made login's users.find() resolve by array order instead of intent). Both
    // are server-managed identity/session fields, same class as doorSync -- never client-settable.
    const forbidden = ['id', 'employeeNo', 'role', 'password', 'doorSync', 'tokenVersion', 'username'];
    forbidden.forEach(k => delete updates[k]);
    // SECURITY FIX 2026-08-16 (Opus cron audit, M-1): this branch applies a KEY denylist but no
    // VALUE validation at all -- `email` specifically feeds the pending-approval digest's `to`
    // header as `[...emailSet].join(', ')`, and nodemailer treats a comma-joined string as
    // MULTIPLE recipients. A full-admin write of `email:"real@corp.com, outside@example.com"`
    // (or the self-service branch below, same reasoning) would silently exfiltrate the entire
    // pending-approval queue -- names, request types including sick/maternity, dates -- to the
    // extra address on every digest send, once notifications are enabled. Reject the injection
    // vector itself (comma/semicolon/newline) rather than attempt full RFC email validation,
    // which risks rejecting a legitimate address this project hasn't anticipated.
    if (typeof updates.email === 'string' && /[,;\r\n]/.test(updates.email)) delete updates.email;
    // 2026-08-17 (review fix, comment corrected): checks the RESOLVED value (this record's
    // existing value merged with the patch) so an invalid incoming namePrefix is dropped even if
    // the patch also happens to touch other fields on the same record. NOTE this is NOT a
    // guarantee that the record's stored value is always valid -- if `namePrefix` is absent from
    // `updates` (the common case), `delete updates.namePrefix` below is a no-op on a key that was
    // never there, so an already-bad STORED value (only reachable via a hand-edited users.json,
    // since both write paths validate on input) is left untouched, not retroactively sanitized.
    // No type-conditional requirement exists here (idCardAddress applies regardless of idType) --
    // see project memory on that recurring bug class before adding one.
    const resolvedPrefix = ('namePrefix' in updates) ? updates.namePrefix : users[idx].namePrefix;
    if (!NAME_PREFIX_VALUES.includes(resolvedPrefix ?? '')) delete updates.namePrefix;
    // 2026-08-17 (review fix): `?? ''` above only widened the CHECK to accept null -- without
    // this, an explicit JSON null in the patch passed the check but got merged into the record
    // as literal `null` rather than the canonical `''` every other absent-value site uses.
    else if (updates.namePrefix == null && 'namePrefix' in updates) updates.namePrefix = '';
    for (const [k, cap] of Object.entries(NEW_PROFILE_STRING_CAPS)) {
      if (k in updates && (typeof updates[k] !== 'string' || updates[k].length > cap)) delete updates[k];
    }
  } else if (isOwnRecord) {
    Object.keys(updates).forEach(k => { if (!SELF_SERVICE_PROFILE_FIELDS.includes(k)) delete updates[k]; });
    // SECURITY FIX 2026-08-13 (Opus audit): the whitelist above only restricted which KEYS could
    // be written, not the VALUES -- any user/driver could PUT e.g. {address:'A'.repeat(9000000)}
    // on their own record with no server-side length cap (only a 10MB express.raw ceiling), and
    // users.json is read synchronously on every single request by the global auth middleware, so
    // one oversized field bloats every request's latency, not just this user's. Non-string values
    // (phone:{}, emailNotifyOnResult:'yes') were also accepted verbatim. Cap string fields to a
    // generous-but-bounded length and require the expected primitive type; silently drop (not
    // 400) anything that fails, matching this endpoint's existing lenient-write style elsewhere.
    Object.keys(updates).forEach(k => {
      if (k === 'emailNotifyOnResult') {
        if (typeof updates[k] !== 'boolean') delete updates[k];
        return;
      }
      if (typeof updates[k] !== 'string' || updates[k].length > 500) { delete updates[k]; return; }
      // SECURITY FIX 2026-08-16 (Opus cron audit, M-1): same email-injection guard as the
      // full-admin branch above -- an ordinary self-service profile save is the more likely real
      // path here, since it needs no elevated role at all. See that branch's comment for the
      // full reasoning (nodemailer comma-splits the digest's `to` header).
      if (k === 'email' && /[,;\r\n]/.test(updates[k])) delete updates[k];
    });
  } else {
    return res.status(403).json({ success:false, message:'Forbidden: not your record' });
  }
  // SECURITY/CORRECTNESS FIX 2026-08-17 (Opus review of the 50-Tawi export): idType is writable by
  // BOTH full-admin (no denylist entry) and self-service (in SELF_SERVICE_PROFILE_FIELDS), but had
  // no value validation on either path -- only a generic string-length cap. It decides which cell
  // (P12 vs P13) an employee's ID number prints in on their 50-Tawi tax certificate
  // (tawi50Xlsx.js's writeEmployeeBlock()), so an unrecognized value (a typo, stray whitespace, or
  // a legacy record predating this field) would silently route a Thai national ID into the
  // foreign-taxpayer box or vice versa on a real legal document. Same resolved-value pattern as the
  // namePrefix check above (checks the MERGED final state, not just whether this request touched
  // the field) -- applied once here since, unlike namePrefix, both write paths above can set it.
  const ID_TYPE_VALUES = ['', 'idcard', 'passport', 'tax_id'];
  const resolvedIdType = ('idType' in updates) ? updates.idType : users[idx].idType;
  if (!ID_TYPE_VALUES.includes(resolvedIdType ?? '')) delete updates.idType;
  else if (updates.idType == null && 'idType' in updates) updates.idType = '';
  // 2026-08-05 (door access sync): compare canOpenDoor() before vs after the update, not
  // field-presence -- the Edit Employee modal sends active+isObserver on every save, even a
  // phone-number-only edit, so a presence check would push a device call on every unrelated save.
  const before = canOpenDoor(users[idx]);
  const wasActive = users[idx].active !== false;
  users[idx] = { ...users[idx], ...updates };
  // SECURITY FIX 2026-09-23 (Opus audit MEDIUM-4): deactivating an account never revoked its
  // tokens, so a remember-me session (30 days) kept working. Bump tokenVersion on the
  // active -> inactive transition, same as a password reset; also closes that user's sockets.
  if (wasActive && users[idx].active === false) {
    users[idx].tokenVersion = (users[idx].tokenVersion || 0) + 1;
  }
  const after = canOpenDoor(users[idx]);
  const empNo = String(users[idx].employeeNo || '');
  saveUsers(users);   // HR fact persists first, regardless of whether the device push below succeeds
  // SECURITY FIX 2026-08-05 (Opus audit, F-1, CRITICAL): this used to echo the full raw record
  // back verbatim -- `users[idx]` straight from readUsers(), no projection at all -- to WHOEVER
  // made the request, including a `manager` (whose write side is correctly restricted to a small
  // whitelist, but the read side had no restriction whatsoever). Looping employeeNo 1..N as a
  // manager account was enough to pull every employee's bcrypt password hash, salary, bank
  // account, and national ID number. Confirmed no frontend caller needs more than `doorSync` from
  // this response (app.js only reads `putData.user.doorSync`) -- so the fix is to stop returning
  // the record at all, not to add a role-conditional projection.
  const respUser = { employeeNo: users[idx].employeeNo, doorSync: users[idx].doorSync };
  if (before === after || !empNo || !isSafeEmpNo(empNo)) {
    return res.json({ success:true, user: respUser });
  }
  // Fail OPEN: an admin must be able to process a status change even if the device is
  // unreachable -- failing closed here would just get worked around by hand-editing users.json.
  let responded = false;
  const deadline = setTimeout(() => {
    if (responded) return;
    responded = true;
    console.error(`[DOOR] push timed out for empNo=${empNo} want=${after} -- the real result will still be persisted (and shown next time this employee's Edit modal is opened) once the device actually answers`);
    res.json({ success:true, user: respUser, deviceSync: { attempted:true, ok:false, want:after, message:'Door sync timed out -- keep checking, or use Retry' } });
  }, 12000);
  // BUG FIX 2026-08-05 (Opus audit, HIGH-1): this whole callback used to be gated behind
  // `if (responded) return;` -- once the 12s timeout above had already answered the HTTP request,
  // the REAL result (arriving anywhere from milliseconds to ~20s later, since pushDoorAccess can
  // issue up to 3 sequential Hikvision round trips on a disable) was thrown away entirely: never
  // persisted to users.json, so the Edit Employee modal kept showing either nothing (first-ever
  // sync for that employee -> no Retry button visible on a push that may have actually failed) or
  // a stale earlier success (a real revocation failure silently displayed as a green checkmark).
  // Persistence must always happen; only the HTTP response itself is one-shot.
  pushDoorAccess(empNo, after, (err, result) => {
    clearTimeout(deadline);
    const deviceSync = err
      ? { attempted:true, ok:false, want:after, message: err.message }
      : (result.skipped
          ? { attempted:true, ok:true, want:after, skipped: result.skipped }
          : { attempted:true, ok:true, want:after, verified: result.verified });
    if (err) console.error(`[DOOR] push failed for empNo=${empNo} want=${after}:`, err.message);
    else if (!result.skipped) console.log(`[DOOR] push ok empNo=${empNo} want=${after} verified=${result.verified}`);
    const doorSyncRecord = { ok: deviceSync.ok, want: after, at: new Date().toISOString(), error: err ? err.message : null };
    respUser.doorSync = doorSyncRecord;
    // Re-read fresh before persisting doorSync -- the device round trip can take up to 12s, during
    // which another request could have legitimately changed users.json; only stamp doorSync onto
    // whatever the current record actually is, don't clobber it with the stale in-memory snapshot.
    // Same usersLock chain as password/profile writes so a late stamp cannot clobber a concurrent save.
    persistDoorSyncLocked(empNo, doorSyncRecord).catch(persistErr => {
      console.error(`[DOOR] failed to persist doorSync for empNo=${empNo}:`, persistErr && persistErr.message);
    }).then(() => {
      if (!responded) {
        responded = true;
        res.json({ success:true, user: respUser, deviceSync });
      }
    });
  });
}

app.put('/api/users/:empNo', withUsersLock((req, res) => {
  const updates = parseBody(req);
  if (!updates || typeof updates !== 'object' || Array.isArray(updates)) {
    return res.status(400).json({ success:false, message:'Invalid request body' });
  }
  const users = readUsers() || [];
  // SECURITY FIX 2026-08-13 (Opus audit, deferred LOW from the events/upload/users audit,
  // fixed now on request): a manager-created employee has NO `employeeNo` property at all until
  // Hikvision device sync assigns one (see the comment a few lines below this route) --
  // `String(undefined) === 'undefined'` meant a request to the literal path
  // `/api/users/undefined` matched the FIRST such employeeNo-less record via findIndex, silently
  // acting on the wrong person (e.g. an md/accounting password reset landing on someone else's
  // account) instead of 404ing. Currently 0 live records lack employeeNo, so this wasn't
  // exploitable against real data today, but the moment 2+ such records coexist it would be.
  // Requiring a real, non-empty employeeNo on the record closes the ambiguity outright -- an
  // employeeNo-less employee must be addressed via the /id/:id sibling route instead (the
  // frontend already does this correctly, app.js:6209).
  const idx = users.findIndex(u => u.employeeNo != null && u.employeeNo !== '' && String(u.employeeNo) === req.params.empNo);
  if (idx < 0) return res.status(404).json({ success:false, message:'User not found' });
  handleUserUpdate(req, res, users, idx, updates);
}));

// 2026-08-06: an employee added via the "Add Employee" form (app.js saveEmployee()) gets
// `employeeNo: ''` from POST /api/users, which never assigns a real one -- only Hikvision device
// sync does that, and only for BRAND NEW device-side records, never by linking back to an
// existing employeeNo-less local one. The :empNo route above can therefore never address such a
// record at all (an empty URL path segment doesn't even match Express's :empNo param), so every
// edit to one of these employees silently discarded the whole PUT while the UI still showed a
// false "✅ Saved" -- confirmed via Opus re-audit reading app.js's saveEmployee(), which gates its
// entire persistence block on `if (u.employeeNo)`. Same handler, looked up by internal id instead
// of employeeNo -- door-push is already correctly skipped for a falsy employeeNo by the existing
// `!empNo` check inside handleUserUpdate() above, so this is a pure persistence fix, not a new
// door-access code path.
app.put('/api/users/id/:id', withUsersLock((req, res) => {
  const updates = parseBody(req);
  if (!updates || typeof updates !== 'object' || Array.isArray(updates)) {
    return res.status(400).json({ success:false, message:'Invalid request body' });
  }
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ success:false, message:'Invalid id' });
  const users = readUsers() || [];
  const idx = users.findIndex(u => u.id === id);
  if (idx < 0) return res.status(404).json({ success:false, message:'User not found' });
  handleUserUpdate(req, res, users, idx, updates);
}));

// 2026-08-05: retry endpoint for a failed/uncertain door-sync push (e.g. the device was
// unreachable during the PUT above) -- md/accounting only, idempotent, just re-runs
// pushDoorAccess() against canOpenDoor()'s current answer for this employee.
// 2026-08-06 (Opus re-audit, N-4): requireRole() deliberately fails OPEN (skips the role check)
// when readUsers() hits a transient read error -- a reasonable app-wide tolerance for payroll/
// leave reads, but this route actuates a real physical door. requireRole() calls readUsers()
// once during the middleware check; this handler calls it again below -- if a transient failure
// clears between those two reads, an unauthorized role could slip through the middleware's
// fail-open gap and still reach a handler whose OWN readUsers() now succeeds. Explicit inline
// role check closes that race independent of requireRole()'s tolerance.
app.post('/api/users/:empNo/door-sync', requireRole('md', 'accounting'), (req, res) => {
  const empNo = req.params.empNo;
  if (!isSafeEmpNo(empNo)) return res.status(400).json({ success:false, message:'invalid employeeNo' });
  const users = readUsers();
  if (users === null) return res.status(503).json({ success:false, message:'Service temporarily unavailable' });
  const live = users.find(u => u.id === req.user.sub);
  // BUG FIX 2026-08-06 (Opus re-audit round 2, F4): this inline check originally only mirrored 2
  // of requireRole()'s 3 gates (missing record, wrong role) -- missed the isObserver/active===false
  // check requireRole() also does. In the exact race this inline check exists for (middleware's
  // readUsers() fails open, this handler's own readUsers() succeeds moments later), an
  // observer-flagged or deactivated md/accounting account would still reach this handler.
  if (!live || !roleAllowedByRequireRole(live, ['md', 'accounting']) || (!isSuperAdminUser(live) && (live.isObserver || live.active === false))) {
    return res.status(403).json({ success:false, message:'Forbidden' });
  }
  const user = users.find(u => String(u.employeeNo) === empNo);
  if (!user) return res.status(404).json({ success:false, message:'User not found' });
  const want = canOpenDoor(user);
  let responded = false;
  const deadline = setTimeout(() => {
    if (responded) return;
    responded = true;
    res.json({ success:true, deviceSync: { attempted:true, ok:false, want, message:'Door sync timed out -- keep checking, or Retry again' } });
  }, 12000);
  // BUG FIX 2026-08-05 (Opus audit, HIGH-1, same fix as the PUT handler above): persistence must
  // run even if the HTTP response already went out via the timeout -- only the res.json() call
  // itself is one-shot.
  pushDoorAccess(empNo, want, (err, result) => {
    clearTimeout(deadline);
    const deviceSync = err
      ? { attempted:true, ok:false, want, message: err.message }
      : (result.skipped
          ? { attempted:true, ok:true, want, skipped: result.skipped }
          : { attempted:true, ok:true, want, verified: result.verified });
    const doorSyncRecord = { ok: deviceSync.ok, want, at: new Date().toISOString(), error: err ? err.message : null };
    persistDoorSyncLocked(empNo, doorSyncRecord).catch(persistErr => {
      console.error(`[DOOR] failed to persist doorSync for empNo=${empNo}:`, persistErr && persistErr.message);
    }).then(() => {
      if (!responded) {
        responded = true;
        res.json({ success:true, deviceSync });
      }
    });
  });
});

// 2026-08-05: read-only audit -- Search the device, join against users.json, surface every
// mismatch for md/accounting to review and reconcile one at a time via the retry endpoint above.
// Deliberately no bulk-push route: an automatic bulk action should never touch real doors
// unattended (see project memory project_time_attendance_2026_08_04_door_access_design, section 4).
// 2026-08-06 (Opus re-audit, N-4): requireRole() deliberately fails OPEN (skips the role check)
// when readUsers() hits a transient read error -- a reasonable app-wide tolerance for payroll/
// leave reads, but this route exposes every employee's active/observer/device-enrollment status,
// so it gets its own explicit, fail-closed role check inside the handler rather than trusting
// requireRole()'s tolerance on a route this sensitive.
app.get('/api/door-access/audit', requireRole('md', 'accounting'), (req, res) => {
  const users = readUsers();
  if (users === null) return res.status(503).json({ success:false, message:'Service temporarily unavailable' });
  const live = users.find(u => u.id === req.user.sub);
  // BUG FIX 2026-08-06 (Opus re-audit round 2, F4): this inline check originally only mirrored 2
  // of requireRole()'s 3 gates (missing record, wrong role) -- missed the isObserver/active===false
  // check requireRole() also does. In the exact race this inline check exists for (middleware's
  // readUsers() fails open, this handler's own readUsers() succeeds moments later), an
  // observer-flagged or deactivated md/accounting account would still reach this handler.
  if (!live || !roleAllowedByRequireRole(live, ['md', 'accounting']) || (!isSuperAdminUser(live) && (live.isObserver || live.active === false))) {
    return res.status(403).json({ success:false, message:'Forbidden' });
  }
  hikSearchAll((err, hikUsers) => {
    if (err) return res.json({ success:false, message: err.message });
    const byEmpNo = new Map(hikUsers.map(hu => [String(hu.employeeNo), hu]));
    const appNos = new Set(users.map(u => String(u.employeeNo || '')).filter(Boolean));
    const rows = [];
    users.forEach(u => {
      const empNo = String(u.employeeNo || '');
      if (!empNo) return;
      const dev = byEmpNo.get(empNo);
      const wants = canOpenDoor(u);
      const deviceEnable = dev ? !!(dev.Valid && dev.Valid.enable) : null;
      rows.push({
        employeeNo: empNo, deviceName: dev ? dev.name : null, appName: u.name,
        appActive: u.active !== false, appIsObserver: !!u.isObserver,
        deviceEnable, wants,
        mismatch: !!dev && deviceEnable !== wants,
        onDeviceOnly: false, inAppOnly: !dev
      });
    });
    hikUsers.forEach(hu => {
      const empNo = String(hu.employeeNo || '');
      if (empNo && !appNos.has(empNo)) {
        rows.push({
          employeeNo: empNo, deviceName: hu.name, appName: null,
          appActive: null, appIsObserver: null,
          deviceEnable: !!(hu.Valid && hu.Valid.enable), wants: null,
          mismatch: false, onDeviceOnly: true, inAppOnly: false
        });
      }
    });
    res.json({ success:true, rows });
  });
});

// SECURITY FIX 2026-08-04 (retrospective Opus audit, MEDIUM): this route auto-fires on every
// md/accounting/manager login (app.js syncHikvisionEmployees()) -- overlapping runs are
// realistic, not theoretical, and a merge-save alone doesn't stop two runs from both trying to
// claim the same new-hire employeeNo/username. One in-flight run at a time.
let hikSyncInProgress = false;

// Sync new employees from Hikvision
app.post('/api/users/sync-hikvision', requireRole('md', 'accounting', 'manager'), (req, res) => {
  if (hikSyncInProgress) {
    return res.status(409).json({ success:false, message:'A Hikvision sync is already running -- try again shortly' });
  }
  hikSyncInProgress = true;
  const releaseLock = () => { hikSyncInProgress = false; };

  hikSearchAll((err, hikUsers) => {
    if (err) {
      releaseLock();
      return res.json({ success:false, message: err.message });
    }

    const currentUsers = readUsers() || [];
    const existingNos  = new Set(currentUsers.map(u => String(u.employeeNo)));
    // H5 fix: reject any device record whose employeeNo isn't a plain alphanumeric token before
    // it's ever used to build a filesystem path below -- see isSafeEmpNo().
    const newHikUsers  = hikUsers.filter(hu => {
      if (!hu.employeeNo) return false;
      // 2026-08-06: badges enrolled on the device that are deliberately not real employees
      // (see HIKVISION_SYNC_EXCLUDE_EMPNOS above) must never get a login/employee account
      // created for them by this auto-detection, no matter how many times Sync runs.
      if (HIKVISION_SYNC_EXCLUDE_EMPNOS.has(String(hu.employeeNo))) return false;
      if (!isSafeEmpNo(String(hu.employeeNo))) {
        console.warn('[SYNC] rejected unsafe employeeNo from device:', JSON.stringify(hu.employeeNo));
        return false;
      }
      return !existingNos.has(String(hu.employeeNo));
    });

    if (newHikUsers.length === 0) {
      releaseLock();
      return res.json({ success:true, added:0, total:currentUsers.length, message:'ไม่มีพนักงานใหม่จาก Hikvision' });
    }

    let pending = newHikUsers.length;
    const added = [];
    let broadcastCount = 0;
    // SECURITY FIX 2026-08-04 (retrospective Opus audit, MEDIUM): saveUsers(currentUsers) used to
    // write back the t=0 snapshot verbatim from both the watchdog and the normal-completion path
    // -- any concurrent write elsewhere (a password change, a profile edit) that landed on
    // users.json during this request's up-to-60s window got silently reverted, and firing twice
    // (once from the watchdog, once from a late finalizeUser()) re-broadcast the same `added`
    // list as a duplicate toast. persistNewUsers() re-reads the file fresh at save time and
    // appends only the employeeNos this run actually added; broadcastNewlyAdded() only ever sends
    // the delta since the last broadcast.
    // SECURITY FIX 2026-08-04 (retrospective audit round 3, HIGH): `readUsers() || []` silently
    // turned a transient read failure into "the company has zero employees" and then WROTE that
    // -- every other readUsers() caller in this file treats null as a real, guarded condition
    // (e.g. the global auth middleware, hikAuth()) specifically to avoid this. Returns null on
    // failure instead of saving; both call sites below must check for that and skip the save.
    function persistNewUsers() {
      return runUsersLocked(() => {
        const fresh = readUsers();
        if (fresh === null) {
          console.error('[SYNC] readUsers() failed at persist time -- refusing to save to avoid wiping users.json');
          return null;
        }
        const freshNos = new Set(fresh.map(u => String(u.employeeNo)));
        const toAppend = added.filter(u => !freshNos.has(String(u.employeeNo)));
        const merged = [...fresh, ...toAppend];
        saveUsers(merged);
        return merged.length;
      });
    }
    // SECURITY FIX 2026-08-04 (retrospective audit round 3, HIGH): same unauthenticated-websocket
    // leak as USER_CREATED/USER_UPDATED -- `added` entries carry the plaintext '1234' seed
    // password plus salary/idCard/bankAccount, and this went to every connected client with no
    // auth check at all.
    function broadcastNewlyAdded() {
      const unbroadcast = added.slice(broadcastCount);
      if (unbroadcast.length) {
        broadcast({ type: 'USERS_SYNCED', added: unbroadcast.map(toBroadcastUserProjection) });
        broadcastCount = added.length;
      }
    }
    // SECURITY FIX 2026-08-04 (Medium, Hikvision audit): a stalled device photo-download request
    // used to leave `pending` above 0 forever -- finalizeUser() (and therefore res.json()) never
    // fires, hanging this request indefinitely. `responded` stops a late finalizeUser() from
    // double-calling res.json() after the watchdog has already answered; the watchdog itself
    // saves+responds with whatever succeeded so far instead of leaving the caller hanging.
    let responded = false;
    function respondOnce(payload) {
      if (responded) return;
      responded = true;
      clearTimeout(watchdog);
      releaseLock();
      res.json(payload);
    }
    const watchdog = setTimeout(() => {
      if (pending <= 0) return;
      console.error(`[SYNC] batch watchdog fired with pending=${pending} device response(s) still outstanding`);
      persistNewUsers().then(total => {
        if (total === null) {
          respondOnce({ success:false, message:'Sync timed out and users.json could not be read to save progress -- no changes were made' });
          return;
        }
        broadcastNewlyAdded();
        respondOnce({
          success: true, added: added.length, total, users: added, partial: true,
          message: `Sync timed out waiting for ${pending} device response(s); saved ${added.length} of ${newHikUsers.length} new employee(s).`
        });
      }).catch(persistErr => {
        console.error('[SYNC] persistNewUsers failed at watchdog:', persistErr && persistErr.message);
        respondOnce({ success:false, message:'Sync timed out and newly synced employees could not be saved' });
      });
    }, 60000);
    // Bug fix 2026-07-23: username collision was checked against `added`, but `added` is only
    // populated inside finalizeUser() -- which fires asynchronously after the photo download
    // completes. Two new hires in the same sync batch with the same derived base username (and
    // at least one with a device photo, taking the async path) would both pass the collision
    // check before either had been pushed to `added`, producing duplicate usernames. Since
    // login resolves by case-insensitive username match (first match only), the second
    // duplicate user could never log in. Reserve the chosen username synchronously in this Set
    // the moment it's picked -- before any async photo fetch starts -- so later iterations in
    // the same forEach (which all run synchronously up to the async hikRequest call) see it.
    const reservedUsernames = new Set();

    // LOW fix 2026-08-04 (retrospective Opus audit): shared completion check, used both by a
    // normal finalizeUser() and by the unsafe-photo-path guard below -- that guard used to
    // `return` without decrementing `pending` at all, so a device record that (somehow) produced
    // an unsafe photo path would leave this batch stuck forever despite the 60s watchdog now
    // existing as a backstop (currently unreachable in practice since isSafeEmpNo() already
    // filters upstream, but decrementing here is the correct behavior regardless).
    function checkAllDone() {
      if (pending !== 0) return;
      persistNewUsers().then(total => {
        if (total === null) {
          respondOnce({ success:false, message:'Sync finished but users.json could not be read to save the result -- no changes were made' });
          return;
        }
        broadcastNewlyAdded();
        respondOnce({ success:true, added: added.length, total, users: added });
      }).catch(persistErr => {
        console.error('[SYNC] persistNewUsers failed at completion:', persistErr && persistErr.message);
        respondOnce({ success:false, message:'Sync finished but newly synced employees could not be saved' });
      });
    }

    newHikUsers.forEach(hu => {
      const empNo     = String(hu.employeeNo);
      // H5 fix (belt-and-braces on top of the isSafeEmpNo filter above): path.basename() strips
      // any directory component, and the startsWith assertion refuses to write outside PHOTOS_DIR
      // even if that ever stops being true -- same guard already used at POST /api/upload/:filename.
      const photoFile = path.join(PHOTOS_DIR, path.basename(`emp_${empNo}.jpg`));
      if (!photoFile.startsWith(PHOTOS_DIR + path.sep)) {
        console.error('[SYNC] refused unsafe photo path for empNo:', empNo);
        pending--;
        checkAllDone();
        return;
      }
      const facePhoto = `images/employees/emp_${empNo}.jpg`;

      // H5 fix: strip control characters from the device-supplied name before it's stored --
      // the real fix for rendering is escapeHtml() at every render site (done in app.js).
      const rawName = String(hu.name || empNo).split('').filter(ch => ch.charCodeAt(0) >= 32).join('').trim().slice(0, 64);
      const baseUser = rawName.toLowerCase().replace(/[^a-z0-9]/g, '').substring(0, 16) || `emp${empNo}`;
      let username = baseUser;
      let ux = 2;
      while (currentUsers.find(u => String(u.username || '').toLowerCase() === username) || reservedUsernames.has(username)) {
        username = baseUser.substring(0, 14) + ux++;
      }
      reservedUsernames.add(username);

      function finalizeUser(photoOk) {
        // F-13: derive id from current state of currentUsers+added at call time, not a
        // pre-computed max — photo downloads are async so multiple finalizeUser callbacks
        // can fire in sequence; reading nextId each time ensures IDs never collide.
        const newUser = {
          // F-09: seed password stays '1234' here (this is device-sync, not an admin picking a
          // password) but mustChangePassword forces it to be replaced before real use.
          // BUG FIX 2026-08-06 (Opus re-audit, N-1): hashed immediately instead of stored as
          // plaintext and left for login's lazy-migrate-on-first-use path (isHashed() check at
          // /api/login) to hash later -- this sync route had been a dormant no-op for months (the
          // UserInfoSearch key bug), so the plaintext-at-rest window was never actually reachable
          // until today's fix turned this code path on for the first time. bcryptjs's hashSync is
          // safe to call from this synchronous callback (pure-JS implementation, no native thread
          // pool to block).
          id: nextId([...currentUsers, ...added]), employeeNo: empNo, username, password: bcrypt.hashSync('1234', BCRYPT_ROUNDS), mustChangePassword: true,
          name: rawName, facePhoto: photoOk ? facePhoto : '',
          role: 'user', dept: '', position: 'Staff',
          salary: 0, idCard: '', phone: '', email: '', address: '',
          startDate: new Date(Date.now() + 7*3600000).toISOString().split('T')[0],
          bankName: '', bankAccount: '', emergencyContact: '', emergencyPhone: '',
          annualLeave: 6, sickLeave: sickLeaveEntitlementDays(), businessLeave: businessLeaveEntitlementDays(),
          transport: 0, positionAllowance: 0, housing: 0, allowance3: 0, pvdRate: 5,
          active: true
        };
        currentUsers.push(newUser);
        added.push(newUser);
        pending--;
        checkAllDone();
      }

      const faceURL = hu.faceURL ? hu.faceURL.split('@')[0] : null;
      if (faceURL) {
        hikRequest('GET', faceURL, null, null, (err2, status2, photoBuf) => {
          if (!err2 && status2 === 200 && photoBuf && photoBuf.length > 500) {
            try {
              if (!fs.existsSync(PHOTOS_DIR)) fs.mkdirSync(PHOTOS_DIR, { recursive: true });
              fs.writeFileSync(photoFile, photoBuf);
              console.log(`[SYNC] Photo saved: emp_${empNo}.jpg (${photoBuf.length} bytes)`);
              finalizeUser(true);
            } catch(e) { console.error('[SYNC] Photo save error:', e.message); finalizeUser(false); }
          } else {
            console.log(`[SYNC] Photo download failed emp=${empNo} status=${status2}`);
            finalizeUser(false);
          }
        });
      } else {
        finalizeUser(false);
      }
    });
  });
});

// Sync name back to Hikvision
// SECURITY FIX 2026-08-04 (retrospective Opus audit, MEDIUM): this endpoint used to (1) accept
// any employeeNo straight from the request body with no check that it belonged to an employee the
// caller is allowed to edit, and (2) force enable:true plus a hardcoded 2024-2029 validity window
// on EVERY call -- silently re-enabling a badge that had been manually disabled on the device (or
// clobbering a manually-configured window/RightPlan) as a side effect of an unrelated name edit.
// Now: reject unless employeeNo matches a real users.json record, sanitize both inputs the same
// way sync-hikvision's inbound path already does, and read-modify-write -- fetch the device's
// CURRENT record first and echo its existing Valid block back unchanged, touching only `name`.
//
// BUG FIX 2026-08-06 (Opus re-audit, (b)-2 + MEDIUM-2 gap): this used to do its own raw
// Search-then-Modify entirely OUTSIDE hikModifyUser()'s per-empNo queue, and its Modify body only
// echoed 4 named fields (employeeNo/name/userType/Valid) instead of spreading the full device
// record. Both gaps had the same real consequence: a name edit landing mid-flight during a
// door-access status flip for the SAME employee could interleave with it -- reading the device's
// PRE-flip Valid block and writing it back, silently re-enabling (or re-disabling) a badge behind
// the status flip's back, with users.json's doorSync record left saying the opposite of what the
// device now has. Routing through hikModifyUser() puts this under the same queue as every other
// device write for this empNo, and spreading `...dv` closes the same "Modify is a replace, not a
// merge" risk MEDIUM-2 already fixed in pushDoorAccess() but missed here.
app.post('/api/sync-name', requireRole('md', 'accounting', 'manager'), (req, res) => {
  const body = parseBody(req);
  const employeeNo = String(body.employeeNo || '');
  if (!isSafeEmpNo(employeeNo)) {
    return res.status(400).json({ success:false, message:'invalid employeeNo' });
  }
  const users = readUsers();
  if (users === null) return res.status(503).json({ success:false, message:'Service temporarily unavailable' });
  if (!users.some(u => String(u.employeeNo) === employeeNo)) {
    return res.status(403).json({ success:false, message:'Forbidden: employeeNo is not a known employee' });
  }
  const name = String(body.name || '').split('').filter(ch => ch.charCodeAt(0) >= 32).join('').trim().slice(0, 64);
  if (!name) return res.status(400).json({ success:false, message:'missing name' });

  hikModifyUser(employeeNo, (dv) => ({
    ...dv,
    employeeNo: dv.employeeNo, name, userType: dv.userType || 'normal',
    Valid: dv.Valid || { enable:true, beginTime:'2024-01-01T00:00:00', endTime: HIK_DEFAULT_END }
  }), (err, result) => {
    if (err) return res.json({ success:false, message: err.message });
    if (result && result.skipped) {
      // Normal for a resigned/never-enrolled employee -- not an error.
      return res.json({ success:true, skipped: result.skipped, message:'Employee not enrolled on the door controller -- nothing to update' });
    }
    res.json({ success: !!(result && result.ok) });
  });
});

// ===== REST API =====
app.get('/api/health', (req, res) => {
  const users = readUsers() || [];
  res.json({ status:'ok', time:new Date().toISOString(), wsClients:clients.size, totalEvents:(readEvents() || []).length, totalUsers: employeeRecords(users).length });
});

// Instant is always NAS Date.now().
// 2026-09-23: always Bangkok, matching what a web scan now records (see the HIGH-1 fix in
// POST /api/hikvision/event) -- the scan-page clock must show the time that will be saved.
// lat/lng query params are still sent by older clients and are ignored.
app.get('/api/now', (req, res) => {
  const tz = DEFAULT_TZ;
  const ms = Date.now();
  const ymd = ymdInTimeZone(ms, tz);
  res.json({
    epoch: ms,
    timezone: tz,
    localIso: isoFromYmd(ymd),
    businessDate: businessDateFromYmd(ymd)
  });
});

// SECURITY FIX 2026-08-04 (Opus audit, H2): these two routes used to return every field
// (gps, cardholderName) of ANY employee's raw scan history to ANY authenticated user, with no
// ownership or role check at all -- same bug class already fixed for GET /api/users via
// toPublicUserProjection(). md/accounting (matches that endpoint's isFullAccess exactly, and
// every frontend gate -- canViewOthers/canViewAll are both md||accounting, never manager) get
// full records for everyone; everyone else gets full records for their OWN employeeNo and the
// public projection for everyone else's. The default (no employee_no filter) still returns
// every employee's events -- loadAttendanceFromBackend() calls it that way on every page load for
// every role, feeding the dashboard "who's checked in today" widget, which is legitimate existing
// product behavior -- only the sensitive fields on OTHER people's rows are now stripped.
function eventViewerContext(req) {
  const users = readUsers() || [];
  const live = users.find(u => u.id === req.user.sub);
  const role = live ? live.role : req.user.role;
  return { isFullAccess: isPrivilegedAdmin(live), ownNo: live ? String(live.employeeNo || '') : '' };
}
function projectEventsForViewer(evs, ctx) {
  return evs.map(e => (ctx.isFullAccess || String(e.employeeNo) === ctx.ownNo) ? e : toPublicEventProjection(e));
}
// 2026-08-17: was 5000 -- with EVENTS_RETENTION_MONTHS now 25, current volume (~955 events/month
// TOTAL across 10 employees, ~95/employee-month) projects to ~24k records at 10 employees, ~29k
// at 12. Retention is the real size ceiling now, not this constant; this stays only as a safety
// net against a pathological case (e.g. a device stuck in a scan loop).
const MAX_EVENT_LIMIT = 50000;

app.get('/api/events/today', (req, res) => {
  const today = new Date(Date.now() + 7 * 3600000).toISOString().split('T')[0];
  const evs = readEvents();
  if (evs === null) return res.status(503).json({ success:false, message:'Service temporarily unavailable' });
  res.json(projectEventsForViewer(evs.filter(e => e.event_time && String(e.event_time).startsWith(today)), eventViewerContext(req)));
});

app.get('/api/events', (req, res) => {
  const date        = req.query.date        ? String(Array.isArray(req.query.date) ? req.query.date[0] : req.query.date) : '';
  const employee_no = req.query.employee_no ? String(Array.isArray(req.query.employee_no) ? req.query.employee_no[0] : req.query.employee_no) : '';
  const n = parseInt(req.query.limit, 10);
  const limit = Number.isFinite(n) && n > 0 ? Math.min(n, MAX_EVENT_LIMIT) : 500;
  let evs = readEvents();
  if (evs === null) return res.status(503).json({ success:false, message:'Service temporarily unavailable' });
  if (date)        evs = evs.filter(e => e.event_time && String(e.event_time).startsWith(date));
  if (employee_no) evs = evs.filter(e => String(e.employeeNo) === employee_no);
  evs = evs.slice(-limit).reverse();
  res.json(projectEventsForViewer(evs, eventViewerContext(req)));
});

// ===== EXCHANGE RATE API =====
let _exRateCache = { data: null, ts: 0 };


// ===== HOLIDAYS API =====
// CORRECTNESS FIX 2026-08-13 (H-5, Opus audit): was `path.join(__dirname, 'data/holidays.json')`
// -- every OTHER data file in this project is built from DATA_DIR (which falls back to the same
// __dirname/data today, so this was invisible in practice), but if DATA_DIR is ever set (a
// restore/migration), this file alone would silently keep reading/writing the old location --
// coming back with an empty/stale holiday calendar while every other file follows the move.
const holidaysPath = path.join(DATA_DIR, 'holidays.json');
let holidays = [];
// CORRECTNESS FIX 2026-08-13 (H-7, Opus audit): a parse failure used to silently become `[]` with
// no log line -- OT drops to x1.5, late-deduction exemptions and today's F-5 leave-days derivation
// all lose every holiday, with nothing but an empty admin page to notice by. `holidaysLoadFailed`
// blocks POST/DELETE while true, so a transient boot-time read error can no longer be turned into
// permanent data loss by the next admin who clicks "Add Holiday" (the old unconditional
// atomicWrite() would have overwritten the real file on disk with the empty in-memory array).
let holidaysLoadFailed = false;
if (fs.existsSync(holidaysPath)) {
  try { holidays = JSON.parse(fs.readFileSync(holidaysPath, 'utf8')); } catch(e) {
    holidays = [];
    holidaysLoadFailed = true;
    console.error('[HOLIDAYS] failed to parse holidays.json --', e.message);
  }
} else {
  fs.writeFileSync(holidaysPath, '[]');
}
const HOLIDAY_NAME_MAX = 200; // matches LOCATION_NAME_MAX below -- same free-text-cap convention
app.get('/api/holidays', (req, res) => {
  res.json({ success: true, holidays });
});

app.post('/api/holidays', requireRole('md', 'accounting'), (req, res) => {
  if (holidaysLoadFailed) return res.status(503).json({ success: false, message: 'Service temporarily unavailable' });
  const { date, name } = parseBody(req);
  // SECURITY/CORRECTNESS FIX 2026-08-13 (H-1/H-2, Opus audit): `date` was only checked for
  // truthiness -- isValidDateStr() already exists and is used everywhere else in this file
  // (leave dates, companyTripDates, etc.) but was never applied here. isPublicHoliday() matches by
  // EXACT string equality against the canonical YYYY-MM-DD attendance dates are always formatted
  // as, so any non-canonical stored value (a `type="date"` input degrades to a plain text field on
  // any browser that doesn't support it, e.g. "13/04/2026") is a permanent SILENT no-op: the
  // holiday shows correctly in the admin table and calendar, but OT pays x1.5 instead of x3, late-
  // deduction exemptions don't apply, and today's F-5 leave-days derivation counts it as a real
  // leave day -- every failure mode costs a real employee money with no visible symptom. A non-
  // string `date` also used to throw an uncaught TypeError on `.split('-')` (H-2), now covered by
  // the same check.
  if (typeof date !== 'string' || !isValidDateStr(date)) {
    return res.status(400).json({ success: false, message: 'date must be a valid YYYY-MM-DD date' });
  }
  // HYGIENE FIX 2026-08-13 (H-3, Opus audit): `name` was only checked for truthiness -- no type
  // check, no length cap (this file's other free-text fields are all capped, e.g. LOCATION_NAME_MAX/
  // REASON_MAX below), and not trimmed (the client's addHoliday() already trims -- server now
  // matches instead of silently disagreeing with it for any non-UI caller).
  if (typeof name !== 'string') return res.status(400).json({ success: false, message: 'name is required' });
  const cleanName = name.trim();
  if (!cleanName || cleanName.length > HOLIDAY_NAME_MAX) {
    return res.status(400).json({ success: false, message: `name must be 1-${HOLIDAY_NAME_MAX} characters` });
  }
  // HYGIENE FIX 2026-08-13 (H-4, Opus audit): the duplicate-date guard is exact-string-only, so it
  // only protects against re-adding the same day once `date` is validated/normalized above --
  // moved after the validation instead of before, so a would-be-duplicate submitted in a slightly
  // different (now-rejected) shape doesn't slip past this check first.
  if (holidays.find(h => h.date === date)) return res.status(400).json({ success: false, message: 'วันนี้มีอยู่แล้ว' });
  const h = { id: nextId(holidays), date, name: cleanName, year: parseInt(date.split('-')[0]) };
  holidays.push(h);
  holidays.sort((a, b) => a.date.localeCompare(b.date));
  atomicWrite(holidaysPath, JSON.stringify(holidays, null, 2));
  res.json({ success: true, holiday: h });
});

app.delete('/api/holidays/:id', requireRole('md', 'accounting'), (req, res) => {
  if (holidaysLoadFailed) return res.status(503).json({ success: false, message: 'Service temporarily unavailable' });
  const id = parseInt(req.params.id);
  const idx = holidays.findIndex(h => h.id === id);
  if (idx < 0) return res.status(404).json({ success: false, message: 'not found' });
  holidays.splice(idx, 1);
  atomicWrite(holidaysPath, JSON.stringify(holidays, null, 2));
  res.json({ success: true });
});

// ===== COMPANY ANNOUNCEMENTS (Dashboard board — collaborative) =====
const ANNOUNCEMENTS_FILE = 'announcements.json';
const ANNOUNCEMENT_MAX_LEN = 1000;
const ANNOUNCEMENT_MAX_ITEMS = 50;

function readAnnouncements() {
  const data = readJSON(ANNOUNCEMENTS_FILE, []);
  if (data === null) return null;
  return Array.isArray(data) ? data : [];
}
function writeAnnouncements(list) {
  writeJSON(ANNOUNCEMENTS_FILE, list);
}
function sanitizeAnnouncementBody(raw) {
  if (typeof raw !== 'string') return null;
  // Strip control chars except newline/tab; trim; hard-cap length.
  const cleaned = raw.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim();
  if (!cleaned) return null;
  if (cleaned.length > ANNOUNCEMENT_MAX_LEN) return null;
  return cleaned;
}
function announcementActor(live) {
  return {
    id: live.id,
    name: String(live.name || live.username || 'User').slice(0, 120),
  };
}
function bangkokNowIso() {
  // Build Asia/Bangkok wall-clock ISO without relying on locale calendar order.
  // (Node on some NAS images ignores 'sv-SE' and returns US M/D/Y + AM/PM.)
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Bangkok',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(new Date());
    const get = (type) => (parts.find(p => p.type === type) || {}).value || '00';
    return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:${get('second')}+07:00`;
  } catch (_) {
    return new Date().toISOString();
  }
}

app.get('/api/announcements', (req, res) => {
  const list = readAnnouncements();
  if (list === null) return res.status(503).json({ success: false, message: 'Service temporarily unavailable' });
  const sorted = [...list].sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  res.json({ success: true, announcements: sorted });
});

app.post('/api/announcements', (req, res) => {
  const live = (readUsers() || []).find(u => u.id === req.user.sub);
  if (!live) return res.status(403).json({ success: false, message: 'Forbidden' });
  if (!isSuperAdminUser(live) && (live.isObserver || live.active === false)) {
    return res.status(403).json({ success: false, message: 'Forbidden: observer or inactive account' });
  }
  const rawBody = parseBody(req);
  const text = sanitizeAnnouncementBody(rawBody && rawBody.body);
  if (!text) return res.status(400).json({ success: false, message: 'Announcement text required (max 1000 characters)' });
  const list = readAnnouncements();
  if (list === null) return res.status(503).json({ success: false, message: 'Service temporarily unavailable' });
  const actor = announcementActor(live);
  const now = bangkokNowIso();
  const item = {
    id: Date.now() * 1000 + Math.floor(Math.random() * 1000),
    body: text,
    createdById: actor.id,
    createdByName: actor.name,
    createdAt: now,
    updatedById: actor.id,
    updatedByName: actor.name,
    updatedAt: now,
  };
  list.unshift(item);
  while (list.length > ANNOUNCEMENT_MAX_ITEMS) list.pop();
  writeAnnouncements(list);
  broadcast({ type: 'ANNOUNCEMENTS_UPDATED' });
  res.json({ success: true, announcement: item });
});

app.put('/api/announcements/:id', (req, res) => {
  const live = (readUsers() || []).find(u => u.id === req.user.sub);
  if (!live) return res.status(403).json({ success: false, message: 'Forbidden' });
  if (!isSuperAdminUser(live) && (live.isObserver || live.active === false)) {
    return res.status(403).json({ success: false, message: 'Forbidden: observer or inactive account' });
  }
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ success: false, message: 'invalid id' });
  const rawBody = parseBody(req);
  const text = sanitizeAnnouncementBody(rawBody && rawBody.body);
  if (!text) return res.status(400).json({ success: false, message: 'Announcement text required (max 1000 characters)' });
  const list = readAnnouncements();
  if (list === null) return res.status(503).json({ success: false, message: 'Service temporarily unavailable' });
  const idx = list.findIndex(a => a.id === id);
  if (idx < 0) return res.status(404).json({ success: false, message: 'not found' });
  const actor = announcementActor(live);
  const now = bangkokNowIso();
  list[idx] = {
    ...list[idx],
    body: text,
    updatedById: actor.id,
    updatedByName: actor.name,
    updatedAt: now,
  };
  writeAnnouncements(list);
  broadcast({ type: 'ANNOUNCEMENTS_UPDATED' });
  res.json({ success: true, announcement: list[idx] });
});

app.delete('/api/announcements/:id', (req, res) => {
  const live = (readUsers() || []).find(u => u.id === req.user.sub);
  if (!live) return res.status(403).json({ success: false, message: 'Forbidden' });
  if (!isSuperAdminUser(live) && (live.isObserver || live.active === false)) {
    return res.status(403).json({ success: false, message: 'Forbidden: observer or inactive account' });
  }
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ success: false, message: 'invalid id' });
  const list = readAnnouncements();
  if (list === null) return res.status(503).json({ success: false, message: 'Service temporarily unavailable' });
  const idx = list.findIndex(a => a.id === id);
  if (idx < 0) return res.status(404).json({ success: false, message: 'not found' });
  list.splice(idx, 1);
  writeAnnouncements(list);
  broadcast({ type: 'ANNOUNCEMENTS_UPDATED' });
  res.json({ success: true });
});

// ===== WEB CHECK-OUT LATE NIGHT REVIEWS (2026-09-23) =====
// { "<userId>_<YYYY-MM-DD>": { decision:'allow'|'deny', checkOut, rawCheckOut, by, byId, at } }
// Own file, not a settings key -- PUT /api/settings deep-merges object keys, which would make a
// cleared review impossible to delete. Unreadable/corrupt file => null => callers fail closed.
const CHECKOUT_REVIEWS_FILE = 'checkout-reviews.json';
const CHECKOUT_REVIEWS_UNAVAILABLE = 'Service temporarily unavailable';
const withCheckoutReviewsLock = makeHandlerLock('CHECKOUT_REVIEWS');
function readCheckoutReviews() {
  const data = readJSON(CHECKOUT_REVIEWS_FILE, {});
  if (data === null) return null;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  return data;
}
// Full-access roles (md/accounting/manager; managers also browse others' attendance) get every
// review; everyone else only their own "<id>_" keys.
function handleGetCheckoutReviews(req, res) {
  const users = readUsers();
  if (users === null) return res.status(503).json({ success: false, message: CHECKOUT_REVIEWS_UNAVAILABLE });
  const live = users.find(u => u.id === req.user.sub);
  if (!live) return res.status(403).json({ success: false, message: 'Forbidden' });
  const all = readCheckoutReviews();
  if (all === null) return res.status(503).json({ success: false, message: CHECKOUT_REVIEWS_UNAVAILABLE });
  if (isLeaveFullAccess(live)) return res.json({ success: true, reviews: all });
  const prefix = `${live.id}_`;
  const own = {};
  Object.keys(all).forEach(k => { if (k.startsWith(prefix)) own[k] = all[k]; });
  return res.json({ success: true, reviews: own });
}
// Accounting/MD Allow / Deny / clear (decision:null) a web check-out at/after the Late Night time.
// requireRole('md','accounting') already refuses observers/inactive accounts (superadmin inherits,
// unchanged). Never on one's own record; never in a locked / Accounting-confirmed / MD-approved
// period (every decision, including a clear). Times are re-derived here -- never taken from the
// client. The broadcast carries no review data; clients re-fetch the scoped GET.
function handlePutCheckoutReview(req, res) {
  try {
    const users = readUsers();
    if (users === null) return res.status(503).json({ success: false, message: CHECKOUT_REVIEWS_UNAVAILABLE });
    const live = users.find(u => u.id === req.user.sub);
    if (!live) return res.status(403).json({ success: false, message: 'Forbidden: user record not found' });
    const body = parseBody(req) || {};
    const userId = Number(body.userId);
    const dateStr = body.date;
    const decision = body.decision;
    if (!Number.isInteger(userId) || userId <= 0) {
      return res.status(400).json({ success: false, message: 'userId is required' });
    }
    if (typeof dateStr !== 'string' || !isValidDateStr(dateStr)) {
      return res.status(400).json({ success: false, message: 'date must be a valid YYYY-MM-DD date' });
    }
    if (decision !== 'allow' && decision !== 'deny' && decision !== null) {
      return res.status(400).json({ success: false, message: "decision must be 'allow', 'deny' or null" });
    }
    // FIX (final review, T10/concurrency): the client now sends the check-out time it displayed
    // when allowing/denying, so a stale screen (someone else's later web tap, or an approved time
    // correction, changed the effective check-out since this screen was loaded) can be caught
    // instead of silently reviewing the wrong time. Required for allow/deny; optional for a
    // decision:null clear (clearing doesn't assert any particular check-out was reviewed).
    // Validated for format only -- never stored; the stored value stays server-derived (day.checkOut
    // below), same as before this fix.
    const bodyCheckOut = body.checkOut;
    if (decision === 'allow' || decision === 'deny') {
      if (typeof bodyCheckOut !== 'string' || !HHMM_RE.test(bodyCheckOut)) {
        return res.status(400).json({ success: false, message: 'checkOut is required and must be in HH:MM format' });
      }
    } else if (bodyCheckOut !== undefined && bodyCheckOut !== null && (typeof bodyCheckOut !== 'string' || !HHMM_RE.test(bodyCheckOut))) {
      return res.status(400).json({ success: false, message: 'checkOut must be in HH:MM format' });
    }
    if (userId === live.id) {
      return res.status(403).json({ success: false, message: 'You cannot review your own check-out' });
    }
    const target = users.find(u => u.id === userId);
    if (!target || isSuperAdminUser(target)) {
      return res.status(404).json({ success: false, message: 'Employee not found' });
    }
    // lockedPeriodInRange() reads settings through readSettings(), which turns a read failure into
    // {} (= "nothing locked") -- check the raw read first so a failure refuses instead.
    if (readJSON('settings.json', {}) === null) {
      return res.status(503).json({ success: false, message: CHECKOUT_REVIEWS_UNAVAILABLE });
    }
    if (lockedPeriodInRange(dateStr, dateStr)) {
      return res.status(400).json({ success: false, message: 'This pay period is locked' });
    }
    if (accountingConfirmedInRange(dateStr, dateStr, userId)) {
      return res.status(409).json({ success: false, message: 'Accounting has already confirmed tax for this period — unconfirm before making changes' });
    }
    if (mdApprovedPeriodInRange(dateStr, dateStr, userId)) {
      return res.status(409).json({ success: false, message: 'Payroll for this period has already been approved by the Managing Director -- ask them to revoke approval first' });
    }
    const reviews = readCheckoutReviews();
    if (reviews === null) return res.status(503).json({ success: false, message: CHECKOUT_REVIEWS_UNAVAILABLE });
    const day = attendanceDayForUser(target, dateStr, reviews);
    if (!checkoutReviewTrigger(day, target, getAppSettings())) {
      return res.status(400).json({ success: false, message: 'This day has no web check-out at or after the Late Night time to review' });
    }
    // FIX (final review, T10/concurrency): re-derive the real check-out and compare against what
    // the reviewer's screen showed. If they differ, someone else's action (another web check-out,
    // an approved time correction) moved the goalposts between when the screen loaded and when
    // Allow/Deny was clicked -- refuse rather than silently recording a review of the wrong time.
    if ((decision === 'allow' || decision === 'deny') && bodyCheckOut !== day.checkOut) {
      // Machine-readable marker: this is the ONLY 409 reason from this endpoint that means "the
      // check-out time itself moved, reload and re-review" -- the other two 409s above (accounting
      // confirmed / MD approved) are period-lock states, not a stale check-out, and must not carry
      // this code so the client only shows the "reload and review again" toast for this one case.
      return res.status(409).json({ success: false, code: 'CHECKOUT_CHANGED', message: 'Check-out time changed — reload and review again' });
    }
    const key = `${userId}_${dateStr}`;
    let review = null;
    if (decision === null) {
      delete reviews[key];
    } else {
      review = {
        decision,
        checkOut: day.checkOut,
        rawCheckOut: day.rawCheckOut || null,
        by: String(live.name || live.username || 'User').slice(0, 120),
        byId: live.id,
        at: new Date().toISOString(),
      };
      reviews[key] = review;
    }
    writeJSON(CHECKOUT_REVIEWS_FILE, reviews);
    broadcast({ type: 'CHECKOUT_REVIEWS_UPDATED' });
    return res.json({ success: true, review });
  } catch (e) {
    const unavailable = !!(e && e.message === CHECKOUT_REVIEWS_UNAVAILABLE);
    console.error('[CHECKOUT_REVIEWS] PUT failed:', e && e.message);
    return res.status(unavailable ? 503 : 500).json({ success: false, message: unavailable ? CHECKOUT_REVIEWS_UNAVAILABLE : 'Server error' });
  }
}
app.get('/api/checkout-reviews', handleGetCheckoutReviews);
app.put('/api/checkout-reviews', requireRole('md', 'accounting'), withCheckoutReviewsLock(handlePutCheckoutReview));

// Was missing entirely — GET/PUT /api/settings referenced these but they were never defined,
// throwing ReferenceError on every call. This silently broke Approval Routing persistence
// (loadSettingsFromBackend()'s try/catch swallowed the failure on the frontend) — settings
// never actually saved to disk, always reverting to defaults on reload.
function readJSON(filename, fallback) {
  try {
    const filePath = path.join(DATA_DIR, filename);
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch(e) {
    console.error('[readJSON] failed', filename, e && e.message);
    return null;
  }
}
function writeJSON(filename, data) {
  // SECURITY FIX 2026-08-04 (retrospective Opus audit, MEDIUM): settings.json holds
  // emailConfig.pass (SMTP/Resend API key) -- was never chmod'd like the other secret files.
  atomicWrite(path.join(DATA_DIR, filename), JSON.stringify(data, null, 2), filename === 'settings.json');
}
if (fs.existsSync(path.join(DATA_DIR, 'settings.json'))) secureChmod(path.join(DATA_DIR, 'settings.json'));

// GET /api/settings
// SECURITY FIX 2026-07-19 (F-05): used to return the whole settings.json unconditionally,
// including emailConfig.pass (the SMTP password / Resend API key) -- any logged-in employee
// could read it straight off this endpoint and use it to send mail as the company outside this
// app entirely. Strip the secret for anyone who isn't md/accounting (the only roles the Settings
// page's Email Config section is shown to in the first place, so this doesn't remove anything a
// legitimate caller was actually using).
// SECURITY FIX 2026-08-12 (2nd comprehensive audit, F2): factored out of the GET handler and
// reused by the PUT response -- non-admins were getting the emailConfig credential stripped, but
// `tawi50Overrides` (every employee's annual gross income + personal income tax, keyed by
// userId) and `leaveCarryForward` (every employee's carry-forward balance) went out to ANY
// authenticated employee completely unstripped. `tawi50Overrides` has no legitimate non-admin
// reader at all (its only consumers are the md/accounting-only 50ทวิ page and the admin backup
// export) so it's dropped entirely; `leaveCarryForward` IS legitimately read by a normal user for
// their own balance (app.js's getCarryForwardDays()/getCarryForwardCompDays()), so it's narrowed
// to the caller's own entries instead of stripped outright.
function stripSensitiveSettingsForRole(settings, live) {
  const isAdmin = isPrivilegedAdmin(live);
  if (isAdmin) return settings;
  const out = { ...settings };
  if (out.emailConfig) {
    out.emailConfig = { ...out.emailConfig, pass: undefined, smtpUser: undefined };
  }
  if (out.appSettings && out.appSettings.emailConfig) {
    out.appSettings = { ...out.appSettings, emailConfig: { ...out.appSettings.emailConfig, pass: undefined, smtpUser: undefined } };
  }
  delete out.tawi50Overrides;
  // 2026-09-24: run log of the year-end carry-forward (who/when) -- only the md/accounting
  // Settings page reads it.
  delete out.leaveCarryForwardRuns;
  if (out.leaveCarryForward && live) {
    const year = bangkokYmd().y;
    const mine = {};
    for (const y of [year, year + 1]) {
      for (const k of [`${y}_${live.id}`, `comp_${y}_${live.id}`]) {
        if (out.leaveCarryForward[k] !== undefined) mine[k] = out.leaveCarryForward[k];
      }
    }
    out.leaveCarryForward = mine;
  } else if (out.leaveCarryForward) {
    out.leaveCarryForward = {};
  }
  if (out.leaveOpeningUsed && live) {
    const year = bangkokYmd().y;
    const mine = {};
    for (const y of [year, year + 1]) {
      for (const type of ['annual', 'sick', 'business']) {
        const k = `${y}_${live.id}_${type}`;
        if (out.leaveOpeningUsed[k] !== undefined) mine[k] = out.leaveOpeningUsed[k];
      }
    }
    out.leaveOpeningUsed = mine;
  } else if (out.leaveOpeningUsed) {
    out.leaveOpeningUsed = {};
  }
  return out;
}
app.get('/api/settings', (req, res) => {
  const settings = readJSON('settings.json', {});
  if (settings === null) return res.status(503).json({ success:false, message:'Service temporarily unavailable' });
  const live = (readUsers() || []).find(u => u.id === req.user.sub);
  res.json(stripSensitiveSettingsForRole(settings, live));
});

// PUT /api/settings
// SECURITY FIX 2026-07-19 (F-01): this generic endpoint is shared by many different
// settings sub-features with different legitimate roles (company/tax/email config = md,accounting
// only; approval-delegation toggle = also manager, for types where manager is in that type's own
// route -- see canToggleApprovalDelegationForType() in app.js). requireRole() here only closes the
// endpoint to non-management roles (previously ANY logged-in employee, including driver/marketing,
// could rewrite the entire settings.json); it does not yet enforce which *fields* each of those
// three roles may touch within a single PUT body -- a manager could in theory smuggle unrelated
// settings keys into the same request.
// SECURITY FIX 2026-08-12 (Opus comprehensive audit): the gap flagged above is now closed. Two
// layers: (1) a top-level key whitelist -- an unknown key name is rejected outright, instead of
// silently accumulating forever via Object.assign (unbounded settings.json growth / DoS, since
// readSettings() is a synchronous readFileSync on effectively every request's hot path); (2) a
// per-key role list, matching exactly what each key's UI control is actually gated to (grepped
// every `adminSection`/role check around each Settings-page section in app.js) -- a manager can
// no longer touch anything server-side that the UI never lets them click. `manager`'s only two
// legitimate keys are the approval-delegation stand-in toggle (canToggleApprovalDelegationForType()
// in app.js) and periodStartDay... no: periodStartDay lives inside appSettings, which is md/
// accounting only, matching the UI. Rejecting is a straight 403, not a silent field drop, so a
// legitimate multi-key save from a role that owns SOME but not all of the keys in one PUT body
// still needs to be split client-side into separate calls -- no such multi-owner PUT exists today
// (checked every apiFetch('/api/settings', {method:'PUT'...}) call site in app.js).
const SETTINGS_KEY_ROLES = {
  periodLocks: ['md'],
  approvalRouting: ['md'],
  emailConfig: ['md', 'accounting'],
  emailNotification: ['md', 'accounting'],
  appSettings: ['md', 'accounting'],
  appSettingsUpdatedAt: ['md', 'accounting'],
  payslipEmailEnabled: ['md', 'accounting'],
  // 2026-09-24 (owner): leaveCarryForward is server-owned now (runYearEndCarryForward /
  // refreshSnapshottedCarryForward only) -- refused explicitly in the handler below.
  leaveOpeningUsed: ['md', 'accounting'],
  tawi50Overrides: ['md', 'accounting'],
  companyTripDates: ['md', 'accounting'],
  // SECURITY FIX 2026-08-13 (4th re-audit, Finding D): 'accounting' had no UI path to either key
  // (canToggleApprovalDelegationForType() in app.js blocks accounting entirely -- only md/manager
  // can toggle the delegation switch, and per-type only for types actually routed to them) yet
  // could write here directly, letting accounting self-grant its own stand-in approval authority.
  // User-confirmed 2026-08-13: only md and manager ever press this toggle.
  approvalDelegateOverrides: ['md', 'manager'],
  approvalDelegateOverridePeriod: ['md', 'manager'],
};
app.put('/api/settings', requireRole('md', 'accounting', 'manager'), (req, res) => {
  const body = parseBody(req);
  if (!body || typeof body !== 'object') {
    return res.status(400).json({ success: false, message: 'invalid body' });
  }
  const live = (readUsers() || []).find(u => u.id === req.user.sub);
  if (!live) return res.status(403).json({ success: false, message: 'Forbidden' });
  if (isSuperAdminUser(live) && body.tawi50Overrides !== undefined) {
    return res.status(403).json({ success: false, message: 'System account: 50-Tawi overrides cannot be saved' });
  }
  function settingsRoleAllowed(actor, allowedRoles) {
    if (allowedRoles.includes(actor.role)) return true;
    if (isSuperAdminUser(actor) && allowedRoles.some(r => ['md', 'accounting', 'manager'].includes(r))) return true;
    return false;
  }
  // 2026-09-24: server-owned key -- written only by runYearEndCarryForward(). Not in
  // SETTINGS_KEY_ROLES either (so the loop below would already 400 it), and Object.assign(current,
  // body) keeps the stored value because a client can never send the key. Explicit for clarity.
  if (Object.prototype.hasOwnProperty.call(body, 'leaveCarryForwardRuns')) {
    return res.status(403).json({ success: false, message: 'leaveCarryForwardRuns is set by the server only' });
  }
  // 2026-09-24 (owner): same for the carry-forward values themselves. No client path sends the key
  // any more (saveLeaveCarryForward was removed with the server-side year-end run); a PUT that
  // still does is refused whole rather than silently dropping part of it.
  if (Object.prototype.hasOwnProperty.call(body, 'leaveCarryForward')) {
    return res.status(403).json({ success: false, code: 'cf-server-only', message: 'leaveCarryForward is set by the server only' });
  }
  for (const key of Object.keys(body)) {
    // 2026-08-12 (3rd audit, F6c): `SETTINGS_KEY_ROLES[key]` is a plain-property lookup, so an
    // inherited name like "constructor"/"toString"/"__proto__" (JSON.parse creates these as real
    // own-enumerable data properties, not the actual prototype setter, so Object.keys() does
    // return them) resolved to an Object.prototype method instead of undefined -- truthy, so the
    // "unknown key" check never fired, and `.includes` then threw a TypeError (an ugly 500, not a
    // clean 400). Never a write (the throw happens before writeJSON), so not exploitable, but
    // Array.isArray() closes the crash outright.
    const allowedRoles = SETTINGS_KEY_ROLES[key];
    if (!Array.isArray(allowedRoles)) {
      return res.status(400).json({ success: false, message: `unknown settings key "${key}"` });
    }
    if (!settingsRoleAllowed(live, allowedRoles)) {
      return res.status(403).json({ success: false, message: `role "${live.role}" may not set "${key}"` });
    }
  }
  // SECURITY FIX 2026-08-11 (Opus re-audit, MEDIUM-2): approvalRouting was written with ZERO
  // validation of its role-name values, even though this endpoint is open to md/accounting/
  // manager. An invalid entry (e.g. a garbage string, or worse, an HTML/script payload) would
  // reach several innerHTML sinks that read a stored route's role names for display (the
  // approval-route banner in the Time Correction modal, My Requests progress chips, the approval
  // flowchart) -- stored XSS via a config field nobody expected to be attacker-controlled. It
  // would also make that type permanently un-approvable (an invalid role name can never satisfy
  // `routeArr.includes(live.role)`), the "stuck queue" failure mode this project has hit before.
  // NOTE: also accepts the legacy boolean format (`false`/`true`) alongside a real array --
  // getApprovalRoute() (app.js and server.js both) still tolerates it for older saved settings,
  // and production's own settings.json genuinely has `ot: false` today, so rejecting booleans
  // here would break re-saving the current live config.
  // 2026-08-11 (Opus re-audit, follow-up finding): the per-key value check below only ran when
  // `body.approvalRouting` was truthy AND iterated with Object.entries() -- but Object.entries()
  // of `{}`, `[]`, `5`, or `true` all return `[]`, so the loop silently does nothing and lets
  // those values straight through to the write below. Validate the CONTAINER shape first.
  // SECURITY FIX 2026-08-12 (Opus re-audit, HIGH-1): the container/value checks below never
  // validated approvalRouting's KEY NAMES against the known leave-type list. This endpoint is
  // open to `manager` too -- a manager could PUT `approvalRouting: {"<payload>": ["md"]}` and
  // that unknown key would be written verbatim, then rendered raw into 4 innerHTML/onclick sinks
  // in ⚙️ Approval Settings / the flow chart (app.js's openApprovalSettings()/
  // openApprovalFlowChart()) -- a manager-to-MD session JS-injection, since one of those sinks is
  // an `onclick="...('${type}')"` handler. ALLOWED_ROUTE_KEYS is exactly the same set the
  // client's own render loops iterate (Object.keys(APPROVAL_ROUTING)) -- an unknown key was never
  // actually meaningful to anything, only dangerous.
  const ALLOWED_ROUTE_KEYS = Object.keys(APPROVAL_ROUTING_DEFAULT);
  if (body.approvalRouting !== undefined) {
    const ar = body.approvalRouting;
    if (!ar || typeof ar !== 'object' || Array.isArray(ar) || Object.keys(ar).length === 0) {
      return res.status(400).json({ success: false, message: 'approvalRouting must be a non-empty object' });
    }
    for (const k of Object.keys(ar)) {
      if (!ALLOWED_ROUTE_KEYS.includes(k)) {
        return res.status(400).json({ success: false, message: `unknown approvalRouting key "${k}"` });
      }
    }
  }
  const ROUTE_ROLES = ['manager', 'accounting', 'md'];
  if (body.approvalRouting) {
    for (const [routeType, routeVal] of Object.entries(body.approvalRouting)) {
      const isValidArray = Array.isArray(routeVal) && routeVal.length > 0 && routeVal.every(r => ROUTE_ROLES.includes(r));
      const isValidLegacyBoolean = typeof routeVal === 'boolean';
      if (!isValidArray && !isValidLegacyBoolean) {
        return res.status(400).json({ success: false, message: `invalid approvalRouting for "${routeType}" -- must be a non-empty array of manager/accounting/md, or a legacy boolean` });
      }
    }
  }
  const current = readJSON('settings.json', {});
  if (current === null) return res.status(503).json({ success:false, message:'Service temporarily unavailable' });
  // 2026-08-11 (Opus re-audit): the actual root cause of the earlier data-loss incident --
  // `approvalRouting` was never deep-merged like `appSettings` is a few lines below, so ANY
  // partial update (even a fully validated one) replaces the WHOLE map via the top-level
  // Object.assign further down, silently dropping every key the request didn't mention. The
  // real client (saveApprovalRouting()) always sends the complete object, so this merge is a
  // no-op for it -- but a partial update (a debugging script, a future feature, a different
  // caller) now merges instead of wiping.
  // SECURITY FIX 2026-08-12 (Opus re-audit, HIGH-1 continued): naively merging in whatever is
  // ALREADY on disk would make an unknown/injected key from BEFORE this whitelist existed
  // permanent -- every future save would keep resurrecting it via the merge, with no API path to
  // ever remove it again (short of hand-editing settings.json on the NAS). Filter `current` down
  // to only known keys first, so the merge can only ever carry forward legitimate values.
  // MEDIUM FIX (Opus re-audit): also guard the shape of `current.approvalRouting` itself -- if it
  // were ever a non-plain-object (a leftover from some pre-validation write), spreading it would
  // produce garbage numeric keys that then fail EVERY future save's per-key validation forever.
  if (body.approvalRouting && current.approvalRouting && typeof current.approvalRouting === 'object' && !Array.isArray(current.approvalRouting)) {
    const cleanCurrent = {};
    for (const k of ALLOWED_ROUTE_KEYS) {
      if (current.approvalRouting[k] !== undefined) cleanCurrent[k] = current.approvalRouting[k];
    }
    body.approvalRouting = { ...cleanCurrent, ...body.approvalRouting };
  }

  // SECURITY/CORRECTNESS FIX 2026-08-12 (Opus re-audit, MEDIUM-2): `periodLocks` has the IDENTICAL
  // shallow-replace hazard that caused the approvalRouting data-loss incident -- savePeriodLocks()
  // (app.js) always sends the complete `PERIOD_LOCKS` map, so a normal save is a no-op here, but a
  // stale browser tab (loaded before someone else locked/unlocked a different period) or any
  // partial-update caller would silently WIPE every other period's lock state -- and unlike
  // approvalRouting, the consequence is worse: a period that was deliberately locked (payroll
  // already paid out) would silently become editable again. Keys here are date-based
  // (getPeriodLockKey()'s YYYYMMDD format), not a fixed enum like approvalRouting, so validate
  // shape instead of a key whitelist: every key must be an 8-digit string, every value must be
  // `{locked: boolean}`.
  const PERIOD_LOCK_KEY_RE = /^\d{8}$/;
  // 2026-08-12 (2nd comprehensive audit, F5): shared with the merge filter below, so "what counts
  // as a valid periodLocks entry" can't drift between validating a NEW request and filtering what
  // survives from disk.
  const isValidPeriodLockEntry = (key, val) => PERIOD_LOCK_KEY_RE.test(key) && val && typeof val === 'object' && !Array.isArray(val) &&
    typeof val.locked === 'boolean' &&
    Object.keys(val).every(f => ['locked', 'lockedAt', 'lockedBy'].includes(f)) &&
    Object.keys(val).every(f => f === 'locked' || val[f] === undefined || (typeof val[f] === 'string' && val[f].length <= 100));
  if (body.periodLocks !== undefined) {
    const pl = body.periodLocks;
    if (!pl || typeof pl !== 'object' || Array.isArray(pl) || Object.keys(pl).length > 500) {
      return res.status(400).json({ success: false, message: 'periodLocks must be an object of 500 or fewer entries' });
    }
    for (const [key, val] of Object.entries(pl)) {
      if (!PERIOD_LOCK_KEY_RE.test(key)) {
        return res.status(400).json({ success: false, message: `invalid periodLocks key "${key}" -- must be an 8-digit YYYYMMDD period key` });
      }
      if (!val || typeof val !== 'object' || Array.isArray(val) || typeof val.locked !== 'boolean') {
        return res.status(400).json({ success: false, message: `invalid periodLocks value for "${key}" -- must be an object with a boolean "locked"` });
      }
      // 2026-08-12 (Opus comprehensive audit, LOW): lockedAt/lockedBy (set by app.js:1024's
      // lockPeriod()) were never field-whitelisted. Nothing currently reads or renders them
      // (checked every reference repo-wide), so this isn't a live XSS sink -- whitelisted anyway
      // so the audit trail can't be filled with arbitrary garbage.
      for (const f of Object.keys(val)) {
        if (!['locked', 'lockedAt', 'lockedBy'].includes(f)) {
          return res.status(400).json({ success: false, message: `unknown periodLocks field "${f}"` });
        }
        if (f !== 'locked' && val[f] !== undefined && (typeof val[f] !== 'string' || val[f].length > 100)) {
          return res.status(400).json({ success: false, message: `periodLocks["${key}"].${f} must be a string of 100 characters or fewer` });
        }
      }
    }
  }
  // SECURITY FIX 2026-08-12 (2nd comprehensive audit, F5): the merge used to carry forward
  // WHATEVER was already on disk unfiltered -- validation only ever runs on `body.X`, so a bad
  // entry written before this validation existed (or before it was strict enough) would survive
  // every future save forever, with no API path to ever remove it again. Filter `current` through
  // the same validity check new entries must pass.
  if (body.periodLocks && current.periodLocks && typeof current.periodLocks === 'object' && !Array.isArray(current.periodLocks)) {
    const cleanPeriodLocks = {};
    for (const [k, v] of Object.entries(current.periodLocks)) {
      if (isValidPeriodLockEntry(k, v)) cleanPeriodLocks[k] = v;
    }
    body.periodLocks = { ...cleanPeriodLocks, ...body.periodLocks };
  }

  // SECURITY FIX 2026-08-12 (Opus comprehensive audit): companyTripDates had zero validation --
  // an element is interpolated raw into an `onclick="removeCompanyTripDate('${dateStr}')"`
  // handler in app.js's Holidays page (JS injection, same sink class as the checkIn/checkOut
  // JS-injection fixed earlier this week via escapeJsAttr()). Now MD/accounting-only (see
  // SETTINGS_KEY_ROLES above) plus format-validated here as defense in depth.
  if (body.companyTripDates !== undefined) {
    const cd = body.companyTripDates;
    if (!Array.isArray(cd) || cd.length > 400 || !cd.every(d => typeof d === 'string' && isValidDateStr(d))) {
      return res.status(400).json({ success: false, message: 'companyTripDates must be an array of 400 or fewer valid YYYY-MM-DD dates' });
    }
    // 2026-09-24 (owner): refuse newly ADDED dates that approved money records already cover
    // (companyTripConflicts). Pre-existing dates are not re-checked; removals always pass.
    const beforeTrip = new Set(Array.isArray(current.companyTripDates) ? current.companyTripDates : []);
    const addedTrip = cd.filter(d => !beforeTrip.has(d));
    if (addedTrip.length) {
      const tripLeaves = readLeaves();
      if (tripLeaves === null) return res.status(503).json({ success: false, message: 'Service temporarily unavailable' });
      const conflicts = companyTripConflicts(tripLeaves, addedTrip);
      if (conflicts.length) {
        const tripUsers = readUsers() || [];
        return res.status(409).json({
          success: false, code: 'company-trip-conflict',
          message: 'Approved allowance / OT / Holiday Work / Abroad records exist on these dates -- revoke or cancel them before adding the Company Trip',
          conflicts: conflicts.slice(0, 100).map(c => {
            const u = tripUsers.find(x => x.id === c.userId);
            return { ...c, name: u ? u.name : '' };
          }),
        });
      }
    }
  }

  // 2026-09-24: the leaveCarryForward validation + stale-entry merge that lived here is gone --
  // the key is refused above (server-owned). Its checks (key format, 0-60 numbers) are what
  // runYearEndCarryForward/refreshSnapshottedCarryForward produce by construction.

  // Opening leave balances (go-live prior-used days) — key `${year}_${userId}_${type}`.
  // Stored as days already used before the system went live; not leave history rows.
  const LEAVE_OPENING_KEY_RE = /^\d{4}_\d+_(annual|sick|business)$/;
  if (body.leaveOpeningUsed !== undefined) {
    const ou = body.leaveOpeningUsed;
    if (!ou || typeof ou !== 'object' || Array.isArray(ou) || Object.keys(ou).length > 500) {
      return res.status(400).json({ success: false, message: 'leaveOpeningUsed must be an object of 500 or fewer entries' });
    }
    for (const [k, v] of Object.entries(ou)) {
      if (!LEAVE_OPENING_KEY_RE.test(k)) {
        return res.status(400).json({ success: false, message: `invalid leaveOpeningUsed key "${k}"` });
      }
      // 2026-09-21: negative is legal and means a CREDIT -- days carried in on top of this year's
      // pool, for an employee whose real go-live balance exceeds the current-year quota. Dual-sync
      // with app.js saveOpeningLeaveBalancesFromUI(), which clamps to the same [-366, 366] range.
      if (typeof v !== 'number' || !Number.isFinite(v) || v < -366 || v > 366) {
        return res.status(400).json({ success: false, message: `leaveOpeningUsed["${k}"] must be a number between -366 and 366` });
      }
    }
  }
  if (body.leaveOpeningUsed && current.leaveOpeningUsed && typeof current.leaveOpeningUsed === 'object' && !Array.isArray(current.leaveOpeningUsed)) {
    const cleanOU = {};
    for (const [k, v] of Object.entries(current.leaveOpeningUsed)) {
      if (LEAVE_OPENING_KEY_RE.test(k) && typeof v === 'number' && Number.isFinite(v) && v >= -366 && v <= 366) cleanOU[k] = v;
    }
    body.leaveOpeningUsed = { ...cleanOU, ...body.leaveOpeningUsed };
  }

  // SECURITY/CORRECTNESS FIX 2026-08-12 (Opus comprehensive audit): tawi50Overrides had zero
  // validation -- reaches an unescaped `value="..."` HTML attribute in app.js's 50 ทวิ page, and
  // silently falsifies the underlying tax-certificate figures if left as free-form input.
  const TAWI_KEY_RE = /^\d{4}_\d+$/;
  // 2026-08-17: ssoOverride/pvdOverride added (SSF/PVD are now editable in the 50 Tawi UI the
  // same way gross/PIT already were) -- kept as ONE const so the two validation sites below
  // (isValidTawiEntry's stale-entry filter, and the per-request field-name check) can't drift
  // out of sync the way this project's other duplicated field-lists have before.
  const TAWI_OVERRIDE_FIELDS = ['grossOverride', 'pitOverride', 'ssoOverride', 'pvdOverride'];
  // 2026-09-24: amounts carry satang now (OT/tax 2 dp, PVD 1 dp), so an override may too -- at most
  // 2 decimal places (was whole baht only).
  const isTawiAmount = x => typeof x === 'number' && Number.isFinite(x) && x >= 0 && x <= 1e9 && round2HalfUp(x) === x;
  const isValidTawiEntry = (key, v) => TAWI_KEY_RE.test(key) && v && typeof v === 'object' && !Array.isArray(v) &&
    Object.keys(v).every(f => TAWI_OVERRIDE_FIELDS.includes(f)) &&
    Object.keys(v).every(f => isTawiAmount(v[f]));
  if (body.tawi50Overrides !== undefined) {
    const tv = body.tawi50Overrides;
    if (!tv || typeof tv !== 'object' || Array.isArray(tv) || Object.keys(tv).length > 500) {
      return res.status(400).json({ success: false, message: 'tawi50Overrides must be an object of 500 or fewer entries' });
    }
    for (const [k, v] of Object.entries(tv)) {
      if (!TAWI_KEY_RE.test(k)) {
        return res.status(400).json({ success: false, message: `invalid tawi50Overrides key "${k}"` });
      }
      if (!v || typeof v !== 'object' || Array.isArray(v)) {
        return res.status(400).json({ success: false, message: `tawi50Overrides["${k}"] must be an object` });
      }
      for (const f of Object.keys(v)) {
        if (!TAWI_OVERRIDE_FIELDS.includes(f)) {
          return res.status(400).json({ success: false, message: `unknown tawi50Overrides field "${f}"` });
        }
        if (!isTawiAmount(v[f])) {
          return res.status(400).json({ success: false, message: `tawi50Overrides["${k}"].${f} must be a number between 0 and 1e9 with at most 2 decimal places` });
        }
      }
    }
  }
  if (body.tawi50Overrides && current.tawi50Overrides && typeof current.tawi50Overrides === 'object' && !Array.isArray(current.tawi50Overrides)) {
    // SECURITY FIX 2026-08-12 (2nd comprehensive audit, F5): same stale-disk-entry filter as
    // periodLocks/leaveCarryForward above.
    const cleanTawi = {};
    for (const [k, v] of Object.entries(current.tawi50Overrides)) {
      if (isValidTawiEntry(k, v)) cleanTawi[k] = v;
    }
    body.tawi50Overrides = { ...cleanTawi, ...body.tawi50Overrides };
  }

  // SECURITY/CORRECTNESS FIX 2026-08-12 (Opus comprehensive audit): isApprovalDelegationActiveForType()
  // fails OPEN when approvalDelegateOverridePeriod doesn't match the current period key -- a
  // garbage value there turns on Accounting's stand-in authority for EVERY request type
  // permanently, bypassing every per-type toggle MD set. approvalDelegateOverrides' keys must be
  // real leave types (reusing the same whitelist approvalRouting validates against).
  // SECURITY FIX 2026-08-12 (2nd comprehensive audit, F1): the /^\d{8}$/ shape check above only
  // validated FORMAT, not value -- every 8-digit string passed, including every WRONG one.
  // isApprovalDelegationActiveForType() (below) fails OPEN whenever this doesn't match the
  // current period key, so a manager sending any past/future 8-digit string (or even a raw
  // number, which also passed the old regex-based check since regex coerces to string) turned on
  // Accounting's stand-in authority for EVERY request type permanently, bypassing every per-type
  // toggle MD had set. The only legitimate value a real client ever sends is the CURRENT period
  // key (app.js's currentApprovalDelegationPeriodKey(), byte-identical to the server's own).
  // SECURITY FIX 2026-08-12 (4th re-audit, Finding A): `null` was exempted from this check, which
  // let a request carrying ONLY `{approvalDelegateOverridePeriod: null}` skip both this check and
  // the whole `approvalDelegateOverrides` block below (F3's per-type manager gate included) while
  // still writing `null` to disk -- isApprovalDelegationActiveForType() fails OPEN on any period
  // mismatch, so this silently re-enabled Accounting's stand-in authority for every type MD had
  // turned off. The real client never sends null (saveApprovalDelegationSetting() in app.js always
  // resets this to the current period key first), so nothing legitimate depends on the exemption.
  if (body.approvalDelegateOverridePeriod !== undefined &&
      body.approvalDelegateOverridePeriod !== currentApprovalDelegationPeriodKey()) {
    return res.status(400).json({ success: false, message: 'approvalDelegateOverridePeriod must be the current period key' });
  }
  if (body.approvalDelegateOverrides !== undefined) {
    const ado = body.approvalDelegateOverrides;
    if (!ado || typeof ado !== 'object' || Array.isArray(ado)) {
      return res.status(400).json({ success: false, message: 'approvalDelegateOverrides must be an object' });
    }
    for (const [k, v] of Object.entries(ado)) {
      if (!ALLOWED_ROUTE_KEYS.includes(k)) {
        return res.status(400).json({ success: false, message: `unknown approvalDelegateOverrides key "${k}"` });
      }
      if (typeof v !== 'boolean') {
        return res.status(400).json({ success: false, message: `approvalDelegateOverrides["${k}"] must be a boolean` });
      }
      // SECURITY FIX 2026-08-12 (2nd comprehensive audit, F3): the top-level role gate lets
      // manager touch this KEY at all (their one legitimate use), but the real UI restricts a
      // manager to toggling delegation only for types where manager is actually in that type's
      // own approval route (canToggleApprovalDelegationForType() in app.js) -- the server never
      // enforced that per-TYPE restriction, so a manager could toggle delegation for a type
      // (e.g. 'annual', routed MD-only) they have no business touching.
      if (live.role === 'manager' && !approvalRouteForRouteKey(k).includes('manager')) {
        return res.status(403).json({ success: false, message: `manager may not change delegation for "${k}"` });
      }
    }
  }
  // SECURITY/CORRECTNESS FIX 2026-08-12: same deep-merge protection as emailConfig/emailNotification
  // above -- saveApprovalDelegationSetting() (app.js) always sends the complete
  // APPROVAL_DELEGATE_OVERRIDES object, so this merge is a no-op for the real client, but protects
  // against a partial update wiping every other type's delegation toggle.
  if (body.approvalDelegateOverrides && current.approvalDelegateOverrides && typeof current.approvalDelegateOverrides === 'object' && !Array.isArray(current.approvalDelegateOverrides)) {
    // 2026-08-12 (Finding 1b, 3rd re-audit): same stale-entry filter as the other keys above --
    // only carry forward entries whose key is a real leave type and whose value is a boolean.
    const cleanDelegate = {};
    for (const [k, v] of Object.entries(current.approvalDelegateOverrides)) {
      if (ALLOWED_ROUTE_KEYS.includes(k) && typeof v === 'boolean') cleanDelegate[k] = v;
    }
    body.approvalDelegateOverrides = { ...cleanDelegate, ...body.approvalDelegateOverrides };
  }
  // SECURITY/CORRECTNESS FIX 2026-08-12 (3rd audit, F4a): matches this project's own standing
  // rule from 2026-08-10 ("validate the RESOLVED value, not just whether this request touched the
  // field"). approvalDelegateOverridePeriod was only checked when THIS request explicitly sent
  // it -- a PUT carrying `approvalDelegateOverrides` alone (no period key, because the disk copy
  // is stale or absent) was accepted and silently had ZERO effect on
  // isApprovalDelegationActiveForType(), since that function only trusts overrides whose period
  // matches "now." An admin toggling delegation off would see a normal 200 and have no idea it
  // didn't actually apply. The real client (saveApprovalDelegationSetting()) always sends both
  // keys together, so this is a no-op for it.
  if (body.approvalDelegateOverrides !== undefined) {
    const resolvedPeriod = body.approvalDelegateOverridePeriod !== undefined ? body.approvalDelegateOverridePeriod : current.approvalDelegateOverridePeriod;
    if (resolvedPeriod !== currentApprovalDelegationPeriodKey()) {
      return res.status(400).json({ success: false, message: 'approvalDelegateOverridePeriod must also be set to the current period key when updating approvalDelegateOverrides' });
    }
  }

  // SECURITY/CORRECTNESS FIX 2026-08-12 (Opus comprehensive audit): payslipEmailEnabled's gate
  // elsewhere is `=== false` (i.e. anything else means "enabled"), so an unvalidated non-boolean
  // could re-enable payslip emailing that MD had deliberately switched off.
  if (body.payslipEmailEnabled !== undefined && typeof body.payslipEmailEnabled !== 'boolean') {
    return res.status(400).json({ success: false, message: 'payslipEmailEnabled must be a boolean' });
  }

  // SECURITY/CORRECTNESS FIX 2026-08-12 (Opus comprehensive audit, CRITICAL-2 defense-in-depth):
  // emailNotification.schedule.time/.days feed straight into a cron expression string
  // (scheduleCronNotification(), now wrapped in try/catch so a bad value can no longer crash the
  // process) -- validating here stops the bad value from ever reaching disk in the first place.
  // time/days/minPendingDays are also rendered raw into value="..." attributes in app.js's
  // Settings page with no escaping, so bounding them here closes that XSS surface at the source
  // too, same reasoning as every other free-text-turned-attribute field this project has fixed.
  // SECURITY/CORRECTNESS FIX 2026-08-12 (2nd comprehensive audit, F6): emailConfig had NO
  // validation at all despite being a whitelisted, md/accounting-writable key -- `emailConfig:
  // "garbage"` or a field with a nested object would be written verbatim and reach every mail
  // send site (payslip, result, digest) with unpredictable failure modes. Field-shape check only
  // (not content bounds -- SMTP host/port/credentials are inherently free-form).
  // Hoisted so the F5-style stale-entry filter at the merge below can reuse the same field list
  // (see "2026-08-12, Finding 1b" further down).
  const EMAIL_CONFIG_FIELDS = { host: 'string', port: 'number', user: 'string', smtpUser: 'string', pass: 'string', fromName: 'string', secure: 'boolean' };
  if (body.emailConfig !== undefined) {
    const ec = body.emailConfig;
    if (!ec || typeof ec !== 'object' || Array.isArray(ec)) {
      return res.status(400).json({ success: false, message: 'emailConfig must be an object' });
    }
    for (const [f, v] of Object.entries(ec)) {
      const expected = EMAIL_CONFIG_FIELDS[f];
      if (!expected) {
        return res.status(400).json({ success: false, message: `unknown emailConfig field "${f}"` });
      }
      if (v !== undefined && v !== '' && typeof v !== expected) {
        return res.status(400).json({ success: false, message: `emailConfig.${f} must be a ${expected}` });
      }
    }
  }
  // SECURITY FIX 2026-08-12 (3rd audit, F2a -- HIGH): an empty string was accepted for any field
  // (deliberately, since SMTP config is free-form), but the credential fields specifically get
  // pre-filled from GET's response into a <input type="password"> (app.js's set-email-pass) --
  // if that GET happened to land while `live` couldn't be resolved (a documented transient
  // readUsers() failure this codebase already tolerates elsewhere, see requireRole()'s own
  // comment), the field strips to '' and the admin's session keeps working normally, so they
  // never notice anything is wrong until they click Save -- silently overwriting the live
  // Resend API key with an empty string and killing every outgoing email (payslips, approval
  // notifications, the pending digest) with no error surfaced anywhere. Treat an explicit empty
  // string on a credential-shaped field as "leave unchanged," matching what the UI actually means
  // by a blank password box, instead of "set it to blank."
  if (body.emailConfig && typeof body.emailConfig === 'object' && !Array.isArray(body.emailConfig) && current.emailConfig) {
    for (const f of ['pass', 'smtpUser', 'user', 'host']) {
      if (body.emailConfig[f] === '' && current.emailConfig[f]) delete body.emailConfig[f];
    }
  }
  // SECURITY/CORRECTNESS FIX 2026-08-12 (found live, during this session's own verification
  // testing): emailConfig was the one remaining whitelisted key with NO deep-merge -- a partial
  // update (`{emailConfig:{fromName:'x'}}`) replaced the WHOLE object via the top-level
  // Object.assign further down, silently destroying host/port/user/smtpUser/pass (the live
  // Resend API key). This actually happened during testing this exact fix round and had to be
  // restored from a value captured earlier in the same session -- proof this class of bug is not
  // hypothetical. The real client (saveSettingsPage()) always sends the complete object, so this
  // merge is a no-op for it, same reasoning as every other key already protected this way.
  if (body.emailConfig && current.emailConfig && typeof current.emailConfig === 'object' && !Array.isArray(current.emailConfig)) {
    // 2026-08-12 (Finding 1b, 3rd re-audit): approvalRouting/periodLocks/leaveCarryForward/
    // tawi50Overrides all filter `current` through their own validity check before merging, so a
    // junk field written before validation existed can't be resurrected forever -- emailConfig's
    // deep-merge (added earlier today) never got that same treatment. Not live today (the field
    // on disk is clean), closing it for consistency with the other 4 keys.
    const cleanEmailConfig = {};
    for (const [f, v] of Object.entries(current.emailConfig)) {
      const expected = EMAIL_CONFIG_FIELDS[f];
      if (expected && (v === '' || typeof v === expected)) cleanEmailConfig[f] = v;
    }
    body.emailConfig = { ...cleanEmailConfig, ...body.emailConfig };
  }
  const EMAIL_NOTIF_DAY_KEYS = ['sun','mon','tue','wed','thu','fri','sat'];
  if (body.emailNotification !== undefined) {
    const en = body.emailNotification;
    if (!en || typeof en !== 'object' || Array.isArray(en)) {
      return res.status(400).json({ success: false, message: 'emailNotification must be an object' });
    }
    // 2026-08-12 (2nd comprehensive audit, F8): no sub-key whitelist -- an unknown key would
    // persist forever with no API path to remove it, same class as the top-level whitelist.
    for (const k of Object.keys(en)) {
      if (!['enabled', 'schedule', 'recipients'].includes(k)) {
        return res.status(400).json({ success: false, message: `unknown emailNotification field "${k}"` });
      }
    }
    if (en.enabled !== undefined && typeof en.enabled !== 'boolean') {
      return res.status(400).json({ success: false, message: 'emailNotification.enabled must be a boolean' });
    }
    const sch = en.schedule;
    if (sch !== undefined) {
      if (!sch || typeof sch !== 'object' || Array.isArray(sch)) {
        return res.status(400).json({ success: false, message: 'emailNotification.schedule must be an object' });
      }
      // LOW fix 2026-08-13 (4th re-audit, Finding C): schedule had no sub-key whitelist, unlike
      // its enabled/recipients siblings -- same self-healing-but-still-worth-closing class as F8.
      for (const k of Object.keys(sch)) {
        if (!['time', 'days', 'minPendingDays'].includes(k)) {
          return res.status(400).json({ success: false, message: `unknown emailNotification.schedule field "${k}"` });
        }
      }
      if (sch.time !== undefined && !HHMM_RE.test(String(sch.time))) {
        return res.status(400).json({ success: false, message: 'emailNotification.schedule.time must be in HH:MM format' });
      }
      if (sch.days !== undefined && (!Array.isArray(sch.days) || sch.days.length === 0 || !sch.days.every(d => EMAIL_NOTIF_DAY_KEYS.includes(d)))) {
        return res.status(400).json({ success: false, message: 'emailNotification.schedule.days must be a non-empty array of sun/mon/tue/wed/thu/fri/sat' });
      }
      if (sch.minPendingDays !== undefined && (!Number.isInteger(sch.minPendingDays) || sch.minPendingDays < 0 || sch.minPendingDays > 30)) {
        return res.status(400).json({ success: false, message: 'emailNotification.schedule.minPendingDays must be an integer 0-30' });
      }
    }
    const rcp = en.recipients;
    if (rcp !== undefined) {
      if (!rcp || typeof rcp !== 'object' || Array.isArray(rcp)) {
        return res.status(400).json({ success: false, message: 'emailNotification.recipients must be an object' });
      }
      for (const k of Object.keys(rcp)) {
        if (!['manager', 'md', 'accounting', 'extra'].includes(k)) {
          return res.status(400).json({ success: false, message: `unknown emailNotification.recipients field "${k}"` });
        }
      }
      for (const k of ['manager', 'md', 'accounting']) {
        if (rcp[k] !== undefined && typeof rcp[k] !== 'boolean') {
          return res.status(400).json({ success: false, message: `emailNotification.recipients.${k} must be a boolean` });
        }
      }
      // SECURITY/CORRECTNESS FIX 2026-08-12 (2nd comprehensive audit, F8): only the array and its
      // length were checked, not each element's shape -- a malformed entry like `[null]` reaches
      // renderNotifExtraList() (app.js), which reads `e.email` unconditionally and throws,
      // blanking the whole Settings page. Real client always sends {email: string, lang: string}
      // (app.js's own save handler filters out empty emails first).
      if (rcp.extra !== undefined) {
        const EMAIL_LANG_KEYS = ['th', 'en', 'ja'];
        // SECURITY FIX 2026-08-16 (Opus cron audit, M-1): this field is deliberately permissive
        // (arbitrary addresses by design), but a comma/semicolon/newline-bearing value is still the
        // same recipient-injection primitive as the profile-email fix above -- one "address" could
        // silently expand into several past the intended ≤20 cap. Reject the injection characters,
        // not the field's intentional flexibility.
        const validExtra = Array.isArray(rcp.extra) && rcp.extra.length <= 20 && rcp.extra.every(e =>
          e && typeof e === 'object' && !Array.isArray(e) &&
          typeof e.email === 'string' && e.email.length > 0 && e.email.length <= 200 &&
          !/[,;\r\n]/.test(e.email) &&
          (e.lang === undefined || EMAIL_LANG_KEYS.includes(e.lang))
        );
        if (!validExtra) {
          return res.status(400).json({ success: false, message: 'emailNotification.recipients.extra must be an array of ≤20 {email: string, lang?: th/en/ja}' });
        }
      }
    }
  }
  // SECURITY/CORRECTNESS FIX 2026-08-12: same deep-merge protection as emailConfig just above --
  // emailNotification is sent as a full object by the real client (saveSettingsPage()) but had no
  // merge protection against a partial update wiping enabled/schedule/recipients.
  // FIX 2026-08-12 (3rd audit, F1a): the merge above was only ONE level deep, but
  // emailNotification's value is a TWO-level tree -- a partial `{schedule:{time:'x'}}` still
  // replaced the whole `schedule` sub-object, destroying `days`/`minPendingDays` (and the same for
  // `recipients.extra` under a partial `{recipients:{md:true}}`). Not live-triggerable by the real
  // client today (it always rebuilds both sub-objects complete), but it's the identical shape as
  // the 3 incidents this exact session already caused -- merge one level deeper too.
  if (body.emailNotification && current.emailNotification && typeof current.emailNotification === 'object' && !Array.isArray(current.emailNotification)) {
    // 2026-08-12 (Finding 1b, 3rd re-audit): same stale-entry filter as emailConfig above, applied
    // to emailNotification's 2-level tree -- rebuild a validated version of `current` before
    // merging, field by field, using the identical rules the request-side validation just above
    // enforces (HH:MM time, known day names, 0-30 minPendingDays, boolean recipient flags, a
    // shape-checked `extra` array).
    const rawCur = current.emailNotification;
    const cleanCurEN = {};
    if (typeof rawCur.enabled === 'boolean') cleanCurEN.enabled = rawCur.enabled;
    if (rawCur.schedule && typeof rawCur.schedule === 'object' && !Array.isArray(rawCur.schedule)) {
      const s = rawCur.schedule, cleanSch = {};
      if (typeof s.time === 'string' && HHMM_RE.test(s.time)) cleanSch.time = s.time;
      if (Array.isArray(s.days) && s.days.length > 0 && s.days.every(d => EMAIL_NOTIF_DAY_KEYS.includes(d))) cleanSch.days = s.days;
      if (Number.isInteger(s.minPendingDays) && s.minPendingDays >= 0 && s.minPendingDays <= 30) cleanSch.minPendingDays = s.minPendingDays;
      if (Object.keys(cleanSch).length) cleanCurEN.schedule = cleanSch;
    }
    if (rawCur.recipients && typeof rawCur.recipients === 'object' && !Array.isArray(rawCur.recipients)) {
      const r = rawCur.recipients, cleanRcp = {};
      for (const k of ['manager', 'md', 'accounting']) if (typeof r[k] === 'boolean') cleanRcp[k] = r[k];
      const EMAIL_LANG_KEYS_FILTER = ['th', 'en', 'ja'];
      if (Array.isArray(r.extra) && r.extra.length <= 20 && r.extra.every(e =>
        e && typeof e === 'object' && !Array.isArray(e) && typeof e.email === 'string' &&
        e.email.length > 0 && e.email.length <= 200 && (e.lang === undefined || EMAIL_LANG_KEYS_FILTER.includes(e.lang))
      )) {
        cleanRcp.extra = r.extra;
      }
      if (Object.keys(cleanRcp).length) cleanCurEN.recipients = cleanRcp;
    }
    body.emailNotification = { ...cleanCurEN, ...body.emailNotification };
    for (const sub of ['schedule', 'recipients']) {
      const inc = body.emailNotification[sub], cur = cleanCurEN[sub];
      if (inc && typeof inc === 'object' && !Array.isArray(inc) && cur && typeof cur === 'object' && !Array.isArray(cur)) {
        body.emailNotification[sub] = { ...cur, ...inc };
      }
    }
  }

  // 2026-07-31: optimistic concurrency for appSettings, on top of the deep-merge below.
  // savePayrollSettings() now echoes back the `updatedAt` stamp it loaded, in
  // body.appSettingsUpdatedAt. If the live file has since been stamped with a DIFFERENT value
  // (someone else saved in between), reject with 409 instead of silently merging over their
  // change -- deep-merging alone still lets a stale client's OWN edited sub-object (e.g. its
  // own out-of-date allowanceEligibility) win over a fresher one, since a per-key merge has no
  // way to tell "unchanged since I loaded" apart from "deliberately edited." This is the same
  // pattern PUT /api/finalize already uses (there, via a narrower per-key PATCH instead of a
  // version stamp, since finalizeData is naturally partitioned per period+employee; appSettings
  // is one cohesive form, so a version stamp is the equivalent for its shape).
  // SECURITY/CORRECTNESS FIX 2026-08-12 (Opus comprehensive audit): `if (body.appSettings)` below
  // accepted any truthy value -- `appSettings: "abcd"` merges junk numeric keys via
  // Object.keys("abcd"), and on a fresh file with no current.appSettings yet, a scalar like
  // `appSettings: 5` gets written verbatim (the deep-merge block further down is skipped whenever
  // `current.appSettings` doesn't already exist).
  if (body.appSettings !== undefined && (!body.appSettings || typeof body.appSettings !== 'object' || Array.isArray(body.appSettings))) {
    return res.status(400).json({ success: false, message: 'appSettings must be an object' });
  }
  // SECURITY FIX 2026-08-12 (Opus comprehensive audit): appSettings is now md/accounting-only
  // (see SETTINGS_KEY_ROLES), matching the UI's own adminSection gate -- but bound the
  // payroll-critical numeric values too, as defense in depth against a compromised admin session
  // or a future caller, and to close 2 more unescaped `value="..."` attribute sinks (tax.brackets,
  // lateDeductPolicy.tiers) that were reachable with completely free-form input before this.
  // SECURITY FIX 2026-08-12 (3rd audit, F6b): appSettings was the one whitelisted key with NO
  // sub-key whitelist and no size cap -- every hardening the top-level whitelist provides was
  // bypassable one level down (`{appSettings:{junkKey:'x'.repeat(2000)}}` persisted forever;
  // `{appSettings:{emailConfig:{...garbage}}}` bypassed EMAIL_CONFIG_FIELDS entirely). The
  // client-side fix (savePayrollSettings() no longer sends emailConfig/emailNotification/
  // payslipEmailEnabled nested here) closes the accidental Resend-key duplication; this closes
  // the validation-bypass path itself, including for any future caller.
  // Hoisted out of the `if (body.appSettings)` block below (4th re-audit, Finding B) so the
  // deep-merge further down can filter `current.appSettings` through the same whitelist -- see
  // that comment for why.
  const ALLOWED_APPSETTINGS_KEYS = ['company', 'payroll', 'sso', 'allowances', 'workSchedule', 'leave', 'allowanceTypes', 'lateDeductPolicy', 'tax', 'allowanceEligibility', 'map', 'updatedAt'];
  if (body.appSettings) {
    const A = body.appSettings;
    if (Object.keys(A).length > 30) {
      return res.status(400).json({ success: false, message: 'appSettings has too many top-level keys' });
    }
    for (const k of Object.keys(A)) {
      if (!ALLOWED_APPSETTINGS_KEYS.includes(k)) {
        return res.status(400).json({ success: false, message: `unknown appSettings field "${k}" -- emailConfig/emailNotification/payslipEmailEnabled must be set as their own top-level keys, not nested inside appSettings` });
      }
    }
    // 2026-08-12 (2nd comprehensive audit, F9): each sub-object must actually BE an object, not a
    // scalar/array a client swapped in -- `Object.assign(APP_SETTINGS.company, 'x')` on the client
    // side is a silent no-op, but the SERVER's own deep-merge (`{...existing, ...incoming}`,
    // further below) only guards `incoming`/`existing` being non-array objects at the point it
    // decides whether to merge -- a scalar `incoming` still gets stored verbatim as that key's new
    // value, corrupting every downstream reader that expects an object.
    for (const sub of ['company', 'payroll', 'sso', 'allowances', 'workSchedule', 'leave', 'allowanceEligibility', 'lateDeductPolicy', 'tax', 'map']) {
      if (A[sub] !== undefined && (!A[sub] || typeof A[sub] !== 'object' || Array.isArray(A[sub]))) {
        return res.status(400).json({ success: false, message: `appSettings.${sub} must be an object` });
      }
    }
    // 2026-08-17: nameTh/addressTh/pvdLicenseNo/ssoEmployerAccountNo added for the 50-Tawi xlsx
    // certificate export (company.name/address/taxId/bankName/bankCode predate this validation
    // block and are left as-is, out of scope for this change). Same string-cap pattern as
    // NEW_PROFILE_STRING_CAPS elsewhere in this file.
    const COMPANY_STRING_CAPS = { nameTh: 200, addressTh: 500, pvdLicenseNo: 30, ssoEmployerAccountNo: 30 };
    if (A.company) {
      for (const [k, cap] of Object.entries(COMPANY_STRING_CAPS)) {
        if (A.company[k] !== undefined && (typeof A.company[k] !== 'string' || A.company[k].length > cap)) {
          return res.status(400).json({ success: false, message: `appSettings.company.${k} must be a string of ${cap} characters or fewer` });
        }
      }
    }
    if (A.map && A.map.cartoApiKey !== undefined) {
      const k = A.map.cartoApiKey;
      if (typeof k !== 'string' || k.length > 200 || (k.length > 0 && !/^[A-Za-z0-9._-]+$/.test(k.trim()))) {
        return res.status(400).json({ success: false, message: 'appSettings.map.cartoApiKey must be empty or a CARTO key (letters, digits, . _ -)' });
      }
      A.map.cartoApiKey = k.trim();
    }
    if (A.sso && A.sso.rate !== undefined && (typeof A.sso.rate !== 'number' || !Number.isFinite(A.sso.rate) || A.sso.rate < 0 || A.sso.rate > 100)) {
      return res.status(400).json({ success: false, message: 'appSettings.sso.rate must be a number 0-100' });
    }
    if (A.sso && A.sso.maxAmount !== undefined && (typeof A.sso.maxAmount !== 'number' || !Number.isFinite(A.sso.maxAmount) || A.sso.maxAmount < 0)) {
      return res.status(400).json({ success: false, message: 'appSettings.sso.maxAmount must be a non-negative number' });
    }
    if (A.tax && A.tax.brackets !== undefined) {
      const validBrackets = Array.isArray(A.tax.brackets) && A.tax.brackets.length <= 20 && A.tax.brackets.every(b =>
        b && typeof b === 'object' &&
        (b.upTo === null || (typeof b.upTo === 'number' && Number.isFinite(b.upTo) && b.upTo > 0)) &&
        typeof b.rate === 'number' && Number.isFinite(b.rate) && b.rate >= 0 && b.rate <= 100
      );
      if (!validBrackets) {
        return res.status(400).json({ success: false, message: 'appSettings.tax.brackets must be an array of 20 or fewer {upTo: number|null, rate: 0-100}' });
      }
    }
    if (A.allowances) {
      if (Object.keys(A.allowances).length > 50) {
        return res.status(400).json({ success: false, message: 'appSettings.allowances must have 50 or fewer entries' });
      }
      for (const [k, v] of Object.entries(A.allowances)) {
        if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 100000) {
          return res.status(400).json({ success: false, message: `appSettings.allowances.${k} must be a number 0-100000` });
        }
      }
    }
    if (A.allowanceEligibility) {
      if (Object.keys(A.allowanceEligibility).length > 50) {
        return res.status(400).json({ success: false, message: 'appSettings.allowanceEligibility must have 50 or fewer entries' });
      }
      const KNOWN_ROLES = ['md', 'manager', 'accounting', 'user', 'marketing', 'driver'];
      for (const [k, v] of Object.entries(A.allowanceEligibility)) {
        if (!Array.isArray(v) || !v.every(r => KNOWN_ROLES.includes(r))) {
          return res.status(400).json({ success: false, message: `appSettings.allowanceEligibility.${k} must be an array of known roles` });
        }
      }
    }
    if (A.lateDeductPolicy && A.lateDeductPolicy.tiers !== undefined) {
      // 2026-08-12 (2nd comprehensive audit, F9): also require fromMin < toMin when both are
      // present -- an inverted range previously passed and would make computeLateDeduction()'s
      // tier lookup misattribute deduction minutes.
      const validTiers = Array.isArray(A.lateDeductPolicy.tiers) && A.lateDeductPolicy.tiers.length <= 20 && A.lateDeductPolicy.tiers.every(t =>
        t && typeof t === 'object' &&
        ['fromMin', 'toMin', 'deductMin'].every(f => t[f] === undefined || (typeof t[f] === 'number' && Number.isFinite(t[f]) && t[f] >= 0)) &&
        (t.fromMin === undefined || t.toMin === undefined || t.fromMin < t.toMin)
      );
      if (!validTiers) {
        return res.status(400).json({ success: false, message: 'appSettings.lateDeductPolicy.tiers must be an array of 20 or fewer {fromMin, toMin, deductMin} non-negative numbers, with fromMin < toMin' });
      }
    }
    // SECURITY/CORRECTNESS FIX 2026-08-12 (2nd comprehensive audit, F9 interaction bug):
    // leaveCarryForward's own per-entry values are capped 0-60 (validated above), but
    // leave.carryForwardMax (the UI's own input cap, app.js's #set-cf-max) was unvalidated
    // server-side -- setting it above 60 makes processYearEndCarryForward() try to write
    // out-of-range carry-forward values, which the (correct) leaveCarryForward validation then
    // rejects, 400-ing the ENTIRE year-end batch with no indication why to the admin (compounded
    // by apiFetch() not surfacing non-2xx responses as errors in the calling UI code).
    if (A.leave && A.leave.carryForwardMax !== undefined && (typeof A.leave.carryForwardMax !== 'number' || !Number.isFinite(A.leave.carryForwardMax) || A.leave.carryForwardMax < 0 || A.leave.carryForwardMax > 60)) {
      return res.status(400).json({ success: false, message: 'appSettings.leave.carryForwardMax must be a number between 0 and 60' });
    }
    // 2026-09-24: carry-forward expiry on/off toggle -- stored as a real boolean.
    if (A.leave && A.leave.carryForwardExpiryEnabled !== undefined) {
      const v = A.leave.carryForwardExpiryEnabled;
      if (v === true || v === 'true') A.leave.carryForwardExpiryEnabled = true;
      else if (v === false || v === 'false') A.leave.carryForwardExpiryEnabled = false;
      else return res.status(400).json({ success: false, message: 'appSettings.leave.carryForwardExpiryEnabled must be true or false' });
    }
    if (A.leave && A.leave.annualLeaveMinMonths !== undefined && (typeof A.leave.annualLeaveMinMonths !== 'number' || !Number.isFinite(A.leave.annualLeaveMinMonths) || A.leave.annualLeaveMinMonths < 0 || A.leave.annualLeaveMinMonths > 600)) {
      return res.status(400).json({ success: false, message: 'appSettings.leave.annualLeaveMinMonths must be a number between 0 and 600' });
    }
    if (A.leave && A.leave.annualLeaveTiers !== undefined) {
      if (!Array.isArray(A.leave.annualLeaveTiers) || A.leave.annualLeaveTiers.length > 12) {
        return res.status(400).json({ success: false, message: 'appSettings.leave.annualLeaveTiers must be an array of 12 or fewer {afterMonths, days} entries' });
      }
      const normalized = normalizeAnnualLeaveTiers(A.leave.annualLeaveTiers);
      A.leave.annualLeaveTiers = normalized;
      A.leave.annualLeaveMinMonths = normalized[0].afterMonths;
    }
    if (A.leave && A.leave.sickLeaveDays !== undefined) {
      if (typeof A.leave.sickLeaveDays !== 'number' || !Number.isFinite(A.leave.sickLeaveDays) || A.leave.sickLeaveDays < 0 || A.leave.sickLeaveDays > 365) {
        return res.status(400).json({ success: false, message: 'appSettings.leave.sickLeaveDays must be a number between 0 and 365' });
      }
      A.leave.sickLeaveDays = normalizeQuotaDays(A.leave.sickLeaveDays, DEFAULT_SICK_LEAVE_DAYS);
    }
    if (A.leave && A.leave.businessLeaveDays !== undefined) {
      if (typeof A.leave.businessLeaveDays !== 'number' || !Number.isFinite(A.leave.businessLeaveDays) || A.leave.businessLeaveDays < 0 || A.leave.businessLeaveDays > 365) {
        return res.status(400).json({ success: false, message: 'appSettings.leave.businessLeaveDays must be a number between 0 and 365' });
      }
      A.leave.businessLeaveDays = normalizeQuotaDays(A.leave.businessLeaveDays, DEFAULT_BUSINESS_LEAVE_DAYS);
    }
  }
  if (body.appSettings) {
    const liveStamp = current.appSettings && current.appSettings.updatedAt;
    const clientStamp = body.appSettingsUpdatedAt;
    // 2026-08-02: previously skipped this whole check whenever EITHER stamp was falsy -- the two
    // cases that matter most (no liveStamp yet on the very first save after deploy, or a future
    // caller that simply forgets to echo the stamp) both silently bypassed the guard this was
    // written to provide. Now a client sending appSettings must always echo a stamp; only "no
    // liveStamp on disk yet" (first save ever) is accept-and-stamp rather than a conflict, since
    // there's nothing on disk yet to conflict with.
    if (!clientStamp) {
      return res.status(409).json({
        success: false,
        conflict: true,
        message: 'Missing settings version stamp -- reload the page and try again.',
        current: current.appSettings,
      });
    }
    if (liveStamp && liveStamp !== clientStamp) {
      return res.status(409).json({
        success: false,
        conflict: true,
        message: 'Settings were changed by someone else since you last loaded this page. Reload and re-apply your changes.',
        current: current.appSettings,
      });
    }
  }

  // Deep-merge appSettings sub-object by sub-object instead of a top-level
  // `Object.assign({}, current, body)`, which replaced the ENTIRE appSettings tree whenever any
  // client sent one -- a stale browser tab would otherwise silently wipe out unrelated settings
  // it simply hadn't loaded yet (allowanceEligibility, allowance rates, tax brackets, etc.),
  // with no warning. Narrows the blast radius for the (now rare, thanks to the version check
  // above) case of a request that IS allowed through but only meant to touch some keys.
  if (body.appSettings && current.appSettings) {
    // SECURITY FIX 2026-08-13 (4th re-audit, Finding B): this used to spread ALL of
    // current.appSettings forward unfiltered, so F6b's sub-key whitelist only ever blocked NEW
    // writes -- any of emailConfig/emailNotification/payslipEmailEnabled already sitting in
    // appSettings from before that fix (as they still are on disk, duplicating the live Resend
    // credential) got resurrected on every single Settings save with no API path to ever remove
    // them. Filter current through the same whitelist the incoming body is already held to.
    const cleanCurrentAppSettings = {};
    for (const k of ALLOWED_APPSETTINGS_KEYS) {
      if (current.appSettings[k] !== undefined) cleanCurrentAppSettings[k] = current.appSettings[k];
    }
    const merged = cleanCurrentAppSettings;
    for (const key of Object.keys(body.appSettings)) {
      const incoming = body.appSettings[key];
      const existing = current.appSettings[key];
      merged[key] = (incoming && typeof incoming === 'object' && !Array.isArray(incoming) &&
                     existing && typeof existing === 'object' && !Array.isArray(existing))
        ? { ...existing, ...incoming }
        : incoming;
    }
    body.appSettings = merged;
  }
  if (body.appSettings) {
    body.appSettings.updatedAt = new Date().toISOString();
  }
  // SECURITY/CORRECTNESS FIX 2026-08-11 (Opus re-audit, LOW-4): periodStartDay was never
  // validated server-side (the UI clamps to 1-28, but this endpoint didn't). A value outside
  // that range makes getPeriodStartForDate()'s day-of-month arithmetic behave inconsistently
  // across months with fewer days (e.g. periodStartDay:31 silently overflows into the next
  // month via JS Date's own rollover), which in turn makes lockedPeriodInRange()'s
  // period-to-period walk drift off-cycle and skip periods it should be checking.
  const sd = body.appSettings && body.appSettings.payroll && body.appSettings.payroll.periodStartDay;
  if (sd !== undefined && (!Number.isInteger(sd) || sd < 1 || sd > 28)) {
    return res.status(400).json({ success: false, message: 'periodStartDay must be an integer between 1 and 28' });
  }
  delete body.appSettingsUpdatedAt; // request-only field, never persisted
  const updated = Object.assign({}, current, body);
  writeJSON('settings.json', updated);
  // SECURITY FIX 2026-08-12 (Opus comprehensive audit, HIGH): this response echoed the ENTIRE
  // merged settings object with no stripping at all -- unlike GET /api/settings (which strips
  // emailConfig.pass/smtpUser for non-admins), a `manager` could PUT an empty/no-op body here and
  // get the live SMTP/Resend credential straight back in the response. Mirror GET's strip exactly.
  // SECURITY FIX 2026-08-12 (2nd comprehensive audit, F2): reuse the same strip helper GET uses --
  // was only stripping emailConfig, leaking tawi50Overrides (per-employee gross/PIT) and every
  // other employee's leaveCarryForward to any non-admin whose PUT happened to touch any key.
  const responseSettings = stripSensitiveSettingsForRole(JSON.parse(JSON.stringify(updated)), live);
  scheduleCronNotification();
  res.json({ success: true, settings: responseSettings });
});

// ===== APPROVAL ROUTING / STATE-MACHINE HELPERS (server-side mirror of app.js) =====
// F-02 fix: POST/PUT /api/leaves used to trust the client's status/userId/approvalRoute
// wholesale (`{...body}` / `{...leave, ...updates}`), so any authenticated user could POST
// status:'approved' on their own request, submit a leave under someone else's userId, or PUT
// their way past the approval chain via devtools. These helpers re-derive the same values
// server-side from settings.json/holidays.json, mirroring app.js's APPROVAL_ROUTING_DEFAULT /
// getApprovalRoute() / getInitialStatus() / isMyTurnOrDelegate() / isApprovalDelegationActiveForType()
// exactly, so the server never has to trust a client-supplied status/route/approver again.
const APPROVAL_ROUTING_DEFAULT = {
  annual: ['md'], sick: ['md'], business: ['md'], upcountry: ['md'],
  'late-out': ['md'], 'time-correction': ['md'], ot: ['md'],
  'early-morning': ['md'], 'holiday-work': ['md'],
  'driver-ot': ['accounting'], 'long-distance': ['accounting'], 'personal-car': ['md'], 'clear-attachments': ['md'],
  // 2026-09-21: abroad must be here, not only in app.js -- PUT /api/settings derives
  // ALLOWED_ROUTE_KEYS from Object.keys(APPROVAL_ROUTING_DEFAULT), so a missing key here makes
  // saving this type's route 400 and silently never persist.
  abroad: ['md'],
};
const ROLE_TO_STATUS = { manager: 'pending', accounting: 'pending-accounting', md: 'pending-md' };
const STATUS_TO_ROLE = PUSH_STATUS_TO_ROLE; // same {pending:manager, pending-accounting:accounting, pending-md:md} map

function getApprovalRoute(type) {
  const routing = { ...APPROVAL_ROUTING_DEFAULT, ...(readSettings().approvalRouting || {}) };
  const r = routing[type];
  if (Array.isArray(r) && r.length > 0) return r;
  return r ? ['manager', 'md'] : ['md'];
}
// Manager-originated requests skip the manager step (cannot self-approve). Accounting stand-in
// for MD during the post-period-close window is unchanged (isApprovalDelegationActiveForType).
function approvalRouteForRequester(routeKey, ownerRole) {
  let route = [...getApprovalRoute(routeKey)];
  if (ownerRole === 'manager') {
    route = route.filter(r => r !== 'manager');
    if (!route.length) route = ['md'];
  }
  return route;
}
function getInitialStatus(type) {
  const route = getApprovalRoute(type);
  return ROLE_TO_STATUS[route[0]] || 'pending-md';
}
function initialStatusForRequester(routeKey, ownerRole) {
  const route = approvalRouteForRequester(routeKey, ownerRole);
  return ROLE_TO_STATUS[route[0]] || 'pending-md';
}
// REVERTED 2026-08-10 (user correction): a 2026-08-10 "fix" (round-3 audit item 5) hardcoded
// regular office OT to always route to MD, treating it as a fixed business rule instead of a
// configurable type -- based on a pre-existing but WRONG assumption from an old code comment.
// User confirmed directly (and showed the live ⚙️ Approval Settings page, where "OT" already has
// a working route dropdown identical to every other request type) that MD choosing OT's approver
// route is the intended, correct behavior. These two functions are now pure pass-throughs -- kept
// only so the call sites below don't need to change again -- so `approvalRouting.ot` in
// settings.json fully governs both status and route, exactly like annual/sick/business/etc.
function initialStatusForRouteKey(routeKey) {
  return getInitialStatus(routeKey);
}
function approvalRouteForRouteKey(routeKey) {
  return getApprovalRoute(routeKey);
}
// Regular office OT and Driver OT are two separate configurable routing keys ('ot' vs
// 'driver-ot') — isDriverOT flag on the record, or the owner's live role being 'driver',
// determines which one this record's approval route/status is derived from.
function routeKeyForLeave(leave, ownerRole) {
  if (leave.type !== 'ot') return leave.type;
  return (leave.isDriverOT || ownerRole === 'driver') ? 'driver-ot' : 'ot';
}
function isPublicHoliday(dateStr) {
  return holidays.some(h => h.date === dateStr);
}
function standardOtMultiplier(dateStr) {
  const dow = new Date(dateStr + 'T12:00:00').getDay();
  return (isPublicHoliday(dateStr) || dow === 0 || dow === 6) ? 3 : 1.5;
}
function effectiveOtMultiplier(leave) {
  const stored = Number(leave.otMultiplier);
  if (Number.isFinite(stored) && stored > 0) return stored;
  return leave.dateFrom ? standardOtMultiplier(leave.dateFrom) : 1.5;
}
// CORRECTNESS FIX 2026-08-16 (Opus re-audit of the C-3 fix): shared by the POST and PUT comp
// checks below -- weekend or public holiday only; a Company Trip date is deliberately NOT treated
// as a non-work day here (companyTripDates is a separate list from holidays, so an ordinary
// weekday company-trip date correctly still fails this check, same reasoning as the driver-OT
// company-trip block: nobody is considered to have "worked" that day, so it can't justify a comp
// day off either, but it also isn't itself sufficient justification).
function isNonWorkDayForComp(dateStr) {
  const d = new Date(dateStr + 'T12:00:00');
  return d.getDay() === 0 || d.getDay() === 6 || isPublicHoliday(dateStr);
}
function isHolidayWorkDay(dateStr) {
  if (!dateStr || isCompanyTripDay(dateStr)) return false;
  return isNonWorkDayForComp(dateStr);
}
function parseHHMMToMins(hhmm) {
  if (!HHMM_RE.test(hhmm)) return NaN;
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}
// 2026-09-24 (owner): Holiday Work may run past midnight, same convention as office OT -- an end
// time that is not after the start and is before 05:00 is after midnight of the SAME work day
// (lateNightCheckoutMins). Returns the end in minutes from the work day's 00:00 (up to 28:59), or
// NaN when the end is not after the start. A start before 05:00 with a later end the same morning
// stays a same-day range. Dual-sync with app.js.
function holidayWorkEndMins(workStartTime, workEndTime) {
  const startMin = parseHHMMToMins(workStartTime);
  const endMin = parseHHMMToMins(workEndTime);
  if (!Number.isFinite(startMin) || !Number.isFinite(endMin)) return NaN;
  if (endMin > startMin) return endMin;
  // 2026-09-24 (review M): the after-midnight rule applies only to a shift that STARTS at/after
  // 05:00 -- 04:00-03:00 used to become a 23-hour shift.
  if (startMin < 5 * 60) return NaN;
  const nextDay = lateNightCheckoutMins(workEndTime);
  return nextDay > startMin ? nextDay : NaN;
}
// 2026-09-24 (review M): a Holiday Work shift may not be longer than 20 hours (the same cap as
// server.js OT_HOURS_MAX); refused on submit/edit. Dual-sync (identical text) with the other file.
function holidayWorkTooLong(workStartTime, workEndTime) {
  const endMin = holidayWorkEndMins(workStartTime, workEndTime);
  return Number.isFinite(endMin) && endMin - parseHHMMToMins(workStartTime) > 20 * 60;
}
// The whole shift is paid at the START day's Holiday Work rate (x2 inside 08:30-17:30, x3 outside
// it, so every hour after midnight is x3); lunch 12:00-13:00 is removed only where the x2 window
// covers it, i.e. on the start day. Nothing here looks at the next calendar day.
function splitHolidayWorkOtMinutes(workStartTime, workEndTime, S) {
  const startMin = parseHHMMToMins(workStartTime);
  const endMin = holidayWorkEndMins(workStartTime, workEndTime);
  if (!Number.isFinite(startMin) || !Number.isFinite(endMin)) {
    return { otMins20: 0, otMins30: 0, otHours20: 0, otHours30: 0 };
  }
  const ws = S.workSchedule || {};
  const stdStart = (ws.standardStartHour != null ? ws.standardStartHour : 8) * 60 +
    (ws.standardStartMinute != null ? ws.standardStartMinute : 30);
  const stdEnd = 17 * 60 + 30;
  const otMins30Before = Math.max(0, Math.min(endMin, stdStart) - Math.min(startMin, stdStart));
  const otMins30After = Math.max(0, endMin - Math.max(startMin, stdEnd));
  const otMins30 = otMins30Before + otMins30After;
  // 2026-09-23 (owner decision): the ×2 window excludes the 12:00-13:00 lunch hour -- the hourly
  // rate assumes an 8-hour day (salary / 30 / 8), so 08:30-17:30 is 8 paid hours, not 9. Only the
  // part of lunch the employee actually worked through is removed (13:00-17:00 loses nothing).
  const x2Start = Math.max(startMin, stdStart), x2End = Math.min(endMin, stdEnd);
  const lunchMins = Math.max(0, Math.min(x2End, 13 * 60) - Math.max(x2Start, 12 * 60));
  const otMins20 = Math.max(0, x2End - x2Start - lunchMins);
  const round2 = n => Math.round(n / 60 * 100) / 100;
  return { otMins20, otMins30, otHours20: round2(otMins20), otHours30: round2(otMins30) };
}
function officeOtStdStartHHMM(S) {
  const ws = (S && S.workSchedule) || {};
  const h = ws.standardStartHour != null ? ws.standardStartHour : 8;
  const m = ws.standardStartMinute != null ? ws.standardStartMinute : 30;
  return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
}
const OFFICE_OT_WEEKEND_MSG = 'Weekends and public holidays use Holiday Work — do not submit office OT for those days';
// Office OT is request-gated (never derived from scan-out). Weekdays only: hours after 17:30 at ×1.5.
// Weekend / public-holiday pay goes through Holiday Work (start–end), not this form. Drivers use isDriverOT.
// 2026-09-24 (owner): office OT may run past midnight -- an end time before 05:00 is after
// midnight of the SAME work day (the check-out convention of lateNightCheckoutMins). The rate is
// always the start day's: office OT only exists on a weekday (x1.5), so running into a weekend or
// public holiday after midnight never turns it into x2/x3. Dual-sync with app.js.
function deriveOfficeOtFromEndTime(dateFrom, otEndTime, S) {
  const out = { isDriverOT: false, otMultiplier: 1.5, otHours: 0, otHours20: 0, otHours30: 0 };
  if (!dateFrom || !otEndTime || !HHMM_RE.test(otEndTime)) return out;
  if (isNonWorkDayForComp(dateFrom)) return out;
  const otMins = lateNightCheckoutMins(otEndTime) - (17 * 60 + 30);
  out.otHours = otMins > 0 ? round2HalfUp(otMins / 60) : 0;
  out.otMultiplier = 1.5;
  return out;
}
// 2026-09-24: approved paid-mode Holiday Work with OT hours -- counted as OT in the payslip OT
// tile (display only). Dual-sync with app.js isHolidayWorkOtRecord.
function isHolidayWorkOtRecord(l) {
  return !!l && l.type === 'holiday-work' && l.status === 'approved' && l.compensationMode === 'paid' &&
    ((Number(l.otHours20) || 0) + (Number(l.otHours30) || 0)) > 0;
}
// 2026-09-24 (owner): hours are kept to 2 decimal places, rounded half-up at the 3rd decimal
// (reminder: the owner wants to reconsider this rule later). The epsilon absorbs binary noise
// such as 1.005 * 100 = 100.49999... Dual-sync with app.js.
function round2HalfUp(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 0;
  return Math.sign(x) * Math.round(Math.abs(x) * 100 + 1e-9) / 100;
}
// 2026-09-24 (owner): provident fund is kept to 1 decimal place, rounded half-up at the 2nd
// decimal (123.45 -> 123.5). Same epsilon idea as round2HalfUp. Dual-sync with app.js.
function round1HalfUp(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 0;
  return Math.sign(x) * Math.round(Math.abs(x) * 10 + 1e-9) / 10;
}
// 2026-09-24 (owner): a request ends in one of three terminal statuses -- 'rejected', 'cancelled'
// (the owner cancelled an APPROVED record; the row is kept as history) or 'revoked' (MD/Accounting
// took an approval back; kept as history). None of them counts toward pay, leave balance, earned
// credit, overlap/duplicate checks, queues or badges. Every NEGATIVE status filter
// ("anything but rejected" style) goes through this helper so a new terminal status can never
// slip through one of them. Dual-sync with app.js.
function isVoidLeaveStatus(s) {
  return s === 'rejected' || s === 'cancelled' || s === 'revoked';
}
function hasActiveHolidayWork(leaves, userId, dateFrom, exceptId) {
  return (leaves || []).some(l =>
    l.id !== exceptId && l.userId === userId && l.type === 'holiday-work' &&
    l.dateFrom === dateFrom && !isVoidLeaveStatus(l.status)
  );
}
function hasActiveOfficeOt(leaves, userId, dateFrom, exceptId) {
  return (leaves || []).some(l =>
    l.id !== exceptId && l.userId === userId && l.type === 'ot' && !l.isDriverOT &&
    l.dateFrom === dateFrom && !isVoidLeaveStatus(l.status)
  );
}
// 2026-09-24 (owner): OT pay is kept to 2 decimal places, rounded half-up at the 3rd decimal
// (was whole baht). Each amount and each running total goes through round2HalfUp so float noise
// (0.1 + 0.2) never reaches the payslip.
function accumulateApprovedOtPay(l, hourlyRate, acc) {
  const hrs20 = Number(l.otHours20) || 0;
  const hrs30 = Number(l.otHours30) || 0;
  if (hrs20 > 0 || hrs30 > 0) {
    const amt20 = round2HalfUp(hourlyRate * 2 * hrs20);
    const amt30 = round2HalfUp(hourlyRate * 3 * hrs30);
    acc.ot20Hours += hrs20; acc.ot20Amount = round2HalfUp(acc.ot20Amount + amt20);
    acc.ot30Hours += hrs30; acc.ot30Amount = round2HalfUp(acc.ot30Amount + amt30);
    acc.otAmount = round2HalfUp(acc.otAmount + amt20 + amt30);
    acc.otTotalHours += hrs20 + hrs30;
    return;
  }
  const mult = effectiveOtMultiplier(l);
  const hrs = Number(l.otHours) || 0;
  const amt = round2HalfUp(hourlyRate * mult * hrs);
  acc.otAmount = round2HalfUp(acc.otAmount + amt);
  acc.otTotalHours += hrs;
  if (mult === 1.5) { acc.ot15Amount = round2HalfUp(acc.ot15Amount + amt); acc.ot15Hours += hrs; }
  else if (mult === 2) { acc.ot20Amount = round2HalfUp(acc.ot20Amount + amt); acc.ot20Hours += hrs; }
  else if (mult === 3) { acc.ot30Amount = round2HalfUp(acc.ot30Amount + amt); acc.ot30Hours += hrs; }
}
function validateHolidayWorkLocation(locations) {
  if (!Array.isArray(locations) || locations.length !== 1) {
    return 'locations must be an array with exactly one entry';
  }
  const loc = locations[0];
  if (!loc || typeof loc.name !== 'string' || !loc.name.trim()) {
    return 'location name is required';
  }
  if (loc.name.length > LOCATION_NAME_MAX) {
    return `location name must be ${LOCATION_NAME_MAX} characters or fewer`;
  }
  return null;
}
// `reviews`: the checkout-reviews map (PUT /api/checkout-reviews passes it so the derived day
// carries checkOutReview). Other callers do not need review decisions and pass nothing.
function attendanceDayForUser(user, dateStr, reviews = {}) {
  const dayStart = new Date(dateStr + 'T12:00:00');
  const attLog = buildAttendanceLogForUser(user, dayStart, dayStart);
  const leaves = readLeaves() || [];
  const S = getAppSettings();
  const days = generatePeriodDays(dayStart, dayStart, false, user, attLog, leaves, S, reviews);
  return days[0] || null;
}
function holidayWorkSubmitBlockReason(user, dateStr) {
  if (!user || !dateStr || !isValidDateStr(dateStr)) {
    return 'dateFrom must be a valid YYYY-MM-DD date';
  }
  if (user.role === 'driver') {
    return 'Drivers cannot submit holiday work requests';
  }
  const S = getAppSettings();
  if (!isAllowanceEligible(S.allowanceEligibility, user.role, 'holidayWork')) {
    return 'You are not eligible to submit holiday work requests';
  }
  if (!isHolidayWorkDay(dateStr)) {
    return 'dateFrom must be a day you actually worked, and a weekend or public holiday (not Company Trip)';
  }
  // 2026-09-23 (Opus review C-1): holiday work is claimed after it happens. Without this, the
  // no-scan Abroad path accepted a future weekend inside an approved trip. Dual-sync with app.js
  // canSubmitHolidayWorkForDate.
  if (dateStr > bangkokDateStr()) {
    return 'Holiday work can only be submitted for a day that has already started';
  }
  const hwLeaves = readLeaves();
  if (hwLeaves === null) return 'Service temporarily unavailable';
  if (isAbroadTravelDay(hwLeaves, user.id, dateStr)) {
    // 2026-09-24 (review L-1): pending trips block too, so no "approved" -- same text as app.js.
    return 'This is a travel day of your Abroad trip — the annual-leave day is credited automatically, so holiday work cannot be submitted';
  }
  const day = attendanceDayForUser(user, dateStr);
  // 2026-09-23 (owner): an approved Abroad day needs no scan -- the trip approval is the evidence.
  if (!day || (!day.checkIn && day.status !== 'abroad')) {
    return 'Holiday work requires a check-in first';
  }
  return null;
}
// 2026-09-23 (Opus audit M-1, rule confirmed by the owner): Holiday Work and office OT are paid
// from times the employee types, which were never compared with the day's real scans -- a 10:00
// arrival could claim 06:00-23:59. The typed start may not be earlier than the check-in and the
// typed end may not be later than the check-out. Uses attendanceDayForUser, so approved
// time-corrections count. A check-out (and, since 2026-09-24, a typed OT end) before 05:00 belongs
// to the same business day (after midnight).
// Dual-sync with app.js scanWindowError.
function scanWindowError(user, dateStr, startHHMM, endHHMM) {
  const day = attendanceDayForUser(user, dateStr);
  // An approved Abroad day deliberately needs no scan (no device abroad; see app.js
  // canSubmitOTForDate's allowNoScan) -- the trip approval is the evidence.
  if (day && day.status === 'abroad') return null;
  if (!day || !day.checkIn) return 'A check-in is required for this date';
  if (startHHMM && parseHHMMToMins(startHHMM) < parseHHMMToMins(day.checkIn)) {
    return `Start time cannot be earlier than your check-in (${day.checkIn})`;
  }
  if (endHHMM) {
    // No check-out: fall back to the last scan after check-in (a morning-only day never records
    // a check-out, since scans before 12:00 are treated as duplicate door scans).
    const rawDay = day.checkOut ? null : (buildAttendanceLogForUser(user)[dateStr] || {});
    const endLimit = day.checkOut || (rawDay && rawDay.lastScan);
    if (!endLimit) return 'A check-out is required for this date — submit a time correction first';
    // 2026-09-24: the typed end follows the same after-midnight rule as the check-out (an OT or
    // Holiday Work end before 05:00 is after midnight; see holidayWorkEndMins).
    const outMin = lateNightCheckoutMins(endLimit);
    if (lateNightCheckoutMins(endHHMM) > outMin) {
      return `End time cannot be later than your check-out (${endLimit})`;
    }
  }
  return null;
}
function earlyMorningTierFromCheckIn(checkIn, S) {
  if (!checkIn || !HHMM_RE.test(checkIn)) return 0;
  const mins = parseHHMMToMins(checkIn);
  if (!Number.isFinite(mins)) return 0;
  if (mins <= S.allowances.earlyThreshold2Min) return 2;
  if (mins <= S.allowances.earlyThreshold1Min) return 1;
  return 0;
}
function earlyMorningTierAllowed(checkIn, tier, S) {
  if (![1, 2].includes(Number(tier)) || !checkIn || !HHMM_RE.test(checkIn)) return false;
  const mins = parseHHMMToMins(checkIn);
  if (!Number.isFinite(mins)) return false;
  const thr = Number(tier) === 2 ? S.allowances.earlyThreshold2Min : S.allowances.earlyThreshold1Min;
  return mins <= thr;
}
function earlyMorningBonusFromWorkStartTime(workStartTime, S) {
  const mins = parseHHMMToMins(workStartTime);
  if (!Number.isFinite(mins)) return { earlyCount: 0, bonus: 0 };
  if (mins <= S.allowances.earlyThreshold2Min) return { earlyCount: 2, bonus: S.allowances.earlyMorning2 };
  if (mins <= S.allowances.earlyThreshold1Min) return { earlyCount: 1, bonus: S.allowances.earlyMorning1 };
  return { earlyCount: 0, bonus: 0 };
}
function earlyMorningSubmitBlockReason(user, dateStr) {
  if (!user || !dateStr || !isValidDateStr(dateStr)) {
    return 'dateFrom must be a valid YYYY-MM-DD date';
  }
  const S = getAppSettings();
  if (!isAllowanceEligible(S.allowanceEligibility, user.role, 'earlyLate')) {
    return 'You are not eligible for early morning allowance';
  }
  if (isHolidayWorkDay(dateStr)) {
    const hwLeaves = readLeaves() || [];
    const hasHw = hwLeaves.some(l =>
      l.userId === user.id && l.type === 'holiday-work' && l.dateFrom === dateStr && !isVoidLeaveStatus(l.status)
    );
    if (!hasHw) {
      return 'Early morning on a holiday requires a holiday work request first';
    }
  }
  const day = attendanceDayForUser(user, dateStr);
  if (!day || !day.checkIn) {
    return 'Early morning claim requires a check-in first';
  }
  if (!isEarlyMorningDayStatus(day.status)) {
    return 'Early morning claim requires a check-in on a working, weekend, or public-holiday day';
  }
  if (isDeviceScanSource(day.checkInSource)) {
    return 'Early morning allowance is automatic when you check in at the face scanner — no request needed';
  }
  const mins = parseHHMMToMins(day.checkIn);
  if (!Number.isFinite(mins) || mins > S.allowances.earlyThreshold1Min) {
    const thr = S.allowances.earlyThreshold1Min;
    const thrStr = `${String(Math.floor(thr / 60)).padStart(2, '0')}:${String(thr % 60).padStart(2, '0')}`;
    return `Early morning claim requires check-in before ${thrStr}`;
  }
  return null;
}
// 2026-09-23 (owner): an approved Abroad trip earns +1 annual-leave day for each TRAVEL day --
// its start date and its end date only, never the days in between -- that falls on a weekend or
// public holiday (Company Trip days excluded). A one-day trip counts once. Counted in the year of
// the travel day. Travel days cannot also carry Holiday Work. Dual-sync with the other file.
// Owner decision 2026-09-23: a travel day counts only once it has ARRIVED (<= today, Bangkok),
// so cancelling a future trip can never take back leave that was already spent.
function abroadTravelCreditDays(abroadLeaves, yStart, yEnd) {
  const today = bangkokDateStr();
  let n = 0;
  abroadLeaves.forEach(l => {
    new Set([l.dateFrom, l.dateTo || l.dateFrom]).forEach(d => {
      if (d && d >= yStart && d <= yEnd && d <= today && isNonWorkDayForComp(d) && !isCompanyTripDay(d)) n++;
    });
  });
  return n;
}
// Blocks Holiday Work on a travel day of any trip that is approved OR still pending (Opus review
// I-1): a pending trip approved later would otherwise pay Holiday Work AND the travel credit.
function isAbroadTravelDay(leaves, userId, dateStr) {
  return leaves.some(l =>
    l.userId === userId && l.type === 'abroad' && !isVoidLeaveStatus(l.status) &&
    (l.dateFrom === dateStr || (l.dateTo || l.dateFrom) === dateStr));
}
// Earned annual-leave days for the year: holiday work taken as annual leave, plus abroad travel
// days on a weekend/holiday (2026-09-23). Every caller treats this as the earned pool.
function getApprovedHolidayWorkAnnualLeaveDays(leaves, userId, year, exceptId) {
  const yStart = `${year}-01-01`, yEnd = `${year}-12-31`;
  // 2026-09-24 (owner): no credit for Holiday Work on a date that later became a Company Trip.
  const hwDays = leaves.filter(l =>
    l.userId === userId && l.type === 'holiday-work' && l.compensationMode === 'annual-leave' &&
    l.status === 'approved' &&
    l.dateFrom >= yStart && l.dateFrom <= yEnd && !isCompanyTripDay(l.dateFrom) &&
    l.id !== exceptId
  ).reduce((s, l) => s + (l.days || 1), 0);
  const abroad = leaves.filter(l =>
    l.userId === userId && l.type === 'abroad' && l.status === 'approved' && l.id !== exceptId);
  return hwDays + abroadTravelCreditDays(abroad, yStart, yEnd);
}
// ===== 2026-09-24 (owner): never take back an earned annual-leave day that is already used =====
// Cancelling (owner) or revoking (MD/Accounting) an approved Holiday Work taken as annual leave,
// or revoking an approved Abroad trip whose travel-day credit has arrived, removes earned days.
// Refused with code 'earned-day-used' when the owner's annual balance for that year -- the SAME
// figure the submission gate uses (pending requests count as used) -- would drop below zero
// without the record. If next year's carry-forward was already snapshotted from that year, the
// carry-forward the refresh would take away must also still be covered by next year's balance.
// DUAL-SYNC (identical in app.js): earnedCreditMinutesOf, earnedCreditYearsOf,
// earnedDayBalanceAsOf, carryForwardAfterCreditLoss, isEarnedDayUsed. Per-side wrapper:
// earnedDayUsedError here, earnedDayUsedByRecord in app.js.
function earnedCreditMinutesOf(l, year) {
  if (!l || l.status !== 'approved') return 0;
  const yStart = `${year}-01-01`, yEnd = `${year}-12-31`;
  if (l.type === 'holiday-work') {
    if (l.compensationMode !== 'annual-leave' || !(l.dateFrom >= yStart && l.dateFrom <= yEnd) || isCompanyTripDay(l.dateFrom)) return 0;
    return (l.days || 1) * 480;
  }
  if (l.type === 'abroad') return abroadTravelCreditDays([l], yStart, yEnd) * 480;
  return 0;
}
function earnedCreditYearsOf(l) {
  if (!l || typeof l.dateFrom !== 'string') return [];
  const ys = new Set([Number(l.dateFrom.slice(0, 4)), Number(String(l.dateTo || l.dateFrom).slice(0, 4))]);
  return [...ys].filter(Number.isInteger).sort((a, b) => a - b);
}
// The balance date for `year`: today inside that year, else the nearer end of it.
function earnedDayBalanceAsOf(year, todayStr) {
  const yStart = `${year}-01-01`, yEnd = `${year}-12-31`;
  return todayStr < yStart ? yStart : (todayStr > yEnd ? yEnd : todayStr);
}
// Next year's carry-forward (days) once the refresh recomputes it without `creditMin`.
function carryForwardAfterCreditLoss(leftoverWithMin, creditMin, maxCF) {
  return Math.min(Math.max(0, leftoverWithMin - creditMin) / 480, maxCF);
}
function isEarnedDayUsed(creditMin, remainingWithMin, nextCfDropMin, nextRemainingWithMin) {
  if (!(creditMin > 0)) return false;
  if (remainingWithMin - creditMin < 0) return true;
  return nextCfDropMin > 0 && nextRemainingWithMin - nextCfDropMin < 0;
}
function earnedDayUsedError(leaves, owner, leave) {
  if (!owner || !leave) return null;
  const cf = readSettings().leaveCarryForward || {};
  // `??` not `||`: a configured 0 means "no carry-forward" (same as refreshSnapshottedCarryForward).
  const rawMax = Number(getAppSettings().leave?.carryForwardMax ?? 5);
  const maxCF = Math.max(0, Math.min(60, Number.isFinite(rawMax) ? rawMax : 5));
  const today = bangkokDateStr();
  for (const year of earnedCreditYearsOf(leave)) {
    const creditMin = earnedCreditMinutesOf(leave, year);
    if (creditMin <= 0) continue;
    const remWith = leaveBalanceRemainingMinutes(leaves, owner, 'annual', undefined, earnedDayBalanceAsOf(year, today));
    let dropMin = 0, nextRem = 0;
    const nextKey = `${year + 1}_${owner.id}`;
    if (cf[nextKey] !== undefined) {
      const cfNew = carryForwardAfterCreditLoss(annualLeaveRemainingMinutes(leaves, owner, year, cf), creditMin, maxCF);
      const cfOld = (Number(cf[nextKey]) || 0) + (Number(cf[`comp_${year + 1}_${owner.id}`]) || 0);
      dropMin = Math.max(0, cfOld - cfNew) * 480;
      if (dropMin > 0) nextRem = leaveBalanceRemainingMinutes(leaves, owner, 'annual', undefined, earnedDayBalanceAsOf(year + 1, today));
    }
    if (isEarnedDayUsed(creditMin, remWith, dropMin, nextRem)) {
      return { code: 'earned-day-used', message: 'The annual-leave day earned from this record has already been used, so it cannot be cancelled or revoked' };
    }
  }
  return null;
}
function ta_localDateStr(d) {
  const p2 = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
}
const EN_MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
function formatDateEn(d) {
  return `${d.getDate()} ${EN_MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}
function getPeriodStartForDate(dateStr) {
  const settings = readSettings();
  const sd = (settings.appSettings && settings.appSettings.payroll && settings.appSettings.payroll.periodStartDay) || 21;
  const d = new Date(String(dateStr).slice(0, 10) + 'T12:00:00');
  let y = d.getFullYear(), m = d.getMonth();
  if (d.getDate() >= sd) return new Date(y, m, sd);
  m -= 1;
  if (m < 0) { m = 11; y -= 1; }
  return new Date(y, m, sd);
}
function getPeriodLockKey(start) {
  const p2 = n => String(n).padStart(2, '0');
  return `${start.getFullYear()}${p2(start.getMonth() + 1)}${p2(start.getDate())}`;
}
function isPeriodLocked(start) {
  const locks = readSettings().periodLocks || {};
  const lock = locks[getPeriodLockKey(start)];
  return !!(lock && lock.locked);
}
// 2026-08-10 (Opus re-audit, F1): every period-lock check up to this point (POST, the approver-
// decision branch, and PUT's owner-edit branch) only ever sampled the request's two ENDPOINT
// dates -- a multi-month request (e.g. dateFrom in an open period, dateTo in another open period,
// with a LOCKED period sitting entirely between them) could leave-days into that locked middle
// period undetected by any of them, since neither endpoint's own period key ever matches it. Walks
// every period from dateFrom's through dateTo's (inclusive), same period-stepping logic as
// getPayDay()'s month math elsewhere in this file.
function lockedPeriodInRange(dateFrom, dateTo) {
  if (!isValidDateStr(dateFrom)) return false;
  const endStr = (dateTo && isValidDateStr(dateTo)) ? dateTo : dateFrom;
  const cursor = getPeriodStartForDate(dateFrom);
  // 2026-08-11 (Opus re-audit, LOW-3): was calling isPeriodLocked(cursor) each iteration, which
  // re-reads+re-parses settings.json from disk on every single period -- with the guard raised to
  // 1000, a pathological legacy span could mean up to 1000 synchronous file reads blocking the
  // event loop. Read `periodLocks` once, up front, and check it directly inside the loop instead.
  const locks = readSettings().periodLocks || {};
  // 2026-08-11 (Opus re-audit, LOW-3): guard was 40 -- `validateDateRange`'s 366-day cap bounds
  // POST and the owner-edit branch's RESOLVED range to ~13 iterations, but two callers read
  // stored/legacy dates that were never span-validated (the approver-decision branch, and the OLD
  // leave.dateFrom/dateTo in the owner-edit branch) -- a multi-year legacy span could exhaust a
  // guard of 40 and silently stop checking, failing OPEN. Raised well past any realistic span.
  let guard = 0;
  while (ta_localDateStr(cursor) <= endStr && guard++ < 1000) {
    const lock = locks[getPeriodLockKey(cursor)];
    if (lock && lock.locked) return true;
    cursor.setMonth(cursor.getMonth() + 1);
  }
  return false;
}
function mdApprovedPeriodInRange(dateFrom, dateTo, userId) {
  if (!isValidDateStr(dateFrom) || userId == null) return false;
  const endStr = (dateTo && isValidDateStr(dateTo)) ? dateTo : dateFrom;
  const cursor = getPeriodStartForDate(dateFrom);
  const fin = readJSON('finalize.json', {});
  if (fin === null) return true;
  let guard = 0;
  while (ta_localDateStr(cursor) <= endStr && guard++ < 1000) {
    if (fin[getMdApprovalKey(cursor, userId)]?.approved === true) return true;
    cursor.setMonth(cursor.getMonth() + 1);
  }
  return false;
}
function accountingConfirmedInRange(dateFrom, dateTo, userId) {
  if (!isValidDateStr(dateFrom) || userId == null) return false;
  const endStr = (dateTo && isValidDateStr(dateTo)) ? dateTo : dateFrom;
  const cursor = getPeriodStartForDate(dateFrom);
  const fin = readJSON('finalize.json', {});
  if (fin === null) return true;
  let guard = 0;
  while (ta_localDateStr(cursor) <= endStr && guard++ < 1000) {
    if (fin[getFinalizeKey(cursor, userId)]?.confirmed === true) return true;
    cursor.setMonth(cursor.getMonth() + 1);
  }
  return false;
}
function getPayDay(periodEnd) {
  const d = new Date(periodEnd.getFullYear(), periodEnd.getMonth() + 1, 0);
  while (d.getDay() === 0 || d.getDay() === 6 || isPublicHoliday(ta_localDateStr(d))) {
    d.setDate(d.getDate() - 1);
  }
  return d;
}
function isApprovalDelegationWindowOpen() {
  const settings = readSettings();
  const startDay = (settings.appSettings && settings.appSettings.payroll && settings.appSettings.payroll.periodStartDay) || 21;
  const today = bangkokTodayDate();
  if (today.getDate() < startDay) return false;
  const periodEnd = new Date(today.getFullYear(), today.getMonth(), startDay - 1);
  const payDay = getPayDay(periodEnd); payDay.setHours(0, 0, 0, 0);
  return today <= payDay;
}
function currentApprovalDelegationPeriodKey() {
  const settings = readSettings();
  const startDay = (settings.appSettings && settings.appSettings.payroll && settings.appSettings.payroll.periodStartDay) || 21;
  const today = bangkokTodayDate();
  const periodEnd = new Date(today.getFullYear(), today.getMonth(), startDay - 1);
  const p2 = n => String(n).padStart(2, '0');
  return `${periodEnd.getFullYear()}${p2(periodEnd.getMonth() + 1)}${p2(periodEnd.getDate())}`;
}
// Last day of the pay period the delegation window is closing. The window only opens on/after
// the period start day, so "this month, startDay - 1" is always that period's end.
function approvalDelegationPeriodEndStr() {
  const settings = readSettings();
  const startDay = (settings.appSettings && settings.appSettings.payroll && settings.appSettings.payroll.periodStartDay) || 21;
  const today = bangkokTodayDate();
  const periodEnd = new Date(today.getFullYear(), today.getMonth(), startDay - 1);
  const p2 = n => String(n).padStart(2, '0');
  return `${periodEnd.getFullYear()}-${p2(periodEnd.getMonth() + 1)}-${p2(periodEnd.getDate())}`;
}
// 2026-09-21 (user-confirmed): the Accounting stand-in exists so a pending request cannot hold up
// the payroll run that starts on the 21st. A request dated in a LATER period holds up nothing, so
// it stays with the Managing Director — without this the window quietly handed Accounting
// authority over next month's leave too. dateFrom decides: a request straddling the boundary
// starts inside the closing period, so it does affect that payroll and remains delegable.
// A legacy record with no usable date keeps the old behaviour rather than becoming un-approvable
// by anyone — the same "never create a stuck queue" reasoning as the period-lock check.
// Dual-sync with app.js.
function delegationCoversLeaveDate(leave) {
  const from = leave && leave.dateFrom;
  if (!from || !isValidDateStr(from)) return true;
  return from <= approvalDelegationPeriodEndStr();
}
function isApprovalDelegationActiveForType(type) {
  if (!isApprovalDelegationWindowOpen()) return false;
  const settings = readSettings();
  const overridePeriod = settings.approvalDelegateOverridePeriod || null;
  const overrides = settings.approvalDelegateOverrides || {};
  if (overridePeriod !== currentApprovalDelegationPeriodKey()) return true;
  return overrides[type] !== false;
}

// ===== LEAVES API =====
// SECURITY FIX 2026-08-13 (re-audit): every field of every employee's leave/OT/upcountry/etc.
// record -- reason, note, attachment filename, targetSnapshot names -- used to go to every
// authenticated user regardless of role, same bug class as F-06 (/api/users) and H2 (/api/events).
// A plain user/driver/marketing session could enumerate every colleague's leave reasons AND their
// attachment filenames, then pull the files themselves via GET /api/upload/:filename (fixed
// separately below). md/accounting/manager keep full access -- manager is a configurable approval
// stage for every request type and also owns company-wide Reports/attendance pages, so a per-record
// "is this your turn" filter would break their pending-review strips for no real privacy gain in a
// single-office company. Everyone else gets their OWN records in full (unaffected) and a minimal
// projection for everyone else's -- deliberately WITHOUT `reason`/`note`/`attachment` per user
// decision 2026-08-13 (stricter than keeping the Today-on-Leave popup's reason display; that popup
// now only shows type/dates for a non-privileged viewer, see openTodayLeaveModal() in app.js).
const PUBLIC_LEAVE_FIELDS = ['id', 'userId', 'type', 'status', 'dateFrom', 'dateTo', 'days', 'hourlyStart', 'hourlyEnd'];
function toPublicLeaveProjection(l) {
  const out = {};
  PUBLIC_LEAVE_FIELDS.forEach(f => { if (f in l) out[f] = l[f]; });
  return out;
}
app.get('/api/leaves', (req, res) => {
  // SECURITY FIX 2026-08-05 (Opus audit, F-2 defense-in-depth): this route never referenced
  // req.user, so it had nothing to fail closed on if the global auth middleware were ever bypassed
  // again by some other casing/path-normalization trick (the primary fix is the middleware's own
  // toLowerCase() check above). Every employee's leave records (reason, note, dates, approver,
  // attachment filename) is sensitive enough to warrant its own explicit assertion here too.
  if (!req.user) return res.status(401).json({ success:false, message:'Unauthorized' });
  const users = readUsers();
  if (users === null) return res.status(503).json({ success:false, message:'Service temporarily unavailable' });
  const live = users.find(u => u.id === req.user.sub);
  if (!live) return res.status(403).json({ success:false, message:'Forbidden: user record not found' });
  const leaves = readLeaves();
  if (leaves === null) return res.status(503).json({ success:false, message:'Service temporarily unavailable' });
  if (isLeaveFullAccess(live)) return res.json(leaves);
  // 2026-09-24 (owner): colleagues' cancelled / revoked records are left out (leaveVisibleToViewer).
  res.json(leaves.filter(l => leaveVisibleToViewer(l, live.id, false))
    .map(l => l.userId === live.id ? l : toPublicLeaveProjection(l)));
});

// 2026-08-06: Upcountry moved from one free-text "location" string to up to 6 structured
// {time, name} stops. Validates shape server-side (not just format-checked at display time) --
// returns an error message string, or null if valid/absent.
// 2026-08-09 (Opus audit finding 2.4): was /^\d{2}:\d{2}$/, which accepts an out-of-range value
// like "99:99" -- harmless for every current consumer (falls through to a safe default) but a
// real HH:MM range check is what the field name promises and costs nothing to tighten.
const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/; // 2026-08-09 (Opus audit finding 2.1)
// 2026-08-09 (2nd-pass audit): DATE_RE alone is shape-only -- "2026-99-99" matches the regex but
// parses to Invalid Date, which produces NaN period-keys that silently bypass isPeriodLocked()/
// the MD-approval-freeze check (the exact bypass 2.1's fix exists to close), and can also match
// EVERY date in leaveDayCoverage()'s plain string comparison if dateFrom/dateTo are set to
// extreme values, hiding an employee's entire attendance history. Round-trips the date through
// its own components (not just new Date(s), which silently rolls an out-of-range month/day into
// a different real date -- e.g. 2026-02-30 becomes 2026-03-02) so a genuinely invalid calendar
// date is rejected outright.
function isValidDateStr(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
}
const LOCATION_NAME_MAX = 200; // 2026-08-09 (Opus audit finding 2.2): was unbounded -- see below
const REASON_MAX = 2000; // 2026-08-09 (Opus audit finding 2.2, generalized to the `reason` field)
// 2026-08-09 (2nd-pass audit): otHours had a lower bound (non-negative) but no upper bound --
// 2000 hours passed validation. Raised 2026-08-21 from 16h to 20h: still a sanity cap against
// a forged daily total, now matching a long driver shift across combined tiers.
const OT_HOURS_MAX = 20;
// 2026-08-10 (round-3 audit, item 3): fields written by exactly ONE request type's own submit
// path. Enumerated by reading every leaveData literal in app.js's submit*() functions against
// validateLeaveFreeFields() below. Universal fields are deliberately ABSENT: dateFrom/dateTo/
// days/timePart/reason/note/attachment/attachmentName/submittedAt/status/approvalRoute/approver/
// approvedAt/id/userId/serverCreatedAt/fileCount (fileCount is only ever written by
// clear-attachments today, but is validated/coerced generically by both handlers, i.e. it reads
// as a universal field and is left alone here).
const TYPE_SCOPED_LEAVE_FIELDS = {
  annual:              ['hourlyStart', 'hourlyEnd'],
  sick:                ['hourlyStart', 'hourlyEnd'],
  business:            ['hourlyStart', 'hourlyEnd'],
  upcountry:           ['locations'],
  'long-distance':     ['mileageStart', 'mileageEnd', 'distanceKm', 'longDistanceAllowance'],
  'personal-car':      ['personalCarRate'],
  'late-out':          ['lateOutTime'],
  ot:                  ['otEndTime', 'otHours', 'otMultiplier', 'isDriverOT', 'otHours20', 'otHours30'],
  'holiday-work':      ['workStartTime', 'workEndTime', 'locations', 'compensationMode', 'otHours20', 'otHours30'],
  'early-morning':     ['earlyMorningTier'],
  'time-correction':   ['correctionField', 'originalTime', 'correctedTime'],
  'clear-attachments': ['targetIds', 'targetSnapshot', 'totalSize'],
  // 2026-09-21: Abroad work trip. `location` is free text -- a country OR a customer name, both
  // are acceptable per the user. Adding the key here also registers the type in
  // VALID_LEAVE_TYPES (built from Object.keys of this object).
  abroad:              ['location'],
};
// SECURITY FIX 2026-08-13 (Opus-planned leaves-whitelist, phase 1): every field that reaches a
// stored leave record now falls into exactly one of three lists -- this one (client-settable on
// every type), TYPE_SCOPED_LEAVE_FIELDS above (client-settable only for its own type), or
// SERVER_LEAVE_FIELDS below (never client-settable at all, always computed here). Enumerated by
// reading every leaveData/leaveData-edit literal across all 13 submit*() paths in app.js
// (submitLeave, submitUpcountry, submitPersonalCar, submitLongDistance, submitClearAttachments,
// submitLateOut, submitOT, submitDriverOT, submitComp, submitTimeCorrection) and cross-checked
// against validateLeaveFreeFields() below -- every key any real submit path sends is covered by
// UNIVERSAL ∪ TYPE_SCOPED[type]. `fileCount` is only ever sent by submitClearAttachments() but is
// kept universal rather than moved into that type's own scoped list, because TYPE_SCOPED_LEAVE_FIELDS
// doubles as the input to the PUT handler's resolved-record prune (`keepFieldSet`, added in phase 2
// the same day this comment was written -- replaced the original phase-1 `keepFields` conversion-
// only cleanup loop it used to reference) -- moving it would also change prune behavior, not just
// filter behavior.
const UNIVERSAL_LEAVE_FIELDS = ['type', 'dateFrom', 'dateTo', 'days', 'timePart', 'reason', 'note', 'attachment', 'attachmentName', 'fileCount'];
// Never accepted from the client on POST or PUT -- always computed by the handler itself, after
// the client body has been filtered through filterLeaveFields() below. Listed here (rather than
// left implicit) so a future field addition has one obvious place to declare which bucket it's in.
const SERVER_LEAVE_FIELDS = ['id', 'userId', 'serverCreatedAt', 'status', 'approvalRoute', 'approver', 'approvedAt', 'submittedAt', 'timezone'];
const _leaveFieldSetCache = new Map();
function allowedLeaveFieldsFor(type) {
  let set = _leaveFieldSetCache.get(type);
  if (!set) {
    set = new Set([...UNIVERSAL_LEAVE_FIELDS, ...(TYPE_SCOPED_LEAVE_FIELDS[type] || [])]);
    _leaveFieldSetCache.set(type, set);
  }
  return set;
}
// Filters an incoming request body down to only the keys `type` is allowed to set. Iterates the
// (small, fixed-size) ALLOWLIST rather than the client's own keys -- bounded cost regardless of how
// many junk keys a hostile body carries, and no attacker-chosen string is ever used as an object
// key/assignment target, so a `__proto__`/`constructor` key in the body can't reach anything here.
// Callers must keep reading the ORIGINAL body/updates object for anything not in the allowlist that
// the handler still needs as an input (e.g. POST's quick-fix `body.userId`, `body.isDriverOT`) --
// this function only produces the base object the record/update is built from, never a replacement
// for the raw request body.
function filterLeaveFields(src, type) {
  const out = {};
  for (const k of allowedLeaveFieldsFor(type)) {
    if (Object.prototype.hasOwnProperty.call(src, k)) out[k] = src[k];
  }
  return out;
}
// SECURITY FIX 2026-08-13 (re-audit, F-2): `type` was never checked against a real whitelist, only
// "is it a non-empty string" -- an arbitrary type bypasses every type-branched validation/recompute
// block below AND reaches getApprovalRoute()'s unknown-key fallback (routes to md, no real approval
// needed for most fields). Worse, it's rendered UNESCAPED as leaveTypeLabel()'s final fallback
// (app.js) straight into an approver's card innerHTML -- a stored-XSS payload in `type` executes in
// the approving Manager's/MD's own browser session the moment they open the Approvals page, the
// exact session holding payroll and user-admin authority. Reusing TYPE_SCOPED_LEAVE_FIELDS's own
// keys as the whitelist means a future new type only needs adding there once.
const VALID_LEAVE_TYPES = new Set(Object.keys(TYPE_SCOPED_LEAVE_FIELDS));
// SECURITY FIX 2026-08-13 (leaves audit, F-5): annual/sick/business's day-mode `days` is fully
// derivable from dateFrom/dateTo -- submitLeave() (app.js) always computes it the same way: every
// calendar day in the range that isn't a weekend or a public holiday. `comp` is deliberately
// excluded (its `days` is always a fixed 1 for the single workedDate, which is typically itself a
// weekend/holiday -- that's the point of a compensatory day -- so this weekend/holiday-exclusion
// logic would be wrong for it). Hourly-mode requests (hourlyStart/hourlyEnd present) legitimately
// keep days:0 and are left alone by callers of this helper.
const DAY_BASED_LEAVE_TYPES = new Set(['annual', 'sick', 'business']);
// SECURITY FIX 2026-09-23 (Opus audit, leave MEDIUM-3): the server only format-checked hourly
// times, so `{hourlyStart:'08:30'}` with no end over a month-long range was stored as days:0 (costs
// 0 quota) while leaveDayCoverage() treats a missing end as a FULL day on every date in the range.
// Hourly leave is one day with both times and end after start -- exactly what submitLeave() sends.
function hourlyLeaveShapeError(hourlyStart, hourlyEnd, dateFrom, dateTo) {
  if (!hourlyStart && !hourlyEnd) return null;
  if (!hourlyStart || !hourlyEnd) return 'hourlyStart and hourlyEnd are both required for hourly leave';
  if (parseHHMMToMins(hourlyEnd) <= parseHHMMToMins(hourlyStart)) return 'hourlyEnd must be after hourlyStart';
  if (dateTo && dateTo !== dateFrom) return 'hourly leave must be a single day (dateTo must equal dateFrom)';
  // 2026-09-24 (owner): the lunch hour is not charged, so e.g. 12:00-13:00 would cost nothing.
  if (hourlyLeaveChargedMinutes(hourlyStart, hourlyEnd) <= 0) return 'hourly leave falls entirely within the 12:00-13:00 lunch break';
  return null;
}
// DUAL-SYNC with app.js hourlyLeaveChargedMinutes.
// 2026-09-24 (owner): hourly leave is charged the requested span MINUS its overlap with the
// 12:00-13:00 lunch break (10:00-15:00 = 4h, 12:30-14:00 = 1h). 12:00-13:00 charges 0 and is
// refused by hourlyLeaveShapeError above.
function hourlyLeaveChargedMinutes(hourlyStart, hourlyEnd) {
  const toMin = s => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || ''));
    return m ? Number(m[1]) * 60 + Number(m[2]) : NaN;
  };
  const s = toMin(hourlyStart), e = toMin(hourlyEnd);
  if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) return 0;
  const lunchMin = Math.max(0, Math.min(e, 13 * 60) - Math.max(s, 12 * 60));
  return e - s - lunchMin;
}
function deriveLeaveDaysCount(dateFrom, dateTo) {
  let days = 0;
  let d = new Date(dateFrom + 'T12:00:00');
  const end = new Date((dateTo || dateFrom) + 'T12:00:00');
  while (d <= end) {
    if (d.getDay() !== 0 && d.getDay() !== 6 && !isPublicHoliday(ta_localDateStr(d))) days++;
    d.setDate(d.getDate() + 1);
  }
  return days;
}

const DATE_OVERLAP_LEAVE_TYPES = new Set(['annual', 'sick', 'business', 'holiday-work', 'abroad']);
// DUAL-SYNC with app.js leaveRecordMinutes. 2026-09-24: hourly leave excludes the 12:00-13:00
// lunch overlap (hourlyLeaveChargedMinutes).
function leaveMinutesOf(l) {
  if ((Number(l.days) || 0) > 0) return Number(l.days) * 8 * 60;
  if (l.hourlyStart && l.hourlyEnd && HHMM_RE.test(l.hourlyStart) && HHMM_RE.test(l.hourlyEnd)) {
    return hourlyLeaveChargedMinutes(l.hourlyStart, l.hourlyEnd);
  }
  if (typeof l.timePart === 'string') {
    const hM = l.timePart.match(/(\d+)\s*(?:ชม\.|h|時間)/);
    const mM = l.timePart.match(/(\d+)\s*(?:น\.|m|分)/);
    return (hM ? parseInt(hM[1], 10) : 0) * 60 + (mM ? parseInt(mM[1], 10) : 0);
  }
  return 0;
}
function findOverlappingLeave(leaves, userId, type, dateFrom, dateTo, exceptId) {
  if (!DATE_OVERLAP_LEAVE_TYPES.has(type) || !dateFrom) return null;
  const aTo = dateTo || dateFrom;
  return leaves.find(l =>
    l.userId === userId &&
    l.id !== exceptId &&
    DATE_OVERLAP_LEAVE_TYPES.has(l.type) &&
    // 2026-09-23 (owner): Holiday Work is allowed on an approved Abroad day, so those two types
    // may overlap each other (every other pair still may not).
    !((type === 'abroad' && l.type === 'holiday-work') || (type === 'holiday-work' && l.type === 'abroad')) &&
    !isVoidLeaveStatus(l.status) &&
    l.dateFrom &&
    l.dateFrom <= aTo && (l.dateTo || l.dateFrom) >= dateFrom
  ) || null;
}
function findOtDuplicate(leaves, { userId, dateFrom, isDriverOT, otMultiplier, exceptId }) {
  if (!dateFrom) return null;
  const others = leaves.filter(l =>
    l.id !== exceptId && l.userId === userId && l.type === 'ot' &&
    l.dateFrom === dateFrom && !isVoidLeaveStatus(l.status)
  );
  if (!others.length) return null;
  if (!isDriverOT) return others[0];
  const office = others.find(l => !l.isDriverOT);
  if (office) return office;
  return others.find(l => Number(l.otMultiplier) === Number(otMultiplier)) || null;
}
function driverOtHoursOverCap(leaves, { userId, dateFrom, newHours, exceptId }) {
  const used = leaves.filter(l =>
    l.id !== exceptId && l.userId === userId && l.type === 'ot' && l.isDriverOT &&
    l.dateFrom === dateFrom && !isVoidLeaveStatus(l.status)
  ).reduce((s, l) => s + (Number(l.otHours) || 0), 0);
  return used + (Number(newHours) || 0) > OT_HOURS_MAX;
}
// DUAL-SYNC with app.js carryForwardExpiryEnabled / carryForwardExpiryDateStr /
// leaveWorkingDaysBetween / leaveMinutesOnOrBefore / carryForwardForfeitMinutes.
// 2026-09-24 (owner): carried-forward annual days expire on the configured month/day of the year
// they were carried INTO. They are consumed first (FIFO): whatever part of the carry-forward is
// not covered by annual leave dated on/before the expiry date (+ go-live opening-used) is
// forfeited once that date has passed. Toggle: appSettings.leave.carryForwardExpiryEnabled
// (missing = on). Late-arrival deductions deliberately do NOT count as carry-forward usage.
function carryForwardExpiryEnabled() {
  const lv = getAppSettings().leave;
  return !(lv && lv.carryForwardExpiryEnabled === false);
}
function carryForwardExpiryDateStr(year) {
  const lv = getAppSettings().leave || {};
  const month = Math.min(12, Math.max(1, Math.trunc(Number(lv.carryForwardExpiryMonth)) || 3));
  const lastDay = new Date(Number(year), month, 0).getDate();
  const day = Math.min(lastDay, Math.max(1, Math.trunc(Number(lv.carryForwardExpiryDay)) || 31));
  const p2 = n => String(n).padStart(2, '0');
  return `${year}-${p2(month)}-${p2(day)}`;
}
// Working days (not weekend / public holiday) from fromStr to toStr inclusive -- the same count
// submitLeave() stores in `days` (deriveLeaveDaysCount).
function leaveWorkingDaysBetween(fromStr, toStr) {
  return deriveLeaveDaysCount(fromStr, toStr);
}
// Minutes of leave `l` that count as carry-forward usage for a cutoff (the expiry date).
// 2026-09-24 (owner, review HIGH): a leave that STARTS on or before the expiry date may use
// carry-forward for the WHOLE leave -- it used to count only its working days up to the cutoff,
// which contradicted the submission gate (asOf = dateFrom sees no forfeit at all) and could push
// later balances negative.
function leaveMinutesOnOrBefore(l, cutoffStr) {
  if (!l || !l.dateFrom || l.dateFrom > cutoffStr) return 0;
  return leaveMinutesOf(l);
}
// Carry-forward minutes forfeited for `year` as seen on asOfDateStr: 0 until the expiry date has
// passed. includePending = the submission gate (pending leave dated on/before expiry already
// reserved the carry-forward, so it must not be penalised twice); balances use approved only.
function carryForwardForfeitMinutes(leaves, user, year, asOfDateStr, includePending, exceptId, cf) {
  if (!user || !carryForwardExpiryEnabled()) return 0;
  const expiry = carryForwardExpiryDateStr(year);
  if (!(String(asOfDateStr || '') > expiry)) return 0;
  const cfMap = cf || readSettings().leaveCarryForward || {};
  const cfMin = ((Number(cfMap[`${year}_${user.id}`]) || 0) + (Number(cfMap[`comp_${year}_${user.id}`]) || 0)) * 480;
  if (cfMin <= 0) return 0;
  const yStart = `${year}-01-01`;
  const openingUsed = Number((readSettings().leaveOpeningUsed || {})[`${year}_${user.id}_annual`]) || 0;
  let usedBeforeMin = Math.max(0, openingUsed) * 480;
  leaves.filter(l =>
    l.userId === user.id && l.type === 'annual' && l.id !== exceptId &&
    (includePending ? !isVoidLeaveStatus(l.status) : l.status === 'approved') &&
    l.dateFrom >= yStart && l.dateFrom <= expiry
  ).forEach(l => { usedBeforeMin += leaveMinutesOnOrBefore(l, expiry); });
  return Math.max(0, cfMin - usedBeforeMin);
}
function leaveBalanceError(leaves, user, type, reqMin, exceptId, dateFrom) {
  if (type !== 'annual' && type !== 'business') return null;
  if (!user) return 'Insufficient leave balance';
  if (reqMin > Math.max(0, leaveBalanceRemainingMinutes(leaves, user, type, exceptId, dateFrom))) return 'Insufficient leave balance';
  return null;
}
// 2026-09-24: the submission gate's remaining minutes (pending + approved use, unclamped -- can be
// negative), split out of leaveBalanceError so earnedDayUsedError uses the exact same number.
// DUAL-SYNC: app.js annualGateRemainingMinutes (annual only).
function leaveBalanceRemainingMinutes(leaves, user, type, exceptId, dateFrom) {
  const asOf = isValidDateStr(dateFrom) ? dateFrom : bangkokDateStr();
  const year = Number(asOf.slice(0, 4));
  const yStart = `${year}-01-01`, yEnd = `${year}-12-31`;
  const cf = (readSettings().leaveCarryForward) || {};
  const cfDays = type === 'annual' ? (Number(cf[`${year}_${user.id}`]) || 0) : 0;
  const cfComp = type === 'annual' ? (Number(cf[`comp_${year}_${user.id}`]) || 0) : 0;
  const approvedComp = type === 'annual' ? getApprovedHolidayWorkAnnualLeaveDays(leaves, user.id, year, exceptId) : 0;
  const entitlement = (type === 'annual' ? annualLeaveEntitlementDays(user, asOf) : businessLeaveEntitlementDays()) || 0;
  const totalMin = (entitlement + cfDays + cfComp + approvedComp) * 8 * 60;
  let usedMin = 0;
  leaves.filter(l =>
    l.userId === user.id && l.type === type &&
    !isVoidLeaveStatus(l.status) &&
    l.id !== exceptId &&
    l.dateFrom >= yStart && l.dateFrom <= yEnd
  ).forEach(l => { usedMin += leaveMinutesOf(l); });
  const openingUsed = Number((readSettings().leaveOpeningUsed || {})[`${year}_${user.id}_${type}`]) || 0;
  usedMin += openingUsed * 8 * 60;
  // 2026-09-24: a request dated after the carry-forward expiry cannot use expired carry-forward;
  // pending + approved leave dated on/before expiry counts as carry-forward usage (FIFO).
  // Dual-sync with app.js submitLeave() balance gate.
  const forfeitMin = type === 'annual' ? carryForwardForfeitMinutes(leaves, user, year, asOf, true, exceptId, cf) : 0;
  return totalMin - usedMin - forfeitMin;
}
// Dual-sync with app.js: DEFAULT_ANNUAL_LEAVE_TIERS, normalizeAnnualLeaveTiers,
// getAnnualLeaveTiers, getAnnualLeaveMinMonths, annualLeaveUnlockDateStr,
// isAnnualLeaveUnlocked, annualLeaveEntitlementDays, annualLeaveServiceError,
// DEFAULT_SICK_LEAVE_DAYS, DEFAULT_BUSINESS_LEAVE_DAYS, normalizeQuotaDays,
// sickLeaveEntitlementDays, businessLeaveEntitlementDays.
const DEFAULT_ANNUAL_LEAVE_TIERS = [
  { afterMonths: 6, days: 3 },
  { afterMonths: 12, days: 6 },
  { afterMonths: 24, days: 8 },
  { afterMonths: 36, days: 10 }
];
const DEFAULT_SICK_LEAVE_DAYS = 30;
const DEFAULT_BUSINESS_LEAVE_DAYS = 3;
function normalizeAnnualLeaveTiers(raw) {
  const fallback = DEFAULT_ANNUAL_LEAVE_TIERS.map(t => ({ ...t }));
  if (!Array.isArray(raw) || raw.length === 0) return fallback;
  const seen = new Set();
  const out = [];
  for (const t of raw) {
    if (!t || typeof t !== 'object') continue;
    const afterMonths = Math.trunc(Number(t.afterMonths));
    const days = Math.trunc(Number(t.days));
    if (!Number.isFinite(afterMonths) || afterMonths < 0 || afterMonths > 600) continue;
    if (!Number.isFinite(days) || days < 0 || days > 365) continue;
    if (seen.has(afterMonths)) continue;
    seen.add(afterMonths);
    out.push({ afterMonths, days });
  }
  if (!out.length) return fallback;
  out.sort((a, b) => a.afterMonths - b.afterMonths);
  return out.slice(0, 12);
}
function getAnnualLeaveTiers() {
  return normalizeAnnualLeaveTiers(getAppSettings().leave && getAppSettings().leave.annualLeaveTiers);
}
function getAnnualLeaveMinMonths() {
  const tiers = getAnnualLeaveTiers();
  if (tiers.length) return Math.max(0, Math.min(600, tiers[0].afterMonths));
  const n = Number(getAppSettings().leave && getAppSettings().leave.annualLeaveMinMonths);
  if (!Number.isFinite(n)) return 6;
  return Math.max(0, Math.min(60, Math.trunc(n)));
}
function annualLeaveUnlockDateStr(startDate, months) {
  if (!isValidDateStr(startDate)) return null;
  const monthsN = Number(months);
  if (!Number.isFinite(monthsN) || monthsN <= 0) return startDate;
  const [y, m, d] = startDate.split('-').map(Number);
  const first = new Date(y, m - 1 + monthsN, 1);
  const lastDay = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
  const day = Math.min(d, lastDay);
  const p2 = n => String(n).padStart(2, '0');
  return `${first.getFullYear()}-${p2(first.getMonth() + 1)}-${p2(day)}`;
}
function isAnnualLeaveUnlocked(user, asOfDate) {
  if (!user || !user.startDate) return false;
  const months = getAnnualLeaveMinMonths();
  if (months <= 0) return true;
  const unlock = annualLeaveUnlockDateStr(user.startDate, months);
  if (!unlock) return false;
  const asOf = asOfDate || bangkokDateStr();
  return asOf >= unlock;
}
function annualLeaveEntitlementDays(user, asOfYmd) {
  const tiers = getAnnualLeaveTiers();
  if (!user || !user.startDate || !tiers.length) return 0;
  const asOf = asOfYmd || bangkokDateStr();
  let days = 0;
  for (const t of tiers) {
    const unlock = annualLeaveUnlockDateStr(user.startDate, t.afterMonths);
    if (unlock && asOf >= unlock) days = Math.max(days, t.days);
  }
  return days;
}
function normalizeQuotaDays(n, fallback) {
  if (n == null) return fallback;
  if (typeof n === 'string' && n.trim() === '') return fallback;
  const v = Math.trunc(Number(n));
  if (!Number.isFinite(v) || v < 0 || v > 365) return fallback;
  return v;
}
function sickLeaveEntitlementDays() {
  return normalizeQuotaDays(getAppSettings().leave && getAppSettings().leave.sickLeaveDays, DEFAULT_SICK_LEAVE_DAYS);
}
function businessLeaveEntitlementDays() {
  return normalizeQuotaDays(getAppSettings().leave && getAppSettings().leave.businessLeaveDays, DEFAULT_BUSINESS_LEAVE_DAYS);
}
// DUAL-SYNC with app.js annualLeaveEarnedPoolDays / canUseAnnualLeave.
// 2026-09-24 (owner): before the tenure unlock the quota part is 0, but days the employee EARNED
// (holiday work taken as annual leave, abroad travel days) or carried forward are theirs to use.
// annualLeaveServiceError lets the request through whenever that pool is > 0; leaveBalanceError
// then limits the amount. Pool 0 = locked exactly as before.
function annualLeaveEarnedPoolDays(leaves, user, year, exceptId) {
  if (!user) return 0;
  const cf = readSettings().leaveCarryForward || {};
  return (Number(cf[`${year}_${user.id}`]) || 0) + (Number(cf[`comp_${year}_${user.id}`]) || 0)
    + getApprovedHolidayWorkAnnualLeaveDays(leaves || [], user.id, year, exceptId);
}
function annualLeaveServiceError(user, type, dateFrom, leaves, exceptId) {
  if (type !== 'annual') return null;
  const asOf = isValidDateStr(dateFrom) ? dateFrom : bangkokDateStr();
  if (user && annualLeaveEarnedPoolDays(leaves, user, Number(asOf.slice(0, 4)), exceptId) > 0) return null;
  if (!user || !user.startDate) return 'Annual leave is not available yet';
  const months = getAnnualLeaveMinMonths();
  if (months <= 0) return null;
  const unlock = annualLeaveUnlockDateStr(user.startDate, months);
  if (!unlock) return 'Annual leave is not available yet';
  if (asOf < unlock) {
    const firstDays = (getAnnualLeaveTiers()[0] && getAnnualLeaveTiers()[0].days) || 0;
    return `Annual leave unlocks after ${months} months of service (available from ${unlock}, ${firstDays} days)`;
  }
  return null;
}
function validateUpcountryLocations(locations) {
  if (locations === undefined) return null;
  if (!Array.isArray(locations) || locations.length === 0 || locations.length > 6) {
    return 'locations must be an array of 1-6 entries';
  }
  for (const loc of locations) {
    if (!loc || typeof loc.name !== 'string' || !loc.name.trim()) {
      return 'each location entry needs a non-empty name';
    }
    // 2026-08-09 (Opus audit finding 2.2): no length cap meant a handful of crafted requests
    // (6 stops x ~megabyte-scale names each) could bloat leaves.json enough to make GET
    // /api/leaves -- which returns every record to every authenticated user on every load --
    // slow or unusable for the whole company. 200 chars comfortably covers a real address/
    // customer name.
    if (loc.name.length > LOCATION_NAME_MAX) {
      return `location name must be ${LOCATION_NAME_MAX} characters or fewer`;
    }
    if (loc.time !== undefined && loc.time !== '' && !HHMM_RE.test(loc.time)) {
      return 'location time must be in HH:MM format';
    }
  }
  return null;
}

function isFiniteNonNegNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0;
}

// SECURITY FIX 2026-08-09 (Opus audit finding 1.4): lateOutTime/otEndTime/otHours/mileageStart/
// mileageEnd/distanceKm had NO format validation at all (only hourlyStart/hourlyEnd and
// locations were covered by the 2026-08-06 fix) -- app.js interpolates lateOutTime (and
// otEndTime/otHours on a separate render path) UNESCAPED into innerHTML at several sites
// (approval cards, the request detail modal), making this a stored-XSS hole reachable by any
// authenticated employee and executed in the approving Manager's/MD's browser -- the exact
// session with approval and payroll authority. Rejecting non-conforming values here closes it
// at the source, same pattern as the 2026-08-06 hourlyStart/hourlyEnd fix; the render sites are
// also being escaped as defense in depth (see app.js).
// SECURITY FIX 2026-08-10 (round-3 audit note): isValidDateStr() rejects shape-invalid and
// calendar-invalid dates, but never checked dateTo against dateFrom -- two individually-valid
// real dates like dateFrom:"1000-01-01"/dateTo:"9999-12-31" both pass it, and nothing capped the
// span between them. leaveDayCoverage() does a plain string range comparison, so an absurd span
// would make it treat an enormous date range as covered by one leave record. A human approver
// would have to approve something obviously wrong for this to matter in practice, but closing it
// at the source costs nothing. DATE_SPAN_MAX_DAYS mirrors the existing `days` field's own cap.
const DATE_SPAN_MAX_DAYS = 366;
function validateDateRange(dateFrom, dateTo) {
  if (!dateTo) return null;
  // 2026-08-10 (round-8 re-audit): a missing/unusable dateFrom used to fall through silently --
  // new Date(undefined + 'T00:00:00') is Invalid Date, so `to < from` is false and spanDays is
  // NaN (NaN > 366 is also false), meaning this returned null (valid) instead of catching the
  // problem. POST always has a real dateFrom by the time this runs, but PUT can pass a legacy
  // record's empty dateFrom through when only dateTo is being edited. Fail closed instead.
  if (!dateFrom || !isValidDateStr(dateFrom)) return 'dateFrom must be a valid YYYY-MM-DD date';
  const from = new Date(dateFrom + 'T00:00:00');
  const to = new Date(dateTo + 'T00:00:00');
  if (to < from) return 'dateTo must not be before dateFrom';
  const spanDays = Math.round((to - from) / 86400000);
  if (spanDays > DATE_SPAN_MAX_DAYS) return `date range must be ${DATE_SPAN_MAX_DAYS} days or fewer`;
  return null;
}
// 2026-09-21 (Abroad): the date range IS the money here -- every calendar day in it is paid -- so
// it gets a tighter cap than the generic 366 and its own required-field check. Takes the RESOLVED
// record (existing merged with the update), never the raw body: validating only the fields a PUT
// happened to touch is a bug class this file has hit repeatedly (see the 2026-08-10 round-4 audit).
const ABROAD_SPAN_MAX_DAYS = 90;
const ABROAD_LOCATION_MAX = 200;
function abroadSpanDays(dateFrom, dateTo) {
  const to = dateTo || dateFrom;
  return Math.round((new Date(to + 'T00:00:00') - new Date(dateFrom + 'T00:00:00')) / 86400000) + 1;
}
function validateAbroadRecord({ dateFrom, dateTo, location, reason }) {
  if (!isValidDateStr(dateFrom)) return 'dateFrom must be a valid YYYY-MM-DD date for abroad requests';
  const to = dateTo || dateFrom;
  if (!isValidDateStr(to)) return 'dateTo must be a valid YYYY-MM-DD date for abroad requests';
  if (to < dateFrom) return 'dateTo must not be before dateFrom';
  const span = abroadSpanDays(dateFrom, to);
  if (!Number.isFinite(span) || span < 1 || span > ABROAD_SPAN_MAX_DAYS) {
    return `abroad date range must be between 1 and ${ABROAD_SPAN_MAX_DAYS} days`;
  }
  const loc = String(location == null ? '' : location).trim();
  if (!loc) return 'location is required for abroad requests';
  if (loc.length > ABROAD_LOCATION_MAX) return `location must be ${ABROAD_LOCATION_MAX} characters or fewer`;
  if (!String(reason == null ? '' : reason).trim()) return 'reason is required for abroad requests';
  return null;
}
// Eligibility gates SUBMISSION, not just payment (user 2026-09-21: "เลือกได้ว่าใครจะยื่น allowance นี้
// ได้บ้าง"). Without this, an ineligible role could still POST a record that pays nothing but does
// silently mark its days as worked instead of absent.
// 2026-09-23 (owner): a trip's start/end dates are travel days that earn annual leave
// automatically and cannot carry Holiday Work -- refuse a trip whose travel day already has one.
const ABROAD_TRAVEL_HW_CONFLICT_MSG = "A holiday work request exists on this trip's start or end date — travel days earn annual leave automatically; cancel that holiday work first";
// Shown to the APPROVER (who cannot cancel the employee's holiday work). Client maps code
// 'abroad-travel-hw-conflict' to its own TH/EN/JA text.
const ABROAD_TRAVEL_HW_CONFLICT_APPROVAL_MSG = "Holiday work already exists on this trip's start or end date, and a travel day cannot also carry holiday work. Reject this trip (the employee can resubmit it with other dates), or reject that holiday work first if it is still pending";
function abroadTravelDayHolidayWorkConflict(leaves, userId, dateFrom, dateTo) {
  const travel = new Set([dateFrom, dateTo || dateFrom]);
  return leaves.some(l =>
    l.userId === userId && l.type === 'holiday-work' &&
    !isVoidLeaveStatus(l.status) && travel.has(l.dateFrom));
}
function abroadSubmitBlockReason(user) {
  if (!user) return 'You are not eligible to submit abroad requests';
  if (!isAllowanceEligible(getAppSettings().allowanceEligibility, user.role, 'abroad')) {
    return 'You are not eligible to submit abroad requests';
  }
  return null;
}
function validateLeaveFreeFields(body) {
  if (body.lateOutTime !== undefined && body.lateOutTime !== '' && !HHMM_RE.test(body.lateOutTime)) {
    return 'lateOutTime must be in HH:MM format';
  }
  if (body.otEndTime !== undefined && body.otEndTime !== '' && !HHMM_RE.test(body.otEndTime)) {
    return 'otEndTime must be in HH:MM format';
  }
  // SECURITY FIX 2026-08-10 (5th-pass audit): correctedTime/correctionField had ZERO server-side
  // validation -- any authenticated employee could submit a time-correction request with
  // correctedTime containing an XSS/JS-injection payload, and once approved it's stored verbatim
  // as attendanceLog checkIn/checkOut and rendered unescaped at ~15 sites across app.js (now fixed
  // there too, but this closes it at the source, same reasoning as every other field here).
  if (body.correctedTime !== undefined && body.correctedTime !== '' && !HHMM_RE.test(body.correctedTime)) {
    return 'correctedTime must be in HH:MM format';
  }
  if (body.correctionField !== undefined && !['checkIn', 'checkOut'].includes(body.correctionField)) {
    return 'correctionField must be checkIn or checkOut';
  }
  // 2026-08-09 (2nd-pass audit): was lower-bound-only -- otHours:2000 used to pass.
  if (body.otHours !== undefined && (!isFiniteNonNegNumber(body.otHours) || Number(body.otHours) > OT_HOURS_MAX)) {
    return `otHours must be a non-negative number, ${OT_HOURS_MAX} or fewer`;
  }
  // SECURITY FIX 2026-08-10 (Opus audit, round-3 note): otMultiplier had no entry here at all --
  // only validated inside the driver-OT tier check further down (POST handler), so for every other
  // leave type it was a completely unvalidated pass-through field. Harmless today (nothing reads it
  // outside an l.type==='ot' branch, and 'ot'-type records either get this recomputed server-side
  // or range-checked by the driver-tier check), but bounding it here closes the gap at the source
  // like every other free field, instead of relying on "nothing reads it" staying true forever.
  if (body.otMultiplier !== undefined && (!isFiniteNonNegNumber(body.otMultiplier) || Number(body.otMultiplier) > 3)) {
    return 'otMultiplier must be a non-negative number, 3 or fewer';
  }
  if (body.mileageStart !== undefined && !isFiniteNonNegNumber(body.mileageStart)) {
    return 'mileageStart must be a non-negative number';
  }
  if (body.mileageEnd !== undefined && !isFiniteNonNegNumber(body.mileageEnd)) {
    return 'mileageEnd must be a non-negative number';
  }
  if (body.distanceKm !== undefined && !isFiniteNonNegNumber(body.distanceKm)) {
    return 'distanceKm must be a non-negative number';
  }
  // 2026-08-09 (2nd-pass audit finding 1): `days`/`fileCount` had no server validation at all --
  // same unescaped-in-several-innerHTML-render-sites class as lateOutTime/otHours above (app.js
  // now Number()-coerces at those render sites as defense in depth; this closes it at the source).
  if (body.days !== undefined && (!isFiniteNonNegNumber(body.days) || Number(body.days) > 366)) {
    return 'days must be a non-negative number, 366 or fewer';
  }
  if (body.fileCount !== undefined && (!isFiniteNonNegNumber(body.fileCount) || Number(body.fileCount) > 1000)) {
    return 'fileCount must be a non-negative number, 1000 or fewer';
  }
  // 2026-08-09 (Opus audit finding 2.2, generalized): `reason` was unbounded even before the
  // Upcountry `locations` length cap -- same GET /api/leaves-returns-everything-to-everyone
  // amplification risk (a handful of megabyte-scale reasons would slow the whole company's
  // login/page-load, since every leave record round-trips on every load).
  if (typeof body.reason === 'string' && body.reason.length > REASON_MAX) {
    return `reason must be ${REASON_MAX} characters or fewer`;
  }
  // HYGIENE FIX 2026-08-13 (re-audit, F-7): `note`/`timePart` are `reason`'s untouched siblings --
  // XSS-safe at every render site already (all escapeHtml()'d), but unbounded, same DoS-
  // amplification class as reason/locations/targetIds (a handful of megabyte-scale values bloat
  // leaves.json, which every client re-downloads on every load).
  if (typeof body.note === 'string' && body.note.length > REASON_MAX) {
    return `note must be ${REASON_MAX} characters or fewer`;
  }
  if (typeof body.timePart === 'string' && body.timePart.length > 50) {
    return 'timePart must be 50 characters or fewer';
  }
  // SECURITY FIX 2026-08-13 (F-A, Opus-flagged during the leaves-whitelist plan): `attachment` had
  // zero format validation -- the real fix is that GET /api/upload/:filename now checks
  // uploadOwners.json (who actually uploaded the file, from their verified JWT) rather than trusting
  // this field, but bounding its shape here too is cheap defense in depth: the real submit path
  // always sends back exactly what POST /api/upload returned (`${Date.now()}_${sanitizedOriginal}`),
  // so anything else is already a lie about a real upload having happened.
  if (body.attachment !== undefined && body.attachment !== null &&
      (typeof body.attachment !== 'string' || !/^\d{10,15}_[A-Za-z0-9.\-_]{1,80}$/.test(body.attachment))) {
    return 'attachment must be a valid uploaded filename';
  }
  if (typeof body.attachmentName === 'string' && body.attachmentName.length > 150) {
    return 'attachmentName must be 150 characters or fewer';
  }
  // HYGIENE FIX 2026-08-13 (re-audit, F-7): workedDate (comp) had no validation at all -- the real
  // submit path always sends it as a real YYYY-MM-DD (same date-input value as dateFrom/dateTo, see
  // submitCompDay() in app.js), and getApprovedCompDays() does a raw string range compare against
  // it, so a garbage value could silently shift a comp day out of its accrual year.
  if (body.workStartTime !== undefined && body.workStartTime !== '' && !HHMM_RE.test(body.workStartTime)) {
    return 'workStartTime must be in HH:MM format';
  }
  if (body.workEndTime !== undefined && body.workEndTime !== '' && !HHMM_RE.test(body.workEndTime)) {
    return 'workEndTime must be in HH:MM format';
  }
  if (body.compensationMode !== undefined && body.compensationMode !== '' &&
      !['annual-leave', 'paid'].includes(body.compensationMode)) {
    return 'compensationMode must be annual-leave or paid';
  }
  if (body.earlyMorningTier !== undefined && ![1, 2].includes(Number(body.earlyMorningTier))) {
    return 'earlyMorningTier must be 1 or 2';
  }
  // CORRECTNESS FIX 2026-08-16 (Opus re-audit): the "workedDate must be a weekend/holiday" rule
  // used to live here, but this function only ever sees a PARTIAL body (PUT's `updates` never
  // carries `type` at all -- saveLeaveEdit() doesn't send it -- so `body.type === 'comp'` was
  // always false on every edit, silently skipping the check entirely), and it was gated on
  // `body.workedDate` being truthy rather than REQUIRING it for type:'comp', so simply omitting
  // the field bypassed the rule outright on a direct POST. Moved to explicit required+resolved-
  // value checks in the POST and PUT handlers themselves (same pattern already used there for
  // time-correction/upcountry/driver-OT), which can see the full resolved record either way.
  // HYGIENE FIX 2026-08-13 (re-audit, F-7): originalTime (time-correction) is correctedTime's
  // sibling -- XSS-safe at every render site already, but the real submit path can legitimately
  // send the '—' sentinel (no prior attendance data) rather than always HH:MM, so only cap length
  // rather than requiring HHMM_RE (avoids rejecting that legitimate sentinel).
  if (typeof body.originalTime === 'string' && body.originalTime.length > 20) {
    return 'originalTime must be 20 characters or fewer';
  }
  // HYGIENE FIX 2026-08-13 (re-audit, F-7): totalSize (clear-attachments) is fileCount's sibling --
  // both are `selected.length`-derived quantities from the same clear-attachments submit flow.
  if (body.totalSize !== undefined && !isFiniteNonNegNumber(body.totalSize)) {
    return 'totalSize must be a non-negative number';
  }
  // SECURITY FIX 2026-08-10 (Opus audit, round-3 note): type:'clear-attachments' is the only
  // consumer of targetIds/targetSnapshot, and neither was bounded -- same unbounded-array DoS-
  // amplification class as the `locations`/`reason`/`days`/`fileCount` caps above, just not closed
  // for these two. The actual file deletion still requires the separately role-gated
  // POST /api/attachments/clear (requireRole('md')), so this can't escalate privilege -- it can
  // only bloat a stored leave record up to the global body-size limit.
  // 2026-08-10 (round-8 re-audit): TARGET_MAX was 500, but `fileCount` (the same underlying
  // quantity -- both are `selected.length` from the same array in app.js's clear-attachments
  // submit flow) is capped at 1000. Once the company accumulates >500 old attachments, "Select
  // All" would hard-fail with no way to complete the operation. Raised to match fileCount's cap.
  const TARGET_MAX = 1000;
  if (body.targetIds !== undefined) {
    if (!Array.isArray(body.targetIds) || body.targetIds.length > TARGET_MAX) {
      return `targetIds must be an array of ${TARGET_MAX} items or fewer`;
    }
  }
  // 2026-08-10 (round-8 re-audit): only .length was checked, not item shape -- targetSnapshot:
  // [null, null] passed this (a valid array, under the cap) but crashes the approver's
  // request-detail modal (app.js's snap.map() reads s.date/s.employeeName off each entry). Not
  // exploitable as XSS (those render sites already escapeHtml() their output), but it let any
  // employee break the Manager/MD's view of a submitted request. Require each entry to actually
  // look like the snapshot object app.js's submitClearAttachments() constructs.
  if (body.targetSnapshot !== undefined) {
    if (!Array.isArray(body.targetSnapshot) || body.targetSnapshot.length > TARGET_MAX) {
      return `targetSnapshot must be an array of ${TARGET_MAX} items or fewer`;
    }
    // 2026-08-10 (round-9 re-audit): typeof s.date === 'string' let an empty string through
    // (it's a string, just not a date) -- app.js's snap.map() does `new Date(s.date+'T12:00:00')`,
    // which for '' renders as the literal text "NaN undefined NaN". Cosmetic, not a crash (the
    // other fields read off each item already have `||''` fallbacks), but tightened to actually
    // require a real calendar date since that's what the field name promises.
    if (body.targetSnapshot.some(s => !s || typeof s !== 'object' || !isValidDateStr(s.date))) {
      return 'targetSnapshot items must be objects with a valid YYYY-MM-DD date field';
    }
  }
  return null;
}

app.post('/api/leaves', withLeavesLock((req, res) => {
  try {
    const body = parseBody(req);
    const type = body.type;
    // 2026-08-10 (Opus audit F5): was `if (!type)`, which accepts `type:123`/`type:['ot']`/
    // `type:{}` (truthy non-strings) -- PUT's own type guard (added today) is stricter, so POST had
    // become the weaker side of the pair. A non-string type would also break
    // TYPE_SCOPED_LEAVE_FIELDS[type] lookups downstream (undefined -> empty keep-set) on any later
    // PUT that converts the record's type.
    if (typeof type !== 'string' || !VALID_LEAVE_TYPES.has(type)) return res.status(400).json({ success:false, message:'unknown request type' });
    if (type === 'comp') return res.status(400).json({ success:false, message:'comp request type is no longer accepted; use holiday-work instead' });
    // SECURITY FIX 2026-08-09 (Opus audit finding 2.1): every legitimate submit path already
    // sends a dateFrom, but nothing required it -- the period-lock/MD-freeze check a few lines
    // below is wrapped in `if (body.dateFrom)`, so simply omitting or blanking the field skipped
    // that guard entirely (the exact class of hole the 2026-08-02 fix was written to close for
    // auto-approving types). Requiring a real YYYY-MM-DD here means that guard can no longer be
    // silently bypassed by leaving the date out.
    if (!body.dateFrom || !isValidDateStr(body.dateFrom)) {
      return res.status(400).json({ success:false, message:'dateFrom must be a valid YYYY-MM-DD date' });
    }
    if (body.dateTo !== undefined && body.dateTo !== '' && !isValidDateStr(body.dateTo)) {
      return res.status(400).json({ success:false, message:'dateTo must be a valid YYYY-MM-DD date' });
    }
    const rangeErrPost = validateDateRange(body.dateFrom, body.dateTo);
    if (rangeErrPost) return res.status(400).json({ success:false, message:rangeErrPost });
    // SECURITY FIX 2026-08-06 (Opus audit): hourlyStart/hourlyEnd were stored with no format
    // validation at all -- app.js interpolates them into rendered HTML (approval cards, the
    // attendance table's half-day-leave chip/note) and, while those sites are now escapeHtml()'d,
    // rejecting a non-HH:MM value here closes the hole at the source instead of relying solely on
    // every render site remembering to escape.
    if ((body.hourlyStart !== undefined && !HHMM_RE.test(body.hourlyStart)) ||
        (body.hourlyEnd !== undefined && !HHMM_RE.test(body.hourlyEnd))) {
      return res.status(400).json({ success:false, message:'hourlyStart/hourlyEnd must be in HH:MM format' });
    }
    // SECURITY FIX 2026-08-13 (leaves audit, F-5): `days` for annual/sick/business was only
    // bounds-checked (isFiniteNonNegNumber, <=366 -- see validateLeaveFreeFields) then trusted
    // verbatim -- confirmed it doesn't touch money today (payroll only reads day-status via
    // leaveDayCoverage(), never l.days, for these 3 types; entitlement enforcement is client-side
    // only regardless), but it's fully derivable and shown back to the employee/approver, so derive
    // it server-side rather than trusting the client, same "not derivable by the client alone ->
    // derive it" pattern as distanceKm/otMultiplier/otHours above. Requires dateFrom/dateTo already
    // validated above. Day-mode only (hourlyStart/hourlyEnd absent) -- hourly-mode requests
    // legitimately send days:0 and are left alone.
    if (DAY_BASED_LEAVE_TYPES.has(type)) {
      const hourlyErr = hourlyLeaveShapeError(body.hourlyStart, body.hourlyEnd, body.dateFrom, body.dateTo);
      if (hourlyErr) return res.status(400).json({ success:false, message:hourlyErr });
    }
    if (DAY_BASED_LEAVE_TYPES.has(type) && body.hourlyStart === undefined && body.hourlyEnd === undefined) {
      body.days = deriveLeaveDaysCount(body.dateFrom, body.dateTo);
    } else if (DAY_BASED_LEAVE_TYPES.has(type)) {
      // SECURITY/CORRECTNESS FIX 2026-08-13 (M-1, Opus retrospective audit): hourly-mode requests
      // were left alone under the assumption their `days` is inert ("legitimately send days:0"),
      // but that's only true when the client actually sends 0 -- `leaveDayCoverage()` (the real
      // consumer) checks `(l.days || 0) > 0` FIRST, before ever looking at hourlyStart/hourlyEnd,
      // so a forged `{hourlyStart,hourlyEnd, days:5}` claims a FULL day off (ignoring the hourly
      // window's own coverage math entirely) instead of the partial/half-day coverage the hourly
      // fields actually describe. Force it server-side the same way the real submit path always
      // does for hourly mode, instead of trusting whatever the client sent.
      body.days = 0;
    } else if (type === 'holiday-work') {
      body.days = body.compensationMode === 'annual-leave' ? 1 : 0;
    } else if (type === 'early-morning') {
      body.days = 0;
    } else if (type === 'abroad') {
      // Full calendar span, NOT deriveLeaveDaysCount() -- that one strips weekends and public
      // holidays, which is right for annual leave and wrong here: an abroad trip covers every
      // day it spans and is paid for every one of them. Display-only; payroll counts day
      // statuses, not this field.
      body.days = abroadSpanDays(body.dateFrom, body.dateTo);
    }
    // 2026-08-09 (Opus audit finding 2.5): validateUpcountryLocations(undefined) returns null
    // (valid/absent), so a direct POST with type:'upcountry' and no `locations` array at all was
    // silently accepted -- the frontend's own display fallback (upcountryLocationsOf()) papered
    // over it, but the structured shape was never actually guaranteed at the source, which is
    // exactly the guarantee this field exists to provide for any future consumer.
    if (type === 'upcountry' && body.locations === undefined) {
      return res.status(400).json({ success:false, message:'locations required for upcountry requests' });
    }
    const locErr = validateUpcountryLocations(body.locations);
    if (locErr) return res.status(400).json({ success:false, message:locErr });
    const freeFieldErr = validateLeaveFreeFields(body);
    if (freeFieldErr) return res.status(400).json({ success:false, message:freeFieldErr });
    // SECURITY FIX 2026-08-10 (round-9 re-audit): validateLeaveFreeFields() only checks
    // correctedTime's FORMAT when present (`!== '' && !HHMM_RE.test(...)`) and correctionField's
    // VALUE when present -- neither was actually required for type:'time-correction', so
    // `{type:'time-correction', correctionField:'checkIn', correctedTime:''}` passed both checks.
    // On approval this sets attendanceLog checkIn to '' (server.js's applyApprovalToLog-equivalent
    // payroll path), which silently flips a 'late' day to 'present' ('' > standardStart is false) --
    // no visible sign anything is wrong, since the approval card shows a generic label and the
    // notification email only includes the time `if (leave.correctedTime)`. Same "not derivable,
    // so require it outright" reasoning as the upcountry `locations` check just above.
    if (type === 'time-correction') {
      if (!body.correctedTime || !HHMM_RE.test(body.correctedTime)) {
        return res.status(400).json({ success:false, message:'correctedTime is required and must be in HH:MM format for time-correction requests' });
      }
      if (!['checkIn', 'checkOut'].includes(body.correctionField)) {
        return res.status(400).json({ success:false, message:'correctionField must be checkIn or checkOut for time-correction requests' });
      }
    }
    if (type === 'abroad') {
      const abroadErr = validateAbroadRecord(body);
      if (abroadErr) return res.status(400).json({ success:false, message:abroadErr });
    }
    if (type === 'holiday-work') {
      if (!['annual-leave', 'paid'].includes(body.compensationMode)) {
        return res.status(400).json({ success:false, message:'compensationMode must be annual-leave or paid for holiday-work requests' });
      }
      if (!body.workStartTime || !HHMM_RE.test(body.workStartTime) ||
          !body.workEndTime || !HHMM_RE.test(body.workEndTime)) {
        return res.status(400).json({ success:false, message:'workStartTime and workEndTime are required and must be in HH:MM format for holiday-work requests' });
      }
      // 2026-09-24 (owner): an end before 05:00 is after midnight of the same work day.
      if (!Number.isFinite(holidayWorkEndMins(body.workStartTime, body.workEndTime))) {
        return res.status(400).json({ success:false, message:'workEndTime must be after workStartTime (an end before 05:00 counts as after midnight)' });
      }
      if (holidayWorkTooLong(body.workStartTime, body.workEndTime)) {
        return res.status(400).json({ success:false, code:'hw-too-long', message:'Holiday Work cannot be longer than 20 hours' });
      }
      const hwLocErr = validateHolidayWorkLocation(body.locations);
      if (hwLocErr) return res.status(400).json({ success:false, message:hwLocErr });
      if (!body.attachment && !(Number(body.fileCount) > 0)) {
        return res.status(400).json({ success:false, message:'Working Report attachment is required for holiday-work requests' });
      }
    }
    // SECURITY FIX 2026-08-13 (re-audit, F-3): distanceKm was only bounds-checked (non-negative),
    // then trusted verbatim to decide whether the Long Distance allowance pays out -- even though
    // it's fully derivable from mileageStart/mileageEnd (submitLongDistance() in app.js always sends
    // `distanceKm = mileageEnd - mileageStart`). A forged distanceKm could claim the allowance for a
    // trip whose actual mileage delta doesn't clear the threshold. Same "not derivable -> require +
    // derive it outright" pattern as upcountry `locations`/time-correction `correctedTime` above.
    if (type === 'long-distance') {
      const ms = Number(body.mileageStart), me = Number(body.mileageEnd);
      if (!Number.isFinite(ms) || !Number.isFinite(me) || me <= ms) {
        return res.status(400).json({ success:false, message:'mileageStart/mileageEnd are required for long-distance requests, and mileageEnd must be greater than mileageStart' });
      }
      body.distanceKm = me - ms;
    }
    const users = readUsers() || [];
    const live = users.find(u => u.id === req.user.sub);
    if (!live) return res.status(403).json({ success:false, message:'Forbidden' });
    if (isSuperAdminUser(live)) {
      return res.status(403).json({ success:false, message:'System account cannot submit leave or attendance requests' });
    }

    // SECURITY FIX 2026-08-09 (2nd-pass audit, gap in the same day's OT-forgery fix): isDriverOT
    // was trusted as a bare client-supplied boolean with no role check -- an OFFICE employee could
    // send isDriverOT:true to (a) skip the otMultiplier/otHours recompute below entirely, letting
    // them submit ×3 on an ordinary weekday, and (b) reroute the request via 'driver-ot's own
    // configured approval route instead of regular office 'ot's (a separate, independently
    // configurable route -- see ⚙️ Approval Settings). Only an actual driver can take the
    // driver-ot path now, regardless of
    // what the client claims -- computed once here and used everywhere below instead of ever
    // reading body.isDriverOT directly again.
    const isDriverOT = type === 'ot' && live.role === 'driver' && !!body.isDriverOT;
    // SECURITY FIX 2026-08-09 (found alongside the lateOutTime XSS audit -- same "never trust the
    // client for a money input" pattern already applied to longDistanceAllowance/personalCarRate
    // below): driver OT's otMultiplier is a manual choice of one of 3 fixed tiers, not derivable
    // from the date -- reject anything else here rather than trusting whatever the client sent.
    // 2026-08-10 (round-8 re-audit): was `!== undefined`-gated, so a driver POSTing isDriverOT:true
    // with NO otMultiplier at all skipped this check entirely -- Number(undefined) is NaN, which
    // gets stored as null a few lines below, and computePayroll()'s `Number(l.otMultiplier) || 1.5`
    // then silently pays the ×1.5 (weekday) rate for what might have been a ×3 holiday shift.
    // Fails safe (never overpays), but it's an unvalidated hole the tier check was meant to close.
    // Now required whenever isDriverOT, not just validated when present.
    if (isDriverOT && ![1.5, 2, 3].includes(Number(body.otMultiplier))) {
      return res.status(400).json({ success:false, message:'otMultiplier must be 1.5, 2, or 3 for driver OT' });
    }
    // POLICY CHANGE 2026-08-16 / 2026-08-21: Company Trip is a paid day off -- no extra
    // allowances or OT of any kind (OT, upcountry, late-out, long-distance, personal-car, comp).
    // The previous server guard only covered driver OT; the UI's blockIfCompanyTrip() already
    // blocked every submit path. Closing the API hole so a direct POST cannot land a paid claim.
    if (isCompanyTripClaimBlocked(type, body.dateFrom, body.workedDate, body.dateTo)) {
      return res.status(400).json({ success:false, code:'company-trip', message: companyTripNoClaimMessage(type) });
    }

    // SECURITY/CORRECTNESS FIX 2026-08-11 (Opus re-audit, HIGH-1): Quick Fix Check-In
    // (openQuickFixCheckIn() -- MD/Accounting directly correcting another employee's
    // ⚠️-flagged check-in) is supposed to apply immediately to the TARGET employee's own
    // attendance record. "Every current submit path already sends userId:currentUser.id" (the
    // old comment here) was false for this one path -- submitTimeCorrection() sends the target
    // employee's userId when in quick-fix mode, but this forced userId=live.id unconditionally,
    // so the fix silently landed on the APPROVER's own attendance instead, and (with no status
    // override here either) became an ordinary pending-md request sitting in the approver's own
    // queue rather than taking effect immediately. Gated strictly on live.role -- never a
    // client-supplied flag -- so only an actual MD/Accounting user can ever target someone else.
    // 2026-08-11 fix-of-a-fix, caught before deploy verification: submitTimeCorrection() ALWAYS
    // sends userId (currentUser.id for a normal self-submission, the target's id for quick-fix) --
    // gating on `body.userId !== undefined` alone would have made every MD/Accounting user's own
    // ordinary time-correction request auto-approve too, a self-approval hole exactly like the
    // ones this whole day's audits have been closing. The real signal for "this is quick-fix" is
    // that the targeted userId is someone OTHER than the submitter.
    const isQuickFixTimeCorrection = type === 'time-correction' && (['md', 'accounting'].includes(live.role) || isSuperAdminUser(live)) && body.userId !== undefined && Number(body.userId) !== live.id;
    let targetUser = live;
    if (isQuickFixTimeCorrection) {
      const foundTarget = users.find(u => u.id === Number(body.userId));
      if (!foundTarget) return res.status(400).json({ success:false, message:'Target employee not found' });
      targetUser = foundTarget;
    }
    // Every OTHER submit path already sends userId:currentUser.id — forcing it server-side
    // closes the "submit a leave as someone else" hole with zero legitimate regression.
    const userId = targetUser.id;
    const routeKey = routeKeyForLeave({ type, isDriverOT }, targetUser.role);
    const approvalRoute = approvalRouteForRequester(routeKey, targetUser.role);
    if (isFullDayPersonalLeaveClaimBlocked(type, targetUser, body.dateFrom)) {
      return res.status(400).json({ success:false, message: fullDayPersonalLeaveNoClaimMessage() });
    }
    if (isAbroadClaimBlocked(type, targetUser, body.dateFrom)) {
      return res.status(400).json({ success:false, message: abroadNoClaimMessage() });
    }
    if (type === 'late-out') {
      const lateOutErr = lateOutSubmitBlockReason(targetUser, body.dateFrom, body.lateOutTime);
      if (lateOutErr === CHECKOUT_REVIEWS_UNAVAILABLE) return res.status(503).json({ success:false, message: lateOutErr });
      if (lateOutErr) return res.status(400).json({ success:false, message: lateOutErr });
    }
    if (type === 'holiday-work') {
      const hwErr = holidayWorkSubmitBlockReason(targetUser, body.dateFrom);
      if (hwErr) return res.status(400).json({ success:false, message: hwErr });
      const hwScanErr = scanWindowError(targetUser, body.dateFrom, body.workStartTime, body.workEndTime);
      if (hwScanErr) return res.status(400).json({ success:false, message: hwScanErr });
    }
    if (type === 'abroad') {
      const abErr = abroadSubmitBlockReason(targetUser);
      if (abErr) return res.status(400).json({ success:false, message: abErr });
    }
    if (type === 'early-morning') {
      const emErr = earlyMorningSubmitBlockReason(targetUser, body.dateFrom);
      if (emErr) return res.status(400).json({ success:false, message: emErr });
      const selectedTier = Number(body.earlyMorningTier);
      if (![1, 2].includes(selectedTier)) {
        return res.status(400).json({ success:false, message:'earlyMorningTier must be 1 or 2' });
      }
      const emDay = attendanceDayForUser(targetUser, body.dateFrom);
      if (!earlyMorningTierAllowed(emDay && emDay.checkIn, selectedTier, getAppSettings())) {
        return res.status(400).json({ success:false, message:'Selected early morning tier does not match check-in time' });
      }
    }

    let status, approver = null, approvedAt = null;
    if (type === 'clear-attachments' && live.role === 'md') {
      // Matches submitClearAttachments(): MD's own request auto-approves — the actual file
      // deletion already happened via the separately role-gated /api/attachments/clear call.
      status = 'approved'; approver = live.name; approvedAt = new Date().toISOString();
    } else if (isQuickFixTimeCorrection) {
      // Matches openQuickFixCheckIn()'s own banner promise: "takes effect immediately, no
      // separate approval needed" -- the approver IS the authority here, same reasoning as the
      // two auto-approve branches above.
      status = 'approved'; approver = live.name; approvedAt = new Date().toISOString();
    } else {
      status = initialStatusForRequester(routeKey, targetUser.role);
    }

    // 2026-08-02: guard against creating a record whose money a frozen payroll snapshot for
    // this employee+period will never reflect. Instant-approve types (MD's own clear-attachments,
    // MD/Accounting quick-fix time-correction) still need the freeze check below because they
    // land as `approved` immediately. Pending types (including personal-car) skip the freeze
    // until a human actually approves them — see PUT /api/leaves/:id for that transition.
    // CORRECTNESS FIX 2026-08-13 (M-3, Opus retrospective audit): `clear-attachments` is exempt --
    // its `dateFrom` is a CUTOFF date (by construction always old, per searchOldAttachments()),
    // not a work date, and it carries no money at all (nothing in computePayroll() reads this
    // type). Without this exemption, "Clear Old Attachments" completely stops working the moment
    // ANY past pay period gets locked or MD-approved -- a total feature outage for something with
    // zero payroll relevance, made more visible (not less) by today's earlier fix requiring the
    // audit record to exist before any file gets deleted.
    if (body.dateFrom && type !== 'clear-attachments') {
      // 2026-08-10 (Opus re-audit, F1): was isPeriodLocked(periodStart) alone -- only checked
      // dateFrom's own period, missing a locked period sitting entirely between dateFrom and
      // dateTo on a multi-month request. lockedPeriodInRange() walks every period in the span.
      if (lockedPeriodInRange(body.dateFrom, body.dateTo)) {
        return res.status(400).json({ success:false, message:'This pay period is locked' });
      }
      if (accountingConfirmedInRange(body.dateFrom, body.dateTo, userId)) {
        return res.status(409).json({ success:false, message:'Accounting has already confirmed tax for this period — unconfirm before making changes' });
      }
      if (status === 'approved' && mdApprovedPeriodInRange(body.dateFrom, body.dateTo, userId)) {
        return res.status(409).json({ success:false, message:'Payroll for this period has already been approved by the Managing Director -- ask them to revoke approval first' });
      }
    }

    const S = getAppSettings();
    const leaves = readLeaves();
    // SECURITY FIX 2026-08-13 (C-2): fail closed on a transient read error instead of silently
    // treating it as "no leaves exist yet" and overwriting leaves.json with an empty array below.
    if (leaves === null) return res.status(503).json({ success:false, message:'Service temporarily unavailable' });
    // 2026-09-23: a trip's travel days cannot also carry Holiday Work (runs here, after `leaves`
    // is read -- it used to sit above the read and threw a TDZ ReferenceError on every abroad POST).
    if (type === 'abroad' && abroadTravelDayHolidayWorkConflict(leaves, userId, body.dateFrom, body.dateTo)) {
      return res.status(409).json({ success:false, message: ABROAD_TRAVEL_HW_CONFLICT_MSG });
    }
    // Duplicate personal-car on the same date (pending or approved) is rejected — payroll would
    // otherwise pay both once approved. Same date + rejected is allowed (resubmit after a deny).
    if (type === 'personal-car' && leaves.some(l =>
        l.userId === userId && l.type === 'personal-car' && l.dateFrom === body.dateFrom && !isVoidLeaveStatus(l.status))) {
      return res.status(409).json({ success:false, message:'Personal car use is already recorded for this date' });
    }
    // CORRECTNESS FIX 2026-08-16 (Opus audit C-2): nothing stopped the same workedDate from
    // being submitted repeatedly, each one independently claiming a compensatory day off --
    // only catchable if the approver happens to remember every prior approval for that
    // employee/date. Same-date duplicate guard as personal-car (pending or approved).
    if (type === 'holiday-work' && leaves.some(l =>
        l.userId === userId && l.type === 'holiday-work' && l.dateFrom === body.dateFrom && !isVoidLeaveStatus(l.status))) {
      return res.status(409).json({ success:false, message:'A holiday work request for this date already exists' });
    }
    if (type === 'holiday-work' && hasActiveOfficeOt(leaves, userId, body.dateFrom)) {
      return res.status(409).json({ success:false, message:'An OT request already exists for this date — do not stack holiday work with office OT' });
    }
    if (type === 'holiday-work' && leaves.some(l =>
        l.userId === userId && l.type === 'upcountry' && l.dateFrom === body.dateFrom && !isVoidLeaveStatus(l.status))) {
      return res.status(409).json({ success:false, message:'An upcountry request already exists for this date — use the holiday-work form instead' });
    }
    if (type === 'upcountry' && leaves.some(l =>
        l.userId === userId && l.type === 'holiday-work' && l.dateFrom === body.dateFrom && !isVoidLeaveStatus(l.status))) {
      return res.status(409).json({ success:false, message:'A holiday work request already exists for this date — upcountry is included automatically' });
    }
    if (type === 'upcountry' && body.dateFrom && isNonWorkDayForComp(body.dateFrom)) {
      return res.status(400).json({ success:false, message:'Upcountry is for weekdays only — on weekends/public holidays submit holiday work (the location counts as upcountry)' });
    }
    if (type === 'early-morning' && leaves.some(l =>
        l.userId === userId && l.type === 'early-morning' && l.dateFrom === body.dateFrom && !isVoidLeaveStatus(l.status))) {
      return res.status(409).json({ success:false, message:'An early morning request for this date already exists' });
    }
    if (type === 'ot') {
      const otDup = findOtDuplicate(leaves, {
        userId, dateFrom: body.dateFrom, isDriverOT,
        otMultiplier: body.otMultiplier, exceptId: undefined,
      });
      if (otDup) {
        return res.status(409).json({ success:false, message: isDriverOT
          ? 'A driver OT request for this date and rate already exists'
          : 'An OT request for this date already exists' });
      }
      if (isDriverOT && driverOtHoursOverCap(leaves, { userId, dateFrom: body.dateFrom, newHours: round2HalfUp(Number(body.otHours) || 0), exceptId: undefined })) {
        return res.status(400).json({ success:false, message:`Driver OT for this date cannot exceed ${OT_HOURS_MAX} hours in total` });
      }
      if (!isDriverOT) {
        if (isNonWorkDayForComp(body.dateFrom)) {
          return res.status(400).json({ success:false, message: OFFICE_OT_WEEKEND_MSG });
        }
        if (hasActiveHolidayWork(leaves, userId, body.dateFrom)) {
          return res.status(409).json({ success:false, message:'A holiday work request already exists for this date — holiday OT is paid from that request (paid mode), do not submit a separate OT' });
        }
        const derivedOfficeOt = deriveOfficeOtFromEndTime(body.dateFrom, body.otEndTime, S);
        if (!(derivedOfficeOt.otHours > 0)) {
          return res.status(400).json({ success:false, message: 'End time must be after 17:30 (an end before 05:00 counts as after midnight)' });
        }
        const otScanErr = scanWindowError(targetUser, body.dateFrom, null, body.otEndTime);
        if (otScanErr) return res.status(400).json({ success:false, message: otScanErr });
        if (derivedOfficeOt.otHours > OT_HOURS_MAX) {
          return res.status(400).json({ success:false, message:`otHours must be a non-negative number, ${OT_HOURS_MAX} or fewer` });
        }
      }
    }
    const overlap = findOverlappingLeave(leaves, userId, type, body.dateFrom, body.dateTo);
    if (overlap) {
      return res.status(409).json({ success:false, message:'Overlapping leave request already exists for this date range' });
    }
    const tenureErr = annualLeaveServiceError(targetUser, type, body.dateFrom, leaves);
    if (tenureErr) return res.status(403).json({ success:false, message: tenureErr });
    const balErr = leaveBalanceError(leaves, targetUser, type, leaveMinutesOf(body), undefined, body.dateFrom);
    if (balErr) return res.status(409).json({ success:false, message: balErr });
    // SECURITY FIX 2026-08-13 (Opus-planned leaves-whitelist, phase 1): was `...body,` -- an
    // unfiltered spread of the entire client body, so any extra key the client sent (typos, guessed
    // future fields, or deliberately crafted junk) landed verbatim in the stored record unless some
    // later override happened to catch it. Filtered here, AFTER the `body.days`/`body.distanceKm`
    // derivations above (so `allowed.days`/`allowed.distanceKm` already carry the server-derived
    // values, not whatever the client sent) and BEFORE every override below (so nothing here can
    // ever beat a server-computed value -- two independent layers, spread-then-override, same as
    // before, just filtered first).
    const allowed = filterLeaveFields(body, type);
    const leave = {
      ...allowed,
      userId, status, approvalRoute, approver, approvedAt,
      // A paid amount must come from a server-computed value, never the request body.
      // 2026-07-31: rate centralized (Settings -> Allowance Rates -> Personal Car); still
      // requires the employee's own personalCarEligible flag, so moving the rate to Settings
      // can't silently grant the allowance to someone never marked eligible.
      // 2026-07-31 fix: was `S.allowances.personalCar || 1000`, which meant an ineligible
      // employee's deliberate `: 0` refusal -- or an admin deliberately setting the rate to 0 to
      // disable the allowance -- both got silently replaced by the ฿1,000 literal (0 is falsy).
      // `!= null` only falls back to 1000 when the setting is genuinely missing/undefined.
      ...(type === 'personal-car' ? { personalCarRate: live.personalCarEligible ? (S.allowances.personalCar != null ? S.allowances.personalCar : 1000) : 0 } : {}),
      // 2026-07-31: previously trusted the client's own distanceKm > threshold calculation
      // verbatim with no server-side check -- recomputed here from the centralized threshold/
      // rate so a forged longDistanceAllowance in the request body can't pay out an arbitrary
      // amount.
      ...(type === 'long-distance' ? { longDistanceAllowance:
        (Number(body.distanceKm) || 0) > (S.allowances.longDistanceThresholdKm || 250)
          ? (S.allowances.longDistance || 0) : 0 } : {}),
      // SECURITY FIX 2026-08-09 (2nd-pass audit tightened this): regular (non-driver) OT's
      // otMultiplier/otHours were entirely client-computed and trusted verbatim --
      // computePayroll() pays `hourlyRate * otMultiplier * otHours` with no server check, so a
      // forged `otMultiplier:999` would pay 999x the hourly rate if an approver didn't catch it.
      // Both values are fully derivable from dateFrom/otEndTime, so recompute them here instead
      // of trusting the request body. Driver OT keeps its manually-chosen tier values (already
      // range-checked above by `isDriverOT`, which is now role-gated, not a bare client claim) --
      // but Number()-coerced here too: `validateLeaveFreeFields()`/the tier check above only
      // VALIDATE, they don't normalize, and computePayroll()'s `mult === 1.5` etc. is a strict
      // equality that silently drops the amount from every tier bucket (though not the total) if
      // the client sent `otMultiplier:"2"` (a string) instead of `2`.
      // 2026-08-09 (2nd-pass audit): when otEndTime is missing/malformed, `out.otHours` used to
      // stay absent from this spread, silently leaving the CLIENT's original (unbounded,
      // unvalidated-beyond-"finite-non-negative") otHours in place -- forced to 0 here instead,
      // consistent with "not derivable -> not trusted".
      ...(type === 'ot' ? (isDriverOT ? {
        isDriverOT: true,
        otMultiplier: Number(body.otMultiplier),
        // 2026-09-24 (owner): stored to 2 decimal places, half-up. Dual-sync: app.js submitDriverOT.
        otHours: round2HalfUp(Number(body.otHours) || 0),
        otHours20: 0,
        otHours30: 0,
      } : deriveOfficeOtFromEndTime(body.dateFrom, body.otEndTime, S)) : {}),
      ...(type === 'ot' && !isDriverOT ? (() => {
        const tz = webScanTimezoneForDate(targetUser.employeeNo, body.dateFrom);
        return tz ? { timezone: tz } : {};
      })() : {}),
      ...(type === 'holiday-work' ? (() => {
        const otSplit = body.compensationMode === 'paid'
          ? splitHolidayWorkOtMinutes(body.workStartTime, body.workEndTime, S)
          : { otHours20: 0, otHours30: 0 };
        return {
          days: body.compensationMode === 'annual-leave' ? 1 : 0,
          otHours20: otSplit.otHours20,
          otHours30: otSplit.otHours30,
        };
      })() : {}),
      ...(type === 'early-morning' ? { earlyMorningTier: Number(body.earlyMorningTier), days: 0 } : {}),
      // SECURITY FIX 2026-08-09 (2nd-pass audit finding 1, XSS-adjacent): mileage/distance were
      // validated (isFiniteNonNegNumber) but not normalized -- stored as whatever type the client
      // sent, so a numeric-looking string would still pass validation and then reach an innerHTML
      // render site as a string (before this fix's Number()-coercion at the render sites) or skew
      // arithmetic elsewhere. Coerced once here at the source instead.
      // 2026-08-13 (whitelist phase 1): repointed from `body.*` to `allowed.*` -- these five are
      // NOT all universal (mileageStart/mileageEnd/distanceKm are long-distance-only), so reading
      // raw `body` here would re-add exactly the three fields the filter above just stripped for
      // every other type, defeating the whitelist on its own scoped fields. `allowed.X === body.X`
      // whenever X is actually allowed for this type, so this is a no-op for legitimate traffic.
      ...(allowed.mileageStart !== undefined ? { mileageStart: Number(allowed.mileageStart) } : {}),
      ...(allowed.mileageEnd !== undefined ? { mileageEnd: Number(allowed.mileageEnd) } : {}),
      ...(allowed.distanceKm !== undefined ? { distanceKm: Number(allowed.distanceKm) } : {}),
      ...(allowed.days !== undefined ? { days: Number(allowed.days) } : {}),
      ...(allowed.fileCount !== undefined ? { fileCount: Number(allowed.fileCount) } : {}),
      // SECURITY FIX 2026-08-09 (2nd-pass audit finding 1): submittedAt was a raw client string
      // with no validation at all -- an unparseable value reached app.js's _fmtDtStr(), which used
      // to return it completely unescaped into every request-list/detail innerHTML render. Now
      // escaped at that render site too (defense in depth), but the real fix is here: never trust
      // the client's clock for this field to begin with.
      submittedAt: new Date().toISOString(),
      id: nextId(leaves), serverCreatedAt: new Date().toISOString(),
    };
    leaves.push(leave);
    saveLeaves(leaves);
    // 2026-09-24 (review M): annual leave (pending or approved) counts in the year-end pool, so a
    // request dated in a year whose carry-forward is already snapshotted rewrites that snapshot.
    if (type === 'annual' && targetUser) {
      try {
        refreshSnapshottedCarryForward(leaves, targetUser, leave.dateFrom);
      } catch (e) {
        console.error('[LEAVE] carry-forward refresh after create failed', e && e.message);
      }
    }
    // SECURITY FIX 2026-08-13 (re-audit, F-1): the raw record used to go out on this broadcast,
    // reaching the SAME unauthenticated /ws socket already fixed for user records this session
    // (toBroadcastUserProjection) -- reason/note/attachment/targetSnapshot names were streaming to
    // any logged-out listener on the LAN for every new request, live. Frontend now does a full
    // authenticated refetch on this event instead of trusting the broadcast content directly, same
    // pattern as USER_CREATED.
    broadcast({ type: 'LEAVE_CREATED', leave: toPublicLeaveProjection(leave) });
    notifyLeaveStatusChange(null, leave);
    res.json({ success:true, leave });
  } catch(e) {
    res.status(500).json({ success:false, error:e.message });
  }
}));

app.put('/api/leaves/:id', withLeavesLock((req, res) => {
  try {
    const id = parseInt(req.params.id);
    const updates = parseBody(req);
    const leaves = readLeaves();
    // SECURITY FIX 2026-08-13 (C-2): same fail-closed guard as POST /api/leaves.
    if (leaves === null) return res.status(503).json({ success:false, message:'Service temporarily unavailable' });
    const idx = leaves.findIndex(l => l.id === id);
    if (idx < 0) return res.status(404).json({ success:false, message:'Not found' });
    const leave = leaves[idx];
    const users = readUsers() || [];
    const live = users.find(u => u.id === req.user.sub);
    if (!live) return res.status(403).json({ success:false, message:'Forbidden' });

    const isOwner = leave.userId === live.id;
    const ownerUser = users.find(u => u.id === leave.userId);
    const routeKey = routeKeyForLeave(leave, ownerUser ? ownerUser.role : null);

    // The only two legitimate PUT shapes are (a) an approver's decision — exactly
    // {status, approver, approvedAt}, as sent by approveMockLeaveInternal/rejectMockLeaveInternal
    // — or (b) the owner editing their own still-pending request's content, as sent by
    // saveLeaveEdit(). Distinguishing by shape lets each path be fully re-derived/validated
    // server-side instead of trusting whatever the client sent (previously a straight
    // `{...leave, ...updates}` merge let anyone set status:'approved' directly).
    const keys = Object.keys(updates);
    const looksLikeApprovalAction = keys.length > 0 && 'status' in updates &&
      keys.every(k => ['status', 'approver', 'approvedAt'].includes(k));

    if (looksLikeApprovalAction && !isOwner) {
      const oldStatus = leave.status;
      const turnRole = STATUS_TO_ROLE[leave.status];
      if (!turnRole) return res.status(400).json({ success:false, message:'This request is not pending' });
      // 2026-08-10 (Opus audit F2): a malformed/blank leave.dateFrom silently skips this lock
      // check rather than rejecting -- deliberately NOT hardened to a 400 here (unlike the
      // owner-edit branch's equivalent check below), because this is the APPROVAL path: failing
      // closed would make a legacy record with a bad dateFrom permanently un-approvable/
      // un-rejectable by anyone, the exact "stuck queue" failure mode this project has hit and
      // fixed before elsewhere (door-access queue, 2026-08-05). New records can't have an invalid
      // dateFrom since 2026-08-09 (POST requires it), so this is legacy-only and unreachable
      // against current data (confirmed empty in leaves.json as of this fix).
      // 2026-08-10 (Opus re-audit, F1): also switched to lockedPeriodInRange() -- the old
      // dateFrom-only check missed a locked period entirely between dateFrom and dateTo on a
      // multi-month request, same gap as POST's.
      if (leave.dateFrom && isValidDateStr(leave.dateFrom) && lockedPeriodInRange(leave.dateFrom, leave.dateTo)) {
        return res.status(400).json({ success:false, message:'This pay period is locked' });
      }
      if (leave.dateFrom && isValidDateStr(leave.dateFrom) && accountingConfirmedInRange(leave.dateFrom, leave.dateTo, leave.userId)) {
        return res.status(409).json({ success:false, message:'Accounting has already confirmed tax for this period — unconfirm before making changes' });
      }
      const routeArr = Array.isArray(leave.approvalRoute) && leave.approvalRoute.length ? leave.approvalRoute : approvalRouteForRouteKey(routeKey);
      const isDelegate = live.role === 'accounting' && turnRole !== 'accounting'
        && isApprovalDelegationActiveForType(routeKey) && delegationCoversLeaveDate(leave);
      const myTurn = (turnRole === live.role && routeArr.includes(live.role)) || isDelegate
        || (isSuperAdminUser(live) && routeArr.includes(turnRole));
      if (!myTurn) return res.status(403).json({ success:false, message:'Forbidden: not your turn to approve this request' });

      let newStatus;
      if (updates.status === 'rejected') {
        newStatus = 'rejected';
      } else {
        const ri = routeArr.indexOf(turnRole);
        newStatus = (ri === -1 || ri === routeArr.length - 1) ? 'approved' : ROLE_TO_STATUS[routeArr[ri + 1]];
      }
      // 2026-08-02: block the transition to 'approved' if this employee's payroll for the
      // request's period is already MD-approved (frozen snapshot) -- otherwise the request
      // shows "approved" to the employee while the money silently never reaches their payslip.
      if (newStatus === 'approved' && isCompanyTripClaimBlocked(leave.type, leave.dateFrom, leave.workedDate, leave.dateTo)) {
        return res.status(400).json({ success:false, code:'company-trip', message: companyTripNoClaimMessage(leave.type) });
      }
      // 2026-09-23 (Opus review I-1): re-check the travel-day rule at approval time -- Holiday Work
      // may have been filed on a travel day while this trip was still pending.
      // 2026-09-24 (review M-1/M-2): the approver cannot cancel someone else's holiday work, so the
      // message says what they CAN do; `code` lets app.js show its own TH/EN/JA text.
      if (newStatus === 'approved' && leave.type === 'abroad' &&
          abroadTravelDayHolidayWorkConflict(leaves, leave.userId, leave.dateFrom, leave.dateTo)) {
        return res.status(409).json({ success:false, code:'abroad-travel-hw-conflict', message: ABROAD_TRAVEL_HW_CONFLICT_APPROVAL_MSG });
      }
      if (newStatus === 'approved' && mdApprovedPeriodInRange(leave.dateFrom, leave.dateTo, leave.userId)) {
        return res.status(409).json({ success:false, message:'Payroll for this employee/period has already been approved by the Managing Director -- ask them to revoke approval first' });
      }
      leaves[idx] = { ...leave, status: newStatus, approver: live.name, approvedAt: new Date().toISOString() };
      saveLeaves(leaves);
      // 2026-09-23 (Opus audit M-2/M-3): an approval that changes this year's annual pool after
      // year-end carry-forward was already run must rewrite next year's snapshot too -- otherwise
      // approved Dec leave still carries over, and a late-approved holiday-work day is lost.
      const touchesAnnualPool = leave.type === 'annual' || leave.type === 'abroad' ||
        (leave.type === 'holiday-work' && leave.compensationMode === 'annual-leave');
      // 2026-09-24 (review M): a pending annual request already counts at the January run
      // (annualLeaveRemainingMinutes), so rejecting it must give the days back to the snapshot.
      if (((newStatus === 'approved' && touchesAnnualPool) || (newStatus === 'rejected' && leave.type === 'annual')) && ownerUser) {
        try {
          refreshSnapshottedCarryForward(leaves, ownerUser, leave.dateFrom);
        } catch (e) {
          console.error('[LEAVE] carry-forward refresh after approval failed', e && e.message);
        }
      }
      // SECURITY FIX 2026-08-13 (re-audit, F-1): same unauthenticated-broadcast leak as
      // LEAVE_CREATED above.
      broadcastLeaveUpdated(leaves[idx]);
      notifyLeaveStatusChange(oldStatus, leaves[idx]);
      return res.json({ success:true, leave: leaves[idx] });
    }

    // Owner content-edit path — editing content always resets the request back to square one
    // (matches saveLeaveEdit()); never trust client status/approvalRoute/approver here either.
    if (!isOwner) return res.status(403).json({ success:false, message:'Forbidden: not your request' });
    if (!String(leave.status).startsWith('pending')) {
      return res.status(400).json({ success:false, message:'Only pending requests can be edited' });
    }
    // SECURITY FIX 2026-08-06 (Opus audit): same HH:MM validation as POST /api/leaves -- this
    // owner-edit path can also set hourlyStart/hourlyEnd (saveLeaveEdit()).
    if ((updates.hourlyStart !== undefined && !HHMM_RE.test(updates.hourlyStart)) ||
        (updates.hourlyEnd !== undefined && !HHMM_RE.test(updates.hourlyEnd))) {
      return res.status(400).json({ success:false, message:'hourlyStart/hourlyEnd must be in HH:MM format' });
    }
    // 2026-08-06: same locations validation as POST /api/leaves -- this owner-edit path can also
    // set/change an upcountry request's locations (saveLeaveEdit()).
    const locErr = validateUpcountryLocations(updates.locations);
    if (locErr) return res.status(400).json({ success:false, message:locErr });
    const freeFieldErr = validateLeaveFreeFields(updates);
    if (freeFieldErr) return res.status(400).json({ success:false, message:freeFieldErr });
    // SECURITY FIX 2026-08-09 (Opus audit finding 2.1): same dateFrom requirement as POST
    // /api/leaves -- a stored record whose dateFrom is blank/garbage makes getPeriodStartForDate()
    // produce a NaN period key, which silently misses every periodLocks entry. Note the
    // period-lock check a few lines above (in the approver-decision branch) does NOT cover this
    // branch -- it returns before ever reaching here; this owner-edit branch gets its own check
    // below (2026-08-10, round-3 audit item 1).
    if (updates.dateFrom !== undefined && (!updates.dateFrom || !isValidDateStr(updates.dateFrom))) {
      return res.status(400).json({ success:false, message:'dateFrom must be a valid YYYY-MM-DD date' });
    }
    if (updates.dateTo !== undefined && updates.dateTo !== '' && !isValidDateStr(updates.dateTo)) {
      return res.status(400).json({ success:false, message:'dateTo must be a valid YYYY-MM-DD date' });
    }
    const rangeErrPut = validateDateRange(
      updates.dateFrom !== undefined ? updates.dateFrom : leave.dateFrom,
      updates.dateTo !== undefined ? updates.dateTo : leave.dateTo
    );
    if (rangeErrPut) return res.status(400).json({ success:false, message:rangeErrPut });
    // SECURITY FIX 2026-08-10 (round-3 audit, item 1): this owner-edit branch had NO period-lock
    // check at all -- the handler's only isPeriodLocked() call lives in the approver-decision
    // branch above, which returns before reaching here. An owner could therefore keep rewriting a
    // pending request's dates/days/hours/amounts after Accounting had already locked the pay
    // period it belongs to -- the exact "money a frozen period will never reflect" hazard POST
    // /api/leaves guards against for new records. Both periods are checked: editing a request that
    // currently sits in a locked period, and moving a request INTO a locked period, are equally
    // wrong.
    // 2026-08-10 (Opus audit F2/F3): the first version of this check silently SKIPPED the lock
    // test whenever a date was blank/garbage (`df &&`/`isValidDateStr`), which fails OPEN on a
    // legacy record with no valid dateFrom -- fail closed instead, matching POST's own dateFrom
    // requirement. F3: only dateFrom's period was ever checked, so a multi-day request could be
    // silently EXTENDED into a locked period by pushing dateTo forward without touching dateFrom --
    // now both resolved dates are required and checked.
    const resolvedDateFromForLock = updates.dateFrom !== undefined ? updates.dateFrom : leave.dateFrom;
    if (!resolvedDateFromForLock || !isValidDateStr(resolvedDateFromForLock)) {
      return res.status(400).json({ success:false, message:'dateFrom must be a valid YYYY-MM-DD date' });
    }
    const resolvedDateToForLock = updates.dateTo !== undefined ? updates.dateTo : leave.dateTo;
    // 2026-08-10 (Opus re-audit, finding 3 + F1): checking individual endpoint dates missed two
    // things -- the OLD dateTo (a record could have its dateTo pulled BACK out of an already-locked
    // period via a plain PUT, silently removing leave days from a locked period), and any period
    // sitting entirely BETWEEN dateFrom and dateTo on a multi-month request. Check both the OLD
    // range and the RESOLVED (about-to-be-saved) range with the same range-walking helper POST uses.
    if (lockedPeriodInRange(leave.dateFrom, leave.dateTo) ||
        lockedPeriodInRange(resolvedDateFromForLock, resolvedDateToForLock)) {
      return res.status(400).json({ success:false, message:'This pay period is locked' });
    }
    if (accountingConfirmedInRange(resolvedDateFromForLock, resolvedDateToForLock, leave.userId)) {
      return res.status(409).json({ success:false, message:'Accounting has already confirmed tax for this period — unconfirm before making changes' });
    }
    // SECURITY FIX 2026-08-09 (2nd-pass audit, same gap as POST /api/leaves): isDriverOT here was
    // also a bare client-supplied boolean with no role check -- since this whole branch already
    // requires isOwner (checked above), `live` IS the request's owner, so `live.role` is exactly
    // the right thing to gate on, same as the POST handler.
    // SECURITY FIX 2026-08-10 (round-3 audit, item 4): `newType` below falls back to the OLD type
    // on any falsy value, but `safeUpdates` never filtered `type`, so an explicit `type:''` was
    // validated/routed as the old type and then STORED as '' -- a typeless record every type-gated
    // code path keeps treating as its old type until re-read. POST rejects this outright ('type
    // required', see the `type` check near the top of app.post('/api/leaves')); mirror it here
    // rather than silently papering over it. `!== undefined` matters: the driver-OT edit path
    // (submitDriverOT()'s edit branch, app.js, which calls saveLeaveEdit(id, 'driver-ot', {...}))
    // sends no `type` key at all and must keep working.
    if (updates.type !== undefined && (typeof updates.type !== 'string' || !VALID_LEAVE_TYPES.has(updates.type))) {
      return res.status(400).json({ success:false, message:'unknown request type' });
    }
    if (updates.type === 'comp') return res.status(400).json({ success:false, message:'comp request type is no longer accepted; use holiday-work instead' });
    const newType = (updates.type || leave.type);
    if (newType === 'comp') return res.status(400).json({ success:false, message:'comp request type is no longer accepted; use holiday-work instead' });
    const resolvedWorkedDateForTrip = updates.workedDate !== undefined ? updates.workedDate : leave.workedDate;
    if (isCompanyTripClaimBlocked(newType, resolvedDateFromForLock, resolvedWorkedDateForTrip, resolvedDateToForLock)) {
      return res.status(400).json({ success:false, code:'company-trip', message: companyTripNoClaimMessage(newType) });
    }
    if (isFullDayPersonalLeaveClaimBlocked(newType, ownerUser || live, resolvedDateFromForLock)) {
      return res.status(400).json({ success:false, message: fullDayPersonalLeaveNoClaimMessage() });
    }
    if (isAbroadClaimBlocked(newType, ownerUser || live, resolvedDateFromForLock)) {
      return res.status(400).json({ success:false, message: abroadNoClaimMessage() });
    }
    if (newType === 'holiday-work') {
      const hwErrPut = holidayWorkSubmitBlockReason(ownerUser || live, resolvedDateFromForLock);
      if (hwErrPut) return res.status(400).json({ success:false, message: hwErrPut });
      const hwScanErrPut = scanWindowError(ownerUser || live, resolvedDateFromForLock,
        updates.workStartTime !== undefined ? updates.workStartTime : leave.workStartTime,
        updates.workEndTime !== undefined ? updates.workEndTime : leave.workEndTime);
      if (hwScanErrPut) return res.status(400).json({ success:false, message: hwScanErrPut });
    }
    if (newType === 'abroad') {
      const abErrPut = abroadSubmitBlockReason(ownerUser || live);
      if (abErrPut) return res.status(400).json({ success:false, message: abErrPut });
      if (abroadTravelDayHolidayWorkConflict(leaves, leave.userId, resolvedDateFromForLock, resolvedDateToForLock)) {
        return res.status(409).json({ success:false, message: ABROAD_TRAVEL_HW_CONFLICT_MSG });
      }
    }
    if (newType === 'late-out') {
      // Validate the RESOLVED tier (what the record will end up with), not just this request's.
      const lateOutErr = lateOutSubmitBlockReason(live, resolvedDateFromForLock,
        updates.lateOutTime !== undefined ? updates.lateOutTime : leave.lateOutTime);
      if (lateOutErr === CHECKOUT_REVIEWS_UNAVAILABLE) return res.status(503).json({ success:false, message: lateOutErr });
      if (lateOutErr) return res.status(400).json({ success:false, message: lateOutErr });
    }
    const requestedIsDriverOT = updates.isDriverOT !== undefined ? updates.isDriverOT : leave.isDriverOT;
    const editIsDriverOT = newType === 'ot' && live.role === 'driver' && !!requestedIsDriverOT;
    // SECURITY FIX 2026-08-09: same driver-OT-tier range check as POST /api/leaves -- this
    // owner-edit path can also set otMultiplier (saveLeaveEdit()).
    // 2026-08-10 (round-9 re-audit): was gated on `updates.otMultiplier !== undefined`, so an
    // owner who edits a leave's `type` (e.g. an 'annual' record with no otMultiplier at all) into
    // `type:'ot', isDriverOT:true` WITHOUT also sending otMultiplier skipped this check entirely --
    // the assignment below then falls back to `leave.otMultiplier`, which is `undefined` for a
    // record that was never OT to begin with, producing the exact null-otMultiplier state the
    // POST-side fix exists to prevent. Also closes a worse variant: POST allows any 0-3 value for
    // *non*-OT types (otMultiplier isn't tier-restricted outside 'ot'), so `type:'annual',
    // otMultiplier:2.5` was a legal POST -- converting that record to driver-OT via this same PUT
    // used to inherit the untiered 2.5 unchanged. Validate the RESOLVED value (what the record will
    // actually end up with), not just whether this specific request happened to touch the field.
    if (editIsDriverOT) {
      const resolvedOtMultiplier = updates.otMultiplier !== undefined ? updates.otMultiplier : leave.otMultiplier;
      if (![1.5, 2, 3].includes(Number(resolvedOtMultiplier))) {
        return res.status(400).json({ success:false, message:'otMultiplier must be 1.5, 2, or 3 for driver OT' });
      }
    }
    // SECURITY FIX 2026-08-10 (round-9 re-audit): same "actually required, not just validated-if-
    // present" gap as the POST handler for time-correction's correctedTime/correctionField --
    // mirrored here against the RESOLVED value (this update's value if it touches the field,
    // otherwise the existing stored value), same pattern as the driver-OT check just above.
    if (newType === 'time-correction') {
      const resolvedCorrectedTime = updates.correctedTime !== undefined ? updates.correctedTime : leave.correctedTime;
      const resolvedCorrectionField = updates.correctionField !== undefined ? updates.correctionField : leave.correctionField;
      if (!resolvedCorrectedTime || !HHMM_RE.test(resolvedCorrectedTime)) {
        return res.status(400).json({ success:false, message:'correctedTime is required and must be in HH:MM format for time-correction requests' });
      }
      if (!['checkIn', 'checkOut'].includes(resolvedCorrectionField)) {
        return res.status(400).json({ success:false, message:'correctionField must be checkIn or checkOut for time-correction requests' });
      }
    }
    // SECURITY FIX 2026-08-10 (round-11 re-audit): same class of gap as the two checks just above
    // -- POST requires `locations` for type:'upcountry' (2026-08-09 fix), but PUT only ever ran
    // `validateUpcountryLocations(updates.locations)`, which returns null (valid) for `undefined`.
    // An owner could PUT an existing non-upcountry record (e.g. 'annual', which never has
    // `locations`) into `type:'upcountry'` without sending `locations` at all -- stored record
    // has type:'upcountry' with no locations array, exactly the state the POST fix exists to
    // prevent. `upcountryLocationsOf()` (app.js) falls back to treating the OLD `reason` text as
    // the destination, and the request routes/pays out as a real upcountry request regardless.
    // Validate the RESOLVED value, same pattern as the two checks above.
    if (newType === 'upcountry') {
      const resolvedLocations = updates.locations !== undefined ? updates.locations : leave.locations;
      if (resolvedLocations === undefined) {
        return res.status(400).json({ success:false, message:'locations required for upcountry requests' });
      }
      const upcountryLocErr = validateUpcountryLocations(resolvedLocations);
      if (upcountryLocErr) return res.status(400).json({ success:false, message:upcountryLocErr });
      if (isNonWorkDayForComp(resolvedDateFromForLock)) {
        return res.status(400).json({ success:false, message:'Upcountry is for weekdays only — on weekends/public holidays submit holiday work (the location counts as upcountry)' });
      }
      if (hasActiveHolidayWork(leaves, leave.userId, resolvedDateFromForLock, leave.id)) {
        return res.status(409).json({ success:false, message:'A holiday work request already exists for this date — upcountry is included automatically' });
      }
    }
    // CORRECTNESS FIX 2026-08-16 (Opus re-audit of C-3): the POST-side "workedDate required and
    // must be a non-work day" check has no PUT-side twin -- saveLeaveEdit() never sends `type` at
    // all (the driver-OT edit branch depends on that), so a check gated on `updates.type ===
    // 'comp'` is always false here and silently skips every edit. Validate against the RESOLVED
    // type/workedDate instead, same pattern as the driver-OT/time-correction/upcountry checks
    // above: an owner editing an existing pending comp request's workedDate to an ordinary weekday
    // (or converting another pending type into 'comp' without ever setting a valid workedDate)
    // must be re-checked here, not just at original submission.
    if (newType === 'holiday-work') {
      const resolvedCompMode = updates.compensationMode !== undefined ? updates.compensationMode : leave.compensationMode;
      const resolvedWorkStart = updates.workStartTime !== undefined ? updates.workStartTime : leave.workStartTime;
      const resolvedWorkEnd = updates.workEndTime !== undefined ? updates.workEndTime : leave.workEndTime;
      const resolvedLocations = updates.locations !== undefined ? updates.locations : leave.locations;
      const resolvedAttachment = updates.attachment !== undefined ? updates.attachment : leave.attachment;
      const resolvedFileCount = updates.fileCount !== undefined ? updates.fileCount : leave.fileCount;
      if (!['annual-leave', 'paid'].includes(resolvedCompMode)) {
        return res.status(400).json({ success:false, message:'compensationMode must be annual-leave or paid for holiday-work requests' });
      }
      if (!resolvedWorkStart || !HHMM_RE.test(resolvedWorkStart) ||
          !resolvedWorkEnd || !HHMM_RE.test(resolvedWorkEnd)) {
        return res.status(400).json({ success:false, message:'workStartTime and workEndTime are required and must be in HH:MM format for holiday-work requests' });
      }
      if (!Number.isFinite(holidayWorkEndMins(resolvedWorkStart, resolvedWorkEnd))) {
        return res.status(400).json({ success:false, message:'workEndTime must be after workStartTime (an end before 05:00 counts as after midnight)' });
      }
      if (holidayWorkTooLong(resolvedWorkStart, resolvedWorkEnd)) {
        return res.status(400).json({ success:false, code:'hw-too-long', message:'Holiday Work cannot be longer than 20 hours' });
      }
      const hwLocErrPut = validateHolidayWorkLocation(resolvedLocations);
      if (hwLocErrPut) return res.status(400).json({ success:false, message:hwLocErrPut });
      if (!resolvedAttachment && !(Number(resolvedFileCount) > 0)) {
        return res.status(400).json({ success:false, message:'Working Report attachment is required for holiday-work requests' });
      }
    }
    if (newType === 'early-morning') {
      const emErrPut = earlyMorningSubmitBlockReason(ownerUser || live, resolvedDateFromForLock);
      if (emErrPut) return res.status(400).json({ success:false, message: emErrPut });
    }
    const oldStatus = leave.status;
    // SECURITY FIX 2026-08-13 (Opus-planned leaves-whitelist, phase 1): was `{ ...updates }` plus a
    // blocklist of 7 known-dangerous keys -- filterLeaveFields() subsumes all of them (none of
    // id/userId/serverCreatedAt/status/approvalRoute/approver/approvedAt/submittedAt is in
    // UNIVERSAL_LEAVE_FIELDS or TYPE_SCOPED_LEAVE_FIELDS) AND closes every OTHER unlisted key the
    // blocklist never covered. Filtered against `newType` (not `leave.type`) so a legitimate type
    // conversion (e.g. annual -> ot) keeps its new type's own fields (otEndTime/otHours/...).
    // 2026-08-09 (2nd-pass audit finding 1): editing a request's content shouldn't let the owner
    // also rewrite when it was originally submitted -- same "never trust the client" reasoning as
    // the POST handler's own submittedAt override (now covered by the filter above, not a delete).
    const safeUpdates = filterLeaveFields(updates, newType);
    // CORRECTNESS FIX 2026-08-13 (re-audit, F-6): a PUT carrying only never-trusted fields (e.g.
    // `{}` or `{status:'approved'}`, both fully stripped by the deletes above) still fell through to
    // the unconditional status/approvalRoute/approver/approvedAt reset a few lines below -- a no-op
    // "edit" from the owner silently rewinds a multi-stage request (e.g. sitting at pending-md on a
    // manager->md route) back to pending, ERASING which stage already approved it, and re-fires a
    // fresh approval-request notification at the earlier stage. Reject before any reset happens.
    if (Object.keys(safeUpdates).length === 0) {
      return res.status(400).json({ success:false, message:'No changes to save' });
    }
    const newRouteKey = routeKeyForLeave({ type: newType, isDriverOT: editIsDriverOT }, ownerUser ? ownerUser.role : null);
    // 2026-07-31: recompute (not trust) longDistanceAllowance/personalCarRate on edit too --
    // this owner-edit path previously passed the client's own value straight through for both,
    // same gap as POST /api/leaves (which was fixed for both there, but personal-car was missed
    // here -- an owner could edit their own pending personal-car request with a forged rate,
    // and since it goes back to pending-md, a real approval would still pay the forged amount).
    if (newType === 'long-distance') {
      // SECURITY FIX 2026-08-13 (re-audit, F-3): same derive-don't-trust fix as POST /api/leaves --
      // distanceKm is fully derivable from mileageStart/mileageEnd (the only real submit path always
      // sends both), so recompute it from the RESOLVED mileage values rather than trusting whatever
      // the client sent (or letting a stale leave.distanceKm survive a mileage edit unchanged).
      const S = getAppSettings();
      const ms = Number(safeUpdates.mileageStart !== undefined ? safeUpdates.mileageStart : leave.mileageStart);
      const me = Number(safeUpdates.mileageEnd !== undefined ? safeUpdates.mileageEnd : leave.mileageEnd);
      if (!Number.isFinite(ms) || !Number.isFinite(me) || me <= ms) {
        return res.status(400).json({ success:false, message:'mileageStart/mileageEnd are required for long-distance requests, and mileageEnd must be greater than mileageStart' });
      }
      safeUpdates.distanceKm = me - ms;
      safeUpdates.longDistanceAllowance = safeUpdates.distanceKm > (S.allowances.longDistanceThresholdKm || 250) ? (S.allowances.longDistance || 0) : 0;
    }
    // 2026-08-09 (2nd-pass audit finding 1, same coercion as POST): normalize mileage/distance to
    // real numbers at the source instead of trusting the client's type.
    if (safeUpdates.mileageStart !== undefined) safeUpdates.mileageStart = Number(safeUpdates.mileageStart);
    if (safeUpdates.mileageEnd !== undefined) safeUpdates.mileageEnd = Number(safeUpdates.mileageEnd);
    if (safeUpdates.distanceKm !== undefined) safeUpdates.distanceKm = Number(safeUpdates.distanceKm);
    // SECURITY FIX 2026-08-13 (leaves audit, F-5): same derive-don't-trust fix as POST /api/leaves
    // -- annual/sick/business's day-mode `days` is fully derivable from the RESOLVED dateFrom/
    // dateTo, so recompute it here rather than trusting whatever the client sent (or letting a
    // stale leave.days survive a date edit unchanged). Resolved hourlyStart/hourlyEnd (not just
    // whether THIS update touched them) decide day-mode vs hourly-mode, same resolved-value
    // pattern used throughout this handler. Every other type keeps the old plain coercion.
    // SECURITY FIX 2026-08-13 (M-1, Opus retrospective audit): the resolved-value fallback above
    // (fall back to leave.hourlyStart when this update doesn't carry the key) is right for fields
    // a PUT genuinely only patches -- but submitLeave() (app.js) always sends a COMPLETE
    // re-description of the form for annual/sick/business on every save, never a partial patch:
    // day-mode always sends a real `days` and NEVER sends hourlyStart/hourlyEnd at all; hourly-mode
    // always sends hourlyStart/hourlyEnd and `days:0`. So "this update carries `days` but no
    // hourly keys" reliably means the user saved in DAY mode, even when the record was PREVIOUSLY
    // hourly-mode -- the old fallback kept resolving to the stale leave.hourlyStart in exactly that
    // case (switching modes via the ordinary Edit button + Days/Hours toggle, no devtools needed),
    // which skipped derivation entirely and let a client-supplied `days` through again.
    const isExplicitDayModeSave = safeUpdates.days !== undefined && safeUpdates.hourlyStart === undefined && safeUpdates.hourlyEnd === undefined;
    const resolvedHourlyStart = isExplicitDayModeSave ? undefined : (safeUpdates.hourlyStart !== undefined ? safeUpdates.hourlyStart : leave.hourlyStart);
    const resolvedHourlyEnd = isExplicitDayModeSave ? undefined : (safeUpdates.hourlyEnd !== undefined ? safeUpdates.hourlyEnd : leave.hourlyEnd);
    if (DAY_BASED_LEAVE_TYPES.has(newType) && !resolvedHourlyStart && !resolvedHourlyEnd) {
      safeUpdates.days = deriveLeaveDaysCount(resolvedDateFromForLock, resolvedDateToForLock);
      // An explicit day-mode save must also clear any hourlyStart/hourlyEnd inherited from a
      // prior hourly-mode version of this same record -- both fields are in annual/sick/
      // business's own TYPE_SCOPED_LEAVE_FIELDS entry, so the phase-2 whitelist prune keeps them
      // otherwise (they're legitimately allowed for this type, just stale for THIS save). Setting
      // to `undefined` (not deleting the key) makes `{...leave, ...safeUpdates}` override leave's
      // value, and JSON.stringify() drops undefined-valued keys entirely on write.
      if (isExplicitDayModeSave) { safeUpdates.hourlyStart = undefined; safeUpdates.hourlyEnd = undefined; }
    } else if (DAY_BASED_LEAVE_TYPES.has(newType)) {
      const hourlyErrPut = hourlyLeaveShapeError(resolvedHourlyStart, resolvedHourlyEnd, resolvedDateFromForLock, resolvedDateToForLock);
      if (hourlyErrPut) return res.status(400).json({ success:false, message:hourlyErrPut });
      // SECURITY/CORRECTNESS FIX 2026-08-13 (M-1, Opus retrospective audit): mirrors the same
      // POST-side fix -- resolved hourly-mode for a day-based type must force days:0 rather than
      // trust whatever the client sent, since leaveDayCoverage() checks `(l.days||0) > 0` BEFORE
      // ever looking at hourlyStart/hourlyEnd.
      safeUpdates.days = 0;
    } else if (newType === 'abroad') {
      // Resolved-value validation: an edit that only moves dateTo must still be checked against
      // the location/reason the record will actually END UP with, not just the keys this request
      // carried. Same rule as every other type in this handler.
      const resolvedLocation = safeUpdates.location !== undefined ? safeUpdates.location : leave.location;
      const resolvedReason = safeUpdates.reason !== undefined ? safeUpdates.reason : leave.reason;
      const abroadErrPut = validateAbroadRecord({
        dateFrom: resolvedDateFromForLock,
        dateTo: resolvedDateToForLock,
        location: resolvedLocation,
        reason: resolvedReason,
      });
      if (abroadErrPut) return res.status(400).json({ success:false, message:abroadErrPut });
      safeUpdates.days = abroadSpanDays(resolvedDateFromForLock, resolvedDateToForLock);
    } else if (newType === 'holiday-work') {
      const resolvedCompModeDays = safeUpdates.compensationMode !== undefined ? safeUpdates.compensationMode : leave.compensationMode;
      safeUpdates.days = resolvedCompModeDays === 'annual-leave' ? 1 : 0;
      const resolvedWs = safeUpdates.workStartTime !== undefined ? safeUpdates.workStartTime : leave.workStartTime;
      const resolvedWe = safeUpdates.workEndTime !== undefined ? safeUpdates.workEndTime : leave.workEndTime;
      if (resolvedCompModeDays === 'paid') {
        const otSplit = splitHolidayWorkOtMinutes(resolvedWs, resolvedWe, getAppSettings());
        safeUpdates.otHours20 = otSplit.otHours20;
        safeUpdates.otHours30 = otSplit.otHours30;
      } else {
        safeUpdates.otHours20 = 0;
        safeUpdates.otHours30 = 0;
      }
      const dupHolidayWork = leaves.some(l =>
        l.id !== leave.id && l.userId === leave.userId && l.type === 'holiday-work' &&
        l.dateFrom === resolvedDateFromForLock && !isVoidLeaveStatus(l.status));
      if (dupHolidayWork) {
        return res.status(409).json({ success:false, message:'A holiday work request for this date already exists' });
      }
    } else if (newType === 'early-morning') {
      safeUpdates.days = 0;
      const emDayPut = attendanceDayForUser(ownerUser || live, resolvedDateFromForLock);
      const resolvedTier = updates.earlyMorningTier !== undefined ? Number(updates.earlyMorningTier) : Number(leave.earlyMorningTier);
      if (![1, 2].includes(resolvedTier)) {
        return res.status(400).json({ success:false, message:'earlyMorningTier must be 1 or 2' });
      }
      if (!earlyMorningTierAllowed(emDayPut && emDayPut.checkIn, resolvedTier, getAppSettings())) {
        return res.status(400).json({ success:false, message:'Selected early morning tier does not match check-in time' });
      }
      safeUpdates.earlyMorningTier = resolvedTier;
      const dupEarlyMorning = leaves.some(l =>
        l.id !== leave.id && l.userId === leave.userId && l.type === 'early-morning' &&
        l.dateFrom === resolvedDateFromForLock && !isVoidLeaveStatus(l.status));
      if (dupEarlyMorning) {
        return res.status(409).json({ success:false, message:'An early morning request for this date already exists' });
      }
    } else if (safeUpdates.days !== undefined) {
      safeUpdates.days = Number(safeUpdates.days);
    }
    if (safeUpdates.fileCount !== undefined) safeUpdates.fileCount = Number(safeUpdates.fileCount);
    if (newType === 'personal-car') {
      // CORRECTNESS FIX 2026-08-13 (LOW-4, Opus retrospective audit): the same-day-duplicate guard
      // POST /api/leaves has (409 on a second personal-car record for the same date) was never
      // mirrored here -- an owner could PUT a pending record's type into 'personal-car' for a date
      // already recorded, landing a second zero-review payout for that day. Reuses
      // resolvedDateFromForLock (already computed above) -- the RESOLVED dateFrom, not just
      // whether this specific request touched the field.
      const dupPersonalCar = leaves.some(l =>
        l.id !== leave.id && l.userId === leave.userId && l.type === 'personal-car' &&
        l.dateFrom === resolvedDateFromForLock && !isVoidLeaveStatus(l.status));
      if (dupPersonalCar) {
        return res.status(409).json({ success:false, message:'Personal car use is already recorded for this date' });
      }
      const S = getAppSettings();
      safeUpdates.personalCarRate = live.personalCarEligible ? (S.allowances.personalCar != null ? S.allowances.personalCar : 1000) : 0;
    }
    // SECURITY FIX 2026-08-09: same recompute as POST /api/leaves -- an owner editing their own
    // pending regular-OT request could otherwise forge otMultiplier/otHours the same way.
    if (newType === 'ot') {
      safeUpdates.isDriverOT = editIsDriverOT;
    }
    if (newType === 'ot' && editIsDriverOT) {
      safeUpdates.otMultiplier = Number(updates.otMultiplier !== undefined ? updates.otMultiplier : leave.otMultiplier);
      // 2026-08-10 (round-3 audit, item 2): was gated on `safeUpdates.otHours !== undefined`, so
      // converting a non-OT record into type:'ot', isDriverOT:true WITHOUT sending otHours left the
      // old record's otHours in place, untouched and uncoerced. Resolve-then-coerce exactly like
      // otMultiplier above -- what the record will actually end up with, not just what this request
      // happened to send. `|| 0` matches POST's own driver-OT branch.
      // 2026-09-24 (owner): 2 decimal places, half-up (same as POST).
      safeUpdates.otHours = round2HalfUp(Number(updates.otHours !== undefined ? updates.otHours : leave.otHours) || 0);
      safeUpdates.otHours20 = 0;
      safeUpdates.otHours30 = 0;
      // 2026-08-10 (Opus audit F4, tightened by re-audit finding 4): the coercion above normalizes
      // TYPE but never re-checked the resolved value's actual bounds -- `Number(x) || 0` turns NaN
      // into 0 but PRESERVES a negative number, so a stored otHours:-8 would pass a `> OT_HOURS_MAX`
      // check unchanged despite the error message's own "non-negative" claim. Use the same
      // isFiniteNonNegNumber() helper validateLeaveFreeFields() already uses for this exact field.
      // Only reachable via stored legacy data predating the 2026-08-09 cap (none in current data),
      // but the resolved-value pattern should bound the same way every other resolved field does.
      if (!isFiniteNonNegNumber(safeUpdates.otHours) || safeUpdates.otHours > OT_HOURS_MAX) {
        return res.status(400).json({ success:false, message:`otHours must be a non-negative number, ${OT_HOURS_MAX} or fewer` });
      }
    } else if (newType === 'ot' && !editIsDriverOT) {
      const dateFrom = safeUpdates.dateFrom || leave.dateFrom;
      if (isNonWorkDayForComp(dateFrom)) {
        return res.status(400).json({ success:false, message: OFFICE_OT_WEEKEND_MSG });
      }
      const otEndTime = safeUpdates.otEndTime !== undefined ? safeUpdates.otEndTime : leave.otEndTime;
      const derivedOfficeOt = deriveOfficeOtFromEndTime(dateFrom, otEndTime, getAppSettings());
      Object.assign(safeUpdates, derivedOfficeOt);
      if (!(derivedOfficeOt.otHours > 0)) {
        return res.status(400).json({ success:false, message: 'End time must be after 17:30 (an end before 05:00 counts as after midnight)' });
      }
      const otScanErrPut = scanWindowError(ownerUser || live, dateFrom, null, otEndTime);
      if (otScanErrPut) return res.status(400).json({ success:false, message: otScanErrPut });
      if (derivedOfficeOt.otHours > OT_HOURS_MAX) {
        return res.status(400).json({ success:false, message:`otHours must be a non-negative number, ${OT_HOURS_MAX} or fewer` });
      }
    }
    if (newType === 'ot') {
      const otDup = findOtDuplicate(leaves, {
        userId: leave.userId,
        dateFrom: resolvedDateFromForLock,
        isDriverOT: editIsDriverOT,
        otMultiplier: editIsDriverOT ? safeUpdates.otMultiplier : undefined,
        exceptId: leave.id,
      });
      if (otDup) {
        return res.status(409).json({ success:false, message: editIsDriverOT
          ? 'A driver OT request for this date and rate already exists'
          : 'An OT request for this date already exists' });
      }
      if (editIsDriverOT && driverOtHoursOverCap(leaves, {
        userId: leave.userId, dateFrom: resolvedDateFromForLock,
        newHours: safeUpdates.otHours, exceptId: leave.id,
      })) {
        return res.status(400).json({ success:false, message:`Driver OT for this date cannot exceed ${OT_HOURS_MAX} hours in total` });
      }
      if (!editIsDriverOT && hasActiveHolidayWork(leaves, leave.userId, resolvedDateFromForLock, leave.id)) {
        return res.status(409).json({ success:false, message:'A holiday work request already exists for this date — holiday OT is paid from that request (paid mode), do not submit a separate OT' });
      }
    }
    if (newType === 'holiday-work' && hasActiveOfficeOt(leaves, leave.userId, resolvedDateFromForLock, leave.id)) {
      return res.status(409).json({ success:false, message:'An OT request already exists for this date — do not stack holiday work with office OT' });
    }
    if (newType === 'holiday-work' && leaves.some(l =>
        l.id !== leave.id && l.userId === leave.userId && l.type === 'upcountry' &&
        l.dateFrom === resolvedDateFromForLock && !isVoidLeaveStatus(l.status))) {
      return res.status(409).json({ success:false, message:'An upcountry request already exists for this date — use the holiday-work form instead' });
    }
    // 2026-08-10 (round-3 audit, item 3): on a confirmed type change the `{...leave, ...safeUpdates}`
    // merge used to keep the OLD type's fields sitting on the record forever (e.g. an 'annual'
    // record edited into 'ot' kept hourlyStart/hourlyEnd). No money/permission path reads them --
    // every consumer is type-gated (leaveDayCoverage()'s annual/sick/business gate, computePayroll()'s
    // `l.type === 'x'` branches) -- so this is data hygiene, closing the gap before some future
    // un-gated reader turns it into a real bug. Conservative by construction: only the OLD type's
    // own scoped fields are eligible, never a field the new type claims, and never a field THIS
    // request explicitly wrote (the recompute blocks above already populated safeUpdates for the
    // new type by this point).
    const merged = { ...leave, ...safeUpdates };
    if (newType === 'ot' && !editIsDriverOT) {
      const owner = ownerUser || live;
      const tz = webScanTimezoneForDate(owner && owner.employeeNo, resolvedDateFromForLock);
      if (tz) merged.timezone = tz;
      else delete merged.timezone;
    } else {
      delete merged.timezone;
    }
    const overlapPut = findOverlappingLeave(leaves, leave.userId, newType, resolvedDateFromForLock, resolvedDateToForLock, leave.id);
    if (overlapPut) {
      return res.status(409).json({ success:false, message:'Overlapping leave request already exists for this date range' });
    }
    const tenureErrPut = annualLeaveServiceError(ownerUser || live, newType, resolvedDateFromForLock, leaves, leave.id);
    if (tenureErrPut) return res.status(403).json({ success:false, message: tenureErrPut });
    const balErrPut = leaveBalanceError(leaves, ownerUser || live, newType, leaveMinutesOf(merged), leave.id, resolvedDateFromForLock);
    if (balErrPut) return res.status(409).json({ success:false, message: balErrPut });
    // SECURITY FIX 2026-08-13 (Opus-planned leaves-whitelist, phase 2): phase 1's filterLeaveFields()
    // only cleans the INCOMING `updates` -- it can't touch a field the record already carries from
    // `...leave` (e.g. a stale field left over from a type conversion made before phase 1 existed,
    // or any other key nobody's audit round happened to enumerate for its current type). This prunes
    // the RESOLVED record the same way phase 1 prunes an incoming request: keep only
    // UNIVERSAL_LEAVE_FIELDS ∪ TYPE_SCOPED_LEAVE_FIELDS[newType] ∪ SERVER_LEAVE_FIELDS, drop
    // everything else. Runs on every owner edit, not just ones that change `type` -- closes the
    // class structurally instead of only at the moment of conversion, and supersedes the old
    // type-conversion-only cleanup loop that used to sit here (that loop only ever handled the OLD
    // type's own scoped fields, and only on a request that changed `type`; this is a strict
    // superset -- any leftover key, on every edit, regardless of whether this request touches type).
    const keepFieldSet = new Set([...UNIVERSAL_LEAVE_FIELDS, ...(TYPE_SCOPED_LEAVE_FIELDS[newType] || []), ...SERVER_LEAVE_FIELDS]);
    for (const k of Object.keys(merged)) {
      if (!keepFieldSet.has(k)) delete merged[k];
    }
    leaves[idx] = {
      ...merged,
      status: initialStatusForRequester(newRouteKey, ownerUser ? ownerUser.role : null),
      approvalRoute: approvalRouteForRequester(newRouteKey, ownerUser ? ownerUser.role : null),
      approver: null, approvedAt: null,
    };
    saveLeaves(leaves);
    // 2026-09-24 (review M): pending annual leave counts in the year-end pool, so an edit of a
    // pending annual request (hours, dates, type) rewrites the snapshot of the year(s) it touches.
    if ((leave.type === 'annual' || newType === 'annual') && (ownerUser || live)) {
      const years = new Set([leave.dateFrom, leaves[idx].dateFrom].filter(isValidDateStr).map(d => d.slice(0, 4)));
      years.forEach(y => {
        try {
          refreshSnapshottedCarryForward(leaves, ownerUser || live, `${y}-01-01`);
        } catch (e) {
          console.error('[LEAVE] carry-forward refresh after edit failed', e && e.message);
        }
      });
    }
    // SECURITY FIX 2026-08-13 (re-audit, F-1): same unauthenticated-broadcast leak as the other
    // 2 leave broadcasts.
    broadcastLeaveUpdated(leaves[idx]);
    notifyLeaveStatusChange(oldStatus, leaves[idx]);
    res.json({ success:true, leave: leaves[idx] });
  } catch(e) {
    res.status(500).json({ success:false, error:e.message });
  }
}));

// Dual-sync with app.js: isCancellableApprovedLeave
function isCancellableApprovedLeave(leave, asOfYmd) {
  if (!leave || leave.status !== 'approved') return false;
  // 2026-09-24 (owner): the owner may cancel an APPROVED Holiday Work (either mode) to re-file it
  // with the other mode. Holiday Work is always a past date, so there is no date rule: DELETE's
  // guards decide -- MD-approved payroll ("closing"), locked, Accounting-confirmed -- plus
  // earnedDayUsedError for the annual-leave mode.
  if (leave.type === 'holiday-work') return isValidDateStr(leave.dateFrom);
  // 2026-09-21: 'abroad' joins the owner-cancellable set. A trip that gets called off must be
  // removable -- unlike a one-day claim it spans many days, pays per day and hides absences, so
  // leaving it permanent was the worst case of the approved-record lock. Same before-start-date
  // rule as leave; the MD-approved-payroll guard and audit log below already cover it.
  if (!['annual', 'sick', 'business', 'abroad'].includes(leave.type)) return false;
  if (!leave.dateFrom || !isValidDateStr(leave.dateFrom)) return false;
  const asOf = asOfYmd || bangkokDateStr();
  return asOf < leave.dateFrom;
}

// Dual-sync with app.js computeLateDeductMinutes (annual-leave balance deduction, NOT the payslip
// display one inside computePayslipExtras). Same exemptions: weekends, public holidays, company
// trips, approved annual/sick/business leave days, drivers; approved checkIn time-corrections win.
function annualLateDeductMinutes(user, year, leaves) {
  const policy = getAppSettings().lateDeductPolicy;
  if (!policy || !policy.enabled || !policy.effectiveFromPeriod) return 0;
  if (!user || user.role === 'driver') return 0;
  const eff = String(policy.effectiveFromPeriod);
  const effDateStr = `${eff.slice(0,4)}-${eff.slice(4,6)}-${eff.slice(6,8)}`;
  const yearStr = String(year);
  const ws = getAppSettings().workSchedule;
  const stdStart = (ws?.standardStartHour ?? 8) * 60 + (ws?.standardStartMinute ?? 30);
  const log = buildAttendanceLogForUser(user);
  let deductMin = 0;
  Object.keys(log).forEach(dateStr => {
    if (!dateStr.startsWith(yearStr) || dateStr < effDateStr) return;
    const dw = new Date(dateStr + 'T12:00:00').getDay();
    if (dw === 0 || dw === 6) return;
    if (isPublicHoliday(dateStr) || isCompanyTripDay(dateStr)) return;
    // 2026-09-24 (owner): an approved Abroad day is never late either. DUAL-SYNC: app.js
    // computeLateDeductMinutes.
    const onLeave = leaves.some(l =>
      l.userId === user.id && l.status === 'approved' &&
      ['annual','sick','business','abroad'].includes(l.type) &&
      dateStr >= l.dateFrom && dateStr <= (l.dateTo || l.dateFrom));
    if (onLeave) return;
    const corr = leaves.find(l =>
      l.userId === user.id && l.status === 'approved' &&
      l.type === 'time-correction' && l.correctionField === 'checkIn' && l.dateFrom === dateStr);
    const effectiveCheckIn = corr ? corr.correctedTime : log[dateStr].checkIn;
    if (!effectiveCheckIn) return;
    const [h, m] = effectiveCheckIn.split(':').map(Number);
    const lateMin = h * 60 + m - stdStart;
    if (lateMin <= 0) return;
    const tier = (policy.tiers || []).find(t => lateMin >= t.fromMin && lateMin <= t.toMin);
    if (tier) deductMin += tier.deductMin;
  });
  return deductMin;
}

// The pool the year-end carry-forward carries over (runYearEndCarryForward /
// refreshSnapshottedCarryForward / earnedDayUsedError). Year-scoped, hourly-aware
// (leaveMinutesOf), minus go-live opening used and the late-arrival deduction.
// 2026-09-24 (owner, review M): last year's annual leave that is still PENDING counts as used
// too (isYearEndCountedLeaveStatus) -- otherwise a December request approved after the January run
// was carried over AND taken. A later reject / owner cancel refreshes the snapshot so the days
// come back; approval changes nothing.
// DUAL-SYNC: app.js annualLeaveRemainingMinutes (same function, same name).
function isYearEndCountedLeaveStatus(s) {
  return s === 'approved' || String(s || '').startsWith('pending');
}
function annualLeaveRemainingMinutes(leaves, user, year, cf) {
  const yStart = `${year}-01-01`, yEnd = `${year}-12-31`;
  const cfDays = Number(cf[`${year}_${user.id}`]) || 0;
  const compDays = getApprovedHolidayWorkAnnualLeaveDays(leaves, user.id, year)
    + (Number(cf[`comp_${year}_${user.id}`]) || 0);
  const effectiveMax = annualLeaveEntitlementDays(user, yEnd) + cfDays + compDays;
  let usedMin = 0;
  leaves.filter(l =>
    l.userId === user.id && l.type === 'annual' && isYearEndCountedLeaveStatus(l.status) &&
    l.dateFrom >= yStart && l.dateFrom <= yEnd
  ).forEach(l => { usedMin += leaveMinutesOf(l); });
  const openingUsed = Number((readSettings().leaveOpeningUsed || {})[`${year}_${user.id}_annual`]) || 0;
  usedMin += openingUsed * 8 * 60;
  // 2026-09-24: the year is over by the time this snapshot matters, so expired carry-forward
  // (FIFO forfeit) is always taken out, as seen on 1 January of the next year. Pending leave dated
  // on/before expiry counts as carry-forward usage (includePending), matching usedMin above.
  const forfeitMin = carryForwardForfeitMinutes(leaves, user, year, `${year + 1}-01-01`, true, undefined, cf);
  return Math.max(0, effectiveMax * 8 * 60 - usedMin - annualLateDeductMinutes(user, year, leaves) - forfeitMin);
}

// Dual-sync with runYearEndCarryForward below (formerly app.js processYearEndCarryForward): if the
// year-end run already snapshotted next year's leftover, any later change to this year's annual pool (cancelling approved leave,
// approving annual leave, approving holiday work credited as an annual day) must rewrite that
// snapshot. No-op when next year's key is absent (year-end has not been processed yet).
// 2026-09-23 (Opus audit HIGH): used to count only `l.days` and skip opening-used and the late
// deduction, so it disagreed with the year-end button -- hourly leave counted as nothing and
// go-live opening balances were ignored, over-carrying days into next year.
function refreshSnapshottedCarryForward(leaves, user, dateFrom) {
  if (!user || !isValidDateStr(dateFrom)) return;
  const leaveYear = Number(dateFrom.slice(0, 4));
  if (!Number.isFinite(leaveYear)) return;
  const nextYear = leaveYear + 1;
  const nextKey = `${nextYear}_${user.id}`;
  const settings = readSettings();
  const cf = settings.leaveCarryForward;
  if (!cf || typeof cf !== 'object' || Array.isArray(cf) || cf[nextKey] === undefined) return;
  // `??` not `||`: a configured 0 means "no carry-forward", not "use the default 5".
  const rawMax = Number(getAppSettings().leave?.carryForwardMax ?? 5);
  const maxCF = Math.max(0, Math.min(60, Number.isFinite(rawMax) ? rawMax : 5));
  const leftoverDays = annualLeaveRemainingMinutes(leaves, user, leaveYear, cf) / 480;
  cf[nextKey] = Math.min(leftoverDays, maxCF);
  cf[`comp_${nextYear}_${user.id}`] = 0;
  writeJSON('settings.json', settings);
}

// ===== YEAR-END CARRY-FORWARD (automatic in January) =====
// 2026-09-24 (owner): the year-end carry-forward used to be a Settings button whose client code
// (app.js processYearEndCarryForward) computed every employee's value and PUT the whole map. It
// now runs HERE only -- automatically in January (on server start and hourly, see
// scheduleYearEndCarryForward) and from the same button via POST /api/leave-carry-forward/run --
// so there is one implementation. For source year Y-1 -> Y, every active employee record gets
// CF(Y) = min(remaining annual leave of Y-1 in days, carryForwardMax) and comp(Y) = 0, using
// annualLeaveRemainingMinutes (entitlement as of 31 Dec, expired carry-forward, opening used and
// the late deduction all included -- the pool app.js computeLeaveBalance shows). Each run is
// recorded in settings.leaveCarryForwardRuns[<source year>] = { at, by, byId }; a recorded year
// is never run again (refreshSnapshottedCarryForward keeps the snapshot current afterwards).
// Past January an unrun year is NOT auto-run (e.g. the feature ships mid-year) -- the manual
// button covers that. DUAL-SYNC: key formats = app.js getCarryForwardKey/getCarryForwardCompKey.

// Source year to auto-run for `todayStr` (Bangkok YYYY-MM-DD), or null. Pure.
// 2026-09-24 (owner): never for a year before the system started (firstSourceYear, see
// carryForwardFirstSourceYear); omitted = no floor.
function carryForwardAutoRunYear(todayStr, runs, firstSourceYear) {
  if (typeof todayStr !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(todayStr)) return null;
  if (todayStr.slice(5, 7) !== '01') return null;
  const fromYear = Number(todayStr.slice(0, 4)) - 1;
  if (Number.isInteger(firstSourceYear) && fromYear < firstSourceYear) return null;
  const r = (runs && typeof runs === 'object' && !Array.isArray(runs)) ? runs : {};
  return r[String(fromYear)] ? null : fromYear;
}
// 2026-09-24 (owner): the manual run (Settings button / POST /api/leave-carry-forward/run) is
// allowed only in January (Bangkok), only for the year that has just ended, and never for a year
// before the system started. Returns the refusal code or null. DUAL-SYNC: app.js carryForwardRunRefusal.
function carryForwardRunRefusal(todayStr, fromYear, firstSourceYear) {
  if (typeof todayStr !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(todayStr) || todayStr.slice(5, 7) !== '01') return 'cf-not-january';
  if (!Number.isInteger(fromYear) || fromYear !== Number(todayStr.slice(0, 4)) - 1) return 'cf-bad-year';
  if (Number.isInteger(firstSourceYear) && fromYear < firstSourceYear) return 'cf-before-system-start';
  return null;
}
// First year whose leave can be carried forward = the year of the first real pay period
// (APP_FIRST_PERIOD_START, the server twin of app.js's constant). Called at run time only (the
// constant is declared further down this file).
function carryForwardFirstSourceYear() {
  return APP_FIRST_PERIOD_START.getFullYear();
}
// The carry-forward entries a run writes for fromYear -> fromYear + 1. Same user filter as the old
// client function (isEmployeeRecord(u) && u.active). `??` not `||`: a configured 0 means "no
// carry-forward" (dual-sync with refreshSnapshottedCarryForward).
function computeYearEndCarryForward(leaves, users, fromYear, cf, carryForwardMax) {
  const rawMax = Number(carryForwardMax ?? 5);
  const maxCF = Math.max(0, Math.min(60, Number.isFinite(rawMax) ? rawMax : 5));
  const out = {};
  (users || []).filter(u => u && !u.isSystemAccount && u.active).forEach(u => {
    const leftoverDays = Math.max(0, annualLeaveRemainingMinutes(leaves, u, fromYear, cf) / 480);
    out[`${fromYear + 1}_${u.id}`] = Math.min(leftoverDays, maxCF);
    out[`comp_${fromYear + 1}_${u.id}`] = 0;
  });
  return out;
}
// Runs fromYear -> fromYear + 1 once. `actor` = the live user record (manual) or null (automatic).
// Synchronous read-modify-write of the WHOLE settings.json (every other key kept as read), the
// same pattern as PUT /api/settings and refreshSnapshottedCarryForward. Never writes on a read
// failure -- readSettings() would turn a corrupt file into {} and this would clobber it.
function runYearEndCarryForward(fromYear, actor) {
  const settings = readJSON('settings.json', {});
  if (settings === null || typeof settings !== 'object' || Array.isArray(settings)) {
    return { ok: false, status: 503, message: 'Service temporarily unavailable' };
  }
  const runs = (settings.leaveCarryForwardRuns && typeof settings.leaveCarryForwardRuns === 'object' && !Array.isArray(settings.leaveCarryForwardRuns))
    ? settings.leaveCarryForwardRuns : {};
  if (runs[String(fromYear)]) {
    return { ok: false, status: 409, code: 'cf-already-processed', message: `Carry-forward for ${fromYear} has already been processed`, run: runs[String(fromYear)] };
  }
  const leaves = readLeaves();
  const users = readUsers();
  if (leaves === null || users === null) return { ok: false, status: 503, message: 'Service temporarily unavailable' };
  const cf = (settings.leaveCarryForward && typeof settings.leaveCarryForward === 'object' && !Array.isArray(settings.leaveCarryForward))
    ? settings.leaveCarryForward : {};
  const computed = computeYearEndCarryForward(leaves, users, fromYear, cf, getAppSettings().leave?.carryForwardMax);
  const run = { at: new Date().toISOString(), by: actor ? String(actor.name || actor.username || actor.id) : 'auto', byId: actor ? actor.id : null };
  settings.leaveCarryForward = { ...cf, ...computed };
  settings.leaveCarryForwardRuns = { ...runs, [String(fromYear)]: run };
  writeJSON('settings.json', settings);
  return { ok: true, run, count: Object.keys(computed).length / 2 };
}
function autoYearEndCarryForward() {
  try {
    const settings = readJSON('settings.json', {});
    if (settings === null) return;
    const fromYear = carryForwardAutoRunYear(bangkokDateStr(), settings.leaveCarryForwardRuns, carryForwardFirstSourceYear());
    if (fromYear === null) return;
    const r = runYearEndCarryForward(fromYear, null);
    if (r.ok) console.log(`[CF] automatic carry-forward ${fromYear} -> ${fromYear + 1} done for ${r.count} employees`);
    else if (r.code !== 'cf-already-processed') console.error(`[CF] automatic carry-forward ${fromYear} failed: ${r.message}`);
  } catch (e) {
    console.error('[CF] automatic carry-forward error:', e && e.message);
  }
}

// Manual button (Settings -> Year-End Carry-Forward). md/accounting only; requireRole already
// refuses observers and inactive accounts. Only the year that has just ended can be processed.
app.post('/api/leave-carry-forward/run', requireRole('md', 'accounting'), withLeavesLock((req, res) => {
  const body = parseBody(req) || {};
  const year = Number(body.year);
  const refusal = carryForwardRunRefusal(bangkokDateStr(), year, carryForwardFirstSourceYear());
  if (refusal) {
    const msg = {
      'cf-not-january': 'Carry-forward can only be run in January',
      'cf-bad-year': 'Only last year can be carried forward',
      'cf-before-system-start': 'That year is before the system started',
    }[refusal];
    return res.status(400).json({ success: false, code: refusal, message: msg });
  }
  const live = (readUsers() || []).find(u => u.id === req.user.sub);
  if (!live) return res.status(403).json({ success: false, message: 'Forbidden' });
  const r = runYearEndCarryForward(year, live);
  if (!r.ok) return res.status(r.status).json({ success: false, code: r.code, message: r.message, run: r.run });
  res.json({ success: true, year, run: r.run, count: r.count });
}));

app.delete('/api/leaves/:id', withLeavesLock((req, res) => {
  try {
    const id = parseInt(req.params.id);
    const leaves = readLeaves();
    // SECURITY FIX 2026-08-13 (C-2): same fail-closed guard as POST/PUT /api/leaves.
    if (leaves === null) return res.status(503).json({ success:false, message:'Service temporarily unavailable' });
    const idx = leaves.findIndex(l => l.id === id);
    if (idx < 0) return res.status(404).json({ success:false, message:'Not found' });
    const leave = leaves[idx];
    const users = readUsers() || [];
    const live = users.find(u => u.id === req.user.sub);
    if (!live || leave.userId !== live.id) {
      return res.status(403).json({ success:false, message:'Forbidden: not your request' });
    }
    // CORRECTNESS FIX 2026-08-13 (F-B, user-requested): personal-car used to auto-approve on
    // creation (zero human review). New records go through pending-* like every other type and
    // cancel while pending; already-approved personal-car (including legacy auto-approved rows)
    // can still be cancelled by the owner — the UI Cancel button has always rendered for those.
    // Period-lock / MD-freeze guards match every other money-affecting state transition.
    // 2026-09-11: approved annual/sick/business can be cancelled by the owner before the leave
    // start date (Bangkok calendar). Hard-delete drops used minutes so the balance returns.
    const isCancellablePersonalCar = leave.type === 'personal-car' && leave.status === 'approved' && !leave.approver;
    const approvedLeaveCancel = isCancellableApprovedLeave(leave);
    if (!String(leave.status).startsWith('pending') && !isCancellablePersonalCar && !approvedLeaveCancel) {
      if (leave.status === 'approved' && ['annual', 'sick', 'business'].includes(leave.type)) {
        if (!leave.dateFrom || !isValidDateStr(leave.dateFrom)) {
          return res.status(400).json({ success:false, message:'Cannot verify pay period for this request' });
        }
        return res.status(400).json({ success:false, message:'Cannot cancel leave on or after the leave date' });
      }
      return res.status(400).json({ success:false, message:'Only pending requests can be cancelled' });
    }
    if (!leave.dateFrom || !isValidDateStr(leave.dateFrom)) {
      return res.status(400).json({ success:false, message:'Cannot verify pay period for this request' });
    }
    // Same period guards as owner PUT: locked and Accounting-confirmed periods cannot drop
    // pending rows from the approval queue. MD-freeze applies to money-bearing personal-car
    // cancels and to approved leave cancels (days already in payroll), matching the previous
    // personal-car-only branch.
    // 2026-09-24: codes added (same ones as the revoke route) so the client can word them.
    if (lockedPeriodInRange(leave.dateFrom, leave.dateTo)) {
      return res.status(400).json({ success:false, code:'period-locked', message:'This pay period is locked' });
    }
    if (accountingConfirmedInRange(leave.dateFrom, leave.dateTo, leave.userId)) {
      return res.status(409).json({ success:false, code:'period-confirmed', message:'Accounting has already confirmed tax for this period — unconfirm before making changes' });
    }
    if (isCancellablePersonalCar || approvedLeaveCancel) {
      const finGuard = readJSON('finalize.json', {});
      if (finGuard === null) return res.status(503).json({ success:false, message:'Service temporarily unavailable' });
      if (mdApprovedPeriodInRange(leave.dateFrom, leave.dateTo, leave.userId)) {
        return res.status(409).json({ success:false, code:'period-frozen', message:'Payroll for this period has already been approved by the Managing Director -- ask them to revoke approval first' });
      }
    }
    // 2026-09-24 (owner): an earned annual-leave day (Holiday Work taken as leave) that is already
    // used cannot be cancelled away. No-op for records that earn nothing.
    if (approvedLeaveCancel) {
      const earnedErr = earnedDayUsedError(leaves, live, leave);
      if (earnedErr) return res.status(409).json({ success:false, code: earnedErr.code, message: earnedErr.message });
    }
    // HYGIENE FIX 2026-08-13 (LOW-3, Opus retrospective audit): a cancelled personal-car record
    // (see the F-B fix above) is the first case in this handler where a hard-delete removes a
    // record that carried real money (personalCarRate feeding grossIncome) with zero trace
    // anywhere -- no status:'cancelled', no console line, nothing comparable to this project's
    // Hikvision door-access audit log. Full soft-delete is a bigger design change (would need
    // computePayroll()/every history view to keep excluding 'cancelled' the way they already
    // exclude 'rejected'); this is the minimum -- at least a server.log line recording who
    // cancelled what, for the one case (isCancellablePersonalCar) that removes money-bearing data
    // an owner could otherwise log-and-unlog with zero record within an open pay period.
    // 2026-09-11: same log line for approved leave cancels (used days leaving the ledger).
    if (isCancellablePersonalCar) {
      console.log('[LEAVE] personal-car cancelled', JSON.stringify({ id, userId: leave.userId, dateFrom: leave.dateFrom, personalCarRate: leave.personalCarRate }));
    } else if (approvedLeaveCancel) {
      console.log('[LEAVE] approved leave cancelled', JSON.stringify({ id, userId: leave.userId, type: leave.type, dateFrom: leave.dateFrom, dateTo: leave.dateTo, days: leave.days }));
    }
    // 2026-09-24 (owner): cancelling an APPROVED record keeps it as history -- status 'cancelled'
    // plus who/when -- instead of deleting it. isVoidLeaveStatus() keeps it out of pay, balances,
    // overlap checks and queues everywhere, so the employee can re-file the same date. Pending
    // cancels still hard-delete (owner decision: nothing was ever granted, nothing to keep).
    const softCancel = isCancellablePersonalCar || approvedLeaveCancel;
    if (softCancel) {
      leaves[idx] = {
        ...leave, status: 'cancelled', cancelledAt: new Date().toISOString(),
        cancelledById: live.id, cancelledBy: live.name,
      };
    } else {
      leaves.splice(idx, 1);
    }
    saveLeaves(leaves);
    const cancelTouchesAnnualPool = ['annual', 'abroad'].includes(leave.type) ||
      (leave.type === 'holiday-work' && leave.compensationMode === 'annual-leave');
    // 2026-09-24 (review M): a PENDING annual request counts in the year-end pool too, so its
    // hard-delete must give the days back to an already-snapshotted carry-forward.
    if ((approvedLeaveCancel && cancelTouchesAnnualPool) || (!softCancel && leave.type === 'annual')) {
      try {
        refreshSnapshottedCarryForward(leaves, live, leave.dateFrom);
      } catch (e) {
        console.error('[LEAVE] carry-forward refresh after cancel failed', e && e.message);
      }
    }
    // A soft-cancelled row stays in everyone's list (greyed), so clients get an update, not a delete.
    if (softCancel) {
      broadcastLeaveUpdated(leaves[idx]);
      return res.json({ success:true, leave: leaves[idx] });
    }
    broadcast({ type: 'LEAVE_DELETED', id });
    res.json({ success:true });
  } catch(e) {
    res.status(500).json({ success:false, error:e.message });
  }
}));

// 2026-09-24 (owner): MD or Accounting may take back an approval on any money-bearing request,
// only until payroll for that period is MD-approved. Every type below produces pay, an allowance
// or earned annual-leave credit in computePayroll()/getApprovedHolidayWorkAnnualLeaveDays():
// holiday-work (OT x2/x3 + holiday transport + upcountry, or +1 annual day), ot (office x1.5 and
// driver OT), early-morning, late-out (Late Night allowance), upcountry, long-distance,
// personal-car, abroad (daily allowance + travel-day annual credit). Leave types
// (annual/sick/business) are not revocable here -- the owner cancel covers them.
// 2026-09-24 (owner): time-correction too -- once revoked, the day falls back to the real scans
// (every log builder applies APPROVED corrections only: server buildAttendanceLog /
// annualLateDeductMinutes, app.js attendanceTimesForDate / generatePeriodDays /
// computeLateDeductMinutes; approval never writes events.json).
// Dual-sync with app.js isRevocableLeaveType.
function isRevocableLeaveType(type) {
  return ['holiday-work', 'ot', 'early-morning', 'late-out', 'upcountry', 'long-distance',
    'personal-car', 'abroad', 'time-correction'].includes(type);
}
// 2026-09-24 (owner, review M): revoking an approved time-correction revokes, in the same step,
// the employee's APPROVED money records on that date whose validity depended on the corrected
// times: re-run the submit validators' time checks (scanWindowError for office OT / Holiday Work,
// the Late Night check-out tier + lateNightCheckoutOk + chosen return time, the early-morning
// check-in tier) against the day WITH and WITHOUT the correction -- a record that passes with it
// and fails without it is a dependent. When Holiday Work on a rest day goes, the Late Night /
// early-morning claims on that day lose their Holiday Work prerequisite and go too. Approved
// Abroad days need no scans (never dependents); driver OT is not scan-validated.
// dayWith / dayWithout: that date's attendance row (generatePeriodDays) + lastScan.
// DUAL-SYNC (identical text): app.js / server.js timeCorrectionDependents.
function timeCorrectionDependents(corr, leaves, dayWith, dayWithout, S) {
  if (!corr || corr.type !== 'time-correction' || !corr.dateFrom) return [];
  const a = (S && S.allowances) || {};
  const sameDay = (leaves || []).filter(l => l && l.id !== corr.id && l.userId === corr.userId &&
    l.status === 'approved' && l.dateFrom === corr.dateFrom);
  const fails = (l, day) => {
    const d = day || {};
    const checkIn = d.checkIn || null;
    const endLimit = d.checkOut || d.lastScan || null;
    const endOk = t => !t || (!!endLimit && lateNightCheckoutMins(t) <= lateNightCheckoutMins(endLimit));
    if (l.type === 'ot' || l.type === 'holiday-work') {
      if (d.status === 'abroad') return false;
      if (!checkIn) return true;
      if (l.type === 'holiday-work' && l.workStartTime && parseHHMMToMins(l.workStartTime) < parseHHMMToMins(checkIn)) return true;
      return !endOk(l.type === 'ot' ? l.otEndTime : l.workEndTime);
    }
    if (l.type === 'late-out') {
      if (!checkIn || !d.checkOut) return true;
      const out = lateNightCheckoutMins(d.checkOut);
      const thr1 = a.lateNightThreshold1Hour || a.lateNightThresholdHour || 19;
      if (!Number.isFinite(out) || out < thr1 * 60 || !lateNightCheckoutOk(d)) return true;
      return !!l.lateOutTime && !(lateNightCheckoutMins(l.lateOutTime) <= out);
    }
    if (l.type === 'early-morning') {
      const mins = checkIn ? parseHHMMToMins(checkIn) : NaN;
      const thr = Number(l.earlyMorningTier) === 2 ? a.earlyThreshold2Min : a.earlyThreshold1Min;
      return !Number.isFinite(mins) || !(mins <= thr);
    }
    return false;
  };
  const checked = sameDay.filter(l => (l.type === 'ot' && !l.isDriverOT) ||
    ['holiday-work', 'late-out', 'early-morning'].includes(l.type));
  const deps = checked.filter(l => !fails(l, dayWith) && fails(l, dayWithout));
  const restDay = !!(dayWithout && (dayWithout.isWeekend || dayWithout.isPubHoliday));
  if (restDay && deps.some(l => l.type === 'holiday-work')) {
    sameDay.forEach(l => {
      if ((l.type === 'late-out' || l.type === 'early-morning') && !deps.includes(l)) deps.push(l);
    });
  }
  return deps.sort((x, y) => (Number(x.id) || 0) - (Number(y.id) || 0));
}
// That date's attendance row computed from an explicit leaves list (with / without the correction),
// plus the day's last raw scan (scanWindowError's end-limit fallback).
function attendanceDayFromLeaves(user, dateStr, leaves, reviews) {
  const dayStart = new Date(dateStr + 'T12:00:00');
  const attLog = buildAttendanceLogForUser(user, dayStart, dayStart);
  const day = generatePeriodDays(dayStart, dayStart, false, user, attLog, leaves, getAppSettings(), reviews || {})[0] || null;
  return day ? { ...day, lastScan: (attLog[dateStr] || {}).lastScan || null } : null;
}
// 2026-09-24 (owner): every revoke made by an Accounting user (incl. the time-correction cascade)
// is pushed to every active MD -- employee, type, date(s), who revoked and why. English, like the
// other push texts (there is no per-user push language).
function accountingRevokeMdPushBody(actor, ownerUser, records, reason) {
  const empName = ownerUser ? ownerUser.name : `#${records[0].userId}`;
  const what = records.map(r => {
    const range = r.dateTo && r.dateTo !== r.dateFrom ? `${r.dateFrom} to ${r.dateTo}` : r.dateFrom;
    return `${getTypeLabel(r.type, 'en')} (${range})`;
  }).join(', ');
  return (`${actor.name} (Accounting) revoked the approval of ${empName}: ${what}` + (reason ? ` -- reason: ${reason}` : '')).slice(0, 900);
}
function notifyMdsOfAccountingRevoke(actor, ownerUser, records, reason) {
  if (!actor || actor.role !== 'accounting' || !Array.isArray(records) || !records.length) return;
  const body = accountingRevokeMdPushBody(actor, ownerUser, records, reason);
  (readUsers() || []).filter(u => u.role === 'md' && u.active !== false && u.id !== actor.id).forEach(md => {
    Promise.resolve(sendPushToUser(md.id, {
      title: 'Approval Revoked by Accounting', body, tag: 'ta-leave-revoke', url: '/', badge: badgeCountForUser(md),
    })).catch(e => console.error('[PUSH] revoke MD notify error:', e && e.message));
  });
}
const REVOKE_REASON_MAX = 500;
app.post('/api/leaves/:id/revoke', requireRole('md', 'accounting'), withLeavesLock((req, res) => {
  try {
    const id = parseInt(req.params.id);
    const body = parseBody(req) || {};
    const leaves = readLeaves();
    if (leaves === null) return res.status(503).json({ success:false, message:'Service temporarily unavailable' });
    const idx = leaves.findIndex(l => l.id === id);
    if (idx < 0) return res.status(404).json({ success:false, message:'Not found' });
    const leave = leaves[idx];
    const users = readUsers() || [];
    const live = users.find(u => u.id === req.user.sub);
    if (!live) return res.status(403).json({ success:false, message:'Forbidden' });
    // Conservative default (open question to the owner): nobody revokes their own approval.
    if (leave.userId === live.id) {
      return res.status(403).json({ success:false, code:'revoke-own', message:'You cannot revoke the approval of your own request' });
    }
    if (leave.status !== 'approved') {
      return res.status(400).json({ success:false, code:'revoke-not-approved', message:'Only approved requests can be revoked' });
    }
    if (!isRevocableLeaveType(leave.type)) {
      return res.status(400).json({ success:false, code:'revoke-type', message:'This request type has no pay to revoke' });
    }
    if (body.reason !== undefined && body.reason !== null && typeof body.reason !== 'string') {
      return res.status(400).json({ success:false, message:'reason must be a string' });
    }
    const reason = String(body.reason || '').trim().slice(0, REVOKE_REASON_MAX);
    if (!leave.dateFrom || !isValidDateStr(leave.dateFrom)) {
      return res.status(400).json({ success:false, message:'Cannot verify pay period for this request' });
    }
    const dateTo = (leave.dateTo && isValidDateStr(leave.dateTo)) ? leave.dateTo : leave.dateFrom;
    const finGuard = readJSON('finalize.json', {});
    if (finGuard === null) return res.status(503).json({ success:false, message:'Service temporarily unavailable' });
    if (mdApprovedPeriodInRange(leave.dateFrom, dateTo, leave.userId)) {
      return res.status(409).json({ success:false, code:'period-frozen', message:'Payroll for this period has already been approved by the Managing Director -- the approval can no longer be revoked' });
    }
    if (lockedPeriodInRange(leave.dateFrom, dateTo)) {
      return res.status(400).json({ success:false, code:'period-locked', message:'This pay period is locked' });
    }
    if (accountingConfirmedInRange(leave.dateFrom, dateTo, leave.userId)) {
      return res.status(409).json({ success:false, code:'period-confirmed', message:'Accounting has already confirmed tax for this period — unconfirm before making changes' });
    }
    const ownerUser = users.find(u => u.id === leave.userId);
    // 2026-09-24 (owner): an earned annual-leave day already used cannot be revoked away
    // (annual-mode Holiday Work, an Abroad trip whose travel-day credit has arrived).
    const earnedErr = earnedDayUsedError(leaves, ownerUser, leave);
    if (earnedErr) return res.status(409).json({ success:false, code: earnedErr.code, message: earnedErr.message });
    // 2026-09-24 (owner, review M): a time-correction revoke takes the records that depended on
    // the corrected times with it (timeCorrectionDependents), all-or-nothing, in one write.
    let dependents = [];
    if (leave.type === 'time-correction') {
      if (!ownerUser) return res.status(404).json({ success:false, message:'Employee not found' });
      const reviews = readCheckoutReviews();
      if (reviews === null) return res.status(503).json({ success:false, message: CHECKOUT_REVIEWS_UNAVAILABLE });
      const dayWith = attendanceDayFromLeaves(ownerUser, leave.dateFrom, leaves, reviews);
      const dayWithout = attendanceDayFromLeaves(ownerUser, leave.dateFrom, leaves.filter(l => l.id !== leave.id), reviews);
      dependents = timeCorrectionDependents(leave, leaves, dayWith, dayWithout, getAppSettings());
      // The confirm the revoker saw listed dependentIds; if the server's set differs (data changed
      // meanwhile, or the browser's copy was stale) nothing is written and the real list goes back.
      if (Array.isArray(body.dependentIds)) {
        const want = [...new Set(body.dependentIds.map(Number))].sort((a, b) => a - b).join(',');
        const have = dependents.map(l => Number(l.id)).sort((a, b) => a - b).join(',');
        if (want !== have) {
          return res.status(409).json({ success:false, code:'revoke-dependents-changed',
            dependents: dependents.map(l => ({ id: l.id, type: l.type, dateFrom: l.dateFrom, dateTo: l.dateTo || l.dateFrom,
              otEndTime: l.otEndTime, workStartTime: l.workStartTime, workEndTime: l.workEndTime, lateOutTime: l.lateOutTime,
              earlyMorningTier: l.earlyMorningTier })),
            message:'The records that depend on this time correction have changed -- review the list and confirm again' });
        }
      }
      for (const dep of dependents) {
        if (!dep.dateFrom || !isValidDateStr(dep.dateFrom)) {
          return res.status(400).json({ success:false, dependentId: dep.id, message:'Cannot verify pay period for this request' });
        }
        const depTo = (dep.dateTo && isValidDateStr(dep.dateTo)) ? dep.dateTo : dep.dateFrom;
        if (mdApprovedPeriodInRange(dep.dateFrom, depTo, dep.userId)) {
          return res.status(409).json({ success:false, code:'period-frozen', dependentId: dep.id, message:'Payroll for this period has already been approved by the Managing Director -- the approval can no longer be revoked' });
        }
        if (lockedPeriodInRange(dep.dateFrom, depTo)) {
          return res.status(400).json({ success:false, code:'period-locked', dependentId: dep.id, message:'This pay period is locked' });
        }
        if (accountingConfirmedInRange(dep.dateFrom, depTo, dep.userId)) {
          return res.status(409).json({ success:false, code:'period-confirmed', dependentId: dep.id, message:'Accounting has already confirmed tax for this period — unconfirm before making changes' });
        }
        const depEarnedErr = earnedDayUsedError(leaves, ownerUser, dep);
        if (depEarnedErr) return res.status(409).json({ success:false, code: depEarnedErr.code, dependentId: dep.id, message: depEarnedErr.message });
      }
    }
    const revokedAt = new Date().toISOString();
    leaves[idx] = {
      ...leave, status: 'revoked', revokedAt,
      revokedById: live.id, revokedBy: live.name, revokeReason: reason,
    };
    const depIdxs = dependents.map(dep => leaves.findIndex(l => l.id === dep.id)).filter(i => i >= 0);
    depIdxs.forEach(i => {
      leaves[i] = { ...leaves[i], status: 'revoked', revokedAt, revokedById: live.id, revokedBy: live.name,
        revokeReason: reason, revokedWith: leave.id };
    });
    saveLeaves(leaves);
    console.log('[LEAVE] approval revoked', JSON.stringify({ id, userId: leave.userId, type: leave.type, dateFrom: leave.dateFrom, dateTo: leave.dateTo, by: live.id,
      ...(depIdxs.length ? { withDependents: depIdxs.map(i => leaves[i].id) } : {}) }));
    const alsoRevoked = depIdxs.map(i => leaves[i]);
    // Earned annual-leave credit goes away with the approval (holiday work taken as a leave day,
    // abroad travel days) -- rewrite next year's carry-forward snapshot like approve/cancel do.
    const touchesAnnualPool = [leave, ...alsoRevoked].some(r => r.type === 'abroad' ||
      (r.type === 'holiday-work' && r.compensationMode === 'annual-leave'));
    if (touchesAnnualPool && ownerUser) {
      try {
        refreshSnapshottedCarryForward(leaves, ownerUser, leave.dateFrom);
      } catch (e) {
        console.error('[LEAVE] carry-forward refresh after revoke failed', e && e.message);
      }
    }
    broadcastLeaveUpdated(leaves[idx]);
    alsoRevoked.forEach(r => broadcastLeaveUpdated(r));
    // Same push channel notifyLeaveStatusChange() uses for approve/reject results -- ONE message
    // listing everything that was revoked.
    const typeName = typeof getTypeLabel === 'function' ? getTypeLabel(leave.type, 'en') : leave.type;
    const alsoText = alsoRevoked.length
      ? `, together with: ${alsoRevoked.map(r => `${getTypeLabel(r.type, 'en')} (${r.dateFrom})`).join(', ')}`
      : '';
    Promise.resolve(sendPushToUser(leave.userId, {
      title: 'Approval Revoked',
      body: `The approval of your ${typeName} request (${leave.dateFrom}) was revoked${alsoText}`,
      tag: 'ta-leave',
      url: '/',
      badge: badgeCountForUser(ownerUser),
    })).catch(e => console.error('[PUSH] revoke notify error:', e && e.message));
    // 2026-09-24 (owner): the result email follows the employee's own opt-in
    // (emailNotifyOnResult) and language (notifyLangEmail), same template as approve/reject.
    sendResultEmail(leaves[idx], undefined, undefined, alsoRevoked).catch(e => console.error('[EMAIL] revoke notify error:', e && e.message));
    notifyMdsOfAccountingRevoke(live, ownerUser, [leaves[idx], ...alsoRevoked], reason);
    res.json({ success:true, leave: leaves[idx], dependents: alsoRevoked });
  } catch(e) {
    res.status(500).json({ success:false, error:e.message });
  }
}));


// RELIABILITY FIX 2026-08-13 (E-1, Opus audit): had no socket timeout, no error listener on the
// response stream, and no size cap -- a stalled connection to SMBC (TLS handshake completes, then
// the connection just sits there) meant neither 'end' nor 'error' ever fired and this promise
// never resolved. Since the route below awaits this via Promise.all with no timeout of its own,
// that hang was NOT just this one request failing -- it meant _exRateCache never got written, so
// the 60s cache (whose entire job is protecting the bank sites from repeated hits) provided zero
// protection and every subsequent request repeated the same hang (see E-2). Mirrors the existing
// r1.setTimeout()/resp1.on('error',()=>{}) precedent already used for the Hikvision HTTP client
// a few hundred lines up in this file.
const EXRATE_MAX_BYTES = 2 * 1024 * 1024;
function fetchSmbcRate() {
  return new Promise((resolve) => {
    const https = require('https');
    const opts = { hostname:'www.smbctb.co.jp', path:'/common/xml/FX_INT.xml',
      headers:{'User-Agent':'Mozilla/5.0 (compatible)'} };
    let settled = false;
    const done = (result) => { if (!settled) { settled = true; resolve(result); } };
    const req = https.get(opts, (resp) => {
      // CORRECTNESS FIX 2026-08-13 (E-3, Opus audit): was `xml += c` on raw Buffer chunks with no
      // stream encoding set -- each chunk gets independently toString('utf8')'d, so a multi-byte
      // UTF-8 character split across a chunk boundary corrupts silently. The regex anchor is
      // Japanese (タイバーツ (THB)) -- a corrupted boundary landing inside those bytes breaks the
      // match and the endpoint returns "THB not found," indistinguishable from a real bank-side
      // outage. setEncoding('utf8') lets Node's StringDecoder handle boundaries correctly.
      resp.setEncoding('utf8');
      resp.on('error', () => done({ error: 'response stream error' }));
      let xml = '';
      let bytes = 0;
      resp.on('data', c => {
        bytes += Buffer.byteLength(c, 'utf8');
        if (bytes > EXRATE_MAX_BYTES) { req.destroy(new Error('response too large')); return; }
        xml += c;
      });
      resp.on('end', () => {
        try {
          // Match on (THB), not the Japanese currency name -- SMBC has tweaked that label before
          // and a name-only regex then returns "THB not found" while the row is still present.
          const thbM = xml.match(/\(THB\)<\/col>\s*<col[^>]*>([\d.]+)<\/col>\s*<col[^>]*>([\d.]+)<\/col>\s*<col[^>]*>([\d.]+)<\/col>/);
          const timeM = xml.match(/<caption>[^:：]*[:：]\s*([^<]+)<\/caption>/);
          if (!thbM) return done({ error: `THB not found (HTTP ${resp.statusCode})` });
          done({ tts:parseFloat(thbM[1]), mid:parseFloat(thbM[2]), ttb:parseFloat(thbM[3]),
            updatedAt: timeM ? timeM[1].trim() : '' });
        } catch(e) { done({ error:e.message }); }
      });
    });
    req.on('error', e => done({ error:e.message }));
    req.setTimeout(15000, () => req.destroy(new Error('SMBC request timed out')));
  });
}

// Mizuho/Resona sit behind Akamai Bot Manager, which blocks Node's plain https client by TLS
// fingerprint (confirmed — same block hits curl from this NAS too). fetch_rates.py uses
// curl_cffi (Chrome TLS impersonation) to get past it; Node has no equivalent library, hence
// shelling out. PYTHONPATH points at the --user site-packages dir curl_cffi was installed into
// (independent of $HOME, which is broken for this NAS account — see deploy notes).
function fetchMizuhoResonaRates() {
  return new Promise((resolve) => {
    const { execFile } = require('child_process');
    const path = require('path');
    // HYGIENE FIX 2026-08-13 (E-5, Opus audit): was the bare command name 'python3', resolved
    // through the inherited PATH -- pinned to the absolute interpreter path (confirmed via `which
    // python3` on the NAS) so this can't be shadowed by anything earlier in PATH.
    execFile('/usr/bin/python3', [path.join(__dirname, 'fetch_rates.py')], {
      timeout: 20000,
      env: { ...process.env, PYTHONPATH: '/volume1/web/.local/lib/python3.8/site-packages' },
    }, (err, stdout) => {
      // HYGIENE FIX 2026-08-13 (E-4, Opus audit): was `err.message` verbatim -- execFile formats
      // that as the full command line (the server's absolute filesystem path) plus the child's
      // raw stderr, which for an uncaught Python exception is a full traceback including
      // site-packages paths. Any authenticated user (this route has no role gate) could read that.
      // Logged server-side instead; client gets a fixed message, same pattern already used for
      // send-payslip's rate-limited log line earlier today.
      if (err) {
        console.error('[EXRATE] fetch_rates.py failed:', err.message);
        const e = { error: 'rate fetch failed' };
        return resolve({ smbc:e, mizuho:e, resona:e });
      }
      try {
        const parsed = JSON.parse(stdout);
        // 2026-08-13 (E-1 fallout): defend the shape, not just the JSON syntax -- a non-object
        // result (should be unreachable given fetch_rates.py always prints {mizuho,resona}, but
        // "unreachable today" is not a reason to let `other.mizuho` throw in the route below if
        // that script is ever changed) falls through to the same parse-failed branch.
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('unexpected shape');
        resolve(parsed);
      } catch(e) {
        console.error('[EXRATE] fetch_rates.py output parse failed:', e.message);
        const pe = { error: 'rate fetch failed' };
        resolve({ smbc:pe, mizuho:pe, resona:pe });
      }
    });
  });
}

// RELIABILITY FIX 2026-08-13 (E-2, Opus audit): the cache above is only written AFTER the fetch
// completes, so every request arriving during the in-flight window (normally a few seconds;
// unbounded before E-1's timeout existed) was an independent cache miss -- N concurrent requests
// meant N Python subprocesses (curl_cffi, tens of MB resident each) plus N outbound HTTPS calls to
// two banks and SMBC. `_exRateInflight` lets every request that arrives while a fetch is already
// running join that SAME promise instead of starting its own. This is only safe to add now that
// E-1 guarantees the underlying fetch always settles within a bounded time -- without that
// guarantee, one hung SMBC connection would have wedged every subsequent request behind a
// permanently-pending promise instead of just failing its own.
let _exRateInflight = null;
app.get('/api/exchange-rate', async (req, res) => {
  try {
    const now = Date.now();
    // 60-second dedup cache — prevents hammering the bank sites when multiple users open dashboard simultaneously
    if (_exRateCache.data && (now - _exRateCache.ts) < 60000) return res.json(_exRateCache.data);
    if (!_exRateInflight) {
      _exRateInflight = Promise.all([fetchSmbcRate(), fetchMizuhoResonaRates()])
        .finally(() => { _exRateInflight = null; });
    }
    const [smbcNode, other] = await _exRateInflight;
    const smbcOk = (b) => b && !b.error && typeof b.ttb === 'number';
    const smbc = smbcOk(smbcNode) ? smbcNode : (smbcOk(other.smbc) ? other.smbc : smbcNode);
    if (!smbcOk(smbc)) console.error('[EXRATE] SMBC failed:', smbc && smbc.error);
    const data = { smbc, mizuho: other.mizuho, resona: other.resona, fetchedAt: new Date().toISOString() };
    // Do not cache a partial/error payload -- one SMBC timeout used to pin N/A on the dashboard
    // for the full 60s even though the next fetch would have succeeded.
    if (smbcOk(smbc) && smbcOk(other.mizuho) && smbcOk(other.resona)) {
      _exRateCache = { data, ts: now };
    }
    res.json(data);
  } catch(e) {
    // RELIABILITY FIX 2026-08-13 (E-1, Opus audit): this route had no try/catch at all -- one of
    // very few in this 6000+-line file without one. Express 4 doesn't catch async throws, so any
    // unexpected error after the await (e.g. a malformed `other` shape) used to leave the client
    // with no response at all rather than a clean 500, matching this file's universal pattern.
    console.error('[EXRATE] route error:', e.message);
    res.status(500).json({ error: 'Exchange rate fetch failed' });
  }
});


// ===== FILE UPLOADS =====
const UPLOADS_DIR = path.join(__dirname, 'data', 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// SECURITY FIX 2026-07-19 (F-04): the filename sanitizer below (strips to [a-zA-Z0-9.-_]) only
// ever guarded against path traversal -- it never restricted the *extension*, so an uploaded
// "evil.html" (or .svg, which can carry embedded <script> too) was stored as-is and, since this
// same route is now behind login (see PUBLIC_PATHS change above) but still served same-origin
// via res.sendFile() with Content-Type inferred from that extension, would render as a live
// webpage on this app's own origin -- a classic same-origin stored-XSS vector, and the leave/OT/
// attachment feature has always accepted arbitrary file uploads with no type check at all.
// Whitelisting the extension here is the actual fix (nothing executable can be stored in the
// first place); this is deliberately NOT paired with a blanket Content-Disposition:attachment on
// the download route below, because the frontend relies on images rendering inline via <img src>
// (see formatAttachment() in app.js) -- forcing download on every response would break that
// legitimate feature. X-Content-Type-Options:nosniff is added instead as cheap defense in depth.
const UPLOAD_ALLOWED_EXT = ['jpg','jpeg','png','gif','webp','pdf','doc','docx','xls','xlsx'];
// SECURITY FIX 2026-08-13 (Opus audit): no rate limit or per-user quota existed on this route at
// all -- any authenticated employee could loop a 10MB POST indefinitely and fill the NAS volume,
// which would then break atomicWrite() for users.json/leaves.json (both live on the same disk).
// Mirrors pushSubscribeLimiter's per-account keying (single office behind one NAT).
const uploadLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.user ? `upload:${req.user.sub}` : ipKeyGenerator(req.ip),
  message: { success:false, message:'Too many uploads -- please wait before trying again' }
});
app.post('/api/upload', uploadLimiter, withUploadOwnersLock((req, res) => {
  // SECURITY FIX 2026-08-05 (Opus audit, F-2 defense-in-depth): same rationale as GET /api/leaves
  // above -- this route never referenced req.user either, so an arbitrary-file-write primitive
  // (allowlisted extensions, but no auth) had nothing to fail closed on if the global middleware
  // were ever bypassed by a future casing/normalization trick.
  if (!req.user) return res.status(401).json({ success:false, message:'Unauthorized' });
  try {
    // BUG FIX 2026-08-13 (LOW-6, Opus retrospective audit, pre-existing): was truncating to 80
    // chars BEFORE reading the extension. app.js sends this header as
    // `encodeURIComponent(medFile.name)`, and non-ASCII characters (Thai/Japanese filenames --
    // exactly the ones real employees attach) expand to ~9 chars each in percent-encoding, then
    // every `%` gets sanitized to `_` here -- a modest Thai filename easily exceeds 80 chars
    // before the extension, so the old `.substring(0,80)` sliced the extension off entirely and
    // every such upload was wrongly rejected as "File type not allowed." Extension is now read
    // from the UNTRUNCATED sanitized name; the stored stem is truncated separately so the real
    // extension always survives into the final filename.
    const rawName = (req.headers['x-filename'] || 'attachment').replace(/[^a-zA-Z0-9.\-_]/g, '_');
    const ext = (rawName.split('.').pop() || '').toLowerCase();
    if (!UPLOAD_ALLOWED_EXT.includes(ext)) {
      return res.status(400).json({ success: false, message: 'File type not allowed. Supported: ' + UPLOAD_ALLOWED_EXT.join(', ') });
    }
    const stem = rawName.slice(0, rawName.length - ext.length - 1);
    const orig = `${stem.substring(0, 75)}.${ext}`;
    // SECURITY FIX 2026-08-13 (Opus audit, real part of a 3-claim finding -- the other 2 claims
    // didn't hold up on inspection: no read-modify-write race exists below since this whole
    // handler is synchronous end-to-end (Node can't interleave another request's JS mid-function,
    // so readJSON->mutate->writeJSON always completes atomically); the "bodyless request writes
    // [object Object]" claim doesn't apply either since `express.raw({type:'*/*'})` (line 424)
    // guarantees req.body is always a Buffer, never a parsed object. This part WAS real though:
    // `${Date.now()}_${orig}` alone collides whenever two requests with the same sanitized
    // filename land in the same millisecond, silently overwriting the first file on disk. An 8-hex
    // -char random component makes that practically impossible without adding any locking.
    const filename = `${Date.now()}_${randomBytes(4).toString('hex')}_${orig}`;
    fs.writeFileSync(path.join(UPLOADS_DIR, filename), req.body);
    // SECURITY FIX 2026-08-13 (F-A, Opus-flagged during the leaves-whitelist plan): record who
    // actually uploaded this file, at the ONE place that can't be spoofed (req.user.sub comes from
    // the verified JWT, not the request body). GET /api/upload/:filename below now trusts THIS
    // mapping instead of a leave record's self-declared `attachment` field -- a leave record is
    // client-authored (POST/PUT /api/leaves), so an employee could always claim any filename as
    // their own attachment and pass the old "do I own a leave record naming this file" check even
    // for a file someone else uploaded (e.g. another employee's medical certificate), fully
    // defeating the 2026-08-13 ownership check earlier today.
    const owners = readJSON('uploadOwners.json', {});
    if (owners === null) return res.status(503).json({ success:false, message:'Service temporarily unavailable' });
    owners[filename] = req.user.sub;
    writeJSON('uploadOwners.json', owners);
    res.json({ success: true, filename, originalName: req.headers['x-filename'] || orig });
  } catch(e) {
    res.status(500).json({ success: false, message: e.message });
  }
}));

app.get('/api/upload/:filename', (req, res) => {
  // SECURITY FIX 2026-08-05 (Opus audit, F-2 defense-in-depth): same rationale as the two routes
  // above -- attachment downloads (medical certificates, leave documents) had nothing to fail
  // closed on besides the global middleware.
  if (!req.user) return res.status(401).send('Unauthorized');
  try {
    // path.basename() strips any directory components (e.g. encoded ../) so this can never
    // resolve outside UPLOADS_DIR regardless of what the client sends as :filename.
    const safeName = path.basename(req.params.filename);
    // SECURITY FIX 2026-08-13 (re-audit, standalone half of the GET /api/leaves finding): this
    // route was authenticated-only, no ownership check -- filenames aren't guessable in bulk on
    // their own, but the unscoped GET /api/leaves (fixed above to strip `attachment` for
    // non-privileged viewers) used to make every colleague's exact filename known to every
    // employee, turning this into "download anyone's medical certificate/leave document." Only
    // the record's own owner (or a full-access role) may fetch it now.
    const users = readUsers() || [];
    const live = users.find(u => u.id === req.user.sub);
    const isFullAccess = isLeaveFullAccess(live);
    if (!isFullAccess) {
      // SECURITY FIX 2026-08-13 (F-A, Opus-flagged during the leaves-whitelist plan): the
      // ownership check used to be "does the requester own a leave record whose `attachment`
      // field names this file" -- but `attachment` is a plain client-supplied string on
      // POST/PUT /api/leaves with zero format validation, so any employee could submit their OWN
      // leave request with `attachment` set to a colleague's real filename and pass this check for
      // a file they never uploaded. Trust POST /api/upload's own uploadOwners.json record instead
      // (written from req.user.sub, the verified JWT, not any client-supplied field) -- that's the
      // one place this filename<->uploader link can't be forged. Fall back to the old leave-based
      // check only for a filename with NO owner record at all (uploaded before this fix existed),
      // so already-attached legacy documents don't suddenly 403 for their real owner.
      const owners = readJSON('uploadOwners.json', {});
      if (owners === null) return res.status(503).send('Service temporarily unavailable');
      const owns = live && (
        owners[safeName] === live.id ||
        (!(safeName in owners) && (readLeaves() || []).some(l => l.userId === live.id && l.attachment === safeName))
      );
      if (!owns) return res.status(403).send('Forbidden');
    }
    const fp = path.join(UPLOADS_DIR, safeName);
    if (!fp.startsWith(UPLOADS_DIR)) return res.status(400).send('Invalid filename');
    if (!fs.existsSync(fp)) return res.status(404).send('Not found');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.sendFile(fp);
  } catch(e) {
    res.status(500).send('Error');
  }
});

// ===== ATTACHMENT CLEANUP ("Clear Old Attachments" feature) =====
// Batch size/existence lookup for the review-checklist preview table. Widened to include
// 'manager' (not just md/accounting per the original plan) -- the "Clear Old Attachments" button
// that opens this preview lives in the shared Approval-page toolbar (app.js), visible to whichever
// role is on that page, which includes manager. This endpoint only reads file existence/size, no
// deletion -- actual deletion (attachments/clear below) stays MD-only as confirmed in app.js.
app.post('/api/attachments/info', requireRole('md', 'accounting', 'manager'), (req, res) => {
  const { filenames } = parseBody(req);
  if (!Array.isArray(filenames)) return res.status(400).json({ success:false, message:'filenames array required' });
  // SECURITY FIX 2026-08-13 (Opus audit, C-4): uncapped -- same DoS-amplification class as the
  // `targetIds`/`targetSnapshot` caps on POST /api/leaves (1000, see validateLeaveFreeFields()),
  // just never mirrored onto this endpoint. Each entry also does a synchronous fs.statSync(), so
  // an unbounded array blocks the whole event loop (attendance scanning, the WS feed) for its
  // entire duration, not just this one request.
  if (filenames.length > 1000) return res.status(400).json({ success:false, message:'filenames must be 1000 items or fewer' });
  const files = {};
  filenames.forEach(name => {
    const safeName = path.basename(String(name));
    const fp = path.join(UPLOADS_DIR, safeName);
    try {
      const stat = fs.statSync(fp);
      files[name] = { exists: true, size: stat.size };
    } catch(e) {
      files[name] = { exists: false, size: 0 };
    }
  });
  res.json({ success:true, files });
});

// SECURITY FIX 2026-08-13 (Opus audit, C-1/C-2/C-3/C-5): this endpoint used to take a raw
// `leaveIds` array straight from the client and delete whatever it named, with zero relationship
// to the `clear-attachments` leave record the approver actually saw. `targetIds` (what this
// endpoint used to trust) and `targetSnapshot`/`dateFrom` (what renders in the MD's approval
// modal) are independent client-authored fields on that record -- nothing ever checked they
// describe the same set. Concretely: any authenticated account (the type has no submission-role
// restriction) could POST /api/leaves with `targetSnapshot` showing one harmless old file while
// `targetIds` names a completely different, current, still-needed attachment -- the MD approves
// what the snapshot shows, the server deleted what targetIds said, permanently and irreversibly.
// Fixed by taking the `clear-attachments` record's OWN id instead of a client-supplied id list,
// then re-deriving the delete set server-side from that record's OWN stored dateFrom/targetIds --
// the exact same filter searchOldAttachments() (app.js) already uses to build the candidate list
// in the first place (`l.attachment && l.type !== 'clear-attachments' && l.dateFrom < cutoff`).
// A forged targetIds can still only ever match records that genuinely satisfy this filter; it can
// no longer point anywhere outside it.
app.post('/api/attachments/clear', requireRole('md'), withLeavesLock((req, res) => {
  const { leaveId } = parseBody(req);
  const id = parseInt(leaveId);
  if (!Number.isInteger(id)) return res.status(400).json({ success:false, message:'leaveId required' });
  const leaves = readLeaves();
  // SECURITY FIX 2026-08-13 (C-2): fail closed on a transient read error -- this handler saves
  // unconditionally below, so treating a read failure as "no leaves" would wipe leaves.json.
  if (leaves === null) return res.status(503).json({ success:false, message:'Service temporarily unavailable' });
  const record = leaves.find(l => l.id === id);
  if (!record || record.type !== 'clear-attachments') {
    return res.status(404).json({ success:false, message:'clear-attachments request not found' });
  }
  // CORRECTNESS FIX 2026-08-13 (M-4, Opus retrospective audit): this endpoint never checked
  // `status` at all -- it happily deleted files for a record that was still pending or even
  // rejected. Requiring 'approved' first also makes the correct call order (persist the approval,
  // THEN delete) the only possible one for the approval-path caller (approveMockLeaveInternal(),
  // app.js) -- it can no longer delete files ahead of a PUT that might still fail. The MD-direct
  // submit path is unaffected: submitClearAttachments() already creates the record with
  // status:'approved' immediately (see the auto-approve branch in POST /api/leaves) before ever
  // calling this endpoint.
  if (record.status !== 'approved') {
    return res.status(400).json({ success:false, message:'This request has not been approved yet' });
  }
  if (!record.dateFrom || !isValidDateStr(record.dateFrom)) {
    return res.status(400).json({ success:false, message:'This request has no valid cutoff date' });
  }
  const cutoff = record.dateFrom;
  const requestedIds = new Set(Array.isArray(record.targetIds) ? record.targetIds : []);
  // Pass 1: delete only files belonging to leaves that are BOTH in this record's own targetIds
  // AND independently satisfy the record's own cutoff/type criteria (never trust targetIds alone).
  const deletedFilenames = new Set();
  leaves.forEach(l => {
    if (requestedIds.has(l.id) && l.attachment && l.type !== 'clear-attachments' && l.dateFrom < cutoff) {
      const safeName = path.basename(l.attachment);
      const fp = path.join(UPLOADS_DIR, safeName);
      try { if (fs.existsSync(fp)) fs.unlinkSync(fp); } catch(e) {}
      deletedFilenames.add(safeName);
    }
  });
  // SECURITY/CORRECTNESS FIX 2026-08-13 (C-5): pass 2 clears the `attachment`/`attachmentName`
  // fields on EVERY leave record naming a file that was just physically deleted, not only the
  // ones in targetIds -- `attachment` has always been a plain client-supplied string (now format-
  // validated, but never checked for uniqueness/ownership against other records), so a different
  // employee's leave could already be pointing at the same filename. Without this, that other
  // record keeps an `attachment` field pointing at a now-missing file, 404ing on a legitimate
  // future GET /api/upload/:filename instead of showing "no attachment."
  let cleared = 0;
  const clearedIds = [];
  leaves.forEach(l => {
    if (l.attachment && deletedFilenames.has(path.basename(l.attachment))) {
      delete l.attachment;
      delete l.attachmentName;
      cleared++;
      clearedIds.push(l.id);
    }
  });
  saveLeaves(leaves);
  // HYGIENE FIX 2026-08-13 (LOW-1, Opus retrospective audit): uploadOwners.json used to grow
  // forever -- every deleted file left a dangling entry behind, and this file is re-parsed on
  // every upload and every non-privileged attachment fetch. Prune the entries for filenames that
  // were actually deleted above. Best-effort: if this happens to race a concurrent
  // POST /api/upload's own read-modify-write on the same file, the worst case is one dangling
  // entry surviving until the next clear pass -- never worse than what happened before this fix.
  if (deletedFilenames.size) {
    const owners = readJSON('uploadOwners.json', {});
    if (owners === null) {
      console.error('[ATTACH] skip uploadOwners prune — file unreadable');
    } else {
      let ownersChanged = false;
      deletedFilenames.forEach(fn => { if (fn in owners) { delete owners[fn]; ownersChanged = true; } });
      if (ownersChanged) writeJSON('uploadOwners.json', owners);
    }
  }
  // 2026-08-13: was `{leaveIds}` (the raw, now-removed client array) on an UNAUTHENTICATED /ws
  // broadcast -- also, no frontend handler for this message type ever existed (verified against
  // the full onmessage dispatch in app.js), so every other open tab kept stale `attachment` fields
  // until a manual reload regardless. Now sends only the actually-cleared ids, and app.js has a
  // real handler for it (see LEAVES_ATTACHMENTS_CLEARED in the WS dispatch).
  broadcast({ type: 'LEAVES_ATTACHMENTS_CLEARED', clearedIds });
  res.json({ success:true, cleared, clearedIds });
}));

// SECURITY FIX 2026-08-04 (4th Opus audit, CRITICAL): the nginx-level deny rules added earlier
// today (www.attendance-server-deny.conf) only cover port 80/443 -- this Node process listens
// directly on :3000/:3443 and express.static() below served the exact same dotfiles (.git/,
// .claude/settings.local.json) and CLAUDE.md with zero protection, one port over. Mirrors the
// nginx-side "location ~ /\." + "location = /attendance/CLAUDE.md" rules so both layers agree.
app.use((req, res, next) => {
  if (/(^|\/)\./.test(req.path) || req.path === '/CLAUDE.md') {
    return res.status(404).end();
  }
  next();
});
app.use(express.static('/volume1/web/Time_Attendance/attendance'));

const PORT = process.env.PORT || 3000;

// ===== FINALIZE PAYROLL =====
app.get('/api/finalize', (req, res) => {
  try {
    const data = JSON.parse(fs.readFileSync(FINALIZE_FILE, 'utf8'));
    const users = readUsers() || [];
    const live = users.find(u => u.id === req.user.sub);
    if (live && isPrivilegedAdmin(live)) {
      return res.json(data);
    }
    // 2026-08-02: this endpoint had no role gate at all -- every YYYYMMDD_userId/md_.../snap_...
    // key for EVERY employee was returned to whoever called it, including an ordinary staff
    // member's own renderPayslip() load. Since the payroll-snapshot feature landed, snap_ keys
    // hold the full computed salary (base/gross/net/allowances) for every employee, so this was
    // a real, live full-company salary leak. Non-md/accounting callers now only get their own
    // keys -- the frontend's staff path never reads anyone else's key anyway.
    const own = {};
    const suffix = '_' + req.user.sub;
    for (const k of Object.keys(data)) {
      if (k.endsWith(suffix)) own[k] = data[k];
    }
    res.json(own);
  } catch(e) {
    console.error('[finalize] GET failed', e && e.message);
    return res.status(503).json({ success:false, message:'Service temporarily unavailable' });
  }
});

// F-12: per-key PATCH instead of whole-object overwrite. Every client-side caller of
// saveFinalizeData() only ever changes ONE key before saving, but the old handler round-tripped
// the client's entire (possibly stale) finalizeData snapshot and blindly overwrote the whole
// file with it -- two people (or two tabs) saving around the same time caused a classic
// lost-update: the second save's stale copy of everyone else's data silently wiped out whatever
// the first save had just written for other keys. Fix: read the CURRENT on-disk state fresh
// (not the client's copy) and merge in only the one key this request intends to change.
app.put('/api/finalize', requireRole('md', 'accounting'), blockSuperAdminPayrollLock, withFinalizeLock((req, res) => {
  try {
    const { key, value } = parseBody(req);
    if (!key || typeof key !== 'string') {
      return res.status(400).json({ success:false, message:'key required' });
    }
    // 2026-08-01: md_ and snap_ keys used to be writable through this same generic endpoint --
    // an Accounting-role account (this endpoint's own requireRole allows both md and accounting)
    // could forge {key:"md_...", value:{approved:true, approvedBy:"..."}} directly via the API,
    // even though the UI only shows the Approve button to MD. md_ approvals now go exclusively
    // through POST /api/md-approve (requireRole('md') only); snap_ snapshots are server-authored
    // only and have no client-facing write path at all.
    if (key.startsWith('md_') || key.startsWith('snap_')) {
      return res.status(403).json({ success:false, message:'Use POST /api/md-approve for approvals; snapshots cannot be written directly' });
    }
    const km = /^(\d{8})_(\d+)$/.exec(key);
    if (!km) return res.status(400).json({ success:false, message:'Invalid key format' });
    const periodStart = new Date(parseInt(km[1].slice(0,4)), parseInt(km[1].slice(4,6)) - 1, parseInt(km[1].slice(6,8)));

    const data = readJSON('finalize.json', {});
    if (data === null) return res.status(503).json({ success:false, message:'Service temporarily unavailable' });
    // 2026-08-01: once MD has approved this employee's period, editing bonus/pit/manualAllowances/
    // diligencePaid/confirmed here would silently drift the live numbers away from what was
    // actually approved -- the UI already disables these inputs post-approval, but that's DOM
    // state only, defeatable by a stale render in another tab/session (a real scenario here: the
    // FINALIZE_UPDATED broadcast doesn't force a re-render). This is the real lock; MD must revoke
    // via POST /api/md-approve first.
    if (data[`md_${key}`]?.approved === true) {
      return res.status(409).json({ success:false, message:'This period has been approved by the Managing Director -- ask them to revoke approval before editing' });
    }
    if (isPeriodLocked(periodStart)) {
      return res.status(409).json({ success:false, message:'This period is locked' });
    }
    // VALIDATION FIX 2026-08-13 (re-audit): `value` used to be written verbatim with no shape
    // checking at all -- unlike PUT /api/settings (whitelisted/type-checked field by field), a
    // malformed manualAllowances (not an array, a negative/non-finite amount, an oversized type
    // string) would silently corrupt this employee's payslip: `Array.isArray` is missing on every
    // read site (server.js/app.js just do `|| []`), so a non-array value throws `.reduce is not a
    // function` and breaks the payslip email, the web payslip, AND the whole-company
    // GET /api/payslip-xlsx-all bulk export (one bad record fails the entire batch). md/accounting
    // only, so this is a future-caller-bug guard rather than an attacker surface.
    if (value && typeof value === 'object' && !Array.isArray(value) && 'manualAllowances' in value) {
      const mas = value.manualAllowances;
      if (!Array.isArray(mas) || mas.length > 50) {
        return res.status(400).json({ success:false, message:'manualAllowances must be an array of at most 50 entries' });
      }
      for (const ma of mas) {
        if (!ma || typeof ma !== 'object' || Array.isArray(ma)) {
          return res.status(400).json({ success:false, message:'manualAllowances entry must be an object' });
        }
        if (typeof ma.type !== 'string' || !ma.type.trim() || ma.type.length > 100) {
          return res.status(400).json({ success:false, message:'manualAllowances entry type must be a non-empty string up to 100 characters' });
        }
        for (const f of ['amount', 'advance']) {
          if (ma[f] === undefined) continue;
          if (!Number.isFinite(ma[f]) || ma[f] < 0 || ma[f] > 10000000) {
            return res.status(400).json({ success:false, message:`manualAllowances entry ${f} must be a number between 0 and 10,000,000` });
          }
        }
      }
    }
    // VALIDATION FIX 2026-08-13 (re-audit, finding 3-c): the manualAllowances check above only
    // stops the HARD-THROW failure mode (`.reduce is not a function`, which 500s the whole-company
    // bulk export) -- but bonus/pit reach the identical blast radius WITHOUT throwing:
    // getPayrollView() does `finRaw.bonus || 0` and `finRaw.pit !== undefined ? finRaw.pit : ...`,
    // both of which pass a string/object straight through and silently turn netIncome into NaN
    // across the web payslip, the emailed payslip, and every xlsx export. `confirmed` also gates
    // MD approval eligibility (POST /api/md-approve checks `!data[finKey]?.confirmed`), so any
    // truthy junk there satisfies it.
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      for (const f of ['bonus', 'pit']) {
        if (value[f] === undefined || value[f] === null) continue;
        if (!Number.isFinite(value[f]) || value[f] < 0 || value[f] > 100000000) {
          return res.status(400).json({ success:false, message:`${f} must be a number between 0 and 100,000,000` });
        }
      }
      for (const f of ['confirmed', 'diligencePaid']) {
        if (value[f] !== undefined && typeof value[f] !== 'boolean') {
          return res.status(400).json({ success:false, message:`${f} must be a boolean` });
        }
      }
    }
    if (value === null || value === undefined) {
      delete data[key];
    } else {
      data[key] = value;
    }
    atomicWrite(FINALIZE_FILE, JSON.stringify(data, null, 2));
    broadcast({ type: 'FINALIZE_UPDATED', key });
    res.json({ success: true });
  } catch(e) {
    console.error('[FINALIZE] save failed:', e.message);
    res.status(500).json({ success: false, message: e.message });
  }
}));

// 2026-08-01: MD approval now goes exclusively through this endpoint, not PUT /api/finalize --
// requireRole('md') only, closing the forgery gap where an Accounting-role account could POST a
// fake md_ approval directly (PUT /api/finalize's own requireRole allowed both roles, and it
// never checked WHICH role was setting an md_ key's `approved` flag). Approving captures a frozen
// snapshot (getPayrollView(), defined below with computePayroll() -- safe to call from here
// despite the forward reference, function declarations are hoisted) in the SAME atomicWrite as
// the approval flag, so the two can never exist independently of each other. Revoking deliberately
// does NOT delete the snapshot -- only the approval flag -- so a revoked-then-later-reapproved
// period still has an audit trail of what was actually paid the first time, via superseded[].
app.post('/api/md-approve', requireRole('md'), blockSuperAdminPayrollLock, withFinalizeLock((req, res) => {
  try {
    const { userId, periodIndex, action } = parseBody(req);
    if (userId === undefined || !Number.isInteger(periodIndex) || periodIndex < 0 || periodIndex > MAX_PERIOD_INDEX || !['approve', 'revoke'].includes(action)) {
      return res.status(400).json({ success:false, message:'userId, periodIndex, action required' });
    }
    const users = readUsers() || [];
    const user = users.find(u => u.id === userId);
    if (!user) return res.status(404).json({ success:false, message:'User not found' });

    const { start, end } = getPeriodBounds(periodIndex);
    if (isPeriodLocked(start)) {
      return res.status(409).json({ success:false, message:'This period is locked' });
    }

    const mdKey = getMdApprovalKey(start, userId);
    const snapKey = getSnapshotKey(start, userId);
    const finKey = getFinalizeKey(start, userId);
    const data = readJSON('finalize.json', {});
    if (data === null) return res.status(503).json({ success:false, message:'Service temporarily unavailable' });
    const approver = users.find(u => u.id === req.user.sub);

    if (action === 'approve') {
      if (data[mdKey]?.approved === true) {
        return res.status(400).json({ success:false, message:'Already approved' });
      }
      if (!data[finKey]?.confirmed) {
        return res.status(400).json({ success:false, message:'Accounting has not confirmed this period yet' });
      }
      // Build the frozen view BEFORE writing the approval flag -- at this point neither md_
      // (about to be set) nor snap_ has taken effect yet, so getPayrollView() takes the live
      // path, which is exactly the moment we want to freeze.
      const view = getPayrollView(user, start, end, periodIndex);
      const { frozen, approvedBy: _ab, approvedAt: _aa, ...snapshotBody } = view;
      // pDays (raw daily attendance, ~8-11KB/employee-period) is deliberately NOT part of the
      // frozen snapshot -- deriveAttendanceCounts() already captured the 12 derived counts we
      // actually need into snapshotBody.attendance. Strip it explicitly rather than relying on
      // computePayroll() to stop returning it.
      const { pDays, ...calcNoDays } = snapshotBody.calc || {};
      const newSnap = { ...snapshotBody, calc: calcNoDays, meta: { capturedAt: new Date().toISOString(), capturedBy: approver?.name || '', engineVersion: 1 } };
      const existingSnap = data[snapKey];
      if (existingSnap) {
        const { superseded: oldSupersededList, ...existingSnapWithoutHistory } = existingSnap;
        // Keep the oldest entry (usually the originally-approved/paid numbers -- the most
        // important audit record) plus the 4 most recent, instead of always dropping the oldest.
        const history = (oldSupersededList || []).concat([existingSnapWithoutHistory]);
        newSnap.superseded = history.length <= 5 ? history : [history[0], ...history.slice(-4)];
      }
      data[mdKey] = { approved: true, approvedAt: new Date().toISOString(), approvedBy: approver?.name || '' };
      data[snapKey] = newSnap;
    } else {
      // Revoke: delete ONLY the approval flag. The snapshot stays (see header comment above).
      if (!data[mdKey]?.approved) {
        return res.status(400).json({ success:false, message:'Not currently approved' });
      }
      delete data[mdKey];
    }

    atomicWrite(FINALIZE_FILE, JSON.stringify(data, null, 2));
    broadcast({ type: 'FINALIZE_UPDATED', key: mdKey });
    res.json({ success:true });
  } catch(e) {
    console.error('[MD-APPROVE] failed:', e.message);
    res.status(500).json({ success:false, message: e.message });
  }
}));


// ===== EMAIL HELPERS =====
function readSettings() {
  const s = readJSON('settings.json', {});
  return s == null ? {} : s;
}

// ===== PAYROLL ENGINE (F-16, 2026-07-22) — server-side port of app.js's payroll engine =====
// Full duplication was chosen deliberately over a lighter "trust the client's confirmed
// snapshot" approach — see memory feedback_attendance_payroll_engine_dual_sync.md. This lets
// /api/send-payslip verify numbers independently of the frontend. STANDING RULE: any future
// change to a payroll rule/tax bracket/allowance formula/attendance-derivation rule in app.js
// MUST be mirrored here in the same change, or the two engines will silently diverge.

// Mirrors APP_SETTINGS's hardcoded defaults in app.js (~line 458) — used as the fallback base
// that loadSettingsFromBackend()'s merge writes over, exactly reproduced here so a field missing
// from settings.json (partial/older config) behaves identically on both sides.
const DEFAULT_APP_SETTINGS = {
  company: { name: 'Tozai Boeki Kaisha (Thailand) Ltd.', nameTh: '', address: '', addressTh: '', taxId: '', bankName: 'Bangkok Bank', bankCode: '002', pvdLicenseNo: '', ssoEmployerAccountNo: '' },
  payroll: { periodStartDay: 21 },
  sso: { rate: 5, minSalary: 1650, maxSalary: 17500, maxAmount: 875 },
  allowances: {
    upcountry: 240,
    earlyMorning1: 240, earlyMorning2: 480,
    earlyThreshold1Min: 450, earlyThreshold2Min: 390,
    lateNight1: 240, lateNight2: 480, lateNightThreshold1Hour: 19, lateNightThreshold2Hour: 20,
    holidayTransport: 500,
    // 2026-07-31: centralized from per-employee fields (diligenceAllowance/longDistanceRate/
    // longDistanceThresholdKm/personalCarRate on the user record) -- defaults exactly match the
    // one real value each was ever set to in production, so this is behavior-neutral on deploy.
    diligence: 200, longDistance: 150, longDistanceThresholdKm: 250, personalCar: 1000, phone: 1000
  },
  workSchedule: { standardStartHour: 8, standardStartMinute: 30 },
  leave: { carryForwardMax: 5, carryForwardExpiryEnabled: true, carryForwardExpiryMonth: 3, carryForwardExpiryDay: 31, carryForwardNotifyDays: 30, annualLeaveMinMonths: 6, annualLeaveTiers: DEFAULT_ANNUAL_LEAVE_TIERS.map(t => ({ ...t })), sickLeaveDays: DEFAULT_SICK_LEAVE_DAYS, businessLeaveDays: DEFAULT_BUSINESS_LEAVE_DAYS },
  map: { cartoApiKey: '' },
  allowanceTypes: [],
  lateDeductPolicy: {
    enabled: false, effectiveFromPeriod: '',
    tiers: [ { fromMin: 1, toMin: 10, deductMin: 10 }, { fromMin: 11, toMin: 20, deductMin: 20 } ]
  },
  tax: {
    personalAllowanceAnnual: 60000,
    brackets: [
      { upTo: 150000, rate: 0 }, { upTo: 300000, rate: 5 }, { upTo: 500000, rate: 10 },
      { upTo: 750000, rate: 15 }, { upTo: 1000000, rate: 20 }, { upTo: 2000000, rate: 25 },
      { upTo: 5000000, rate: 30 }, { upTo: Infinity, rate: 35 }
    ]
  }
};

// ===== ALLOWANCE ELIGIBILITY (DUAL-SYNC BLOCK v1) =====
// Must stay byte-identical between Z:\attendance\js\app.js and
// Z:\attendance-server\backend\server.js. Verify with a diff of this block before deploying
// either file. 2026-07-31: replaces hardcoded role checks (user.role === 'driver', isAcctMkt,
// etc.) scattered across computePayroll()/renderPayslip()/payslipXlsx.js/the Finalize Payroll
// page with a single settings-driven eligibility table, so "who gets this allowance" is a
// config edit instead of a code change requiring both engines to be touched in lockstep.
const ALLOWANCE_KEYS = ['diligence', 'longDistance', 'personalCar', 'upcountry', 'earlyLate', 'ot', 'phone', 'holidayWork', 'abroad'];
const ROLE_KEYS = ['md', 'manager', 'accounting', 'user', 'marketing', 'driver'];
const DEFAULT_ALLOWANCE_ELIGIBILITY = {
  diligence:    ['driver'],
  longDistance: ['driver'],
  personalCar:  ['user', 'manager'],
  upcountry:    ['md', 'manager', 'user', 'driver'],
  earlyLate:    ['md', 'manager', 'user', 'driver'],
  ot:           ['md', 'manager', 'user', 'driver'],
  holidayWork:  ['md', 'manager', 'user'],
  // 2026-07-31: phone allowance has zero real correlation with role (only 1 of 4 'user'-role
  // employees ever had it) -- this default is intentionally permissive since the actual gate is
  // the per-employee user.phoneAllowanceEligible flag (see computePayroll), same pattern as
  // personalCar. A missing key here would throw in isAllowanceEligible() below, not just be over-permissive.
  phone:        ['md', 'manager', 'accounting', 'user', 'marketing', 'driver'],
  // 2026-09-21: Abroad (work-abroad trip allowance). MUST exist here even though the live
  // settings.json has no allowanceEligibility.abroad yet -- isAllowanceEligible() falls back to
  // DEFAULT_ALLOWANCE_ELIGIBILITY[key].includes(role), which throws on a missing key.
  abroad:       ['manager', 'user'],
};
// allowanceEligibilityConfig: the `allowanceEligibility` sub-object of appSettings (may be
// missing entirely, or missing individual keys -- per-key fallback so a partially written
// config can never silently zero out an unrelated allowance).
function isAllowanceEligible(allowanceEligibilityConfig, role, key) {
  const list = allowanceEligibilityConfig && allowanceEligibilityConfig[key];
  return Array.isArray(list) ? list.includes(role) : DEFAULT_ALLOWANCE_ELIGIBILITY[key].includes(role);
}
// 2026-08-27: Early Morning / Late Night money is tied to a face-scanner event, not a web
// Check In / Check Out button. Missing source (time-correction overlay with no scan) must not
// count as a device scan. Must stay identical in app.js and server.js.
function isDeviceScanSource(source) {
  return source === 'device';
}
// Weekends/public holidays keep status 'weekend'/'holiday' even with a real scan.
// Early morning still applies on those days and may be paid with holiday work (user 2026-08-31).
function isEarlyMorningDayStatus(status) {
  return status === 'present' || status === 'late' || status === 'weekend' || status === 'holiday';
}
function isFullDayPersonalLeaveStatus(status) {
  return status === 'leave-annual' || status === 'leave-sick' || status === 'leave-business';
}
function isRestAttendanceDay(d) {
  return !!(d && (d.isWeekend || d.isPubHoliday || d.status === 'weekend' || d.status === 'holiday'));
}
// Auto early: Hikvision device scan only. Rest days (weekend/public holiday) pay only when
// approved holiday-work exists for that date — then both may apply (user 2026-08-31).
function deviceScanQualifiesForEarlyMorning(d, holidayWorkDateSet) {
  if (!d || !d.checkIn || d.status === 'company-trip') return false;
  if (!isEarlyMorningDayStatus(d.status) || !isDeviceScanSource(d.checkInSource)) return false;
  if (isRestAttendanceDay(d) && !(holidayWorkDateSet && holidayWorkDateSet.has(d.date))) return false;
  return true;
}
// 2026-09-23 (web check-out Late Night review): a check-out before 05:00 belongs to the same
// business day (after midnight), so it compares as 24:00 + time. NaN for anything not HH:MM.
function lateNightCheckoutMins(hhmm) {
  if (typeof hhmm !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(hhmm)) return NaN;
  const [h, m] = hhmm.split(':').map(Number);
  const mins = h * 60 + m;
  return mins < 5 * 60 ? mins + 24 * 60 : mins;
}
// 2026-09-24 (review M): Late Night points for a qualifying day -- 2 once the check-out is at/after
// the x2 threshold hour, else 1. Used to compare the parseInt() hour of lateOut, which read "01:30" as hour 1
// and paid x1 for a check-out past midnight; lateNightCheckoutMins puts before-05:00 on the
// previous evening's clock (+24h).
function lateNightPoints(lateOut, thr2Hour) {
  return lateNightCheckoutMins(lateOut) >= Number(thr2Hour) * 60 ? 2 : 1;
}
// An Accounting/MD review applies only to a web check-out, and only while the day's current
// effective check-out is still the time that was reviewed -- a later web tap or an approved
// time-correction puts the day back to pending (null).
function checkoutReviewDecisionFor(review, checkOut, checkOutSource) {
  if (!review || checkOutSource !== 'web' || !checkOut || review.checkOut !== checkOut) return null;
  return review.decision === 'allow' || review.decision === 'deny' ? review.decision : null;
}
// Late Night can be paid after a face-scanner check-out, or after a web check-out that
// Accounting/MD allowed (d.checkOutReview is set by generatePeriodDays).
function lateNightCheckoutOk(d) {
  if (!d) return false;
  return isDeviceScanSource(d.checkOutSource) || (d.checkOutSource === 'web' && d.checkOutReview === 'allow');
}
// A day Accounting/MD must review: a web check-out at/after the Late Night x1 time, on a worked
// day that is not full-day personal leave / Company Trip / Abroad, for a role eligible for earlyLate.
function checkoutReviewTrigger(day, user, S) {
  if (!day || !user || !S || !day.checkIn || !day.checkOut || day.isFuture) return false;
  if (day.checkOutSource !== 'web') return false;
  if (isFullDayPersonalLeaveStatus(day.status) || day.status === 'company-trip' ||
      day.status === 'abroad' || day.status === 'future') return false;
  if (!isAllowanceEligible(S.allowanceEligibility, user.role, 'earlyLate')) return false;
  const a = S.allowances || {};
  const thr1 = a.lateNightThreshold1Hour || a.lateNightThresholdHour || 19;
  const mins = lateNightCheckoutMins(day.checkOut);
  return Number.isFinite(mins) && mins >= thr1 * 60;
}
// Late night pay: device check-out (or an Accounting/MD-allowed web check-out) + approved
// late-out. Rest days also need approved holiday-work.
function deviceScanQualifiesForLateNight(d, holidayWorkDateSet) {
  if (!d || !d.lateOut || !d.lateApproved || d.status === 'company-trip' || d.status === 'abroad') return false;
  if (isFullDayPersonalLeaveStatus(d.status) || !lateNightCheckoutOk(d)) return false;
  if (isRestAttendanceDay(d) && !(holidayWorkDateSet && holidayWorkDateSet.has(d.date))) return false;
  return true;
}
// ===== END DUAL-SYNC BLOCK =====

// Mirrors app.js loadSettingsFromBackend()'s merge of GET /api/settings().appSettings onto
// APP_SETTINGS (Object.assign per sub-object; tax.brackets' JSON-null upTo restored to Infinity)
// — must produce the exact same effective numbers computePayroll() reads on the frontend.
function getAppSettings() {
  const raw = readSettings().appSettings || {};
  const S = {
    company:      { ...DEFAULT_APP_SETTINGS.company,      ...(raw.company      || {}) },
    payroll:      { ...DEFAULT_APP_SETTINGS.payroll,      ...(raw.payroll      || {}) },
    sso:          { ...DEFAULT_APP_SETTINGS.sso,          ...(raw.sso          || {}) },
    allowances:   { ...DEFAULT_APP_SETTINGS.allowances,   ...(raw.allowances   || {}) },
    workSchedule: { ...DEFAULT_APP_SETTINGS.workSchedule, ...(raw.workSchedule || {}) },
    leave:        { ...DEFAULT_APP_SETTINGS.leave,        ...(raw.leave       || {}) },
    allowanceTypes:   raw.allowanceTypes   || DEFAULT_APP_SETTINGS.allowanceTypes,
    lateDeductPolicy: raw.lateDeductPolicy || DEFAULT_APP_SETTINGS.lateDeductPolicy,
    allowanceEligibility: raw.allowanceEligibility || {},
    tax: { personalAllowanceAnnual: DEFAULT_APP_SETTINGS.tax.personalAllowanceAnnual, brackets: DEFAULT_APP_SETTINGS.tax.brackets }
  };
  if (raw.tax) {
    if (raw.tax.personalAllowanceAnnual !== undefined) S.tax.personalAllowanceAnnual = raw.tax.personalAllowanceAnnual;
    if (Array.isArray(raw.tax.brackets) && raw.tax.brackets.length > 0) {
      S.tax.brackets = raw.tax.brackets.map(b => ({ ...b, upTo: b.upTo === null ? Infinity : b.upTo }));
    }
  }
  S.leave.annualLeaveTiers = normalizeAnnualLeaveTiers(S.leave.annualLeaveTiers);
  S.leave.sickLeaveDays = normalizeQuotaDays(S.leave.sickLeaveDays, DEFAULT_SICK_LEAVE_DAYS);
  S.leave.businessLeaveDays = normalizeQuotaDays(S.leave.businessLeaveDays, DEFAULT_BUSINESS_LEAVE_DAYS);
  return S;
}

// Port of app.js calcAnnualTax() (~line 501) — Thai progressive PIT bracket calculation.
function calcAnnualTax(taxableIncome) {
  const brackets = getAppSettings().tax.brackets;
  let tax = 0, prev = 0;
  for (const b of brackets) {
    if (taxableIncome <= prev) break;
    tax += (Math.min(taxableIncome, b.upTo === Infinity ? taxableIncome : b.upTo) - prev) * b.rate / 100;
    if (b.upTo === Infinity || taxableIncome <= b.upTo) break;
    prev = b.upTo;
  }
  // 2026-09-24 (owner): 2 decimal places, half-up (was whole baht). Dual-sync.
  return round2HalfUp(tax);
}

// Port of app.js isCompanyTripDay() (~line 625) — DATA_COMPANY_TRIP_DATES equivalent is
// settings.companyTripDates (top-level key, NOT under appSettings — matches how
// loadSettingsFromBackend() reads data.companyTripDates and saveCompanyTripDates() writes it).
function isCompanyTripDay(dateStr) {
  return (readSettings().companyTripDates || []).includes(dateStr);
}

// Company Trip is a paid day off with no work expected of anyone. These types pay extra
// (allowance, OT, or a compensatory day claimed from having "worked") -- none of them may be
// submitted or paid for a company-trip date. Matches app.js blockIfCompanyTrip() call sites.
// 2026-09-24 (owner: "a Company Trip day pays NO allowance of any kind in any case"): 'early-morning'
// added (a web claim could still be approved on a trip date) and 'abroad' added -- an Abroad trip
// whose date RANGE includes any Company Trip day is refused (dual-sync: app.js
// companyTripDateInRange / submitAbroad / approveMockLeaveInternal).
const COMPANY_TRIP_NO_CLAIM_TYPES = new Set(['ot', 'upcountry', 'late-out', 'long-distance', 'personal-car', 'holiday-work', 'early-morning', 'abroad']);
function companyTripNoClaimMessage(type) {
  if (type === 'abroad') return 'This date range includes a Company Trip day -- Company Trip days pay no allowance of any kind, so they cannot be part of an Abroad trip';
  return 'Company Trip days are a day off -- no extra allowances or OT can be claimed';
}
// 2026-09-24 (owner-accepted safety net): a date may not be ADDED to the Company Trip list while an
// APPROVED money record of any employee covers it -- it would silently stop paying. Returns
// [{ id, userId, type, date }] sorted by date then employee; [] = no conflict. Dates already on
// the list are never re-checked (only newly added ones are passed in). Removing dates is always
// allowed. DUAL-SYNC (identical text): app.js / server.js companyTripConflicts.
function companyTripConflicts(leaves, addedDates) {
  const guarded = ['holiday-work', 'ot', 'early-morning', 'late-out', 'upcountry', 'long-distance', 'personal-car', 'abroad'];
  const isDate = d => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d);
  const added = [...new Set((addedDates || []).filter(isDate))].sort();
  const out = [];
  (leaves || []).forEach(l => {
    if (!l || l.status !== 'approved' || !guarded.includes(l.type) || !isDate(l.dateFrom)) return;
    const to = isDate(l.dateTo) && l.dateTo >= l.dateFrom ? l.dateTo : l.dateFrom;
    added.forEach(d => { if (d >= l.dateFrom && d <= to) out.push({ id: l.id, userId: l.userId, type: l.type, date: d }); });
  });
  return out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : (Number(a.userId) || 0) - (Number(b.userId) || 0)));
}
// First Company Trip date inside [dateFrom, dateTo], or null. Dual-sync with app.js.
function companyTripDateInRange(dateFrom, dateTo) {
  const to = dateTo || dateFrom;
  if (!dateFrom || !to) return null;
  return (readSettings().companyTripDates || []).filter(d => d >= dateFrom && d <= to).sort()[0] || null;
}
function isCompanyTripClaimBlocked(type, dateFrom, workedDate, dateTo) {
  if (!COMPANY_TRIP_NO_CLAIM_TYPES.has(type)) return false;
  if (type === 'abroad') return !!companyTripDateInRange(dateFrom, dateTo);
  const claimDate = dateFrom;
  return !!(claimDate && isCompanyTripDay(claimDate));
}

// Full-day annual/sick/business leave is paid time off. Daily claims still need a check-in
// gate, but a leftover scan must not unlock OT / Upcountry / Late Night / etc.
const FULL_LEAVE_NO_CLAIM_TYPES = new Set(['ot', 'upcountry', 'late-out', 'long-distance', 'personal-car', 'early-morning']);
function fullDayPersonalLeaveNoClaimMessage() {
  return 'Full-day leave is paid time off -- daily allowances and OT cannot be claimed';
}
function isFullDayPersonalLeaveClaimBlocked(type, user, dateFrom) {
  if (!FULL_LEAVE_NO_CLAIM_TYPES.has(type) || !user || !dateFrom) return false;
  const day = attendanceDayForUser(user, dateFrom);
  return isFullDayPersonalLeaveStatus(day && day.status);
}
// 2026-09-21 (Abroad): 'ot' is deliberately ABSENT from this set -- the user confirmed OT is the
// one claim that still applies while abroad; the flat daily allowance covers everything else.
// Dual-sync twin in app.js.
// 2026-09-23 (owner): 'holiday-work' removed -- allowed on an abroad day without a scan, paid OT only.
const ABROAD_NO_CLAIM_TYPES = new Set(['upcountry', 'late-out', 'long-distance', 'personal-car', 'early-morning']);
function abroadNoClaimMessage() {
  return 'This day is covered by an approved Abroad request -- only OT and Holiday Work can be claimed';
}
function isAbroadClaimBlocked(type, user, dateFrom) {
  if (!ABROAD_NO_CLAIM_TYPES.has(type) || !user || !dateFrom) return false;
  const day = attendanceDayForUser(user, dateFrom);
  return !!(day && day.status === 'abroad');
}

// Port of app.js getCurrentPeriodStart() (~line 2165) and getPeriodBounds() (~line 2178).
function getCurrentPeriodStart() {
  const { y, m, day } = bangkokYmd();
  const sd = getAppSettings().payroll.periodStartDay || 21;
  let month = m;
  let year = y;
  if (day < sd) {
    month -= 1;
    if (month < 0) { month = 11; year -= 1; }
  }
  return new Date(year, month, sd);
}

// Server-side twin of app.js's APP_FIRST_PERIOD_START (~line 779) -- MUST stay byte-identical.
// 2026-08-17: added for buildTawi50AnnualTotals()'s period walk, which needs the same "don't walk
// past when this app actually started recording periods" guard render50Tawi() already has
// client-side (see project memory, Part 2 finding E).
const APP_FIRST_PERIOD_START = new Date(2026, 5, 21); // 21 June 2026

function getPeriodBounds(index = 0) {
  const sd = getAppSettings().payroll.periodStartDay || 21;
  const ed = sd - 1 || 20;
  const base = getCurrentPeriodStart();
  const startMonth = base.getMonth() - index;
  const startYear = base.getFullYear();
  const adj = new Date(startYear, startMonth, sd);
  const endM = adj.getMonth() + 1;
  const endY = endM >= 12 ? adj.getFullYear() + 1 : adj.getFullYear();
  const end = new Date(endY, endM % 12, ed);
  return { start: adj, end, isCurrent: index === 0 };
}

// Port of app.js getFinalizeKey() (~line 10344).
function getFinalizeKey(periodStart, userId) {
  const pad2 = n => String(n).padStart(2, '0');
  return `${periodStart.getFullYear()}${pad2(periodStart.getMonth() + 1)}${pad2(periodStart.getDate())}_${userId}`;
}

// Port of app.js getMdApprovalKey() (~line 10359).
function getMdApprovalKey(periodStart, userId) {
  const pad2 = n => String(n).padStart(2, '0');
  return `md_${periodStart.getFullYear()}${pad2(periodStart.getMonth() + 1)}${pad2(periodStart.getDate())}_${userId}`;
}

// Derives { [businessDateStr]: { checkIn, checkOut, status } } for ONE user across a date range,
// mirroring app.js loadAttendanceFromBackend()'s event-grouping logic exactly: 5am
// business-day boundary (local hour of the stored event_time offset), employeeNo '6344'
// emergency-account exclusion, late threshold 08:30 (driver exempt), first/last-scan grouping.
// Sort is by instant (compareEventsByInstant), not ISO string, so mixed +07:00/+09:00 stamps
// stay chronological. GPS is still dropped; checkInSource/checkOutSource are kept (2026-08-27)
// so Early Morning / Late Night can require a face scan.
// 2026-08-06: dual-sync twin of app.js's CHECKIN_CUTOFF -- must stay identical in both files or
// the web display and the backend-computed payroll/attendance summary silently disagree.
const CHECKIN_CUTOFF = '13:00';

function buildAttendanceLogForUser(user, start, end) {
  const loadedEvents = readEvents();
  if (loadedEvents === null) throw new Error('Service temporarily unavailable');
  const events = loadedEvents
    .filter(ev => String(ev.employeeNo) === String(user.employeeNo))
    .sort(compareEventsByInstant);
  // 2026-08-09 (2nd-pass audit finding 4.2 follow-up): hoisted out of the per-event loop below --
  // was a hardcoded '08:30' literal; now reads the configurable standard start time once per call
  // instead of re-reading settings on every event.
  const _ws7 = getAppSettings().workSchedule;
  const _stdStr7 = `${String(_ws7?.standardStartHour ?? 8).padStart(2,'0')}:${String(_ws7?.standardStartMinute ?? 30).padStart(2,'0')}`;
  const log = {};
  events.forEach(ev => {
    if (String(ev.employeeNo) === '6344') return;
    const raw = ev.event_time || '';
    if (!raw) return;
    const datePart = raw.substring(0, 10);
    const timePart = raw.substring(11, 16);
    const hour = parseInt(timePart.substring(0, 2), 10);
    let businessDate = datePart;
    if (hour < 5) {
      const d = new Date(datePart + 'T00:00:00');
      d.setDate(d.getDate() - 1);
      businessDate = ta_localDateStr(d);
    }
    if (!log[businessDate]) log[businessDate] = {};
    const rec = log[businessDate];
    const source = ev.eventType === 'WebScan' ? 'web' : 'device';
    if (hour < 5) {
      // 2026-09-23: always overwrite -- events are sorted by instant, so an after-midnight scan
      // is the latest of the business day ("00:30" used to lose to a "12:30" lunch scan on a
      // string compare). Dual-sync with app.js loadAttendanceFromBackend.
      rec.checkOut = timePart;
      rec.checkOutSource = source;
    } else if (!rec.checkIn && timePart >= CHECKIN_CUTOFF) {
      if (!rec.firstScanAfterCutoff) rec.firstScanAfterCutoff = timePart;
      if (!rec.status) rec.status = 'not-clocked-in';
      if (!rec.checkOut || timePart > rec.checkOut) {
        rec.checkOut = timePart;
        rec.checkOutSource = source;
      }
    } else if (!rec.checkIn) {
      rec.checkIn = timePart;
      rec.checkInSource = source;
      // 2026-08-09 (2nd-pass audit finding 4.2 follow-up, dual-sync twin of app.js's two copies):
      // was hardcoded '08:30' even though this is the site that decides 'late' vs 'present' in
      // the first place -- every downstream late-deduction/display site already reads the
      // configurable Settings value (_stdStr7, hoisted above).
      rec.status = (user.role !== 'driver' && timePart > _stdStr7) ? 'late' : 'present';
    } else {
      if (timePart >= '12:00' && (!rec.checkOut || timePart > rec.checkOut)) {
        rec.checkOut = timePart;
        rec.checkOutSource = source;
      }
      // 2026-09-23: latest scan after check-in, morning ones included -- only scanWindowError's
      // fallback end limit when no check-out exists (dual-sync with app.js).
      rec.lastScan = timePart;
    }
  });
  return log;
}

// Port of app.js generatePeriodDays() (~line 2206) — day-by-day status derivation. Takes
// explicit deps (attLog from buildAttendanceLogForUser, leaves from readLeaves(), appSettings
// from getAppSettings()) instead of reading frontend globals (attendanceLog/DATA_LEAVES/
// DATA_USERS/APP_SETTINGS). checkInSource/checkOutSource are kept (2026-08-27) so Early Morning
// / Late Night can require a face scan; GPS/dayName remain UI-only and dropped.
// 2026-08-06: dual-sync twin of app.js's leaveDayCoverage() -- must classify identically or the
// web display and the backend-computed attendance summary/payroll silently disagree. See app.js's
// copy for the full rationale (fixes the pre-existing "any hourly leave wipes the whole day" bug).
const LUNCH_START_MIN = 12 * 60;      // 12:00
const LUNCH_END_MIN   = 13 * 60;      // 13:00
const STD_END_MIN     = 17 * 60 + 30; // 17:30
// 2026-08-06 (Opus audit finding 5, dual-sync twin of app.js's copy): absorbs a few-minutes-off
// manual entry so a near-exact half-day/full-day boundary doesn't silently degrade to 'partial'.
const HALFDAY_TOL_MIN = 15;
function leaveDayCoverage(l, dateStr, stdStartMin) {
  if (!['annual', 'sick', 'business'].includes(l.type)) return 'none';
  if (!(dateStr >= l.dateFrom && dateStr <= (l.dateTo || l.dateFrom))) return 'none';
  if ((l.days || 0) > 0) return 'full';
  if (!l.hourlyStart || !l.hourlyEnd) return 'full';
  const [sh, sm] = l.hourlyStart.split(':').map(Number);
  const [eh, em] = l.hourlyEnd.split(':').map(Number);
  // 2026-08-06 (Opus audit finding 6): a present-but-garbage value used to fall through to
  // 'partial' -- the opposite of the documented safe default above.
  if ([sh, sm, eh, em].some(n => Number.isNaN(n))) return 'full';
  const sMin = sh * 60 + sm, eMin = eh * 60 + em;
  if (sMin <= stdStartMin + HALFDAY_TOL_MIN && eMin >= STD_END_MIN - HALFDAY_TOL_MIN) return 'full';
  if (sMin <= stdStartMin + HALFDAY_TOL_MIN && eMin >= LUNCH_START_MIN) return 'am';
  if (sMin >= LUNCH_START_MIN && sMin <= LUNCH_END_MIN && eMin >= STD_END_MIN - HALFDAY_TOL_MIN) return 'pm';
  return 'partial';
}

// Port of app.js's lateReferenceMin() (~line 2547) -- a day's "late" minutes/status should be
// measured from whichever is later: the standard start time, or the end of an approved
// partial leave that covers the standard start time. Only applies when the leave's own start
// is at/before the standard start.
function lateReferenceMin(row, stdStartMin) {
  const pl = row.partialLeave;
  if (!pl || !pl.hourlyStart || !pl.hourlyEnd) return stdStartMin;
  const [sh, sm] = pl.hourlyStart.split(':').map(Number);
  const [eh, em] = pl.hourlyEnd.split(':').map(Number);
  if (Number.isNaN(sh) || Number.isNaN(sm) || Number.isNaN(eh) || Number.isNaN(em)) return stdStartMin;
  const plStartMin = sh * 60 + sm, plEndMin = eh * 60 + em;
  return (plStartMin <= stdStartMin && plEndMin > stdStartMin) ? plEndMin : stdStartMin;
}

function generatePeriodDays(start, end, isCurrent, user, attLog, leaves, appSettings, reviews = {}) {
  const uid = user.id;
  const reviewMap = reviews || {};
  const days = [];
  const todayCopy = bangkokTodayDate();
  todayCopy.setHours(23, 59, 59, 0);

  let d = new Date(start);
  while (d <= end) {
    const isFuture = isCurrent && d > todayCopy;
    const isWeekend = d.getDay() === 0 || d.getDay() === 6;
    const dateStr = ta_localDateStr(d);
    const isPubHoliday = isPublicHoliday(dateStr) && !isWeekend;
    const isCompanyTrip = isCompanyTripDay(dateStr);

    let status = 'present', checkIn = null, checkOut = null, lateOut = null;
    let upcountry = false, lateApproved = false;
    let longDistance = false, longDistanceKm = 0, longDistanceAllowance = 0;
    let firstScanAfterCutoff = null, partialLeave = null;
    let checkInSource = null, checkOutSource = null;

    if (isCompanyTrip) {
      // Overrides weekend/holiday/future — still shows real scan times, never counts as
      // late/absent, never earns early/late/OT/upcountry bonuses (enforced in computePayroll()).
      status = 'company-trip';
      const realRecord = attLog[dateStr] || null;
      if (realRecord) {
        checkIn = realRecord.checkIn || null;
        checkOut = realRecord.checkOut || null;
        checkInSource  = realRecord.checkInSource  || null;
        checkOutSource = realRecord.checkOutSource || null;
      }
    } else if (isWeekend) {
      status = 'weekend';
      const weekendRec = attLog[dateStr] || null;
      if (weekendRec) {
        checkIn = weekendRec.checkIn || null;
        checkOut = weekendRec.checkOut || null;
        checkInSource  = weekendRec.checkInSource  || null;
        checkOutSource = weekendRec.checkOutSource || null;
      }
    } else if (isPubHoliday && isFuture) {
      status = 'holiday';
    } else if (isFuture) {
      status = 'future';
    } else {
      const realRecord = attLog[dateStr] || null;
      if (realRecord) {
        const hasIn = !!realRecord.checkIn;
        const hasOut = !!realRecord.checkOut;
        if (hasIn || hasOut) {
          status = realRecord.status || 'present';
          checkIn = realRecord.checkIn || null;
          checkOut = realRecord.checkOut || null;
          checkInSource  = realRecord.checkInSource  || null;
          checkOutSource = realRecord.checkOutSource || null;
          firstScanAfterCutoff = realRecord.firstScanAfterCutoff || null;
          lateOut = realRecord.lateOut || null;
          lateApproved = realRecord.lateApproved || false;
          upcountry = realRecord.upcountry || false;
          longDistance = realRecord.longDistance || false;
          longDistanceKm = realRecord.longDistanceKm || 0;
          longDistanceAllowance = realRecord.longDistanceAllowance || 0;
        } else {
          status = 'absent';
        }
      } else {
        status = isPubHoliday ? 'holiday' : 'absent';
      }
    }

    // 2026-09-23: the scanned check-out before any time-correction overlay -- shown to reviewers
    // as "21:00 (corrected from 17:40)". Dual-sync twin in app.js.
    const rawCheckOut = checkOut;

    // Overlay approved leaves so approvals always appear regardless of attLog state
    // (mirrors app.js's `DATA_LEAVES.filter(l => l.userId == uid && l.status === 'approved')`).
    // 2026-09-01: weekend still skips annual/sick/business overlays, but same-date late-out /
    // LD / time-correction must apply — otherwise holiday late-night never gets lateApproved.
    if (!isCompanyTrip && !isFuture) {
      const ws2 = appSettings.workSchedule;
      const stdStartMin2 = (ws2?.standardStartHour ?? 8) * 60 + (ws2?.standardStartMinute ?? 30);
      leaves.filter(l => l.userId == uid && l.status === 'approved').forEach(l => {
        // 2026-09-21 (Abroad): deliberately BEFORE the weekend guard below and with no
        // `if (isWeekend) return` of its own -- a trip abroad covers every calendar day it spans
        // and is paid for every one of them, so Saturday and Sunday inside the range must read as
        // worked-abroad, not weekend-with-no-scan. Dual-sync twin in app.js.
        if (l.type === 'abroad') {
          const _to = l.dateTo || l.dateFrom;
          if (l.dateFrom <= dateStr && _to >= dateStr) status = 'abroad';
          return;
        }
        if (['annual', 'sick', 'business'].includes(l.type)) {
          if (isWeekend) return;
          // 2026-08-06: see leaveDayCoverage() above -- 'full' unchanged from before; 'am'/'pm'/
          // 'partial' now keep the real checkIn/checkOut instead of wiping the whole day.
          const coverage = leaveDayCoverage(l, dateStr, stdStartMin2);
          // 2026-08-06 (Opus audit finding 1, refined, dual-sync twin of app.js): fall back to
          // full-day treatment when there's no scan at all AND coverage is 'am' specifically (its
          // loose end-boundary also catches a near-full-day leave, e.g. 08:00-17:00) -- NOT 'pm'
          // (always a genuinely clean half-day, per leaveDayCoverage()'s tight start window) or
          // 'partial'. See app.js's copy for the full rationale.
          const treatAsFull = coverage === 'full' || (status === 'absent' && coverage === 'am');
          if (treatAsFull && !isPubHoliday) {
            status = l.type === 'annual' ? 'leave-annual' : l.type === 'sick' ? 'leave-sick' : 'leave-business';
            checkIn = null; checkOut = null; upcountry = false;
            lateOut = null; lateApproved = false;
            longDistance = false; longDistanceKm = 0; longDistanceAllowance = 0;
            checkInSource = null; checkOutSource = null;
          } else if ((coverage === 'am' || coverage === 'pm' || coverage === 'partial') && !isPubHoliday) {
            // 2026-08-09 (Opus audit finding 5.1, dual-sync twin of app.js): two qualifying
            // hourly leaves on the same day used to let whichever record appeared LAST in the
            // array win (last-write-wins) instead of whichever one actually covers the standard
            // start time -- see app.js's copy for the full failure-scenario rationale.
            const candidate = { type: l.type, coverage, hourlyStart: l.hourlyStart, hourlyEnd: l.hourlyEnd };
            const covers = pl => { const [h,m]=(pl?.hourlyStart||'').split(':').map(Number); return Number.isFinite(h) && Number.isFinite(m) && (h*60+m) <= stdStartMin2; };
            // 2026-08-09 (2nd-pass audit finding 3 follow-up, dual-sync twin of app.js): see
            // app.js's copy for the full rationale -- 'am' coverage ranks above the plain
            // covers() check.
            const rank = pl => pl && pl.coverage === 'am' ? 2 : (covers(pl) ? 1 : 0);
            if (!partialLeave || rank(candidate) > rank(partialLeave)) {
              partialLeave = candidate;
            }
          }
        } else if (l.dateFrom === dateStr) {
          if (isFullDayPersonalLeaveStatus(status) && l.type !== 'time-correction') {
            // Full-day personal leave is an off day — do not overlay Upcountry / LD / late-out.
          } else if (l.type === 'upcountry') {
            upcountry = true;
          } else if (l.type === 'long-distance') {
            longDistance = true;
            longDistanceKm = l.distanceKm || 0;
            longDistanceAllowance = l.longDistanceAllowance || 0;
          } else if (l.type === 'time-correction') {
            if (l.correctionField === 'checkIn') {
              checkIn = l.correctedTime;
              if (status === 'present' || status === 'late' || status === 'not-clocked-in') {
                const ws = appSettings.workSchedule;
                const stdStr = `${String(ws?.standardStartHour ?? 8).padStart(2, '0')}:${String(ws?.standardStartMinute ?? 30).padStart(2, '0')}`;
                status = (user.role !== 'driver' && checkIn > stdStr) ? 'late' : 'present';
              }
            }
            if (l.correctionField === 'checkOut') checkOut = l.correctedTime;
          } else if (l.type === 'late-out') {
            lateApproved = true;
            if (l.lateOutTime) lateOut = l.lateOutTime;
          }
        }
      });
      // 2026-08-06 (Opus audit finding 4, dual-sync twin of app.js): moved out of the forEach so
      // the AM-coverage late-clearing no longer depends on record iteration order relative to a
      // same-day time-correction record. See app.js's copy for the full rationale.
      if (partialLeave && partialLeave.coverage === 'am' && (status === 'late' || status === 'not-clocked-in')) {
        status = 'present';
      } else if (partialLeave && partialLeave.coverage === 'partial' && status === 'late' && checkIn) {
        // 2026-08-07: 'partial' coverage never got the automatic clearing 'am' has -- a check-in
        // at/before the leave's own end time (not the standard start) should not read as late.
        const [ch, cm] = checkIn.split(':').map(Number);
        if (ch * 60 + cm <= lateReferenceMin({ partialLeave }, stdStartMin2)) status = 'present';
      }
    }

    // 2026-09-23: after the overlay, so a review counts only for the effective (corrected) web
    // check-out it was made on. Dual-sync twin in app.js.
    const checkOutReview = checkoutReviewDecisionFor(reviewMap[`${uid}_${dateStr}`], checkOut, checkOutSource);
    days.push({ date: dateStr, isWeekend, isPubHoliday, isFuture, status, checkIn, checkOut, lateOut, upcountry, longDistance, longDistanceKm, longDistanceAllowance, lateApproved, firstScanAfterCutoff, partialLeave, checkInSource, checkOutSource, checkOutReview, rawCheckOut });
    d.setDate(d.getDate() + 1);
  }
  return days;
}

// 2026-08-27: Late Night Out may only be submitted after a check-out that already meets the ×1
// threshold. 2026-09-23 (web check-out review): a face-scanner check-out qualifies directly; a web
// check-out qualifies only after Accounting/MD allowed that exact effective check-out time (see
// checkoutReviewTrigger / PUT /api/checkout-reviews). A check-out before 05:00 is after midnight
// on the same business day and reaches the top tier. The chosen tier (lateOutTime) may not be
// later than the real check-out -- this used to be checked only in the browser.
// Returns CHECKOUT_REVIEWS_UNAVAILABLE when the reviews file cannot be read (callers answer 503).
function lateOutSubmitBlockReason(user, dateStr, lateOutTime) {
  if (!user || !dateStr || !isValidDateStr(dateStr)) {
    return 'dateFrom must be a valid YYYY-MM-DD date';
  }
  const reviews = readCheckoutReviews();
  if (reviews === null) return CHECKOUT_REVIEWS_UNAVAILABLE;
  const S = getAppSettings();
  const dayStart = new Date(dateStr + 'T12:00:00');
  const attLog = buildAttendanceLogForUser(user, dayStart, dayStart);
  const leaves = readLeaves() || [];
  const days = generatePeriodDays(dayStart, dayStart, false, user, attLog, leaves, S, reviews);
  const day = days[0];
  if (isFullDayPersonalLeaveStatus(day && day.status)) {
    return fullDayPersonalLeaveNoClaimMessage();
  }
  // FIX (final review, T3): company-trip/abroad used to fall through into the checkOut/review
  // checks below, where checkoutReviewTrigger() never fires for them -- resulting in a day that
  // can NEVER be reviewed reporting "waiting for Accounting/MD review" forever. Report the real,
  // specific reason instead, matching app.js's canSubmitLateNightForDate().
  if (day && day.status === 'company-trip') {
    return 'This date is a Company Trip day — Late Night Out cannot be claimed';
  }
  if (day && day.status === 'abroad') {
    return 'This day is an approved Abroad day — Late Night Out cannot be claimed';
  }
  // FIX (final review, T3): checkIn used to be checked AFTER the checkout/tier/review checks
  // below, so a day with no check-in at all (but some stray web checkOut value) could report
  // "waiting for Accounting/MD review" -- a state that can never clear -- instead of the real,
  // fixable "check in first" reason.
  if (!day || !day.checkIn) {
    return 'Late Night Out requires a check-in first';
  }
  if (!day.checkOut) {
    return 'Late Night Out requires a check-out first';
  }
  const thr1 = S.allowances.lateNightThreshold1Hour || S.allowances.lateNightThresholdHour || 19;
  const outMins = lateNightCheckoutMins(day.checkOut);
  if (!Number.isFinite(outMins) || outMins < thr1 * 60) {
    return `Late Night Out requires a check-out at or after ${String(thr1).padStart(2, '0')}:00`;
  }
  if (!lateNightCheckoutOk(day)) {
    // FIX (final review, T3): gate on the actual trigger predicate (checkoutReviewTrigger),
    // not merely `checkOutSource === 'web'` -- keeps this consistent with app.js and with
    // whatever day.status exclusions checkoutReviewTrigger() applies (future-proof if that list
    // changes) instead of duplicating the exclusion list here.
    if (checkoutReviewTrigger(day, user, S)) {
      return day.checkOutReview === 'deny'
        ? 'This web check-out was not allowed by Accounting/MD -- Late Night Out cannot be claimed'
        : 'This web check-out is waiting for Accounting/MD review before Late Night Out can be submitted';
    }
    return 'Late Night Out requires check-out at the face scanner, not the web app';
  }
  if (lateOutTime !== undefined && lateOutTime !== null && lateOutTime !== '') {
    const tierMins = lateNightCheckoutMins(lateOutTime);
    if (!Number.isFinite(tierMins) || tierMins > outMins) {
      return `The selected return time is later than your check-out (${day.checkOut})`;
    }
  }
  const hwDay = isHolidayWorkDay(dateStr);
  const hasHw = hasActiveHolidayWork(leaves, user.id, dateStr);
  if (hwDay && !hasHw) {
    return 'Late night on a holiday requires a holiday work request first';
  }
  return null;
}

// Port of app.js computePayroll() (~line 5588) — the full gross/SSO/PVD/OT/allowance/PIT-estimate
// formula, copied line-for-line from the frontend (not re-derived from understanding).
function computePayroll(user, start, end, periodIndex) {
  const S = getAppSettings();
  // Monthly salary is never prorated for approved annual/sick/business leave — those days are
  // paid leave. Only daily allowances are skipped (see fullLeaveDates below).
  const base = user.salary || 0;
  const transport = user.transport || 0;
  const posAllowance = user.positionAllowance || 0;
  const housingAllowance = user.housing || 0;
  // 2026-07-31: phone allowance centralized (Settings -> Allowance Rates -> Phone) and gated on
  // role eligibility AND the per-employee flag, mirroring personalCar. Previously this read
  // user.allowance3 raw with no gate of any kind. Flag is named phoneAllowanceEligible, not
  // phoneEligible, because user.phone is already the employee's phone NUMBER.
  // `!= null` not `||`: an admin deliberately zeroing the central rate must yield 0, not fall
  // back to 1000 (same footgun fixed in personalCarTotal below).
  const phoneEligible = isAllowanceEligible(S.allowanceEligibility, user.role, 'phone') &&
    user.phoneAllowanceEligible === true;
  const allowance3val = phoneEligible
    ? (S.allowances.phone != null ? S.allowances.phone : 1000) : 0;

  const finKey = getFinalizeKey(start, user.id);
  const finalizeData = readJSON('finalize.json', {});
  if (finalizeData === null) throw new Error('Service temporarily unavailable');
  const diligencePaidThisPeriod = finalizeData[finKey]?.diligencePaid !== false;
  // 2026-07-31: role gate moved from UI-only (Finalize Payroll toggle visibility, payslip row
  // visibility) into the calculation itself -- previously a non-eligible role with a stray
  // nonzero user.diligenceAllowance would have been paid it silently, since this line only
  // checked the finalize.json flag, never the role.
  // 2026-07-31: amount now centralized (Settings -> Allowance Rates -> Diligence), not read from
  // the per-employee user.diligenceAllowance field anymore (that field is being removed from the
  // Employee edit form -- role eligibility already gates who gets it, so a single company-wide
  // amount replaces per-employee variance that never actually existed in real data).
  const diligenceAllowance = (diligencePaidThisPeriod && isAllowanceEligible(S.allowanceEligibility, user.role, 'diligence'))
    ? (S.allowances.diligence || 0) : 0;

  const isCurrent = periodIndex === 0;
  const attLog = buildAttendanceLogForUser(user, start, end);
  const leaves = readLeaves() || [];
  // 2026-09-23: an Accounting/MD-allowed web check-out pays Late Night like a device scan. Never
  // treat an unreadable reviews file as "no reviews" -- that would silently change payroll.
  const reviews = readCheckoutReviews();
  if (reviews === null) throw new Error('Service temporarily unavailable');
  const pDays = generatePeriodDays(start, end, isCurrent, user, attLog, leaves, S, reviews);

  const canUpcountry = isAllowanceEligible(S.allowanceEligibility, user.role, 'upcountry');
  const canEarlyLate = isAllowanceEligible(S.allowanceEligibility, user.role, 'earlyLate');
  const canOT = isAllowanceEligible(S.allowanceEligibility, user.role, 'ot');
  const canHolidayWork = isAllowanceEligible(S.allowanceEligibility, user.role, 'holidayWork');

  const pad2 = n => String(n).padStart(2, '0');
  const periodStartStr = `${start.getFullYear()}-${pad2(start.getMonth() + 1)}-${pad2(start.getDate())}`;
  const periodEndStr   = `${end.getFullYear()}-${pad2(end.getMonth() + 1)}-${pad2(end.getDate())}`;

  const approvedHolidayWork = canHolidayWork ? leaves.filter(l =>
    l.userId === user.id && l.type === 'holiday-work' && l.status === 'approved' &&
    l.dateFrom >= periodStartStr && l.dateFrom <= periodEndStr &&
    !isCompanyTripDay(l.dateFrom)
  ) : [];
  const holidayWorkDates = new Set(approvedHolidayWork.map(l => l.dateFrom));
  const fullLeaveDates = new Set(
    pDays.filter(d => isFullDayPersonalLeaveStatus(d.status)).map(d => d.date)
  );
  // 2026-09-23 (owner): Holiday Work on an approved Abroad day pays its OT (x2/x3) only -- no
  // Upcountry and no holiday transport, the Abroad allowance already covers the day.
  // Dual-sync with the other file's computePayroll.
  const abroadDates = new Set(pDays.filter(d => d.status === 'abroad').map(d => d.date));

  // 2026-09-24 (owner: a Company Trip day pays no allowance of any kind): a web Early Morning
  // approved before the date was declared a Company Trip is no longer paid. Dual-sync with app.js.
  const approvedEarlyMorning = canEarlyLate ? leaves.filter(l =>
    l.userId === user.id && l.type === 'early-morning' && l.status === 'approved' &&
    l.dateFrom >= periodStartStr && l.dateFrom <= periodEndStr &&
    !isCompanyTripDay(l.dateFrom)
  ) : [];

  const upcountryCount = canUpcountry ? pDays.filter(d =>
    d.upcountry && d.status !== 'company-trip' && !holidayWorkDates.has(d.date) &&
    !isFullDayPersonalLeaveStatus(d.status)
  ).length : 0;
  const holidayWorkUpcountryCount = canUpcountry ? approvedHolidayWork.filter(l =>
    !abroadDates.has(l.dateFrom) &&
    Array.isArray(l.locations) && l.locations.some(x => x && x.name && String(x.name).trim())
  ).length : 0;

  let earlyCount = 0, earlyLateBonus = 0, lateNightCount = 0;
  const earlyScanPaidDates = new Set();
  if (canEarlyLate) {
    const _ln1Thr = S.allowances.lateNightThreshold1Hour || S.allowances.lateNightThresholdHour || 19;
    const _ln2Thr = S.allowances.lateNightThreshold2Hour || S.allowances.lateNightThresholdHour || 20;
    pDays.forEach(d => {
      // Auto early: Hikvision only. Rest days require approved holiday-work, then both pay.
      if (deviceScanQualifiesForEarlyMorning(d, holidayWorkDates)) {
        const [h, m] = d.checkIn.split(':').map(Number);
        const mins = h * 60 + m;
        if (mins <= S.allowances.earlyThreshold2Min) {
          earlyCount += 2; earlyLateBonus += S.allowances.earlyMorning2; earlyScanPaidDates.add(d.date);
        } else if (mins <= S.allowances.earlyThreshold1Min) {
          earlyCount += 1; earlyLateBonus += S.allowances.earlyMorning1; earlyScanPaidDates.add(d.date);
        }
      }
      if (deviceScanQualifiesForLateNight(d, holidayWorkDates)) {
        const lnPts = lateNightPoints(d.lateOut, _ln2Thr);
        lateNightCount += lnPts;
        earlyLateBonus += lnPts === 2 ? S.allowances.lateNight2 : S.allowances.lateNight1;
      }
    });
    approvedEarlyMorning.forEach(l => {
      if (earlyScanPaidDates.has(l.dateFrom)) return;
      if (fullLeaveDates.has(l.dateFrom)) return;
      // 2026-09-23: never paid on an approved Abroad day (a trip approved after the request).
      if (abroadDates.has(l.dateFrom)) return;
      // Rest-day web request pays only with approved holiday-work (user 2026-09-01).
      if (isHolidayWorkDay(l.dateFrom) && !holidayWorkDates.has(l.dateFrom)) return;
      const tier = Number(l.earlyMorningTier) || 0;
      if (tier === 2) { earlyCount += 2; earlyLateBonus += S.allowances.earlyMorning2; }
      else if (tier === 1) { earlyCount += 1; earlyLateBonus += S.allowances.earlyMorning1; }
    });
  }

  const hourlyRate = base / 30 / 8;

  const approvedOTs = canOT ? leaves.filter(l =>
    l.userId === user.id && l.type === 'ot' && l.status === 'approved' &&
    l.dateFrom >= periodStartStr && l.dateFrom <= periodEndStr &&
    !isCompanyTripDay(l.dateFrom)
  ) : [];

  // 2026-07-31: now role-gated at the calc layer (previously ungated here -- only hidden
  // downstream in renderPayslip()/payslipXlsx.js -- so an ineligible role with an approved
  // long-distance leave record would have been paid it silently).
  const approvedLD = isAllowanceEligible(S.allowanceEligibility, user.role, 'longDistance') ? leaves.filter(l =>
    l.userId === user.id && l.type === 'long-distance' && l.status === 'approved' &&
    l.dateFrom >= periodStartStr && l.dateFrom <= periodEndStr &&
    !isCompanyTripDay(l.dateFrom) && !fullLeaveDates.has(l.dateFrom)
  ) : [];
  const longDistanceCount = approvedLD.filter(l => (l.longDistanceAllowance || 0) > 0).length;
  const longDistanceTotal = approvedLD.reduce((sum, l) => sum + (l.longDistanceAllowance || 0), 0);

  // 2026-08-02: was gated on role eligibility only -- eligibility.personalCar (below) has
  // always additionally required user.personalCarEligible===true (mirroring phoneEligible
  // above), so a role-eligible-but-not-flagged employee's XLSX hid the row while grossIncome
  // still silently included the money. Gate matches eligibility.personalCar exactly now.
  const approvedPC = (isAllowanceEligible(S.allowanceEligibility, user.role, 'personalCar') && user.personalCarEligible === true) ? leaves.filter(l =>
    l.userId === user.id && l.type === 'personal-car' && l.status === 'approved' &&
    l.dateFrom >= periodStartStr && l.dateFrom <= periodEndStr &&
    !isCompanyTripDay(l.dateFrom) && !fullLeaveDates.has(l.dateFrom)
  ) : [];
  const personalCarCount = approvedPC.length;
  // l.personalCarRate is a submission-time snapshot (server.js POST /api/leaves always
  // overwrites it from the live rate at approval time, see below) -- the settings fallback here
  // only covers a malformed/legacy record missing the field.
  // 2026-07-31 fix: `||` chains treat a legitimate 0 (an ineligible/refused record, or an admin
  // deliberately zeroing the rate to disable the allowance) as "missing" and substitute the
  // fallback anyway. `!= null` only falls back when the value is truly absent.
  const personalCarTotal = approvedPC.reduce((sum, l) =>
    sum + (l.personalCarRate != null ? l.personalCarRate : (S.allowances.personalCar != null ? S.allowances.personalCar : 1000)), 0);

  let otAmount = 0, otTotalHours = 0;
  let ot15Amount = 0, ot15Hours = 0;
  let ot20Amount = 0, ot20Hours = 0;
  let ot30Amount = 0, ot30Hours = 0;
  const paidHolidayWorkDates = new Set(
    (approvedHolidayWork || []).filter(l => l.compensationMode === 'paid').map(l => l.dateFrom)
  );
  const otPayAcc = {
    otAmount, otTotalHours, ot15Amount, ot15Hours, ot20Amount, ot20Hours, ot30Amount, ot30Hours,
  };
  approvedOTs.forEach(l => {
    if (fullLeaveDates.has(l.dateFrom)) return;
    if (!l.isDriverOT && paidHolidayWorkDates.has(l.dateFrom)) return;
    accumulateApprovedOtPay(l, hourlyRate, otPayAcc);
  });
  otAmount = otPayAcc.otAmount; otTotalHours = otPayAcc.otTotalHours;
  ot15Amount = otPayAcc.ot15Amount; ot15Hours = otPayAcc.ot15Hours;
  ot20Amount = otPayAcc.ot20Amount; ot20Hours = otPayAcc.ot20Hours;
  ot30Amount = otPayAcc.ot30Amount; ot30Hours = otPayAcc.ot30Hours;
  let holidayTransportTotal = 0;
  approvedHolidayWork.forEach(l => {
    if (l.compensationMode !== 'paid') return;
    if (!abroadDates.has(l.dateFrom)) {
      holidayTransportTotal += S.allowances.holidayTransport != null ? S.allowances.holidayTransport : 500;
    }
    const hrs20 = Number(l.otHours20) || 0;
    const hrs30 = Number(l.otHours30) || 0;
    // 2026-09-24 (owner): 2 decimal places, half-up (was whole baht). Dual-sync.
    const amt20 = round2HalfUp(hourlyRate * 2 * hrs20);
    const amt30 = round2HalfUp(hourlyRate * 3 * hrs30);
    ot20Hours += hrs20; ot30Hours += hrs30;
    ot20Amount = round2HalfUp(ot20Amount + amt20); ot30Amount = round2HalfUp(ot30Amount + amt30);
    otAmount = round2HalfUp(otAmount + amt20 + amt30);
    otTotalHours += hrs20 + hrs30;
  });
  // 2026-09-01: guaranteed OT is a driver contract floor only (OT ×1.5 hours/month). Still
  // requires canOT so a driver removed from OT eligibility does not keep the top-up.
  const guaranteedOT = user.guaranteedOT || 0;
  if (user.role === 'driver' && canOT && guaranteedOT > ot15Hours) {
    const extraH = guaranteedOT - ot15Hours;
    // 2026-09-24 (owner): the top-up is OT pay too -- 2 decimal places, half-up. Dual-sync.
    const extraA = round2HalfUp(hourlyRate * 1.5 * extraH);
    ot15Hours += extraH; ot15Amount = round2HalfUp(ot15Amount + extraA); otAmount = round2HalfUp(otAmount + extraA); otTotalHours += extraH;
  }

  const totalUpcountryCount = upcountryCount + holidayWorkUpcountryCount;
  const allowance1 = S.allowances.upcountry * totalUpcountryCount;
  const allowance2 = earlyLateBonus;
  // 2026-09-21 (Abroad): counted off day STATUS, not off the leave record, so the day count is
  // automatically scoped to this pay period and automatically includes the weekends and public
  // holidays inside the trip (the day builder overlays every calendar day of an approved abroad
  // record). MUST stay byte-identical with app.js's copy -- dual-sync rule.
  const abroadEligible = isAllowanceEligible(S.allowanceEligibility, user.role, 'abroad');
  const abroadDays = abroadEligible ? pDays.filter(d => d.status === 'abroad').length : 0;
  const abroadTotal = (S.allowances.abroad || 0) * abroadDays;
  // 2026-09-24: OT is now in satang, so the sum is rounded to 2 dp to drop float noise only.
  const grossIncome = round2HalfUp(base + transport + posAllowance + housingAllowance + diligenceAllowance +
    allowance1 + allowance2 + allowance3val + otAmount + longDistanceTotal + personalCarTotal +
    holidayTransportTotal + abroadTotal);

  // SSO — rate and caps from settings (updates when law changes)
  // SECURITY/CORRECTNESS FIX 2026-08-17 (user report): MD is exempt from SSO/SSF the same way
  // they're already exempt from PVD just below -- this had NO role check at all, only a salary-
  // threshold check, so it only ever computed 0 for the one live MD account by coincidence
  // (their `user.salary` happens to be set to a low placeholder value under the threshold, not
  // because of any code-level protection). A real salary entry would have silently started
  // deducting SSF for an MD. Guard added explicitly, matching the pvdRate pattern immediately
  // below -- MUST stay byte-identical with app.js's copy of this calculation (dual-sync rule).
  const ssoRate = (S.sso.rate || 5) / 100;
  const ssf = user.role === 'md' || base < (S.sso.minSalary || 1650)
    ? 0
    : Math.min(Math.round(base * ssoRate), S.sso.maxAmount || 875);

  // PVD
  const pvdRate = user.role === 'md' ? 0 : (user.pvdRate !== undefined ? user.pvdRate : 5);
  // 2026-09-24 (owner): 1 decimal place, half-up at the 2nd decimal (was whole baht). Dual-sync.
  const pvd = round1HalfUp(base * pvdRate / 100);

  // Progressive income tax (Thai ม.40(1)) — estimate only; Accounting can override before Confirm.
  // 2026-08-23: annualize recurring pay only. Variable items (OT, one-off allowances, bonus,
  // manual income) are added for THIS period and must not be ×12. Dual-sync with app.js.
  const finRec = finalizeData[finKey] || {};
  const bonusForPit = Number(finRec.bonus) || 0;
  const manualIncomeForPit = (finRec.manualAllowances || []).reduce((s, ma) => s + (Number(ma.amount) || 0), 0);
  const regularIncome = base + transport + posAllowance + housingAllowance + diligenceAllowance + allowance3val;
  // 2026-09-21: abroadTotal belongs here too -- it is part of grossIncome, so leaving it out
  // would under-estimate the annual taxable base and therefore the auto-PIT figure.
  const variableIncome = allowance1 + allowance2 + otAmount + longDistanceTotal + personalCarTotal + holidayTransportTotal + abroadTotal + bonusForPit + manualIncomeForPit;
  const annualGross = regularIncome * 12 + variableIncome;
  const expenseDeduct = Math.min(annualGross * 0.5, 100000);
  const personalAllow = S.tax.personalAllowanceAnnual || 60000;
  const annualTaxable = Math.max(0, annualGross - expenseDeduct - personalAllow - ssf * 12 - pvd * 12);
  // 2026-09-24 (owner): tax is kept to 2 decimal places, half-up (was whole baht). Dual-sync.
  const autoPit = round2HalfUp(calcAnnualTax(annualTaxable) / 12);

  return {
    base, transport, posAllowance, housingAllowance, diligenceAllowance,
    allowance1, allowance2, allowance3: allowance3val,
    otAmount, longDistanceTotal, personalCarTotal, holidayTransportTotal,
    abroadDays, abroadTotal,
    grossIncome, ssf, pvd, autoPit,
    upcountryCount: totalUpcountryCount, earlyLateBonus, earlyCount, lateNightCount,
    ot15Amount, ot15Hours, ot20Amount, ot20Hours, ot30Amount, ot30Hours, otTotalHours,
    longDistanceCount, personalCarCount,
    periodStartStr, periodEndStr, hourlyRate, pDays
  };
}

// ===== FREEZING PAID PAYROLL PERIODS (2026-08-01) =====
// getSnapshotKey/deriveAttendanceCounts/getPayrollView must stay logically identical between
// app.js and server.js -- same dual-sync standing rule as computePayroll() itself. Verify with a
// diff before deploying either file (two documented, legitimate divergences: server.js's
// computePayroll() doesn't return approvedOTs/approvedLD/approvedPC the way app.js's does, and
// getPayrollView()'s `display` block is recomputed independently here for that reason -- see below).
function getSnapshotKey(periodStart, userId) {
  const pad2 = n => String(n).padStart(2, '0');
  return `snap_${periodStart.getFullYear()}${pad2(periodStart.getMonth() + 1)}${pad2(periodStart.getDate())}_${userId}`;
}

// Lifts the attendance-summary block this endpoint used to build inline (and app.js's
// renderPayslip() built a near-identical, differently-named version of) into one shared shape,
// so the live path and the frozen-snapshot path can never diverge from each other.
function deriveAttendanceCounts(pDays, calc) {
  return {
    workingDays:   pDays.filter(d => !d.isWeekend && d.status !== 'holiday' && d.status !== 'company-trip').length,
    daysWorked:    pDays.filter(d => d.status === 'present' || d.status === 'late' || d.status === 'not-clocked-in' || d.status === 'abroad').length,
    leaveDays:     pDays.filter(d => d.status === 'leave-annual' || d.status === 'leave-sick' || d.status === 'leave-business').length,
    lateTimes:     pDays.filter(d => d.status === 'late').length,
    otHours:       calc.otTotalHours || 0,
    absentDays:    pDays.filter(d => d.status === 'absent').length,
    paidHoliday:   pDays.filter(d => d.status === 'leave-annual').length,
    sickLeave:     pDays.filter(d => d.status === 'leave-sick').length,
    businessLeave: pDays.filter(d => d.status === 'leave-business').length,
    upcountryCount:  calc.upcountryCount || 0,
    earlyCount:      calc.earlyCount || 0,
    lateNightCount:  calc.lateNightCount || 0,
  };
}

// The single read path every payroll-numbers consumer (payslip web/XLSX/email, Finalize Payroll,
// CSV exports, 50 Tawi, Payroll History) goes through instead of calling computePayroll()
// directly. Once MD has approved a period AND a snapshot exists for it, returns the FROZEN
// numbers captured at that moment -- immune to a later salary raise, Settings edit, or
// attendance/leave record edit. Otherwise builds the identical shape live (what approval will
// snapshot). See migrate_snapshot_approved.js for backfilling periods approved before this existed.
//
// Frozen `fin` is intentionally NOT re-derived from live finalizeData even though edits to
// bonus/pit/manualAllowances/diligencePaid are ALSO blocked once approved (PUT /api/finalize) --
// storing it directly here is defense in depth against that lock ever being bypassed (e.g. a
// direct file edit on the NAS), and is what makes revoke-then-reapprove's superseded[] history
// (POST /api/md-approve) meaningful.
// finalizeDataOverride (2026-08-06, L4 fix): optional pre-read finalize.json snapshot, so a
// caller looping over many users (payslip-xlsx-all) can pass ONE consistent read instead of each
// iteration re-reading the file live -- closes the theoretical torn-read window where an MD
// approval landing mid-loop could make some employees in the same export reflect the old
// live-computed numbers and others the newly-frozen snapshot. Every other caller is unaffected
// (still reads fresh per call, exactly as before).
function getPayrollView(user, start, end, periodIndex, finalizeDataOverride) {
  const finalizeData = finalizeDataOverride || readJSON('finalize.json', {});
  if (finalizeData === null) throw new Error('Service temporarily unavailable');
  const mdApproval = finalizeData[getMdApprovalKey(start, user.id)];
  const snapshot = finalizeData[getSnapshotKey(start, user.id)];
  if (mdApproval?.approved === true && snapshot) {
    return { ...snapshot, frozen: true, approvedBy: mdApproval.approvedBy, approvedAt: mdApproval.approvedAt };
  }

  const S = getAppSettings();
  const calc = computePayroll(user, start, end, periodIndex);
  const attendance = deriveAttendanceCounts(calc.pDays || [], calc);

  const finKey = getFinalizeKey(start, user.id);
  const finRaw = finalizeData[finKey] || {};
  const fin = {
    bonus: finRaw.bonus || 0,
    pit: finRaw.pit !== undefined ? finRaw.pit : calc.autoPit,
    manualAllowances: finRaw.manualAllowances || [],
    diligencePaid: finRaw.diligencePaid !== false,
  };

  const eligibility = {};
  ALLOWANCE_KEYS.forEach(key => { eligibility[key] = isAllowanceEligible(S.allowanceEligibility, user.role, key); });
  eligibility.personalCar = eligibility.personalCar && user.personalCarEligible === true;
  eligibility.phone = eligibility.phone && user.phoneAllowanceEligible === true;

  // UI-only values app.js's web payslip needs that server.js's computePayroll() doesn't return
  // (it omits the raw approved-leave arrays app.js's version returns) -- recomputed independently
  // here rather than widening computePayroll()'s signature, matching this pair's existing "full
  // duplication over a lighter shared approach" rule (see the header comment on computePayroll()).
  const leaves = readLeaves() || [];
  // 2026-09-24: + paid Holiday Work that carries OT hours (its hours/amount were already in calc).
  // Dual-sync with app.js getPayrollView's otCount (calc.holidayWorkOtCount there).
  const hwOtCount = eligibility.holidayWork ? leaves.filter(l =>
    l.userId === user.id && isHolidayWorkOtRecord(l) &&
    l.dateFrom >= calc.periodStartStr && l.dateFrom <= calc.periodEndStr &&
    !isCompanyTripDay(l.dateFrom)
  ).length : 0;
  const otCount = (eligibility.ot ? leaves.filter(l =>
    l.userId === user.id && l.type === 'ot' && l.status === 'approved' &&
    l.dateFrom >= calc.periodStartStr && l.dateFrom <= calc.periodEndStr &&
    !isCompanyTripDay(l.dateFrom)
  ).length : 0) + hwOtCount;
  const firstPC = eligibility.personalCar ? leaves.find(l =>
    l.userId === user.id && l.type === 'personal-car' && l.status === 'approved' &&
    l.dateFrom >= calc.periodStartStr && l.dateFrom <= calc.periodEndStr &&
    !isCompanyTripDay(l.dateFrom)
  ) : null;
  const personalCarRateDisplay = firstPC?.personalCarRate != null
    ? firstPC.personalCarRate : (S.allowances.personalCar != null ? S.allowances.personalCar : 1000);

  // This module's own consumers (XLSX/email) don't read these -- they're captured here because
  // this function is what BUILDS the snapshot app.js's renderPayslip() later reads when frozen,
  // and that side does need them (see the matching comment on app.js's copy).
  const policy = S.lateDeductPolicy;
  let lateDeductMinutes = 0;
  // 2026-08-09 (Opus audit finding 4.1, payroll-facing, dual-sync twin of app.js's copy): this
  // loop used to ignore leave/holiday/company-trip/driver status entirely -- app.js's
  // computeLateDeductMinutes() (the leave-BALANCE deduction) already exempts any day touched by
  // an approved annual/sick/business leave, a company-trip day, a public holiday, or a driver's
  // record, but this SEPARATE payslip-display calculation (the one that actually gets frozen into
  // the MD-approval snapshot) didn't mirror any of that. `d.partialLeave` is truthy exactly on
  // the set of days generatePeriodDays() treats as leave-touched-but-checkIn-kept ('am'/'pm'/
  // 'partial' coverage); a FULL-day leave already wipes `d.checkIn` to null, so it's already
  // excluded by the guard below without needing a separate check.
  if (policy?.enabled && user.role !== 'driver') {
    const effStr = policy.effectiveFromPeriod
      ? `${policy.effectiveFromPeriod.slice(0,4)}-${policy.effectiveFromPeriod.slice(4,6)}-${policy.effectiveFromPeriod.slice(6,8)}` : '';
    const _ws4 = S.workSchedule;
    const stdStartMin4 = (_ws4?.standardStartHour ?? 8) * 60 + (_ws4?.standardStartMinute ?? 30);
    (calc.pDays || []).forEach(d => {
      if (!d.checkIn || d.date < effStr) return;
      // 2026-08-09 (2nd-pass audit finding 4 follow-up, dual-sync twin of app.js): see app.js's
      // copy for the full rationale -- a same-date time-correction record processed after a
      // full-day leave in the overlay loop can restore a real checkIn while status is still a
      // leave status.
      if (d.isPubHoliday || d.status === 'company-trip' || d.partialLeave ||
          ['leave-annual','leave-sick','leave-business','abroad'].includes(d.status)) return;
      const [hh, mm] = d.checkIn.split(':').map(Number);
      const lm = hh * 60 + mm - stdStartMin4;
      if (lm <= 0) return;
      const tier = (policy.tiers || []).find(t => lm >= t.fromMin && lm <= t.toMin);
      if (tier) lateDeductMinutes += tier.deductMin;
    });
  }
  const pvdRate = user.role === 'md' ? 0 : (user.pvdRate !== undefined ? user.pvdRate : 5);

  const company = S.company;
  const periodLabel = `${formatDateEn(start)} to ${formatDateEn(end)}`;
  const paymentDate = getPayDay(end);
  const paymentDateLabel = formatDateEn(paymentDate);

  return {
    calc, attendance, fin, eligibility,
    display: {
      otCount, personalCarRateDisplay, lateDeductMinutes, pvdRate,
      rates: { upcountry: S.allowances.upcountry || 240, longDistance: S.allowances.longDistance, personalCar: S.allowances.personalCar },
      ssoDisplay: { rate: S.sso.rate || 5, maxAmount: S.sso.maxAmount || 875, minSalary: S.sso.minSalary || 1650 },
    },
    labels: { periodLabel, paymentDateLabel, paymentDate, company: { name: company.name, address: company.address, taxId: company.taxId } },
    frozen: false, approvedBy: '', approvedAt: ''
  };
}

// Server-side port of app.js's render50Tawi() aggregation loop (2026-08-17, for GET
// /api/tawi50-xlsx-all) -- same period walk, same guard ORDER (checks saved?.confirmed BEFORE
// calling the expensive getPayrollView()/computePayroll(), never after -- see project memory,
// Part 2 finding G: a naive full loop here is ~610 getPayrollView calls, uncached synchronous file
// reads each), same override resolution semantics via settings.tawi50Overrides. Returns only
// entries with resolved gross > 0 for the year (Part 6 answer 5).
// 2026-08-18 (Opus review finding, corrected): this used to claim MD/isObserver accounts are
// "naturally excluded" because salary is forced to 0 for MD -- that's wrong, grossIncome also
// includes transport/positionAllowance/housing, none of which are role-gated, so an MD with a
// confirmed period WILL clear this gross>0 filter and get a sheet. Confirmed with the user
// (2026-08-18): this is the intended behavior -- MD should receive a 50-Tawi certificate like any
// other employee when they have real income for the year. tawi50Xlsx.js's dedicated A58 checkbox
// for role==='md' only makes sense under this reading. isObserver accounts aren't role-gated
// anywhere in computePayroll() either; they're excluded only if their own gross happens to be 0.
function buildTawi50AnnualTotals(year, finalizeSnapshot) {
  const users = readUsers() || [];
  const overrides = readSettings().tawi50Overrides || {};
  const periodData = {}; // userId -> {totalGross,totalSSO,totalPVD,totalPIT}
  for (let i = 0; i <= 60; i++) {
    const { start, end } = getPeriodBounds(i);
    if (end.getFullYear() < year) break;
    if (end.getFullYear() > year) continue;
    if (start < APP_FIRST_PERIOD_START) break;
    users.forEach(u => {
      if (isSystemAccountUser(u)) return;
      if (!periodData[u.id]) periodData[u.id] = { totalGross: 0, totalSSO: 0, totalPVD: 0, totalPIT: 0 };
      const finKey = getFinalizeKey(start, u.id);
      const saved = finalizeSnapshot[finKey];
      if (!saved?.confirmed) return;
      const view = getPayrollView(u, start, end, i, finalizeSnapshot);
      const bonus = view.fin.bonus;
      const manualIncome = (view.fin.manualAllowances || []).reduce((s, ma) => s + (ma.amount || 0), 0);
      periodData[u.id].totalGross += view.calc.grossIncome + bonus + manualIncome;
      periodData[u.id].totalSSO += view.calc.ssf;
      periodData[u.id].totalPVD += view.calc.pvd;
      periodData[u.id].totalPIT += view.fin.pit;
    });
  }
  const results = [];
  users.forEach(u => {
    if (isSystemAccountUser(u)) return;
    const d = periodData[u.id] || { totalGross: 0, totalSSO: 0, totalPVD: 0, totalPIT: 0 };
    // 2026-09-24 (owner): the amounts actually paid per payslip -- summed, then rounded to 2 dp only
    // to drop float noise (never to whole baht). Dual-sync with app.js render50Tawi.
    d.totalGross = round2HalfUp(d.totalGross); d.totalSSO = round2HalfUp(d.totalSSO);
    d.totalPVD = round2HalfUp(d.totalPVD); d.totalPIT = round2HalfUp(d.totalPIT);
    const overKey = `${year}_${u.id}`;
    const ov = overrides[overKey] || {};
    const gross = ov.grossOverride !== undefined ? ov.grossOverride : d.totalGross;
    const pit = ov.pitOverride !== undefined ? ov.pitOverride : d.totalPIT;
    const sso = ov.ssoOverride !== undefined ? ov.ssoOverride : d.totalSSO;
    const pvd = ov.pvdOverride !== undefined ? ov.pvdOverride : d.totalPVD;
    if (!(gross > 0)) return;
    results.push({ user: u, amounts: { grossIncome: gross, pit, sso, pvd } });
  });
  return results;
}

function getEmailTransport() {
  const cfg = (readSettings().emailConfig) || {};
  if (!cfg.user || !cfg.pass) return null;
  // F-15: derive secure from port: 465 = implicit TLS (secure:true), 587/other = STARTTLS
  // (secure:false). cfg.secure allows explicit override if needed. Previously hardcoded
  // secure:false which silently broke port-465 configs.
  const port = Number(cfg.port) || 587;
  return nodemailer.createTransport({
    host: cfg.host || 'smtp.gmail.com',
    port,
    secure: cfg.secure != null ? !!cfg.secure : port === 465,
    // Gmail's SMTP username is the sender's own email address, so this field used to double as
    // both the auth username and the "From" address (cfg.user, used below in every sendMail's
    // `from:`). Transactional providers like Resend use a fixed literal username ("resend") that
    // is NOT an email address, so cfg.smtpUser lets that be set independently -- falls back to
    // cfg.user when blank, so existing Gmail configs keep working unchanged.
    auth: { user: cfg.smtpUser || cfg.user, pass: cfg.pass }
  });
}

// REWRITTEN 2026-08-13 (Opus audit, P-2/P-3/P-5): the old version (a) printed a "รวมรายได้" total
// that EXCLUDED bonus and manual allowances even though rows above/below it implied otherwise, and
// never showed manual allowances/advance-deductions as line items at all despite them being folded
// into netIncome -- an employee with a bonus or manual allowance literally could not reconcile
// income rows -> total -> net from the numbers printed; (b) computed the period label as
// `start.toLocaleDateString('th-TH', ...)`, which is the WRONG MONTH (labels the pay run by its
// START month, not the month everyone actually calls it -- e.g. a 21 Jul-20 Aug period showed
// "July"), was English-only despite Node here being small-icu (see MONTH_NAMES_EMAIL's comment --
// toLocaleDateString('th-TH',...) silently falls back to en-US instead of throwing), and would
// silently change to Buddhist-era Thai the day anyone rebuilds Node with full ICU; (c) hardcoded
// Thai and bypassed emailShell()/EMAIL_I18N entirely, unlike every other notification in this file,
// so an employee with notifyLangEmail:'en'/'ja' got their payslip in Thai regardless. None of this
// touches the net-income FORMULA (still `grossIncome + bonus + manualIncome - ssf - pvd - pit -
// manualAdvance`, unchanged and dual-sync-correct against app.js's renderPayslip() totalEarn/
// totalDeduct) -- this is a presentation-only rewrite.
function buildPayslipHtml(payslip, lang) {
  const t = EMAIL_I18N[lang] || EMAIL_I18N.th;
  const C = EMAIL_COLORS;
  const fmt = n => Number(n||0).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
  // Income rows: grossIncome is shown as ONE consolidated line (it already bundles base salary,
  // transport/position/housing, diligence, OT, upcountry/early-late/phone allowances, long-distance
  // and personal-car totals -- the web/Excel payslips break these out into their own rows, but this
  // email is a compact notification, not a full replacement for either) plus bonus and each manual
  // allowance with amount>0, so the printed rows ACTUALLY SUM to totalIncome below them.
  const incomeRows = [
    [t.payslipGross, payslip.grossIncome],
    payslip.bonus > 0 ? [t.payslipBonus, payslip.bonus] : null,
    ...payslip.manualAllowances.filter(ma => (ma.amount||0) > 0).map(ma => [escapeHtml(ma.type), ma.amount]),
  ].filter(Boolean);
  const deductRows = [
    [t.payslipSSF, -payslip.ssf],
    [t.payslipPVD, -payslip.pvd],
    [t.payslipPIT, -payslip.pit],
    ...payslip.manualAllowances.filter(ma => (ma.advance||0) > 0).map(ma => [t.payslipAdvance(escapeHtml(ma.type)), -ma.advance]),
  ];
  const rows = [
    ...incomeRows,
    [t.payslipTotalIncome, payslip.totalIncome, true],
    ...deductRows,
    [t.payslipNet, payslip.netIncome, true, true],
  ];
  const rowsHtml = rows.map(([label, val, bold, highlight]) =>
    `<tr style="${highlight ? `background:${C.successBg}` : ''}">
      <td style="padding:9px 4px;border-bottom:1px solid ${C.border};font-size:13.5px;${bold ? 'font-weight:700' : ''};color:${C.text}">${label}</td>
      <td style="padding:9px 4px;border-bottom:1px solid ${C.border};font-size:13.5px;text-align:right;${bold ? 'font-weight:700' : ''}${highlight ? `;color:${C.success}` : ''}">${fmt(val)} ${t.payslipCurrency}</td>
    </tr>`
  ).join('');
  const bodyHtml = `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse">
      ${rowsHtml}
    </table>`;
  return emailShell({
    headerBg: C.primary, headerIcon: '💰', headerTitle: t.payslipTitle,
    headerSubtitle: t.payslipSubtitle(escapeHtml(payslip.employeeName), escapeHtml(payslip.periodLabel)),
    bodyHtml, footerText: t.footer,
  });
}

// SECURITY FIX 2026-08-13 (Opus audit, P-4): no rate limit existed on this endpoint at all --
// combined with P-1 (fixed below), the only real abuse vector left is inbox-spamming an employee
// or burning the SMTP provider's daily quota (which every OTHER notification in this app also
// depends on). Mirrors webScanLimiter's per-account keying pattern.
const sendPayslipLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.user ? `sendpayslip:${req.user.sub}` : ipKeyGenerator(req.ip),
  message: { success:false, message:'Too many payslip emails sent -- please wait before sending more' }
});

// POST /api/send-payslip
// F-16 (2026-07-22): rewritten to accept {to, userId, periodIndex} instead of a client-computed
// {to, payslip} — the server now computes every number itself via computePayroll() and refuses
// to send unless Accounting has actually confirmed this period for this employee in
// finalize.json. This is the real security gate: no unreviewed number ever gets emailed.
// SECURITY FIX 2026-08-13 (Opus audit, P-1): `to` used to be taken from the client body and sent
// to VERBATIM -- the server independently computes a real employee's full salary breakdown here,
// then emailed it wherever the request said, with zero check against that employee's own address
// on file. Every OTHER production email in this file (sendResultEmail(), the digest, etc.) derives
// its recipient server-side from the user record and only ever honours a client `to` on the
// separately-labelled test-* endpoints -- this was the one exception. An md/accounting token (up
// to 30 days old with "remember me", the same exposure window the M1 finding on
// GET /api/payslip-xlsx was about) or an XSS in that session could have exfiltrated any employee's
// full payroll to an arbitrary external address with a single request. The frontend already only
// ever sent `emp.email`, so this closes with zero legitimate regression.
app.post('/api/send-payslip', requireRole('md', 'accounting'), blockSuperAdminPayrollLock, sendPayslipLimiter, async (req, res) => {
  try {
    if (readSettings().payslipEmailEnabled === false) {
      return res.status(403).json({ success:false, code:'PAYSLIP_EMAIL_DISABLED', message:'Payslip email is currently disabled by the administrator' });
    }
    const { userId, periodIndex } = parseBody(req);
    // SECURITY FIX 2026-08-13 (P-6): mirrors POST /api/md-approve's own periodIndex bounds check --
    // this endpoint's `mdApproval` gate happened to fail closed on a garbage value already (an
    // invalid Date produces a key that never matches), so this was defence-in-depth only, not an
    // active hole, but it shouldn't rely on that as an accident.
    if (userId === undefined || !Number.isInteger(periodIndex) || periodIndex < 0 || periodIndex > MAX_PERIOD_INDEX) {
      return res.status(400).json({ success:false, message:`userId and a valid periodIndex (0-${MAX_PERIOD_INDEX}) are required` });
    }
    const users = readUsers() || [];
    const user = users.find(u => u.id === userId);
    if (!user) return res.status(404).json({ success:false, message:'User not found' });
    if (!user.email) return res.status(400).json({ success:false, code:'EMPLOYEE_HAS_NO_EMAIL', message:'This employee has no email address on file' });

    const { start, end } = getPeriodBounds(periodIndex);
    // 2026-08-01: gate aligned on `approved` (was `confirmed`) -- previously an employee could
    // receive their payslip BY EMAIL before Managing Director had approved it, while being
    // blocked from downloading the identical XLSX in the app (that endpoint already required
    // `approved`). Also now reads getPayrollView() instead of computePayroll() + a separate live
    // finalizeData read, so a period MD has approved sends its FROZEN numbers.
    const finForMail = readJSON('finalize.json', {});
    if (finForMail === null) return res.status(503).json({ success:false, message:'Service temporarily unavailable' });
    const mdApproval = finForMail[getMdApprovalKey(start, userId)];
    if (!mdApproval?.approved) {
      return res.status(400).json({ success:false, message:'Payroll for this period has not been approved by the Managing Director yet' });
    }
    const view = getPayrollView(user, start, end, periodIndex);
    const calc = view.calc;
    const pit = view.fin.pit;
    const bonus = view.fin.bonus;
    const manualAllowances = view.fin.manualAllowances || [];
    const manualIncome  = manualAllowances.reduce((s, ma) => s + (ma.amount || 0), 0);
    const manualAdvance = manualAllowances.reduce((s, ma) => s + (ma.advance || 0), 0);
    const totalIncome = calc.grossIncome + bonus + manualIncome;
    const netIncome = totalIncome - calc.ssf - calc.pvd - pit - manualAdvance;

    const lang = emailLangOf(user.notifyLangEmail);
    // SECURITY/CORRECTNESS FIX 2026-08-13 (P-3): was `start.toLocaleDateString('th-TH', {...})` --
    // labels the period by its START month only (wrong: a 21 Jul-20 Aug period is what everyone
    // calls "August"), and unsafe on this NAS's small-icu Node build. fmtEmailDateLong() is the
    // same ICU-safe formatter every other emailed date in this file already uses.
    const periodLabel = `${fmtEmailDateLong(start, lang)} – ${fmtEmailDateLong(end, lang)}`;

    const payslip = {
      employeeName: user.name, periodLabel,
      grossIncome: calc.grossIncome, bonus, manualAllowances,
      totalIncome, ssf: calc.ssf, pvd: calc.pvd, pit, netIncome,
    };

    const transport = getEmailTransport();
    if (!transport) return res.status(503).json({ success:false, message:'Email not configured' });
    const cfg = readSettings().emailConfig || {};
    const t = EMAIL_I18N[lang] || EMAIL_I18N.th;
    await transport.sendMail({
      from: `"${cfg.fromName || 'Time Attendance Application'}" <${cfg.user}>`,
      to: user.email,
      subject: t.payslipSubject(user.name, periodLabel),
      html: buildPayslipHtml(payslip, lang)
    });
    // 2026-08-13 (P-4): no employee-identifying figures beyond userId in the log line any more --
    // server.log is 0644 (outside the web root, so not remotely reachable, but still local-fs
    // readable) and previously logged grossIncome/ssf/pvd/pit/netIncome in plaintext on every send.
    console.log('[EMAIL] payslip sent', JSON.stringify({ userId: user.id, periodIndex }));
    res.json({ success:true });
  } catch(e) {
    console.error('[EMAIL] send-payslip error:', e.message);
    res.status(500).json({ success:false, message: e.message });
  }
});

const STAFF_ROLES = ['user', 'driver', 'manager', 'marketing'];

// GET /api/payslip-xlsx?userId=&periodIndex=
// Real .xlsx export (SUM/IF formulas, not hardcoded numbers) built server-side via exceljs --
// see payslipXlsx.js for the layout, agreed with the user 2026-07-23. Visibility mirrors the
// frontend's renderPayslip() gate (app.js ~5762-5819): staff can only fetch their own payslip,
// and only once MD has approved it AND (current period only) pay day has arrived. MD/Accounting
// can fetch any employee's payslip anytime, no gate -- same rule as /api/send-payslip's caller
// restriction, just opened up to self-service for the employee viewing their own data.
app.get('/api/payslip-xlsx', async (req, res) => {
  try {
    const userId = parseInt(req.query.userId);
    const periodIndex = parseInt(req.query.periodIndex || '0');
    if (!userId) return res.status(400).json({ success:false, message:'userId required' });
    if (!Number.isInteger(periodIndex) || periodIndex < 0 || periodIndex > MAX_PERIOD_INDEX) {
      return res.status(400).json({ success:false, message:`periodIndex must be 0-${MAX_PERIOD_INDEX}` });
    }

    // SECURITY FIX 2026-08-05 (Opus audit, M1): this used to fall back to the JWT's frozen
    // `req.user.role` when `live` was missing (a deleted account keeps working with its old role
    // until the token expires -- the exact anti-pattern `requireRole()` above was hardened
    // against on 2026-08-02) AND had NO isObserver/active check at all for the md/accounting
    // ("not staff") branch, unlike every other admin-gated endpoint in this file. Confirmed a real
    // account in production sits exactly in that gap: id 1 (Daiki Katagiri), role:'md',
    // active:false, isObserver:true -- with a still-valid token (up to 30 days with "remember
    // me"), that account could download every employee's salary/allowances/net pay via this
    // endpoint with zero restriction. Now mirrors requireRole()'s exact check.
    const users = readUsers() || [];
    const live = users.find(u => u.id === req.user.sub);
    if (!live) return res.status(403).json({ success:false, message:'Forbidden: user record not found' });
    const role = live.role;
    const isStaff = STAFF_ROLES.includes(role);

    if (isStaff && userId !== req.user.sub) {
      return res.status(403).json({ success:false, message:'Forbidden' });
    }
    if (!isStaff && (live.isObserver || live.active === false)) {
      return res.status(403).json({ success:false, message:'Forbidden: observer or inactive account' });
    }

    const user = users.find(u => u.id === userId);
    if (!user) return res.status(404).json({ success:false, message:'User not found' });

    const { start, end } = getPeriodBounds(periodIndex);

    // Read regardless of isStaff (not just inside the gate check below) -- MD/accounting
    // fetching someone else's payslip skip the gate entirely, but still need mdApproval.approvedBy
    // for the "Paid by" signature name.
    const mdKey = getMdApprovalKey(start, userId);
    const finForXlsx = readJSON('finalize.json', {});
    if (finForXlsx === null) return res.status(503).json({ success:false, message:'Service temporarily unavailable' });
    const mdApproval = finForXlsx[mdKey];

    if (isStaff) {
      const mdApproved = !!(mdApproval?.approved);
      const payDay = getPayDay(end);
      const today = bangkokTodayDate();
      const isCurrent = periodIndex === 0;
      if (!mdApproved || (isCurrent && today < payDay)) {
        return res.status(403).json({ success:false, message:'Payslip not yet available for this period' });
      }
    }

    // 2026-08-01: routed through getPayrollView() instead of computePayroll() + separate live
    // finalizeData/attendance/eligibility computation inline -- once MD has approved this
    // period, this now reads the FROZEN snapshot from approval time.
    const view = getPayrollView(user, start, end, periodIndex);

    const wb = buildPayslipWorkbook({
      companyInfo: { name: view.labels.company.name, address: view.labels.company.address, taxId: view.labels.company.taxId, branch: 'Thailand Head Office' },
      user: { name: user.name, position: user.position || '', role: user.role, startDate: user.startDate ? formatDateEn(new Date(user.startDate)) : '', idCard: user.idCard || '' },
      calc: view.calc,
      fin: { bonus: view.fin.bonus, pit: view.fin.pit, manualAllowances: view.fin.manualAllowances },
      period: { label: view.labels.periodLabel, paymentDateLabel: view.labels.paymentDateLabel, paymentDate: (view.labels.paymentDate instanceof Date ? view.labels.paymentDate : getPayDay(end)) },
      // 2026-08-02: otCount (number of approved OT requests, not hours) added for the Attendance
      // Summary's Over Time tile -- per user request that tile shows a count like every other
      // tile in that grid (Late/Upcountry/Early Morning/Late Night), not raw hours; the hours
      // themselves no longer appear anywhere in this file (Calculation Details moved to the web
      // Payslip page only, see payslipXlsx.js).
      attendance: { ...view.attendance, otCount: view.display.otCount },
      // 2026-08-01 (bug fix): guard on `approved`, not just presence of approvedBy -- a revoked
      // approval (md_ key deleted, see POST /api/md-approve) must not leave a stale signature.
      // app.js's renderPayslip() already had this guard; server.js's copy didn't (a live
      // dual-sync divergence, fixed here).
      approvedBy: view.frozen ? view.approvedBy : '',
      eligibility: view.eligibility,
    });
    const periodLabel = view.labels.periodLabel;

    const safeName = String(user.name || 'payslip').replace(/[^a-z0-9]+/gi, '_');
    const safePeriod = periodLabel.replace(/[^a-z0-9]+/gi, '_');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="Payslip_${safeName}_${safePeriod}.xlsx"`);
    await wb.xlsx.write(res);
    res.end();
  } catch (e) {
    console.error('[XLSX] payslip-xlsx error:', e.message);
    res.status(500).json({ success:false, message: e.message });
  }
});

// GET /api/payslip-xlsx-all?periodIndex= (2026-08-02) -- every active employee's payslip in ONE
// .xlsx, one sheet per employee (payslipXlsx.js's workbook/sheetName params, added the same
// session, let buildPayslipWorkbook() append to a shared workbook instead of always creating its
// own). Accounting/MD only -- no staff self-service angle here, this is a bulk admin export.
app.get('/api/payslip-xlsx-all', requireRole('md', 'accounting'), async (req, res) => {
  try {
    const periodIndex = parseInt(req.query.periodIndex || '0');
    if (!Number.isInteger(periodIndex) || periodIndex < 0 || periodIndex > MAX_PERIOD_INDEX) {
      return res.status(400).json({ success:false, message:`periodIndex must be 0-${MAX_PERIOD_INDEX}` });
    }
    const { start, end } = getPeriodBounds(periodIndex);
    const users = employeeActiveRecords(readUsers() || []);
    if (!users.length) return res.status(404).json({ success:false, message:'No active employees' });
    // L4 fix: one finalize.json read for the whole export (see getPayrollView's
    // finalizeDataOverride comment) instead of one fresh read per employee inside the loop below.
    const finalizeSnapshot = readJSON('finalize.json', {});
    if (finalizeSnapshot === null) return res.status(503).json({ success:false, message:'Service temporarily unavailable' });

    // Excel sheet names: max 31 chars, can't contain \ / ? * [ ] : , can't start/end with a single
    // quote, can't be the literal name "History" (case-insensitive), can't repeat within a
    // workbook (ExcelJS's own dedupe check is ALSO case-insensitive). MD's sheet uses just the
    // last name (2026-08-02, user request -- "Toshifumi Takiuchi" -> "Takiuchi"; only Takiuchi is
    // actually active as MD in production today, but this is written as a general role rule, not
    // a hardcoded name, so it stays correct if that ever changes) -- every other role uses the
    // full name.
    // BUG FIX 2026-08-05 (Opus audit, H2): this used to (1) call `.trim()` on `u.name` before the
    // `|| fallback`, so a null/undefined name on an MD threw a TypeError and 500'd the whole
    // export; (2) dedupe with a case-SENSITIVE Set while ExcelJS's own duplicate check is
    // case-insensitive, so two names differing only by case passed this function's check and then
    // threw inside `addWorksheet()` -- aborting the entire export, so NO employee got a payslip,
    // not even the ones already written before the collision; (3) the "(2)" dedupe suffix could
    // push the final name to 32 chars (one over the 31-char limit), which ExcelJS silently
    // truncates, desyncing `usedNames` from the sheet's real name; (4) never guarded against a
    // leading/trailing single-quote or the reserved name "History", both of which also throw.
    const usedNamesLower = new Set();
    const RESERVED_SHEET_NAMES = new Set(['history']);
    const sheetNameFor = (u) => {
      const base = (u.role === 'md' ? (u.name || '').trim().split(/\s+/).pop() : u.name) || `Employee ${u.id}`;
      let clean = String(base).replace(/[\\/?*[\]:]/g, '').replace(/^'+|'+$/g, '').trim().slice(0, 31) || `Employee ${u.id}`;
      if (RESERVED_SHEET_NAMES.has(clean.toLowerCase())) clean = `${clean}_`;
      let name = clean, n = 2;
      while (usedNamesLower.has(name.toLowerCase())) {
        const suffix = ` (${n})`;
        name = clean.slice(0, 31 - suffix.length) + suffix;
        n++;
      }
      usedNamesLower.add(name.toLowerCase());
      return name;
    };

    const wb = new ExcelJS.Workbook();
    let periodLabelSafe = 'period';
    for (const user of users) {
      const view = getPayrollView(user, start, end, periodIndex, finalizeSnapshot);
      periodLabelSafe = view.labels.periodLabel.replace(/[^a-z0-9]+/gi, '_');
      buildPayslipWorkbook({
        companyInfo: { name: view.labels.company.name, address: view.labels.company.address, taxId: view.labels.company.taxId, branch: 'Thailand Head Office' },
        user: { name: user.name, position: user.position || '', role: user.role, startDate: user.startDate ? formatDateEn(new Date(user.startDate)) : '', idCard: user.idCard || '' },
        calc: view.calc,
        fin: { bonus: view.fin.bonus, pit: view.fin.pit, manualAllowances: view.fin.manualAllowances },
        period: { label: view.labels.periodLabel, paymentDateLabel: view.labels.paymentDateLabel, paymentDate: (view.labels.paymentDate instanceof Date ? view.labels.paymentDate : getPayDay(end)) },
        attendance: { ...view.attendance, otCount: view.display.otCount },
        approvedBy: view.frozen ? view.approvedBy : '',
        eligibility: view.eligibility,
        workbook: wb,
        sheetName: sheetNameFor(user),
      });
    }

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="Payslips_All_${periodLabelSafe}.xlsx"`);
    await wb.xlsx.write(res);
    res.end();
  } catch (e) {
    console.error('[XLSX] payslip-xlsx-all error:', e.message);
    res.status(500).json({ success:false, message: e.message });
  }
});

// GET /api/tawi50-xlsx-all?year= (2026-08-17) -- official 50-Tawi (มาตรา 50 ทวิ) withholding-tax
// certificate export, one sheet per employee, modelled line-for-line on payslip-xlsx-all just
// above (role gate, year validation, one finalize.json read for the whole export, sheetNameFor()'s
// hardening reused verbatim). Architecture decision (Part 3, project memory): compute server-side
// via buildTawi50AnnualTotals(), same "server computes every number itself" precedent as
// send-payslip's F-16/P-1 fixes -- no client-supplied figure is ever exported to a government tax
// document. Only employees with resolved gross > 0 for the year get a sheet (see
// buildTawi50AnnualTotals's own comment).
app.get('/api/tawi50-xlsx-all', requireRole('md', 'accounting'), async (req, res) => {
  try {
    const year = parseInt(req.query.year);
    const nowYear = new Date().getFullYear();
    if (!Number.isInteger(year) || year < 2020 || year > nowYear + 1) {
      return res.status(400).json({ success:false, message:'invalid year' });
    }
    const finalizeSnapshot = readJSON('finalize.json', {});
    if (finalizeSnapshot === null) return res.status(503).json({ success:false, message:'Service temporarily unavailable' });
    const entries = buildTawi50AnnualTotals(year, finalizeSnapshot);
    if (!entries.length) return res.status(404).json({ success:false, message:'No employees with income for this year' });

    const company = getAppSettings().company;
    const issueDate = new Date();

    // Same sheet-naming hardening as payslip-xlsx-all above (max 31 chars, forbidden chars, no
    // leading/trailing quote, no reserved "History" name, case-insensitive dedupe) -- reused
    // verbatim rather than factored into a shared helper, matching this codebase's existing
    // "full duplication over a lighter shared approach" convention for these two sibling routes.
    const usedNamesLower = new Set();
    const RESERVED_SHEET_NAMES = new Set(['history']);
    const sheetNameFor = (u) => {
      const base = (u.role === 'md' ? (u.name || '').trim().split(/\s+/).pop() : u.name) || `Employee ${u.id}`;
      let clean = String(base).replace(/[\\/?*[\]:]/g, '').replace(/^'+|'+$/g, '').trim().slice(0, 31) || `Employee ${u.id}`;
      if (RESERVED_SHEET_NAMES.has(clean.toLowerCase())) clean = `${clean}_`;
      let name = clean, n = 2;
      while (usedNamesLower.has(name.toLowerCase())) {
        const suffix = ` (${n})`;
        name = clean.slice(0, 31 - suffix.length) + suffix;
        n++;
      }
      usedNamesLower.add(name.toLowerCase());
      return name;
    };

    const wb = new ExcelJS.Workbook();
    for (const { user, amounts } of entries) {
      buildTawi50Workbook({
        company,
        employee: {
          name: user.name, namePrefix: user.namePrefix, firstNameTh: user.firstNameTh,
          lastNameTh: user.lastNameTh, idCardAddress: user.idCardAddress, idCard: user.idCard,
          idType: user.idType, employeeNo: user.employeeNo, role: user.role,
        },
        amounts,
        seq: user.employeeNo || '',
        year,
        issueDate,
        pvdLicenseNo: company.pvdLicenseNo,
        ssoEmployerAccountNo: company.ssoEmployerAccountNo,
        workbook: wb,
        sheetName: sheetNameFor(user),
      });
    }

    // 2026-08-17: no employee-identifying data in the log line, same P-4 log-hygiene precedent as
    // send-payslip above.
    console.log('[XLSX] tawi50-xlsx-all', JSON.stringify({ year, sheets: entries.length }));
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="50Tawi_${year}.xlsx"`);
    await wb.xlsx.write(res);
    res.end();
  } catch (e) {
    console.error('[XLSX] tawi50-xlsx-all error:', e.message);
    res.status(500).json({ success:false, message: e.message });
  }
});

// SECURITY FIX 2026-08-13 (Opus audit, F-2): `to` on all three test-* endpoints below used to be
// passed straight to nodemailer with zero shape validation. nodemailer/SMTP treats a comma-
// separated string as MULTIPLE recipients, so an unbounded `to` was really an unbounded recipient
// LIST -- worst case on test-result-notification, which sends 9 emails per call, each fanning out
// to however many addresses the string contained. Rejects anything that isn't a single plausible
// address (no comma/semicolon/whitespace/newline, bounded length, loose format check -- loose is
// deliberate: the whole point of test-email is trying arbitrary real destinations, this should
// catch abuse shapes and typos, not enforce strict RFC 5322).
function normalizeTestRecipient(to) {
  if (typeof to !== 'string') return null;
  const trimmed = to.trim();
  if (!trimmed || trimmed.length > 254) return null;
  if (/[,;\r\n\s]/.test(trimmed)) return null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(trimmed)) return null;
  return trimmed;
}
// SECURITY FIX 2026-08-13 (Opus audit, F-3): none of the three had any rate limit -- requireRole()
// alone isn't enough against a stolen/XSS'd md-or-accounting token, only against an untrusted
// role. test-result-notification alone is 9 sendMail() calls per request with zero backoff, and
// exhausting the SMTP provider's daily quota this way takes down every OTHER notification this
// app depends on (leave-approval results, the real pending digest, payslip email). Per-account
// keying, same shape as today's sendPayslipLimiter -- single office behind one NAT, IP-keying
// would punish everyone on one bad actor's token.
const testEmailLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.user ? `testemail:${req.user.sub}` : ipKeyGenerator(req.ip),
  message: { success:false, message:'Too many test emails -- please wait before sending more' }
});

// POST /api/test-email
app.post('/api/test-email', requireRole('md', 'accounting'), testEmailLimiter, async (req, res) => {
  try {
    const { to } = parseBody(req);
    const recipient = to ? normalizeTestRecipient(to) : null;
    if (to && !recipient) return res.status(400).json({ success:false, message:'to must be a single valid email address' });
    const transport = getEmailTransport();
    if (!transport) return res.status(503).json({ success:false, message:'Email not configured' });
    const cfg = readSettings().emailConfig || {};
    await transport.sendMail({
      from: `"${cfg.fromName || 'Time Attendance Application'}" <${cfg.user}>`,
      to: recipient || cfg.user,
      subject: 'ทดสอบการส่งอีเมล — ระบบ Time Attendance',
      html: '<div style="font-family:sans-serif;padding:20px"><h3>✅ ส่งอีเมลสำเร็จ</h3><p>การตั้งค่า SMTP ใช้งานได้ปกติ</p></div>'
    });
    res.json({ success:true });
  } catch(e) {
    res.status(500).json({ success:false, message: e.message });
  }
});

// POST /api/test-pending-notification — manual trigger for testing the pending-approval digest
// email's layout/template. Always sends to the single `to` address given.
// SECURITY FIX 2026-08-13 (Opus audit, F-1): this used to have a second mode -- when `sample`
// wasn't truthy, it read and emailed out the REAL current pending-approval queue (every pending
// requester's name, request type incl. sick/maternity/ordain leave, dates, and how long it's been
// stuck) to whatever `to` the request gave, completely bypassing the recipient allowlist in
// Settings -> emailNotification.recipients that the real cron-triggered digest (see the `else`
// branch of runPendingApprovalNotification()) always goes through. A stolen/XSS'd md-or-accounting
// token was a one-request channel to exfiltrate that queue externally. The sample path exercises
// the IDENTICAL rendering pipeline (runPendingApprovalNotification -> buildStageGroups ->
// buildPendingEmailHtml -> emailShell -> sendMail) and proves everything this test tool exists to
// prove -- nothing here calls this endpoint with real data on purpose (grep confirms `app.js` has
// no caller for this endpoint at all), so the real-data mode bought nothing legitimate. Always
// sample now; the `sample` flag from the request body is no longer read.
app.post('/api/test-pending-notification', requireRole('md', 'accounting'), testEmailLimiter, async (req, res) => {
  try {
    const { to, lang } = parseBody(req);
    const recipient = normalizeTestRecipient(to);
    if (!recipient) return res.status(400).json({ success:false, message:'to must be a single valid email address' });
    // one item at each of the 3 approval stages, across 2 different requesters at the manager
    // stage so the grouped-by-person layout actually has something to group. Never written to
    // leaves.json.
    // SECURITY/HYGIENE FIX 2026-08-13 (Opus audit, F-5): was 4 real employees' names hardcoded
    // here and resolved through readUsers() -- harmless (this endpoint always sends to the
    // caller-controlled `to`, and every real digest recipient already sees these names anyway),
    // but gratuitous: synthetic names exercise the exact same template with nothing real in it.
    // Also removes the "falls back to users[0] once the named employee leaves the company"
    // footgun the old uid() helper had (several sample rows silently collapsing onto whoever is
    // first in users.json).
    const now = Date.now();
    const sampleLeaves = [
      { userId: -1, _empName: '[Sample] Somchai A.', type:'annual', status:'pending', dateFrom:'2026-08-10', dateTo:'2026-08-11', serverCreatedAt: new Date(now - 2*86400000).toISOString() },
      { userId: -2, _empName: '[Sample] Suda B.', type:'ot', status:'pending', dateFrom:'2026-08-07', dateTo:'2026-08-07', serverCreatedAt: new Date(now - 1*86400000).toISOString() },
      { userId: -3, _empName: '[Sample] Prasert C.', type:'business', status:'pending-md', dateFrom:'2026-08-12', dateTo:'2026-08-12', serverCreatedAt: new Date(now - 3*86400000).toISOString() },
      { userId: -4, _empName: '[Sample] Ananya D.', type:'sick', status:'pending-accounting', dateFrom:'2026-08-06', dateTo:'2026-08-06', serverCreatedAt: new Date(now).toISOString() },
    ];
    const result = await runPendingApprovalNotification(recipient, lang, sampleLeaves);
    res.json({ success: result.sent, ...result });
  } catch(e) {
    res.status(500).json({ success:false, message: e.message });
  }
});

// POST /api/test-result-notification (2026-08-06, test-only, mirrors the pattern above) -- sends
// a representative sample of the real request-RESULT email (sendResultEmail(), the one fired by
// notifyLeaveStatusChange() when MD/manager approves or rejects a leave/OT/etc. request) across
// several request types and both outcomes, all routed to the single `to` address given via
// overrideTo/overrideLang (bypasses the target user's real email/emailNotifyOnResult/notifyLang
// settings entirely -- this never touches leaves.json, every "leave" object here is built
// in-memory only and discarded after the email is sent).
app.post('/api/test-result-notification', requireRole('md', 'accounting'), testEmailLimiter, async (req, res) => {
  try {
    const { to, lang, userId } = parseBody(req);
    const recipient = normalizeTestRecipient(to);
    if (!recipient) return res.status(400).json({ success:false, message:'to must be a single valid email address' });
    const users = readUsers() || [];
    // SECURITY/CORRECTNESS FIX 2026-08-13 (Opus audit, F-4): was `userId != null ? userId :
    // (users.find(u => u.email === to)?.id ?? users[0]?.id)` -- an unresolvable userId (or an
    // omitted one whose `to` doesn't match any real employee's email) silently fell back to
    // `users[0]`, whichever employee happens to be first in users.json, rather than failing. The
    // template itself never actually prints that employee's name (verified: sendResultEmail()'s
    // detail rows come entirely from the fake `leave` object below), so this was a confusing UX
    // footgun rather than a real data leak -- but it also meant a genuinely-unresolvable id sailed
    // through here and crashed later inside sendResultEmail() (see that function's own F-4 fix)
    // with a raw TypeError after the first email had already sent. Require it to resolve, or 400
    // up front before anything is sent.
    const targetUserId = userId != null ? userId : users.find(u => u.email === recipient)?.id;
    if (targetUserId == null || !users.some(u => u.id === targetUserId)) {
      return res.status(400).json({ success:false, message:'userId must be provided and match a real employee' });
    }
    const today = new Date().toISOString().slice(0, 10);
    const variants = [
      { type:'annual', status:'approved', dateFrom: today, dateTo: today, reason:'Family trip' },
      { type:'annual', status:'rejected', dateFrom: today, dateTo: today, reason:'Family trip' },
      { type:'sick', status:'approved', dateFrom: today, dateTo: today, reason:'Fever' },
      { type:'ot', status:'approved', dateFrom: today, dateTo: today, otHours: 3, otEndTime:'20:30', reason:'Month-end closing' },
      { type:'late-out', status:'approved', dateFrom: today, dateTo: today, lateOutTime:'21:15', reason:'Client deliverable' },
      { type:'upcountry', status:'approved', dateFrom: today, dateTo: today, reason:'Client site — Rayong' },
      { type:'long-distance', status:'approved', dateFrom: today, dateTo: today, mileageStart: 12000, mileageEnd: 12280, distanceKm: 280 },
      { type:'time-correction', status:'approved', dateFrom: today, dateTo: today, correctedTime:'08:05', reason:'Forgot to scan in' },
      { type:'holiday-work', status:'approved', dateFrom: today, dateTo: today,
        compensationMode:'annual-leave', workStartTime:'08:00', workEndTime:'17:30',
        locations:[{ name:'Client site' }], days:1, reason:'Worked Saturday for client launch' },
      { type:'personal-car', status:'approved', dateFrom: today, dateTo: today, personalCarRate: 1000, reason:'Site visit — own car' },
    ];
    let sent = 0;
    for (const v of variants) {
      await sendResultEmail({ userId: targetUserId, ...v }, recipient, lang || 'en');
      sent++;
    }
    res.json({ success:true, sent, total: variants.length });
  } catch(e) {
    res.status(500).json({ success:false, message: e.message });
  }
});

// ===== NOTIFICATION CRON =====
let _cronJob = null;

const TYPE_LABELS = {
  annual:              { th:'ลาพักร้อน',               en:'Annual Leave',          ja:'有給休暇' },
  sick:                { th:'ลาป่วย',                  en:'Sick Leave',            ja:'病気休暇' },
  business:            { th:'ลากิจ',                   en:'Business Leave',        ja:'業務休暇' },
  maternity:           { th:'ลาคลอด',                  en:'Maternity Leave',       ja:'産休' },
  ordain:              { th:'ลาบวช',                   en:'Ordination Leave',      ja:'出家休暇' },
  'holiday-work':      { th:'ขอทำงานวันหยุด',            en:'Holiday Work',          ja:'休日出勤' },
  'early-morning':     { th:'ขอแจ้งมาเช้า',              en:'Early Morning',         ja:'早朝手当' },
  ot:                  { th:'ขอ OT',                   en:'Request OT',            ja:'残業申請' },
  'driver-ot':         { th:'ขอ OT (คนขับ)',            en:'Driver OT',             ja:'運転手残業' },
  trip:                { th:'ไปต่างจังหวัด',            en:'Business Trip',         ja:'出張' },
  upcountry:           { th:'Upcountry',                en:'Upcountry',             ja:'出張' },
  'late-out':          { th:'แจ้งกลับดึก',              en:'Late Night Out',        ja:'深夜残業' },
  'time-correction':   { th:'ขอแก้ไขเวลาย้อนหลัง',       en:'Time Correction',       ja:'時刻修正' },
  'long-distance':     { th:'แจ้ง Long Distance',       en:'Long Distance',         ja:'長距離' },
  'personal-car':      { th:'แจ้งใช้รถส่วนตัว',         en:'Personal Car',          ja:'自家用車' },
  'clear-attachments': { th:'ล้างไฟล์แนบเก่า',           en:'Clear Old Attachments', ja:'古い添付ファイルを削除' }
};
function getTypeLabel(type, lang) {
  const l = emailLangOf(lang);
  const t = TYPE_LABELS[type];
  // SECURITY FIX 2026-08-13 (re-audit, F-2 defense-in-depth): raw `type` was interpolated unescaped
  // into the result-notification email's HTML header (sendResultEmail() above). POST/PUT /api/leaves
  // now whitelist `type` against VALID_LEAVE_TYPES, so this fallback should be unreachable for any
  // new record -- escaped anyway for any legacy/pre-fix record still carrying a bogus type.
  return t ? t[l] : escapeHtml(String(type));
}

const EMAIL_I18N = {
  th: {
    digestTitle: '🔔 แจ้งเตือนคำขอค้างอนุมัติ',
    digestSubject: n => `🔔 แจ้งเตือน: มีคำขอค้างอนุมัติ ${n} รายการ ใน Time Attendance Application`,
    sectionManager: n => `⏳ รอการอนุมัติจาก Manager (${n} รายการ)`,
    sectionMd: n => `⏳ รอการอนุมัติจาก Managing Director (${n} รายการ)`,
    sectionAccounting: n => `⏳ รอการอนุมัติจาก Accounting (${n} รายการ)`,
    colType: 'ประเภท', colDate: 'วันที่', colRequested: 'ยื่นคำขอเมื่อ', colPending: 'ค้างมา',
    daysSuffix: d => `${d} วัน`,
    footer: 'อีเมลนี้ส่งโดยระบบอัตโนมัติ — กรุณาอย่าตอบกลับ',
    resultSubject: approved => approved ? '✅ คำขอของคุณได้รับการอนุมัติ' : '❌ คำขอของคุณไม่ได้รับการอนุมัติ',
    resultApproved: 'คำขอนี้ได้รับการอนุมัติแล้ว',
    resultRejected: 'คำขอนี้ไม่ได้รับการอนุมัติ',
    resultSubjectRevoked: '↩️ คำขอของคุณถูกเพิกถอนการอนุมัติ', resultRevoked: 'ถูกเพิกถอนการอนุมัติ',
    lblRevokedBy: 'เพิกถอนโดย', lblRevokeReason: 'เหตุผลที่เพิกถอน', lblAlsoRevoked: 'เพิกถอนพร้อมกัน',
    lblDate: 'วันที่', lblReturnTime: 'เวลาที่กลับ', lblLocation: 'สถานที่ / ลูกค้า',
    lblMileage: 'เลขไมล์', lblDistance: 'ระยะทาง', lblWorkedDate: 'วันที่ไปทำงาน',
    lblCorrectedTime: 'เวลาที่แก้ไข', lblOtHours: 'ชั่วโมง OT', lblRate: 'อัตรา', lblReason: 'เหตุผล', lblRequestedBy: 'ผู้ขอ',
    payslipTitle: 'สลิปเงินเดือน', payslipSubject: (name, period) => `สลิปเงินเดือน ${period} — ${name}`,
    payslipGross: 'เงินเดือนและเบี้ยเลี้ยงต่างๆ', payslipBonus: 'โบนัส', payslipTotalIncome: 'รวมรายได้',
    payslipSSF: 'ประกันสังคม', payslipPVD: 'กองทุนสำรองเลี้ยงชีพ', payslipPIT: 'ภาษีหัก ณ ที่จ่าย',
    payslipAdvance: type => `เบิกล่วงหน้า — ${type}`, payslipNet: 'รายได้สุทธิ',
    payslipCurrency: 'บาท', payslipSubtitle: (name, period) => `${name} — งวด ${period}`,
  },
  en: {
    digestTitle: '🔔 Pending Approval Notification',
    digestSubject: n => `🔔 Notification: ${n} request(s) pending approval in Time Attendance Application`,
    sectionManager: n => `⏳ Pending from Manager (${n})`,
    sectionMd: n => `⏳ Pending from Managing Director (${n})`,
    sectionAccounting: n => `⏳ Pending from Accounting (${n})`,
    colType: 'Type', colDate: 'Date', colRequested: 'Requested On', colPending: 'Pending for',
    daysSuffix: d => `${d} day${d === 1 ? '' : 's'}`,
    footer: 'This email was sent automatically — please do not reply.',
    resultSubject: approved => approved ? '✅ Your request has been approved' : '❌ Your request was not approved',
    resultApproved: 'This request has been approved.',
    resultRejected: 'This request was not approved.',
    resultSubjectRevoked: '↩️ The approval of your request was revoked', resultRevoked: 'Approval revoked',
    lblRevokedBy: 'Revoked by', lblRevokeReason: 'Reason for revoking', lblAlsoRevoked: 'Also revoked',
    lblDate: 'Date', lblReturnTime: 'Return time', lblLocation: 'Location / Client',
    lblMileage: 'Mileage', lblDistance: 'Distance', lblWorkedDate: 'Worked on',
    lblCorrectedTime: 'Corrected time', lblOtHours: 'OT hours', lblRate: 'Rate', lblReason: 'Reason', lblRequestedBy: 'Requested by',
    payslipTitle: 'Payslip', payslipSubject: (name, period) => `Payslip ${period} — ${name}`,
    payslipGross: 'Salary & Allowances', payslipBonus: 'Bonus', payslipTotalIncome: 'Total Income',
    payslipSSF: 'Social Security (SSF)', payslipPVD: 'Provident Fund (PVD)', payslipPIT: 'Income Tax (PIT)',
    payslipAdvance: type => `Advance — ${type}`, payslipNet: 'Net Income',
    payslipCurrency: 'THB', payslipSubtitle: (name, period) => `${name} — ${period}`,
  },
  ja: {
    digestTitle: '🔔 承認待ちリクエストのお知らせ',
    digestSubject: n => `🔔 お知らせ：承認待ちのリクエストが${n}件あります（Time Attendance Application）`,
    sectionManager: n => `⏳ Manager承認待ち（${n}件）`,
    sectionMd: n => `⏳ 専務承認待ち（${n}件）`,
    sectionAccounting: n => `⏳ Accounting承認待ち（${n}件）`,
    colType: '種類', colDate: '日付', colRequested: '申請日', colPending: '経過日数',
    daysSuffix: d => `${d}日`,
    footer: 'このメールは自動送信されています。返信しないでください。',
    resultSubject: approved => approved ? '✅ 申請が承認されました' : '❌ 申請は承認されませんでした',
    resultApproved: 'この申請は承認されました。',
    resultRejected: 'この申請は承認されませんでした。',
    resultSubjectRevoked: '↩️ 申請の承認が取り消されました', resultRevoked: '承認取り消し',
    lblRevokedBy: '取り消した人', lblRevokeReason: '取り消しの理由', lblAlsoRevoked: '同時に取り消された申請',
    lblDate: '日付', lblReturnTime: '帰宅時間', lblLocation: '場所 / 訪問先',
    lblMileage: '走行距離', lblDistance: '距離', lblWorkedDate: '出勤日',
    lblCorrectedTime: '修正後の時刻', lblOtHours: '残業時間', lblRate: 'レート', lblReason: '理由', lblRequestedBy: '申請者',
    payslipTitle: '給与明細', payslipSubject: (name, period) => `給与明細 ${period} — ${name}`,
    payslipGross: '給与・諸手当', payslipBonus: 'ボーナス', payslipTotalIncome: '収入合計',
    payslipSSF: '社会保険料', payslipPVD: '積立基金 (PVD)', payslipPIT: '源泉徴収税',
    payslipAdvance: type => `前渡し — ${type}`, payslipNet: '差引支給額',
    payslipCurrency: 'バーツ', payslipSubtitle: (name, period) => `${name} — ${period}`,
  }
};

const EMAIL_COLORS = {
  primary: '#1E3A5F', primaryLight: '#2563EB',
  bg: '#F1F3F5', card: '#FFFFFF', cardMuted: '#F8FAFC',
  border: '#E4E7EB', text: '#0F172A', textMuted: '#64748B', textFaint: '#94A3B8',
  success: '#059669', successBg: '#ECFDF5',
  danger: '#DC2626', dangerBg: '#FEF2F2',
  amber: '#D97706', amberBg: '#FFFBEB',
  purple: '#7C3AED', purpleBg: '#F5F3FF',
  teal: '#0891B2', tealBg: '#ECFEFF'
};

const TYPE_ICONS = {
  annual:'🏖️', sick:'🤒', business:'📋', maternity:'👶', ordain:'🙏',
  'holiday-work':'🔄', 'early-morning':'🌅', ot:'⏱️',
  'driver-ot':'⏱️', trip:'🧳', upcountry:'🗺️', 'late-out':'🌙', 'time-correction':'✏️',
  'long-distance':'🚗', 'personal-car':'🚙', 'clear-attachments':'🗑️'
};

const EMAIL_FONT_STACK = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,'Noto Sans Thai','Noto Sans JP',sans-serif";

// Shared outer shell for every notification email — solid-color fallback declared before the
// gradient so clients that can't parse linear-gradient() (older Outlook) just keep the solid
// color instead of rendering a transparent header.
function emailShell({ headerBg, headerIcon, headerTitle, headerSubtitle, bodyHtml, footerText }) {
  const C = EMAIL_COLORS;
  return `<div style="background:${C.bg};padding:32px 16px;font-family:${EMAIL_FONT_STACK}">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;margin:0 auto">
      <tr><td style="background:${headerBg};border-radius:16px 16px 0 0;padding:26px 32px">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
          <td style="font-size:26px;line-height:1;padding-right:14px;vertical-align:middle">${headerIcon}</td>
          <td style="vertical-align:middle">
            <div style="font-size:18px;font-weight:700;color:#ffffff;letter-spacing:-0.2px">${headerTitle}</div>
            ${headerSubtitle ? `<div style="font-size:12.5px;color:rgba(255,255,255,0.78);margin-top:3px">${headerSubtitle}</div>` : ''}
          </td>
        </tr></table>
      </td></tr>
      <tr><td style="background:${C.card};padding:26px 32px;border-left:1px solid ${C.border};border-right:1px solid ${C.border}">
        ${bodyHtml}
      </td></tr>
      <tr><td style="background:${C.cardMuted};border:1px solid ${C.border};border-top:none;border-radius:0 0 16px 16px;padding:16px 32px;text-align:center">
        <div style="font-size:12px;font-weight:600;color:${C.textMuted}">Tozai Boeki Kaisha (Thailand) Ltd. — Time Attendance System</div>
        <div style="font-size:11px;color:${C.textFaint};margin-top:3px">${footerText}</div>
      </td></tr>
    </table>
  </div>`;
}

function emailStageBadge(label, color, bg) {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:14px"><tr>
    <td style="background:${bg};border-radius:20px;padding:6px 14px">
      <span style="font-size:12.5px;font-weight:700;color:${color}">${label}</span>
    </td>
  </tr></table>`;
}

// Small colored initials circle used as a lightweight "avatar" next to each requester's name —
// email clients can't reliably load external profile photos, so this is a CSS-only stand-in.
function emailInitialsAvatar(name, bg) {
  const initials = String(name || '?').trim().split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase() || '?';
  return `<td width="32" style="width:32px;height:32px;border-radius:50%;background:${bg};color:#ffffff;text-align:center;font-size:12px;font-weight:700;line-height:32px;font-family:${EMAIL_FONT_STACK}">${escapeHtml(initials)}</td>`;
}

// Node on this NAS is built with small-icu (only en-US Intl data compiled in) — toLocaleDateString
// with 'th-TH'/'ja-JP' silently falls back to en-US instead of throwing, so dates must be
// hand-formatted here rather than relying on Intl. Mirrors the frontend's own MONTH_NAMES_*
// arrays (app.js) for visual consistency between in-app and emailed dates.
const MONTH_NAMES_EMAIL = {
  th: ['มกราคม','กุมภาพันธ์','มีนาคม','เมษายน','พฤษภาคม','มิถุนายน','กรกฎาคม','สิงหาคม','กันยายน','ตุลาคม','พฤศจิกายน','ธันวาคม'],
  en: ['January','February','March','April','May','June','July','August','September','October','November','December']
};
function fmtEmailDateLong(ts, lang) {
  const d = new Date(ts);
  if (lang === 'ja') return `${d.getFullYear()}年${d.getMonth()+1}月${d.getDate()}日`;
  const months = lang === 'en' ? MONTH_NAMES_EMAIL.en : MONTH_NAMES_EMAIL.th;
  return `${d.getDate()} ${months[d.getMonth()]} ${d.getFullYear()}`;
}
function fmtEmailDateShort(ts, lang) {
  const d = new Date(ts);
  const dd = String(d.getDate()).padStart(2, '0'), mm = String(d.getMonth() + 1).padStart(2, '0'), yyyy = d.getFullYear();
  return lang === 'ja' ? `${yyyy}/${mm}/${dd}` : `${dd}/${mm}/${yyyy}`;
}

// groups: [{ empName, items:[{type,dateRange,createdAt,pendingDays}, ...] }] — items pre-sorted
// newest-first, groups pre-sorted by their newest item first (see buildStageGroups below).
// Card-based layout (one card per requester) reads better on mobile than a wide 4-column table —
// each item is its own compact row inside the card instead of a table cell that has to squeeze
// onto a narrow phone screen.
function buildPendingEmailHtml(managerGroups, mdGroups, accountingGroups, lang) {
  const t = EMAIL_I18N[lang] || EMAIL_I18N.th;
  const C = EMAIL_COLORS;

  function itemRow(it, isLast) {
    return `<tr><td style="padding:0 0 ${isLast ? 0 : 8}px">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${C.cardMuted};border-radius:10px">
        <tr><td style="padding:10px 14px 4px">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
            <!-- HYGIENE FIX 2026-08-16 (Opus cron audit, L-3): getTypeLabel() already returns
                 escapeHtml()'d output for any unrecognized type (its own fallback branch) -- was
                 wrapped in escapeHtml() again here, double-encoding a legacy bogus type's HTML
                 entities (e.g. "&amp;amp;amp;" instead of "&amp;"). Cosmetic only. -->
            <td style="font-size:13px;font-weight:600;color:${C.text}">${TYPE_ICONS[it.type] || '📋'} ${getTypeLabel(it.type, lang)}</td>
            <td align="right" style="font-size:11px;color:${C.textFaint};white-space:nowrap;padding-left:8px">${t.daysSuffix(it.pendingDays)}</td>
          </tr></table>
        </td></tr>
        <tr><td style="padding:0 14px 10px">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
            <td style="font-size:12px;color:${C.textMuted}">📅 ${escapeHtml(it.dateRange)}</td>
            <td align="right" style="font-size:11px;color:${C.textFaint};white-space:nowrap;padding-left:8px">${t.colRequested} ${fmtEmailDateShort(it.createdAt, lang)}</td>
          </tr></table>
        </td></tr>
      </table>
    </td></tr>`;
  }

  function personCard(g, avatarBg) {
    const rows = g.items.map((it, i) => itemRow(it, i === g.items.length - 1)).join('');
    return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid ${C.border};border-radius:12px;margin-bottom:12px"><tr><td style="padding:14px 16px">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:12px"><tr>
        ${emailInitialsAvatar(g.empName, avatarBg)}
        <td style="padding-left:10px;vertical-align:middle">
          <div style="font-size:10.5px;font-weight:700;letter-spacing:0.4px;text-transform:uppercase;color:${C.textFaint};margin-bottom:2px">${t.lblRequestedBy}</div>
          <div style="font-size:16px;font-weight:700;color:${C.text}">${escapeHtml(g.empName)}<span style="font-size:12px;font-weight:400;color:${C.textFaint}"> · ${g.items.length}</span></div>
        </td>
      </tr></table>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${rows}</table>
    </td></tr></table>`;
  }

  const sections = [];
  if (managerGroups.length) {
    const n = managerGroups.reduce((s, g) => s + g.items.length, 0);
    sections.push(`${emailStageBadge(t.sectionManager(n), C.amber, C.amberBg)}${managerGroups.map(g => personCard(g, C.amber)).join('')}`);
  }
  if (mdGroups.length) {
    const n = mdGroups.reduce((s, g) => s + g.items.length, 0);
    sections.push(`<div style="height:${managerGroups.length ? 6 : 0}px"></div>${emailStageBadge(t.sectionMd(n), C.purple, C.purpleBg)}${mdGroups.map(g => personCard(g, C.purple)).join('')}`);
  }
  if (accountingGroups.length) {
    const n = accountingGroups.reduce((s, g) => s + g.items.length, 0);
    sections.push(`<div style="height:${(managerGroups.length || mdGroups.length) ? 6 : 0}px"></div>${emailStageBadge(t.sectionAccounting(n), C.teal, C.tealBg)}${accountingGroups.map(g => personCard(g, C.teal)).join('')}`);
  }

  return emailShell({
    headerBg: `${C.primary};background:linear-gradient(135deg, ${C.primary}, ${C.primaryLight})`,
    headerIcon: '🔔',
    // FIX 2026-08-13: same double-icon bug as the result-notification email above -- digestTitle
    // already has its own 🔔 prefix (used verbatim as the mail subject elsewhere), duplicating
    // the separate headerIcon <td>.
    headerTitle: t.digestTitle.replace(/^🔔\s*/, ''),
    headerSubtitle: fmtEmailDateLong(Date.now(), lang),
    bodyHtml: sections.join(''),
    footerText: t.footer
  });
}

// Groups a flat list of leave records (already filtered to one stage) by requester, sorts each
// person's own requests newest-first, then sorts the person-groups themselves by their most
// recent request (so whoever requested most recently floats to the top of the section).
function buildStageGroups(stageLeaves, users, now, minDays) {
  const byUser = new Map();
  for (const l of stageLeaves) {
    const emp = users.find(u => u.id === l.userId);
    // HYGIENE FIX 2026-08-16 (Opus cron audit, L-6): a PRESENT-but-unparseable timestamp (garbage
    // string, not just missing) made this resolve to NaN, not the 1970 fallback below -- pendingDays
    // then came out NaN too, `NaN < minDays` is always false so the row was silently KEPT, and the
    // email rendered "NaN วัน" with a NaN sort comparator. Not reachable via any currently-validated
    // write path, but cheap to close at the source rather than rely on that staying true.
    let createdAt = new Date(l.serverCreatedAt || l.submittedAt || l.createdAt || '1970-01-01').getTime();
    if (!Number.isFinite(createdAt)) createdAt = 0;
    const pendingDays = Math.floor((now - createdAt) / 86400000);
    if (pendingDays < minDays) continue;
    // 2026-08-13 (Opus audit, F-5 fix): `_empName` lets a synthetic sample item (see
    // POST /api/test-pending-notification, which no longer resolves real employees for its
    // preview data) supply its own display name instead of falling back to the raw numeric
    // `userId` -- real leave records never carry this field, so this is inert for production data.
    const empName = l._empName || (emp ? emp.name : l.userId);
    if (!byUser.has(l.userId)) byUser.set(l.userId, { empName, items: [] });
    byUser.get(l.userId).items.push({
      type: l.type,
      dateRange: l.dateFrom === l.dateTo ? l.dateFrom : (l.dateFrom + ' - ' + l.dateTo),
      createdAt,
      pendingDays
    });
  }
  const groups = [...byUser.values()];
  groups.forEach(g => g.items.sort((a, b) => b.createdAt - a.createdAt));
  groups.sort((a, b) => b.items[0].createdAt - a.items[0].createdAt);
  return groups;
}

// Runs the pending-approval digest check. overrideTo (+ optional overrideLang), when given,
// bypasses the enabled/schedule/recipients config entirely and sends only to that one address
// in that one language — used by the manual test endpoint so testing never touches real
// recipients. Otherwise, recipients are bucketed by each person's own notifyLangEmail (manager/
// md/accounting users) or each extra entry's own lang, and one email per language is sent.
// 2026-08-06: optional 4th param `sampleLeaves` -- when given, the digest is built from THIS
// array instead of readLeaves(), so the manual test endpoint can preview the real digest
// template/layout (grouped-by-requester sections per approval stage) even when there are
// genuinely zero pending requests in production right now. Never touches leaves.json either way.
async function runPendingApprovalNotification(overrideTo, overrideLang, sampleLeaves) {
  const s2 = readSettings();
  const nc2 = s2.emailNotification;
  if (!overrideTo && (!nc2 || !nc2.enabled)) return { sent: false, reason: 'disabled' };
  const transport = getEmailTransport();
  if (!transport) return { sent: false, reason: 'no-transport' };
  const cfg = s2.emailConfig || {};
  const users = readUsers() || [];
  const leaves = sampleLeaves || readLeaves() || [];
  const minDays = (overrideTo || sampleLeaves) ? 0 : Number((nc2.schedule || {}).minPendingDays || 0);
  const now = Date.now();
  const pending = leaves.filter(l => l.status === 'pending' || l.status === 'pending-md' || l.status === 'pending-accounting');
  if (!pending.length) return { sent: false, reason: 'no-pending' };

  const managerGroups    = buildStageGroups(pending.filter(l => l.status === 'pending'), users, now, minDays);
  const mdGroups         = buildStageGroups(pending.filter(l => l.status === 'pending-md'), users, now, minDays);
  const accountingGroups = buildStageGroups(pending.filter(l => l.status === 'pending-accounting'), users, now, minDays);
  const totalCount = managerGroups.reduce((s, g) => s + g.items.length, 0) + mdGroups.reduce((s, g) => s + g.items.length, 0) + accountingGroups.reduce((s, g) => s + g.items.length, 0);
  if (!totalCount) return { sent: false, reason: 'nothing-to-report' };

  const langBuckets = new Map(); // lang -> Set(email)
  function addRecipient(email, lang) {
    if (!email) return;
    const l = emailLangOf(lang);
    if (!langBuckets.has(l)) langBuckets.set(l, new Set());
    langBuckets.get(l).add(email);
  }
  if (overrideTo) {
    addRecipient(overrideTo, overrideLang);
  } else {
    const recip = nc2.recipients || {};
    // HYGIENE FIX 2026-08-16 (Opus cron audit, L-2): was `u.active` (truthy check), inconsistent
    // with this file's own established convention elsewhere (`u.active !== false`, e.g. the door-
    // access and employees-table filters) -- a record with `active` absent/undefined would be
    // silently skipped as a digest recipient while counting as active everywhere else in the app.
    if (recip.manager)    users.filter(u => u.role === 'manager'    && u.active !== false && u.email).forEach(u => addRecipient(u.email, u.notifyLangEmail));
    if (recip.md)         users.filter(u => u.role === 'md'         && u.active !== false && u.email).forEach(u => addRecipient(u.email, u.notifyLangEmail));
    if (recip.accounting) users.filter(u => u.role === 'accounting' && u.active !== false && u.email).forEach(u => addRecipient(u.email, u.notifyLangEmail));
    // extra entries are normally {email,lang} objects; tolerate legacy plain strings (pre-i18n
    // settings) by defaulting those to Thai.
    (recip.extra || []).forEach(e => {
      if (typeof e === 'string') addRecipient(e, 'th');
      else if (e && e.email) addRecipient(e.email, e.lang);
    });
  }
  if (!langBuckets.size) return { sent: false, reason: 'no-recipients' };

  const sentTo = [];
  const failedBuckets = [];
  let lastHtml;
  // HYGIENE FIX 2026-08-16 (Opus cron audit, M-2): was a single un-caught loop -- one bad/rejected
  // recipient (a typo'd recipients.extra address, or an approver's own profile email set to
  // garbage, neither of which is format-validated) made sendMail() reject, which aborted the WHOLE
  // loop, silently skipping every remaining language bucket (Map-insertion order, so a bad Thai
  // recipient could block English/Japanese too). Isolate per-bucket so one failure can't take down
  // digests for languages/recipients that would otherwise have succeeded.
  for (const [lang, emailSet] of langBuckets) {
    const html = buildPendingEmailHtml(managerGroups, mdGroups, accountingGroups, lang);
    const t = EMAIL_I18N[lang];
    try {
      await transport.sendMail({
        from: `"${cfg.fromName || 'Time Attendance Application'}" <${cfg.user}>`,
        to: [...emailSet].join(', '),
        subject: t.digestSubject(totalCount),
        html
      });
      sentTo.push(...emailSet);
      if (overrideTo) lastHtml = html; // debug/test convenience only, single-language path
    } catch (e) {
      console.error(`[CRON] pending-digest send failed for lang=${lang} --`, e.message);
      failedBuckets.push(lang);
    }
  }
  return { sent: sentTo.length > 0, to: sentTo, count: totalCount, html: overrideTo ? lastHtml : undefined, failedBuckets: failedBuckets.length ? failedBuckets : undefined };
}

function scheduleCronNotification() {
  // SECURITY/CORRECTNESS FIX 2026-08-12 (Opus comprehensive audit, CRITICAL-2): this function is
  // called bare at module scope BELOW, BEFORE server.listen() -- a malformed emailNotification
  // .schedule (garbage time/days) makes cron.schedule() throw synchronously, which previously
  // crashed the whole process before it ever bound a port. Combined with this NAS's watchdog
  // auto-respawn, that's a permanent boot-crash loop recoverable only by hand-editing
  // settings.json on the NAS. Wrapped so a bad schedule disables notifications instead of taking
  // the whole app down.
  // CORRECTION 2026-08-16 (Opus cron audit, L-5): "including manager" above was stale --
  // SETTINGS_KEY_ROLES.emailNotification is ['md','accounting'] only, manager gets a 403 on this
  // settings key. Per this project's own standing lesson about not treating a dated comment as
  // permanent truth, corrected rather than left to mislead the next reader.
  try {
    // HYGIENE FIX 2026-08-16 (Opus cron audit, L-1): .stop() alone (InlineScheduledTask) emits
    // task:stopped, not task:destroyed -- node-cron's module-global task registry only removes an
    // entry on task:destroyed, so every call to this function (re-run on EVERY PUT /api/settings,
    // even by a manager save that can't touch emailNotification at all) leaked one dead task into
    // that registry forever. Stopped tasks never fire, so this was a slow memory leak, not a
    // correctness bug -- .destroy() is the one-word fix. stop()/destroy() are synchronous on an
    // inline task, so there's no unhandled-promise-rejection risk from not awaiting them.
    if (_cronJob) { _cronJob.stop(); _cronJob.destroy(); _cronJob = null; }
    const settings = readSettings();
    const nc = settings.emailNotification;
    if (!nc || !nc.enabled) return;
    const sched = nc.schedule || {};
    const time = (sched.time || '09:00').split(':');
    const hour = time[0] || '9';
    const min  = time[1] || '0';
    const days = sched.days || ['mon','tue','wed','thu','fri'];
    const dayMap = { sun:'0', mon:'1', tue:'2', wed:'3', thu:'4', fri:'5', sat:'6' };
    const cronDays = days.map(d => dayMap[d] || d).join(',');
    const expr = `${min} ${hour} * * ${cronDays}`;
    console.log('[CRON] notification schedule:', expr);
    _cronJob = cron.schedule(expr, async () => {
      try {
        const result = await runPendingApprovalNotification(null);
        if (result.sent) console.log('[CRON] notification sent to', result.to.join(', '));
      } catch(e) {
        console.error('[CRON] notification error:', e.message);
      }
    }, { timezone: 'Asia/Bangkok' });
  } catch(e) {
    console.error('[CRON] invalid emailNotification schedule, notifications disabled:', e.message);
  }
}

scheduleCronNotification();

// 2026-09-24 (owner): automatic year-end carry-forward -- at start-up (a server that was down on
// 1 January still runs it while it is January) and then hourly. See runYearEndCarryForward.
function scheduleYearEndCarryForward() {
  try {
    cron.schedule('7 * * * *', autoYearEndCarryForward, { timezone: 'Asia/Bangkok' });
  } catch (e) {
    console.error('[CF] could not schedule the automatic carry-forward:', e.message);
  }
  setTimeout(autoYearEndCarryForward, 10000);
}
scheduleYearEndCarryForward();

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[HTTP] port ${PORT}`);
  // 2026-09-24 (review): geo-tz/all is lazy-loaded (~1.2 s) inside the events lock on the first
  // web scan with GPS -- warm it once the server is listening so no scan waits for it.
  setImmediate(() => { try { timezoneFromCoords(13.75, 100.5); } catch (e) { /* display-only */ } });
});
server.on('error', err => console.error('[HTTP] error:', err.message));

// ===== HTTPS (port 3443) =====
(function startHttps() {
  const CERT_FILE = path.join(DATA_DIR, 'cert.pem');
  const KEY_FILE  = path.join(DATA_DIR, 'key.pem');

  if (!fs.existsSync(CERT_FILE) || !fs.existsSync(KEY_FILE)) {
    try {
      require('child_process').execSync(
        `openssl req -x509 -newkey rsa:2048 -keyout "${KEY_FILE}" -out "${CERT_FILE}" ` +
        `-days 3650 -nodes -subj "/CN=192.168.100.100"`,
        { stdio: 'pipe' }
      );
      console.log('[HTTPS] Self-signed cert generated →', CERT_FILE);
    } catch(e) {
      try {
        require('child_process').execSync(
          `/usr/bin/openssl req -x509 -newkey rsa:2048 -keyout "${KEY_FILE}" -out "${CERT_FILE}" ` +
          `-days 3650 -nodes -subj "/CN=192.168.100.100"`,
          { stdio: 'pipe' }
        );
        console.log('[HTTPS] Self-signed cert generated (syno openssl) →', CERT_FILE);
      } catch(e2) {
        console.log('[HTTPS] openssl not available — HTTPS disabled. HTTP still running on', PORT);
        return;
      }
    }
  }

  secureChmod(KEY_FILE);

  let certPem, keyPem;
  try {
    certPem = fs.readFileSync(CERT_FILE);
    keyPem  = fs.readFileSync(KEY_FILE);
  } catch(e) {
    console.log('[HTTPS] Cannot read cert —', e.message);
    return;
  }

  const httpsServer = https.createServer({ cert: certPem, key: keyPem }, app);
  const wssHttps    = new WebSocketServer({ server: httpsServer, path: '/ws' });

  // SECURITY FIX 2026-08-13: was an unauthenticated duplicate of the same logic as the plain-WS
  // handler above (same CRITICAL finding) -- now shares handleWsConnection()'s auth gate.
  wssHttps.on('connection', (ws, req) => handleWsConnection(ws, req, 'WSS'));

  httpsServer.on('error', err =>
    console.error('[HTTPS] error (HTTP still running on', PORT, '):', err.message)
  );
  httpsServer.listen(3443, '0.0.0.0', () =>
    console.log('[HTTPS] port 3443 ready — https://192.168.100.100:3443/')
  );
}());
