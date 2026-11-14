# Deploying garmin-mcp to Cloudflare

This runs the same Python MCP server as a remote MCP endpoint on Cloudflare, so
agents can use it without the server running on your machine.

```
MCP client ──Bearer MCP_AUTH_TOKEN──▶ Worker (/mcp) ──▶ Container (Python, :8080/mcp)
                                        │
                                        └─ Durable Object storage: Garmin tokens
```

- **Container:** the repo-root `Dockerfile`, running `garmin-mcp-http` (Streamable HTTP,
  stateless, JSON responses). It sleeps after 15 minutes idle and cold-starts on the next call.
- **Worker** (`src/index.ts`): checks the bearer token, starts the container with your Garmin
  tokens, and saves refreshed tokens the container reports back so they survive restarts.

Why a Container rather than a plain (Python) Worker: `garminconnect` uses blocking HTTP and
native extensions (`curl_cffi`) that Python Workers can't run.

## Requirements

- Cloudflare account on the **Workers Paid** plan (Containers aren't on the free plan).
- Docker running locally: `wrangler deploy` builds the image and pushes it to Cloudflare's
  registry.
- Node.js 20+.

## Deploy

All commands run from this `cloudflare/` directory.

1. Install and sign in:
   ```bash
   npm install
   npx wrangler login
   ```
2. Deploy the Worker and container:
   ```bash
   npm run deploy
   ```
   The first deploy takes a few minutes while the container is provisioned. The output shows
   the URL, e.g. `https://garmin-mcp.<your-subdomain>.workers.dev`. Requests fail until the
   secrets below are set.
3. Log in to Garmin **locally**. The login needs your password and an MFA code, and Garmin
   often blocks logins from cloud IPs, so it always runs on your machine. From the repo root:
   ```bash
   uv run garmin-mcp-login
   ```
4. Upload the Garmin tokens:
   ```bash
   npx wrangler secret put GARMIN_TOKENS < ~/.garminconnect/garmin_tokens.json
   ```
5. Create the access token MCP clients will use:
   ```bash
   openssl rand -hex 32 | tee /dev/stderr | npx wrangler secret put MCP_AUTH_TOKEN
   ```
   This prints the token once. Save it in your password manager; clients need it.

Setting a secret deploys a new version automatically, so no extra deploy is needed.

## Connect a client

The endpoint is `https://garmin-mcp.<your-subdomain>.workers.dev/mcp` with the header
`Authorization: Bearer <MCP_AUTH_TOKEN>`.

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

The first call after an idle period can take several seconds while the container starts.

## Operations

- **Garmin login expired** (tools return "authentication failed"): run `garmin-mcp-login`
  locally again, then re-run the `wrangler secret put GARMIN_TOKENS` command. The Worker
  detects the new secret, restarts the container, and uses the new tokens.
- **Rotate the client token:** `openssl rand -hex 32 | npx wrangler secret put MCP_AUTH_TOKEN`,
  then update your clients.
- **Logs:** `npx wrangler tail`, or Workers & Pages → garmin-mcp → Logs in the dashboard.
- **Cost:** the container only runs while it's being used (it stops 15 minutes after the last
  request). `instance_type` and `sleepAfter` are in `wrangler.jsonc` and `src/index.ts`.

## Security notes

- Anyone with `MCP_AUTH_TOKEN` can read your Garmin health data. Treat it like a password.
- `GARMIN_TOKENS` grants access to your Garmin account. It's stored as an encrypted Worker
  secret and in the Durable Object's private storage, and it never leaves Cloudflare.
- The container has no authentication of its own and isn't reachable from the internet; only
  this Worker can talk to it.
- Clients that only support OAuth (such as claude.ai custom connectors) can't send a bearer
  token. Supporting them needs an OAuth layer in the Worker, which isn't included.

## Development

```bash
npm run typecheck   # generate binding types and type-check the Worker
npm test            # unit tests for the auth and token logic
```

To run the container image on its own (no Worker, no auth; for local testing only):

```bash
docker build -t garmin-mcp .. && docker run --rm -p 8080:8080 -e GARMIN_TOKENS_JSON="$(cat ~/.garminconnect/garmin_tokens.json)" garmin-mcp
```
