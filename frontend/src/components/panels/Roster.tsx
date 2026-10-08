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
      title="Subject Roster"
      right={
        <span className="mono text-[11px] text-[var(--text-1)]">
          {tracks.length} {tracks.length === 1 ? "SUBJECT" : "SUBJECTS"}
        </span>
      }
      flush
    >
      {tracks.length === 0 ? (
        <Empty>Volume clear — no subject detected.</Empty>
      ) : (
        <ul className="flex flex-col">
          {tracks.map((track) => (
            <RosterRow
              key={track.id}
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

function RosterRow({
  track,
  selected,
  onSelect,
}: {
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
        className="row-hover w-full border-b border-[var(--line)] px-2.5 py-2 text-left"
        style={{ background: selected ? "var(--bg-3)" : undefined }}
      >
        <div className="flex items-center gap-2.5">
          <span className="w-[3px] self-stretch" style={{ background: color, minHeight: 28 }} />
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline gap-2">
              <span className="mono text-[13px] font-semibold text-[var(--text-0)]">{track.id}</span>
              <span
                className="text-[10px] font-semibold tracking-[0.1em]"
                style={{ color: state ? STATE_VAR[state] : "var(--unknown)" }}
              >
                {state ? STATE_SHORT[state] : "UNRESOLVED"}
              </span>
              <span className="mono ml-auto text-[10px]" style={{ color }}>
                {DECISION_TEXT[decision]}
              </span>
            </div>

            <div className="mt-1 flex items-baseline gap-3 text-[10px] text-[var(--text-2)]">
              <span className="mono">
                {resp.bpm !== null ? `${num(resp.bpm)} BPM` : "NO RESP LOCK"}
              </span>
              <span className="mono">{range(track.position)} m</span>
              <span className="mono">{bearing(track.position)}</span>
              <span className="mono hidden md:inline">{position(track.position)}</span>
              <span className="ml-auto mono">{duration(track.state?.dwell_s)}</span>
            </div>

            <div className="mt-1.5 flex items-center gap-2">
              <Meter value={readiness} color={color} height={3} />
              <span className="mono w-7 text-right text-[9px] text-[var(--text-3)]">
                {num(readiness, 2)}
              </span>
            </div>

            <div className="mt-1 flex items-center gap-2 text-[9px] text-[var(--text-3)]">
              <span className="mono">{PROVENANCE_TEXT[track.provenance] ?? track.provenance}</span>
              {track.node_id !== null && <span className="mono">NODE {track.node_id}</span>}
              {track.posture && <span className="mono">{track.posture.toUpperCase()}</span>}
              {track.vitals.attribution !== "exclusive" && (
                <span className="mono" style={{ color: "var(--warn)" }}>
                  {track.vitals.attribution.replace("_", " ").toUpperCase()}
                </span>
              )}
            </div>
          </div>
        </div>
      </button>
    </li>
  );
}
