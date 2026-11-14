"""Shrink Garmin API responses so they fit comfortably in an LLM context window.

Garmin responses are full of nulls and minute-by-minute time series (heart rate,
stress, sleep movement, ...) that can be hundreds of entries long. Agents rarely
need those, so by default we drop empty values and replace long lists with a
short placeholder. Callers can opt back in with ``include_timeseries=True``.
"""

from __future__ import annotations

from typing import Any

DEFAULT_MAX_LIST = 50


def compact(value: Any, max_list: int | None = DEFAULT_MAX_LIST) -> Any:
    """Recursively drop null/empty values and truncate long lists.

    ``max_list=None`` keeps every list intact (only nulls/empties are removed).
    """
    if isinstance(value, dict):
        out: dict[str, Any] = {}
        for key, item in value.items():
            cleaned = compact(item, max_list)
            if _is_empty(cleaned):
                continue
            out[key] = cleaned
        return out
    if isinstance(value, list):
        if max_list is not None and len(value) > max_list:
            return f"<{len(value)} items omitted; pass include_timeseries=true to get them>"
        cleaned_items = [compact(item, max_list) for item in value]
        return [item for item in cleaned_items if not _is_empty(item)]
    return value


def _is_empty(value: Any) -> bool:
    return value is None or (isinstance(value, (dict, list, str)) and len(value) == 0)


def dig(obj: Any, *path: str | int, default: Any = None) -> Any:
    """Safely read a nested value: ``dig(d, "a", "b", 0)`` -> ``d["a"]["b"][0]``."""
    cur = obj
    for key in path:
        try:
            cur = cur[key]
        except (KeyError, IndexError, TypeError):
            return default
        if cur is None:
            return default
    return cur
