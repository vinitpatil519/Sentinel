"""HTTP + WebSocket API.

``/ws`` carries everything the console renders. The REST surface is for things a
stream is the wrong shape for: capability discovery on load, history, research
exports, and operator ground-truth labelling.
"""

from __future__ import annotations

import csv
import dataclasses
import io
import json

from fastapi import APIRouter, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import PlainTextResponse
from pydantic import BaseModel

from sentinel.core.assessment import AROUSAL, STATE_LABEL, Decision, State
from sentinel.core.telemetry import now_ms

router = APIRouter()


@router.get("/healthz")
async def healthz(request: Request):
    sensors = request.app.state.supervisor.snapshot()
    ok = any(h == "ok" for h in sensors.values()) if sensors else False
    return {"ok": ok, "sensors": sensors, "ts": now_ms()}


@router.get("/api/capabilities")
async def capabilities(request: Request):
    """Everything the console needs to configure itself on load."""
    app = request.app
    settings = app.state.settings
    merged: set[str] = set()
    for s in app.state.sensors:
        merged |= s.capabilities()
    pipeline = app.state.pipeline
    return {
        "version": app.version,
        "capabilities": sorted(merged),
        "sensors": app.state.supervisor.snapshot(),
        "session_id": app.state.db.session_id,
        "source": pipeline.last_frame.get("source") if pipeline.last_frame else None,
        "geometry": {
            "extent": list(settings.geometry.extent),
            "origin": list(settings.geometry.origin),
            "wall_axis": settings.geometry.wall_axis,
            "wall_offset_m": settings.geometry.wall_offset_m,
        },
        "model": {
            "provenance": app.state.model_cfg.provenance,
            "states": [s.value for s in State],
            "state_labels": {s.value: STATE_LABEL[s] for s in State},
            "arousal_weights": {s.value: AROUSAL[s] for s in State},
            "decisions": [d.value for d in Decision],
            "vitals_attribution": settings.vitals_attribution,
        },
        # The *effective* policy, after config layering — what the advisory is
        # actually being decided with, not what a YAML file happens to contain.
        "advisory": dataclasses.asdict(app.state.policy_cfg),
    }


@router.get("/api/state")
async def state(request: Request):
    """Latest value of every console channel — the initial-render snapshot."""
    hub = request.app.state.hub
    out = {}
    for ch in ("rf.presence", "rf.vitals", "rf.nodes", "rf.field", "track.state"):
        recent = hub.recent(ch, 1)
        out[ch] = recent[-1] if recent else None
    out["events"] = hub.recent("events", 40)
    return out


@router.get("/api/sensors")
async def sensors(request: Request):
    return {
        "sensors": [s.describe() for s in request.app.state.sensors],
        "health": request.app.state.supervisor.snapshot(),
    }


@router.get("/api/stats")
async def stats(request: Request):
    app = request.app
    return {
        "hub": app.state.hub.stats(),
        "pipeline": app.state.pipeline.snapshot(),
        "db_writes": app.state.db.writes,
        "session_id": app.state.db.session_id,
    }


@router.get("/api/events")
async def events(request: Request, limit: int = 200, severity: str | None = None, since: int = 0):
    q = "SELECT ts, type, severity, track_id, payload_json FROM events WHERE ts>=?"
    args: list = [since]
    if severity:
        q += " AND severity=?"
        args.append(severity)
    q += " ORDER BY ts DESC LIMIT ?"
    args.append(min(limit, 2000))
    rows = await request.app.state.db.query(q, tuple(args))
    for r in rows:
        r["payload"] = json.loads(r.pop("payload_json") or "{}")
    return {"events": rows}


@router.get("/api/samples")
async def samples(
    request: Request, channel: str, from_ts: int = 0, to_ts: int | None = None, limit: int = 3600
):
    q = "SELECT ts, value_json FROM samples WHERE channel=? AND ts>=?"
    args: list = [channel, from_ts]
    if to_ts is not None:
        q += " AND ts<=?"
        args.append(to_ts)
    q += " ORDER BY ts DESC LIMIT ?"
    args.append(min(limit, 20000))
    rows = await request.app.state.db.query(q, tuple(args))
    return {
        "channel": channel,
        "samples": [{"ts": r["ts"], "value": json.loads(r["value_json"])} for r in rows],
    }


@router.get("/api/assessments")
async def assessments(
    request: Request, track: str | None = None, from_ts: int = 0,
    to_ts: int | None = None, limit: int = 5000,
):
    q = "SELECT * FROM assessments WHERE ts>=?"
    args: list = [from_ts]
    if track:
        q += " AND track_id=?"
        args.append(track)
    if to_ts is not None:
        q += " AND ts<=?"
        args.append(to_ts)
    q += " ORDER BY ts ASC LIMIT ?"
    args.append(min(limit, 50000))
    rows = await request.app.state.db.query(q, tuple(args))
    for r in rows:
        r["features"] = json.loads(r.pop("features_json") or "{}")
    return {"assessments": rows}


@router.get("/api/session/summary")
async def session_summary(request: Request, session_id: int | None = None):
    return await request.app.state.db.session_summary(session_id)


@router.get("/api/sessions")
async def sessions(request: Request, limit: int = 50):
    return {"sessions": await request.app.state.db.query(
        "SELECT * FROM sessions ORDER BY started_at DESC LIMIT ?", (min(limit, 500),)
    )}


class LabelIn(BaseModel):
    label: str
    ts_start: int | None = None
    ts_end: int | None = None
    track_id: str | None = None
    notes: str | None = None


@router.post("/api/labels")
async def add_label(request: Request, body: LabelIn):
    """Record operator ground truth for a window.

    This is the input to ``scripts/calibrate_states.py`` and to the evaluation
    protocol in ``docs/evaluation.md``: the console's label control writes here
    while a subject is doing a known thing, and the fitted model is scored
    against exactly these windows.
    """
    valid = {s.value for s in State}
    if body.label not in valid:
        raise HTTPException(422, f"label must be one of {sorted(valid)}")
    ts_start = body.ts_start or now_ms()
    label_id = await request.app.state.db.add_label(
        body.label, ts_start, body.ts_end, body.track_id, body.notes
    )
    return {"id": label_id, "label": body.label, "ts_start": ts_start, "ts_end": body.ts_end}


@router.get("/api/labels")
async def labels(request: Request, session_id: int | None = None):
    db = request.app.state.db
    sid = session_id or db.session_id
    return {"labels": await db.query(
        "SELECT * FROM labels WHERE session_id=? ORDER BY ts_start", (sid,)
    )}


@router.get("/api/export.json")
async def export_json(request: Request, session_id: int | None = None):
    db = request.app.state.db
    sid = session_id or db.session_id
    return {
        "session_id": sid,
        "exported_at": now_ms(),
        "summary": await db.session_summary(sid),
        "events": await db.query(
            "SELECT ts, type, severity, track_id, payload_json FROM events"
            " WHERE session_id=? ORDER BY ts", (sid,)),
        "assessments": await db.query(
            "SELECT * FROM assessments WHERE session_id=? ORDER BY ts", (sid,)),
        "labels": await db.query("SELECT * FROM labels WHERE session_id=? ORDER BY ts_start", (sid,)),
        "samples": await db.query(
            "SELECT ts, channel, value_json FROM samples WHERE session_id=? ORDER BY ts", (sid,)),
    }


@router.get("/api/export.csv")
async def export_csv(request: Request, table: str = "assessments", session_id: int | None = None):
    """Flat CSV per table — the shape offline analysis actually wants."""
    db = request.app.state.db
    sid = session_id or db.session_id
    if table not in {"assessments", "events", "samples", "labels"}:
        raise HTTPException(422, "table must be assessments|events|samples|labels")
    rows = await db.query(f"SELECT * FROM {table} WHERE session_id=? ORDER BY ts_start"
                          if table == "labels" else
                          f"SELECT * FROM {table} WHERE session_id=? ORDER BY ts", (sid,))
    buf = io.StringIO()
    if rows:
        w = csv.DictWriter(buf, fieldnames=list(rows[0].keys()))
        w.writeheader()
        w.writerows(rows)
    return PlainTextResponse(
        buf.getvalue(), media_type="text/csv",
        headers={"Content-Disposition": f"attachment; filename=sentinel-{table}-{sid}.csv"},
    )


@router.websocket("/ws")
async def ws_endpoint(ws: WebSocket):
    hub = ws.app.state.hub
    await ws.accept()
    await hub.attach(ws)
    try:
        await hub.replay(ws)
        while True:
            await ws.receive_text()      # client keep-alive; content unused
    except WebSocketDisconnect:
        pass
    except Exception:
        pass
    finally:
        await hub.detach(ws)
