// Small pure helpers (no Cloudflare runtime imports) so they can be unit-tested in Node.

/** Constant-time comparison of a presented access key with the configured one. */
export async function keyMatches(
  candidate: string | null | undefined,
  expected: string | undefined,
): Promise<boolean> {
  if (!candidate || !expected) return false;
  // Compare SHA-256 digests so the comparison length never depends on the input.
  const [a, b] = await Promise.all([digest(candidate.trim()), digest(expected)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

async function digest(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

/** Tokens as saved by `garmin-mcp-login` (python-garminconnect's token file). */
export interface GarminTokens {
  di_token: string;
  di_refresh_token: string;
  di_client_id: string;
}

export function parseTokens(raw: string): GarminTokens {
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("GARMIN_TOKENS is not valid JSON. Upload ~/.garminconnect/garmin_tokens.json.");
  }
  for (const key of ["di_token", "di_refresh_token", "di_client_id"] as const) {
    if (typeof parsed?.[key] !== "string" || !parsed[key]) {
      throw new Error(`GARMIN_TOKENS is missing "${key}". Run garmin-mcp-login again.`);
    }
  }
  return parsed as GarminTokens;
}

export interface TokenState {
  /** Value of the GARMIN_TOKENS secret when it was last adopted. */
  seed?: string;
  /** Latest tokens after a refresh (Garmin rotates the refresh token every time). */
  refreshed?: string;
}

/**
 * Decide which tokens to use. A newly set GARMIN_TOKENS secret (e.g. after logging in
 * again) always wins; otherwise use the most recently refreshed tokens.
 */
export function chooseTokens(
  secret: string | undefined,
  state: TokenState,
): { tokens: string | undefined; reseed: boolean } {
  const seed = secret?.trim() || undefined;
  if (seed && seed !== state.seed) return { tokens: seed, reseed: true };
  return { tokens: state.refreshed ?? seed, reseed: false };
}

/** Expiry (ms since epoch) from a JWT's `exp` claim, or null if it has none. */
export function tokenExpiresAt(jwt: string): number | null {
  try {
    const part = jwt.split(".")[1];
    const json = atob(part.replace(/-/g, "+").replace(/_/g, "/"));
    const exp = JSON.parse(json).exp;
    return typeof exp === "number" && Number.isFinite(exp) ? exp * 1000 : null;
  } catch {
    return null;
  }
}

/** True when the access token expires within `marginMs` (unknown expiry: false). */
export function needsRefresh(jwt: string, now: number, marginMs: number): boolean {
  const exp = tokenExpiresAt(jwt);
  return exp !== null && exp - now < marginMs;
}
