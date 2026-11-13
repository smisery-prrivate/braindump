// Bump CACHE on every release; keep it equal to VERSION in app-core.js.
// One release = one complete set of files, fetched past the browser's HTTP cache in one go at
// install time and served only from this set, so the page never runs a mix of two versions and
// starts at once without waiting for the network. A new release arrives as a new worker that
// WAITS; the page asks for the switch at a quiet moment right before it restarts.
const CACHE = 'journal-v30';
const ASSETS = ['.', 'index.html', 'vault.js', 'app-core.js', 'app-journal.js', 'app-rec.js', 'app-whisper.js', 'whisper-worker.js', 'vendor/transformers-4.3.2/transformers.min.js', 'vendor/transformers-4.3.2/ort-wasm-simd-threaded.asyncify.mjs', 'app-lock.js', 'app-sync.js', 'app-backup.js', 'app-boot.js', 'config.js', 'manifest.json', 'icon.svg', 'icon-192.png', 'icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS.map(u => new Request(u, { cache: 'reload' })))));
});
self.addEventListener('message', e => { if (e.data && e.data.t === 'skip') self.skipWaiting(); });

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k.startsWith('journal-') && k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Same-origin GETs only; cloud calls never pass through here. Nothing is written to the cache at
// run time, so no error page, no half-loaded file and no address with sign-in tokens can end up in it.
// Every response carries the two headers that make the page "cross-origin isolated", which lets
// the speech model use several processor cores (SharedArrayBuffer). GitHub Pages cannot set
// headers; a service worker can. "credentialless" keeps cross-origin fetches (the model's weights,
// the cloud) working: they are sent without cookies rather than blocked.
const ISO = { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'credentialless' };
function isolated(res) {
  if (!res || res.type === 'opaque' || res.type === 'opaqueredirect') return res;
  const h = new Headers(res.headers); for (const k in ISO) h.set(k, ISO[k]);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
}
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  if (url.origin !== location.origin || !url.pathname.startsWith(new URL(self.registration.scope).pathname)) return;
  e.respondWith(
    caches.open(CACHE)
      .then(c => c.match(url.origin + url.pathname, { ignoreSearch: true }))
      .then(hit => hit || fetch(e.request))
      .then(isolated)
  );
});
