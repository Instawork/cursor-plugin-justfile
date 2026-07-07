#!/usr/bin/env python3
"""SQLite ledger for per-turn token telemetry (canonical long-term store)."""

from __future__ import annotations

import argparse
import csv
import json
import os
import sqlite3
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

DEFAULT_DB = Path.home() / "code/cursor-contexts/assistant/token-telemetry.sqlite"
DEFAULT_CSV = Path.home() / "code/cursor-contexts/assistant/token-telemetry.csv"

BILLABLE_EVENTS = frozenset({"agentTurn", "cloudRun"})

SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS turns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  event TEXT NOT NULL,
  model TEXT,
  conversation_id TEXT,
  generation_id TEXT,
  input_uncached_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  cumulative_total_tokens INTEGER,
  cumulative_output_tokens INTEGER,
  cumulative_cost_usd REAL,
  context_usage_percent REAL,
  conversation TEXT,
  source TEXT NOT NULL DEFAULT 'ide'
);
CREATE INDEX IF NOT EXISTS idx_turns_at ON turns(at DESC);
CREATE INDEX IF NOT EXISTS idx_turns_event ON turns(event);
CREATE UNIQUE INDEX IF NOT EXISTS idx_turns_generation
  ON turns(generation_id) WHERE generation_id IS NOT NULL AND generation_id != '';
"""


def env_flag(name: str, default: str = "0") -> bool:
    return os.environ.get(name, default).lower() not in ("0", "false", "no")


def sql_enabled() -> bool:
    return env_flag("TOKEN_HOOK_SQL", "1")


def db_path() -> Path:
    raw = os.environ.get("TOKEN_HOOK_SQLITE", "").strip()
    return Path(raw).expanduser() if raw else DEFAULT_DB


def csv_path_default() -> Path:
    raw = os.environ.get("TOKEN_HOOK_CSV", "").strip()
    return Path(raw).expanduser() if raw else DEFAULT_CSV


def sql_retention_days() -> int:
    raw = os.environ.get("TOKEN_HOOK_SQL_RETENTION_DAYS", "365").strip()
    try:
        return max(0, int(raw))
    except ValueError:
        return 365


def connect() -> sqlite3.Connection:
    path = db_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path, timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    ensure_schema(conn)
    return conn


def ensure_schema(conn: sqlite3.Connection) -> None:
    conn.executescript(SCHEMA_SQL)
    conn.commit()


def _meta_get(conn: sqlite3.Connection, key: str) -> str | None:
    row = conn.execute("SELECT value FROM meta WHERE key = ?", (key,)).fetchone()
    return str(row["value"]) if row else None


def _meta_set(conn: sqlite3.Connection, key: str, value: str) -> None:
    conn.execute(
        "INSERT INTO meta(key, value) VALUES (?, ?) "
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (key, value),
    )


def source_for_event(event: str) -> str:
    return "cloud" if event == "cloudRun" else "ide"


def insert_turn(
    conn: sqlite3.Connection,
    *,
    at: str,
    event: str,
    model: str,
    conversation_id: str,
    generation_id: str,
    input_uncached_tokens: int,
    cache_read_tokens: int,
    cache_write_tokens: int,
    output_tokens: int,
    total_tokens: int,
    cost_usd: float,
    cumulative_total_tokens: int | None,
    cumulative_output_tokens: int | None,
    cumulative_cost_usd: float | None,
    context_usage_percent: float | None,
    conversation: str,
) -> bool:
    if event not in BILLABLE_EVENTS and event not in ("hourly", "daily"):
        pass
    cur = conn.execute(
        """
        INSERT OR IGNORE INTO turns (
          at, event, model, conversation_id, generation_id,
          input_uncached_tokens, cache_read_tokens, cache_write_tokens,
          output_tokens, total_tokens, cost_usd,
          cumulative_total_tokens, cumulative_output_tokens, cumulative_cost_usd,
          context_usage_percent, conversation, source
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            at,
            event,
            model or "",
            conversation_id or "",
            generation_id or "",
            input_uncached_tokens,
            cache_read_tokens,
            cache_write_tokens,
            output_tokens,
            total_tokens,
            round(float(cost_usd), 6),
            cumulative_total_tokens,
            cumulative_output_tokens,
            cumulative_cost_usd,
            context_usage_percent,
            conversation or "",
            source_for_event(event),
        ),
    )
    conn.commit()
    return cur.rowcount > 0


def apply_retention(conn: sqlite3.Connection) -> int:
    days = sql_retention_days()
    if days <= 0:
        return 0
    cutoff = datetime.now(timezone.utc) - timedelta(days=days)
    cutoff_s = cutoff.isoformat()
    cur = conn.execute("DELETE FROM turns WHERE at < ?", (cutoff_s,))
    conn.commit()
    return cur.rowcount


def read_csv_rows(path: Path) -> tuple[list[str], list[list[str]]]:
    if not path.is_file():
        return [], []
    with path.open(newline="", encoding="utf-8") as f:
        rows = list(csv.reader(f))
    if not rows:
        return [], []
    return rows[0], rows[1:]


def migrate_csv(conn: sqlite3.Connection, csv_file: Path | None = None) -> int:
    path = csv_file or csv_path_default()
    header, data = read_csv_rows(path)
    if not header or not data:
        _meta_set(conn, "csv_migrated_at", datetime.now(timezone.utc).isoformat())
        conn.commit()
        return 0
    col = {name: i for i, name in enumerate(header)}
    inserted = 0
    for row in data:
        if len(row) < 2:
            continue
        event = row[col.get("event", 1)] if "event" in col else ""
        if event not in BILLABLE_EVENTS and event not in ("hourly", "daily"):
            continue

        def cell_int(key: str) -> int:
            idx = col.get(key)
            if idx is None or idx >= len(row) or not row[idx]:
                return 0
            try:
                return int(float(row[idx]))
            except ValueError:
                return 0

        def cell_float(key: str) -> float | None:
            idx = col.get(key)
            if idx is None or idx >= len(row) or not row[idx]:
                return None
            try:
                return float(row[idx])
            except ValueError:
                return None

        gen = (
            row[col["generation_id"]]
            if "generation_id" in col and col["generation_id"] < len(row)
            else ""
        )
        if insert_turn(
            conn,
            at=row[col["at"]] if "at" in col else "",
            event=event,
            model=row[col["model"]] if "model" in col else "",
            conversation_id=row[col["conversation_id"]]
            if "conversation_id" in col
            else "",
            generation_id=gen,
            input_uncached_tokens=cell_int("input_uncached_tokens"),
            cache_read_tokens=cell_int("cache_read_tokens"),
            cache_write_tokens=cell_int("cache_write_tokens"),
            output_tokens=cell_int("output_tokens"),
            total_tokens=cell_int("total_tokens"),
            cost_usd=cell_float("cost_usd") or 0.0,
            cumulative_total_tokens=cell_int("cumulative_total_tokens") or None,
            cumulative_output_tokens=cell_int("cumulative_output_tokens") or None,
            cumulative_cost_usd=cell_float("cumulative_cost_usd"),
            context_usage_percent=cell_float("context_usage_percent"),
            conversation=row[col["conversation"]]
            if "conversation" in col and col["conversation"] < len(row)
            else "",
        ):
            inserted += 1
    _meta_set(conn, "csv_migrated_at", datetime.now(timezone.utc).isoformat())
    _meta_set(conn, "csv_migrated_path", str(path))
    conn.commit()
    return inserted


def migrate_csv_if_needed(conn: sqlite3.Connection) -> int:
    csv_file = csv_path_default()
    if not csv_file.is_file():
        return 0
    mtime = csv_file.stat().st_mtime
    last = _meta_get(conn, "csv_migrated_mtime")
    if last and float(last) >= mtime:
        count = conn.execute("SELECT COUNT(*) AS c FROM turns").fetchone()
        if count and int(count["c"]) > 0:
            return 0
    n = migrate_csv(conn, csv_file)
    _meta_set(conn, "csv_migrated_mtime", str(mtime))
    conn.commit()
    return n


def query_turns(
    conn: sqlite3.Connection,
    *,
    limit: int = 10_000,
    since: str | None = None,
    include_rollups: bool = False,
) -> list[dict[str, object]]:
    clauses = []
    params: list[object] = []
    if not include_rollups:
        clauses.append("event IN ('agentTurn', 'cloudRun')")
    if since:
        clauses.append("at >= ?")
        params.append(since)
    where = (" WHERE " + " AND ".join(clauses)) if clauses else ""
    params.append(max(1, min(limit, 50_000)))
    rows = conn.execute(
        f"SELECT * FROM turns{where} ORDER BY at DESC LIMIT ?",
        params,
    ).fetchall()
    out: list[dict[str, object]] = []
    for row in reversed(rows):
        rec: dict[str, object] = {}
        for key in row.keys():
            if key == "id" or key == "source":
                continue
            val = row[key]
            if val is None or val == "":
                rec[key] = None
            elif key in (
                "input_uncached_tokens",
                "cache_read_tokens",
                "cache_write_tokens",
                "output_tokens",
                "total_tokens",
                "cumulative_total_tokens",
                "cumulative_output_tokens",
            ):
                rec[key] = int(val)
            elif key in ("cost_usd", "cumulative_cost_usd", "context_usage_percent"):
                rec[key] = float(val)
            else:
                rec[key] = val
        out.append(rec)
    return out


def row_to_insert_kwargs(row: dict[str, object]) -> dict[str, object]:
    return {
        "at": str(row.get("at") or datetime.now(timezone.utc).isoformat()),
        "event": str(row.get("event") or "agentTurn"),
        "model": str(row.get("model") or ""),
        "conversation_id": str(row.get("conversation_id") or ""),
        "generation_id": str(row.get("generation_id") or ""),
        "input_uncached_tokens": int(row.get("input_uncached_tokens") or 0),
        "cache_read_tokens": int(row.get("cache_read_tokens") or 0),
        "cache_write_tokens": int(row.get("cache_write_tokens") or 0),
        "output_tokens": int(row.get("output_tokens") or 0),
        "total_tokens": int(row.get("total_tokens") or 0),
        "cost_usd": float(row.get("cost_usd") or 0),
        "cumulative_total_tokens": row.get("cumulative_total_tokens"),
        "cumulative_output_tokens": row.get("cumulative_output_tokens"),
        "cumulative_cost_usd": row.get("cumulative_cost_usd"),
        "context_usage_percent": row.get("context_usage_percent"),
        "conversation": str(row.get("conversation") or ""),
    }


def insert_turn_from_append(
    *,
    at: str,
    event: str,
    model: str,
    conversation_id: str,
    generation_id: str,
    uncached: int,
    cache_r: int,
    cache_w: int,
    out: int,
    total: int,
    row_cost: float,
    cum_total: int,
    cum_out: int,
    cum_cost: float,
    ctx_cell: str,
    conversation: str,
) -> None:
    if not sql_enabled():
        return
    ctx: float | None = None
    if ctx_cell:
        try:
            ctx = float(ctx_cell)
        except ValueError:
            ctx = None
    conn = connect()
    try:
        insert_turn(
            conn,
            at=at,
            event=event,
            model=model,
            conversation_id=conversation_id,
            generation_id=generation_id,
            input_uncached_tokens=uncached,
            cache_read_tokens=cache_r,
            cache_write_tokens=cache_w,
            output_tokens=out,
            total_tokens=total,
            cost_usd=row_cost,
            cumulative_total_tokens=cum_total,
            cumulative_output_tokens=cum_out,
            cumulative_cost_usd=cum_cost,
            context_usage_percent=ctx,
            conversation=conversation,
        )
        apply_retention(conn)
    finally:
        conn.close()


def main() -> int:
    parser = argparse.ArgumentParser(description="Token telemetry SQLite store")
    parser.add_argument("--migrate-csv", action="store_true")
    parser.add_argument("--migrate-csv-if-needed", action="store_true")
    parser.add_argument(
        "--retention", action="store_true", help="Apply SQL retention policy"
    )
    parser.add_argument("--query", action="store_true", help="JSON query on stdin")
    parser.add_argument("--status", action="store_true")
    args = parser.parse_args()

    if args.status:
        path = db_path()
        print(f"SQL:   {path}")
        print(f"Enabled: {sql_enabled()}")
        print(f"Retention days: {sql_retention_days()}")
        if path.is_file():
            conn = connect()
            try:
                n = conn.execute("SELECT COUNT(*) AS c FROM turns").fetchone()
                print(f"Rows:  {int(n['c']) if n else 0}")
            finally:
                conn.close()
        else:
            print("Rows:  0 (no database yet)")
        return 0

    conn = connect()
    try:
        if args.migrate_csv:
            n = migrate_csv(conn)
            print(f"Migrated {n} row(s) from CSV")
            return 0
        if args.migrate_csv_if_needed:
            n = migrate_csv_if_needed(conn)
            if n:
                print(f"Migrated {n} row(s) from CSV")
            return 0
        if args.retention:
            n = apply_retention(conn)
            print(f"Deleted {n} row(s) older than retention")
            return 0
        if args.query:
            raw = sys.stdin.read()
            opts = json.loads(raw) if raw.strip() else {}
            if opts.get("mode") == "cloudRunIds":
                id_rows = conn.execute(
                    """
                    SELECT DISTINCT generation_id FROM turns
                    WHERE event = 'cloudRun'
                      AND generation_id IS NOT NULL
                      AND generation_id != ''
                    """
                ).fetchall()
                ids = [str(r[0]) for r in id_rows if r[0]]
                sys.stdout.write(json.dumps(ids, separators=(",", ":")))
                return 0
            limit = int(opts.get("limit", 10_000))
            since = opts.get("since")
            include_rollups = bool(opts.get("includeRollups", False))
            rows = query_turns(
                conn,
                limit=limit,
                since=since if isinstance(since, str) else None,
                include_rollups=include_rollups,
            )
            sys.stdout.write(json.dumps(rows, separators=(",", ":")))
            return 0
    finally:
        conn.close()

    parser.print_help()
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
