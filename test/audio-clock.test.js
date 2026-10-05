import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SampleClock } from '../src/audio-in.js';
import { rng } from './sim.js';

test('sample clock recovers the true time despite jittery message delays', () => {
  const c = new SampleClock(48000), r = rng(3);
  const start = 1000;                                  // perf time of sample 0
  for (let i = 0; i < 120; i++) {
    const sample = i * 1600;                           // a message every ~33 ms
    c.anchor(sample, start + sample / 48 + 2 + r() * 30);   // 2–32 ms delivery delay
  }
  assert.ok(Math.abs(c.toPerf(48000 * 3) - (start + 3000)) < 4, String(c.toPerf(48000 * 3)));
});

test('sample clock ignores the AudioContext entirely (regression: frozen ctx clock on Android)', () => {
  // Onsets 1 s apart in samples must stay 1 s apart in perf time.
  const c = new SampleClock(48000);
  for (let i = 0; i <= 300; i++) c.anchor(i * 1600, 500 + i * 1600 / 48 + 5);
  const a = c.toPerf(48000 * 5), b = c.toPerf(48000 * 6);
  assert.ok(Math.abs(b - a - 1000) < 1e-6);
});

test('sample clock resets on a counter restart', () => {
  const c = new SampleClock(48000);
  for (let i = 0; i < 30; i++) c.anchor(480000 + i * 1600, 20000 + i * 33.3);
  c.anchor(0, 30000);                                  // worklet recreated, counter back to 0
  assert.ok(Math.abs(c.toPerf(0) - 30000) < 1);
});
