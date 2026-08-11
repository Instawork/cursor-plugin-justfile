#!/usr/bin/env python3
"""Active Tasks: session digest + occasional board refresh.

Fail-open. Events: sessionStart (digest every time; maybe rewrite board),
afterAgentResponse (turn counter; maybe rewrite board; no digest).

Roster SoT: Active Tasks SQLite via canonical
~/code/cursor-contexts/scripts/active_tasks_db.py
Board: ~/code/cursor-contexts/active-tasks.md
Throttle: 30 minutes OR every 15 agent turns (whichever first).
"""

from __future__ import annotations

import importlib.util
import json
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

HOOK_DIR = Path(__file__).resolve().parent
STATE_PATH = HOOK_DIR / "state" / "active_tasks_hook.json"
BOARD_PATH = Path.home() / "code/cursor-contexts/active-tasks.md"
ACTIVE_TASKS_DB = Path(
    os.environ.get(
        "ACTIVE_TASKS_DB_PATH",
        str(Path.home() / "code/cursor-contexts/active-tasks.sqlite"),
    )
)
ACTIVE_TASKS_DB_MODULE = Path.home() / "code/cursor-contexts/scripts/active_tasks_db.py"
SCHEMA_PATH = Path.home() / "code/cursor-contexts/active-tasks.schema.toml"
CLI = "python3 ~/code/cursor-contexts/scripts/active_tasks_db.py"
MAX_OPEN = 8
RECENT_DONE_MAX = 12
RECENT_DONE_DAYS = 14
BOARD_TTL_SEC = 30 * 60
TURNS_PER_REFRESH = 15


def _load_module(name: str, path: Path):
    if not path.is_file():
        return None
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        return None
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    try:
        spec.loader.exec_module(mod)
    except Exception:
        sys.modules.pop(name, None)
        return None
    return mod


def _load_state() -> dict[str, Any]:
    try:
        if STATE_PATH.is_file():
            data = json.loads(STATE_PATH.read_text(encoding="utf-8"))
            if isinstance(data, dict):
                return data
    except Exception:
        pass
    return {"last_board_at": 0.0, "turn_count": 0}


def _save_state(state: dict[str, Any]) -> None:
    try:
        STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
        STATE_PATH.write_text(
            json.dumps(state, indent=2, ensure_ascii=False) + "\n",
            encoding="utf-8",
        )
    except Exception:
        pass


def _open_plans(directory: Path | None = None) -> list:
    resolver = _load_module("plan_resolver", HOOK_DIR / "plan_resolver.py")
    if resolver is None:
        return []
    try:
        plans = resolver.list_plans(directory)
    except Exception:
        return []
    open_plans = [p for p in plans if getattr(p, "status", "") != "done"]
    open_plans.sort(key=lambda p: getattr(p, "mtime", 0), reverse=True)
    return open_plans[:MAX_OPEN]


def _list_all_items() -> list[dict]:
    db_mod = _load_module("active_tasks_db", ACTIVE_TASKS_DB_MODULE)
    if db_mod is None:
        return []
    try:
        return list(db_mod.list_items())
    except Exception:
        return []


def _open_active_tasks(limit: int = MAX_OPEN) -> list[dict]:
    pending = [i for i in _list_all_items() if not i.get("done")]
    return pending[:limit]


def _parse_iso_ms(raw: object) -> float | None:
    if not isinstance(raw, str) or not raw.strip():
        return None
    text = raw.strip().replace("Z", "+00:00")
    try:
        return datetime.fromisoformat(text).timestamp() * 1000.0
    except ValueError:
        return None


def _recent_done_tasks(limit: int = RECENT_DONE_MAX) -> list[dict]:
    now_ms = time.time() * 1000.0
    window_ms = RECENT_DONE_DAYS * 24 * 60 * 60 * 1000.0
    done_rows = [i for i in _list_all_items() if i.get("done")]
    scored: list[tuple[float, dict]] = []
    for item in done_rows:
        ts = _parse_iso_ms(item.get("done_at")) or _parse_iso_ms(item.get("updated_at"))
        if ts is None:
            ts = now_ms
        if now_ms - ts > window_ms:
            continue
        scored.append((ts, item))
    scored.sort(key=lambda pair: pair[0], reverse=True)
    return [item for _, item in scored[:limit]]


def _format_row(item: dict) -> str:
    label = item.get("label") or item.get("title") or "Untitled"
    bits = [f"- {label}"]
    status_key = (item.get("status_key") or "").strip()
    if status_key:
        bits.append(f"`{status_key}`")
    next_action = (item.get("next_action") or "").strip()
    if next_action:
        bits.append(f"next: {next_action}")
    return " · ".join(bits) if len(bits) > 1 else bits[0]


def _format_done_row(item: dict) -> str:
    label = item.get("label") or item.get("title") or "Untitled"
    bits = [f"- {label}"]
    repo = (item.get("repo") or "").strip()
    pr_number = item.get("pr_number")
    if repo and isinstance(pr_number, int):
        bits.append(f"`{repo}#{pr_number}`")
    elif item.get("pr_url"):
        bits.append(str(item.get("pr_url")).strip())
    branch = (item.get("branch") or "").strip()
    if branch:
        bits.append(f"branch `{branch}`")
    worktree = (item.get("worktree") or "").strip()
    if worktree:
        bits.append(f"wt `{worktree}`")
    row_id = (item.get("id") or "").strip()
    if row_id:
        bits.append(f"id=`{row_id}`")
    return " · ".join(bits)


def build_additional_context(plans: list) -> str:
    if plans:
        lines = []
        for p in plans:
            title = getattr(p, "title", None) or p.path.stem
            status = getattr(p, "status", "draft")
            path = getattr(p, "path", None)
            path_s = str(path) if path else title
            lines.append(f"- `{status}` **{title}** — `{path_s}`")
        open_block = "\n".join(lines)
    else:
        open_block = (
            "(none — create a plan via living-spec when starting design-first work)"
        )

    try:
        rows = _open_active_tasks()
    except Exception:
        rows = []

    try:
        recent_done = _recent_done_tasks()
    except Exception:
        recent_done = []

    if rows:
        task_block = "\n".join(_format_row(r) for r in rows)
    elif recent_done:
        task_block = (
            "(none open — do **not** recreate Recently done; reopen with "
            f"`{CLI} set <id> done=0` or the Done filter if needed)"
        )
    else:
        task_block = f'(none — add via Active Tasks panel or `{CLI} add "…"`)'

    if recent_done:
        done_block = "\n".join(_format_done_row(r) for r in recent_done)
        done_section = (
            f"\n**Recently done (do NOT recreate — ≤{RECENT_DONE_MAX} or last "
            f"{RECENT_DONE_DAYS}d):**\n{done_block}\n\n"
            "Rules:\n"
            "- Never `add` / quick-add a new row that matches Recently done by PR, "
            "branch, worktree, **or the same title**.\n"
            "- A worktree / PR whose only roster row is done is **finished**, not an orphan.\n"
            "- An open plan with no open row is **not** a reason to mint a new Active Task "
            "if Recently done already covers that initiative — mark the plan `status: done` "
            "or reopen the existing row (`done=0`) instead.\n"
            "- To reopen: Done filter in the panel, or CLI `set <id> done=0` — never a second UUID.\n"
        )
    else:
        done_section = ""

    return (
        "## Open work (sessionStart)\n\n"
        "Source of truth for **what is in flight**: Active Tasks SQLite "
        f"(`{ACTIVE_TASKS_DB}`; fields `{SCHEMA_PATH}`; CLI `{CLI}`). "
        "Do **not** use memory `add_task` / `list_tasks` for work state — facts only. "
        "**TodoWrite** owns the in-thread checklist. `~/.cursor/plans/*.plan.md` are "
        "design artifacts — the design-first gate reads them, so they are still required "
        "before app-code writes.\n\n"
        "Agent-readable board: "
        f"`{BOARD_PATH}` (refreshed by this hook every {BOARD_TTL_SEC // 60}m "
        f"or every {TURNS_PER_REFRESH} agent turns).\n\n"
        "Call **TodoWrite** once with `merge: false` for the current initiative's "
        "checklist items (from the bound plan when present).\n"
        f"\n**Open Active Tasks (≤{MAX_OPEN}):**\n{task_block}\n"
        f"{done_section}"
        f"\n**Open plans (≤{MAX_OPEN}, newest first):**\n{open_block}\n"
    )


def _bullet_rows(items: list[dict]) -> str:
    if not items:
        return "_None._"
    return "\n".join(_format_row(i) for i in items)


def _needs_you(items: list[dict]) -> list[dict]:
    out = []
    for i in items:
        key = (i.get("status_key") or "").strip()
        waiting = (i.get("waiting_on") or "").strip()
        if key in ("blocked", "review") or waiting:
            out.append(i)
    return out


def render_board(items: list[dict], generated_at: str) -> str:
    open_items = [i for i in items if not i.get("done")]
    needs = _needs_you(open_items)
    progress = [i for i in open_items if (i.get("status_key") or "") == "progress"]
    prioritized = [i for i in open_items if (i.get("status_key") or "") == "prioritized"]
    in_flight = [i for i in open_items if (i.get("cloud_agent_id") or "").strip()]
    listed_ids = {i["id"] for i in needs + progress + prioritized + in_flight}
    queued = [
        i
        for i in open_items
        if i.get("id") not in listed_ids and not (i.get("cloud_agent_id") or "").strip()
    ]

    return f"""# Active tasks — board

Agent-readable snapshot of the roster. **Not a source of truth.** The roster is
`active-tasks.sqlite` (`active_work` table; field reference in `active-tasks.schema.toml`).
Edit rows through the Active Tasks panel or `scripts/active_tasks_db.py` — never by editing
this file.

The panel is the human view of the same rows; this file exists because agents cannot see a
webview. Short pointer: `~/code/AGENTS.md` (Active Tasks section).

Generated by `active_tasks_hook.py` (every {BOARD_TTL_SEC // 60}m or every {TURNS_PER_REFRESH} agent turns).

---

Generated: {generated_at}

## Needs you

{_bullet_rows(needs)}

Blocked on me, review handed back, CI red, waiting_on set, or status blocked/review.

## In Progress

{_bullet_rows(progress)}

Open rows with `status_key=progress`.

## Prioritized

{_bullet_rows(prioritized)}

Open rows with `status_key=prioritized`.

## In flight

{_bullet_rows(in_flight)}

Rows with `cloud_agent_id` set.

## Queued

{_bullet_rows(queued)}

Remaining open rows with no agent, by roster sort — backlog and anything not already listed above.

## Drift

_Not derived in-hook (git worktree / gh / plan frontmatter stay on-demand)._

When checking live:

- **Finished, not orphan:** a worktree / PR whose only roster row is **done** — leave alone; do not `add`.
- **True orphan:** a worktree / PR with **no** roster row at all (open or done).
- **Plan hygiene:** open plan + Recently done already covers that initiative → mark the plan `status: done`, do not mint a new Active Task row.
- an open row with no plan (may still need a living-spec plan before app-code writes)
- a worktree that is dirty *and* cold (no recent commits)
- `cloud_agent_id` set with nothing actually running

None of this is written back into the roster.
"""


def _board_stale(state: dict[str, Any], *, force: bool = False) -> bool:
    if force:
        return True
    last = float(state.get("last_board_at") or 0)
    turns = int(state.get("turn_count") or 0)
    if turns >= TURNS_PER_REFRESH:
        return True
    if (time.time() - last) >= BOARD_TTL_SEC:
        return True
    return False


def maybe_write_board(state: dict[str, Any], *, force: bool = False) -> dict[str, Any]:
    if not _board_stale(state, force=force):
        return state
    try:
        items = _list_all_items()
        stamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        BOARD_PATH.parent.mkdir(parents=True, exist_ok=True)
        BOARD_PATH.write_text(render_board(items, stamp), encoding="utf-8")
        state = dict(state)
        state["last_board_at"] = time.time()
        state["turn_count"] = 0
        _save_state(state)
    except Exception as exc:
        sys.stderr.write(f"active_tasks_hook: board write failed: {exc}\n")
    return state


def run_session_start(_payload: dict) -> dict:
    state = _load_state()
    maybe_write_board(state)
    try:
        plans = _open_plans()
    except Exception:
        plans = []
    return {"additional_context": build_additional_context(plans)}


def run_after_agent_response(_payload: dict) -> dict:
    state = _load_state()
    state = dict(state)
    state["turn_count"] = int(state.get("turn_count") or 0) + 1
    _save_state(state)
    maybe_write_board(state)
    return {}


def main() -> int:
    try:
        raw = sys.stdin.read()
        payload = json.loads(raw) if raw.strip() else {}
    except Exception as exc:
        sys.stderr.write(f"active_tasks_hook: stdin parse failed: {exc}\n")
        print("{}")
        return 0

    if not isinstance(payload, dict):
        payload = {}

    event = payload.get("hook_event_name") or payload.get("event") or ""
    # Empty/missing event: treat as sessionStart so install smoke and old callers work.
    try:
        if event in ("", "sessionStart"):
            out = run_session_start(payload)
        elif event == "afterAgentResponse":
            out = run_after_agent_response(payload)
        else:
            out = {}
    except Exception as exc:
        sys.stderr.write(f"active_tasks_hook: failed: {exc}\n")
        print("{}")
        return 0

    print(json.dumps(out or {}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
