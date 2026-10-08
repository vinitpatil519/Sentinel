"""SQLite (WAL) persistence for sessions, telemetry, tracks and assessments.

The live console is fed from the TelemetryHub, never from here. This store
exists for the research workflow: recording a session, labelling windows of it,
fitting the behavioural-state model on those labels, and exporting everything
for offline analysis.

Write policy
------------
* ``events``      — every event, never downsampled.
* ``samples``     — generic per-channel snapshots at 1 Hz.
* ``assessments`` — per-track state/advisory/vitals at 1 Hz; the table the
                    evaluation scripts read.
* ``tracks``      — one row per subject track, opened and closed.
* ``labels``      — operator ground truth for a time window, used to fit and
                    to score the state model.

CSI amplitude vectors and the full field grid are deliberately *not* persisted:
they are large, and none of the downstream analysis reads them back. What is
persisted is the derived feature vector, which is what the model consumes.
"""

from __future__ import annotations

import json
from pathlib import Path

import aiosqlite

from sentinel.core.telemetry import now_ms

SCHEMA = """
CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at INTEGER NOT NULL,
    ended_at INTEGER,
    source TEXT,
    notes TEXT
);
CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL REFERENCES sessions(id),
    ts INTEGER NOT NULL,
    type TEXT NOT NULL,
    severity TEXT NOT NULL DEFAULT 'info',
    track_id TEXT,
    payload_json TEXT
);
CREATE TABLE IF NOT EXISTS samples (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL REFERENCES sessions(id),
    ts INTEGER NOT NULL,
    channel TEXT NOT NULL,
    value_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tracks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL REFERENCES sessions(id),
    track_id TEXT NOT NULL,
    first_seen INTEGER NOT NULL,
    last_seen INTEGER NOT NULL,
    provenance TEXT,
    UNIQUE(session_id, track_id)
);
CREATE TABLE IF NOT EXISTS assessments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL REFERENCES sessions(id),
    ts INTEGER NOT NULL,
    track_id TEXT NOT NULL,
    state TEXT,
    state_confidence REAL,
    decision TEXT,
    readiness_index REAL,
    respiration_bpm REAL,
    respiration_confidence REAL,
    heart_bpm REAL,
    rrv_cv REAL,
    motion_index REAL,
    evidence REAL,
    features_json TEXT
);
CREATE TABLE IF NOT EXISTS labels (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL REFERENCES sessions(id),
    ts_start INTEGER NOT NULL,
    ts_end INTEGER,
    label TEXT NOT NULL,
    track_id TEXT,
    notes TEXT
);
CREATE INDEX IF NOT EXISTS idx_samples_chan_ts ON samples(channel, ts);
CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
CREATE INDEX IF NOT EXISTS idx_assess_ts ON assessments(track_id, ts);
CREATE INDEX IF NOT EXISTS idx_labels_ts ON labels(ts_start, ts_end);
"""

#: Columns added after the first schema release: (table, column, DDL). Appended
#: to, never rewritten — each entry is applied to a database that lacks it.
ADDED_COLUMNS: list[tuple[str, str, str]] = [
    ("events", "track_id", "track_id TEXT"),
    ("sessions", "source", "source TEXT"),
]

#: Channels persisted as generic samples (the rest are either internal or
#: reconstructible from these).
SAMPLE_CHANNELS = {"rf.presence", "rf.vitals", "rf.nodes"}
SAMPLE_PERIOD_MS = 1000
ASSESSMENT_PERIOD_MS = 1000


class Database:
    def __init__(self, path: Path) -> None:
        self.path = Path(path)
        self.session_id: int | None = None
        self._conn: aiosqlite.Connection | None = None
        self._last_sample_ts: dict[str, int] = {}
        self._last_assessment_ts: dict[str, int] = {}
        self._known_tracks: set[str] = set()
        self.writes = 0

    async def open(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._conn = await aiosqlite.connect(self.path)
        self._conn.row_factory = aiosqlite.Row
        await self._conn.execute("PRAGMA journal_mode=WAL")
        await self._conn.execute("PRAGMA synchronous=NORMAL")
        await self._conn.executescript(SCHEMA)
        await self._migrate()
        cur = await self._conn.execute(
            "INSERT INTO sessions(started_at) VALUES (?)", (now_ms(),)
        )
        self.session_id = cur.lastrowid
        await self._conn.commit()

    async def _migrate(self) -> None:
        """Add columns a previous schema version lacked.

        ``CREATE TABLE IF NOT EXISTS`` silently leaves an existing table on the
        old shape, so a database recorded before a column was introduced fails
        on the first insert — at runtime, mid-session, with data being lost. The
        columns are added instead of the table being recreated: a recorded
        session is research data and is never dropped to simplify a migration.
        """
        assert self._conn
        for table, column, ddl in ADDED_COLUMNS:
            cur = await self._conn.execute(f"PRAGMA table_info({table})")
            names = {r["name"] for r in await cur.fetchall()}
            if names and column not in names:
                await self._conn.execute(f"ALTER TABLE {table} ADD COLUMN {ddl}")
        await self._conn.commit()

    async def close(self) -> None:
        if self._conn:
            await self._conn.execute(
                "UPDATE sessions SET ended_at=? WHERE id=?", (now_ms(), self.session_id)
            )
            await self._conn.commit()
            await self._conn.close()
            self._conn = None

    # -- hub tap ------------------------------------------------------------

    async def on_telemetry(self, msg: dict) -> None:
        if not self._conn:
            return
        ch, ts, data = msg["ch"], msg["ts"], msg["data"]
        if ch == "events":
            await self._insert_event(ts, data)
        elif ch == "track.state":
            await self._insert_tracks(ts, data)
        elif ch in SAMPLE_CHANNELS:
            if ts - self._last_sample_ts.get(ch, 0) < SAMPLE_PERIOD_MS:
                return
            self._last_sample_ts[ch] = ts
            await self._exec(
                "INSERT INTO samples(session_id, ts, channel, value_json) VALUES (?,?,?,?)",
                (self.session_id, ts, ch, json.dumps(data, separators=(",", ":"))),
            )

    async def _insert_event(self, ts: int, data: dict) -> None:
        await self._exec(
            "INSERT INTO events(session_id, ts, type, severity, track_id, payload_json)"
            " VALUES (?,?,?,?,?,?)",
            (self.session_id, ts, data.get("type", "UNKNOWN"), data.get("severity", "info"),
             data.get("track"), json.dumps(data, separators=(",", ":"))),
        )

    async def _insert_tracks(self, ts: int, data: dict) -> None:
        for tr in data.get("tracks", []):
            tid = tr["id"]
            if tid not in self._known_tracks:
                self._known_tracks.add(tid)
                await self._exec(
                    "INSERT OR IGNORE INTO tracks(session_id, track_id, first_seen, last_seen,"
                    " provenance) VALUES (?,?,?,?,?)",
                    (self.session_id, tid, tr.get("first_seen", ts), ts, tr.get("provenance")),
                )
            if ts - self._last_assessment_ts.get(tid, 0) < ASSESSMENT_PERIOD_MS:
                continue
            self._last_assessment_ts[tid] = ts
            await self._exec(
                "UPDATE tracks SET last_seen=? WHERE session_id=? AND track_id=?",
                (ts, self.session_id, tid),
            )
            state = tr.get("state") or {}
            adv = tr.get("advisory") or {}
            vit = tr.get("vitals") or {}
            resp = vit.get("respiration") or {}
            card = vit.get("cardiac") or {}
            rfeat = vit.get("respiration_features") or {}
            motion = vit.get("motion") or {}
            await self._exec(
                "INSERT INTO assessments(session_id, ts, track_id, state, state_confidence,"
                " decision, readiness_index, respiration_bpm, respiration_confidence,"
                " heart_bpm, rrv_cv, motion_index, evidence, features_json)"
                " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (
                    self.session_id, ts, tid, state.get("state"), state.get("confidence"),
                    adv.get("decision"), adv.get("readiness_index"),
                    resp.get("bpm"), resp.get("confidence"), card.get("bpm"),
                    rfeat.get("rrv_cv"), motion.get("index"), state.get("evidence"),
                    json.dumps(tr.get("features") or {}, separators=(",", ":")),
                ),
            )

    async def _exec(self, sql: str, args: tuple) -> None:
        assert self._conn
        await self._conn.execute(sql, args)
        await self._conn.commit()
        self.writes += 1

    # -- reads --------------------------------------------------------------

    async def query(self, sql: str, args: tuple = ()) -> list[dict]:
        assert self._conn
        cur = await self._conn.execute(sql, args)
        return [dict(r) for r in await cur.fetchall()]

    async def add_label(
        self, label: str, ts_start: int, ts_end: int | None,
        track_id: str | None = None, notes: str | None = None,
    ) -> int:
        assert self._conn
        cur = await self._conn.execute(
            "INSERT INTO labels(session_id, ts_start, ts_end, label, track_id, notes)"
            " VALUES (?,?,?,?,?,?)",
            (self.session_id, ts_start, ts_end, label, track_id, notes),
        )
        await self._conn.commit()
        return cur.lastrowid or 0

    async def session_summary(self, session_id: int | None = None) -> dict:
        sid = session_id or self.session_id
        rows = await self.query("SELECT * FROM sessions WHERE id=?", (sid,))
        if not rows:
            return {}
        session = rows[0]
        counts = await self.query(
            "SELECT severity, COUNT(*) AS n FROM events WHERE session_id=? GROUP BY severity", (sid,)
        )
        states = await self.query(
            "SELECT state, COUNT(*) AS n FROM assessments WHERE session_id=? AND state IS NOT NULL"
            " GROUP BY state", (sid,)
        )
        decisions = await self.query(
            "SELECT decision, COUNT(*) AS n FROM assessments WHERE session_id=?"
            " AND decision IS NOT NULL GROUP BY decision", (sid,)
        )
        tracks = await self.query("SELECT * FROM tracks WHERE session_id=?", (sid,))
        vitals = await self.query(
            "SELECT AVG(respiration_bpm) AS mean_bpm, MIN(respiration_bpm) AS min_bpm,"
            " MAX(respiration_bpm) AS max_bpm, AVG(rrv_cv) AS mean_rrv,"
            " COUNT(*) AS samples FROM assessments"
            " WHERE session_id=? AND respiration_confidence > 0.4", (sid,)
        )
        return {
            "session": session,
            "event_counts": {r["severity"]: r["n"] for r in counts},
            "state_seconds": {r["state"]: r["n"] for r in states},
            "decision_seconds": {r["decision"]: r["n"] for r in decisions},
            "tracks": tracks,
            "respiration": vitals[0] if vitals else {},
        }
