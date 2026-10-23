"""Behavioural-state estimation and approach advisory.

This is the analytical core of SENTINEL and the part that is not merely a relay
of upstream sensing. It answers the operational question the platform exists for:

    given only through-wall RF measurements of a person we cannot see, how
    aroused are they, and is now a defensible moment to approach?

Two layers, deliberately separated so each can be evaluated on its own:

1. **State model** (`BehaviouralStateModel`) — a hidden Markov model over five
   behavioural states with diagonal-covariance Gaussian emissions on respiration
   and motion features. Causal forward filtering only (no smoothing over future
   frames), because the operator needs the answer now. Emission parameters are
   configuration, not code: the backend loads `config/state_model.yaml`, which
   `scripts/fit_reference_model.py` fits on the reference simulation and
   `scripts/calibrate_states.py` refits on labelled recordings from a real site.
   The in-code defaults below are the fallback when no such file exists, and
   their *shape* follows respiratory physiology — rate and breath-to-breath
   variability both fall in NREM sleep and both rise with arousal.

2. **Advisory policy** (`ApproachPolicy`) — a deterministic, auditable mapping
   from the state posterior plus continuous modifiers to one of four decisions.
   It is intentionally *not* learned: a safety-relevant recommendation must be
   explainable line by line, and every decision carries the reason codes that
   produced it.

Safety posture, applied throughout:

* Missing or weak evidence never produces a permissive answer. The default is
  ``INSUFFICIENT_EVIDENCE``, and a green ``APPROACH`` requires positive evidence
  of sustained low arousal.
* Escalation (towards "do not approach") is immediate; de-escalation requires a
  dwell period. An operator should never see the advisory flicker green while a
  subject is waking up.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field, replace
from enum import Enum

from sentinel.core import dsp
from sentinel.core.vitals import VitalsSnapshot


class State(str, Enum):
    ASLEEP = "ASLEEP"
    RESTING = "RESTING"
    ALERT_STILL = "ALERT_STILL"
    ACTIVE = "ACTIVE"
    DISTRESSED = "DISTRESSED"


STATES: tuple[State, ...] = (
    State.ASLEEP, State.RESTING, State.ALERT_STILL, State.ACTIVE, State.DISTRESSED,
)

#: Operator-facing one-liners, shown in the console next to the state.
STATE_LABEL = {
    State.ASLEEP: "Dormant — sleep-consistent respiration, no volitional motion",
    State.RESTING: "Awake, relaxed — regular respiration, occasional micro-motion",
    State.ALERT_STILL: "Awake, holding still — elevated respiratory variability",
    State.ACTIVE: "Moving — sustained body motion",
    State.DISTRESSED: "Irregular — erratic or arrested respiration",
}

#: Arousal weight per state: the expected reflex readiness of a subject in it.
#: These are the numbers that turn a state posterior into an approach risk, so
#: they are stated explicitly rather than buried in a threshold.
AROUSAL = {
    State.ASLEEP: 0.05,
    State.RESTING: 0.35,
    State.ALERT_STILL: 0.78,
    State.ACTIVE: 0.95,
    State.DISTRESSED: 0.85,
}


class Decision(str, Enum):
    APPROACH = "APPROACH"
    CAUTION = "CAUTION"
    HOLD = "HOLD"
    DO_NOT_APPROACH = "DO_NOT_APPROACH"
    INSUFFICIENT_EVIDENCE = "INSUFFICIENT_EVIDENCE"


#: Ordered by permissiveness. Used by the hysteresis rule: moving *down* this
#: list (more restrictive) is immediate, moving up requires dwell.
DECISION_RANK = {
    Decision.APPROACH: 0,
    Decision.CAUTION: 1,
    Decision.HOLD: 2,
    Decision.INSUFFICIENT_EVIDENCE: 3,
    Decision.DO_NOT_APPROACH: 4,
}


# ── feature vector ──────────────────────────────────────────────────────────

#: Feature order used by the emission model. A feature whose value is unknown
#: is dropped from the likelihood for that frame (naive-Bayes factorisation)
#: rather than imputed, so a missing heart rate weakens rather than biases.
FEATURES = ("respiration_bpm", "rrv_cv", "motion_index", "burst_rate", "amplitude_cv")


@dataclass
class FeatureVector:
    respiration_bpm: float | None = None
    rrv_cv: float | None = None
    motion_index: float | None = None
    burst_rate: float | None = None
    amplitude_cv: float | None = None
    irregular: bool = False
    evidence: float = 0.0       # 0..1 — how much of the vector is trustworthy

    def get(self, name: str) -> float | None:
        return getattr(self, name)

    def as_dict(self) -> dict:
        return {
            "respiration_bpm": self.respiration_bpm,
            "rrv_cv": self.rrv_cv,
            "motion_index": self.motion_index,
            "burst_rate": self.burst_rate,
            "amplitude_cv": self.amplitude_cv,
            "irregular": self.irregular,
            "evidence": round(self.evidence, 3),
        }


def features_from_vitals(v: VitalsSnapshot) -> FeatureVector:
    resp_ok = v.respiration.confidence > 0.0 and v.respiration.bpm is not None
    timing_ok = v.features.interval_count >= 4
    # A motion window is "observed" once it has run long enough to establish a
    # quiet floor; before that the index is not yet referenced to anything.
    motion_ok = v.motion.observed_s >= 20.0

    # Two independent evidence sources. Respiration carries more weight — it is
    # what separates sleep from deliberate stillness, which motion cannot do —
    # but motion alone is sufficient evidence for the high-arousal states, and
    # during heavy movement respiration is legitimately unmeasurable. Making
    # evidence depend on respiration alone would blind the model exactly when
    # the subject is most active.
    evidence = (
        0.45 * (v.respiration.confidence if resp_ok else 0.0)
        + 0.20 * (1.0 if timing_ok else 0.0)
        + 0.25 * (1.0 if motion_ok else 0.0)
        + 0.10 * dsp.clamp(v.signal_quality, 0.0, 1.0)
    )
    if v.attribution == "unattributed":
        # A vitals stream we cannot tie to this individual is not evidence
        # about this individual.
        evidence *= 0.35
    elif v.attribution == "nearest_node":
        evidence *= 0.8

    return FeatureVector(
        respiration_bpm=v.respiration.bpm if resp_ok else None,
        rrv_cv=v.features.rrv_cv if timing_ok else None,
        motion_index=v.motion.index if motion_ok else None,
        burst_rate=v.motion.burst_rate_per_min if motion_ok else None,
        amplitude_cv=v.features.amplitude_cv if timing_ok else None,
        irregular=v.features.irregular,
        evidence=dsp.clamp(evidence, 0.0, 1.0),
    )


# ── emission / transition parameters ────────────────────────────────────────


#: Mahalanobis distance at which a feature's contribution stops growing. Beyond
#: ~4 sd the reading is an outlier, and the difference between "4 sd out" and
#: "26 sd out" is not additional information about which state is true — it is a
#: sensor glitch or a feature the model was never fitted over. Left unbounded, a
#: single such value contributes hundreds of nats and overwhelms every prior and
#: every other feature at once. This is a robust (Huberised) likelihood.
Z_CLAMP = 4.0


@dataclass
class Gaussian:
    mean: float
    sd: float

    def log_pdf(self, x: float) -> float:
        z = (x - self.mean) / self.sd
        z = Z_CLAMP if z > Z_CLAMP else -Z_CLAMP if z < -Z_CLAMP else z
        return -0.5 * z * z - math.log(self.sd) - 0.5 * math.log(2 * math.pi)


@dataclass
class StateParams:
    """Diagonal Gaussian emission for one state, plus its expected dwell."""

    emissions: dict[str, Gaussian]
    min_dwell_s: float = 5.0

    def log_likelihood(self, fv: FeatureVector) -> tuple[float, int]:
        total, used = 0.0, 0
        for name in FEATURES:
            x = fv.get(name)
            g = self.emissions.get(name)
            if x is None or g is None:
                continue
            total += g.log_pdf(float(x))
            used += 1
        return total, used


def default_params() -> dict[State, StateParams]:
    """Default emission parameters. Replaced by a fitted model when one exists.

    Shape comes from respiratory physiology: rate and breath-to-breath
    variability are both lowest in NREM sleep, rise through quiet wakefulness,
    and rise again with alertness — while *deliberate stillness under alert*
    shows near-sleep body motion with clearly awake variability. That last pair
    (ASLEEP vs ALERT_STILL) is the discrimination the whole platform turns on,
    and motion alone cannot make it; variability can.

    The numbers are the measured feature distributions of this estimator chain
    over the reference scenarios in ``sentinel.simulation`` — because the
    features are estimator outputs (a 45 s spectral window, a quiet-floor motion
    index), not physiological quantities in textbook units, so literature values
    are not directly transferable to them. They are therefore a *starting point
    for a deployment, not a calibrated model of a room*: run
    ``scripts/calibrate_states.py`` against labelled recordings from the actual
    site, and ``scripts/evaluate_model.py`` to score the result. See
    ``docs/assessment-model.md`` §3 for the full provenance argument.
    """
    return {
        State.ASLEEP: StateParams(
            {
                "respiration_bpm": Gaussian(12.2, 1.6),
                "rrv_cv": Gaussian(0.080, 0.045),
                "motion_index": Gaussian(1.0, 3.0),
                "burst_rate": Gaussian(0.6, 0.9),
                "amplitude_cv": Gaussian(0.17, 0.10),
            },
            min_dwell_s=30.0,
        ),
        State.RESTING: StateParams(
            {
                "respiration_bpm": Gaussian(14.7, 1.8),
                "rrv_cv": Gaussian(0.140, 0.055),
                "motion_index": Gaussian(4.0, 6.0),
                "burst_rate": Gaussian(1.2, 0.8),
                "amplitude_cv": Gaussian(0.26, 0.13),
            },
            min_dwell_s=15.0,
        ),
        State.ALERT_STILL: StateParams(
            {
                "respiration_bpm": Gaussian(17.0, 2.6),
                "rrv_cv": Gaussian(0.230, 0.075),
                "motion_index": Gaussian(7.0, 8.0),
                "burst_rate": Gaussian(1.7, 0.9),
                "amplitude_cv": Gaussian(0.37, 0.15),
            },
            min_dwell_s=10.0,
        ),
        State.ACTIVE: StateParams(
            {
                "respiration_bpm": Gaussian(16.5, 3.0),
                "rrv_cv": Gaussian(0.220, 0.080),
                "motion_index": Gaussian(45.0, 14.0),
                "burst_rate": Gaussian(2.0, 1.2),
                "amplitude_cv": Gaussian(0.55, 0.16),
            },
            min_dwell_s=4.0,
        ),
        State.DISTRESSED: StateParams(
            {
                "respiration_bpm": Gaussian(18.5, 3.5),
                "rrv_cv": Gaussian(0.320, 0.110),
                "motion_index": Gaussian(13.0, 10.0),
                "burst_rate": Gaussian(3.1, 1.6),
                "amplitude_cv": Gaussian(0.78, 0.24),
            },
            min_dwell_s=8.0,
        ),
    }


def default_transitions() -> dict[State, dict[State, float]]:
    """Row-stochastic transition matrix at the model's nominal 2 Hz update rate.

    Self-transitions dominate (behavioural states persist for seconds to
    minutes); sleep is the stickiest and cannot jump straight to ACTIVE without
    passing through an arousal state, which is both physiologically right and
    the property that keeps the advisory from flickering green.
    """
    t = {
        State.ASLEEP:      {State.ASLEEP: 0.970, State.RESTING: 0.020, State.ALERT_STILL: 0.008, State.ACTIVE: 0.001, State.DISTRESSED: 0.001},
        State.RESTING:     {State.ASLEEP: 0.020, State.RESTING: 0.930, State.ALERT_STILL: 0.035, State.ACTIVE: 0.012, State.DISTRESSED: 0.003},
        State.ALERT_STILL: {State.ASLEEP: 0.002, State.RESTING: 0.045, State.ALERT_STILL: 0.900, State.ACTIVE: 0.048, State.DISTRESSED: 0.005},
        State.ACTIVE:      {State.ASLEEP: 0.001, State.RESTING: 0.020, State.ALERT_STILL: 0.060, State.ACTIVE: 0.910, State.DISTRESSED: 0.009},
        State.DISTRESSED:  {State.ASLEEP: 0.002, State.RESTING: 0.020, State.ALERT_STILL: 0.040, State.ACTIVE: 0.038, State.DISTRESSED: 0.900},
    }
    return t


@dataclass
class ModelConfig:
    params: dict[State, StateParams] = field(default_factory=default_params)
    transitions: dict[State, dict[State, float]] = field(default_factory=default_transitions)
    #: Likelihood temperature. <1 softens emissions so one odd frame cannot
    #: swing the posterior; the HMM prior then carries more weight.
    temperature: float = 0.55
    #: Below this evidence level the frame contributes prior only.
    min_evidence: float = 0.20
    provenance: str = "literature-seeded defaults"

    @classmethod
    def from_dict(cls, raw: dict | None) -> "ModelConfig":
        cfg = cls()
        if not raw:
            return cfg
        for name, spec in (raw.get("states") or {}).items():
            try:
                st = State(name)
            except ValueError:
                continue
            emissions = {
                f: Gaussian(float(v["mean"]), max(float(v["sd"]), 1e-3))
                for f, v in (spec.get("emissions") or {}).items()
                if f in FEATURES
            }
            if emissions:
                cfg.params[st] = StateParams(
                    emissions=emissions,
                    min_dwell_s=float(spec.get("min_dwell_s", cfg.params[st].min_dwell_s)),
                )
        for name, row in (raw.get("transitions") or {}).items():
            try:
                st = State(name)
            except ValueError:
                continue
            parsed = {State(k): float(v) for k, v in row.items() if k in State.__members__}
            total = sum(parsed.values())
            if total > 0:
                cfg.transitions[st] = {k: v / total for k, v in parsed.items()}
        if "temperature" in raw:
            cfg.temperature = float(raw["temperature"])
        if "min_evidence" in raw:
            cfg.min_evidence = float(raw["min_evidence"])
        cfg.provenance = str(raw.get("provenance", "config override"))
        return cfg


# ── the state model ─────────────────────────────────────────────────────────


@dataclass
class StateEstimate:
    state: State | None
    confidence: float
    posterior: dict[State, float]
    dwell_s: float
    evidence: float
    features_used: int

    def as_dict(self) -> dict:
        return {
            "state": self.state.value if self.state else None,
            "label": STATE_LABEL.get(self.state, "Insufficient evidence") if self.state else "Insufficient evidence",
            "confidence": round(self.confidence, 3),
            "posterior": {s.value: round(p, 4) for s, p in self.posterior.items()},
            "dwell_s": round(self.dwell_s, 1),
            "evidence": round(self.evidence, 3),
            "features_used": self.features_used,
        }


class BehaviouralStateModel:
    """Causal forward filter over the behavioural HMM, for one subject."""

    def __init__(self, config: ModelConfig | None = None) -> None:
        self.cfg = config or ModelConfig()
        n = len(STATES)
        self.posterior: dict[State, float] = {s: 1.0 / n for s in STATES}
        self._current: State | None = None
        self._entered_ms: int = 0
        self._last_ms: int = 0

    def update(self, ts_ms: int, fv: FeatureVector) -> StateEstimate:
        # 1. Predict: propagate the previous posterior through the transitions.
        predicted = {s: 0.0 for s in STATES}
        for prev, p in self.posterior.items():
            for nxt, a in self.cfg.transitions[prev].items():
                predicted[nxt] += p * a

        used = 0
        if fv.evidence >= self.cfg.min_evidence:
            # 2. Correct: weight by emission likelihood, tempered.
            logs: dict[State, float] = {}
            for s in STATES:
                ll, k = self.cfg.params[s].log_likelihood(fv)
                used = max(used, k)
                if fv.irregular and s is State.DISTRESSED:
                    ll += math.log(3.0)      # an arrested breath is strong evidence
                elif fv.irregular and s is State.ASLEEP:
                    ll -= math.log(2.0)
                logs[s] = ll * self.cfg.temperature * fv.evidence
            m = max(logs.values())
            weights = {s: math.exp(logs[s] - m) for s in STATES}
            unnorm = {s: predicted[s] * weights[s] for s in STATES}
        else:
            unnorm = predicted

        total = sum(unnorm.values())
        if total <= 0 or not math.isfinite(total):
            unnorm = {s: 1.0 / len(STATES) for s in STATES}
            total = 1.0
        self.posterior = {s: v / total for s, v in unnorm.items()}

        best = max(STATES, key=lambda s: self.posterior[s])
        conf = self.posterior[best]
        if self._last_ms == 0:
            self._entered_ms = ts_ms
        if best is not self._current:
            self._current, self._entered_ms = best, ts_ms
        self._last_ms = ts_ms
        dwell = (ts_ms - self._entered_ms) / 1000.0

        if fv.evidence < self.cfg.min_evidence:
            return StateEstimate(None, 0.0, dict(self.posterior), dwell, fv.evidence, used)
        return StateEstimate(best, conf, dict(self.posterior), dwell, fv.evidence, used)


# ── approach advisory ───────────────────────────────────────────────────────

REASON_TEXT = {
    "SLEEP_CONSISTENT": "Respiration rate and variability consistent with sleep",
    "LOW_AROUSAL_SUSTAINED": "Low arousal sustained beyond the dwell threshold",
    "RECENT_MOVEMENT": "Movement burst within the last 10 s",
    "ELEVATED_VARIABILITY": "Respiratory variability above the awake threshold",
    "RATE_RISING": "Respiration rate rising against the subject's own baseline",
    "ACTIVE_MOTION": "Sustained body motion",
    "IRREGULAR_RESPIRATION": "Irregular or arrested respiration",
    "OBSERVED_MOTION": "Measured body motion sets the readiness floor directly",
    "WEAK_EVIDENCE": "Evidence below the decision threshold",
    "NO_RESPIRATION_LOCK": "No respiration lock on this subject",
    "VITALS_UNATTRIBUTED": "Vitals cannot be attributed to this subject",
    "MULTIPLE_SUBJECTS": "More than one subject in the sensing volume",
    "DE_ESCALATION_HOLD": "Holding the previous, more restrictive advisory",
    "STATE_UNSTABLE": "State posterior unstable over the last 15 s",
}

#: The single determinant of each decision — the policy branch that produced
#: it. Reason codes list every modifier in play; the basis says which one rule
#: the decision actually rests on, so the console never shows a restriction
#: with nothing beneath it.
BASIS_TEXT = {
    "STATE_UNRESOLVED": "Behavioural state unresolved",
    "EVIDENCE_BELOW_MINIMUM": "Evidence below the decision minimum",
    "STATE_DISTRESSED": "Subject in distress — irregular or arrested respiration",
    "AROUSAL_ABOVE_HOLD": "Readiness above the HOLD limit",
    "AROUSAL_HOLD_BAND": "Readiness within the HOLD band",
    "AROUSAL_CAUTION_BAND": "Readiness within the CAUTION band",
    "SECOND_SUBJECT": "Readiness low, but a second subject is in the volume",
    "NOT_ASLEEP": "Readiness low, but the subject is awake",
    "SLEEP_DWELL_SHORT": "Asleep, but for less than the minimum dwell",
    "SLEEP_DWELL_MET": "Asleep beyond the minimum dwell, readiness low",
    "DE_ESCALATION_HOLD": "Standing advisory held until the relief persists",
}


@dataclass
class PolicyConfig:
    approach_max_arousal: float = 0.25
    caution_max_arousal: float = 0.45
    hold_max_arousal: float = 0.70
    min_evidence: float = 0.35
    approach_min_dwell_s: float = 45.0
    de_escalation_dwell_s: float = 12.0
    recent_burst_s: float = 10.0
    #: Below ``min_evidence`` the advisory is withheld as INSUFFICIENT_EVIDENCE.
    #: Turning the gate off issues the policy's best decision on any evidence,
    #: still flagged WEAK_EVIDENCE — for bench trials on hardware, where the
    #: question is what the model makes of real data. APPROACH still requires a
    #: resolved ASLEEP state, so it cannot come from an unresolved one. The
    #: evaluated safety figures hold only with the gate on.
    evidence_gate: bool = True

    @classmethod
    def from_dict(cls, raw: dict | None) -> "PolicyConfig":
        cfg = cls()
        for k, v in (raw or {}).items():
            if not hasattr(cfg, k):
                continue
            if isinstance(getattr(cfg, k), bool):
                # From the environment this arrives as text, and bool("false") is True.
                setattr(cfg, k, v if isinstance(v, bool) else str(v).strip().lower() in ("1", "true", "yes", "on"))
            else:
                setattr(cfg, k, float(v))
        return cfg


@dataclass
class Advisory:
    decision: Decision
    readiness_index: float          # 0..1 estimated reflex readiness
    confidence: float
    reasons: list[str]
    quiet_window_s: float | None    # predicted seconds of continued low arousal
    stability: float                # 0..1 posterior stability over the window
    basis: str = ""                 # BASIS_TEXT key: the rule the decision rests on
    held_s: float = 0.0             # seconds the standing decision has stood
    pending: Decision | None = None     # more permissive decision awaiting dwell
    pending_in_s: float | None = None   # seconds until it applies, if it holds

    def as_dict(self) -> dict:
        return {
            "decision": self.decision.value,
            "readiness_index": round(self.readiness_index, 3),
            "confidence": round(self.confidence, 3),
            "reasons": self.reasons,
            "reason_text": [REASON_TEXT.get(r, r) for r in self.reasons],
            "quiet_window_s": round(self.quiet_window_s, 1) if self.quiet_window_s is not None else None,
            "stability": round(self.stability, 3),
            "basis": self.basis,
            "basis_text": BASIS_TEXT.get(self.basis, self.basis),
            "held_s": round(self.held_s, 1),
            "pending": self.pending.value if self.pending is not None else None,
            "pending_in_s": round(self.pending_in_s, 1) if self.pending_in_s is not None else None,
        }


class ApproachPolicy:
    """Deterministic advisory layer with safety-biased hysteresis."""

    def __init__(self, config: PolicyConfig | None = None) -> None:
        self.cfg = config or PolicyConfig()
        self._decision: Decision = Decision.INSUFFICIENT_EVIDENCE
        self._decided_ms: int = 0
        self._relief_since_ms: int = 0
        self._relief_target: Decision | None = None
        self._arousal_hist: list[tuple[int, float]] = []
        self._br_baseline: float | None = None

    def evaluate(
        self,
        ts_ms: int,
        est: StateEstimate,
        vitals: VitalsSnapshot,
        subject_count: int = 1,
    ) -> Advisory:
        reasons: list[str] = []

        # --- continuous readiness index -----------------------------------
        arousal = sum(est.posterior[s] * AROUSAL[s] for s in STATES)

        # The posterior is deliberately slow — that is what stops it flickering.
        # But a person who has just started moving is dangerous *now*, and an
        # index derived only from a lagging posterior would report low readiness
        # for several seconds after they moved. The observed motion therefore
        # sets a floor under the index directly, so escalation never waits for
        # the state estimate to catch up. Only the floor is instantaneous; the
        # de-escalation path is still gated by dwell below.
        observed_floor = dsp.clamp(vitals.motion.index / 70.0, 0.0, 1.0) * 0.95
        if observed_floor > arousal:
            arousal = observed_floor
            reasons.append("OBSERVED_MOTION")

        if vitals.motion.seconds_since_burst <= self.cfg.recent_burst_s:
            arousal += 0.15
            reasons.append("RECENT_MOVEMENT")
        if vitals.features.rrv_cv >= 0.30 and vitals.features.interval_count >= 4:
            arousal += 0.05
            reasons.append("ELEVATED_VARIABILITY")

        br = vitals.respiration.bpm
        if br is not None and vitals.respiration.confidence > 0.3:
            self._br_baseline = dsp.ema(self._br_baseline, br, 0.01)
            if self._br_baseline and br > self._br_baseline + 2.5:
                arousal += 0.08
                reasons.append("RATE_RISING")
        if vitals.features.irregular:
            reasons.append("IRREGULAR_RESPIRATION")

        arousal = dsp.clamp(arousal, 0.0, 1.0)
        self._arousal_hist.append((ts_ms, arousal))
        self._arousal_hist = [(t, a) for t, a in self._arousal_hist if ts_ms - t <= 15_000]
        stability = 1.0 - dsp.clamp(dsp.stdev([a for _, a in self._arousal_hist]) * 3.0, 0.0, 1.0)
        if stability < 0.5 and len(self._arousal_hist) >= 8:
            reasons.append("STATE_UNSTABLE")

        # --- evidence gate --------------------------------------------------
        evidence = est.evidence
        if vitals.attribution == "unattributed":
            reasons.append("VITALS_UNATTRIBUTED")
        if subject_count > 1:
            reasons.append("MULTIPLE_SUBJECTS")
        if vitals.respiration.confidence <= 0.0:
            reasons.append("NO_RESPIRATION_LOCK")

        gated = self.cfg.evidence_gate
        if est.state is None and gated:
            reasons.append("WEAK_EVIDENCE")
            raw, basis = Decision.INSUFFICIENT_EVIDENCE, "STATE_UNRESOLVED"
        elif est.state is State.DISTRESSED:
            raw, basis = Decision.DO_NOT_APPROACH, "STATE_DISTRESSED"
        elif arousal <= self.cfg.approach_max_arousal:
            if subject_count > 1:
                # An advisory about approaching a subject is in practice an
                # advisory about entering their space. A second person in the
                # volume is a hazard whatever this subject is doing, and their
                # vitals cannot be attributed with the same confidence — so a
                # green light is withheld on principle, not on measurement.
                raw, basis = Decision.CAUTION, "SECOND_SUBJECT"
            elif est.state is State.ASLEEP and est.dwell_s >= self.cfg.approach_min_dwell_s:
                raw, basis = Decision.APPROACH, "SLEEP_DWELL_MET"
                reasons.append("SLEEP_CONSISTENT")
                reasons.append("LOW_AROUSAL_SUSTAINED")
            elif est.state is State.ASLEEP:
                raw, basis = Decision.CAUTION, "SLEEP_DWELL_SHORT"
            elif est.state is None:
                # Only reachable with the evidence gate off.
                raw, basis = Decision.CAUTION, "STATE_UNRESOLVED"
            else:
                raw, basis = Decision.CAUTION, "NOT_ASLEEP"
        elif arousal <= self.cfg.caution_max_arousal:
            raw, basis = Decision.CAUTION, "AROUSAL_CAUTION_BAND"
        elif arousal <= self.cfg.hold_max_arousal:
            raw, basis = Decision.HOLD, "AROUSAL_HOLD_BAND"
        else:
            raw, basis = Decision.DO_NOT_APPROACH, "AROUSAL_ABOVE_HOLD"
            if est.state is State.ACTIVE:
                reasons.append("ACTIVE_MOTION")

        # Evidence gates permission, not warning. Below the threshold the
        # advisory can never be more permissive than INSUFFICIENT_EVIDENCE — but
        # a strong high-arousal reading still warns, because suppressing a
        # danger signal for want of confidence is the more dangerous error.
        if evidence < self.cfg.min_evidence:
            reasons.append("WEAK_EVIDENCE")
            if gated and DECISION_RANK[raw] < DECISION_RANK[Decision.INSUFFICIENT_EVIDENCE]:
                raw, basis = Decision.INSUFFICIENT_EVIDENCE, "EVIDENCE_BELOW_MINIMUM"

        decision = self._apply_hysteresis(ts_ms, raw, reasons)
        pending = pending_in_s = None
        if decision is not raw:
            # Held: the decision now rests on the hysteresis rule, not on the
            # reading that first produced it.
            basis = "DE_ESCALATION_HOLD"
            pending = self._relief_target
            held = (ts_ms - self._relief_since_ms) / 1000.0
            pending_in_s = max(0.0, self.cfg.de_escalation_dwell_s - held)
        confidence = dsp.clamp(0.5 * est.confidence + 0.3 * evidence + 0.2 * stability, 0.0, 1.0)
        return Advisory(
            decision=decision,
            readiness_index=arousal,
            confidence=confidence,
            reasons=list(dict.fromkeys(reasons)),
            quiet_window_s=self._quiet_window(decision, vitals, est),
            stability=stability,
            basis=basis,
            held_s=(ts_ms - self._decided_ms) / 1000.0,
            pending=pending,
            pending_in_s=pending_in_s,
        )

    def _apply_hysteresis(self, ts_ms: int, raw: Decision, reasons: list[str]) -> Decision:
        """Escalate immediately; de-escalate only after the *relief* has held.

        The dwell is measured from when the more permissive reading first
        appeared — not from when the restrictive decision was entered. Measuring
        the latter has the property that the longer a subject was dangerous, the
        faster the system clears them, which is precisely backwards: a single
        calm frame after ten minutes of movement would lift the warning at once.
        """
        if self._decided_ms == 0:
            self._decision, self._decided_ms = raw, ts_ms
            return raw

        if DECISION_RANK[raw] >= DECISION_RANK[self._decision]:
            # Same or more restrictive: take it now and cancel any pending relief.
            self._relief_since_ms = 0
            self._relief_target = None
            if raw is not self._decision:
                self._decision, self._decided_ms = raw, ts_ms
            return self._decision

        # More permissive than the standing decision: start (or continue) the
        # relief timer. A relief that gets *more* permissive restarts it.
        if self._relief_target is None or DECISION_RANK[raw] < DECISION_RANK[self._relief_target]:
            self._relief_since_ms = ts_ms
            self._relief_target = raw
        held_s = (ts_ms - self._relief_since_ms) / 1000.0
        if held_s < self.cfg.de_escalation_dwell_s:
            reasons.append("DE_ESCALATION_HOLD")
            return self._decision

        self._decision, self._decided_ms = raw, ts_ms
        self._relief_since_ms = 0
        self._relief_target = None
        return raw

    def _quiet_window(
        self, decision: Decision, vitals: VitalsSnapshot, est: StateEstimate
    ) -> float | None:
        """Seconds of continued low arousal we can defend, not a prediction.

        Derived from the observed movement-burst rate: with bursts arriving at
        ``r`` per minute, the expected time to the next one is ``60/r``; we
        report the elapsed-adjusted remainder and nothing when there is no
        burst history to reason from.
        """
        if decision not in (Decision.APPROACH, Decision.CAUTION):
            return None
        r = vitals.motion.burst_rate_per_min
        if r <= 0.0:
            # No bursts observed in the window: report the dwell already
            # achieved as the defensible lower bound, capped.
            return min(est.dwell_s, 300.0) if est.dwell_s > 0 else None
        expected = 60.0 / r
        remaining = expected - min(vitals.motion.seconds_since_burst, expected)
        return max(0.0, remaining)


@dataclass
class SubjectAssessment:
    """Combined output for one subject, ready for transport."""

    state: StateEstimate
    advisory: Advisory
    features: FeatureVector

    def as_dict(self) -> dict:
        return {
            "state": self.state.as_dict(),
            "advisory": self.advisory.as_dict(),
            "features": self.features.as_dict(),
        }


class SubjectAssessor:
    """One state model + one policy, bound to a single track."""

    def __init__(self, model_cfg: ModelConfig | None = None, policy_cfg: PolicyConfig | None = None) -> None:
        self.model = BehaviouralStateModel(model_cfg)
        self.policy = ApproachPolicy(policy_cfg)

    def update(self, ts_ms: int, vitals: VitalsSnapshot, subject_count: int = 1) -> SubjectAssessment:
        fv = features_from_vitals(vitals)
        est = self.model.update(ts_ms, fv)
        adv = self.policy.evaluate(ts_ms, est, vitals, subject_count)
        return SubjectAssessment(state=est, advisory=adv, features=fv)


def fit_state_params(
    samples: list[tuple[str, FeatureVector]],
    prior: dict[State, StateParams] | None = None,
    prior_weight: float = 8.0,
) -> dict[State, StateParams]:
    """Fit emission parameters from labelled samples (MAP with a prior).

    Used by ``scripts/calibrate_states.py`` on labelled recordings. The prior
    keeps a class with three observations from collapsing to a zero-variance
    Gaussian that would then dominate every posterior — the failure mode that
    makes small-sample calibration worse than no calibration.
    """
    base = prior or default_params()
    out: dict[State, StateParams] = {}
    for st in STATES:
        by_feature: dict[str, list[float]] = {f: [] for f in FEATURES}
        for label, fv in samples:
            if label != st.value:
                continue
            for f in FEATURES:
                v = fv.get(f)
                if v is not None:
                    by_feature[f].append(float(v))
        emissions: dict[str, Gaussian] = {}
        for f in FEATURES:
            xs = by_feature[f]
            p = base[st].emissions.get(f)
            if not xs and p:
                emissions[f] = p
                continue
            if not xs:
                continue
            n = len(xs)
            m = dsp.mean(xs)
            sd = dsp.stdev(xs)
            if p:
                w = n / (n + prior_weight)
                m = w * m + (1 - w) * p.mean
                sd = w * sd + (1 - w) * p.sd
            emissions[f] = Gaussian(m, max(sd, 1e-2))
        out[st] = StateParams(emissions=emissions, min_dwell_s=base[st].min_dwell_s)
    return out


def params_to_dict(params: dict[State, StateParams]) -> dict:
    return {
        "states": {
            st.value: {
                "min_dwell_s": p.min_dwell_s,
                "emissions": {
                    f: {"mean": round(g.mean, 4), "sd": round(g.sd, 4)}
                    for f, g in p.emissions.items()
                },
            }
            for st, p in params.items()
        }
    }


__all__ = [
    "Advisory", "ApproachPolicy", "BehaviouralStateModel", "Decision", "FeatureVector",
    "Gaussian", "ModelConfig", "PolicyConfig", "State", "StateEstimate", "StateParams",
    "SubjectAssessment", "SubjectAssessor", "STATES", "STATE_LABEL", "AROUSAL",
    "features_from_vitals", "fit_state_params", "params_to_dict", "replace",
]
