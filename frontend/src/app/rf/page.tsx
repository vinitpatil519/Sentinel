"use client";

/**
 * RF / Nodes — the sensing layer itself.
 *
 * Whether a reading can be believed is decided here: which nodes are reporting,
 * at what rate, at what link margin, and what the raw CSI amplitude profile
 * looks like. A respiration estimate from a node at −80 dBm updating at 2 Hz is
 * a different claim from the same number at −45 dBm and 10 Hz, and this page is
 * where that difference is visible.
 */

import { useMemo } from "react";
import PlanView from "@/components/panels/PlanView";
import { BarProfile, Sparkline } from "@/components/charts";
import { useSelection } from "@/components/Shell";
import { Chip, Empty, Field, Panel, Stat } from "@/components/ui";
import {
  useCapabilities,
  useChannelHistory,
  useField,
  useNodes,
  usePresence,
  useTracks,
} from "@/lib/telemetry";
import { num, pct } from "@/lib/format";
import type { Nodes, Presence } from "@/lib/types";

export default function RF() {
  const nodes = useNodes();
  const tracks = useTracks();
  const field = useField();
  const presence = usePresence();
  const caps = useCapabilities();
  const nodeHistory = useChannelHistory("rf.nodes");
  const presenceHistory = useChannelHistory("rf.presence");
  const { selected } = useSelection();

  const rssiSeries = useMemo(() => {
    const byNode = new Map<number, number[]>();
    for (const msg of nodeHistory) {
      for (const n of (msg.data as unknown as Nodes).nodes ?? []) {
        const arr = byNode.get(n.node_id) ?? [];
        arr.push(n.rssi_dbm);
        byNode.set(n.node_id, arr);
      }
    }
    return byNode;
  }, [nodeHistory]);

  const motionSeries = useMemo(
    () => presenceHistory.map((m) => (m.data as unknown as Presence).motion_band_power),
    [presenceHistory],
  );
  const breathingSeries = useMemo(
    () => presenceHistory.map((m) => (m.data as unknown as Presence).breathing_band_power),
    [presenceHistory],
  );

  const list = nodes?.nodes ?? [];

  return (
    <div className="grid h-full min-h-0 gap-2.5" style={{ gridTemplateColumns: "minmax(0,1fr) 430px" }}>
      <div className="flex min-h-0 flex-col gap-2.5 overflow-y-auto pr-0.5 [&>*]:shrink-0">
        <Panel
          code="E1"
          title="Sensing Nodes"
          flush
          right={
            <span className="mono text-[10px] text-[var(--text-2)]">
              {nodes ? `${nodes.online_count}/${nodes.node_count} ONLINE` : "NO NODE TELEMETRY"}
            </span>
          }
        >
          {list.length === 0 ? (
            <Empty title="No nodes">
              No node telemetry. The sensing server reports nodes once CSI frames arrive on
              UDP 5005.
            </Empty>
          ) : (
            <table className="data-table [&_td]:px-2 [&_th]:px-2">
              <thead>
                <tr>
                  <th>Node</th>
                  <th>Status</th>
                  <th className="text-right">RSSI</th>
                  <th style={{ width: "22%" }}>RSSI trend</th>
                  <th className="text-right">Rate</th>
                  <th className="text-right">Subcarriers</th>
                  <th className="text-right">Motion band</th>
                  <th className="text-right">Resp band</th>
                  <th className="text-right">Novelty</th>
                  <th className="text-right">Position x,z</th>
                  <th>Carrying</th>
                </tr>
              </thead>
              <tbody>
                {list.map((n) => {
                  const carrying = (tracks?.tracks ?? []).filter((t) => t.node_id === n.node_id);
                  return (
                    <tr key={n.node_id}>
                      <td className="mono" style={{ color: "var(--text-0)" }}>N{n.node_id}</td>
                      <td>
                        <span className="chip" style={{ color: n.stale ? "var(--deny)" : "var(--ok)" }}>
                          <span className={`dot ${n.stale ? "blink" : ""}`} />
                          {n.stale ? "Stale" : "Online"}
                        </span>
                      </td>
                      <td className="num">{num(n.rssi_dbm)} dBm</td>
                      <td style={{ padding: "2px 8px" }}>
                        <Sparkline
                          data={rssiSeries.get(n.node_id) ?? []}
                          color={n.stale ? "var(--deny)" : "var(--accent)"}
                          height={18}
                        />
                      </td>
                      <td className="num">{num(n.frame_rate_hz, 1)} Hz</td>
                      <td className="num">{n.subcarrier_count}</td>
                      <td className="num">{n.motion_band_power.toExponential(1)}</td>
                      <td className="num">{n.breathing_band_power.toExponential(1)}</td>
                      <td className="num">
                        {n.novelty_score !== null ? num(n.novelty_score, 2) : "--"}
                      </td>
                      <td className="num">
                        {n.position[0].toFixed(1)}, {n.position[2].toFixed(1)}
                      </td>
                      <td className="mono">
                        {carrying.length ? carrying.map((t) => t.id).join(" ") : "--"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </Panel>

        <div className="grid gap-2.5" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))" }}>
          {list.map((n) => (
            <Panel
              key={n.node_id}
              code={`E2.${n.node_id}`}
              title={`Node ${n.node_id} · CSI profile`}
              right={
                <Chip color={n.stale ? "var(--deny)" : "var(--text-2)"}>
                  {n.stale ? "STALE" : `${num(n.frame_rate_hz, 1)} Hz`}
                </Chip>
              }
            >
              <BarProfile data={n.amplitude_profile} height={70} color={n.stale ? "var(--deny)" : "var(--accent)"} />
              <div className="mt-2 grid grid-cols-2 gap-x-5">
                <Field label="Mean amplitude" value={n.amplitude_mean !== null ? num(n.amplitude_mean, 2) : "--"} />
                <Field label="Subcarriers" value={String(n.subcarrier_count)} />
                <Field label="Link margin" value={`${num(n.rssi_dbm)} dBm`} />
                <Field label="Last seen" value={n.last_seen_ms ? "reported" : "--"} />
              </div>
              <p className="note mt-1.5">
                Decimated to 48 bins for transport. Chest displacement modulates these bins
                unevenly; the respiration chain averages them to trade sensitivity for noise.
              </p>
            </Panel>
          ))}
        </div>

        <div className="grid gap-2.5" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))" }}>
          <Panel code="E3" title="Motion band power · volume">
            <Sparkline data={motionSeries} color="var(--alert)" height={92} fill scale />
            <div className="mt-2 grid grid-cols-2 gap-x-5">
              <Field label="Current" value={presence ? presence.motion_band_power.toExponential(2) : "--"} />
              <Field label="Change points" value={presence ? String(presence.change_points) : "--"} />
            </div>
          </Panel>
          <Panel code="E4" title="Respiration band power · volume">
            <Sparkline data={breathingSeries} color="var(--ok)" height={92} fill scale />
            <div className="mt-2 grid grid-cols-2 gap-x-5">
              <Field
                label="Dominant"
                value={presence ? `${num(presence.dominant_freq_hz, 3)} Hz` : "--"}
              />
              <Field
                label="As rate"
                value={presence ? `${num(presence.dominant_freq_hz * 60, 1)} BPM` : "--"}
              />
            </div>
          </Panel>
        </div>
      </div>

      <div className="flex min-h-0 flex-col gap-2.5 overflow-y-auto pr-0.5 [&>*]:shrink-0">
        <Panel code="E5" title="Deployment Plan" ticks>
          <PlanView
            tracks={tracks?.tracks ?? []}
            nodes={list}
            geometry={caps?.geometry}
            selectedId={selected}
            height={380}
          />
          <div className="mt-2 grid grid-cols-2 gap-x-5">
            <Field
              label="Volume"
              value={
                caps?.geometry
                  ? `${caps.geometry.extent[0]} × ${caps.geometry.extent[1]} × ${caps.geometry.extent[2]} m`
                  : "--"
              }
            />
            <Field label="Wall axis" value={caps?.geometry.wall_axis?.toUpperCase() ?? "--"} />
            <Field
              label="Wall offset"
              value={caps?.geometry ? `${num(caps.geometry.wall_offset_m, 2)} m` : "--"}
            />
            <Field label="Nodes" value={String(list.length)} />
          </div>
        </Panel>

        <Panel code="E6" title="Signal Field">
          {field ? (
            <div className="flex flex-col gap-3">
              <div className="flex flex-wrap gap-6">
                <Stat label="Occupied voxels" value={String(field.occupied)} />
                <Stat label="Peak intensity" value={num(field.peak, 3)} />
                <Stat label="Grid" value={field.dims.join(" × ")} />
              </div>
              <div className="grid grid-cols-2 gap-x-5">
                <Field label="Noise floor cut" value={`${pct(field.floor_fraction)}% of peak`} />
                <Field label="Extent" value={field.extent.map((e) => `${e}`).join(" × ") + " m"} />
                <Field label="Source" value={field.source} />
              </div>
              <p className="note">
                Voxels below the cut are the empty-room floor and are dropped before transport;
                what reaches the console is only the part of the field that carries subject
                information.
              </p>
            </div>
          ) : (
            <Empty title="No field">No signal field received.</Empty>
          )}
        </Panel>
      </div>
    </div>
  );
}
