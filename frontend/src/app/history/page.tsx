"use client";

/**
 * Session Log — the recorded session, for after-action review and for research.
 *
 * Reads from the database rather than the live stream, so it survives a console
 * reload and covers the whole session. Everything here is exportable, because
 * the numbers in a report have to be traceable to the rows that produced them.
 */

import { useCallback, useEffect, useState } from "react";
import { Chip, Empty, Field, Panel, Stat } from "@/components/ui";
import { StateBand } from "@/components/charts";
import { API_BASE } from "@/lib/config";
import { SEVERITY_VAR, STATE_VAR, clockHMS, duration, eventTitle, num, zuluDate } from "@/lib/format";
import type { BehaviouralState, StoredEvent } from "@/lib/types";

type Summary = {
  session?: { id: number; started_at: number; ended_at: number | null; notes: string | null };
  event_counts?: Record<string, number>;
  state_seconds?: Record<string, number>;
  decision_seconds?: Record<string, number>;
  tracks?: { track_id: string; first_seen: number; last_seen: number; provenance: string }[];
  respiration?: { mean_bpm: number | null; min_bpm: number | null; max_bpm: number | null; mean_rrv: number | null; samples: number };
};

const SEVERITIES = ["all", "critical", "alert", "warn", "info"] as const;

export default function History() {
  const [events, setEvents] = useState<StoredEvent[] | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [severity, setSeverity] = useState<(typeof SEVERITIES)[number]>("all");
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const q = severity === "all" ? "" : `&severity=${severity}`;
      const [e, s] = await Promise.all([
        fetch(`${API_BASE}/api/events?limit=500${q}`).then((r) => r.json()),
        fetch(`${API_BASE}/api/session/summary`).then((r) => r.json()),
      ]);
      setEvents(e.events ?? []);
      setSummary(s ?? null);
      setError(null);
    } catch {
      setError("Backend unreachable — the session log is served from the database.");
      setEvents([]);
    }
  }, [severity]);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 10000);
    return () => clearInterval(t);
  }, [load]);

  const stateTotal = Object.values(summary?.state_seconds ?? {}).reduce((a, b) => a + b, 0);

  return (
    <div className="grid h-full min-h-0 gap-3" style={{ gridTemplateColumns: "minmax(0,1fr) 380px" }}>
      <Panel
        title="Event Log — recorded session"
        flush
        right={
          <div className="flex gap-1">
            {SEVERITIES.map((s) => (
              <button key={s} className="btn" data-active={severity === s} onClick={() => setSeverity(s)}>
                {s}
              </button>
            ))}
          </div>
        }
      >
        {error ? (
          <Empty>{error}</Empty>
        ) : events === null ? (
          <Empty>Loading…</Empty>
        ) : events.length === 0 ? (
          <Empty>No events recorded for this filter.</Empty>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>Time</th>
                <th>Severity</th>
                <th>Event</th>
                <th>Track</th>
                <th>Detail</th>
              </tr>
            </thead>
            <tbody>
              {events.map((e, i) => (
                <tr key={`${e.ts}-${i}`}>
                  <td className="mono" style={{ color: "var(--text-2)" }}>
                    {clockHMS(e.ts)}
                  </td>
                  <td style={{ color: SEVERITY_VAR[e.severity] ?? "var(--text-2)" }}>
                    {e.severity.toUpperCase()}
                  </td>
                  <td style={{ color: "var(--text-0)" }}>{eventTitle(e.type)}</td>
                  <td className="mono">{e.track_id ?? "--"}</td>
                  <td className="mono" style={{ color: "var(--text-3)", whiteSpace: "normal" }}>
                    {Object.entries(e.payload)
                      .filter(([k]) => !["type", "severity", "track"].includes(k))
                      .map(([k, v]) => `${k}=${Array.isArray(v) ? v.join("/") : String(v)}`)
                      .join("  ")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>

      <div className="flex min-h-0 flex-col gap-3 overflow-y-auto pr-0.5">
        <Panel title="Session Summary">
          {summary?.session ? (
            <div className="flex flex-col gap-3">
              <div className="flex flex-wrap gap-6">
                <Stat label="Session" value={String(summary.session.id).padStart(4, "0")} />
                <Stat
                  label="Started"
                  value={clockHMS(summary.session.started_at)}
                  hint={zuluDate(summary.session.started_at)}
                />
                <Stat
                  label="Duration"
                  value={duration(
                    ((summary.session.ended_at ?? Date.now()) - summary.session.started_at) / 1000,
                  )}
                />
              </div>

              <div className="border-t border-[var(--line)] pt-2">
                <span className="label">Event counts</span>
                <div className="mt-1 flex flex-wrap gap-2">
                  {Object.entries(summary.event_counts ?? {}).map(([sev, n]) => (
                    <Chip key={sev} color={SEVERITY_VAR[sev] ?? "var(--text-2)"} dot>
                      {sev} {n}
                    </Chip>
                  ))}
                  {Object.keys(summary.event_counts ?? {}).length === 0 && (
                    <span className="text-[11px] text-[var(--text-2)]">none</span>
                  )}
                </div>
              </div>

              {stateTotal > 0 && (
                <div className="border-t border-[var(--line)] pt-2">
                  <span className="label">Time in behavioural state</span>
                  <div className="mt-1.5">
                    <StateBand
                      segments={Object.entries(summary.state_seconds ?? {}).map(([name, n]) => ({
                        color: STATE_VAR[name as BehaviouralState] ?? null,
                        weight: n,
                      }))}
                      height={20}
                    />
                  </div>
                  <div className="mt-2 grid grid-cols-2 gap-x-5">
                    {Object.entries(summary.state_seconds ?? {})
                      .sort((a, b) => b[1] - a[1])
                      .map(([name, n]) => (
                        <Field
                          key={name}
                          label={name}
                          value={`${duration(n)} · ${Math.round((n / stateTotal) * 100)}%`}
                          color={STATE_VAR[name as BehaviouralState]}
                        />
                      ))}
                  </div>
                  <p className="mt-1.5 text-[9.5px] text-[var(--text-3)]">
                    Assessments are recorded at 1 Hz, so a count is a second.
                  </p>
                </div>
              )}

              {summary.respiration && summary.respiration.samples > 0 && (
                <div className="border-t border-[var(--line)] pt-2">
                  <span className="label">Respiration across the session</span>
                  <div className="mt-1 grid grid-cols-2 gap-x-5">
                    <Field label="Mean" value={`${num(summary.respiration.mean_bpm)} BPM`} />
                    <Field
                      label="Range"
                      value={`${num(summary.respiration.min_bpm)}–${num(summary.respiration.max_bpm)}`}
                    />
                    <Field label="Mean RRV" value={num(summary.respiration.mean_rrv, 3)} />
                    <Field label="Locked samples" value={String(summary.respiration.samples)} />
                  </div>
                  <p className="mt-1.5 text-[9.5px] text-[var(--text-3)]">
                    Only samples with respiration confidence above 0.4 are included.
                  </p>
                </div>
              )}

              {summary.tracks && summary.tracks.length > 0 && (
                <div className="border-t border-[var(--line)] pt-2">
                  <span className="label">Tracks</span>
                  <table className="data-table mt-1">
                    <thead>
                      <tr>
                        <th>Track</th>
                        <th>Provenance</th>
                        <th className="text-right">Duration</th>
                      </tr>
                    </thead>
                    <tbody>
                      {summary.tracks.map((t) => (
                        <tr key={t.track_id}>
                          <td className="mono">{t.track_id}</td>
                          <td>{t.provenance}</td>
                          <td className="num">{duration((t.last_seen - t.first_seen) / 1000)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          ) : (
            <Empty>No session summary available.</Empty>
          )}
        </Panel>

        <Panel title="Export">
          <p className="mb-2 text-[11px] leading-snug text-[var(--text-1)]">
            Session data for offline analysis. The assessments table is the one the evaluation
            and calibration scripts read.
          </p>
          <div className="flex flex-wrap gap-2">
            <a className="btn" href={`${API_BASE}/api/export.csv?table=assessments`}>
              Assessments CSV
            </a>
            <a className="btn" href={`${API_BASE}/api/export.csv?table=events`}>
              Events CSV
            </a>
            <a className="btn" href={`${API_BASE}/api/export.csv?table=samples`}>
              Samples CSV
            </a>
            <a className="btn" href={`${API_BASE}/api/export.csv?table=labels`}>
              Labels CSV
            </a>
            <a className="btn" href={`${API_BASE}/api/export.json`}>
              Full JSON
            </a>
          </div>
        </Panel>
      </div>
    </div>
  );
}
