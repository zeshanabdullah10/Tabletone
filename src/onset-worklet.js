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
    this.levelEvery = Math.round(fs / 30);
    this.levelCount = 0; this.levelAcc = 0; this.levelN = 0;

    this.port.onmessage = (e) => {
      const d = e.data;
      if (d.k != null) this.k = d.k;
      if (d.minEnergy != null) this.minEnergy = d.minEnergy;
    };
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    const base = currentFrame;
    for (let i = 0; i < ch.length; i++) {
      const x = ch[i];
      const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
      this.x2 = this.x1; this.x1 = x; this.y2 = this.y1; this.y1 = y;
      if (this.n === 0) this.winStart = base + i;
      this.acc += y * y;
      const ay = y < 0 ? -y : y;
      if (ay > this.winPeak) this.winPeak = ay;
      this.levelAcc += y * y; this.levelN++;
      if (++this.n >= this.win) {
        const e = this.acc / this.n;
        if (e > this.floor * this.k && e > this.minEnergy &&
            this.winStart - this.lastOnset >= this.refractory) {
          this.lastOnset = this.winStart;
          this.port.postMessage({ type: 'onset', frame: this.winStart, ratio: e / this.floor, peak: this.winPeak, energy: e });
        }
        // Update the floor slowly; clamp spikes so a tap doesn't drag it up too far.
        const target = Math.min(e, this.floor * 4);
        this.floor += this.floorAlpha * (target - this.floor);
        if (this.floor < 1e-9) this.floor = 1e-9;
        this.acc = 0; this.n = 0; this.winPeak = 0;
      }
    }
    this.levelCount += ch.length;
    if (this.levelCount >= this.levelEvery) {
      this.port.postMessage({ type: 'level', rms: Math.sqrt(this.levelAcc / Math.max(1, this.levelN)), floor: Math.sqrt(this.floor) });
      this.levelCount = 0; this.levelAcc = 0; this.levelN = 0;
    }
    return true;
  }
}

registerProcessor('onset-processor', OnsetProcessor);
