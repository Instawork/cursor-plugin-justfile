from __future__ import annotations

import json
import os
from functools import lru_cache
from pathlib import Path
from typing import Any

_RATES_FILE = Path(__file__).resolve().parent / "cursor-model-rates.json"


@lru_cache(maxsize=1)
def _load_config() -> dict[str, Any]:
    if _RATES_FILE.is_file():
        return json.loads(_RATES_FILE.read_text(encoding="utf-8"))
    return {"defaultUsdPerM": 0.76, "rules": []}


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


def model_effective_usd_per_m(model: str) -> float:
    override = os.environ.get("TOKEN_HOOK_MODEL_RATE_OVERRIDE", "").strip()
    if override:
        try:
            return float(override)
        except ValueError:
            pass
    cfg = _load_config()
    model_lower = (model or "").strip().lower()
    for rule in cfg.get("rules") or []:
        if isinstance(rule, dict) and _rule_matches(model_lower, rule):
            return float(rule.get("usdPerM", cfg.get("defaultUsdPerM", 0.76)))
    return float(cfg.get("defaultUsdPerM", 0.76))


def price_mode_normalized() -> str:
    mode = (os.environ.get("TOKEN_HOOK_PRICE_MODE") or "model").strip().lower()
    if mode in ("billing", "by-model", "by_model"):
        return "model"
    if mode == "auto":
        return "flat"
    return mode
