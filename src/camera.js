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
    // Halve the resolution while keeping the frame's shape: a portrait phone reports
    // e.g. 720x1280, and asking for 640x480 would change the aspect and invalidate the keyboard.
    async lowerResolution() {
      const s = track.getSettings ? track.getSettings() : {};
      if (!s.width || !s.height) return;
      try {
        await track.applyConstraints({
          width: { ideal: Math.round(s.width / 2) }, height: { ideal: Math.round(s.height / 2) },
          aspectRatio: { exact: s.width / s.height }, facingMode: 'user',
        });
      } catch (_) {}
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
      // Re-arm first so an exception in cb can't stop the loop for good.
      video.requestVideoFrameCallback(step);
      cb(meta.captureTime || meta.presentationTime || now, now);
    };
    video.requestVideoFrameCallback(step);
  } else {
    let lastTime = -1;
    const step = (now) => {
      if (stopped) return;
      requestAnimationFrame(step);
      if (video.currentTime !== lastTime) { lastTime = video.currentTime; cb(now, now); }
    };
    requestAnimationFrame(step);
  }
  return () => { stopped = true; };
}
