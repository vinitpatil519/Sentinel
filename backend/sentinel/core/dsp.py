"""Dependency-free signal processing primitives.

Everything here is pure Python on purpose: the backend must run identically on a
laptop, in a container and on a Jetson Orin Nano without a numpy/scipy wheel
matching the ARM64 JetPack stack. Window sizes are small (a 60 s window at 10 Hz
is 600 samples), so the cost is negligible compared with the WebSocket I/O.

The chain implemented here is the standard CSI respiration pipeline:

    raw CSI amplitude  →  subcarrier aggregation  →  detrend (remove slow drift)
    →  band-pass 0.1–0.5 Hz  →  periodogram (dominant frequency + SNR)
    →  peak picking (breath-to-breath intervals → variability)

References for the band definitions: adult respiration 6–30 breaths/min
(0.1–0.5 Hz) and cardiac 40–120 bpm (0.67–2.0 Hz); the same bands the RuView
sensing server uses for its own FFT estimator, so our independent estimate is
comparable with the upstream one.
"""

from __future__ import annotations

import math
from collections import deque
from dataclasses import dataclass, field
from typing import Deque, Iterable, Sequence

# Physiological bands (Hz)
RESP_BAND = (0.10, 0.50)      # 6 – 30 breaths/min
CARDIAC_BAND = (0.67, 2.00)   # 40 – 120 beats/min


# ── small helpers ───────────────────────────────────────────────────────────


def mean(xs: Sequence[float]) -> float:
    return sum(xs) / len(xs) if xs else 0.0


def variance(xs: Sequence[float]) -> float:
    if len(xs) < 2:
        return 0.0
    m = mean(xs)
    return sum((x - m) ** 2 for x in xs) / (len(xs) - 1)


def stdev(xs: Sequence[float]) -> float:
    return math.sqrt(variance(xs))


def median(xs: Sequence[float]) -> float:
    if not xs:
        return 0.0
    s = sorted(xs)
    n = len(s)
    mid = n // 2
    return s[mid] if n % 2 else 0.5 * (s[mid - 1] + s[mid])


def clamp(x: float, lo: float, hi: float) -> float:
    return lo if x < lo else hi if x > hi else x


def ema(prev: float | None, value: float, alpha: float) -> float:
    """Exponential moving average; seeds itself on the first sample."""
    return value if prev is None else alpha * value + (1.0 - alpha) * prev


# ── biquad band-pass (RBJ audio-EQ cookbook, constant 0 dB peak gain) ────────


@dataclass
class Biquad:
    b0: float
    b1: float
    b2: float
    a1: float
    a2: float
    _x1: float = 0.0
    _x2: float = 0.0
    _y1: float = 0.0
    _y2: float = 0.0

    @classmethod
    def bandpass(cls, fs: float, f0: float, q: float = 0.707) -> "Biquad":
        f0 = clamp(f0, 1e-4, fs / 2 - 1e-4)
        w0 = 2.0 * math.pi * f0 / fs
        alpha = math.sin(w0) / (2.0 * q)
        a0 = 1.0 + alpha
        return cls(
            b0=alpha / a0,
            b1=0.0,
            b2=-alpha / a0,
            a1=(-2.0 * math.cos(w0)) / a0,
            a2=(1.0 - alpha) / a0,
        )

    def reset(self) -> None:
        self._x1 = self._x2 = self._y1 = self._y2 = 0.0

    def step(self, x: float) -> float:
        y = (
            self.b0 * x
            + self.b1 * self._x1
            + self.b2 * self._x2
            - self.a1 * self._y1
            - self.a2 * self._y2
        )
        self._x2, self._x1 = self._x1, x
        self._y2, self._y1 = self._y1, y
        return y

    def filtfilt(self, xs: Sequence[float]) -> list[float]:
        """Zero-phase filtering: forward pass, reverse pass, reverse again.

        Phase distortion matters here — a lagged respiration waveform would bias
        breath-interval timing — and the windows are short enough that filtering
        twice costs nothing.
        """
        self.reset()
        fwd = [self.step(x) for x in xs]
        self.reset()
        rev = [self.step(x) for x in reversed(fwd)]
        return list(reversed(rev))


def detrend(xs: Sequence[float]) -> list[float]:
    """Remove the least-squares linear trend (slow CSI drift / thermal ramp)."""
    n = len(xs)
    if n < 2:
        return list(xs)
    sx = (n - 1) / 2.0
    sxx = sum((i - sx) ** 2 for i in range(n))
    my = mean(xs)
    if sxx == 0:
        return [x - my for x in xs]
    sxy = sum((i - sx) * (xs[i] - my) for i in range(n))
    slope = sxy / sxx
    return [xs[i] - (my + slope * (i - sx)) for i in range(n)]


# ── spectral estimation ─────────────────────────────────────────────────────


def goertzel_power(xs: Sequence[float], fs: float, freq: float) -> float:
    """Power at a single frequency (Goertzel). O(n) per frequency, no FFT."""
    n = len(xs)
    if n < 4 or fs <= 0:
        return 0.0
    w = 2.0 * math.pi * freq / fs
    coeff = 2.0 * math.cos(w)
    s1 = s2 = 0.0
    for x in xs:
        s0 = x + coeff * s1 - s2
        s2, s1 = s1, s0
    power = s1 * s1 + s2 * s2 - coeff * s1 * s2
    return max(0.0, power) / (n * n)


@dataclass
class Spectrum:
    """Peak of a band-limited periodogram plus the SNR that justifies it."""

    peak_hz: float
    peak_power: float
    band_power: float
    total_power: float
    snr: float          # peak power / mean power of the rest of the band
    resolution_hz: float

    @property
    def bpm(self) -> float:
        return self.peak_hz * 60.0


def band_spectrum(
    xs: Sequence[float],
    fs: float,
    band: tuple[float, float],
    bins: int = 64,
) -> Spectrum:
    """Scan ``band`` with ``bins`` Goertzel probes and describe the peak.

    ``bins`` oversamples relative to the natural FFT resolution (fs/n) so the
    reported frequency is not quantised to coarse steps; ``resolution_hz``
    reports the honest resolution limit of the window, which the UI displays as
    the uncertainty on the rate.
    """
    lo, hi = band
    n = len(xs)
    if n < 16 or fs <= 0:
        return Spectrum(0.0, 0.0, 0.0, 0.0, 0.0, 0.0)
    hi = min(hi, fs / 2.0 * 0.95)
    if hi <= lo:
        return Spectrum(0.0, 0.0, 0.0, 0.0, 0.0, 0.0)

    win = hann(n)
    wx = [x * w for x, w in zip(xs, win)]
    step = (hi - lo) / max(1, bins - 1)
    freqs = [lo + i * step for i in range(bins)]
    powers = [goertzel_power(wx, fs, f) for f in freqs]

    peak_i = max(range(bins), key=lambda i: powers[i])
    peak_p = powers[peak_i]
    peak_f = freqs[peak_i]
    # Parabolic interpolation around the peak for sub-bin accuracy.
    if 0 < peak_i < bins - 1:
        a, b, c = powers[peak_i - 1], peak_p, powers[peak_i + 1]
        denom = a - 2 * b + c
        if denom != 0:
            peak_f = peak_f + 0.5 * (a - c) / denom * step

    band_p = sum(powers)
    others = [p for i, p in enumerate(powers) if abs(i - peak_i) > 1]
    noise = mean(others) if others else 0.0
    snr = peak_p / noise if noise > 0 else 0.0
    total_p = sum(x * x for x in wx) / (n * n)
    return Spectrum(
        peak_hz=peak_f,
        peak_power=peak_p,
        band_power=band_p,
        total_power=total_p,
        snr=snr,
        resolution_hz=fs / n,
    )


def hann(n: int) -> list[float]:
    if n <= 1:
        return [1.0] * n
    return [0.5 - 0.5 * math.cos(2.0 * math.pi * i / (n - 1)) for i in range(n)]


# ── peak picking → breath-to-breath intervals ───────────────────────────────


def peak_indices(xs: Sequence[float], min_distance: int, prominence: float) -> list[int]:
    """Local maxima at least ``min_distance`` apart and ``prominence`` above the
    surrounding trough — the refractory rule that stops a noisy waveform from
    reporting double breaths."""
    peaks: list[int] = []
    n = len(xs)
    for i in range(1, n - 1):
        if xs[i] <= xs[i - 1] or xs[i] < xs[i + 1]:
            continue
        lo = max(0, i - min_distance)
        hi = min(n, i + min_distance + 1)
        local_min = min(xs[lo:hi])
        if xs[i] - local_min < prominence:
            continue
        if peaks and i - peaks[-1] < min_distance:
            if xs[i] > xs[peaks[-1]]:
                peaks[-1] = i
            continue
        peaks.append(i)
    return peaks


def intervals_s(peaks: Sequence[int], fs: float) -> list[float]:
    if fs <= 0 or len(peaks) < 2:
        return []
    return [(peaks[i] - peaks[i - 1]) / fs for i in range(1, len(peaks))]


# ── time-stamped ring buffer with irregular-rate handling ───────────────────


@dataclass
class TimeSeries:
    """Ring buffer of (epoch_ms, value) with sample-rate estimation.

    Telemetry arrives at a nominally fixed rate but jitters; every estimate that
    depends on fs uses the measured rate rather than the nominal one.
    """

    window_s: float
    max_len: int = 4096
    _buf: Deque[tuple[int, float]] = field(default_factory=deque)

    def push(self, ts_ms: int, value: float) -> None:
        if value is None or not math.isfinite(value):
            return
        self._buf.append((ts_ms, float(value)))
        cutoff = ts_ms - int(self.window_s * 1000)
        while self._buf and self._buf[0][0] < cutoff:
            self._buf.popleft()
        while len(self._buf) > self.max_len:
            self._buf.popleft()

    def clear(self) -> None:
        self._buf.clear()

    def __len__(self) -> int:
        return len(self._buf)

    @property
    def values(self) -> list[float]:
        return [v for _, v in self._buf]

    @property
    def timestamps(self) -> list[int]:
        return [t for t, _ in self._buf]

    def span_s(self) -> float:
        if len(self._buf) < 2:
            return 0.0
        return (self._buf[-1][0] - self._buf[0][0]) / 1000.0

    def rate_hz(self) -> float:
        span = self.span_s()
        return (len(self._buf) - 1) / span if span > 0 else 0.0

    def latest(self) -> float | None:
        return self._buf[-1][1] if self._buf else None

    def resampled(self, fs: float) -> list[float]:
        """Uniformly resample onto ``fs`` by linear interpolation.

        Goertzel and the biquad both assume a uniform grid; feeding them jittered
        samples smears the spectral peak. Returns [] if the window is too short.
        """
        if len(self._buf) < 4 or fs <= 0:
            return []
        t0, t1 = self._buf[0][0], self._buf[-1][0]
        span = (t1 - t0) / 1000.0
        n = int(span * fs)
        if n < 8:
            return []
        out: list[float] = []
        j = 0
        pts = list(self._buf)
        for i in range(n):
            t = t0 + int(i * 1000.0 / fs)
            while j + 1 < len(pts) - 1 and pts[j + 1][0] < t:
                j += 1
            (ta, va), (tb, vb) = pts[j], pts[j + 1]
            if tb == ta:
                out.append(va)
            else:
                f = clamp((t - ta) / (tb - ta), 0.0, 1.0)
                out.append(va + f * (vb - va))
        return out


def normalize(xs: Sequence[float]) -> list[float]:
    """Zero-mean, unit-peak — for waveform display, not for analysis."""
    if not xs:
        return []
    m = mean(xs)
    centred = [x - m for x in xs]
    peak = max((abs(x) for x in centred), default=0.0)
    return [x / peak for x in centred] if peak > 1e-12 else [0.0] * len(xs)


def decimate(xs: Sequence[float], n: int) -> list[float]:
    """Down-sample to at most ``n`` points by block averaging (for transport)."""
    if n <= 0 or len(xs) <= n:
        return list(xs)
    block = len(xs) / n
    out: list[float] = []
    for i in range(n):
        lo = int(i * block)
        hi = max(lo + 1, int((i + 1) * block))
        out.append(mean(xs[lo:hi]))
    return out


def rolling_zscore(value: float, history: Iterable[float]) -> float:
    hs = list(history)
    if len(hs) < 8:
        return 0.0
    sd = stdev(hs)
    return 0.0 if sd < 1e-9 else (value - mean(hs)) / sd
