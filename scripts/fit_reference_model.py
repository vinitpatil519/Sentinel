"""Fit the shipped state model on the reference simulation, reproducibly.

The emission parameters the backend loads by default are not hand-tuned numbers
typed into a source file — they are fitted, by this script, from the reference
scenarios in ``sentinel.simulation``, and written to
``backend/sentinel/config/state_model.yaml`` with a provenance string the
console displays. Re-running this command regenerates them exactly.

    python scripts/fit_reference_model.py

What this model is, and is not
------------------------------
It is a defensible *starting point*: the feature distributions this estimator
chain produces for each behavioural state, under a physics simulation whose
respiration and motion parameters were chosen independently of the estimator.
It is **not** a model of any real room. Multipath, node placement, subject build
and posture all shift these distributions. A deployment refits from labelled
recordings of its own site with ``scripts/calibrate_states.py``; this file is
what it starts from and what it is compared against.

Standard deviations are floored (``SD_FLOOR``) so a state that happens to be
narrowly sampled in simulation cannot ship as an over-confident Gaussian that
dominates the posterior on a slightly different real distribution.
"""

from __future__ import annotations

import argparse
import asyncio
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))

# Windows consoles default to a legacy code page that cannot encode the box and
# arrow characters used in scenario descriptions and reports; without this a
# perfectly healthy run dies on its first print().
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
sys.stderr.reconfigure(encoding="utf-8", errors="replace")


import yaml  # noqa: E402

from sentinel.core.assessment import (  # noqa: E402
    FEATURES,
    STATES,
    FeatureVector,
    default_params,
    fit_state_params,
    params_to_dict,
)
from sentinel.core.pipeline import Pipeline  # noqa: E402
from sentinel.core.telemetry import TelemetryHub  # noqa: E402
from sentinel.core.tracks import TrackGeometry  # noqa: E402
from sentinel.sensors.ruview_rf import RuViewRF  # noqa: E402
from sentinel.simulation import Simulator, build_scenario  # noqa: E402

#: Scenarios used for the fit. "clear" contributes no labelled subject frames
#: and is exercised by the evaluation instead.
FIT_SCENARIOS = ("patrol", "sleep", "wake", "two-person", "distress")
#: Frames before this are discarded: the estimator windows are still filling.
WARMUP_S = 75.0
#: Minimum standard deviation per feature, in that feature's own units.
SD_FLOOR = {
    "respiration_bpm": 1.8,
    "rrv_cv": 0.045,
    "motion_index": 3.0,
    "burst_rate": 0.6,
    "amplitude_cv": 0.09,
}


async def collect(scenario_name: str, seed: int) -> list[tuple[str, FeatureVector]]:
    scenario = build_scenario(scenario_name)
    sim = Simulator(scenario, fs=10.0, seed=seed)
    adapter = RuViewRF(url="http://sim.local")
    pipeline = Pipeline(TelemetryHub(), geometry=TrackGeometry(extent=scenario.extent))
    out: list[tuple[str, FeatureVector]] = []

    for frame in sim.run():
        truth = frame.get("_ground_truth", {})
        normalised = adapter.normalize(frame)
        assert normalised is not None
        await pipeline.process(normalised)
        summary = pipeline.last_tracks
        if not summary or truth.get("t", 0.0) < WARMUP_S:
            continue
        subjects = truth.get("subjects", [])
        tracks = summary["tracks"]
        taken: set[int] = set()
        for subj in subjects:
            best_i, best_d = None, 2.5
            for i, tr in enumerate(tracks):
                if i in taken:
                    continue
                d = sum((a - b) ** 2 for a, b in zip(subj["position"], tr["position"])) ** 0.5
                if d < best_d:
                    best_i, best_d = i, d
            if best_i is None:
                continue
            taken.add(best_i)
            f = tracks[best_i].get("features") or {}
            out.append((subj["state"], FeatureVector(
                respiration_bpm=f.get("respiration_bpm"),
                rrv_cv=f.get("rrv_cv"),
                motion_index=f.get("motion_index"),
                burst_rate=f.get("burst_rate"),
                amplitude_cv=f.get("amplitude_cv"),
                irregular=bool(f.get("irregular")),
                evidence=float(f.get("evidence") or 0.0),
            )))
    return out


async def main_async(args: argparse.Namespace) -> int:
    samples: list[tuple[str, FeatureVector]] = []
    for name in FIT_SCENARIOS:
        got = await collect(name, args.seed)
        print(f"{name:<12} {len(got):>6} labelled frames")
        samples.extend(got)

    counts = Counter(label for label, _ in samples)
    print(f"\ntotal {len(samples)} frames")
    for st in STATES:
        print(f"  {st.value.ljust(12)} {counts.get(st.value, 0):>6}")

    fitted = fit_state_params(samples, prior=default_params(), prior_weight=args.prior_weight)
    for st in STATES:
        for name, g in fitted[st].emissions.items():
            g.sd = max(g.sd, SD_FLOOR.get(name, 0.01))

    print("\nfitted emissions")
    for st in STATES:
        parts = [f"{f}={fitted[st].emissions[f].mean:7.3f}+-{fitted[st].emissions[f].sd:5.3f}"
                 for f in FEATURES if f in fitted[st].emissions]
        print(f"  {st.value.ljust(12)} " + "  ".join(parts))

    payload = params_to_dict(fitted)
    payload["provenance"] = (
        f"fitted from the reference simulation ({', '.join(FIT_SCENARIOS)}; "
        f"{len(samples)} frames, seed {args.seed}) by scripts/fit_reference_model.py "
        f"- not calibrated to any physical site"
    )
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(yaml.safe_dump(payload, sort_keys=False), encoding="utf-8")
    print(f"\nwrote {out}")
    return 0


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--out", default="backend/sentinel/config/state_model.yaml")
    p.add_argument("--seed", type=int, default=7)
    p.add_argument("--prior-weight", type=float, default=200.0,
                   help="weight of the literature-shaped prior, in samples")
    raise SystemExit(asyncio.run(main_async(p.parse_args())))


if __name__ == "__main__":
    main()
