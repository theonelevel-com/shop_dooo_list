const CACHE = "shopwise-v41";
const ASSETS = [
  "./", "./index.html", "./manifest.json",
  "./icons/icon-192.svg", "./icons/icon-512.svg",
  "./sync-bridge.js",
  "./vendor/dooo-core/index.js",
  "./vendor/dooo-core/sync-engine.js",
  "./vendor/dooo-core/idb.js",
  "./vendor/dooo-core/queue.js",
  "./vendor/dooo-core/dedup.js",
  "./vendor/dooo-core/transports.js",
];

// Hostnames the SW must NEVER intercept (so the network always sees the request
// and the browser uses normal HTTP caching). The Shop Wise API is one of these.
const PASSTHROUGH_HOSTS = ["dooo-api.apps-8ec.workers.dev", "workers.dev"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Background Sync: replay offline list mutations when connectivity returns,
// even if the app was closed. Wakes any open client to drain the outbox
// (sync-bridge.js listens); otherwise the next app open drains it.
self.addEventListener("sync", (e) => {
  if (e.tag === "dooo-sync") {
    e.waitUntil(
      self.clients.matchAll({ includeUncontrolled: true, type: "window" })
        .then(clients => clients.forEach(c => c.postMessage({ type: "dooo-sync" })))
    );
  }
});

self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;

  const url = new URL(e.request.url);

  // 1) API and any cross-origin call: never touch — let the browser fetch
  //    direct. Keeps the list live; no chance of serving stale `/api/list`.
  if (PASSTHROUGH_HOSTS.some(h => url.hostname.endsWith(h))) return;
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/")) return;

  // 2) App shell (HTML / navigations): network-first.
  const isAppShell = e.request.mode === "navigate" ||
                     e.request.destination === "document" ||
                     url.pathname === "/" ||
                     url.pathname.endsWith("/") ||
                     url.pathname.endsWith(".html");

  if (isAppShell) {
    e.respondWith(
      fetch(e.request).then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {});
        return res;
      }).catch(() => caches.match(e.request).then(c => c || caches.match("./index.html")))
    );
    return;
  }

  // 3) Static assets (icons, manifest, etc.): cache-first.
  e.respondWith(
    caches.match(e.request).then(cached =>
      cached || fetch(e.request).then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {});
        return res;
      }).catch(() => cached)
    )
  );
});
