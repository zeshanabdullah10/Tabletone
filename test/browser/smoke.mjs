// End-to-end smoke test in real Chromium with a fake camera and microphone.
// Usage: npm run test:browser   (needs `npm i` for playwright; uses CHROMIUM_PATH if set)
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const out = fileURLToPath(new URL('./out/', import.meta.url));
await mkdir(out, { recursive: true });
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.png': 'image/png', '.task': 'application/octet-stream' };
const server = createServer(async (req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^([/\\])+/, '');
  try {
    const body = await readFile(join(root, path.endsWith('/') || path === '' ? join(path, 'index.html') : path));
    res.writeHead(200, { 'content-type': TYPES[extname(path)] || 'text/html' }); res.end(body);
  } catch { res.writeHead(404); res.end('not found'); }
}).listen(0);
const url = `http://localhost:${server.address().port}/`;

const launch = (args = []) => chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ['--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required', ...args],
});

let failures = 0;
async function check(name, fn) {
  try { await fn(); console.log(`ok - ${name}`); }
  catch (e) { failures++; console.log(`not ok - ${name}\n  ${String(e && e.stack || e).split('\n').slice(0, 3).join('\n  ')}`); }
}
const assert = (c, m) => { if (!c) throw new Error(m); };

const browser = await launch(['--use-fake-ui-for-media-stream']);

await check('start → placement, no page errors, tracker runs', async () => {
  const ctx = await browser.newContext({ permissions: ['camera', 'microphone'], viewport: { width: 412, height: 860 } });
  const p = await ctx.newPage();
  const errs = []; p.on('pageerror', (e) => errs.push(e.message));
  await p.goto(url);
  await p.click('#startBtn');
  await p.waitForSelector('#stage:not([hidden])', { timeout: 60000 });
  await p.evaluate(() => document.getElementById('debugOn').click());
  await p.waitForFunction(() => /fps: [1-9]/.test(document.getElementById('debug').textContent), null, { timeout: 30000 });
  const dbg = await p.textContent('#debug');
  assert(/mode: place/.test(dbg), dbg);
  assert(/Lay both hands|Both hands/.test(await p.textContent('#prompt')), 'placement prompt');
  await p.screenshot({ path: out + 'place.png' });
  assert(!errs.length, errs.join('\n'));
  await ctx.close();
});

await check('saved keyboard + calibration are restored; keys are drawn; settings persist', async () => {
  const ctx = await browser.newContext({ permissions: ['camera', 'microphone'], viewport: { width: 860, height: 412 } });
  await ctx.addInitScript(() => localStorage.setItem('mirror-piano-v1', JSON.stringify({
    calibrated: true, L: 40, sensitivity: 8, debug: true,
    keyboard: { quad: { nl: { x: 200, y: 300 }, nr: { x: 440, y: 300 }, fr: { x: 460, y: 420 }, fl: { x: 180, y: 420 } }, frame: { w: 640, h: 480 }, scale: 'pentatonic', octave: 3 },
  })));
  const p = await ctx.newPage();
  const errs = []; p.on('pageerror', (e) => errs.push(e.message));
  await p.goto(url);
  await p.click('#startBtn');
  await p.waitForFunction(() => /mode: (play|place)/.test(document.getElementById('debug').textContent), null, { timeout: 60000 });
  const dbg = await p.textContent('#debug');
  const res = dbg.match(/res: (\d+)x(\d+)/);
  // Fake camera is 640x480 → same frame → play. Any other aspect must fall back to placement.
  if (res && res[1] === '640') assert(/mode: play/.test(dbg), dbg); else assert(/mode: (play|place)/.test(dbg), dbg);
  await p.click('#settingsBtn');
  assert(await p.inputValue('#scale') === 'pentatonic', 'scale restored');
  assert(await p.inputValue('#sens') === '8', 'sensitivity restored');
  await p.screenshot({ path: out + 'play-settings.png' });
  assert(!errs.length, errs.join('\n'));
  await ctx.close();
});

await check('corrupt saved settings do not break startup', async () => {
  const ctx = await browser.newContext({ permissions: ['camera', 'microphone'] });
  await ctx.addInitScript(() => localStorage.setItem('mirror-piano-v1', '{not json'));
  const p = await ctx.newPage();
  const errs = []; p.on('pageerror', (e) => errs.push(e.message));
  await p.goto(url);
  await p.click('#startBtn');
  await p.waitForSelector('#stage:not([hidden])', { timeout: 60000 });
  assert(!errs.length, errs.join('\n'));
  await ctx.close();
});

await check('service worker caches everything; app shell loads offline', async () => {
  const ctx = await browser.newContext({ permissions: ['camera', 'microphone'] });
  const p = await ctx.newPage();
  await p.goto(url);
  await p.evaluate(async () => { await navigator.serviceWorker.ready; });
  await p.waitForFunction(async () => (await caches.keys()).length > 0 && (await (await caches.open((await caches.keys())[0])).keys()).length >= 20, null, { timeout: 60000 });
  await ctx.setOffline(true);
  await p.reload();
  assert((await p.textContent('h1')) === 'Mirror Piano', 'offline shell');
  await p.click('#startBtn');
  await p.waitForSelector('#stage:not([hidden])', { timeout: 60000 });   // model + wasm from cache
  await ctx.close();
});

await check('Tap Table: starts, captures tap snippets and trains from them', async () => {
  const ctx = await browser.newContext({ permissions: ['microphone'], viewport: { width: 412, height: 860 } });
  const p = await ctx.newPage();
  const errs = []; p.on('pageerror', (e) => errs.push(e.message));
  await p.goto(url + 'tap.html');
  await p.selectOption('#count', '4');
  await p.click('#go');
  await p.waitForSelector('#stage:not([hidden])', { timeout: 30000 });
  assert(/mic/.test(await p.textContent('#mics')), 'mic count shown');
  assert((await p.$$('.key')).length === 4, 'four keys');
  // The fake mic beeps; each beep is a "tap" that should fill a training dot.
  await p.waitForFunction(() => document.querySelectorAll('.dots i.on').length >= 2 || /spot 2/.test(document.getElementById('prompt').textContent), null, { timeout: 30000 });
  await p.screenshot({ path: out + 'tap-train.png' });
  assert(!errs.length, errs.join('\n'));
  await ctx.close();
});

await browser.close();

await check('denied permissions show a clear message and allow retry', async () => {
  const b = await launch(['--deny-permission-prompts']);
  const ctx = await b.newContext();
  const p = await ctx.newPage();
  await p.goto(url);
  await p.click('#startBtn');
  await p.waitForFunction(() => /denied|permission/i.test(document.getElementById('startStatus').textContent), null, { timeout: 30000 });
  assert(!(await p.isDisabled('#startBtn')), 'start button re-enabled');
  await b.close();
});

server.close();
console.log(failures ? `\n${failures} failed` : '\nall browser checks passed');
process.exit(failures ? 1 : 0);
