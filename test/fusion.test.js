import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreTap, pickKeys, Retrigger, StopDetector, estimateLatency, fitLatency, FUSION } from '../src/fusion.js';
import { placedKeyboard, simulate, randomTaps } from './sim.js';
import { replay, calibrate, visionOnly, accuracy } from './replay.js';

const kb = placedKeyboard();
const LAT = 45;   // true mic latency in the simulations

// ---- Plan success criteria, on simulated sessions (8 white keys, good conditions) ----

test('accuracy ≥ 95% and misses ≤ 3% over 400 random taps', () => {
  const sim = simulate(kb, randomTaps(kb, 400, { seed: 11 }), { seed: 12, latency: LAT });
  const a = accuracy(replay(kb, sim, { L: LAT }));
  assert.ok(a.acc >= 0.95, JSON.stringify(a));
  assert.ok(a.missRate <= 0.03, JSON.stringify(a));
  assert.ok(a.extra / a.n <= 0.02, `false chord notes: ${a.extra}`);
});

test('robust across conditions: noise, 24 fps, dropped frames, small lifts, sympathetic fingers', () => {
  const cases = {
    noisy: { noisePx: 3 }, fps24: { fps: 24 }, drops: { dropRate: 0.15 },
    smallLift: { liftScale: 0.2 }, sympathy: { sympathy: 0.45 }, farAway: { scale: 45 },
  };
  for (const [name, o] of Object.entries(cases)) {
    const k = o.scale ? placedKeyboard({ scale: o.scale, leftX: 400, rightX: 880 }) : kb;
    const sim = simulate(k, randomTaps(k, 200, { seed: 21 }), { seed: 22, latency: LAT, ...o });
    const a = accuracy(replay(k, sim, { L: LAT }));
    assert.ok(a.acc >= 0.9, `${name}: ${JSON.stringify(a)}`);
    assert.ok(a.missRate <= 0.05, `${name}: ${JSON.stringify(a)}`);
  }
});

test('L errors: underestimating is safe, overestimating by >30 ms is not (documents the asymmetry)', () => {
  const sim = simulate(kb, randomTaps(kb, 200, { seed: 31 }), { seed: 32, latency: LAT });
  for (const L of [LAT - 60, LAT - 30, LAT, LAT + 15]) assert.ok(accuracy(replay(kb, sim, { L })).acc >= 0.95, `L=${L}`);
  assert.ok(accuracy(replay(kb, sim, { L: LAT + 60 })).acc < 0.8, 'large overestimate should hurt (if not, widen FUSION.pre)');
});

test('latency budget: decision ≈ max(audio, camera lag) after contact; never above camera lag + maxWait', () => {
  const sim = simulate(kb, randomTaps(kb, 200, { seed: 41 }), { seed: 42, latency: LAT });
  for (const cameraLagMs of [30, 60, 90]) {
    const a = accuracy(replay(kb, sim, { L: LAT, cameraLagMs }));
    assert.ok(a.acc >= 0.95, `lag ${cameraLagMs}: ${JSON.stringify(a)}`);
    assert.ok(a.latMedian <= Math.max(LAT + 10, cameraLagMs) + 40, `lag ${cameraLagMs}: median ${a.latMedian}`);
    assert.ok(a.latMax <= LAT + 10 + FUSION.maxWait + 1, `lag ${cameraLagMs}: max ${a.latMax}`);
  }
});

// ---- Calibration ----

test('fitLatency recovers the mic latency within 20 ms (and errs low, the safe side)', () => {
  for (const [latency, seed] of [[20, 1], [45, 2], [90, 3], [140, 4]]) {
    const taps = Array.from({ length: 10 }, (_, i) => ({ t: 800 + i * 500, key: 3, slot: 0, finger: 2 }));
    const { est } = calibrate(kb, simulate(kb, taps, { seed, latency }));
    assert.ok(est, `latency ${latency}: no estimate`);
    assert.ok(est.L <= latency + 5 && est.L >= latency - 20, `latency ${latency}: got ${est.L}`);
  }
});

test('fitLatency tolerates stray onsets (talking, knocks) during calibration', () => {
  const taps = Array.from({ length: 10 }, (_, i) => ({ t: 800 + i * 500, key: 3, slot: 0, finger: 2 }));
  const sim = simulate(kb, taps, { seed: 5, latency: 60 });
  sim.onsets.push({ t: 1010 }, { t: 2333 }, { t: 3999 });
  const { est } = calibrate(kb, sim);
  assert.ok(est && Math.abs(est.L - 55) <= 15, JSON.stringify(est));
});

test('fitLatency refuses too few taps or no finger motion', () => {
  const taps = Array.from({ length: 3 }, (_, i) => ({ t: 800 + i * 500, key: 3, slot: 0, finger: 2 }));
  assert.equal(calibrate(kb, simulate(kb, taps, { latency: 45 })).est, null);
  const still = simulate(kb, [], { duration: 6000 });
  still.onsets = Array.from({ length: 10 }, (_, i) => ({ t: 800 + i * 500 }));
  assert.equal(calibrate(kb, still).est, null);
});

test('legacy estimateLatency still rejects inconsistent sessions', () => {
  assert.equal(estimateLatency([100, 200, 300, 400, 500, 600], [0, 230, 220, 470, 310, 690], { maxGap: 300 }), null);
  assert.equal(estimateLatency([100, 200, 300, 400, 500], [80, 180, 280, 380, 480]).L, 20);
});

// ---- Rejection: things that must NOT play ----

test('a knock with all fingers resting plays nothing', () => {
  const sim = simulate(kb, [], { duration: 4000, seed: 51 });
  sim.onsets = [1000, 1700, 2500, 3300].map((t) => ({ t }));
  const res = replay(kb, sim, { L: LAT });
  assert.ok(res.every((r) => r.keys.length === 0), JSON.stringify(res.map((r) => r.keys)));
});

test('a finger lifting up (not striking) at the onset plays nothing', () => {
  // Contact at 1000 but the onset arrives mid-lift of the *next* tap (≈ 300 ms before its contact).
  const sim = simulate(kb, [{ t: 1600, key: 2, slot: 0, finger: 2 }], { seed: 52, latency: LAT });
  sim.onsets = [{ t: 1600 - 300 + LAT }];
  const res = replay(kb, sim, { L: LAT });
  assert.deepEqual(res[0].keys, []);
});

test('fingers outside the keyboard never play', () => {
  const far = placedKeyboard({ leftX: 330, rightX: 950 });
  const res = scoreTap(new Map([[0, [
    { t: 0, x: 5, y: 100, z: 0, vy: 0, rel: 0, key: null, scale: 70 },
    { t: 33, x: 5, y: 130, z: 0, vy: 10, rel: 10, key: null, scale: 70 },
  ]]]), 33);
  assert.equal(res.length, 0);
  assert.ok(far);
});

// ---- Chords and retrigger ----

test('two fingers striking together play a chord; one finger with sympathetic neighbours does not', () => {
  const chord = simulate(kb, [{ t: 1000, key: 1, slot: 0, finger: 1 }, { t: 1003, key: 6, slot: 1, finger: 2 }], { seed: 61, latency: LAT });
  chord.onsets = [chord.onsets[0]];
  assert.deepEqual(replay(kb, chord, { L: LAT })[0].keys.sort(), [1, 6]);

  let extras = 0;
  for (let seed = 0; seed < 20; seed++) {
    const one = simulate(kb, [{ t: 1000, key: 2, slot: 0, finger: 2 }], { seed, latency: LAT, sympathy: 0.4 });
    extras += replay(kb, one, { L: LAT })[0].keys.length - 1;
  }
  assert.ok(extras <= 1, `false chord notes: ${extras}/20`);
});

test('pickKeys: near-tie on another key needs its own downstroke to join the chord', () => {
  const c = (key, score, drop) => ({ key, score, drop });
  assert.deepEqual(pickKeys([c(1, 10, 0.4), c(2, 9, 0.05)]), [1]);
  assert.deepEqual(pickKeys([c(1, 10, 0.4), c(2, 9, 0.3)]), [1, 2]);
  assert.deepEqual(pickKeys([c(1, 10, 0.4), c(1, 9.9, 0.4)]), [1], 'same key once');
  assert.deepEqual(pickKeys([c(1, 10, 0.4), c(2, 5, 0.4)]), [1]);
  assert.deepEqual(pickKeys([]), []);
});

test('Retrigger drops the same key within the window but not other keys', () => {
  const r = new Retrigger(70);
  assert.deepEqual(r.filter([1], 0), [1]);
  assert.deepEqual(r.filter([1, 2], 40), [2]);
  assert.deepEqual(r.filter([1], 80), [1]);
});

// ---- Vision-only fallback ----

test('vision-only mode finds most taps without audio and few ghosts', () => {
  const taps = randomTaps(kb, 100, { seed: 71 });
  const notes = visionOnly(kb, simulate(kb, taps, { seed: 72 }));
  let hit = 0;
  for (const tap of taps) if (notes.some((n) => n.key === tap.key && n.t >= tap.t - 10 && n.t <= tap.t + 120)) hit++;
  const ghosts = notes.filter((n) => !taps.some((tap) => n.t >= tap.t - 10 && n.t <= tap.t + 120)).length;
  assert.ok(hit >= 80, `hits ${hit}/100`);
  assert.ok(ghosts <= 5, `ghost notes ${ghosts}`);
});

test('StopDetector ignores a still hand', () => {
  const det = new StopDetector();
  const tr = Array.from({ length: 30 }, (_, i) => ({ t: i * 33, x: 0, y: 100, vy: 0, scale: 70, key: 1 }));
  assert.deepEqual(det.update(new Map([[0, tr]])), []);
});
