// Tap Table mode: DSP, classifier, and the full worklet → features → classifier
// pipeline on a simulated table.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fft, logMel, melBank, tapFeatures, gccPhatLag, FFT_N, BANDS } from '../src/tap/features.js';
import { TapClassifier } from '../src/tap/classifier.js';
import { rng } from './sim.js';

const FS = 48000;

// ---- DSP ----

test('fft finds a sine at the right bin', () => {
  const re = new Float64Array(FFT_N), im = new Float64Array(FFT_N);
  for (let i = 0; i < FFT_N; i++) re[i] = Math.sin((2 * Math.PI * 37 * i) / FFT_N);
  fft(re, im);
  const mag = Array.from(re, (r, i) => Math.hypot(r, im[i]));
  assert.equal(mag.slice(0, FFT_N / 2).indexOf(Math.max(...mag.slice(0, FFT_N / 2))), 37);
});

test('mel bank covers the range with no empty bands', () => {
  const bank = melBank(FS);
  assert.equal(bank.length, BANDS);
  for (const b of bank) assert.ok(b.length > 0);
});

test('features ignore loudness (same tap, 20× louder → same features)', () => {
  const r = rng(1), x = new Float32Array(1600);
  for (let i = 64; i < 1600; i++) x[i] = Math.exp(-(i - 64) / 300) * r.normal();
  const a = tapFeatures({ channels: [x], pre: 64, sampleRate: FS });
  const b = tapFeatures({ channels: [x.map((v) => v * 20)], pre: 64, sampleRate: FS });
  for (let i = 0; i < a.length; i++) assert.ok(Math.abs(a[i] - b[i]) < 1e-4);
});

test('GCC-PHAT finds the inter-mic delay', () => {
  const r = rng(2), a = new Float32Array(1600), b = new Float32Array(1600);
  for (let i = 64; i < 1600; i++) a[i] = Math.exp(-(i - 64) / 200) * r.normal();
  for (let i = 0; i < 1600; i++) b[i] = a[i - 9] || 0;
  assert.equal(gccPhatLag(a, b, 64, 48), 9);
});

// ---- Classifier ----

test('classifier: separable clusters, leave-one-out, unknown rejection, persistence', () => {
  const r = rng(3), c = new TapClassifier();
  const centre = (k) => Array.from({ length: 20 }, (_, i) => Math.sin(k * 3 + i));
  for (let k = 0; k < 6; k++) for (let n = 0; n < 6; n++) c.add(k, centre(k).map((v) => v + 0.1 * r.normal()));
  const ev = c.evaluate();
  assert.equal(ev.acc, 1);
  assert.equal(c.predict(centre(4)).key, 4);
  assert.equal(c.predict(centre(4).map((v) => v + 5)).unknown, true);
  const back = TapClassifier.from(JSON.parse(JSON.stringify(c)));
  assert.equal(back.predict(centre(2)).key, 2);
  assert.equal(TapClassifier.from({ examples: [{ key: 'x', f: [1] }] }).examples.length, 0);
});

// ---- End-to-end on a simulated table ----

// Table = plate with vibration modes; a tap at position p excites mode m with
// amplitude sin(m·π·p) (mode shape). Two mics at the phone's ends hear it with
// position-dependent delays. Each tap varies in force, finger softness and noise.
const MODES = Array.from({ length: 24 }, (_, m) => ({ f: 180 * (m + 1) ** 1.35, decay: 0.012 + 0.03 / (m + 1) }));
function tapAt(p, seed, { stereo = false, noise = 0.003 } = {}) {
  const r = rng(seed), len = 20000, x = new Float32Array(len), y = new Float32Array(len);
  const amp = 0.05 + 0.6 * r(), soft = 0.6 + 0.8 * r(), at = 16000;
  const delayB = Math.round((p - 0.5) * 12);
  for (let m = 0; m < MODES.length; m++) {
    const shape = Math.sin((m + 1) * Math.PI * (0.07 + 0.55 * p)) * (1 + 0.15 * r.normal());
    const g = (amp * shape) / (1 + (MODES[m].f / (4000 * soft)) ** 2);
    for (let i = 0; i < 2000; i++) {
      const v = g * Math.exp(-i / FS / MODES[m].decay) * Math.sin((2 * Math.PI * MODES[m].f * i) / FS);
      x[at + i] += v;
      if (stereo) y[at + i + delayB] += v * (0.7 + 0.6 * p);
    }
  }
  for (let i = 0; i < len; i++) { x[i] += noise * r.normal(); y[i] += noise * r.normal(); }
  return stereo ? [x, y] : [x];
}

// Real worklet with stubbed globals, so detection + snippet capture are exercised.
let Processor;
globalThis.sampleRate = FS;
globalThis.currentFrame = 0;
globalThis.AudioWorkletProcessor = class { constructor() { this._out = []; this.port = { postMessage: (m) => this._out.push(m) }; } };
globalThis.registerProcessor = (_, cls) => { Processor = cls; };
await import('../src/onset-worklet.js');

function snippetsOf(channels) {
  const p = new Processor();
  p.port.onmessage({ data: { snippet: true } });
  const n = channels[0].length;
  for (let i = 0; i < n; i += 128) {
    globalThis.currentFrame = i;
    p.process([channels.map((c) => c.subarray(i, Math.min(n, i + 128)))]);
  }
  return p._out.filter((m) => m.type === 'snippet').map((m) => ({ ...m, sampleRate: FS }));
}

for (const stereo of [false, true]) {
  test(`simulated table, 8 spots, 6 training taps each (${stereo ? 'stereo' : 'mono'}): ≥ 95% on new taps`, () => {
    const spots = 8, c = new TapClassifier();
    for (let k = 0; k < spots; k++) for (let n = 0; n < 6; n++) {
      const sn = snippetsOf(tapAt(k / (spots - 1), 1000 + k * 50 + n, { stereo }));
      assert.equal(sn.length, 1, 'one snippet per tap');
      assert.equal(sn[0].channels.length, stereo ? 2 : 1);
      c.add(k, tapFeatures(sn[0]));
    }
    assert.ok(c.evaluate().acc >= 0.9, `LOO ${c.evaluate().acc}`);
    let ok = 0, n = 0;
    for (let k = 0; k < spots; k++) for (let t = 0; t < 15; t++) {
      const sn = snippetsOf(tapAt(k / (spots - 1), 5000 + k * 100 + t, { stereo }));
      const p = c.predict(tapFeatures(sn[0])); n++; if (p.key === k) ok++;
    }
    assert.ok(ok / n >= 0.95, `${ok}/${n}`);
  });
}

test('snippet starts just before the tap and has all channels', () => {
  const [x, y] = tapAt(0.3, 9, { stereo: true });
  const [s] = snippetsOf([x, y]);
  assert.equal(s.channels[0].length, s.pre + 1536);
  assert.ok(Math.abs(s.sample - 16000) <= 96, `onset at ${s.sample}`);
});

