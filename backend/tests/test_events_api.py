"""Event derivation, persistence and HTTP surface."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from sentinel.config.settings import Settings
from sentinel.core.events import EventEngine
from sentinel.core.telemetry import TelemetryHub
from sentinel.database.db import Database
from sentinel.main import create_app

T0 = 1_700_000_000_000


def collect(hub: TelemetryHub) -> list[dict]:
    events: list[dict] = []

    async def tap(msg):
        if msg["ch"] == "events":
            events.append(msg["data"])

    hub.tap(tap)
    return events


def track_msg(track_id="S-001", state="ASLEEP", decision="APPROACH", resp_conf=0.8,
              irregular=False, closed=None):
    return {
        "tracks": [{
            "id": track_id,
            "provenance": "field_peak",
            "position": [1.0, 0.8, 0.0],
            "state": {"state": state, "confidence": 0.8},
            "advisory": {"decision": decision, "readiness_index": 0.1, "reasons": []},
            "vitals": {
                "respiration": {"bpm": 12.0, "confidence": resp_conf, "method": "local_csi"},
                "respiration_features": {"irregular": irregular},
            },
        }],
        "closed": closed or [],
        "subject_count": 1,
    }


# ── event derivation ────────────────────────────────────────────────────────


async def test_presence_events_use_hysteresis():
    hub = TelemetryHub()
    EventEngine(hub)
    events = collect(hub)
    for c in [0.2, 0.5, 0.9, 0.95, 0.9]:
        await hub.publish("rf.presence", {"present": True, "confidence": c})
    for c in [0.4, 0.1, 0.05, 0.05]:
        await hub.publish("rf.presence", {"present": False, "confidence": c})
    assert [e["type"] for e in events] == ["PRESENCE_DETECTED", "PRESENCE_LOST"]


async def test_track_lifecycle_events():
    hub = TelemetryHub()
    EventEngine(hub)
    events = collect(hub)
    await hub.publish("track.state", track_msg())
    await hub.publish("track.state", track_msg())          # unchanged: no new events
    await hub.publish("track.state", track_msg(state="ACTIVE", decision="DO_NOT_APPROACH"))
    await hub.publish("track.state", {"tracks": [], "closed": [
        {"id": "S-001", "duration_s": 42.0, "last_state": "ACTIVE"}], "subject_count": 0})
    types = [e["type"] for e in events]
    assert types.count("TRACK_ACQUIRED") == 1
    assert types.count("STATE_CHANGED") == 2               # None→ASLEEP, ASLEEP→ACTIVE
    assert types.count("ADVISORY_CHANGED") == 2
    assert "TRACK_LOST" in types


async def test_advisory_severity_reflects_risk():
    hub = TelemetryHub()
    EventEngine(hub)
    events = collect(hub)
    await hub.publish("track.state", track_msg(state="ACTIVE", decision="DO_NOT_APPROACH"))
    sev = {e["type"]: e["severity"] for e in events}
    assert sev["ADVISORY_CHANGED"] == "critical"
    assert sev["STATE_CHANGED"] == "alert"


async def test_respiration_lock_and_loss_are_logged_once_each():
    hub = TelemetryHub()
    EventEngine(hub)
    events = collect(hub)
    await hub.publish("track.state", track_msg(resp_conf=0.8))
    await hub.publish("track.state", track_msg(resp_conf=0.75))
    await hub.publish("track.state", track_msg(resp_conf=0.0))
    types = [e["type"] for e in events]
    assert types.count("RESPIRATION_LOCKED") == 1
    assert types.count("RESPIRATION_LOST") == 1


async def test_irregular_respiration_raises_a_critical_event():
    hub = TelemetryHub()
    EventEngine(hub)
    events = collect(hub)
    await hub.publish("track.state", track_msg(state="RESTING", irregular=True))
    assert any(e["type"] == "RESPIRATION_IRREGULAR" and e["severity"] == "critical"
               for e in events)


async def test_switching_to_simulated_data_is_an_event():
    """An operator must never be unaware that the feed stopped being real."""
    hub = TelemetryHub()
    EventEngine(hub)
    events = collect(hub)
    await hub.publish("rf.presence", {"present": True, "confidence": 0.9, "source": "esp32"})
    await hub.publish("rf.presence", {"present": True, "confidence": 0.9, "source": "simulate"})
    changed = [e for e in events if e["type"] == "SOURCE_CHANGED"]
    assert changed and changed[0]["severity"] == "warn"
    assert changed[0]["source"] == "simulate"


async def test_node_stale_and_recovery_events():
    hub = TelemetryHub()
    EventEngine(hub)
    events = collect(hub)
    await hub.publish("rf.nodes", {"nodes": [{"node_id": 1, "stale": False},
                                             {"node_id": 2, "stale": True}]})
    await hub.publish("rf.nodes", {"nodes": [{"node_id": 1, "stale": False},
                                             {"node_id": 2, "stale": False}]})
    types = [e["type"] for e in events]
    assert "NODE_STALE" in types and "NODE_RECOVERED" in types


async def test_sensor_health_transitions():
    hub = TelemetryHub()
    EventEngine(hub)
    events = collect(hub)
    await hub.publish("sensor.health", {"sensor": "ruview_rf", "health": "offline"})
    await hub.publish("sensor.health", {"sensor": "ruview_rf", "health": "ok",
                                        "recovered": True})
    assert [e["type"] for e in events] == ["SENSOR_OFFLINE", "SENSOR_RECOVERED"]


# ── persistence ─────────────────────────────────────────────────────────────


async def test_samples_are_downsampled_but_events_are_not(tmp_path):
    db = Database(tmp_path / "t.db")
    await db.open()
    for ts in (T0, T0 + 200, T0 + 900, T0 + 1100):
        await db.on_telemetry({"ch": "rf.presence", "ts": ts, "data": {"present": True}})
    assert len(await db.query("SELECT * FROM samples")) == 2
    await db.on_telemetry({"ch": "events", "ts": T0, "data": {"type": "X"}})
    await db.on_telemetry({"ch": "events", "ts": T0 + 1, "data": {"type": "Y"}})
    assert len(await db.query("SELECT * FROM events")) == 2
    await db.close()


async def test_assessments_are_recorded_per_track(tmp_path):
    db = Database(tmp_path / "t.db")
    await db.open()
    for i in range(4):
        await db.on_telemetry({"ch": "track.state", "ts": T0 + i * 1000,
                               "data": track_msg()})
    rows = await db.query("SELECT * FROM assessments ORDER BY ts")
    assert len(rows) == 4
    assert rows[0]["state"] == "ASLEEP" and rows[0]["decision"] == "APPROACH"
    assert rows[0]["respiration_bpm"] == 12.0
    tracks = await db.query("SELECT * FROM tracks")
    assert len(tracks) == 1 and tracks[0]["track_id"] == "S-001"
    await db.close()


async def test_labels_and_summary(tmp_path):
    db = Database(tmp_path / "t.db")
    await db.open()
    await db.on_telemetry({"ch": "track.state", "ts": T0, "data": track_msg()})
    await db.add_label("ASLEEP", T0, T0 + 60_000, "S-001", "subject confirmed asleep")
    summary = await db.session_summary()
    assert summary["state_seconds"]["ASLEEP"] == 1
    labels = await db.query("SELECT * FROM labels")
    assert labels[0]["label"] == "ASLEEP"
    await db.close()


# ── HTTP surface ────────────────────────────────────────────────────────────


@pytest.fixture
def client(tmp_path):
    settings = Settings(db_path=tmp_path / "api.db", sensors=[])
    with TestClient(create_app(settings)) as c:
        yield c


def test_capabilities_describes_the_model_and_geometry(client):
    body = client.get("/api/capabilities").json()
    assert "ASLEEP" in body["model"]["states"]
    assert "APPROACH" in body["model"]["decisions"]
    assert body["model"]["state_labels"]["ASLEEP"]
    assert body["geometry"]["extent"] == [6.0, 2.5, 6.0]
    assert body["advisory"]["min_evidence"] > 0


def test_state_snapshot_shape(client):
    body = client.get("/api/state").json()
    assert set(body) >= {"rf.presence", "track.state", "events"}


def test_healthz_reports_no_sensor_as_not_ok(client):
    body = client.get("/healthz").json()
    assert body["ok"] is False


def test_label_endpoint_rejects_an_unknown_state(client):
    assert client.post("/api/labels", json={"label": "SLEEPY"}).status_code == 422
    ok = client.post("/api/labels", json={"label": "ASLEEP", "notes": "verified"})
    assert ok.status_code == 200 and ok.json()["ts_start"] > 0
    assert client.get("/api/labels").json()["labels"][0]["label"] == "ASLEEP"


def test_exports(client):
    assert client.get("/api/export.json").json()["session_id"] >= 1
    csv_resp = client.get("/api/export.csv?table=events")
    assert csv_resp.status_code == 200
    assert client.get("/api/export.csv?table=secrets").status_code == 422


def test_stats_endpoint(client):
    body = client.get("/api/stats").json()
    assert "hub" in body and "pipeline" in body


def test_websocket_attaches_and_detaches_a_client(client):
    hub = client.app.state.hub
    assert hub.stats()["clients"] == 0
    with client.websocket_connect("/ws"):
        assert hub.stats()["clients"] == 1
    assert hub.stats()["clients"] == 0
