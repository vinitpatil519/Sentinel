"""Layered configuration: default.yaml ← local.yaml ← environment.

Everything the behavioural-state model and the advisory policy depend on is
configuration, not code, so a calibration run can replace the model without a
redeploy and a reviewer can see the exact parameters a recorded session used.
"""

from __future__ import annotations

import os
from pathlib import Path

import yaml
from pydantic import BaseModel, Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class SensorConfig(BaseModel):
    type: str                       # "ruview_rf" | future modalities
    name: str | None = None         # instance name; defaults to type
    url: str | None = None          # sensing-server HTTP base
    ws_url: str | None = None       # explicit WebSocket override
    token: str | None = None        # bearer, when upstream auth is on
    enabled: bool = True
    capabilities: list[str] | None = None


class GeometryConfig(BaseModel):
    """Physical extent the signal-field grid maps onto, in metres.

    ``extent`` is the sensing volume the nodes bound; ``origin`` is its centre
    in the console's world frame. The console renders the room from these, so
    a wrong extent shows as a subject standing outside the walls — which is the
    intended failure mode: visibly wrong beats silently wrong.
    """

    extent: tuple[float, float, float] = (6.0, 2.5, 6.0)
    origin: tuple[float, float, float] = (0.0, 0.0, 0.0)
    wall_axis: str = "x"            # the wall the operator is sensing through
    wall_offset_m: float = -1.5     # its position along that axis


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="SENTINEL_", env_nested_delimiter="__")

    host: str = "0.0.0.0"
    port: int = 8010
    db_path: Path = Path("data/sentinel.db")
    sensors: list[SensorConfig] = [SensorConfig(type="ruview_rf")]

    #: RuView sensing-server HTTP base. The sensing WebSocket port is derived
    #: (3000→3001, 8080→8765) unless a sensor sets ``ws_url``.
    ruview_url: str = os.environ.get("RUVIEW_URL", "http://localhost:3000")
    ruview_token: str | None = os.environ.get("RUVIEW_TOKEN")

    geometry: GeometryConfig = Field(default_factory=GeometryConfig)

    #: Vitals attribution when more than one subject is present:
    #: "auto"   — attribute by nearest node, discounted and labelled;
    #: "strict" — refuse to attribute, report vitals as unattributed.
    vitals_attribution: str = "auto"

    #: Behavioural-state model (emissions, transitions) — see docs/assessment-model.md.
    #: Replaced wholesale by ``scripts/calibrate_states.py`` output.
    state_model: dict = Field(default_factory=dict)
    #: Approach-advisory thresholds.
    advisory: dict = Field(default_factory=dict)

    @classmethod
    def settings_customise_sources(cls, settings_cls, init_settings, env_settings, dotenv_settings, file_secret_settings):
        # The YAML files arrive as init kwargs. Put the environment above them,
        # as the layering promises, so a deployment can flip a single key
        # (SENTINEL_ADVISORY__EVIDENCE_GATE=false) without a config file; the
        # sources are deep-merged, so the rest of the section is kept.
        return env_settings, init_settings, dotenv_settings, file_secret_settings


def load_settings(config_file: str | Path | None = None) -> Settings:
    cfg_dir = Path(__file__).parent
    merged: dict = {}
    files = [cfg_dir / "default.yaml", cfg_dir / "local.yaml"]
    if config_file:
        files.append(Path(config_file))
    for f in files:
        if f.exists():
            loaded = yaml.safe_load(f.read_text()) or {}
            for key, value in loaded.items():
                # A section in local.yaml amends the default one, not replaces it.
                if isinstance(value, dict) and isinstance(merged.get(key), dict):
                    merged[key] = {**merged[key], **value}
                else:
                    merged[key] = value
    model_path = cfg_dir / "state_model.yaml"
    if model_path.exists() and not merged.get("state_model"):
        merged["state_model"] = yaml.safe_load(model_path.read_text()) or {}
    return Settings(**merged)
