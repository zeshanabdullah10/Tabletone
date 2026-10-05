// Front camera with requestVideoFrameCallback; frame times on the performance.now() clock.

export async function startCamera(video, { width = 1280, height = 720 } = {}) {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: 'user', width: { ideal: width }, height: { ideal: height }, frameRate: { ideal: 60 } },
    audio: false,
  });
  video.srcObject = stream;
  video.muted = true;
  video.playsInline = true;
  await video.play();
  const track = stream.getVideoTracks()[0];
  return {
    stream, track,
    async setResolution(w, h) {
      try { await track.applyConstraints({ width: { ideal: w }, height: { ideal: h } }); } catch (_) {}
    },
    stop() { stream.getTracks().forEach((t) => t.stop()); },
  };
}

// Calls cb(t, now) for every new video frame; t is the capture time when known.
export function onFrames(video, cb) {
  let stopped = false;
  if ('requestVideoFrameCallback' in HTMLVideoElement.prototype) {
    const step = (now, meta) => {
      if (stopped) return;
      const t = meta.captureTime || meta.presentationTime || now;
      cb(t, now);
      video.requestVideoFrameCallback(step);
    };
    video.requestVideoFrameCallback(step);
  } else {
    let lastTime = -1;
    const step = (now) => {
      if (stopped) return;
      if (video.currentTime !== lastTime) { lastTime = video.currentTime; cb(now, now); }
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }
  return () => { stopped = true; };
}
