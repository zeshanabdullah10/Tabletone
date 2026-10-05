// Stamps every app-internal module/worklet URL and the service-worker cache with one
// build id, so a phone can never run a mix of old and new files from browser/CDN caches.
// Usage: node tools/set-build.mjs [build]   (default: today's date + time)
import { readFile, writeFile, readdir } from 'node:fs/promises';

const build = process.argv[2] || new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
const root = new URL('../', import.meta.url);
const files = ['index.html', 'tap.html', 'sw.js',
  ...(await readdir(new URL('src/', root))).filter((f) => f.endsWith('.js')).map((f) => 'src/' + f),
  ...(await readdir(new URL('src/tap/', root))).map((f) => 'src/tap/' + f)];

for (const f of files) {
  let s = await readFile(new URL(f, root), 'utf8');
  const before = s;
  // import … from './x.js'  |  src="./src/x.js"  |  new URL('./x.js', import.meta.url)
  s = s.replace(/((?:from |src=|new URL\()['"])(\.{1,2}\/(?!vendor|models)[^'"?]+\.(?:js|mjs))(\?v=[^'"]*)?(['"])/g,
    (_, a, path, _v, q) => `${a}${path}?v=${build}${q}`);
  s = s.replace(/const BUILD = '[^']*';/, `const BUILD = '${build}';`);
  s = s.replace(/const VERSION = 'mirror-piano-[^']*';/, `const VERSION = 'mirror-piano-${build}';`);
  if (s !== before) await writeFile(new URL(f, root), s);
}
console.log('build', build);
