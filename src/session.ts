// GarminSession: one Durable Object instance that owns the Garmin tokens.
//
// Garmin rotates the refresh token on every refresh, so refreshed tokens must be saved,
// and two requests must never refresh at the same time (the loser would save a refresh
// token Garmin already replaced). A single Durable Object gives us both: durable storage
// and one place where refreshes are serialized. It also records how each renewal went, so
// get_connection_status can warn before the login lapses.

import { DurableObject } from "cloudflare:workers";
import { GarminClient, GarminError, fetchProfile, refreshTokens, type Profile } from "./garmin";
import { chooseTokens, needsRefresh, parseTokens, tokenExpiresAt, type GarminTokens } from "./logic";
import {
  describeStatus,
  LOGIN_LIFETIME_MS,
  RENEWAL_SCHEDULE,
  type RenewalState,
  type StatusReport,
} from "./status";

export type SessionEnv = {
  /** Contents of ~/.garminconnect/garmin_tokens.json from `garmin-mcp-login`. */
  GARMIN_TOKENS?: string;
};

const SEED_KEY = "garmin_tokens_seed";
const REFRESHED_KEY = "garmin_tokens";
const PROFILE_KEY = "profile";
const RENEWAL_KEY = "renewal";
const PROFILE_TTL_MS = 24 * 60 * 60 * 1000;
/** Refresh ahead of expiry so a request never starts with a token about to lapse. */
const REFRESH_MARGIN_MS = 30 * 60 * 1000;

export class GarminSession extends DurableObject<SessionEnv> {
  private refreshing: Promise<GarminTokens> | undefined;

  /** A valid access token, refreshed first if it is about to expire. */
  async accessToken(): Promise<string> {
    const tokens = await this.load();
    if (needsRefresh(tokens.di_token, Date.now(), REFRESH_MARGIN_MS)) {
      return (await this.refresh(tokens.di_token)).di_token;
    }
    return tokens.di_token;
  }

  /** After a 401: refresh unless another request already replaced `staleToken`. */
  async refreshAfter(staleToken: string): Promise<string> {
    return (await this.refresh(staleToken)).di_token;
  }

  /**
   * Unconditional refresh, run on a daily schedule. Each refresh gives a new refresh token
   * that lasts about 30 days, so the login never lapses while renewals keep succeeding.
   */
  async keepAlive(): Promise<void> {
    await this.refresh();
  }

  /** Health of the login. Reads only stored state: works even when Garmin rejects the login. */
  async status(): Promise<StatusReport> {
    let accessTokenExpiry: number | null = null;
    try {
      accessTokenExpiry = tokenExpiresAt((await this.load()).di_token);
    } catch (error) {
      return {
        status: "action_needed",
        message: error instanceof Error ? error.message : String(error),
        renewal_schedule: RENEWAL_SCHEDULE,
      };
    }
    const state = (await this.ctx.storage.get<RenewalState>(RENEWAL_KEY)) ?? {};
    return describeStatus(state, accessTokenExpiry, Date.now());
  }

  async profile(): Promise<Profile> {
    const cached = await this.ctx.storage.get<{ at: number; profile: Profile }>(PROFILE_KEY);
    if (cached && Date.now() - cached.at < PROFILE_TTL_MS) return cached.profile;
    const client = new GarminClient({
      accessToken: () => this.accessToken(),
      refreshAfter: (stale) => this.refreshAfter(stale),
    });
    const profile = await fetchProfile(client);
    await this.ctx.storage.put(PROFILE_KEY, { at: Date.now(), profile });
    return profile;
  }

  private refresh(staleToken?: string): Promise<GarminTokens> {
    this.refreshing ??= (async () => {
      const current = await this.load();
      if (staleToken && current.di_token !== staleToken) return current; // someone beat us to it
      const state = (await this.ctx.storage.get<RenewalState>(RENEWAL_KEY)) ?? {};
      const now = Date.now();
      try {
        const { tokens, loginExpiresAt } = await refreshTokens(current);
        await this.ctx.storage.put({
          [REFRESHED_KEY]: JSON.stringify(tokens),
          [RENEWAL_KEY]: {
            loginUploadedAt: state.loginUploadedAt,
            lastSuccessAt: now,
            loginExpiresAt: loginExpiresAt ?? now + LOGIN_LIFETIME_MS,
            loginExpiryEstimated: loginExpiresAt === null,
          } satisfies RenewalState,
        });
        return tokens;
      } catch (error) {
        await this.ctx.storage.put(RENEWAL_KEY, {
          ...state,
          lastFailure: {
            at: now,
            message: error instanceof Error ? error.message : String(error),
            loginRejected: error instanceof GarminError && error.kind === "auth",
          },
        } satisfies RenewalState);
        throw error;
      }
    })().finally(() => {
      this.refreshing = undefined;
    });
    return this.refreshing;
  }

  private async load(): Promise<GarminTokens> {
    const storage = this.ctx.storage;
    const [seed, refreshed] = await Promise.all([
      storage.get<string>(SEED_KEY),
      storage.get<string>(REFRESHED_KEY),
    ]);
    const { tokens, reseed } = chooseTokens(this.env.GARMIN_TOKENS, { seed, refreshed });
    if (!tokens) {
      throw new Error(
        "GARMIN_TOKENS secret is not set. Run garmin-mcp-login, then " +
          "`npx wrangler secret put GARMIN_TOKENS < ~/.garminconnect/garmin_tokens.json`.",
      );
    }
    const parsed = parseTokens(tokens);
    if (reseed) {
      // A new login was uploaded: forget refreshed tokens, the cached profile and the old
      // renewal history, and start a new one.
      await storage.delete([REFRESHED_KEY, PROFILE_KEY]);
      await storage.put({
        [SEED_KEY]: tokens,
        [RENEWAL_KEY]: { loginUploadedAt: Date.now() } satisfies RenewalState,
      });
    }
    return parsed;
  }
}
