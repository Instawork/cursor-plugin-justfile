#!/usr/bin/env python3
"""On sessionStart, inject active work from SQLite (no JSON snapshot)."""

from __future__ import annotations

import importlib.util
import json
import os
import sys
from pathlib import Path

ACTIVE_TASKS_DB = Path(
    os.environ.get(
        "ACTIVE_TASKS_DB_PATH",
        str(Path.home() / "code/cursor-contexts/active-tasks.sqlite"),
    )
)
RULE_PATH = Path.home() / ".cursor/rules/active-tasks.mdc"
SCHEMA_PATH = Path.home() / "code/cursor-contexts/active-tasks.schema.toml"
MERGE_CLI = (
    "python3.11 ~/code/cursor-contexts/scripts/active_tasks_db.py "
    "merge-work PRIMARY_UUID MERGE_UUID …"
)


def _load_db_module():
    hook_dir = Path(__file__).resolve().parent
    candidate = hook_dir / "active_tasks_db.py"
    if not candidate.is_file():
        return None
    spec = importlib.util.spec_from_file_location("active_tasks_db", candidate)
    if spec is None or spec.loader is None:
        return None
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _agent_consolidation_block(pending: list[dict]) -> str:
    if len(pending) <= 8:
        return ""
    id_lines = "\n".join(
        f"- `{i['id']}` {i.get('title', i.get('label', ''))}" for i in pending
    )
    return (
        f"\n\n**Consolidate (agent — {len(pending)} open, target 3–8):** "
        "Decide which rows are the same initiative (semantic). Merge each group with:\n\n"
        f"```bash\n{MERGE_CLI}\n```\n\n"
        f"Row ids:\n{id_lines}\n\n"
        "Or run `active_tasks_db.py consolidation-brief` · panel **Copy brief for Agent**.\n"
    )


def build_additional_context(items: list[dict]) -> str:
    pending = [i for i in items if not i.get("done")]
    done = [i for i in items if i.get("done")]
    open_lines = "\n".join(f"- {i['label']}" for i in pending) if pending else "(none)"
    done_lines = "\n".join(f"- {i['label']}" for i in done) if done else "(none)"
    return (
        "## Active work (sessionStart)\n\n"
        f"Policy: `{RULE_PATH}` · fields: `{SCHEMA_PATH}` · DB: `{ACTIVE_TASKS_DB}`\n\n"
        "Call **TodoWrite** once with `merge: false`: one todo per **open** row below (use each **label** as "
        "`content`). Set `completed` only for **Already done**; all others `pending`.\n\n"
        "Keep **3–8** open initiatives. **Merging related work is agent judgment** (multi-repo, paired PRs); "
        "the panel only auto-suggests duplicate branch/worktree/PR links.\n"
        f"{_agent_consolidation_block(pending)}"
        f"\n**Open ({len(pending)}):**\n{open_lines}\n\n"
        f"**Already done (DB or hidden this session):**\n{done_lines}"
    )


def run_session_start(payload: dict) -> dict | None:
    db_mod = _load_db_module()
    if db_mod is None:
        return None
    db_mod.clear_session_hidden()
    session_id = payload.get("session_id") or payload.get("conversation_id")
    if session_id:
        db_mod.set_meta("last_session_id", str(session_id))
    items = db_mod.list_items()
    if not items:
        return None
    return {"additional_context": build_additional_context(items)}


def main() -> int:
    raw = sys.stdin.read()
    if not raw.strip():
        return 0
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError:
        return 0
    event = payload.get("hook_event_name") or ""
    if event == "sessionStart":
        out = run_session_start(payload)
        if out:
            sys.stdout.write(json.dumps(out, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
