import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TrackStore } from '../src/tracks.js';
import { handPts } from './sim.js';

const H = (x, y, o) => ({ pts: handPts(x, y, 70, o) });

test('slots: two hands are ordered screen-left → right regardless of detection order', () => {
  const s = new TrackStore();
  const hs = s.ingest([H(900, 300, { mirror: true }), H(300, 300)], 0, null, 1280);
  assert.deepEqual(hs.map((h) => h.slot), [0, 1]);
  assert.ok(s.tracks.has(0) && s.tracks.has(9));
});

test('slots: a lone hand keeps the slot of the nearest previous hand', () => {
  const s = new TrackStore();
  s.ingest([H(300, 300), H(900, 300, { mirror: true })], 0, null, 1280);
  const [h] = s.ingest([H(880, 300, { mirror: true })], 33, null, 1280);
  assert.equal(h.slot, 1, 'right hand stays right even when alone');
  const [h2] = s.ingest([H(250, 300)], 66, null, 1280);   // hands swap visibility
  assert.equal(h2.slot, 1, 'nearest previous hand was slot 1');
  // …but its track restarted instead of producing a huge fake velocity.
  const tr = s.tracks.get(5 + 2);
  assert.equal(tr.length, 1);
  assert.equal(tr[0].vy, 0);
});

test('vy is downward speed in hand scales per second; rel is relative to the other fingers', () => {
  const s = new TrackStore();
  s.ingest([H(300, 300)], 0, null, 1280);
  s.ingest([H(300, 300, { dy: [0, 0, 7, 0, 0] })], 50, null, 1280);   // middle tip 7px down in 50ms
  const sm = s.tracks.get(2).at(-1);
  assert.ok(Math.abs(sm.vy - 2) < 1e-9, `vy ${sm.vy}`);                // 7px/50ms = 140px/s = 2 scales/s
  assert.ok(Math.abs(sm.rel - 2) < 1e-9);
  assert.equal(s.tracks.get(1).at(-1).vy, 0);
});

test('no velocity across long gaps (dropped frames / hand lost)', () => {
  const s = new TrackStore();
  s.ingest([H(300, 300)], 0, null, 1280);
  s.ingest([H(300, 300, { dy: [0, 0, 30, 0, 0] })], 400, null, 1280);
  assert.equal(s.tracks.get(2).at(-1).vy, 0);
});

test('out-of-order or duplicate frames are ignored', () => {
  const s = new TrackStore();
  s.ingest([H(300, 300)], 100, null, 1280);
  s.ingest([H(300, 300)], 100, null, 1280);
  s.ingest([H(300, 300)], 90, null, 1280);
  assert.equal(s.tracks.get(0).length, 1);
});

test('history is bounded and stale tracks are dropped', () => {
  const s = new TrackStore();
  for (let t = 0; t <= 2000; t += 33) s.ingest([H(300, 300)], t, null, 1280);
  assert.ok(s.tracks.get(0).length <= 20);
  s.ingest([H(900, 300, { mirror: true })], 2700, null, 1280);
  assert.ok(!s.tracks.has(0) || s.tracks.get(0).every((x) => 2700 - x.t <= 600));
});

test('more than two hands: only two are kept (MediaPipe is configured for 2)', () => {
  const s = new TrackStore();
  const hs = s.ingest([H(300, 300), H(600, 300), H(900, 300, { mirror: true })], 0, null, 1280);
  assert.equal(hs.length, 2);
});

test('keyAt is recorded per sample', () => {
  const s = new TrackStore();
  s.ingest([H(300, 300)], 0, (x) => (x < 300 ? 1 : 2), 1280);
  assert.equal(s.tracks.get(0).at(-1).key, 1);   // thumb is left of the wrist
  assert.equal(s.tracks.get(4).at(-1).key, 2);
});
