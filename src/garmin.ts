// Minimal Garmin Connect API client for Workers.
//
// Talks to the same endpoints as the Garmin Connect mobile app, with the same identity
// headers python-garminconnect uses. Login is not here: it needs browser impersonation and
// MFA, so it runs locally (`garmin-mcp-login`). This client only uses and refreshes the
// tokens that login produced.

import type { GarminTokens } from "./logic";

export const API_BASE = "https://connectapi.garmin.com";
export const DI_TOKEN_URL = "https://diauth.garmin.com/di-oauth2-service/oauth/token";

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

export const RELOGIN_HINT =
  "Run `uv run garmin-mcp-login` in login/, then upload the tokens with " +
  "`npx wrangler secret put GARMIN_TOKENS < ~/.garminconnect/garmin_tokens.json`.";

export type GarminErrorKind = "auth" | "not_found" | "rate_limited" | "upstream";

export class GarminError extends Error {
  constructor(
    readonly kind: GarminErrorKind,
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

export type FetchFn = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

// Workers' global fetch must be called unbound-safe; wrap it rather than passing `fetch`.
const defaultFetch: FetchFn = (input, init) => fetch(input, init);

/** Where API calls get their bearer token. Implemented by the GarminSession Durable Object. */
export interface TokenSource {
  accessToken(): Promise<string>;
  /** Called after a 401: refresh, unless another request already replaced `staleToken`. */
  refreshAfter(staleToken: string): Promise<string>;
}

export type QueryParams = Record<string, string | number | boolean | undefined>;

export class GarminClient {
  constructor(
    private readonly tokens: TokenSource,
    private readonly fetchFn: FetchFn = defaultFetch,
  ) {}

  /** GET a Connect API path. Returns parsed JSON, or null for "no content". */
  async get(path: string, params?: QueryParams): Promise<any> {
    const url = new URL(path, API_BASE);
    for (const [key, value] of Object.entries(params ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    let token = await this.tokens.accessToken();
    let res = await this.send(url, token);
    if (res.status === 401) {
      token = await this.tokens.refreshAfter(token);
      res = await this.send(url, token);
    }
    if (res.status === 204) return null;
    if (res.ok) {
      const text = await res.text();
      return text ? JSON.parse(text) : null;
    }

    const body = (await res.text()).slice(0, 200);
    if (res.status === 401 || res.status === 403) {
      throw new GarminError("auth", `Garmin rejected the login (${res.status}). ${RELOGIN_HINT}`, res.status);
    }
    if (res.status === 404) throw new GarminError("not_found", `Not found in Garmin Connect: ${path}`, 404);
    if (res.status === 429) {
      throw new GarminError("rate_limited", "Garmin is rate-limiting requests; wait a few minutes.", 429);
    }
    throw new GarminError("upstream", `Garmin Connect error ${res.status}: ${body}`, res.status);
  }

  private send(url: URL, token: string): Promise<Response> {
    return this.fetchFn(url, {
      headers: { ...NATIVE_HEADERS, Authorization: `Bearer ${token}`, Accept: "application/json" },
    });
  }
}

/** Exchange the refresh token for new tokens. Garmin rotates the refresh token each time. */
export async function refreshTokens(
  tokens: GarminTokens,
  fetchFn: FetchFn = defaultFetch,
): Promise<GarminTokens> {
  const res = await fetchFn(DI_TOKEN_URL, {
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
  if (res.status === 429) {
    throw new GarminError("rate_limited", "Garmin is rate-limiting token refreshes; wait a few minutes.", 429);
  }
  if (!res.ok) {
    throw new GarminError(
      "auth",
      `Garmin token refresh failed (${res.status}); the login has expired. ${RELOGIN_HINT}`,
      res.status,
    );
  }
  const data: any = await res.json();
  if (typeof data?.access_token !== "string") {
    throw new GarminError("upstream", "Garmin token refresh returned no access token.");
  }
  return {
    di_token: data.access_token,
    di_refresh_token: typeof data.refresh_token === "string" ? data.refresh_token : tokens.di_refresh_token,
    di_client_id: tokens.di_client_id,
  };
}

export interface Profile {
  displayName: string;
  /** IANA time zone from the Garmin profile, if set. */
  timeZone?: string;
}

/** Read the display name (needed in many URLs) and the user's time zone. */
export async function fetchProfile(client: GarminClient): Promise<Profile> {
  const social = await client.get("/userprofile-service/socialProfile");
  const displayName = social?.displayName;
  if (typeof displayName !== "string" || !displayName) {
    throw new GarminError("upstream", "Garmin profile has no display name.");
  }
  let timeZone: string | undefined;
  try {
    const info = await client.get(
      `/userprofile-service/userprofile/personal-information/${encodeURIComponent(displayName)}`,
    );
    if (typeof info?.timeZone === "string" && info.timeZone) timeZone = info.timeZone;
  } catch {
    // Not fatal: fall back to the TIMEZONE setting or UTC.
  }
  return { displayName, timeZone };
}
