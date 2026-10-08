"""Sensor registry: config type string -> builder. Adding a sensor modality =
adding a module in this package and one line here."""

from __future__ import annotations

from sentinel.sensors.base import Sensor


def build_sensors(settings) -> list[Sensor]:
    from sentinel.sensors import ruview_rf

    builders = {
        "ruview_rf": ruview_rf.build,
        # "esp32cam": esp32cam.build,   # camera phase (later session)
    }
    out: list[Sensor] = []
    for cfg in settings.sensors:
        if not cfg.enabled:
            continue
        try:
            out.append(builders[cfg.type](cfg, settings))
        except KeyError:
            raise ValueError(f"unknown sensor type: {cfg.type}") from None
    return out
