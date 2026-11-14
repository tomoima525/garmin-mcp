"""HTTP mode: MCP over Streamable HTTP plus the token write-back header."""

from __future__ import annotations

import json
from typing import Any

import pytest
from starlette.testclient import TestClient

from garmin_mcp import auth
from garmin_mcp.remote import TOKEN_HEADER, build_app

INITIAL = '{"di_token": "t0", "di_refresh_token": "r0", "di_client_id": "c"}'
REFRESHED = '{"di_token": "t1", "di_refresh_token": "r1", "di_client_id": "c"}'


class FakeInner:
    def __init__(self, tokens: str) -> None:
        self.tokens = tokens

    def dumps(self) -> str:
        return self.tokens


class FakeGarmin:
    def __init__(self, tokens: str) -> None:
        self.client = FakeInner(tokens)

    def get_rhr_daily(self, start: str, end: str) -> list[dict[str, Any]]:
        return [{"date": start, "rhr": 47}]


HEADERS = {
    "accept": "application/json, text/event-stream",
    "content-type": "application/json",
    "mcp-protocol-version": "2025-06-18",
}


def _rpc(client: TestClient, method: str, params: dict[str, Any]) -> Any:
    body = {"jsonrpc": "2.0", "id": 1, "method": method, "params": params}
    return client.post("/mcp", headers=HEADERS, content=json.dumps(body))


@pytest.fixture
def app(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv(auth.TOKENS_JSON_ENV, INITIAL)
    yield build_app()
    auth.set_client(None)


def _call_tool(client: TestClient):
    return _rpc(
        client,
        "tools/call",
        {
            "name": "garmin_query",
            "arguments": {
                "method": "get_rhr_daily",
                "args": {"start": "2026-11-01", "end": "2026-11-01"},
            },
        },
    )


def test_tool_call_over_http_without_refresh_sends_no_tokens(app) -> None:
    auth.set_client(FakeGarmin(INITIAL))  # type: ignore[arg-type]
    with TestClient(app) as client:
        res = _call_tool(client)
    assert res.status_code == 200, res.text
    result = res.json()["result"]
    assert not result.get("isError"), result
    assert "47" in json.dumps(result)
    assert TOKEN_HEADER.decode() not in res.headers


def test_refreshed_tokens_are_reported_in_header(app) -> None:
    auth.set_client(FakeGarmin(REFRESHED))  # type: ignore[arg-type]
    with TestClient(app) as client:
        res = _call_tool(client)
    assert res.status_code == 200, res.text
    assert res.headers[TOKEN_HEADER.decode()] == REFRESHED


def test_tools_list_over_http(app) -> None:
    with TestClient(app) as client:
        res = _rpc(client, "tools/list", {})
    assert res.status_code == 200, res.text
    names = {t["name"] for t in res.json()["result"]["tools"]}
    assert {"get_sleep", "list_activities"} <= names
