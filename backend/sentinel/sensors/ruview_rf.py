"""RuView WiFi-CSI sensing server as a SENTINEL sensor.

The adapter owns every assumption about the upstream wire format and nothing
else: it connects, normalises, and publishes one internal frame per update.
All analysis happens downstream in ``core/pipeline.py``.

Upstream contract (``wifi-densepose-sensing-server``, crate ``src/types.rs``
``SensingUpdate``), as served on ``/ws/sensing``::

    {"type": "sensing_update", "timestamp": <epoch seconds, float>,
     "source": "esp32" | "esp32:offline" | "simulate" | "wifi",
     "tick": <u64>,
     "nodes": [{"node_id": u8, "rssi_dbm": f64, "position": [x,y,z],
                "amplitude": [f64], "subcarrier_count": usize}],
     "features": {"mean_rssi", "variance", "motion_band_power",
                  "breathing_band_power", "dominant_freq_hz",
                  "change_points", "spectral_power"},
     "classification": {"motion_level": str, "presence": bool, "confidence": f64},
     "signal_field": {"grid_size": [nx,ny,nz], "values": [f64]},
     "vital_signs": {"breathing_rate_bpm": f64?, "heart_rate_bpm": f64?,
                     "breathing_confidence", "heartbeat_confidence",
                     "signal_quality"},
     "persons": [{"id", "confidence", "keypoints": [{"name","x","y","z","confidence"}],
                  "bbox": {...}, "zone", "position": [x,y,z], "motion_score", "pose"}]?,
     "estimated_persons": usize?, "posture": str?, "pose_keypoints": [[x,y,z,c]]?,
     "node_features": [{"node_id", "features", "classification", "rssi_dbm",
                        "last_seen_ms", "frame_rate_hz", "novelty_score", "stale"}]?,
     "signal_quality_score": f64?, "quality_verdict": str?}

Ports. The server binds HTTP and the sensing WebSocket to *different* ports:
``--http-port 8080`` with ``--ws-port 8765`` natively, and 3000/3001 in the
published Docker image. ``ws_port_for`` encodes that mapping, and an explicit
``ws_url`` in config overrides it.

Authentication. When upstream auth is on, ``/ws/sensing`` is gated (ADR-272).
A native client may send the bearer directly on the upgrade, which is what we
do; the browser-only ticket exchange at ``POST /api/v1/ws-ticket`` is used as a
fallback when the direct bearer is rejected.
"""

from __future__ import annotations

import asyncio
import json
import logging
from urllib.parse import urlparse, urlunparse

import httpx
import websockets

from sentinel.core.telemetry import now_ms
from sentinel.sensors.base import Sensor

log = logging.getLogger(__name__)

WS_PATH = "/ws/sensing"
#: Fallback paths for older builds / the legacy Python sensing stack.
WS_PATH_FALLBACKS = ("/ws/sensing", "/ws", "/api/v1/stream/pose")
#: HTTP port → sensing-WebSocket port, per upstream's own UI mapping.
WS_PORT_MAP = {3000: 3001, 8080: 8765}
RECONNECT_MIN_S, RECONNECT_MAX_S = 1.0, 20.0
#: Cap on field values we forward internally; the grid is decimated for the
#: console separately, this only bounds a pathological upstream payload.
MAX_FIELD_VALUES = 32768


def ws_port_for(http_port: int) -> int:
    return WS_PORT_MAP.get(http_port, http_port)


def ws_url_for(base_url: str, path: str = WS_PATH) -> str:
    p = urlparse(base_url)
    scheme = "wss" if p.scheme == "https" else "ws"
    port = p.port or (443 if p.scheme == "https" else 80)
    host = p.hostname or "localhost"
    return urlunparse((scheme, f"{host}:{ws_port_for(port)}", path, "", "", ""))


class RuViewRF(Sensor):
    """Streaming adapter for one RuView sensing server."""

    name = "ruview_rf"

    def __init__(
        self,
        url: str,
        name: str | None = None,
        ws_url: str | None = None,
        token: str | None = None,
    ) -> None:
        super().__init__()
        if name:
            self.name = name
        self.base_url = url.rstrip("/")
        self._ws_override = ws_url
        self._token = token
        self._task: asyncio.Task | None = None
        self._ws_url: str | None = None      # sticky once a path works
        self.upstream_source: str | None = None
        self.last_error: str | None = None
        self.frames = 0
        self.unrecognised = 0

    def capabilities(self) -> set[str]:
        return {
            "rf.presence", "rf.vitals", "rf.field", "rf.nodes",
            "track.state", "rf.pose",
        }

    def describe(self) -> dict:
        return {
            "name": self.name,
            "type": "ruview_rf",
            "base_url": self.base_url,
            "ws_url": self._ws_url or self._ws_override or ws_url_for(self.base_url),
            "upstream_source": self.upstream_source,
            "frames": self.frames,
            "unrecognised": self.unrecognised,
            "last_error": self.last_error,
            "health": self.health().value,
        }

    async def start(self, hub) -> None:
        self._started = True
        self._task = asyncio.create_task(self._run(hub), name=f"sensor:{self.name}")

    async def stop(self) -> None:
        self._started = False
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except (asyncio.CancelledError, Exception):
                pass

    # -- connection ---------------------------------------------------------

    def _candidate_urls(self) -> list[str]:
        if self._ws_url:
            return [self._ws_url]
        if self._ws_override:
            return [self._ws_override]
        return [ws_url_for(self.base_url, p) for p in WS_PATH_FALLBACKS]

    async def _mint_ticket(self) -> str | None:
        if not self._token:
            return None
        try:
            async with httpx.AsyncClient(timeout=4.0) as client:
                r = await client.post(
                    f"{self.base_url}/api/v1/ws-ticket",
                    headers={"Authorization": f"Bearer {self._token}"},
                )
                if r.status_code == 200:
                    return r.json().get("ticket")
        except Exception as e:  # pragma: no cover - network dependent
            log.debug("%s ticket mint failed: %s", self.name, e)
        return None

    async def _run(self, hub) -> None:
        backoff = RECONNECT_MIN_S
        while True:
            connected = False
            for url in self._candidate_urls():
                headers = {"Authorization": f"Bearer {self._token}"} if self._token else {}
                try:
                    async with websockets.connect(
                        url,
                        open_timeout=5,
                        ping_interval=20,
                        max_size=8 * 1024 * 1024,
                        additional_headers=headers or None,
                    ) as ws:
                        self._ws_url = url
                        self.last_error = None
                        connected = True
                        backoff = RECONNECT_MIN_S
                        log.info("%s connected: %s", self.name, url)
                        async for raw in ws:
                            self.mark_data()
                            await self._handle(hub, raw)
                except asyncio.CancelledError:
                    raise
                except Exception as e:
                    self.last_error = f"{type(e).__name__}: {e}"
                    log.debug("%s %s: %s", self.name, url, e)
                    if "401" in str(e) or "403" in str(e):
                        ticket = await self._mint_ticket()
                        if ticket:
                            self._ws_url = f"{url}?ticket={ticket}"
                            continue
                    if connected:
                        # Lost an established link: retry the same URL, do not
                        # re-probe the fallbacks.
                        break
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, RECONNECT_MAX_S)

    async def _handle(self, hub, raw: str | bytes) -> None:
        try:
            msg = json.loads(raw)
        except Exception:
            return
        if not isinstance(msg, dict):
            return
        frame = self.normalize(msg)
        if frame is None:
            self.unrecognised += 1
            await hub.publish("rf.raw", {"upstream": _truncate(msg)})
            return
        self.frames += 1
        self.upstream_source = frame.get("source")
        await hub.publish("rf.sensing", frame, ts=frame["ts_ms"])

    # -- normalisation ------------------------------------------------------

    def normalize(self, msg: dict) -> dict | None:
        """Map an upstream ``SensingUpdate`` to the internal frame shape.

        Returns ``None`` for a payload that carries no sensing content, so the
        caller can route it to ``rf.raw`` where it is visible in the console's
        diagnostics rather than silently dropped.
        """
        has_core = any(k in msg for k in ("classification", "features", "nodes", "signal_field"))
        if not has_core:
            return None

        ts_ms = _ts_ms(msg.get("timestamp"))
        cls = msg.get("classification") or {}
        feats = msg.get("features") or {}

        nodes = []
        for n in msg.get("nodes") or []:
            if not isinstance(n, dict):
                continue
            amps = [float(a) for a in (n.get("amplitude") or []) if _is_num(a)]
            nodes.append({
                "node_id": int(n.get("node_id", 0)),
                "rssi_dbm": _num(n.get("rssi_dbm"), 0.0),
                "position": _vec3(n.get("position")),
                "amplitude": amps,
                "subcarrier_count": int(n.get("subcarrier_count") or len(amps)),
            })

        field = msg.get("signal_field") or {}
        values = [float(v) for v in (field.get("values") or [])[:MAX_FIELD_VALUES] if _is_num(v)]
        grid = [int(g) for g in (field.get("grid_size") or []) if _is_num(g)]

        persons = []
        for p in msg.get("persons") or []:
            if not isinstance(p, dict):
                continue
            persons.append({
                "id": p.get("id"),
                "confidence": _num(p.get("confidence"), 0.0),
                "keypoints": [
                    {
                        "name": str(k.get("name", "")),
                        "x": _num(k.get("x"), 0.0),
                        "y": _num(k.get("y"), 0.0),
                        "z": _num(k.get("z"), 0.0),
                        "confidence": _num(k.get("confidence"), 0.0),
                    }
                    for k in (p.get("keypoints") or []) if isinstance(k, dict)
                ],
                "bbox": p.get("bbox"),
                "zone": p.get("zone"),
                "position": _vec3(p.get("position")),
                "motion_score": _num(p.get("motion_score"), 0.0),
                "pose": p.get("pose"),
            })

        # `pose_keypoints` is the volume-wide skeleton (no person id) some builds
        # send instead of `persons`; promote it to a single detection so the
        # console renders identically against both.
        if not persons and msg.get("pose_keypoints"):
            kps = [
                {"name": f"kp{i}", "x": _num(k[0], 0.0), "y": _num(k[1], 0.0),
                 "z": _num(k[2], 0.0), "confidence": _num(k[3], 0.0) if len(k) > 3 else 0.0}
                for i, k in enumerate(msg["pose_keypoints"])
                if isinstance(k, (list, tuple)) and len(k) >= 3
            ]
            if any(k["confidence"] > 0.05 for k in kps):
                persons = [{
                    "id": 0, "confidence": _num(cls.get("confidence"), 0.0),
                    "keypoints": kps, "bbox": None, "zone": "volume",
                    "position": [0.0, 0.0, 0.0], "motion_score": 0.0,
                    "pose": msg.get("posture"),
                }]

        vs = msg.get("vital_signs") or {}
        return {
            "ts_ms": ts_ms,
            "sensor": self.name,
            "source": str(msg.get("source") or "unknown"),
            "tick": int(msg.get("tick") or 0),
            "nodes": nodes,
            "features": {
                "mean_rssi": _num(feats.get("mean_rssi"), 0.0),
                "variance": _num(feats.get("variance"), 0.0),
                "motion_band_power": _num(feats.get("motion_band_power"), 0.0),
                "breathing_band_power": _num(feats.get("breathing_band_power"), 0.0),
                "dominant_freq_hz": _num(feats.get("dominant_freq_hz"), 0.0),
                "change_points": int(feats.get("change_points") or 0),
                "spectral_power": _num(feats.get("spectral_power"), 0.0),
            },
            "classification": {
                "motion_level": str(cls.get("motion_level") or "unknown"),
                "presence": bool(cls.get("presence")),
                "confidence": _num(cls.get("confidence"), 0.0),
            },
            "signal_field": {"grid_size": grid, "values": values},
            "vital_signs": {
                "breathing_rate_bpm": _opt(vs.get("breathing_rate_bpm")),
                "heart_rate_bpm": _opt(vs.get("heart_rate_bpm")),
                "breathing_confidence": _num(vs.get("breathing_confidence"), 0.0),
                "heartbeat_confidence": _num(vs.get("heartbeat_confidence"), 0.0),
                "signal_quality": _num(vs.get("signal_quality"), 0.0),
            },
            "persons": persons,
            "estimated_persons": _opt_int(msg.get("estimated_persons")),
            "posture": msg.get("posture"),
            "node_features": msg.get("node_features") or [],
            "signal_quality_score": _opt(msg.get("signal_quality_score")),
            "quality_verdict": msg.get("quality_verdict"),
        }


# ── coercion helpers (upstream schema is beta; never trust a field's type) ───


def _is_num(v) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def _num(v, default: float) -> float:
    return float(v) if _is_num(v) else default


def _opt(v) -> float | None:
    return float(v) if _is_num(v) else None


def _opt_int(v) -> int | None:
    return int(v) if _is_num(v) else None


def _vec3(v) -> list[float]:
    if isinstance(v, (list, tuple)):
        out = [float(x) if _is_num(x) else 0.0 for x in v[:3]]
        return out + [0.0] * (3 - len(out))
    return [0.0, 0.0, 0.0]


def _ts_ms(ts) -> int:
    """Upstream sends epoch seconds as a float; tolerate ms and missing values."""
    if not _is_num(ts):
        return now_ms()
    ts = float(ts)
    if ts > 1e11:        # already milliseconds
        return int(ts)
    if ts < 1e6:         # a monotonic tick, not a wall clock
        return now_ms()
    return int(ts * 1000)


def _truncate(msg: dict, limit: int = 2000) -> dict:
    s = json.dumps(msg)[:limit]
    return {"preview": s, "keys": sorted(msg.keys())}


def build(cfg, settings) -> RuViewRF:
    return RuViewRF(
        url=cfg.url or settings.ruview_url,
        name=cfg.name,
        ws_url=cfg.ws_url,
        token=cfg.token or settings.ruview_token,
    )
