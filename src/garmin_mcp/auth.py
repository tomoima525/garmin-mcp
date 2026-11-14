"""Garmin Connect session handling.

The MCP server never sees your password. You log in once with
``garmin-mcp-login`` (which handles MFA); that writes OAuth tokens to the token
store, and the server reuses and refreshes them from there.
"""

from __future__ import annotations

import os
import threading
from pathlib import Path

from garminconnect import Garmin

DEFAULT_TOKENSTORE = "~/.garminconnect"


def tokenstore_path() -> str:
    """Where tokens are stored. Override with the GARMINTOKENS env var."""
    return str(Path(os.environ.get("GARMINTOKENS", DEFAULT_TOKENSTORE)).expanduser())


class NotLoggedInError(RuntimeError):
    pass


_lock = threading.Lock()
_client: Garmin | None = None


def get_client() -> Garmin:
    """Return a logged-in Garmin client, created lazily from saved tokens."""
    global _client
    with _lock:
        if _client is None:
            store = tokenstore_path()
            if not Path(store).exists():
                raise NotLoggedInError(
                    f"No Garmin tokens found at {store}. Run `garmin-mcp-login` once "
                    "in a terminal to sign in, then retry."
                )
            client = Garmin()
            client.login(store)
            _client = client
        return _client


def set_client(client: Garmin | None) -> None:
    """Replace the cached client (used by tests, or to force a re-login)."""
    global _client
    with _lock:
        _client = client
