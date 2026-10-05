import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Synth, PRESETS } from '../src/synth.js';

// Minimal Web Audio stand-in: records scheduling, no sound.
function fakeCtx(outputLatency = 0.04) {
  const param = () => ({ value: 0, setValueAtTime() {}, linearRampToValueAtTime() {}, setTargetAtTime() {}, cancelScheduledValues() {} });
  const node = (extra = {}) => ({ connect(n) { return n; }, disconnect() {}, ...extra });
  const ctx = {
    currentTime: 0, outputLatency, destination: node(), started: 0,
    createGain: () => node({ gain: param() }),
    createBiquadFilter: () => node({ type: '', frequency: param() }),
    createDynamicsCompressor: () => node(),
    createOscillator: () => node({ type: '', frequency: param(), start() { ctx.started++; }, stop() {}, onended: null }),
  };
  return ctx;
}

test('every preset plays without throwing', () => {
  const ctx = fakeCtx(); const s = new Synth(ctx);
  for (const k of Object.keys(PRESETS)) { s.preset = k; s.play(60, 0.8); }
  assert.ok(ctx.started > 0);
});

test('polyphony is capped: the oldest voice is stolen', () => {
  const s = new Synth(fakeCtx(), { voices: 8 });
  for (let i = 0; i < 20; i++) s.play(60 + i, 0.5);
  assert.equal(s.active.length, 8);
});

test('self-trigger gate without measurement uses outputLatency + gate (performance.now ms)', () => {
  const s = new Synth(fakeCtx(0.04));
  const t0 = s.play(60);
  assert.equal(s.isSelf(t0 + 50, 60), true);
  assert.equal(s.isSelf(t0 + 200, 60), false);
  assert.equal(s.isSelf(t0 - 100, 60), false, 'a tap before the note is never "self"');
});

test('self-trigger gate with a measured round trip is centred on it', () => {
  const s = new Synth(fakeCtx(0.01));
  const t0 = s.play(60);
  assert.equal(s.isSelf(t0 + 130, 40, 120), true, 'echo arrives at the measured 120 ms');
  assert.equal(s.isSelf(t0 + 50, 40, 120), false, 'a real tap 50 ms after a note still plays');
  assert.equal(s.isSelf(t0 + 170, 40, 120), false);
});
