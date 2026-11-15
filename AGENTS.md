# Garmin MCP — guide for agents

## What it is
`garmin-mcp` (https://github.com/tomoima525/garmin-mcp) is a remote MCP server on Cloudflare
Workers that gives read-only access to the user's Garmin Connect data: sleep, HRV, Body Battery,
stress, training readiness/status, daily stats and activities (runs, rides, swims, ...). It is for
the user's own account only.

## Connecting
The user deploys it once (see README.md). Then connect over Streamable HTTP:
- URL: `https://garmin-mcp.<subdomain>.workers.dev/mcp` (ask the user for their URL).
- Auth, either:
  - OAuth 2.1 (claude.ai custom connectors and other OAuth clients): the client discovers and
    registers by itself; the human approves it on the sign-in page with their access key.
  - Header `Authorization: Bearer <MCP_AUTH_TOKEN>`. Ask the user for it; never print or log it.
- Claude Code:
  ```bash
  claude mcp add --transport http garmin https://garmin-mcp.<subdomain>.workers.dev/mcp --header "Authorization: Bearer <MCP_AUTH_TOKEN>"
  ```
- Verify: call `get_daily_summary` with no arguments.

Setup steps that need the human: the Garmin login (`cd login && uv run garmin-mcp-login`, which
asks for their password and an MFA code) and creating secrets. Never ask the user to paste their
Garmin password or tokens into chat.

## Conventions
- Dates: `YYYY-MM-DD` in the user's local time zone; omitted dates default to today.
- Sleep for date D = the night that **ended** on the morning of D ("last night" = today's date).
- Units: distance in meters, duration in seconds, speed in m/s. Fields with a unit suffix say so
  (e.g. `avg_pace_min_per_km`, `deep_s`).
- Range tools accept at most 31 days (`get_sleep_trend`: 90). For longer periods, make several
  calls.
- Minute-by-minute series are replaced with `"<N items omitted ...>"`. Pass
  `include_timeseries: true` only when you need the curve; responses get large.
- All tools are read-only. Nothing can modify the user's Garmin data.

## Tools
| Tool | Args | Use for |
|---|---|---|
| `get_daily_summary` | date? | Steps, calories, resting HR, stress, Body Battery, intensity minutes |
| `get_sleep` | date?, include_timeseries? | One night: `summary` (score, stages, HRV, RHR, SpO2) + `details` |
| `get_sleep_trend` | start_date, end_date? | Daily sleep stats for up to 90 days; use for trends |
| `get_hrv` | date?, include_timeseries? | Overnight HRV, weekly avg, baseline, status |
| `get_training_readiness` | date? | Readiness score + contributing factors |
| `get_body_battery` | start_date?, end_date?, include_timeseries? | Charged/drained/high/low per day |
| `get_stress` | date?, include_timeseries? | Avg/max stress, time per stress level |
| `get_heart_rate` | date?, include_timeseries? | Resting/min/max HR |
| `list_activities` | start_date, end_date?, activity_type? | Activities newest first; type e.g. `running`, `cycling`, `swimming`, `strength_training` |
| `get_activity` | activity_id, include_splits?, include_hr_zones? | One activity: details, splits/laps, HR zones (id from `list_activities`) |
| `get_training_status` | date? | Training status, acute/chronic load, VO2 max |
| `get_race_predictions` | — | Predicted 5K/10K/half/marathon times |
| `get_body_composition` | start_date?, end_date? | Weight, BMI, body fat %, muscle mass |
| `garmin_get` | path, params?, include_timeseries? | Escape hatch: GET a read-only Garmin API path under an allowed service; its description lists useful paths |

## Recommended patterns
- "How did I sleep?" → `get_sleep` (today). "Sleep this week/month?" → `get_sleep_trend`.
- "Am I ready to train hard?" → `get_training_readiness` + `get_hrv` + `get_sleep` (today), then
  `get_training_status` for load context.
- "My recent runs" → `list_activities(activity_type="running")`, then `get_activity` for any run
  the user wants broken down.
- Prefer summary tools first; fetch details/timeseries only when needed.

## Errors
- "the login has expired" / "Garmin rejected the login" / "GARMIN_TOKENS secret is not set" → the
  human must re-run the Garmin login and upload the tokens (README, set-up steps 3 and 4). Do not
  loop retries.
- "rate-limiting" → wait a few minutes; don't hammer the API.
- Empty or missing fields usually mean the watch wasn't worn or the device doesn't support that
  metric. Say so rather than guessing.
- Health data is personal: don't send it to external services unless the user asks.

## Working on this repo
- Worker (TypeScript, `src/`): `npm test`, `npm run test:e2e` and `npm run typecheck` before
  committing.
- Login tool (Python, `login/`): `uv run ruff check .` and `uv run ruff format --check .`.
- New tools go in `src/tools.ts` via the `tool(...)` helper (read-only annotations are added for
  you), with a test in `test/tools.test.ts`. Find Garmin endpoints in python-garminconnect's
  source. Keep everything read-only: the Garmin client only sends GET requests.
- The free plan allows 10 ms CPU and 50 outbound requests per call; keep tools within that.
