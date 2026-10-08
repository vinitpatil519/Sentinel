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
 * * **Subject marker** — a track's position, drawn as a ground ring, a vertical
 *   stem and a label carrying the behavioural state and advisory colour. Its
 *   provenance is printed on the label: FIELD PEAK means the position came from
 *   the strongest field voxel, POSE MODEL means the upstream skeletal model
 *   produced it.
 * * **Skeleton** — drawn *only* when the upstream pose model returns keypoints
 *   with real confidence. The upstream model currently ships as a stub, so in
 *   most deployments this is correctly absent, and the console says so rather
 *   than drawing a plausible mannequin.
 * * **Nodes and wall** — the deployment geometry from configuration.
 *
 * Implementation note: raw three.js, no React renderer. The scene has a fixed
 * set of objects whose attributes are updated in place from a ref each frame;
 * a reconciler would be re-diffing a component tree 10 times a second to move
 * the same points.
 */

import { useEffect, useRef } from "react";
import * as THREE from "three";
import type { Field, Geometry, NodeInfo, Track } from "@/lib/types";
import { DECISION_VAR, STATE_SHORT } from "@/lib/format";

const MAX_POINTS = 4096;
const CSS_VAR_FALLBACK: Record<string, string> = {
  "--accent": "#3d8bd6",
  "--advisory-approach": "#4e9e6a",
  "--advisory-caution": "#c9922e",
  "--advisory-hold": "#c4632f",
  "--advisory-deny": "#b93a36",
  "--advisory-unknown": "#6b7684",
};

function cssColor(varRef: string): THREE.Color {
  const name = varRef.startsWith("var(") ? varRef.slice(4, -1).trim() : varRef;
  let value = CSS_VAR_FALLBACK[name] ?? name;
  if (typeof window !== "undefined" && name.startsWith("--")) {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    if (v) value = v;
  }
  return new THREE.Color(value);
}

type SceneRefs = {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  cloud: THREE.Points;
  cloudPositions: Float32Array;
  cloudColors: Float32Array;
  markers: THREE.Group;
  skeletons: THREE.Group;
  labelCanvas: HTMLCanvasElement;
  dispose: () => void;
};

export default function VolumeScene({
  field,
  tracks,
  nodes = [],
  geometry,
  selectedId,
  onSelect,
}: {
  field?: Field;
  tracks: Track[];
  nodes?: NodeInfo[];
  geometry?: Geometry;
  selectedId?: string | null;
  onSelect?: (id: string) => void;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const refs = useRef<SceneRefs | null>(null);
  const dataRef = useRef({ field, tracks, nodes, geometry, selectedId });
  dataRef.current = { field, tracks, nodes, geometry, selectedId };
  const selectRef = useRef(onSelect);
  selectRef.current = onSelect;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const extent = dataRef.current.geometry?.extent ?? [6, 2.5, 6];
    const scene = new THREE.Scene();
    scene.fog = new THREE.Fog(0x0a0c0f, 8, 26);

    const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 120);
    const orbit = { azimuth: -0.62, polar: 1.02, radius: 11.5, target: new THREE.Vector3(0, 0.9, 0) };
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

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setClearColor(0x0a0c0f, 0);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    host.appendChild(renderer.domElement);
    renderer.domElement.style.display = "block";
    renderer.domElement.style.cursor = "grab";

    // ---- static deployment geometry ---------------------------------------

    const grid = new THREE.GridHelper(
      Math.max(extent[0], extent[2]) + 2,
      Math.round(Math.max(extent[0], extent[2]) + 2),
      0x2a3743,
      0x161d25,
    );
    grid.position.y = 0;
    scene.add(grid);

    // Volume bounds: the extent the field grid maps onto.
    const bounds = new THREE.Box3(
      new THREE.Vector3(-extent[0] / 2, 0, -extent[2] / 2),
      new THREE.Vector3(extent[0] / 2, extent[1], extent[2] / 2),
    );
    const boundsHelper = new THREE.Box3Helper(bounds, new THREE.Color(0x223040));
    scene.add(boundsHelper);

    // The wall the operator senses through, drawn as a translucent plane on the
    // configured axis so the display matches the physical situation.
    const wallAxis = dataRef.current.geometry?.wall_axis ?? "x";
    const wallOffset = dataRef.current.geometry?.wall_offset_m ?? -extent[0] / 4;
    const wallGeom = new THREE.PlaneGeometry(
      wallAxis === "x" ? extent[2] : extent[0],
      extent[1],
    );
    const wall = new THREE.Mesh(
      wallGeom,
      new THREE.MeshBasicMaterial({
        color: 0x3d8bd6,
        transparent: true,
        opacity: 0.045,
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
    );
    const wallEdges = new THREE.LineSegments(
      new THREE.EdgesGeometry(wallGeom),
      new THREE.LineBasicMaterial({ color: 0x2a4f70 }),
    );
    if (wallAxis === "x") {
      wall.rotation.y = Math.PI / 2;
      wallEdges.rotation.y = Math.PI / 2;
      wall.position.set(wallOffset, extent[1] / 2, 0);
      wallEdges.position.copy(wall.position);
    } else {
      wall.position.set(0, extent[1] / 2, wallOffset);
      wallEdges.position.copy(wall.position);
    }
    scene.add(wall, wallEdges);

    // ---- occupancy cloud ---------------------------------------------------

    const cloudPositions = new Float32Array(MAX_POINTS * 3);
    const cloudColors = new Float32Array(MAX_POINTS * 3);
    const cloudGeom = new THREE.BufferGeometry();
    cloudGeom.setAttribute("position", new THREE.BufferAttribute(cloudPositions, 3));
    cloudGeom.setAttribute("color", new THREE.BufferAttribute(cloudColors, 3));
    cloudGeom.setDrawRange(0, 0);
    const cloud = new THREE.Points(
      cloudGeom,
      new THREE.PointsMaterial({
        size: 0.085,
        vertexColors: true,
        transparent: true,
        opacity: 0.92,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        sizeAttenuation: true,
      }),
    );
    scene.add(cloud);

    const markers = new THREE.Group();
    const skeletons = new THREE.Group();
    const nodeGroup = new THREE.Group();
    scene.add(markers, skeletons, nodeGroup);

    const labelCanvas = document.createElement("canvas");

    // ---- interaction -------------------------------------------------------

    let dragging = false;
    let lastX = 0;
    let lastY = 0;
    const onDown = (e: PointerEvent) => {
      dragging = true;
      lastX = e.clientX;
      lastY = e.clientY;
      renderer.domElement.style.cursor = "grabbing";
      renderer.domElement.setPointerCapture(e.pointerId);
    };
    const onMove = (e: PointerEvent) => {
      if (!dragging) return;
      orbit.azimuth -= (e.clientX - lastX) * 0.006;
      orbit.polar = Math.max(0.25, Math.min(1.5, orbit.polar - (e.clientY - lastY) * 0.005));
      lastX = e.clientX;
      lastY = e.clientY;
      applyCamera();
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
      orbit.radius = Math.max(4, Math.min(24, orbit.radius + e.deltaY * 0.01));
      applyCamera();
    };
    const raycaster = new THREE.Raycaster();
    const onClick = (e: MouseEvent) => {
      const rect = renderer.domElement.getBoundingClientRect();
      const ndc = new THREE.Vector2(
        ((e.clientX - rect.left) / rect.width) * 2 - 1,
        -((e.clientY - rect.top) / rect.height) * 2 + 1,
      );
      raycaster.setFromCamera(ndc, camera);
      const hits = raycaster.intersectObjects(markers.children, true);
      const id = hits[0]?.object.userData?.trackId ?? hits[0]?.object.parent?.userData?.trackId;
      if (id) selectRef.current?.(id as string);
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
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(host);

    // ---- frame loop --------------------------------------------------------

    let raf = 0;
    let lastFieldSeq = -1;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const data = dataRef.current;

      // Cloud: rewrite the buffer only when a new field arrives.
      const f = data.field;
      const seq = f ? f.points.length * 1000 + Math.round(f.peak * 1000) : -1;
      if (f && seq !== lastFieldSeq) {
        lastFieldSeq = seq;
        const count = Math.min(f.points.length, MAX_POINTS);
        const cold = new THREE.Color(0x1f4c74);
        const hot = new THREE.Color(0x6fc3ff);
        for (let i = 0; i < count; i++) {
          const [x, y, z, intensity] = f.points[i];
          cloudPositions[i * 3] = x;
          cloudPositions[i * 3 + 1] = y;
          cloudPositions[i * 3 + 2] = z;
          const c = cold.clone().lerp(hot, Math.min(1, intensity));
          const scale = 0.35 + intensity * 0.65;
          cloudColors[i * 3] = c.r * scale;
          cloudColors[i * 3 + 1] = c.g * scale;
          cloudColors[i * 3 + 2] = c.b * scale;
        }
        cloudGeom.setDrawRange(0, count);
        cloudGeom.attributes.position.needsUpdate = true;
        cloudGeom.attributes.color.needsUpdate = true;
        // A floor-plane field is a map, so its cells are drawn larger and flat on
        // the ground; a true volume is drawn as fine points. Same data either
        // way — the difference is not to make it prettier but to stop a 2-D map
        // reading as a 3-D body.
        const mat = cloud.material as THREE.PointsMaterial;
        mat.size = f.planar ? 0.17 : 0.085;
      } else if (!f) {
        cloudGeom.setDrawRange(0, 0);
      }

      syncMarkers(markers, skeletons, data.tracks, data.selectedId ?? null, labelCanvas);
      syncNodes(nodeGroup, data.nodes, data.tracks);

      renderer.render(scene, camera);
    };
    tick();

    const dispose = () => {
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
        if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
        else mat?.dispose?.();
      });
      renderer.dispose();
      host.removeChild(renderer.domElement);
    };

    refs.current = {
      renderer, scene, camera, cloud, cloudPositions, cloudColors,
      markers, skeletons, labelCanvas, dispose,
    };
    return dispose;
    // Geometry changes require a full rebuild (walls, bounds, grid).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [geometry?.extent?.join(","), geometry?.wall_axis, geometry?.wall_offset_m]);

  return <div ref={hostRef} className="absolute inset-0" />;
}

// ---- subject markers --------------------------------------------------------

function syncMarkers(
  group: THREE.Group,
  skeletons: THREE.Group,
  tracks: Track[],
  selectedId: string | null,
  labelCanvas: HTMLCanvasElement,
) {
  const seen = new Set<string>();

  for (const track of tracks) {
    seen.add(track.id);
    let marker = group.children.find((c) => c.userData.trackId === track.id) as THREE.Group | undefined;
    if (!marker) {
      marker = buildMarker(track.id);
      group.add(marker);
    }

    const [x, y, z] = track.position;
    marker.position.set(x, 0, z);

    const decision = track.advisory?.decision ?? "INSUFFICIENT_EVIDENCE";
    const color = cssColor(DECISION_VAR[decision]);
    const selected = selectedId === track.id;

    const ring = marker.getObjectByName("ring") as THREE.Mesh;
    (ring.material as THREE.MeshBasicMaterial).color = color;
    ring.scale.setScalar(selected ? 1.25 : 1);

    const stem = marker.getObjectByName("stem") as THREE.Line;
    (stem.material as THREE.LineBasicMaterial).color = color;
    stem.scale.y = Math.max(0.6, y || 1.0);

    const column = marker.getObjectByName("column") as THREE.Mesh;
    const columnMat = column.material as THREE.MeshBasicMaterial;
    columnMat.color = color;
    // Opacity tracks the readiness index: a dangerous subject is the brightest
    // object in the scene, and a dormant one recedes.
    columnMat.opacity = 0.05 + (track.advisory?.readiness_index ?? 0) * 0.22;

    const label = marker.getObjectByName("label") as THREE.Sprite;
    const stateText = track.state?.state ? STATE_SHORT[track.state.state] : "UNRESOLVED";
    const key = `${track.id}|${stateText}|${decision}|${track.provenance}|${selected}`;
    if (label.userData.key !== key) {
      label.userData.key = key;
      const texture = makeLabelTexture(labelCanvas, track.id, stateText, decision, track.provenance, selected);
      const old = (label.material as THREE.SpriteMaterial).map;
      (label.material as THREE.SpriteMaterial).map = texture;
      (label.material as THREE.SpriteMaterial).needsUpdate = true;
      old?.dispose();
    }
    label.position.set(0, (y || 1.0) + 0.55, 0);

    syncSkeleton(skeletons, track, color);
  }

  for (const child of [...group.children]) {
    if (!seen.has(child.userData.trackId)) group.remove(child);
  }
  for (const child of [...skeletons.children]) {
    if (!seen.has(child.userData.trackId)) skeletons.remove(child);
  }
}

function buildMarker(trackId: string): THREE.Group {
  const g = new THREE.Group();
  g.userData.trackId = trackId;

  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.34, 0.42, 48),
    new THREE.MeshBasicMaterial({ side: THREE.DoubleSide, transparent: true, opacity: 0.9 }),
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.012;
  ring.name = "ring";
  ring.userData.trackId = trackId;
  g.add(ring);

  const stemGeom = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(0, 0, 0),
    new THREE.Vector3(0, 1, 0),
  ]);
  const stem = new THREE.Line(stemGeom, new THREE.LineBasicMaterial({ transparent: true, opacity: 0.7 }));
  stem.name = "stem";
  stem.userData.trackId = trackId;
  g.add(stem);

  // A soft column standing in for the subject's occupied volume. It is an
  // extent indicator, not a body: no limbs are implied where none are measured.
  const column = new THREE.Mesh(
    new THREE.CylinderGeometry(0.32, 0.36, 1.7, 20, 1, true),
    new THREE.MeshBasicMaterial({
      transparent: true,
      opacity: 0.12,
      side: THREE.DoubleSide,
      depthWrite: false,
    }),
  );
  column.position.y = 0.85;
  column.name = "column";
  column.userData.trackId = trackId;
  g.add(column);

  const label = new THREE.Sprite(new THREE.SpriteMaterial({ transparent: true, depthTest: false }));
  label.scale.set(2.2, 0.55, 1);
  label.name = "label";
  label.userData.trackId = trackId;
  g.add(label);

  return g;
}

function makeLabelTexture(
  canvas: HTMLCanvasElement,
  id: string,
  state: string,
  decision: string,
  provenance: string,
  selected: boolean,
): THREE.CanvasTexture {
  const w = 440;
  const h = 110;
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d")!;
  ctx.clearRect(0, 0, w, h);

  const accent = cssColor(DECISION_VAR[decision as keyof typeof DECISION_VAR] ?? "var(--advisory-unknown)");
  const accentCss = `#${accent.getHexString()}`;

  ctx.fillStyle = selected ? "rgba(20,26,33,0.95)" : "rgba(15,19,24,0.86)";
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = accentCss;
  ctx.lineWidth = selected ? 4 : 2;
  ctx.strokeRect(1, 1, w - 2, h - 2);
  ctx.fillStyle = accentCss;
  ctx.fillRect(0, 0, 8, h);

  ctx.fillStyle = "#dde4ec";
  ctx.font = "600 34px ui-monospace, monospace";
  ctx.fillText(id, 22, 42);

  ctx.fillStyle = accentCss;
  ctx.font = "600 26px ui-sans-serif, system-ui";
  ctx.fillText(state, 22, 76);

  ctx.fillStyle = "#5f6d7c";
  ctx.font = "20px ui-sans-serif, system-ui";
  ctx.textAlign = "right";
  ctx.fillText(provenance.replace("_", " ").toUpperCase(), w - 18, 76);
  ctx.textAlign = "left";

  const texture = new THREE.CanvasTexture(canvas);
  texture.minFilter = THREE.LinearFilter;
  return texture;
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
    const line = new THREE.LineSegments(
      geom,
      new THREE.LineBasicMaterial({ color, linewidth: 2 }),
    );
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
function syncNodes(group: THREE.Group, nodes: NodeInfo[], tracks: Track[]) {
  const seen = new Set<number>();

  for (const node of nodes) {
    seen.add(node.node_id);
    let marker = group.children.find(
      (c) => c.userData.kind === "node" && c.userData.nodeId === node.node_id,
    ) as THREE.Mesh | undefined;

    if (!marker) {
      marker = new THREE.Mesh(
        new THREE.OctahedronGeometry(0.13),
        new THREE.MeshBasicMaterial({ wireframe: true }),
      );
      marker.userData = { kind: "node", nodeId: node.node_id };
      group.add(marker);
    }
    marker.position.set(node.position[0], node.position[1], node.position[2]);
    (marker.material as THREE.MeshBasicMaterial).color = node.stale
      ? new THREE.Color(0xb93a36)
      : new THREE.Color(0x4e6a80);
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
          color: 0x2a4f70, dashSize: 0.16, gapSize: 0.12, transparent: true, opacity: 0.55,
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

  for (const child of [...group.children]) {
    if (child.userData.kind === "node" && !seen.has(child.userData.nodeId)) group.remove(child);
    if (child.userData.kind === "link" && !wanted.has(child.userData.key)) group.remove(child);
  }
}
