const CACHE = "shopwise-v13";
const ASSETS = ["./", "./index.html", "./manifest.json", "./icons/icon-192.svg", "./icons/icon-512.svg"];

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

// Network-first for HTML + the app shell — guarantees users see the latest
// deployment as soon as they're online. Cache-first for everything else
// (icons, manifest) keeps offline use fast.
self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;

  const url = new URL(e.request.url);
  const isAppShell = e.request.mode === "navigate" ||
                     e.request.destination === "document" ||
                     url.pathname.endsWith("/") ||
                     url.pathname.endsWith(".html");

  if (isAppShell) {
    // Network-first
    e.respondWith(
      fetch(e.request).then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {});
        return res;
      }).catch(() => caches.match(e.request).then(c => c || caches.match("./index.html")))
    );
    return;
  }

  // Cache-first for static assets
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
