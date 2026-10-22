"use client";

/**
 * Telemetry client: one WebSocket, an external store, per-channel subscriptions.
 *
 * Why not React state: presence arrives at 10 Hz and the track channel carries a
 * respiration waveform per subject. Putting that in a context value re-renders
 * every panel on every frame, and the 3-D scene with it. Instead the socket
 * writes into a plain store and components subscribe to the *one channel* they
 * read through `useSyncExternalStore`, so a vitals panel does not re-render when
 * a node's RSSI changes.
 *
 * Connection state is deliberately explicit and surfaced: an operator must be
 * able to tell "no subject detected" from "the console stopped receiving". The
 * two look identical on a panel that renders only the data.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from "react";
import { API_BASE, WS_URL } from "./config";
import type {
  Capabilities,
  Envelope,
  Field,
  Nodes,
  Presence,
  SentinelEvent,
  Source,
  TrackState,
  UpstreamVitals,
} from "./types";

export type LinkState = "connecting" | "live" | "reconnecting" | "down";

/** Per-channel history depth. Small: panels chart seconds, not sessions. */
const HISTORY: Record<string, number> = {
  "rf.presence": 600,
  "rf.vitals": 240,
  "rf.nodes": 120,
  "rf.field": 2,
  "track.state": 120,
  events: 200,
  "sensor.health": 40,
};
const DEFAULT_HISTORY = 120;

type Listener = () => void;

class TelemetryStore {
  private latest = new Map<string, Envelope>();
  private history = new Map<string, Envelope[]>();
  private listeners = new Map<string, Set<Listener>>();
  private metaListeners = new Set<Listener>();

  link: LinkState = "connecting";
  capabilities: Capabilities | null = null;
  lastMessageAt = 0;
  messageCount = 0;
  /** Messages per second, smoothed — the console's own health indicator. */
  rate = 0;
  private rateWindow: number[] = [];

  subscribe = (channel: string) => (listener: Listener) => {
    let set = this.listeners.get(channel);
    if (!set) {
      set = new Set();
      this.listeners.set(channel, set);
    }
    set.add(listener);
    return () => set!.delete(listener);
  };

  subscribeMeta = (listener: Listener) => {
    this.metaListeners.add(listener);
    return () => this.metaListeners.delete(listener);
  };

  getLatest = <T,>(channel: string): Envelope<T> | undefined =>
    this.latest.get(channel) as Envelope<T> | undefined;

  getHistory = (channel: string): Envelope[] => this.history.get(channel) ?? EMPTY;

  ingest(msg: Envelope) {
    this.latest.set(msg.ch, msg);
    const cap = HISTORY[msg.ch] ?? DEFAULT_HISTORY;
    const prev = this.history.get(msg.ch) ?? [];
    // New array each time: `useSyncExternalStore` compares by reference, and a
    // mutated array would render stale in concurrent mode.
    const next = prev.length >= cap ? [...prev.slice(prev.length - cap + 1), msg] : [...prev, msg];
    this.history.set(msg.ch, next);

    this.lastMessageAt = Date.now();
    this.messageCount += 1;
    this.rateWindow.push(this.lastMessageAt);
    if (this.rateWindow.length > 40) this.rateWindow.shift();
    if (this.rateWindow.length > 2) {
      const span = (this.rateWindow[this.rateWindow.length - 1] - this.rateWindow[0]) / 1000;
      this.rate = span > 0 ? (this.rateWindow.length - 1) / span : 0;
    }

    this.emit(msg.ch);
  }

  setLink(state: LinkState) {
    if (this.link === state) return;
    this.link = state;
    this.emitMeta();
  }

  setCapabilities(caps: Capabilities | null) {
    this.capabilities = caps;
    this.emitMeta();
  }

  private emit(channel: string) {
    this.listeners.get(channel)?.forEach((l) => l());
  }

  private emitMeta() {
    this.metaListeners.forEach((l) => l());
    // Meta changes alter what panels render, so wake every channel subscriber.
    this.listeners.forEach((set) => set.forEach((l) => l()));
  }
}

const EMPTY: Envelope[] = [];

const StoreContext = createContext<TelemetryStore | null>(null);

export function TelemetryProvider({ children }: { children: React.ReactNode }) {
  const storeRef = useRef<TelemetryStore | null>(null);
  if (!storeRef.current) storeRef.current = new TelemetryStore();
  const store = storeRef.current;

  const loadCapabilities = useCallback(async () => {
    try {
      const r = await fetch(`${API_BASE}/api/capabilities`);
      if (!r.ok) return;
      store.setCapabilities((await r.json()) as Capabilities);
    } catch {
      /* backend not up yet; retried on the next connect */
    }
  }, [store]);

  useEffect(() => {
    let ws: WebSocket | null = null;
    let closed = false;
    let retry = 750;
    let keepAlive: ReturnType<typeof setInterval> | null = null;

    const connect = () => {
      if (closed) return;
      store.setLink(store.messageCount > 0 ? "reconnecting" : "connecting");
      ws = new WebSocket(WS_URL);

      ws.onopen = () => {
        retry = 750;
        store.setLink("live");
        void loadCapabilities();
        // The server reads client frames only as a liveness signal; this keeps
        // intermediaries from closing an idle-looking socket.
        keepAlive = setInterval(() => {
          try {
            ws?.send("ping");
          } catch {
            /* closing */
          }
        }, 15000);
      };

      ws.onmessage = (ev) => {
        try {
          store.ingest(JSON.parse(ev.data) as Envelope);
        } catch {
          /* a malformed frame is dropped, not fatal */
        }
      };

      ws.onclose = () => {
        if (keepAlive) clearInterval(keepAlive);
        keepAlive = null;
        if (closed) return;
        store.setLink("down");
        retry = Math.min(retry * 2, 10000);
        setTimeout(connect, retry);
      };

      ws.onerror = () => ws?.close();
    };

    connect();
    // Capability refresh also covers a backend restart behind a live socket.
    const capTimer = setInterval(() => void loadCapabilities(), 30000);

    return () => {
      closed = true;
      if (keepAlive) clearInterval(keepAlive);
      clearInterval(capTimer);
      ws?.close();
    };
  }, [store, loadCapabilities]);

  return <StoreContext.Provider value={store}>{children}</StoreContext.Provider>;
}

function useStore(): TelemetryStore {
  const store = useContext(StoreContext);
  if (!store) throw new Error("useStore must be used inside <TelemetryProvider>");
  return store;
}

/** Latest envelope on a channel. Re-renders only when that channel changes. */
export function useChannel<T>(channel: string): Envelope<T> | undefined {
  const store = useStore();
  return useSyncExternalStore(
    useMemo(() => store.subscribe(channel), [store, channel]),
    () => store.getLatest<T>(channel),
    () => undefined,
  );
}

/** Rolling history for a channel. */
export function useChannelHistory(channel: string): Envelope[] {
  const store = useStore();
  return useSyncExternalStore(
    useMemo(() => store.subscribe(channel), [store, channel]),
    () => store.getHistory(channel),
    () => EMPTY,
  );
}

export function useLink() {
  const store = useStore();
  return useSyncExternalStore(
    store.subscribeMeta,
    () => store.link,
    () => "connecting" as LinkState,
  );
}

export function useCapabilities(): Capabilities | null {
  const store = useStore();
  return useSyncExternalStore(
    store.subscribeMeta,
    () => store.capabilities,
    () => null,
  );
}

/** Message rate and last-seen, for the console's own health strip. */
export function useLinkStats() {
  const store = useStore();
  const tick = useSyncExternalStore(
    useMemo(() => store.subscribe("rf.presence"), [store]),
    () => store.messageCount,
    () => 0,
  );
  return { messages: tick, rate: store.rate, lastMessageAt: store.lastMessageAt };
}

// ---- typed convenience hooks ------------------------------------------------

export const useTracks = () => useChannel<TrackState>("track.state")?.data;
export const usePresence = () => useChannel<Presence>("rf.presence")?.data;
export const useUpstreamVitals = () => useChannel<UpstreamVitals>("rf.vitals")?.data;
export const useNodes = () => useChannel<Nodes>("rf.nodes")?.data;
export const useField = () => useChannel<Field>("rf.field")?.data;

export function useEvents(): { ts: number; data: SentinelEvent }[] {
  const history = useChannelHistory("events");
  return useMemo(
    () =>
      history
        .map((m) => ({ ts: m.ts, data: m.data as unknown as SentinelEvent }))
        .reverse(),
    [history],
  );
}

/**
 * The effective data source, and whether it counts as a measurement.
 *
 * `live` is false for simulated and stale-hardware feeds; the System screen
 * reports the active source.
 */
export function useSource(): { source: Source; live: boolean; label: string } {
  const tracks = useTracks();
  const presence = usePresence();
  const caps = useCapabilities();
  const source = (tracks?.source ?? presence?.source ?? caps?.source ?? "unknown") as Source;
  if (source === "esp32") return { source, live: true, label: "LIVE · ESP32 CSI" };
  if (source === "wifi") return { source, live: true, label: "LIVE · WIFI SCAN" };
  if (source === "simulate") return { source, live: false, label: "SIMULATED FEED" };
  if (source === "esp32:offline") return { source, live: false, label: "NODES OFFLINE" };
  return { source, live: false, label: "NO SOURCE" };
}
