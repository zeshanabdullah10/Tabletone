// Turns the raw audio of one tap (all mic channels) into a feature vector that
// describes *where* on the table it happened, not how hard:
//  - log-mel spectrum of the attack (0–21 ms) and of the ring (11–32 ms), per channel,
//    each with its mean removed (loudness-invariant);
//  - with two mics: per-band level difference and the arrival-time difference.

export const FFT_N = 1024;
export const BANDS = 96;

export function tapFeatures({ channels, pre, sampleRate }) {
  const mel = melBank(sampleRate);
  const feats = [];
  const raw = [];
  for (const x of channels) {
    for (const off of [0, FFT_N / 2]) {
      const bands = logMel(x, pre + off - 16, mel);
      if (off === 0) raw.push(bands);
      feats.push(...centre(bands));
    }
  }
  if (channels.length >= 2) {
    const [a, b] = raw;
    for (let i = 0; i < BANDS; i++) feats.push(a[i] - b[i]);                   // level difference per band
    feats.push(gccPhatLag(channels[0], channels[1], pre, 48) / 8);              // arrival-time difference
  }
  return Float32Array.from(feats);
}

export function loudness({ channels, pre }) {
  let p = 0;
  const x = channels[0];
  for (let i = pre; i < Math.min(x.length, pre + 480); i++) p = Math.max(p, Math.abs(x[i]));
  return p;
}

// ---- DSP building blocks ----

const HANN = Float32Array.from({ length: FFT_N }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FFT_N - 1)));

export function logMel(x, start, mel) {
  const re = new Float64Array(FFT_N), im = new Float64Array(FFT_N);
  for (let i = 0; i < FFT_N; i++) { const j = start + i; re[i] = (j >= 0 && j < x.length ? x[j] : 0) * HANN[i]; }
  fft(re, im);
  const out = new Float64Array(BANDS);
  for (let b = 0; b < BANDS; b++) {
    let s = 0;
    for (const [k, w] of mel[b]) s += w * (re[k] * re[k] + im[k] * im[k]);
    out[b] = Math.log10(s + 1e-12);
  }
  // Bands far below the strongest are mostly room noise: clamp them (40 dB range).
  const top = Math.max(...out);
  for (let b = 0; b < BANDS; b++) out[b] = Math.max(out[b], top - 4);
  return out;
}

// Keep only the fine spectral structure (which table resonances rang), removing the
// smooth envelope set by tap force and finger softness: subtract a moving average.
function centre(v, half = 6) {
  const n = v.length, out = new Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0, c = 0;
    for (let j = Math.max(0, i - half); j <= Math.min(n - 1, i + half); j++) { s += v[j]; c++; }
    out[i] = v[i] - s / c;
  }
  return out;
}

const melCache = new Map();
export function melBank(sampleRate, lo = 150, hi = 16000) {
  const key = sampleRate;
  if (melCache.has(key)) return melCache.get(key);
  hi = Math.min(hi, sampleRate / 2 - 100);
  const toMel = (f) => 2595 * Math.log10(1 + f / 700), toHz = (m) => 700 * (10 ** (m / 2595) - 1);
  const pts = Array.from({ length: BANDS + 2 }, (_, i) => toHz(toMel(lo) + (i * (toMel(hi) - toMel(lo))) / (BANDS + 1)));
  const bin = (f) => (f * FFT_N) / sampleRate;
  const bank = [];
  for (let b = 0; b < BANDS; b++) {
    const [l, c, r] = [bin(pts[b]), bin(pts[b + 1]), bin(pts[b + 2])];
    const taps = [];
    for (let k = Math.floor(l); k <= Math.ceil(r); k++) {
      const w = k < c ? (k - l) / (c - l) : (r - k) / (r - c);
      if (w > 0) taps.push([k, w]);
    }
    if (!taps.length) taps.push([Math.round(c), 1]);
    bank.push(taps);
  }
  melCache.set(key, bank);
  return bank;
}

// In-place iterative radix-2 FFT.
export function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        [cr, ci] = [cr * wr - ci * wi, cr * wi + ci * wr];
      }
    }
  }
}

// Arrival-time difference (samples, b relative to a) by phase-transform cross-correlation.
export function gccPhatLag(a, b, start, maxLag) {
  const n = FFT_N;
  const ar = new Float64Array(n), ai = new Float64Array(n), br = new Float64Array(n), bi = new Float64Array(n);
  for (let i = 0; i < n / 2; i++) { const j = start - 16 + i; ar[i] = a[j] || 0; br[i] = b[j] || 0; }
  fft(ar, ai); fft(br, bi);
  const cr = new Float64Array(n), ci = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    // conj(A)·B
    const r = ar[k] * br[k] + ai[k] * bi[k], i = ar[k] * bi[k] - ai[k] * br[k];
    const m = Math.hypot(r, i) || 1;
    cr[k] = r / m; ci[k] = -i / m;           // conjugate for inverse via forward FFT
  }
  fft(cr, ci);
  let best = 0, bestV = -Infinity;
  for (let lag = -maxLag; lag <= maxLag; lag++) { const v = cr[(lag + n) % n]; if (v > bestV) { bestV = v; best = lag; } }
  return best;
}
