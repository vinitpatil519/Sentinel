"use client";

/**
 * Console primitives. Everything on screen is built from these, so the rules
 * live here once: labels are condensed, uppercase and quiet, readings are
 * monospace and loud, an unknown value is `--` and is never dressed up as a
 * number.
 */

import type { CSSProperties, ReactNode } from "react";
import { DASH } from "@/lib/format";

// ---- panel ------------------------------------------------------------------

export function Panel({
  title,
  code,
  right,
  children,
  flush,
  className = "",
  accent,
  ticks,
  bodyClassName = "",
}: {
  title?: string;
  /** Short grid reference shown before the title, e.g. "A1". */
  code?: string;
  right?: ReactNode;
  children: ReactNode;
  flush?: boolean;
  className?: string;
  /** Status colour: lights the frame corners and rules the header. */
  accent?: string;
  /** Marks the screen's primary surface by lighting its corners in the accent. */
  ticks?: boolean;
  bodyClassName?: string;
}) {
  const style = accent ? ({ "--corner": accent } as CSSProperties) : undefined;
  return (
    <section className={`panel ${ticks ? "corner-ticks" : ""} ${className}`} style={style}>
      <div className="panel-frame">
        {title !== undefined && (
          <header
            className="panel-head"
            style={accent ? { boxShadow: `inset 0 -2px 0 ${accent}` } : undefined}
          >
            {code && <span className="panel-code">{code}</span>}
            <span className="panel-title">{title}</span>
            {right !== undefined && <div className="ml-auto flex flex-none items-center gap-2">{right}</div>}
          </header>
        )}
        <div className={`${flush ? "panel-body-flush" : "panel-body"} ${bodyClassName}`}>{children}</div>
      </div>
    </section>
  );
}

/** Label with a rule running off it to the right; optional trailing content. */
export function Section({ children, right, className = "" }: { children: ReactNode; right?: ReactNode; className?: string }) {
  return (
    <div className={`mb-2 flex items-center gap-2.5 ${className}`}>
      <span className="label flex-none">{children}</span>
      <span className="h-px flex-1 bg-gradient-to-r from-[var(--line-strong)] to-transparent" />
      {right}
    </div>
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
    <div className="flex flex-col gap-1.5">
      <span className="label">{label}</span>
      <Readout value={value} unit={unit} size={size} color={color} />
      {hint && <span className="mono text-[9.5px] tracking-wide text-[var(--text-2)] uppercase">{hint}</span>}
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
    <div className="flex items-baseline justify-between gap-3 border-b border-dashed border-[var(--line)] py-[4px] last:border-0" title={title}>
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
          style={{ background: i < filled ? color : "var(--bg-4)" }}
        />
      ))}
    </div>
  );
}

/**
 * Banded instrument tape. The scale is divided into the decision zones the
 * backend uses, each drawn in its own colour, with a pointer at the value —
 * so the reading is shown *against* the thresholds that turn it into a
 * decision, rather than as a bare fraction.
 */
export function ZoneTape({
  value,
  zones,
  height = 16,
  uncertain,
}: {
  value: number;
  /** Ascending upper bounds in 0..1; the last should be 1. */
  zones: { to: number; color: string; label: string }[];
  height?: number;
  uncertain?: boolean;
}) {
  const v = Math.max(0, Math.min(1, value));
  const active = zones.find((z) => v <= z.to) ?? zones[zones.length - 1];
  let from = 0;
  return (
    <div className="flex flex-col gap-1 px-[5px]">
      <div className="relative" style={{ height: height + 8 }}>
        {/* pointer */}
        <span
          className="absolute top-0 z-[2] -translate-x-1/2 transition-[left] duration-300"
          style={{ left: `${v * 100}%` }}
        >
          <svg width="11" height="7" viewBox="0 0 11 7" aria-hidden>
            <path d="M0 0h11L5.5 7z" fill="var(--text-0)" />
          </svg>
        </span>
        <div className="absolute right-0 bottom-0 left-0 flex gap-[2px]" style={{ height }}>
          {zones.map((z) => {
            const w = (z.to - from) * 100;
            const isActive = z === active;
            from = z.to;
            return (
              <span
                key={z.label}
                className="relative"
                style={{
                  width: `${w}%`,
                  background: `color-mix(in srgb, ${z.color} ${isActive ? 26 : 10}%, transparent)`,
                  boxShadow: `inset 0 -2px 0 color-mix(in srgb, ${z.color} ${isActive ? 100 : 45}%, transparent)`,
                }}
              />
            );
          })}
        </div>
        {/* fill up to the value */}
        <span
          className={`absolute bottom-0 left-0 z-[1] transition-[width] duration-300 ${uncertain ? "hatch" : ""}`}
          style={{
            height,
            width: `${v * 100}%`,
            background: uncertain ? undefined : `color-mix(in srgb, ${active.color} 30%, transparent)`,
          }}
        />
        <span
          className="absolute bottom-0 z-[2] w-[2px] -translate-x-1/2 transition-[left] duration-300"
          style={{ left: `${v * 100}%`, height: height + 2, background: "var(--text-0)", boxShadow: `0 0 8px ${active.color}` }}
        />
      </div>
      <div className="relative h-3">
        {zones.slice(0, -1).map((z) => (
          <span
            key={z.label}
            className="mono absolute top-0 -translate-x-1/2 text-[9px] text-[var(--text-2)]"
            style={{ left: `${z.to * 100}%` }}
          >
            {z.to.toFixed(2)}
          </span>
        ))}
        <span className="mono absolute top-0 left-0 text-[9px] text-[var(--text-3)]">0</span>
        <span className="mono absolute top-0 right-0 text-[9px] text-[var(--text-3)]">1</span>
      </div>
    </div>
  );
}

/** Four-bar link quality indicator. */
export function SignalBars({ level, color = "var(--accent)" }: { level: number; color?: string }) {
  return (
    <span className="inline-flex items-end gap-[2px]" style={{ height: 12 }} aria-hidden>
      {[0, 1, 2, 3].map((i) => (
        <span
          key={i}
          className="w-[3px]"
          style={{ height: 4 + i * 2.6, background: i < level ? color : "var(--line-strong)" }}
        />
      ))}
    </span>
  );
}

export function Empty({ children, title = "No data" }: { children: ReactNode; title?: string }) {
  return (
    <div className="flex h-full min-h-20 flex-col items-center justify-center gap-1.5 px-6 text-center">
      <span className="label flex items-center gap-2 text-[var(--text-2)]">
        <span className="h-px w-5 bg-[var(--line-strong)]" />
        {title}
        <span className="h-px w-5 bg-[var(--line-strong)]" />
      </span>
      <span className="max-w-[46ch] text-[11px] leading-snug text-[var(--text-2)]">{children}</span>
    </div>
  );
}

export function Divider({ label }: { label?: string }) {
  if (!label) return <hr className="my-2 border-0 border-t border-[var(--line)]" />;
  return <Section className="mt-2">{label}</Section>;
}

export function KeyHint({ k, children }: { k: string; children: ReactNode }) {
  return (
    <span className="flex items-center gap-1.5 text-[10px] text-[var(--text-2)]">
      <kbd>{k}</kbd>
      <span className="label text-[10px]">{children}</span>
    </span>
  );
}
