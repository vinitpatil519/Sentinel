"""Offline evaluation of the behavioural-state model and approach advisory.

Replays a scenario through the *real* pipeline — the same adapter normaliser,
the same estimator chain, the same HMM and policy the live system runs — and
scores the output against the ground truth that generated it. Lives in the
package rather than in the script so the regression tests measure exactly what
``scripts/evaluate_model.py`` reports.

Metrics
-------
* **Per-state precision / recall / F1** and the confusion matrix, over frames
  after the warm-up window (the estimator windows must fill before any claim is
  defensible; scoring before that measures nothing).
* **Transition latency** — seconds from a ground-truth state change to the model
  reporting it. The operationally important number for "the subject just woke".
* **Advisory safety** — two rates over frames where the subject was truly
  ALERT_STILL, ACTIVE or DISTRESSED: *false-APPROACH* (a green light, which must
  be zero) and the softer *false-permissive* (APPROACH or CAUTION). A missed
  approach opportunity is an inconvenience; a false permission is not.
* **Detection** — detection rate against occupied frames, and false tracks
  against an empty volume.
"""

from __future__ import annotations

from sentinel.config.settings import load_settings
from sentinel.core.assessment import STATES, ModelConfig, PolicyConfig
from sentinel.core.pipeline import Pipeline
from sentinel.core.telemetry import TelemetryHub
from sentinel.core.tracks import TrackGeometry
from sentinel.sensors.ruview_rf import RuViewRF
from sentinel.simulation import Simulator, build_scenario

#: Seconds of a run ignored before scoring — the respiration window must fill.
WARMUP_S = 75.0
STATE_NAMES = [s.value for s in STATES]
PERMISSIVE = {"APPROACH", "CAUTION"}
HIGH_AROUSAL = {"ALERT_STILL", "ACTIVE", "DISTRESSED"}


async def run_scenario(
    name: str, seed: int = 7, rate: float = 10.0, use_defaults: bool = False,
    seconds: float | None = None,
) -> dict:
    """Replay one scenario through the pipeline as the backend actually runs it.

    By default this evaluates the *shipped* configuration — the fitted model in
    ``config/state_model.yaml`` and the advisory thresholds in ``default.yaml`` —
    so the reported numbers describe the system under test, not a variant of it.
    ``use_defaults`` evaluates the built-in literature-shaped parameters instead,
    which is how the value of fitting is measured. ``seconds`` truncates the run
    (regression tests use a short slice; a full report does not).
    """
    scenario = build_scenario(name)
    sim = Simulator(scenario, fs=rate, seed=seed)
    adapter = RuViewRF(url="http://sim.local")
    hub = TelemetryHub()
    settings = load_settings()
    pipeline = Pipeline(
        hub,
        geometry=TrackGeometry(extent=scenario.extent),
        model_cfg=ModelConfig() if use_defaults else ModelConfig.from_dict(settings.state_model),
        policy_cfg=PolicyConfig.from_dict(settings.advisory),
        attribution_mode=settings.vitals_attribution,
    )

    records: list[dict] = []
    for frame in sim.run(seconds):
        truth = frame.get("_ground_truth", {})
        normalised = adapter.normalize(frame)
        assert normalised is not None, "adapter failed to recognise its own wire format"
        await pipeline.process(normalised)
        summary = pipeline.last_tracks
        if not summary:
            continue
        subjects = truth.get("subjects", [])
        records.append({
            "t": truth.get("t", 0.0),
            "truth": subjects,
            "tracks": summary["tracks"],
        })
    return {"scenario": scenario, "records": records, "sim": sim}


def _assign(truth_subjects: list[dict], tracks: list[dict]) -> list[tuple[dict, dict]]:
    """Greedy nearest-position assignment of ground-truth subjects to tracks.

    Multi-subject scenarios are scored per subject, so a run with one sleeping
    and one active person exercises attribution rather than being skipped.
    """
    pairs: list[tuple[dict, dict]] = []
    taken: set[int] = set()
    for subj in truth_subjects:
        best_i, best_d = None, 2.5
        for i, tr in enumerate(tracks):
            if i in taken:
                continue
            d = sum((a - b) ** 2 for a, b in zip(subj["position"], tr["position"])) ** 0.5
            if d < best_d:
                best_i, best_d = i, d
        if best_i is not None:
            taken.add(best_i)
            pairs.append((subj, tracks[best_i]))
    return pairs


def score(scenario_name: str, records: list[dict]) -> dict:
    """Score every ground-truth subject in every frame after the warm-up."""
    confusion = {a: {b: 0 for b in STATE_NAMES} for a in STATE_NAMES}
    unknown = 0
    scored = 0
    permissive_violations = 0
    permissive_total = 0
    approach_total = 0
    approach_violations = 0
    latencies: list[dict] = []
    pending: dict[str, dict] = {}
    prev_truth: dict[str, str] = {}
    detection_frames = 0
    presence_frames = 0
    false_track_frames = 0

    for rec in records:
        truth_subjects = rec["truth"]
        tracks = rec["tracks"]
        if truth_subjects:
            presence_frames += 1
            if tracks:
                detection_frames += 1
        elif tracks:
            false_track_frames += 1

        for subj, tr in _assign(truth_subjects, tracks):
            name = subj["name"]
            truth_state = subj["state"]
            predicted = (tr.get("state") or {}).get("state")
            decision = (tr.get("advisory") or {}).get("decision")

            if truth_state != prev_truth.get(name):
                if name in pending:
                    latencies.append({**pending[name], "latency_s": None})  # never reached
                pending[name] = {
                    "subject": name, "from": prev_truth.get(name),
                    "to": truth_state, "t": rec["t"],
                }
                prev_truth[name] = truth_state

            if name in pending and predicted == pending[name]["to"]:
                entry = pending.pop(name)
                latencies.append({**entry, "latency_s": round(rec["t"] - entry["t"], 2)})

            if rec["t"] < WARMUP_S:
                continue
            scored += 1
            if predicted is None:
                unknown += 1
            elif predicted in confusion.get(truth_state, {}):
                confusion[truth_state][predicted] += 1

            if decision in PERMISSIVE:
                permissive_total += 1
                if truth_state in HIGH_AROUSAL:
                    permissive_violations += 1
            if decision == "APPROACH":
                approach_total += 1
                if truth_state in HIGH_AROUSAL:
                    approach_violations += 1

    per_state = {}
    for st in STATE_NAMES:
        tp = confusion[st][st]
        fn = sum(confusion[st][o] for o in STATE_NAMES if o != st)
        fp = sum(confusion[o][st] for o in STATE_NAMES if o != st)
        support = tp + fn
        precision = tp / (tp + fp) if tp + fp else 0.0
        recall = tp / support if support else 0.0
        f1 = 2 * precision * recall / (precision + recall) if precision + recall else 0.0
        per_state[st] = {
            "support": support,
            "precision": round(precision, 3),
            "recall": round(recall, 3),
            "f1": round(f1, 3),
        }

    correct = sum(confusion[s][s] for s in STATE_NAMES)
    resolved = sum(sum(row.values()) for row in confusion.values())
    return {
        "scenario": scenario_name,
        "frames_scored": scored,
        "accuracy": round(correct / resolved, 3) if resolved else None,
        "unknown_rate": round(unknown / scored, 3) if scored else None,
        "confusion": confusion,
        "per_state": per_state,
        "transition_latency_s": latencies,
        "median_latency_s": _median([d["latency_s"] for d in latencies if d["latency_s"] is not None]),
        "advisory": {
            # APPROACH is the only advisory that actively permits contact; a
            # false APPROACH is the failure with a casualty attached, so it is
            # reported separately from the softer CAUTION.
            "approach_frames": approach_total,
            "false_approach_frames": approach_violations,
            "false_approach_rate": round(approach_violations / approach_total, 4)
            if approach_total else 0.0,
            "permissive_frames": permissive_total,
            "false_permissive_frames": permissive_violations,
            "false_permissive_rate": round(permissive_violations / permissive_total, 4)
            if permissive_total else 0.0,
        },
        "detection": {
            "presence_frames": presence_frames,
            "detected_frames": detection_frames,
            "detection_rate": round(detection_frames / presence_frames, 3) if presence_frames else None,
            "false_track_frames": false_track_frames,
        },
    }


def _median(xs: list[float]) -> float | None:
    if not xs:
        return None
    s = sorted(xs)
    n = len(s)
    return round(s[n // 2] if n % 2 else 0.5 * (s[n // 2 - 1] + s[n // 2]), 2)


