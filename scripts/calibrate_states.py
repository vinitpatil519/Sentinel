"""Fit the behavioural-state emission model from labelled recordings.

Field procedure
---------------
1. Run a session with the console open. While a subject is verifiably in a known
   state, mark it: the console's LABEL control (or ``POST /api/labels``) writes a
   window with the ground-truth state.
2. Collect several minutes per state, ideally across subjects and positions.
3. Fit::

       python scripts/calibrate_states.py --db backend/data/sentinel.db \\
           --out backend/sentinel/config/state_model.yaml

4. Re-score against held-out labels::

       python scripts/calibrate_states.py --db ... --evaluate-only

The fit is MAP with the shipped defaults as the prior (see
``core.assessment.fit_state_params``), so a class with a handful of samples is
pulled toward the default rather than collapsing onto a near-zero variance that
would dominate every posterior. The report prints the per-class sample counts so
an under-sampled class is visible rather than silently trusted.

Nothing here touches the live system: the output is a YAML file, and it takes
effect when the backend is restarted.
"""

from __future__ import annotations

import argparse
import json
import sqlite3
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))

# Windows consoles default to a legacy code page that cannot encode the box and
# arrow characters used in scenario descriptions and reports; without this a
# perfectly healthy run dies on its first print().
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
sys.stderr.reconfigure(encoding="utf-8", errors="replace")


import yaml  # noqa: E402

from sentinel.core.assessment import (  # noqa: E402
    FEATURES,
    STATES,
    FeatureVector,
    ModelConfig,
    default_params,
    fit_state_params,
    params_to_dict,
)

#: A class with fewer samples than this is reported as under-sampled; its fitted
#: parameters stay dominated by the prior.
MIN_SAMPLES_PER_STATE = 120


def load_labelled(db_path: Path, session_id: int | None = None) -> list[tuple[str, FeatureVector]]:
    """Join ``assessments`` rows onto the operator's label windows."""
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    where = "WHERE session_id=?" if session_id else ""
    args = (session_id,) if session_id else ()
    labels = conn.execute(f"SELECT * FROM labels {where} ORDER BY ts_start", args).fetchall()
    rows = conn.execute(f"SELECT * FROM assessments {where} ORDER BY ts", args).fetchall()
    conn.close()

    samples: list[tuple[str, FeatureVector]] = []
    for r in rows:
        for lab in labels:
            if r["ts"] < lab["ts_start"]:
                continue
            if lab["ts_end"] is not None and r["ts"] > lab["ts_end"]:
                continue
            if lab["track_id"] and lab["track_id"] != r["track_id"]:
                continue
            feats = json.loads(r["features_json"] or "{}")
            samples.append((lab["label"], FeatureVector(
                respiration_bpm=feats.get("respiration_bpm"),
                rrv_cv=feats.get("rrv_cv"),
                motion_index=feats.get("motion_index"),
                burst_rate=feats.get("burst_rate"),
                amplitude_cv=feats.get("amplitude_cv"),
                irregular=bool(feats.get("irregular")),
                evidence=float(feats.get("evidence") or 0.0),
            )))
            break
    return samples


def report(samples: list[tuple[str, FeatureVector]], fitted) -> None:
    counts = Counter(label for label, _ in samples)
    print(f"labelled samples: {len(samples)}")
    for st in STATES:
        n = counts.get(st.value, 0)
        flag = "" if n >= MIN_SAMPLES_PER_STATE else "  <- under-sampled, prior-dominated"
        print(f"  {st.value.ljust(12)} {str(n).rjust(6)}{flag}")
    print("\nfitted emissions (mean +/- sd)")
    for st in STATES:
        parts = []
        for f in FEATURES:
            g = fitted[st].emissions.get(f)
            if g:
                parts.append(f"{f}={g.mean:.3f}+-{g.sd:.3f}")
        print(f"  {st.value.ljust(12)} " + "  ".join(parts))


def evaluate(samples: list[tuple[str, FeatureVector]], params) -> dict:
    """Frame-wise emission-only accuracy — no HMM prior, no temporal smoothing.

    This is deliberately the *pessimistic* number: it measures how separable the
    features are on their own. The live system adds transition priors and dwell,
    which is why ``scripts/evaluate_model.py`` reports a higher figure on the
    same data. Quoting only the higher one would overstate the model.
    """
    cfg = ModelConfig()
    cfg.params = params
    correct = 0
    confusion: dict[str, Counter] = {s.value: Counter() for s in STATES}
    for label, fv in samples:
        best, best_ll = None, float("-inf")
        for st in STATES:
            ll, used = cfg.params[st].log_likelihood(fv)
            if used and ll > best_ll:
                best, best_ll = st.value, ll
        if best is None:
            continue
        confusion.setdefault(label, Counter())[best] += 1
        correct += int(best == label)
    total = sum(sum(c.values()) for c in confusion.values())
    return {
        "frames": total,
        "accuracy": round(correct / total, 3) if total else None,
        "confusion": {k: dict(v) for k, v in confusion.items()},
    }


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--db", default="backend/data/sentinel.db")
    p.add_argument("--session", type=int, help="session id (default: all sessions)")
    p.add_argument("--out", default="backend/sentinel/config/state_model.yaml")
    p.add_argument("--prior-weight", type=float, default=8.0)
    p.add_argument("--evaluate-only", action="store_true")
    args = p.parse_args()

    db = Path(args.db)
    if not db.exists():
        raise SystemExit(f"no database at {db}")
    samples = load_labelled(db, args.session)
    if not samples:
        raise SystemExit(
            "no labelled samples found — record a session and mark windows with "
            "the console's LABEL control (or POST /api/labels) first"
        )

    fitted = fit_state_params(samples, prior=default_params(), prior_weight=args.prior_weight)
    report(samples, fitted)

    baseline = evaluate(samples, default_params())
    tuned = evaluate(samples, fitted)
    print(f"\nemission-only accuracy: defaults {baseline['accuracy']} -> fitted {tuned['accuracy']}")

    if args.evaluate_only:
        return
    payload = params_to_dict(fitted)
    payload["provenance"] = (
        f"fitted from {len(samples)} labelled samples in {db.name}"
        + (f" (session {args.session})" if args.session else "")
    )
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(yaml.safe_dump(payload, sort_keys=False), encoding="utf-8")
    print(f"wrote {out} — restart the backend to load it")


if __name__ == "__main__":
    main()
