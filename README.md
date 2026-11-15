# garmin-mcp

A remote [MCP](https://modelcontextprotocol.io) server that lets AI agents read your Garmin
Connect data — sleep score, HRV, Body Battery, stress, training readiness, runs and other
activities. It runs on **Cloudflare Workers' free plan** and works with claude.ai (as a custom
connector), Claude Code, the Claude Agent SDK and any MCP client.

```
claude.ai ─────────OAuth 2.1 token───────┐
                                         ├─▶ Worker /mcp ──▶ Garmin Connect API
Claude Code / SDK ─Bearer MCP_AUTH_TOKEN─┘      │
                                                ├─ GarminSession (Durable Object): Garmin tokens
                                                └─ KV: OAuth clients and grants (hashed)
```

It talks to Garmin's private API (the one the Garmin Connect app uses), so it's meant for
**personal use with your own account**. Garmin can change that API at any time.

## How it works

- **Login runs on your machine** (`login/`, Python). Garmin's sign-in needs your password and an
  MFA code and blocks automated logins, so you do it once locally. Only tokens are saved, never
  your password.
- **Everything else runs in the Worker** (`src/`, TypeScript). It refreshes the Garmin tokens by
  itself and stores them in a Durable Object, which also makes sure only one refresh happens at a
  time (Garmin replaces the refresh token on every refresh). A weekly scheduled refresh keeps the
  login alive even if you don't use the server for a while.
- **OAuth sign-in for claude.ai.** The Worker is an OAuth 2.1 authorization server, so claude.ai
  can connect. You approve each app on a sign-in page with your access key. The same key also
  works directly as a bearer token.

## Requirements

- A Cloudflare account. The free plan is enough.
- Node.js 20+.
- Python 3.12+ and [uv](https://docs.astral.sh/uv/), for the one-time login.

## Set up

1. Install and sign in to Cloudflare:
   ```bash
   npm install
   ```
   ```bash
   npx wrangler login
   ```
2. Deploy. The first deploy also creates the KV namespace for OAuth. The output shows your URL,
   e.g. `https://garmin-mcp.<your-subdomain>.workers.dev`.
   ```bash
   npm run deploy
   ```
   If your Wrangler doesn't create the namespace, run `npx wrangler kv namespace create OAUTH_KV`
   and add the printed `id` to `kv_namespaces` in `wrangler.jsonc`.
3. Log in to Garmin on your machine:
   ```bash
   cd login && uv run garmin-mcp-login && cd ..
   ```
4. Upload the Garmin tokens:
   ```bash
   npx wrangler secret put GARMIN_TOKENS < ~/.garminconnect/garmin_tokens.json
   ```
5. Create your access key. This prints it once: save it in your password manager.
   ```bash
   openssl rand -hex 32 | tee /dev/stderr | npx wrangler secret put MCP_AUTH_TOKEN
   ```

Setting a secret deploys a new version automatically.

> **Deployed an earlier, container-based version?** Delete it first with `npx wrangler delete`,
> then follow the steps above. The storage layout changed, so it can't be upgraded in place.

## Connect a client

Your MCP endpoint is `https://garmin-mcp.<your-subdomain>.workers.dev/mcp`.

**claude.ai** (also used by the Claude desktop and mobile apps)

1. Open **Settings → Connectors** and choose **Add custom connector**. On a Team or Enterprise
   plan, an owner adds it under the organization's connector settings.
2. Name it (e.g. "Garmin") and paste the `/mcp` URL. Leave the OAuth client ID and secret under
   *Advanced settings* empty: claude.ai registers itself.
3. Click **Connect**. On the page "Allow Claude to read your Garmin data?", check that access
   goes to **claude.ai**, enter your access key and click **Allow**.

claude.ai renews its access by itself. You approve again after 90 days.

**Claude Code**

```bash
claude mcp add --transport http garmin https://garmin-mcp.<your-subdomain>.workers.dev/mcp --header "Authorization: Bearer <MCP_AUTH_TOKEN>"
```

**Claude Agent SDK (Python)**

```python
options = ClaudeAgentOptions(
    mcp_servers={
        "garmin": {
            "type": "http",
            "url": "https://garmin-mcp.<your-subdomain>.workers.dev/mcp",
            "headers": {"Authorization": f"Bearer {os.environ['GARMIN_MCP_TOKEN']}"},
        }
    },
    allowed_tools=["mcp__garmin__*"],
)
```

**Quick check with curl**

```bash
curl -s https://garmin-mcp.<your-subdomain>.workers.dev/mcp -H "Authorization: Bearer $GARMIN_MCP_TOKEN" -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_daily_summary","arguments":{}}}'
```

## Tools

All tools are read-only. Dates are `YYYY-MM-DD` in your local time zone and default to today.

| Tool | What it returns |
| --- | --- |
| `get_daily_summary` | Steps, calories, resting HR, stress, Body Battery, intensity minutes |
| `get_sleep` | One night: sleep score, stages, overnight HRV, resting HR, SpO2, respiration |
| `get_sleep_trend` | Daily sleep statistics for up to 90 days |
| `get_hrv` | Overnight HRV, weekly average, baseline, HRV status |
| `get_training_readiness` | Readiness score and contributing factors |
| `get_body_battery` | Charged / drained / high / low per day |
| `get_stress` | Average / max stress and time in each stress level |
| `get_heart_rate` | Resting, min, max HR for a day |
| `list_activities` | Activities in a date range (filter by `running`, `cycling`, ...) with pace, HR, training effect |
| `get_activity` | One activity in detail: splits/laps and time in HR zones |
| `get_training_status` | Training status, acute/chronic load, VO2 max |
| `get_race_predictions` | Predicted 5K / 10K / half / full marathon times |
| `get_body_composition` | Weight, BMI, body fat %, muscle mass |
| `garmin_get` | Escape hatch: GET any read-only Garmin API path under an allowed service |

Minute-by-minute series (heart rate, stress, sleep movement, ...) are replaced with a short
placeholder to keep responses small. Pass `include_timeseries: true` where supported to get them.

**Time zone:** "today" is worked out in the time zone set in your Garmin profile. To override
it, add `"vars": { "TIMEZONE": "America/Los_Angeles" }` to `wrangler.jsonc` and deploy.

## Operations

- **Garmin login expired** (tools say "the login has expired"): run step 3 and step 4 again. The
  Worker notices the new secret and switches to it. With the weekly refresh this should only be
  needed if Garmin revokes the login, or the Worker was unused for 30 days with the schedule off.
- **Rotate the access key:** `openssl rand -hex 32 | npx wrangler secret put MCP_AUTH_TOKEN`,
  then update bearer-token clients. Apps already approved through OAuth stay connected.
- **Disconnect all OAuth apps** (e.g. a lost device): in the dashboard, Storage & Databases → KV →
  OAUTH_KV, delete the keys starting with `grant:` and `token:`. Apps must sign in again.
- **Logs:** `npx wrangler tail`, or Workers & Pages → garmin-mcp → Logs.
- **Free plan limits:** 100,000 requests a day and 10 ms of CPU per request (waiting on Garmin
  doesn't count). Even a 1 MB Garmin response used about 5 ms in testing.

## Security notes

- Anyone with `MCP_AUTH_TOKEN` can read your Garmin data and approve new apps. Treat it like a
  password and keep it generated by `openssl rand`. Wrong keys on the sign-in page are slowed down.
- The sign-in page shows where access will be sent. Only approve when it says **claude.ai** (or
  another app you just started connecting). Anyone can register an app under any name.
- `GARMIN_TOKENS` and the refreshed tokens give access to your Garmin account. They live in an
  encrypted Worker secret and in the Durable Object's private storage, and never leave
  Cloudflare. OAuth tokens and codes are stored in KV only as hashes.
- Never commit `~/.garminconnect` or `.dev.vars`; both are in `.gitignore`.

## Development

```bash
npm test            # unit tests (fake Garmin, no network)
npm run test:e2e    # bundles the Worker and runs it in the Workers runtime against a fake Garmin
npm run typecheck   # generate binding types and type-check
```

To run locally, put `MCP_AUTH_TOKEN=...` and `GARMIN_TOKENS=...` (the token JSON on one line) in
`.dev.vars`, then `npm run dev`. The endpoint is `http://localhost:8787/mcp`.

Code layout: `src/index.ts` (routing, OAuth, MCP endpoint, schedule), `src/tools.ts` (the MCP
tools), `src/garmin.ts` (Garmin API client and token refresh), `src/session.ts` (token storage),
`src/consent.ts` (sign-in page), `login/` (the Python login tool).
