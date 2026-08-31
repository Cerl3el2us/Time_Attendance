'use strict';

const CACHE = 'ta-v1';

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', e =>
  e.waitUntil(clients.claim())
);

// Server-push handler (VAPID — future use)
self.addEventListener('push', e => {
  let d = { title: 'Time Attendance', body: '' };
  try { d = Object.assign(d, e.data.json()); } catch {}
  e.waitUntil(
    self.registration.showNotification(d.title, {
      body:  d.body,
      icon:  '/images/logo-short.jpg',
      badge: '/images/logo-short.jpg',
      tag:   d.tag || 'ta',
      data:  d,
    })
  );
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
