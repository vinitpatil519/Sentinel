"use client";

/**
 * Application chrome: classification banner, header, navigation rail, status
 * strip. Everything here is persistent context — what system you are looking
 * at, whether its data is real, and whether the console is still receiving.
 *
 * The chrome is deliberately thin (a 22px banner, a 46px header, a 26px strip)
 * because the operational content is the 3-D volume and the advisory; framing
 * that takes 20% of the screen is a website, not an instrument.
 */

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import {
  TelemetryProvider,
  useCapabilities,
  useLink,
  useLinkStats,
  useNodes,
  useSource,
  useTracks,
} from "@/lib/telemetry";
import { num, zulu, zuluDate } from "@/lib/format";
import { SyntheticBanner } from "./ui";

export const NAV = [
  { href: "/", key: "1", code: "OPS", label: "Operations" },
  { href: "/subjects", key: "2", code: "SUB", label: "Subjects" },
  { href: "/vitals", key: "3", code: "VIT", label: "Vitals" },
  { href: "/rf", key: "4", code: "RF", label: "RF / Nodes" },
  { href: "/history", key: "5", code: "LOG", label: "Session Log" },
  { href: "/system", key: "6", code: "SYS", label: "System" },
];

// ---- selected subject, shared across pages ---------------------------------

type Selection = { selected: string | null; select: (id: string | null) => void };
const SelectionContext = createContext<Selection>({ selected: null, select: () => {} });
export const useSelection = () => useContext(SelectionContext);

// ---- clock -----------------------------------------------------------------

function useClock() {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return now;
}

function Clock() {
  const now = useClock();
  // Rendered only after mount: the server has a different second than the
  // browser, and a hydration mismatch on a clock is a warning storm.
  if (now === null) return <span className="mono text-[12px] text-[var(--text-2)]">--:--:--Z</span>;
  return (
    <span className="flex items-baseline gap-2">
      <span className="mono text-[12px] text-[var(--text-1)]">{zuluDate(now)}</span>
      <span className="mono text-[14px] text-[var(--text-0)]">{zulu(now)}</span>
    </span>
  );
}

// ---- header ----------------------------------------------------------------

const LINK_STYLE: Record<string, { color: string; text: string }> = {
  live: { color: "var(--ok)", text: "LINK UP" },
  connecting: { color: "var(--warn)", text: "CONNECTING" },
  reconnecting: { color: "var(--warn)", text: "RECONNECTING" },
  down: { color: "var(--deny)", text: "LINK DOWN" },
};

function Header() {
  const link = useLink();
  const caps = useCapabilities();
  const { label, live } = useSource();
  const state = LINK_STYLE[link];

  return (
    <header
      className="flex flex-none items-center gap-5 border-b border-[var(--line)] bg-[var(--bg-1)] px-4"
      style={{ height: "var(--header-h)" }}
    >
      <Link href="/" className="flex items-baseline gap-2.5 no-underline">
        <span
          className="text-[15px] font-semibold tracking-[0.34em] text-[var(--text-0)]"
          style={{ fontFeatureSettings: '"ss01"' }}
        >
          SENTINEL
        </span>
        <span className="label hidden sm:inline">Through-wall human sensing</span>
      </Link>

      <div className="ml-auto flex items-center gap-5">
        <div className="hidden items-center gap-2 lg:flex">
          <span className="label">Source</span>
          <span
            className="mono text-[11px] font-semibold tracking-wider"
            style={{ color: live ? "var(--ok)" : "var(--warn)" }}
          >
            {label}
          </span>
        </div>

        <div className="hidden items-center gap-2 md:flex">
          <span className="label">Session</span>
          <span className="mono text-[11px] text-[var(--text-1)]">
            {caps?.session_id != null ? String(caps.session_id).padStart(4, "0") : "----"}
          </span>
        </div>

        <Clock />

        <span className="flex items-center gap-2" style={{ color: state.color }}>
          <span className={`dot ${link === "live" ? "" : "pulse"}`} />
          <span className="label-strong" style={{ color: state.color }}>
            {state.text}
          </span>
        </span>
      </div>
    </header>
  );
}

// ---- navigation rail --------------------------------------------------------

function NavRail() {
  const pathname = usePathname();
  return (
    <nav
      className="flex flex-none flex-col border-r border-[var(--line)] bg-[var(--bg-1)]"
      style={{ width: "var(--rail-w)" }}
    >
      {NAV.map((item) => {
        const active = pathname === item.href;
        return (
          <Link
            key={item.href}
            href={item.href}
            title={`${item.label}  (${item.key})`}
            className="relative flex h-[58px] flex-col items-center justify-center gap-1 no-underline transition-colors"
            style={{
              background: active ? "var(--bg-3)" : "transparent",
              color: active ? "var(--text-0)" : "var(--text-2)",
            }}
          >
            {active && (
              <span className="absolute top-0 bottom-0 left-0 w-[2px] bg-[var(--accent)]" />
            )}
            <span className="text-[11px] font-semibold tracking-[0.12em]">{item.code}</span>
            <span className="mono text-[9px] text-[var(--text-3)]">{item.key}</span>
          </Link>
        );
      })}
      <div className="mt-auto p-2 text-center">
        <span className="mono text-[9px] text-[var(--text-3)]">v0.2</span>
      </div>
    </nav>
  );
}

// ---- status strip -----------------------------------------------------------

function StatusStrip() {
  const nodes = useNodes();
  const tracks = useTracks();
  const caps = useCapabilities();
  const { rate } = useLinkStats();
  const sensors = Object.entries(caps?.sensors ?? {});

  return (
    <footer
      className="flex flex-none items-center gap-5 border-t border-[var(--line)] bg-[var(--bg-1)] px-4"
      style={{ height: "var(--status-h)" }}
    >
      <StatusItem
        label="Nodes"
        value={nodes ? `${nodes.online_count}/${nodes.node_count}` : "--"}
        color={
          nodes && nodes.node_count > 0 && nodes.online_count === nodes.node_count
            ? "var(--ok)"
            : nodes && nodes.online_count > 0
              ? "var(--warn)"
              : "var(--text-2)"
        }
      />
      <StatusItem label="Subjects" value={tracks ? String(tracks.subject_count) : "--"} />
      <StatusItem label="Mean RSSI" value={nodes?.mean_rssi != null ? `${num(nodes.mean_rssi)} dBm` : "--"} />
      <StatusItem label="Stream" value={`${num(rate, 1)} msg/s`} />
      {sensors.map(([name, health]) => (
        <StatusItem
          key={name}
          label={name}
          value={health.toUpperCase()}
          color={
            health === "ok" ? "var(--ok)" : health === "degraded" ? "var(--warn)" : "var(--deny)"
          }
        />
      ))}
      <div className="ml-auto hidden items-center gap-4 xl:flex">
        <span className="mono text-[9px] text-[var(--text-3)]">
          {caps?.model.provenance ? `MODEL: ${caps.model.provenance.slice(0, 64)}` : ""}
        </span>
      </div>
    </footer>
  );
}

function StatusItem({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <span className="flex items-baseline gap-1.5">
      <span className="label">{label}</span>
      <span className="mono text-[11px]" style={{ color: color ?? "var(--text-1)" }}>
        {value}
      </span>
    </span>
  );
}

// ---- warning strips ---------------------------------------------------------

function ClassificationBanner() {
  return (
    <div
      className="flex flex-none items-center justify-center gap-3 border-b border-[var(--line)] bg-[var(--bg-2)]"
      style={{ height: "var(--banner-h)" }}
    >
      <span className="label-strong" style={{ color: "var(--text-2)" }}>
        Unclassified
      </span>
      <span className="h-2.5 w-px bg-[var(--line-strong)]" />
      <span className="label-strong" style={{ color: "var(--warn)" }}>
        Research prototype — not for operational use
      </span>
      <span className="h-2.5 w-px bg-[var(--line-strong)]" />
      <span className="label" style={{ color: "var(--text-3)" }}>
        Advisory output is decision support, not a clearance to act
      </span>
    </div>
  );
}

function LinkLostOverlay() {
  const link = useLink();
  if (link !== "down") return null;
  return (
    <div className="pointer-events-none absolute inset-0 z-50 flex items-start justify-center pt-24">
      <div
        className="pointer-events-auto border px-6 py-4 text-center"
        style={{
          background: "color-mix(in srgb, var(--deny) 12%, var(--bg-1))",
          borderColor: "var(--deny)",
        }}
      >
        <div className="label-strong mb-1" style={{ color: "var(--deny)" }}>
          Telemetry link down
        </div>
        <p className="max-w-sm text-[11px] text-[var(--text-1)]">
          Readings on screen are the last received and are no longer updating. Reconnecting
          automatically.
        </p>
      </div>
    </div>
  );
}

// ---- shell ------------------------------------------------------------------

function Chrome({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const { live, label } = useSource();
  const [selected, setSelected] = useState<string | null>(null);
  const select = useCallback((id: string | null) => setSelected(id), []);
  const selection = useMemo(() => ({ selected, select }), [selected, select]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      const hit = NAV.find((n) => n.key === e.key);
      if (hit) {
        router.push(hit.href);
        return;
      }
      if (e.key.toLowerCase() === "f") {
        if (document.fullscreenElement) void document.exitFullscreen();
        else void document.documentElement.requestFullscreen();
      }
      if (e.key === "Escape") select(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [router, select]);

  return (
    <SelectionContext.Provider value={selection}>
      <div className="relative flex h-screen flex-col overflow-hidden">
        <ClassificationBanner />
        {!live && <SyntheticBanner label={label} />}
        <Header />
        <div className="flex min-h-0 flex-1">
          <NavRail />
          <main className="relative min-w-0 flex-1 overflow-hidden p-3">{children}</main>
        </div>
        <StatusStrip />
        <LinkLostOverlay />
      </div>
    </SelectionContext.Provider>
  );
}

export default function Shell({ children }: { children: React.ReactNode }) {
  return (
    <TelemetryProvider>
      <Chrome>{children}</Chrome>
    </TelemetryProvider>
  );
}
