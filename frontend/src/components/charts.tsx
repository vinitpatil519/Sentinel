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

const GRID = "#111b1f";
const GRID_MAJOR = "#18272d";
const AXIS = "#24363e";

/**
 * Respiration waveform: the chest-motion trace, normalised to ±1, drawn on an
 * oscilloscope graticule — 10 major divisions across, 4 down, with minor ticks
 * on the centre axes — so its period can be read against the grid.
 */
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
      ctx.fillStyle = "#060a0b";
      ctx.fillRect(0, 0, w, h);
      if (grid) {
        ctx.lineWidth = 1;
        ctx.strokeStyle = GRID;
        for (let i = 1; i < 10; i++) {
          const x = Math.round((w / 10) * i) + 0.5;
          ctx.beginPath();
          ctx.moveTo(x, 0);
          ctx.lineTo(x, h);
          ctx.stroke();
        }
        for (let i = 1; i < 4; i++) {
          const y = Math.round((h / 4) * i) + 0.5;
          ctx.beginPath();
          ctx.moveTo(0, y);
          ctx.lineTo(w, y);
          ctx.stroke();
        }
        // Minor ticks on the centre axis, five per division.
        ctx.strokeStyle = GRID_MAJOR;
        for (let i = 1; i < 50; i++) {
          const x = Math.round((w / 50) * i) + 0.5;
          const len = i % 5 === 0 ? 5 : 3;
          ctx.beginPath();
          ctx.moveTo(x, mid - len);
          ctx.lineTo(x, mid + len);
          ctx.stroke();
        }
        ctx.strokeStyle = GRID_MAJOR;
        ctx.strokeRect(0.5, 0.5, w - 1, h - 1);
      }
      ctx.strokeStyle = AXIS;
      ctx.beginPath();
      ctx.moveTo(0, Math.round(mid) + 0.5);
      ctx.lineTo(w, Math.round(mid) + 0.5);
      ctx.stroke();

      if (data.length < 2) {
        ctx.fillStyle = "#3a474d";
        ctx.font = "10px ui-monospace, monospace";
        ctx.fillText("NO RESPIRATION WAVEFORM", 10, mid - 8);
        return;
      }

      const step = w / (data.length - 1);
      const amp = mid - 8;
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
        g.addColorStop(0, withAlpha(stroke, 0.2));
        g.addColorStop(0.5, withAlpha(stroke, 0.04));
        g.addColorStop(1, withAlpha(stroke, 0.2));
        ctx.fillStyle = g;
        ctx.fill(area);
      }

      // Phosphor: a wide faint pass under a sharp one.
      ctx.lineJoin = "round";
      ctx.strokeStyle = withAlpha(stroke, 0.25);
      ctx.lineWidth = 4;
      ctx.stroke(path);
      ctx.strokeStyle = stroke;
      ctx.lineWidth = 1.5;
      ctx.stroke(path);

      // Leading edge: the "now" end of the trace.
      const lastY = mid - Math.max(-1, Math.min(1, data[data.length - 1])) * amp;
      ctx.fillStyle = withAlpha(stroke, 0.25);
      ctx.beginPath();
      ctx.arc(w - 4, lastY, 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#e2e8e6";
      ctx.beginPath();
      ctx.arc(w - 4, lastY, 2.2, 0, Math.PI * 2);
      ctx.fill();

      ctx.font = "9px ui-monospace, monospace";
      ctx.fillStyle = "#3a474d";
      ctx.fillText("+1", 4, 11);
      ctx.fillText("-1", 4, h - 4);
      if (label) {
        ctx.fillStyle = "#66757a";
        ctx.fillText(label, 22, 11);
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
  scale = false,
}: {
  data: number[];
  color?: string;
  height?: number;
  min?: number;
  max?: number;
  threshold?: number;
  fill?: boolean;
  /** Draw a graticule and print the range at the right edge. */
  scale?: boolean;
}) {
  const stroke = resolveColor(color);
  const ref = useCanvas(
    (ctx, w, h) => {
      if (scale) {
        ctx.strokeStyle = GRID;
        ctx.lineWidth = 1;
        for (let i = 1; i < 4; i++) {
          const y = Math.round((h / 4) * i) + 0.5;
          ctx.beginPath();
          ctx.moveTo(0, y);
          ctx.lineTo(w, y);
          ctx.stroke();
        }
        for (let i = 1; i < 12; i++) {
          const x = Math.round((w / 12) * i) + 0.5;
          ctx.beginPath();
          ctx.moveTo(x, h - 3);
          ctx.lineTo(x, h);
          ctx.stroke();
        }
        ctx.strokeStyle = GRID_MAJOR;
        ctx.beginPath();
        ctx.moveTo(0, h - 0.5);
        ctx.lineTo(w, h - 0.5);
        ctx.stroke();
      }
      if (data.length < 2) {
        ctx.fillStyle = "#3a474d";
        ctx.font = "9px ui-monospace, monospace";
        ctx.fillText(scale ? "NO SERIES" : "--", 4, h / 2 + 3);
        return;
      }
      const lo = min ?? Math.min(...data);
      const hi = max ?? Math.max(...data);
      const span = hi - lo || 1;
      const pad = scale ? 6 : 2;
      const right = scale ? w - 34 : w;
      const y = (v: number) => h - pad - ((v - lo) / span) * (h - pad * 2);
      const step = right / (data.length - 1);

      if (threshold !== undefined) {
        ctx.strokeStyle = withAlpha(stroke, 0.5);
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.moveTo(0, Math.round(y(threshold)) + 0.5);
        ctx.lineTo(right, Math.round(y(threshold)) + 0.5);
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
        area.lineTo(right, h);
        area.lineTo(0, h);
        area.closePath();
        const g = ctx.createLinearGradient(0, 0, 0, h);
        g.addColorStop(0, withAlpha(stroke, 0.22));
        g.addColorStop(1, withAlpha(stroke, 0.02));
        ctx.fillStyle = g;
        ctx.fill(area);
      }
      ctx.strokeStyle = stroke;
      ctx.lineWidth = 1.4;
      ctx.lineJoin = "round";
      ctx.stroke(path);

      const lastY = y(data[data.length - 1]);
      ctx.fillStyle = stroke;
      ctx.fillRect(right - 2, lastY - 2, 4, 4);

      if (scale) {
        ctx.font = "9px ui-monospace, monospace";
        ctx.fillStyle = "#66757a";
        ctx.textAlign = "right";
        const valueY = Math.max(10, Math.min(h - 4, lastY + 3));
        // Range labels give way to the live value when they would collide.
        if (Math.abs(valueY - 10) > 10) ctx.fillText(fmt(hi), w - 2, 10);
        if (Math.abs(valueY - (h - 4)) > 10) ctx.fillText(fmt(lo), w - 2, h - 4);
        ctx.fillStyle = stroke;
        ctx.fillText(fmt(data[data.length - 1]), w - 2, valueY);
        ctx.textAlign = "left";
      }
    },
    [data, stroke, min, max, threshold, fill, scale],
  );

  return (
    <div style={{ height, width: "100%" }}>
      <canvas ref={ref} />
    </div>
  );
}

function fmt(v: number): string {
  const a = Math.abs(v);
  if (a !== 0 && (a < 0.01 || a >= 10000)) return v.toExponential(1);
  return a >= 100 ? v.toFixed(0) : a >= 10 ? v.toFixed(1) : v.toFixed(2);
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
      ctx.strokeStyle = GRID;
      for (let i = 1; i < 4; i++) {
        const y = Math.round((h / 4) * i) + 0.5;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(w, y);
        ctx.stroke();
      }
      data.forEach((v, i) => {
        const frac = (v - lo) / span;
        const barH = Math.max(1, frac * (h - 2));
        ctx.fillStyle = withAlpha(fillColor, 0.25 + frac * 0.55);
        ctx.fillRect(i * bw, h - barH, Math.max(1, bw - 1), barH);
        ctx.fillStyle = withAlpha(fillColor, 0.95);
        ctx.fillRect(i * bw, h - barH, Math.max(1, bw - 1), 1.5);
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
        ctx.fillStyle = "#0d1215";
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
          ctx.fillStyle = "#131a1e";
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
  if (typeof window === "undefined") return "#5cd0e6";
  const cached = colorCache.get(color);
  if (cached) return cached;
  const name = color.slice(4, -1).trim();
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const resolved = value || "#5cd0e6";
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
