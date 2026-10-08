"""Subject tracking, vitals attribution and per-subject assessment.

The sensing server reports what it can see per frame; it does not maintain
subject identity, and its vital-sign estimate is a single aggregate stream for
the whole volume. This module turns that into per-subject state:

* **association** — frame detections are matched to persistent tracks by
  upstream id first, then by nearest-neighbour gating on position, so an id
  reassignment upstream does not create a phantom subject.
* **attribution** — a vitals stream is bound to a subject only when that binding
  is defensible. With one subject present the aggregate stream is exclusive to
  them. With several, per-node spectral features are attributed by proximity
  (the nearest node dominates that subject's chest-motion signal), and the
  resulting estimate is marked as such and discounted. When neither holds, the
  subject's vitals are reported as unattributed rather than guessed.
* **localisation fallback** — when the upstream pose model is not producing
  keypoints (its documented first-cut state), a subject is still localised from
  the peak of the signal field. That produces a position and a presence mass,
  never a skeleton, and the provenance field says which one the console is
  drawing.

Provenance is carried on every track so the console can label what it is
showing. Nothing synthesises a measurement that was not made.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from sentinel.core import dsp
from sentinel.core.assessment import (
    ModelConfig,
    PolicyConfig,
    SubjectAssessment,
    SubjectAssessor,
)
from sentinel.core.vitals import (
    CardiacAnalyzer,
    MotionAnalyzer,
    RespirationAnalyzer,
    VitalsSnapshot,
    apply_motion_gate,
)

#: Association gate: a detection further than this from a track's predicted
#: position starts a new track instead of teleporting an existing one.
ASSOC_GATE_M = 1.8
#: A track with no supporting detection for this long is closed.
TRACK_TIMEOUT_S = 6.0
#: Minimum interval between spectral re-estimates / state updates per track.
#: The behavioural HMM's transition matrix is specified at this rate.
ESTIMATE_PERIOD_MS = 500
#: Position smoothing (per update).
POSITION_ALPHA = 0.35


@dataclass
class TrackGeometry:
    """Physical extent the sensing field grid maps onto, in metres."""

    extent: tuple[float, float, float] = (6.0, 2.5, 6.0)
    origin: tuple[float, float, float] = (0.0, 0.0, 0.0)  # centre of the volume

    def grid_to_world(self, idx: tuple[int, int, int], dims: tuple[int, int, int]) -> list[float]:
        """Voxel index → metres.

        The horizontal axes are centred on the origin, but the vertical one is
        floor-referenced: y runs 0 at the floor to ``extent[1]`` at the ceiling.
        Centring it too would put half the sensing volume — and every voxel of a
        subject's lower body — underground.

        A single vertical cell (``dims[1] == 1``) means the grid is a floor-plane
        map, not a volume — which is what the sensing server actually publishes
        (a 20×1×20 grid). It carries no height information, so it is placed *on
        the floor* rather than at mid-height: putting a 2-D map at 1.25 m would
        invent a vertical position the measurement does not contain.
        """
        out = []
        for axis, (ix, n, ext, o) in enumerate(zip(idx, dims, self.extent, self.origin)):
            if axis == 1:
                if n <= 1:
                    out.append(o)
                else:
                    out.append(o + ((ix + 0.5) / n) * ext)
                continue
            frac = (ix + 0.5) / n if n > 0 else 0.5
            out.append(o + (frac - 0.5) * ext)
        return out


@dataclass
class Track:
    id: str
    upstream_id: int | None
    provenance: str                      # pose_model | field_peak | aggregate
    first_seen_ms: int
    last_seen_ms: int
    position: list[float] = field(default_factory=lambda: [0.0, 0.0, 0.0])
    velocity: list[float] = field(default_factory=lambda: [0.0, 0.0, 0.0])
    confidence: float = 0.0
    motion_score: float = 0.0
    bbox: dict | None = None
    zone: str = "unassigned"
    posture: str | None = None
    keypoints: list[dict] | None = None
    node_id: int | None = None           # nearest node, for vitals attribution
    resp: RespirationAnalyzer = field(default_factory=RespirationAnalyzer)
    card: CardiacAnalyzer = field(default_factory=CardiacAnalyzer)
    motion: MotionAnalyzer = field(default_factory=MotionAnalyzer)
    assessor: SubjectAssessor | None = None
    vitals: VitalsSnapshot = field(default_factory=VitalsSnapshot)
    assessment: SubjectAssessment | None = None
    _missed: int = 0
    _last_estimate_ms: int = 0

    def age_s(self, now_ms: int) -> float:
        return (now_ms - self.first_seen_ms) / 1000.0

    def as_dict(self, waveform_points: int = 160) -> dict:
        d = {
            "id": self.id,
            "upstream_id": self.upstream_id,
            "provenance": self.provenance,
            "first_seen": self.first_seen_ms,
            "last_seen": self.last_seen_ms,
            "position": [round(v, 3) for v in self.position],
            "velocity": [round(v, 3) for v in self.velocity],
            "speed_mps": round(sum(v * v for v in self.velocity) ** 0.5, 3),
            "confidence": round(self.confidence, 3),
            "motion_score": round(self.motion_score, 2),
            "bbox": self.bbox,
            "zone": self.zone,
            "posture": self.posture,
            "keypoints": self.keypoints,
            "node_id": self.node_id,
            "vitals": self.vitals.as_dict(),
            "respiration_waveform": self.resp.waveform(waveform_points),
        }
        if self.assessment:
            d.update(self.assessment.as_dict())
        return d


class TrackStore:
    """Holds every live subject and keeps their analysis chains warm."""

    def __init__(
        self,
        geometry: TrackGeometry | None = None,
        model_cfg: ModelConfig | None = None,
        policy_cfg: PolicyConfig | None = None,
        timeout_s: float = TRACK_TIMEOUT_S,
        attribution_mode: str = "auto",   # auto | strict
        estimate_period_ms: int = ESTIMATE_PERIOD_MS,
    ) -> None:
        self.geometry = geometry or TrackGeometry()
        self.model_cfg = model_cfg
        self.policy_cfg = policy_cfg
        self.timeout_s = timeout_s
        self.attribution_mode = attribution_mode
        self.estimate_period_ms = estimate_period_ms
        self.tracks: dict[str, Track] = {}
        self._seq = 0
        self._closed: list[dict] = []

    # -- public -------------------------------------------------------------

    def ingest(self, frame: dict) -> dict:
        """Consume one normalised sensing frame; return the track summary."""
        ts = int(frame.get("ts_ms") or 0)
        nodes = frame.get("nodes") or []
        classification = frame.get("classification") or {}
        persons = frame.get("persons") or []
        present = bool(classification.get("presence"))

        detections = self._detections(frame, persons, present, ts)
        matched = self._associate(detections, ts)
        self._feed_signals(matched, frame, nodes, ts)
        self._expire(ts)

        subject_count = len(self.tracks)
        for tr in self.tracks.values():
            # Signals are fed at the full sensing rate; the spectral estimate and
            # the state update run at ESTIMATE_PERIOD_MS. That is not only a cost
            # control — the HMM transition matrix is specified for this update
            # rate, so running it per frame would change its dynamics.
            if ts - tr._last_estimate_ms < self.estimate_period_ms and tr.assessment:
                continue
            tr._last_estimate_ms = ts
            tr.vitals = self._snapshot(tr, frame, subject_count)
            if tr.assessor is None:
                tr.assessor = SubjectAssessor(self.model_cfg, self.policy_cfg)
            tr.assessment = tr.assessor.update(ts, tr.vitals, subject_count)

        closed, self._closed = self._closed, []
        return {
            "ts_ms": ts,
            "tracks": [t.as_dict() for t in self._ordered()],
            "closed": closed,
            "subject_count": subject_count,
            "source": frame.get("source"),
        }

    def _ordered(self) -> list[Track]:
        """Highest-risk subject first: that is the one the operator needs."""
        def key(t: Track):
            adv = t.assessment.advisory if t.assessment else None
            risk = adv.readiness_index if adv else -1.0
            return (-risk, t.first_seen_ms)
        return sorted(self.tracks.values(), key=key)

    # -- detections ---------------------------------------------------------

    def _detections(self, frame: dict, persons: list, present: bool, ts: int) -> list[dict]:
        if persons:
            out = []
            for p in persons:
                kps = p.get("keypoints") or []
                has_pose = any((k.get("confidence") or 0) > 0.05 for k in kps)
                pos = p.get("position") or [0.0, 0.0, 0.0]
                if not any(pos) and has_pose:
                    pos = _keypoint_centroid(kps)
                out.append({
                    "upstream_id": p.get("id"),
                    "position": [float(v) for v in (list(pos) + [0, 0, 0])[:3]],
                    "confidence": float(p.get("confidence") or 0.0),
                    "motion_score": float(p.get("motion_score") or 0.0),
                    "bbox": p.get("bbox"),
                    "zone": str(p.get("zone") or "unassigned"),
                    "posture": p.get("pose") or frame.get("posture"),
                    "keypoints": kps if has_pose else None,
                    "provenance": "pose_model" if has_pose else "field_peak",
                })
            return out

        if not present:
            return []

        # No per-person detections upstream: one aggregate subject, localised
        # from the field peak when the field carries one.
        peak = self._field_peak(frame.get("signal_field") or {})
        classification = frame.get("classification") or {}
        features = frame.get("features") or {}
        return [{
            "upstream_id": None,
            "position": peak or [0.0, 0.0, 0.0],
            "confidence": float(classification.get("confidence") or 0.0),
            "motion_score": float(features.get("motion_band_power") or 0.0),
            "bbox": None,
            "zone": "volume",
            "posture": frame.get("posture"),
            "keypoints": None,
            "provenance": "field_peak" if peak else "aggregate",
        }]

    def _field_peak(self, sf: dict) -> list[float] | None:
        dims = sf.get("grid_size") or []
        values = sf.get("values") or []
        if len(dims) != 3 or not values:
            return None
        nx, ny, nz = (int(d) for d in dims)
        if nx * ny * nz != len(values):
            return None
        best_i = max(range(len(values)), key=lambda i: values[i])
        if values[best_i] <= 0:
            return None
        # Row-major [x][y][z], matching the sensing server's flattening order.
        z = best_i % nz
        y = (best_i // nz) % ny
        x = best_i // (nz * ny)
        return self.geometry.grid_to_world((x, y, z), (nx, ny, nz))

    # -- association --------------------------------------------------------

    def _associate(self, detections: list[dict], ts: int) -> list[tuple[Track, dict]]:
        unmatched = list(detections)
        pairs: list[tuple[Track, dict]] = []
        claimed: set[str] = set()

        # 1. exact upstream-id match
        for det in list(unmatched):
            uid = det.get("upstream_id")
            if uid is None:
                continue
            for tr in self.tracks.values():
                if tr.id in claimed or tr.upstream_id != uid:
                    continue
                pairs.append((tr, det))
                claimed.add(tr.id)
                unmatched.remove(det)
                break

        # 2. nearest-neighbour within the gate
        for det in list(unmatched):
            best, best_d = None, ASSOC_GATE_M
            for tr in self.tracks.values():
                if tr.id in claimed:
                    continue
                d = _dist(tr.position, det["position"])
                if d < best_d:
                    best, best_d = tr, d
            if best is not None:
                best.upstream_id = det.get("upstream_id", best.upstream_id)
                pairs.append((best, det))
                claimed.add(best.id)
                unmatched.remove(det)

        # 3. remaining detections open new tracks
        for det in unmatched:
            self._seq += 1
            tid = f"S-{self._seq:03d}"
            tr = Track(
                id=tid,
                upstream_id=det.get("upstream_id"),
                provenance=det["provenance"],
                first_seen_ms=ts,
                last_seen_ms=ts,
                position=list(det["position"]),
                assessor=SubjectAssessor(self.model_cfg, self.policy_cfg),
            )
            self.tracks[tid] = tr
            pairs.append((tr, det))

        for tr, det in pairs:
            self._update_track(tr, det, ts)
        for tr in self.tracks.values():
            if tr.id not in {t.id for t, _ in pairs}:
                tr._missed += 1
        return pairs

    def _update_track(self, tr: Track, det: dict, ts: int) -> None:
        dt = max((ts - tr.last_seen_ms) / 1000.0, 1e-3)
        new_pos = [
            dsp.ema(tr.position[i], det["position"][i], POSITION_ALPHA) for i in range(3)
        ]
        if tr.last_seen_ms and dt < 2.0:
            tr.velocity = [(new_pos[i] - tr.position[i]) / dt for i in range(3)]
        tr.position = new_pos
        tr.confidence = det["confidence"]
        tr.motion_score = det["motion_score"]
        tr.bbox = det["bbox"]
        tr.zone = det["zone"]
        tr.posture = det["posture"]
        tr.keypoints = det["keypoints"]
        tr.provenance = det["provenance"]
        tr.last_seen_ms = ts
        tr._missed = 0

    def _expire(self, ts: int) -> None:
        for tid in list(self.tracks):
            tr = self.tracks[tid]
            if (ts - tr.last_seen_ms) / 1000.0 > self.timeout_s:
                self._closed.append({
                    "id": tr.id,
                    "duration_s": round(tr.age_s(ts), 1),
                    "last_state": tr.assessment.state.state.value
                    if tr.assessment and tr.assessment.state.state else None,
                })
                del self.tracks[tid]

    # -- signal routing -----------------------------------------------------

    def _feed_signals(self, pairs, frame: dict, nodes: list, ts: int) -> None:
        """Route CSI amplitude and vitals references into each track's chains."""
        node_amp = {}
        for n in nodes:
            amps = n.get("amplitude") or []
            if amps:
                node_amp[int(n.get("node_id", 0))] = dsp.mean(amps)
        node_pos = {int(n.get("node_id", 0)): n.get("position") or [0, 0, 0] for n in nodes}
        node_feats = {
            int(nf.get("node_id", 0)): nf for nf in (frame.get("node_features") or [])
        }
        vs = frame.get("vital_signs") or {}
        features = frame.get("features") or {}
        global_amp = dsp.mean(list(node_amp.values())) if node_amp else None

        multi = len(self.tracks) > 1
        for tr in self.tracks.values():
            nearest = _nearest_node(tr.position, node_pos)
            tr.node_id = nearest
            amp = node_amp.get(nearest) if (multi and nearest is not None) else global_amp
            if amp is not None:
                tr.resp.push_csi(ts, amp)
                tr.card.push_csi(ts, amp)

            nf = node_feats.get(nearest) if nearest is not None else None
            motion_power = None
            if multi and nf:
                motion_power = (nf.get("features") or {}).get("motion_band_power")
                # Per-node dominant frequency inside the respiration band is an
                # independent per-subject rate estimate; use it as this track's
                # reference instead of the volume-wide aggregate.
                dom = (nf.get("features") or {}).get("dominant_freq_hz")
                if dom and 0.1 <= float(dom) <= 0.5:
                    tr.resp.push_reference(ts, float(dom) * 60.0, 0.45)
            if motion_power is None:
                motion_power = features.get("motion_band_power")
            if motion_power is not None:
                tr.motion.push(ts, float(motion_power))

            if not multi:
                tr.resp.push_reference(
                    ts, _f(vs.get("breathing_rate_bpm")), float(vs.get("breathing_confidence") or 0.0)
                )
                tr.card.push_reference(
                    ts, _f(vs.get("heart_rate_bpm")), float(vs.get("heartbeat_confidence") or 0.0)
                )

    def _snapshot(self, tr: Track, frame: dict, subject_count: int) -> VitalsSnapshot:
        resp, feats = tr.resp.estimate()
        card = tr.card.estimate()
        motion = tr.motion.state()
        # Body motion contaminates the respiration band; gate before the estimate
        # is used as evidence about breathing.
        resp = apply_motion_gate(resp, motion)
        if motion.index >= 55.0:
            card = type(card)(method="motion_blocked")
        vs = frame.get("vital_signs") or {}
        quality = float(
            frame.get("signal_quality_score")
            or vs.get("signal_quality")
            or 0.0
        )
        if subject_count <= 1:
            attribution = "exclusive"
        elif self.attribution_mode == "strict":
            attribution = "unattributed"
        elif tr.node_id is not None:
            attribution = "nearest_node"
        else:
            attribution = "unattributed"

        if attribution == "unattributed":
            # Keep the local estimate — it is this track's own CSI — but drop the
            # aggregate cardiac stream, which cannot be assigned to anyone.
            if card.method == "reference":
                card = type(card)()
        return VitalsSnapshot(
            respiration=resp,
            cardiac=card,
            features=feats,
            motion=motion,
            signal_quality=quality,
            attribution=attribution,
        )


# ── helpers ─────────────────────────────────────────────────────────────────


def _f(v) -> float | None:
    try:
        return float(v) if v is not None else None
    except (TypeError, ValueError):
        return None


def _dist(a, b) -> float:
    return sum((float(x) - float(y)) ** 2 for x, y in zip(a, b)) ** 0.5


def _nearest_node(pos, node_pos: dict[int, list]) -> int | None:
    if not node_pos:
        return None
    return min(node_pos, key=lambda nid: _dist(pos, node_pos[nid]))


def _keypoint_centroid(kps: list[dict]) -> list[float]:
    pts = [(k.get("x", 0.0), k.get("y", 0.0), k.get("z", 0.0), k.get("confidence", 0.0))
           for k in kps]
    good = [p for p in pts if p[3] > 0.05]
    if not good:
        return [0.0, 0.0, 0.0]
    n = len(good)
    return [sum(p[i] for p in good) / n for i in range(3)]
