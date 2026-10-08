# SENTINEL

**Through-wall human sensing with an approach advisory.**

SENTINEL detects people through walls using ordinary WiFi signals — no camera, no
light, no device on the subject — estimates their respiration, infers what they
are *doing* from how they breathe and move, and turns that into the one judgement
an operator on the other side of the wall actually needs:

> **is this a defensible moment to approach?**

The physical sensing is WiFi channel state information (CSI) from ESP32-S3 nodes,
processed by the [RuView](https://github.com/ruvnet/RuView) sensing server.
Everything above that — independent respiration estimation, subject tracking,
behavioural-state inference and the approach advisory — is this project.

```
ESP32-S3 nodes ──UDP:5005──▶ RuView sensing server ──WS /ws/sensing──▶ SENTINEL backend ──WS──▶ console
   (CSI)                      (presence, field, vitals)                (FastAPI :8010)          (Next.js)
```

---

## What it produces

| Output | How |
|---|---|
| **Subject detection & localisation** | Signal-field peak, or the upstream pose model when it returns keypoints |
| **Occupancy point cloud** | The measured signal field, rendered as a live 3-D voxel cloud that moves with the subject |
| **Respiration rate + waveform** | Our own DSP chain over CSI amplitude — band-pass, periodogram, breath-interval extraction |
| **Heart rate** | Cardiac band of the same signal, under a stricter evidence gate; reported as unknown when it cannot be supported |
| **Behavioural state** | HMM over respiration rate, breath-to-breath variability and motion: `ASLEEP · RESTING · ALERT_STILL · ACTIVE · DISTRESSED` |
| **Approach advisory** | `APPROACH · CAUTION · HOLD · DO NOT APPROACH · INSUFFICIENT EVIDENCE`, each with its reason codes |

The advisory is the research contribution. The physiological claim behind it:
respiration rate and *breath-to-breath variability* both fall in sleep and rise
with arousal, and variability separates a sleeping subject from an awake one
holding still — which body motion alone cannot do. See
[`docs/assessment-model.md`](docs/assessment-model.md).

### Measured performance

Reference scenarios, full pipeline, scored against ground truth
(`python scripts/evaluate_model.py --all`):

| Scenario | State accuracy | Median detection latency | False APPROACH |
|---|---|---|---|
| patrol (all states) | 0.788 | 13.3 s | **0 / 1936** |
| sleep | 0.897 | 0.0 s | **0 / 3571** |
| wake (subject rouses) | 0.876 | 18.5 s | **0 / 1226** |
| two-person | 0.725 | 19.4 s | **0** (none issued) |
| distress | 0.911 | 7.9 s | **0** (none issued) |
| clear (empty room) | — | — | 0 false tracks |

*False APPROACH* — a green light issued while the subject was in fact alert,
moving or in distress — is the metric that must be zero, and is zero across every
scenario. Accuracy is deliberately the harder number: `RESTING` vs `ALERT_STILL`
is the confusion that remains, and it is the physically hard one.

These figures come from the reference **simulation**, not from a physical
deployment. They validate the estimator chain and the decision logic; they are
not a claim about a real room. See [`docs/evaluation.md`](docs/evaluation.md) for
the protocol, and run `scripts/calibrate_states.py` to refit on a real site.

---

## Doing the hardware build

**[`NEXT-STEPS.md`](NEXT-STEPS.md) is the runbook** — every remaining step from
here to a measured result, in order, with exit tests: access point, Jetson host,
flashing and provisioning the three nodes, placement, first-light verification,
the data-collection protocol, calibration, and what to claim in the write-up.

Node firmware and host setup live in [`hardware/`](hardware/).

## Run it

Three processes. Nothing needs hardware to start.

```bash
# 1. sensing source — simulator (emits the real RuView wire format)
backend/.venv/bin/python scripts/ruview_sim.py --scenario patrol --loop

# 2. backend
cd backend && uv venv && uv pip install -e '.[dev]'
RUVIEW_URL=http://localhost:3300 .venv/bin/uvicorn sentinel.main:app --port 8010

# 3. console
cd frontend && npm install && npm run dev      # http://localhost:3000
```

On Windows use `backend\.venv\Scripts\python.exe`. The simulator defaults to port
3001 (matching the RuView Docker image); pass `--port 3300` and point
`RUVIEW_URL` at it if 3000/3001 are occupied, as above.

Scenarios: `patrol` (every state), `sleep`, `wake`, `two-person`, `distress`,
`clear`. Simulated frames are labelled `source: simulate`, and the console shows
a standing banner saying so — synthetic output is never presented as measurement.

### With real hardware

```bash
# RuView sensing server (Docker; serves HTTP on 3000, sensing WS on 3001)
docker run -p 3000:3000 -p 3001:3001 ruvnet/wifi-densepose:latest

RUVIEW_URL=http://localhost:3000 .venv/bin/uvicorn sentinel.main:app --port 8010
```

Flash and place the ESP32-S3 nodes per
[`docs/deployment.md`](docs/deployment.md). Set the real room dimensions in
`backend/sentinel/config/default.yaml` — the console draws the deployment from
them.

### Full stack in Docker

```bash
docker compose -f docker/docker-compose.yml up --build      # console on :3000
docker compose -f docker/docker-compose.yml --profile sim up --build   # with the simulator
```

---

## Tests and evaluation

```bash
cd backend && .venv/bin/python -m pytest              # 97 tests
.venv/bin/python -m pytest -m "not slow"              # skip the end-to-end model regressions

python scripts/evaluate_model.py --all                # full model report
python scripts/fit_reference_model.py                 # regenerate the shipped model
python scripts/calibrate_states.py --db backend/data/sentinel.db   # fit on real labelled data
```

The test suite asserts the safety properties directly, not just accuracy: weak
evidence never permits approach, escalation is immediate, de-escalation requires
dwell, and a second subject in the volume withdraws the green light.

---

## The console

Six screens, keyboard `1`–`6`, `F` for fullscreen.

- **Operations** — the 3-D sensing volume, the advisory, the roster, live events.
- **Subjects** — every track in full, including the feature vector that produced
  its state and which features were dropped for want of evidence.
- **Vitals** — the respiration waveform at size, both independent rate estimates
  plotted against each other, and the variability features.
- **RF / Nodes** — per-node link health, CSI amplitude profiles, a scaled plan
  view of the deployment.
- **Session Log** — the recorded session and its exports.
- **System** — model provenance, advisory thresholds, diagnostics, and the
  **ground-truth labelling control** used to calibrate the state model.

---

## Repository map

| Path | What lives there |
|---|---|
| `backend/sentinel/core/dsp.py` | Dependency-free DSP: biquad, Goertzel periodogram, peak picking |
| `backend/sentinel/core/vitals.py` | Respiration / cardiac estimation, motion index, evidence gates |
| `backend/sentinel/core/assessment.py` | Behavioural-state HMM and the approach policy |
| `backend/sentinel/core/tracks.py` | Subject tracking and vitals attribution |
| `backend/sentinel/core/pipeline.py` | Sensing frames → console channels |
| `backend/sentinel/sensors/ruview_rf.py` | The only code that knows the upstream wire format |
| `backend/sentinel/simulation/` | Physics-based scenario simulator with ground truth |
| `backend/sentinel/evaluation.py` | Scoring used by both the CLI and the regression tests |
| `frontend/src/components/VolumeScene.tsx` | The 3-D volume (three.js) |
| `frontend/src/app/` | The six console screens |
| `docs/` | Architecture, the model specification, evaluation protocol, deployment |
| `hardware/esp32-csi-node/` | ESP32-S3 CSI firmware, provisioning and UDP probe tools |
| `hardware/jetson/` | Host setup script, systemd units, first-light check |
| `NEXT-STEPS.md` | The ordered hardware runbook |

Adding a sensing modality (radar, camera, mmWave) means one module under
`sensors/` and one registry line; the analysis and the console are modality-neutral.

---

## Honesty rules this codebase follows

These are enforced in code and asserted in tests, because on a system that tells
a soldier when to walk through a door, a plausible-looking wrong number is worse
than no number:

1. **A value that was not measured renders as `--`, never as `0`.**
2. **Synthetic or stale data carries a standing banner.** The source is on screen
   at all times, and a change of source raises an event.
3. **Weak evidence never permits.** It can still warn: a high-arousal reading with
   low confidence yields a restriction, not silence.
4. **Every claim carries its provenance** — which estimator, what confidence, and
   for a position, whether it came from a pose model or a field peak.
5. **No skeleton is drawn from a pose model that is not producing keypoints.**

---

## Status

Research prototype. Not for operational use. The advisory is decision support
under a stated model, not a clearance to act.
