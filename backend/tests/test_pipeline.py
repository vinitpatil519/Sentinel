"""Adapter, tracking and pipeline tests.

Covers the path from an upstream wire payload to the channels the console
consumes: schema normalisation, subject association, vitals attribution, field
sparsification and per-channel rate limiting.
"""

from __future__ import annotations

import pytest

from sentinel.core.pipeline import MAX_FIELD_VOXELS, Pipeline
from sentinel.core.telemetry import INTERNAL_CHANNELS, TelemetryHub
from sentinel.core.tracks import TrackGeometry, TrackStore
from sentinel.sensors.ruview_rf import RuViewRF, ws_port_for, ws_url_for
from sentinel.simulation import Simulator, build_scenario

T0 = 1_700_000_000_000


def upstream_frame(**overrides) -> dict:
    """A minimal but real-shaped SensingUpdate from the sensing server."""
    frame = {
        "type": "sensing_update",
        "timestamp": T0 / 1000,
        "source": "esp32",
        "tick": 42,
        "nodes": [{
            "node_id": 1, "rssi_dbm": -47.5, "position": [-2.6, 1.0, -2.6],
            "amplitude": [18.0, 19.0, 20.0], "subcarrier_count": 3,
        }],
        "features": {
            "mean_rssi": -47.5, "variance": 0.04, "motion_band_power": 0.002,
            "breathing_band_power": 0.02, "dominant_freq_hz": 0.25,
            "change_points": 0, "spectral_power": 0.12,
        },
        "classification": {"motion_level": "present_still", "presence": True,
                           "confidence": 0.82},
        "signal_field": {"grid_size": [2, 1, 2], "values": [0.1, 0.9, 0.2, 0.1]},
        "vital_signs": {
            "breathing_rate_bpm": 13.5, "heart_rate_bpm": 62.0,
            "breathing_confidence": 0.8, "heartbeat_confidence": 0.4,
            "signal_quality": 0.77,
        },
        "estimated_persons": 1,
    }
    frame.update(overrides)
    return frame


# ── adapter ─────────────────────────────────────────────────────────────────


def test_ws_port_mapping_matches_upstream_deployments():
    assert ws_port_for(3000) == 3001        # published Docker image
    assert ws_port_for(8080) == 8765        # native build
    assert ws_port_for(9000) == 9000        # anything else: same port
    assert ws_url_for("http://host:3000") == "ws://host:3001/ws/sensing"
    assert ws_url_for("https://host:8080").startswith("wss://host:8765/")


def test_normalize_maps_the_upstream_schema():
    s = RuViewRF("http://x")
    out = s.normalize(upstream_frame())
    assert out is not None
    assert out["ts_ms"] == T0
    assert out["source"] == "esp32"
    assert out["classification"]["presence"] is True
    assert out["vital_signs"]["breathing_rate_bpm"] == 13.5
    assert out["nodes"][0]["amplitude"] == [18.0, 19.0, 20.0]


def test_normalize_rejects_a_payload_with_no_sensing_content():
    s = RuViewRF("http://x")
    assert s.normalize({"type": "pong", "id": 3}) is None


def test_normalize_tolerates_wrong_types_without_raising():
    """The upstream schema is beta; a type change must degrade, not crash."""
    s = RuViewRF("http://x")
    out = s.normalize(upstream_frame(
        nodes=[{"node_id": 1, "rssi_dbm": "loud", "position": "here", "amplitude": [1, "x", 3]}],
        vital_signs={"breathing_rate_bpm": None, "breathing_confidence": "high"},
        classification={"presence": 1, "confidence": None},
    ))
    assert out is not None
    assert out["nodes"][0]["rssi_dbm"] == 0.0
    assert out["nodes"][0]["position"] == [0.0, 0.0, 0.0]
    assert out["nodes"][0]["amplitude"] == [1.0, 3.0]
    assert out["vital_signs"]["breathing_rate_bpm"] is None
    assert out["vital_signs"]["breathing_confidence"] == 0.0


def test_normalize_promotes_volume_keypoints_to_a_person():
    s = RuViewRF("http://x")
    out = s.normalize(upstream_frame(
        pose_keypoints=[[0.1, 0.2, 0.3, 0.9], [0.2, 0.3, 0.4, 0.8]]))
    assert out["persons"] and out["persons"][0]["keypoints"][0]["confidence"] == 0.9


def test_normalize_ignores_a_zero_confidence_pose_stub():
    """Upstream ships a `confidence=0` keypoint stub; it is not a detection."""
    s = RuViewRF("http://x")
    out = s.normalize(upstream_frame(pose_keypoints=[[0, 0, 0, 0]] * 17))
    assert out["persons"] == []


def test_normalize_handles_millisecond_and_missing_timestamps():
    s = RuViewRF("http://x")
    assert s.normalize(upstream_frame(timestamp=T0))["ts_ms"] == T0
    assert s.normalize(upstream_frame(timestamp=None))["ts_ms"] > 0
    assert s.normalize(upstream_frame(timestamp=17.0))["ts_ms"] > 0   # a tick, not a clock


def test_adapter_recognises_its_own_simulator_output():
    """Contract test: the simulator emits the upstream format, so a failure
    here means the two have drifted apart."""
    s = RuViewRF("http://x")
    sim = Simulator(build_scenario("patrol"))
    for _ in range(20):
        assert s.normalize(sim.step()) is not None


# ── tracking ────────────────────────────────────────────────────────────────


def normalised(**kw) -> dict:
    return RuViewRF("http://x").normalize(upstream_frame(**kw))


def test_presence_without_persons_creates_a_field_localised_track():
    store = TrackStore(geometry=TrackGeometry(extent=(6.0, 2.5, 6.0)))
    out = store.ingest(normalised())
    assert out["subject_count"] == 1
    assert out["tracks"][0]["provenance"] == "field_peak"


def test_no_presence_creates_no_track():
    store = TrackStore()
    out = store.ingest(normalised(
        classification={"motion_level": "absent", "presence": False, "confidence": 0.04}))
    assert out["tracks"] == []


def test_upstream_ids_keep_track_identity():
    store = TrackStore()
    persons = [{"id": 7, "confidence": 0.8, "keypoints": [], "bbox": None,
                "zone": "v", "position": [1.0, 0.8, 0.0], "motion_score": 3.0, "pose": None}]
    first = store.ingest(normalised(persons=persons, timestamp=T0 / 1000))
    persons[0]["position"] = [1.1, 0.8, 0.05]
    second = store.ingest(normalised(persons=persons, timestamp=T0 / 1000 + 0.1))
    assert first["tracks"][0]["id"] == second["tracks"][0]["id"]


def test_a_reassigned_upstream_id_does_not_create_a_phantom():
    """Same person, new upstream id: nearest-neighbour gating must reuse the
    existing track instead of reporting two subjects."""
    store = TrackStore()
    p = [{"id": 1, "confidence": 0.8, "keypoints": [], "bbox": None, "zone": "v",
          "position": [1.0, 0.8, 0.0], "motion_score": 3.0, "pose": None}]
    first = store.ingest(normalised(persons=p, timestamp=T0 / 1000))
    p[0]["id"] = 99
    second = store.ingest(normalised(persons=p, timestamp=T0 / 1000 + 0.1))
    assert second["subject_count"] == 1
    assert second["tracks"][0]["id"] == first["tracks"][0]["id"]


def test_a_distant_detection_opens_a_second_track():
    store = TrackStore()
    store.ingest(normalised(persons=[{
        "id": 1, "confidence": 0.8, "keypoints": [], "bbox": None, "zone": "v",
        "position": [-2.0, 0.8, -2.0], "motion_score": 1.0, "pose": None}]))
    out = store.ingest(normalised(persons=[
        {"id": 1, "confidence": 0.8, "keypoints": [], "bbox": None, "zone": "v",
         "position": [-2.0, 0.8, -2.0], "motion_score": 1.0, "pose": None},
        {"id": 2, "confidence": 0.8, "keypoints": [], "bbox": None, "zone": "v",
         "position": [2.2, 0.9, 2.0], "motion_score": 1.0, "pose": None},
    ], timestamp=T0 / 1000 + 0.1))
    assert out["subject_count"] == 2


def test_a_stale_track_is_closed_and_reported():
    store = TrackStore(timeout_s=1.0)
    store.ingest(normalised())
    out = store.ingest(normalised(
        timestamp=T0 / 1000 + 5,
        classification={"motion_level": "absent", "presence": False, "confidence": 0.0}))
    assert out["tracks"] == []
    assert out["closed"] and out["closed"][0]["duration_s"] >= 0


def test_single_subject_owns_the_vitals_stream():
    store = TrackStore()
    out = store.ingest(normalised())
    assert out["tracks"][0]["vitals"]["attribution"] == "exclusive"


def test_strict_mode_refuses_to_attribute_vitals_to_two_subjects():
    store = TrackStore(attribution_mode="strict")
    persons = [
        {"id": 1, "confidence": 0.8, "keypoints": [], "bbox": None, "zone": "v",
         "position": [-2.0, 0.8, -2.0], "motion_score": 1.0, "pose": None},
        {"id": 2, "confidence": 0.8, "keypoints": [], "bbox": None, "zone": "v",
         "position": [2.2, 0.9, 2.0], "motion_score": 1.0, "pose": None},
    ]
    out = store.ingest(normalised(persons=persons))
    assert all(t["vitals"]["attribution"] == "unattributed" for t in out["tracks"])


def test_auto_mode_attributes_two_subjects_by_nearest_node():
    store = TrackStore(attribution_mode="auto")
    nodes = [
        {"node_id": 1, "rssi_dbm": -47.0, "position": [-2.6, 1.0, -2.6],
         "amplitude": [18.0], "subcarrier_count": 1},
        {"node_id": 2, "rssi_dbm": -49.0, "position": [2.6, 1.0, 2.2],
         "amplitude": [19.0], "subcarrier_count": 1},
    ]
    persons = [
        {"id": 1, "confidence": 0.8, "keypoints": [], "bbox": None, "zone": "v",
         "position": [-2.0, 0.8, -2.0], "motion_score": 1.0, "pose": None},
        {"id": 2, "confidence": 0.8, "keypoints": [], "bbox": None, "zone": "v",
         "position": [2.2, 0.9, 2.0], "motion_score": 1.0, "pose": None},
    ]
    out = store.ingest(normalised(persons=persons, nodes=nodes))
    assert {t["vitals"]["attribution"] for t in out["tracks"]} == {"nearest_node"}
    assert {t["node_id"] for t in out["tracks"]} == {1, 2}


def test_tracks_are_ordered_by_risk():
    """The operator reads the top of the list first, so it must hold the most
    dangerous subject."""
    store = TrackStore()
    persons = [
        {"id": 1, "confidence": 0.9, "keypoints": [], "bbox": None, "zone": "v",
         "position": [-2.0, 0.8, -2.0], "motion_score": 90.0, "pose": None},
        {"id": 2, "confidence": 0.9, "keypoints": [], "bbox": None, "zone": "v",
         "position": [2.2, 0.9, 2.0], "motion_score": 1.0, "pose": None},
    ]
    out = None
    for i in range(60):
        out = store.ingest(normalised(persons=persons, timestamp=T0 / 1000 + i * 0.5))
    risks = [t["advisory"]["readiness_index"] for t in out["tracks"]]
    assert risks == sorted(risks, reverse=True)


# ── pipeline ────────────────────────────────────────────────────────────────


async def test_pipeline_publishes_the_console_channels():
    hub = TelemetryHub()
    seen: dict[str, dict] = {}

    async def tap(msg):
        seen[msg["ch"]] = msg["data"]

    hub.tap(tap)
    pipe = Pipeline(hub)
    await pipe.process(normalised())
    for ch in ("rf.presence", "rf.vitals", "rf.nodes", "rf.field", "track.state"):
        assert ch in seen, f"{ch} not published"
    assert seen["rf.presence"]["present"] is True
    assert seen["rf.vitals"]["provenance"] == "sensing_server"


async def test_pipeline_rate_limits_each_channel_independently():
    hub = TelemetryHub()
    counts: dict[str, int] = {}

    async def tap(msg):
        counts[msg["ch"]] = counts.get(msg["ch"], 0) + 1

    hub.tap(tap)
    pipe = Pipeline(hub)
    for i in range(30):
        await pipe.process(normalised(timestamp=T0 / 1000 + i * 0.1))
    assert counts["rf.presence"] > counts["rf.vitals"] >= 1
    assert counts["rf.nodes"] <= counts["rf.field"]


async def test_field_is_sparsified_and_thresholded():
    hub = TelemetryHub()
    pipe = Pipeline(hub, geometry=TrackGeometry(extent=(6.0, 2.5, 6.0)))
    field = pipe._field(normalised())
    assert field["dims"] == [2, 1, 2]
    # Values 0.1/0.9/0.2/0.1 against a floor of 0.22 x peak: two voxels survive,
    # and the peak is normalised to 1.0.
    assert field["occupied"] == 2
    x, y, z, intensity = field["points"][0]
    assert intensity == 1.0
    assert -3.0 <= x <= 3.0 and -3.0 <= z <= 3.0


async def test_field_is_bounded_for_a_large_grid():
    hub = TelemetryHub()
    pipe = Pipeline(hub)
    big = normalised(signal_field={"grid_size": [32, 16, 32],
                                   "values": [0.9] * (32 * 16 * 32)})
    field = pipe._field(big)
    assert len(field["points"]) <= MAX_FIELD_VOXELS


async def test_mismatched_field_dimensions_are_rejected():
    hub = TelemetryHub()
    pipe = Pipeline(hub)
    assert pipe._field(normalised(
        signal_field={"grid_size": [4, 4, 4], "values": [0.5, 0.5]})) is None


async def test_sensing_frames_never_reach_browser_clients():
    """rf.sensing carries CSI vectors at 10 Hz; it is for internal consumers."""
    assert "rf.sensing" in INTERNAL_CHANNELS
    hub = TelemetryHub()

    class FakeWS:
        def __init__(self):
            self.sent = []

        async def send_text(self, text):
            self.sent.append(text)

    ws = FakeWS()
    await hub.attach(ws)
    await hub.publish("rf.sensing", {"big": [1] * 100})
    await hub.publish("rf.presence", {"present": True})
    assert len(ws.sent) == 1
    assert "rf.presence" in ws.sent[0]


async def test_hub_drops_a_client_that_fails_instead_of_stalling():
    hub = TelemetryHub()

    class BrokenWS:
        async def send_text(self, text):
            raise RuntimeError("client gone")

    await hub.attach(BrokenWS())
    await hub.publish("rf.presence", {"present": True})
    assert hub.dropped_clients == 1
    assert hub.stats()["clients"] == 0


async def test_hub_reports_channel_rates():
    hub = TelemetryHub()
    for _ in range(5):
        await hub.publish("rf.presence", {"present": True})
    stats = hub.stats()
    assert stats["channels"]["rf.presence"]["count"] == 5


@pytest.mark.parametrize("scenario", ["patrol", "two-person", "clear"])
async def test_scenario_runs_through_the_whole_pipeline(scenario):
    """End-to-end smoke test over the real adapter + pipeline for each shape of
    scenario: one subject, two subjects, and an empty room."""
    sc = build_scenario(scenario)
    sim = Simulator(sc, fs=10.0, seed=3)
    adapter = RuViewRF("http://x")
    pipe = Pipeline(TelemetryHub(), geometry=TrackGeometry(extent=sc.extent))
    for _ in range(300):
        frame = adapter.normalize(sim.step())
        await pipe.process(frame)
    summary = pipe.last_tracks
    expected = len(sc.subjects)
    assert summary["subject_count"] == expected
    for tr in summary["tracks"]:
        assert -4.0 < tr["position"][0] < 4.0
        assert tr["vitals"]["respiration"]["confidence"] >= 0.0


def test_field_heights_are_floor_referenced():
    """y must run 0..extent from the floor. Centring it on the origin puts a
    subject's legs — and half the sensing volume — underground."""
    geo = TrackGeometry(extent=(6.0, 2.5, 6.0))
    bottom = geo.grid_to_world((0, 0, 0), (4, 4, 4))
    top = geo.grid_to_world((3, 3, 3), (4, 4, 4))
    assert bottom[1] > 0.0 and top[1] < 2.5
    assert top[1] > bottom[1]
    # Horizontal axes stay centred on the origin.
    assert bottom[0] < 0.0 < top[0]
    assert bottom[2] < 0.0 < top[2]


async def test_published_field_stays_inside_the_volume():
    hub = TelemetryHub()
    pipe = Pipeline(hub, geometry=TrackGeometry(extent=(6.0, 2.5, 6.0)))
    sim = Simulator(build_scenario("patrol"), fs=10.0, seed=5)
    adapter = RuViewRF("http://x")
    field = pipe._field(adapter.normalize(sim.step()))
    assert field and field["points"]
    for x, y, z, intensity in field["points"]:
        assert -3.0 <= x <= 3.0
        assert 0.0 <= y <= 2.5
        assert -3.0 <= z <= 3.0
        assert 0.0 <= intensity <= 1.0


def test_a_floor_plane_field_is_placed_on_the_floor():
    """The sensing server publishes a 20x1x20 grid — a floor map, not a volume.
    It carries no height, so it must not be rendered at mid-height."""
    geo = TrackGeometry(extent=(6.0, 2.5, 6.0))
    p = geo.grid_to_world((10, 0, 10), (20, 1, 20))
    assert p[1] == 0.0


async def test_field_metadata_marks_a_planar_grid():
    hub = TelemetryHub()
    pipe = Pipeline(hub, geometry=TrackGeometry(extent=(6.0, 2.5, 6.0)))
    planar = normalised(signal_field={
        "grid_size": [4, 1, 4],
        "values": [0.1] * 15 + [0.9],
    })
    field = pipe._field(planar)
    assert field["planar"] is True
    assert all(pt[1] == 0.0 for pt in field["points"])
