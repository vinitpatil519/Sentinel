"use client";

/**
 * Operations — the screen an operator actually watches.
 *
 * Layout follows the decision path: the volume (where are they), the advisory
 * (can I go), the roster (who else is there), the vitals (why the advisory says
 * that), the log (what changed). Nothing else is on this screen.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import VolumeScene, { type ViewPreset } from "@/components/VolumeScene";
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
import type { Decision } from "@/lib/types";

const VIEW_LABEL: Record<ViewPreset, string> = { persp: "Persp", top: "Plan", operator: "Opr" };
const LEGEND: Decision[] = ["APPROACH", "CAUTION", "HOLD", "DO_NOT_APPROACH", "INSUFFICIENT_EVIDENCE"];
const LEGEND_SHORT: Record<Decision, string> = {
  APPROACH: "APPR",
  CAUTION: "CAUT",
  HOLD: "HOLD",
  DO_NOT_APPROACH: "DNA",
  INSUFFICIENT_EVIDENCE: "INSUF",
};

export default function Operations() {
  const tracks = useTracks();
  const field = useField();
  const nodes = useNodes();
  const presence = usePresence();
  const upstream = useUpstreamVitals();
  const caps = useCapabilities();
  const { live } = useSource();
  const { selected, select } = useSelection();
  const [view, setView] = useState<ViewPreset>("persp");
  const [orbit, setOrbit] = useState(false);
  const headingRef = useRef<HTMLSpanElement | null>(null);
  const roseRef = useRef<SVGGElement | null>(null);
  // Written straight to the DOM: the heading changes every frame while orbiting.
  const onHeading = useCallback((deg: number) => {
    if (headingRef.current) headingRef.current.textContent = `${String(deg).padStart(3, "0")}°`;
    roseRef.current?.setAttribute("transform", `rotate(${-deg})`);
  }, []);

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

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      const k = e.key.toLowerCase();
      if (k === "v") setView((v) => (v === "persp" ? "top" : v === "top" ? "operator" : "persp"));
      if (k === "o") setOrbit((o) => !o);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const anyPose = list.some((t) => (t.keypoints?.length ?? 0) > 0);

  return (
    <div className="grid h-full min-h-0 gap-2.5" style={{ gridTemplateColumns: "minmax(0,1fr) 384px" }}>
      {/* Left: volume + roster/log */}
      <div className="grid min-h-0 min-w-0 gap-2.5" style={{ gridTemplateRows: "minmax(0,1fr) 232px" }}>
        <Panel
          code="A1"
          title="Sensing Volume"
          ticks
          flush
          right={
            <>
              <span className="panel-meta hidden xl:inline">
                {field ? `${field.occupied} VOX` : "NO FIELD"}
                {caps?.geometry ? ` · ${caps.geometry.extent[0]}×${caps.geometry.extent[2]}×${caps.geometry.extent[1]} M` : ""}
              </span>
              <div className="flex">
                {(Object.keys(VIEW_LABEL) as ViewPreset[]).map((v) => (
                  <button
                    key={v}
                    type="button"
                    className="btn h-[22px] px-2 text-[10.5px]"
                    data-active={view === v}
                    onClick={() => setView(v)}
                    title={v === "operator" ? "Operator's vantage, through the wall" : undefined}
                  >
                    {VIEW_LABEL[v]}
                  </button>
                ))}
              </div>
              <button
                type="button"
                className="btn h-[22px] px-2 text-[10.5px]"
                data-active={orbit}
                onClick={() => setOrbit((o) => !o)}
              >
                Orbit
              </button>
            </>
          }
        >
          <div className="scanlines vignette relative h-full w-full overflow-hidden bg-[radial-gradient(ellipse_at_50%_55%,#0a1519_0%,#050708_75%)]">
            <VolumeScene
              field={field}
              tracks={list}
              nodes={nodes?.nodes ?? []}
              geometry={caps?.geometry}
              selectedId={focus?.id ?? null}
              onSelect={select}
              view={view}
              autoRotate={orbit}
              onHeading={onHeading}
            />
            <div className="brackets z-[2]" />

            {/* Top-left: acquisition readouts */}
            <div className="hud-box pointer-events-none absolute top-4 left-4 z-[3] w-[212px] px-3 py-2.5">
              <div className="mb-2 flex items-center justify-between">
                <span className="label-strong text-[10.5px]">Acquisition</span>
                <span
                  className="chip"
                  style={{ color: presence?.present ? "var(--ok)" : "var(--text-2)", height: 17 }}
                >
                  <span className={`dot ${presence?.present ? "pulse" : ""}`} />
                  {presence?.present ? "Detect" : "Clear"}
                </span>
              </div>
              <HudRow label="Confidence" value={presence ? `${pct(presence.confidence)}%` : "--"} />
              <HudRow label="Motion" value={presence?.motion_level?.replaceAll("_", " ").toUpperCase() ?? "--"} />
              <HudRow label="Field peak" value={field ? num(field.peak, 2) : "--"} />
              <HudRow label="Tracks" value={String(list.length)} />
              <HudRow
                label="Est. persons"
                value={presence?.estimated_persons != null ? String(presence.estimated_persons) : "--"}
              />
            </div>

            {/* Top-right: camera heading */}
            <div className="hud-box pointer-events-none absolute top-4 right-4 z-[3] flex items-center gap-3 px-3 py-2">
              <Compass roseRef={roseRef} />
              <div className="flex flex-col gap-0.5">
                <span className="label text-[10px]">View hdg</span>
                <span ref={headingRef} className="mono text-[15px] leading-none text-[var(--text-0)]">
                  ---°
                </span>
                <span className="mono text-[9.5px] text-[var(--accent)]">{VIEW_LABEL[view].toUpperCase()}{orbit ? " · ORBIT" : ""}</span>
              </div>
            </div>

            {/* Bottom-left: legend + provenance */}
            <div className="hud-box pointer-events-none absolute bottom-4 left-4 z-[3] flex max-w-[min(54%,440px)] flex-col gap-1.5 px-3 py-2">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="label text-[10px]">Advisory</span>
                {LEGEND.map((d) => (
                  <span key={d} className="flex items-center gap-1.5">
                    <span className="h-[7px] w-[7px]" style={{ background: DECISION_VAR[d] }} />
                    <span className="mono text-[9.5px] text-[var(--text-1)]">{LEGEND_SHORT[d]}</span>
                  </span>
                ))}
              </div>
              <p className="border-t border-[var(--line)] pt-1.5 text-[10px] leading-snug text-[var(--text-2)]">
                {anyPose
                  ? "Skeleton drawn from upstream pose keypoints."
                  : field?.planar
                    ? `Field is a ${field.dims[0]}×${field.dims[2]} floor-plane map, drawn on the ground; it carries no height. Columns show occupied extent, not body shape. No skeleton: the upstream pose model returns no keypoints.`
                    : "Cloud is the measured signal field; markers are field-peak localisations. Columns show extent, not body shape. No skeleton: the upstream CSI pose model returns no keypoints."}
              </p>
            </div>

            {/* Bottom-right: controls */}
            <div className="hud-box pointer-events-none absolute right-4 bottom-4 z-[3] flex flex-col items-start gap-1 px-3 py-2">
              <KeyHint k="drag">orbit</KeyHint>
              <KeyHint k="wheel">range</KeyHint>
              <KeyHint k="click">select</KeyHint>
              <KeyHint k="V">view</KeyHint>
            </div>

            {!field && (
              <div className="absolute inset-0 z-[4] flex items-center justify-center">
                <Empty title={live ? "Awaiting field" : "No sensing source"}>
                  {live
                    ? "Awaiting signal field from the sensing server."
                    : "Start the sensing server or run scripts/ruview_sim.py."}
                </Empty>
              </div>
            )}
          </div>
        </Panel>

        <div className="grid min-h-0 gap-2.5" style={{ gridTemplateColumns: "minmax(0,1fr) minmax(0,1.15fr)" }}>
          <Roster tracks={list} selectedId={focus?.id ?? null} onSelect={select} />
          <EventFeed limit={40} />
        </div>
      </div>

      {/* Right rail: advisory + vitals */}
      <div className="flex min-h-0 flex-col gap-2.5 overflow-y-auto pr-0.5 [&>*]:shrink-0">
        <AdvisoryPanel track={focus} thresholds={caps?.advisory} />
        <VitalsPanel track={focus} upstream={upstream} compact />
      </div>
    </div>
  );
}

function HudRow({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-[1.5px]">
      <span className="label text-[10.5px]">{label}</span>
      <span className="mono text-[11px]" style={{ color: color ?? "var(--text-0)" }}>
        {value}
      </span>
    </div>
  );
}

/**
 * Heading rose: the card turns against the camera, so the accent tick always
 * points at bearing 000 on the floor; the lubber line at the top is the view.
 */
function Compass({ roseRef }: { roseRef: React.RefObject<SVGGElement | null> }) {
  return (
    <svg width="36" height="36" viewBox="-18 -18 36 36" aria-hidden>
      <path d="M0 -18V-13" stroke="var(--text-0)" strokeWidth="1.5" />
      <g ref={roseRef}>
        <circle r="15" fill="none" stroke="var(--line-bright)" />
        {Array.from({ length: 12 }, (_, i) => {
          const a = (i * 30 * Math.PI) / 180;
          const r0 = i % 3 === 0 ? 11 : 13;
          return (
            <line
              key={i}
              x1={Math.sin(a) * r0}
              y1={-Math.cos(a) * r0}
              x2={Math.sin(a) * 15}
              y2={-Math.cos(a) * 15}
              stroke={i === 0 ? "var(--accent)" : "var(--text-3)"}
            />
          );
        })}
        <path d="M0 -9L3 2H-3z" fill="var(--accent)" />
        <path d="M0 9L3 2H-3z" fill="var(--text-3)" />
      </g>
    </svg>
  );
}
