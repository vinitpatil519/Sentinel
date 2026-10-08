"""Signal-processing and vitals-estimation tests.

These are the load-bearing numeric claims: if the band-pass, the periodogram or
the motion index is wrong, every downstream state and advisory is wrong while
still looking plausible on screen. Each test drives a synthetic signal whose
correct answer is known analytically.
"""

from __future__ import annotations

import math
import random

import pytest

from sentinel.core import dsp
from sentinel.core.vitals import (
    MOTION_BLOCK_INDEX,
    CardiacAnalyzer,
    MotionAnalyzer,
    RateEstimate,
    RespirationAnalyzer,
    apply_motion_gate,
)

FS = 10.0


def sine(freq_hz: float, seconds: float, fs: float = FS, amp: float = 1.0, phase: float = 0.0):
    n = int(seconds * fs)
    return [amp * math.sin(2 * math.pi * freq_hz * i / fs + phase) for i in range(n)]


# ── dsp ─────────────────────────────────────────────────────────────────────


def test_bandpass_passes_respiration_and_rejects_out_of_band():
    bq = dsp.Biquad.bandpass(FS, 0.3, q=0.8)
    in_band = bq.filtfilt(sine(0.25, 60))
    bq2 = dsp.Biquad.bandpass(FS, 0.3, q=0.8)
    out_of_band = bq2.filtfilt(sine(2.0, 60))
    assert dsp.stdev(in_band) > 0.4
    assert dsp.stdev(out_of_band) < 0.05


def test_filtfilt_is_zero_phase():
    """A lagged waveform would bias every breath-interval measurement."""
    xs = sine(0.25, 60)
    wave = dsp.Biquad.bandpass(FS, 0.25, q=0.8).filtfilt(xs)
    a, b = xs[200:400], wave[200:400]
    # Best alignment lag by cross-correlation; a causal filter would show a
    # lag of several samples at this centre frequency.
    def corr(lag: int) -> float:
        return sum(a[i] * b[i + lag] for i in range(20, len(a) - 20))
    best = max(range(-15, 16), key=corr)
    assert best == 0


def test_band_spectrum_finds_the_right_peak():
    spec = dsp.band_spectrum(sine(0.25, 60), FS, dsp.RESP_BAND, bins=96)
    assert spec.bpm == pytest.approx(15.0, abs=0.6)
    assert spec.snr > 5.0
    assert spec.resolution_hz == pytest.approx(FS / 600, abs=1e-3)


def test_band_spectrum_reports_no_confidence_on_noise():
    rnd = [math.sin(i * 1.7) * 0.01 + math.cos(i * 3.1) * 0.01 for i in range(600)]
    spec = dsp.band_spectrum(rnd, FS, dsp.RESP_BAND, bins=96)
    assert spec.snr < 5.0


def test_peak_picking_and_intervals():
    xs = sine(0.25, 60)                    # 15 breaths/min → 4 s intervals
    peaks = dsp.peak_indices(xs, min_distance=int(FS * 4 * 0.55), prominence=0.5)
    iv = dsp.intervals_s(peaks, FS)
    assert len(iv) >= 12
    assert dsp.mean(iv) == pytest.approx(4.0, abs=0.15)


def test_timeseries_resample_handles_jitter():
    ts = dsp.TimeSeries(window_s=30)
    t = 1_700_000_000_000
    for i in range(300):
        jitter = (i % 5) * 7            # up to 28 ms of jitter
        ts.push(t + i * 100 + jitter, math.sin(i / 10))
    assert ts.rate_hz() == pytest.approx(10.0, abs=0.3)
    assert len(ts.resampled(10.0)) > 250


def test_timeseries_drops_non_finite():
    ts = dsp.TimeSeries(window_s=10)
    ts.push(1000, float("nan"))
    ts.push(1100, float("inf"))
    ts.push(1200, 1.0)
    assert ts.values == [1.0]


# ── respiration ─────────────────────────────────────────────────────────────


def feed(analyzer, bpm: float, seconds: float, amp: float = 1.0, start_ms: int = 1_700_000_000_000,
         noise: float = 0.0):
    f = bpm / 60.0
    n = int(seconds * FS)
    for i in range(n):
        t = start_ms + int(i * 1000 / FS)
        v = 20.0 + amp * math.sin(2 * math.pi * f * i / FS) + noise * math.sin(i * 2.3)
        analyzer.push_csi(t, v)
    return start_ms + int(n * 1000 / FS)


def test_respiration_recovers_a_known_rate():
    a = RespirationAnalyzer()
    feed(a, 14.0, 50)
    est, feats = a.estimate()
    assert est.bpm == pytest.approx(14.0, abs=1.0)
    assert est.confidence > 0.5
    assert est.method == "local_csi"
    assert feats.interval_count >= 6
    assert feats.rrv_cv < 0.15          # a perfect sine is highly regular


def test_respiration_reports_unknown_on_a_short_window():
    a = RespirationAnalyzer()
    feed(a, 14.0, 8)
    est, _ = a.estimate()
    assert est.bpm is None and est.confidence == 0.0


def test_respiration_fuses_with_an_agreeing_reference():
    a = RespirationAnalyzer()
    end = feed(a, 14.0, 50)
    for i in range(20):
        a.push_reference(end + i * 100, 14.2, 0.8)
    est, _ = a.estimate()
    assert est.method == "fused"
    assert est.agreement is not None and est.agreement < 2.0
    assert est.confidence > 0.6


def test_respiration_disagreement_lowers_confidence_instead_of_averaging():
    a = RespirationAnalyzer()
    end = feed(a, 14.0, 50)
    for i in range(20):
        a.push_reference(end + i * 100, 25.0, 0.9)   # upstream way off
    est, _ = a.estimate()
    assert est.method == "local_csi"
    assert est.bpm == pytest.approx(14.0, abs=1.2)   # local wins, not the mean
    assert est.agreement > 5.0


def test_waveform_is_bounded_and_decimated():
    a = RespirationAnalyzer()
    feed(a, 14.0, 50)
    a.estimate()
    w = a.waveform(120)
    assert len(w) <= 120
    assert all(-1.001 <= v <= 1.001 for v in w)


def test_cardiac_reports_unknown_when_buried_in_noise():
    """Cardiac chest displacement is ~100x smaller than respiratory. Buried in
    broadband noise it must come back unknown, not as a plausible number."""
    rng = random.Random(3)
    c = CardiacAnalyzer()
    t = 1_700_000_000_000
    for i in range(400):
        c.push_csi(t + i * 100, 20.0
                   + 0.002 * math.sin(2 * math.pi * 1.2 * i / FS)
                   + rng.gauss(0.0, 0.25))
    est = c.estimate()
    assert est.bpm is None and est.confidence == 0.0


# ── motion ──────────────────────────────────────────────────────────────────


def test_motion_index_is_zero_at_the_quiet_floor():
    m = MotionAnalyzer()
    t = 1_700_000_000_000
    for i in range(600):
        m.push(t + i * 100, 0.001)
    st = m.state()
    assert st.index < 1.0
    assert st.burst_rate_per_min == 0.0


def test_motion_index_rises_with_sustained_movement():
    m = MotionAnalyzer()
    t = 1_700_000_000_000
    for i in range(300):
        m.push(t + i * 100, 0.001)
    for i in range(300, 900):
        m.push(t + i * 100, 0.2)
    st = m.state()
    assert st.index > MOTION_BLOCK_INDEX


def test_motion_floor_does_not_absorb_sustained_motion():
    """The failure this design exists to prevent: two minutes of movement must
    not be re-baselined into apparent stillness."""
    m = MotionAnalyzer()
    t = 1_700_000_000_000
    for i in range(200):
        m.push(t + i * 100, 0.001)
    for i in range(200, 1600):      # 140 s of motion
        m.push(t + i * 100, 0.25)
    assert m.state().index > 40.0


def test_one_movement_counts_as_one_burst():
    """A decaying burst above threshold for several seconds is still one event."""
    m = MotionAnalyzer()
    t = 1_700_000_000_000
    for i in range(300):
        m.push(t + i * 100, 0.001)
    power = 0.2
    for i in range(300, 360):        # single 6 s decaying burst
        m.push(t + i * 100, max(0.001, power * math.exp(-(i - 300) / 16.0)))
    for i in range(360, 700):
        m.push(t + i * 100, 0.001)
    assert m.state().burst_rate_per_min <= 1.5


def test_motion_gate_blocks_respiration_claims_during_movement():
    m = MotionAnalyzer()
    t = 1_700_000_000_000
    for i in range(200):
        m.push(t + i * 100, 0.001)
    for i in range(200, 1000):
        m.push(t + i * 100, 0.3)
    est = apply_motion_gate(RateEstimate(bpm=15.0, confidence=0.8), m.state())
    assert est.confidence == 0.0
    assert est.method == "motion_blocked"
