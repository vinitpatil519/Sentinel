"use client";

/**
 * Top-down plan of the sensing volume.
 *
 * The 3-D view is for reading a scene; this is for reading *geometry* — where
 * the nodes are, where the wall is, and where each subject sits relative to
 * both. Distances are to scale in metres with a printed scale bar, so a range
 * can be measured off the screen rather than estimated.
 */

import { useEffect, useRef } from "react";
import type { Geometry, NodeInfo, Track } from "@/lib/types";
import { DECISION_VAR } from "@/lib/format";

function cssVar(name: string, fallback: string): string {
  if (typeof window === "undefined") return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

export default function PlanView({
  tracks,
  nodes,
  geometry,
  selectedId,
  height = 300,
}: {
  tracks: Track[];
  nodes: NodeInfo[];
  geometry?: Geometry;
  selectedId?: string | null;
  height?: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const dataRef = useRef({ tracks, nodes, geometry, selectedId });
  dataRef.current = { tracks, nodes, geometry, selectedId };

  useEffect(() => {
    const canvas = canvasRef.current;
    const parent = canvas?.parentElement;
    if (!canvas || !parent) return;

    let raf = 0;
    const draw = () => {
      raf = requestAnimationFrame(draw);
      const { tracks: trs, nodes: nds, geometry: geo, selectedId: sel } = dataRef.current;
      const dpr = window.devicePixelRatio || 1;
      const w = parent.clientWidth;
      const h = parent.clientHeight;
      if (!w || !h) return;
      if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
        canvas.width = w * dpr;
        canvas.height = h * dpr;
        canvas.style.width = `${w}px`;
        canvas.style.height = `${h}px`;
      }
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);

      const extent = geo?.extent ?? [6, 2.5, 6];
      const pad = 26;
      const scale = Math.min((w - pad * 2) / extent[0], (h - pad * 2) / extent[2]);
      const cx = w / 2;
      const cy = h / 2;
      const X = (mx: number) => cx + mx * scale;
      const Y = (mz: number) => cy + mz * scale;

      const line = cssVar("--line", "#1c242e");
      const lineStrong = cssVar("--line-strong", "#2a3743");
      const text2 = cssVar("--text-2", "#5f6d7c");
      const text3 = cssVar("--text-3", "#3d4854");
      const accent = cssVar("--accent", "#3d8bd6");

      // 1 m grid
      ctx.strokeStyle = line;
      ctx.lineWidth = 1;
      for (let m = -Math.floor(extent[0] / 2); m <= extent[0] / 2; m++) {
        ctx.beginPath();
        ctx.moveTo(Math.round(X(m)) + 0.5, Y(-extent[2] / 2));
        ctx.lineTo(Math.round(X(m)) + 0.5, Y(extent[2] / 2));
        ctx.stroke();
      }
      for (let m = -Math.floor(extent[2] / 2); m <= extent[2] / 2; m++) {
        ctx.beginPath();
        ctx.moveTo(X(-extent[0] / 2), Math.round(Y(m)) + 0.5);
        ctx.lineTo(X(extent[0] / 2), Math.round(Y(m)) + 0.5);
        ctx.stroke();
      }

      // Volume bounds
      ctx.strokeStyle = lineStrong;
      ctx.strokeRect(
        X(-extent[0] / 2),
        Y(-extent[2] / 2),
        extent[0] * scale,
        extent[2] * scale,
      );

      // Wall
      const axis = geo?.wall_axis ?? "x";
      const offset = geo?.wall_offset_m ?? -extent[0] / 4;
      ctx.strokeStyle = accent;
      ctx.lineWidth = 3;
      ctx.globalAlpha = 0.55;
      ctx.beginPath();
      if (axis === "x") {
        ctx.moveTo(X(offset), Y(-extent[2] / 2));
        ctx.lineTo(X(offset), Y(extent[2] / 2));
      } else {
        ctx.moveTo(X(-extent[0] / 2), Y(offset));
        ctx.lineTo(X(extent[0] / 2), Y(offset));
      }
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.lineWidth = 1;
      ctx.fillStyle = text3;
      ctx.font = "9px ui-sans-serif, system-ui";
      if (axis === "x") ctx.fillText("WALL", X(offset) + 4, Y(-extent[2] / 2) + 12);
      else ctx.fillText("WALL", X(-extent[0] / 2) + 4, Y(offset) - 4);

      // Nodes
      for (const n of nds) {
        const x = X(n.position[0]);
        const y = Y(n.position[2]);
        ctx.strokeStyle = n.stale ? cssVar("--deny", "#b93a36") : "#4e6a80";
        ctx.beginPath();
        ctx.moveTo(x, y - 6);
        ctx.lineTo(x + 6, y);
        ctx.lineTo(x, y + 6);
        ctx.lineTo(x - 6, y);
        ctx.closePath();
        ctx.stroke();
        ctx.fillStyle = text2;
        ctx.font = "9px ui-monospace, monospace";
        ctx.fillText(`N${n.node_id}`, x + 9, y + 3);
      }

      // Subjects
      for (const t of trs) {
        const x = X(t.position[0]);
        const y = Y(t.position[2]);
        const color = cssVar(
          (DECISION_VAR[t.advisory?.decision ?? "INSUFFICIENT_EVIDENCE"] ?? "var(--unknown)")
            .slice(4, -1)
            .trim(),
          "#6b7684",
        );
        const selected = t.id === sel;

        // Attribution link to the node carrying this subject's vitals.
        const node = nds.find((n) => n.node_id === t.node_id);
        if (node) {
          ctx.strokeStyle = "#2a4f70";
          ctx.setLineDash([3, 3]);
          ctx.beginPath();
          ctx.moveTo(X(node.position[0]), Y(node.position[2]));
          ctx.lineTo(x, y);
          ctx.stroke();
          ctx.setLineDash([]);
        }

        ctx.strokeStyle = color;
        ctx.lineWidth = selected ? 2 : 1;
        ctx.beginPath();
        ctx.arc(x, y, selected ? 11 : 8, 0, Math.PI * 2);
        ctx.stroke();
        ctx.fillStyle = color;
        ctx.globalAlpha = 0.25 + (t.advisory?.readiness_index ?? 0) * 0.5;
        ctx.fill();
        ctx.globalAlpha = 1;
        ctx.lineWidth = 1;

        ctx.fillStyle = cssVar("--text-0", "#dde4ec");
        ctx.font = "10px ui-monospace, monospace";
        ctx.fillText(t.id, x + 13, y - 2);
        ctx.fillStyle = color;
        ctx.font = "9px ui-sans-serif, system-ui";
        ctx.fillText(t.state?.state ?? "UNRESOLVED", x + 13, y + 9);
      }

      // Scale bar
      const barM = extent[0] >= 6 ? 2 : 1;
      const barPx = barM * scale;
      const bx = 12;
      const by = h - 14;
      ctx.strokeStyle = text2;
      ctx.beginPath();
      ctx.moveTo(bx, by);
      ctx.lineTo(bx + barPx, by);
      ctx.moveTo(bx, by - 3);
      ctx.lineTo(bx, by + 3);
      ctx.moveTo(bx + barPx, by - 3);
      ctx.lineTo(bx + barPx, by + 3);
      ctx.stroke();
      ctx.fillStyle = text2;
      ctx.font = "9px ui-monospace, monospace";
      ctx.fillText(`${barM} m`, bx + barPx + 6, by + 3);
    };

    draw();
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <div style={{ height, width: "100%" }}>
      <canvas ref={canvasRef} />
    </div>
  );
}
