# Garmin MCP — setup & usage guide for agents

## What it is
`garmin-mcp` (https://github.com/tomoima525/garmin-mcp) is a local MCP server (stdio) that gives
read-only access to the user's Garmin Connect data: sleep, HRV, Body Battery, stress, training
readiness/status, daily stats, and activities (runs, rides, swims, ...). It uses the unofficial
python-garminconnect library and is for the user's own account only.

## Setup (one time)
Requirements: Python 3.12+, [`uv`](https://docs.astral.sh/uv/).

1. Clone and install:
   ```bash
   git clone https://github.com/tomoima525/garmin-mcp && cd garmin-mcp && uv sync
   ```
2. Log in. **The human must do this step**, because it asks for a password and an MFA code:
   ```bash
   uv run garmin-mcp-login
   ```
   This saves OAuth tokens (not the password) to `~/.garminconnect` (override with env
   `GARMINTOKENS`). Never ask the user to paste their Garmin password into chat.
3. Register the server with your MCP client:
   - Claude Code:
     ```bash
     claude mcp add garmin -- uv --directory /ABS/PATH/garmin-mcp run garmin-mcp
     ```
   - Claude Desktop / generic MCP config:
     ```json
     {"mcpServers": {"garmin": {"command": "uv",
       "args": ["--directory", "/ABS/PATH/garmin-mcp", "run", "garmin-mcp"]}}}
     ```
   - Claude Agent SDK (Python): pass the same command/args in
     `ClaudeAgentOptions(mcp_servers={"garmin": {...}}, allowed_tools=["mcp__garmin__*"])`.
4. Verify: call `get_daily_summary` with no arguments. A login error means step 2 wasn't done.

## Conventions
- Dates: `YYYY-MM-DD`, user's local time; omitted dates default to today.
- Sleep for date D = the night that **ended** on the morning of D ("last night" = today's date).
- Units: distance in meters, duration in seconds, speed in m/s. Fields with a unit suffix say so
  (e.g. `avg_pace_min_per_km`, `deep_s`).
- Range tools accept at most 31 days. For longer periods, make several calls.
- Minute-by-minute series are replaced with `"<N items omitted ...>"`. Pass
  `include_timeseries: true` only when you actually need the curve; responses get large.
- All tools are read-only. Nothing can modify the user's Garmin data.

## Tools
| Tool | Args | Use for |
|---|---|---|
| `get_daily_summary` | date? | Steps, calories, resting HR, stress, Body Battery, intensity minutes |
| `get_sleep` | date?, include_timeseries? | One night: `summary` (score, stages, HRV, RHR, SpO2) + `details` |
| `get_sleep_trend` | start_date, end_date? | One compact row per night (≤31 days); use for trends |
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
| `garmin_query` | method, args?, include_timeseries? | Escape hatch for ~45 allow-listed read-only methods. Call with `method="help"` first to see names and parameters |

## Recommended patterns
- "How did I sleep?" → `get_sleep` (today). "Sleep this week/month?" → `get_sleep_trend`.
- "Am I ready to train hard?" → `get_training_readiness` + `get_hrv` + `get_sleep` (today), then
  `get_training_status` for load context.
- "My recent runs" → `list_activities(activity_type="running")`, then `get_activity` for any run
  the user wants broken down.
- Prefer summary tools first; fetch details/timeseries only when needed.

## Errors
- "No Garmin tokens found" / "authentication failed" → ask the human to run
  `uv run garmin-mcp-login` in the repo directory, then retry. Do not loop retries.
- "rate-limiting" → wait a few minutes; don't hammer the API.
- Empty or missing fields usually mean the watch wasn't worn or that metric isn't supported by
  the device. Say so rather than guessing.
- Health data is personal: don't send it to external services unless the user asks.

## Working on this repo
- `uv run pytest` (fake Garmin client, no network) and `uv run ruff check .` before committing.
- New tools go in `src/garmin_mcp/server.py`: decorate with `@mcp.tool(annotations=READ_ONLY)`
  and `@_garmin_errors`, and keep them read-only.
