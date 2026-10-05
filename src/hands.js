// HandLandmarker wrapper; motion tracking lives in tracks.js.
import { FilesetResolver, HandLandmarker } from '../vendor/mediapipe/vision_bundle.mjs';
import { TrackStore, TIPS } from './tracks.js';

export { TIPS };

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
  let landmarker, delegate = 'GPU';
  try { landmarker = await HandLandmarker.createFromOptions(vision, opts('GPU')); }
  catch (_) { delegate = 'CPU'; landmarker = await HandLandmarker.createFromOptions(vision, opts('CPU')); }
  return new HandTracker(landmarker, delegate);
}

class HandTracker {
  constructor(landmarker, delegate) {
    this.landmarker = landmarker;
    this.delegate = delegate;
    this.store = new TrackStore();
    this.lastTs = 0;
    this.inferMs = 0;
    this.skip = 0;
  }

  get tracks() { return this.store.tracks; }
  get hands() { return this.store.hands; }

  // Runs inference on the current video frame. keyAt(x,y) → key index or null.
  process(video, t, keyAt) {
    // Save heat when nobody's there: only check every 3rd frame.
    if (this.hands.length === 0 && (this.skip++ % 3) !== 0) {
      this.store.lastT = Math.max(this.store.lastT, t);   // nothing to wait for on skipped frames
      return this.hands;
    }
    const ts = Math.max(this.lastTs + 1, Math.round(t));
    const t0 = performance.now();
    const res = this.landmarker.detectForVideo(video, ts);
    this.lastTs = ts;
    this.inferMs = performance.now() - t0;
    const W = video.videoWidth, H = video.videoHeight;
    const raw = (res.landmarks || []).map((lm) => ({ pts: lm.map((p) => ({ x: (1 - p.x) * W, y: p.y * H, z: p.z })) }));
    return this.store.ingest(raw, t, keyAt, W);
  }

  // Capture time of the newest processed frame (performance.now() clock).
  latestTime() { return this.store.lastT; }
}
