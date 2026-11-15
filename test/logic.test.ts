import { describe, expect, it } from "vitest";
import { chooseTokens, keyMatches, needsRefresh, parseTokens, tokenExpiresAt } from "../src/logic";

export const jwt = (claims: object) =>
  `${btoa('{"alg":"RS256"}')}.${btoa(JSON.stringify(claims)).replace(/=+$/, "")}.sig`;

describe("keyMatches", () => {
  it("compares access keys in constant time", async () => {
    expect(await keyMatches("k", "k")).toBe(true);
    expect(await keyMatches(" k ", "k")).toBe(true);
    expect(await keyMatches("x", "k")).toBe(false);
    expect(await keyMatches(undefined, "k")).toBe(false);
    expect(await keyMatches("k", undefined)).toBe(false);
  });
});

describe("parseTokens", () => {
  it("accepts garmin-mcp-login's token file", () => {
    const t = parseTokens('{"di_token":"a","di_refresh_token":"b","di_client_id":"c"}');
    expect(t.di_client_id).toBe("c");
  });
  it("explains what is wrong", () => {
    expect(() => parseTokens("nope")).toThrow(/not valid JSON/);
    expect(() => parseTokens('{"di_token":"a"}')).toThrow(/di_refresh_token/);
  });
});

describe("chooseTokens", () => {
  const A = '{"di_refresh_token":"a"}';
  const B = '{"di_refresh_token":"b"}';
  it("adopts a new secret and asks to reseed", () => {
    expect(chooseTokens(A, {})).toEqual({ tokens: A, reseed: true });
    expect(chooseTokens(B, { seed: A, refreshed: '{"x":1}' })).toEqual({ tokens: B, reseed: true });
  });
  it("prefers refreshed tokens once the secret has been adopted", () => {
    expect(chooseTokens(A, { seed: A, refreshed: B })).toEqual({ tokens: B, reseed: false });
    expect(chooseTokens(A, { seed: A })).toEqual({ tokens: A, reseed: false });
  });
  it("keeps working from storage if the secret is removed", () => {
    expect(chooseTokens(undefined, { seed: A, refreshed: B })).toEqual({ tokens: B, reseed: false });
    expect(chooseTokens(undefined, {})).toEqual({ tokens: undefined, reseed: false });
  });
});

describe("token expiry", () => {
  it("reads exp from a JWT", () => {
    expect(tokenExpiresAt(jwt({ exp: 1_700_000_000 }))).toBe(1_700_000_000_000);
    expect(tokenExpiresAt("not-a-jwt")).toBeNull();
    expect(tokenExpiresAt(jwt({}))).toBeNull();
  });
  it("refreshes only when expiry is near", () => {
    const now = 1_700_000_000_000;
    expect(needsRefresh(jwt({ exp: now / 1000 + 600 }), now, 30 * 60_000)).toBe(true);
    expect(needsRefresh(jwt({ exp: now / 1000 + 7200 }), now, 30 * 60_000)).toBe(false);
    expect(needsRefresh("opaque", now, 30 * 60_000)).toBe(false);
  });
});
