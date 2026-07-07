#!/usr/bin/env python3
"""Token telemetry → append-only CSV (no agent context, no chat by default)."""

from __future__ import annotations

import argparse
import csv
import json
import os
import re
import sys
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

from model_pricing import model_effective_usd_per_m, price_mode_normalized

STATE_PATH = Path.home() / "code/cursor-contexts/assistant/token-hook-state.json"
TITLES_PATH = (
    Path.home() / "code/cursor-contexts/assistant/token-conversation-titles.json"
)
CSV_PATH = Path.home() / "code/cursor-contexts/assistant/token-telemetry.csv"
UUID_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.I
)
CHAT_PREFIX = "↳ Hook · "
HOOK_DIR = Path(__file__).resolve().parent
if str(HOOK_DIR) not in sys.path:
    sys.path.insert(0, str(HOOK_DIR))

from token_telemetry_db import insert_turn_from_append, sql_enabled  # noqa: E402

DASHBOARD_TEMPLATE = HOOK_DIR / "token-telemetry-dashboard.tpl.html"

CSV_HEADER = (
    "at",
    "event",
    "model",
    "conversation_id",
    "generation_id",
    "input_uncached_tokens",
    "cache_read_tokens",
    "cache_write_tokens",
    "output_tokens",
    "total_tokens",
    "cost_usd",
    "cumulative_total_tokens",
    "cumulative_output_tokens",
    "cumulative_cost_usd",
    "context_usage_percent",
    "conversation",
)

COL = {name: i for i, name in enumerate(CSV_HEADER)}

BILLABLE_TURN_EVENTS = frozenset({"agentTurn", "cloudRun"})

SUM_COLUMNS = (
    "input_uncached_tokens",
    "cache_read_tokens",
    "cache_write_tokens",
    "output_tokens",
    "total_tokens",
)

STATE_KEYS = (
    "updated_at",
    "conversation_id",
    "generation_id",
    "model",
    "cumulative_day",
    "cumulative_total_tokens",
    "cumulative_output_tokens",
    "cumulative_cost_usd",
    "logged_generations",
    "last_input_total_tokens",
    "last_output_tokens",
    "last_cache_read_tokens",
    "last_cache_write_tokens",
    "context_usage_percent",
    "conversation_title",
)


def env_flag(name: str, default: str = "0") -> bool:
    return os.environ.get(name, default).lower() not in ("0", "false", "no")


def csv_path() -> Path:
    raw = os.environ.get("TOKEN_HOOK_CSV", "").strip()
    return Path(raw).expanduser() if raw else CSV_PATH


def int_or_none(value: object) -> int | None:
    if value is None:
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def load_state() -> dict:
    if STATE_PATH.is_file():
        try:
            return json.loads(STATE_PATH.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            pass
    return {}


def save_state(state: dict) -> None:
    STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
    slim = {k: state[k] for k in STATE_KEYS if k in state}
    STATE_PATH.write_text(
        json.dumps(slim, separators=(",", ":")) + "\n", encoding="utf-8"
    )


def reset_telemetry() -> None:
    path = csv_path()
    write_csv_rows(path, list(CSV_HEADER), [])
    archive = path.with_name(path.stem + ".archive" + path.suffix)
    if archive.is_file():
        archive.unlink()
    save_state({})
    write_telemetry_html(path, {})


def csv_retention_days() -> int:
    raw = os.environ.get("TOKEN_HOOK_CSV_RETENTION_DAYS", "30").strip()
    try:
        return max(0, int(raw))
    except ValueError:
        return 30


def parse_row_date(at: str) -> date | None:
    if not at:
        return None
    try:
        text = at[:-1] + "+00:00" if at.endswith("Z") else at
        dt = datetime.fromisoformat(text)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.astimezone(timezone.utc).date()
    except ValueError:
        if len(at) >= 10:
            try:
                return date.fromisoformat(at[:10])
            except ValueError:
                return None
        return None


def cell_float(row: list[str], idx: int) -> float:
    if idx >= len(row) or not row[idx]:
        return 0.0
    try:
        return float(row[idx])
    except ValueError:
        return 0.0


def cell_int(row: list[str], idx: int) -> int:
    if idx >= len(row) or not row[idx]:
        return 0
    try:
        return int(float(row[idx]))
    except ValueError:
        return 0


def csv_tail_rows() -> int:
    raw = os.environ.get("TOKEN_HOOK_CSV_TAIL_ROWS", "50").strip()
    try:
        return max(0, int(raw))
    except ValueError:
        return 50


def parse_row_datetime(at: str) -> datetime | None:
    if not at:
        return None
    try:
        text = at[:-1] + "+00:00" if at.endswith("Z") else at
        dt = datetime.fromisoformat(text)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.astimezone(timezone.utc)
    except ValueError:
        return None


def sort_rows(rows: list[list[str]]) -> list[list[str]]:
    return sorted(rows, key=lambda r: r[0] if r else "")


def usage_from_payload(
    inp_total: int, out: int, cache_r: int, cache_w: int
) -> tuple[int, int, int, int, int]:
    uncached = max(0, inp_total - cache_r - cache_w)
    total = uncached + cache_r + cache_w + out
    return uncached, cache_r, cache_w, out, total


def price_mode() -> str:
    return price_mode_normalized()


def price_rates() -> tuple[float, float, float, float]:
    return (
        float(os.environ.get("TOKEN_HOOK_PRICE_INPUT_M", "0.25")),
        float(os.environ.get("TOKEN_HOOK_PRICE_OUTPUT_M", "1.25")),
        float(os.environ.get("TOKEN_HOOK_PRICE_CACHE_READ_M", "0.06")),
        float(os.environ.get("TOKEN_HOOK_PRICE_CACHE_WRITE_M", "0.25")),
    )


def cost_usd(
    uncached: int,
    out: int,
    cache_r: int = 0,
    cache_w: int = 0,
    *,
    model: str = "",
) -> float:
    mode = price_mode()
    if mode == "decomposed":
        in_m, out_m, cr_m, cw_m = price_rates()
        return (
            uncached * in_m + out * out_m + cache_r * cr_m + cache_w * cw_m
        ) / 1_000_000
    total = uncached + cache_r + cache_w + out
    if mode == "model":
        rate = model_effective_usd_per_m(model)
    else:
        rate = float(os.environ.get("TOKEN_HOOK_PRICE_TOTAL_M", "0.35"))
    return total * rate / 1_000_000


def aggregate_rows(rows: list[list[str]], event: str) -> list[str]:
    ordered = sort_rows(rows)
    last = ordered[-1]
    row = [""] * len(CSV_HEADER)
    row[COL["at"]] = last[COL["at"]]
    row[COL["event"]] = event
    row[COL["model"]] = last[COL["model"]] if len(last) > COL["model"] else ""
    row[COL["conversation_id"]] = (
        last[COL["conversation_id"]] if len(last) > COL["conversation_id"] else ""
    )
    row[COL["generation_id"]] = ""
    for key in SUM_COLUMNS:
        row[COL[key]] = str(sum(cell_int(r, COL[key]) for r in ordered))
    row[COL["cost_usd"]] = str(
        round(sum(cell_float(r, COL["cost_usd"]) for r in ordered), 6)
    )
    row[COL["cumulative_total_tokens"]] = last[COL["cumulative_total_tokens"]]
    row[COL["cumulative_output_tokens"]] = last[COL["cumulative_output_tokens"]]
    row[COL["cumulative_cost_usd"]] = last[COL["cumulative_cost_usd"]]
    row[COL["context_usage_percent"]] = last[COL["context_usage_percent"]]
    if "conversation" in COL and len(last) > COL["conversation"]:
        row[COL["conversation"]] = last[COL["conversation"]]
    return row


def aggregate_hour_rows(rows: list[list[str]]) -> list[str]:
    return aggregate_rows(rows, "hourly")


def aggregate_day_rows(rows: list[list[str]]) -> list[str]:
    return aggregate_rows(rows, "daily")


def html_path() -> Path:
    raw = os.environ.get("TOKEN_HOOK_HTML", "").strip()
    if raw:
        return Path(raw).expanduser()
    return csv_path().with_name("token-telemetry.html")


def csv_rows_to_records(data: list[list[str]]) -> list[dict[str, object]]:
    int_cols = {
        "input_uncached_tokens",
        "cache_read_tokens",
        "cache_write_tokens",
        "output_tokens",
        "total_tokens",
        "cumulative_total_tokens",
        "cumulative_output_tokens",
    }
    float_cols = {"cost_usd", "cumulative_cost_usd", "context_usage_percent"}
    records: list[dict[str, object]] = []
    for row in data:
        rec: dict[str, object] = {}
        for i, key in enumerate(CSV_HEADER):
            if i >= len(row) or row[i] == "":
                rec[key] = None
                continue
            if key in int_cols:
                rec[key] = cell_int(row, i)
            elif key in float_cols:
                rec[key] = cell_float(row, i)
            else:
                rec[key] = row[i]
        records.append(rec)
    return records


def write_telemetry_html(csv_file: Path, state: dict) -> None:
    if not env_flag("TOKEN_HOOK_HTML", "1"):
        return
    if not DASHBOARD_TEMPLATE.is_file():
        return
    if csv_file.is_file():
        _, data = read_csv_rows(csv_file)
    else:
        data = []
    in_m, out_m, cr_m, cw_m = price_rates()
    payload = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "csvPath": str(csv_file),
        "priceMode": price_mode(),
        "rates": {
            "input": in_m,
            "output": out_m,
            "cacheRead": cr_m,
            "cacheWrite": cw_m,
            "total": float(os.environ.get("TOKEN_HOOK_PRICE_TOTAL_M", "0.35")),
        },
        "state": {
            "conversation_id": state.get("conversation_id"),
            "cumulative_total_tokens": state.get("cumulative_total_tokens"),
            "cumulative_output_tokens": state.get("cumulative_output_tokens"),
            "cumulative_cost_usd": state.get("cumulative_cost_usd"),
            "model": state.get("model"),
        },
        "rows": csv_rows_to_records(data),
    }
    tpl = DASHBOARD_TEMPLATE.read_text(encoding="utf-8")
    blob = json.dumps(payload, separators=(",", ":")).replace("<", "\\u003c")
    out_path = html_path()
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(
        tpl.replace("__TELEMETRY_JSON__", blob),
        encoding="utf-8",
    )


def read_csv_rows(path: Path) -> tuple[list[str], list[list[str]]]:
    with path.open(newline="", encoding="utf-8") as f:
        rows = list(csv.reader(f))
    if not rows:
        return list(CSV_HEADER), []
    header = rows[0]
    return header, rows[1:]


def write_csv_rows(path: Path, header: list[str], data: list[list[str]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="") as f:
        w = csv.writer(f)
        w.writerow(header)
        w.writerows(data)


def archive_csv_rows(path: Path, header: list[str], rows: list[list[str]]) -> None:
    if not rows:
        return
    archive = path.with_name(path.stem + ".archive" + path.suffix)
    if archive.is_file() and archive.stat().st_size > 0:
        with archive.open("a", encoding="utf-8", newline="") as f:
            csv.writer(f).writerows(rows)
    else:
        write_csv_rows(archive, header, rows)


def compact_head_rows(
    head: list[list[str]], today: date
) -> tuple[list[list[str]], list[list[str]]]:
    by_day: dict[date, list[list[str]]] = {}
    for row in head:
        if len(row) < 2:
            continue
        day = parse_row_date(row[0])
        if day is None:
            continue
        by_day.setdefault(day, []).append(row)

    retention = csv_retention_days()
    oldest = today - timedelta(days=retention - 1) if retention > 0 else None
    archived: list[list[str]] = []
    out: list[list[str]] = []

    for day in sorted(by_day.keys()):
        rows = by_day[day]
        if oldest is not None and day < oldest:
            archived.extend(rows)
            continue
        if day > today:
            continue
        if day == today:
            by_hour: dict[int, list[list[str]]] = {}
            for row in rows:
                dt = parse_row_datetime(row[0])
                hour = dt.hour if dt else 0
                by_hour.setdefault(hour, []).append(row)
            for hour in sorted(by_hour.keys()):
                bucket = by_hour[hour]
                if len(bucket) == 1:
                    out.append(bucket[0])
                else:
                    out.append(aggregate_hour_rows(bucket))
        else:
            out.append(aggregate_day_rows(rows))

    return sort_rows(out), archived


def maybe_compact_csv(path: Path) -> None:
    default = "0" if sql_enabled() else "1"
    if not env_flag("TOKEN_HOOK_CSV_COMPACT", default):
        return
    compact_csv(path)


def compact_csv(path: Path) -> int:
    if not path.is_file():
        return 0
    header, data = read_csv_rows(path)
    if not data:
        return 0

    data = sort_rows(data)
    tail_n = csv_tail_rows()
    if tail_n > 0 and len(data) <= tail_n:
        return 0

    head = data[:-tail_n] if tail_n > 0 else data
    tail = data[-tail_n:] if tail_n > 0 else []
    if not head:
        return 0

    today = datetime.now(timezone.utc).date()
    compacted_head, archived = compact_head_rows(head, today)
    out = sort_rows(compacted_head + tail)
    removed = len(data) - len(out)
    if removed <= 0 and out == data:
        return 0

    if env_flag("TOKEN_HOOK_CSV_ARCHIVE", "1") and archived:
        archive_csv_rows(path, header, archived)
    write_csv_rows(path, header, out)
    return max(0, removed)


def turn_generation_key(payload: dict) -> str:
    event = payload.get("hook_event_name") or ""
    if event == "subagentStop":
        sid = payload.get("subagent_id") or payload.get("tool_call_id")
        if sid:
            return f"subagent:{sid}"
    return str(payload.get("generation_id") or "")


def ingest_usage(state: dict, payload: dict) -> None:
    for src, dst in (
        ("input_tokens", "last_input_total_tokens"),
        ("output_tokens", "last_output_tokens"),
        ("cache_read_tokens", "last_cache_read_tokens"),
        ("cache_write_tokens", "last_cache_write_tokens"),
    ):
        val = int_or_none(payload.get(src))
        if val is not None:
            state[dst] = val
    tt = int_or_none(payload.get("total_tokens"))
    if tt is not None:
        state["last_payload_total_tokens"] = tt


def ensure_csv_header(path: Path) -> None:
    if path.is_file() and path.stat().st_size > 0:
        header, data = read_csv_rows(path)
        want = list(CSV_HEADER)
        if header != want and header and len(header) == len(want) - 1:
            if want[-1] == "conversation" and "conversation" not in header:
                data = [row + [""] for row in data]
                write_csv_rows(path, want, data)
                return
        if header == want:
            return
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="") as f:
        csv.writer(f).writerow(CSV_HEADER)


def cumulative_from_csv_for_day(path: Path, day: date) -> tuple[int, int, float]:
    if not path.is_file():
        return 0, 0, 0.0
    _, data = read_csv_rows(path)
    tot_tok = 0
    tot_out = 0
    cost = 0.0
    for row in data:
        if len(row) <= COL["event"]:
            continue
        if parse_row_date(row[COL["at"]]) != day:
            continue
        ev = row[COL["event"]]
        if ev not in ("agentTurn", "cloudRun", "hourly"):
            continue
        tot_tok += cell_int(row, COL["total_tokens"])
        tot_out += cell_int(row, COL["output_tokens"])
        cost += cell_float(row, COL["cost_usd"])
    return tot_tok, tot_out, round(cost, 6)


def ensure_daily_cumulative(state: dict) -> None:
    today = datetime.now(timezone.utc).date()
    tot_tok, tot_out, cost = cumulative_from_csv_for_day(csv_path(), today)
    state["cumulative_day"] = today.isoformat()
    state["cumulative_total_tokens"] = tot_tok
    state["cumulative_output_tokens"] = tot_out
    state["cumulative_cost_usd"] = cost


def row_conversation_label(state: dict, payload: dict) -> str:
    base = conversation_label(state)
    if (payload.get("hook_event_name") or "") != "subagentStop":
        return base
    desc = (
        payload.get("description")
        or payload.get("subagent_type")
        or payload.get("task")
        or "subagent"
    )
    suffix = normalize_conversation_title(str(desc).split("\n", 1)[0])
    if base and suffix:
        return f"{base} · {suffix}"
    return suffix or base


def _pick_int(source: dict, *keys: str) -> int:
    for key in keys:
        val = int_or_none(source.get(key))
        if val is not None:
            return val
    return 0


def usage_numbers_from_ingest(body: dict) -> tuple[int, int, int, int]:
    usage = body.get("usage")
    if not isinstance(usage, dict):
        usage = body
    inp = _pick_int(usage, "input_tokens", "inputTokens")
    out = _pick_int(usage, "output_tokens", "outputTokens")
    cache_r = _pick_int(usage, "cache_read_tokens", "cacheReadTokens")
    cache_w = _pick_int(usage, "cache_write_tokens", "cacheWriteTokens")
    if inp == 0 and out == 0 and cache_r == 0 and cache_w == 0:
        total = _pick_int(usage, "total_tokens", "totalTokens")
        if total > 0:
            out = total
    return inp, out, cache_r, cache_w


def append_billable_row(
    state: dict,
    *,
    event: str,
    generation_id: str,
    conversation_id: str,
    model: str,
    at: str | None,
    conversation: str,
    inp_total: int,
    out: int,
    cache_r: int,
    cache_w: int,
    context_usage_percent: float | None = None,
) -> bool:
    logged = state.get("logged_generations")
    if not isinstance(logged, list):
        logged = []
    gen = generation_id
    if event in BILLABLE_TURN_EVENTS and gen and gen in logged:
        return False

    uncached, cache_r, cache_w, out, total = usage_from_payload(
        inp_total, out, cache_r, cache_w
    )
    if event in BILLABLE_TURN_EVENTS and total == 0:
        return False

    if at:
        state["updated_at"] = at
    elif not state.get("updated_at"):
        state["updated_at"] = datetime.now(timezone.utc).isoformat()

    ensure_daily_cumulative(state)

    model_name = model or str(state.get("model") or "")
    row_cost = round(cost_usd(uncached, out, cache_r, cache_w, model=model_name), 6)
    cum_total = int(state.get("cumulative_total_tokens") or 0) + total
    cum_out = int(state.get("cumulative_output_tokens") or 0) + out
    cum_cost = round(float(state.get("cumulative_cost_usd") or 0) + row_cost, 6)
    state["cumulative_total_tokens"] = cum_total
    state["cumulative_output_tokens"] = cum_out
    state["cumulative_cost_usd"] = cum_cost

    ctx_cell = ""
    if context_usage_percent is not None:
        ctx_cell = f"{float(context_usage_percent):.2f}"

    path = csv_path()
    ensure_csv_header(path)
    with path.open("a", encoding="utf-8", newline="") as f:
        csv.writer(f).writerow(
            [
                state.get("updated_at") or "",
                event,
                model_name,
                conversation_id,
                gen,
                uncached,
                cache_r,
                cache_w,
                out,
                total,
                row_cost,
                cum_total,
                cum_out,
                cum_cost,
                ctx_cell,
                conversation,
            ]
        )

    at_iso = str(state.get("updated_at") or "")
    insert_turn_from_append(
        at=at_iso,
        event=event,
        model=model_name,
        conversation_id=conversation_id,
        generation_id=gen,
        uncached=uncached,
        cache_r=cache_r,
        cache_w=cache_w,
        out=out,
        total=total,
        row_cost=row_cost,
        cum_total=cum_total,
        cum_out=cum_out,
        cum_cost=cum_cost,
        ctx_cell=ctx_cell,
        conversation=conversation,
    )

    maybe_compact_csv(path)
    write_telemetry_html(path, state)

    if gen and event in BILLABLE_TURN_EVENTS:
        logged.append(gen)
        state["logged_generations"] = logged[-200:]
    return True


def ingest_records(records: list[object]) -> int:
    state = load_state()
    written = 0
    for item in records:
        if not isinstance(item, dict):
            continue
        event = str(item.get("event") or "cloudRun")
        if event not in BILLABLE_TURN_EVENTS:
            event = "cloudRun"
        run_id = str(
            item.get("run_id") or item.get("runId") or item.get("id") or ""
        ).strip()
        if not run_id:
            continue
        agent_id = str(item.get("agent_id") or item.get("agentId") or "").strip()
        model = str(
            item.get("model") or item.get("model_id") or item.get("modelId") or ""
        )
        at_raw = item.get("at")
        at = str(at_raw) if at_raw is not None else None
        conversation = str(item.get("conversation") or item.get("label") or "").strip()
        if not conversation:
            conversation = f"☁ {agent_id[:12]}" if agent_id else "☁ cloud"
        inp, out, cache_r, cache_w = usage_numbers_from_ingest(item)
        if append_billable_row(
            state,
            event=event,
            generation_id=run_id,
            conversation_id=agent_id,
            model=model,
            at=at,
            conversation=conversation,
            inp_total=inp,
            out=out,
            cache_r=cache_r,
            cache_w=cache_w,
        ):
            written += 1
    save_state(state)
    return written


def append_csv_row(state: dict, payload: dict, *, event: str) -> None:
    gen = turn_generation_key(payload)
    logged = state.get("logged_generations")
    if not isinstance(logged, list):
        logged = []
    if event in BILLABLE_TURN_EVENTS and gen and gen in logged:
        return

    inp_total = int_or_none(state.get("last_input_total_tokens")) or 0
    out = int_or_none(state.get("last_output_tokens")) or 0
    cache_r = int_or_none(state.get("last_cache_read_tokens")) or 0
    cache_w = int_or_none(state.get("last_cache_write_tokens")) or 0
    uncached, cache_r, cache_w, out, total = usage_from_payload(
        inp_total, out, cache_r, cache_w
    )
    if event in BILLABLE_TURN_EVENTS and total == 0:
        fallback = int_or_none(state.pop("last_payload_total_tokens", None))
        if fallback and fallback > 0:
            out = fallback
            total = fallback
            uncached = fallback
            inp_total = fallback
        else:
            return

    ctx_pct = state.get("context_usage_percent")
    if ctx_pct is None:
        ctx_pct = payload.get("context_usage_percent")
    ctx_val = float(ctx_pct) if ctx_pct is not None else None

    append_billable_row(
        state,
        event=event,
        generation_id=gen,
        conversation_id=str(state.get("conversation_id") or ""),
        model=str(state.get("model") or ""),
        at=str(state.get("updated_at") or "") or None,
        conversation=row_conversation_label(state, payload),
        inp_total=inp_total,
        out=out,
        cache_r=cache_r,
        cache_w=cache_w,
        context_usage_percent=ctx_val,
    )


def normalize_conversation_title(raw: str) -> str:
    text = " ".join(str(raw).split())
    if len(text) > 120:
        return text[:117] + "…"
    return text


def title_from_payload(payload: dict) -> str | None:
    for key in (
        "conversation_title",
        "conversation_name",
        "chat_title",
        "workspace_name",
        "title",
    ):
        val = payload.get(key)
        if isinstance(val, str) and val.strip():
            candidate = normalize_conversation_title(val.strip())
            if candidate and not UUID_RE.match(candidate):
                return candidate
    for key in ("user_message", "prompt", "text", "message"):
        val = payload.get(key)
        if isinstance(val, str) and val.strip():
            line = val.strip().split("\n", 1)[0].strip()
            if len(line) >= 4 and not UUID_RE.match(line):
                return normalize_conversation_title(line)
    return None


def load_conversation_titles() -> dict[str, str]:
    if not TITLES_PATH.is_file():
        return {}
    try:
        raw = json.loads(TITLES_PATH.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return {}
    if not isinstance(raw, dict):
        return {}
    out: dict[str, str] = {}
    for key, val in raw.items():
        if isinstance(key, str) and isinstance(val, str) and val.strip():
            out[key] = normalize_conversation_title(val.strip())
    return out


def save_conversation_title(conv_id: str, title: str) -> None:
    if not conv_id or not title.strip():
        return
    titles = load_conversation_titles()
    titles[conv_id] = normalize_conversation_title(title)
    TITLES_PATH.parent.mkdir(parents=True, exist_ok=True)
    TITLES_PATH.write_text(
        json.dumps(titles, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )


def conversation_label(state: dict) -> str:
    conv_id = str(state.get("conversation_id") or "")
    title = state.get("conversation_title")
    if isinstance(title, str) and title.strip():
        return normalize_conversation_title(title)
    if conv_id:
        hit = load_conversation_titles().get(conv_id)
        if hit:
            return hit
    return ""


def sync_conversation(state: dict, payload: dict) -> None:
    conv_id = payload.get("conversation_id")
    if conv_id and state.get("conversation_id") != conv_id:
        state["logged_generations"] = []
        state.pop("conversation_title", None)
    if conv_id:
        state["conversation_id"] = conv_id
    event = payload.get("hook_event_name") or ""
    if event != "subagentStop":
        title = title_from_payload(payload)
        if title:
            state["conversation_title"] = title
            if conv_id:
                save_conversation_title(str(conv_id), title)
        elif conv_id:
            remembered = load_conversation_titles().get(str(conv_id))
            if remembered:
                state["conversation_title"] = remembered
    if payload.get("generation_id"):
        state["generation_id"] = payload.get("generation_id")
    model = payload.get("model") or payload.get("subagent_model")
    if model:
        state["model"] = model


def run_hook(payload: dict) -> dict:
    event = payload.get("hook_event_name") or ""
    state = load_state()
    state["updated_at"] = datetime.now(timezone.utc).isoformat()
    sync_conversation(state, payload)

    if event in ("stop", "subagentStop"):
        if payload.get("status") != "completed":
            save_state(state)
            return {}
        ingest_usage(state, payload)
        append_csv_row(state, payload, event="agentTurn")
        save_state(state)
        return {}

    if event == "preCompact":
        state["context_usage_percent"] = payload.get("context_usage_percent")
        save_state(state)
        if env_flag("TOKEN_HOOK_CHAT"):
            pct = payload.get("context_usage_percent")
            pct_s = f"{float(pct):.0f}%" if pct is not None else "?"
            return {"user_message": f"{CHAT_PREFIX}Context · {pct_s} · compacting"}
        return {}

    save_state(state)
    return {}


def print_status() -> int:
    state = load_state()
    path = csv_path()
    tail_n = csv_tail_rows()
    retention = csv_retention_days()
    print(f"CSV:   {path}")
    print(
        f"Price: {price_mode()} (TOKEN_HOOK_PRICE_MODE; flat $/M={os.environ.get('TOKEN_HOOK_PRICE_TOTAL_M', '0.35')})"
    )
    if sql_enabled():
        from token_telemetry_db import db_path as sql_db_path, sql_retention_days

        print(f"SQL:   {sql_db_path()} (retention {sql_retention_days()}d)")
        print(
            "CSV compact: "
            + (
                "on"
                if env_flag("TOKEN_HOOK_CSV_COMPACT", "0")
                else "off (SQL canonical)"
            )
        )
    print(
        f"Keep:  last {tail_n} granular CSV rows when compact on (TOKEN_HOOK_CSV_TAIL_ROWS); "
        f"older today → hourly; older days → daily"
    )
    if retention > 0:
        print(
            f"Drop:  daily buckets before {retention} UTC days "
            f"(TOKEN_HOOK_CSV_RETENTION_DAYS; 0 = keep all days)"
        )
    if path.is_file():
        _, data = read_csv_rows(path)
        print(f"Lines: {len(data)} data rows (+ header)")
        if data:
            print(f"Last:  {','.join(data[-1])}")
        archive = path.with_name(path.stem + ".archive" + path.suffix)
        if archive.is_file():
            _, adata = read_csv_rows(archive)
            print(f"Archive: {archive} ({len(adata)} rows)")
    else:
        print("Lines: 0 (no CSV yet)")
    print(f"State: {STATE_PATH}")
    html = html_path()
    if html.is_file():
        print(f"HTML:  {html}")
    elif env_flag("TOKEN_HOOK_HTML", "1"):
        print(f"HTML:  {html} (not generated yet)")
    if state:
        print(
            f"Cum:   tokens {state.get('cumulative_total_tokens', 0):,} · "
            f"out {state.get('cumulative_output_tokens', 0):,} · "
            f"${float(state.get('cumulative_cost_usd') or 0):.4f}"
        )
    return 0 if path.is_file() else 1


def main() -> int:
    parser = argparse.ArgumentParser(description="Token telemetry hook")
    parser.add_argument("--status", action="store_true")
    parser.add_argument(
        "--reset",
        action="store_true",
        help="Clear CSV, archive, state, and regenerate empty HTML",
    )
    parser.add_argument(
        "--compact",
        action="store_true",
        help="Apply tail + hourly/daily rollups and retention trim",
    )
    parser.add_argument(
        "--html",
        action="store_true",
        help="Regenerate token-telemetry.html from CSV + state",
    )
    parser.add_argument(
        "--ingest",
        action="store_true",
        help="Append cloud/SDK usage rows from JSON on stdin (object or array)",
    )
    args = parser.parse_args()
    if args.status:
        return print_status()
    if args.reset:
        reset_telemetry()
        print(f"Reset telemetry · CSV {csv_path()} · HTML {html_path()}")
        return 0
    if args.compact:
        path = csv_path()
        if not path.is_file():
            print(f"No CSV at {path}", file=sys.stderr)
            return 1
        n = compact_csv(path)
        write_telemetry_html(path, load_state())
        print(f"Compacted {path}: dropped {n} row(s)")
        return 0
    if args.html:
        path = csv_path()
        write_telemetry_html(path, load_state())
        print(f"Wrote {html_path()}")
        return 0

    raw = sys.stdin.read()
    if not raw.strip():
        return 0
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError:
        return 0

    if args.ingest:
        records = payload if isinstance(payload, list) else [payload]
        n = ingest_records(records)
        print(f"Ingested {n} row(s) → {csv_path()}")
        return 0

    out = run_hook(payload)
    if out:
        sys.stdout.write(json.dumps(out, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
