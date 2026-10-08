"""Analysis pipeline: normalised sensing frames → console-facing telemetry.

The adapter publishes one internal ``rf.sensing`` frame per upstream update at
the full sensing rate (~10 Hz, carrying per-node CSI vectors and the whole field
grid). This module is the only consumer of that channel. It runs the analysis
chain and re-publishes derived, bandwidth-bounded channels for the console.

Every derived channel is rate-limited independently: the console needs presence
at sensing rate, tracks a few times a second, and the field volume rarely enough
that a 3-D scene can interpolate between updates without saturating the socket.
"""

from __future__ import annotations

import logging

from sentinel.core import dsp
from sentinel.core.assessment import ModelConfig, PolicyConfig
from sentinel.core.telemetry import TelemetryHub
from sentinel.core.tracks import TrackGeometry, TrackStore

log = logging.getLogger(__name__)

#: Publication rates (Hz) per derived channel.
RATES = {
    "rf.presence": 10.0,
    "rf.vitals": 2.0,
    "rf.field": 4.0,
    "rf.nodes": 1.0,
    "track.state": 4.0,
}

#: Upper bound on field voxels forwarded to the console per update.
MAX_FIELD_VOXELS = 4096
#: Voxels below this fraction of the frame peak are dropped from the cloud —
#: they are the empty-room floor and carry no subject information.
FIELD_FLOOR_FRACTION = 0.22


class Pipeline:
    def __init__(
        self,
        hub: TelemetryHub,
        geometry: TrackGeometry | None = None,
        model_cfg: ModelConfig | None = None,
        policy_cfg: PolicyConfig | None = None,
        attribution_mode: str = "auto",
    ) -> None:
        self.hub = hub
        self.geometry = geometry or TrackGeometry()
        self.store = TrackStore(
            geometry=self.geometry,
            model_cfg=model_cfg,
            policy_cfg=policy_cfg,
            attribution_mode=attribution_mode,
        )
        self._last_pub: dict[str, int] = {}
        self.frames = 0
        self.last_frame: dict | None = None
        self.last_tracks: dict | None = None
        hub.tap(self.on_telemetry)

    # -- hub tap ------------------------------------------------------------

    async def on_telemetry(self, msg: dict) -> None:
        if msg["ch"] != "rf.sensing":
            return
        await self.process(msg["data"])

    async def process(self, frame: dict) -> None:
        self.frames += 1
        self.last_frame = frame
        ts = int(frame.get("ts_ms") or 0)

        if self._due("rf.presence", ts):
            await self.hub.publish("rf.presence", self._presence(frame), ts=ts)
        if self._due("rf.vitals", ts):
            await self.hub.publish("rf.vitals", self._vitals(frame), ts=ts)
        if self._due("rf.nodes", ts):
            await self.hub.publish("rf.nodes", self._nodes(frame), ts=ts)
        if self._due("rf.field", ts):
            field = self._field(frame)
            if field:
                await self.hub.publish("rf.field", field, ts=ts)

        summary = self.store.ingest(frame)
        self.last_tracks = summary
        if self._due("track.state", ts) or summary["closed"]:
            await self.hub.publish("track.state", summary, ts=ts)

    def _due(self, channel: str, ts_ms: int) -> bool:
        """Rate-limit on *data* time, not wall time.

        Spacing by the frame's own timestamp keeps the published stream evenly
        sampled when frames arrive in bursts, and makes an offline replay produce
        exactly the stream the live system would have produced. A clock that
        jumps backwards, or forwards by more than a minute (a reconnect to a
        source with a different epoch), resets the limiter rather than stalling
        every channel until wall time catches up.
        """
        period_ms = 1000.0 / RATES[channel]
        last = self._last_pub.get(channel)
        if last is None or ts_ms < last or ts_ms - last > 60_000:
            self._last_pub[channel] = ts_ms
            return True
        if ts_ms - last < period_ms:
            return False
        self._last_pub[channel] = ts_ms
        return True

    # -- derived channels ---------------------------------------------------

    def _presence(self, frame: dict) -> dict:
        cls = frame["classification"]
        feats = frame["features"]
        return {
            "present": cls["presence"],
            "confidence": round(cls["confidence"], 3),
            "motion_level": cls["motion_level"],
            "estimated_persons": frame.get("estimated_persons"),
            "motion_band_power": round(feats["motion_band_power"], 6),
            "breathing_band_power": round(feats["breathing_band_power"], 6),
            "dominant_freq_hz": round(feats["dominant_freq_hz"], 4),
            "mean_rssi": round(feats["mean_rssi"], 2),
            "variance": round(feats["variance"], 6),
            "change_points": feats["change_points"],
            "source": frame["source"],
            "tick": frame["tick"],
        }

    def _vitals(self, frame: dict) -> dict:
        """The upstream estimate, relayed unchanged and labelled as upstream.

        Per-subject vitals — including our own independent estimate — travel on
        ``track.state``. This channel exists so the two can be compared.
        """
        vs = dict(frame["vital_signs"])
        vs["source"] = frame["source"]
        vs["quality_verdict"] = frame.get("quality_verdict")
        vs["signal_quality_score"] = frame.get("signal_quality_score")
        vs["provenance"] = "sensing_server"
        return vs

    def _nodes(self, frame: dict) -> dict:
        by_id = {int(nf.get("node_id", 0)): nf for nf in (frame.get("node_features") or [])}
        nodes = []
        for n in frame["nodes"]:
            nf = by_id.get(n["node_id"], {})
            nf_feats = nf.get("features") or {}
            nodes.append({
                "node_id": n["node_id"],
                "rssi_dbm": round(n["rssi_dbm"], 1),
                "position": [round(v, 2) for v in n["position"]],
                "subcarrier_count": n["subcarrier_count"],
                "frame_rate_hz": round(float(nf.get("frame_rate_hz") or 0.0), 2),
                "last_seen_ms": nf.get("last_seen_ms"),
                "stale": bool(nf.get("stale", False)),
                "novelty_score": nf.get("novelty_score"),
                "motion_band_power": round(float(nf_feats.get("motion_band_power") or 0.0), 6),
                "breathing_band_power": round(float(nf_feats.get("breathing_band_power") or 0.0), 6),
                "amplitude_mean": round(dsp.mean(n["amplitude"]), 4) if n["amplitude"] else None,
                "amplitude_profile": [round(v, 3) for v in dsp.decimate(n["amplitude"], 48)],
            })
        online = [n for n in nodes if not n["stale"]]
        return {
            "nodes": nodes,
            "node_count": len(nodes),
            "online_count": len(online),
            "source": frame["source"],
            "mean_rssi": round(dsp.mean([n["rssi_dbm"] for n in nodes]), 1) if nodes else None,
        }

    def _field(self, frame: dict) -> dict | None:
        """Sparse voxel cloud for the 3-D view.

        The dense grid is thresholded against its own peak and shipped as sparse
        ``[x, y, z, intensity]`` quadruples in metres. Sparse beats dense here:
        an occupied room lights up a few percent of the volume, and the console
        renders points, not a texture.
        """
        sf = frame.get("signal_field") or {}
        dims = sf.get("grid_size") or []
        values = sf.get("values") or []
        if len(dims) != 3 or not values:
            return None
        nx, ny, nz = (int(d) for d in dims)
        if nx * ny * nz != len(values) or nx * ny * nz == 0:
            return None

        peak = max(values)
        if peak <= 0:
            return {"points": [], "peak": 0.0, "dims": [nx, ny, nz],
                    "planar": ny <= 1, "extent": list(self.geometry.extent),
                    "occupied": 0, "source": frame["source"]}

        floor = peak * FIELD_FLOOR_FRACTION
        points: list[list[float]] = []
        stride = max(1, int((nx * ny * nz / MAX_FIELD_VOXELS) ** (1 / 3)))
        for i, v in enumerate(values):
            if v < floor:
                continue
            z = i % nz
            y = (i // nz) % ny
            x = i // (nz * ny)
            if stride > 1 and (x % stride or y % stride or z % stride):
                continue
            wx, wy, wz = self.geometry.grid_to_world((x, y, z), (nx, ny, nz))
            points.append([round(wx, 3), round(wy, 3), round(wz, 3), round(v / peak, 3)])
            if len(points) >= MAX_FIELD_VOXELS:
                break

        return {
            "points": points,
            "peak": round(peak, 5),
            "dims": [nx, ny, nz],
            # A single vertical cell means this is a floor-plane map, not a
            # volume. The console renders and labels the two differently, because
            # a flat map drawn as a cloud implies height that was never measured.
            "planar": ny <= 1,
            "extent": list(self.geometry.extent),
            "origin": list(self.geometry.origin),
            "occupied": len(points),
            "floor_fraction": FIELD_FLOOR_FRACTION,
            "source": frame["source"],
        }

    # -- introspection ------------------------------------------------------

    def snapshot(self) -> dict:
        return {
            "frames": self.frames,
            "tracks": self.last_tracks["tracks"] if self.last_tracks else [],
            "subject_count": self.last_tracks["subject_count"] if self.last_tracks else 0,
            "source": self.last_frame.get("source") if self.last_frame else None,
            "last_frame_ts": self.last_frame.get("ts_ms") if self.last_frame else None,
        }
