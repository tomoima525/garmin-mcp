// Cloudflare Worker that fronts the garmin-mcp Python server running in a Container.
//
//   MCP client --(Bearer MCP_AUTH_TOKEN)--> Worker /mcp --> Container :8080 /mcp
//
// The Worker authenticates callers and owns the Garmin tokens: it starts the
// container with them and saves refreshed tokens the container reports back in
// the `x-garmin-tokens` response header (stripped before the response leaves).

import { Container, getContainer } from "@cloudflare/containers";
import { TOKEN_HEADER, chooseTokens, isAuthorized, isTokenJson } from "./logic";

type AppEnv = Env & {
  /** Bearer token MCP clients must present. */
  MCP_AUTH_TOKEN?: string;
  /** Contents of ~/.garminconnect/garmin_tokens.json from `garmin-mcp-login`. */
  GARMIN_TOKENS?: string;
};

const SEED_KEY = "garmin_tokens_seed";
const REFRESHED_KEY = "garmin_tokens";

export class GarminMcpContainer extends Container<AppEnv> {
  defaultPort = 8080;
  // Stop the container after 15 minutes without requests; it restarts on the next call.
  sleepAfter = "15m";

  override async fetch(request: Request): Promise<Response> {
    const storage = this.ctx.storage;
    const [seed, refreshed] = await Promise.all([
      storage.get<string>(SEED_KEY),
      storage.get<string>(REFRESHED_KEY),
    ]);
    const { tokens, reseed } = chooseTokens(this.env.GARMIN_TOKENS, { seed, refreshed });
    if (!tokens) {
      return Response.json(
        { error: "GARMIN_TOKENS secret is not set. See cloudflare/README.md." },
        { status: 503 },
      );
    }
    if (reseed) {
      await storage.put(SEED_KEY, tokens);
      await storage.delete(REFRESHED_KEY);
      // Tokens changed under a running container: restart it so it picks them up.
      if ((await this.getState()).status !== "stopped") await this.destroy();
    }

    // Only read when the container (re)starts.
    this.envVars = { GARMIN_TOKENS_JSON: tokens };
    const upstream = await super.fetch(request);

    const reported = upstream.headers.get(TOKEN_HEADER);
    if (!reported) return upstream;
    if (reported !== tokens && isTokenJson(reported)) {
      await storage.put(REFRESHED_KEY, reported);
    }
    const response = new Response(upstream.body, upstream);
    response.headers.delete(TOKEN_HEADER);
    return response;
  }
}

export default {
  async fetch(request, env): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname === "/") {
      return new Response("garmin-mcp: MCP endpoint is POST /mcp (Bearer token required)\n");
    }
    if (pathname !== "/mcp") return new Response("Not found\n", { status: 404 });

    if (!env.MCP_AUTH_TOKEN) {
      return new Response("MCP_AUTH_TOKEN secret is not set\n", { status: 500 });
    }
    if (!(await isAuthorized(request.headers.get("authorization"), env.MCP_AUTH_TOKEN))) {
      return new Response("Unauthorized\n", {
        status: 401,
        headers: { "www-authenticate": 'Bearer realm="garmin-mcp"' },
      });
    }

    const forwarded = new Request(request);
    forwarded.headers.delete("authorization"); // the container doesn't need it
    return getContainer(env.GARMIN_MCP).fetch(forwarded);
  },
} satisfies ExportedHandler<AppEnv>;
