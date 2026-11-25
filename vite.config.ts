import { defineConfig, type Plugin } from 'vite';
import preact from '@preact/preset-vite';

/**
 * Emits sw.js: precaches the app shell (all built assets) and serves the large
 * OCR model / runtime files cache-first so the app works offline after first use.
 */
function serviceWorker(): Plugin {
  return {
    name: 'mobilemining-sw',
    apply: 'build',
    generateBundle(_, bundle) {
      // pdf.js and the ONNX runtime are large and only needed on use: cached when first fetched.
      const assets = Object.keys(bundle).filter((f) => !f.endsWith('.map') && !f.endsWith('.wasm') && !/(^|\/)pdf/.test(f));
      const wasm = Object.keys(bundle).filter((f) => f.endsWith('.wasm')).map((f) => '/' + f);
      const version = Date.now().toString(36);
      const shell = ['./', ...assets.map((a) => './' + a), './manifest.webmanifest', './icons/icon.svg', './icons/icon-192.png', './icons/icon-512.png'];
      const source = `// generated
const VERSION = ${JSON.stringify(version)};
const SHELL = 'shell-' + VERSION;
const RUNTIME = 'runtime-v1';
const SHELL_FILES = ${JSON.stringify(shell)};
const WASM = ${JSON.stringify(wasm)};
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(SHELL_FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith('shell-') && k !== SHELL).map((k) => caches.delete(k)));
    // Drop ONNX Runtime binaries from previous app versions.
    const rt = await caches.open(RUNTIME);
    for (const req of await rt.keys()) {
      const path = new URL(req.url).pathname;
      if (path.endsWith('.wasm') && !WASM.some((w) => path.endsWith(w))) await rt.delete(req);
    }
    await self.clients.claim();
  })());
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  // Dictionary files are imported into IndexedDB once; don't keep a second copy.
  if (url.pathname.includes('/dict/')) return;
  const big = /\\/(models|pdfjs)\\//.test(url.pathname) || /\\/assets\\/pdf/.test(url.pathname) || url.pathname.endsWith('.wasm');
  if (big) {
    e.respondWith(caches.open(RUNTIME).then(async (c) => {
      const hit = await c.match(e.request);
      if (hit) return hit;
      const res = await fetch(e.request);
      if (res.ok) c.put(e.request, res.clone());
      return res;
    }));
    return;
  }
  if (e.request.mode === 'navigate') {
    e.respondWith(fetch(e.request).catch(() => caches.match('./', { ignoreSearch: true })));
    return;
  }
  e.respondWith(caches.match(e.request, { ignoreSearch: true }).then((hit) => hit || fetch(e.request)));
});
`;
      this.emitFile({ type: 'asset', fileName: 'sw.js', source });
    },
  };
}

export default defineConfig({
  base: './',
  plugins: [preact(), serviceWorker()],
  worker: { format: 'es' },
  build: { target: 'es2022', chunkSizeWarningLimit: 1500 },
  optimizeDeps: { exclude: ['onnxruntime-web'] },
});
