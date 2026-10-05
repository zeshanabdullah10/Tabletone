// Table Mallets: camera points (index fingertips), mic triggers (tap sound).
import { startCamera, onFrames } from './camera.js?v=202610052230';
import { createHandTracker } from './hands.js?v=202610052230';
import { startMic, BUILD } from './audio-in.js?v=202610052230';
import { Synth, PRESETS } from './synth.js?v=202610052230';
import { SCALES, noteName } from './keyboard.js?v=202610052230';
import { keyForX, strikers, readyToDecide, malletId, MALLET } from './mallet.js?v=202610052230';
import { Retrigger } from './fusion.js?v=202610052230';

const $ = (id) => document.getElementById(id);
const STORE = 'table-mallets-v1';
// Onset times are stamped when the mic sample is processed; camera frames when captured.
// The mic path is typically a few tens of ms behind; strikers() tolerates ±100 ms.
const MIC_OFFSET_MS = 40;
const HAND_COLORS = ['#ffb347', '#7fdbff'];

const saved = load();
const state = {
  count: saved.count || 8, scale: SCALES[saved.scale] ? saved.scale : 'major', octave: 4,
  instrument: PRESETS[saved.instrument] ? saved.instrument : 'marimba',
  sensitivity: saved.sensitivity || 6, debug: !!saved.debug,
};
const video = $('video'), canvas = $('view'), g = canvas.getContext('2d');
let ctx, synth, mic, tracker, camera;
const pending = [];
const retrig = new Retrigger(70);
const pressed = new Map();        // key → {t, slot}
const log = [];
let test = null, heard = 0, played = 0, lastDecideMs = 0, camLag = 0;
let pendingTimer = 0;

$('count').value = String(state.count);
$('build').textContent = `build ${BUILD}`;

$('startBtn').addEventListener('click', async () => {
  const status = $('startStatus');
  if (!window.isSecureContext || !navigator.mediaDevices) { status.textContent = 'Needs a secure (https://) page with camera and microphone access.'; return; }
  $('startBtn').disabled = true;
  try {
    state.count = +$('count').value; save();
    status.textContent = 'Starting…';
    ctx = new AudioContext({ latencyHint: 'interactive' });
    await ctx.resume();
    synth = new Synth(ctx); synth.preset = state.instrument;
    camera = await startCamera(video, { width: 960, height: 540 });
    mic = await startMic(ctx, { onOnset, onLevel, onStale: () => toast('Outdated app files — close the tab and reopen the link.', 10000) });
    mic.setSensitivity(state.sensitivity);
    status.textContent = 'Loading hand tracker…';
    tracker = await createHandTracker();
    tracker.store.historyMs = 1200;           // strikers() looks ~700 ms back for the resting height
    $('start').hidden = true; $('stage').hidden = false;
    setupSettings();
    prompt('Point an index finger at a key, then tap the table.');
    setTimeout(() => prompt(''), 5000);
    onFrames(video, frame);
    try { await navigator.wakeLock?.request('screen'); } catch (_) {}
  } catch (err) {
    console.error(err);
    status.textContent = err && err.name === 'NotAllowedError' ? 'Camera or microphone permission was denied. Allow both in site settings, then try again.' : `Couldn't start: ${(err && err.message) || err}`;
    $('startBtn').disabled = false;
  }
});

// ---------- Frames ----------
function frame(t) {
  try {
    tracker.process(video, t, null);
    camLag += 0.1 * (performance.now() - t - camLag);
    resolvePending();
    draw();
  } catch (err) { console.error(err); }
}

// Fingertip cursor for each visible hand: {slot, x, y, key}.
function cursors() {
  const out = [];
  for (const slot of [0, 1]) {
    const tr = tracker.tracks.get(malletId(slot));
    if (!tr || !tr.length || tracker.latestTime() - tr[tr.length - 1].t > 150) continue;
    const s = tr[tr.length - 1];
    out.push({ slot, x: s.x, y: s.y, key: keyForX(s.x, video.videoWidth, state.count) });
  }
  return out;
}

// ---------- Taps ----------
function onOnset(o) {
  heard++;
  if (synth.isSelf(o.t, 80)) { record({ type: 'self', t: o.t }); return; }
  pending.push({ tTap: o.t - MIC_OFFSET_MS, heardAt: performance.now(), ratio: o.ratio });
  resolvePending();
}

function resolvePending() {
  while (pending.length) {
    const o = pending[0], ago = performance.now() - o.heardAt;
    if (!readyToDecide(tracker.tracks, o.tTap, tracker.latestTime(), ago)) {
      if (!pendingTimer) pendingTimer = setTimeout(() => { pendingTimer = 0; resolvePending(); }, 10);
      return;
    }
    pending.shift();
    const hits = strikers(tracker.tracks, o.tTap);
    const keys = [];
    for (const h of hits) { const k = keyForX(h.x, video.videoWidth, state.count); if (k != null && !keys.some((x) => x.k === k)) keys.push({ k, slot: h.slot }); }
    const ok = new Set(retrig.filter(keys.map((x) => x.k), o.tTap));
    const vel = Math.max(0.35, Math.min(1, 0.35 + 0.65 * Math.log10(Math.max(1, o.ratio / state.sensitivity)) / 1.5));
    lastDecideMs = Math.round(ago);
    for (const { k, slot } of keys) if (ok.has(k)) { synth.play(midi(k), vel); pressed.set(k, { t: performance.now(), slot }); played++; }
    record({ type: 'tap', keys: keys.filter((x) => ok.has(x.k)).map((x) => x.k), hits, waitMs: lastDecideMs, target: test && test.target });
    if (test) testResult(keys.length ? keys[0].k : null);
  }
}

function midi(i) { const st = SCALES[state.scale].steps, n = st.length - 1; return 12 * (state.octave + 1) + st[i % n] + 12 * Math.floor(i / n); }

// ---------- Drawing ----------
function draw() {
  const W = video.videoWidth, H = video.videoHeight;
  if (!W) return;
  if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
  g.save(); g.translate(W, 0); g.scale(-1, 1); g.drawImage(video, 0, 0, W, H); g.restore();
  g.fillStyle = 'rgba(0,0,0,0.25)'; g.fillRect(0, 0, W, H);

  const cs = cursors(), now = performance.now();
  const m = MALLET.margin * W, kw = (W - 2 * m) / state.count;
  const top = H * 0.35;
  for (let i = 0; i < state.count; i++) {
    const x = m + i * kw;
    const over = cs.find((c) => c.key === i);
    const p = pressed.get(i), press = p ? Math.max(0, 1 - (now - p.t) / 300) : 0;
    g.fillStyle = test && test.target === i ? 'rgba(255,214,90,0.45)' : over ? 'rgba(255,255,255,0.32)' : 'rgba(255,255,255,0.12)';
    g.fillRect(x + 3, top, kw - 6, H - top - 6);
    if (press > 0) { g.fillStyle = `rgba(110,220,255,${0.75 * press})`; g.fillRect(x + 3, top, kw - 6, H - top - 6); }
    if (over) { g.lineWidth = 6; g.strokeStyle = HAND_COLORS[over.slot]; g.strokeRect(x + 6, top + 3, kw - 12, H - top - 12); }
    g.fillStyle = '#fff'; g.font = `700 ${Math.min(36, kw * 0.32)}px system-ui, sans-serif`; g.textAlign = 'center';
    g.fillText(noteName(midi(i)).replace(/\d+$/, ''), x + kw / 2, H - 24);
  }
  for (const c of cs) {
    g.beginPath(); g.arc(c.x, c.y, Math.max(14, W * 0.018), 0, Math.PI * 2);
    g.fillStyle = HAND_COLORS[c.slot]; g.fill(); g.lineWidth = 3; g.strokeStyle = '#000'; g.stroke();
  }
  $('info').textContent = state.debug
    ? `heard ${heard} · played ${played} · hands ${cs.length} · cam ${Math.round(camLag)}ms · wait ${lastDecideMs}ms`
    : cs.length ? (test ? `Test ${test.ok}/${test.n}` : `played ${played}`) : 'show your hands';
}

// ---------- Accuracy test ----------
function setTest(on) { test = on ? { n: 0, ok: 0, target: Math.floor(Math.random() * state.count), confusion: {} } : null; }
function testResult(got) {
  test.n++; if (got === test.target) test.ok++;
  const row = (test.confusion[test.target] ||= {}); row[got] = (row[got] || 0) + 1;
  test.target = Math.floor(Math.random() * state.count);
}

// ---------- Settings ----------
function setupSettings() {
  $('instrument').innerHTML = Object.entries(PRESETS).map(([k, p]) => `<option value="${k}">${p.name}</option>`).join('');
  $('scale').innerHTML = Object.entries(SCALES).map(([k, s]) => `<option value="${k}">${s.name}</option>`).join('');
  $('instrument').value = state.instrument; $('scale').value = state.scale; $('count2').value = String(state.count);
  $('sens').value = state.sensitivity; $('debugOn').checked = state.debug;
}
$('settingsBtn').addEventListener('click', () => $('settings').showModal());
$('instrument').addEventListener('change', (e) => { state.instrument = synth.preset = e.target.value; save(); });
$('scale').addEventListener('change', (e) => { state.scale = e.target.value; save(); });
$('count2').addEventListener('change', (e) => { state.count = +e.target.value; save(); });
$('sens').addEventListener('input', (e) => { state.sensitivity = +e.target.value; mic && mic.setSensitivity(state.sensitivity); save(); });
$('debugOn').addEventListener('change', (e) => { state.debug = e.target.checked; save(); });
$('testOn').addEventListener('change', (e) => setTest(e.target.checked));
$('exportBtn').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify({ meta: { ua: navigator.userAgent, build: BUILD, state, mic: mic && mic.settings, video: { w: video.videoWidth, h: video.videoHeight }, test }, log }, null, 1)], { type: 'application/json' });
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `table-mallets-${Date.now()}.json` });
  document.body.appendChild(a); a.click(); a.remove();
});

// ---------- Helpers ----------
let meterHit = 0;
function onLevel(d) {
  const pct = Math.max(0, Math.min(1, (20 * Math.log10(Math.max(1e-5, d.rms)) + 80) / 80)) * 100;
  $('meterBar').style.width = pct + '%';
  $('meterBar').classList.toggle('hit', heard !== meterHit && (meterHit = heard, true));
}
function prompt(t) { $('prompt').textContent = t; }
function record(e) { log.push({ at: Math.round(performance.now()), camLag: Math.round(camLag), ...e }); if (log.length > 20000) log.shift(); }
let toastTimer;
function toast(t, ms = 4000) { const el = $('toast'); el.textContent = t; el.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => (el.hidden = true), ms); }
function load() { try { return JSON.parse(localStorage.getItem(STORE)) || {}; } catch (_) { return {}; } }
function save() { try { localStorage.setItem(STORE, JSON.stringify(state)); } catch (_) {} }
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && ctx) ctx.resume(); });
if ('serviceWorker' in navigator && window.isSecureContext) navigator.serviceWorker.register('./sw.js').catch(() => {});
