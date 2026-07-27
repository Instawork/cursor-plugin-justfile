from __future__ import annotations

import json
import os
from functools import lru_cache
from pathlib import Path
from typing import Any

_RATES_FILE = Path(__file__).resolve().parent / "cursor-model-rates.json"

ChannelRates = dict[str, float]


@lru_cache(maxsize=1)
def _load_config() -> dict[str, Any]:
    if _RATES_FILE.is_file():
        return json.loads(_RATES_FILE.read_text(encoding="utf-8"))
    return {
        "defaultChannels": {
            "input": 1.25,
            "cacheWrite": 1.25,
            "cacheRead": 0.25,
            "output": 6.0,
        },
        "defaultUsdPerM": 0.76,
        "rules": [],
    }


def _rule_matches(model_lower: str, rule: dict[str, Any]) -> bool:
    any_parts = [str(x).lower() for x in rule.get("any") or []]
    all_parts = [str(x).lower() for x in rule.get("all") or []]
    if all_parts and not all(p in model_lower for p in all_parts):
        return False
    if any_parts and not any(p in model_lower for p in any_parts):
        return False
    if not any_parts and not all_parts:
        return False
    return True


def _channels_from_mapping(raw: dict[str, Any] | None, fallback: ChannelRates) -> ChannelRates:
    src = raw if isinstance(raw, dict) else {}
    input_m = float(src.get("input", fallback["input"]))
    cache_read = float(src.get("cacheRead", fallback["cacheRead"]))
    output_m = float(src.get("output", fallback["output"]))
    cache_write = float(src.get("cacheWrite", input_m))
    return {
        "input": input_m,
        "cacheWrite": cache_write,
        "cacheRead": cache_read,
        "output": output_m,
    }


def default_channel_rates() -> ChannelRates:
    cfg = _load_config()
    defaults = cfg.get("defaultChannels")
    if isinstance(defaults, dict):
        return _channels_from_mapping(defaults, {
            "input": 1.25,
            "cacheWrite": 1.25,
            "cacheRead": 0.25,
            "output": 6.0,
        })
    # Legacy: blended defaultUsdPerM
    blended = float(cfg.get("defaultUsdPerM", 0.76))
    return {
        "input": blended,
        "cacheWrite": blended,
        "cacheRead": blended,
        "output": blended,
    }


def model_channel_rates(model: str) -> ChannelRates:
    """Resolve per-channel $/M for a model id (Cursor docs table)."""
    override = os.environ.get("TOKEN_HOOK_MODEL_RATE_OVERRIDE", "").strip()
    if override:
        try:
            blended = float(override)
            return {
                "input": blended,
                "cacheWrite": blended,
                "cacheRead": blended,
                "output": blended,
            }
        except ValueError:
            pass
    cfg = _load_config()
    fallback = default_channel_rates()
    model_lower = (model or "").strip().lower()
    for rule in cfg.get("rules") or []:
        if not isinstance(rule, dict) or not _rule_matches(model_lower, rule):
            continue
        channels = rule.get("channels")
        if isinstance(channels, dict):
            return _channels_from_mapping(channels, fallback)
        if "usdPerM" in rule:
            blended = float(rule["usdPerM"])
            return {
                "input": blended,
                "cacheWrite": blended,
                "cacheRead": blended,
                "output": blended,
            }
    return fallback


def model_effective_usd_per_m(model: str) -> float:
    """Blended $/M (legacy); prefer input channel of resolved rates."""
    return model_channel_rates(model)["input"]


def price_mode_normalized() -> str:
    mode = (os.environ.get("TOKEN_HOOK_PRICE_MODE") or "model").strip().lower()
    if mode in ("billing", "by-model", "by_model"):
        return "model"
    if mode == "auto":
        return "flat"
    return mode
