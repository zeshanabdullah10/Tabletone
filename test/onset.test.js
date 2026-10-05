// Runs the real AudioWorkletProcessor in Node with stubbed worklet globals.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rng } from './sim.js';

const FS = 48000;
let Processor;
globalThis.sampleRate = FS;
globalThis.currentFrame = 0;
globalThis.AudioWorkletProcessor = class { constructor() { this.port = { postMessage: (m) => this._out.push(m), onmessage: null }; this._out = []; } };
globalThis.registerProcessor = (_, cls) => { Processor = cls; };
await import('../src/onset-worklet.js');

function run(signal, cfg = {}) {
  const p = new Processor();
  if (Object.keys(cfg).length) p.port.onmessage({ data: cfg });
  for (let i = 0; i < signal.length; i += 128) {
    globalThis.currentFrame = i;
    p.process([[signal.subarray(i, Math.min(i + 128, signal.length))]]);
  }
  return p._out.filter((m) => m.type === 'onset').map((m) => ({ ms: (m.frame / FS) * 1000, ratio: m.ratio }));
}

// Building blocks (amplitudes in full scale).
const secs = (s) => new Float32Array(Math.round(s * FS));
function noise(sig, amp, seed = 1) { const r = rng(seed); for (let i = 0; i < sig.length; i++) sig[i] += amp * r.normal(); return sig; }
function hum(sig, amp, f = 50) { for (let i = 0; i < sig.length; i++) sig[i] += amp * Math.sin(2 * Math.PI * f * i / FS); return sig; }
// A knuckle/finger tap on a table: broadband click with a ~8 ms decay and a body resonance.
function tap(sig, ms, amp, seed = 2) {
  const r = rng(seed), i0 = Math.round(ms / 1000 * FS);
  for (let i = 0; i < 0.06 * FS && i0 + i < sig.length; i++) {
    const t = i / FS;
    sig[i0 + i] += amp * Math.exp(-t / 0.008) * (0.6 * r.normal() + 0.8 * Math.sin(2 * Math.PI * 900 * t));
  }
  return sig;
}
// Speech-like: band-limited noise with ~4 Hz syllable envelope (≈40 ms rise).
function speech(sig, amp, seed = 3) {
  const r = rng(seed); let lp = 0;
  for (let i = 0; i < sig.length; i++) {
    lp += 0.15 * (r.normal() - lp);
    const env = Math.max(0, Math.sin(2 * Math.PI * 4 * i / FS)) ** 2;
    sig[i] += amp * env * lp * 3;
  }
  return sig;
}
// Sustained musical tones with soft (~30 ms) attacks.
function tones(sig, amp) {
  for (let n = 0; n < 8; n++) {
    const i0 = Math.round((0.4 + n * 0.25) * FS), f = 220 * 2 ** (n / 12);
    for (let i = 0; i < 0.22 * FS && i0 + i < sig.length; i++) {
      const t = i / FS, env = Math.min(1, t / 0.03) * Math.exp(-t / 0.3);
      sig[i0 + i] += amp * env * Math.sin(2 * Math.PI * f * t);
    }
  }
  return sig;
}
const near = (onsets, ms, tol = 3) => onsets.some((o) => Math.abs(o.ms - ms) <= tol);

test('detects each tap within 3 ms over a quiet room', () => {
  const times = [500, 800, 1150, 1400, 1900, 2300];
  const sig = noise(secs(2.6), 0.002);
  times.forEach((t, i) => tap(sig, t, 0.3, i + 10));
  const on = run(sig);
  for (const t of times) assert.ok(near(on, t), `missing tap at ${t}: ${JSON.stringify(on)}`);
  assert.equal(on.length, times.length, JSON.stringify(on));
});

test('detects soft taps (−30 dB) and reports loudness via ratio', () => {
  const sig = noise(secs(1.5), 0.001);
  tap(sig, 600, 0.03); tap(sig, 1100, 0.3);
  const on = run(sig);
  assert.equal(on.length, 2, JSON.stringify(on));
  assert.ok(on[1].ratio > on[0].ratio * 5);
});

test('nothing fires during warm-up even if the first sound is loud', () => {
  const sig = noise(secs(1), 0.05);
  assert.deepEqual(run(sig), []);
});

test('ignores mains hum (high-pass) and steady noise', () => {
  const sig = hum(noise(secs(2), 0.003), 0.3, 50);
  hum(sig, 0.2, 60);
  assert.deepEqual(run(sig), []);
  tap(sig, 1200, 0.3);
  assert.ok(near(run(sig), 1200));
});

test('refractory: a tap with a bouncing ring fires once', () => {
  const sig = noise(secs(1.2), 0.002);
  tap(sig, 600, 0.3); tap(sig, 620, 0.2, 9);
  assert.equal(run(sig).length, 1);
});

test('fast repeats ≥ 50 ms apart are all detected', () => {
  const sig = noise(secs(1.5), 0.002);
  const times = [500, 560, 620, 680, 740];
  times.forEach((t, i) => tap(sig, t, 0.3, i + 20));
  const on = run(sig);
  for (const t of times) assert.ok(near(on, t), `${t}: ${JSON.stringify(on)}`);
});

test('few false onsets from talking and from music with soft attacks', () => {
  const talk = run(speech(noise(secs(4), 0.002), 0.15));
  assert.ok(talk.length <= 1, `talking: ${talk.length} onsets`);
  const music = run(tones(noise(secs(3), 0.002), 0.25));
  assert.ok(music.length <= 1, `music: ${music.length} onsets`);
});

test('taps are still detected while someone talks', () => {
  const sig = speech(noise(secs(3), 0.002), 0.08);
  const times = [700, 1300, 1900, 2500];
  times.forEach((t, i) => tap(sig, t, 0.3, i + 30));
  const on = run(sig);
  const hits = times.filter((t) => near(on, t, 4)).length;
  assert.ok(hits >= 3, `hits ${hits}/4: ${JSON.stringify(on)}`);
});

test('higher k makes it less sensitive', () => {
  const sig = noise(secs(1.5), 0.002);
  tap(sig, 700, 0.012);
  assert.equal(run(sig, { k: 4 }).length, 1);
  assert.equal(run(sig, { k: 60 }).length, 0);
});

test('clipped input (loud tap next to the mic) still yields exactly one onset', () => {
  const sig = noise(secs(1.2), 0.002);
  tap(sig, 600, 3);
  for (let i = 0; i < sig.length; i++) sig[i] = Math.max(-1, Math.min(1, sig[i]));
  assert.equal(run(sig).length, 1);
});

test('digital silence does not crash or fire', () => {
  assert.deepEqual(run(secs(1)), []);
});

test('taps are still detected while music plays', () => {
  const sig = tones(noise(secs(3), 0.002), 0.1);
  const times = [520, 1000, 1480, 2100, 2600];
  times.forEach((t, i) => tap(sig, t, 0.3, i + 40));
  const on = run(sig);
  const hits = times.filter((t) => near(on, t, 4)).length;
  assert.ok(hits >= 4, `hits ${hits}/5: ${JSON.stringify(on)}`);
  assert.ok(on.length - hits <= 1, `false: ${on.length - hits}`);
});

test('a ringing surface (glass/metal, 40 ms decay) is still one onset, on time', () => {
  const sig = noise(secs(1.2), 0.002);
  const i0 = Math.round(0.6 * FS);
  for (let i = 0; i < 0.2 * FS; i++) sig[i0 + i] += 0.3 * Math.exp(-i / FS / 0.04) * Math.sin(2 * Math.PI * 2400 * i / FS);
  const on = run(sig);
  assert.equal(on.length, 1, JSON.stringify(on));
  assert.ok(near(on, 600));
});
