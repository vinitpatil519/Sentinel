"use client";

/**
 * Canvas instruments.
 *
 * Hand-drawn on 2-D canvas rather than pulled from a charting library: these are
 * five specific readouts that update several times a second, and a general
 * charting library brings a DOM node per datum, a default visual language that
 * fights the console's, and a bundle larger than the entire app. Each component
 * here is ~40 lines and draws exactly what the panel needs.
 *
 * All of them resize with their container and render at device pixel ratio, so
 * a 1px grid line is 1 physical pixel on a HiDPI screen rather than a grey blur.
 */

import { useEffect, useRef } from "react";

function useCanvas(
  draw: (ctx: CanvasRenderingContext2D, w: number, h: number) => void,
  deps: unknown[],
) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  const drawRef = useRef(draw);
  drawRef.current = draw;

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const parent = canvas.parentElement;
    if (!parent) return;

    const render = () => {
      const dpr = window.devicePixelRatio || 1;
      const w = parent.clientWidth;
      const h = parent.clientHeight;
      if (w === 0 || h === 0) return;
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
      drawRef.current(ctx, w, h);
    };

    render();
    const ro = new ResizeObserver(render);
    ro.observe(parent);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return ref;
}

const GRID = "#1c242e";
const AXIS = "#2a3743";

/** Respiration waveform: the chest-motion trace, normalised to ±1. */
export function WaveTrace({
  data,
  color = "var(--accent)",
  height = 96,
  grid = true,
  fill = true,
  label,
}: {
  data: number[];
  color?: string;
  height?: number;
  grid?: boolean;
  fill?: boolean;
  label?: string;
}) {
  const stroke = resolveColor(color);
  const ref = useCanvas(
    (ctx, w, h) => {
      const mid = h / 2;
      if (grid) {
        ctx.strokeStyle = GRID;
        ctx.lineWidth = 1;
        for (let i = 1; i < 4; i++) {
          const y = Math.round((h / 4) * i) + 0.5;
          ctx.beginPath();
          ctx.moveTo(0, y);
          ctx.lineTo(w, y);
          ctx.stroke();
        }
        // Vertical ticks every ~10% of the window.
        for (let i = 1; i < 10; i++) {
          const x = Math.round((w / 10) * i) + 0.5;
          ctx.beginPath();
          ctx.moveTo(x, h - 4);
          ctx.lineTo(x, h);
          ctx.stroke();
        }
      }
      ctx.strokeStyle = AXIS;
      ctx.beginPath();
      ctx.moveTo(0, Math.round(mid) + 0.5);
      ctx.lineTo(w, Math.round(mid) + 0.5);
      ctx.stroke();

      if (data.length < 2) {
        ctx.fillStyle = "#3d4854";
        ctx.font = "10px ui-monospace, monospace";
        ctx.fillText("NO RESPIRATION WAVEFORM", 8, mid - 6);
        return;
      }

      const step = w / (data.length - 1);
      const amp = mid - 6;
      const path = new Path2D();
      data.forEach((v, i) => {
        const x = i * step;
        const y = mid - Math.max(-1, Math.min(1, v)) * amp;
        if (i === 0) path.moveTo(x, y);
        else path.lineTo(x, y);
      });

      if (fill) {
        const area = new Path2D(path);
        area.lineTo(w, mid);
        area.lineTo(0, mid);
        area.closePath();
        const g = ctx.createLinearGradient(0, 0, 0, h);
        g.addColorStop(0, withAlpha(stroke, 0.22));
        g.addColorStop(1, withAlpha(stroke, 0.02));
        ctx.fillStyle = g;
        ctx.fill(area);
      }

      ctx.strokeStyle = stroke;
      ctx.lineWidth = 1.5;
      ctx.lineJoin = "round";
      ctx.stroke(path);

      // Leading-edge marker: the "now" end of the trace.
      const lastY = mid - Math.max(-1, Math.min(1, data[data.length - 1])) * amp;
      ctx.fillStyle = stroke;
      ctx.fillRect(w - 3, lastY - 1.5, 3, 3);

      if (label) {
        ctx.fillStyle = "#5f6d7c";
        ctx.font = "9px ui-sans-serif, system-ui";
        ctx.fillText(label, 6, 12);
      }
    },
    [data, stroke, grid, fill, label],
  );

  return (
    <div style={{ height, width: "100%" }}>
      <canvas ref={ref} />
    </div>
  );
}

/** Compact series line with an optional threshold band. */
export function Sparkline({
  data,
  color = "var(--accent)",
  height = 32,
  min,
  max,
  threshold,
  fill = false,
}: {
  data: number[];
  color?: string;
  height?: number;
  min?: number;
  max?: number;
  threshold?: number;
  fill?: boolean;
}) {
  const stroke = resolveColor(color);
  const ref = useCanvas(
    (ctx, w, h) => {
      if (data.length < 2) {
        ctx.fillStyle = "#3d4854";
        ctx.font = "9px ui-monospace, monospace";
        ctx.fillText("--", 2, h / 2 + 3);
        return;
      }
      const lo = min ?? Math.min(...data);
      const hi = max ?? Math.max(...data);
      const span = hi - lo || 1;
      const y = (v: number) => h - 2 - ((v - lo) / span) * (h - 4);
      const step = w / (data.length - 1);

      if (threshold !== undefined) {
        ctx.strokeStyle = AXIS;
        ctx.setLineDash([2, 3]);
        ctx.beginPath();
        ctx.moveTo(0, y(threshold));
        ctx.lineTo(w, y(threshold));
        ctx.stroke();
        ctx.setLineDash([]);
      }

      const path = new Path2D();
      data.forEach((v, i) => {
        const x = i * step;
        if (i === 0) path.moveTo(x, y(v));
        else path.lineTo(x, y(v));
      });
      if (fill) {
        const area = new Path2D(path);
        area.lineTo(w, h);
        area.lineTo(0, h);
        area.closePath();
        ctx.fillStyle = withAlpha(stroke, 0.16);
        ctx.fill(area);
      }
      ctx.strokeStyle = stroke;
      ctx.lineWidth = 1.25;
      ctx.stroke(path);
    },
    [data, stroke, min, max, threshold, fill],
  );

  return (
    <div style={{ height, width: "100%" }}>
      <canvas ref={ref} />
    </div>
  );
}

/** Per-subcarrier amplitude profile — the raw CSI shape, as bars. */
export function BarProfile({
  data,
  color = "var(--accent)",
  height = 48,
}: {
  data: number[];
  color?: string;
  height?: number;
}) {
  const fillColor = resolveColor(color);
  const ref = useCanvas(
    (ctx, w, h) => {
      if (!data.length) {
        ctx.fillStyle = "#3d4854";
        ctx.font = "9px ui-monospace, monospace";
        ctx.fillText("NO CSI PROFILE", 4, h / 2);
        return;
      }
      const lo = Math.min(...data);
      const hi = Math.max(...data);
      const span = hi - lo || 1;
      const bw = w / data.length;
      data.forEach((v, i) => {
        const frac = (v - lo) / span;
        const barH = Math.max(1, frac * (h - 2));
        ctx.fillStyle = withAlpha(fillColor, 0.35 + frac * 0.6);
        ctx.fillRect(i * bw, h - barH, Math.max(1, bw - 1), barH);
      });
    },
    [data, fillColor],
  );

  return (
    <div style={{ height, width: "100%" }}>
      <canvas ref={ref} />
    </div>
  );
}

/** Behavioural state over time, as a band. One row per subject. */
export function StateBand({
  segments,
  height = 18,
}: {
  /** Ordered oldest → newest; `color` null renders as "unknown". */
  segments: { color: string | null; weight?: number }[];
  height?: number;
}) {
  const resolved = segments.map((s) => ({
    color: s.color ? resolveColor(s.color) : null,
    weight: s.weight ?? 1,
  }));
  const ref = useCanvas(
    (ctx, w, h) => {
      if (!resolved.length) {
        ctx.fillStyle = "#141a21";
        ctx.fillRect(0, 0, w, h);
        return;
      }
      const total = resolved.reduce((a, s) => a + s.weight, 0);
      let x = 0;
      for (const seg of resolved) {
        const sw = (seg.weight / total) * w;
        if (seg.color) {
          ctx.fillStyle = seg.color;
          ctx.fillRect(x, 0, Math.ceil(sw), h);
        } else {
          ctx.fillStyle = "#1a222b";
          ctx.fillRect(x, 0, Math.ceil(sw), h);
        }
        x += sw;
      }
    },
    [resolved],
  );

  return (
    <div style={{ height, width: "100%" }}>
      <canvas ref={ref} />
    </div>
  );
}

// ---- colour helpers ---------------------------------------------------------

const colorCache = new Map<string, string>();

/** Resolve a CSS custom property to a concrete colour for canvas use. */
function resolveColor(color: string): string {
  if (!color.startsWith("var(")) return color;
  if (typeof window === "undefined") return "#3d8bd6";
  const cached = colorCache.get(color);
  if (cached) return cached;
  const name = color.slice(4, -1).trim();
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const resolved = value || "#3d8bd6";
  colorCache.set(color, resolved);
  return resolved;
}

function withAlpha(hex: string, alpha: number): string {
  const m = hex.replace("#", "");
  if (m.length !== 6) return hex;
  const r = parseInt(m.slice(0, 2), 16);
  const g = parseInt(m.slice(2, 4), 16);
  const b = parseInt(m.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
