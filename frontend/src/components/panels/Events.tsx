"use client";

/**
 * Live event feed — the operational log as it happens.
 *
 * Laid out as a fixed-column log so the eye can scan times and severities
 * without the rows shifting. Only transitions appear here: a state that
 * persists is on the advisory panel, not repeated in the log.
 */

import { useEvents } from "@/lib/telemetry";
import { SEVERITY_VAR, clockHMS, eventTitle } from "@/lib/format";
import { Empty, Panel } from "@/components/ui";

const DETAIL_KEYS = ["state", "decision", "bpm", "sensor", "node_id", "source", "duration_s"];

const SEVERITY_TAG: Record<string, string> = {
  critical: "CRIT",
  alert: "ALRT",
  warn: "WARN",
  info: "INFO",
};

export default function EventFeed({ limit = 60 }: { limit?: number }) {
  const events = useEvents().slice(0, limit);

  return (
    <Panel
      code="A3"
      title="Event Log"
      right={
        <span className="flex items-center gap-1.5">
          <span className="dot pulse" style={{ color: "var(--ok)" }} />
          <span className="panel-meta">LIVE · {events.length}</span>
        </span>
      }
      flush
    >
      {events.length === 0 ? (
        <Empty title="Log empty">No events yet this session.</Empty>
      ) : (
        <ul className="mono flex flex-col text-[10.5px]">
          {events.map((e, i) => {
            const color = SEVERITY_VAR[e.data.severity] ?? "var(--text-2)";
            const detail = DETAIL_KEYS.filter((k) => e.data[k] !== undefined && e.data[k] !== null)
              .map((k) => `${k}=${formatValue(e.data[k])}`)
              .join("  ");
            return (
              <li
                key={`${e.ts}-${e.data.type}-${String(e.data.track ?? "")}`}
                className={`row-hover flex items-baseline gap-2.5 border-b border-[var(--line)] px-3 py-[5px] ${i === 0 ? "row-in" : ""}`}
              >
                <span className="w-[58px] flex-none text-[var(--text-2)]">{clockHMS(e.ts)}</span>
                <span
                  className="w-[38px] flex-none text-center text-[9px] font-semibold"
                  style={{
                    color,
                    border: `1px solid color-mix(in srgb, ${color} 45%, transparent)`,
                    background: `color-mix(in srgb, ${color} 9%, transparent)`,
                  }}
                >
                  {SEVERITY_TAG[e.data.severity] ?? e.data.severity.toUpperCase()}
                </span>
                <span
                  className="display flex-none text-[12px] font-bold tracking-[0.1em]"
                  style={{ color: e.data.severity === "info" ? "var(--text-0)" : color }}
                >
                  {eventTitle(e.data.type)}
                </span>
                {e.data.track && <span className="flex-none text-[var(--accent)]">{String(e.data.track)}</span>}
                <span className="truncate text-[9.5px] text-[var(--text-2)]">{detail}</span>
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}

function formatValue(v: unknown): string {
  if (typeof v === "number" && !Number.isInteger(v)) return v.toFixed(2);
  return String(v);
}
