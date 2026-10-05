// Screens, state, and the glue between camera, mic, fusion and sound.
import { startCamera, onFrames } from './camera.js';
import { createHandTracker } from './hands.js';
import { Keyboard, SCALES } from './keyboard.js';
import { Renderer } from './render.js';
import { startMic } from './audio-in.js';
import { scoreTap, pickKeys, StopDetector, Retrigger, fitLatency, FUSION } from './fusion.js';
import { Synth, PRESETS } from './synth.js';
import { Debug } from './debug.js';

const $ = (id) => document.getElementById(id);
const STORE = 'mirror-piano-v1';

const settings = {
  instrument: 'piano', sensitivity: 6, gateMs: 60, visionOnly: false,
  fillLight: false, debug: false, L: 0, calibrated: false, keyboard: null, rtt: null,
  ...load(),
};

const kb = new Keyboard();
kb.load(settings.keyboard);
const video = $('video');
const renderer = new Renderer($('view'), video);
const debug = new Debug($('debug'));
debug.on = settings.debug;

let ctx, synth, mic, camera, tracker;
let mode = 'start';              // start | place | calibrate | play | adjust
let hands = [];
const pending = [];              // onsets waiting for camera frames
const stopDet = new StopDetector();
const retrig = new Retrigger();
let pendingTimer = 0;
let frameErrors = 0;
let lastLightWarn = -Infinity;
let loopback = null;             // speaker→mic echo measurement in progress
let camLag = 0;                  // capture → landmarks ready (ms), smoothed
let place = null;                // span-gesture state
let calib = null;                // latency calibration state
let test = null;                 // accuracy test state
let lowRes = false, slowSince = 0;
let wakeLock = null;

// ---------- Start ----------
$('startBtn').addEventListener('click', async () => {
  const status = $('startStatus');
  const missing = unsupported();
  if (missing) { status.textContent = missing; return; }
  $('startBtn').disabled = true;
  try {
    status.textContent = 'Starting audio…';
    ctx = new AudioContext({ latencyHint: 'interactive' });
    await ctx.resume();
    synth = new Synth(ctx);
    synth.preset = settings.instrument;

    status.textContent = 'Opening camera…';
    camera = await startCamera(video);

    status.textContent = 'Opening microphone…';
    mic = await startMic(ctx, { onOnset, onLevel });
    mic.setSensitivity(settings.sensitivity);
    if (mic.processingOn.length) toast(`This browser kept ${mic.processingOn.join(', ')} on — taps may be muffled. Try Chrome on Android.`, 7000);

    status.textContent = 'Loading hand tracker…';
    tracker = await createHandTracker();

    await requestWakeLock();
    $('start').hidden = true;
    $('stage').hidden = false;
    applySettingsUI();
    if (kb.quad) enter(settings.calibrated ? 'play' : 'calibrate'); else enter('place');
    onFrames(video, frame);
    setInterval(checkLight, 2000);
  } catch (err) {
    console.error(err);
    status.textContent = startError(err);
    $('startBtn').disabled = false;
    if (camera) camera.stop();
    if (mic) mic.stop();
    if (ctx) ctx.close().catch(() => {});
    camera = mic = ctx = null;
  }
});

// ---------- Per-frame loop ----------
function frame(t, now) {
  try { step(t); frameErrors = 0; camLag += 0.1 * (performance.now() - t - camLag); }
  catch (err) {
    console.error(err);
    debug.record('error', { message: String(err && err.message || err) });
    if (++frameErrors === 30) toast('Hand tracking keeps failing on this device. Try reloading the page.', 8000);
  }
}

function step(t) {
  const fit = kb.fit(video.videoWidth, video.videoHeight);
  if (fit === 'invalid') { saveKeyboard(); toast('The camera view changed shape. Place the keyboard again.', 4000); enter('place'); }
  hands = tracker.process(video, t, kb.quad ? (x, y) => kb.keyAt(x, y) : null);
  debug.frame(t);
  watchFrameRate(t);

  if (mode === 'place') stepPlace(t);
  const stops = stopDet.update(tracker.tracks);
  if (mode === 'play' && settings.visionOnly) {
    for (const s of stops) if (s.key != null) {
      const vel = clamp(0.3 + s.down / 15, 0.3, 1);
      const keys = playKeys([s.key], vel, s.t);
      if (keys.length) afterNote({ keys, via: 'vision', lag: performance.now() - s.t, best: { score: 0, down: s.down } });
    }
  }
  resolvePending();

  renderer.showHandles = mode === 'adjust';
  renderer.draw({ hands, keyboard: kb, placing: place && place.quad ? place : null });
  debug.render({
    infer: tracker.inferMs.toFixed(1) + 'ms', camLag: Math.round(camLag) + 'ms', rtt: settings.rtt == null ? '—' : Math.round(settings.rtt), hands: hands.length, L: Math.round(settings.L),
    res: `${video.videoWidth}x${video.videoHeight}`, mode, k: settings.sensitivity,
  });
}

function watchFrameRate(t) {
  if (lowRes || debug.frames.length < 2 || !hands.length) { slowSince = 0; return; }
  if (debug.fps < 20) {
    if (!slowSince) slowSince = t;
    else if (t - slowSince > 3000) { lowRes = true; camera.setResolution(640, 480); toast('Lowered camera resolution to keep tracking smooth.'); }
  } else slowSince = 0;
}

// ---------- Placement: two-hand span gesture ----------
function enter(m) {
  mode = m;
  $('skipBtn').hidden = m !== 'calibrate';
  $('doneAdjustBtn').hidden = m !== 'adjust';
  place = null; calib = null;
  tracker.store.historyMs = m === 'calibrate' ? 30000 : 600;   // calibration needs the whole session
  if (m === 'place') {
    place = { hold: 0, quad: null, prev: null, progress: 0 };
    prompt('Lay both hands flat on the table where the keyboard should go, and hold still.');
  } else if (m === 'calibrate') {
    calib = { onsets: [], started: performance.now(), ready: false };
    prompt('Keep your hands still — measuring the speaker echo…');
    measureLoopback().then(() => {
      if (!calib) return;
      calib.ready = true;
      prompt(`Latency check: tap the ${kb.label(Math.floor(kb.count / 2))} key 10 times at a steady pace.`);
    });
  } else if (m === 'adjust') {
    prompt('Drag the yellow corners to line the keys up with the table.');
  } else if (m === 'play') {
    prompt('');
    if (test) nextTarget();
  }
}

const SPAN_HINTS = {
  level: 'Put both hands flat on the table at the same height.',
  flat: 'Stretch your fingers out flat on the table.',
  apart: 'Spread your hands further apart — that sets the keyboard width.',
};
function stepPlace(t) {
  const resetHold = (msg) => { place.hold = t; place.prev = null; place.quad = null; place.progress = 0; prompt(msg); };
  if (hands.length !== 2) return resetHold(hands.length ? 'Both hands please — lay them flat at the ends of the keyboard.' : 'Lay both hands flat on the table where the keyboard should go, and hold still.');
  const [l, r] = hands;
  const W = video.videoWidth, H = video.videoHeight;
  const pose = Keyboard.isSpanPose(l, r, W, H);
  if (pose !== 'ok') return resetHold(SPAN_HINTS[pose]);
  prompt('Hold still…');
  const q = Keyboard.quadFromHands(l, r);
  const moved = place.prev ? Math.max(...['nl', 'nr', 'fr', 'fl'].map((k) => Math.hypot(q[k].x - place.prev[k].x, q[k].y - place.prev[k].y))) : Infinity;
  place.prev = q;
  if (moved > W * 0.015 || q.nr.x - q.nl.x < W * 0.15) { place.hold = t; }
  // Smooth while holding.
  place.quad = place.quad && moved < W * 0.015 ? blendQuad(place.quad, q, 0.2) : q;
  place.progress = clamp((t - place.hold) / 1000, 0, 1);
  if (place.progress >= 1) {
    kb.setQuad(place.quad, W, H);
    saveKeyboard();
    debug.record('place', { quad: kb.quad });
    toast('Keyboard placed. Lift your hands.', 2000);
    enter(settings.calibrated ? 'play' : 'calibrate');
  }
}
const blendQuad = (a, b, w) => Object.fromEntries(Object.keys(a).map((k) => [k, { x: a[k].x + (b[k].x - a[k].x) * w, y: a[k].y + (b[k].y - a[k].y) * w }]));

// ---------- Corner dragging (fine-tune) ----------
const view = $('view');
view.addEventListener('pointerdown', (e) => {
  if (mode !== 'adjust' || !kb.quad) return;
  const p = renderer.toCanvas(e.clientX, e.clientY);
  let best = null, bd = 48 / p.s;
  for (const [k, q] of kb.corners()) { const d = Math.hypot(q.x - p.x, q.y - p.y); if (d < bd) { bd = d; best = k; } }
  if (best) { renderer.dragging = best; view.setPointerCapture(e.pointerId); }
});
view.addEventListener('pointermove', (e) => {
  if (!renderer.dragging) return;
  const p = renderer.toCanvas(e.clientX, e.clientY);
  kb.quad[renderer.dragging] = { x: p.x, y: p.y };
});
view.addEventListener('pointerup', () => { if (renderer.dragging) { renderer.dragging = null; saveKeyboard(); } });
$('doneAdjustBtn').addEventListener('click', () => enter('play'));
$('skipBtn').addEventListener('click', () => { settings.calibrated = true; save(); enter('play'); });

// ---------- Audio onsets → fusion ----------
function onOnset(o) {
  if (loopback) { loopback.onsets.push(o.ctxTime); return; }
  const self = synth.isSelf(o.ctxTime, settings.gateMs, settings.rtt);
  debug.record('onset', { tOnset: o.t, ratio: o.ratio, peak: o.peak, self });
  flashMeter();
  if (self) return;
  if (mode === 'calibrate') return calibOnset(o);
  if (mode !== 'play' || settings.visionOnly || !kb.quad) return;
  pending.push({ ...o, tTap: o.t - settings.L, received: performance.now() });
  resolvePending();
}

function resolvePending() {
  const now = performance.now();
  while (pending.length) {
    const o = pending[0];
    // Wait until the camera has caught up to the tap moment (+ a little), but not forever.
    const ready = tracker.latestTime() >= o.tTap + FUSION.waitAfterTap || now - o.received > FUSION.maxWait;
    if (!ready) {
      if (!pendingTimer) pendingTimer = setTimeout(() => { pendingTimer = 0; resolvePending(); }, 10);
      return;
    }
    pending.shift();
    const cands = scoreTap(tracker.tracks, o.tTap);
    const keys = pickKeys(cands);
    if (!keys.length) { debug.record('drop', { reason: cands.length ? 'no key' : 'no finger moving down', tTap: o.tTap }); continue; }
    const vel = clamp(0.35 + 0.65 * Math.log10(Math.max(1, o.ratio / settings.sensitivity)) / 1.5, 0.35, 1);
    const played = playKeys(keys, vel, o.tTap);
    if (!played.length) { debug.record('drop', { reason: 'retrigger', keys }); continue; }
    afterNote({ keys: played, via: 'audio', lag: performance.now() - o.t, best: cands[0], cands: cands.slice(0, 4), ratio: o.ratio });
  }
}

function playKeys(keys, vel, t) {
  const ok = retrig.filter(keys, t);
  for (const k of ok) { synth.play(kb.midi(k), vel); renderer.press(k, vel); }
  return ok;
}

function afterNote(info) {
  debug.record('note', info);
  if (test) testResult(info.keys[0]);
}

// ---------- Latency calibration ----------
function calibOnset(o) {
  if (!calib.ready) return;
  calib.onsets.push(o.t);
  prompt(`Latency check: ${calib.onsets.length} / 10 taps`);
  if (calib.onsets.length >= 10) {
    // Give the camera a moment to deliver the last stops.
    setTimeout(() => {
      if (!calib) return;
      const r = fitLatency(tracker.tracks, calib.onsets);
      if (r) {
        settings.L = r.L; settings.calibrated = true; save();
        debug.record('calibrate', r);
        toast(`Latency offset set to ${Math.round(r.L)} ms (±${Math.round(r.spread)}).`, 3000);
        enter('play');
      } else {
        toast("Couldn't line taps up with finger motion. Tap with one finger, a bit more firmly.", 4000);
        enter('calibrate');
      }
    }, 300);
  }
}

// Plays a few notes and times when the mic hears them: the speaker→mic round trip,
// used to centre the self-trigger gate. No echo heard (headphones) → rtt stays null.
async function measureLoopback() {
  loopback = { starts: [], onsets: [] };
  for (let i = 0; i < 4; i++) {
    loopback.starts.push(synth.play(kb.midi(i * 2 % kb.count), 1));
    await sleep(350);
  }
  await sleep(300);
  const diffs = loopback.starts
    .map((s) => loopback.onsets.find((o) => o >= s && o <= s + 0.3))
    .map((o, i) => (o == null ? null : (o - loopback.starts[i]) * 1000))
    .filter((d) => d != null);
  loopback = null;
  if (diffs.length >= 2) {
    diffs.sort((a, b) => a - b);
    settings.rtt = diffs[diffs.length >> 1];
  } else settings.rtt = null;
  save();
  debug.record('loopback', { diffs, rtt: settings.rtt });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- Accuracy test ----------
function nextTarget() {
  test.target = Math.floor(Math.random() * kb.count);
  test.shown = performance.now();
  renderer.target = test.target;
  clearTimeout(test.timer);
  test.timer = setTimeout(() => { test.miss++; debug.record('test', { target: test.target, got: null }); updateTestStats(); nextTarget(); }, 4000);
}
function testResult(got) {
  if (performance.now() - test.shown < 250) return;   // ignore leftovers from the previous prompt
  test.n++;
  if (got === test.target) test.ok++;
  test.confusion[test.target][got] = (test.confusion[test.target][got] || 0) + 1;
  debug.record('test', { target: test.target, got });
  updateTestStats();
  nextTarget();
}
function updateTestStats() {
  const tot = test.n + test.miss;
  $('testStats').textContent = `✓ ${test.ok}/${test.n} (${test.n ? Math.round(100 * test.ok / test.n) : 0}%) · missed ${test.miss}/${tot}`;
}
function setTest(on) {
  if (test) clearTimeout(test.timer);
  test = on ? { n: 0, ok: 0, miss: 0, confusion: Array.from({ length: kb.count }, () => ({})) } : null;
  $('testStats').hidden = !on;
  renderer.target = null;
  if (on) { updateTestStats(); if (mode === 'play') nextTarget(); }
}

// ---------- Level meter ----------
let meterHitUntil = 0;
function onLevel(d) {
  const db = (x) => 20 * Math.log10(Math.max(1e-5, x));
  const pct = (x) => clamp((db(x) + 80) / 80, 0, 1) * 100;
  $('meterBar').style.width = pct(d.rms) + '%';
  $('meterBar').classList.toggle('hit', performance.now() < meterHitUntil);
  $('meterThr').style.left = pct(d.floor * Math.sqrt(settings.sensitivity)) + '%';
}
function flashMeter() { meterHitUntil = performance.now() + 150; }

// ---------- Light check ----------
const probe = document.createElement('canvas');
probe.width = 32; probe.height = 18;
function checkLight() {
  if (!video.videoWidth) return;
  const c = probe.getContext('2d', { willReadFrequently: true });
  c.drawImage(video, 0, 0, 32, 18);
  const d = c.getImageData(0, 0, 32, 18).data;
  let s = 0; for (let i = 0; i < d.length; i += 4) s += d[i] + d[i + 1] + d[i + 2];
  const lum = s / (d.length / 4) / 3;
  if (lum < 45 && !settings.fillLight && performance.now() - lastLightWarn > 30000) lastLightWarn = performance.now(), toast('It looks dark — turn on a lamp or the screen-edge fill light in Settings.', 3000);
}

// ---------- Settings UI ----------
function applySettingsUI() {
  const inst = $('instrument'), sc = $('scale');
  inst.innerHTML = Object.entries(PRESETS).map(([k, p]) => `<option value="${k}">${p.name}</option>`).join('');
  sc.innerHTML = Object.entries(SCALES).map(([k, s]) => `<option value="${k}">${s.name}</option>`).join('');
  inst.value = settings.instrument; sc.value = kb.scale;
  $('octave').value = kb.octave;
  $('sens').value = settings.sensitivity; $('sensOut').value = settings.sensitivity;
  $('gate').value = settings.gateMs; $('gateOut').value = settings.gateMs;
  $('visionOnly').checked = settings.visionOnly;
  $('fillLight').checked = settings.fillLight; $('fill').hidden = !settings.fillLight;
  $('debugOn').checked = settings.debug;
  $('testOn').checked = !!test;
  $('latOut').value = settings.calibrated ? Math.round(settings.L) : '—';
}

$('settingsBtn').addEventListener('click', () => { applySettingsUI(); $('settings').showModal(); });
$('instrument').addEventListener('change', (e) => { settings.instrument = synth.preset = e.target.value; save(); synth.play(kb.midi(0), 0.6); });
$('scale').addEventListener('change', (e) => { kb.scale = e.target.value; saveKeyboard(); });
$('octDown').addEventListener('click', () => { kb.octave = Math.max(1, kb.octave - 1); $('octave').value = kb.octave; saveKeyboard(); });
$('octUp').addEventListener('click', () => { kb.octave = Math.min(7, kb.octave + 1); $('octave').value = kb.octave; saveKeyboard(); });
$('sens').addEventListener('input', (e) => { settings.sensitivity = +e.target.value; $('sensOut').value = e.target.value; mic && mic.setSensitivity(settings.sensitivity); save(); });
$('gate').addEventListener('input', (e) => { settings.gateMs = +e.target.value; $('gateOut').value = e.target.value; save(); });
$('visionOnly').addEventListener('change', (e) => { settings.visionOnly = e.target.checked; save(); });
$('fillLight').addEventListener('change', (e) => { settings.fillLight = e.target.checked; $('fill').hidden = !e.target.checked; save(); });
$('debugOn').addEventListener('change', (e) => { settings.debug = debug.on = e.target.checked; save(); });
$('testOn').addEventListener('change', (e) => setTest(e.target.checked));
$('replaceBtn').addEventListener('click', () => { $('settings').close(); enter('place'); });
$('adjustBtn').addEventListener('click', () => { $('settings').close(); if (kb.quad) enter('adjust'); });
$('calibBtn').addEventListener('click', () => { $('settings').close(); if (kb.quad) enter('calibrate'); });
$('exportBtn').addEventListener('click', () => debug.export({
  ua: navigator.userAgent, settings, keyboard: kb.toJSON(), fusion: FUSION,
  video: { w: video.videoWidth, h: video.videoHeight }, mic: mic && mic.settings,
  test: test && { n: test.n, ok: test.ok, miss: test.miss, confusion: test.confusion },
}));

// ---------- Lifecycle ----------
async function requestWakeLock() {
  try { if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen'); } catch (_) {}
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && ctx) { requestWakeLock(); ctx.resume(); if (video.paused) video.play().catch(() => {}); }
});

if ('serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}

// ---------- Helpers ----------
function unsupported() {
  if (!window.isSecureContext) return 'Mirror Piano needs a secure (https://) page for camera and microphone access.';
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return 'This browser has no camera/microphone access. Use Chrome on Android.';
  if (!window.AudioContext || !('audioWorklet' in AudioContext.prototype)) return 'This browser lacks AudioWorklet. Update Chrome or Safari.';
  if (!window.WebAssembly) return 'This browser lacks WebAssembly, which hand tracking needs.';
  return '';
}
function startError(err) {
  const n = err && err.name;
  if (n === 'NotAllowedError' || n === 'SecurityError') return 'Camera or microphone permission was denied. Allow both in the browser’s site settings, then tap Start again.';
  if (n === 'NotFoundError' || n === 'OverconstrainedError') return 'No front camera or microphone found on this device.';
  if (n === 'NotReadableError' || n === 'AbortError') return 'The camera or microphone is busy in another app. Close it and try again.';
  return `Couldn't start: ${(err && err.message) || err}. Check your connection the first time (the hand model is downloaded once).`;
}

function prompt(text) { $('prompt').textContent = text; }
let toastTimer;
function toast(text, ms = 4000) {
  const el = $('toast'); el.textContent = text; el.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (el.hidden = true), ms);
}
function clamp(x, a, b) { return Math.max(a, Math.min(b, x)); }
function load() { try { return JSON.parse(localStorage.getItem(STORE)) || {}; } catch (_) { return {}; } }
function save() { try { localStorage.setItem(STORE, JSON.stringify(settings)); } catch (_) {} }
function saveKeyboard() { settings.keyboard = kb.toJSON(); save(); }
