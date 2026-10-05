// Service worker: cache-first for the app shell, MediaPipe WASM and the hand model.
// Bump VERSION on every release so phones pick up the update.
const VERSION = 'mirror-piano-202610052230';
const ASSETS = [
  './',
  './index.html',
  './tap.html',
  './mallets.html',
  './mallets.css',
  './src/mallet-main.js',
  './src/mallet.js',
  './style.css',
  './tap.css',
  './manifest.webmanifest',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './src/main.js',
  './src/tap-main.js',
  './src/camera.js',
  './src/hands.js',
  './src/tracks.js',
  './src/keyboard.js',
  './src/render.js',
  './src/audio-in.js',
  './src/onset-worklet.js',
  './src/fusion.js',
  './src/synth.js',
  './src/debug.js',
  './src/tap/features.js',
  './src/tap/classifier.js',
  './vendor/mediapipe/vision_bundle.mjs',
  './vendor/mediapipe/wasm/vision_wasm_internal.js',
  './vendor/mediapipe/wasm/vision_wasm_internal.wasm',
  './vendor/mediapipe/wasm/vision_wasm_nosimd_internal.js',
  './vendor/mediapipe/wasm/vision_wasm_nosimd_internal.wasm',
  './models/hand_landmarker.task',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// App code (html/js/css/manifest): network first, so an online phone always runs the
// latest version and the cache is only the offline fallback. Big immutable files
// (MediaPipe WASM, the hand model): cache first.
const IMMUTABLE = /\/(vendor|models)\//;

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  const put = (res) => { if (res.ok) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(req, copy)); } return res; };
  if (IMMUTABLE.test(new URL(req.url).pathname)) {
    e.respondWith(caches.match(req, { ignoreSearch: true }).then((hit) => hit || fetch(req).then(put)));
  } else {
    e.respondWith(fetch(req).then(put).catch(() => caches.match(req, { ignoreSearch: true })));
  }
});
