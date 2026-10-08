"use client";

/**
 * Live event feed — the operational log as it happens.
 *
 * Severity is carried by a left rule and the timestamp column stays fixed so
 * the eye can scan times without the rows shifting. Only transitions appear
 * here: a state that persists is on the advisory panel, not repeated in the log.
 */

import { useEvents } from "@/lib/telemetry";
import { SEVERITY_VAR, clockHMS, eventTitle } from "@/lib/format";
import { Empty, Panel } from "@/components/ui";

const DETAIL_KEYS = ["state", "decision", "bpm", "sensor", "node_id", "source", "duration_s"];

export default function EventFeed({ limit = 60 }: { limit?: number }) {
  const events = useEvents().slice(0, limit);

  return (
    <Panel
      title="Event Log"
      right={<span className="mono text-[10px] text-[var(--text-2)]">LIVE</span>}
      flush
    >
      {events.length === 0 ? (
        <Empty>No events yet this session.</Empty>
      ) : (
        <ul className="flex flex-col">
          {events.map((e, i) => {
            const color = SEVERITY_VAR[e.data.severity] ?? "var(--text-2)";
            const detail = DETAIL_KEYS.filter((k) => e.data[k] !== undefined && e.data[k] !== null)
              .map((k) => `${k}=${String(e.data[k])}`)
              .join("  ");
            return (
              <li
                key={`${e.ts}-${i}`}
                className="row-hover flex items-baseline gap-2 border-b border-[var(--line)] px-2.5 py-[5px]"
              >
                <span className="w-[2px] self-stretch" style={{ background: color }} />
                <span className="mono w-[62px] flex-none text-[10px] text-[var(--text-3)]">
                  {clockHMS(e.ts)}
                </span>
                <span
                  className="flex-none text-[10.5px] font-semibold tracking-[0.06em]"
                  style={{ color }}
                >
                  {eventTitle(e.data.type)}
                </span>
                {e.data.track && (
                  <span className="mono flex-none text-[10px] text-[var(--text-1)]">
                    {String(e.data.track)}
                  </span>
                )}
                <span className="mono truncate text-[9.5px] text-[var(--text-3)]">{detail}</span>
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}
