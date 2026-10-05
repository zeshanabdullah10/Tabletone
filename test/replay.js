// Replays a simulated session through the real tracking + fusion code, the way main.js does:
// each onset is resolved once the camera has delivered frames up to t_tap + 30 ms.
import { TrackStore } from '../src/tracks.js';
import { scoreTap, pickKeys, StopDetector, Retrigger, estimateLatency, fitLatency, FUSION } from '../src/fusion.js';
import { W } from './sim.js';

// cameraLagMs: delay from frame capture until its landmarks are available.
// audioLagMs: delay from the onset's timestamp until the main thread hears about it.
// maxWaitMs: give up waiting for frames after this long (main.js uses 120).
export function replay(kb, { frames, onsets }, { L = 45, cameraLagMs = 0, audioLagMs = 10, maxWaitMs = FUSION.maxWait, waitAfterTap = FUSION.waitAfterTap } = {}) {
  const store = new TrackStore();
  const retrig = new Retrigger();
  const keyAt = (x, y) => kb.keyAt(x, y);
  const results = [];
  const queue = onsets.map((o) => ({ ...o, tTap: o.t - L, heard: o.t + audioLagMs })).sort((a, b) => a.t - b.t);
  let fi = 0, wall = -Infinity;
  const feedUntil = (w) => {
    while (fi < frames.length && frames[fi].t + cameraLagMs <= w) { store.ingest(frames[fi].hands, frames[fi].t, keyAt, W); fi++; }
    wall = w;
  };
  for (const o of queue) {
    // Wall time when a frame captured at ≥ tTap + waitAfterTap is available.
    const f = frames.find((x) => x.t >= o.tTap + waitAfterTap);
    const ready = Math.max(o.heard, f ? f.t + cameraLagMs : Infinity);
    const at = Math.max(wall, Math.min(ready, o.heard + maxWaitMs));
    feedUntil(at);
    const cands = scoreTap(store.tracks, o.tTap);
    const keys = retrig.filter(pickKeys(cands), o.tTap);
    results.push({ onset: o, keys, cands, latency: at - (o.tap ? o.tap.t : o.t) });
  }
  return results;
}

export function calibrate(kb, { frames, onsets }) {
  const store = new TrackStore({ historyMs: 60000 });
  const det = new StopDetector();
  const stops = [];
  for (const f of frames) {
    store.ingest(f.hands, f.t, (x, y) => kb.keyAt(x, y), W);
    for (const s of det.update(store.tracks)) stops.push(s.t);
  }
  const times = onsets.map((o) => o.t);
  return { est: fitLatency(store.tracks, times), legacy: estimateLatency(times, stops), stops };
}

export function visionOnly(kb, { frames }) {
  const store = new TrackStore();
  const det = new StopDetector();
  const retrig = new Retrigger();
  const notes = [];
  for (const f of frames) {
    store.ingest(f.hands, f.t, (x, y) => kb.keyAt(x, y), W);
    for (const s of det.update(store.tracks)) if (s.key != null) {
      const k = retrig.filter([s.key], s.t);
      if (k.length) notes.push({ t: s.t, key: s.key });
    }
  }
  return notes;
}

export function accuracy(results) {
  let ok = 0, wrong = 0, missed = 0, extra = 0;
  for (const r of results) {
    if (!r.keys.length) { missed++; continue; }
    if (r.keys[0] === r.onset.tap.key) ok++; else wrong++;
    extra += r.keys.length - 1;
  }
  const n = results.length;
  const lat = results.filter((r) => r.keys.length).map((r) => r.latency).sort((a, b) => a - b);
  return { n, ok, wrong, missed, extra, acc: ok / n, missRate: missed / n, latMedian: lat[lat.length >> 1], latMax: lat[lat.length - 1] };
}
