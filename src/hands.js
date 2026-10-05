// HandLandmarker wrapper and per-fingertip motion tracks.
import { FilesetResolver, HandLandmarker } from '../vendor/mediapipe/vision_bundle.mjs';

export const TIPS = [4, 8, 12, 16, 20];
const HISTORY_MS = 500;

export async function createHandTracker() {
  const vision = await FilesetResolver.forVisionTasks(new URL('../vendor/mediapipe/wasm', import.meta.url).href);
  const opts = (delegate) => ({
    baseOptions: { modelAssetPath: new URL('../models/hand_landmarker.task', import.meta.url).href, delegate },
    runningMode: 'VIDEO',
    numHands: 2,
    minHandDetectionConfidence: 0.5,
    minHandPresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,
  });
  let landmarker;
  try { landmarker = await HandLandmarker.createFromOptions(vision, opts('GPU')); }
  catch (_) { landmarker = await HandLandmarker.createFromOptions(vision, opts('CPU')); }
  return new HandTracker(landmarker);
}

class HandTracker {
  constructor(landmarker) {
    this.landmarker = landmarker;
    this.tracks = new Map();   // id (slot*5+finger) → [{t,x,y,z,vy,rel,key}]
    this.hands = [];           // latest frame: [{slot, pts:[{x,y,z}], scale}]
    this.lastTs = 0;
    this.inferMs = 0;
    this.skip = 0;
  }

  // Runs inference on the current video frame. keyAt(x,y) → key index or null.
  process(video, t, keyAt) {
    // Save heat when nobody's there: only check every 3rd frame.
    if (this.hands.length === 0 && (this.skip++ % 3) !== 0) return this.hands;
    const ts = Math.max(this.lastTs + 1, Math.round(t));
    this.lastTs = ts;
    const t0 = performance.now();
    const res = this.landmarker.detectForVideo(video, ts);
    this.inferMs = performance.now() - t0;
    const W = video.videoWidth, H = video.videoHeight;

    const hands = (res.landmarks || []).map((lm) => {
      const pts = lm.map((p) => ({ x: (1 - p.x) * W, y: p.y * H, z: p.z }));   // mirrored
      const scale = Math.hypot(pts[9].x - pts[0].x, pts[9].y - pts[0].y) || 1;
      return { pts, scale };
    });
    // Stable slots: sort by wrist x (screen-left first); a lone hand keeps the nearer slot.
    hands.sort((a, b) => a.pts[0].x - b.pts[0].x);
    if (hands.length === 2) { hands[0].slot = 0; hands[1].slot = 1; }
    else if (hands.length === 1) {
      const prev = this.hands;
      let slot = hands[0].pts[0].x < W / 2 ? 0 : 1;
      if (prev.length) {
        const near = prev.reduce((a, b) => Math.abs(a.pts[0].x - hands[0].pts[0].x) < Math.abs(b.pts[0].x - hands[0].pts[0].x) ? a : b);
        slot = near.slot;
      }
      hands[0].slot = slot;
    }

    for (const h of hands) {
      const vys = [];
      const samples = TIPS.map((idx, f) => {
        const p = h.pts[idx];
        const id = h.slot * 5 + f;
        let tr = this.tracks.get(id);
        if (!tr) { tr = []; this.tracks.set(id, tr); }
        const last = tr[tr.length - 1];
        let vy = 0;
        if (last && t - last.t > 0 && t - last.t < 150) vy = (p.y - last.y) / (t - last.t) * 1000 / h.scale; // hand-scales per second, + = down
        vys.push(vy);
        return { tr, s: { t, x: p.x, y: p.y, z: p.z, vy, rel: 0, key: keyAt ? keyAt(p.x, p.y) : null, scale: h.scale } };
      });
      const sorted = [...vys].sort((a, b) => a - b);
      const med = sorted[2];
      for (const { tr, s } of samples) {
        s.rel = s.vy - med;
        tr.push(s);
        while (tr.length && t - tr[0].t > HISTORY_MS) tr.shift();
      }
    }
    // Drop tracks for hands that disappeared long ago.
    for (const [id, tr] of this.tracks) if (!tr.length || t - tr[tr.length - 1].t > HISTORY_MS) this.tracks.delete(id);

    this.hands = hands;
    return hands;
  }

  latestTime() { return this.lastTs; }
}
