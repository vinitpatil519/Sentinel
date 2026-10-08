"""Stand-in RuView sensing server for development without hardware.

Serves the real upstream wire format on ``ws://0.0.0.0:<port>/ws/sensing``, so
the SENTINEL adapter connects to it with the same code path, the same port
mapping and the same schema it uses against the real sensing server. Frames are
labelled ``source: "simulate"`` and the console shows a SIMULATED banner
whenever that is what it is receiving.

    python scripts/ruview_sim.py --scenario patrol
    python scripts/ruview_sim.py --scenario two-person --rate 10 --loop

Scenario physics live in ``backend/sentinel/simulation/scenario.py``.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))

# Windows consoles default to a legacy code page that cannot encode the box and
# arrow characters used in scenario descriptions and reports; without this a
# perfectly healthy run dies on its first print().
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
sys.stderr.reconfigure(encoding="utf-8", errors="replace")


import websockets  # noqa: E402

from sentinel.simulation import SCENARIOS, Simulator, build_scenario  # noqa: E402

DEFAULT_PORT = 3001   # the sensing-WebSocket port of the published Docker image


async def serve(args: argparse.Namespace) -> None:
    scenario = build_scenario(args.scenario)
    clients: set = set()

    async def handler(ws):
        clients.add(ws)
        print(f"[sim] client connected ({len(clients)} total) path={getattr(ws, 'path', '/')}")
        try:
            await ws.wait_closed()
        finally:
            clients.discard(ws)
            print(f"[sim] client disconnected ({len(clients)} left)")

    async def pump():
        sim = Simulator(scenario, fs=args.rate, seed=args.seed)
        period = 1.0 / args.rate
        emitted = 0
        while True:
            frame = sim.step()
            emitted += 1
            if sim.t >= scenario.duration_s and scenario.duration_s > 0:
                if not args.loop:
                    print(f"[sim] scenario '{scenario.name}' complete ({emitted} frames)")
                    return
                sim = Simulator(scenario, fs=args.rate, seed=args.seed + emitted)
            if clients:
                text = json.dumps(frame, separators=(",", ":"))
                await asyncio.gather(
                    *(c.send(text) for c in list(clients)), return_exceptions=True
                )
            if emitted % (int(args.rate) * 30) == 0:
                gt = frame.get("_ground_truth", {}).get("subjects", [])
                states = ", ".join(f"{s['name']}={s['state']}" for s in gt) or "empty"
                print(f"[sim] t={sim.t:6.1f}s  {states}")
            await asyncio.sleep(period)

    async with websockets.serve(handler, args.host, args.port, max_size=8 * 1024 * 1024):
        print(f"[sim] scenario '{scenario.name}': {scenario.description}")
        print(f"[sim] {len(scenario.subjects)} subject(s), {len(scenario.nodes)} node(s), "
              f"{scenario.duration_s:.0f}s, {args.rate} Hz")
        print(f"[sim] listening on ws://{args.host}:{args.port}/ws/sensing")
        await pump()


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--scenario", default="patrol", choices=SCENARIOS)
    p.add_argument("--host", default="0.0.0.0")
    p.add_argument("--port", type=int, default=DEFAULT_PORT)
    p.add_argument("--rate", type=float, default=10.0, help="frames per second")
    p.add_argument("--seed", type=int, default=7)
    p.add_argument("--loop", action="store_true", help="restart when the scenario ends")
    args = p.parse_args()
    try:
        asyncio.run(serve(args))
    except KeyboardInterrupt:
        print("\n[sim] stopped")


if __name__ == "__main__":
    main()
