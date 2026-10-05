// Screens, state, and the glue between camera, mic, fusion and sound.
import { startCamera, onFrames } from './camera.js';
import { createHandTracker } from './hands.js';
import { Keyboard, SCALES } from './keyboard.js';
import { Renderer } from './render.js';
import { startMic } from './audio-in.js';
import { scoreTap, pickKeys, StopDetector, estimateLatency, FUSION } from './fusion.js';
import { Synth, PRESETS } from './synth.js';
import { Debug } from './debug.js';

const $ = (id) => document.getElementById(id);
const STORE = 'mirror-piano-v1';

const settings = {
  instrument: 'piano', sensitivity: 6, gateMs: 60, visionOnly: false,
  fillLight: false, debug: false, L: 0, calibrated: false, keyboard: null,
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
let place = null;                // span-gesture state
let calib = null;                // latency calibration state
let test = null;                 // accuracy test state
let lowRes = false, slowSince = 0;
let wakeLock = null;

// ---------- Start ----------
$('startBtn').addEventListener('click', async () => {
  const status = $('startStatus');
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
    status.textContent = `Couldn't start: ${err.message || err}. Camera and microphone access are both needed.`;
    $('startBtn').disabled = false;
  }
});

// ---------- Per-frame loop ----------
function frame(t) {
  hands = tracker.process(video, t, kb.quad ? (x, y) => kb.keyAt(x, y) : null);
  debug.frame(t);
  watchFrameRate(t);

  if (mode === 'place') stepPlace(t);
  const stops = stopDet.update(tracker.tracks);
  if (mode === 'calibrate') for (const s of stops) calib.stops.push(s.t);
  if (mode === 'play' && settings.visionOnly) {
    for (const s of stops) if (s.key != null) {
      const vel = clamp(0.3 + s.down / 15, 0.3, 1);
      playKeys([s.key], vel);
      afterNote({ keys: [s.key], via: 'vision', lag: performance.now() - s.t, best: { score: 0, down: s.down } });
    }
  }
  resolvePending();

  renderer.showHandles = mode === 'adjust';
  renderer.draw({ hands, keyboard: kb, placing: place && place.quad ? place : null });
  debug.render({
    infer: tracker.inferMs.toFixed(1) + 'ms', hands: hands.length, L: Math.round(settings.L),
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
  if (m === 'place') {
    place = { hold: 0, quad: null, prev: null, progress: 0 };
    prompt('Lay both hands flat on the table where the keyboard should go, and hold still.');
  } else if (m === 'calibrate') {
    calib = { onsets: [], stops: [], started: performance.now() };
    prompt(`Latency check: tap the ${kb.label(Math.floor(kb.count / 2))} key 10 times at a steady pace.`);
  } else if (m === 'adjust') {
    prompt('Drag the yellow corners to line the keys up with the table.');
  } else if (m === 'play') {
    prompt('');
    if (test) nextTarget();
  }
}

function stepPlace(t) {
  if (hands.length !== 2) { place.hold = 0; place.quad = null; place.progress = 0; return; }
  const [l, r] = hands;
  const q = Keyboard.quadFromHands(l, r);
  const W = video.videoWidth;
  const moved = place.prev ? Math.max(...['nl', 'nr', 'fr', 'fl'].map((k) => Math.hypot(q[k].x - place.prev[k].x, q[k].y - place.prev[k].y))) : Infinity;
  place.prev = q;
  if (moved > W * 0.015 || q.nr.x - q.nl.x < W * 0.15) { place.hold = t; }
  // Smooth while holding.
  place.quad = place.quad && moved < W * 0.015 ? blendQuad(place.quad, q, 0.2) : q;
  place.progress = clamp((t - place.hold) / 1000, 0, 1);
  if (place.progress >= 1) {
    kb.quad = place.quad;
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
  const self = synth.isSelf(o.ctxTime, settings.gateMs);
  debug.record('onset', { tOnset: o.t, ratio: o.ratio, peak: o.peak, self });
  flashMeter();
  if (self) return;
  if (mode === 'calibrate') return calibOnset(o);
  if (mode !== 'play' || settings.visionOnly || !kb.quad) return;
  pending.push({ ...o, tTap: o.t - settings.L, received: performance.now() });
  resolvePending();
  if (pending.length) setTimeout(resolvePending, 40);
}

function resolvePending() {
  const now = performance.now();
  while (pending.length) {
    const o = pending[0];
    // Wait until the camera has caught up to the tap moment (+ a little), but not forever.
    const ready = tracker.latestTime() >= o.tTap + Math.min(FUSION.post, 30) || now - o.received > 120;
    if (!ready) { setTimeout(resolvePending, 10); return; }
    pending.shift();
    const cands = scoreTap(tracker.tracks, o.tTap);
    const keys = pickKeys(cands);
    if (!keys.length) { debug.record('drop', { reason: cands.length ? 'no key' : 'no finger moving down', tTap: o.tTap }); continue; }
    const vel = clamp(0.35 + 0.65 * Math.log10(Math.max(1, o.ratio / settings.sensitivity)) / 1.5, 0.35, 1);
    playKeys(keys, vel);
    afterNote({ keys, via: 'audio', lag: performance.now() - o.t, best: cands[0], cands: cands.slice(0, 4), ratio: o.ratio });
  }
}

function playKeys(keys, vel) {
  for (const k of keys) { synth.play(kb.midi(k), vel); renderer.press(k, vel); }
}

function afterNote(info) {
  debug.record('note', info);
  if (test) testResult(info.keys[0]);
}

// ---------- Latency calibration ----------
function calibOnset(o) {
  calib.onsets.push(o.t);
  prompt(`Latency check: ${calib.onsets.length} / 10 taps`);
  if (calib.onsets.length >= 10) {
    // Give the camera a moment to deliver the last stops.
    setTimeout(() => {
      if (!calib) return;
      const r = estimateLatency(calib.onsets, calib.stops);
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
  if (lum < 45 && !settings.fillLight) toast('It looks dark — turn on a lamp or the screen-edge fill light in Settings.', 3000);
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

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}

// ---------- Helpers ----------
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
