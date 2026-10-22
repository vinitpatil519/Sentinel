/**
 * Formatters. One rule: a value the backend could not measure renders as `--`,
 * never as `0`, and never as a plausible-looking number.
 */

import type { BehaviouralState, Decision } from "./types";

export const DASH = "--";

export function num(v: number | null | undefined, digits = 1): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return DASH;
  return v.toFixed(digits);
}

export function int(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return DASH;
  return Math.round(v).toString();
}

export function pct(v: number | null | undefined, digits = 0): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return DASH;
  return `${(v * 100).toFixed(digits)}`;
}

export function signed(v: number | null | undefined, digits = 1): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return DASH;
  return `${v > 0 ? "+" : ""}${v.toFixed(digits)}`;
}

/** Zulu time — the console runs on UTC; local time is a deployment detail. */
export function zulu(ts: number | Date = Date.now()): string {
  const d = ts instanceof Date ? ts : new Date(ts);
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}Z`;
}

export function zuluDate(ts: number | Date = Date.now()): string {
  const d = ts instanceof Date ? ts : new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}

const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

/** Date-time group, the military timestamp: `221052Z OCT 26`. */
export function dtg(ts: number | Date = Date.now()): string {
  const d = ts instanceof Date ? ts : new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}Z ${MONTHS[d.getUTCMonth()]} ${p(d.getUTCFullYear() % 100)}`;
}

export function clockHMS(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

/** Compact duration: 8s, 4m12s, 1h03m. */
export function duration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return DASH;
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  return `${h}h${String(m % 60).padStart(2, "0")}m`;
}

export function elapsedSince(ts: number | null | undefined): string {
  if (!ts) return DASH;
  return duration((Date.now() - ts) / 1000);
}

/** Metres, to centimetre precision, as an (x, z) ground position. */
export function position(p: [number, number, number] | undefined): string {
  if (!p) return DASH;
  return `${p[0] >= 0 ? "+" : ""}${p[0].toFixed(2)}, ${p[2] >= 0 ? "+" : ""}${p[2].toFixed(2)}`;
}

/** Range and bearing from the operator's side of the wall (world origin). */
export function bearing(p: [number, number, number] | undefined): string {
  if (!p) return DASH;
  const deg = (Math.atan2(p[0], -p[2]) * 180) / Math.PI;
  const norm = (deg + 360) % 360;
  return `${norm.toFixed(0).padStart(3, "0")}°`;
}

export function range(p: [number, number, number] | undefined): string {
  if (!p) return DASH;
  return Math.hypot(p[0], p[2]).toFixed(2);
}

// ---- domain vocabulary ------------------------------------------------------

export const DECISION_TEXT: Record<Decision, string> = {
  APPROACH: "APPROACH",
  CAUTION: "APPROACH W/ CAUTION",
  HOLD: "HOLD",
  DO_NOT_APPROACH: "DO NOT APPROACH",
  INSUFFICIENT_EVIDENCE: "INSUFFICIENT EVIDENCE",
};

export const DECISION_SUB: Record<Decision, string> = {
  APPROACH: "Subject dormant and stable beyond the dwell threshold",
  CAUTION: "Low arousal, but not a sustained dormant state",
  HOLD: "Elevated arousal — wait for a quieter window",
  DO_NOT_APPROACH: "Subject alert, moving or in distress",
  INSUFFICIENT_EVIDENCE: "Evidence below the decision threshold — no clearance given",
};

export const DECISION_VAR: Record<Decision, string> = {
  APPROACH: "var(--advisory-approach)",
  CAUTION: "var(--advisory-caution)",
  HOLD: "var(--advisory-hold)",
  DO_NOT_APPROACH: "var(--advisory-deny)",
  INSUFFICIENT_EVIDENCE: "var(--advisory-unknown)",
};

export const STATE_VAR: Record<BehaviouralState, string> = {
  ASLEEP: "var(--state-asleep)",
  RESTING: "var(--state-resting)",
  ALERT_STILL: "var(--state-alert)",
  ACTIVE: "var(--state-active)",
  DISTRESSED: "var(--state-distressed)",
};

export const STATE_SHORT: Record<BehaviouralState, string> = {
  ASLEEP: "ASLEEP",
  RESTING: "RESTING",
  ALERT_STILL: "ALERT/STILL",
  ACTIVE: "ACTIVE",
  DISTRESSED: "DISTRESS",
};

export const SEVERITY_VAR: Record<string, string> = {
  critical: "var(--deny)",
  alert: "var(--alert)",
  warn: "var(--warn)",
  info: "var(--text-2)",
};

/** How a rate was arrived at — shown next to every vital sign. */
export const METHOD_TEXT: Record<string, string> = {
  local_csi: "SENTINEL CSI",
  reference: "SENSING SERVER",
  fused: "FUSED",
  motion_blocked: "BLOCKED BY MOTION",
  none: "NO LOCK",
};

export const ATTRIBUTION_TEXT: Record<string, string> = {
  exclusive: "EXCLUSIVE",
  nearest_node: "NEAREST NODE",
  aggregate: "AGGREGATE",
  unattributed: "UNATTRIBUTED",
};

export const PROVENANCE_TEXT: Record<string, string> = {
  pose_model: "POSE MODEL",
  field_peak: "FIELD PEAK",
  aggregate: "AGGREGATE",
};

export function eventTitle(type: string): string {
  return type.replaceAll("_", " ");
}

/** Confidence → a short qualifier, so a bare 0.41 is never the whole story. */
export function confidenceWord(c: number | null | undefined): string {
  if (c === null || c === undefined || !Number.isFinite(c) || c <= 0) return "NO LOCK";
  if (c >= 0.75) return "HIGH";
  if (c >= 0.5) return "MODERATE";
  if (c >= 0.3) return "LOW";
  return "MARGINAL";
}
