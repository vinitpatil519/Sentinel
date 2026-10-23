"use client";

/**
 * The approach advisory — the one output an operator acts on.
 *
 * Laid out like a caution/warning panel and read top to bottom, each block
 * answering the question the one above it raises:
 *
 *   decision  →  the rule it rests on  →  the reading against its limits
 *             →  what modified it      →  how far to trust it
 *
 * Design constraints, in priority order:
 *   1. The decision reads across a room without parsing a number: a lit
 *      annunciator in the decision's colour with a dark legend. Nothing on it
 *      moves except a brief flash when the decision changes.
 *   2. It is never shown without its basis. The backend names the one policy
 *      rule each decision rests on, and it sits directly under the annunciator
 *      with the figures that tripped it — a restriction with nothing beneath
 *      it is one an operator will either over-trust or ignore.
 *   3. Absence of evidence looks different from evidence of safety.
 *      INSUFFICIENT EVIDENCE is an unlit, hatched annunciator — never a colour.
 *   4. A held decision says so. While the policy waits out the de-escalation
 *      dwell, the relief it is waiting for and the time left are on screen, so
 *      a restriction that outlasts its reading is not mistaken for a fault.
 */

import type { Advisory, StateEstimate, Track } from "@/lib/types";
import {
  DASH,
  DECISION_TEXT,
  DECISION_VAR,
  STATE_VAR,
  confidenceWord,
  duration,
  num,
  pct,
} from "@/lib/format";
import { Empty, Meter, Panel, Section, ZoneTape } from "@/components/ui";

/** The policy limits the advisory is drawn against (backend PolicyConfig). */
type Limits = {
  approach: number;
  caution: number;
  hold: number;
  minEvidence: number;
  minDwell: number;
};

function limitsFrom(t?: Record<string, number | boolean>): Limits {
  const n = (key: string, fallback: number) => (typeof t?.[key] === "number" ? (t[key] as number) : fallback);
  return {
    approach: n("approach_max_arousal", 0.25),
    caution: n("caution_max_arousal", 0.45),
    hold: n("hold_max_arousal", 0.7),
    minEvidence: n("min_evidence", 0.35),
    minDwell: n("approach_min_dwell_s", 45),
  };
}

/** What each modifier does to the decision — the column an operator scans. */
const MODIFIER_EFFECT: Record<string, string> = {
  OBSERVED_MOTION: "RAISES",
  RECENT_MOVEMENT: "RAISES",
  ELEVATED_VARIABILITY: "RAISES",
  RATE_RISING: "RAISES",
  ACTIVE_MOTION: "RAISES",
  IRREGULAR_RESPIRATION: "RAISES",
  WEAK_EVIDENCE: "LIMITS",
  NO_RESPIRATION_LOCK: "LIMITS",
  VITALS_UNATTRIBUTED: "LIMITS",
  MULTIPLE_SUBJECTS: "LIMITS",
  STATE_UNSTABLE: "LIMITS",
  DE_ESCALATION_HOLD: "HOLDS",
  SLEEP_CONSISTENT: "SUPPORTS",
  LOW_AROUSAL_SUSTAINED: "SUPPORTS",
};

/**
 * Sort order for the modifier list. The list is read top down, often no
 * further than the first line or two, so its order is itself a statement of
 * what matters most: what raises the danger first, then what limits trust in
 * the reading, then the hysteresis hold, and what supports approach last.
 */
const EFFECT_ORDER = ["RAISES", "LIMITS", "HOLDS", "SUPPORTS"];

function rankModifier(code: string): number {
  const i = EFFECT_ORDER.indexOf(MODIFIER_EFFECT[code] ?? "");
  return i === -1 ? EFFECT_ORDER.length : i;
}

/** The figures that tripped the basis rule, written as the comparison made. */
function basisFigure(a: Advisory, s: StateEstimate | undefined, L: Limits): string | null {
  const r = num(a.readiness_index, 2);
  switch (a.basis) {
    case "AROUSAL_ABOVE_HOLD":
      return `${r} > ${num(L.hold, 2)}`;
    case "AROUSAL_HOLD_BAND":
      return `${num(L.caution, 2)} < ${r} ≤ ${num(L.hold, 2)}`;
    case "AROUSAL_CAUTION_BAND":
      return `${num(L.approach, 2)} < ${r} ≤ ${num(L.caution, 2)}`;
    case "SECOND_SUBJECT":
    case "NOT_ASLEEP":
      return `${r} ≤ ${num(L.approach, 2)}`;
    case "SLEEP_DWELL_SHORT":
      return s ? `${duration(s.dwell_s)} < ${duration(L.minDwell)}` : null;
    case "SLEEP_DWELL_MET":
      return s ? `${duration(s.dwell_s)} ≥ ${duration(L.minDwell)}` : null;
    case "EVIDENCE_BELOW_MINIMUM":
      return s ? `${num(s.evidence, 2)} < ${num(L.minEvidence, 2)}` : null;
    case "STATE_DISTRESSED":
      return s ? `P ${pct(s.posterior.DISTRESSED)}%` : null;
    default:
      return null;
  }
}

export default function AdvisoryPanel({
  track,
  thresholds,
}: {
  track?: Track;
  thresholds?: Record<string, number | boolean>;
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

  const { advisory: a, state } = track;
  const L = limitsFrom(thresholds);
  const color = DECISION_VAR[a.decision];
  const unlit = a.decision === "INSUFFICIENT_EVIDENCE";
  const held = a.pending != null;
  const legend = DECISION_TEXT[a.decision];
  const figure = basisFigure(a, state, L);
  const modifiers = a.reasons
    .map((code, i) => ({ code, text: a.reason_text[i] ?? code }))
    .sort((x, y) => rankModifier(x.code) - rankModifier(y.code));

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
      {/* Decision and the rule it rests on */}
      <div className="px-3 pt-3">
        <div
          key={a.decision}
          className={`annunciator ${unlit ? "annunciator-unlit" : ""}`}
          style={unlit ? undefined : { background: color }}
          role="status"
          aria-label={`Advisory: ${legend}`}
        >
          {unlit && <span className="hatch absolute inset-0 opacity-25" aria-hidden />}
          <span
            className="display relative leading-none font-bold"
            style={{ fontSize: legend.length > 16 ? 24 : 30, letterSpacing: "0.06em" }}
          >
            {legend}
          </span>
          {held && (
            <span className="mono relative flex-none border border-current px-1.5 py-px text-[10px] font-semibold tracking-[0.12em]">
              HELD
            </span>
          )}
        </div>
        <div className="flex items-baseline gap-3 border-x border-b border-[var(--line)] bg-[var(--bg-2)] px-3 py-2">
          <span className="label flex-none text-[10px]">Basis</span>
          <span className="flex-1 text-[12px] leading-snug text-[var(--text-0)]">
            {a.basis_text || DASH}
          </span>
          {figure && (
            <span className="mono flex-none text-[11px] whitespace-nowrap text-[var(--text-1)]">{figure}</span>
          )}
        </div>
        <div className="grid grid-cols-2 border-x border-b border-[var(--line)]">
          <Cell label="Standing" value={duration(a.held_s)} />
          <Cell
            label="Pending relief"
            value={held && a.pending ? DECISION_TEXT[a.pending] : "NONE"}
            sub={held ? `IN ${duration(a.pending_in_s)} IF SUSTAINED` : undefined}
            color={held && a.pending ? DECISION_VAR[a.pending] : "var(--text-2)"}
            last
          />
        </div>
      </div>

      <div className="flex flex-col gap-4 p-3 pt-4">
        {/* The reading, against the limits that turn it into a decision */}
        <div>
          <div className="mb-1 flex items-baseline justify-between">
            <span
              className="label"
              title="Estimated reflex readiness, 0–1: state-posterior arousal with a floor set by observed motion"
            >
              Readiness index
            </span>
            <span className="readout text-[20px]" style={{ color: unlit ? "var(--text-2)" : undefined }}>
              {num(a.readiness_index, 2)}
            </span>
          </div>
          <ZoneTape
            value={a.readiness_index}
            uncertain={unlit}
            zones={[
              { to: L.approach, color: "var(--advisory-approach)", label: "APPROACH" },
              { to: L.caution, color: "var(--advisory-caution)", label: "CAUTION" },
              { to: L.hold, color: "var(--advisory-hold)", label: "HOLD" },
              { to: 1, color: "var(--advisory-deny)", label: "DO NOT APPROACH" },
            ]}
          />
        </div>

        {/* Everything that modified it */}
        <div>
          <Section right={<span className="mono text-[9.5px] text-[var(--text-2)]">{modifiers.length}</span>}>
            Modifiers
          </Section>
          {modifiers.length === 0 ? (
            <p className="text-[11px] text-[var(--text-2)]">None in effect.</p>
          ) : (
            <ul>
              {modifiers.map((m) => (
                <li
                  key={m.code}
                  title={m.code}
                  className="grid grid-cols-[58px_minmax(0,1fr)] items-baseline border-b border-[var(--line)] py-[5px] last:border-0"
                >
                  <span className="mono text-[9px] tracking-[0.08em] text-[var(--text-2)]">
                    {MODIFIER_EFFECT[m.code] ?? ""}
                  </span>
                  <span className="text-[11.5px] leading-snug text-[var(--text-1)]">{m.text}</span>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* How far to trust it */}
        <div className="grid grid-cols-3 border border-[var(--line)]">
          <Cell label="Confidence" value={num(a.confidence, 2)} sub={confidenceWord(a.confidence)} />
          <Cell
            label="Stability"
            value={num(a.stability, 2)}
            sub={a.stability >= 0.5 ? "STEADY · 15 S" : "UNSTABLE · 15 S"}
          />
          <Cell
            label="Quiet window"
            value={a.quiet_window_s !== null ? duration(a.quiet_window_s) : DASH}
            sub={a.quiet_window_s !== null ? "EXPECTED" : "NOT OFFERED"}
            last
          />
        </div>

        {/* The behavioural state the readiness is derived from */}
        {state && (
          <div>
            <Section
              right={
                <span
                  className="mono text-[11px] font-semibold tracking-[0.06em]"
                  style={{ color: state.state ? STATE_VAR[state.state] : "var(--unknown)" }}
                >
                  {state.state ? state.state.replace("_", " ") : "UNRESOLVED"}
                </span>
              }
            >
              Behavioural state
            </Section>
            <p className="text-[11px] leading-snug text-[var(--text-2)]">{state.label}</p>
            <div className="mt-2 flex flex-col gap-[3px]">
              {Object.entries(state.posterior)
                .sort((x, y) => y[1] - x[1])
                .map(([name, p], i) => (
                  <div key={name} className="grid grid-cols-[92px_minmax(0,1fr)_36px] items-center gap-2">
                    <span className={`mono text-[9.5px] ${i === 0 ? "text-[var(--text-0)]" : "text-[var(--text-2)]"}`}>
                      {name}
                    </span>
                    <Meter
                      value={p}
                      color={i === 0 ? STATE_VAR[name as keyof typeof STATE_VAR] : "var(--text-3)"}
                      height={i === 0 ? 4 : 3}
                    />
                    <span className="mono text-right text-[10px] text-[var(--text-1)]">{pct(p)}%</span>
                  </div>
                ))}
            </div>
            <div className="mt-3 grid grid-cols-3 border border-[var(--line)]">
              <Cell label="Evidence" value={num(state.evidence, 2)} sub={`MIN ${num(L.minEvidence, 2)}`} />
              <Cell label="Dwell" value={duration(state.dwell_s)} sub="IN STATE" />
              <Cell label="Features" value={String(state.features_used)} sub="IN LIKELIHOOD" last />
            </div>
          </div>
        )}
      </div>
    </Panel>
  );
}

function Cell({
  label,
  value,
  sub,
  color,
  last,
}: {
  label: string;
  value: string;
  sub?: string;
  color?: string;
  last?: boolean;
}) {
  return (
    <div className={`flex flex-col gap-1 px-2.5 py-2 ${last ? "" : "border-r border-[var(--line)]"}`}>
      <span className="label text-[10px]">{label}</span>
      <span
        className="mono truncate text-[14px] leading-none"
        style={{ color: value === DASH ? "var(--text-3)" : (color ?? "var(--text-0)") }}
      >
        {value}
      </span>
      {sub && <span className="mono text-[9px] text-[var(--text-2)]">{sub}</span>}
    </div>
  );
}
