"""Watches sensor health and publishes transitions to the hub."""

from __future__ import annotations

import asyncio

from sentinel.core.telemetry import TelemetryHub
from sentinel.sensors.base import Health, Sensor

POLL_S = 1.0


class SensorSupervisor:
    def __init__(self, sensors: list[Sensor], hub: TelemetryHub) -> None:
        self.sensors = sensors
        self.hub = hub
        self._last: dict[str, Health] = {}
        self._task: asyncio.Task | None = None

    def snapshot(self) -> dict[str, str]:
        return {s.name: s.health().value for s in self.sensors}

    async def start(self) -> None:
        self._task = asyncio.create_task(self._loop())

    async def stop(self) -> None:
        if self._task:
            self._task.cancel()

    async def _loop(self) -> None:
        while True:
            for s in self.sensors:
                h = s.health()
                prev = self._last.get(s.name)
                if h != prev:
                    self._last[s.name] = h
                    await self.hub.publish("sensor.health", {
                        "sensor": s.name,
                        "health": h.value,
                        "recovered": prev in (Health.OFFLINE, Health.DEGRADED) and h == Health.OK,
                    })
            await asyncio.sleep(POLL_S)
