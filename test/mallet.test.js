import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keyForX, strikers, readyToDecide, malletId } from '../src/mallet.js';
import { TrackStore } from '../src/tracks.js';
import { handPts, rng } from './sim.js';

const W = 1280;

test('keyForX: even columns inside the margins', () => {
  assert.equal(keyForX(0.05 * W, W, 8), 0);
  assert.equal(keyForX(0.5 * W - 1, W, 8), 3);
  assert.equal(keyForX(0.5 * W + 1, W, 8), 4);
  assert.equal(keyForX(0.949 * W, W, 8), 7);
  assert.equal(keyForX(0.02 * W, W, 8), null);
  assert.equal(keyForX(0.99 * W, W, 8), null);
  assert.equal(keyForX(NaN, W, 8), null);
});

// Simulated hands: index finger (finger 1) of a hand taps at tc by dropping `lift` px.
function session({ taps, seed = 1, noise = 1.5, fps = 30, end = 3000, oneHand = false }) {
  const r = rng(seed), store = new TrackStore(), frames = [];
  for (let t = 0; t < end; t += 1000 / fps + (r() - 0.5) * 4) {
    const hands = [];
    for (const slot of oneHand ? [0] : [0, 1]) {
      const dy = [0, 0, 0, 0, 0];
      for (const tap of taps) if (tap.slot === slot) {
        const d = t - tap.t, lift = 30;
        if (d > -300 && d < -100) dy[1] -= lift * (d + 300) / 200;
        else if (d >= -100 && d < 0) dy[1] -= lift * (1 - ((d + 100) / 100) ** 2);
        if (d > -300 && d < 0) { dy[0] += dy[1] * 0.2; dy[2] += dy[1] * 0.3; }
      }
      const x = slot === 0 ? 350 : 900;
      const pts = handPts(x, 250, 70, { dy, mirror: slot === 1 });
      for (const p of pts) { p.x += r.normal() * noise; p.y += r.normal() * noise; }
      hands.push({ pts });
    }
    frames.push({ t, hands });
  }
  return { store, frames };
}
const feed = ({ store, frames }, until) => { for (const f of frames) if (f.t <= until) store.ingest(f.hands, f.t, null, W); return store; };

test('one hand in view: it is the striker, even with no frames after the tap yet', () => {
  const s = session({ taps: [{ t: 1000, slot: 0 }], oneHand: true });
  const st = feed(s, 1000 - 60);                       // camera 60 ms behind the mic
  const r = strikers(st.tracks, 1000);
  assert.equal(r.length, 1); assert.equal(r[0].slot, 0);
  assert.equal(readyToDecide(st.tracks, 1000, 940, 0), true);
});

test('two hands: the one that came down is chosen (100 random sessions)', () => {
  let ok = 0;
  for (let seed = 0; seed < 100; seed++) {
    const slot = seed % 2;
    const s = session({ taps: [{ t: 1000, slot }], seed });
    const r = strikers(feed(s, 1010).tracks, 1000);
    if (r.length === 1 && r[0].slot === slot) ok++;
  }
  assert.ok(ok >= 98, `${ok}/100`);
});

test('two hands: still right when the camera is 60 ms behind the mic', () => {
  let ok = 0;
  for (let seed = 0; seed < 100; seed++) {
    const slot = seed % 2;
    const s = session({ taps: [{ t: 1000, slot }], seed: seed + 500 });
    const r = strikers(feed(s, 940).tracks, 1000);
    if (r[0].slot === slot) ok++;
  }
  assert.ok(ok >= 95, `${ok}/100`);
});

test('both hands striking together: chord of two', () => {
  const s = session({ taps: [{ t: 1000, slot: 0 }, { t: 1005, slot: 1 }], seed: 7 });
  const r = strikers(feed(s, 1020).tracks, 1000);
  assert.deepEqual(r.map((h) => h.slot).sort(), [0, 1]);
});

test('no hands: nothing to play', () => {
  assert.deepEqual(strikers(new TrackStore().tracks, 1000), []);
});

test('waiting rule: two hands visible → wait for a frame at/after the tap, but not forever', () => {
  const s = session({ taps: [{ t: 1000, slot: 1 }], seed: 3 });
  const st = feed(s, 950);
  assert.equal(readyToDecide(st.tracks, 1000, 950, 10), false);
  assert.equal(readyToDecide(st.tracks, 1000, 950, 95), true);
  assert.equal(readyToDecide(st.tracks, 1000, 1001, 10), true);
});

test('key comes from where the striking finger is, not the other hand', () => {
  const s = session({ taps: [{ t: 1000, slot: 1 }], seed: 9 });
  const st = feed(s, 1010);
  const [h] = strikers(st.tracks, 1000);
  const idx = st.tracks.get(malletId(1)).at(-1);
  assert.ok(Math.abs(h.x - idx.x) < 10);
  assert.equal(keyForX(h.x, W, 8), keyForX(idx.x, W, 8));
});
