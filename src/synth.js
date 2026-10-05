// Small polyphonic synth: oscillator(s) → low-pass → ADSR gain. 8 voices, oldest stolen.

export const PRESETS = {
  piano:   { name: 'Soft piano', waves: [['triangle', 1, 0.7], ['sine', 2, 0.25], ['sine', 3, 0.08]], cutoff: 3200, a: 0.006, d: 0.9, s: 0.0, r: 0.25 },
  marimba: { name: 'Marimba',    waves: [['sine', 1, 0.9], ['sine', 3.98, 0.18]], cutoff: 5000, a: 0.004, d: 0.45, s: 0.0, r: 0.12 },
  pluck:   { name: 'Pluck',      waves: [['sawtooth', 1, 0.35], ['square', 0.5, 0.12]], cutoff: 1800, a: 0.005, d: 0.35, s: 0.0, r: 0.1 },
  organ:   { name: 'Organ',      waves: [['sine', 1, 0.6], ['sine', 2, 0.3], ['sine', 4, 0.15]], cutoff: 4000, a: 0.02, d: 0.1, s: 0.8, r: 0.15, hold: 0.35 },
};

export class Synth {
  constructor(ctx, { voices = 8 } = {}) {
    this.ctx = ctx;
    this.max = voices;
    this.active = [];
    this.preset = 'piano';
    this.out = ctx.createGain();
    this.out.gain.value = 0.6;
    const comp = ctx.createDynamicsCompressor();
    this.out.connect(comp).connect(ctx.destination);
    this.starts = [];       // recent note starts (performance.now() ms), for the self-trigger gate
  }

  play(midi, velocity = 0.8) {
    const ctx = this.ctx, p = PRESETS[this.preset];
    const t = ctx.currentTime;
    while (this.active.length >= this.max) this.kill(this.active.shift(), t);
    const f = 440 * Math.pow(2, (midi - 69) / 12);
    const env = ctx.createGain();
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = p.cutoff * (0.6 + 0.6 * velocity);
    env.gain.setValueAtTime(0, t);
    const peak = 0.25 * velocity;
    env.gain.linearRampToValueAtTime(peak, t + p.a);
    const hold = p.hold || 0;
    env.gain.setTargetAtTime(peak * p.s, t + p.a, p.d / 3);
    const end = t + p.a + (p.s > 0 ? hold : p.d * 1.5);
    env.gain.setTargetAtTime(0, end, p.r / 3);
    lp.connect(env).connect(this.out);
    const oscs = p.waves.map(([type, mul, g]) => {
      const o = ctx.createOscillator();
      o.type = type; o.frequency.value = f * mul;
      const og = ctx.createGain(); og.gain.value = g;
      o.connect(og).connect(lp);
      o.start(t); o.stop(end + p.r * 2);
      return o;
    });
    const v = { oscs, env, stopAt: end + p.r * 2 };
    oscs[0].onended = () => { env.disconnect(); this.active = this.active.filter((x) => x !== v); };
    this.active.push(v);
    this.starts.push(performance.now());
    if (this.starts.length > 16) this.starts.shift();
    return this.starts[this.starts.length - 1];
  }

  kill(v, t) {
    v.env.gain.cancelScheduledValues(t);
    v.env.gain.setTargetAtTime(0, t, 0.01);
    v.oscs.forEach((o) => { try { o.stop(t + 0.05); } catch (_) {} });
  }

  // True if a mic onset at tMs (performance.now() clock) is probably our own note coming
  // back through the speaker. rttMs: measured speaker→mic round trip, or null (unknown →
  // allow outputLatency + gate after each note).
  isSelf(tMs, gateMs, rttMs = null) {
    const out = (this.ctx.outputLatency || this.ctx.baseLatency || 0.02) * 1000;
    const lo = rttMs != null ? rttMs - 25 : -10;
    const hi = (rttMs != null ? rttMs : out) + gateMs;
    return this.starts.some((s) => tMs >= s + lo && tMs <= s + hi);
  }
}
