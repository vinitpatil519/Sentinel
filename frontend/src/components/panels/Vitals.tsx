"use client";

/**
 * Vital signs for one subject.
 *
 * Every rate on this panel carries three things beside it, and the panel is
 * worthless without them: how it was derived (our own CSI chain, the sensing
 * server's, or a fusion of both), how confident that derivation is, and — when
 * two independent chains produced a number — how far apart they were. A bare
 * "14.2 BPM" invites trust the measurement has not earned.
 *
 * When a rate cannot be measured the panel says why: motion contaminating the
 * band, no spectral lock, or a vitals stream that cannot be attributed to this
 * subject. It never falls back to a plausible number.
 */

import type { Track, UpstreamVitals } from "@/lib/types";
import {
  ATTRIBUTION_TEXT,
  METHOD_TEXT,
  confidenceWord,
  duration,
  num,
  pct,
} from "@/lib/format";
import { WaveTrace } from "@/components/charts";
import { Chip, Empty, Field, Meter, Panel, Readout, Section } from "@/components/ui";

export default function VitalsPanel({
  track,
  upstream,
  compact,
}: {
  track?: Track;
  upstream?: UpstreamVitals;
  compact?: boolean;
}) {
  if (!track) {
    return (
      <Panel code="B2" title="Vital Signs">
        <Empty title="No subject">No subject selected.</Empty>
      </Panel>
    );
  }

  const v = track.vitals;
  const resp = v.respiration;
  const card = v.cardiac;
  const feats = v.respiration_features;
  const motion = v.motion;

  const respColor =
    resp.confidence > 0.6 ? "var(--ok)" : resp.confidence > 0.3 ? "var(--warn)" : "var(--text-3)";
  const motionColor = motion.index > 55 ? "var(--alert)" : motion.index > 25 ? "var(--warn)" : "var(--ok)";

  return (
    <Panel
      code="B2"
      title="Vital Signs"
      right={
        <>
          <Chip
            color={v.attribution === "exclusive" ? "var(--text-2)" : "var(--warn)"}
            dot={v.attribution !== "exclusive"}
          >
            {ATTRIBUTION_TEXT[v.attribution] ?? v.attribution}
          </Chip>
          <span className="mono text-[11px] text-[var(--text-0)]">{track.id}</span>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {/* Respiration */}
        <div>
          <div className="flex items-start justify-between gap-3">
            <div className="flex flex-col gap-1.5">
              <span className="label">Respiration</span>
              <div className="flex items-baseline gap-2">
                <Readout
                  value={resp.bpm !== null ? num(resp.bpm) : "--"}
                  unit="BR/MIN"
                  size={compact ? 40 : 46}
                  color={respColor}
                />
                {resp.bpm !== null && resp.resolution_bpm > 0 && (
                  <span className="mono text-[10.5px] text-[var(--text-2)]">±{num(resp.resolution_bpm, 1)}</span>
                )}
              </div>
            </div>
            <div className="flex flex-none flex-col items-end gap-1.5 pt-0.5">
              <Chip color={resp.confidence > 0.5 ? "var(--ok)" : resp.confidence > 0 ? "var(--warn)" : "var(--unknown)"}>
                {METHOD_TEXT[resp.method] ?? resp.method.toUpperCase()}
              </Chip>
              <span className="mono text-[10px] text-[var(--text-1)]">
                {confidenceWord(resp.confidence)} · {num(resp.confidence, 2)}
              </span>
            </div>
          </div>
          <div className="mt-2">
            <Meter
              value={resp.confidence}
              color={respColor}
              height={3}
              uncertain={resp.confidence > 0 && resp.confidence < 0.35}
              ticks={[0.35]}
            />
          </div>
          {resp.method === "motion_blocked" && (
            <p className="mt-2 text-[10.5px] leading-snug" style={{ color: "var(--warn)" }}>
              Respiration band dominated by body motion — no rate is measurable while the
              subject is moving.
            </p>
          )}
          {resp.agreement_bpm !== null && (
            <p className="mt-2 text-[10.5px] leading-snug text-[var(--text-2)]">
              Independent chains differ by{" "}
              <span className="mono" style={{ color: resp.agreement_bpm > 2 ? "var(--warn)" : "var(--ok)" }}>
                {num(resp.agreement_bpm, 1)} BPM
              </span>
              {resp.agreement_bpm > 2 ? " — confidence reduced accordingly." : " — in agreement."}
            </p>
          )}
        </div>

        {/* Waveform */}
        <div>
          <Section
            right={
              <span className="mono text-[9px] text-[var(--text-2)]">
                0.1–0.5 HZ · {resp.snr > 0 ? `SNR ${num(resp.snr, 1)}` : "NO LOCK"}
              </span>
            }
          >
            Chest-motion trace
          </Section>
          <WaveTrace data={track.respiration_waveform} color={respColor} height={compact ? 78 : 110} />
        </div>

        {/* Respiration timing features */}
        <div>
          <Section>Breath timing</Section>
          <div className="grid grid-cols-2 gap-x-5">
            <Field
              label="Variability CV"
              value={num(feats.rrv_cv, 3)}
              color={feats.rrv_cv > 0.3 ? "var(--warn)" : "var(--text-0)"}
              title="Coefficient of variation of breath-to-breath intervals — the feature that separates sleep from deliberate stillness"
            />
            <Field label="Breaths held" value={String(feats.interval_count)} />
            <Field label="Mean interval" value={`${num(feats.mean_interval_s, 2)} s`} />
            <Field label="RMSSD" value={`${num(feats.rmssd_s, 2)} s`} />
            <Field
              label="Longest pause"
              value={`${num(feats.longest_pause_s, 1)} s`}
              color={feats.irregular ? "var(--deny)" : "var(--text-0)"}
            />
            <Field label="Depth CV" value={num(feats.amplitude_cv, 3)} />
          </div>
        </div>

        {feats.irregular && (
          <div
            className="border-l-2 px-2.5 py-2 text-[10.5px] leading-snug"
            style={{
              borderColor: "var(--deny)",
              background: "color-mix(in srgb, var(--deny) 9%, transparent)",
              color: "var(--deny)",
            }}
          >
            Irregular respiration: a pause exceeding 2.5× the running mean interval. Treated as
            evidence of distress by the state model.
          </div>
        )}

        {/* Cardiac */}
        <div>
          <Section
            right={
              <Chip color={card.bpm !== null ? "var(--text-1)" : "var(--unknown)"}>
                {METHOD_TEXT[card.method] ?? card.method.toUpperCase()}
              </Chip>
            }
          >
            Heart rate
          </Section>
          <div className="flex items-baseline justify-between">
            <Readout
              value={card.bpm !== null ? num(card.bpm, 0) : "--"}
              unit="BEATS/MIN"
              size={24}
              color={card.confidence > 0.4 ? "var(--text-0)" : "var(--text-3)"}
            />
            <span className="mono text-[10px] text-[var(--text-2)]">{confidenceWord(card.confidence)}</span>
          </div>
          {card.bpm === null && (
            <p className="note mt-1.5">
              Cardiac displacement is roughly two orders of magnitude smaller than respiratory. A
              single commodity link frequently cannot support the claim; unknown is reported
              rather than a number.
            </p>
          )}
        </div>

        {/* Motion */}
        <div>
          <Section
            right={
              <span className="mono text-[12px]" style={{ color: motionColor }}>
                {num(motion.index, 1)}
                <span className="ml-1 text-[9px] text-[var(--text-2)]">dB IDX</span>
              </span>
            }
          >
            Body motion
          </Section>
          <Meter value={motion.index / 100} color={motionColor} height={5} ticks={[0.25, 0.55]} />
          <div className="mt-2 grid grid-cols-2 gap-x-5">
            <Field label="Bursts / min" value={num(motion.burst_rate_per_min, 1)} />
            <Field
              label="Since burst"
              value={motion.seconds_since_burst > 900 ? "none" : duration(motion.seconds_since_burst)}
            />
            <Field label="Quiet floor" value={motion.quiet_floor.toExponential(1)} />
            <Field label="Observed" value={duration(motion.observed_s)} />
          </div>
          <p className="note mt-1.5">
            Decibels above this subject&apos;s own quiet floor, so comparable across rooms and
            node gains. Above 55 the respiration band is unusable.
          </p>
        </div>

        {/* Upstream comparison */}
        {upstream && (
          <div>
            <Section>Sensing-server estimate · independent</Section>
            <div className="grid grid-cols-2 gap-x-5">
              <Field
                label="Respiration"
                value={
                  upstream.breathing_rate_bpm !== null
                    ? `${num(upstream.breathing_rate_bpm)} BPM`
                    : "--"
                }
              />
              <Field label="Confidence" value={`${pct(upstream.breathing_confidence)}%`} />
              <Field
                label="Heart rate"
                value={upstream.heart_rate_bpm !== null ? `${num(upstream.heart_rate_bpm, 0)} BPM` : "--"}
              />
              <Field label="Signal qual." value={`${pct(upstream.signal_quality)}%`} />
            </div>
            {upstream.quality_verdict && (
              <div className="mono mt-1.5 text-[9.5px] text-[var(--text-2)]">
                VERDICT · {upstream.quality_verdict.replaceAll("_", " ").toUpperCase()}
              </div>
            )}
          </div>
        )}
      </div>
    </Panel>
  );
}
