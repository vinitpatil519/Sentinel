from __future__ import annotations

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from sentinel.api.routes import router
from sentinel.config.settings import Settings, load_settings
from sentinel.core.assessment import ModelConfig, PolicyConfig
from sentinel.core.events import EventEngine
from sentinel.core.pipeline import Pipeline
from sentinel.core.supervisor import SensorSupervisor
from sentinel.core.telemetry import TelemetryHub
from sentinel.core.tracks import TrackGeometry
from sentinel.database.db import Database
from sentinel.sensors import build_sensors

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)-7s %(name)s: %(message)s",
)
log = logging.getLogger("sentinel")

VERSION = "0.2.0"


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or load_settings()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        hub = TelemetryHub()
        db = Database(settings.db_path)
        await db.open()
        hub.tap(db.on_telemetry)

        geometry = TrackGeometry(
            extent=tuple(settings.geometry.extent),
            origin=tuple(settings.geometry.origin),
        )
        model_cfg = ModelConfig.from_dict(settings.state_model)
        policy_cfg = PolicyConfig.from_dict(settings.advisory)
        pipeline = Pipeline(
            hub,
            geometry=geometry,
            model_cfg=model_cfg,
            policy_cfg=policy_cfg,
            attribution_mode=settings.vitals_attribution,
        )
        EventEngine(hub)

        sensors = build_sensors(settings)
        supervisor = SensorSupervisor(sensors, hub)
        app.state.settings = settings
        app.state.hub, app.state.db = hub, db
        app.state.pipeline = pipeline
        app.state.policy_cfg = policy_cfg
        app.state.model_cfg = model_cfg
        app.state.sensors, app.state.supervisor = sensors, supervisor

        for s in sensors:
            await s.start(hub)
        await supervisor.start()
        log.info(
            "SENTINEL %s up — session %s, sensors: %s",
            VERSION, db.session_id, ", ".join(s.name for s in sensors) or "none",
        )
        try:
            yield
        finally:
            await supervisor.stop()
            for s in sensors:
                await s.stop()
            await db.close()

    app = FastAPI(title="SENTINEL", version=VERSION, lifespan=lifespan)
    app.add_middleware(
        CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"]
    )
    app.include_router(router)
    return app


app = create_app()
