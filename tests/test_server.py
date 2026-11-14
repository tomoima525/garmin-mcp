"""Exercise the MCP server in-process against a fake Garmin client (no network)."""

from __future__ import annotations

import json
from typing import Any

import pytest
from garminconnect import Garmin, GarminConnectAuthenticationError
from mcp import Client

from garmin_mcp import auth, server

SLEEP = {
    "dailySleepDTO": {
        "calendarDate": "2026-11-13",
        "sleepTimeSeconds": 27000,
        "deepSleepSeconds": 5400,
        "lightSleepSeconds": 14400,
        "remSleepSeconds": 6000,
        "awakeSleepSeconds": 1200,
        "averageSpO2Value": 95.0,
        "sleepScores": {"overall": {"value": 82, "qualifierKey": "GOOD"}},
        "unusedNull": None,
    },
    "sleepMovement": [{"activityLevel": 0.1}] * 500,
    "avgOvernightHrv": 61.0,
    "restingHeartRate": 48,
}

RUN = {
    "activityId": 123,
    "activityName": "Morning Run",
    "activityType": {"typeKey": "running"},
    "startTimeLocal": "2026-11-13 07:00:00",
    "distance": 10000.0,
    "duration": 3000.0,
    "averageSpeed": 3.3333,
    "averageHR": 150.0,
}


class FakeGarmin:
    def __init__(self) -> None:
        self.calls: list[tuple[str, tuple[Any, ...]]] = []

    def get_sleep_data(self, cdate: str) -> dict[str, Any]:
        self.calls.append(("get_sleep_data", (cdate,)))
        return SLEEP

    def get_activities_by_date(self, startdate, enddate=None, activitytype=None, sortorder=None):
        self.calls.append(("get_activities_by_date", (startdate, enddate, activitytype)))
        return [RUN]

    def get_user_summary(self, cdate: str) -> dict[str, Any]:
        raise GarminConnectAuthenticationError("401")

    def get_rhr_daily(self, start: str, end: str) -> list[dict[str, Any]]:
        return [{"date": start, "rhr": 48}]

    def get_activity(self, activity_id: str) -> dict[str, Any]:
        return {"activityId": int(activity_id), "summaryDTO": {"distance": 10000.0}}

    def logout(self) -> None:  # not in the allowlist; must not be callable
        raise AssertionError("should never be called")


@pytest.fixture
def fake() -> FakeGarmin:
    client = FakeGarmin()
    auth.set_client(client)  # type: ignore[arg-type]
    yield client
    auth.set_client(None)


def _payload(result: Any) -> dict[str, Any]:
    assert not result.is_error, result.content
    if result.structured_content is not None:
        return result.structured_content
    return json.loads(result.content[0].text)


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


@pytest.mark.anyio
async def test_tools_are_listed_and_read_only() -> None:
    async with Client(server.mcp) as c:
        tools = {t.name: t for t in (await c.list_tools()).tools}
    assert {"get_sleep", "get_sleep_trend", "list_activities", "get_hrv", "garmin_query"} <= set(
        tools
    )
    assert all(t.annotations and t.annotations.read_only_hint for t in tools.values())
    assert "date" in tools["get_sleep"].input_schema["properties"]


@pytest.mark.anyio
async def test_get_sleep_summarizes_and_drops_timeseries(fake: FakeGarmin) -> None:
    async with Client(server.mcp) as c:
        data = _payload(await c.call_tool("get_sleep", {"date": "2026-11-13"}))
    assert data["summary"]["sleep_score"] == 82
    assert data["summary"]["deep_s"] == 5400
    assert data["summary"]["avg_overnight_hrv"] == 61.0
    assert "omitted" in data["details"]["sleepMovement"]
    assert "unusedNull" not in data["details"]["dailySleepDTO"]


@pytest.mark.anyio
async def test_sleep_trend_one_row_per_night(fake: FakeGarmin) -> None:
    async with Client(server.mcp) as c:
        data = _payload(
            await c.call_tool(
                "get_sleep_trend", {"start_date": "2026-11-10", "end_date": "2026-11-13"}
            )
        )
    assert [n["date"] for n in data["nights"]] == [
        "2026-11-10",
        "2026-11-11",
        "2026-11-12",
        "2026-11-13",
    ]


@pytest.mark.anyio
async def test_range_limit_and_bad_dates(fake: FakeGarmin) -> None:
    async with Client(server.mcp) as c:
        too_long = await c.call_tool(
            "get_sleep_trend", {"start_date": "2026-01-01", "end_date": "2026-03-01"}
        )
        bad = await c.call_tool("get_sleep", {"date": "13/11/2026"})
    assert too_long.is_error and "max is 31" in too_long.content[0].text
    assert bad.is_error and "YYYY-MM-DD" in bad.content[0].text


@pytest.mark.anyio
async def test_list_activities_adds_pace(fake: FakeGarmin) -> None:
    async with Client(server.mcp) as c:
        data = _payload(
            await c.call_tool(
                "list_activities",
                {"start_date": "2026-11-01", "end_date": "2026-11-14", "activity_type": "running"},
            )
        )
    run = data["activities"][0]
    assert data["count"] == 1
    assert run["activity_id"] == 123 and run["type"] == "running"
    assert run["avg_pace_min_per_km"] == "5:00"
    assert fake.calls[-1] == ("get_activities_by_date", ("2026-11-01", "2026-11-14", "running"))


@pytest.mark.anyio
async def test_auth_error_tells_user_to_log_in(fake: FakeGarmin) -> None:
    async with Client(server.mcp) as c:
        res = await c.call_tool("get_daily_summary", {})
    assert res.is_error and "garmin-mcp-login" in res.content[0].text


@pytest.mark.anyio
async def test_garmin_query_allowlist(fake: FakeGarmin) -> None:
    async with Client(server.mcp) as c:
        ok = _payload(
            await c.call_tool(
                "garmin_query",
                {"method": "get_rhr_daily", "args": {"start": "2026-11-01", "end": "2026-11-02"}},
            )
        )
        denied = await c.call_tool("garmin_query", {"method": "logout"})
    assert ok == {"data": [{"date": "2026-11-01", "rhr": 48}]}
    assert denied.is_error and "not allowed" in denied.content[0].text


def test_allowlisted_methods_exist_and_are_reads() -> None:
    for name in server.RAW_ALLOWED:
        assert name.startswith("get_"), name
        assert callable(getattr(Garmin, name, None)), f"{name} missing from garminconnect"


@pytest.mark.anyio
async def test_not_logged_in_message(tmp_path, monkeypatch) -> None:
    auth.set_client(None)
    monkeypatch.setenv("GARMINTOKENS", str(tmp_path / "missing"))
    async with Client(server.mcp) as c:
        res = await c.call_tool("get_sleep", {})
    assert res.is_error and "garmin-mcp-login" in res.content[0].text
