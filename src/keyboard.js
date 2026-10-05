// Keyboard placed on the table as a perspective quad in (mirrored) image pixels.
// Corners: near (player side, wrists) and far (toward the phone, past fingertips).
// u runs left→right along the keys, v runs near→far; fingertips sit around v≈0.5.

export const SCALES = {
  major:      { name: 'C major',    steps: [0, 2, 4, 5, 7, 9, 11, 12] },
  pentatonic: { name: 'Pentatonic', steps: [0, 2, 4, 7, 9, 12, 14, 16] },
  minor:      { name: 'A minor',    steps: [-3, -1, 0, 2, 4, 5, 7, 9] },
};
const NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];

export function noteName(midi) { return NAMES[((midi % 12) + 12) % 12] + (Math.floor(midi / 12) - 1); }

export class Keyboard {
  constructor() {
    this.quad = null;          // {nl, nr, fr, fl} each {x,y}
    this.scale = 'major';
    this.octave = 4;
  }

  get count() { return SCALES[this.scale].steps.length; }
  midi(i) { return 12 * (this.octave + 1) + SCALES[this.scale].steps[i]; }
  label(i) { return noteName(this.midi(i)); }

  toJSON() { return { quad: this.quad, scale: this.scale, octave: this.octave }; }
  load(o) { if (o) { this.quad = o.quad || null; this.scale = SCALES[o.scale] ? o.scale : 'major'; this.octave = o.octave ?? 4; } }

  // Build the quad from two hands laid flat: outer fingertips set the ends,
  // fingertip line sets the playing line, finger length sets key depth.
  static quadFromHands(left, right) {
    const tipsL = [4, 8, 12, 16, 20].map((i) => left.pts[i]);
    const tipsR = [4, 8, 12, 16, 20].map((i) => right.pts[i]);
    const avg = (a) => a.reduce((s, p) => s + p, 0) / a.length;
    const xl = Math.min(...tipsL.map((p) => p.x));
    const xr = Math.max(...tipsR.map((p) => p.x));
    const yl = avg(tipsL.slice(1).map((p) => p.y));
    const yr = avg(tipsR.slice(1).map((p) => p.y));
    // Finger vector wrist→middle tip, per side (perspective: nearer = bigger).
    const fv = (h) => ({ x: h.pts[12].x - h.pts[0].x, y: h.pts[12].y - h.pts[0].y });
    const vl = fv(left), vr = fv(right);
    const dl = 0.55 * Math.hypot(vl.x, vl.y), dr = 0.55 * Math.hypot(vr.x, vr.y);
    // Key depth runs along the image vertical, in the direction the fingers point.
    const sgn = Math.sign(vl.y + vr.y) || 1;
    return {
      nl: { x: xl, y: yl - sgn * dl }, nr: { x: xr, y: yr - sgn * dr },
      fr: { x: xr, y: yr + sgn * dr }, fl: { x: xl, y: yl + sgn * dl },
    };
  }

  // Bilinear point at (u,v).
  point(u, v) {
    const q = this.quad;
    const a = lerp(q.nl, q.nr, u), b = lerp(q.fl, q.fr, u);
    return lerp(a, b, v);
  }

  // Inverse bilinear: image (x,y) → (u,v), or null if degenerate.
  uv(x, y) {
    const q = this.quad;
    if (!q) return null;
    const A = q.nl, B = q.nr, C = q.fr, D = q.fl;
    const e = sub(B, A), f = sub(D, A), g = add(sub(A, B), sub(C, D)), h = sub({ x, y }, A);
    const k2 = cross(g, f), k1 = cross(e, f) + cross(h, g), k0 = cross(h, e);
    let v;
    if (Math.abs(k2) < 1e-6) { if (Math.abs(k1) < 1e-9) return null; v = -k0 / k1; }
    else {
      const disc = k1 * k1 - 4 * k0 * k2;
      if (disc < 0) return null;
      const s = Math.sqrt(disc);
      const v1 = (-k1 - s) / (2 * k2), v2 = (-k1 + s) / (2 * k2);
      v = Math.abs(v1 - 0.5) < Math.abs(v2 - 0.5) ? v1 : v2;
    }
    const den = e.x + g.x * v;
    const u = Math.abs(den) > Math.abs(e.y + g.y * v) ? (h.x - f.x * v) / den : (h.y - f.y * v) / (e.y + g.y * v);
    return { u, v };
  }

  // Key under an image point, or null if outside the keyboard zone (with some slack in depth).
  keyAt(x, y) {
    const r = this.uv(x, y);
    if (!r || r.u < 0 || r.u >= 1 || r.v < -0.25 || r.v > 1.25) return null;
    return Math.floor(r.u * this.count);
  }

  corners() { const q = this.quad; return q ? [['nl', q.nl], ['nr', q.nr], ['fr', q.fr], ['fl', q.fl]] : []; }
}

const lerp = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y });
const add = (a, b) => ({ x: a.x + b.x, y: a.y + b.y });
const cross = (a, b) => a.x * b.y - a.y * b.x;
