import { describe, expect, it } from "vitest";
import { DAY_MS, describeStatus, LOGIN_LIFETIME_MS, loginExpiry } from "../src/status";

const NOW = Date.parse("2026-11-17T12:00:00Z");

describe("loginExpiry", () => {
  it("prefers Garmin's figure, else estimates 30 days from the upload", () => {
    expect(loginExpiry({ loginExpiresAt: 5, loginExpiryEstimated: false })).toEqual({ at: 5, estimated: false });
    expect(loginExpiry({ loginUploadedAt: 10 })).toEqual({ at: 10 + LOGIN_LIFETIME_MS, estimated: true });
    expect(loginExpiry({})).toEqual({ estimated: true });
  });
});

describe("describeStatus", () => {
  it("is ok after a recent renewal, with the expiry and schedule", () => {
    const r = describeStatus(
      { loginUploadedAt: NOW - 10 * DAY_MS, lastSuccessAt: NOW - DAY_MS, loginExpiresAt: NOW + 29 * DAY_MS },
      NOW + 20 * 3600_000,
      NOW,
    );
    expect(r.status).toBe("ok");
    expect(r.days_until_login_expires).toBe(29);
    expect(r.login_expiry_is_estimate).toBe(false);
    expect(r.last_renewal_at).toBe(new Date(NOW - DAY_MS).toISOString());
    expect(r.renewal_schedule).toMatch(/daily/);
    expect(r.last_renewal_error).toBeUndefined();
  });

  it("is ok but explains when nothing has been renewed yet", () => {
    const r = describeStatus({ loginUploadedAt: NOW - 3600_000 }, null, NOW);
    expect(r.status).toBe("ok");
    expect(r.login_expiry_is_estimate).toBe(true);
    expect(r.message).toMatch(/No renewal recorded yet/);
  });

  it("asks for a new login when Garmin rejected the renewal", () => {
    const r = describeStatus(
      {
        lastSuccessAt: NOW - 3 * DAY_MS,
        loginExpiresAt: NOW + 27 * DAY_MS,
        lastFailure: { at: NOW - DAY_MS, message: "refresh failed (400)", loginRejected: true },
      },
      null,
      NOW,
    );
    expect(r.status).toBe("action_needed");
    expect(r.message).toMatch(/garmin-mcp-login/);
    expect(r.last_renewal_error?.message).toBe("refresh failed (400)");
  });

  it("only warns about a temporary failure, and forgets it after a later success", () => {
    const failure = { at: NOW - DAY_MS, message: "rate limited", loginRejected: false };
    const warn = describeStatus({ lastSuccessAt: NOW - 2 * DAY_MS, loginExpiresAt: NOW + 28 * DAY_MS, lastFailure: failure }, null, NOW);
    expect(warn.status).toBe("warning");
    expect(warn.message).toMatch(/temporary/);
    const healed = describeStatus({ lastSuccessAt: NOW - 3600_000, loginExpiresAt: NOW + 30 * DAY_MS, lastFailure: failure }, null, NOW);
    expect(healed.status).toBe("ok");
    expect(healed.last_renewal_error).toBeUndefined();
  });

  it("warns in the last week and flags an expired login", () => {
    expect(describeStatus({ lastSuccessAt: NOW - 25 * DAY_MS, loginExpiresAt: NOW + 5 * DAY_MS }, null, NOW).status).toBe("warning");
    const expired = describeStatus({ loginUploadedAt: NOW - 31 * DAY_MS }, null, NOW);
    expect(expired.status).toBe("action_needed");
    expect(expired.days_until_login_expires).toBe(0);
  });
});
