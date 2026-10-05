// Tap Table: the phone lies on the table; taps are located by how they sound.
import { startMic, BUILD } from './audio-in.js?v=202610052230';
import { tapFeatures, loudness } from './tap/features.js?v=202610052230';
import { TapClassifier } from './tap/classifier.js?v=202610052230';
import { Synth, PRESETS } from './synth.js?v=202610052230';
import { SCALES, noteName } from './keyboard.js?v=202610052230';

const $ = (id) => document.getElementById(id);
const STORE = 'tap-table-v1';
const PER_KEY = 6;           // training taps per spot
const TRAIN_GAP_MS = 250;    // ignore bounces while training
const PLAY_GAP_MS = 90;      // ignore bounces while playing (same tap ringing twice)

const saved = load();
const state = {
  count: saved.count || 6, scale: SCALES[saved.scale] ? saved.scale : 'pentatonic', octave: saved.octave || 4,
  instrument: PRESETS[saved.instrument] ? saved.instrument : 'marimba', sensitivity: saved.sensitivity || 6,
  reject: saved.reject ?? true,
};
let clf = TapClassifier.from(saved.classifier);
let ctx, synth, mic;
let mode = 'idle';          // idle | train | play
let trainKey = 0;
let lastTap = -Infinity;
let test = null;
let heard = 0, snipped = 0;
const STALE_MSG = 'Your browser is running an outdated copy of the app. Close this tab completely and open the link again.';
const log = [];

$('count').value = String(state.count);
$('build').textContent = `build ${BUILD}`;

$('go').addEventListener('click', async () => {
  const status = $('status');
  if (!window.isSecureContext || !navigator.mediaDevices) { status.textContent = 'Needs a secure (https://) page with microphone access.'; return; }
  $('go').disabled = true;
  try {
    state.count = +$('count').value;
    ctx = new AudioContext({ latencyHint: 'interactive' });
    await ctx.resume();
    synth = new Synth(ctx);
    synth.preset = state.instrument;
    mic = await startMic(ctx, {
      channels: 2, onSnippet, onLevel,
      onStale: () => toast(STALE_MSG, 10000),
      onOnset: () => {
        heard++;
        $('heard').textContent = `heard ${heard}`;
        // Every heard tap should produce a snippet within ~40 ms; if not, files are mismatched.
        const before = snipped;
        setTimeout(() => { if (snipped === before && heard > 2) toast(STALE_MSG, 10000); }, 600);
      },
    });
    mic.setSensitivity(state.sensitivity);
    const ch = mic.settings.channelCount || 1;
    $('mics').textContent = ch >= 2 ? '2 mics — best accuracy' : '1 mic';
    if (mic.processingOn.length) toast(`This browser kept ${mic.processingOn.join(', ')} on — results may suffer.`, 6000);
    $('setup').hidden = true; $('stage').hidden = false;
    setupSettings();
    // Saved training only fits if the spot count matches and the phone hasn't moved.
    state.channels = ch;
    if (saved.channels === ch && clf.keys.length === state.count && clf.keys.every((k, i) => k === i && clf.count(k) >= 3)) { showScore(); enterPlay(); toast('Loaded your saved spots. If the phone moved, tap “Retrain all”.', 4000); }
    else startTraining();
    try { await navigator.wakeLock?.request('screen'); } catch (_) {}
  } catch (err) {
    status.textContent = err && err.name === 'NotAllowedError' ? 'Microphone permission was denied. Allow it in site settings and try again.' : `Couldn't start: ${err.message || err}`;
    $('go').disabled = false;
  }
});

// ---------- Keys ----------
function midi(i) { const st = SCALES[state.scale].steps; return 12 * (state.octave + 1) + st[i % st.length] + 12 * Math.floor(i / st.length); }
function renderKeys() {
  $('keys').innerHTML = '';
  for (let i = 0; i < state.count; i++) {
    const b = document.createElement('div');
    b.className = 'key' + (clf.count(i) < 3 ? ' untrained' : '') + (mode === 'train' && i === trainKey ? ' current' : '') + (test && test.target === i ? ' target' : '');
    b.innerHTML = `${i + 1}<small>${noteName(midi(i))}</small>`;
    b.id = 'key' + i;
    $('keys').appendChild(b);
  }
}
function flashKey(i, cls) {
  const el = $('key' + i); if (!el) return;
  el.classList.add(cls); setTimeout(() => el.classList.remove(cls), 160);
}

// ---------- Training ----------
function startTraining(from = 0) {
  mode = 'train';
  if (from === 0) clf = new TapClassifier();
  trainKey = from;
  $('redoBtn').hidden = false;
  $('score').hidden = true;
  nextTrainPrompt();
}
function nextTrainPrompt() {
  renderKeys();
  const n = clf.count(trainKey);
  prompt(`Tap spot ${trainKey + 1} — ${PER_KEY - n} more time${PER_KEY - n === 1 ? '' : 's'}. Vary your finger a little.`);
  $('dots').innerHTML = Array.from({ length: PER_KEY }, (_, i) => `<i class="${i < n ? 'on' : ''}"></i>`).join('');
}
function trainTap(f) {
  clf.add(trainKey, f);
  if (clf.count(trainKey) >= PER_KEY) {
    trainKey++;
    if (trainKey >= state.count) { save(); showScore(); enterPlay(); return; }
  }
  nextTrainPrompt();
}
$('redoBtn').addEventListener('click', () => { if (mode === 'train') { clf.removeKey(trainKey); nextTrainPrompt(); } });
$('trainBtn').addEventListener('click', () => { setTest(false); startTraining(0); });

function showScore() {
  const ev = clf.evaluate();
  if (!ev) return;
  const pct = Math.round(ev.acc * 100);
  $('score').hidden = false;
  $('score').textContent = `Self-test ${pct}%`;
  // Worst confusion, so the user knows which spots to move apart.
  let worst = null;
  for (const [k, row] of Object.entries(ev.confusion)) for (const [p, n] of Object.entries(row)) if (p !== k && (!worst || n > worst.n)) worst = { k: +k, p: +p, n };
  const hint = pct >= 90 ? 'Great — play away.' : pct >= 75 ? 'Usable.' : 'Weak: move the spots further apart, or put the phone at the end of the row, then retrain.';
  addLog(`self-test ${pct}% (${ev.ok}/${ev.n})${worst ? ` · most confused: spot ${worst.k + 1} → ${worst.p + 1}` : ''}`);
  toast(`Self-test: ${pct}%. ${hint}`, 5000);
}

// ---------- Play ----------
function enterPlay() {
  mode = 'play';
  $('redoBtn').hidden = true;
  $('dots').innerHTML = '';
  prompt(test ? 'Tap the yellow spot.' : 'Play! Tap your spots.');
  renderKeys();
}

function onSnippet(sn) {
  snipped++;
  if (synth.isSelf(sn.t, 80)) return addLog('ignored: own note');
  const gap = sn.t - lastTap;
  if (gap < (mode === 'train' ? TRAIN_GAP_MS : PLAY_GAP_MS)) return;
  lastTap = sn.t;
  const f = tapFeatures(sn);
  if (mode === 'train') return trainTap(f);
  if (mode !== 'play') return;
  const p = clf.predict(f);
  const lag = performance.now() - sn.t;
  record({ type: 'tap', key: p && p.key, confidence: p && p.confidence, distance: p && p.distance, unknown: p && p.unknown, lag, target: test && test.target });
  if (!p || (state.reject && p.unknown)) { addLog(`no match (distance ${p ? p.distance.toFixed(1) : '—'})`); return; }
  const vel = Math.max(0.3, Math.min(1, 0.3 + Math.log10(1 + 40 * loudness(sn)) * 0.5));
  synth.play(midi(p.key), vel);
  flashKey(p.key, test && p.key !== test.target ? 'miss' : 'hit');
  addLog(`spot ${p.key + 1} · ${Math.round(p.confidence * 100)}% · ${Math.round(lag)} ms`);
  if (test) testResult(p.key);
}

// ---------- Accuracy test ----------
function setTest(on) {
  test = on ? { n: 0, ok: 0, target: 0, confusion: {} } : null;
  $('testBtn').textContent = on ? 'Stop test' : 'Accuracy test';
  if (on) nextTarget(); else renderKeys();
  if (mode === 'play') prompt(on ? 'Tap the yellow spot.' : 'Play! Tap your spots.');
}
function nextTarget() { test.target = Math.floor(Math.random() * state.count); renderKeys(); }
function testResult(got) {
  test.n++; if (got === test.target) test.ok++;
  const row = (test.confusion[test.target] ||= {}); row[got] = (row[got] || 0) + 1;
  $('score').hidden = false;
  $('score').textContent = `Test ${test.ok}/${test.n} (${Math.round((100 * test.ok) / test.n)}%)`;
  setTimeout(nextTarget, 200);
}
$('testBtn').addEventListener('click', () => { if (mode === 'play') setTest(!test); });

// ---------- Settings ----------
function setupSettings() {
  $('instrument').innerHTML = Object.entries(PRESETS).map(([k, p]) => `<option value="${k}">${p.name}</option>`).join('');
  $('scale').innerHTML = Object.entries(SCALES).map(([k, s]) => `<option value="${k}">${s.name}</option>`).join('');
  $('instrument').value = state.instrument; $('scale').value = state.scale;
  $('sens').value = state.sensitivity; $('reject').checked = state.reject;
}
$('instrument').addEventListener('change', (e) => { state.instrument = synth.preset = e.target.value; save(); });
$('scale').addEventListener('change', (e) => { state.scale = e.target.value; save(); renderKeys(); });
$('sens').addEventListener('input', (e) => { state.sensitivity = +e.target.value; mic && mic.setSensitivity(state.sensitivity); save(); });
$('reject').addEventListener('change', (e) => { state.reject = e.target.checked; save(); });
$('exportBtn').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify({ meta: { ua: navigator.userAgent, mic: mic && mic.settings, state, selfTest: clf.evaluate(), test }, log }, null, 1)], { type: 'application/json' });
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `tap-table-${Date.now()}.json` });
  document.body.appendChild(a); a.click(); a.remove();
});

// ---------- Helpers ----------
function onLevel(d) {
  const pct = Math.max(0, Math.min(1, (20 * Math.log10(Math.max(1e-5, d.rms)) + 80) / 80)) * 100;
  $('meterBar').style.width = pct + '%';
}
function prompt(t) { $('prompt').textContent = t; }
function addLog(line) { const el = $('log'); el.textContent = (line + '\n' + el.textContent).split('\n').slice(0, 8).join('\n'); }
function record(e) { log.push({ t: Math.round(performance.now()), ...e }); if (log.length > 20000) log.shift(); }
let toastTimer;
function toast(t, ms = 4000) { const el = $('toast'); el.textContent = t; el.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => (el.hidden = true), ms); }
function load() { try { return JSON.parse(localStorage.getItem(STORE)) || {}; } catch (_) { return {}; } }
function save() { try { localStorage.setItem(STORE, JSON.stringify({ ...state, classifier: clf.toJSON() })); } catch (_) {} }

if ('serviceWorker' in navigator && window.isSecureContext) navigator.serviceWorker.register('./sw.js').catch(() => {});
