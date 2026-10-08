"""Sensor abstraction — the only layer that knows hardware.

Adding a new modality (ESP32-CAM, RTSP, thermal, mmWave radar…) means adding
one module here that subclasses Sensor; nothing outside sensors/ changes.
Panels on the dashboard mount from the merged capability manifest.
"""

from __future__ import annotations

import time
from abc import ABC, abstractmethod
from enum import Enum


class Health(str, Enum):
    OK = "ok"
    DEGRADED = "degraded"
    OFFLINE = "offline"


# Staleness watchdog: no data for this long → DEGRADED; 3x → OFFLINE.
STALE_AFTER_S = 5.0


class Sensor(ABC):
    """A source of telemetry. Emits into the TelemetryHub it is started with."""

    #: unique instance name from config (e.g. "ruview_rf")
    name: str = "sensor"

    def __init__(self) -> None:
        self._last_data_ts: float = 0.0
        self._started = False

    @abstractmethod
    def capabilities(self) -> set[str]:
        """Channels this sensor can emit, e.g. {"rf.presence", "rf.breathing"}."""

    @abstractmethod
    async def start(self, hub) -> None:
        """Begin emitting telemetry into ``hub`` (a TelemetryHub). Non-blocking:
        spawn tasks and return."""

    @abstractmethod
    async def stop(self) -> None:
        ...

    def describe(self) -> dict:
        """Diagnostics for ``GET /api/sensors``. Overridden per modality."""
        return {"name": self.name, "type": type(self).__name__, "health": self.health().value}

    def mark_data(self) -> None:
        self._last_data_ts = time.monotonic()

    def health(self) -> Health:
        if not self._started:
            return Health.OFFLINE
        age = time.monotonic() - self._last_data_ts
        if self._last_data_ts == 0.0 or age > 3 * STALE_AFTER_S:
            return Health.OFFLINE
        if age > STALE_AFTER_S:
            return Health.DEGRADED
        return Health.OK
