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
import PlanView from "@/components/panels/PlanView";
import VitalsPanel from "@/components/panels/Vitals";
import { Sparkline, StateBand } from "@/components/charts";
import { Chip, Empty, Field, Panel, Section } from "@/components/ui";
import { useCapabilities, useChannelHistory, useNodes, useTracks, useUpstreamVitals } from "@/lib/telemetry";
import {
  DASH,
  DECISION_TEXT,
  DECISION_VAR,
  PROVENANCE_TEXT,
  STATE_SHORT,
  STATE_VAR,
  bearing,
  duration,
  num,
  position,
  range,
} from "@/lib/format";
import type { TrackState } from "@/lib/types";

export default function Subjects() {
  const tracks = useTracks();
  const nodes = useNodes();
  const upstream = useUpstreamVitals();
  const caps = useCapabilities();
  const history = useChannelHistory("track.state");
  const { selected, select } = useSelection();

  const list = useMemo(() => tracks?.tracks ?? [], [tracks]);
  const focus = useMemo(() => list.find((t) => t.id === selected) ?? list[0], [list, selected]);
  // Track timestamps are on the sensing source's clock (a simulator's clock is
  // not the wall clock), so ages are measured against the frame's own time.
  const frameTs = tracks?.ts_ms ?? null;

  // State band and readiness series for the focused subject over the retained history.
  const { band, readiness, resp } = useMemo(() => {
    if (!focus) return { band: [], readiness: [], resp: [] };
    const band: { color: string | null }[] = [];
    const readiness: number[] = [];
    const resp: number[] = [];
    for (const msg of history) {
      const t = (msg.data as unknown as TrackState).tracks?.find((x) => x.id === focus.id);
      const state = t?.state?.state ?? null;
      band.push({ color: state ? STATE_VAR[state] : null });
      if (t?.advisory) readiness.push(t.advisory.readiness_index);
      if (t && t.vitals.respiration.bpm !== null) resp.push(t.vitals.respiration.bpm);
    }
    return { band, readiness, resp };
  }, [history, focus]);

  return (
    <div className="grid h-full min-h-0 gap-2.5" style={{ gridTemplateColumns: "minmax(0,1fr) 384px" }}>
      <div className="grid min-h-0 gap-2.5" style={{ gridTemplateRows: "auto minmax(0,1fr)" }}>
        <Panel
          code="C1"
          title="Tracked Subjects"
          flush
          right={<span className="panel-meta">{list.length} TRACKS · RISK ORDER · CLICK TO FOCUS</span>}
        >
          {list.length === 0 ? (
            <Empty title="Volume clear">No subject in the sensing volume.</Empty>
          ) : (
            <div className="overflow-auto">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Track</th>
                    <th>State</th>
                    <th>Advisory</th>
                    <th className="text-right">RRI</th>
                    <th className="text-right">Resp</th>
                    <th className="text-right">RRV</th>
                    <th className="text-right">Motion</th>
                    <th className="text-right">Range</th>
                    <th className="text-right">Brg</th>
                    <th className="text-right">Pos x,z</th>
                    <th>Provenance</th>
                    <th>Attribution</th>
                    <th className="text-right">Dwell</th>
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
                        data-selected={t.id === focus?.id}
                        style={{ cursor: "pointer" }}
                      >
                        <td className="mono" style={{ color: "var(--text-0)" }}>{t.id}</td>
                        <td className="display font-bold tracking-[0.1em]" style={{ color: state ? STATE_VAR[state] : "var(--unknown)" }}>
                          {state ? STATE_SHORT[state] : "UNRESOLVED"}
                        </td>
                        <td className="display font-bold tracking-[0.1em]" style={{ color: DECISION_VAR[decision] }}>
                          {t.advisory ? DECISION_TEXT[decision] : DASH}
                        </td>
                        <td className="num">{num(t.advisory?.readiness_index ?? 0, 2)}</td>
                        <td className="num">
                          {t.vitals.respiration.bpm !== null ? num(t.vitals.respiration.bpm) : "--"}
                        </td>
                        <td className="num">{num(t.vitals.respiration_features.rrv_cv, 3)}</td>
                        <td className="num">{num(t.vitals.motion.index, 1)}</td>
                        <td className="num">{range(t.position)}</td>
                        <td className="num">{bearing(t.position)}</td>
                        <td className="num">{position(t.position)}</td>
                        <td className="mono text-[11px]">{PROVENANCE_TEXT[t.provenance] ?? t.provenance}</td>
                        <td
                          className="mono text-[11px]"
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
            code="C2"
            title="Subject Record"
            ticks
            right={<span className="mono text-[11px] text-[var(--text-0)]">{focus.id}</span>}
          >
            <div className="grid h-full min-h-0 gap-5" style={{ gridTemplateColumns: "minmax(0,1fr) minmax(0,0.8fr)" }}>
              <div className="flex min-w-0 flex-col gap-4">
                <div>
                  <Section right={<span className="mono text-[9px] text-[var(--text-3)]">{history.length} FRAMES · OLDEST LEFT</span>}>
                    Behavioural state history
                  </Section>
                  <StateBand segments={band} height={18} />
                  <div className="mt-1.5 flex flex-wrap gap-3">
                    {Object.entries(STATE_VAR).map(([name, color]) => (
                      <span key={name} className="flex items-center gap-1.5">
                        <span className="h-2 w-2" style={{ background: color }} />
                        <span className="mono text-[9px] text-[var(--text-2)]">{name}</span>
                      </span>
                    ))}
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <Section>Readiness index</Section>
                    <Sparkline data={readiness} color={DECISION_VAR[focus.advisory?.decision ?? "INSUFFICIENT_EVIDENCE"]} height={58} min={0} max={1} threshold={0.25} fill scale />
                  </div>
                  <div>
                    <Section>Respiration · BPM</Section>
                    <Sparkline data={resp} color="var(--ok)" height={58} fill scale />
                  </div>
                </div>

                <div>
                  <Section>Track</Section>
                  <div className="grid grid-cols-2 gap-x-6 lg:grid-cols-3">
                    <Field label="Track id" value={focus.id} />
                    <Field label="Upstream id" value={focus.upstream_id ?? "--"} />
                    <Field label="Zone" value={focus.zone} />
                    <Field label="Held for" value={frameTs ? duration((frameTs - focus.first_seen) / 1000) : "--"} />
                    <Field label="Last update" value={frameTs ? `${duration(Math.max(0, frameTs - focus.last_seen) / 1000)} ago` : "--"} />
                    <Field label="Detect conf" value={num(focus.confidence, 2)} />
                    <Field label="Speed" value={`${num(focus.speed_mps, 2)} m/s`} />
                    <Field label="Posture" value={focus.posture ?? "unknown"} />
                    <Field label="Nearest node" value={focus.node_id ?? "--"} />
                    <Field label="Motion score" value={num(focus.motion_score, 1)} />
                    <Field label="Signal qual" value={num(focus.vitals.signal_quality, 2)} />
                    <Field label="Features used" value={focus.state?.features_used ?? "--"} />
                  </div>
                </div>

                {focus.features && (
                  <div>
                    <Section>Feature vector into the state model</Section>
                    <div className="grid grid-cols-2 gap-x-6 lg:grid-cols-3">
                      <Feature label="Respiration" value={focus.features.respiration_bpm} digits={1} />
                      <Feature label="RRV CV" value={focus.features.rrv_cv} digits={3} />
                      <Feature label="Motion idx" value={focus.features.motion_index} digits={1} />
                      <Feature label="Burst rate" value={focus.features.burst_rate} digits={2} />
                      <Feature label="Depth CV" value={focus.features.amplitude_cv} digits={3} />
                      <Field label="Evidence" value={num(focus.features.evidence, 2)} />
                    </div>
                    <p className="note mt-1.5">
                      A dropped feature is excluded from the likelihood for that frame rather than
                      imputed — it weakens the estimate instead of biasing it.
                    </p>
                  </div>
                )}

                <div className="flex flex-wrap gap-2">
                  <Chip color="var(--text-1)">{PROVENANCE_TEXT[focus.provenance] ?? focus.provenance}</Chip>
                  <Chip color={focus.vitals.attribution === "exclusive" ? "var(--text-1)" : "var(--warn)"}>
                    Vitals {focus.vitals.attribution.replaceAll("_", " ")}
                  </Chip>
                  {caps?.model.vitals_attribution && (
                    <Chip color="var(--text-1)">Mode {caps.model.vitals_attribution}</Chip>
                  )}
                </div>
              </div>

              <div className="flex min-h-[260px] min-w-0 flex-col">
                <Section right={<span className="mono text-[9px] text-[var(--text-2)]">{range(focus.position)} M · {bearing(focus.position)}</span>}>
                  Plot
                </Section>
                <div className="min-h-0 flex-1 border border-[var(--line)]">
                  <PlanView
                    tracks={list}
                    nodes={nodes?.nodes ?? []}
                    geometry={caps?.geometry}
                    selectedId={focus.id}
                    height="100%"
                  />
                </div>
              </div>
            </div>
          </Panel>
        ) : (
          <Panel code="C2" title="Subject Record">
            <Empty title="No subject">Select a subject to see its full record.</Empty>
          </Panel>
        )}
      </div>

      <div className="flex min-h-0 flex-col gap-2.5 overflow-y-auto pr-0.5 [&>*]:shrink-0">
        <AdvisoryPanel track={focus} thresholds={caps?.advisory} />
        <VitalsPanel track={focus} upstream={upstream} compact />
      </div>
    </div>
  );
}

function Feature({ label, value, digits }: { label: string; value: number | null; digits: number }) {
  return (
    <Field
      label={label}
      value={value !== null ? num(value, digits) : "dropped"}
      color={value === null ? "var(--text-3)" : undefined}
    />
  );
}
