import { describe, expect, it, vi } from "vitest";
import { type FetchFn, fetchProfile, GarminClient, GarminError, refreshTokens } from "../src/garmin";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function tokenSource(initial = "t0", refreshed = "t1") {
  return {
    accessToken: vi.fn(async () => initial),
    refreshAfter: vi.fn(async (_stale: string) => refreshed),
  };
}

describe("GarminClient.get", () => {
  it("sends the bearer token, the app identity and query params", async () => {
    const fetchFn = vi.fn<FetchFn>(async () => json({ ok: 1 }));
    const client = new GarminClient(tokenSource(), fetchFn);
    expect(await client.get("/hrv-service/hrv/2026-11-14", { a: 1, skip: undefined })).toEqual({ ok: 1 });
    const [url, init] = fetchFn.mock.calls[0];
    expect(String(url)).toBe("https://connectapi.garmin.com/hrv-service/hrv/2026-11-14?a=1");
    const headers = init!.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer t0");
    expect(headers["User-Agent"]).toBe("GCM-Android-5.23");
    expect(headers["X-Garmin-Client-Platform"]).toBe("Android");
  });

  it("refreshes once on 401 and retries with the new token", async () => {
    const tokens = tokenSource();
    const fetchFn = vi
      .fn<FetchFn>()
      .mockResolvedValueOnce(new Response("", { status: 401 }))
      .mockResolvedValueOnce(json({ ok: 2 }));
    expect(await new GarminClient(tokens, fetchFn).get("/x")).toEqual({ ok: 2 });
    expect(tokens.refreshAfter).toHaveBeenCalledWith("t0");
    expect((fetchFn.mock.calls[1][1]!.headers as Record<string, string>).Authorization).toBe("Bearer t1");
  });

  it("maps statuses to errors and 204 to null", async () => {
    const at = (status: number) => new GarminClient(tokenSource(), async () => new Response(status === 204 ? null : "", { status }));
    expect(await at(204).get("/x")).toBeNull();
    await expect(at(403).get("/x")).rejects.toMatchObject({ kind: "auth" });
    await expect(at(404).get("/x")).rejects.toMatchObject({ kind: "not_found" });
    await expect(at(429).get("/x")).rejects.toMatchObject({ kind: "rate_limited" });
    await expect(at(500).get("/x")).rejects.toBeInstanceOf(GarminError);
  });

  it("gives up after one refresh", async () => {
    const fetchFn = vi.fn<FetchFn>(async () => new Response("", { status: 401 }));
    await expect(new GarminClient(tokenSource(), fetchFn).get("/x")).rejects.toThrow(/garmin-mcp-login/);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });
});

describe("refreshTokens", () => {
  const tokens = { di_token: "a", di_refresh_token: "r", di_client_id: "CID" };

  it("posts a refresh_token grant, keeps the rotated refresh token and its expiry", async () => {
    const fetchFn = vi.fn<FetchFn>(async () =>
      json({ access_token: "a2", refresh_token: "r2", refresh_token_expires_in: 2_591_999 }),
    );
    expect(await refreshTokens(tokens, fetchFn, 1_000)).toEqual({
      tokens: { di_token: "a2", di_refresh_token: "r2", di_client_id: "CID" },
      loginExpiresAt: 1_000 + 2_591_999_000,
    });
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe("https://diauth.garmin.com/di-oauth2-service/oauth/token");
    expect((init!.headers as Record<string, string>).Authorization).toBe(`Basic ${btoa("CID:")}`);
    expect(String(init!.body)).toBe("grant_type=refresh_token&client_id=CID&refresh_token=r");
  });

  it("keeps the old refresh token if Garmin doesn't send a new one", async () => {
    const next = await refreshTokens(tokens, async () => json({ access_token: "a2" }));
    expect(next.tokens.di_refresh_token).toBe("r");
    expect(next.loginExpiresAt).toBeNull();
  });

  it("tells the user to log in again when the refresh is refused", async () => {
    await expect(refreshTokens(tokens, async () => json({ error: "invalid_grant" }, 400))).rejects.toThrow(
      /login has expired.*garmin-mcp-login/,
    );
  });
});

describe("fetchProfile", () => {
  it("reads the display name and time zone", async () => {
    const fetchFn = vi.fn<FetchFn>(async (url) =>
      String(url).includes("socialProfile")
        ? json({ displayName: "runner 1" })
        : json({ timeZone: "America/Los_Angeles" }),
    );
    expect(await fetchProfile(new GarminClient(tokenSource(), fetchFn))).toEqual({
      displayName: "runner 1",
      timeZone: "America/Los_Angeles",
    });
    expect(String(fetchFn.mock.calls[1][0])).toContain("/personal-information/runner%201");
  });

  it("still works if the time zone can't be read", async () => {
    const fetchFn: FetchFn = async (url) =>
      String(url).includes("socialProfile") ? json({ displayName: "r" }) : new Response("", { status: 500 });
    expect(await fetchProfile(new GarminClient(tokenSource(), fetchFn))).toEqual({ displayName: "r", timeZone: undefined });
  });
});
