'use strict';

// 2026-09-25 (owner: "ต้องใช้งานได้ตลอด"): until now this worker only handled push notifications --
// `CACHE` was declared and never used and there was no fetch handler at all, so the installed app
// was a plain web page: no network, no app. It can now be opened and read offline.
//
// Deliberately READ-ONLY offline (owner chose option A): the shell and the last GET /api responses
// are served from cache, but anything that WRITES (check-in, leave request, approval) is never
// queued or replayed -- a time record invented from a phone's clock hours after the fact is worse
// than an error message. Non-GET requests simply fail while offline and the UI says so.
const SHELL_CACHE = 'ta-shell-v9';   // app shell: html/js/css/images, cache-first
const DATA_CACHE  = 'ta-data-v9';    // GET /api responses, network-first

// Query strings are part of the key, so a `?v=` bump is a cache miss and fetches the new file --
// the existing cache-buster keeps working unchanged. Old entries are dropped on activate.
const SHELL_URLS = [
  './',
  './index.html',
  './manifest.json',
  './images/logo-short.jpg',
  './images/logo-long.jpg',
  './images/logo-long.png',
  './images/icon-192.png',
  './images/icon-512.png',
];

self.addEventListener('install', e => {
  // addAll() is atomic: one 404 and nothing is cached. The versioned js/css are left to the
  // runtime handler instead, so a stale URL list here can never block the install.
  e.waitUntil(
    caches.open(SHELL_CACHE)
      .then(c => c.addAll(SHELL_URLS))
      .catch(err => console.warn('[SW] shell precache incomplete:', err && err.message))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e =>
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== SHELL_CACHE && k !== DATA_CACHE).map(k => caches.delete(k))
      ))
      .then(pruneVersionedShellEntries)
      .then(() => clients.claim())
  )
);

// 2026-09-25 (Opus ripple review): `app.js?v=...` and `style.css?v=...` are a different cache key
// on every deploy, and nothing ever removed the previous one -- each release left another ~1 MB
// copy of app.js in the cache forever. Keep only the newest entry per path. Runs on activate, i.e.
// once per worker version, which is exactly when a new `?v=` has just appeared.
async function pruneVersionedShellEntries() {
  try {
    const cache = await caches.open(SHELL_CACHE);
    const reqs = await cache.keys();
    const byPath = new Map();
    for (const r of reqs) {
      const u = new URL(r.url);
      if (!u.search) continue;                       // unversioned entries are one-per-path already
      if (!/\.(js|css)$/.test(u.pathname)) continue; // only the versioned code assets
      if (!byPath.has(u.pathname)) byPath.set(u.pathname, []);
      byPath.get(u.pathname).push(r);
    }
    for (const list of byPath.values()) {
      // The freshest copy is the one the current index.html asked for, which is also the most
      // recently written -- cache.keys() returns insertion order, so keep the last.
      for (const r of list.slice(0, -1)) await cache.delete(r);
    }
  } catch (_) { /* quota/private mode -- nothing to prune there anyway */ }
}

// Only same-origin GETs are touched. Anything else -- POST/PUT/DELETE, and every cross-origin
// request (jsDelivr, Google Fonts, map tiles) -- goes straight to the network untouched, so a bug
// here cannot break a write path or a third-party asset.
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  let url;
  try { url = new URL(req.url); } catch (_) { return; }
  if (url.origin !== self.location.origin) return;

  const isApi = url.pathname.startsWith('/api/');

  // Never cache auth or streaming endpoints: a cached login/session answer served offline would
  // present a signed-out user as signed in.
  if (isApi && /\/api\/(login|logout|now|health|events\/stream)/.test(url.pathname)) return;

  if (isApi) {
    // Network-first: online behaviour is unchanged (always fresh). The cached copy is a fallback
    // for reading while offline, and the UI labels it as such -- see OFFLINE_SINCE in app.js.
    e.respondWith(
      fetch(req)
        .then(res => {
          // JSON only. Four GET routes under /api return FILES -- payslip-xlsx, payslip-xlsx-all,
          // tawi50-xlsx-all and upload/:filename -- and caching those meant every payslip and
          // attachment an admin ever opened was written to the device: megabytes per file, enough
          // to hit the browser's storage quota (at which point cache writes fail silently, since
          // the .catch() below swallows them), and a stale payslip could be replayed offline as if
          // it were current. Nothing offline needs them: you cannot meaningfully download a fresh
          // export without a network anyway.
          const ct = res && res.headers ? (res.headers.get('content-type') || '') : '';
          if (res && res.ok && ct.includes('application/json')) {
            const copy = res.clone();
            caches.open(DATA_CACHE).then(c => c.put(req, copy)).catch(() => {});
          }
          return res;
        })
        .catch(() => caches.match(req).then(async hit => {
          if (!hit) {
            return new Response(
              JSON.stringify({ success: false, offline: true, message: 'Offline -- no cached copy of this request' }),
              { status: 503, headers: { 'Content-Type': 'application/json' } });
          }
          // A cache hit replays the ORIGINAL 200, so the page cannot tell it apart from a live
          // answer -- the offline banner hid itself the moment any read succeeded from cache, and
          // the user was left reading yesterday's numbers with nothing saying so. Stamp it.
          const headers = new Headers(hit.headers);
          headers.set('X-TA-From-Cache', '1');
          return new Response(await hit.blob(), { status: hit.status, statusText: hit.statusText, headers });
        }))
    );
    return;
  }

  // index.html / navigations: NETWORK-FIRST. This document carries the `?v=` cache-busters that
  // point at the current js and css, so serving a cached copy first would pin the whole app to the
  // previous deploy until a second reload -- worse than having no offline at all. Online it is
  // always fresh; offline it falls back to the cached copy.
  const isDoc = req.mode === 'navigate' || /\.html?$/.test(url.pathname) || url.pathname.endsWith('/');
  if (isDoc) {
    e.respondWith(
      fetch(req)
        .then(res => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(SHELL_CACHE).then(c => c.put(req, copy)).catch(() => {});
          }
          return res;
        })
        .catch(() => caches.match(req).then(hit => hit || caches.match('./index.html')))
    );
    return;
  }

  // 2026-09-25 (Opus ripple review): employee photos are NOT shell. The app requests them as
  // `…jpg?t=<Date.now()>` to defeat browser caching after an upload, which makes every single view
  // a brand-new cache key -- opening 40 employee records wrote 40 entries, and again next week.
  // They are also per-person data sitting in a cache that logout does not clear (only ta-data-* is).
  // Straight to the network, never stored.
  if (url.pathname.includes('/images/employees/')) return;

  // Everything else (js, css, images) is versioned or immutable in practice, so cache-first is safe
  // and fast: a `?v=` bump is a different key and misses the cache. The background refresh keeps an
  // unversioned asset (an image) current without blocking the render.
  e.respondWith(
    caches.match(req).then(hit => {
      const net = fetch(req).then(res => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(SHELL_CACHE).then(c => c.put(req, copy)).catch(() => {});
        }
        return res;
      }).catch(() => hit);
      return hit || net;
    })
  );
});

// Server-push handler (VAPID — future use)
self.addEventListener('push', e => {
  let d = { title: 'Time Attendance', body: '' };
  try { d = Object.assign(d, e.data.json()); } catch {}
  e.waitUntil((async () => {
    if (typeof d.badge === 'number' && navigator.setAppBadge) {
      try {
        if (d.badge > 0) await navigator.setAppBadge(d.badge);
        else await navigator.clearAppBadge();
      } catch (_) {}
    }
    return self.registration.showNotification(d.title, {
      body:  d.body,
      icon:  '/images/logo-short.jpg',
      badge: '/images/logo-short.jpg',
      tag:   d.tag || 'ta',
      renotify: true,
      data:  d,
    });
  })());
});

// Open app when user clicks notification
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/';
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const c of list) {
        if (new URL(c.url).origin === self.location.origin && 'focus' in c) return c.focus();
      }
      return clients.openWindow(url);
    })
  );
});

// Main thread → SW notification bridge (works even in background tabs)
self.addEventListener('message', e => {
  if (!e.data || e.data.type !== 'SHOW') return;
  self.registration.showNotification(e.data.title || 'Time Attendance', {
    body:  e.data.body  || '',
    icon:  '/images/logo-short.jpg',
    badge: '/images/logo-short.jpg',
    tag:   e.data.tag   || 'ta',
    data:  e.data,
  });
});
