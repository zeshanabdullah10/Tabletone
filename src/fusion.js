// Fusion: an audio onset says *when*; fingertip motion around that moment says *which key*.
// Also: vision-only "stop" detection and latency calibration.
// Units: positions in image px, motion in "hand scales" (wrist→middle-knuckle length),
// so thresholds hold at any distance from the camera.

export const FUSION = {
  pre: 130,          // ms before t_tap to look for the downstroke
  post: 50,          // ms after t_tap to look for stillness
  minDown: 1.5,      // hand-scales/s: minimum peak downward speed to qualify…
  minDrop: 0.08,     // …and minimum net downward travel (hand scales)
  chordRatio: 0.75,  // other fingers scoring ≥ best × this also play…
  chordMinDrop: 0.12,// …if they clearly travelled down themselves
  stillSpeed: 1.2,   // hand-scales/s considered "resting"
  retriggerMs: 70,   // same key can't fire twice within this window (bounces, double onsets)
  waitAfterTap: 0,   // decide once frames up to t_tap + this are in (see docs/ANALYSIS.md: latency)
  maxWait: 120,      // …but never wait longer than this after hearing the tap
};

const W_DOWN = 0.35, W_REL = 0.6, W_DROP = 8, W_STILL = 0.8, W_Z = 3;

// Score every fingertip track for a tap at time tTap. Returns candidates sorted best first.
export function scoreTap(tracks, tTap, cfg = FUSION) {
  const out = [];
  for (const [id, tr] of tracks) {
    let down = 0, rel = 0, keyS = null, bestDt = Infinity, after = 0, nAfter = 0;
    let yTop = Infinity, landSum = 0, nLand = 0;
    for (let i = 0; i < tr.length; i++) {
      const s = tr[i];
      const dt = s.t - tTap;
      if (dt < -cfg.pre - 60) continue;
      if (dt > cfg.post) break;
      // Highest point shortly before contact (3-sample average to ignore jitter),
      // and the average resting height around contact.
      if (dt < -25 && i > 0 && i < tr.length - 1) yTop = Math.min(yTop, (tr[i - 1].y + s.y + tr[i + 1].y) / 3);
      if (dt >= -20) { landSum += s.y; nLand++; }
      if (dt < -cfg.pre) continue;
      if (dt <= 20) { if (s.vy > down) down = s.vy; if (s.rel > rel) rel = s.rel; }
      if (dt > 20) { after += Math.abs(s.vy); nAfter++; }
      if (s.key != null && Math.abs(dt) < bestDt) { bestDt = Math.abs(dt); keyS = s; }
    }
    if (!keyS) continue;
    const drop = Number.isFinite(yTop) && nLand ? (landSum / nLand - yTop) / keyS.scale : 0;
    // Needs both a real downward speed and real downward travel: landmark jitter alone
    // easily produces one of the two on a resting hand, rarely both.
    if (down < cfg.minDown || drop < cfg.minDrop) continue;
    const still = nAfter ? (after / nAfter < cfg.stillSpeed ? 1 : 0) : 0.5;
    const z = keyS.z || 0;
    const score = W_DOWN * Math.min(down, 15) + W_REL * Math.max(0, Math.min(rel, 15)) + W_DROP * Math.min(drop, 1) + W_STILL * still + W_Z * Math.max(0, -z);
    out.push({ id, key: keyS.key, score, down, rel, drop, still, z, x: keyS.x, y: keyS.y });
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}

// Latency calibration: for each onset, find the strongest fingertip landing in the
// preceding ~300 ms and the moment it crossed 90% of its fall (interpolated between
// frames, so sub-frame accurate). L = median(onset − landing). tracks must hold the
// whole calibration history. Returns {L, n, spread} or null if inconsistent.
export function fitLatency(tracks, onsetTimes, { before = 300, after = 60, minDrop = 0.1, minPairs = 5, maxSpread = 30 } = {}) {
  const diffs = [];
  for (const ta of onsetTimes) {
    let best = null;
    for (const [, tr] of tracks) {
      for (let i = 1; i < tr.length; i++) {
        const s = tr[i];
        if (s.t < ta - before) continue;
        if (s.t > ta + after) break;
        // Highest point in the 200 ms before this sample.
        let top = s, j = i - 1;
        for (; j >= 0 && s.t - tr[j].t <= 200; j--) if (tr[j].y < top.y) top = tr[j];
        const drop = (s.y - top.y) / s.scale;
        if (drop < minDrop || (best && drop <= best.drop)) continue;
        // Only count it if the finger stops here (next sample is not much lower).
        const nx = tr[i + 1];
        if (nx && (nx.y - s.y) / s.scale > 0.25 * drop) continue;
        const yc = top.y + 0.9 * (s.y - top.y);
        let k = i;
        while (k > 0 && tr[k - 1].y >= yc && tr[k - 1].t > top.t) k--;
        const p = tr[k - 1], q = tr[k];
        const tc = q.y === p.y ? q.t : p.t + (yc - p.y) / (q.y - p.y) * (q.t - p.t);
        best = { drop, tc };
      }
    }
    if (best) diffs.push(ta - best.tc);
  }
  if (diffs.length < minPairs) return null;
  const L = median(diffs);
  const spread = median(diffs.map((d) => Math.abs(d - L)));
  if (spread > maxSpread) return null;
  return { L, n: diffs.length, spread };
}

// Pick the winning key(s): best, plus clear near-ties on other keys (chord).
export function pickKeys(cands, cfg = FUSION) {
  if (!cands.length) return [];
  const best = cands[0];
  const keys = [best.key];
  for (const c of cands.slice(1)) {
    if (c.score >= best.score * cfg.chordRatio && c.drop >= cfg.chordMinDrop && !keys.includes(c.key)) keys.push(c.key);
  }
  return keys;
}

// Drops keys that fired within retriggerMs (table ring, double onsets, audio+vision overlap).
export class Retrigger {
  constructor(ms = FUSION.retriggerMs) { this.ms = ms; this.last = new Map(); }
  filter(keys, t) {
    const ok = keys.filter((k) => t - (this.last.get(k) ?? -Infinity) >= this.ms);
    for (const k of ok) this.last.set(k, t);
    return ok;
  }
}

// Vision-only: a fingertip that moved down fast and has just stopped.
export class StopDetector {
  constructor({ downThr = 3, stillThr = 1.0, refractory = 180, minDrop = 0.1 } = {}) {
    Object.assign(this, { downThr, stillThr, refractory, minDrop });
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
      // Fire on the *transition* to still, after a real downstroke.
      if (tr[n - 2].vy <= this.stillThr) continue;
      let down = 0, yTop = cur.y;
      for (let i = n - 2; i >= 0 && cur.t - tr[i].t <= 150; i--) { down = Math.max(down, tr[i].vy); yTop = Math.min(yTop, tr[i].y); }
      if (down >= this.downThr && (cur.y - yTop) / cur.scale >= this.minDrop) {
        this.lastFire.set(id, cur.t);
        out.push({ id, t: cur.t, key: cur.key, x: cur.x, y: cur.y, down });
      }
    }
    return out;
  }
}

// Latency calibration: L = median(onset time − nearest vision stop time).
// Robust to missed/extra events; rejects inconsistent sessions (spread too large).
export function estimateLatency(onsetTimes, stopTimes, { maxGap = 300, minPairs = 5, maxSpread = 40 } = {}) {
  const diffs = [];
  for (const ta of onsetTimes) {
    let best = null;
    for (const tv of stopTimes) {
      const d = ta - tv;
      if (Math.abs(d) <= maxGap && (best == null || Math.abs(d) < Math.abs(best))) best = d;
    }
    if (best != null) diffs.push(best);
  }
  if (diffs.length < minPairs) return null;
  diffs.sort((a, b) => a - b);
  const m = median(diffs);
  const spread = median(diffs.map((d) => Math.abs(d - m)));
  if (spread > maxSpread) return null;
  return { L: m, n: diffs.length, spread };
}

function median(a) {
  const s = [...a].sort((x, y) => x - y), n = s.length;
  return n % 2 ? s[n >> 1] : (s[n / 2 - 1] + s[n / 2]) / 2;
}
