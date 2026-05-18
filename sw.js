// ── Confluence Screener Service Worker ────────────────────
// Runs in background even when browser is closed
// Listens to Firebase for new alerts and fires push notifications

const CACHE_NAME = 'confluence-screener-v1';
const DB_URL = 'https://confluence-screener-default-rtdb.firebaseio.com';

// ── Install ───────────────────────────────────────────────
self.addEventListener('install', event => {
  console.log('[SW] Installing...');
  self.skipWaiting();
});

// ── Activate ──────────────────────────────────────────────
self.addEventListener('activate', event => {
  console.log('[SW] Activated');
  event.waitUntil(clients.claim());
});

// ── Push notification received ────────────────────────────
self.addEventListener('push', event => {
  let data = {};
  try { data = event.data.json(); } catch(e) { data = { title: 'Confluence Screener', body: event.data?.text() || 'New alert' }; }
  event.waitUntil(
    self.registration.showNotification(data.title || 'Confluence Screener', {
      body:    data.body || '',
      icon:    '/confluence-screener/icon.png',
      badge:   '/confluence-screener/icon.png',
      tag:     data.tag || 'screener-alert',
      data:    data,
      vibrate: [200, 100, 200],
      actions: [
        { action: 'open',    title: '📈 Open Screener' },
        { action: 'dismiss', title: 'Dismiss' }
      ]
    })
  );
});

// ── Notification click ────────────────────────────────────
self.addEventListener('notificationclick', event => {
  event.notification.close();
  if (event.action === 'dismiss') return;
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientList => {
      const url = 'https://shoprevoltinc-source.github.io/confluence-screener/';
      for (const client of clientList) {
        if (client.url.includes('confluence-screener') && 'focus' in client) {
          return client.focus();
        }
      }
      if (clients.openWindow) return clients.openWindow(url);
    })
  );
});

// ── Background sync — poll Firebase every 5 min ───────────
// This fires even when browser is closed on supported browsers
self.addEventListener('periodicsync', event => {
  if (event.tag === 'check-alerts') {
    event.waitUntil(checkFirebaseAlerts());
  }
});

// ── Message from main app ─────────────────────────────────
self.addEventListener('message', event => {
  if (event.data?.type === 'CHECK_ALERTS') {
    checkFirebaseAlerts();
  }
});

// ── Check Firebase for new alerts ────────────────────────
let lastAlertTime = {};

async function checkFirebaseAlerts() {
  const sessions = ['premarket', 'open', 'midday', 'afternoon', 'preclose'];
  for (const session of sessions) {
    try {
      const res = await fetch(`${DB_URL}/screener/alerts_${session}.json`);
      const data = await res.json();
      if (!data || !data.savedAt) continue;

      const savedAt = new Date(data.savedAt).getTime();
      const lastSeen = lastAlertTime[session] || 0;

      if (savedAt > lastSeen) {
        lastAlertTime[session] = savedAt;
        const alerts = data.data ? JSON.parse(data.data) : [];
        if (alerts.length > 0) {
          const top3 = alerts.slice(0, 3).map(a =>
            `${a.sym} ${a.changePct >= 0 ? '▲' : '▼'}${Math.abs(a.changePct || 0).toFixed(1)}%`
          ).join(' · ');
          const sessionLabel = {
            premarket:  '🌅 6AM Pre-Market',
            open:       '🟢 9:45AM Market Open',
            midday:     '☀️ 12PM Midday',
            afternoon:  '🕑 2PM Afternoon',
            preclose:   '🔔 3:30PM Pre-Close'
          }[session] || session;

          await self.registration.showNotification(
            `${sessionLabel} — ${alerts.length} movers`, {
              body:    top3,
              icon:    '/confluence-screener/icon.png',
              tag:     `alert-${session}`,
              vibrate: [200, 100, 200],
              data:    { url: 'https://shoprevoltinc-source.github.io/confluence-screener/' },
              actions: [
                { action: 'open', title: '📈 View Alerts' },
                { action: 'dismiss', title: 'Dismiss' }
              ]
            }
          );
        }
      }
    } catch(e) {
      console.log('[SW] Firebase check error:', e);
    }
  }

  // Also check JAX signals
  try {
    const res = await fetch(`${DB_URL}/screener/jax_last_run.json`);
    const data = await res.json();
    if (!data || !data.time) return;

    const runTime = new Date(data.time).getTime();
    const lastSeen = lastAlertTime['jax'] || 0;

    if (runTime > lastSeen && data.signals && data.signals.length > 0) {
      lastAlertTime['jax'] = runTime;
      await self.registration.showNotification(
        `🟢 JAX SIGNAL — ${data.signals.length} green arrow${data.signals.length > 1 ? 's' : ''}`, {
          body:    data.signals.join(' · ') + ' · Tap to open TradingView',
          icon:    '/confluence-screener/icon.png',
          tag:     'jax-signal',
          vibrate: [300, 100, 300, 100, 300],
          data:    { url: 'https://shoprevoltinc-source.github.io/confluence-screener/' },
          actions: [
            { action: 'open', title: '🟢 Open Screener' },
            { action: 'dismiss', title: 'Dismiss' }
          ]
        }
      );
    }
  } catch(e) {
    console.log('[SW] JAX check error:', e);
  }
}
