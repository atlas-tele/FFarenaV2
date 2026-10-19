// FF Arena service worker. Static assets: stale-while-revalidate (fast, and new deploys arrive on the next open).
// Pages: network first, falling back to the cached shell, then the offline page. API calls are never cached here.
const CACHE = "ffarena-v4";
const SHELL = ["/", "/app.css", "/app.js", "/offline.html", "/icon.svg", "/manifest.json"];
self.addEventListener("install", e => { e.waitUntil(caches.open(CACHE).then(c => Promise.allSettled(SHELL.map(u => c.add(u)))).then(() => self.skipWaiting())); });
self.addEventListener("activate", e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener("fetch", e => {
  const r = e.request, u = new URL(r.url);
  if (r.method !== "GET" || u.origin !== location.origin || u.pathname.startsWith("/api/") || u.pathname === "/health") return;
  if (r.mode === "navigate") { e.respondWith(fetch(r).then(res => { const c = res.clone(); caches.open(CACHE).then(x => x.put("/", c)); return res; }).catch(async () => (await caches.match("/")) || caches.match("/offline.html"))); return; }
  e.respondWith(caches.open(CACHE).then(async c => { const hit = await c.match(r); const net = fetch(r).then(res => { if (res.ok) c.put(r, res.clone()); return res; }).catch(() => hit); return hit || net; }));
});
