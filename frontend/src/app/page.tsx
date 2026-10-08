"use client";

/**
 * Operations — the screen a soldier actually watches.
 *
 * Layout follows the decision path: the volume (where are they), the advisory
 * (can I go), the roster (who else is there), the vitals (why the advisory says
 * that), the log (what changed). Nothing else is on this screen.
 */

import { useEffect, useMemo } from "react";
import VolumeScene from "@/components/VolumeScene";
import AdvisoryPanel from "@/components/panels/Advisory";
import EventFeed from "@/components/panels/Events";
import Roster from "@/components/panels/Roster";
import VitalsPanel from "@/components/panels/Vitals";
import { useSelection } from "@/components/Shell";
import { Empty, KeyHint, Panel } from "@/components/ui";
import {
  useCapabilities,
  useField,
  useNodes,
  usePresence,
  useSource,
  useTracks,
  useUpstreamVitals,
} from "@/lib/telemetry";
import { DECISION_VAR, num, pct } from "@/lib/format";

export default function Operations() {
  const tracks = useTracks();
  const field = useField();
  const nodes = useNodes();
  const presence = usePresence();
  const upstream = useUpstreamVitals();
  const caps = useCapabilities();
  const { live } = useSource();
  const { selected, select } = useSelection();

  const list = useMemo(() => tracks?.tracks ?? [], [tracks]);
  // The roster is risk-ordered, so the default focus is the subject that most
  // constrains the operator — not the first one acquired.
  const focus = useMemo(
    () => list.find((t) => t.id === selected) ?? list[0],
    [list, selected],
  );

  useEffect(() => {
    if (selected && !list.some((t) => t.id === selected)) select(null);
  }, [list, selected, select]);

  const anyPose = list.some((t) => (t.keypoints?.length ?? 0) > 0);

  return (
    <div className="grid h-full min-h-0 gap-3" style={{ gridTemplateColumns: "minmax(0,1fr) 372px" }}>
      {/* Left: volume + roster/log */}
      <div className="grid min-h-0 min-w-0 gap-3" style={{ gridTemplateRows: "minmax(0,1fr) 236px" }}>
        <Panel
          title="Sensing Volume"
          ticks
          flush
          right={
            <>
              <span className="mono text-[10px] text-[var(--text-2)]">
                {field ? `${field.occupied} VOXELS` : "NO FIELD"}
              </span>
              <span className="mono text-[10px] text-[var(--text-2)]">
                {caps?.geometry
                  ? `${caps.geometry.extent[0]}×${caps.geometry.extent[2]} M`
                  : ""}
              </span>
            </>
          }
        >
          <div className="relative h-full w-full">
            <VolumeScene
              field={field}
              tracks={list}
              nodes={nodes?.nodes ?? []}
              geometry={caps?.geometry}
              selectedId={focus?.id ?? null}
              onSelect={select}
            />

            {/* Top-left readouts */}
            <div className="pointer-events-none absolute top-2.5 left-2.5 flex flex-col gap-1.5">
              <HudRow label="Presence" value={presence?.present ? "DETECTED" : "CLEAR"}
                color={presence?.present ? "var(--ok)" : "var(--text-2)"} />
              <HudRow label="Confidence" value={presence ? `${pct(presence.confidence)}%` : "--"} />
              <HudRow label="Motion" value={presence?.motion_level?.replace("_", " ").toUpperCase() ?? "--"} />
              <HudRow label="Field peak" value={field ? num(field.peak, 2) : "--"} />
            </div>

            {/* Top-right legend */}
            <div className="pointer-events-none absolute top-2.5 right-2.5 flex flex-col items-end gap-1">
              <span className="label" style={{ color: "var(--text-2)" }}>
                Advisory colour
              </span>
              {(["APPROACH", "CAUTION", "HOLD", "DO_NOT_APPROACH"] as const).map((d) => (
                <span key={d} className="flex items-center gap-1.5">
                  <span className="mono text-[9px] text-[var(--text-3)]">{d.replaceAll("_", " ")}</span>
                  <span className="h-2 w-4" style={{ background: DECISION_VAR[d] }} />
                </span>
              ))}
            </div>

            {/* Bottom-left provenance note */}
            <div className="pointer-events-none absolute bottom-2.5 left-2.5 max-w-[46ch]">
              <p className="text-[9.5px] leading-snug text-[var(--text-3)]">
                {anyPose
                  ? "Skeleton drawn from upstream pose keypoints."
                  : field?.planar
                    ? `Field is a ${field.dims[0]}×${field.dims[2]} floor-plane map, drawn on the ground; it carries no height. Subject columns show occupied extent, not measured body shape. No skeletal pose: the upstream CSI pose model is not returning keypoints.`
                    : "Cloud is the measured signal field; subject markers are field-peak localisations. No skeletal pose is drawn because the upstream CSI pose model is not returning keypoints."}
              </p>
            </div>

            {/* Bottom-right controls */}
            <div className="pointer-events-none absolute right-2.5 bottom-2.5 flex flex-col items-end gap-1">
              <KeyHint k="drag">orbit</KeyHint>
              <KeyHint k="scroll">zoom</KeyHint>
              <KeyHint k="click">select subject</KeyHint>
            </div>

            {!field && (
              <div className="absolute inset-0 flex items-center justify-center">
                <Empty>
                  {live
                    ? "Awaiting signal field from the sensing server."
                    : "No sensing source connected. Start the sensing server or run scripts/ruview_sim.py."}
                </Empty>
              </div>
            )}
          </div>
        </Panel>

        <div className="grid min-h-0 gap-3" style={{ gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr)" }}>
          <Roster tracks={list} selectedId={focus?.id ?? null} onSelect={select} />
          <EventFeed limit={40} />
        </div>
      </div>

      {/* Right rail: advisory + vitals */}
      <div className="flex min-h-0 flex-col gap-3 overflow-y-auto pr-0.5">
        <AdvisoryPanel track={focus} thresholds={caps?.advisory} />
        <VitalsPanel track={focus} upstream={upstream} compact />
      </div>
    </div>
  );
}

function HudRow({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <span className="flex items-baseline gap-2">
      <span className="label" style={{ width: 62 }}>
        {label}
      </span>
      <span className="mono text-[11px]" style={{ color: color ?? "var(--text-1)" }}>
        {value}
      </span>
    </span>
  );
}
