// Mic setup, onset worklet bridge, and audio-clock → performance.now() mapping.

export async function startMic(ctx, { onOnset, onLevel }) {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      channelCount: 1,
    },
  });
  const track = stream.getAudioTracks()[0];
  const settings = track.getSettings ? track.getSettings() : {};
  const processingOn = ['echoCancellation', 'noiseSuppression', 'autoGainControl']
    .filter((k) => settings[k] === true);

  await ctx.audioWorklet.addModule(new URL('./onset-worklet.js', import.meta.url));
  const src = ctx.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(ctx, 'onset-processor', { numberOfInputs: 1, numberOfOutputs: 0 });
  src.connect(node);

  // Timestamps come from the worklet's own sample counter, anchored to performance.now()
  // by the least-delayed message seen recently. This does not trust the AudioContext
  // clock, which was seen freezing for seconds on an Android phone while input kept flowing.
  const clock = new SampleClock(ctx.sampleRate);
  node.port.onmessage = (e) => {
    const d = e.data;
    if (d.type === 'level') {
      clock.anchor(d.seen, performance.now());
      onLevel && onLevel(d);
    } else if (d.type === 'onset') {
      clock.anchor(d.sample, performance.now());
      onOnset({ t: clock.toPerf(d.sample), ratio: d.ratio, peak: d.peak, ctxFrame: d.frame });
    }
  };

  return {
    stream, track, settings, processingOn,
    setSensitivity(k) { node.port.postMessage({ k }); },
    stop() { stream.getTracks().forEach((t) => t.stop()); src.disconnect(); },
  };
}

// Maps an input sample index to the performance.now() clock (ms). Each message gives
// perf ≥ true time of its sample (it can only arrive late), so the smallest
// (perf − sample time) over a sliding window is the best estimate of the offset.
// Any constant input latency left over is absorbed by the calibration L.
export class SampleClock {
  constructor(sampleRate, windowMs = 4000) { this.fs = sampleRate; this.windowMs = windowMs; this.anchors = []; }
  anchor(sample, perf) {
    const off = perf - (sample / this.fs) * 1000;
    // A restarted counter (new worklet) or a big jump invalidates old anchors.
    if (this.anchors.length && Math.abs(off - this.offset()) > 1000) this.anchors.length = 0;
    this.anchors.push({ perf, off });
    while (this.anchors.length && perf - this.anchors[0].perf > this.windowMs) this.anchors.shift();
  }
  offset() { return this.anchors.reduce((m, a) => Math.min(m, a.off), Infinity); }
  toPerf(sample) { return (sample / this.fs) * 1000 + this.offset(); }
}
