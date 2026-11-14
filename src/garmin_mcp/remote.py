"""Streamable HTTP entry point, used when the server runs remotely (Cloudflare Containers).

The app is meant to sit behind a gateway that authenticates callers (the
Cloudflare Worker in ``cloudflare/`` checks a bearer token). It must not be
exposed to the internet directly: it has no authentication of its own.

Token write-back: Garmin rotates access/refresh tokens. A container's memory is
lost when it sleeps, so whenever the live tokens differ from the ones the
container was started with, every response carries them in the
``x-garmin-tokens`` header. The Worker stores them and strips the header before
the response leaves Cloudflare.
"""

from __future__ import annotations

import argparse
import os

from starlette.types import ASGIApp, Message, Receive, Scope, Send

from .auth import TOKENS_JSON_ENV, current_tokens
from .server import mcp

TOKEN_HEADER = b"x-garmin-tokens"


class TokenWriteBack:
    """ASGI middleware that attaches refreshed Garmin tokens to responses."""

    def __init__(self, app: ASGIApp, initial_tokens: str | None) -> None:
        self.app = app
        self.reported = (initial_tokens or "").strip() or None

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        async def send_with_tokens(message: Message) -> None:
            if message["type"] == "http.response.start":
                tokens = current_tokens()
                if tokens and tokens != self.reported:
                    headers = list(message.get("headers", []))
                    headers.append((TOKEN_HEADER, tokens.encode()))
                    message = {**message, "headers": headers}
                    # Keep re-sending until the process restarts with the new tokens;
                    # the Worker de-duplicates, and a lost response must not lose them.
            await send(message)

        await self.app(scope, receive, send_with_tokens)


def build_app() -> ASGIApp:
    app = mcp.streamable_http_app(
        streamable_http_path="/mcp",
        stateless_http=True,  # no session affinity needed; containers may restart anytime
        json_response=True,  # plain JSON responses: simpler to proxy than SSE
        host="0.0.0.0",  # Host checks are the gateway's job; the container is not public
    )
    return TokenWriteBack(app, os.environ.get(TOKENS_JSON_ENV))


def main() -> None:
    parser = argparse.ArgumentParser(description="Run garmin-mcp over Streamable HTTP.")
    parser.add_argument("--host", default=os.environ.get("HOST", "0.0.0.0"))
    parser.add_argument("--port", type=int, default=int(os.environ.get("PORT", "8080")))
    args = parser.parse_args()

    import uvicorn

    uvicorn.run(build_app(), host=args.host, port=args.port, log_level="info")


if __name__ == "__main__":
    main()
