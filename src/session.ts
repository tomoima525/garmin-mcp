// GarminSession: one Durable Object instance that owns the Garmin tokens.
//
// Garmin rotates the refresh token on every refresh, so refreshed tokens must be saved,
// and two requests must never refresh at the same time (the loser would save a refresh
// token Garmin already replaced). A single Durable Object gives us both: durable storage
// and one place where refreshes are serialized.

import { DurableObject } from "cloudflare:workers";
import { GarminClient, fetchProfile, refreshTokens, type Profile } from "./garmin";
import { chooseTokens, needsRefresh, parseTokens, type GarminTokens } from "./logic";

export type SessionEnv = {
  /** Contents of ~/.garminconnect/garmin_tokens.json from `garmin-mcp-login`. */
  GARMIN_TOKENS?: string;
};

const SEED_KEY = "garmin_tokens_seed";
const REFRESHED_KEY = "garmin_tokens";
const PROFILE_KEY = "profile";
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
   * Unconditional refresh, run on a schedule. Garmin's refresh token expires 30 days after
   * it is issued, so refreshing weekly keeps the login alive even when nobody uses it.
   */
  async keepAlive(): Promise<void> {
    await this.refresh();
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
      const next = await refreshTokens(current);
      await this.ctx.storage.put(REFRESHED_KEY, JSON.stringify(next));
      return next;
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
      // A new login was uploaded: forget refreshed tokens and the cached profile.
      await storage.put(SEED_KEY, tokens);
      await storage.delete([REFRESHED_KEY, PROFILE_KEY]);
    }
    return parsed;
  }
}
