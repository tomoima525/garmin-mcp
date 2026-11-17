// Health of the Garmin login, for the get_connection_status tool. Pure, so it can be tested.
//
// The Worker renews the login on a daily schedule. Each renewal gives a new refresh token that
// lasts about 30 days, so the login only lapses if renewals keep failing. This module turns the
// recorded renewal history into a short report an agent can relay to the user.

export const DAY_MS = 24 * 60 * 60 * 1000;
/** How long Garmin's refresh token lasts, used when Garmin doesn't say. */
export const LOGIN_LIFETIME_MS = 30 * DAY_MS;
/** Warn when the login has less than this left. */
export const WARN_BEFORE_MS = 7 * DAY_MS;
export const RENEWAL_SCHEDULE = "daily at 04:17 UTC";

/** What the GarminSession Durable Object records about renewals. */
export interface RenewalState {
  /** When the current GARMIN_TOKENS secret was adopted (i.e. the last local login). */
  loginUploadedAt?: number;
  lastSuccessAt?: number;
  /** When the current login expires (from Garmin, or estimated). */
  loginExpiresAt?: number;
  loginExpiryEstimated?: boolean;
  lastFailure?: {
    at: number;
    message: string;
    /** True when Garmin refused the login itself (not a temporary problem). */
    loginRejected: boolean;
  };
}

export interface StatusReport {
  status: "ok" | "warning" | "action_needed";
  message: string;
  login_expires_at?: string;
  days_until_login_expires?: number;
  login_expiry_is_estimate?: boolean;
  last_renewal_at?: string;
  last_renewal_error?: { at: string; message: string };
  login_uploaded_at?: string;
  access_token_expires_at?: string;
  renewal_schedule: string;
}

const RELOGIN =
  "The user needs to log in again on their computer: run `uv run garmin-mcp-login` in login/, " +
  "then `npx wrangler secret put GARMIN_TOKENS < ~/.garminconnect/garmin_tokens.json`.";

const iso = (ms?: number) => (ms === undefined ? undefined : new Date(ms).toISOString());

/** When the login expires: Garmin's figure if we have one, else 30 days after the upload. */
export function loginExpiry(state: RenewalState): { at?: number; estimated: boolean } {
  if (state.loginExpiresAt !== undefined) {
    return { at: state.loginExpiresAt, estimated: Boolean(state.loginExpiryEstimated) };
  }
  if (state.loginUploadedAt !== undefined) {
    return { at: state.loginUploadedAt + LOGIN_LIFETIME_MS, estimated: true };
  }
  return { estimated: true };
}

export function describeStatus(
  state: RenewalState,
  accessTokenExpiresAt: number | null,
  now: number,
): StatusReport {
  const expiry = loginExpiry(state);
  const msLeft = expiry.at === undefined ? undefined : expiry.at - now;
  const failure = state.lastFailure;
  const failedSinceSuccess = failure !== undefined && failure.at > (state.lastSuccessAt ?? 0);

  const report: StatusReport = {
    status: "ok",
    message: "",
    login_expires_at: iso(expiry.at),
    days_until_login_expires: msLeft === undefined ? undefined : Math.max(0, Math.floor(msLeft / DAY_MS)),
    login_expiry_is_estimate: expiry.at === undefined ? undefined : expiry.estimated,
    last_renewal_at: iso(state.lastSuccessAt),
    last_renewal_error: failedSinceSuccess ? { at: iso(failure.at)!, message: failure.message } : undefined,
    login_uploaded_at: iso(state.loginUploadedAt),
    access_token_expires_at: iso(accessTokenExpiresAt ?? undefined),
    renewal_schedule: RENEWAL_SCHEDULE,
  };

  if (failedSinceSuccess && failure.loginRejected) {
    report.status = "action_needed";
    report.message = `Garmin rejected the login when renewing it. ${RELOGIN}`;
  } else if (msLeft !== undefined && msLeft <= 0) {
    report.status = "action_needed";
    report.message = `The Garmin login has expired. ${RELOGIN}`;
  } else if (msLeft !== undefined && msLeft < WARN_BEFORE_MS) {
    report.status = "warning";
    report.message =
      `The Garmin login expires in ${report.days_until_login_expires} day(s) and recent renewals ` +
      `haven't extended it. If it still says this tomorrow: ${RELOGIN}`;
  } else if (failedSinceSuccess) {
    report.status = "warning";
    report.message =
      "The last renewal failed with what looks like a temporary problem; the next scheduled " +
      "renewal will retry. No action needed unless this persists for days.";
  } else if (state.lastSuccessAt === undefined) {
    report.message =
      "No renewal recorded yet; the first one runs at the next schedule " +
      `(${RENEWAL_SCHEDULE}) or when the access token is about to expire. No action needed.`;
  } else {
    report.message = `The Garmin login is healthy and is renewed ${RENEWAL_SCHEDULE}. No action needed.`;
  }
  return report;
}
