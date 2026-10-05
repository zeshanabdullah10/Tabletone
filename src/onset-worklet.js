// AudioWorkletProcessor: high-pass + short-term energy vs. slow noise floor.
// Posts {type:'onset', frame, ratio, peak} and periodic {type:'level', rms, floor}.

class OnsetProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    const fs = sampleRate;
    // 2nd-order Butterworth high-pass at ~100 Hz (RBJ cookbook).
    const f0 = 100, q = Math.SQRT1_2;
    const w = 2 * Math.PI * f0 / fs, cw = Math.cos(w), alpha = Math.sin(w) / (2 * q);
    const a0 = 1 + alpha;
    this.b0 = (1 + cw) / 2 / a0; this.b1 = -(1 + cw) / a0; this.b2 = this.b0;
    this.a1 = -2 * cw / a0; this.a2 = (1 - alpha) / a0;
    this.x1 = this.x2 = this.y1 = this.y2 = 0;

    this.win = Math.max(16, Math.round(fs * 0.002));   // 2 ms energy window
    this.acc = 0; this.n = 0; this.winPeak = 0; this.winStart = 0;
    this.floor = 1e-6;
    this.floorAlpha = this.win / (fs * 0.2);             // ~200 ms average
    this.k = 6;
    this.minEnergy = 1e-6;
    this.refractory = Math.round(fs * 0.04);            // 40 ms
    this.lastOnset = -Infinity;
    this.warmup = Math.round(fs * 0.3);               // learn the floor before firing
    this.sharp = 4;                                   // attack must jump vs. the last ~6 ms
    this.riseMax = 3;                                 // windows (6 ms): taps peak fast, music swells don't
    this.cand = null;                                 // onset candidate waiting for its peak
    this.hold = false;                                // rejected swell: wait for it to fall first
    this.prevE = [0, 0, 0];
    this.seen = 0;                                    // samples processed (context may predate the mic)
    // Snippet capture (Tap Table mode): raw audio of every channel around each onset.
    this.snipOn = false;
    this.snipPre = 64; this.snipPost = 1536;
    this.ringSize = 8192; this.rings = [];
    this.snips = [];                                  // pending {sample, until}
    this.levelEvery = Math.round(fs / 30);
    this.levelCount = 0; this.levelAcc = 0; this.levelN = 0;

    this.port.onmessage = (e) => {
      const d = e.data;
      if (d.k != null) this.k = d.k;
      if (d.minEnergy != null) this.minEnergy = d.minEnergy;
      if (d.sharp != null) this.sharp = d.sharp;
      if (d.snippet != null) { this.snipOn = !!d.snippet; if (d.pre) this.snipPre = d.pre; if (d.post) this.snipPost = d.post; }
    };
  }

  process(inputs) {
    const chans = inputs[0];
    const ch = chans && chans[0];
    if (!ch) return true;
    const base = currentFrame;
    if (this.snipOn) while (this.rings.length < chans.length) this.rings.push(new Float32Array(this.ringSize));
    for (let i = 0; i < ch.length; i++) {
      const x = ch[i];
      if (this.snipOn) { const w = this.seen % this.ringSize; for (let c = 0; c < chans.length; c++) this.rings[c][w] = chans[c][i]; }
      const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
      this.seen++;
      this.x2 = this.x1; this.x1 = x; this.y2 = this.y1; this.y1 = y;
      if (this.n === 0) { this.winStart = base + i; this.winSample = this.seen - 1; }
      this.acc += y * y;
      const ay = y < 0 ? -y : y;
      if (ay > this.winPeak) this.winPeak = ay;
      this.levelAcc += y * y; this.levelN++;
      if (++this.n >= this.win) {
        const e = this.acc / this.n;
        const recent = (this.prevE[0] + this.prevE[1] + this.prevE[2]) / 3;
        const loud = e > this.floor * this.k && e > this.minEnergy;
        const c = this.cand;
        if (c) {
          // Follow the candidate to its peak; accept if it peaked quickly.
          if (e > c.peak) {
            c.peak = e; c.peakAmp = Math.max(c.peakAmp, this.winPeak);
            if (++c.rise > this.riseMax) { this.cand = null; this.hold = true; }
          } else {
            c.peakAmp = Math.max(c.peakAmp, this.winPeak);
            this.lastOnset = c.frame;
            if (this.snipOn) this.snips.push({ sample: c.sample, until: c.sample + this.snipPost });
            this.port.postMessage({ type: 'onset', frame: c.frame, sample: c.sample, ratio: c.peak / c.floor, peak: c.peakAmp, energy: c.peak });
            this.cand = null;
          }
        } else if (this.hold) {
          if (!loud) this.hold = false;
        } else if (this.seen >= this.warmup && loud && e > recent * this.sharp &&
                   this.winStart - this.lastOnset >= this.refractory) {
          this.cand = { frame: this.winStart, sample: this.winSample, peak: e, peakAmp: this.winPeak, floor: this.floor, rise: 0 };
        }
        // Update the floor slowly; clamp spikes so a tap doesn't drag it up too far.
        // During warm-up adapt fast so the first real sound isn't compared to silence.
        const warm = this.seen < this.warmup;
        const a = warm ? 0.3 : this.floorAlpha;
        const target = warm ? e : Math.min(e, this.floor * 4);
        this.floor += a * (target - this.floor);
        if (this.floor < 1e-9) this.floor = 1e-9;
        this.prevE[2] = this.prevE[1]; this.prevE[1] = this.prevE[0]; this.prevE[0] = e;
        this.acc = 0; this.n = 0; this.winPeak = 0;
      }
    }
    while (this.snips.length && this.seen >= this.snips[0].until) {
      const s = this.snips.shift(), len = this.snipPre + this.snipPost, from = s.sample - this.snipPre;
      const channels = this.rings.slice(0, chans.length).map((ring) => {
        const out = new Float32Array(len);
        for (let j = 0; j < len; j++) out[j] = ring[(from + j + this.ringSize * 4) % this.ringSize];
        return out;
      });
      this.port.postMessage({ type: 'snippet', sample: s.sample, pre: this.snipPre, channels }, channels.map((c) => c.buffer));
    }
    this.levelCount += ch.length;
    if (this.levelCount >= this.levelEvery) {
      this.port.postMessage({ type: 'level', rms: Math.sqrt(this.levelAcc / Math.max(1, this.levelN)), floor: Math.sqrt(this.floor), seen: this.seen });
      this.levelCount = 0; this.levelAcc = 0; this.levelN = 0;
    }
    return true;
  }
}

registerProcessor('onset-processor', OnsetProcessor);
