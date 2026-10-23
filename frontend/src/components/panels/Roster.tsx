"use client";

/**
 * Subject roster — every track in the volume, highest risk first.
 *
 * The ordering is the backend's, not the UI's: it sorts by readiness index so
 * the subject who most constrains the operator's next move is always the top
 * row. A list sorted by acquisition time would put a sleeping subject above an
 * alert one purely because they were seen first.
 */

import type { Track } from "@/lib/types";
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
  range,
} from "@/lib/format";
import { Empty, Meter, Panel } from "@/components/ui";

export default function Roster({
  tracks,
  selectedId,
  onSelect,
}: {
  tracks: Track[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <Panel
      code="A2"
      title="Subject Roster"
      right={
        <span className="panel-meta">
          {tracks.length} {tracks.length === 1 ? "TRACK" : "TRACKS"} · RISK ORDER
        </span>
      }
      flush
    >
      {tracks.length === 0 ? (
        <Empty title="Volume clear">No subject detected in the sensing volume.</Empty>
      ) : (
        <ul className="flex flex-col">
          {tracks.map((track, i) => (
            <RosterRow
              key={track.id}
              index={i + 1}
              track={track}
              selected={track.id === selectedId}
              onSelect={onSelect}
            />
          ))}
        </ul>
      )}
    </Panel>
  );
}

/** Diamond track symbol in the advisory colour, numbered by risk rank. */
function TrackSymbol({ color, index, selected }: { color: string; index: number; selected: boolean }) {
  return (
    <svg width="30" height="30" viewBox="-15 -15 30 30" className="flex-none" aria-hidden>
      {selected && <rect x="-14.5" y="-14.5" width="29" height="29" fill="none" stroke={color} strokeDasharray="5 19" strokeDashoffset="2.5" />}
      <path d="M0 -10L10 0L0 10L-10 0z" fill={`color-mix(in srgb, ${color} 18%, transparent)`} stroke={color} strokeWidth="1.5" />
      <text y="3.5" textAnchor="middle" fontSize="9.5" fontFamily="var(--font-mono)" fill="var(--text-0)">
        {index}
      </text>
    </svg>
  );
}

function RosterRow({
  index,
  track,
  selected,
  onSelect,
}: {
  index: number;
  track: Track;
  selected: boolean;
  onSelect: (id: string) => void;
}) {
  const decision = track.advisory?.decision ?? "INSUFFICIENT_EVIDENCE";
  const color = DECISION_VAR[decision];
  const state = track.state?.state ?? null;
  const resp = track.vitals.respiration;
  const readiness = track.advisory?.readiness_index ?? 0;

  return (
    <li>
      <button
        type="button"
        onClick={() => onSelect(track.id)}
        className="row-hover relative w-full border-b border-[var(--line)] px-3 py-2.5 text-left"
        style={{ background: selected ? "var(--bg-4)" : undefined }}
      >
        {selected && <span className="absolute top-0 bottom-0 left-0 w-[2px] bg-[var(--accent)]" />}
        <div className="flex items-start gap-3">
          <TrackSymbol color={color} index={index} selected={selected} />
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline gap-2.5">
              <span className="mono text-[14px] font-semibold text-[var(--text-0)]">{track.id}</span>
              <span
                className="display text-[12px] font-bold tracking-[0.14em]"
                style={{ color: state ? STATE_VAR[state] : "var(--unknown)" }}
              >
                {state ? STATE_SHORT[state] : "UNRESOLVED"}
              </span>
              <span className="display ml-auto text-[12px] font-bold tracking-[0.12em]" style={{ color }}>
                {track.advisory ? DECISION_TEXT[decision] : DASH}
              </span>
            </div>

            <div className="mt-1.5 grid grid-cols-4 gap-2">
              <Metric label="Resp" value={resp.bpm !== null ? num(resp.bpm) : "NO LOCK"} unit={resp.bpm !== null ? "BPM" : undefined} dim={resp.bpm === null} />
              <Metric label="Range" value={range(track.position)} unit="M" />
              <Metric label="Brg" value={bearing(track.position)} />
              <Metric label="Dwell" value={duration(track.state?.dwell_s)} />
            </div>

            <div className="mt-2 flex items-center gap-2">
              <span className="label text-[9.5px]">RRI</span>
              <div className="flex-1">
                <Meter value={readiness} color={color} height={3} ticks={[0.25, 0.45, 0.7]} />
              </div>
              <span className="mono w-8 text-right text-[10px] text-[var(--text-1)]">{num(readiness, 2)}</span>
            </div>

            <div className="mono mt-1.5 flex flex-wrap items-center gap-x-2 text-[9.5px] text-[var(--text-2)]">
              <span>{PROVENANCE_TEXT[track.provenance] ?? track.provenance}</span>
              {track.node_id !== null && <span>· NODE {track.node_id}</span>}
              {track.posture && <span>· {track.posture.toUpperCase()}</span>}
              {track.vitals.attribution !== "exclusive" && (
                <span style={{ color: "var(--warn)" }}>
                  · {track.vitals.attribution.replace("_", " ").toUpperCase()}
                </span>
              )}
            </div>
          </div>
        </div>
      </button>
    </li>
  );
}

function Metric({ label, value, unit, dim }: { label: string; value: string; unit?: string; dim?: boolean }) {
  return (
    <div className="flex flex-col">
      <span className="label text-[9.5px]">{label}</span>
      <span className="mono text-[12px]" style={{ color: dim ? "var(--text-3)" : "var(--text-0)" }}>
        {value}
        {unit && <span className="ml-1 text-[9px] text-[var(--text-2)]">{unit}</span>}
      </span>
    </div>
  );
}
