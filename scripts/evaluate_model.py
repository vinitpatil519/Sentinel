"""CLI for the offline model evaluation in ``sentinel.evaluation``.

    python scripts/evaluate_model.py --scenario patrol
    python scripts/evaluate_model.py --all --json reports/evaluation.json

See ``sentinel/evaluation.py`` for what each metric means and
``docs/evaluation.md`` for the protocol these numbers belong to.
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


from sentinel.evaluation import STATE_NAMES, run_scenario, score  # noqa: E402
from sentinel.simulation import SCENARIOS  # noqa: E402


def print_report(report: dict) -> None:
    title = report["scenario"]
    print()
    print(f"== {title} " + "=" * max(4, 56 - len(title)))
    print(f"frames scored     {report['frames_scored']}")
    print(f"accuracy          {report['accuracy']}")
    print(f"unknown rate      {report['unknown_rate']}")
    print(f"median latency    {report['median_latency_s']} s")
    adv = report["advisory"]
    print(f"false-APPROACH    {adv['false_approach_frames']}/{adv['approach_frames']} "
          f"({adv['false_approach_rate']})   <- hard safety metric")
    print(f"false-permissive  {adv['false_permissive_frames']}/{adv['permissive_frames']} "
          f"({adv['false_permissive_rate']})   (APPROACH or CAUTION)")
    det = report["detection"]
    print(f"detection rate    {det['detection_rate']}  false tracks {det['false_track_frames']}")
    width = max(len(s) for s in STATE_NAMES) + 1
    print()
    print("confusion (row = truth, column = predicted)")
    print(" " * width + "".join(s[:6].rjust(8) for s in STATE_NAMES))
    for truth in STATE_NAMES:
        row = report["confusion"][truth]
        print(truth.ljust(width) + "".join(str(row[p]).rjust(8) for p in STATE_NAMES))
    print()
    print("per state")
    for st, m in report["per_state"].items():
        print(f"  {st.ljust(width)} support {str(m['support']).rjust(5)} "
              f"P {m['precision']:.3f}  R {m['recall']:.3f}  F1 {m['f1']:.3f}")


async def main_async(args: argparse.Namespace) -> int:
    names = list(SCENARIOS) if args.all else [args.scenario]
    reports = []
    for name in names:
        run = await run_scenario(name, seed=args.seed, rate=args.rate,
                                 use_defaults=args.defaults)
        report = score(name, run["records"])
        reports.append(report)
        print_report(report)
    if args.json:
        out = Path(args.json)
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps(reports, indent=2), encoding="utf-8")
        print()
        print(f"wrote {out}")
    return 0


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--scenario", default="patrol", choices=SCENARIOS)
    p.add_argument("--all", action="store_true", help="evaluate every scenario")
    p.add_argument("--seed", type=int, default=7)
    p.add_argument("--rate", type=float, default=10.0)
    p.add_argument("--defaults", action="store_true",
                   help="evaluate the built-in parameters instead of the fitted model")
    p.add_argument("--json", help="write the full report to this path")
    raise SystemExit(asyncio.run(main_async(p.parse_args())))


if __name__ == "__main__":
    main()
