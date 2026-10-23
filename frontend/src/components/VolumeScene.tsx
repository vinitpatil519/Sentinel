"use client";

/**
 * The sensing volume, rendered in 3-D.
 *
 * What is actually drawn, and where each element comes from — because on a
 * through-wall display the difference between a measurement and an inference is
 * the whole point:
 *
 * * **Occupancy cloud** — one point per voxel of the sensing server's signal
 *   field that cleared the noise floor, positioned in metres and coloured by
 *   intensity. This is measured data. It breathes with the subject because the
 *   field itself is modulated by chest displacement; nothing animates it.
 * * **Subject marker** — a track's position, drawn as a ground reticle, an
 *   extent column and a tag carrying the behavioural state and advisory colour.
 *   Its provenance is printed on the tag: FIELD PEAK means the position came
 *   from the strongest field voxel, POSE MODEL means the upstream skeletal
 *   model produced it. The column is an extent indicator, not a body.
 * * **Skeleton** — drawn *only* when the upstream pose model returns keypoints
 *   with real confidence. The upstream model currently ships as a stub, so in
 *   most deployments this is correctly absent, and the console says so rather
 *   than drawing a plausible mannequin.
 * * **Range rings and bearing spokes** — measured from the world origin, the
 *   same reference the roster's range and bearing are computed from, so a
 *   range can be read off the floor and checked against the number.
 * * **Nodes, wall, bounds** — the deployment geometry from configuration. A
 *   node that is reporting radiates a ripple; a stale node does not. That is
 *   the only ambient animation in the scene, and it encodes node liveness.
 *
 * Implementation note: raw three.js, no React renderer. The scene has a fixed
 * set of objects whose attributes are updated in place from a ref each frame;
 * a reconciler would be re-diffing a component tree 10 times a second to move
 * the same points.
 */

import { useEffect, useRef } from "react";
import * as THREE from "three";
import type { Field, Geometry, NodeInfo, Track } from "@/lib/types";
import { DECISION_TEXT, DECISION_VAR, STATE_SHORT, bearing, range } from "@/lib/format";

export type ViewPreset = "persp" | "top" | "operator";

const MAX_POINTS = 4096;
const CSS_VAR_FALLBACK: Record<string, string> = {
  "--accent": "#5cd0e6",
  "--advisory-approach": "#3ad98b",
  "--advisory-caution": "#f2c94c",
  "--advisory-hold": "#ff8a3d",
  "--advisory-deny": "#ff4747",
  "--advisory-unknown": "#7a868c",
};

const ACCENT = 0x5cd0e6;
const NODE_LIVE = 0x5cd0e6;
const NODE_STALE = 0xff4747;

function cssColor(varRef: string): THREE.Color {
  const name = varRef.startsWith("var(") ? varRef.slice(4, -1).trim() : varRef;
  let value = CSS_VAR_FALLBACK[name] ?? name;
  if (typeof window !== "undefined" && name.startsWith("--")) {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    if (v && !v.startsWith("var(")) value = v;
  }
  return new THREE.Color(value);
}

/** The page's loaded font stacks, for canvas text. */
function fontStack(name: "--font-plex-mono" | "--font-barlow"): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || (name === "--font-plex-mono" ? "ui-monospace, monospace" : "ui-sans-serif, sans-serif");
}

const VIEWS: Record<ViewPreset, { azimuth: number; polar: number; radius: number }> = {
  persp: { azimuth: -0.68, polar: 0.98, radius: 9.4 },
  top: { azimuth: 0, polar: 0.02, radius: 10.5 },
  // From behind the wall, looking through it — the operator's own vantage.
  operator: { azimuth: -Math.PI / 2, polar: 1.28, radius: 8.6 },
};

// ---- point cloud shader -----------------------------------------------------

const CLOUD_VERT = /* glsl */ `
  attribute float intensity;
  uniform float uSize;
  uniform float uScale;
  varying float vI;
  void main() {
    vI = intensity;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = uSize * (0.55 + intensity * 0.85) * uScale / -mv.z;
    gl_Position = projectionMatrix * mv;
  }
`;

const CLOUD_FRAG = /* glsl */ `
  uniform vec3 cLo;
  uniform vec3 cMid;
  uniform vec3 cHi;
  varying float vI;
  void main() {
    vec2 c = gl_PointCoord - 0.5;
    float d = length(c);
    if (d > 0.5) discard;
    float core = smoothstep(0.5, 0.05, d);
    vec3 col = vI < 0.5 ? mix(cLo, cMid, vI * 2.0) : mix(cMid, cHi, (vI - 0.5) * 2.0);
    gl_FragColor = vec4(col * core, core * (0.3 + 0.7 * vI));
  }
`;

type SceneData = {
  field?: Field;
  tracks: Track[];
  nodes: NodeInfo[];
  geometry?: Geometry;
  selectedId?: string | null;
  view: ViewPreset;
  autoRotate: boolean;
};

export default function VolumeScene({
  field,
  tracks,
  nodes = [],
  geometry,
  selectedId,
  onSelect,
  view = "persp",
  autoRotate = false,
  onHeading,
}: {
  field?: Field;
  tracks: Track[];
  nodes?: NodeInfo[];
  geometry?: Geometry;
  selectedId?: string | null;
  onSelect?: (id: string) => void;
  view?: ViewPreset;
  autoRotate?: boolean;
  /**
   * Called with the camera heading in whole degrees whenever it changes —
   * every frame while orbiting, so the receiver should write to the DOM
   * directly rather than set React state.
   */
  onHeading?: (deg: number) => void;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const dataRef = useRef<SceneData>({ field, tracks, nodes, geometry, selectedId, view, autoRotate });
  dataRef.current = { field, tracks, nodes, geometry, selectedId, view, autoRotate };
  const selectRef = useRef(onSelect);
  selectRef.current = onSelect;
  const headingCb = useRef(onHeading);
  headingCb.current = onHeading;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const extent = dataRef.current.geometry?.extent ?? [6, 2.5, 6];
    const scene = new THREE.Scene();
    scene.fog = new THREE.Fog(0x050708, 11, 30);

    const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 120);
    const start = VIEWS[dataRef.current.view];
    const orbit = { ...start, target: new THREE.Vector3(0, 0.55, 0) };
    const goal = { ...start };
    let activeView = dataRef.current.view;
    const applyCamera = () => {
      const { azimuth, polar, radius, target } = orbit;
      camera.position.set(
        target.x + radius * Math.sin(polar) * Math.sin(azimuth),
        target.y + radius * Math.cos(polar),
        target.z + radius * Math.sin(polar) * Math.cos(azimuth),
      );
      camera.lookAt(target);
    };
    applyCamera();

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    } catch {
      host.dataset.webgl = "unavailable";
      return;
    }
    renderer.setClearColor(0x050708, 0);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    host.appendChild(renderer.domElement);
    renderer.domElement.style.display = "block";
    renderer.domElement.style.cursor = "grab";

    const mono = fontStack("--font-plex-mono");
    const display = fontStack("--font-barlow");
    const disposables: { dispose: () => void }[] = [];

    // ---- floor: plate, grid, range rings, bearing spokes --------------------

    const half = [extent[0] / 2, extent[2] / 2];
    const plate = new THREE.Mesh(
      new THREE.PlaneGeometry(extent[0], extent[2]),
      new THREE.MeshBasicMaterial({ color: 0x071114, transparent: true, opacity: 0.7, depthWrite: false }),
    );
    plate.rotation.x = -Math.PI / 2;
    plate.position.y = -0.002;
    scene.add(plate);

    const minor: number[] = [];
    const major: number[] = [];
    for (let v = -half[0]; v <= half[0] + 1e-6; v += 0.5) {
      (Math.abs(v % 1) < 1e-6 ? major : minor).push(v, 0, -half[1], v, 0, half[1]);
    }
    for (let v = -half[1]; v <= half[1] + 1e-6; v += 0.5) {
      (Math.abs(v % 1) < 1e-6 ? major : minor).push(-half[0], 0, v, half[0], 0, v);
    }
    scene.add(lines(minor, 0x0d1d22, 1), lines(major, 0x15303a, 1));

    const maxR = Math.ceil(Math.hypot(half[0], half[1]));
    const ringPts: number[] = [];
    for (let r = 1; r <= maxR; r++) {
      const seg = 128;
      for (let i = 0; i < seg; i++) {
        const a0 = (i / seg) * Math.PI * 2;
        const a1 = ((i + 1) / seg) * Math.PI * 2;
        ringPts.push(Math.sin(a0) * r, 0.003, -Math.cos(a0) * r, Math.sin(a1) * r, 0.003, -Math.cos(a1) * r);
      }
      const lbl = textSprite(`${r} M`, { font: `600 26px ${mono}`, color: "#3c7d8c", height: 0.16 });
      lbl.position.set(Math.sin(Math.PI / 4) * r + 0.12, 0.05, -Math.cos(Math.PI / 4) * r);
      scene.add(lbl);
    }
    scene.add(lines(ringPts, 0x1d4a55, 0.55));

    const spokePts: number[] = [];
    for (let deg = 0; deg < 360; deg += 30) {
      const a = (deg * Math.PI) / 180;
      spokePts.push(Math.sin(a) * 0.35, 0.003, -Math.cos(a) * 0.35, Math.sin(a) * maxR, 0.003, -Math.cos(a) * maxR);
      const lbl = textSprite(String(deg).padStart(3, "0"), {
        font: `600 26px ${mono}`,
        color: deg === 0 ? "#5cd0e6" : "#2f5f6b",
        height: 0.17,
      });
      lbl.position.set(Math.sin(a) * (maxR + 0.35), 0.05, -Math.cos(a) * (maxR + 0.35));
      scene.add(lbl);
    }
    // Fine bearing ticks on the outer ring.
    for (let deg = 0; deg < 360; deg += 5) {
      if (deg % 30 === 0) continue;
      const a = (deg * Math.PI) / 180;
      const r0 = maxR - (deg % 10 === 0 ? 0.14 : 0.08);
      spokePts.push(Math.sin(a) * r0, 0.003, -Math.cos(a) * r0, Math.sin(a) * maxR, 0.003, -Math.cos(a) * maxR);
    }
    scene.add(lines(spokePts, 0x173a44, 0.6));

    // Origin: the reference every range and bearing is measured from.
    const origin = lines([-0.18, 0.004, 0, 0.18, 0.004, 0, 0, 0.004, -0.18, 0, 0.004, 0.18], ACCENT, 0.9);
    scene.add(origin);

    // ---- volume bounds: faint box, bright corner brackets -------------------

    const bounds = new THREE.Box3(
      new THREE.Vector3(-half[0], 0, -half[1]),
      new THREE.Vector3(half[0], extent[1], half[1]),
    );
    scene.add(new THREE.Box3Helper(bounds, new THREE.Color(0x10252c)));
    const corner: number[] = [];
    const L = 0.4;
    for (const x of [-half[0], half[0]])
      for (const y of [0, extent[1]])
        for (const z of [-half[1], half[1]]) {
          const sx = x < 0 ? 1 : -1;
          const sy = y === 0 ? 1 : -1;
          const sz = z < 0 ? 1 : -1;
          corner.push(x, y, z, x + sx * L, y, z, x, y, z, x, y + sy * L, z, x, y, z, x, y, z + sz * L);
        }
    scene.add(lines(corner, 0x2d7f90, 0.9));

    // ---- wall ----------------------------------------------------------------

    const wallAxis = dataRef.current.geometry?.wall_axis ?? "x";
    const wallOffset = dataRef.current.geometry?.wall_offset_m ?? -extent[0] / 4;
    const wallW = wallAxis === "x" ? extent[2] : extent[0];
    const wallGeom = new THREE.PlaneGeometry(wallW, extent[1]);
    const hatch = hatchTexture();
    hatch.repeat.set(wallW * 2.2, extent[1] * 2.2);
    disposables.push(hatch);
    const wall = new THREE.Mesh(
      wallGeom,
      new THREE.MeshBasicMaterial({
        color: 0x5cd0e6,
        map: hatch,
        transparent: true,
        opacity: 0.13,
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
    );
    const wallEdges = new THREE.LineSegments(
      new THREE.EdgesGeometry(wallGeom),
      new THREE.LineBasicMaterial({ color: 0x2f7686, transparent: true, opacity: 0.85 }),
    );
    const wallLabel = textSprite(`WALL · ${wallAxis.toUpperCase()} ${wallOffset.toFixed(1)} M`, {
      font: `700 30px ${display}`,
      color: "#5cd0e6",
      height: 0.2,
      letterSpacing: 4,
    });
    if (wallAxis === "x") {
      wall.rotation.y = Math.PI / 2;
      wallEdges.rotation.y = Math.PI / 2;
      wall.position.set(wallOffset, extent[1] / 2, 0);
      wallLabel.position.set(wallOffset, extent[1] + 0.22, -half[1] + 0.9);
    } else {
      wall.position.set(0, extent[1] / 2, wallOffset);
      wallLabel.position.set(-half[0] + 0.9, extent[1] + 0.22, wallOffset);
    }
    wallEdges.position.copy(wall.position);
    scene.add(wall, wallEdges, wallLabel);

    // ---- occupancy cloud -----------------------------------------------------

    const cloudPositions = new Float32Array(MAX_POINTS * 3);
    const cloudIntensity = new Float32Array(MAX_POINTS);
    const cloudGeom = new THREE.BufferGeometry();
    cloudGeom.setAttribute("position", new THREE.BufferAttribute(cloudPositions, 3));
    cloudGeom.setAttribute("intensity", new THREE.BufferAttribute(cloudIntensity, 1));
    cloudGeom.setDrawRange(0, 0);
    const cloudMat = new THREE.ShaderMaterial({
      vertexShader: CLOUD_VERT,
      fragmentShader: CLOUD_FRAG,
      uniforms: {
        uSize: { value: 0.14 },
        uScale: { value: 400 },
        cLo: { value: new THREE.Color(0x0a3a48) },
        cMid: { value: new THREE.Color(0x1fb3cc) },
        cHi: { value: new THREE.Color(0xe8fbff) },
      },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const cloud = new THREE.Points(cloudGeom, cloudMat);
    cloud.frustumCulled = false;
    scene.add(cloud);

    const markers = new THREE.Group();
    const skeletons = new THREE.Group();
    const nodeGroup = new THREE.Group();
    scene.add(markers, skeletons, nodeGroup);

    const columnAlpha = gradientTexture();
    disposables.push(columnAlpha);
    // Labels are redrawn when fonts finish loading, so the first frame's
    // fallback face does not stick.
    let fontEpoch = 0;
    void document.fonts?.ready.then(() => {
      fontEpoch += 1;
    });

    // ---- interaction -------------------------------------------------------

    let dragging = false;
    let moved = 0;
    let lastX = 0;
    let lastY = 0;
    const onDown = (e: PointerEvent) => {
      dragging = true;
      moved = 0;
      lastX = e.clientX;
      lastY = e.clientY;
      renderer.domElement.style.cursor = "grabbing";
      renderer.domElement.setPointerCapture(e.pointerId);
    };
    const raycaster = new THREE.Raycaster();
    raycaster.params.Line = { threshold: 0.04 };
    const ndc = new THREE.Vector2();
    const pick = (e: { clientX: number; clientY: number }): string | null => {
      const rect = renderer.domElement.getBoundingClientRect();
      ndc.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
      raycaster.setFromCamera(ndc, camera);
      const hits = raycaster.intersectObjects(markers.children, true);
      for (const h of hits) {
        let o: THREE.Object3D | null = h.object;
        while (o && !o.userData?.trackId) o = o.parent;
        if (o) return o.userData.trackId as string;
      }
      return null;
    };
    const onMove = (e: PointerEvent) => {
      if (!dragging) {
        renderer.domElement.style.cursor = pick(e) ? "pointer" : "grab";
        return;
      }
      const dx = e.clientX - lastX;
      const dy = e.clientY - lastY;
      moved += Math.abs(dx) + Math.abs(dy);
      goal.azimuth -= dx * 0.006;
      goal.polar = Math.max(0.02, Math.min(1.5, goal.polar - dy * 0.005));
      lastX = e.clientX;
      lastY = e.clientY;
    };
    const onUp = (e: PointerEvent) => {
      dragging = false;
      renderer.domElement.style.cursor = "grab";
      try {
        renderer.domElement.releasePointerCapture(e.pointerId);
      } catch {
        /* pointer already released */
      }
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      goal.radius = Math.max(3.5, Math.min(22, goal.radius * (1 + e.deltaY * 0.001)));
    };
    const onClick = (e: MouseEvent) => {
      if (moved > 4) return;
      const id = pick(e);
      if (id) selectRef.current?.(id);
    };

    renderer.domElement.addEventListener("pointerdown", onDown);
    renderer.domElement.addEventListener("pointermove", onMove);
    renderer.domElement.addEventListener("pointerup", onUp);
    renderer.domElement.addEventListener("wheel", onWheel, { passive: false });
    renderer.domElement.addEventListener("click", onClick);

    const resize = () => {
      const w = host.clientWidth;
      const h = host.clientHeight;
      if (!w || !h) return;
      renderer.setSize(w, h, false);
      renderer.domElement.style.width = `${w}px`;
      renderer.domElement.style.height = `${h}px`;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      cloudMat.uniforms.uScale.value = (h * renderer.getPixelRatio()) / 2;
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(host);

    // ---- frame loop --------------------------------------------------------

    let raf = 0;
    let lastFieldRef: Field | undefined;
    let lastHeading = -1;
    const dir = new THREE.Vector3();
    const clock = new THREE.Clock();
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const data = dataRef.current;
      const dt = Math.min(0.05, clock.getDelta() || 0.016);
      const t = clock.elapsedTime;

      // Camera: presets and drags set a goal; the camera eases toward it.
      if (data.view !== activeView) {
        activeView = data.view;
        const v = VIEWS[activeView];
        // Take the short way round to the preset heading.
        const turn = Math.round((goal.azimuth - v.azimuth) / (Math.PI * 2));
        goal.azimuth = v.azimuth + turn * Math.PI * 2;
        goal.polar = v.polar;
        goal.radius = v.radius;
      }
      if (data.autoRotate && !dragging) goal.azimuth -= dt * 0.08;
      const k = 1 - Math.pow(0.0015, dt);
      orbit.azimuth += (goal.azimuth - orbit.azimuth) * k;
      orbit.polar += (goal.polar - orbit.polar) * k;
      orbit.radius += (goal.radius - orbit.radius) * k;
      applyCamera();

      if (headingCb.current) {
        // Camera heading in the same bearing convention as the floor spokes.
        camera.getWorldDirection(dir);
        const deg = Math.round(((Math.atan2(dir.x, -dir.z) * 180) / Math.PI + 360) % 360) % 360;
        if (deg !== lastHeading) {
          lastHeading = deg;
          headingCb.current(deg);
        }
      }

      // Cloud: rewrite the buffer only when a new field arrives.
      const f = data.field;
      if (f && f !== lastFieldRef) {
        lastFieldRef = f;
        const count = Math.min(f.points.length, MAX_POINTS);
        for (let i = 0; i < count; i++) {
          const [x, y, z, intensity] = f.points[i];
          cloudPositions[i * 3] = x;
          cloudPositions[i * 3 + 1] = f.planar ? 0.02 : y;
          cloudPositions[i * 3 + 2] = z;
          cloudIntensity[i] = Math.min(1, Math.max(0, intensity));
        }
        cloudGeom.setDrawRange(0, count);
        cloudGeom.attributes.position.needsUpdate = true;
        cloudGeom.attributes.intensity.needsUpdate = true;
        // A floor-plane field is a map, so its cells are drawn larger and flat
        // on the ground; a true volume is drawn as finer points. Same data
        // either way — the difference is to stop a 2-D map reading as a body.
        cloudMat.uniforms.uSize.value = f.planar ? 0.3 : 0.15;
      } else if (!f && lastFieldRef) {
        lastFieldRef = undefined;
        cloudGeom.setDrawRange(0, 0);
      }

      syncMarkers(markers, skeletons, data.tracks, data.selectedId ?? null, columnAlpha, t, { mono, display, epoch: fontEpoch });
      syncNodes(nodeGroup, data.nodes, data.tracks, t, mono);

      renderer.render(scene, camera);
    };
    tick();

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      renderer.domElement.removeEventListener("pointerdown", onDown);
      renderer.domElement.removeEventListener("pointermove", onMove);
      renderer.domElement.removeEventListener("pointerup", onUp);
      renderer.domElement.removeEventListener("wheel", onWheel);
      renderer.domElement.removeEventListener("click", onClick);
      scene.traverse((obj) => {
        const mesh = obj as THREE.Mesh;
        mesh.geometry?.dispose?.();
        const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
        const mats = Array.isArray(mat) ? mat : mat ? [mat] : [];
        for (const m of mats) {
          (m as THREE.SpriteMaterial).map?.dispose();
          m.dispose();
        }
      });
      disposables.forEach((d) => d.dispose());
      renderer.dispose();
      host.removeChild(renderer.domElement);
    };
    // Geometry changes require a full rebuild (walls, bounds, grid).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [geometry?.extent?.join(","), geometry?.wall_axis, geometry?.wall_offset_m]);

  return <div ref={hostRef} className="absolute inset-0" />;
}

// ---- static helpers -------------------------------------------------------------

function lines(points: number[], color: number, opacity: number): THREE.LineSegments {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(points, 3));
  return new THREE.LineSegments(
    g,
    new THREE.LineBasicMaterial({ color, transparent: opacity < 1, opacity, depthWrite: false }),
  );
}

function textSprite(
  text: string,
  { font, color, height, letterSpacing = 0 }: { font: string; color: string; height: number; letterSpacing?: number },
): THREE.Sprite {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d")!;
  ctx.font = font;
  const chars = [...text];
  const w = Math.ceil(ctx.measureText(text).width + letterSpacing * chars.length) + 8;
  const h = 40;
  canvas.width = w;
  canvas.height = h;
  ctx.font = font;
  ctx.fillStyle = color;
  ctx.textBaseline = "middle";
  let x = 4;
  for (const ch of chars) {
    ctx.fillText(ch, x, h / 2);
    x += ctx.measureText(ch).width + letterSpacing;
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.minFilter = THREE.LinearFilter;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
  sprite.scale.set((height * w) / h, height, 1);
  return sprite;
}

/** Diagonal hatch, tiled across the wall so it reads as a solid, not a pane. */
function hatchTexture(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 32;
  c.height = 32;
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = "rgba(255,255,255,0.18)";
  ctx.fillRect(0, 0, 32, 32);
  ctx.strokeStyle = "rgba(255,255,255,0.9)";
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(-8, 40);
  ctx.lineTo(40, -8);
  ctx.moveTo(-24, 24);
  ctx.lineTo(24, -24);
  ctx.moveTo(8, 56);
  ctx.lineTo(56, 8);
  ctx.stroke();
  const t = new THREE.CanvasTexture(c);
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.RepeatWrapping;
  return t;
}

/** Vertical alpha ramp for the extent column: solid at the floor, gone at the top. */
function gradientTexture(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 2;
  c.height = 64;
  const ctx = c.getContext("2d")!;
  const g = ctx.createLinearGradient(0, 0, 0, 64);
  g.addColorStop(0, "#000");
  g.addColorStop(0.75, "#666");
  g.addColorStop(1, "#fff");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 2, 64);
  return new THREE.CanvasTexture(c);
}

// ---- subject markers --------------------------------------------------------

type Fonts = { mono: string; display: string; epoch: number };

function syncMarkers(
  group: THREE.Group,
  skeletons: THREE.Group,
  tracks: Track[],
  selectedId: string | null,
  columnAlpha: THREE.Texture,
  t: number,
  fonts: Fonts,
) {
  const seen = new Set<string>();

  for (const track of tracks) {
    seen.add(track.id);
    let marker = group.children.find((c) => c.userData.trackId === track.id) as THREE.Group | undefined;
    if (!marker) {
      marker = buildMarker(track.id, columnAlpha);
      group.add(marker);
    }

    const [x, y, z] = track.position;
    marker.position.set(x, 0, z);
    const height = Math.max(0.9, y || 1.0) + 0.6;

    const decision = track.advisory?.decision ?? "INSUFFICIENT_EVIDENCE";
    const color = cssColor(DECISION_VAR[decision]);
    const selected = selectedId === track.id;
    const readiness = track.advisory?.readiness_index ?? 0;

    const setColor = (name: string, opacity?: number) => {
      const o = marker!.getObjectByName(name) as THREE.Mesh | THREE.Line;
      const m = o.material as THREE.MeshBasicMaterial;
      m.color.copy(color);
      if (opacity !== undefined) m.opacity = opacity;
      return o;
    };

    setColor("disc", 0.1 + readiness * 0.14);
    setColor("ring", 0.95);
    const brackets = setColor("brackets", selected ? 0.95 : 0.35);
    brackets.rotation.z = selected ? t * 0.9 : 0;
    brackets.scale.setScalar(selected ? 1 : 0.86);

    // Column opacity tracks the readiness index: a dangerous subject is the
    // brightest object in the scene, and a dormant one recedes.
    const column = setColor("column", 0.1 + readiness * 0.32);
    column.scale.y = height / 1.7;
    column.position.y = height / 2;
    const cap = setColor("cap", 0.5 + readiness * 0.4);
    cap.position.y = height;
    const stem = setColor("stem", 0.6);
    stem.scale.y = height + 0.62;

    const label = marker.getObjectByName("label") as THREE.Sprite;
    const stateText = track.state?.state ? STATE_SHORT[track.state.state] : "UNRESOLVED";
    const key = `${track.id}|${stateText}|${decision}|${track.provenance}|${selected}|${range(track.position)}|${bearing(track.position)}|${fonts.epoch}`;
    if (label.userData.key !== key) {
      label.userData.key = key;
      const texture = makeLabelTexture(track, stateText, decision, selected, fonts);
      const mat = label.material as THREE.SpriteMaterial;
      const old = mat.map;
      mat.map = texture;
      mat.needsUpdate = true;
      old?.dispose();
    }
    label.position.set(0, height + 0.62, 0);

    syncSkeleton(skeletons, track, color);
  }

  for (const child of [...group.children]) {
    if (!seen.has(child.userData.trackId)) {
      disposeTree(child);
      group.remove(child);
    }
  }
  for (const child of [...skeletons.children]) {
    if (!seen.has(child.userData.trackId)) {
      disposeTree(child);
      skeletons.remove(child);
    }
  }
}

function disposeTree(obj: THREE.Object3D) {
  obj.traverse((o) => {
    const mesh = o as THREE.Mesh;
    mesh.geometry?.dispose?.();
    const mat = mesh.material as THREE.Material | undefined;
    if (mat && !Array.isArray(mat)) {
      (mat as THREE.SpriteMaterial).map?.dispose?.();
      mat.dispose();
    }
  });
}

function buildMarker(trackId: string, columnAlpha: THREE.Texture): THREE.Group {
  const g = new THREE.Group();
  g.userData.trackId = trackId;
  const basic = (opacity: number) =>
    new THREE.MeshBasicMaterial({ side: THREE.DoubleSide, transparent: true, opacity, depthWrite: false });

  const disc = new THREE.Mesh(new THREE.CircleGeometry(0.4, 48), basic(0.15));
  disc.rotation.x = -Math.PI / 2;
  disc.position.y = 0.006;
  disc.name = "disc";
  g.add(disc);

  const ring = new THREE.Mesh(new THREE.RingGeometry(0.38, 0.42, 64), basic(0.95));
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.01;
  ring.name = "ring";
  g.add(ring);

  // Four bracket arcs: the target-lock reticle, turning when selected.
  const bracketGeoms: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 4; i++) {
    bracketGeoms.push(new THREE.RingGeometry(0.56, 0.6, 16, 1, i * (Math.PI / 2) + 0.35, Math.PI / 2 - 0.7));
  }
  const brackets = new THREE.Mesh(mergeGeometries(bracketGeoms), basic(0.4));
  brackets.rotation.x = -Math.PI / 2;
  brackets.position.y = 0.012;
  brackets.name = "brackets";
  g.add(brackets);

  const column = new THREE.Mesh(
    new THREE.CylinderGeometry(0.3, 0.34, 1.7, 32, 1, true),
    new THREE.MeshBasicMaterial({
      transparent: true,
      opacity: 0.2,
      side: THREE.DoubleSide,
      depthWrite: false,
      alphaMap: columnAlpha,
      blending: THREE.AdditiveBlending,
    }),
  );
  column.name = "column";
  g.add(column);

  const cap = new THREE.Mesh(new THREE.RingGeometry(0.28, 0.31, 48), basic(0.6));
  cap.rotation.x = -Math.PI / 2;
  cap.name = "cap";
  g.add(cap);

  const stem = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 1, 0)]),
    new THREE.LineBasicMaterial({ transparent: true, opacity: 0.6 }),
  );
  stem.name = "stem";
  g.add(stem);

  const label = new THREE.Sprite(new THREE.SpriteMaterial({ transparent: true, depthTest: false }));
  label.scale.set(2.4, 0.7, 1);
  label.center.set(0.5, 0);
  label.renderOrder = 10;
  label.name = "label";
  g.add(label);

  return g;
}

function mergeGeometries(geoms: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const positions: number[] = [];
  for (const geom of geoms) {
    const g = geom.index ? geom.toNonIndexed() : geom;
    positions.push(...(g.getAttribute("position").array as Float32Array));
    g.dispose();
    geom.dispose();
  }
  const merged = new THREE.BufferGeometry();
  merged.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  return merged;
}

/**
 * Each tag gets its own canvas: a CanvasTexture keeps a reference to its
 * canvas and re-reads it on upload, so a shared canvas would let the last tag
 * drawn overwrite every other subject's tag.
 */
function makeLabelTexture(
  track: Track,
  state: string,
  decision: keyof typeof DECISION_VAR,
  selected: boolean,
  fonts: Fonts,
): THREE.CanvasTexture {
  const w = 512;
  const h = 150;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d")!;
  ctx.clearRect(0, 0, w, h);

  const accent = `#${cssColor(DECISION_VAR[decision] ?? "var(--advisory-unknown)").getHexString()}`;
  const cut = 18;

  // Chamfered plate.
  ctx.beginPath();
  ctx.moveTo(cut, 2);
  ctx.lineTo(w - 2, 2);
  ctx.lineTo(w - 2, h - cut);
  ctx.lineTo(w - cut, h - 2);
  ctx.lineTo(2, h - 2);
  ctx.lineTo(2, cut);
  ctx.closePath();
  ctx.fillStyle = selected ? "rgba(13,20,24,0.94)" : "rgba(7,11,13,0.84)";
  ctx.fill();
  ctx.strokeStyle = selected ? accent : "rgba(92,208,230,0.28)";
  ctx.lineWidth = selected ? 3 : 2;
  ctx.stroke();

  ctx.fillStyle = accent;
  ctx.fillRect(2, cut + 4, 8, h - cut - 8);

  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = "#e2e8e6";
  ctx.font = `600 40px ${fonts.mono}`;
  ctx.fillText(track.id, 26, 50);

  ctx.textAlign = "right";
  ctx.fillStyle = "#66757a";
  ctx.font = `500 22px ${fonts.mono}`;
  ctx.fillText(`${range(track.position)} M  ${bearing(track.position)}`, w - 20, 46);
  ctx.textAlign = "left";

  ctx.fillStyle = accent;
  ctx.font = `700 34px ${fonts.display}`;
  drawSpaced(ctx, track.advisory ? DECISION_TEXT[decision] : "--", 26, 92, 3);

  ctx.fillStyle = "#9eaaab";
  ctx.font = `600 24px ${fonts.display}`;
  drawSpaced(ctx, state, 26, 130, 3);
  ctx.textAlign = "right";
  ctx.fillStyle = "#3a474d";
  ctx.font = `600 20px ${fonts.display}`;
  ctx.fillText(track.provenance.replace("_", " ").toUpperCase(), w - 20, 130);
  ctx.textAlign = "left";

  const texture = new THREE.CanvasTexture(canvas);
  texture.minFilter = THREE.LinearFilter;
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function drawSpaced(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, spacing: number) {
  for (const ch of text) {
    ctx.fillText(ch, x, y);
    x += ctx.measureText(ch).width + spacing;
  }
}

/**
 * Skeleton, drawn only from real keypoints.
 *
 * The upstream CSI pose model publishes a zero-confidence stub in its current
 * release, and the adapter drops those. So this normally renders nothing — and
 * that is the correct output, not a gap to be filled with a synthetic pose.
 */
const COCO_BONES: [number, number][] = [
  [5, 7], [7, 9], [6, 8], [8, 10], [5, 6], [5, 11], [6, 12],
  [11, 12], [11, 13], [13, 15], [12, 14], [14, 16], [0, 5], [0, 6],
];

function syncSkeleton(group: THREE.Group, track: Track, color: THREE.Color) {
  const existing = group.children.find((c) => c.userData.trackId === track.id) as
    | THREE.LineSegments
    | undefined;
  const kps = (track.keypoints ?? []).filter((k) => k.confidence > 0.05);

  if (kps.length < 6) {
    if (existing) group.remove(existing);
    return;
  }

  const points: THREE.Vector3[] = [];
  for (const [a, b] of COCO_BONES) {
    const ka = track.keypoints?.[a];
    const kb = track.keypoints?.[b];
    if (!ka || !kb || ka.confidence < 0.05 || kb.confidence < 0.05) continue;
    points.push(new THREE.Vector3(ka.x, ka.y, ka.z), new THREE.Vector3(kb.x, kb.y, kb.z));
  }
  if (!points.length) {
    if (existing) group.remove(existing);
    return;
  }

  const geom = new THREE.BufferGeometry().setFromPoints(points);
  if (existing) {
    existing.geometry.dispose();
    existing.geometry = geom;
    (existing.material as THREE.LineBasicMaterial).color = color;
  } else {
    const line = new THREE.LineSegments(geom, new THREE.LineBasicMaterial({ color, linewidth: 2 }));
    line.userData.trackId = track.id;
    group.add(line);
  }
}

// ---- node markers -----------------------------------------------------------

/**
 * Sensing nodes, plus a line to the subject whose vitals each one is carrying.
 *
 * That line is the attribution made visible: with several subjects in the
 * volume, a respiration rate belongs to a subject *because* a particular node
 * is closest to them, and an operator should be able to see which node is
 * making the claim rather than take the number on faith.
 */
function syncNodes(group: THREE.Group, nodes: NodeInfo[], tracks: Track[], t: number, mono: string) {
  const seen = new Set<number>();

  for (const node of nodes) {
    seen.add(node.node_id);
    let marker = group.children.find(
      (c) => c.userData.kind === "node" && c.userData.nodeId === node.node_id,
    ) as THREE.Group | undefined;

    if (!marker) {
      marker = new THREE.Group();
      marker.userData = { kind: "node", nodeId: node.node_id };
      const body = new THREE.Mesh(
        new THREE.OctahedronGeometry(0.12),
        new THREE.MeshBasicMaterial({ wireframe: true, transparent: true, opacity: 0.95 }),
      );
      body.name = "body";
      const core = new THREE.Mesh(
        new THREE.OctahedronGeometry(0.05),
        new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.9 }),
      );
      core.name = "core";
      const drop = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, -1, 0)]),
        new THREE.LineDashedMaterial({ dashSize: 0.06, gapSize: 0.05, transparent: true, opacity: 0.5 }),
      );
      drop.computeLineDistances();
      drop.name = "drop";
      marker.add(body, core, drop);
      for (let i = 0; i < 2; i++) {
        const ripple = new THREE.Mesh(
          new THREE.RingGeometry(0.96, 1, 64),
          new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false }),
        );
        ripple.rotation.x = -Math.PI / 2;
        ripple.name = `ripple${i}`;
        marker.add(ripple);
      }
      const label = textSprite(`N${node.node_id}`, { font: `600 28px ${mono}`, color: "#9eaaab", height: 0.17 });
      label.name = "label";
      label.position.set(0.24, 0.12, 0);
      marker.add(label);
      group.add(marker);
    }

    const [nx, ny, nz] = node.position;
    marker.position.set(nx, ny, nz);
    const color = new THREE.Color(node.stale ? NODE_STALE : NODE_LIVE);
    for (const name of ["body", "core", "drop"]) {
      const o = marker.getObjectByName(name) as THREE.Mesh;
      (o.material as THREE.MeshBasicMaterial).color.copy(color);
    }
    const body = marker.getObjectByName("body")!;
    body.rotation.y = node.stale ? 0 : t * 0.6;
    const drop = marker.getObjectByName("drop") as THREE.Line;
    drop.scale.y = Math.max(0.001, ny);

    // Ripple on the floor beneath a reporting node: liveness, not data.
    for (let i = 0; i < 2; i++) {
      const ripple = marker.getObjectByName(`ripple${i}`) as THREE.Mesh;
      const mat = ripple.material as THREE.MeshBasicMaterial;
      ripple.position.y = -ny + 0.008;
      if (node.stale) {
        mat.opacity = 0;
        continue;
      }
      const phase = (t / 2.4 + i * 0.5) % 1;
      ripple.scale.setScalar(0.12 + phase * 1.3);
      mat.opacity = 0.45 * (1 - phase) * (1 - phase);
      mat.color.copy(color);
    }
  }

  const wanted = new Set<string>();
  for (const track of tracks) {
    if (track.node_id === null) continue;
    const node = nodes.find((n) => n.node_id === track.node_id);
    if (!node) continue;
    const key = `${track.id}:${node.node_id}`;
    wanted.add(key);
    const points = [
      new THREE.Vector3(node.position[0], node.position[1], node.position[2]),
      new THREE.Vector3(track.position[0], Math.max(0.6, track.position[1]), track.position[2]),
    ];
    let link = group.children.find(
      (c) => c.userData.kind === "link" && c.userData.key === key,
    ) as THREE.Line | undefined;
    if (!link) {
      link = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(points),
        new THREE.LineDashedMaterial({
          color: 0x5cd0e6, dashSize: 0.12, gapSize: 0.1, transparent: true, opacity: 0.35,
        }),
      );
      link.computeLineDistances();
      link.userData = { kind: "link", key };
      group.add(link);
    } else {
      link.geometry.setFromPoints(points);
      link.computeLineDistances();
    }
  }

  // Range line on the floor, from the reference origin to each subject.
  for (const track of tracks) {
    const key = `range:${track.id}`;
    wanted.add(key);
    const points = [new THREE.Vector3(0, 0.006, 0), new THREE.Vector3(track.position[0], 0.006, track.position[2])];
    let line = group.children.find((c) => c.userData.kind === "link" && c.userData.key === key) as
      | THREE.Line
      | undefined;
    if (!line) {
      line = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(points),
        new THREE.LineDashedMaterial({ color: 0x9eaaab, dashSize: 0.08, gapSize: 0.08, transparent: true, opacity: 0.3 }),
      );
      line.userData = { kind: "link", key };
      group.add(line);
    } else {
      line.geometry.setFromPoints(points);
    }
    line.computeLineDistances();
  }

  for (const child of [...group.children]) {
    const stale =
      (child.userData.kind === "node" && !seen.has(child.userData.nodeId)) ||
      (child.userData.kind === "link" && !wanted.has(child.userData.key));
    if (stale) {
      disposeTree(child);
      group.remove(child);
    }
  }
}
