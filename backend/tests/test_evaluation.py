"""Regression tests on the end-to-end model performance.

These run the real pipeline over short slices of the reference scenarios and
assert the properties that must not silently regress. The thresholds are set
below the measured figures with margin: they catch a break, not a wobble. The
full report — every scenario, full length, confusion matrices — comes from
``python scripts/evaluate_model.py --all``.
"""

from __future__ import annotations

import pytest

from sentinel.evaluation import run_scenario, score

pytestmark = pytest.mark.slow


async def evaluate(name: str, seconds: float) -> dict:
    run = await run_scenario(name, seconds=seconds)
    return score(name, run["records"])


async def test_sleep_is_recognised_and_permits_approach():
    report = await evaluate("sleep", 260)
    assert report["accuracy"] > 0.75
    assert report["advisory"]["approach_frames"] > 0
    assert report["advisory"]["false_approach_rate"] == 0.0


async def test_waking_subject_is_never_cleared_for_approach():
    """The headline safety property, on the scenario built to break it."""
    report = await evaluate("wake", 420)
    assert report["advisory"]["false_approach_frames"] == 0
    assert report["accuracy"] > 0.6


async def test_active_subject_is_detected_quickly():
    report = await evaluate("wake", 420)
    assert report["median_latency_s"] is not None
    assert report["median_latency_s"] < 45.0     # one respiration window


async def test_empty_volume_produces_no_tracks():
    report = await evaluate("clear", 200)
    assert report["detection"]["false_track_frames"] == 0


async def test_distress_is_flagged_and_denied():
    report = await evaluate("distress", 400)
    assert report["advisory"]["false_approach_frames"] == 0
    assert report["per_state"]["DISTRESSED"]["recall"] > 0.4
