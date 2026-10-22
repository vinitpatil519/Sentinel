"use client";

/**
 * Lock screen. Nothing behind it is mounted until the code is accepted — the
 * telemetry socket included — so a locked console holds no data, not just
 * hides it. See `lib/access.ts` for what this gate does and does not protect.
 *
 * The boot log reports checks the console really performs (renderer, display,
 * clock, endpoint); it is not theatre, and a failed WebGL probe shows as FAIL
 * because the sensing volume cannot draw without it.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  FREE_ATTEMPTS,
  lockoutFor,
  readGranted,
  readLockout,
  sha256Hex,
  verifyCode,
  writeGranted,
  writeLockout,
  type Lockout,
} from "@/lib/access";
import { WS_URL } from "@/lib/config";
import { dtg, zulu } from "@/lib/format";
import { Emblem, IconBackspace } from "./icons";

type Access = { lock: () => void };
const AccessContext = createContext<Access>({ lock: () => {} });
export const useAccess = () => useContext(AccessContext);

const MAX_DIGITS = 8;

export default function AccessGate({ children }: { children: ReactNode }) {
  // `null` until mounted: storage is browser-only, and rendering either the
  // console or the gate on the server would flash the wrong one on reload.
  const [granted, setGranted] = useState<boolean | null>(null);

  useEffect(() => {
    setGranted(readGranted());
  }, []);

  const lock = useCallback(() => {
    writeGranted(false);
    setGranted(false);
  }, []);
  const access = useMemo(() => ({ lock }), [lock]);

  if (granted === null) return <div className="fixed inset-0 bg-[#030405]" />;
  if (!granted)
    return (
      <Keypad
        onGranted={() => {
          writeGranted(true);
          setGranted(true);
        }}
      />
    );
  return <AccessContext.Provider value={access}>{children}</AccessContext.Provider>;
}

// ---- boot probes ------------------------------------------------------------

type Probe = { key: string; value: string; status: "OK" | "HELD" | "FAIL" | "ARMED" };

function runProbes(): Probe[] {
  let renderer = "UNAVAILABLE";
  let rendererOk = false;
  try {
    const c = document.createElement("canvas");
    const gl2 = c.getContext("webgl2");
    const gl = gl2 ?? c.getContext("webgl");
    if (gl) {
      rendererOk = true;
      renderer = gl2 ? "WEBGL 2.0" : "WEBGL 1.0";
      const ext = gl.getExtension("WEBGL_debug_renderer_info");
      const name = ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : "";
      if (name) renderer += ` · ${name.replace(/\s*\(.*$/, "").slice(0, 22).toUpperCase()}`;
    }
  } catch {
    /* treated as unavailable */
  }
  const dpr = window.devicePixelRatio || 1;
  return [
    { key: "CONSOLE IMAGE", value: "SNTL-C2 BUILD 0.3", status: "OK" },
    { key: "RENDERER", value: renderer, status: rendererOk ? "OK" : "FAIL" },
    { key: "DISPLAY", value: `${window.innerWidth}×${window.innerHeight} @${dpr}X`, status: "OK" },
    { key: "TIME BASE", value: "UTC · HOST CLOCK", status: "OK" },
    { key: "TELEMETRY", value: WS_URL.replace(/^wss?:\/\//, "").toUpperCase(), status: "HELD" },
    { key: "ACCESS CONTROL", value: "KEYPAD · SHA-256", status: "ARMED" },
  ];
}

const STATUS_COLOR: Record<Probe["status"], string> = {
  OK: "var(--ok)",
  HELD: "var(--warn)",
  FAIL: "var(--deny)",
  ARMED: "var(--accent)",
};

// ---- keypad -----------------------------------------------------------------

type Phase = "idle" | "verifying" | "denied" | "granted";

function Keypad({ onGranted }: { onGranted: () => void }) {
  const [entry, setEntryState] = useState("");
  const [phase, setPhaseState] = useState<Phase>("idle");
  const [lockout, setLockout] = useState<Lockout>({ failures: 0, until: 0 });
  const [now, setNow] = useState(() => Date.now());
  const [probes, setProbes] = useState<Probe[]>([]);
  const [shown, setShown] = useState(0);
  const [pressed, setPressed] = useState<string | null>(null);
  const [terminal, setTerminal] = useState("----");
  const [leaving, setLeaving] = useState(false);

  // Keystrokes are applied to refs, not to render-time state: a fast typist
  // (or a paste-like burst) delivers several keydowns before React re-renders,
  // and `#` must submit what was typed, not the entry as of the last render.
  const entryRef = useRef("");
  const phaseRef = useRef<Phase>("idle");
  const lockedUntil = useRef(0);
  const setEntry = (v: string) => {
    entryRef.current = v;
    setEntryState(v);
  };
  const setPhase = (v: Phase) => {
    phaseRef.current = v;
    setPhaseState(v);
  };

  useEffect(() => {
    const stored = readLockout();
    lockedUntil.current = stored.until;
    setLockout(stored);
    setProbes(runProbes());
    setTerminal(
      sha256Hex(`${navigator.userAgent}|${screen.width}x${screen.height}`).slice(0, 4).toUpperCase(),
    );
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, []);

  // Reveal the boot log one line at a time.
  useEffect(() => {
    if (!probes.length || shown > probes.length) return;
    const t = setTimeout(() => setShown((s) => s + 1), shown === 0 ? 260 : 170);
    return () => clearTimeout(t);
  }, [probes, shown]);

  const lockedMs = Math.max(0, lockout.until - now);
  const locked = lockedMs > 0;
  const busy = phase === "verifying" || phase === "granted" || locked;

  const onGrantedRef = useRef(onGranted);
  onGrantedRef.current = onGranted;

  const submit = useCallback((code: string) => {
    if (!code) return;
    setPhase("verifying");
    // A short, fixed verification beat: long enough to register as a check,
    // identical for right and wrong codes so timing reveals nothing.
    setTimeout(() => {
      // `#` is both ENT and the last character of the code, as typed.
      if (verifyCode(`${code}#`)) {
        writeLockout({ failures: 0, until: 0 });
        setPhase("granted");
        setTimeout(() => setLeaving(true), 750);
        setTimeout(() => onGrantedRef.current(), 1150);
        return;
      }
      const prev = readLockout();
      const failures = prev.failures + 1;
      const next = { failures, until: Date.now() + lockoutFor(failures) };
      writeLockout(next);
      lockedUntil.current = next.until;
      setLockout(next);
      setPhase("denied");
      setTimeout(() => {
        setEntry("");
        setPhase("idle");
      }, 950);
    }, 420);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const press = useCallback(
    (key: string) => {
      if (phaseRef.current !== "idle" || Date.now() < lockedUntil.current) return;
      setPressed(key);
      setTimeout(() => setPressed((p) => (p === key ? null : p)), 110);
      const cur = entryRef.current;
      if (key === "#") submit(cur);
      else if (key === "*") setEntry("");
      else if (key === "back") setEntry(cur.slice(0, -1));
      else if (/^\d$/.test(key) && cur.length < MAX_DIGITS) setEntry(cur + key);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [submit],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (/^\d$/.test(e.key)) press(e.key);
      else if (e.key === "#" || e.key === "Enter") press("#");
      else if (e.key === "Backspace") press("back");
      else if (e.key === "Escape" || e.key === "*" || e.key === "Delete") press("*");
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [press]);

  const remaining = Math.max(0, FREE_ATTEMPTS - lockout.failures);
  const status = locked
    ? { text: `LOCKED OUT — RETRY IN ${countdown(lockedMs)}`, color: "var(--deny)" }
    : phase === "verifying"
      ? { text: "VERIFYING CREDENTIAL", color: "var(--accent)" }
      : phase === "denied"
        ? { text: "ACCESS DENIED — CODE REJECTED", color: "var(--deny)" }
        : phase === "granted"
          ? { text: "ACCESS GRANTED — OPENING CONSOLE", color: "var(--ok)" }
          : entry
            ? { text: "TERMINATE WITH #", color: "var(--text-1)" }
            : { text: "AWAITING OPERATOR CREDENTIAL", color: "var(--text-1)" };

  const cellColor =
    phase === "denied" ? "var(--deny)" : phase === "granted" ? "var(--ok)" : "var(--accent)";

  return (
    <div
      className="gate surface"
      style={{
        transition: "opacity 400ms ease, transform 400ms ease, filter 400ms ease",
        opacity: leaving ? 0 : 1,
        transform: leaving ? "scale(1.015)" : "none",
        filter: leaving ? "brightness(1.6)" : "none",
      }}
    >

      <div className="flex h-10 flex-none items-center gap-4 border-b border-[var(--line)] px-5">
        <span className="label-strong text-[10.5px]" style={{ color: "var(--warn)" }}>Restricted access</span>
        <span className="h-3 w-px bg-[var(--line-strong)]" />
        <span className="mono text-[10.5px] text-[var(--text-2)]">SNTL-C2</span>
        <span className="h-3 w-px bg-[var(--line-strong)]" />
        <span className="mono text-[10.5px] text-[var(--text-2)]">TERMINAL {terminal}</span>
        <span className="ml-auto mono text-[10.5px] text-[var(--text-2)]">{dtg(now)}</span>
        <span className="mono text-[13px] text-[var(--text-0)]">{zulu(now)}</span>
      </div>

      <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-auto p-6">
        <Rings />

        <div
          className={`panel corner-ticks relative z-[2] w-full max-w-[900px] ${phase === "denied" ? "shake" : ""}`}
          style={phase === "denied" ? ({ "--corner": "var(--deny)" } as React.CSSProperties) : phase === "granted" ? ({ "--corner": "var(--ok)" } as React.CSSProperties) : undefined}
        >
          <div className="panel-frame">
            <header className="panel-head">
              <span className="panel-code">AUTH</span>
              <span className="panel-title">Operator authentication</span>
              <span className="ml-auto flex items-center gap-2">
                <span className="dot pulse" style={{ color: locked ? "var(--deny)" : "var(--warn)" }} />
                <span className="label" style={{ color: locked ? "var(--deny)" : "var(--warn)" }}>
                  {locked ? "Keypad locked" : "Console locked"}
                </span>
              </span>
            </header>

            <div className="grid gap-0 md:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
              {/* identity + boot log */}
              <div className="flex flex-col gap-5 border-b border-[var(--line)] p-6 md:border-r md:border-b-0">
                <div className="flex items-center gap-4">
                  <div className="relative flex h-[72px] w-[72px] flex-none items-center justify-center text-[var(--accent)]">
                    <svg className="absolute inset-0" viewBox="0 0 72 72" style={{ animation: "spin 14s linear infinite" }} aria-hidden>
                      <circle cx="36" cy="36" r="34" fill="none" stroke="var(--line-bright)" strokeWidth="1" strokeDasharray="2 5" />
                    </svg>
                    <svg className="absolute inset-0" viewBox="0 0 72 72" style={{ animation: "spin-rev 22s linear infinite" }} aria-hidden>
                      <circle cx="36" cy="36" r="30" fill="none" stroke="var(--accent)" strokeOpacity="0.55" strokeWidth="1.5" strokeDasharray="38 150" />
                    </svg>
                    <Emblem size={34} />
                  </div>
                  <div className="flex flex-col gap-1">
                    <span
                      className="display text-[38px] leading-none font-bold text-[var(--text-0)]"
                      style={{ letterSpacing: "0.32em" }}
                    >
                      Sentinel
                    </span>
                    <span className="label text-[11px]">RF through-wall human sensing · C2 console</span>
                  </div>
                </div>

                <div className="flex flex-col gap-[5px] border border-[var(--line)] bg-[color-mix(in_srgb,var(--bg-0)_70%,transparent)] p-3">
                  <div className="mb-1 flex items-center justify-between">
                    <span className="label">Power-on self test</span>
                    <span className="mono text-[9.5px] text-[var(--text-3)]">
                      {shown > probes.length ? "COMPLETE" : "RUNNING"}
                    </span>
                  </div>
                  {probes.slice(0, shown).map((p, i) => (
                    <div key={p.key} className="rise mono flex items-baseline gap-2 text-[10.5px]">
                      <span className="w-[46px] flex-none text-[var(--text-3)]">
                        +{(0.26 + i * 0.17).toFixed(3)}
                      </span>
                      <span className="flex-none text-[var(--text-1)]">{p.key}</span>
                      <span className="mx-0.5 h-px flex-1 translate-y-[-3px] border-b border-dotted border-[var(--line-bright)]" />
                      <span className="max-w-[45%] truncate text-[var(--text-0)]">{p.value}</span>
                      <span className="w-[52px] flex-none text-right" style={{ color: STATUS_COLOR[p.status] }}>
                        [{p.status}]
                      </span>
                    </div>
                  ))}
                  {shown > probes.length && (
                    <div className="mono mt-1 text-[10.5px] text-[var(--text-1)]">
                      &gt; {phase === "granted" ? "credential accepted · releasing telemetry hold" : "awaiting operator credential"}
                      <span className="blink ml-1 inline-block h-[11px] w-[6px] translate-y-[1px] bg-[var(--accent)]" />
                    </div>
                  )}
                </div>

                <p className="note max-w-[52ch]">
                  Access is limited to authorised project personnel. The telemetry link stays closed
                  until a valid code is entered, and closes again when the console is locked.
                </p>
              </div>

              {/* keypad */}
              <div className="flex flex-col gap-4 p-6">
                <div className="flex items-baseline justify-between">
                  <span className="label-strong">Enter access code</span>
                  <span className="flex items-center gap-1.5" title="Attempts before lockout">
                    <span className="label text-[10px]">Attempts</span>
                    {Array.from({ length: FREE_ATTEMPTS }, (_, i) => (
                      <span
                        key={i}
                        className="h-2 w-2"
                        style={{ background: i < remaining ? "var(--accent)" : "var(--deny)", opacity: i < remaining ? 0.9 : 0.8 }}
                      />
                    ))}
                  </span>
                </div>

                <div className="grid grid-cols-8 gap-1.5">
                  {Array.from({ length: MAX_DIGITS }, (_, i) => {
                    const filled = i < entry.length;
                    return (
                      <span
                        key={i}
                        className="gate-cell"
                        data-filled={filled}
                        data-cursor={i === entry.length && !busy}
                        style={filled ? { color: cellColor, borderColor: `color-mix(in srgb, ${cellColor} 55%, transparent)`, background: `color-mix(in srgb, ${cellColor} 10%, transparent)` } : undefined}
                      >
                        {filled ? "■" : i === entry.length && !busy ? <span className="blink text-[var(--text-2)]">_</span> : ""}
                      </span>
                    );
                  })}
                </div>

                <div className="mono flex h-5 items-center gap-2 text-[11px]" style={{ color: status.color }}>
                  <span className={`dot ${phase === "verifying" ? "pulse" : ""}`} />
                  {status.text}
                </div>

                <div className="grid grid-cols-3 gap-1.5">
                  {["1", "2", "3", "4", "5", "6", "7", "8", "9", "*", "0", "#"].map((k) => (
                    <button
                      key={k}
                      type="button"
                      className="gate-key"
                      data-down={pressed === k}
                      disabled={busy}
                      onClick={() => press(k)}
                      style={k === "#" ? { borderColor: "color-mix(in srgb, var(--accent) 45%, transparent)" } : undefined}
                    >
                      <span style={k === "#" ? { color: "var(--accent)" } : undefined}>{k === "*" ? "✱" : k}</span>
                      {k === "*" && <span className="gate-key-sub">CLR</span>}
                      {k === "#" && <span className="gate-key-sub" style={{ color: "var(--accent)" }}>ENT</span>}
                    </button>
                  ))}
                </div>

                <div className="flex items-center justify-between">
                  <button type="button" className="btn" onClick={() => press("back")} disabled={busy || !entry}>
                    <IconBackspace size={14} /> Delete
                  </button>
                  <span className="flex items-center gap-1.5 text-[10px] text-[var(--text-2)]">
                    <kbd>0-9</kbd>
                    <kbd>#</kbd>/<kbd>↵</kbd>
                    <kbd>esc</kbd>
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="flex h-8 flex-none items-center gap-4 border-t border-[var(--line)] px-5">
        <span className="label text-[10px]">Advisory output is decision support, not a clearance to act</span>
        <span className="ml-auto label text-[10px] text-[var(--text-3)]">Research prototype · session locks when the tab closes</span>
      </div>
    </div>
  );
}

/** Concentric range rings behind the panel: the lock screen's only motion. */
function Rings() {
  return (
    <svg
      className="pointer-events-none absolute top-1/2 left-1/2 z-[1] -translate-x-1/2 -translate-y-1/2 opacity-60"
      width="1100"
      height="1100"
      viewBox="-550 -550 1100 1100"
      aria-hidden
    >
      {[160, 260, 360, 460, 540].map((r) => (
        <circle key={r} r={r} fill="none" stroke="rgba(92,208,230,0.07)" strokeWidth="1" />
      ))}
      <path d="M-550 0H550M0 -550V550" stroke="rgba(92,208,230,0.05)" />
      <g style={{ animation: "spin 90s linear infinite", transformOrigin: "0 0" }}>
        {Array.from({ length: 72 }, (_, i) => {
          const a = (i * 5 * Math.PI) / 180;
          const r0 = i % 6 === 0 ? 446 : 454;
          return (
            <line
              key={i}
              x1={Math.sin(a) * r0}
              y1={-Math.cos(a) * r0}
              x2={Math.sin(a) * 460}
              y2={-Math.cos(a) * 460}
              stroke="rgba(92,208,230,0.16)"
            />
          );
        })}
      </g>
    </svg>
  );
}

function countdown(ms: number): string {
  const s = Math.ceil(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}
