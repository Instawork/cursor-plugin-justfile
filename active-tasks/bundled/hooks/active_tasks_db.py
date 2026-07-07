#!/usr/bin/env python3
"""Active work SQLite store (shared contract with Active Tasks VS Code extension)."""

from __future__ import annotations

import json
import os
import sqlite3
import sys
from pathlib import Path
from typing import Any

DEFAULT_DB = Path.home() / "code/cursor-contexts/active-tasks.sqlite"
VALID_REPOS = frozenset({"instawork", "finch", "infrastructure"})


class ActiveTasksValidationError(ValueError):
    pass


def db_path() -> Path:
    raw = os.environ.get("ACTIVE_TASKS_DB_PATH", "")
    return Path(raw) if raw.strip() else DEFAULT_DB


def connect() -> sqlite3.Connection:
    path = db_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path, timeout=30)
    conn.row_factory = sqlite3.Row
    return conn


def ensure_schema(conn: sqlite3.Connection) -> None:
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS meta (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS active_work (
            id TEXT PRIMARY KEY,
            sort_order INTEGER NOT NULL,
            title TEXT NOT NULL,
            status TEXT NOT NULL,
            repo TEXT,
            branch TEXT,
            worktree TEXT,
            notes TEXT,
            pr_number INTEGER,
            pr_url TEXT,
            prs_json TEXT NOT NULL DEFAULT '[]',
            links_json TEXT NOT NULL DEFAULT '[]',
            done INTEGER NOT NULL DEFAULT 0,
            updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_active_work_sort ON active_work(sort_order);
        CREATE TABLE IF NOT EXISTS discovery_dismiss (
            kind TEXT NOT NULL,
            ref_key TEXT NOT NULL,
            PRIMARY KEY (kind, ref_key)
        );
        CREATE TABLE IF NOT EXISTS session_hidden (
            work_id TEXT PRIMARY KEY,
            FOREIGN KEY (work_id) REFERENCES active_work(id) ON DELETE CASCADE
        );
        """
    )
    conn.execute(
        "INSERT OR IGNORE INTO meta (key, value) VALUES ('schema_version', '1')"
    )


def _format_title(task: dict[str, Any]) -> str:
    title = str(task["title"]).strip()
    pr_number = task.get("pr_number")
    pr_url = task.get("pr_url")
    if isinstance(pr_number, int) and isinstance(pr_url, str) and pr_url.strip():
        title = f"[PR #{pr_number}]({pr_url.strip()}) {title}"
    return f"**{title}**"


def _format_extras(task: dict[str, Any]) -> str:
    parts: list[str] = []
    for pr in json.loads(task.get("prs_json") or "[]"):
        if not isinstance(pr, dict):
            continue
        num = pr.get("number")
        url = pr.get("url")
        if isinstance(num, int) and isinstance(url, str) and url.strip():
            parts.append(f"[#{num}]({url.strip()})")
    branch = task.get("branch")
    if isinstance(branch, str) and branch.strip():
        parts.append(f"`{branch.strip()}`")
    worktree = task.get("worktree")
    if isinstance(worktree, str) and worktree.strip():
        parts.append(f"worktree `{worktree.strip()}`")
    notes = task.get("notes")
    if isinstance(notes, str) and notes.strip():
        parts.append(notes.strip())
    return " ".join(parts)


def task_to_label(row: sqlite3.Row) -> str:
    task = dict(row)
    chunks = [_format_title(task), str(task["status"]).strip()]
    repo = task.get("repo")
    if isinstance(repo, str) and repo.strip():
        chunks.append(f"`{repo.strip()}`")
    extras = _format_extras(task)
    if extras:
        chunks.append(extras)
    return " — ".join(chunks)


def validate_row(row: sqlite3.Row, index: int) -> None:
    title = row["title"]
    status = row["status"]
    if not isinstance(title, str) or not title.strip():
        raise ActiveTasksValidationError(f"active_work[{index}].title must be non-empty")
    if not isinstance(status, str) or not status.strip():
        raise ActiveTasksValidationError(f"active_work[{index}].status must be non-empty")
    repo = row["repo"]
    if repo is not None and (not isinstance(repo, str) or repo.strip() not in VALID_REPOS):
        raise ActiveTasksValidationError(
            f"active_work[{index}].repo must be one of {sorted(VALID_REPOS)}"
        )
    pr_num = row["pr_number"]
    if pr_num is not None and not isinstance(pr_num, int):
        raise ActiveTasksValidationError(f"active_work[{index}].pr_number must be int")
    for field in ("prs_json", "links_json"):
        raw = row[field]
        try:
            parsed = json.loads(raw or "[]")
        except json.JSONDecodeError as err:
            raise ActiveTasksValidationError(
                f"active_work[{index}].{field} invalid JSON"
            ) from err
        if not isinstance(parsed, list):
            raise ActiveTasksValidationError(
                f"active_work[{index}].{field} must be a JSON array"
            )
    prs = json.loads(row["prs_json"] or "[]")
    for j, pr in enumerate(prs):
        if not isinstance(pr, dict):
            raise ActiveTasksValidationError(f"active_work[{index}].prs_json[{j}] must be object")
        if not isinstance(pr.get("number"), int):
            raise ActiveTasksValidationError(
                f"active_work[{index}].prs_json[{j}].number must be int"
            )
        url = pr.get("url")
        if not isinstance(url, str) or not url.strip():
            raise ActiveTasksValidationError(
                f"active_work[{index}].prs_json[{j}].url must be non-empty string"
            )


def validate_db() -> None:
    conn = connect()
    try:
        ensure_schema(conn)
        rows = conn.execute(
            "SELECT * FROM active_work ORDER BY sort_order ASC"
        ).fetchall()
        if len(rows) > 8:
            raise ActiveTasksValidationError(
                f"active_work has {len(rows)} rows; keep roughly 3–8"
            )
        for i, row in enumerate(rows):
            validate_row(row, i)
    finally:
        conn.close()


def row_to_item(row: sqlite3.Row) -> dict[str, Any]:
    label = task_to_label(row)
    item: dict[str, Any] = {
        "id": row["id"],
        "label": label,
        "title": row["title"],
        "status": row["status"],
        "repo": row["repo"],
        "done": bool(row["done"]),
    }
    if row["pr_number"] is not None:
        item["pr_number"] = row["pr_number"]
    if row["pr_url"]:
        item["pr_url"] = row["pr_url"]
    if row["branch"]:
        item["branch"] = row["branch"]
    if row["worktree"]:
        item["worktree"] = row["worktree"]
    if row["notes"]:
        item["notes"] = row["notes"]
    prs = json.loads(row["prs_json"] or "[]")
    if prs:
        item["prs"] = prs
    links = json.loads(row["links_json"] or "[]")
    if links:
        item["links"] = links
    return item


def list_items() -> list[dict[str, Any]]:
    conn = connect()
    try:
        ensure_schema(conn)
        hidden = {
            r["work_id"]
            for r in conn.execute("SELECT work_id FROM session_hidden").fetchall()
        }
        rows = conn.execute(
            "SELECT * FROM active_work ORDER BY sort_order ASC, updated_at DESC"
        ).fetchall()
        items = [row_to_item(r) for r in rows]
        for item in items:
            if item["id"] in hidden:
                item["done"] = True
        return items
    finally:
        conn.close()


def clear_session_hidden() -> None:
    conn = connect()
    try:
        ensure_schema(conn)
        conn.execute("DELETE FROM session_hidden")
        conn.commit()
    finally:
        conn.close()


def set_meta(key: str, value: str) -> None:
    conn = connect()
    try:
        ensure_schema(conn)
        conn.execute(
            "INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)",
            (key, value),
        )
        conn.commit()
    finally:
        conn.close()


def main() -> int:
    if len(sys.argv) > 1 and sys.argv[1] == "validate":
        try:
            validate_db()
        except (ActiveTasksValidationError, sqlite3.Error) as err:
            print(err, file=sys.stderr)
            return 1
        print("ok")
        return 0
    if len(sys.argv) > 1 and sys.argv[1] == "items":
        sys.stdout.write(json.dumps(list_items(), ensure_ascii=False))
        return 0
    print("usage: active_tasks_db.py validate|items", file=sys.stderr)
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
