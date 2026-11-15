// End-to-end test: the bundled Worker in the real Workers runtime (Miniflare) against a fake
// Garmin API. Run with `npm run test:e2e` (bundles first). No network or Garmin account needed.
//
// Uses the stable Miniflare 4 (aliased as "miniflare-stable"); its runtime is older than our
// compatibility_date, so the date is lowered here. Nothing in the Worker depends on the newer date.
import { Miniflare } from "miniflare-stable";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import assert from "node:assert/strict";

const bundle = process.argv[2] ?? ".e2e/index.js";
const jwt = (exp) => `${btoa('{"alg":"RS256"}')}.${btoa(JSON.stringify({ exp })).replace(/=+$/, "")}.sig`;
const now = Math.floor(Date.now() / 1000);

// ---- fake Garmin
let n = 0;                       // token generation counter
const garmin = { refreshes: [], api: [], reject401Once: null };
function issue() { n += 1; return { access: jwt(now + 29 * 3600) + `#${n}`, refresh: `r${n}` }; }
let current = { access: jwt(now + 600) + "#0", refresh: "r0" };   // expires in 10 min -> must refresh

async function outbound(req) {
  const url = new URL(req.url);
  if (url.host === "diauth.garmin.com") {
    const body = new URLSearchParams(await req.text());
    garmin.refreshes.push(body.get("refresh_token"));
    await new Promise((r) => setTimeout(r, 50));                    // widen any race window
    if (body.get("refresh_token") !== current.refresh) return new Response('{"error":"invalid_grant"}', { status: 400 });
    current = issue();
    return Response.json({ access_token: current.access, refresh_token: current.refresh, expires_in: 104400 });
  }
  if (url.host === "connectapi.garmin.com") {
    const token = req.headers.get("authorization")?.replace("Bearer ", "");
    garmin.api.push({ path: url.pathname + url.search, token: token?.split("#")[1] });
    if (garmin.reject401Once && token === garmin.reject401Once) { garmin.reject401Once = null; return new Response("", { status: 401 }); }
    if (token !== current.access) return new Response("", { status: 401 });
    if (url.pathname === "/userprofile-service/socialProfile") return Response.json({ displayName: "runner1" });
    if (url.pathname.startsWith("/userprofile-service/userprofile/personal-information/")) return Response.json({ timeZone: "America/Los_Angeles" });
    if (url.pathname.startsWith("/wellness-service/wellness/dailySleepData/")) return Response.json({ dailySleepDTO: { sleepScores: { overall: { value: 81 } }, sleepTimeSeconds: 26000 } });
    if (url.pathname.startsWith("/hrv-service/hrv/")) return new Response(null, { status: 204 });
    return new Response("not mocked", { status: 404 });
  }
  return new Response("blocked in test", { status: 599 });
}

const mf = new Miniflare({
  modules: true,
  scriptPath: bundle,
  compatibilityDate: "2026-08-01",
  compatibilityFlags: ["global_fetch_strictly_public", "nodejs_compat"],
  durableObjects: { GARMIN_SESSION: { className: "GarminSession", useSQLite: true } },
  kvNamespaces: ["OAUTH_KV"],
  bindings: {
    MCP_AUTH_TOKEN: "owner-key",
    GARMIN_TOKENS: JSON.stringify({ di_token: current.access, di_refresh_token: current.refresh, di_client_id: "CID" }),
  },
  outboundService: outbound,
});

const mcp = async (key = "owner-key") => {
  const client = new Client({ name: "e2e", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL("http://localhost/mcp"), {
    fetch: (u, init) => mf.dispatchFetch(u, init),
    requestInit: { headers: { authorization: `Bearer ${key}` } },
  }));
  return client;
};
const text = (r) => r.content[0].text;
const step = (name) => console.log(`✓ ${name}`);

try {
  // 1. Unauthenticated -> OAuth challenge
  const unauth = await mf.dispatchFetch("http://localhost/mcp", { method: "POST" });
  assert.equal(unauth.status, 401);
  assert.match(unauth.headers.get("www-authenticate"), /resource_metadata=/);
  step("unauthenticated /mcp gets a 401 OAuth challenge");

  // 2. Wrong key rejected by the SDK client
  await assert.rejects(mcp("wrong"));
  step("wrong bearer key is rejected");

  // 3. Real MCP client: initialize + list tools
  const client = await mcp();
  const { tools } = await client.listTools();
  assert.equal(tools.length, 14);
  step(`MCP client initializes and lists ${tools.length} tools`);

  // 4. Five concurrent calls with a token about to expire -> exactly ONE refresh
  const results = await Promise.all(Array.from({ length: 5 }, () => client.callTool({ name: "get_sleep", arguments: { date: "2026-11-13" } })));
  for (const r of results) assert.ok(!r.isError, text(r));
  assert.deepEqual(garmin.refreshes, ["r0"], `refreshes: ${garmin.refreshes}`);
  assert.equal(JSON.parse(text(results[0])).summary.sleep_score, 81);
  assert.ok(garmin.api.some((c) => c.path === "/wellness-service/wellness/dailySleepData/runner1?date=2026-11-13&nonSleepBufferMinutes=60"));
  step("5 concurrent calls with an expiring token: one refresh, all succeed, sleep_score=81");

  // 5. Garmin revokes the current access token -> one 401, refresh, retry
  garmin.reject401Once = current.access;
  const before = garmin.refreshes.length;
  const r401 = await client.callTool({ name: "get_hrv", arguments: { date: "2026-11-13" } });
  assert.ok(!r401.isError, text(r401));
  assert.match(text(r401), /No HRV data/);
  assert.equal(garmin.refreshes.length, before + 1);
  step("401 from Garmin triggers one refresh and a successful retry");

  // 6. Default date = user's local "today" (America/Los_Angeles from the profile)
  await client.callTool({ name: "get_hrv", arguments: {} });
  const la = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(new Date());
  assert.equal(garmin.api.at(-1).path, `/hrv-service/hrv/${la}`);
  step(`default date uses the profile time zone (${la})`);

  // 7. Weekly cron -> refresh with the latest (rotated) refresh token
  const worker = await mf.getWorker();
  const latest = current.refresh;
  await worker.scheduled({ cron: "17 4 * * 1" });
  assert.equal(garmin.refreshes.at(-1), latest);
  step(`scheduled keep-alive refreshes with the rotated refresh token (${latest})`);

  // 8. Tokens were persisted: a fresh client works without another refresh.
  const count = garmin.refreshes.length;
  const again = await (await mcp()).callTool({ name: "get_sleep", arguments: { date: "2026-11-12" } });
  assert.ok(!again.isError, text(again));
  assert.equal(garmin.refreshes.length, count);
  step("later requests reuse the stored token (no extra refresh)");

  // 9. Expired login -> clear error telling the user what to do
  current.refresh = "revoked-on-garmin";
  garmin.reject401Once = current.access;
  const dead = await client.callTool({ name: "get_stress", arguments: { date: "2026-11-13" } });
  assert.ok(dead.isError);
  assert.match(text(dead), /garmin-mcp-login/);
  step(`expired Garmin login returns a helpful error: "${text(dead).slice(0, 70)}..."`);

  console.log("\nALL E2E CHECKS PASSED");
} finally {
  await mf.dispose();
}
