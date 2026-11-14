"""Garmin Connect MCP server.

Exposes read-only tools for sleep, recovery (HRV, Body Battery, readiness),
daily stats and activities. Run with ``garmin-mcp`` (stdio transport).
"""

from __future__ import annotations

import datetime as dt
import functools
import inspect
from collections.abc import Callable
from typing import Any

from garminconnect import (
    GarminConnectAuthenticationError,
    GarminConnectConnectionError,
    GarminConnectNotFoundError,
    GarminConnectTooManyRequestsError,
)
from mcp.server.mcpserver import MCPServer
from mcp.server.mcpserver.exceptions import ToolError
from mcp.types import ToolAnnotations

from .auth import NotLoggedInError, get_client, set_client
from .compact import DEFAULT_MAX_LIST, compact, dig

MAX_RANGE_DAYS = 31

mcp = MCPServer(
    name="garmin",
    title="Garmin Connect",
    instructions=(
        "Read-only access to the user's Garmin Connect data: sleep, HRV, Body Battery, "
        "stress, training readiness/status, daily stats and activities (runs, rides, ...). "
        "Dates are YYYY-MM-DD in the user's local time and default to today. "
        "Sleep for date D is the night that ended on the morning of D. "
        "Units: distance in meters, duration in seconds, speed in m/s unless a field says "
        "otherwise. Long minute-by-minute series are omitted unless include_timeseries=true."
    ),
)

READ_ONLY = ToolAnnotations(readOnlyHint=True, openWorldHint=True)


# --------------------------------------------------------------------------- helpers


def _garmin_errors[F: Callable[..., Any]](fn: F) -> F:
    """Turn Garmin library exceptions into readable MCP tool errors."""

    @functools.wraps(fn)
    def wrapper(*args: Any, **kwargs: Any) -> Any:
        try:
            return fn(*args, **kwargs)
        except ToolError:
            raise
        except NotLoggedInError as e:
            raise ToolError(str(e)) from e
        except GarminConnectAuthenticationError as e:
            set_client(None)
            raise ToolError(
                f"Garmin authentication failed ({e}). Tokens may have expired: run "
                "`garmin-mcp-login` again."
            ) from e
        except GarminConnectTooManyRequestsError as e:
            raise ToolError(f"Garmin is rate-limiting requests; wait a few minutes. ({e})") from e
        except GarminConnectNotFoundError as e:
            raise ToolError(f"Not found in Garmin Connect: {e}") from e
        except GarminConnectConnectionError as e:
            raise ToolError(f"Garmin Connect request failed: {e}") from e
        except ValueError as e:
            raise ToolError(str(e)) from e

    return wrapper  # type: ignore[return-value]


def _date(value: str | None) -> str:
    if not value:
        return dt.date.today().isoformat()
    try:
        return dt.date.fromisoformat(value).isoformat()
    except ValueError as e:
        raise ToolError(f"Invalid date {value!r}; expected YYYY-MM-DD.") from e


def _range(start: str, end: str | None) -> tuple[str, str]:
    s, e = _date(start), _date(end)
    days = (dt.date.fromisoformat(e) - dt.date.fromisoformat(s)).days
    if days < 0:
        raise ToolError("end_date must be on or after start_date.")
    if days >= MAX_RANGE_DAYS:
        raise ToolError(f"Date range too long ({days + 1} days); max is {MAX_RANGE_DAYS}.")
    return s, e


def _days(start: str, end: str) -> list[str]:
    s, e = dt.date.fromisoformat(start), dt.date.fromisoformat(end)
    return [(s + dt.timedelta(days=i)).isoformat() for i in range((e - s).days + 1)]


def _shrink(data: Any, include_timeseries: bool) -> Any:
    return compact(data, None if include_timeseries else DEFAULT_MAX_LIST)


def _wrap(data: Any) -> dict[str, Any]:
    """Structured tool output must be an object; wrap bare lists/scalars."""
    return data if isinstance(data, dict) else {"data": data}


def _pace_min_per_km(speed_mps: float | None) -> str | None:
    if not speed_mps or speed_mps <= 0:
        return None
    secs = round(1000 / speed_mps)
    return f"{secs // 60}:{secs % 60:02d}"


def _summarize_activity(a: dict[str, Any]) -> dict[str, Any]:
    type_key = dig(a, "activityType", "typeKey")
    summary = {
        "activity_id": a.get("activityId"),
        "name": a.get("activityName"),
        "type": type_key,
        "start_time_local": a.get("startTimeLocal"),
        "distance_m": a.get("distance"),
        "duration_s": a.get("duration"),
        "moving_duration_s": a.get("movingDuration"),
        "avg_speed_mps": a.get("averageSpeed"),
        "avg_hr": a.get("averageHR"),
        "max_hr": a.get("maxHR"),
        "calories": a.get("calories"),
        "elevation_gain_m": a.get("elevationGain"),
        "avg_cadence_spm": a.get("averageRunningCadenceInStepsPerMinute"),
        "aerobic_training_effect": a.get("aerobicTrainingEffect"),
        "anaerobic_training_effect": a.get("anaerobicTrainingEffect"),
        "training_load": a.get("activityTrainingLoad"),
        "vo2max": a.get("vO2MaxValue"),
    }
    if type_key and ("running" in type_key or "walking" in type_key or "hiking" in type_key):
        summary["avg_pace_min_per_km"] = _pace_min_per_km(a.get("averageSpeed"))
    return compact(summary)


def _summarize_sleep(date: str, raw: dict[str, Any]) -> dict[str, Any]:
    d = raw.get("dailySleepDTO") or {}
    return compact(
        {
            "date": date,
            "sleep_score": dig(d, "sleepScores", "overall", "value"),
            "sleep_score_qualifier": dig(d, "sleepScores", "overall", "qualifierKey"),
            "total_sleep_s": d.get("sleepTimeSeconds"),
            "deep_s": d.get("deepSleepSeconds"),
            "light_s": d.get("lightSleepSeconds"),
            "rem_s": d.get("remSleepSeconds"),
            "awake_s": d.get("awakeSleepSeconds"),
            "sleep_start_local_ms": d.get("sleepStartTimestampLocal"),
            "sleep_end_local_ms": d.get("sleepEndTimestampLocal"),
            "avg_overnight_hrv": raw.get("avgOvernightHrv"),
            "hrv_status": raw.get("hrvStatus"),
            "resting_hr": raw.get("restingHeartRate"),
            "avg_spo2": d.get("averageSpO2Value"),
            "avg_respiration": d.get("averageRespirationValue"),
            "avg_sleep_stress": d.get("avgSleepStress"),
            "body_battery_change": raw.get("bodyBatteryChange"),
        }
    )


# --------------------------------------------------------------------------- tools


@mcp.tool(annotations=READ_ONLY)
@_garmin_errors
def get_daily_summary(date: str | None = None) -> dict[str, Any]:
    """Daily overview for one day: steps, calories, resting HR, stress, Body Battery,
    intensity minutes, floors, SpO2 and respiration averages."""
    return _shrink(get_client().get_user_summary(_date(date)), False)


@mcp.tool(annotations=READ_ONLY)
@_garmin_errors
def get_sleep(date: str | None = None, include_timeseries: bool = False) -> dict[str, Any]:
    """Full sleep record for one night: sleep score and sub-scores, stage durations
    (deep/light/REM/awake), overnight HRV, resting HR, SpO2, respiration and sleep stress.
    `date` is the morning the sleep ended."""
    day = _date(date)
    raw = get_client().get_sleep_data(day)
    return {"summary": _summarize_sleep(day, raw), "details": _shrink(raw, include_timeseries)}


@mcp.tool(annotations=READ_ONLY)
@_garmin_errors
def get_sleep_trend(start_date: str, end_date: str | None = None) -> dict[str, Any]:
    """One compact row per night (score, stages, HRV, resting HR) for a range of up to
    31 days. Use this to spot trends; use get_sleep for a single night's detail."""
    s, e = _range(start_date, end_date)
    client = get_client()
    return {"nights": [_summarize_sleep(day, client.get_sleep_data(day)) for day in _days(s, e)]}


@mcp.tool(annotations=READ_ONLY)
@_garmin_errors
def get_hrv(date: str | None = None, include_timeseries: bool = False) -> dict[str, Any]:
    """Heart-rate variability for one night: last-night average, weekly average,
    baseline range and HRV status (balanced/unbalanced/low)."""
    data = get_client().get_hrv_data(_date(date))
    if not data:
        return {"message": "No HRV data for this date (watch not worn overnight?)."}
    return _shrink(data, include_timeseries)


@mcp.tool(annotations=READ_ONLY)
@_garmin_errors
def get_training_readiness(date: str | None = None) -> dict[str, Any]:
    """Training readiness score and its contributing factors (sleep, recovery time,
    HRV, acute load, stress history) for one day."""
    return _wrap(_shrink(get_client().get_training_readiness(_date(date)), False))


@mcp.tool(annotations=READ_ONLY)
@_garmin_errors
def get_body_battery(
    start_date: str | None = None, end_date: str | None = None, include_timeseries: bool = False
) -> dict[str, Any]:
    """Body Battery per day (charged, drained, highest, lowest) for up to 31 days."""
    s, e = _range(start_date or _date(None), end_date or start_date)
    return _wrap(_shrink(get_client().get_body_battery(s, e), include_timeseries))


@mcp.tool(annotations=READ_ONLY)
@_garmin_errors
def get_stress(date: str | None = None, include_timeseries: bool = False) -> dict[str, Any]:
    """All-day stress for one day: average and max stress level, plus time spent at
    rest / low / medium / high stress."""
    return _shrink(get_client().get_stress_data(_date(date)), include_timeseries)


@mcp.tool(annotations=READ_ONLY)
@_garmin_errors
def get_heart_rate(date: str | None = None, include_timeseries: bool = False) -> dict[str, Any]:
    """Heart rate for one day: resting, min, max and 7-day average resting HR."""
    return _shrink(get_client().get_heart_rates(_date(date)), include_timeseries)


@mcp.tool(annotations=READ_ONLY)
@_garmin_errors
def list_activities(
    start_date: str, end_date: str | None = None, activity_type: str | None = None
) -> dict[str, Any]:
    """Activities (runs, rides, swims, strength, ...) between two dates, newest first, with
    distance, duration, pace, HR, training effect and load. `activity_type` filters by
    Garmin type key, e.g. "running", "cycling", "swimming", "strength_training"."""
    s, e = _date(start_date), _date(end_date)
    if e < s:
        raise ToolError("end_date must be on or after start_date.")
    acts = get_client().get_activities_by_date(s, e, activity_type)  # Garmin sorts newest first
    return {"count": len(acts), "activities": [_summarize_activity(a) for a in acts]}


@mcp.tool(annotations=READ_ONLY)
@_garmin_errors
def get_activity(
    activity_id: int, include_splits: bool = True, include_hr_zones: bool = True
) -> dict[str, Any]:
    """Detailed view of one activity (get the id from list_activities): full summary,
    per-km/lap splits and time in each heart-rate zone."""
    client = get_client()
    aid = str(activity_id)
    result: dict[str, Any] = {"activity": _shrink(client.get_activity(aid), False)}
    if include_splits:
        result["splits"] = _shrink(client.get_activity_splits(aid), False)
    if include_hr_zones:
        result["hr_zones"] = _shrink(client.get_activity_hr_in_timezones(aid), False)
    return result


@mcp.tool(annotations=READ_ONLY)
@_garmin_errors
def get_training_status(date: str | None = None) -> dict[str, Any]:
    """Training status (productive, maintaining, overreaching, ...), acute/chronic training
    load, load focus and VO2 max for one day."""
    day = _date(date)
    client = get_client()
    return {
        "training_status": _shrink(client.get_training_status(day), False),
        "max_metrics": _shrink(client.get_max_metrics(day), False),
    }


@mcp.tool(annotations=READ_ONLY)
@_garmin_errors
def get_race_predictions() -> dict[str, Any]:
    """Garmin's current predicted race times for 5K, 10K, half marathon and marathon."""
    return _wrap(_shrink(get_client().get_race_predictions(), False))


@mcp.tool(annotations=READ_ONLY)
@_garmin_errors
def get_body_composition(
    start_date: str | None = None, end_date: str | None = None
) -> dict[str, Any]:
    """Weight and body composition (BMI, body fat %, muscle mass, ...) for a date range."""
    s, e = _range(start_date or _date(None), end_date or start_date)
    return _shrink(get_client().get_body_composition(s, e), False)


# Methods the escape-hatch tool may call. All are read-only `get_*` methods of the
# garminconnect client; `get_` alone is not a guarantee, so keep this list explicit.
RAW_ALLOWED = frozenset(
    name
    for name in (
        "get_all_day_stress",
        "get_body_battery_events",
        "get_daily_steps",
        "get_daily_sleep",
        "get_devices",
        "get_endurance_score",
        "get_fastest_splits",
        "get_fitnessage_data",
        "get_floors",
        "get_heart_rate_zones",
        "get_hill_score",
        "get_hrv_data_range",
        "get_hydration_data",
        "get_intensity_minutes_data",
        "get_lactate_threshold",
        "get_last_activity",
        "get_lifetime_totals",
        "get_max_metrics_range",
        "get_morning_training_readiness",
        "get_personal_record",
        "get_progress_summary_between_dates",
        "get_respiration_data",
        "get_rhr_daily",
        "get_running_tolerance",
        "get_sleep_stats_overall",
        "get_sleep_stats_weekly",
        "get_spo2_data",
        "get_stats",
        "get_stats_and_body",
        "get_steps_data",
        "get_training_load_activities",
        "get_training_readiness_range",
        "get_weekly_activity_stats",
        "get_weekly_steps",
        "get_weekly_stress",
        "get_weekly_training_status",
        "get_weigh_ins",
        "get_activity_laps",
        "get_activity_weather",
        "get_activity_typed_splits",
        "get_activity_power_in_timezones",
        "get_stamina_curve",
        "get_running_economy_range",
        "get_user_profile",
    )
)


@mcp.tool(annotations=READ_ONLY)
@_garmin_errors
def garmin_query(
    method: str, args: dict[str, Any] | None = None, include_timeseries: bool = False
) -> dict[str, Any]:
    """Escape hatch for data the other tools don't cover. Calls a read-only method of the
    python-garminconnect client by name with keyword `args`. Call with method="help" to
    list allowed methods and their parameters."""
    client = get_client()
    if method == "help":
        return {
            "methods": {
                name: str(inspect.signature(getattr(client, name)))
                for name in sorted(RAW_ALLOWED)
                if hasattr(client, name)
            }
        }
    if method not in RAW_ALLOWED or not hasattr(client, method):
        raise ToolError(f"Method {method!r} is not allowed. Call with method='help' for the list.")
    try:
        data = getattr(client, method)(**(args or {}))
    except TypeError as e:
        raise ToolError(f"Bad arguments for {method}: {e}") from e
    return _wrap(_shrink(data, include_timeseries))


def main() -> None:
    mcp.run()


if __name__ == "__main__":
    main()
