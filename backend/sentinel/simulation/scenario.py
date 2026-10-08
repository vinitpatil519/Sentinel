"""Physically-structured sensing simulator emitting the upstream wire format.

This is not a mock that replays canned numbers. It simulates the *cause* of the
measurement — chest displacement, body motion, link geometry — and renders it
into exactly the ``SensingUpdate`` payload the RuView sensing server sends, so
the adapter, the pipeline and the console all run their real code paths.

It exists for three jobs:

1. **Development and demonstration** without hardware. Frames are labelled
   ``source: "simulate"``, which the console surfaces as a banner; nothing
   downstream can mistake simulated data for a measurement.
2. **Test fixtures** — deterministic under a seed.
3. **Model evaluation** — every frame carries the ground-truth behavioural state
   that produced it, under ``_ground_truth``. ``scripts/evaluate_model.py``
   replays a scenario through the real pipeline and scores the state model's
   output against those labels (see ``docs/evaluation.md``). The adapter drops
   unknown keys, so the label never leaks into the live path.

Respiration parameters per state follow the same literature the state model is
seeded from — rate and breath-to-breath variability both lowest in sleep,
rising through quiet wakefulness to alert stillness and activity. The simulator
and the model are nevertheless written against *independent* parameterisations
(displacement physics here, spectral features there), so a scenario run is a
real test of the estimator chain rather than a tautology.
"""

from __future__ import annotations

import math
import random
from dataclasses import dataclass, field

# state → (respiration BPM, breath-interval CV, motion-burst rate /min,
#          burst amplitude, chest displacement scale)
STATE_PHYSIOLOGY = {
    "ASLEEP":      (12.0, 0.06, 0.2, 0.35, 1.00),
    "RESTING":     (15.0, 0.16, 1.2, 0.55, 0.85),
    "ALERT_STILL": (17.0, 0.30, 3.0, 0.70, 0.70),
    "ACTIVE":      (21.0, 0.42, 12.0, 1.00, 0.55),
    "DISTRESSED":  (26.0, 0.60, 5.0, 0.90, 0.50),
}

HEART_RATE = {
    "ASLEEP": 54.0, "RESTING": 66.0, "ALERT_STILL": 78.0,
    "ACTIVE": 96.0, "DISTRESSED": 104.0,
}

SUBCARRIERS = 56


@dataclass
class Segment:
    state: str
    duration_s: float


@dataclass
class SubjectScript:
    name: str
    position: tuple[float, float, float]
    segments: list[Segment]
    #: Subjects drift slightly; ACTIVE segments also translate the subject.
    mobile: bool = True


@dataclass
class NodeSpec:
    node_id: int
    position: tuple[float, float, float]


@dataclass
class Scenario:
    name: str
    description: str
    subjects: list[SubjectScript]
    nodes: list[NodeSpec]
    extent: tuple[float, float, float] = (6.0, 2.5, 6.0)
    grid: tuple[int, int, int] = (16, 8, 16)
    duration_s: float = 0.0

    def __post_init__(self) -> None:
        if not self.duration_s:
            self.duration_s = max(
                (sum(s.duration_s for s in sub.segments) for sub in self.subjects),
                default=0.0,
            )


#: Three ESP32-S3 nodes ringing the volume from different angles — the spatial
#: diversity that makes per-subject attribution possible at all.
DEFAULT_NODES = [
    NodeSpec(1, (-2.6, 1.0, -2.6)),
    NodeSpec(2, (2.6, 1.0, -2.2)),
    NodeSpec(3, (0.2, 1.0, 2.8)),
]


def build_scenario(name: str) -> Scenario:
    """Named scenarios covering the operationally interesting cases."""
    if name == "sleep":
        return Scenario(
            name="sleep",
            description="One subject asleep behind the wall, stirring briefly, settling again.",
            subjects=[SubjectScript("subject-a", (1.2, 0.6, 0.4), [
                Segment("ASLEEP", 240), Segment("RESTING", 120),
                Segment("ASLEEP", 240),
            ], mobile=False)],
            nodes=DEFAULT_NODES,
        )
    if name == "wake":
        return Scenario(
            name="wake",
            description="Subject wakes, becomes alert while staying still, then moves.",
            subjects=[SubjectScript("subject-a", (0.8, 0.9, -0.6), [
                Segment("ASLEEP", 180), Segment("RESTING", 120),
                Segment("ALERT_STILL", 120), Segment("ACTIVE", 120),
                Segment("ALERT_STILL", 120),
            ])],
            nodes=DEFAULT_NODES,
        )
    if name == "two-person":
        return Scenario(
            name="two-person",
            description="Two subjects on opposite sides of the volume in different states.",
            subjects=[
                SubjectScript("subject-a", (-1.6, 0.8, -1.2), [
                    Segment("ASLEEP", 200), Segment("RESTING", 140), Segment("ASLEEP", 140),
                ], mobile=False),
                SubjectScript("subject-b", (1.8, 1.0, 1.4), [
                    Segment("ALERT_STILL", 140), Segment("ACTIVE", 140),
                    Segment("RESTING", 100), Segment("ALERT_STILL", 100),
                ]),
            ],
            nodes=DEFAULT_NODES,
        )
    if name == "distress":
        return Scenario(
            name="distress",
            description="Subject deteriorates into irregular, arrested respiration.",
            subjects=[SubjectScript("subject-a", (0.4, 0.7, 0.9), [
                Segment("RESTING", 150), Segment("DISTRESSED", 240), Segment("ACTIVE", 120),
            ], mobile=False)],
            nodes=DEFAULT_NODES,
        )
    if name == "clear":
        return Scenario(
            name="clear",
            description="Empty volume — the baseline every false-positive claim is measured against.",
            subjects=[],
            duration_s=300.0,
            nodes=DEFAULT_NODES,
        )
    # Default: the full patrol sweep, every state in one run.
    return Scenario(
        name="patrol",
        description="Full sweep: sleep → stir → alert → movement → settle, one subject.",
        subjects=[SubjectScript("subject-a", (1.0, 0.8, -0.4), [
            Segment("ASLEEP", 210), Segment("RESTING", 150), Segment("ALERT_STILL", 150),
            Segment("ACTIVE", 120), Segment("RESTING", 120), Segment("ASLEEP", 180),
        ])],
        nodes=DEFAULT_NODES,
    )


SCENARIOS = ("patrol", "sleep", "wake", "two-person", "distress", "clear")


@dataclass
class _SubjectRuntime:
    script: SubjectScript
    index: int
    position: list[float]
    phase: float = 0.0
    interval_s: float = 5.0
    elapsed: float = 0.0
    seg_i: int = 0
    seg_elapsed: float = 0.0
    motion: float = 0.0
    heart_phase: float = 0.0
    breath_count: int = 0
    pause_left: float = 0.0
    history: list[float] = field(default_factory=list)

    @property
    def state(self) -> str:
        segs = self.script.segments
        if not segs:
            return "RESTING"
        return segs[min(self.seg_i, len(segs) - 1)].state


class Simulator:
    """Steps the scenario and renders ``SensingUpdate`` payloads."""

    def __init__(self, scenario: Scenario, fs: float = 10.0, seed: int = 7) -> None:
        self.scenario = scenario
        self.fs = fs
        self.dt = 1.0 / fs
        self.rng = random.Random(seed)
        self.t = 0.0
        self.tick = 0
        self.start_epoch = 1_760_000_000.0  # fixed epoch → deterministic frames
        self.subjects = [
            _SubjectRuntime(script=s, index=i, position=list(s.position))
            for i, s in enumerate(scenario.subjects)
        ]
        for s in self.subjects:
            s.interval_s = 60.0 / STATE_PHYSIOLOGY[s.state][0]
        self._motion_hist: list[float] = []
        self._noise_floor = 0.02

    # -- stepping -----------------------------------------------------------

    def step(self) -> dict:
        self.t += self.dt
        self.tick += 1
        for s in self.subjects:
            self._advance_subject(s)
        return self._render()

    def run(self, seconds: float | None = None):
        """Yield frames for ``seconds`` (default: the scenario's own length)."""
        total = seconds or self.scenario.duration_s
        n = int(total * self.fs)
        for _ in range(n):
            yield self.step()

    # -- subject physics ----------------------------------------------------

    def _advance_subject(self, s: _SubjectRuntime) -> None:
        segs = s.script.segments
        s.seg_elapsed += self.dt
        if segs and s.seg_i < len(segs) - 1 and s.seg_elapsed >= segs[s.seg_i].duration_s:
            s.seg_i += 1
            s.seg_elapsed = 0.0

        bpm, cv, burst_rate, burst_amp, _ = STATE_PHYSIOLOGY[s.state]

        # Respiration: advance the phase; on each completed breath draw the next
        # interval from a lognormal with the state's coefficient of variation.
        # Interval variability *is* the feature the state model separates on, so
        # it is generated here rather than approximated with additive noise.
        if s.pause_left > 0:
            s.pause_left = max(0.0, s.pause_left - self.dt)
        else:
            s.phase += 2 * math.pi * self.dt / max(s.interval_s, 0.5)
            if s.phase >= 2 * math.pi:
                s.phase -= 2 * math.pi
                s.breath_count += 1
                mean_i = 60.0 / bpm
                sigma = math.sqrt(math.log(1 + cv * cv))
                mu = math.log(mean_i) - 0.5 * sigma * sigma
                s.interval_s = min(12.0, max(1.2, self.rng.lognormvariate(mu, sigma)))
                # Irregular respiration in distress: occasional arrested breath.
                if s.state == "DISTRESSED" and self.rng.random() < 0.18:
                    s.pause_left = self.rng.uniform(3.0, 7.0)

        s.heart_phase += 2 * math.pi * self.dt * HEART_RATE[s.state] / 60.0
        if s.heart_phase > 2 * math.pi:
            s.heart_phase -= 2 * math.pi

        # Motion: Poisson bursts with exponential decay; ACTIVE also translates.
        s.motion *= math.exp(-self.dt / 1.6)
        if self.rng.random() < (burst_rate / 60.0) * self.dt:
            s.motion += burst_amp * self.rng.uniform(0.6, 1.4)
        if s.state == "ACTIVE":
            s.motion = max(s.motion, 0.55 + 0.25 * math.sin(self.t * 1.7))
            if s.script.mobile:
                s.position[0] += math.sin(self.t * 0.6) * 0.012
                s.position[2] += math.cos(self.t * 0.43) * 0.010
                for i, lim in ((0, self.scenario.extent[0] / 2 - 0.4),
                               (2, self.scenario.extent[2] / 2 - 0.4)):
                    s.position[i] = max(-lim, min(lim, s.position[i]))

    def _chest(self, s: _SubjectRuntime) -> float:
        scale = STATE_PHYSIOLOGY[s.state][4]
        if s.pause_left > 0:
            return 0.0
        return scale * math.sin(s.phase)

    # -- rendering ----------------------------------------------------------

    def _weights(self, node: NodeSpec) -> list[float]:
        """Per-subject coupling to a node: inverse-square with a near-field floor."""
        out = []
        for s in self.subjects:
            d = math.dist(node.position, tuple(s.position))
            out.append(1.0 / (1.0 + 0.55 * d * d))
        return out

    def _render(self) -> dict:
        nodes, node_features = [], []
        total_motion = 0.0
        for node in self.scenario.nodes:
            w = self._weights(node)
            resp_mod = sum(wi * self._chest(s) for wi, s in zip(w, self.subjects))
            heart_mod = sum(
                wi * 0.035 * math.sin(s.heart_phase) for wi, s in zip(w, self.subjects)
            )
            motion_mod = sum(wi * s.motion for wi, s in zip(w, self.subjects))
            total_motion += motion_mod

            amps = []
            for k in range(SUBCARRIERS):
                # Subcarrier-dependent sensitivity: multipath does not modulate
                # every bin equally, and a flat profile would make the mean
                # amplitude series unrealistically clean.
                sens = 0.6 + 0.4 * math.sin(k * 0.27 + node.node_id)
                base = 18.0 + 2.5 * math.sin(k * 0.19 + node.node_id * 1.3)
                amps.append(round(
                    base
                    + sens * (1.15 * resp_mod + heart_mod + 4.0 * motion_mod)
                    + self.rng.gauss(0.0, self._noise_floor * 6.0),
                    4,
                ))
            rssi = -46.0 - 4.0 * math.dist(node.position, (0.0, 1.0, 0.0)) \
                + 2.0 * motion_mod + self.rng.gauss(0, 0.4)

            occupied = bool(self.subjects)
            feats = self._features(resp_mod, motion_mod, occupied)
            nodes.append({
                "node_id": node.node_id,
                "rssi_dbm": round(rssi, 2),
                "position": list(node.position),
                "amplitude": amps,
                "subcarrier_count": SUBCARRIERS,
            })
            node_features.append({
                "node_id": node.node_id,
                "features": feats,
                "classification": self._classification(motion_mod, occupied),
                "rssi_dbm": round(rssi, 2),
                "last_seen_ms": int((self.start_epoch + self.t) * 1000),
                "frame_rate_hz": round(self.fs, 2),
                "stale": False,
            })

        self._motion_hist.append(total_motion)
        if len(self._motion_hist) > 100:
            self._motion_hist.pop(0)

        primary = self._primary()
        occupied = bool(self.subjects)
        agg_resp = sum(self._chest(s) for s in self.subjects)
        frame = {
            "type": "sensing_update",
            "timestamp": round(self.start_epoch + self.t, 3),
            "source": "simulate",
            "tick": self.tick,
            "nodes": nodes,
            "features": self._features(agg_resp, total_motion, occupied),
            "classification": self._classification(total_motion, occupied),
            "signal_field": self._field(),
            "vital_signs": self._vitals(primary),
            "node_features": node_features,
            "estimated_persons": len(self.subjects),
            "signal_quality_score": round(0.82 - 0.25 * min(total_motion, 1.0), 3),
            "quality_verdict": "usable" if total_motion < 1.2 else "degraded_by_motion",
            "persons": self._persons(),
            # Ground truth for offline evaluation only; the adapter ignores it.
            "_ground_truth": {
                "t": round(self.t, 2),
                "subjects": [
                    {"name": s.script.name, "state": s.state,
                     "position": [round(v, 3) for v in s.position],
                     "respiration_bpm": STATE_PHYSIOLOGY[s.state][0],
                     "heart_bpm": HEART_RATE[s.state]}
                    for s in self.subjects
                ],
            },
        }
        if primary is not None:
            frame["posture"] = "supine" if primary.state == "ASLEEP" else "upright"
        return frame

    def _primary(self) -> _SubjectRuntime | None:
        """The subject the aggregate vitals stream would lock onto: the one
        coupling most strongly to any node."""
        if not self.subjects:
            return None
        best, best_w = self.subjects[0], -1.0
        for node in self.scenario.nodes:
            for s, w in zip(self.subjects, self._weights(node)):
                if w > best_w:
                    best, best_w = s, w
        return best

    def _features(self, resp: float, motion: float, occupied: bool) -> dict:
        var = 0.02 + abs(resp) * 0.05 + motion * 0.8
        dom = 0.0
        if occupied:
            s = self._primary()
            if s is not None:
                dom = STATE_PHYSIOLOGY[s.state][0] / 60.0
        return {
            "mean_rssi": round(-48.0 + 2.0 * motion, 2),
            "variance": round(var, 5),
            "motion_band_power": round(max(1e-4, motion * motion * 0.4 + 0.0008), 6),
            "breathing_band_power": round(max(1e-4, abs(resp) * 0.02 + 0.0015), 6),
            "dominant_freq_hz": round(dom, 4),
            "change_points": 1 if motion > 0.8 else 0,
            "spectral_power": round(var * 3.1, 5),
        }

    def _classification(self, motion: float, occupied: bool) -> dict:
        if not occupied:
            return {"motion_level": "absent", "presence": False,
                    "confidence": round(0.05 + self.rng.random() * 0.05, 3)}
        if motion > 0.45:
            level, conf = "present_moving", 0.94
        elif motion > 0.12:
            level, conf = "present_micro", 0.88
        else:
            level, conf = "present_still", 0.82
        return {"motion_level": level, "presence": True,
                "confidence": round(conf + self.rng.gauss(0, 0.02), 3)}

    def _vitals(self, primary: _SubjectRuntime | None) -> dict:
        if primary is None:
            return {"breathing_rate_bpm": None, "heart_rate_bpm": None,
                    "breathing_confidence": 0.0, "heartbeat_confidence": 0.0,
                    "signal_quality": 0.3}
        bpm, _, _, _, _ = STATE_PHYSIOLOGY[primary.state]
        motion_penalty = min(primary.motion, 1.0)
        br_conf = max(0.05, 0.9 - 0.7 * motion_penalty)
        hr_conf = max(0.0, 0.55 - 0.8 * motion_penalty)
        # The upstream estimator is imperfect: the relayed rate carries noise
        # that grows with motion, which is what makes the fusion in
        # core/vitals.py meaningful rather than decorative.
        return {
            "breathing_rate_bpm": round(bpm + self.rng.gauss(0, 0.4 + motion_penalty), 2)
            if br_conf > 0.2 else None,
            "heart_rate_bpm": round(HEART_RATE[primary.state] + self.rng.gauss(0, 3.0), 1)
            if hr_conf > 0.25 else None,
            "breathing_confidence": round(br_conf, 3),
            "heartbeat_confidence": round(hr_conf, 3),
            "signal_quality": round(0.8 - 0.4 * motion_penalty, 3),
        }

    def _persons(self) -> list[dict]:
        out = []
        for i, s in enumerate(self.subjects):
            out.append({
                "id": i + 1,
                "confidence": round(0.72 + 0.2 * min(s.motion, 1.0), 3),
                "keypoints": [],       # upstream pose model is a stub; so is this
                "bbox": {"x": round(s.position[0] - 0.3, 3), "y": round(s.position[1] - 0.8, 3),
                         "width": 0.6, "height": 1.7},
                "zone": "volume",
                "position": [round(v, 3) for v in s.position],
                "motion_score": round(min(100.0, s.motion * 70.0), 2),
                "pose": "supine" if s.state == "ASLEEP" else "upright",
            })
        return out

    def _field(self) -> dict:
        nx, ny, nz = self.scenario.grid
        ex, ey, ez = self.scenario.extent
        values = [0.0] * (nx * ny * nz)
        sigma = 0.55
        for ix in range(nx):
            wx = (ix + 0.5) / nx * ex - ex / 2
            for iy in range(ny):
                wy = (iy + 0.5) / ny * ey
                for iz in range(nz):
                    wz = (iz + 0.5) / nz * ez - ez / 2
                    v = 0.035 + self.rng.random() * 0.02
                    for s in self.subjects:
                        # Occupancy mass around the torso, breathing-modulated so
                        # the rendered cloud visibly pulses at the subject's rate.
                        d2 = ((wx - s.position[0]) ** 2
                              + (wy - s.position[1]) ** 2 * 0.6
                              + (wz - s.position[2]) ** 2)
                        amp = 0.85 + 0.15 * self._chest(s) + 0.5 * min(s.motion, 1.0)
                        v += amp * math.exp(-d2 / (2 * sigma * sigma))
                    values[ix * (ny * nz) + iy * nz + iz] = round(v, 4)
        return {"grid_size": [nx, ny, nz], "values": values}
