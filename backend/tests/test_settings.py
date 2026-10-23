"""Configuration layering: default.yaml ← local.yaml ← environment."""

from __future__ import annotations

from sentinel.config.settings import load_settings
from sentinel.core.assessment import PolicyConfig


def test_environment_overrides_one_advisory_key_and_keeps_the_rest(monkeypatch):
    monkeypatch.setenv("SENTINEL_ADVISORY__EVIDENCE_GATE", "false")
    settings = load_settings()
    cfg = PolicyConfig.from_dict(settings.advisory)
    assert cfg.evidence_gate is False
    # The YAML thresholds survive the override.
    assert settings.advisory["hold_max_arousal"] == 0.70


def test_evidence_gate_is_on_by_default(monkeypatch):
    monkeypatch.delenv("SENTINEL_ADVISORY__EVIDENCE_GATE", raising=False)
    assert PolicyConfig.from_dict(load_settings().advisory).evidence_gate is True
