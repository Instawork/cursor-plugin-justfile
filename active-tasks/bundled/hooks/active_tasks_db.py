#!/usr/bin/env python3
"""Active work SQLite store (shared contract with Active Tasks VS Code extension)."""

from __future__ import annotations

import json
import os
import sqlite3
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

try:
    import tomllib
except ModuleNotFoundError:
    import tomli as tomllib  # type: ignore[no-redef]

DEFAULT_DB = Path.home() / "code/cursor-contexts/active-tasks.sqlite"
DEFAULT_TOML = Path.home() / "code/cursor-contexts/active-tasks.toml"
SCHEMA_VERSION = 2
VALID_REPOS = frozenset({"instawork", "finch", "infrastructure"})
VALID_STATUS_KEYS = frozenset(
    {"blocked", "review", "progress", "ready", "paused", "other"}
)


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
            tags_json TEXT NOT NULL DEFAULT '[]',
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
        "INSERT OR IGNORE INTO meta (key, value) VALUES ('schema_version', ?)",
        (str(SCHEMA_VERSION),),
    )
    conn.execute(
        "UPDATE meta SET value = ? WHERE key = 'schema_version' AND CAST(value AS INTEGER) < ?",
        (str(SCHEMA_VERSION), SCHEMA_VERSION),
    )
    _migrate_columns(conn)


def _infer_status_key(status: str) -> str:
    s = status.lower()
    if any(x in s for x in ("block", "fail", "red", "tach")):
        return "blocked"
    if any(x in s for x in ("review", "duncan", "waiting")):
        return "review"
    if any(x in s for x in ("progress", "step", "walkthrough", "active branch")):
        return "progress"
    if any(x in s for x in ("ready", "green", "merge", "ci green", "pushed")):
        return "ready"
    if "pause" in s:
        return "paused"
    return "other"


def _migrate_columns(conn: sqlite3.Connection) -> None:
    cols = {r[1] for r in conn.execute("PRAGMA table_info(active_work)")}
    if "tags_json" not in cols:
        conn.execute(
            "ALTER TABLE active_work ADD COLUMN tags_json TEXT NOT NULL DEFAULT '[]'"
        )
    v2 = [
        ("status_key", "TEXT NOT NULL DEFAULT 'other'"),
        ("priority", "INTEGER NOT NULL DEFAULT 1"),
        ("pinned", "INTEGER NOT NULL DEFAULT 0"),
        ("next_action", "TEXT"),
        ("waiting_on", "TEXT"),
        ("blocked_by_id", "TEXT"),
        ("parent_id", "TEXT"),
        ("cloud_agent_id", "TEXT"),
        ("created_at", "TEXT"),
        ("done_at", "TEXT"),
        ("done_reason", "TEXT"),
    ]
    for name, ddl in v2:
        if name not in cols:
            conn.execute(f"ALTER TABLE active_work ADD COLUMN {name} {ddl}")
    conn.execute(
        """
        UPDATE active_work
        SET created_at = updated_at
        WHERE created_at IS NULL OR TRIM(created_at) = ''
        """
    )
    for row in conn.execute("SELECT id, status, status_key FROM active_work"):
        if row[2] and row[2] != "other":
            continue
        inferred = _infer_status_key(str(row[1]))
        if inferred != "other":
            conn.execute(
                "UPDATE active_work SET status_key = ? WHERE id = ?",
                (inferred, row[0]),
            )
    conn.commit()


def _parse_tags_json(raw: str | None) -> list[str]:
    if not raw or not raw.strip():
        return []
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        return []
    if not isinstance(parsed, list):
        return []
    out: list[str] = []
    seen: set[str] = set()
    for item in parsed:
        if not isinstance(item, str):
            continue
        t = " ".join(item.strip().split())
        if not t or len(t) > 64:
            continue
        key = t.lower()
        if key in seen:
            continue
        seen.add(key)
        out.append(t)
    return out


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
    for tag in _parse_tags_json(task.get("tags_json")):
        parts.append("#" + tag)
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
        raise ActiveTasksValidationError(
            f"active_work[{index}].title must be non-empty"
        )
    if not isinstance(status, str) or not status.strip():
        raise ActiveTasksValidationError(
            f"active_work[{index}].status must be non-empty"
        )
    repo = row["repo"]
    if repo is not None and (
        not isinstance(repo, str) or repo.strip() not in VALID_REPOS
    ):
        raise ActiveTasksValidationError(
            f"active_work[{index}].repo must be one of {sorted(VALID_REPOS)}"
        )
    pr_num = row["pr_number"]
    if pr_num is not None and not isinstance(pr_num, int):
        raise ActiveTasksValidationError(f"active_work[{index}].pr_number must be int")
    for field in ("prs_json", "links_json", "tags_json"):
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
        if field == "tags_json":
            for j, tag in enumerate(parsed):
                if not isinstance(tag, str) or not tag.strip():
                    raise ActiveTasksValidationError(
                        f"active_work[{index}].tags_json[{j}] must be non-empty string"
                    )
    prs = json.loads(row["prs_json"] or "[]")
    for j, pr in enumerate(prs):
        if not isinstance(pr, dict):
            raise ActiveTasksValidationError(
                f"active_work[{index}].prs_json[{j}] must be object"
            )
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
        "status_key": row["status_key"] if "status_key" in row.keys() else "other",
        "priority": row["priority"] if "priority" in row.keys() else 1,
        "pinned": bool(row["pinned"]) if "pinned" in row.keys() else False,
        "repo": row["repo"],
        "done": bool(row["done"]),
    }
    for optional in (
        "next_action",
        "waiting_on",
        "blocked_by_id",
        "parent_id",
        "cloud_agent_id",
        "created_at",
        "updated_at",
    ):
        if optional in row.keys() and row[optional]:
            item[optional] = row[optional]
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
    tags = _parse_tags_json(row["tags_json"] if row["tags_json"] else "[]")
    if tags:
        item["tags"] = tags
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
            "SELECT * FROM active_work ORDER BY pinned DESC, priority DESC, sort_order ASC, updated_at DESC"
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


def _links_json(raw: Any) -> str:
    if not isinstance(raw, list):
        return "[]"
    out: list[Any] = []
    for link in raw:
        if isinstance(link, str) and link.strip():
            out.append({"label": link.strip(), "url": link.strip()})
        elif isinstance(link, dict) and isinstance(link.get("url"), str):
            url = link["url"].strip()
            label = link.get("label")
            if isinstance(label, str) and label.strip():
                out.append({"label": label.strip(), "url": url})
            else:
                out.append({"label": url, "url": url})
    return json.dumps(out)


def import_toml_if_empty(toml_path: Path | None = None) -> int:
    """One-time import when SQLite has no rows. Returns rows imported."""
    src = toml_path or DEFAULT_TOML
    conn = connect()
    try:
        ensure_schema(conn)
        count = conn.execute("SELECT COUNT(*) FROM active_work").fetchone()[0]
        if count > 0:
            return 0
        if not src.is_file():
            return 0
        doc = tomllib.loads(src.read_text(encoding="utf-8"))
        if doc.get("schema_version") != 1:
            return 0
        rows = doc.get("active_work")
        if not isinstance(rows, list):
            return 0
        ts = datetime.now(timezone.utc).isoformat()
        insert_sql = """
            INSERT INTO active_work (
              id, sort_order, title, status, repo, branch, worktree, notes,
              pr_number, pr_url, prs_json, links_json, tags_json, done, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """
        imported = 0
        for index, raw in enumerate(rows):
            if not isinstance(raw, dict):
                continue
            title = raw.get("title")
            status = raw.get("status")
            if not isinstance(title, str) or not isinstance(status, str):
                continue
            if not title.strip() or not status.strip():
                continue
            repo = raw.get("repo")
            repo_val = (
                repo.strip()
                if isinstance(repo, str) and repo.strip() in VALID_REPOS
                else None
            )
            branch = raw.get("branch")
            worktree = raw.get("worktree")
            notes = raw.get("notes")
            pr_number = raw.get("pr_number")
            pr_url = raw.get("pr_url")
            prs = raw.get("prs") if isinstance(raw.get("prs"), list) else []
            links = _links_json(raw.get("links"))
            conn.execute(
                insert_sql,
                (
                    str(uuid.uuid4()),
                    index,
                    title.strip(),
                    status.strip(),
                    repo_val,
                    branch.strip()
                    if isinstance(branch, str) and branch.strip()
                    else None,
                    worktree.strip()
                    if isinstance(worktree, str) and worktree.strip()
                    else None,
                    notes.strip() if isinstance(notes, str) and notes.strip() else None,
                    pr_number if isinstance(pr_number, int) else None,
                    pr_url.strip()
                    if isinstance(pr_url, str) and pr_url.strip()
                    else None,
                    json.dumps(prs),
                    links,
                    "[]",
                    1 if raw.get("done") else 0,
                    ts,
                ),
            )
            imported += 1
        if imported:
            conn.execute(
                "INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)",
                ("migrated_from_toml", str(src)),
            )
            conn.commit()
        return imported
    finally:
        conn.close()


def _open_order_ids(conn: sqlite3.Connection) -> list[str]:
    rows = conn.execute(
        """
        SELECT id FROM active_work WHERE done = 0
        ORDER BY pinned DESC, priority DESC, sort_order ASC, updated_at DESC
        """
    ).fetchall()
    return [str(r["id"]) for r in rows]


def _parent_map(conn: sqlite3.Connection) -> dict[str, str | None]:
    rows = conn.execute(
        "SELECT id, parent_id FROM active_work WHERE done = 0"
    ).fetchall()
    out: dict[str, str | None] = {}
    for r in rows:
        pid = r["parent_id"]
        if isinstance(pid, str) and pid.strip():
            out[str(r["id"])] = pid.strip()
        else:
            out[str(r["id"])] = None
    return out


def _is_under_ancestor(
    parent_map: dict[str, str | None], node_id: str, ancestor_id: str
) -> bool:
    cur: str | None = node_id
    while cur:
        if cur == ancestor_id:
            return True
        cur = parent_map.get(cur)
    return False


def _insert_after_subtree(
    order: list[str],
    parent_id: str,
    child_id: str,
    parent_map: dict[str, str | None],
) -> list[str]:
    without = [x for x in order if x != child_id]
    try:
        idx = without.index(parent_id)
    except ValueError:
        without.append(child_id)
        return without
    end = idx + 1
    while end < len(without) and _is_under_ancestor(
        parent_map, without[end], parent_id
    ):
        end += 1
    without.insert(end, child_id)
    return without


def merge_work_rows(primary_id: str, *merge_ids: str) -> bool:
    """Nest merge rows under primary via parent_id (rows are kept)."""
    sources = [m for m in merge_ids if m and m != primary_id]
    if not sources:
        return False
    conn = connect()
    try:
        ensure_schema(conn)
        primary = conn.execute(
            "SELECT id, done FROM active_work WHERE id = ?", (primary_id,)
        ).fetchone()
        if primary is None or primary["done"]:
            return False
        parent_map = _parent_map(conn)
        order = _open_order_ids(conn)
        ts = datetime.now(timezone.utc).isoformat()
        for source_id in sources:
            row = conn.execute(
                "SELECT id, done FROM active_work WHERE id = ?", (source_id,)
            ).fetchone()
            if row is None or row["done"]:
                continue
            if _is_under_ancestor(parent_map, primary_id, source_id):
                return False
            conn.execute(
                "UPDATE active_work SET parent_id = ?, updated_at = ? WHERE id = ?",
                (primary_id, ts, source_id),
            )
            parent_map[source_id] = primary_id
            order = _insert_after_subtree(order, primary_id, source_id, parent_map)
        for idx, row_id in enumerate(order):
            conn.execute(
                "UPDATE active_work SET sort_order = ?, updated_at = ? WHERE id = ?",
                (idx, ts, row_id),
            )
        conn.commit()
        return True
    finally:
        conn.close()


def consolidation_brief() -> dict[str, Any]:
    items = list_items()
    open_items = [i for i in items if not i.get("done")]
    merge_cli = (
        "python3.11 ~/code/cursor-contexts/scripts/active_tasks_db.py "
        "merge-work PRIMARY_UUID MERGE_UUID …"
    )
    return {
        "open_count": len(open_items),
        "target_min": 3,
        "target_max": 8,
        "needs_agent_consolidation": len(open_items) > 8,
        "merge_cli": merge_cli,
        "rows": open_items,
    }


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
    if len(sys.argv) > 1 and sys.argv[1] == "import-toml-if-empty":
        path = Path(sys.argv[2]) if len(sys.argv) > 2 else DEFAULT_TOML
        n = import_toml_if_empty(path)
        print(n)
        return 0
    if len(sys.argv) > 1 and sys.argv[1] == "merge-work":
        if len(sys.argv) < 4:
            print("usage: merge-work PRIMARY_ID MERGE_ID [MERGE_ID…]", file=sys.stderr)
            return 2
        ok = merge_work_rows(sys.argv[2], *sys.argv[3:])
        print("ok" if ok else "failed")
        return 0 if ok else 1
    if len(sys.argv) > 1 and sys.argv[1] == "consolidation-brief":
        sys.stdout.write(
            json.dumps(consolidation_brief(), ensure_ascii=False, indent=2)
        )
        return 0
    print(
        "usage: active_tasks_db.py validate|items|import-toml-if-empty [toml-path]|merge-work PRIMARY MERGE…|consolidation-brief",
        file=sys.stderr,
    )
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
