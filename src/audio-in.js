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

  node.port.onmessage = (e) => {
    const d = e.data;
    if (d.type === 'onset') {
      const ctxTime = d.frame / ctx.sampleRate;
      onOnset({ ctxTime, t: ctxToPerf(ctx, ctxTime), ratio: d.ratio, peak: d.peak });
    } else if (d.type === 'level') {
      onLevel && onLevel(d);
    }
  };

  return {
    stream, track, settings, processingOn,
    setSensitivity(k) { node.port.postMessage({ k }); },
    stop() { stream.getTracks().forEach((t) => t.stop()); src.disconnect(); },
  };
}

// Map an AudioContext time (s) to the performance.now() clock (ms).
// Any constant error left over is absorbed by the latency calibration L.
export function ctxToPerf(ctx, ctxTime) {
  const ts = ctx.getOutputTimestamp ? ctx.getOutputTimestamp() : null;
  if (ts && ts.performanceTime) {
    return ts.performanceTime + (ctxTime - ts.contextTime) * 1000;
  }
  return performance.now() - (ctx.currentTime - ctxTime) * 1000;
}
