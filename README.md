# garmin-mcp

An [MCP](https://modelcontextprotocol.io) server that lets an AI agent read your
Garmin Connect data — sleep score, HRV, Body Battery, stress, training
readiness, runs and other activities.

It uses the unofficial [`python-garminconnect`](https://github.com/cyberjunky/python-garminconnect)
library, which talks to the same private API as the Garmin Connect app. It is
meant for **personal use with your own account**. Garmin can change that API at
any time, so things may occasionally break until the library is updated.

> Handing this to an AI agent? Point it at [AGENTS.md](AGENTS.md) for setup and usage instructions.

## Tools

All tools are read-only. Dates are `YYYY-MM-DD` (local time) and default to today.

| Tool | What it returns |
| --- | --- |
| `get_daily_summary` | Steps, calories, resting HR, stress, Body Battery, intensity minutes |
| `get_sleep` | One night: sleep score, stages, overnight HRV, resting HR, SpO2, respiration |
| `get_sleep_trend` | One compact row per night for up to 31 days |
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
| `garmin_query` | Escape hatch: call one of ~45 allow-listed read-only library methods (`method="help"` lists them) |

Minute-by-minute series (heart rate, stress, sleep movement, ...) are replaced
with a short placeholder to keep responses small. Pass `include_timeseries: true`
where supported to get them.

## Setup

Requires Python 3.12+ and [uv](https://docs.astral.sh/uv/).

```bash
git clone <this repo> && cd garmin-mcp
uv sync
```

### 1. Log in once

```bash
uv run garmin-mcp-login
```

You'll be asked for your Garmin email, password and, if you have two-step
verification on, the code. Only OAuth tokens are saved, to `~/.garminconnect`
(override with `GARMINTOKENS=/some/dir`). Your password is not stored. Tokens
refresh automatically; if they ever stop working, run the login again.

### 2. Connect it to your agent

**Claude Code**

```bash
claude mcp add garmin -- uv --directory /absolute/path/to/garmin-mcp run garmin-mcp
```

**Claude Desktop** — add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "garmin": {
      "command": "uv",
      "args": ["--directory", "/absolute/path/to/garmin-mcp", "run", "garmin-mcp"]
    }
  }
}
```

**Your own agent (Claude Agent SDK, Python)**

```python
from claude_agent_sdk import ClaudeAgentOptions, query

options = ClaudeAgentOptions(
    mcp_servers={
        "garmin": {
            "command": "uv",
            "args": ["--directory", "/absolute/path/to/garmin-mcp", "run", "garmin-mcp"],
        }
    },
    allowed_tools=["mcp__garmin__*"],
)

async for msg in query(
    prompt="How did I sleep this week, and am I ready for a hard run?", options=options
):
    print(msg)
```

### Try it with the MCP Inspector

```bash
npx @modelcontextprotocol/inspector uv --directory . run garmin-mcp
```

## Example prompts

- "How did I sleep last night compared with my average this month?"
- "List my runs from the past two weeks with pace and average HR."
- "Is my HRV trending down? Should I take a rest day?"
- "Break down yesterday's long run by kilometer."

## Development

```bash
uv run pytest        # tests use a fake Garmin client; no network or account needed
uv run ruff check .
```

## Notes

- **Rate limits:** Garmin rate-limits logins harder than data requests. Don't
  loop the login command; the server reuses saved tokens.
- **Security:** treat `~/.garminconnect` like a password. Anyone holding those
  tokens can read your Garmin data. It's in `.gitignore`; never commit it.
- **Terms:** this uses an unofficial API. For a multi-user product, use Garmin's
  official [Connect Developer Program](https://developer.garmin.com/gc-developer-program/) instead.
