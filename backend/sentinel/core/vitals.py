"""Respiration / cardiac estimation and the derived variability features.

Two estimates of the same quantity are kept deliberately separate:

* **local** — computed here from the CSI amplitude series the nodes stream. We
  own the whole chain, so we can also produce the *waveform*, the breath-to-breath
  intervals and their variability, none of which the upstream server exposes.
* **reference** — the sensing server's own FFT estimate, relayed as-is.

They are fused only at the end, with the provenance recorded, so a disagreement
is visible rather than averaged away. Respiratory variability (the feature the
behavioural state model leans on most) is only ever computed from the local
chain, because it needs per-breath timing.

Confidence is evidence-gated throughout: a rate is reported as *measured* only
when the spectral peak clears an SNR floor and the window is long enough to
resolve it. Otherwise the estimate is returned with ``confidence == 0`` and the
consumer is expected to treat it as unknown, never as zero.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field

from sentinel.core import dsp
from sentinel.core.dsp import CARDIAC_BAND, RESP_BAND, TimeSeries

# Analysis window. 45 s resolves 0.022 Hz (1.3 breaths/min) and holds ~11 breaths
# at a resting rate — enough for a variability estimate, short enough to follow a
# behavioural transition without smearing two states together. That trade is the
# binding constraint on how fast an arousal can be detected; ``resolution_bpm``
# on every estimate reports the resulting uncertainty rather than hiding it.
RESP_WINDOW_S = 45.0
CARDIAC_WINDOW_S = 30.0
TARGET_FS = 10.0            # resample grid; ESP32-S3 CSI arrives at ~10 Hz

# Evidence gates.
MIN_SPAN_S = 20.0           # below this the frequency resolution is too coarse

# SNR floors are set from the *noise-only* distribution of this periodogram, not
# picked by eye. Band-limited white noise through the same chain produces a peak
# that already stands well above the in-band mean simply because it is the
# maximum of many bins: measured median 4.4 and p95 7.4 in the respiration band,
# median 6.3 and p95 10.8 in the cardiac band (400 trials, 45 s / 30 s windows).
# A threshold below those is not a detector — it reports a confident rate from
# pure noise. These floors sit at the p95, i.e. a ~5% false-alarm rate per
# estimate, which the HMM's temporal prior then suppresses further.
RESP_SNR_FLOOR = 7.5
CARDIAC_SNR_FLOOR = 11.0
PLAUSIBLE_BPM = (6.0, 30.0)
PLAUSIBLE_HR = (40.0, 120.0)


@dataclass
class RateEstimate:
    """A rate with the evidence behind it. ``confidence == 0`` means unknown."""

    bpm: float | None = None
    confidence: float = 0.0
    snr: float = 0.0
    resolution_bpm: float = 0.0
    method: str = "none"          # local_csi | reference | fused | none
    agreement: float | None = None  # |local - reference| in BPM, when both exist

    def as_dict(self) -> dict:
        return {
            "bpm": round(self.bpm, 2) if self.bpm is not None else None,
            "confidence": round(self.confidence, 3),
            "snr": round(self.snr, 2),
            "resolution_bpm": round(self.resolution_bpm, 2),
            "method": self.method,
            "agreement_bpm": round(self.agreement, 2) if self.agreement is not None else None,
        }


@dataclass
class RespirationFeatures:
    """Breath-timing features. The behavioural state model consumes these."""

    interval_count: int = 0
    mean_interval_s: float = 0.0
    rrv_cv: float = 0.0        # coefficient of variation of breath intervals
    rmssd_s: float = 0.0       # root mean square of successive differences
    longest_pause_s: float = 0.0
    irregular: bool = False    # pause > 2.5x the running mean interval
    amplitude_cv: float = 0.0  # breath-depth variability

    def as_dict(self) -> dict:
        return {
            "interval_count": self.interval_count,
            "mean_interval_s": round(self.mean_interval_s, 2),
            "rrv_cv": round(self.rrv_cv, 4),
            "rmssd_s": round(self.rmssd_s, 3),
            "longest_pause_s": round(self.longest_pause_s, 2),
            "irregular": self.irregular,
            "amplitude_cv": round(self.amplitude_cv, 4),
        }


class RespirationAnalyzer:
    """Rolling CSI-amplitude → respiration chain for one subject or one node."""

    def __init__(self, window_s: float = RESP_WINDOW_S) -> None:
        self.raw = TimeSeries(window_s=window_s)
        self.reference = TimeSeries(window_s=window_s)
        self.reference_conf = TimeSeries(window_s=window_s)
        self._cached_wave: list[float] = []
        self._cached_fs: float = 0.0

    # -- ingestion ----------------------------------------------------------

    def push_csi(self, ts_ms: int, amplitude: float) -> None:
        """One respiration-surrogate sample: the mean CSI subcarrier amplitude.

        Chest displacement modulates multipath amplitude; averaging subcarriers
        trades some sensitivity for a large drop in per-subcarrier phase noise.
        """
        self.raw.push(ts_ms, amplitude)

    def push_reference(self, ts_ms: int, bpm: float | None, confidence: float) -> None:
        if bpm is not None:
            self.reference.push(ts_ms, bpm)
        self.reference_conf.push(ts_ms, confidence)

    # -- analysis -----------------------------------------------------------

    def _filtered(self) -> tuple[list[float], float]:
        """Band-passed, detrended respiration waveform on a uniform grid."""
        fs = TARGET_FS
        xs = self.raw.resampled(fs)
        if len(xs) < 32:
            return [], 0.0
        centre = (RESP_BAND[0] + RESP_BAND[1]) / 2.0
        bq = dsp.Biquad.bandpass(fs, centre, q=0.8)
        wave = bq.filtfilt(dsp.detrend(xs))
        self._cached_wave, self._cached_fs = wave, fs
        return wave, fs

    def estimate(self) -> tuple[RateEstimate, RespirationFeatures]:
        wave, fs = self._filtered()
        span = self.raw.span_s()
        local = RateEstimate()
        feats = RespirationFeatures()

        if wave and span >= MIN_SPAN_S:
            spec = dsp.band_spectrum(wave, fs, RESP_BAND, bins=96)
            bpm = spec.bpm
            if PLAUSIBLE_BPM[0] <= bpm <= PLAUSIBLE_BPM[1] and spec.snr >= RESP_SNR_FLOOR:
                # Confidence blends spectral SNR with window adequacy; both must
                # be good for a high number, and neither alone can produce one.
                snr_term = dsp.clamp((spec.snr - RESP_SNR_FLOOR) / 8.0, 0.0, 1.0)
                span_term = dsp.clamp(span / RESP_WINDOW_S, 0.0, 1.0)
                local = RateEstimate(
                    bpm=bpm,
                    confidence=round(0.35 + 0.45 * snr_term + 0.20 * span_term, 3),
                    snr=spec.snr,
                    resolution_bpm=spec.resolution_hz * 60.0,
                    method="local_csi",
                )
                feats = self._features(wave, fs, bpm)

        ref_bpm = dsp.median([v for v in self.reference.values[-30:]]) or None
        ref_conf = self.reference_conf.latest() or 0.0
        fused = self._fuse(local, ref_bpm, ref_conf)
        return fused, feats

    def _features(self, wave: list[float], fs: float, bpm: float) -> RespirationFeatures:
        period_samples = max(2, int(fs * 60.0 / max(bpm, 1e-3)))
        # Refractory at 55% of a period: rejects the dicrotic-style double peak
        # without merging genuinely fast breaths.
        min_dist = max(2, int(period_samples * 0.55))
        amp = dsp.stdev(wave)
        peaks = dsp.peak_indices(wave, min_distance=min_dist, prominence=amp * 0.5)
        iv = dsp.intervals_s(peaks, fs)
        if len(iv) < 3:
            return RespirationFeatures(interval_count=len(iv))

        m = dsp.mean(iv)
        sd = dsp.stdev(iv)
        succ = [iv[i] - iv[i - 1] for i in range(1, len(iv))]
        rmssd = (dsp.mean([d * d for d in succ])) ** 0.5 if succ else 0.0
        depths = [wave[p] for p in peaks]
        depth_mean = dsp.mean([abs(d) for d in depths]) or 1.0
        return RespirationFeatures(
            interval_count=len(iv),
            mean_interval_s=m,
            rrv_cv=(sd / m) if m > 0 else 0.0,
            rmssd_s=rmssd,
            longest_pause_s=max(iv),
            irregular=max(iv) > 2.5 * m,
            amplitude_cv=dsp.stdev([abs(d) for d in depths]) / depth_mean,
        )

    def _fuse(self, local: RateEstimate, ref_bpm: float | None, ref_conf: float) -> RateEstimate:
        has_ref = ref_bpm is not None and ref_conf > 0.2 and PLAUSIBLE_BPM[0] <= ref_bpm <= PLAUSIBLE_BPM[1]
        if local.confidence <= 0 and not has_ref:
            return RateEstimate()
        if local.confidence <= 0:
            return RateEstimate(bpm=ref_bpm, confidence=round(ref_conf * 0.8, 3), method="reference")
        if not has_ref:
            return local

        delta = abs(local.bpm - ref_bpm)  # type: ignore[operator]
        # Two independent chains agreeing within 2 BPM is strong evidence; a wide
        # disagreement is reported (not hidden) by capping confidence.
        if delta <= 2.0:
            w = local.confidence
            wr = ref_conf
            bpm = (local.bpm * w + ref_bpm * wr) / (w + wr)  # type: ignore[operator]
            conf = min(0.99, max(local.confidence, ref_conf) + 0.1)
            method = "fused"
        else:
            bpm, conf, method = local.bpm, local.confidence * 0.6, "local_csi"
        return RateEstimate(
            bpm=bpm, confidence=round(conf, 3), snr=local.snr,
            resolution_bpm=local.resolution_bpm, method=method, agreement=delta,
        )

    def waveform(self, points: int = 180) -> list[float]:
        """Normalised respiration waveform for display (not for analysis)."""
        wave = self._cached_wave or self._filtered()[0]
        return [round(v, 4) for v in dsp.decimate(dsp.normalize(wave), points)]


class CardiacAnalyzer:
    """Heart-rate band of the same CSI series, held to a stricter evidence gate.

    Cardiac chest displacement is roughly two orders of magnitude smaller than
    respiratory displacement, so a single commodity ESP32 link frequently cannot
    support a heart-rate claim. Returning "unknown" in that case is the correct
    output, and the dashboard renders it as such.
    """

    def __init__(self, window_s: float = CARDIAC_WINDOW_S) -> None:
        self.raw = TimeSeries(window_s=window_s)
        self.reference = TimeSeries(window_s=window_s)
        self.reference_conf = TimeSeries(window_s=window_s)

    def push_csi(self, ts_ms: int, amplitude: float) -> None:
        self.raw.push(ts_ms, amplitude)

    def push_reference(self, ts_ms: int, bpm: float | None, confidence: float) -> None:
        if bpm is not None:
            self.reference.push(ts_ms, bpm)
        self.reference_conf.push(ts_ms, confidence)

    def estimate(self) -> RateEstimate:
        fs = TARGET_FS
        xs = self.raw.resampled(fs)
        span = self.raw.span_s()
        local = RateEstimate()
        if len(xs) >= 64 and span >= MIN_SPAN_S:
            bq = dsp.Biquad.bandpass(fs, (CARDIAC_BAND[0] + CARDIAC_BAND[1]) / 2.0, q=1.2)
            wave = bq.filtfilt(dsp.detrend(xs))
            spec = dsp.band_spectrum(wave, fs, CARDIAC_BAND, bins=96)
            hr = spec.bpm
            if PLAUSIBLE_HR[0] <= hr <= PLAUSIBLE_HR[1] and spec.snr >= CARDIAC_SNR_FLOOR:
                snr_term = dsp.clamp((spec.snr - CARDIAC_SNR_FLOOR) / 10.0, 0.0, 1.0)
                local = RateEstimate(
                    bpm=hr,
                    confidence=round(0.25 + 0.45 * snr_term, 3),
                    snr=spec.snr,
                    resolution_bpm=spec.resolution_hz * 60.0,
                    method="local_csi",
                )

        ref = dsp.median(self.reference.values[-20:]) or None
        ref_conf = self.reference_conf.latest() or 0.0
        if local.confidence <= 0:
            if ref is not None and ref_conf > 0.25 and PLAUSIBLE_HR[0] <= ref <= PLAUSIBLE_HR[1]:
                return RateEstimate(bpm=ref, confidence=round(ref_conf * 0.75, 3), method="reference")
            return RateEstimate()
        if ref is not None and ref_conf > 0.25:
            delta = abs(local.bpm - ref)  # type: ignore[operator]
            if delta <= 6.0:
                return RateEstimate(
                    bpm=(local.bpm + ref) / 2.0,  # type: ignore[operator]
                    confidence=min(0.95, local.confidence + 0.1),
                    snr=local.snr, resolution_bpm=local.resolution_bpm,
                    method="fused", agreement=delta,
                )
            local.agreement = delta
            local.confidence = round(local.confidence * 0.6, 3)
        return local


@dataclass
class MotionState:
    """Body-motion index on an absolute decibel scale, plus burst statistics.

    ``motion_band_power`` is reported in arbitrary units that depend on room,
    link geometry and node gain, so an absolute threshold on it is meaningless
    across deployments. It is therefore expressed in dB above the subject's own
    *quiet floor* — the power level observed when they are still — which is the
    one reference that is both deployment-independent and physically meaningful.
    """

    index: float = 0.0              # 0..100, dB above quiet floor, smoothed
    instant_index: float = 0.0      # same scale, unsmoothed
    burst_rate_per_min: float = 0.0
    seconds_since_burst: float = 999.0
    quiet_floor: float = 0.0
    observed_s: float = 0.0

    def as_dict(self) -> dict:
        return {
            "index": round(self.index, 2),
            "instant_index": round(self.instant_index, 2),
            "burst_rate_per_min": round(self.burst_rate_per_min, 2),
            "seconds_since_burst": round(self.seconds_since_burst, 1),
            "quiet_floor": round(self.quiet_floor, 6),
            "observed_s": round(self.observed_s, 1),
        }


class MotionAnalyzer:
    """Quiet-floor-referenced motion index.

    The floor tracks *downwards instantly* and *upwards slowly*. That asymmetry
    is the point: a subject who goes still immediately re-establishes a floor,
    while a subject who moves for two minutes does not get their own motion
    absorbed into the reference and reported as stillness. A symmetric moving
    average has exactly that failure, and it is what makes an "is this person
    asleep" call silently wrong after a period of activity.
    """

    FLOOR_PERCENTILE = 0.10
    FLOOR_RISE_PER_S = 0.005        # ≤0.5 %/s upward drift
    BURST_RATIO = 8.0               # ~9 dB over floor opens a movement burst
    BURST_RELEASE_RATIO = 2.5       # must fall back below this to close it
    BURST_REFRACTORY_MS = 1500
    DB_SCALE = 3.0                  # dB → index units
    SMOOTH_TAU_S = 15.0
    BURST_WINDOW_MS = 120_000

    def __init__(self, window_s: float = 180.0) -> None:
        self.series = TimeSeries(window_s=window_s)
        self._floor: float | None = None
        self._bursts: list[int] = []
        self._last_ts: int = 0
        self._first_ts: int = 0
        self._smoothed: float | None = None
        self._in_burst: bool = False

    def push(self, ts_ms: int, motion_power: float) -> None:
        power = max(float(motion_power), 1e-9)
        if not self._first_ts:
            self._first_ts = ts_ms
        dt_s = (ts_ms - self._last_ts) / 1000.0 if self._last_ts else 0.1
        self.series.push(ts_ms, power)
        self._update_floor(dt_s)

        floor = self._floor or power
        instant = self._to_index(power, floor)
        alpha = dsp.clamp(dt_s / self.SMOOTH_TAU_S, 0.0, 1.0)
        self._smoothed = dsp.ema(self._smoothed, instant, alpha)

        # Count burst *onsets*, with a release threshold below the trigger. A
        # single movement decays over several seconds, so a bare threshold test
        # counts one event three or four times and inflates the rate for a
        # subject who moved once — the feature that is supposed to separate
        # "occasional micro-motion" from "repeatedly shifting".
        if not self._in_burst and power > floor * self.BURST_RATIO:
            self._in_burst = True
            if not self._bursts or ts_ms - self._bursts[-1] > self.BURST_REFRACTORY_MS:
                self._bursts.append(ts_ms)
        elif self._in_burst and power < floor * self.BURST_RELEASE_RATIO:
            self._in_burst = False
        cutoff = ts_ms - self.BURST_WINDOW_MS
        self._bursts = [b for b in self._bursts if b >= cutoff]
        self._last_ts = ts_ms

    def _update_floor(self, dt_s: float) -> None:
        vals = sorted(self.series.values)
        if len(vals) < 8:
            return
        p = vals[max(0, int(len(vals) * self.FLOOR_PERCENTILE) - 1)]
        if self._floor is None or p < self._floor:
            self._floor = max(p, 1e-9)
        else:
            self._floor = min(p, self._floor * (1.0 + self.FLOOR_RISE_PER_S * dt_s))

    def _to_index(self, power: float, floor: float) -> float:
        if floor <= 0:
            return 0.0
        db = 10.0 * math.log10(max(power / floor, 1.0))
        return dsp.clamp(db * self.DB_SCALE, 0.0, 100.0)

    def state(self) -> MotionState:
        latest = self.series.latest()
        if latest is None or self._floor is None:
            return MotionState()
        observed = (self._last_ts - self._first_ts) / 1000.0
        span_min = max(min(self.series.span_s(), self.BURST_WINDOW_MS / 1000.0) / 60.0, 1e-3)
        since = (self._last_ts - self._bursts[-1]) / 1000.0 if self._bursts else 999.0
        return MotionState(
            index=self._smoothed or 0.0,
            instant_index=self._to_index(latest, self._floor),
            burst_rate_per_min=len(self._bursts) / span_min,
            seconds_since_burst=since,
            quiet_floor=self._floor,
            observed_s=observed,
        )


#: Above this motion index the respiration band is dominated by body motion
#: rather than chest displacement, and a respiration rate is not measurable.
#: Reporting one anyway is the classic motion-artefact failure of RF vitals.
MOTION_BLOCK_INDEX = 55.0
MOTION_DEGRADE_INDEX = 25.0


def apply_motion_gate(resp: RateEstimate, motion: MotionState) -> RateEstimate:
    """Discount or reject a respiration estimate contaminated by body motion."""
    if motion.index >= MOTION_BLOCK_INDEX:
        return RateEstimate(method="motion_blocked")
    if motion.index > MOTION_DEGRADE_INDEX and resp.confidence > 0:
        span = MOTION_BLOCK_INDEX - MOTION_DEGRADE_INDEX
        factor = 1.0 - (motion.index - MOTION_DEGRADE_INDEX) / span
        resp.confidence = round(resp.confidence * max(factor, 0.0), 3)
    return resp


@dataclass
class VitalsSnapshot:
    """Everything the state model and the console need about one subject."""

    respiration: RateEstimate = field(default_factory=RateEstimate)
    cardiac: RateEstimate = field(default_factory=RateEstimate)
    features: RespirationFeatures = field(default_factory=RespirationFeatures)
    motion: MotionState = field(default_factory=MotionState)
    signal_quality: float = 0.0
    attribution: str = "unattributed"   # exclusive | nearest_node | aggregate | unattributed

    def as_dict(self) -> dict:
        return {
            "respiration": self.respiration.as_dict(),
            "cardiac": self.cardiac.as_dict(),
            "respiration_features": self.features.as_dict(),
            "motion": self.motion.as_dict(),
            "signal_quality": round(self.signal_quality, 3),
            "attribution": self.attribution,
        }
