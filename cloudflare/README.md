# Deploying garmin-mcp to Cloudflare

This runs the same Python MCP server as a remote MCP endpoint on Cloudflare, so
agents can use it without the server running on your machine.

```
claude.ai ─────────OAuth 2.1 token───────┐
                                         ├─▶ Worker (/mcp) ──▶ Container (Python, :8080/mcp)
Claude Code / SDK ─Bearer MCP_AUTH_TOKEN─┘     │
                                               ├─ KV: OAuth clients, grants, hashed tokens
                                               └─ Durable Object storage: Garmin tokens
```

- **Container:** the repo-root `Dockerfile`, running `garmin-mcp-http` (Streamable HTTP,
  stateless, JSON responses). It sleeps after 15 minutes idle and cold-starts on the next call.
- **Worker** (`src/index.ts`): an OAuth 2.1 authorization server (via
  [`@cloudflare/workers-oauth-provider`](https://github.com/cloudflare/workers-oauth-provider))
  so OAuth-only clients such as claude.ai can connect. You approve each client by entering your
  access key (`MCP_AUTH_TOKEN`) on its sign-in page; the same key also works directly as a
  bearer token. It also starts the container with your Garmin tokens and saves refreshed tokens
  the container reports back so they survive restarts.

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
   The first deploy takes a few minutes while the container is provisioned, and creates the
   `OAUTH_KV` namespace for you. The output shows the URL, e.g.
   `https://garmin-mcp.<your-subdomain>.workers.dev`. Requests fail until the secrets below are
   set. (If your Wrangler doesn't create the namespace, run
   `npx wrangler kv namespace create OAUTH_KV` and add the printed `id` to `wrangler.jsonc`.)
3. Log in to Garmin **locally**. The login needs your password and an MFA code, and Garmin
   often blocks logins from cloud IPs, so it always runs on your machine. From the repo root:
   ```bash
   uv run garmin-mcp-login
   ```
4. Upload the Garmin tokens:
   ```bash
   npx wrangler secret put GARMIN_TOKENS < ~/.garminconnect/garmin_tokens.json
   ```
5. Create your access key:
   ```bash
   openssl rand -hex 32 | tee /dev/stderr | npx wrangler secret put MCP_AUTH_TOKEN
   ```
   This prints the key once. Save it in your password manager. You enter it on the sign-in
   page when connecting claude.ai, and bearer-token clients send it directly.

Setting a secret deploys a new version automatically, so no extra deploy is needed.

## Connect a client

The endpoint is `https://garmin-mcp.<your-subdomain>.workers.dev/mcp`.

**claude.ai (and the Claude desktop and mobile apps)**

1. In claude.ai, open **Settings → Connectors** and choose **Add custom connector**. On a Team
   or Enterprise plan, an owner adds it under the organization's connector settings.
2. Name it (e.g. "Garmin"), paste the `/mcp` URL above, and leave the OAuth client ID and
   secret under *Advanced settings* empty: claude.ai registers itself.
3. Click **Connect**. A page titled "Allow Claude to read your Garmin data?" opens. Check that
   access goes to **claude.ai**, enter your access key, and click **Allow**.

Access tokens last an hour and claude.ai refreshes them by itself. You'll be asked to approve
again after 90 days, or if you remove and re-add the connector.

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
- **Rotate the access key:** `openssl rand -hex 32 | npx wrangler secret put MCP_AUTH_TOKEN`,
  then update bearer-token clients. This doesn't disconnect clients you already approved
  with OAuth.
- **Disconnect all OAuth clients** (e.g. if a device was lost): delete and re-create the KV
  namespace, or delete the keys starting with `grant:` and `token:` in the dashboard
  (Storage & Databases → KV → OAUTH_KV). Approved clients then have to sign in again.
- **Logs:** `npx wrangler tail`, or Workers & Pages → garmin-mcp → Logs in the dashboard.
- **Cost:** the container only runs while it's being used (it stops 15 minutes after the last
  request). `instance_type` and `sleepAfter` are in `wrangler.jsonc` and `src/index.ts`.

## Security notes

- Anyone with `MCP_AUTH_TOKEN` can read your Garmin health data and approve new OAuth clients.
  Treat it like a password. Wrong keys on the sign-in page are slowed down, but the key is
  only as strong as its randomness: keep it generated by `openssl rand`.
- The sign-in page shows where access will be sent. Only approve when it says **claude.ai**
  (or another app you just started connecting). Anyone can register an OAuth client with any
  name, so the name alone proves nothing.
- OAuth tokens, codes and client secrets are stored in KV only as hashes.
- `GARMIN_TOKENS` grants access to your Garmin account. It's stored as an encrypted Worker
  secret and in the Durable Object's private storage, and it never leaves Cloudflare.
- The container has no authentication of its own and isn't reachable from the internet; only
  this Worker can talk to it.

## Development

```bash
npm run typecheck   # generate binding types and type-check the Worker
npm test            # unit tests for the auth, consent page and token logic
```

To run the container image on its own (no Worker, no auth; for local testing only):

```bash
docker build -t garmin-mcp .. && docker run --rm -p 8080:8080 -e GARMIN_TOKENS_JSON="$(cat ~/.garminconnect/garmin_tokens.json)" garmin-mcp
```
