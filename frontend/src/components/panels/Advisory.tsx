"use client";

/**
 * The approach advisory — the one output an operator acts on.
 *
 * Design constraints, in priority order:
 *   1. The decision must be readable across a room, in one glance, without
 *      parsing a number. Hence the full-width word in the panel's own colour.
 *   2. It must never be readable *without* its basis. The reason codes sit
 *      directly beneath it, always, not behind a tooltip — a recommendation a
 *      soldier cannot interrogate is one they will either over-trust or ignore.
 *   3. Absence of evidence must look different from evidence of safety. The
 *      INSUFFICIENT EVIDENCE state is grey and hatched, never green.
 */

import type { Track } from "@/lib/types";
import {
  DECISION_SUB,
  DECISION_TEXT,
  DECISION_VAR,
  STATE_VAR,
  confidenceWord,
  duration,
  num,
  pct,
} from "@/lib/format";
import { Chip, Empty, Meter, Panel, SegmentBar } from "@/components/ui";

export default function AdvisoryPanel({
  track,
  thresholds,
}: {
  track?: Track;
  thresholds?: Record<string, number>;
}) {
  if (!track || !track.advisory) {
    return (
      <Panel title="Approach Advisory" ticks>
        <Empty>
          No subject in the sensing volume. The advisory is issued per subject and
          appears when one is acquired.
        </Empty>
      </Panel>
    );
  }

  const { advisory, state } = track;
  const color = DECISION_VAR[advisory.decision];
  const deny = advisory.decision === "DO_NOT_APPROACH";
  const unknown = advisory.decision === "INSUFFICIENT_EVIDENCE";
  const readiness = advisory.readiness_index;

  const ticks = thresholds
    ? [
        thresholds.approach_max_arousal ?? 0.25,
        thresholds.caution_max_arousal ?? 0.45,
        thresholds.hold_max_arousal ?? 0.7,
      ]
    : [0.25, 0.45, 0.7];

  return (
    <Panel
      title="Approach Advisory"
      accent={color}
      ticks
      right={
        <span className="mono text-[11px] text-[var(--text-1)]">{track.id}</span>
      }
    >
      <div className={`flex flex-col gap-4 ${deny ? "deny-edge" : ""}`}>
        {/* Decision */}
        <div>
          <div className="flex items-center gap-3">
            <span
              className={`h-9 w-[5px] ${unknown ? "hatch" : ""}`}
              style={{ background: unknown ? undefined : color }}
            />
            <span
              className="text-[26px] leading-none font-semibold tracking-[0.02em]"
              style={{ color }}
            >
              {DECISION_TEXT[advisory.decision]}
            </span>
          </div>
          <p className="mt-2 text-[11px] leading-snug text-[var(--text-1)]">
            {DECISION_SUB[advisory.decision]}
          </p>
        </div>

        {/* Readiness index */}
        <div className="flex flex-col gap-1.5">
          <div className="flex items-baseline justify-between">
            <span className="label">Reflex readiness index</span>
            <span className="mono text-[15px]" style={{ color }}>
              {num(readiness, 2)}
            </span>
          </div>
          <SegmentBar value={readiness} color={color} segments={28} height={11} />
          <div className="relative h-3">
            {ticks.map((t) => (
              <span
                key={t}
                className="absolute top-0 flex -translate-x-1/2 flex-col items-center"
                style={{ left: `${t * 100}%` }}
              >
                <span className="h-1 w-px bg-[var(--line-strong)]" />
                <span className="mono text-[8px] text-[var(--text-3)]">{t.toFixed(2)}</span>
              </span>
            ))}
          </div>
        </div>

        {/* Basis */}
        <div>
          <span className="label">Basis</span>
          <ul className="mt-1.5 flex flex-col gap-1">
            {advisory.reason_text.length === 0 && (
              <li className="text-[11px] text-[var(--text-2)]">
                Nominal — no modifier applied to the state posterior.
              </li>
            )}
            {advisory.reason_text.map((text, i) => (
              <li key={advisory.reasons[i] ?? text} className="flex gap-2 text-[11px] leading-snug">
                <span
                  className="mt-[5px] h-[3px] w-[3px] flex-none"
                  style={{ background: color }}
                />
                <span className="text-[var(--text-1)]">{text}</span>
              </li>
            ))}
          </ul>
        </div>

        {/* Supporting figures */}
        <div className="grid grid-cols-3 gap-3 border-t border-[var(--line)] pt-3">
          <Figure
            label="Advisory conf."
            value={num(advisory.confidence, 2)}
            sub={confidenceWord(advisory.confidence)}
            meter={advisory.confidence}
          />
          <Figure
            label="Stability 15s"
            value={num(advisory.stability, 2)}
            sub={advisory.stability > 0.6 ? "STEADY" : "FLUCTUATING"}
            meter={advisory.stability}
          />
          <Figure
            label="Quiet window"
            value={advisory.quiet_window_s !== null ? duration(advisory.quiet_window_s) : "--"}
            sub={advisory.quiet_window_s !== null ? "EXPECTED" : "NOT OFFERED"}
          />
        </div>

        {/* Behavioural state */}
        {state && (
          <div className="border-t border-[var(--line)] pt-3">
            <div className="flex items-center justify-between gap-2">
              <span className="label">Behavioural state</span>
              {state.state ? (
                <Chip color={STATE_VAR[state.state]} dot>
                  {state.state.replace("_", " ")}
                </Chip>
              ) : (
                <Chip color="var(--unknown)">UNRESOLVED</Chip>
              )}
            </div>
            <p className="mt-1.5 text-[11px] leading-snug text-[var(--text-2)]">{state.label}</p>
            <div className="mt-2 grid grid-cols-3 gap-3">
              <Figure label="State conf." value={num(state.confidence, 2)} meter={state.confidence} />
              <Figure label="Evidence" value={num(state.evidence, 2)} meter={state.evidence} />
              <Figure label="Dwell" value={duration(state.dwell_s)} sub={`${state.features_used} FEATURES`} />
            </div>
          </div>
        )}

        {/* Posterior */}
        {state && (
          <div>
            <span className="label">State posterior</span>
            <div className="mt-1.5 flex flex-col gap-[3px]">
              {Object.entries(state.posterior)
                .sort((a, b) => b[1] - a[1])
                .map(([name, p]) => (
                  <div key={name} className="flex items-center gap-2">
                    <span className="mono w-[86px] text-[9.5px] text-[var(--text-2)]">{name}</span>
                    <div className="flex-1">
                      <Meter
                        value={p}
                        color={STATE_VAR[name as keyof typeof STATE_VAR]}
                        height={5}
                      />
                    </div>
                    <span className="mono w-8 text-right text-[9.5px] text-[var(--text-2)]">
                      {pct(p)}
                    </span>
                  </div>
                ))}
            </div>
          </div>
        )}
      </div>
    </Panel>
  );
}

function Figure({
  label,
  value,
  sub,
  meter,
}: {
  label: string;
  value: string;
  sub?: string;
  meter?: number;
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="label">{label}</span>
      <span className="mono text-[14px] text-[var(--text-0)]">{value}</span>
      {meter !== undefined && <Meter value={meter} color="var(--text-3)" height={3} />}
      {sub && <span className="mono text-[9px] text-[var(--text-3)]">{sub}</span>}
    </div>
  );
}
