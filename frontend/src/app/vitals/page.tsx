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
import { Chip, Empty, Field, Panel, Readout, Section } from "@/components/ui";
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
      <Panel code="D1" title="Vital Signs">
        <Empty title="No subject">No subject in the sensing volume — nothing to analyse.</Empty>
      </Panel>
    );
  }

  const resp = focus.vitals.respiration;
  const feats = focus.vitals.respiration_features;
  const respColor = resp.confidence > 0.6 ? "var(--ok)" : resp.confidence > 0.3 ? "var(--warn)" : "var(--text-3)";

  return (
    <div className="grid h-full min-h-0 gap-2.5" style={{ gridTemplateColumns: "minmax(0,1fr) 384px" }}>
      <div className="flex min-h-0 flex-col gap-2.5 overflow-y-auto pr-0.5 [&>*]:shrink-0">
        <Panel
          code="D1"
          title="Respiration — chest-motion waveform"
          ticks
          right={
            <>
              {list.length > 1 && (
                <div className="flex">
                  {list.map((t) => (
                    <button
                      key={t.id}
                      className="btn h-[22px] px-2 text-[10.5px]"
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
            <div className="grid border border-[var(--line)]" style={{ gridTemplateColumns: "minmax(0,1.6fr) repeat(5, minmax(0,1fr))" }}>
              <div className="flex flex-col gap-2 border-r border-[var(--line)] px-3.5 py-3">
                <span className="label">Respiration rate</span>
                <div className="flex items-baseline gap-2">
                  <Readout value={resp.bpm !== null ? num(resp.bpm) : "--"} unit="BR/MIN" size={44} color={respColor} />
                  {resp.bpm !== null && (
                    <span className="mono text-[11px] text-[var(--text-2)]">±{num(resp.resolution_bpm, 1)}</span>
                  )}
                </div>
              </div>
              <Tile label="Spectral SNR" value={num(resp.snr, 1)} hint="floor 7.5 · p95 noise" color={resp.snr >= 7.5 ? "var(--ok)" : "var(--warn)"} />
              <Tile label="Confidence" value={num(resp.confidence, 2)} hint={confidenceWord(resp.confidence)} />
              <Tile label="Variability CV" value={num(feats.rrv_cv, 3)} hint="breath-to-breath" color={feats.rrv_cv > 0.3 ? "var(--warn)" : undefined} />
              <Tile label="Breaths held" value={String(feats.interval_count)} hint="45 s window" />
              <Tile
                label="Chain delta"
                value={resp.agreement_bpm !== null ? num(resp.agreement_bpm, 1) : "--"}
                hint={resp.agreement_bpm !== null ? "BPM apart" : "single chain"}
                color={resp.agreement_bpm === null ? undefined : resp.agreement_bpm > 2 ? "var(--warn)" : "var(--ok)"}
                last
              />
            </div>

            <WaveTrace
              data={focus.respiration_waveform}
              color={respColor === "var(--text-3)" ? "var(--warn)" : respColor}
              height={190}
              label="BAND-PASS 0.1–0.5 HZ · ZERO-PHASE · NORMALISED"
            />
          </div>
        </Panel>

        <Panel
          code="D2"
          title="Rate history — independent chains"
          right={
            <button className="btn h-[22px] px-2 text-[10.5px]" data-active={showUpstream} onClick={() => setShowUpstream((v) => !v)}>
              Sensing-server overlay
            </button>
          }
        >
          <div className="flex flex-col gap-3">
            <div>
              <Section right={<span className="mono text-[9px] text-[var(--text-2)]">{series.local.length} ESTIMATES</span>}>
                SENTINEL CSI chain · BPM
              </Section>
              <Sparkline data={series.local} color="var(--ok)" height={78} fill scale />
            </div>
            {showUpstream && (
              <div>
                <Section right={<span className="mono text-[9px] text-[var(--text-2)]">{upstreamSeries.length} ESTIMATES</span>}>
                  Sensing-server chain · BPM
                </Section>
                <Sparkline data={upstreamSeries} color="var(--accent)" height={78} fill scale />
              </div>
            )}
            <p className="note">
              Two estimators over the same physical signal, kept separate on purpose. They are
              fused only when they agree within 2 BPM; a wider disagreement keeps the local
              estimate and lowers its confidence rather than averaging the two into a number
              neither chain produced.
            </p>
          </div>
        </Panel>

        <div className="grid gap-2.5" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))" }}>
          <Panel code="D3" title="Respiration confidence">
            <Sparkline data={series.conf} color="var(--accent)" height={74} min={0} max={1} threshold={0.35} fill scale />
            <div className="mt-2.5 grid grid-cols-1">
              <Field label="Current" value={num(resp.confidence, 2)} />
              <Field label="Method" value={METHOD_TEXT[resp.method] ?? resp.method} />
              <Field label="Threshold" value="0.35" color="var(--text-2)" />
            </div>
          </Panel>

          <Panel code="D4" title="Body motion index">
            <Sparkline data={series.motion} color="var(--alert)" height={74} min={0} max={100} threshold={55} fill scale />
            <div className="mt-2.5 grid grid-cols-1">
              <Field label="Current" value={num(focus.vitals.motion.index, 1)} />
              <Field label="Bursts / min" value={num(focus.vitals.motion.burst_rate_per_min, 1)} />
              <Field label="Since burst" value={duration(focus.vitals.motion.seconds_since_burst)} />
              <Field
                label="Blocking resp"
                value={focus.vitals.motion.index >= 55 ? "YES" : "NO"}
                color={focus.vitals.motion.index >= 55 ? "var(--alert)" : "var(--ok)"}
              />
            </div>
          </Panel>

          <Panel code="D5" title="Respiratory variability">
            <Sparkline data={series.rrv} color="var(--warn)" height={74} min={0} max={0.6} threshold={0.3} fill scale />
            <div className="mt-2.5 grid grid-cols-1">
              <Field label="CV" value={num(feats.rrv_cv, 3)} />
              <Field label="RMSSD" value={`${num(feats.rmssd_s, 2)} s`} />
              <Field label="Longest pause" value={`${num(feats.longest_pause_s, 1)} s`} />
              <Field label="Irregular" value={feats.irregular ? "YES" : "NO"} color={feats.irregular ? "var(--deny)" : "var(--ok)"} />
            </div>
            <p className="note mt-2">
              Variability separates sleep from deliberate stillness — motion cannot, and rate alone
              barely can.
            </p>
          </Panel>

          {upstream && (
            <Panel code="D6" title="Upstream quality">
              <div className="grid grid-cols-1">
                <Field label="Breathing conf" value={`${pct(upstream.breathing_confidence)}%`} />
                <Field label="Heartbeat conf" value={`${pct(upstream.heartbeat_confidence)}%`} />
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

function Tile({
  label,
  value,
  hint,
  color,
  last,
}: {
  label: string;
  value: string;
  hint?: string;
  color?: string;
  last?: boolean;
}) {
  return (
    <div className={`flex flex-col justify-between gap-2 px-3 py-3 ${last ? "" : "border-r border-[var(--line)]"}`}>
      <span className="label text-[10.5px]">{label}</span>
      <Readout value={value} size={22} color={color} />
      {hint && <span className="mono truncate text-[9px] text-[var(--text-2)] uppercase">{hint}</span>}
    </div>
  );
}
