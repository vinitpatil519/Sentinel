"use client";

/**
 * The approach advisory — the one output an operator acts on.
 *
 * Design constraints, in priority order:
 *   1. The decision must be readable across a room, in one glance, without
 *      parsing a number. Hence the full-width word in the panel's own colour.
 *   2. It must never be readable *without* its basis. The reason codes sit
 *      directly beneath it, always, not behind a tooltip — a recommendation an
 *      operator cannot interrogate is one they will either over-trust or ignore.
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
import { Empty, Meter, Panel, Section, ZoneTape } from "@/components/ui";

export default function AdvisoryPanel({
  track,
  thresholds,
}: {
  track?: Track;
  thresholds?: Record<string, number>;
}) {
  if (!track || !track.advisory) {
    return (
      <Panel code="B1" title="Approach Advisory" ticks>
        <Empty title="No subject">
          The advisory is issued per subject and appears when one is acquired in the sensing
          volume.
        </Empty>
      </Panel>
    );
  }

  const { advisory, state } = track;
  const color = DECISION_VAR[advisory.decision];
  const deny = advisory.decision === "DO_NOT_APPROACH";
  const unknown = advisory.decision === "INSUFFICIENT_EVIDENCE";
  const readiness = advisory.readiness_index;

  const t = {
    approach: thresholds?.approach_max_arousal ?? 0.25,
    caution: thresholds?.caution_max_arousal ?? 0.45,
    hold: thresholds?.hold_max_arousal ?? 0.7,
  };

  return (
    <Panel
      code="B1"
      title="Approach Advisory"
      accent={color}
      right={
        <span className="mono text-[11px] text-[var(--text-1)]">
          SUBJ <span className="text-[var(--text-0)]">{track.id}</span>
        </span>
      }
      bodyClassName="!p-0"
    >
      {/* Decision */}
      <div
        className={`relative overflow-hidden border-b border-[var(--line)] px-4 pt-3.5 pb-3 ${deny ? "deny-edge" : ""}`}
        style={{
          background: unknown
            ? "transparent"
            : `linear-gradient(90deg, color-mix(in srgb, ${color} 16%, transparent), color-mix(in srgb, ${color} 3%, transparent) 70%)`,
        }}
      >
        {unknown && <span className="hatch absolute inset-0 opacity-[0.18]" />}
        <div className="relative flex items-stretch gap-3">
          <span className={`w-[6px] flex-none ${unknown ? "hatch" : ""}`} style={{ background: unknown ? undefined : color, boxShadow: unknown ? undefined : `0 0 14px ${color}` }} />
          <div className="flex min-w-0 flex-col gap-1">
            <span className="label text-[10px]" style={{ color }}>
              Recommendation
            </span>
            <span
              className="display text-[34px] leading-[0.95] font-bold"
              style={{ color, letterSpacing: "0.06em" }}
            >
              {DECISION_TEXT[advisory.decision]}
            </span>
            <span className="text-[11.5px] leading-snug text-[var(--text-1)]">
              {DECISION_SUB[advisory.decision]}
            </span>
          </div>
        </div>
      </div>

      <div className="flex flex-col gap-4 p-4">
        {/* Readiness index against the decision thresholds */}
        <div>
          <div className="mb-1 flex items-baseline justify-between">
            <span className="label">Reflex readiness index</span>
            <span className="readout text-[22px]" style={{ color }}>
              {num(readiness, 2)}
            </span>
          </div>
          <ZoneTape
            value={readiness}
            uncertain={unknown}
            zones={[
              { to: t.approach, color: "var(--advisory-approach)", label: "APPROACH" },
              { to: t.caution, color: "var(--advisory-caution)", label: "CAUTION" },
              { to: t.hold, color: "var(--advisory-hold)", label: "HOLD" },
              { to: 1, color: "var(--advisory-deny)", label: "DENY" },
            ]}
          />
        </div>

        {/* Basis */}
        <div>
          <Section right={<span className="mono text-[9.5px] text-[var(--text-3)]">{advisory.reasons.length} CODES</span>}>
            Basis
          </Section>
          <ul className="flex flex-col gap-1.5">
            {advisory.reason_text.length === 0 && (
              <li className="text-[11px] text-[var(--text-2)]">
                Nominal — no modifier applied to the state posterior.
              </li>
            )}
            {advisory.reason_text.map((text, i) => (
              <li key={advisory.reasons[i] ?? text} className="flex items-start gap-2 text-[11.5px] leading-snug">
                <span className="mono mt-[1px] flex-none text-[10px]" style={{ color }}>
                  {String(i + 1).padStart(2, "0")}
                </span>
                <span className="text-[var(--text-1)]">
                  {text}
                  {advisory.reasons[i] && (
                    <span className="mono ml-1.5 text-[9.5px] text-[var(--text-3)]">[{advisory.reasons[i]}]</span>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </div>

        {/* Supporting figures */}
        <div className="grid grid-cols-3 border border-[var(--line)]">
          <Figure
            label="Adv. conf"
            value={num(advisory.confidence, 2)}
            sub={confidenceWord(advisory.confidence)}
            meter={advisory.confidence}
          />
          <Figure
            label="Stability"
            value={num(advisory.stability, 2)}
            sub={advisory.stability > 0.6 ? "STEADY · 15S" : "FLUCTUATING"}
            meter={advisory.stability}
          />
          <Figure
            label="Quiet window"
            value={advisory.quiet_window_s !== null ? duration(advisory.quiet_window_s) : "--"}
            sub={advisory.quiet_window_s !== null ? "EXPECTED" : "NOT OFFERED"}
            last
          />
        </div>

        {/* Behavioural state */}
        {state && (
          <div>
            <Section
              right={
                <span
                  className="chip"
                  style={{ color: state.state ? STATE_VAR[state.state] : "var(--unknown)" }}
                >
                  <span className="dot" />
                  {state.state ? state.state.replace("_", " ") : "Unresolved"}
                </span>
              }
            >
              Behavioural state
            </Section>
            <p className="text-[11px] leading-snug text-[var(--text-2)]">{state.label}</p>
            <div className="mt-2.5 grid grid-cols-3 border border-[var(--line)]">
              <Figure label="State conf" value={num(state.confidence, 2)} meter={state.confidence} />
              <Figure label="Evidence" value={num(state.evidence, 2)} meter={state.evidence} />
              <Figure label="Dwell" value={duration(state.dwell_s)} sub={`${state.features_used} FEATURES`} last />
            </div>

            <div className="mt-3 flex flex-col gap-[5px]">
              {Object.entries(state.posterior)
                .sort((a, b) => b[1] - a[1])
                .map(([name, p], i) => {
                  const c = STATE_VAR[name as keyof typeof STATE_VAR];
                  return (
                    <div key={name} className="flex items-center gap-2">
                      <span
                        className="mono w-[92px] flex-none text-[9.5px]"
                        style={{ color: i === 0 ? c : "var(--text-2)" }}
                      >
                        {name}
                      </span>
                      <div className="flex-1">
                        <Meter value={p} color={c} height={i === 0 ? 6 : 4} />
                      </div>
                      <span className="mono w-9 text-right text-[10px] text-[var(--text-1)]">
                        {pct(p)}%
                      </span>
                    </div>
                  );
                })}
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
  last,
}: {
  label: string;
  value: string;
  sub?: string;
  meter?: number;
  last?: boolean;
}) {
  return (
    <div className={`flex flex-col gap-1 px-2.5 py-2 ${last ? "" : "border-r border-[var(--line)]"}`}>
      <span className="label text-[10px]">{label}</span>
      <span className="mono text-[15px] leading-none text-[var(--text-0)]">{value}</span>
      {meter !== undefined && <Meter value={meter} color="var(--accent)" height={2} />}
      {sub && <span className="mono text-[9px] text-[var(--text-2)]">{sub}</span>}
    </div>
  );
}
