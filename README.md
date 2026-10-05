# Mirror Piano

Turn any bare table into a piano. Stand your phone up facing you: the front camera shows you like a mirror with a virtual keyboard drawn on the table, and you play by tapping the real table. The camera decides **which** key (fingertip position), the microphone decides **when** (the tap sound).

Static PWA, no build step, runs entirely in the browser. Primary target: Chrome on Android; iOS Safari is best effort.

## Using it

1. Open the site (HTTPS) and press **Start** — this unlocks camera, microphone and audio.
2. **Place:** lay both hands flat where the keyboard should go and hold still for ~1 s. The keyboard grows between your hands.
3. **Calibrate:** tap the middle key 10 times at a steady pace; this measures the latency offset *L* between the mic and camera clocks. You can skip it and redo it later from Settings.
4. **Play.** Settings (⚙︎) has instrument, scale, octave, tap sensitivity, self-trigger gate, vision-only mode for soft surfaces, fill light, the debug overlay, an accuracy test and session-log export.

Headphones are recommended: the phone's own speaker can trigger the tap detector.

## How it works

| Module | Role |
| --- | --- |
| `src/camera.js` | Front camera, `requestVideoFrameCallback` frame times on the `performance.now()` clock |
| `src/hands.js` | MediaPipe HandLandmarker (GPU, CPU fallback); per-fingertip 500 ms tracks with downward velocity (in hand-scales/s) and velocity relative to the other fingers |
| `src/keyboard.js` | Two-hand span gesture → perspective quad; inverse-bilinear fingertip → key; scale presets |
| `src/onset-worklet.js` | AudioWorklet: 100 Hz high-pass, 2 ms energy vs ~200 ms noise floor, ×k threshold, 40 ms refractory |
| `src/audio-in.js` | Raw mic (echo cancellation / noise suppression / AGC off, verified with `getSettings()`), audio clock → `performance.now()` |
| `src/fusion.js` | Scores fingertips in [t_tap − 100 ms, t_tap + 50 ms]: downstroke, relative downstroke, stillness after, landmark z. Chords, vision-only stop detector, latency estimate |
| `src/synth.js` | 8-voice oscillator + filter + envelope synth, presets, self-trigger gate |
| `src/render.js` | Mirrored video, keys in perspective, hover/press glow, fingertip dots |
| `src/debug.js` | Overlay (fps, inference time, onset log) and JSON session log export |

MediaPipe `@mediapipe/tasks-vision` **1.0.1** and the float16 hand landmarker model are vendored in `vendor/mediapipe/` and `models/` so the service worker can cache them for offline play.

## Deploy

Settings → Pages → *Deploy from a branch* → `main` / root. All paths are relative, so the site works under `/<repo-name>/`. Bump `VERSION` in `sw.js` on each release so installed copies update.

## Local development

Camera and mic need a secure context. Serve the folder (e.g. `python3 -m http.server 8000`), then on the phone use Chrome's `chrome://inspect` → *Port forwarding* to `localhost:8000`, which counts as secure. Turn on the debug overlay while tuning.

## Status vs. plan milestones

- M0–M4 core: implemented (camera + landmarks, mic onsets, span placement + corner drag, vision-only play, audio-triggered fusion, self-trigger gate, latency calibration, chords, velocity, press animation, debug overlay, session log, accuracy test).
- M6 basics: manifest, offline service worker, icons.
- Not yet: M5 extras (black keys, falling notes, drum/marimba layouts, printed-sheet mode). All thresholds are first guesses and need on-device tuning against the success criteria.
