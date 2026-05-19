// Minimal service worker — just enough to satisfy PWA install requirements
// and cache static assets for fast offline-startup. We DON'T cache /api/*
// (always live) or "/" (re-fetch each load to pick up HTML changes).

const CACHE = "keepers-temple-v20-rename-backup-firstrun";
const STATIC_ASSETS = [
  "/static/app.css",
  "/static/app.js",
  "/static/icon.svg",
  "/static/manifest.webmanifest",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(STATIC_ASSETS)),
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  // Only handle same-origin GET. Always pass-through for API + root + cross-origin.
  if (
    event.request.method !== "GET" ||
    url.origin !== self.location.origin ||
    url.pathname.startsWith("/api/") ||
    url.pathname === "/"
  ) {
    return;
  }
  if (url.pathname.startsWith("/static/")) {
    // Network-first for JS/CSS so dev edits always win. Fall back to cache
    // only when offline. Icons/manifest stay cache-first (they change rarely).
    const isScript = /\.(js|css)(\?.*)?$/.test(url.pathname);
    if (isScript) {
      event.respondWith(
        fetch(event.request)
          .then((res) => {
            const clone = res.clone();
            caches.open(CACHE).then((cache) => cache.put(event.request, clone));
            return res;
          })
          .catch(() => caches.match(event.request)),
      );
    } else {
      event.respondWith(
        caches.match(event.request).then(
          (hit) =>
            hit ||
            fetch(event.request).then((res) => {
              const clone = res.clone();
              caches.open(CACHE).then((cache) => cache.put(event.request, clone));
              return res;
            }),
        ),
      );
    }
  }
});
