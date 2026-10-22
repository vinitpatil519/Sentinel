"use client";

/**
 * Application chrome: header, navigation rail, status strip. Everything here is persistent context — what system you are
 * looking at, whether its data is real, and whether the console is still
 * receiving.
 *
 * The access gate sits outside all of it. The telemetry provider mounts only
 * once the gate opens, so a locked console has no socket and holds no data.
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
  type ComponentType,
} from "react";
import {
  TelemetryProvider,
  useCapabilities,
  useLink,
  useLinkStats,
  useNodes,
  useTracks,
} from "@/lib/telemetry";
import { dtg, duration, num, zulu } from "@/lib/format";
import AccessGate, { useAccess } from "./Gate";
import {
  Emblem,
  IconFullscreen,
  IconLock,
  IconLog,
  IconOps,
  IconRF,
  IconSubjects,
  IconSystem,
  IconVitals,
} from "./icons";
import { SignalBars } from "./ui";

export const NAV: {
  href: string;
  key: string;
  code: string;
  label: string;
  Icon: ComponentType<{ size?: number }>;
}[] = [
  { href: "/", key: "1", code: "OPS", label: "Operations", Icon: IconOps },
  { href: "/subjects", key: "2", code: "SUB", label: "Subjects", Icon: IconSubjects },
  { href: "/vitals", key: "3", code: "VIT", label: "Vitals", Icon: IconVitals },
  { href: "/rf", key: "4", code: "RF", label: "RF / Nodes", Icon: IconRF },
  { href: "/history", key: "5", code: "LOG", label: "Session Log", Icon: IconLog },
  { href: "/system", key: "6", code: "SYS", label: "System", Icon: IconSystem },
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
  return (
    <div className="flex flex-col items-end leading-none">
      <span className="mono text-[17px] font-medium tracking-[0.02em] text-[var(--text-0)]">
        {now === null ? "--:--:--Z" : zulu(now)}
      </span>
      <span className="mono mt-1 text-[9.5px] tracking-[0.08em] text-[var(--text-2)]">
        {now === null ? "DTG ------Z --- --" : `DTG ${dtg(now)}`}
      </span>
    </div>
  );
}

// ---- header ----------------------------------------------------------------

const LINK_STYLE: Record<string, { color: string; text: string }> = {
  live: { color: "var(--ok)", text: "LINK UP" },
  connecting: { color: "var(--warn)", text: "CONNECTING" },
  reconnecting: { color: "var(--warn)", text: "RECONNECTING" },
  down: { color: "var(--deny)", text: "LINK DOWN" },
};

function HeaderBlock({ label, children, className = "" }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={`flex h-full flex-col justify-center gap-1 border-l border-[var(--line)] px-4 ${className}`}>
      <span className="label text-[10px] leading-none">{label}</span>
      <div className="flex items-center gap-2 leading-none">{children}</div>
    </div>
  );
}

function Header() {
  const link = useLink();
  const caps = useCapabilities();
  const { rate } = useLinkStats();
  const { lock } = useAccess();
  const pathname = usePathname();
  const state = LINK_STYLE[link];
  const page = NAV.find((n) => n.href === pathname) ?? NAV[0];
  const bars = link === "live" ? (rate > 5 ? 4 : rate > 1 ? 3 : 2) : link === "down" ? 0 : 1;

  return (
    <header
      className="flex flex-none items-stretch border-b border-[var(--line-strong)] bg-[linear-gradient(180deg,var(--bg-2),var(--bg-1))]"
      style={{ height: "var(--header-h)" }}
    >
      <Link
        href="/"
        className="flex flex-none items-center justify-center border-r border-[var(--line-strong)] text-[var(--accent)] no-underline"
        style={{ width: "var(--rail-w)" }}
        title="SENTINEL"
      >
        <Emblem size={30} />
      </Link>

      <div className="flex flex-none flex-col justify-center gap-1 px-4">
        <span
          className="display text-[21px] leading-none font-bold text-[var(--text-0)]"
          style={{ letterSpacing: "0.34em" }}
        >
          Sentinel
        </span>
        <span className="label hidden text-[9.5px] leading-none sm:block">RF through-wall sensing · C2 console</span>
      </div>

      <div className="hidden h-full items-center gap-3 border-l border-[var(--line)] px-4 md:flex">
        <span className="panel-code">{page.key.padStart(2, "0")}</span>
        <span className="display text-[16px] leading-none font-semibold tracking-[0.2em] text-[var(--text-1)]">
          {page.label}
        </span>
      </div>

      <div className="ml-auto flex h-full items-stretch">
        <HeaderBlock label="Session" className="hidden xl:flex">
          <span className="mono text-[12px] text-[var(--text-0)]">
            {caps?.session_id != null ? `S-${String(caps.session_id).padStart(4, "0")}` : "S-----"}
          </span>
        </HeaderBlock>

        <HeaderBlock label="Telemetry">
          <SignalBars level={bars} color={state.color} />
          <span className="label-strong" style={{ color: state.color }}>
            {state.text}
          </span>
          <span className="mono hidden text-[10.5px] text-[var(--text-2)] lg:inline">{num(rate, 1)}/s</span>
        </HeaderBlock>

        <div className="flex h-full items-center border-l border-[var(--line)] px-4">
          <Clock />
        </div>

        <div className="flex h-full items-center gap-1.5 border-l border-[var(--line)] px-3">
          <button
            type="button"
            className="btn h-[30px] w-[30px] p-0"
            title="Fullscreen (F)"
            onClick={() => {
              if (document.fullscreenElement) void document.exitFullscreen();
              else void document.documentElement.requestFullscreen();
            }}
          >
            <IconFullscreen size={15} />
          </button>
          <button type="button" className="btn h-[30px] gap-1.5 px-2.5" title="Lock console (L)" onClick={lock}>
            <IconLock size={15} />
            <span className="hidden lg:inline">Lock</span>
          </button>
        </div>
      </div>
    </header>
  );
}

// ---- navigation rail --------------------------------------------------------

function NavRail() {
  const pathname = usePathname();
  return (
    <nav
      className="flex flex-none flex-col border-r border-[var(--line-strong)] bg-[var(--bg-1)]"
      style={{ width: "var(--rail-w)" }}
    >
      {NAV.map((item) => {
        const active = pathname === item.href;
        return (
          <Link
            key={item.href}
            href={item.href}
            title={`${item.label}  (${item.key})`}
            className="group relative flex h-[66px] flex-col items-center justify-center gap-1.5 border-b border-[var(--line)] no-underline transition-colors"
            style={{
              background: active ? "linear-gradient(90deg, var(--accent-soft), transparent)" : "transparent",
              color: active ? "var(--accent)" : "var(--text-2)",
            }}
          >
            {active && <span className="absolute top-0 bottom-0 left-0 w-[2px] bg-[var(--accent)] shadow-[0_0_10px_var(--accent)]" />}
            <span className="transition-colors group-hover:text-[var(--text-0)]">
              <item.Icon size={20} />
            </span>
            <span
              className="display text-[11px] leading-none font-bold tracking-[0.16em]"
              style={{ color: active ? "var(--text-0)" : undefined }}
            >
              {item.code}
            </span>
            <span className="mono absolute top-1.5 right-2 text-[8.5px] text-[var(--text-3)]">{item.key}</span>
          </Link>
        );
      })}
      <div className="mt-auto flex flex-col items-center gap-1 border-t border-[var(--line)] py-2.5">
        <span className="label text-[9px]">Build</span>
        <span className="mono text-[9.5px] text-[var(--text-2)]">0.3</span>
      </div>
    </nav>
  );
}

// ---- status strip -----------------------------------------------------------

function StatusStrip({ since }: { since: number }) {
  const nodes = useNodes();
  const tracks = useTracks();
  const caps = useCapabilities();
  const { rate } = useLinkStats();
  const now = useClock();
  const sensors = Object.entries(caps?.sensors ?? {});

  return (
    <footer
      className="flex flex-none items-stretch border-t border-[var(--line-strong)] bg-[var(--bg-1)]"
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
          label={name.replaceAll("_", " ")}
          value={health.toUpperCase()}
          color={
            health === "ok" ? "var(--ok)" : health === "degraded" ? "var(--warn)" : "var(--deny)"
          }
        />
      ))}
      <div className="ml-auto hidden min-w-0 items-center px-4 xl:flex" title={caps?.model.provenance}>
        <span className="label truncate text-[10px] text-[var(--text-3)]">
          Research prototype — not for operational use
        </span>
      </div>
      <StatusItem label="Console up" value={now ? duration((now - since) / 1000) : "--"} border="left" />
    </footer>
  );
}

function StatusItem({
  label,
  value,
  color,
  border = "right",
}: {
  label: string;
  value: string;
  color?: string;
  border?: "left" | "right";
}) {
  return (
    <span
      className={`flex flex-none items-center gap-2 px-4 ${border === "right" ? "border-r" : "border-l"} border-[var(--line)]`}
    >
      <span className="label text-[10.5px]">{label}</span>
      <span className="mono text-[11px]" style={{ color: color ?? "var(--text-1)" }}>
        {value}
      </span>
    </span>
  );
}

// ---- overlays ---------------------------------------------------------------

function LinkLostOverlay() {
  const link = useLink();
  if (link !== "down") return null;
  return (
    <div className="pointer-events-none absolute inset-0 z-50 flex items-start justify-center pt-28">
      <div
        className="panel pointer-events-auto w-[420px]"
        style={{ "--corner": "var(--deny)", "--frame": "color-mix(in srgb, var(--deny) 45%, transparent)" } as React.CSSProperties}
      >
        <div className="panel-frame deny-edge" style={{ background: "color-mix(in srgb, var(--deny) 8%, var(--bg-1))" }}>
          <div className="flex flex-col gap-1.5 px-5 py-4">
            <span className="flex items-center gap-2">
              <span className="dot blink" style={{ color: "var(--deny)" }} />
              <span className="label-strong text-[13px]" style={{ color: "var(--deny)" }}>
                Telemetry link down
              </span>
            </span>
            <p className="text-[11.5px] leading-snug text-[var(--text-1)]">
              Readings on screen are the last received and are no longer updating. Reconnecting
              automatically.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---- shell ------------------------------------------------------------------

function Chrome({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const { lock } = useAccess();
  const [selected, setSelected] = useState<string | null>(null);
  const [since] = useState(() => Date.now());
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
      const key = e.key.toLowerCase();
      if (key === "f") {
        if (document.fullscreenElement) void document.exitFullscreen();
        else void document.documentElement.requestFullscreen();
      }
      if (key === "l") lock();
      if (e.key === "Escape") select(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [router, select, lock]);

  return (
    <SelectionContext.Provider value={selection}>
      <div className="console-in relative flex h-screen flex-col overflow-hidden">
        <Header />
        <div className="flex min-h-0 flex-1">
          <NavRail />
          <main className="surface relative min-w-0 flex-1 overflow-hidden p-2.5">{children}</main>
        </div>
        <StatusStrip since={since} />
        <LinkLostOverlay />
      </div>
    </SelectionContext.Provider>
  );
}

export default function Shell({ children }: { children: React.ReactNode }) {
  return (
    <AccessGate>
      <TelemetryProvider>
        <Chrome>{children}</Chrome>
      </TelemetryProvider>
    </AccessGate>
  );
}
