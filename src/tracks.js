// Fingertip motion tracks — pure logic, no MediaPipe, so it can be unit-tested.
// Input per frame: hands as [{pts:[21 × {x,y,z}]}] in mirrored image pixels.

export const TIPS = [4, 8, 12, 16, 20];
export const HISTORY_MS = 600;
const MAX_GAP_MS = 150;          // longer gaps → velocity unknown (0)
const TELEPORT_SCALES = 1.5;     // per-frame jump bigger than this → hands swapped, restart track

export class TrackStore {
  constructor({ historyMs = HISTORY_MS } = {}) {
    this.historyMs = historyMs;    // raised during latency calibration to keep the whole session
    this.tracks = new Map();     // id (slot*5+finger) → [{t,x,y,z,vy,rel,key,scale}]
    this.hands = [];
    this.lastT = -Infinity;
  }

  // Assigns stable slots (0 = screen-left hand, 1 = screen-right) and appends samples.
  ingest(rawHands, t, keyAt, frameW) {
    if (t <= this.lastT) return this.hands;     // out-of-order frame
    this.lastT = t;
    const hands = rawHands.map((h) => ({
      pts: h.pts,
      scale: Math.hypot(h.pts[9].x - h.pts[0].x, h.pts[9].y - h.pts[0].y) || 1,
    }));
    assignSlots(hands, this.hands, frameW);

    for (const h of hands) {
      const vys = [];
      const samples = TIPS.map((idx, f) => {
        const p = h.pts[idx];
        const id = h.slot * 5 + f;
        let tr = this.tracks.get(id);
        if (!tr) { tr = []; this.tracks.set(id, tr); }
        let last = tr[tr.length - 1];
        if (last && Math.hypot(p.x - last.x, p.y - last.y) > TELEPORT_SCALES * h.scale) { tr.length = 0; last = null; }
        let vy = 0;
        const dt = last ? t - last.t : 0;
        if (last && dt > 0 && dt < MAX_GAP_MS) vy = (p.y - last.y) / dt * 1000 / h.scale;   // hand-scales/s, + = down
        vys.push(vy);
        return { tr, s: { t, x: p.x, y: p.y, z: p.z, vy, rel: 0, key: keyAt ? keyAt(p.x, p.y) : null, scale: h.scale } };
      });
      const med = [...vys].sort((a, b) => a - b)[2];
      for (const { tr, s } of samples) {
        s.rel = s.vy - med;
        tr.push(s);
        while (tr.length && t - tr[0].t > this.historyMs) tr.shift();
      }
    }
    for (const [id, tr] of this.tracks) if (!tr.length || t - tr[tr.length - 1].t > this.historyMs) this.tracks.delete(id);
    this.hands = hands;
    return hands;
  }
}

function assignSlots(hands, prev, frameW) {
  hands.sort((a, b) => a.pts[0].x - b.pts[0].x);
  if (hands.length >= 2) { hands.length = 2; hands[0].slot = 0; hands[1].slot = 1; return; }
  if (hands.length === 1) {
    const h = hands[0];
    let slot = h.pts[0].x < frameW / 2 ? 0 : 1;
    if (prev.length) {
      const near = prev.reduce((a, b) => (Math.abs(a.pts[0].x - h.pts[0].x) < Math.abs(b.pts[0].x - h.pts[0].x) ? a : b));
      slot = near.slot;
    }
    h.slot = slot;
  }
}
