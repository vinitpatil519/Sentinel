"use client";

/**
 * Subjects — the tabular view of every track, and the full record of one.
 *
 * Operations answers "can I go"; this page answers "what exactly is the system
 * claiming, and on what". Everything shown is a field the backend published,
 * including the ones that qualify a claim rather than make one: provenance,
 * attribution, evidence, features used.
 */

import { useMemo } from "react";
import { useSelection } from "@/components/Shell";
import AdvisoryPanel from "@/components/panels/Advisory";
import VitalsPanel from "@/components/panels/Vitals";
import { StateBand } from "@/components/charts";
import { Chip, Empty, Field, Panel } from "@/components/ui";
import { useCapabilities, useChannelHistory, useTracks, useUpstreamVitals } from "@/lib/telemetry";
import {
  DECISION_TEXT,
  DECISION_VAR,
  PROVENANCE_TEXT,
  STATE_SHORT,
  STATE_VAR,
  bearing,
  duration,
  elapsedSince,
  num,
  position,
  range,
} from "@/lib/format";
import type { TrackState } from "@/lib/types";

export default function Subjects() {
  const tracks = useTracks();
  const upstream = useUpstreamVitals();
  const caps = useCapabilities();
  const history = useChannelHistory("track.state");
  const { selected, select } = useSelection();

  const list = useMemo(() => tracks?.tracks ?? [], [tracks]);
  const focus = useMemo(() => list.find((t) => t.id === selected) ?? list[0], [list, selected]);

  // State band for the focused subject over the retained track history.
  const band = useMemo(() => {
    if (!focus) return [];
    return history.map((msg) => {
      const data = msg.data as unknown as TrackState;
      const t = data.tracks?.find((x) => x.id === focus.id);
      const state = t?.state?.state ?? null;
      return { color: state ? STATE_VAR[state] : null };
    });
  }, [history, focus]);

  return (
    <div className="grid h-full min-h-0 gap-3" style={{ gridTemplateColumns: "minmax(0,1fr) 372px" }}>
      <div className="grid min-h-0 gap-3" style={{ gridTemplateRows: "auto minmax(0,1fr)" }}>
        <Panel title="Tracked Subjects" flush>
          {list.length === 0 ? (
            <Empty>No subject in the sensing volume.</Empty>
          ) : (
            <div className="overflow-auto">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Track</th>
                    <th>State</th>
                    <th>Advisory</th>
                    <th className="text-right">Readiness</th>
                    <th className="text-right">Resp</th>
                    <th className="text-right">RRV</th>
                    <th className="text-right">Motion</th>
                    <th className="text-right">Range</th>
                    <th className="text-right">Bearing</th>
                    <th className="text-right">Position x,z</th>
                    <th>Provenance</th>
                    <th>Attribution</th>
                    <th className="text-right">Held</th>
                  </tr>
                </thead>
                <tbody>
                  {list.map((t) => {
                    const decision = t.advisory?.decision ?? "INSUFFICIENT_EVIDENCE";
                    const state = t.state?.state;
                    return (
                      <tr
                        key={t.id}
                        onClick={() => select(t.id)}
                        style={{
                          cursor: "pointer",
                          background: t.id === focus?.id ? "var(--bg-3)" : undefined,
                        }}
                      >
                        <td className="mono" style={{ color: "var(--text-0)" }}>{t.id}</td>
                        <td style={{ color: state ? STATE_VAR[state] : "var(--unknown)" }}>
                          {state ? STATE_SHORT[state] : "UNRESOLVED"}
                        </td>
                        <td style={{ color: DECISION_VAR[decision] }}>{DECISION_TEXT[decision]}</td>
                        <td className="num">{num(t.advisory?.readiness_index ?? 0, 2)}</td>
                        <td className="num">
                          {t.vitals.respiration.bpm !== null ? num(t.vitals.respiration.bpm) : "--"}
                        </td>
                        <td className="num">{num(t.vitals.respiration_features.rrv_cv, 3)}</td>
                        <td className="num">{num(t.vitals.motion.index, 1)}</td>
                        <td className="num">{range(t.position)}</td>
                        <td className="num">{bearing(t.position)}</td>
                        <td className="num">{position(t.position)}</td>
                        <td>{PROVENANCE_TEXT[t.provenance] ?? t.provenance}</td>
                        <td
                          style={{
                            color:
                              t.vitals.attribution === "exclusive" ? "var(--text-1)" : "var(--warn)",
                          }}
                        >
                          {t.vitals.attribution.replaceAll("_", " ").toUpperCase()}
                        </td>
                        <td className="num">{duration(t.state?.dwell_s)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Panel>

        {focus ? (
          <Panel
            title="Subject Record"
            right={<span className="mono text-[11px] text-[var(--text-1)]">{focus.id}</span>}
          >
            <div className="flex flex-col gap-3">
              <div>
                <div className="mb-1 flex items-baseline justify-between">
                  <span className="label">Behavioural state history</span>
                  <span className="mono text-[9px] text-[var(--text-3)]">
                    {history.length} SAMPLES · OLDEST LEFT
                  </span>
                </div>
                <StateBand segments={band} height={22} />
                <div className="mt-1.5 flex flex-wrap gap-3">
                  {Object.entries(STATE_VAR).map(([name, color]) => (
                    <span key={name} className="flex items-center gap-1.5">
                      <span className="h-2 w-3" style={{ background: color }} />
                      <span className="mono text-[9px] text-[var(--text-3)]">{name}</span>
                    </span>
                  ))}
                </div>
              </div>

              <div className="grid grid-cols-2 gap-x-6 gap-y-0 border-t border-[var(--line)] pt-2 lg:grid-cols-3">
                <Field label="Track id" value={focus.id} />
                <Field label="Upstream id" value={focus.upstream_id ?? "--"} />
                <Field label="Zone" value={focus.zone} />
                <Field label="Acquired" value={elapsedSince(focus.first_seen) + " ago"} />
                <Field label="Last update" value={elapsedSince(focus.last_seen) + " ago"} />
                <Field label="Detection conf." value={num(focus.confidence, 2)} />
                <Field label="Speed" value={`${num(focus.speed_mps, 2)} m/s`} />
                <Field label="Posture" value={focus.posture ?? "unknown"} />
                <Field label="Nearest node" value={focus.node_id ?? "--"} />
                <Field label="Motion score" value={num(focus.motion_score, 1)} />
                <Field label="Signal quality" value={num(focus.vitals.signal_quality, 2)} />
                <Field label="Features used" value={focus.state?.features_used ?? "--"} />
              </div>

              {focus.features && (
                <div className="border-t border-[var(--line)] pt-2">
                  <span className="label">Feature vector into the state model</span>
                  <div className="mt-1 grid grid-cols-2 gap-x-6 lg:grid-cols-3">
                    <Field
                      label="Respiration BPM"
                      value={focus.features.respiration_bpm !== null ? num(focus.features.respiration_bpm) : "dropped"}
                      color={focus.features.respiration_bpm === null ? "var(--text-3)" : undefined}
                    />
                    <Field
                      label="RRV CV"
                      value={focus.features.rrv_cv !== null ? num(focus.features.rrv_cv, 3) : "dropped"}
                      color={focus.features.rrv_cv === null ? "var(--text-3)" : undefined}
                    />
                    <Field
                      label="Motion index"
                      value={focus.features.motion_index !== null ? num(focus.features.motion_index, 1) : "dropped"}
                      color={focus.features.motion_index === null ? "var(--text-3)" : undefined}
                    />
                    <Field
                      label="Burst rate"
                      value={focus.features.burst_rate !== null ? num(focus.features.burst_rate, 2) : "dropped"}
                      color={focus.features.burst_rate === null ? "var(--text-3)" : undefined}
                    />
                    <Field
                      label="Depth CV"
                      value={focus.features.amplitude_cv !== null ? num(focus.features.amplitude_cv, 3) : "dropped"}
                      color={focus.features.amplitude_cv === null ? "var(--text-3)" : undefined}
                    />
                    <Field label="Evidence" value={num(focus.features.evidence, 2)} />
                  </div>
                  <p className="mt-1.5 text-[9.5px] leading-snug text-[var(--text-3)]">
                    A dropped feature is excluded from the likelihood for that frame rather than
                    imputed — it weakens the estimate instead of biasing it.
                  </p>
                </div>
              )}

              <div className="flex flex-wrap gap-2 border-t border-[var(--line)] pt-2">
                <Chip color="var(--text-2)">{PROVENANCE_TEXT[focus.provenance] ?? focus.provenance}</Chip>
                <Chip color={focus.vitals.attribution === "exclusive" ? "var(--text-2)" : "var(--warn)"}>
                  VITALS {focus.vitals.attribution.replaceAll("_", " ").toUpperCase()}
                </Chip>
                {caps?.model.vitals_attribution && (
                  <Chip color="var(--text-2)">MODE {caps.model.vitals_attribution.toUpperCase()}</Chip>
                )}
              </div>
            </div>
          </Panel>
        ) : (
          <Panel title="Subject Record">
            <Empty>Select a subject to see its full record.</Empty>
          </Panel>
        )}
      </div>

      <div className="flex min-h-0 flex-col gap-3 overflow-y-auto pr-0.5">
        <AdvisoryPanel track={focus} thresholds={caps?.advisory} />
        <VitalsPanel track={focus} upstream={upstream} compact />
      </div>
    </div>
  );
}
