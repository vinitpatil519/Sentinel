"use client";

/**
 * Console primitives. Everything on screen is built from these, so the rules
 * live here once: labels are uppercase and quiet, readings are monospace and
 * loud, an unknown value is `--` and is never dressed up as a number.
 */

import type { CSSProperties, ReactNode } from "react";
import { DASH } from "@/lib/format";

// ---- panel ------------------------------------------------------------------

export function Panel({
  title,
  right,
  children,
  flush,
  className = "",
  accent,
  ticks,
}: {
  title?: string;
  right?: ReactNode;
  children: ReactNode;
  flush?: boolean;
  className?: string;
  /** Colour of the 2px rule under the header — used to carry a status. */
  accent?: string;
  ticks?: boolean;
}) {
  return (
    <section className={`panel ${ticks ? "corner-ticks" : ""} ${className}`}>
      {title !== undefined && (
        <header className="panel-head" style={accent ? { boxShadow: `inset 0 -2px 0 ${accent}` } : undefined}>
          <span className="label-strong">{title}</span>
          {right !== undefined && <div className="ml-auto flex items-center gap-2">{right}</div>}
        </header>
      )}
      <div className={flush ? "panel-body-flush" : "panel-body"}>{children}</div>
    </section>
  );
}

// ---- readings ---------------------------------------------------------------

export function Readout({
  value,
  unit,
  size = 28,
  color,
  dim,
  title,
}: {
  value: string;
  unit?: string;
  size?: number;
  color?: string;
  dim?: boolean;
  title?: string;
}) {
  const unknown = value === DASH;
  return (
    <span
      className="readout"
      title={title}
      style={{
        fontSize: size,
        lineHeight: 1,
        fontWeight: 500,
        color: unknown ? "var(--text-3)" : dim ? "var(--text-1)" : color ?? "var(--text-0)",
      }}
    >
      {value}
      {unit && !unknown && <span className="unit">{unit}</span>}
    </span>
  );
}

export function Stat({
  label,
  value,
  unit,
  color,
  hint,
  size = 20,
}: {
  label: string;
  value: string;
  unit?: string;
  color?: string;
  hint?: string;
  size?: number;
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="label">{label}</span>
      <Readout value={value} unit={unit} size={size} color={color} />
      {hint && <span className="text-[10px] text-[var(--text-2)]">{hint}</span>}
    </div>
  );
}

/** Label / value row — the densest way to show a field, used in lists. */
export function Field({
  label,
  value,
  color,
  mono = true,
  title,
}: {
  label: string;
  value: ReactNode;
  color?: string;
  mono?: boolean;
  title?: string;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-[3px]" title={title}>
      <span className="label">{label}</span>
      <span
        className={`${mono ? "mono" : ""} text-right text-[12px]`}
        style={{ color: color ?? "var(--text-0)" }}
      >
        {value}
      </span>
    </div>
  );
}

// ---- status -----------------------------------------------------------------

export function Chip({
  children,
  color = "var(--text-2)",
  dot,
  style,
}: {
  children: ReactNode;
  color?: string;
  dot?: boolean;
  style?: CSSProperties;
}) {
  return (
    <span className="chip" style={{ color, ...style }}>
      {dot && <span className="dot" />}
      {children}
    </span>
  );
}

export function Meter({
  value,
  color = "var(--accent)",
  height = 4,
  uncertain,
  ticks,
}: {
  /** 0..1 */
  value: number;
  color?: string;
  height?: number;
  /** Renders the fill hatched: a value the system does not vouch for. */
  uncertain?: boolean;
  /** Fractions at which to draw threshold marks. */
  ticks?: number[];
}) {
  const pctValue = Math.max(0, Math.min(1, value)) * 100;
  return (
    <div className="meter relative" style={{ height, color }}>
      <div
        className={`meter-fill ${uncertain ? "hatch" : ""}`}
        style={{ width: `${pctValue}%` }}
      />
      {ticks?.map((t) => (
        <span
          key={t}
          className="absolute top-0 bottom-0 w-px"
          style={{ left: `${t * 100}%`, background: "var(--bg-0)" }}
        />
      ))}
    </div>
  );
}

/** Horizontal segmented gauge — reads as an instrument, not a progress bar. */
export function SegmentBar({
  value,
  segments = 24,
  color = "var(--accent)",
  height = 10,
}: {
  value: number;
  segments?: number;
  color?: string;
  height?: number;
}) {
  const filled = Math.round(Math.max(0, Math.min(1, value)) * segments);
  return (
    <div className="flex gap-[2px]" style={{ height }}>
      {Array.from({ length: segments }, (_, i) => (
        <span
          key={i}
          className="flex-1"
          style={{ background: i < filled ? color : "var(--bg-3)" }}
        />
      ))}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full min-h-16 items-center justify-center px-4 text-center">
      <span className="text-[11px] text-[var(--text-2)]">{children}</span>
    </div>
  );
}

export function Divider({ label }: { label?: string }) {
  if (!label) return <hr className="my-2 border-0 border-t border-[var(--line)]" />;
  return (
    <div className="my-2 flex items-center gap-2">
      <span className="label">{label}</span>
      <span className="h-px flex-1 bg-[var(--line)]" />
    </div>
  );
}

export function KeyHint({ k, children }: { k: string; children: ReactNode }) {
  return (
    <span className="flex items-center gap-1.5 text-[10px] text-[var(--text-3)]">
      <kbd className="mono border border-[var(--line-strong)] bg-[var(--bg-2)] px-1 text-[9px] text-[var(--text-2)]">
        {k}
      </kbd>
      {children}
    </span>
  );
}

/**
 * Standing banner for a feed that is not a measurement. Deliberately impossible
 * to miss and impossible to dismiss.
 */
export function SyntheticBanner({ label }: { label: string }) {
  return (
    <div
      className="flex items-center justify-center gap-2 border-b px-3 py-[3px]"
      style={{
        background: "color-mix(in srgb, var(--warn) 14%, transparent)",
        borderColor: "color-mix(in srgb, var(--warn) 40%, transparent)",
      }}
    >
      <span className="dot" style={{ color: "var(--warn)" }} />
      <span className="label-strong" style={{ color: "var(--warn)" }}>
        {label} — displayed values are not measurements
      </span>
    </div>
  );
}
