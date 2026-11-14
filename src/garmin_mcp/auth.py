"""Garmin Connect session handling.

The MCP server never sees your password. You log in once with
``garmin-mcp-login`` (which handles MFA); that writes OAuth tokens to the token
store, and the server reuses and refreshes them from there.

When running remotely (e.g. on Cloudflare Containers) there is no token file:
the tokens are passed in as JSON via the ``GARMIN_TOKENS_JSON`` env var, and
``current_tokens()`` lets the HTTP layer hand refreshed tokens back to the host
so they survive container restarts.
"""

from __future__ import annotations

import os
import threading
from pathlib import Path

from garminconnect import Garmin

DEFAULT_TOKENSTORE = "~/.garminconnect"
TOKENS_JSON_ENV = "GARMIN_TOKENS_JSON"


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
            inline = os.environ.get(TOKENS_JSON_ENV, "").strip()
            if inline:
                source = inline  # garminconnect accepts token JSON in place of a path
            else:
                source = tokenstore_path()
                if not Path(source).exists():
                    raise NotLoggedInError(
                        f"No Garmin tokens found at {source}. Run `garmin-mcp-login` once "
                        "in a terminal to sign in, then retry."
                    )
            client = Garmin()
            client.login(source)
            _client = client
        return _client


def current_tokens() -> str | None:
    """Serialized tokens of the live client (they change when Garmin refreshes them)."""
    with _lock:
        if _client is None:
            return None
        try:
            return _client.client.dumps()
        except Exception:
            return None


def set_client(client: Garmin | None) -> None:
    """Replace the cached client (used by tests, or to force a re-login)."""
    global _client
    with _lock:
        _client = client
