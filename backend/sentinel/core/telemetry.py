"""Telemetry hub: channel-multiplexed fan-out to internal consumers and clients.

Envelope (JSON text frames): ``{"ch": ..., "ts": <epoch_ms>, "seq": n, "data": {...}}``

Channels
--------
``rf.sensing``   full normalised sensing frame — **internal only**, never fanned
                 out to browsers (it carries per-node CSI amplitude vectors and
                 the full field grid at 10 Hz).
``rf.presence``  presence / motion classification, volume-wide.
``rf.vitals``    the sensing server's own vital-sign estimate, relayed as-is.
``rf.field``     decimated signal-field volume for the 3-D view.
``rf.nodes``     per-node link health, rate and features.
``track.state``  per-subject tracks with vitals, behavioural state and advisory.
``events``       derived discrete events.
``sensor.health``sensor health transitions.
``rf.raw``       upstream payloads the adapter did not recognise.

Backpressure: a client that cannot keep up is dropped rather than allowed to
stall the publisher — a console that has stopped consuming is already useless,
and blocking the hub would stall sensing for everyone.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from collections import defaultdict, deque
from typing import Any, Awaitable, Callable

log = logging.getLogger(__name__)

Subscriber = Callable[[dict], Awaitable[None]]

#: Channels that exist only for internal consumers.
INTERNAL_CHANNELS = {"rf.sensing"}

#: Channels replayed to a client on connect, and how many messages of each.
REPLAY_ON_CONNECT = {
    "rf.presence": 60,
    "rf.vitals": 30,
    "rf.field": 2,
    "rf.nodes": 2,
    "track.state": 2,
    "events": 40,
    "sensor.health": 6,
}

SEND_TIMEOUT_S = 2.0


def now_ms() -> int:
    return int(time.time() * 1000)


class TelemetryHub:
    def __init__(self, buffer: int = 600) -> None:
        self._ws_clients: set[Any] = set()
        self._taps: list[Subscriber] = []
        self._recent: dict[str, deque[dict]] = {}
        self._buffer = buffer
        self._seq = 0
        self._counts: dict[str, int] = defaultdict(int)
        self._rate_marks: dict[str, deque[float]] = defaultdict(lambda: deque(maxlen=50))
        self._lock = asyncio.Lock()
        self.dropped_clients = 0

    # -- wiring -------------------------------------------------------------

    def tap(self, fn: Subscriber) -> None:
        self._taps.append(fn)

    def recent(self, channel: str, n: int = 300) -> list[dict]:
        return list(self._recent.get(channel, []))[-n:]

    def stats(self) -> dict:
        out = {}
        for ch, marks in self._rate_marks.items():
            rate = 0.0
            if len(marks) >= 2:
                span = marks[-1] - marks[0]
                rate = (len(marks) - 1) / span if span > 0 else 0.0
            out[ch] = {"count": self._counts[ch], "rate_hz": round(rate, 2)}
        return {"channels": out, "clients": len(self._ws_clients), "dropped_clients": self.dropped_clients}

    # -- publish ------------------------------------------------------------

    async def publish(self, channel: str, data: dict, ts: int | None = None) -> None:
        self._seq += 1
        msg = {"ch": channel, "ts": ts or now_ms(), "seq": self._seq, "data": data}
        self._counts[channel] += 1
        self._rate_marks[channel].append(time.monotonic())
        if channel not in INTERNAL_CHANNELS:
            self._recent.setdefault(channel, deque(maxlen=self._buffer)).append(msg)

        for tap in self._taps:
            try:
                await tap(msg)
            except Exception:
                log.exception("telemetry tap failed on channel %s", channel)

        if channel in INTERNAL_CHANNELS or not self._ws_clients:
            return
        text = json.dumps(msg, separators=(",", ":"))
        dead = []
        for ws in list(self._ws_clients):
            try:
                await asyncio.wait_for(ws.send_text(text), timeout=SEND_TIMEOUT_S)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self._ws_clients.discard(ws)
            self.dropped_clients += 1

    # -- clients ------------------------------------------------------------

    async def attach(self, ws: Any) -> None:
        async with self._lock:
            self._ws_clients.add(ws)

    async def detach(self, ws: Any) -> None:
        async with self._lock:
            self._ws_clients.discard(ws)

    async def replay(self, ws: Any) -> None:
        """Send recent context so panels render immediately instead of empty."""
        for ch, n in REPLAY_ON_CONNECT.items():
            for msg in self.recent(ch, n):
                await ws.send_text(json.dumps(msg, separators=(",", ":")))
