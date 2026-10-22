"use client";

/**
 * Top-down plan of the sensing volume, drawn as a plot board.
 *
 * The 3-D view is for reading a scene; this is for reading *geometry* — where
 * the nodes are, where the wall is, and where each subject sits relative to
 * both. Distances are to scale in metres, with range rings and bearings from
 * the same origin the roster measures from, so a range can be read off the
 * board rather than estimated. A subject's velocity, when it has one, is drawn
 * as a 2-second lead vector: the one motion cue here that is measured, not
 * decorative.
 */

import { useEffect, useRef } from "react";
import type { Geometry, NodeInfo, Track } from "@/lib/types";
import { DECISION_VAR, STATE_SHORT } from "@/lib/format";

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
  height?: number | string;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const dataRef = useRef({ tracks, nodes, geometry, selectedId });
  dataRef.current = { tracks, nodes, geometry, selectedId };

  useEffect(() => {
    const canvas = canvasRef.current;
    const parent = canvas?.parentElement;
    if (!canvas || !parent) return;

    const mono = cssVar("--font-plex-mono", "ui-monospace, monospace");
    const display = cssVar("--font-barlow", "ui-sans-serif, sans-serif");
    const c = {
      grid: "#0e1a1e",
      gridMajor: "#152a31",
      ring: "#1b414b",
      text0: cssVar("--text-0", "#e2e8e6"),
      text1: cssVar("--text-1", "#9eaaab"),
      text2: cssVar("--text-2", "#66757a"),
      text3: cssVar("--text-3", "#3a474d"),
      accent: cssVar("--accent", "#5cd0e6"),
      deny: cssVar("--deny", "#ff4747"),
    };
    const t0 = performance.now();

    let raf = 0;
    const draw = () => {
      raf = requestAnimationFrame(draw);
      const { tracks: trs, nodes: nds, geometry: geo, selectedId: sel } = dataRef.current;
      const t = (performance.now() - t0) / 1000;
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
      ctx.fillStyle = "#060a0b";
      ctx.fillRect(0, 0, w, h);

      const extent = geo?.extent ?? [6, 2.5, 6];
      const pad = 34;
      const scale = Math.min((w - pad * 2) / extent[0], (h - pad * 2) / extent[2]);
      const cx = w / 2;
      const cy = h / 2;
      const X = (mx: number) => cx + mx * scale;
      const Y = (mz: number) => cy + mz * scale;
      const hx = extent[0] / 2;
      const hz = extent[2] / 2;

      // Volume plate and grid, 0.5 m minor / 1 m major.
      ctx.fillStyle = "#08100f";
      ctx.fillRect(X(-hx), Y(-hz), extent[0] * scale, extent[2] * scale);
      ctx.lineWidth = 1;
      for (let m = -hx; m <= hx + 1e-6; m += 0.5) {
        ctx.strokeStyle = Math.abs(m % 1) < 1e-6 ? c.gridMajor : c.grid;
        ctx.beginPath();
        ctx.moveTo(Math.round(X(m)) + 0.5, Y(-hz));
        ctx.lineTo(Math.round(X(m)) + 0.5, Y(hz));
        ctx.stroke();
      }
      for (let m = -hz; m <= hz + 1e-6; m += 0.5) {
        ctx.strokeStyle = Math.abs(m % 1) < 1e-6 ? c.gridMajor : c.grid;
        ctx.beginPath();
        ctx.moveTo(X(-hx), Math.round(Y(m)) + 0.5);
        ctx.lineTo(X(hx), Math.round(Y(m)) + 0.5);
        ctx.stroke();
      }

      // Range rings and bearing ticks from the origin.
      const maxR = Math.ceil(Math.hypot(hx, hz));
      ctx.font = `9px ${mono}`;
      for (let r = 1; r <= maxR; r++) {
        ctx.strokeStyle = c.ring;
        ctx.setLineDash(r === maxR ? [] : [2, 4]);
        ctx.beginPath();
        ctx.arc(cx, cy, r * scale, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = "#2f6370";
        ctx.fillText(`${r}m`, cx + r * scale * Math.SQRT1_2 + 3, cy - r * scale * Math.SQRT1_2 - 3);
      }
      const R = maxR * scale;
      for (let deg = 0; deg < 360; deg += 10) {
        const a = (deg * Math.PI) / 180;
        const len = deg % 30 === 0 ? 8 : 4;
        const sx = Math.sin(a);
        const sy = -Math.cos(a);
        ctx.strokeStyle = deg === 0 ? c.accent : "#24505b";
        ctx.beginPath();
        ctx.moveTo(cx + sx * R, cy + sy * R);
        ctx.lineTo(cx + sx * (R - len), cy + sy * (R - len));
        ctx.stroke();
        if (deg % 30 === 0) {
          const lx = cx + sx * (R + 11);
          const ly = cy + sy * (R + 11);
          if (lx > 8 && lx < w - 8 && ly > 8 && ly < h - 4) {
            ctx.fillStyle = deg === 0 ? c.accent : c.text3;
            ctx.textAlign = "center";
            ctx.fillText(String(deg).padStart(3, "0"), lx, ly + 3);
            ctx.textAlign = "left";
          }
        }
      }

      // Volume bounds with bright corners.
      ctx.strokeStyle = "#1b3138";
      ctx.strokeRect(X(-hx) + 0.5, Y(-hz) + 0.5, extent[0] * scale - 1, extent[2] * scale - 1);
      ctx.strokeStyle = "#2d7f90";
      ctx.lineWidth = 1.5;
      const L = 12;
      for (const [x, y, sx, sy] of [
        [X(-hx), Y(-hz), 1, 1],
        [X(hx), Y(-hz), -1, 1],
        [X(-hx), Y(hz), 1, -1],
        [X(hx), Y(hz), -1, -1],
      ]) {
        ctx.beginPath();
        ctx.moveTo(x + sx * L, y);
        ctx.lineTo(x, y);
        ctx.lineTo(x, y + sy * L);
        ctx.stroke();
      }
      ctx.lineWidth = 1;

      // Origin cross.
      ctx.strokeStyle = c.accent;
      ctx.beginPath();
      ctx.moveTo(cx - 6, cy);
      ctx.lineTo(cx + 6, cy);
      ctx.moveTo(cx, cy - 6);
      ctx.lineTo(cx, cy + 6);
      ctx.stroke();

      // Wall: a hatched band, so it reads as a solid the signal passes through.
      const axis = geo?.wall_axis ?? "x";
      const offset = geo?.wall_offset_m ?? -extent[0] / 4;
      ctx.save();
      const band = 6;
      if (axis === "x") {
        ctx.beginPath();
        ctx.rect(X(offset) - band / 2, Y(-hz), band, extent[2] * scale);
      } else {
        ctx.beginPath();
        ctx.rect(X(-hx), Y(offset) - band / 2, extent[0] * scale, band);
      }
      ctx.clip();
      ctx.fillStyle = "rgba(92,208,230,0.12)";
      ctx.fillRect(0, 0, w, h);
      ctx.strokeStyle = "rgba(92,208,230,0.55)";
      for (let k = -h; k < w + h; k += 5) {
        ctx.beginPath();
        ctx.moveTo(k, 0);
        ctx.lineTo(k + h, h);
        ctx.stroke();
      }
      ctx.restore();
      ctx.fillStyle = c.accent;
      ctx.font = `700 10px ${display}`;
      if (axis === "x") spaced(ctx, "WALL", X(offset) + 7, Y(-hz) + 13, 2);
      else spaced(ctx, "WALL", X(-hx) + 6, Y(offset) - 7, 2);

      // Nodes, with a liveness ripple when reporting.
      for (const n of nds) {
        const x = X(n.position[0]);
        const y = Y(n.position[2]);
        const color = n.stale ? c.deny : c.accent;
        if (!n.stale) {
          for (let i = 0; i < 2; i++) {
            const phase = (t / 2.4 + i * 0.5) % 1;
            ctx.strokeStyle = color;
            ctx.globalAlpha = 0.5 * (1 - phase) ** 2;
            ctx.beginPath();
            ctx.arc(x, y, 4 + phase * 30, 0, Math.PI * 2);
            ctx.stroke();
          }
          ctx.globalAlpha = 1;
        }
        ctx.strokeStyle = color;
        ctx.fillStyle = "#060a0b";
        ctx.beginPath();
        ctx.moveTo(x, y - 6);
        ctx.lineTo(x + 6, y);
        ctx.lineTo(x, y + 6);
        ctx.lineTo(x - 6, y);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = color;
        ctx.fillRect(x - 1.5, y - 1.5, 3, 3);
        ctx.fillStyle = c.text1;
        ctx.font = `10px ${mono}`;
        ctx.fillText(`N${n.node_id}`, x + 9, y + 3);
      }

      // Subjects.
      for (const tr of trs) {
        const x = X(tr.position[0]);
        const y = Y(tr.position[2]);
        const color = cssVar(
          (DECISION_VAR[tr.advisory?.decision ?? "INSUFFICIENT_EVIDENCE"] ?? "var(--unknown)").slice(4, -1).trim(),
          "#7a868c",
        );
        const selected = tr.id === sel;

        // Range line from the origin.
        ctx.strokeStyle = "rgba(158,170,171,0.25)";
        ctx.setLineDash([3, 4]);
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(x, y);
        ctx.stroke();

        // Attribution link to the node carrying this subject's vitals.
        const node = nds.find((n) => n.node_id === tr.node_id);
        if (node) {
          ctx.strokeStyle = "rgba(92,208,230,0.4)";
          ctx.beginPath();
          ctx.moveTo(X(node.position[0]), Y(node.position[2]));
          ctx.lineTo(x, y);
          ctx.stroke();
        }
        ctx.setLineDash([]);

        // 2-second lead vector from measured velocity.
        const [vx, , vz] = tr.velocity;
        if (Math.hypot(vx, vz) > 0.05) {
          ctx.strokeStyle = color;
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.moveTo(x, y);
          ctx.lineTo(x + vx * 2 * scale, y + vz * 2 * scale);
          ctx.stroke();
          ctx.lineWidth = 1;
        }

        const s = selected ? 11 : 9;
        ctx.fillStyle = withAlpha(color, 0.22);
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(x, y - s);
        ctx.lineTo(x + s, y);
        ctx.lineTo(x, y + s);
        ctx.lineTo(x - s, y);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        ctx.lineWidth = 1;
        ctx.fillStyle = color;
        ctx.fillRect(x - 2, y - 2, 4, 4);

        if (selected) {
          ctx.save();
          ctx.translate(x, y);
          ctx.rotate(t * 0.8);
          ctx.strokeStyle = c.text0;
          const b = 17;
          const l = 5;
          for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
            ctx.beginPath();
            ctx.moveTo(sx * b, sy * (b - l));
            ctx.lineTo(sx * b, sy * b);
            ctx.lineTo(sx * (b - l), sy * b);
            ctx.stroke();
          }
          ctx.restore();
        }

        const lx = x + 16;
        ctx.fillStyle = "rgba(6,10,11,0.8)";
        ctx.fillRect(lx - 3, y - 13, 86, 26);
        ctx.fillStyle = withAlpha(color, 0.9);
        ctx.fillRect(lx - 3, y - 13, 2, 26);
        ctx.fillStyle = c.text0;
        ctx.font = `600 11px ${mono}`;
        ctx.fillText(tr.id, lx + 3, y - 1);
        ctx.fillStyle = color;
        ctx.font = `700 10px ${display}`;
        spaced(ctx, tr.state?.state ? STATE_SHORT[tr.state.state] : "UNRESOLVED", lx + 3, y + 10, 1);
      }

      // Scale bar and north reference.
      const barM = extent[0] >= 6 ? 2 : 1;
      const barPx = barM * scale;
      const bx = 12;
      const by = h - 12;
      ctx.strokeStyle = c.text2;
      ctx.beginPath();
      ctx.moveTo(bx, by);
      ctx.lineTo(bx + barPx, by);
      for (let i = 0; i <= barM * 2; i++) {
        const xx = bx + (barPx / (barM * 2)) * i;
        ctx.moveTo(xx, by - (i % 2 === 0 ? 4 : 2));
        ctx.lineTo(xx, by);
      }
      ctx.stroke();
      ctx.fillStyle = c.text2;
      ctx.font = `9px ${mono}`;
      ctx.fillText(`${barM} M`, bx + barPx + 6, by + 3);

      ctx.fillStyle = c.accent;
      ctx.beginPath();
      ctx.moveTo(w - 16, 10);
      ctx.lineTo(w - 12, 20);
      ctx.lineTo(w - 20, 20);
      ctx.closePath();
      ctx.fill();
      ctx.font = `9px ${mono}`;
      ctx.textAlign = "center";
      ctx.fillText("000", w - 16, 31);
      ctx.textAlign = "left";
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

function spaced(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, spacing: number) {
  for (const ch of text) {
    ctx.fillText(ch, x, y);
    x += ctx.measureText(ch).width + spacing;
  }
}

function withAlpha(hex: string, alpha: number): string {
  const m = hex.replace("#", "");
  if (m.length !== 6) return hex;
  return `rgba(${parseInt(m.slice(0, 2), 16)}, ${parseInt(m.slice(2, 4), 16)}, ${parseInt(m.slice(4, 6), 16)}, ${alpha})`;
}
