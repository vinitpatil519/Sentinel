"use client";

/**
 * Vitals — the estimator's own instrument panel.
 *
 * One subject at a time, at full size: the chest-motion waveform, the rate
 * history from both independent chains plotted against each other, and the
 * variability features the behavioural model consumes. This is the page used
 * to decide whether a respiration lock is trustworthy, so it shows the raw
 * evidence (SNR, window occupancy, agreement) rather than summarising it away.
 */

import { useMemo, useState } from "react";
import { Sparkline, WaveTrace } from "@/components/charts";
import VitalsPanel from "@/components/panels/Vitals";
import { useSelection } from "@/components/Shell";
import { Chip, Empty, Field, Panel, Readout, Stat } from "@/components/ui";
import { useChannelHistory, useTracks, useUpstreamVitals } from "@/lib/telemetry";
import { METHOD_TEXT, confidenceWord, duration, num, pct } from "@/lib/format";
import type { TrackState, UpstreamVitals } from "@/lib/types";

export default function Vitals() {
  const tracks = useTracks();
  const upstream = useUpstreamVitals();
  const trackHistory = useChannelHistory("track.state");
  const vitalsHistory = useChannelHistory("rf.vitals");
  const { selected, select } = useSelection();
  const [showUpstream, setShowUpstream] = useState(true);

  const list = useMemo(() => tracks?.tracks ?? [], [tracks]);
  const focus = useMemo(() => list.find((t) => t.id === selected) ?? list[0], [list, selected]);

  const series = useMemo(() => {
    if (!focus) return { local: [], conf: [], motion: [], rrv: [] };
    const local: number[] = [];
    const conf: number[] = [];
    const motion: number[] = [];
    const rrv: number[] = [];
    for (const msg of trackHistory) {
      const t = (msg.data as unknown as TrackState).tracks?.find((x) => x.id === focus.id);
      if (!t) continue;
      if (t.vitals.respiration.bpm !== null) local.push(t.vitals.respiration.bpm);
      conf.push(t.vitals.respiration.confidence);
      motion.push(t.vitals.motion.index);
      rrv.push(t.vitals.respiration_features.rrv_cv);
    }
    return { local, conf, motion, rrv };
  }, [trackHistory, focus]);

  const upstreamSeries = useMemo(
    () =>
      vitalsHistory
        .map((m) => (m.data as unknown as UpstreamVitals).breathing_rate_bpm)
        .filter((v): v is number => v !== null),
    [vitalsHistory],
  );

  if (!focus) {
    return (
      <Panel title="Vital Signs">
        <Empty>No subject in the sensing volume — nothing to analyse.</Empty>
      </Panel>
    );
  }

  const resp = focus.vitals.respiration;
  const feats = focus.vitals.respiration_features;

  return (
    <div className="grid h-full min-h-0 gap-3" style={{ gridTemplateColumns: "minmax(0,1fr) 372px" }}>
      <div className="flex min-h-0 flex-col gap-3 overflow-y-auto pr-0.5">
        <Panel
          title="Respiration — chest-motion waveform"
          ticks
          right={
            <>
              {list.length > 1 && (
                <div className="flex gap-1">
                  {list.map((t) => (
                    <button
                      key={t.id}
                      className="btn"
                      data-active={t.id === focus.id}
                      onClick={() => select(t.id)}
                    >
                      {t.id}
                    </button>
                  ))}
                </div>
              )}
              <Chip color={resp.confidence > 0.5 ? "var(--ok)" : "var(--warn)"}>
                {METHOD_TEXT[resp.method] ?? resp.method}
              </Chip>
            </>
          }
        >
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-end gap-8">
              <div>
                <span className="label">Rate</span>
                <div className="mt-1 flex items-baseline gap-2">
                  <Readout
                    value={resp.bpm !== null ? num(resp.bpm) : "--"}
                    unit="BREATHS/MIN"
                    size={44}
                    color={resp.confidence > 0.6 ? "var(--ok)" : "var(--warn)"}
                  />
                  {resp.bpm !== null && (
                    <span className="mono text-[11px] text-[var(--text-3)]">
                      ±{num(resp.resolution_bpm, 1)}
                    </span>
                  )}
                </div>
              </div>
              <Stat label="Spectral SNR" value={num(resp.snr, 1)} hint="floor 7.5 (p95 of noise)" />
              <Stat label="Confidence" value={num(resp.confidence, 2)} hint={confidenceWord(resp.confidence)} />
              <Stat label="Variability CV" value={num(feats.rrv_cv, 3)} hint="breath-to-breath" />
              <Stat label="Breaths held" value={String(feats.interval_count)} hint="in 45 s window" />
              {resp.agreement_bpm !== null && (
                <Stat
                  label="Chain agreement"
                  value={`${num(resp.agreement_bpm, 1)}`}
                  hint="BPM apart"
                  color={resp.agreement_bpm > 2 ? "var(--warn)" : "var(--ok)"}
                />
              )}
            </div>

            <WaveTrace
              data={focus.respiration_waveform}
              color={resp.confidence > 0.6 ? "var(--ok)" : "var(--warn)"}
              height={168}
              label="BAND-PASS 0.1–0.5 Hz · ZERO-PHASE · NORMALISED"
            />
          </div>
        </Panel>

        <Panel
          title="Rate history — independent chains"
          right={
            <button className="btn" data-active={showUpstream} onClick={() => setShowUpstream((v) => !v)}>
              Sensing server overlay
            </button>
          }
        >
          <div className="flex flex-col gap-3">
            <div>
              <div className="mb-1 flex items-baseline justify-between">
                <span className="label">SENTINEL CSI chain</span>
                <span className="mono text-[9px] text-[var(--text-3)]">
                  {series.local.length} ESTIMATES
                </span>
              </div>
              <Sparkline data={series.local} color="var(--ok)" height={64} fill />
            </div>
            {showUpstream && (
              <div>
                <div className="mb-1 flex items-baseline justify-between">
                  <span className="label">Sensing-server chain</span>
                  <span className="mono text-[9px] text-[var(--text-3)]">
                    {upstreamSeries.length} ESTIMATES
                  </span>
                </div>
                <Sparkline data={upstreamSeries} color="var(--accent)" height={64} fill />
              </div>
            )}
            <p className="text-[9.5px] leading-snug text-[var(--text-3)]">
              Two estimators over the same physical signal, kept separate on purpose. They are
              fused only when they agree within 2 BPM; a wider disagreement keeps the local
              estimate and lowers its confidence rather than averaging the two into a number
              neither chain produced.
            </p>
          </div>
        </Panel>

        <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))" }}>
          <Panel title="Respiration confidence">
            <Sparkline data={series.conf} color="var(--accent)" height={56} min={0} max={1} threshold={0.35} fill />
            <div className="mt-2 grid grid-cols-2 gap-x-5">
              <Field label="Current" value={num(resp.confidence, 2)} />
              <Field label="Method" value={METHOD_TEXT[resp.method] ?? resp.method} />
            </div>
          </Panel>

          <Panel title="Body motion index">
            <Sparkline data={series.motion} color="var(--alert)" height={56} min={0} max={100} threshold={55} fill />
            <div className="mt-2 grid grid-cols-2 gap-x-5">
              <Field label="Current" value={num(focus.vitals.motion.index, 1)} />
              <Field label="Bursts/min" value={num(focus.vitals.motion.burst_rate_per_min, 1)} />
              <Field label="Since burst" value={duration(focus.vitals.motion.seconds_since_burst)} />
              <Field label="Blocking" value={focus.vitals.motion.index >= 55 ? "YES" : "NO"} />
            </div>
          </Panel>

          <Panel title="Respiratory variability">
            <Sparkline data={series.rrv} color="var(--warn)" height={56} min={0} max={0.6} threshold={0.3} fill />
            <div className="mt-2 grid grid-cols-2 gap-x-5">
              <Field label="CV" value={num(feats.rrv_cv, 3)} />
              <Field label="RMSSD" value={`${num(feats.rmssd_s, 2)} s`} />
              <Field label="Longest pause" value={`${num(feats.longest_pause_s, 1)} s`} />
              <Field label="Irregular" value={feats.irregular ? "YES" : "NO"} />
            </div>
            <p className="mt-2 text-[9.5px] leading-snug text-[var(--text-3)]">
              Variability is the discriminator between sleep and deliberate stillness — motion
              cannot separate those two, and rate alone barely can.
            </p>
          </Panel>

          {upstream && (
            <Panel title="Upstream quality">
              <div className="grid grid-cols-2 gap-x-5">
                <Field label="Breathing conf." value={`${pct(upstream.breathing_confidence)}%`} />
                <Field label="Heartbeat conf." value={`${pct(upstream.heartbeat_confidence)}%`} />
                <Field label="Signal quality" value={`${pct(upstream.signal_quality)}%`} />
                <Field label="Verdict" value={upstream.quality_verdict ?? "--"} />
                <Field label="Source" value={upstream.source} />
                <Field label="Provenance" value={upstream.provenance} />
              </div>
            </Panel>
          )}
        </div>
      </div>

      <div className="min-h-0 overflow-y-auto pr-0.5">
        <VitalsPanel track={focus} upstream={upstream} />
      </div>
    </div>
  );
}
