# Spike: Garmin API from a free-plan Cloudflare Worker

A throwaway test to answer one question before porting the server to TypeScript: **will Garmin
answer API calls (and token refreshes) sent from a Cloudflare Worker?** The Python library
disguises its token refresh as Chrome (`curl_cffi`), which a Worker can't do, and Garmin may treat
Cloudflare's IPs differently.

Works on the **Workers Free** plan. Takes about 10 minutes. Delete it afterwards.

## Run it

From this folder (`spike/workers-free/`):

```bash
npm install && npx wrangler login && npx wrangler deploy
```

Log in to Garmin locally, so the tokens are fresh (from the repo root):

```bash
uv run garmin-mcp-login
```

Upload the tokens and a key that protects the test URL:

```bash
npx wrangler secret put GARMIN_TOKENS < ~/.garminconnect/garmin_tokens.json
```

```bash
export SPIKE_KEY=$(openssl rand -hex 16) && echo "$SPIKE_KEY" | npx wrangler secret put SPIKE_KEY
```

Set `URL` to the address `wrangler deploy` printed, e.g.:

```bash
export URL=https://garmin-spike.<your-subdomain>.workers.dev
```

### Test 1: data calls

```bash
curl -s "$URL/run?key=$SPIKE_KEY"
```

### Test 2: the heaviest call (CPU limit check)

```bash
curl -s "$URL/run?key=$SPIKE_KEY&steps=details"
```

### Test 3: token refresh

This asks Garmin for new tokens. Garmin may replace the refresh token, which can make the tokens
on your machine stop working. If the local server or the container deployment then reports
"authentication failed", run `uv run garmin-mcp-login` again.

```bash
curl -s -X POST "$URL/refresh?key=$SPIKE_KEY"
```

Paste the three outputs back into the chat. They contain only statuses, timings, sizes and your
sleep score/step count, never tokens.

## Reading the results

| What you see | Meaning |
| --- | --- |
| `"all_ok": true` in test 1 | Data calls from Workers work |
| `403` or `429` with `cf-mitigated` or an HTML error page | Garmin's bot protection blocks Workers |
| `401` in test 1 | Access token expired: run test 3, then test 1 again |
| Test 2 fails with "Exceeded CPU" / error 1102 | Big responses exceed the free plan's 10 ms CPU limit |
| Test 3 `"ok": true` | Workers can refresh tokens, so you rarely need to log in again |

CPU time per request is also shown in the dashboard: Workers & Pages → garmin-spike →
Metrics → CPU time.

## Clean up

```bash
npx wrangler delete
```

Also delete the KV namespace `wrangler deploy` created for it, under Storage & Databases → KV
(`npx wrangler kv namespace list` shows its name).
