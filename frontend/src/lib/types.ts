/**
 * Wire types, mirroring the backend payloads exactly.
 *
 * Optional fields are optional here too, and `null` means *unknown* — never
 * zero. Rendering a missing measurement as `0` is the single most dangerous
 * thing this console could do, so the types force the distinction at the call
 * site: a rate is `number | null`, and the formatters render `null` as `--`.
 */

export type Envelope<T = Record<string, unknown>> = {
  ch: string;
  ts: number;
  seq: number;
  data: T;
};

/** Upstream data source. `simulate` and `esp32:offline` are not measurements. */
export type Source = "esp32" | "esp32:offline" | "simulate" | "wifi" | "unknown" | string;

export type BehaviouralState =
  | "ASLEEP"
  | "RESTING"
  | "ALERT_STILL"
  | "ACTIVE"
  | "DISTRESSED";

export type Decision =
  | "APPROACH"
  | "CAUTION"
  | "HOLD"
  | "DO_NOT_APPROACH"
  | "INSUFFICIENT_EVIDENCE";

export type Health = "ok" | "degraded" | "offline";

export type RateEstimate = {
  bpm: number | null;
  confidence: number;
  snr: number;
  resolution_bpm: number;
  /** local_csi | reference | fused | motion_blocked | none */
  method: string;
  agreement_bpm: number | null;
};

export type RespirationFeatures = {
  interval_count: number;
  mean_interval_s: number;
  rrv_cv: number;
  rmssd_s: number;
  longest_pause_s: number;
  irregular: boolean;
  amplitude_cv: number;
};

export type MotionState = {
  index: number;
  instant_index: number;
  burst_rate_per_min: number;
  seconds_since_burst: number;
  quiet_floor: number;
  observed_s: number;
};

export type Vitals = {
  respiration: RateEstimate;
  cardiac: RateEstimate;
  respiration_features: RespirationFeatures;
  motion: MotionState;
  signal_quality: number;
  /** exclusive | nearest_node | aggregate | unattributed */
  attribution: string;
};

export type StateEstimate = {
  state: BehaviouralState | null;
  label: string;
  confidence: number;
  posterior: Record<BehaviouralState, number>;
  dwell_s: number;
  evidence: number;
  features_used: number;
};

export type Advisory = {
  decision: Decision;
  readiness_index: number;
  confidence: number;
  reasons: string[];
  reason_text: string[];
  quiet_window_s: number | null;
  stability: number;
  /** The one policy rule the decision rests on (backend BASIS_TEXT key). */
  basis: string;
  basis_text: string;
  /** Seconds the standing decision has stood. */
  held_s: number;
  /** A more permissive decision waiting out the de-escalation dwell. */
  pending: Decision | null;
  pending_in_s: number | null;
};

export type FeatureVector = {
  respiration_bpm: number | null;
  rrv_cv: number | null;
  motion_index: number | null;
  burst_rate: number | null;
  amplitude_cv: number | null;
  irregular: boolean;
  evidence: number;
};

export type Keypoint = {
  name: string;
  x: number;
  y: number;
  z: number;
  confidence: number;
};

export type Track = {
  id: string;
  upstream_id: number | null;
  /** pose_model | field_peak | aggregate — what the position is derived from */
  provenance: string;
  first_seen: number;
  last_seen: number;
  position: [number, number, number];
  velocity: [number, number, number];
  speed_mps: number;
  confidence: number;
  motion_score: number;
  bbox: { x: number; y: number; width: number; height: number } | null;
  zone: string;
  posture: string | null;
  keypoints: Keypoint[] | null;
  node_id: number | null;
  vitals: Vitals;
  respiration_waveform: number[];
  state?: StateEstimate;
  advisory?: Advisory;
  features?: FeatureVector;
};

export type TrackState = {
  ts_ms: number;
  tracks: Track[];
  closed: { id: string; duration_s: number; last_state: string | null }[];
  subject_count: number;
  source: Source;
};

export type Presence = {
  present: boolean;
  confidence: number;
  motion_level: string;
  estimated_persons: number | null;
  motion_band_power: number;
  breathing_band_power: number;
  dominant_freq_hz: number;
  mean_rssi: number;
  variance: number;
  change_points: number;
  source: Source;
  tick: number;
};

export type UpstreamVitals = {
  breathing_rate_bpm: number | null;
  heart_rate_bpm: number | null;
  breathing_confidence: number;
  heartbeat_confidence: number;
  signal_quality: number;
  quality_verdict: string | null;
  signal_quality_score: number | null;
  source: Source;
  provenance: string;
};

export type NodeInfo = {
  node_id: number;
  rssi_dbm: number;
  position: [number, number, number];
  subcarrier_count: number;
  frame_rate_hz: number;
  last_seen_ms: number | null;
  stale: boolean;
  novelty_score: number | null;
  motion_band_power: number;
  breathing_band_power: number;
  amplitude_mean: number | null;
  amplitude_profile: number[];
};

export type Nodes = {
  nodes: NodeInfo[];
  node_count: number;
  online_count: number;
  source: Source;
  mean_rssi: number | null;
};

/** Sparse voxel cloud: [x, y, z, intensity] in metres / 0..1. */
export type FieldPoint = [number, number, number, number];

export type Field = {
  points: FieldPoint[];
  peak: number;
  dims: [number, number, number];
  /** True when the grid has one vertical cell: a floor-plane map, not a volume. */
  planar?: boolean;
  extent: [number, number, number];
  origin?: [number, number, number];
  occupied: number;
  floor_fraction: number;
  source: Source;
};

export type SentinelEvent = {
  type: string;
  severity: "info" | "warn" | "alert" | "critical";
  track?: string;
  [key: string]: unknown;
};

export type Geometry = {
  extent: [number, number, number];
  origin: [number, number, number];
  wall_axis: string;
  wall_offset_m: number;
};

export type Capabilities = {
  version: string;
  capabilities: string[];
  sensors: Record<string, Health>;
  session_id: number | null;
  source: Source | null;
  geometry: Geometry;
  model: {
    provenance: string;
    states: BehaviouralState[];
    state_labels: Record<BehaviouralState, string>;
    arousal_weights: Record<BehaviouralState, number>;
    decisions: Decision[];
    vitals_attribution: string;
  };
  advisory: Record<string, number | boolean>;
};

export type StoredEvent = {
  ts: number;
  type: string;
  severity: string;
  track_id: string | null;
  payload: Record<string, unknown>;
};
