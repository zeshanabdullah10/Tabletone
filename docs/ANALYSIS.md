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
