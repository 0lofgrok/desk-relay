/* Desk service worker: network-first app shell, never caches /api. Web push is a stub. */
const CACHE = "desk-shell-v6";
const SHELL = ["/", "/index.html", "/app.css?v=5", "/app.js?v=5", "/chart.js?v=3", "/manifest.json", "/icons/apple-touch-icon.png"];
self.addEventListener("install", (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => {})); self.skipWaiting(); });
self.addEventListener("activate", (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener("fetch", (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== "GET" || u.origin !== location.origin || u.pathname.startsWith("/api/") || u.pathname.startsWith("/desk/")) return;
  e.respondWith(fetch(e.request).then((r) => { if (r.ok) { const cp = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, cp)); } return r; })
    .catch(() => caches.match(e.request).then((m) => m || caches.match("/index.html"))));
});
// Stub: notifications go to Discord in this hosting. Kept so web push can be enabled later.
self.addEventListener("push", (e) => {
  let d = {}; try { d = e.data ? e.data.json() : {}; } catch (_) {}
  e.waitUntil(self.registration.showNotification(d.title || "Desk · now", { body: d.body || "", icon: d.icon || "/icons/icon-192.png", data: { url: d.url || "/" } }));
});
self.addEventListener("notificationclick", (e) => { e.notification.close(); e.waitUntil(self.clients.openWindow((e.notification.data && e.notification.data.url) || "/")); });
