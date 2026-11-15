# garmin-mcp-login

Signs in to Garmin Connect once and saves the tokens the Worker needs. Garmin's login needs your
password and an MFA code and blocks automated logins, so this runs on your machine, not on
Cloudflare. Your password is never stored.

```bash
uv run garmin-mcp-login
```

Tokens are written to `~/.garminconnect/garmin_tokens.json` (override the folder with
`GARMINTOKENS=/some/dir`). See the main [README](../README.md) for uploading them.
