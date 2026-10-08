"""Behavioural-state model and approach-advisory tests.

The advisory is the output a person acts on, so its safety properties are
asserted directly rather than inferred from accuracy numbers: weak evidence
never permits, escalation is immediate, de-escalation is delayed, and a second
subject in the volume withdraws the green light.
"""

from __future__ import annotations

from sentinel.core.assessment import (
    AROUSAL,
    STATES,
    ApproachPolicy,
    BehaviouralStateModel,
    Decision,
    FeatureVector,
    ModelConfig,
    PolicyConfig,
    State,
    SubjectAssessor,
    features_from_vitals,
    fit_state_params,
    params_to_dict,
)
from sentinel.core.vitals import (
    MotionState,
    RateEstimate,
    RespirationFeatures,
    VitalsSnapshot,
)

T0 = 1_700_000_000_000


def vitals(bpm=12.0, conf=0.85, rrv=0.08, motion=1.0, bursts=0.3, acv=0.15,
           since_burst=120.0, irregular=False, attribution="exclusive", intervals=8):
    return VitalsSnapshot(
        respiration=RateEstimate(bpm=bpm, confidence=conf, snr=12.0, method="local_csi"),
        cardiac=RateEstimate(),
        features=RespirationFeatures(
            interval_count=intervals, mean_interval_s=60.0 / max(bpm or 15.0, 1),
            rrv_cv=rrv, irregular=irregular, amplitude_cv=acv,
        ),
        motion=MotionState(index=motion, burst_rate_per_min=bursts,
                           seconds_since_burst=since_burst, quiet_floor=0.001,
                           observed_s=120.0),
        signal_quality=0.8,
        attribution=attribution,
    )


def drive(assessor: SubjectAssessor, snapshot, seconds: float, subject_count: int = 1,
          start_ms: int = T0, step_ms: int = 500):
    last = None
    for i in range(int(seconds * 1000 / step_ms)):
        last = assessor.update(start_ms + i * step_ms, snapshot, subject_count)
    return last


# ── state model ─────────────────────────────────────────────────────────────


def test_sleep_like_features_converge_on_asleep():
    a = SubjectAssessor()
    out = drive(a, vitals(bpm=12.0, rrv=0.07, motion=0.5, bursts=0.2), 120)
    assert out.state.state is State.ASLEEP
    assert out.state.confidence > 0.6
    assert out.state.dwell_s > 60


def test_movement_features_converge_on_active():
    a = SubjectAssessor()
    out = drive(a, vitals(bpm=18.0, conf=0.0, rrv=0.25, motion=60.0, bursts=3.0,
                          acv=0.55, since_burst=2.0), 90)
    assert out.state.state is State.ACTIVE


def test_alert_stillness_is_separated_from_sleep_by_variability_alone():
    """The discrimination the platform turns on: same near-zero motion, but
    awake-level breath-to-breath variability and rate."""
    a = SubjectAssessor()
    asleep = drive(a, vitals(bpm=12.0, rrv=0.07, motion=1.0, bursts=0.2), 120)
    b = SubjectAssessor()
    alert = drive(b, vitals(bpm=17.0, rrv=0.24, motion=5.0, bursts=1.6, acv=0.37), 120)
    assert asleep.state.state is State.ASLEEP
    assert alert.state.state is State.ALERT_STILL


def test_posterior_is_a_distribution():
    m = BehaviouralStateModel()
    est = m.update(T0, FeatureVector(respiration_bpm=14.0, rrv_cv=0.15,
                                     motion_index=5.0, evidence=0.9))
    assert abs(sum(est.posterior.values()) - 1.0) < 1e-9
    assert set(est.posterior) == set(STATES)


def test_hmm_prior_resists_a_single_moderate_outlier():
    """One noisy frame must not move the state; sustained evidence must."""
    a = SubjectAssessor()
    drive(a, vitals(bpm=12.0, rrv=0.07, motion=0.5), 120)
    blip = a.update(T0 + 120_000, vitals(bpm=15.5, rrv=0.16, motion=9.0, bursts=1.4), 1)
    assert blip.state.state is State.ASLEEP
    sustained = drive(a, vitals(bpm=15.0, rrv=0.15, motion=6.0, bursts=1.2),
                      40, start_ms=T0 + 121_000)
    assert sustained.state.state is not State.ASLEEP


def test_strong_arousal_is_detected_without_waiting():
    """The opposite requirement to the one above, and the more important one:
    an unambiguous movement reading escalates on the frame it arrives."""
    a = SubjectAssessor()
    drive(a, vitals(bpm=12.0, rrv=0.07, motion=0.5), 120)
    spike = a.update(T0 + 120_000, vitals(bpm=22.0, conf=0.0, rrv=0.5, motion=80.0,
                                          bursts=9.0, acv=0.8, since_burst=0.5), 1)
    assert spike.advisory.decision is not Decision.APPROACH
    assert spike.advisory.readiness_index > 0.5


def test_missing_features_weaken_rather_than_bias():
    m = BehaviouralStateModel()
    full = m.update(T0, FeatureVector(respiration_bpm=12.0, rrv_cv=0.07,
                                      motion_index=1.0, evidence=0.9))
    m2 = BehaviouralStateModel()
    partial = m2.update(T0, FeatureVector(motion_index=1.0, evidence=0.5))
    assert full.features_used > partial.features_used
    assert partial.confidence <= full.confidence


def test_no_evidence_yields_no_state():
    m = BehaviouralStateModel()
    est = m.update(T0, FeatureVector(evidence=0.0))
    assert est.state is None


# ── advisory ────────────────────────────────────────────────────────────────


def test_sustained_sleep_eventually_permits_approach():
    a = SubjectAssessor()
    out = drive(a, vitals(bpm=12.0, rrv=0.07, motion=0.5, bursts=0.0), 180)
    assert out.advisory.decision is Decision.APPROACH
    assert "SLEEP_CONSISTENT" in out.advisory.reasons
    assert out.advisory.readiness_index < 0.25


def test_approach_is_withheld_before_the_dwell_threshold():
    a = SubjectAssessor()
    out = drive(a, vitals(bpm=12.0, rrv=0.07, motion=0.5, bursts=0.0), 20)
    assert out.advisory.decision is not Decision.APPROACH


def test_weak_evidence_never_permits():
    a = SubjectAssessor()
    weak = vitals(conf=0.0, intervals=0, attribution="unattributed")
    out = drive(a, weak, 180)
    assert out.advisory.decision in (Decision.INSUFFICIENT_EVIDENCE,
                                     Decision.HOLD, Decision.DO_NOT_APPROACH)
    assert "WEAK_EVIDENCE" in out.advisory.reasons


def test_weak_evidence_does_not_suppress_a_warning():
    """Low confidence must not hide a high-arousal reading behind 'unknown'."""
    a = SubjectAssessor()
    out = drive(a, vitals(bpm=None, conf=0.0, rrv=0.4, motion=85.0, bursts=9.0,
                          acv=0.8, since_burst=1.0, intervals=0,
                          attribution="unattributed"), 90)
    assert out.advisory.decision in (Decision.DO_NOT_APPROACH,
                                     Decision.INSUFFICIENT_EVIDENCE)


def test_escalation_is_immediate():
    a = SubjectAssessor()
    drive(a, vitals(bpm=12.0, rrv=0.07, motion=0.5, bursts=0.0), 180)
    hot = a.update(T0 + 200_000, vitals(bpm=21.0, conf=0.0, rrv=0.45, motion=90.0,
                                        bursts=10.0, acv=0.8, since_burst=0.5), 1)
    assert hot.advisory.decision is not Decision.APPROACH


def test_de_escalation_is_delayed():
    a = SubjectAssessor()
    active = vitals(bpm=20.0, conf=0.0, rrv=0.45, motion=90.0, bursts=10.0,
                    acv=0.8, since_burst=0.5)
    drive(a, active, 60)
    calm = vitals(bpm=12.0, rrv=0.07, motion=0.5, bursts=0.0)
    soon = a.update(T0 + 61_000, calm, 1)
    assert soon.advisory.decision is not Decision.APPROACH
    assert "DE_ESCALATION_HOLD" in soon.advisory.reasons


def test_multiple_subjects_withdraw_the_green_light():
    a = SubjectAssessor()
    out = drive(a, vitals(bpm=12.0, rrv=0.07, motion=0.5, bursts=0.0), 180, subject_count=2)
    assert out.advisory.decision is not Decision.APPROACH
    assert "MULTIPLE_SUBJECTS" in out.advisory.reasons


def test_irregular_respiration_drives_distress_and_denial():
    a = SubjectAssessor()
    out = drive(a, vitals(bpm=24.0, rrv=0.5, motion=12.0, bursts=3.0, acv=0.8,
                          irregular=True), 150)
    assert out.state.state is State.DISTRESSED
    assert out.advisory.decision is Decision.DO_NOT_APPROACH


def test_recent_movement_raises_readiness_and_is_reported():
    a = SubjectAssessor()
    calm = drive(a, vitals(bpm=12.0, rrv=0.07, motion=0.5, since_burst=120.0), 120)
    b = SubjectAssessor()
    stirred = drive(b, vitals(bpm=12.0, rrv=0.07, motion=0.5, since_burst=3.0), 120)
    assert stirred.advisory.readiness_index > calm.advisory.readiness_index
    assert "RECENT_MOVEMENT" in stirred.advisory.reasons


def test_quiet_window_is_only_offered_with_a_permissive_decision():
    a = SubjectAssessor()
    out = drive(a, vitals(bpm=20.0, conf=0.0, rrv=0.45, motion=90.0, bursts=10.0,
                          acv=0.8, since_burst=0.5), 90)
    assert out.advisory.quiet_window_s is None


def test_arousal_weights_are_ordered():
    assert (AROUSAL[State.ASLEEP] < AROUSAL[State.RESTING]
            < AROUSAL[State.ALERT_STILL] < AROUSAL[State.ACTIVE])


# ── evidence / attribution ──────────────────────────────────────────────────


def test_unattributed_vitals_are_discounted_as_evidence():
    exclusive = features_from_vitals(vitals(attribution="exclusive"))
    unattributed = features_from_vitals(vitals(attribution="unattributed"))
    assert unattributed.evidence < exclusive.evidence * 0.5


def test_nearest_node_attribution_is_discounted_but_usable():
    fv = features_from_vitals(vitals(attribution="nearest_node"))
    assert 0.3 < fv.evidence < features_from_vitals(vitals()).evidence


# ── calibration ─────────────────────────────────────────────────────────────


def test_fit_recovers_shifted_parameters():
    samples = [(State.ASLEEP.value, FeatureVector(respiration_bpm=10.0, rrv_cv=0.05,
                                                  motion_index=1.0, evidence=1.0))] * 400
    fitted = fit_state_params(samples, prior_weight=8.0)
    assert 9.5 < fitted[State.ASLEEP].emissions["respiration_bpm"].mean < 10.5


def test_fit_keeps_a_sparse_class_near_its_prior():
    """Three samples must not produce a zero-variance Gaussian."""
    samples = [(State.ACTIVE.value, FeatureVector(motion_index=80.0, evidence=1.0))] * 3
    fitted = fit_state_params(samples, prior_weight=8.0)
    assert fitted[State.ACTIVE].emissions["motion_index"].sd > 1.0


def test_params_round_trip_through_config():
    cfg = ModelConfig.from_dict(params_to_dict(fit_state_params([])))
    assert set(cfg.params) == set(STATES)
    assert cfg.params[State.ASLEEP].emissions["respiration_bpm"].sd > 0


def test_policy_config_from_dict_overrides_thresholds():
    cfg = PolicyConfig.from_dict({"approach_min_dwell_s": 5.0, "min_evidence": 0.9})
    assert cfg.approach_min_dwell_s == 5.0 and cfg.min_evidence == 0.9
    policy = ApproachPolicy(cfg)
    assert policy.cfg.approach_min_dwell_s == 5.0
