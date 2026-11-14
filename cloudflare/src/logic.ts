// Pure helpers (no Cloudflare runtime imports) so they can be unit-tested in Node.

export const TOKEN_HEADER = "x-garmin-tokens";

/** Constant-time check of an `Authorization: Bearer <token>` header. */
export async function isAuthorized(header: string | null, expected: string): Promise<boolean> {
  const match = header?.match(/^Bearer\s+(.+)$/i);
  if (!match || !expected) return false;
  // Compare SHA-256 digests so the comparison length never depends on the input.
  const [a, b] = await Promise.all([digest(match[1].trim()), digest(expected)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

async function digest(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

/** True if `value` looks like the token JSON garminconnect produces. */
export function isTokenJson(value: string): boolean {
  try {
    const parsed = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null && "di_refresh_token" in parsed;
  } catch {
    return false;
  }
}

export interface TokenState {
  /** Value of the GARMIN_TOKENS secret when it was last adopted. */
  seed?: string;
  /** Latest tokens reported back by the container after a refresh. */
  refreshed?: string;
}

/**
 * Decide which tokens to start the container with.
 * A newly set GARMIN_TOKENS secret (e.g. after logging in again) always wins;
 * otherwise use the most recently refreshed tokens.
 */
export function chooseTokens(
  secret: string | undefined,
  state: TokenState,
): { tokens: string | undefined; reseed: boolean } {
  const seed = secret?.trim() || undefined;
  if (seed && seed !== state.seed) return { tokens: seed, reseed: true };
  return { tokens: state.refreshed ?? seed, reseed: false };
}
