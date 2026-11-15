// Spike: can a Cloudflare Worker (free plan, plain fetch, no TLS impersonation) talk to
// Garmin Connect's API with tokens from `garmin-mcp-login`?
//
//   GET  /run?key=...                      data calls with the current access token
//   GET  /run?key=...&steps=details        the heavy activity-details call on its own
//   POST /refresh?key=...                  token refresh via diauth.garmin.com, then re-test
//
// Reports only statuses, timings, sizes and a few harmless fields. It never returns tokens.

type Env = {
  GARMIN_TOKENS?: string;
  SPIKE_KEY?: string;
  SPIKE_KV: KVNamespace;
};

type Tokens = { di_token: string; di_refresh_token: string; di_client_id: string };

const API = "https://connectapi.garmin.com";
const DI_TOKEN_URL = "https://diauth.garmin.com/di-oauth2-service/oauth/token";

// Same identity headers python-garminconnect sends for API calls.
const NATIVE_HEADERS: Record<string, string> = {
  "User-Agent": "GCM-Android-5.23",
  "X-Garmin-User-Agent":
    "com.garmin.android.apps.connectmobile/5.23; ; Google/sdk_gphone64_arm64/google; Android/33; Dalvik/2.1.0",
  "X-Garmin-Paired-App-Version": "10861",
  "X-Garmin-Client-Platform": "Android",
  "X-App-Ver": "10861",
  "X-Lang": "en",
  "X-GCExperience": "GC5",
  "Accept-Language": "en-US,en;q=0.9",
};

// ----------------------------------------------------------------------------- helpers

async function loadTokens(env: Env): Promise<{ tokens: Tokens; source: string }> {
  const stored = await env.SPIKE_KV.get("tokens");
  const raw = stored ?? env.GARMIN_TOKENS;
  if (!raw) throw new Error("GARMIN_TOKENS secret is not set");
  return { tokens: JSON.parse(raw) as Tokens, source: stored ? "kv (refreshed)" : "secret" };
}

function jwtExpiry(token: string): string | null {
  try {
    const payload = JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
    if (typeof payload.exp !== "number") return null;
    const hours = (payload.exp * 1000 - Date.now()) / 3_600_000;
    return `${new Date(payload.exp * 1000).toISOString()} (${hours.toFixed(1)} h from now)`;
  } catch {
    return null;
  }
}

/** Response headers that reveal bot protection or where the request was answered. */
function telltaleHeaders(res: Response): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of ["server", "cf-ray", "cf-mitigated", "content-type", "retry-after"]) {
    const value = res.headers.get(name);
    if (value) out[name] = value;
  }
  return out;
}

type StepResult = {
  step: string;
  ok: boolean;
  status?: number;
  ms?: number;
  bytes?: number;
  headers?: Record<string, string>;
  info?: Record<string, unknown>;
  error?: string;
};

async function api(path: string, token: string, step: string): Promise<{ result: StepResult; json: any }> {
  const started = Date.now(); // advances across I/O in Workers, so this is network time
  try {
    const res = await fetch(`${API}${path}`, {
      headers: { ...NATIVE_HEADERS, Authorization: `Bearer ${token}`, Accept: "application/json" },
    });
    const text = await res.text();
    const result: StepResult = {
      step,
      ok: res.ok,
      status: res.status,
      ms: Date.now() - started,
      bytes: text.length,
      headers: telltaleHeaders(res),
    };
    let json: any = null;
    if (res.ok && text) json = JSON.parse(text); // parse like the real tools would (CPU cost)
    if (!res.ok) result.error = text.slice(0, 300);
    return { result, json };
  } catch (e) {
    return { result: { step, ok: false, ms: Date.now() - started, error: String(e) }, json: null };
  }
}

const today = () => new Date().toISOString().slice(0, 10);
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

// ----------------------------------------------------------------------------- tests

async function runDataCalls(token: string, steps: Set<string>): Promise<StepResult[]> {
  const results: StepResult[] = [];
  const profile = await api("/userprofile-service/socialProfile", token, "profile");
  if (profile.json) profile.result.info = { has_display_name: Boolean(profile.json.displayName) };
  results.push(profile.result);
  const displayName = encodeURIComponent(profile.json?.displayName ?? "");
  if (!displayName) return results;

  if (steps.has("sleep")) {
    const r = await api(
      `/wellness-service/wellness/dailySleepData/${displayName}?date=${today()}&nonSleepBufferMinutes=60`,
      token,
      "sleep (today)",
    );
    if (r.json) {
      r.result.info = {
        sleep_score: r.json.dailySleepDTO?.sleepScores?.overall?.value ?? null,
        sleep_seconds: r.json.dailySleepDTO?.sleepTimeSeconds ?? null,
      };
    }
    results.push(r.result);
  }
  if (steps.has("hrv")) {
    const r = await api(`/hrv-service/hrv/${today()}`, token, "hrv (today)");
    if (r.json) r.result.info = { last_night_avg: r.json.hrvSummary?.lastNightAvg ?? null };
    results.push(r.result);
  }
  if (steps.has("summary")) {
    const r = await api(
      `/usersummary-service/usersummary/daily/${displayName}?calendarDate=${today()}`,
      token,
      "daily summary (today)",
    );
    if (r.json) r.result.info = { steps: r.json.totalSteps ?? null };
    results.push(r.result);
  }
  let latestActivityId: number | undefined;
  if (steps.has("activities") || steps.has("details")) {
    const r = await api(
      `/activitylist-service/activities/search/activities?startDate=${daysAgo(30)}&endDate=${today()}&start=0&limit=5`,
      token,
      "activities (last 30 days)",
    );
    if (Array.isArray(r.json)) {
      latestActivityId = r.json[0]?.activityId;
      r.result.info = { count: r.json.length, latest_type: r.json[0]?.activityType?.typeKey ?? null };
    }
    results.push(r.result);
  }
  if (steps.has("details")) {
    if (!latestActivityId) {
      results.push({ step: "activity details", ok: false, error: "no activity in the last 30 days" });
    } else {
      const r = await api(
        `/activity-service/activity/${latestActivityId}/details?maxChartSize=2000&maxPolylineSize=4000`,
        token,
        "activity details (heaviest call)",
      );
      results.push(r.result);
    }
  }
  return results;
}

async function refresh(env: Env): Promise<Response> {
  const { tokens, source } = await loadTokens(env);
  const started = Date.now();
  const res = await fetch(DI_TOKEN_URL, {
    method: "POST",
    headers: {
      ...NATIVE_HEADERS,
      Authorization: `Basic ${btoa(`${tokens.di_client_id}:`)}`,
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
      "Cache-Control": "no-cache",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: tokens.di_client_id,
      refresh_token: tokens.di_refresh_token,
    }),
  });
  const text = await res.text();
  const report: Record<string, unknown> = {
    step: "refresh (diauth.garmin.com)",
    tokens_from: source,
    ok: res.ok,
    status: res.status,
    ms: Date.now() - started,
    headers: telltaleHeaders(res),
  };
  if (!res.ok) {
    report.error = text.slice(0, 300);
    return Response.json(report, { status: 502 });
  }
  const data = JSON.parse(text);
  const next: Tokens = {
    di_token: data.access_token,
    di_refresh_token: data.refresh_token ?? tokens.di_refresh_token,
    di_client_id: tokens.di_client_id,
  };
  await env.SPIKE_KV.put("tokens", JSON.stringify(next));
  report.refresh_token_rotated = next.di_refresh_token !== tokens.di_refresh_token;
  report.new_access_token_expires = jwtExpiry(next.di_token);
  report.refresh_token_expires_in_s = data.refresh_token_expires_in ?? null;
  report.check_with_new_token = await runDataCalls(next.di_token, new Set(["sleep"]));
  return Response.json(report);
}

// ----------------------------------------------------------------------------- entry

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    if (!env.SPIKE_KEY || url.searchParams.get("key") !== env.SPIKE_KEY) {
      return new Response("Not found\n", { status: 404 });
    }
    try {
      if (url.pathname === "/run" && request.method === "GET") {
        const { tokens, source } = await loadTokens(env);
        const steps = new Set(
          (url.searchParams.get("steps") ?? "sleep,hrv,summary,activities").split(","),
        );
        const results = await runDataCalls(tokens.di_token, steps);
        return Response.json({
          tokens_from: source,
          access_token_expires: jwtExpiry(tokens.di_token),
          all_ok: results.every((r) => r.ok),
          results,
        });
      }
      if (url.pathname === "/refresh" && request.method === "POST") return await refresh(env);
      return new Response("Use GET /run or POST /refresh\n", { status: 404 });
    } catch (e) {
      return Response.json({ error: String(e) }, { status: 500 });
    }
  },
} satisfies ExportedHandler<Env>;
