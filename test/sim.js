// Deterministic simulator of the camera + mic pipeline for tests.
// Produces per-frame hand landmarks (mirrored image px) and audio onset times
// for a scripted sequence of taps, with landmark noise, frame jitter, dropped
// frames, sympathetic finger motion and hand drift.
import { Keyboard } from '../src/keyboard.js';

export function rng(seed = 1) {
  let s = seed >>> 0;
  const next = () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  next.normal = () => { const u = Math.max(1e-12, next()), v = next(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
  return next;
}

export const W = 1280, H = 720;
// Fingertip x offsets (thumb..pinky) relative to the wrist, in hand scales, for a
// hand seen from the front with fingers pointing toward the camera (down the image).
const TIP_DX = [-1.0, -0.55, -0.1, 0.35, 0.75];
const TIP_DY = [1.3, 1.85, 1.95, 1.85, 1.6];

// Builds 21 landmarks for a hand: wrist at (x, y), scale = wrist→middle knuckle px.
// dy[f] = extra downward offset (px) of fingertip f; mirror = right hand flips offsets.
export function handPts(x, y, scale, { dy = [0, 0, 0, 0, 0], mirror = false, z = [0, 0, 0, 0, 0] } = {}) {
  const pts = Array.from({ length: 21 }, () => ({ x, y, z: 0 }));
  const sgn = mirror ? -1 : 1;
  pts[9] = { x, y: y + scale, z: 0 };
  [4, 8, 12, 16, 20].forEach((idx, f) => {
    const tx = x + sgn * TIP_DX[f] * scale, ty = y + TIP_DY[f] * scale + dy[f];
    pts[idx] = { x: tx, y: ty, z: z[f] };
    pts[idx - 1] = { x: (x + tx) / 2 + sgn * 0.02 * scale, y: (y + ty) * 0.5 + 0.3 * scale, z: 0 };
  });
  return pts;
}

// Keyboard laid between two flat hands, like the span gesture would.
export function placedKeyboard({ scale = 70, leftX = 330, rightX = 950, wristY = 300 } = {}) {
  const kb = new Keyboard();
  const l = { pts: handPts(leftX, wristY, scale) };
  const r = { pts: handPts(rightX, wristY + 6, scale * 1.02, { mirror: true }) };
  kb.setQuad(Keyboard.quadFromHands(l, r), W, H);
  return kb;
}

// Wrist x so that `finger` of hand `slot` sits above key `key` (+ offset in key widths).
function wristXFor(kb, key, finger, slot, scale, offset) {
  const u = (key + 0.5 + offset) / kb.count;
  const p = kb.point(Math.min(0.999, Math.max(0, u)), 0.5);
  const sgn = slot === 1 ? -1 : 1;
  return { x: p.x - sgn * TIP_DX[finger] * scale, y: p.y - TIP_DY[finger] * scale };
}

// Tap motion: lift by `lift` px, then fall with acceleration over `fall` ms to contact at tc.
function tapOffset(t, tc, lift, fall = 80) {
  const up0 = tc - 380, up1 = tc - 160;
  if (t < up0 || t > tc + 400) return 0;
  if (t < up1) { const a = (t - up0) / (up1 - up0); return -lift * (0.5 - 0.5 * Math.cos(Math.PI * a)); }
  if (t < tc - fall) return -lift;
  if (t < tc) { const a = (t - (tc - fall)) / fall; return -lift * (1 - a * a); }
  return 0;
}

// Simulates a session. taps: [{t, key, finger, slot, offset?, lift?}] (t = contact time, ms).
// Returns {frames:[{t, hands:[{pts}]}], onsets:[{t, tap}]}.
export function simulate(kb, taps, opts = {}) {
  const {
    seed = 7, fps = 30, jitterMs = 3, dropRate = 0.04, noisePx = 1.5, scale = 70,
    latency = 45, onsetJitter = 3, sympathy = 0.25, duration = null, extraHands = true,
    drift = 0.05, liftScale = 0.35, depthNoise = 0,
  } = opts;
  const r = rng(seed);
  const end = duration ?? (taps.length ? taps[taps.length - 1].t + 600 : 1000);
  const frames = [];
  const sorted = [...taps].sort((a, b) => a.t - b.t);
  // Home position per hand, updated toward each tap's target smoothly.
  const home = [wristXFor(kb, 1, 2, 0, scale, 0), wristXFor(kb, kb.count - 2, 2, 1, scale * 1.02, 0)];
  const plans = [[], []];
  for (const tap of sorted) {
    const sc = tap.slot === 1 ? scale * 1.02 : scale;
    plans[tap.slot].push({ t: tap.t, pos: wristXFor(kb, tap.key, tap.finger, tap.slot, sc, tap.offset ?? 0), tap });
  }
  const posAt = (slot, t) => {
    const pl = plans[slot];
    let prev = { t: -Infinity, pos: home[slot] };
    for (const p of pl) {
      if (p.t - 250 > t) {
        // Moving toward the next target during [p.t-450, p.t-250].
        const a = (t - (p.t - 450)) / 200;
        if (a <= 0) return prev.pos;
        const e = 0.5 - 0.5 * Math.cos(Math.PI * Math.min(1, a));
        return { x: prev.pos.x + (p.pos.x - prev.pos.x) * e, y: prev.pos.y + (p.pos.y - prev.pos.y) * e };
      }
      prev = p;
    }
    return prev.pos;
  };

  let t = 0;
  while (t < end) {
    t += 1000 / fps + (r() * 2 - 1) * jitterMs;
    if (r() < dropRate) continue;
    const hands = [];
    for (const slot of [0, 1]) {
      if (!extraHands && !plans[slot].length) continue;
      const sc = slot === 1 ? scale * 1.02 : scale;
      const p = posAt(slot, t);
      const dy = [0, 0, 0, 0, 0], z = [0, 0, 0, 0, 0];
      for (const p2 of plans[slot]) {
        const lift = (p2.tap.lift ?? liftScale) * sc;
        const off = tapOffset(t, p2.t, lift);
        if (!off) continue;
        for (let f = 0; f < 5; f++) {
          const w = f === p2.tap.finger ? 1 : Math.abs(f - p2.tap.finger) === 1 ? sympathy : sympathy * 0.3;
          dy[f] += off * w;
          z[f] += f === p2.tap.finger ? -off / sc * 0.02 : 0;
        }
      }
      const dr = drift * sc * Math.sin(t / 900 + slot);
      const pts = handPts(p.x + dr, p.y, sc, { dy, z, mirror: slot === 1 });
      for (const q of pts) {
        q.x += r.normal() * noisePx; q.y += r.normal() * noisePx;
        q.z += r.normal() * depthNoise;
      }
      hands.push({ pts });
    }
    frames.push({ t, hands });
  }
  const onsets = sorted.map((tap) => ({ t: tap.t + latency + r.normal() * onsetJitter, tap }));
  return { frames, onsets };
}

// Evenly spaced random taps over the keyboard; each key played by the nearer hand.
export function randomTaps(kb, n, { seed = 3, gap = 550, start = 800, fingers = [1, 2, 3], offsetSpread = 0.25 } = {}) {
  const r = rng(seed);
  const taps = [];
  for (let i = 0; i < n; i++) {
    const key = Math.floor(r() * kb.count);
    const slot = key < kb.count / 2 ? 0 : 1;
    taps.push({ t: start + i * gap, key, slot, finger: fingers[Math.floor(r() * fingers.length)], offset: (r() * 2 - 1) * offsetSpread });
  }
  return taps;
}
