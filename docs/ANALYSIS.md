# Mirror Piano — engineering analysis

What the simulator and tests found, what was changed, and what still needs a real phone.

## Findings from simulation (`test/sim.js`, `test/replay.js`)

| Finding | Effect | Fix |
| --- | --- | --- |
| Knock on the table with resting hands played notes | False notes | Strike must show **both** downward speed and real downward travel (`minDrop`) |
| Noisy landmarks produced false chords (25 / 300 taps) | Extra notes | Jitter-resistant travel measure; chord members need their own downstroke |
| Old latency calibration was 50+ ms off | Wrong key choice | Calibrate from interpolated landing time; now within 4–15 ms, always on the low (safe) side |
| Accuracy is asymmetric in L: too low is harmless, >20 ms too high collapses it | — | Calibration errs low by design |
| Waiting for frames 30 ms after the tap blew the latency budget | +30 ms | Decide at the tap frame (`waitAfterTap = 0`); accuracy unchanged |
| Music with soft attacks triggered onsets | False notes | Rise-time check: taps peak within 6 ms, swells don't |
| First sound after start always fired (floor learned from silence) | False note | 300 ms warm-up |

## Latency: the honest budget

Time to sound ≈ max(mic path, **camera lag**) + audio output latency. The camera path
(capture → landmarks) is typically 50–100 ms on phones, so the plan's ≤100 ms end-to-end
target is likely only reachable on fast devices / 60 fps cameras. Simulated decision time:
~55 ms at 40 ms camera lag, ~97 ms at 80 ms (before output latency). The debug overlay
now shows live `camLag` and the measured speaker→mic `rtt` so this can be checked per device.

## Robustness fixes found by review

- An exception in the frame callback stopped the render/track loop forever → loop re-arms first; errors are logged.
- Placement could complete instantly when hands re-entered → hold timer resets correctly; pose checks (level, flat, apart) with hints.
- Camera resolution drop broke the keyboard → quad rescales; aspect change (rotation) asks for re-placement.
- Hands swapping slots produced huge fake velocities → tracks restart on teleport.
- Self-trigger gate assumed a round trip; Android often 80–150 ms → loopback measurement at calibration.
- Specific messages for denied permission, busy camera, insecure context, missing APIs; corrupt storage tolerated.
- New source file missing from the offline cache → test now enforces the precache list.

## Needs a real phone (cannot be simulated)

Real landmark noise and occlusion (thumb, fingers hidden from the front), true camera lag,
OS audio processing ignoring the "off" constraints, surfaces (glass, tablecloth), lighting,
thermal throttling, iOS Safari. Use Settings → Debug overlay + Accuracy test + Export session log,
and tune `FUSION` in `src/fusion.js` from the exported logs.

## Tests

`npm test` — 50 unit/integration tests (keyboard geometry, tracking, fusion accuracy on simulated
sessions, calibration, onset detector on synthetic audio, synth gate, PWA/offline invariants).
`npm run test:browser` — Chromium with fake camera/mic: start flow, restore, corrupt storage, offline, denied permissions.

## Alternative approaches (after the first on-device test)

The camera mode is limited by physics, not tuning: a front camera sees millimetres of
fingertip travel at 15–30 fps with fingers hiding each other, and the key (camera) and
timing (mic) must be joined across a ~145 ms calibrated offset.

| Approach | Key from | Timing from | Latency | Setup | Verdict |
| --- | --- | --- | --- | --- | --- |
| Mirror (front camera) | hand landmarks | mic onset | camera lag (100–150 ms) | phone on a stand | finicky; kept as a mode |
| **Tap Table** (built) | how the tap sounds at each spot (k-NN on spectra, 2-mic differences) | mic onset | ~25 ms + output | phone flat, train ~6 taps/spot | most promising; self-measures accuracy |
| Top-down camera + printed sheet | fingertip x/y over sheet | mic onset | camera lag | stand above the table | good geometry, awkward setup |
| 2-mic delay only | which mic hears it first | mic | ~25 ms | phone flat | 1-D, few phones expose 2 mics |
| Phone motion sensors | — | — | — | — | browser gives ~60 Hz: too slow |

Tap Table findings from simulation (`test/tap.test.js`): spectra must ignore loudness and
finger softness (envelope removed, only fine resonance structure kept); per-dimension
standardisation amplified noise and was dropped. With the phone in the *middle* of the row,
mirror-image spots can sound alike to one mic, so the setup guide puts the phone at one end.
Whether real tables separate spots well enough is unknown until tried: the app's self-test
score after training answers that in ~2 minutes.
