// Mallet mode: the camera only *points* (where are the two index fingertips?), the mic
// only *triggers* (a tap happened). Keys are plain columns across the image.

export const INDEX_TIP = 8;
export const MALLET = {
  margin: 0.05,     // fraction of the image width left unused at each side
  lookback: 260,    // ms before the tap to look for each finger's downstroke
  after: 50,        // ms after the tap still counted as "landing"
  minTravel: 0.06,  // hand scales of downward travel for a finger to count as the striker
  chordRatio: 0.6,  // second hand also plays if it travelled ≥ this × the first…
  chordMin: 0.15,   // …and at least this much
};

// Key column under image x (mirrored image px), or null in the side margins.
export function keyForX(x, width, count, margin = MALLET.margin) {
  const u = (x / width - margin) / (1 - 2 * margin);
  if (!(u >= 0 && u < 1)) return null;
  return Math.floor(u * count);
}

// Track id of a hand slot's index fingertip in TrackStore (slot*5 + finger index 1).
export const malletId = (slot) => slot * 5 + 1;

// Which mallet(s) struck at tTap? tracks: TrackStore.tracks. Returns
// [{slot, x, travel}] best first: one entry normally, two for a two-hand chord.
export function strikers(tracks, tTap, cfg = MALLET) {
  const hands = [];
  for (const slot of [0, 1]) {
    const tr = tracks.get(malletId(slot));
    if (!tr || !tr.length) continue;
    let top = Infinity, land = -Infinity, at = null;
    const rest = [];
    for (const s of tr) {
      const dt = s.t - tTap;
      if (dt >= -cfg.lookback - 450 && dt < -cfg.lookback) rest.push(s.y);   // resting height before the stroke
      if (dt < -cfg.lookback || dt > cfg.after) continue;
      if (dt <= -30) top = Math.min(top, s.y);
      if (dt >= -80) land = Math.max(land, s.y);
      if (dt <= cfg.after && (!at || Math.abs(dt) < Math.abs(at.t - tTap))) at = s;
    }
    const last = tr[tr.length - 1];
    if (!at) {
      // No frame near the tap yet: only usable if the hand is still in view right now.
      if (tTap - last.t > 400) continue;
      at = last;
    }
    // A striking finger lifts first (visible even when the camera lags the mic), then falls.
    const travel = Number.isFinite(top) && Number.isFinite(land) ? Math.max(0, (land - top) / at.scale) : 0;
    rest.sort((p, q) => p - q);
    const lift = rest.length && Number.isFinite(top) ? Math.max(0, (rest[rest.length >> 1] - top) / at.scale) : 0;
    hands.push({ slot, x: at.x, travel: travel + 0.8 * lift, fall: travel, lift });
  }
  if (hands.length <= 1) return hands;                 // one hand in view: it's the striker
  hands.sort((a, b) => b.travel - a.travel);
  const [a, b] = hands;
  if (a.travel < cfg.minTravel) return [nearestRecent(tracks, hands, tTap)];
  return b.travel >= Math.max(cfg.chordMin, a.travel * cfg.chordRatio) ? [a, b] : [a];
}

// Neither finger visibly moved (e.g. frames not in yet): pick the lower fingertip
// relative to its own recent position — the one closer to having just landed.
function nearestRecent(tracks, hands, tTap) {
  let best = hands[0], bestScore = -Infinity;
  for (const h of hands) {
    const tr = tracks.get(malletId(h.slot));
    const recent = tr.filter((s) => s.t >= tTap - 500 && s.t <= tTap + 50);
    if (!recent.length) continue;
    const minY = Math.min(...recent.map((s) => s.y));
    const score = (recent[recent.length - 1].y - minY) / recent[recent.length - 1].scale;
    if (score > bestScore) { bestScore = score; best = h; }
  }
  return best;
}

// Has the camera delivered enough frames to decide? With one hand in view we can decide
// at once; with two we want a frame at or after the tap (bounded by maxWait).
export function readyToDecide(tracks, tTap, latestFrameT, heardAgoMs, maxWait = 90) {
  const visible = [0, 1].filter((s) => { const tr = tracks.get(malletId(s)); return tr && tr.length && latestFrameT - tr[tr.length - 1].t < 150; });
  if (visible.length < 2) return true;
  return latestFrameT >= tTap || heardAgoMs >= maxWait;
}
