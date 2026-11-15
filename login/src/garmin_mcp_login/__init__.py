"""One-time interactive Garmin Connect login: ``garmin-mcp-login``.

Prompts for email, password and (if enabled) the MFA code, then saves OAuth tokens
to the token store. The password itself is never written to disk. The Worker only
needs the resulting tokens; it refreshes them by itself from then on.
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

DEFAULT_TOKENSTORE = "~/.garminconnect"


def tokenstore_path() -> Path:
    """Folder the tokens are saved in. Override with the GARMINTOKENS env var."""
    return Path(os.environ.get("GARMINTOKENS", DEFAULT_TOKENSTORE)).expanduser()


def main() -> None:
    store = tokenstore_path()
    email = os.environ.get("GARMIN_EMAIL") or input("Garmin email: ").strip()
    password = os.environ.get("GARMIN_PASSWORD") or getpass.getpass("Garmin password: ")

    store.mkdir(mode=0o700, parents=True, exist_ok=True)
    client = Garmin(
        email=email,
        password=password,
        prompt_mfa=lambda: input("MFA code (check your email/app): ").strip(),
    )
    try:
        client.login(str(store))
    except GarminConnectTooManyRequestsError as e:
        sys.exit(f"Garmin is rate-limiting logins: {e}")
    except (GarminConnectAuthenticationError, GarminConnectConnectionError) as e:
        sys.exit(f"Login failed: {e}")

    token_file = store / "garmin_tokens.json"
    name = client.get_full_name() or email
    print(f"Logged in as {name}. Tokens saved to {token_file}")
    print("Upload them to the Worker (from the repo root):")
    print(f"  npx wrangler secret put GARMIN_TOKENS < {token_file}")


if __name__ == "__main__":
    main()
