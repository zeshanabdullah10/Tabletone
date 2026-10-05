// Fusion: an audio onset says *when*; fingertip motion around that moment says *which key*.
// Also: vision-only "stop" detection and latency calibration.

export const FUSION = {
  pre: 100,          // ms before t_tap to look for the downstroke
  post: 50,          // ms after t_tap to look for stillness
  minDown: 1.5,      // hand-scales/s: minimum downstroke to qualify
  chordRatio: 0.8,   // score ≥ best × this → also play (chord)
  stillSpeed: 1.2,   // hand-scales/s considered "resting"
};

// Score every fingertip track for a tap at time tTap. Returns sorted candidates.
export function scoreTap(tracks, tTap) {
  const out = [];
  for (const [id, tr] of tracks) {
    let down = 0, rel = 0, keyS = null, bestDt = Infinity, after = 0, nAfter = 0, zAt = 0;
    for (const s of tr) {
      const dt = s.t - tTap;
      if (dt < -FUSION.pre || dt > FUSION.post) continue;
      if (dt <= 15) { if (s.vy > down) down = s.vy; if (s.rel > rel) rel = s.rel; }
      if (dt > 15) { after += Math.abs(s.vy); nAfter++; }
      if (Math.abs(dt) < bestDt && s.key != null) { bestDt = Math.abs(dt); keyS = s; zAt = s.z; }
    }
    if (!keyS || down < FUSION.minDown) continue;
    const still = nAfter ? (after / nAfter < FUSION.stillSpeed ? 1 : 0) : 0.5;
    const score = 0.5 * down + 1.0 * Math.max(0, rel) + 1.5 * still + Math.max(0, -zAt) * 5;
    out.push({ id, key: keyS.key, score, down, rel, still, z: zAt, x: keyS.x, y: keyS.y });
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}

// Pick the winning key(s) from scored candidates: best, plus near-ties on other keys (chord).
export function pickKeys(cands) {
  if (!cands.length) return [];
  const best = cands[0];
  const keys = [best.key];
  for (const c of cands.slice(1)) {
    if (c.score >= best.score * FUSION.chordRatio && !keys.includes(c.key)) keys.push(c.key);
  }
  return keys;
}

// Vision-only: a fingertip that moved down fast and has just stopped.
export class StopDetector {
  constructor({ downThr = 3, stillThr = 1.0, refractory = 180 } = {}) {
    Object.assign(this, { downThr, stillThr, refractory });
    this.lastFire = new Map();
  }
  // Returns [{id, t, key, x, y, down}] for stops on the newest frame.
  update(tracks) {
    const out = [];
    for (const [id, tr] of tracks) {
      const n = tr.length;
      if (n < 3) continue;
      const cur = tr[n - 1];
      if (Math.abs(cur.vy) > this.stillThr) continue;
      if (cur.t - (this.lastFire.get(id) ?? -1e9) < this.refractory) continue;
      let down = 0;
      for (let i = n - 2; i >= 0 && cur.t - tr[i].t <= 120; i--) down = Math.max(down, tr[i].vy);
      // Require the previous sample to be moving (so we fire on the *transition* to still).
      if (down >= this.downThr && tr[n - 2].vy > this.stillThr) {
        this.lastFire.set(id, cur.t);
        out.push({ id, t: cur.t, key: cur.key, x: cur.x, y: cur.y, down });
      }
    }
    return out;
  }
}

// Latency calibration: L = median(onset time − nearest vision stop time).
export function estimateLatency(onsetTimes, stopTimes, maxGap = 300) {
  const diffs = [];
  for (const ta of onsetTimes) {
    let best = null;
    for (const tv of stopTimes) {
      const d = ta - tv;
      if (Math.abs(d) <= maxGap && (best == null || Math.abs(d) < Math.abs(best))) best = d;
    }
    if (best != null) diffs.push(best);
  }
  if (diffs.length < 4) return null;
  diffs.sort((a, b) => a - b);
  const m = diffs[diffs.length >> 1];
  const mad = [...diffs].map((d) => Math.abs(d - m)).sort((a, b) => a - b)[diffs.length >> 1];
  return { L: m, n: diffs.length, spread: mad };
}
