// Regression guard for the scanner WebSocket reconnect loop found on the live site 2026-10-17.
//
// What was wrong: initHikvisionLive() replaced a live socket with
//     if (hikvisionWs) { try { hikvisionWs.close(); } catch(e) {} }
//     clearTimeout(wsReconnectTimer);
// `close()` is ASYNCHRONOUS, so the replaced socket's own onclose ran AFTER that clearTimeout and
// set wsReconnectTimer = setTimeout(initHikvisionLive, 5000) again -- a timer nothing could then
// cancel. Five seconds later it replaced the healthy socket, whose onclose armed the next one, so
// a single disconnect put the tab into a permanent connect/close cycle that never recovered.
// Measured on the live site: close code 1005 (a LOCAL close with no status) with wasClean true,
// every ~5.5s, and initHikvisionLive() called from an empty stack (a timer) four times in 22s.
// The status dot still read "connected" because a socket was usually open, so nobody could see it,
// while scan events arriving inside a gap were lost.
//
// The function is read out of the real attendance/js/app.js and run in a sandbox, like the other
// client-side tests here, so this cannot pass against a copy that has drifted from what ships.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const APP_SRC = fs.readFileSync(path.join(ROOT, 'attendance/js/app.js'), 'utf8');

function balancedFrom(src, start, label) {
  const i = src.indexOf('{', start);
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (depth === 0) return src.slice(start, j + 1); }
  }
  throw new Error(`unbalanced ${label}`);
}
function extractFunction(src, name) {
  const m = new RegExp(`^(async )?function ${name}\\(`, 'm').exec(src);
  if (!m) throw new Error(`function ${name} not found`);
  return balancedFrom(src, m.index, name);
}

// A sandbox with a fake WebSocket whose close() is asynchronous, like the real one: the onclose
// handler is delivered by flushCloses(), not during close() itself. That asynchrony IS the bug,
// so a fake that called onclose synchronously would hide it.
function makeWorld() {
  const sockets = [];
  const timers = [];
  const queuedCloses = [];

  function FakeWebSocket(url) {
    this.url = url;
    this.readyState = 0; // CONNECTING
    this.onopen = this.onmessage = this.onclose = this.onerror = null;
    sockets.push(this);
  }
  FakeWebSocket.prototype.close = function () {
    if (this.readyState === 3) return;
    this.readyState = 3; // CLOSED
    queuedCloses.push(this);
  };

  const ctx = {
    WebSocket: FakeWebSocket,
    encodeURIComponent,
    console: { log() {}, error() {}, warn() {} },
    // the bits initHikvisionLive() touches on the way in and out
    currentUser: { id: 1, role: 'md' },
    AUTH_TOKEN: 'test-token',
    NAS_WS: 'wss://example.invalid/ws',
    hikvisionWs: null,
    wsReconnectTimer: null,
    updateWsStatus() {},
    loadNotifications() {},
    setTimeout(fn, ms) { timers.push({ id: timers.length + 1, fn, ms, cancelled: false }); return timers.length; },
    clearTimeout(id) { const t = timers.find(t => t.id === id); if (t) t.cancelled = true; },
  };
  vm.createContext(ctx);
  vm.runInContext(extractFunction(APP_SRC, 'initHikvisionLive'), ctx);

  return {
    ctx,
    sockets,
    init: () => ctx.initHikvisionLive(),
    open: (ws) => { ws.readyState = 1; if (ws.onopen) ws.onopen(); },
    // deliver every queued close callback, as the browser's event loop would
    flushCloses: () => { while (queuedCloses.length) { const ws = queuedCloses.shift(); if (ws.onclose) ws.onclose({ code: 1005, reason: '', wasClean: true }); } },
    pending: () => timers.filter(t => !t.cancelled),
  };
}

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok  ${name}`); }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; }
}

// ---------------------------------------------------------------------------------------------

test('replacing a live socket leaves no reconnect timer behind (the loop that shipped)', () => {
  const w = makeWorld();
  w.init();
  w.open(w.sockets[0]);
  assert.strictEqual(w.pending().length, 0, 'a freshly opened socket should have no retry pending');

  // Anything that calls init() again while the socket is open: the orphaned timer itself, a second
  // initApp(), a manual reconnect. The replaced socket must not be able to arm a new timer.
  w.init();
  w.open(w.sockets[1]);
  w.flushCloses();

  assert.strictEqual(w.sockets.length, 2, 'the second init should have opened exactly one new socket');
  assert.strictEqual(w.ctx.hikvisionWs, w.sockets[1], 'the live socket must be the newest one');
  assert.deepStrictEqual(
    w.pending().map(t => t.ms), [],
    'the replaced socket armed a reconnect timer after clearTimeout had already run -- this is the 5s connect/close loop'
  );
});

test('a socket that really drops still reconnects exactly once', () => {
  const w = makeWorld();
  w.init();
  w.open(w.sockets[0]);

  // a genuine disconnect (network blip, laptop lid, proxy hiccup)
  w.sockets[0].readyState = 3;
  w.flushCloses.call(null);
  if (w.sockets[0].onclose) w.sockets[0].onclose({ code: 1006, reason: '', wasClean: false });

  const waiting = w.pending();
  assert.strictEqual(waiting.length, 1, 'a real drop should arm exactly one retry');
  assert.strictEqual(waiting[0].ms, 5000, 'the retry delay should still be 5s');

  waiting[0].fn();                 // the retry fires
  w.open(w.sockets[1]);
  w.flushCloses();
  assert.strictEqual(w.sockets.length, 2, 'the retry should open one replacement socket');
  assert.strictEqual(w.pending().length, 0, 'after a successful reconnect nothing should still be scheduled');
});

test('no retry is armed once the user is logged out', () => {
  const w = makeWorld();
  w.init();
  w.open(w.sockets[0]);
  w.ctx.currentUser = null;
  w.ctx.AUTH_TOKEN = null;
  w.sockets[0].readyState = 3;
  if (w.sockets[0].onclose) w.sockets[0].onclose({ code: 1005, reason: '', wasClean: true });
  assert.strictEqual(w.pending().length, 0, 'a logged-out tab must not keep reconnecting');
});

console.log(`ws-reconnect: ${passed} passed`);
