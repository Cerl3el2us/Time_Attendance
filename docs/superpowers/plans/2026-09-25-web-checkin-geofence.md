# Web Check-in GPS Geofence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refuse a web check-in made within 150 m of the office, so attendance at the office is recorded by the face scanner, while web check-in keeps working everywhere else.

**Architecture:** One pure decision function, written identically into `attendance/js/app.js` and `attendance-server/backend/server.js` (the project's dual-sync convention, proven by a test that compares the two extracted function bodies). The server calls it inside the WebScan branch of `POST /api/hikvision/event` and refuses with 403; the client calls it to disable the button and explain why before anyone presses it. Configuration lives in `appSettings.geofence`.

**Tech Stack:** Plain Node/Express backend (no build step), plain browser JS frontend, `node:vm`-sandbox tests with no framework (`node tests/run-all.js`).

## Global Constraints

- **Worktree only.** All work happens in `C:\Users\Teerawat\ta-work` on branch `work/2026-09-25`. `Z:\Time_Attendance\attendance` is the live site and is not edited. Nothing reaches production until an explicit merge + deploy step, which the owner authorises separately.
- **Dual-sync.** `geofenceDistanceM()` and `geofenceCheckinReason()` must be byte-identical in `app.js` and `server.js`. `tests/geofence.test.js` enforces this with `sameSource()`. Never fix one copy alone.
- **Three languages from the start.** Every new user-visible string ships TH + EN + JA. TH/EN come from `L(en, th)`; JA is an entry in `attendance/lang/ja.js` keyed by the exact English string.
- **No `x || default` on numeric settings.** A legitimate `0` must survive. Use `Number.isFinite(x) ? x : default`.
- **Settings saves send the complete object.** The Settings page must `GET` first and send the whole `geofence` object, never a partial patch.
- **The device branch of `POST /api/hikvision/event` is not touched.** Only `req.hikSource === 'webscan'`.
- **Exact values:** office centre `13.7268315, 100.52847` (Paso Tower); radius `150` m; max accuracy `50` m; exempt role `driver`; refusal reasons `geofence-inside`, `geofence-no-position`, `geofence-accuracy`.
- **Check-out is never gated.** The "is this a check-in" test runs before any GPS requirement.
- `node --check` both edited files before bumping cache-busters. Run `npm run lint && npm test` before every commit.

**Open decision to confirm before Task 5:** the spec says MD edits these values. This plan stores them in `appSettings`, which `SETTINGS_KEY_ROLES` already grants to **md + accounting** — the same pair that can already change `standardStartHour`, the setting that decides who is late. If the owner wants MD alone, `geofence` becomes its own top-level settings key with `['md']` instead, which adds a separate load/save path on both sides.

---

### Task 1: The shared decision function

**Files:**
- Modify: `attendance/js/app.js` (insert next to `CHECKIN_CUTOFF`, around line 5941)
- Modify: `attendance-server/backend/server.js` (insert next to its `CHECKIN_CUTOFF` twin, around line 9010)
- Test: `tests/geofence.test.js` (create)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `geofenceDistanceM(lat1, lng1, lat2, lng2) -> number` (metres, haversine)
  - `geofenceCheckinReason(G, role, lat, lng, accuracy) -> '' | 'geofence-no-position' | 'geofence-accuracy' | 'geofence-inside'` where `G` is the `geofence` settings object and `''` means allow.

- [ ] **Step 1: Write the failing test**

Create `tests/geofence.test.js`:

```js
// 2026-09-25: web check-in geofence. The real functions are extracted from app.js and server.js
// and run in a sandbox, so the DUAL-SYNC copies are proven to agree. `node tests/geofence.test.js`
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const APP_SRC = fs.readFileSync(path.join(ROOT, 'attendance/js/app.js'), 'utf8');
const SERVER_SRC = fs.readFileSync(path.join(ROOT, 'attendance-server/backend/server.js'), 'utf8');

function extractBraced(src, startIdx, openIdx, name) {
  let depth = 0;
  for (let j = openIdx; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (depth === 0) return src.slice(startIdx, j + 1); }
  }
  throw new Error(`unbalanced ${name}`);
}
function extractFunction(src, name) {
  const m = new RegExp(`^(async )?function ${name}\\(`, 'm').exec(src);
  if (!m) throw new Error(`function ${name} not found`);
  return extractBraced(src, m.index, src.indexOf(') {', m.index) + 2, name);
}
function sameSource(name) {
  const norm = s => s.replace(/\s+/g, ' ').trim();
  assert.strictEqual(norm(extractFunction(APP_SRC, name)), norm(extractFunction(SERVER_SRC, name)),
    `${name} differs between app.js and server.js`);
}
function sandbox(src, names) {
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(names.map(n => extractFunction(src, n)).join('\n'), ctx);
  return ctx;
}

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok  ${name}`); }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; }
}

const PASO  = { lat: 13.7268315, lng: 100.52847 };
const AMARA = { lat: 13.7290317, lng: 100.5274579 };
const G = { enabled: true, lat: PASO.lat, lng: PASO.lng, radiusM: 150, maxAccuracyM: 50, exemptRoles: ['driver'] };

const S = sandbox(SERVER_SRC, ['geofenceDistanceM', 'geofenceCheckinReason']);

console.log('Geofence: distance and the check-in decision');

test('both functions are identical in app.js and server.js (dual-sync)', () => {
  sameSource('geofenceDistanceM');
  sameSource('geofenceCheckinReason');
});

test('Paso Tower to Amara Bangkok Hotel is 268 m', () => {
  const d = S.geofenceDistanceM(PASO.lat, PASO.lng, AMARA.lat, AMARA.lng);
  assert.ok(Math.abs(d - 268) < 2, `expected ~268 m, got ${d.toFixed(1)}`);
  assert.strictEqual(S.geofenceDistanceM(PASO.lat, PASO.lng, PASO.lat, PASO.lng), 0);
});

test('at the office: a check-in is refused', () => {
  assert.strictEqual(S.geofenceCheckinReason(G, 'user', PASO.lat, PASO.lng, 20), 'geofence-inside');
});

test('at the hotel with any accuracy inside the threshold: never refused', () => {
  // The design rests on this: 268 m - 50 m of error is still outside the 150 m fence.
  for (let acc = 0; acc <= G.maxAccuracyM; acc += 5) {
    assert.strictEqual(S.geofenceCheckinReason(G, 'user', AMARA.lat, AMARA.lng, acc), '',
      `refused at the hotel with accuracy ${acc}`);
  }
});

test('no position, or a position that is not a number, is refused', () => {
  assert.strictEqual(S.geofenceCheckinReason(G, 'user', null, null, 10), 'geofence-no-position');
  assert.strictEqual(S.geofenceCheckinReason(G, 'user', NaN, 100.5, 10), 'geofence-no-position');
});

test('a fix worse than the threshold is refused wherever it claims to be', () => {
  assert.strictEqual(S.geofenceCheckinReason(G, 'user', AMARA.lat, AMARA.lng, 51), 'geofence-accuracy');
  assert.strictEqual(S.geofenceCheckinReason(G, 'user', 13.9, 100.9, 500), 'geofence-accuracy');
  assert.strictEqual(S.geofenceCheckinReason(G, 'user', AMARA.lat, AMARA.lng, null), 'geofence-accuracy');
});

test('a driver is allowed everywhere, including with no position at all', () => {
  assert.strictEqual(S.geofenceCheckinReason(G, 'driver', PASO.lat, PASO.lng, 10), '');
  assert.strictEqual(S.geofenceCheckinReason(G, 'driver', null, null, null), '');
});

test('the master switch restores the old behaviour exactly', () => {
  const off = { ...G, enabled: false };
  assert.strictEqual(S.geofenceCheckinReason(off, 'user', PASO.lat, PASO.lng, 10), '');
  assert.strictEqual(S.geofenceCheckinReason(off, 'user', null, null, null), '');
  assert.strictEqual(S.geofenceCheckinReason(undefined, 'user', PASO.lat, PASO.lng, 10), '');
});

test('a radius or threshold of 0 is honoured, not replaced by a default', () => {
  // Falsy-zero guard: `radiusM || 150` would silently restore 150 here.
  assert.strictEqual(S.geofenceCheckinReason({ ...G, radiusM: 0 }, 'user', PASO.lat, PASO.lng, 10), '');
  assert.strictEqual(S.geofenceCheckinReason({ ...G, maxAccuracyM: 0 }, 'user', AMARA.lat, AMARA.lng, 1), 'geofence-accuracy');
});

console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ', 0 failed'}`);
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node tests/geofence.test.js`
Expected: FAIL — `function geofenceDistanceM not found`.

- [ ] **Step 3: Add both functions to `server.js`**

Insert immediately after the `const CHECKIN_CUTOFF = '13:00';` line (~9010):

```js
// 2026-09-25: web check-in geofence. DUAL-SYNC twin of app.js -- both copies must stay identical
// or tests/geofence.test.js fails. Pure: no I/O, no globals, safe to extract into a test sandbox.
function geofenceDistanceM(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = d => d * Math.PI / 180;
  const p1 = toRad(lat1), p2 = toRad(lat2);
  const dp = toRad(lat2 - lat1), dl = toRad(lng2 - lng1);
  const a = Math.sin(dp / 2) * Math.sin(dp / 2) + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) * Math.sin(dl / 2);
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}
// Returns '' to allow, or the reason code to refuse. Order matters: the caller must already have
// established that this scan would become a CHECK-IN -- check-out is never gated.
function geofenceCheckinReason(G, role, lat, lng, accuracy) {
  if (!G || typeof G !== 'object' || G.enabled !== true) return '';
  const exempt = Array.isArray(G.exemptRoles) ? G.exemptRoles : [];
  if (exempt.includes(role)) return '';
  const la = Number(lat), ln = Number(lng);
  if (!Number.isFinite(la) || !Number.isFinite(ln)) return 'geofence-no-position';
  // Number.isFinite, never `||`: a configured 0 is a real value and must not fall back to a default.
  const maxAcc = Number.isFinite(Number(G.maxAccuracyM)) ? Number(G.maxAccuracyM) : 50;
  const acc = Number(accuracy);
  if (!Number.isFinite(acc) || acc < 0 || acc > maxAcc) return 'geofence-accuracy';
  const radius = Number.isFinite(Number(G.radiusM)) ? Number(G.radiusM) : 150;
  return geofenceDistanceM(la, ln, Number(G.lat), Number(G.lng)) <= radius ? 'geofence-inside' : '';
}
```

- [ ] **Step 4: Copy the identical block into `app.js`**

Insert the exact same two functions (same text, same comments) immediately after `const CHECKIN_CUTOFF = '13:00';` in `attendance/js/app.js` (~5941).

- [ ] **Step 5: Run the tests**

Run: `node tests/geofence.test.js`
Expected: PASS, 9 tests, including the dual-sync comparison.

- [ ] **Step 6: Syntax check and commit**

```bash
node --check attendance/js/app.js && node --check attendance-server/backend/server.js
npm run lint && npm test
git add attendance/js/app.js attendance-server/backend/server.js tests/geofence.test.js
git commit -m "feat(geofence): shared distance and check-in decision, dual-synced"
```

---

### Task 2: Settings — defaults, whitelist, validation

**Files:**
- Modify: `attendance-server/backend/server.js` — `DEFAULT_APP_SETTINGS` (~8687), `getAppSettings()` (~8850), `ALLOWED_APPSETTINGS_KEYS` (~4348), the sub-object type loop (~4366), and the validation block after it
- Modify: `attendance/js/app.js` — the `APP_SETTINGS` default object (~1294) and the settings merge in `loadSettings` (~2635)
- Test: `tests/geofence.test.js` (extend)

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: `appSettings.geofence = { enabled, lat, lng, radiusM, maxAccuracyM, exemptRoles }`, readable server-side via `getAppSettings().geofence` and client-side via `APP_SETTINGS.geofence`.

- [ ] **Step 1: Write the failing test**

Append to `tests/geofence.test.js`, before the final `console.log`:

```js
console.log('Geofence: settings');

test('both files default to Paso Tower, 150 m, 50 m, driver exempt', () => {
  for (const [label, src, name] of [['server', SERVER_SRC, 'DEFAULT_APP_SETTINGS'], ['app', APP_SRC, 'APP_SETTINGS']]) {
    const m = new RegExp(`geofence:\\s*\\{[^}]*\\}`).exec(src);
    assert.ok(m, `${label}: no geofence defaults in ${name}`);
    const g = m[0];
    assert.ok(/enabled:\s*true/.test(g), `${label}: geofence must default to enabled`);
    assert.ok(/13\.7268315/.test(g) && /100\.52847/.test(g), `${label}: office centre must be Paso Tower`);
    assert.ok(/radiusM:\s*150/.test(g), `${label}: radius must default to 150`);
    assert.ok(/maxAccuracyM:\s*50/.test(g), `${label}: accuracy threshold must default to 50`);
    assert.ok(/exemptRoles:\s*\['driver'\]/.test(g), `${label}: driver must be exempt by default`);
  }
});

test('getAppSettings merges geofence over the defaults', () => {
  const fn = extractFunction(SERVER_SRC, 'getAppSettings');
  assert.ok(/geofence:\s*\{\s*\.\.\.DEFAULT_APP_SETTINGS\.geofence,\s*\.\.\.\(raw\.geofence\s*\|\|\s*\{\}\)\s*\}/.test(fn),
    'geofence must be merged like workSchedule, or a partial stored value loses its other fields');
});

test('PUT /api/settings accepts geofence and validates it', () => {
  const allowed = /const ALLOWED_APPSETTINGS_KEYS = \[[^\]]*\]/.exec(SERVER_SRC)[0];
  assert.ok(/'geofence'/.test(allowed), 'geofence must be in the appSettings whitelist or every save is rejected');
  const objLoop = /for \(const sub of \['company'[^\]]*\]\)/.exec(SERVER_SRC)[0];
  assert.ok(/'geofence'/.test(objLoop), 'geofence must be type-checked like the other sub-objects');
  for (const needle of [
    'appSettings.geofence.lat must be a number between -90 and 90',
    'appSettings.geofence.lng must be a number between -180 and 180',
    'appSettings.geofence.radiusM must be a number between 10 and 5000',
    'appSettings.geofence.maxAccuracyM must be a number between 5 and 1000',
    'appSettings.geofence.exemptRoles must be an array of known roles',
    'appSettings.geofence.enabled must be true or false',
  ]) {
    assert.ok(SERVER_SRC.includes(needle), `missing validation: ${needle}`);
  }
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node tests/geofence.test.js`
Expected: FAIL — `server: no geofence defaults in DEFAULT_APP_SETTINGS`.

- [ ] **Step 3: Add the defaults in `server.js`**

In `DEFAULT_APP_SETTINGS`, directly after the `workSchedule:` line (~8687):

```js
  // 2026-09-25: web check-in geofence (Paso Tower). Editable in Settings; `enabled:false` restores
  // the pre-geofence behaviour exactly.
  geofence: { enabled: true, lat: 13.7268315, lng: 100.52847, radiusM: 150, maxAccuracyM: 50, exemptRoles: ['driver'] },
```

In `getAppSettings()`, next to the other merged groups (~8850):

```js
    geofence:     { ...DEFAULT_APP_SETTINGS.geofence,     ...(raw.geofence     || {}) },
```

- [ ] **Step 4: Add the same defaults in `app.js`**

In the `APP_SETTINGS` object (~1294), directly after its `workSchedule:` line, add the identical `geofence: {...}` line. Then in the settings load (~2635), beside the existing group merges:

```js
      if (s.geofence) Object.assign(APP_SETTINGS.geofence, s.geofence);
```

- [ ] **Step 5: Whitelist and validate in the PUT handler**

Add `'geofence'` to `ALLOWED_APPSETTINGS_KEYS` (~4348) and to the `for (const sub of ['company', ...])` type-check list (~4366). Then add this block next to the other group validators (after the `A.sso` checks, ~4390):

```js
    if (A.geofence) {
      const g = A.geofence;
      const num = (v, lo, hi) => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;
      if (g.enabled !== undefined && typeof g.enabled !== 'boolean') {
        return res.status(400).json({ success: false, message: 'appSettings.geofence.enabled must be true or false' });
      }
      if (g.lat !== undefined && !num(g.lat, -90, 90)) {
        return res.status(400).json({ success: false, message: 'appSettings.geofence.lat must be a number between -90 and 90' });
      }
      if (g.lng !== undefined && !num(g.lng, -180, 180)) {
        return res.status(400).json({ success: false, message: 'appSettings.geofence.lng must be a number between -180 and 180' });
      }
      // Lower bounds are not cosmetic: a radius under ~80 m lets GPS noise walk people out of the
      // zone, and an accuracy threshold that is too tight refuses everyone indoors.
      if (g.radiusM !== undefined && !num(g.radiusM, 10, 5000)) {
        return res.status(400).json({ success: false, message: 'appSettings.geofence.radiusM must be a number between 10 and 5000' });
      }
      if (g.maxAccuracyM !== undefined && !num(g.maxAccuracyM, 5, 1000)) {
        return res.status(400).json({ success: false, message: 'appSettings.geofence.maxAccuracyM must be a number between 5 and 1000' });
      }
      if (g.exemptRoles !== undefined) {
        const known = ['md', 'manager', 'accounting', 'user', 'driver', 'marketing'];
        if (!Array.isArray(g.exemptRoles) || g.exemptRoles.length > 6 || !g.exemptRoles.every(r => known.includes(r))) {
          return res.status(400).json({ success: false, message: 'appSettings.geofence.exemptRoles must be an array of known roles' });
        }
      }
    }
```

- [ ] **Step 6: Run the tests, syntax check, commit**

```bash
node tests/geofence.test.js
node --check attendance/js/app.js && node --check attendance-server/backend/server.js
npm run lint && npm test
git add attendance/js/app.js attendance-server/backend/server.js tests/geofence.test.js
git commit -m "feat(geofence): settings group with defaults, whitelist and validation"
```

---

### Task 3: The server gate

**Files:**
- Modify: `attendance-server/backend/server.js` — `sanitizeGps()` neighbourhood (~1451), the WebScan branch of `POST /api/hikvision/event` (~1745–1800)
- Test: `tests/geofence.test.js` (extend)

**Interfaces:**
- Consumes: `geofenceCheckinReason()` (Task 1), `getAppSettings().geofence` (Task 2), the existing `buildAttendanceLogForUser(user)` and `CHECKIN_CUTOFF`.
- Produces:
  - `sanitizeGpsAccuracy(raw) -> number | null`
  - `parseGpsCoords(gps)` already exists and returns `{ lat, lng }` or null — reused, not rewritten.
  - `webScanWouldBeCheckIn(user, eventTimeIso) -> boolean`
  - 403 responses carrying `{ success: false, reason, message }`.

- [ ] **Step 1: Write the failing test**

Append to `tests/geofence.test.js`:

```js
console.log('Geofence: the server gate');

test('accuracy is sanitised to a bounded number or null', () => {
  const A = sandbox(SERVER_SRC, ['sanitizeGpsAccuracy']);
  assert.strictEqual(A.sanitizeGpsAccuracy(23.4), 23);
  assert.strictEqual(A.sanitizeGpsAccuracy('12'), 12);
  assert.strictEqual(A.sanitizeGpsAccuracy(0), 0);
  assert.strictEqual(A.sanitizeGpsAccuracy(-1), null);
  assert.strictEqual(A.sanitizeGpsAccuracy('abc'), null);
  assert.strictEqual(A.sanitizeGpsAccuracy(undefined), null);
  assert.strictEqual(A.sanitizeGpsAccuracy(1e9), null);
});

test('only a real check-in is gated: pre-dawn and post-cutoff scans are check-outs', () => {
  const ctx = { CHECKIN_CUTOFF: '13:00', buildAttendanceLogForUser: () => ({}) };
  vm.createContext(ctx);
  vm.runInContext(extractFunction(SERVER_SRC, 'webScanWouldBeCheckIn'), ctx);
  const U = { employeeNo: '1' };
  assert.strictEqual(ctx.webScanWouldBeCheckIn(U, '2026-09-25T08:25:00'), true);
  assert.strictEqual(ctx.webScanWouldBeCheckIn(U, '2026-09-25T02:10:00'), false, 'before 05:00 is a late-night check-out');
  assert.strictEqual(ctx.webScanWouldBeCheckIn(U, '2026-09-25T13:00:00'), false, 'at the cutoff is a check-out');
  assert.strictEqual(ctx.webScanWouldBeCheckIn(U, '2026-09-25T17:40:00'), false);
});

test('an employee who already checked in today is not gated again', () => {
  const ctx = { CHECKIN_CUTOFF: '13:00', buildAttendanceLogForUser: () => ({ '2026-09-25': { checkIn: '08:20' } }) };
  vm.createContext(ctx);
  vm.runInContext(extractFunction(SERVER_SRC, 'webScanWouldBeCheckIn'), ctx);
  assert.strictEqual(ctx.webScanWouldBeCheckIn({ employeeNo: '1' }, '2026-09-25T09:00:00'), false);
});

test('the gate is wired into the WebScan branch, before the event is saved', () => {
  const route = SERVER_SRC.slice(SERVER_SRC.indexOf("app.post('/api/hikvision/event'"));
  const body = route.slice(0, route.indexOf('\napp.'));
  const gateAt = body.indexOf('geofenceCheckinReason');
  const saveAt = body.indexOf('saveEvent({');
  assert.ok(gateAt > 0, 'the route must call geofenceCheckinReason');
  assert.ok(gateAt < saveAt, 'the gate must run BEFORE saveEvent, or a refused check-in is still recorded');
  assert.ok(/hikSource === 'webscan'/.test(body.slice(0, gateAt)),
    'the gate must be inside the webscan branch -- the physical device is never gated');
  assert.ok(/webScanWouldBeCheckIn\(/.test(body.slice(0, gateAt)),
    'the check-in test must run before the gate, so check-outs are never gated');
  assert.ok(/req\.hikUser\.role/.test(body.slice(0, gateAt + 400)),
    'the role must come from the live record, never from the request body');
  assert.ok(/status\(403\)/.test(body.slice(gateAt, gateAt + 600)), 'refusal must be a 403');
});

test('the stored event carries the accuracy, and it is not public', () => {
  const route = SERVER_SRC.slice(SERVER_SRC.indexOf("app.post('/api/hikvision/event'"));
  assert.ok(/gpsAcc/.test(route.slice(0, route.indexOf('\napp.'))), 'the event must store gpsAcc');
  const pub = /const EVENT_PUBLIC_FIELDS = \[[^\]]*\]/.exec(SERVER_SRC)[0];
  assert.ok(!/gpsAcc/.test(pub), 'gpsAcc must stay out of the public projection, like gps itself');
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node tests/geofence.test.js`
Expected: FAIL — `function sanitizeGpsAccuracy not found`.

- [ ] **Step 3: Add the two helpers**

Directly after `sanitizeGps()` (~1456):

```js
// 2026-09-25: the browser's reported accuracy in metres, for the geofence gate and for reviewing a
// stored position afterwards. Bounded like every other client-supplied number here.
function sanitizeGpsAccuracy(raw) {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 && n <= 100000 ? Math.round(n) : null;
}
```

Directly after `buildAttendanceLogForUser()` (~9072):

```js
// 2026-09-25: would this WebScan become the day's CHECK-IN? Mirrors buildAttendanceLogForUser()'s
// own rules so the gate and the attendance log can never disagree. Check-out is never gated.
function webScanWouldBeCheckIn(user, eventTimeIso) {
  const raw = String(eventTimeIso || '');
  const datePart = raw.substring(0, 10);
  const timePart = raw.substring(11, 16);
  const hour = parseInt(timePart.substring(0, 2), 10);
  if (!Number.isFinite(hour) || hour < 5) return false;   // late-night return = check-out
  if (timePart >= CHECKIN_CUTOFF) return false;           // first scan after the cutoff = check-out
  const log = buildAttendanceLogForUser(user);
  return !(log[datePart] && log[datePart].checkIn);
}
```

- [ ] **Step 4: Wire the gate into the route**

In the WebScan branch, after `eventTime = taNowIso();` and before `saveEvent({...})` (~1795), insert:

```js
    // 2026-09-25 (owner): attendance at the office is recorded by the face scanner. A web check-in
    // from inside the office radius is refused; a check-out is not gated at all, and the physical
    // device never reaches this code.
    if (req.hikSource === 'webscan' && webScanWouldBeCheckIn(req.hikUser, eventTime)) {
      const G = getAppSettings().geofence;
      const coords = gps ? parseGpsCoords(gps) : null;
      const reason = geofenceCheckinReason(
        G, req.hikUser.role,
        coords ? coords.lat : NaN, coords ? coords.lng : NaN,
        gpsAccuracy
      );
      if (reason) {
        const messages = {
          'geofence-inside': 'Company policy: check-in must be made with the face scanner at the office.',
          'geofence-no-position': 'Web check-in requires your location.',
          'geofence-accuracy': 'Your location is not precise enough yet.',
        };
        return res.status(403).json({ success: false, reason, message: messages[reason] });
      }
    }
```

Add `const gpsAccuracy = sanitizeGpsAccuracy(body.gpsAccuracy);` beside the existing `const gps = sanitizeGps(body.gps);` (~1745), and store it on the event by extending the `saveEvent({...})` call:

```js
      ...(gpsAccuracy !== null ? { gpsAcc: gpsAccuracy } : {}),
```

- [ ] **Step 5: Confirm the projection**

Read `EVENT_PUBLIC_FIELDS` (~720) and confirm it is a whitelist that does not list `gpsAcc`, so the new field is only visible to the owner and privileged admins, exactly like `gps`. If the privileged path enumerates fields explicitly rather than passing the record through, add `gpsAcc` there.

- [ ] **Step 6: Run the tests, syntax check, commit**

```bash
node tests/geofence.test.js
node --check attendance-server/backend/server.js
npm run lint && npm test
git add attendance-server/backend/server.js tests/geofence.test.js
git commit -m "feat(geofence): refuse a web check-in inside the office radius"
```

---

### Task 4: The client — payload, pre-check, button state, policy note

**Files:**
- Modify: `attendance/js/app.js` — `onGPSSuccess()` (~7030), `doScan()` (~7773)
- Modify: `attendance/index.html` — the scan button block (~335)
- Modify: `attendance/lang/ja.js`
- Test: `tests/geofence.test.js` (extend)

**Interfaces:**
- Consumes: `geofenceCheckinReason()` (Task 1), `APP_SETTINGS.geofence` (Task 2), the 403 `reason` codes (Task 3).
- Produces: `geofenceUiState() -> { blocked: boolean, reason: string, text: string }`, called from `onGPSSuccess()` and after settings load.

- [ ] **Step 1: Write the failing test**

Append to `tests/geofence.test.js`:

```js
console.log('Geofence: the client');

const JA_SRC = fs.readFileSync(path.join(ROOT, 'attendance/lang/ja.js'), 'utf8');
const INDEX_SRC = fs.readFileSync(path.join(ROOT, 'attendance/index.html'), 'utf8');

test('the check-in POST sends the accuracy', () => {
  const fn = extractFunction(APP_SRC, 'doScan');
  assert.ok(/gpsAccuracy:/.test(fn), 'doScan must send gpsAccuracy or the server refuses every check-in');
});

test('the client refuses before posting, using the same shared function', () => {
  const fn = extractFunction(APP_SRC, 'doScan');
  assert.ok(/geofenceCheckinReason\(/.test(fn), 'doScan must pre-check');
  const preIdx = fn.indexOf('geofenceCheckinReason');
  const postIdx = fn.indexOf('/api/hikvision/event');
  assert.ok(preIdx > 0 && preIdx < postIdx, 'the pre-check must run before the request');
});

test('every new message exists in all three languages', () => {
  const EN = [
    'Company policy: check-in must be made with the face scanner at the office.',
    'Web check-in requires your location',
    'not precise enough',
  ];
  for (const en of EN) assert.ok(APP_SRC.includes(en), `English string missing: ${en}`);
  for (const th of ['กรุณาสแกนที่เครื่อง', 'กรุณาอนุญาตให้เข้าถึงตำแหน่ง', 'ยังไม่แม่นพอ']) {
    assert.ok(APP_SRC.includes(th), `Thai string missing: ${th}`);
  }
  for (const ja of ['顔認証端末', '位置情報が必要', '精度が不足']) {
    assert.ok(JA_SRC.includes(ja), `Japanese string missing: ${ja}`);
  }
});

test('the standing policy note is on the check-in screen, not only in the error', () => {
  assert.ok(/id="scan-policy-note"/.test(INDEX_SRC), 'the policy note element must exist');
  assert.ok(/data-en=/.test(INDEX_SRC.slice(INDEX_SRC.indexOf('scan-policy-note') - 300, INDEX_SRC.indexOf('scan-policy-note') + 300)),
    'the note must carry data-en so fixStaticText() can translate it');
});

test('the button state function never reads currentUser at load time', () => {
  // fixStaticText() runs before login; anything it touches must not assume a logged-in user.
  const fn = extractFunction(APP_SRC, 'geofenceUiState');
  assert.ok(/currentUser/.test(fn) === false || /currentUser\s*&&/.test(fn) || /currentUser\?\./.test(fn),
    'guard every currentUser read in geofenceUiState');
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node tests/geofence.test.js`
Expected: FAIL — `doScan must send gpsAccuracy...`.

- [ ] **Step 3: Send the accuracy and pre-check in `doScan()`**

In `doScan()` (~7784), beside the existing `gpsInfo`:

```js
  const gpsAcc = currentGPS && Number.isFinite(Number(currentGPS.accuracy)) ? Number(currentGPS.accuracy) : null;
  // Preview of the server's decision (the server decides for real -- see server.js's WebScan gate).
  const isFirstScan = !isPreDawn && !attendanceLog[key]?.checkIn && timeStr < CHECKIN_CUTOFF;
  if (isFirstScan) {
    const reason = geofenceCheckinReason(
      APP_SETTINGS.geofence, currentUser && currentUser.role,
      currentGPS ? Number(currentGPS.latRaw) : NaN,
      currentGPS ? Number(currentGPS.lngRaw) : NaN,
      gpsAcc
    );
    if (reason) { showToast(geofenceMessage(reason, gpsAcc), 'warning'); return; }
  }
```

`isPreDawn`, `key` and `timeStr` already exist a few lines above. Add `gpsAccuracy: gpsAcc` to the POST body alongside `gps: gpsInfo`.

- [ ] **Step 4: Add the message helper and the button state**

Add next to `gpsErrorMsg()` (~7010):

```js
function geofenceMessage(reason, acc) {
  if (reason === 'geofence-inside') {
    return L('Company policy: check-in must be made with the face scanner at the office. You are within the office area — please scan at the device.',
             'นโยบายบริษัท: การลงเวลาเข้างานต้องสแกนใบหน้าที่เครื่องในออฟฟิศ — ขณะนี้คุณอยู่ในบริเวณออฟฟิศ กรุณาสแกนที่เครื่อง');
  }
  if (reason === 'geofence-no-position') {
    return L('Web check-in requires your location — please allow location access, or use the face scanner at the office.',
             'เช็คอินผ่านเว็บต้องระบุตำแหน่ง — กรุณาอนุญาตให้เข้าถึงตำแหน่งในเบราว์เซอร์ หรือสแกนใบหน้าที่เครื่องในออฟฟิศ');
  }
  const a = Number.isFinite(Number(acc)) ? ` (±${Math.round(Number(acc))} m)` : '';
  return L(`Your location is not precise enough yet${a} — please wait a moment or move to an open area.`,
           `ตำแหน่งยังไม่แม่นพอ${a} — กรุณารอสักครู่หรือขยับไปที่โล่ง`);
}
function geofenceUiState() {
  const role = currentUser ? currentUser.role : '';
  const reason = geofenceCheckinReason(
    APP_SETTINGS.geofence, role,
    currentGPS ? Number(currentGPS.latRaw) : NaN,
    currentGPS ? Number(currentGPS.lngRaw) : NaN,
    currentGPS ? Number(currentGPS.accuracy) : null
  );
  return { blocked: !!reason, reason, text: reason ? geofenceMessage(reason, currentGPS && currentGPS.accuracy) : '' };
}
function applyGeofenceToScanButton() {
  const btn = document.getElementById('scan-btn');
  const hint = document.getElementById('scan-geofence-hint');
  if (!btn) return;
  const st = geofenceUiState();
  btn.disabled = st.blocked;
  btn.classList.toggle('scan-blocked', st.blocked);
  if (hint) { hint.textContent = st.text; hint.style.display = st.blocked ? 'block' : 'none'; }
}
```

Call `applyGeofenceToScanButton()` at the end of `onGPSSuccess()`, in `gpsErrorMsg()`'s caller (the watchPosition error handler), and once after settings load.

- [ ] **Step 5: Add the markup and the Japanese entries**

In `attendance/index.html`, inside the scan block (~335), directly above the button:

```html
                <div id="scan-policy-note" class="scan-policy-note"
                     data-en="Company policy: check in with the face scanner at the office. Web check-in is for working away from the office.">
                  นโยบายบริษัท: การลงเวลาเข้างานให้สแกนใบหน้าที่เครื่องในออฟฟิศ — เช็คอินผ่านเว็บใช้สำหรับการทำงานนอกออฟฟิศ
                </div>
                <div id="scan-geofence-hint" class="scan-geofence-hint" style="display:none"></div>
```

In `attendance/lang/ja.js`, add entries keyed by the exact English strings:

```js
  "Company policy: check in with the face scanner at the office. Web check-in is for working away from the office.": "会社規定により、出勤打刻はオフィスの顔認証端末で行ってください。Web打刻は社外勤務用です。",
  "Company policy: check-in must be made with the face scanner at the office. You are within the office area — please scan at the device.": "会社規定により、出勤打刻はオフィスの顔認証端末で行ってください。現在オフィス周辺にいるため、Webでの出勤打刻はできません。",
  "Web check-in requires your location — please allow location access, or use the face scanner at the office.": "Web出勤打刻には位置情報が必要です。ブラウザで位置情報を許可するか、オフィスの顔認証端末をご利用ください。",
```

For the accuracy message, whose English text interpolates `±N m`, add the JA entry for the fixed prefix used by `L()`'s lookup and verify in the browser that JA mode shows Japanese, not the English fallback — the project's `ja.js` is keyed by whole strings, so if the interpolated form does not match, split the message into a fixed sentence plus the `±N m` appended outside the translated part.

- [ ] **Step 6: Run the tests, syntax check, commit**

```bash
node tests/geofence.test.js
node --check attendance/js/app.js
npm run lint && npm test
git add attendance/js/app.js attendance/index.html attendance/lang/ja.js tests/geofence.test.js
git commit -m "feat(geofence): client pre-check, blocked button and the policy note"
```

---

### Task 5: Settings page

**Files:**
- Modify: `attendance/js/app.js` — the settings render (~4516) and `saveSettingsPage()`'s field reads (~5245)
- Test: `tests/geofence.test.js` (extend)

**Interfaces:**
- Consumes: `APP_SETTINGS.geofence` (Task 2).
- Produces: the five inputs `set-geo-enabled`, `set-geo-lat`, `set-geo-lng`, `set-geo-radius`, `set-geo-acc`.

**Two facts about this code path, verified before writing this task:**

1. `saveSettingsPage()` (~5107) reads the inputs into `APP_SETTINGS`, then calls
   `savePayrollSettings()` (~2674), which PUTs `{ ...APP_SETTINGS }` minus the three email keys.
   The complete `geofence` object therefore reaches the server automatically — no client-side
   whitelist to extend, and no partial patch.
2. **Do not read the coordinates with the existing `fi`/`ff` helpers.** Both end in `|| 0`
   (`const ff = id => parseFloat(...) || 0`), so an empty or mistyped latitude field silently saves
   `0` — moving the office centre into the Atlantic and disabling the geofence with no error shown.
   This task adds a strict reader instead.

- [ ] **Step 1: Write the failing test**

```js
test('the Settings page exposes all five geofence fields and saves them safely', () => {
  for (const id of ['set-geo-enabled', 'set-geo-lat', 'set-geo-lng', 'set-geo-radius', 'set-geo-acc']) {
    assert.ok(APP_SRC.includes(id), `Settings field missing: ${id}`);
  }
  const save = extractFunction(APP_SRC, 'saveSettingsPage');
  for (const key of ['enabled', 'lat', 'lng', 'radiusM', 'maxAccuracyM']) {
    assert.ok(new RegExp(`geofence\\.${key}\\s*=`).test(save), `save must write geofence.${key}`);
  }
  // Falsy-zero guard: `ff()` ends in `|| 0`, which would turn an empty latitude into 0.
  const geoLines = save.split('\n').filter(l => /geofence\.(lat|lng|radiusM|maxAccuracyM)\s*=/.test(l));
  assert.ok(geoLines.length === 4, 'all four numeric fields must be assigned');
  for (const line of geoLines) {
    assert.ok(!/\bff\(|\bfi\(/.test(line),
      `use the strict reader, not fi()/ff() -- they coerce an empty field to 0: ${line.trim()}`);
  }
  assert.ok(/geofenceNum\(/.test(save), 'a strict numeric reader must be used for the geofence fields');
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node tests/geofence.test.js` — FAIL on `set-geo-enabled`.

- [ ] **Step 3: Render the card**

Beside the work-schedule inputs (~4516), following the same `inp()` helper and card markup already used there, add a card titled `L('Web check-in area', 'พื้นที่เช็คอินผ่านเว็บ')` containing: a checkbox `set-geo-enabled` bound to `s.geofence.enabled`; number inputs `set-geo-lat` / `set-geo-lng` (`step="0.0000001"`), `set-geo-radius` (`min="10" max="5000"`), `set-geo-acc` (`min="5" max="1000"`); and a read-only line stating that `driver` is always exempt. Label each with its unit and add the helper line `L('Inside this radius, check-in must use the face scanner.', 'ภายในรัศมีนี้ การลงเวลาเข้างานต้องสแกนใบหน้าที่เครื่อง')` — with matching `ja.js` entries.

- [ ] **Step 4: Read the fields back on save**

In `saveSettingsPage()` (~5245), beside the existing `fi('set-std-hour')` reads. Declare the strict
reader next to the existing `fv`/`fi`/`ff` helpers (~5131):

```js
  // Strict: keeps the stored value when a field is blank or unreadable, instead of writing 0.
  // `ff()` would save latitude 0 for an empty box and silently move the office to the Atlantic.
  const geofenceNum = (id, fallback) => {
    const v = parseFloat(document.getElementById(id)?.value);
    return Number.isFinite(v) ? v : fallback;
  };
```

```js
  APP_SETTINGS.geofence.enabled      = !!document.getElementById('set-geo-enabled')?.checked;
  APP_SETTINGS.geofence.lat          = geofenceNum('set-geo-lat',    APP_SETTINGS.geofence.lat);
  APP_SETTINGS.geofence.lng          = geofenceNum('set-geo-lng',    APP_SETTINGS.geofence.lng);
  APP_SETTINGS.geofence.radiusM      = geofenceNum('set-geo-radius', APP_SETTINGS.geofence.radiusM);
  APP_SETTINGS.geofence.maxAccuracyM = geofenceNum('set-geo-acc',    APP_SETTINGS.geofence.maxAccuracyM);
```

No change is needed to how the request is sent: `saveSettingsPage()` calls `savePayrollSettings()`,
which PUTs `const { emailConfig, emailNotification, payslipEmailEnabled, ...payrollOnlyAppSettings } = APP_SETTINGS`
— the complete `geofence` object travels with it.

- [ ] **Step 5: Run the tests and commit**

```bash
node tests/geofence.test.js && npm run lint && npm test
git add attendance/js/app.js attendance/lang/ja.js tests/geofence.test.js
git commit -m "feat(geofence): Settings fields for the office area"
```

---

### Task 6: Show the stored accuracy when reviewing a position

**Files:**
- Modify: `attendance/js/app.js` — `gpsPopupHtml()` (~7375) and the attendance-row GPS buttons (~8657)
- Test: `tests/geofence.test.js` (extend)

**Interfaces:**
- Consumes: the `gpsAcc` field stored in Task 3.

- [ ] **Step 1: Write the failing test**

```js
test('the review popup shows the accuracy that was stored with the position', () => {
  const rows = APP_SRC.slice(APP_SRC.indexOf('const gpsInBtn'), APP_SRC.indexOf('const gpsInBtn') + 1200);
  assert.ok(/checkInGpsAcc|gpsAcc/.test(rows), 'the row must pass the stored accuracy to the popup');
  const fn = extractFunction(APP_SRC, 'gpsPopupHtml');
  assert.ok(/±/.test(fn), 'the popup must render the accuracy');
});
```

- [ ] **Step 2: Run it and watch it fail.** Run: `node tests/geofence.test.js`.

- [ ] **Step 3:** Carry `gpsAcc` from the event onto the scan rows (beside `checkInGPS` / `checkOutGPS`, ~6607) and pass it into the map popup, rendering `±N m` when present and nothing when absent — old records have no accuracy and must not show a made-up one.

- [ ] **Step 4: Run the tests and commit**

```bash
node tests/geofence.test.js && npm run lint && npm test
git add attendance/js/app.js tests/geofence.test.js
git commit -m "feat(geofence): show the stored GPS accuracy when reviewing a check-in"
```

---

### Task 7: Cache-busters, full check, and the deploy gate

**Files:**
- Modify: `attendance/index.html` (the `?v=` pointers), `attendance/sw.js` (cache version)

- [ ] **Step 1: Bump the cache-busters**

Only after `node --check` passes on both edited JS files: bump `app.js?v=`, `ja.js?v=`, and the `ta-shell-*` / `ta-data-*` cache names in `sw.js` to the next letter/number in the existing sequence. A stale cached `app.js` sends no accuracy and is refused by the server, so this step is what keeps that window short.

- [ ] **Step 2: Full check**

```bash
npm run check
```
Expected: lint clean, 10/10 test files pass.

- [ ] **Step 3: Scan for use-before-define**

Run the project's TDZ scan (a `const` referenced above its declaration passes both `node --check` and ESLint but stops the server from booting — it has happened here before).

- [ ] **Step 4: STOP — ask the owner before deploying**

Everything above happens in the worktree. Merging into the NAS repo and restarting the server is a separate, explicitly authorised step. When authorised: merge `work/2026-09-25` into `main` on `Z:\Time_Attendance`, deploy, then **verify the deploy before any live test** by comparing the running process start time against `server.js`'s mtime.

- [ ] **Step 5: Live verification with Playwright** (after a verified deploy)

Log in as a `user` account and as the `driver` account (QA credentials are in memory). With location mocked at Paso Tower: the user is refused with the policy message and the button is disabled; the driver checks in normally. With location mocked at the Amara Hotel and accuracy 30 m: the user checks in normally. Check the check-out path at the office is unaffected. Screenshot each state in TH, EN and JA — assert on what the screen shows, not on an internal flag.

---

## Self-review notes

- Spec coverage: gate order (T3), radius/accuracy/exempt/centre defaults (T2), settings editing (T5), payload + storage (T3), messages in three languages (T4), standing policy note (T4), accuracy in the review popup (T6), tests for every property the spec names (T1–T6), cache-buster window (T7). The spec's "no logging of blocked attempts" is satisfied by absence — no task adds one.
- The spec says MD edits the settings; this plan gives MD + Accounting by storing them in `appSettings`. Flagged at the top; change to a `['md']` top-level key if the owner prefers.
- `parseGpsCoords()` and `buildAttendanceLogForUser()` already exist and are reused rather than reimplemented. `buildAttendanceLogForUser()` is a hoisted function declaration, so calling it from the route above its definition is safe — unlike a `const`, which would be a TDZ crash at boot.
