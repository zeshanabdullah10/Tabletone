import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const sw = await readFile(new URL('sw.js', root), 'utf8');
const assets = [...sw.matchAll(/'\.\/([^']*)'/g)].map((m) => m[1]);

async function appFiles() {
  const js = (dir) => readdir(new URL(dir, root)).then((fs) => fs.filter((f) => f.endsWith('.js')).map((f) => dir + f));
  const wasm = (await readdir(new URL('vendor/mediapipe/wasm/', root))).map((f) => 'vendor/mediapipe/wasm/' + f);
  return [...(await js('src/')), ...(await js('src/tap/')), ...wasm, 'index.html', 'tap.html', 'style.css', 'tap.css',
    'manifest.webmanifest', 'models/hand_landmarker.task', 'vendor/mediapipe/vision_bundle.mjs'];
}

test('service worker precaches every app file (offline play)', async () => {
  for (const f of await appFiles()) assert.ok(assets.includes(f), `sw.js ASSETS is missing ${f}`);
});

test('every precached file exists', async () => {
  for (const f of assets) if (f) await stat(new URL(f, root));
});

test('manifest uses relative paths (GitHub Pages lives under /<repo>/) and has installable icons', async () => {
  const m = JSON.parse(await readFile(new URL('manifest.webmanifest', root), 'utf8'));
  assert.equal(m.start_url, './'); assert.equal(m.scope, './');
  for (const i of m.icons) { assert.ok(!i.src.startsWith('/'), i.src); await stat(new URL(i.src, root)); }
  assert.ok(m.icons.some((i) => i.sizes === '192x192') && m.icons.some((i) => i.sizes === '512x512'));
});

test('no root-relative paths or CDN dependencies in the app', async () => {
  for (const f of (await appFiles()).filter((f) => /\.(html|js)$/.test(f) && !f.startsWith('vendor'))) {
    const s = await readFile(new URL(f, root), 'utf8');
    assert.ok(!/(src|href)="\//.test(s), `${f}: root-relative path breaks under /<repo>/`);
    assert.ok(!/cdn\.jsdelivr|storage\.googleapis/.test(s), `${f}: network dependency breaks offline`);
  }
});
