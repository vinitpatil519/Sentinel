"use client";

/**
 * System — configuration, model provenance, diagnostics, and the ground-truth
 * labelling control.
 *
 * The labelling control is the research workflow, not an afterthought: while a
 * subject is verifiably doing a known thing, the operator marks it, and those
 * windows are what `scripts/calibrate_states.py` fits the state model on and
 * what the evaluation protocol scores against. A model calibrated on a room is
 * worth more than one calibrated on a simulation, and this is the only way to
 * get the labels.
 */

import { useCallback, useEffect, useState } from "react";
import { Chip, Empty, Field, Panel, Stat } from "@/components/ui";
import { API_BASE } from "@/lib/config";
import {
  useCapabilities,
  useChannel,
  useChannelHistory,
  useLink,
  useSource,
  useTracks,
} from "@/lib/telemetry";
import { STATE_VAR, clockHMS, num } from "@/lib/format";
import type { BehaviouralState } from "@/lib/types";

type Stats = {
  hub?: { channels: Record<string, { count: number; rate_hz: number }>; clients: number; dropped_clients: number };
  pipeline?: { frames: number; subject_count: number; source: string | null; last_frame_ts: number | null };
  db_writes?: number;
  session_id?: number | null;
};

type SensorInfo = Record<string, unknown> & { name: string; health: string };

const CHANNELS = ["rf.presence", "rf.vitals", "rf.nodes", "rf.field", "track.state", "events"];

export default function System() {
  const caps = useCapabilities();
  const link = useLink();
  const tracks = useTracks();
  const { label: sourceLabel, live } = useSource();
  const [stats, setStats] = useState<Stats | null>(null);
  const [sensors, setSensors] = useState<SensorInfo[]>([]);
  const [inspect, setInspect] = useState<string>("track.state");

  const refresh = useCallback(async () => {
    try {
      const [s, sn] = await Promise.all([
        fetch(`${API_BASE}/api/stats`).then((r) => r.json()),
        fetch(`${API_BASE}/api/sensors`).then((r) => r.json()),
      ]);
      setStats(s);
      setSensors(sn.sensors ?? []);
    } catch {
      /* backend down; the link indicator already says so */
    }
  }, []);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 5000);
    return () => clearInterval(t);
  }, [refresh]);

  return (
    <div className="grid h-full min-h-0 gap-3" style={{ gridTemplateColumns: "minmax(0,1fr) 400px" }}>
      <div className="flex min-h-0 flex-col gap-3 overflow-y-auto pr-0.5">
        <LabelControl trackIds={(tracks?.tracks ?? []).map((t) => t.id)} />
        <ChannelInspector channel={inspect} onChannel={setInspect} />
      </div>

      <div className="flex min-h-0 flex-col gap-3 overflow-y-auto pr-0.5">
        <Panel title="Platform">
          <div className="flex flex-wrap gap-6">
            <Stat label="Version" value={caps?.version ?? "--"} />
            <Stat label="Session" value={caps?.session_id != null ? String(caps.session_id).padStart(4, "0") : "--"} />
            <Stat label="Link" value={link.toUpperCase()} color={link === "live" ? "var(--ok)" : "var(--warn)"} />
          </div>
          <div className="mt-3 grid grid-cols-2 gap-x-5 border-t border-[var(--line)] pt-2">
            <Field label="Source" value={sourceLabel} color={live ? "var(--ok)" : "var(--warn)"} />
            <Field label="Subjects" value={tracks?.subject_count ?? "--"} />
            <Field label="Pipeline frames" value={stats?.pipeline?.frames ?? "--"} />
            <Field label="DB writes" value={stats?.db_writes ?? "--"} />
            <Field label="WS clients" value={stats?.hub?.clients ?? "--"} />
            <Field label="Dropped clients" value={stats?.hub?.dropped_clients ?? "--"} />
          </div>
        </Panel>

        <Panel title="Behavioural State Model">
          {caps ? (
            <div className="flex flex-col gap-2">
              <div>
                <span className="label">Provenance</span>
                <p className="mt-1 text-[11px] leading-snug text-[var(--text-1)]">
                  {caps.model.provenance}
                </p>
              </div>
              <div className="border-t border-[var(--line)] pt-2">
                <span className="label">States and arousal weight</span>
                <div className="mt-1.5 flex flex-col gap-1">
                  {caps.model.states.map((s) => (
                    <div key={s} className="flex items-baseline gap-2">
                      <span
                        className="h-2 w-3 flex-none"
                        style={{ background: STATE_VAR[s as BehaviouralState] }}
                      />
                      <span className="mono w-[84px] text-[10px] text-[var(--text-1)]">{s}</span>
                      <span className="mono text-[10px] text-[var(--text-0)]">
                        {num(caps.model.arousal_weights[s], 2)}
                      </span>
                      <span className="truncate text-[10px] text-[var(--text-3)]">
                        {caps.model.state_labels[s]}
                      </span>
                    </div>
                  ))}
                </div>
                <p className="mt-1.5 text-[9.5px] leading-snug text-[var(--text-3)]">
                  The advisory&apos;s readiness index is the posterior-weighted mean of these
                  weights, plus observed-motion and recency modifiers.
                </p>
              </div>
              <div className="border-t border-[var(--line)] pt-2">
                <span className="label">Advisory thresholds</span>
                <div className="mt-1 grid grid-cols-2 gap-x-5">
                  {Object.entries(caps.advisory).map(([k, v]) => (
                    <Field key={k} label={k.replaceAll("_", " ")} value={num(v, 2)} />
                  ))}
                </div>
              </div>
              <div className="border-t border-[var(--line)] pt-2">
                <Field label="Vitals attribution" value={caps.model.vitals_attribution} />
                <Field label="Capabilities" value={caps.capabilities.join("  ")} />
              </div>
            </div>
          ) : (
            <Empty>Backend unreachable.</Empty>
          )}
        </Panel>

        <Panel title="Sensors">
          {sensors.length === 0 ? (
            <Empty>No sensors configured.</Empty>
          ) : (
            <div className="flex flex-col gap-3">
              {sensors.map((s) => (
                <div key={s.name} className="border-b border-[var(--line)] pb-2 last:border-0">
                  <div className="flex items-center justify-between">
                    <span className="mono text-[12px] text-[var(--text-0)]">{s.name}</span>
                    <Chip
                      color={
                        s.health === "ok"
                          ? "var(--ok)"
                          : s.health === "degraded"
                            ? "var(--warn)"
                            : "var(--deny)"
                      }
                      dot
                    >
                      {String(s.health).toUpperCase()}
                    </Chip>
                  </div>
                  <div className="mt-1 grid grid-cols-1 gap-x-5">
                    {Object.entries(s)
                      .filter(([k]) => !["name", "health"].includes(k))
                      .map(([k, v]) => (
                        <Field
                          key={k}
                          label={k.replaceAll("_", " ")}
                          value={v === null ? "--" : String(v)}
                          color={k === "last_error" && v ? "var(--deny)" : undefined}
                        />
                      ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </Panel>

        <Panel title="Channel Rates">
          {stats?.hub?.channels ? (
            <table className="data-table">
              <thead>
                <tr>
                  <th>Channel</th>
                  <th className="text-right">Messages</th>
                  <th className="text-right">Rate</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(stats.hub.channels).map(([ch, v]) => (
                  <tr key={ch}>
                    <td className="mono">{ch}</td>
                    <td className="num">{v.count}</td>
                    <td className="num">{num(v.rate_hz, 1)} Hz</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <Empty>No hub statistics.</Empty>
          )}
        </Panel>
      </div>
    </div>
  );
}

// ---- ground truth labelling -------------------------------------------------

const LABELS: BehaviouralState[] = ["ASLEEP", "RESTING", "ALERT_STILL", "ACTIVE", "DISTRESSED"];

function LabelControl({ trackIds }: { trackIds: string[] }) {
  const [active, setActive] = useState<{ label: BehaviouralState; started: number; track: string | null } | null>(null);
  const [track, setTrack] = useState<string | null>(null);
  const [notes, setNotes] = useState("");
  const [recent, setRecent] = useState<{ label: string; ts_start: number; ts_end: number | null }[]>([]);
  const [status, setStatus] = useState<string | null>(null);

  const loadLabels = useCallback(async () => {
    try {
      const r = await fetch(`${API_BASE}/api/labels`).then((x) => x.json());
      setRecent((r.labels ?? []).slice(-12).reverse());
    } catch {
      /* backend down */
    }
  }, []);

  useEffect(() => {
    void loadLabels();
  }, [loadLabels]);

  const start = (label: BehaviouralState) => {
    setActive({ label, started: Date.now(), track });
    setStatus(null);
  };

  const commit = async () => {
    if (!active) return;
    try {
      const res = await fetch(`${API_BASE}/api/labels`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          label: active.label,
          ts_start: active.started,
          ts_end: Date.now(),
          track_id: active.track,
          notes: notes || null,
        }),
      });
      setStatus(res.ok ? `Recorded ${active.label}` : `Rejected (${res.status})`);
      setActive(null);
      setNotes("");
      void loadLabels();
    } catch {
      setStatus("Backend unreachable — label not recorded");
    }
  };

  return (
    <Panel
      title="Ground-truth labelling"
      ticks
      right={
        active && (
          <Chip color="var(--warn)" dot>
            RECORDING {active.label}
          </Chip>
        )
      }
    >
      <p className="mb-3 text-[11px] leading-snug text-[var(--text-1)]">
        Mark a window while the subject is verifiably in a known state. These windows are what
        the state model is fitted on and scored against — a model calibrated in the room it will
        be used in is the difference between a demonstration and a result.
      </p>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span className="label">Subject</span>
        <button className="btn" data-active={track === null} onClick={() => setTrack(null)}>
          whole volume
        </button>
        {trackIds.map((id) => (
          <button key={id} className="btn" data-active={track === id} onClick={() => setTrack(id)}>
            {id}
          </button>
        ))}
      </div>

      <div className="flex flex-wrap gap-2">
        {LABELS.map((l) => (
          <button
            key={l}
            className="btn"
            data-active={active?.label === l}
            onClick={() => start(l)}
            disabled={!!active && active.label !== l}
            style={{ borderColor: active?.label === l ? STATE_VAR[l] : undefined }}
          >
            {l.replace("_", " ")}
          </button>
        ))}
      </div>

      {active && (
        <div className="mt-3 border border-[var(--line-strong)] bg-[var(--bg-2)] p-2.5">
          <div className="flex items-center justify-between">
            <span className="mono text-[12px]" style={{ color: STATE_VAR[active.label] }}>
              {active.label} · {active.track ?? "whole volume"}
            </span>
            <span className="mono text-[11px] text-[var(--text-2)]">
              started {clockHMS(active.started)}
            </span>
          </div>
          <input
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="notes — subject, posture, anything that changes the interpretation"
            className="mono mt-2 w-full border border-[var(--line)] bg-[var(--bg-1)] px-2 py-1 text-[11px] text-[var(--text-0)] outline-none"
          />
          <div className="mt-2 flex gap-2">
            <button className="btn" onClick={() => void commit()}>
              Close window &amp; record
            </button>
            <button className="btn" onClick={() => setActive(null)}>
              Discard
            </button>
          </div>
        </div>
      )}

      {status && <p className="mt-2 text-[11px] text-[var(--text-1)]">{status}</p>}

      {recent.length > 0 && (
        <div className="mt-3 border-t border-[var(--line)] pt-2">
          <span className="label">Recorded windows</span>
          <table className="data-table mt-1">
            <thead>
              <tr>
                <th>Label</th>
                <th>Start</th>
                <th>End</th>
              </tr>
            </thead>
            <tbody>
              {recent.map((l, i) => (
                <tr key={`${l.ts_start}-${i}`}>
                  <td style={{ color: STATE_VAR[l.label as BehaviouralState] ?? "var(--text-1)" }}>
                    {l.label}
                  </td>
                  <td className="mono">{clockHMS(l.ts_start)}</td>
                  <td className="mono">{l.ts_end ? clockHMS(l.ts_end) : "open"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-2 text-[9.5px] leading-snug text-[var(--text-3)]">
            Fit with{" "}
            <span className="mono">python scripts/calibrate_states.py --db backend/data/sentinel.db</span>{" "}
            and restart the backend to load the result.
          </p>
        </div>
      )}
    </Panel>
  );
}

// ---- raw channel inspector --------------------------------------------------

function ChannelInspector({
  channel,
  onChannel,
}: {
  channel: string;
  onChannel: (ch: string) => void;
}) {
  const latest = useChannel<Record<string, unknown>>(channel);
  const history = useChannelHistory(channel);
  const raw = useChannel<Record<string, unknown>>("rf.raw");

  return (
    <Panel
      title="Channel Inspector"
      right={
        <div className="flex flex-wrap gap-1">
          {CHANNELS.map((c) => (
            <button key={c} className="btn" data-active={channel === c} onClick={() => onChannel(c)}>
              {c.replace("rf.", "")}
            </button>
          ))}
        </div>
      }
    >
      <div className="mb-2 flex flex-wrap gap-5">
        <Field label="Messages held" value={String(history.length)} />
        <Field label="Last sequence" value={latest ? String(latest.seq) : "--"} />
        <Field label="Last update" value={latest ? clockHMS(latest.ts) : "--"} />
      </div>
      <pre className="max-h-[38vh] overflow-auto border border-[var(--line)] bg-[var(--bg-0)] p-2 text-[10px] leading-relaxed text-[var(--text-1)]">
        {latest ? JSON.stringify(latest.data, null, 2) : "no message received on this channel"}
      </pre>

      {raw && (
        <div className="mt-3 border-t border-[var(--line)] pt-2">
          <span className="label" style={{ color: "var(--warn)" }}>
            Unrecognised upstream payloads (rf.raw)
          </span>
          <p className="mt-1 text-[10px] leading-snug text-[var(--text-2)]">
            The sensing server sent something the adapter did not map to a channel. Schema drift
            shows up here rather than as a silent gap.
          </p>
          <pre className="mt-1 max-h-40 overflow-auto border border-[var(--line)] bg-[var(--bg-0)] p-2 text-[10px] text-[var(--text-2)]">
            {JSON.stringify(raw.data, null, 2)}
          </pre>
        </div>
      )}
    </Panel>
  );
}
