"""One-time interactive login: ``garmin-mcp-login``.

Prompts for email, password and (if enabled) the MFA code, then saves OAuth
tokens to the token store. The password itself is never written to disk.
"""

from __future__ import annotations

import getpass
import os
import sys
from pathlib import Path

from garminconnect import (
    Garmin,
    GarminConnectAuthenticationError,
    GarminConnectConnectionError,
    GarminConnectTooManyRequestsError,
)

from .auth import tokenstore_path


def main() -> None:
    store = tokenstore_path()
    email = os.environ.get("GARMIN_EMAIL") or input("Garmin email: ").strip()
    password = os.environ.get("GARMIN_PASSWORD") or getpass.getpass("Garmin password: ")

    Path(store).mkdir(mode=0o700, parents=True, exist_ok=True)
    client = Garmin(
        email=email,
        password=password,
        prompt_mfa=lambda: input("MFA code (check your email/app): ").strip(),
    )
    try:
        client.login(store)
    except GarminConnectTooManyRequestsError as e:
        sys.exit(f"Garmin is rate-limiting logins: {e}")
    except (GarminConnectAuthenticationError, GarminConnectConnectionError) as e:
        sys.exit(f"Login failed: {e}")

    name = client.get_full_name() or email
    print(f"Logged in as {name}. Tokens saved to {store}")
    print("You can now start the MCP server with `garmin-mcp`.")


if __name__ == "__main__":
    main()
