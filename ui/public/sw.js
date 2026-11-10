/* TeamBot service worker (mobile module).
 * - Offline app shell: index.html + hashed /assets/* + icons. Navigations are network-first.
 * - Never caches API responses, attachments or the WebSocket (no chats/files at rest in the cache).
 * - Web Push: shows the notification; a tap only opens the app. Nothing is ever approved from a notification.
 *   A "close" push (an approval or question handled elsewhere) takes its notification away and shows nothing.
 * - Share target (Android/desktop PWA): text, links and files shared to TeamBot are kept on this device in the
 *   "tb-share" cache until you send or cancel them on the "Delen" page (max 24 hours, max 10 files / 50 MB).
 */
const VERSION = 'tb-shell-v1';
const SHARE = 'tb-share';
const SHARE_MAX_FILES = 10;
const SHARE_MAX_BYTES = 50 * 1024 * 1024;
const SHARE_TTL_MS = 24 * 60 * 60 * 1000;

async function cleanShares(cache) {
  for (const req of await cache.keys()) {
    const m = new URL(req.url).pathname.match(/^\/__share\/([\w-]+)\/meta$/);
    if (!m) continue;
    const res = await cache.match(req);
    const meta = res ? await res.json().catch(() => null) : null;
    if (!meta || Date.now() - (meta.created || 0) > SHARE_TTL_MS) {
      for (const k of await cache.keys()) if (new URL(k.url).pathname.startsWith(`/__share/${m[1]}/`)) await cache.delete(k);
    }
  }
}

async function receiveShare(request) {
  const form = await request.formData();
  const id = (self.crypto && self.crypto.randomUUID ? self.crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2)).replace(/[^\w-]/g, '');
  const cache = await caches.open(SHARE);
  await cleanShares(cache);
  const files = [];
  let total = 0;
  let skipped = 0;
  for (const f of form.getAll('files')) {
    if (!(f instanceof File) || !f.size) continue;
    if (files.length >= SHARE_MAX_FILES || total + f.size > SHARE_MAX_BYTES) {
      skipped++;
      continue;
    }
    total += f.size;
    const n = files.length;
    files.push({ name: String(f.name || `bestand-${n + 1}`).slice(0, 200), type: f.type || 'application/octet-stream', size: f.size });
    await cache.put(`/__share/${id}/f${n}`, new Response(f, { headers: { 'content-type': f.type || 'application/octet-stream' } }));
  }
  const str = (k) => String(form.get(k) || '').slice(0, 20000);
  const meta = { id, created: Date.now(), title: str('title'), text: str('text'), url: str('url'), files, skipped };
  await cache.put(`/__share/${id}/meta`, new Response(JSON.stringify(meta), { headers: { 'content-type': 'application/json' } }));
  return Response.redirect(`/#/m/mobile/delen/${id}`, 303);
}
const STATIC = ['/manifest.webmanifest', '/icon.svg', '/icon-192.png', '/icon-512.png', '/icon-maskable-512.png', '/apple-touch-icon.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(VERSION);
      try {
        const res = await fetch('/', { cache: 'no-store' });
        if (res.ok) {
          const html = await res.clone().text();
          await cache.put('/', res);
          const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((m) => m[1]);
          await Promise.all([...new Set(assets)].map((a) => cache.add(a).catch(() => undefined)));
        }
      } catch (e) {
        /* offline during install: the shell is cached on the next visit */
      }
      await Promise.all(STATIC.map((u) => cache.add(u).catch(() => undefined)));
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const k of await caches.keys()) if (k !== VERSION && k !== SHARE) await caches.delete(k);
      await cleanShares(await caches.open(SHARE)).catch(() => undefined);
      await self.clients.claim();
    })(),
  );
});

function offlinePage() {
  const html = `<!doctype html><html lang="nl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>TeamBot offline</title><style>body{margin:0;font:16px/1.5 system-ui,-apple-system,sans-serif;background:#0d0d10;color:#ededf2;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:24px;box-sizing:border-box}
main{max-width:360px}a{display:inline-block;margin-top:16px;padding:12px 18px;border-radius:10px;background:#f4f4f7;color:#111114;text-decoration:none;font-weight:600}</style></head>
<body><main><h1>TeamBot is niet bereikbaar</h1><p>Je computer of server staat uit, slaapt, of je telefoon zit niet op hetzelfde netwerk (of Tailscale staat uit).</p>
<p>Je gesprekken staan veilig op je eigen computer; zonder verbinding kan TeamBot niets ophalen of versturen.</p><a href="/">Opnieuw proberen</a></main></body></html>`;
  return new Response(html, { status: 503, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method === 'POST' && url.origin === self.location.origin && url.pathname === '/share-target') {
    event.respondWith(receiveShare(req).catch(() => Response.redirect('/#/m/mobile/delen/fout', 303)));
    return;
  }
  if (req.method !== 'GET') return;
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname === '/api' || url.pathname === '/ws' || url.pathname === '/sw.js') return;

  if (req.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          const res = await fetch(req);
          if (res.ok && url.pathname === '/') (await caches.open(VERSION)).put('/', res.clone());
          return res;
        } catch (e) {
          return (await caches.match('/')) || offlinePage();
        }
      })(),
    );
    return;
  }

  if (url.pathname.startsWith('/assets/') || STATIC.includes(url.pathname)) {
    event.respondWith(
      (async () => {
        const cached = await caches.match(req);
        if (cached) {
          if (!url.pathname.startsWith('/assets/'))
            fetch(req)
              .then((r) => (r.ok ? caches.open(VERSION).then((c) => c.put(req, r)) : undefined))
              .catch(() => undefined);
          return cached;
        }
        const res = await fetch(req);
        if (res.ok) (await caches.open(VERSION)).put(req, res.clone());
        return res;
      })(),
    );
  }
});

self.addEventListener('push', (event) => {
  let d = {};
  try {
    d = event.data ? event.data.json() : {};
  } catch (e) {
    d = { title: 'TeamBot', body: event.data ? event.data.text() : '' };
  }
  if (d.kind === 'close') {
    // Only approval tags (apr-<id>): a push can never close other notifications.
    const tag = typeof d.tag === 'string' && /^apr-[\w-]{1,40}$/.test(d.tag) ? d.tag : '';
    event.waitUntil(
      tag
        ? self.registration.getNotifications({ tag }).then((list) => list.forEach((n) => n.close()))
        : Promise.resolve(),
    );
    return;
  }
  const link = typeof d.link === 'string' && /^#\/[\w\-/?=&.%:]*$/.test(d.link) ? d.link : '#/';
  event.waitUntil(
    self.registration.showNotification(String(d.title || 'TeamBot').slice(0, 120), {
      body: String(d.body || '').slice(0, 300),
      tag: d.tag ? String(d.tag).slice(0, 80) : undefined,
      renotify: !!d.tag && d.kind === 'approval',
      requireInteraction: d.kind === 'approval',
      silent: d.silent === true,
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      data: { link },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const link = (event.notification.data && event.notification.data.link) || '#/';
  const target = new URL('/' + link, self.location.origin).href;
  event.waitUntil(
    (async () => {
      const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const c of list) {
        if (new URL(c.url).origin !== self.location.origin) continue;
        await c.focus();
        c.postMessage({ type: 'tb.navigate', link });
        return;
      }
      await self.clients.openWindow(target);
    })(),
  );
});
