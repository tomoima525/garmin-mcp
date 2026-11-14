import { describe, expect, it } from "vitest";
import { chooseTokens, isAuthorized, isTokenJson } from "./logic";

describe("isAuthorized", () => {
  it("accepts the right bearer token", async () => {
    expect(await isAuthorized("Bearer s3cret", "s3cret")).toBe(true);
    expect(await isAuthorized("bearer   s3cret ", "s3cret")).toBe(true);
  });
  it("rejects wrong, missing or malformed credentials", async () => {
    expect(await isAuthorized("Bearer nope", "s3cret")).toBe(false);
    expect(await isAuthorized(null, "s3cret")).toBe(false);
    expect(await isAuthorized("Basic s3cret", "s3cret")).toBe(false);
    expect(await isAuthorized("Bearer s3cret", "")).toBe(false);
  });
});

describe("isTokenJson", () => {
  it("recognizes garminconnect token JSON", () => {
    expect(isTokenJson('{"di_token":"a","di_refresh_token":"b","di_client_id":"c"}')).toBe(true);
    expect(isTokenJson("not json")).toBe(false);
    expect(isTokenJson('{"foo":1}')).toBe(false);
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
