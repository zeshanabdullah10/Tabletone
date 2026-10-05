// Nearest-neighbour tap-location classifier trained from a few taps per key.
// Features are standardised per dimension using the training set.

export class TapClassifier {
  constructor({ k = 3, standardize = false } = {}) { this.k = k; this.standardize = standardize; this.examples = []; this.stats = null; }

  add(key, f) { this.examples.push({ key, f: Array.from(f) }); this.stats = null; }
  removeKey(key) { this.examples = this.examples.filter((e) => e.key !== key); this.stats = null; }
  count(key) { return this.examples.filter((e) => e.key === key).length; }
  get keys() { return [...new Set(this.examples.map((e) => e.key))].sort((a, b) => a - b); }

  toJSON() { return { k: this.k, examples: this.examples }; }
  static from(o) {
    const c = new TapClassifier({ k: (o && o.k) || 3 });
    if (o && Array.isArray(o.examples)) {
      const dim = o.examples[0] && o.examples[0].f.length;
      c.examples = o.examples.filter((e) => Number.isInteger(e.key) && Array.isArray(e.f) && e.f.length === dim && e.f.every(Number.isFinite));
    }
    return c;
  }

  fit() {
    const ex = this.examples;
    if (!ex.length) return (this.stats = null);
    const d = ex[0].f.length, mean = new Float64Array(d), sd = new Float64Array(d);
    for (const e of ex) for (let i = 0; i < d; i++) mean[i] += e.f[i] / ex.length;
    for (const e of ex) for (let i = 0; i < d; i++) sd[i] += (e.f[i] - mean[i]) ** 2 / ex.length;
    for (let i = 0; i < d; i++) sd[i] = this.standardize ? Math.sqrt(sd[i]) + 1e-3 : 1;
    const z = ex.map((e) => ({ key: e.key, z: e.f.map((v, i) => (v - mean[i]) / sd[i]) }));
    // Typical within-key nearest-neighbour distance, for rejecting unfamiliar sounds.
    const nn = z.map((a, i) => Math.min(...z.filter((b, j) => j !== i && b.key === a.key).map((b) => dist(a.z, b.z)), Infinity)).filter(Number.isFinite).sort((a, b) => a - b);
    this.stats = { mean, sd, z, typical: nn.length ? nn[nn.length >> 1] : 1 };
    return this.stats;
  }

  // → {key, confidence, distance, unknown} or null when untrained.
  predict(f, { exclude = -1, rejectFactor = 3 } = {}) {
    const st = this.stats || this.fit();
    if (!st) return null;
    const q = Array.from(f, (v, i) => (v - st.mean[i]) / st.sd[i]);
    const ds = st.z.map((e, i) => ({ key: e.key, d: i === exclude ? Infinity : dist(q, e.z) })).sort((a, b) => a.d - b.d);
    const votes = new Map();
    for (const n of ds.slice(0, this.k)) if (Number.isFinite(n.d)) votes.set(n.key, (votes.get(n.key) || 0) + 1 / (n.d + 1e-6));
    let key = null, best = -1, total = 0;
    for (const [k2, v] of votes) { total += v; if (v > best) { best = v; key = k2; } }
    const nearest = ds[0].d;
    return { key, confidence: total ? best / total : 0, distance: nearest, unknown: nearest > rejectFactor * st.typical };
  }

  // Leave-one-out accuracy + confusion matrix: how well this table/phone setup works.
  evaluate() {
    const st = this.fit();
    if (!st) return null;
    let ok = 0;
    const confusion = {};
    st.z.forEach((e, i) => {
      const p = this.predict(this.examples[i].f, { exclude: i });
      confusion[e.key] = confusion[e.key] || {};
      confusion[e.key][p.key] = (confusion[e.key][p.key] || 0) + 1;
      if (p.key === e.key) ok++;
    });
    return { n: st.z.length, ok, acc: ok / st.z.length, confusion };
  }
}

function dist(a, b) { let s = 0; for (let i = 0; i < a.length; i++) s += (a[i] - b[i]) ** 2; return Math.sqrt(s); }
