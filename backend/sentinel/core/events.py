"""Event derivation: continuous telemetry → the discrete operational log.

Every event is something an operator would want in an after-action review:
a subject appeared, a behavioural state changed, the approach advisory changed,
a node dropped, the data source stopped being real hardware.

Two rules keep the log readable:

* **hysteresis** — continuous quantities must cross separated enter/exit
  thresholds, so a signal hovering at a boundary produces one event, not fifty.
* **transitions only** — a state that persists is not re-logged. The current
  value is always available on its live channel; the log records change.
"""

from __future__ import annotations

from sentinel.core.telemetry import TelemetryHub

PRESENCE_ENTER = 0.65
PRESENCE_EXIT = 0.35
EMA_ALPHA = 0.3

#: Advisory decision → event severity. An advisory becoming more restrictive is
#: operationally urgent; becoming permissive is not.
ADVISORY_SEVERITY = {
    "DO_NOT_APPROACH": "critical",
    "HOLD": "alert",
    "CAUTION": "warn",
    "INSUFFICIENT_EVIDENCE": "warn",
    "APPROACH": "info",
}

STATE_SEVERITY = {
    "DISTRESSED": "critical",
    "ACTIVE": "alert",
    "ALERT_STILL": "warn",
    "RESTING": "info",
    "ASLEEP": "info",
}


class EventEngine:
    def __init__(self, hub: TelemetryHub) -> None:
        self.hub = hub
        self.presence_ema: float | None = None
        self.person_present = False
        self.track_states: dict[str, str | None] = {}
        self.track_advisories: dict[str, str] = {}
        self.track_resp_lock: dict[str, bool] = {}
        self.source: str | None = None
        self.stale_nodes: set[int] = set()
        hub.tap(self.on_telemetry)

    async def _emit(self, type_: str, severity: str = "info", **payload) -> None:
        await self.hub.publish("events", {"type": type_, "severity": severity, **payload})

    async def on_telemetry(self, msg: dict) -> None:
        ch, data = msg["ch"], msg["data"]
        if ch == "rf.presence":
            await self._presence(data)
        elif ch == "track.state":
            await self._tracks(data)
        elif ch == "rf.nodes":
            await self._nodes(data)
        elif ch == "sensor.health":
            await self._health(data)

    # -- presence -----------------------------------------------------------

    async def _presence(self, data: dict) -> None:
        raw = float(data.get("confidence", 0.0)) if data.get("present") else 0.0
        self.presence_ema = (
            raw if self.presence_ema is None
            else EMA_ALPHA * raw + (1 - EMA_ALPHA) * self.presence_ema
        )
        if not self.person_present and self.presence_ema >= PRESENCE_ENTER:
            self.person_present = True
            await self._emit("PRESENCE_DETECTED", "alert",
                             confidence=round(self.presence_ema, 3),
                             motion_level=data.get("motion_level"))
        elif self.person_present and self.presence_ema <= PRESENCE_EXIT:
            self.person_present = False
            await self._emit("PRESENCE_LOST", "info", confidence=round(self.presence_ema, 3))

        source = data.get("source")
        if source and source != self.source:
            previous, self.source = self.source, source
            if previous is not None:
                severity = "warn" if source in ("simulate", "esp32:offline") else "info"
                await self._emit("SOURCE_CHANGED", severity, source=source, previous=previous)

    # -- tracks -------------------------------------------------------------

    async def _tracks(self, data: dict) -> None:
        for tr in data.get("tracks", []):
            tid = tr["id"]
            state = (tr.get("state") or {}).get("state")
            advisory = (tr.get("advisory") or {}).get("decision")
            resp = ((tr.get("vitals") or {}).get("respiration") or {})
            resp_locked = float(resp.get("confidence") or 0.0) > 0.4

            if tid not in self.track_states:
                await self._emit("TRACK_ACQUIRED", "alert", track=tid,
                                 provenance=tr.get("provenance"),
                                 position=tr.get("position"))
                self.track_states[tid] = None
                self.track_advisories[tid] = ""
                self.track_resp_lock[tid] = False

            if state and state != self.track_states.get(tid):
                await self._emit(
                    "STATE_CHANGED", STATE_SEVERITY.get(state, "info"), track=tid,
                    state=state, previous=self.track_states.get(tid),
                    confidence=(tr.get("state") or {}).get("confidence"),
                )
                self.track_states[tid] = state

            if advisory and advisory != self.track_advisories.get(tid):
                await self._emit(
                    "ADVISORY_CHANGED", ADVISORY_SEVERITY.get(advisory, "info"), track=tid,
                    decision=advisory, previous=self.track_advisories.get(tid) or None,
                    readiness_index=(tr.get("advisory") or {}).get("readiness_index"),
                    reasons=(tr.get("advisory") or {}).get("reasons"),
                )
                self.track_advisories[tid] = advisory

            if resp_locked != self.track_resp_lock.get(tid, False):
                self.track_resp_lock[tid] = resp_locked
                await self._emit(
                    "RESPIRATION_LOCKED" if resp_locked else "RESPIRATION_LOST",
                    "info", track=tid, bpm=resp.get("bpm"),
                    confidence=resp.get("confidence"), method=resp.get("method"),
                )

            if ((tr.get("vitals") or {}).get("respiration_features") or {}).get("irregular"):
                if self.track_states.get(tid) != "DISTRESSED":
                    await self._emit("RESPIRATION_IRREGULAR", "critical", track=tid,
                                     bpm=resp.get("bpm"))

        for closed in data.get("closed", []):
            await self._emit("TRACK_LOST", "info", track=closed.get("id"),
                             duration_s=closed.get("duration_s"),
                             last_state=closed.get("last_state"))
            for d in (self.track_states, self.track_advisories, self.track_resp_lock):
                d.pop(closed.get("id"), None)

    # -- infrastructure -----------------------------------------------------

    async def _nodes(self, data: dict) -> None:
        stale = {n["node_id"] for n in data.get("nodes", []) if n.get("stale")}
        for nid in stale - self.stale_nodes:
            await self._emit("NODE_STALE", "warn", node_id=nid)
        for nid in self.stale_nodes - stale:
            await self._emit("NODE_RECOVERED", "info", node_id=nid)
        self.stale_nodes = stale

    async def _health(self, data: dict) -> None:
        status = data.get("health")
        if status == "offline":
            await self._emit("SENSOR_OFFLINE", "critical", sensor=data.get("sensor"))
        elif status == "degraded":
            await self._emit("SENSOR_DEGRADED", "warn", sensor=data.get("sensor"))
        elif status == "ok" and data.get("recovered"):
            await self._emit("SENSOR_RECOVERED", "info", sensor=data.get("sensor"))
