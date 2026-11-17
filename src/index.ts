// garmin-mcp: a remote MCP server for your Garmin Connect data, on Cloudflare Workers.
//
//   claude.ai ----(OAuth 2.1 access token)----\
//                                              >--> /mcp --> MCP tools --> Garmin Connect API
//   Claude Code / SDK --(Bearer MCP_AUTH_TOKEN)/                 |
//                                                     GarminSession (Durable Object):
//                                                     Garmin tokens, refreshed and rotated
//
// Auth: the Worker is an OAuth 2.1 authorization server (via workers-oauth-provider) so
// OAuth-only clients like claude.ai custom connectors can connect. The owner approves each
// client on /authorize by entering MCP_AUTH_TOKEN. That same key also works directly as a
// bearer token for clients that can send headers.

import {
  AuthorizationError,
  CimdFetchError,
  OAuthProvider,
  type OAuthHelpers,
} from "@cloudflare/workers-oauth-provider";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { consentPage, messagePage } from "./consent";
import { GarminClient, type TokenSource } from "./garmin";
import { keyMatches } from "./logic";
import type { GarminSession } from "./session";
import { buildServer } from "./tools";

export { GarminSession } from "./session";

type AppEnv = Env & {
  /** Owner's access key: approves OAuth clients, and works directly as a bearer token. */
  MCP_AUTH_TOKEN?: string;
  /** Contents of ~/.garminconnect/garmin_tokens.json from `garmin-mcp-login`. */
  GARMIN_TOKENS?: string;
  /** Optional IANA time zone overriding the one in your Garmin profile. */
  TIMEZONE?: string;
  /** Injected by OAuthProvider into the default handler. */
  OAUTH_PROVIDER: OAuthHelpers;
};

/** The only scope: read access to the owner's Garmin data. */
const SCOPE = "garmin:read";
const OWNER = "owner";

/** The single GarminSession instance (one Garmin account per deployment). */
function session(env: AppEnv): DurableObjectStub<GarminSession> {
  return env.GARMIN_SESSION.get(env.GARMIN_SESSION.idFromName(OWNER));
}

// --------------------------------------------------------------------------- MCP endpoint

const mcpHandler = {
  // Only reached with a valid OAuth access token or the owner's access key.
  async fetch(request: Request, env: AppEnv): Promise<Response> {
    const stub = session(env);
    const tokens: TokenSource = {
      accessToken: () => stub.accessToken(),
      refreshAfter: (stale) => stub.refreshAfter(stale),
    };
    const server = buildServer({
      garmin: new GarminClient(tokens),
      profile: () => stub.profile(),
      connectionStatus: () => stub.status(),
      timeZoneOverride: env.TIMEZONE,
    });
    // Stateless: a fresh server and transport per request, plain JSON responses.
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server.connect(transport);
    return transport.handleRequest(request);
  },
} satisfies ExportedHandler<AppEnv>;

// --------------------------------------------------------------------------- pages

const html = (body: string, init: ResponseInit = {}) => {
  const headers = new Headers(init.headers);
  headers.set("content-type", "text/html; charset=utf-8");
  return new Response(body, { ...init, headers });
};

async function showConsent(request: Request, env: AppEnv, error?: string): Promise<Response> {
  const oauth = env.OAUTH_PROVIDER;
  const authRequest = await oauth.parseAuthRequest(request);
  const details = await oauth.describeConsent(authRequest); // before beginConsent: see library docs
  const consent = await oauth.beginConsent(authRequest);
  consent.headers.set("content-type", "text/html; charset=utf-8");
  return new Response(consentPage(details, consent.handle, error), {
    status: error ? 401 : 200,
    headers: consent.headers,
  });
}

async function handleAuthorize(request: Request, env: AppEnv): Promise<Response> {
  if (!env.MCP_AUTH_TOKEN) {
    return html(messagePage("Not configured", "The MCP_AUTH_TOKEN secret is not set."), {
      status: 500,
    });
  }
  if (request.method === "GET") return showConsent(request, env);
  if (request.method !== "POST") return new Response("Method not allowed\n", { status: 405 });

  const oauth = env.OAUTH_PROVIDER;
  const form = await request.formData();
  const handle = String(form.get("handle") ?? "");

  if (form.get("decision") !== "approve") {
    const denied = await oauth.denyConsent(request, handle);
    return new Response(null, { status: 302, headers: denied.headers });
  }

  if (!(await keyMatches(form.get("access_key")?.toString(), env.MCP_AUTH_TOKEN))) {
    await new Promise((resolve) => setTimeout(resolve, 1000)); // slow down guessing
    // The form posts back to the original /authorize URL, so the request can be shown again.
    return showConsent(request, env, "That access key is not correct.");
  }

  const approved = await oauth.approveConsent(request, handle, {
    scope: form.getAll("scope").map(String),
  });
  const { redirectTo } = await oauth.completeAuthorization({
    request: approved.request, // from server-side storage, not from the form
    userId: OWNER,
    metadata: { approvedAt: new Date().toISOString() },
    scope: approved.request.scope,
    props: { userId: OWNER },
  });
  approved.headers.set("location", redirectTo);
  return new Response(null, { status: 302, headers: approved.headers });
}

const defaultHandler = {
  async fetch(request: Request, env: AppEnv): Promise<Response> {
    const { pathname } = new URL(request.url);
    try {
      if (pathname === "/authorize") return await handleAuthorize(request, env);
    } catch (error) {
      if (error instanceof AuthorizationError && error.redirectTo) {
        return Response.redirect(error.redirectTo, 302);
      }
      if (error instanceof AuthorizationError || error instanceof CimdFetchError) {
        const message =
          error instanceof AuthorizationError
            ? `${error.description} Start connecting again from your app.`
            : "This app could not be verified.";
        return html(messagePage("Can't connect", message), { status: 400 });
      }
      throw error;
    }
    if (pathname === "/") {
      return new Response(
        "garmin-mcp: MCP endpoint is /mcp (OAuth 2.1, or Bearer MCP_AUTH_TOKEN)\n",
      );
    }
    return new Response("Not found\n", { status: 404 });
  },
} satisfies ExportedHandler<AppEnv>;

// --------------------------------------------------------------------------- provider

// The OAuth resource must be this deployment's absolute /mcp URL. It isn't known until the
// Worker is deployed (workers.dev subdomain or custom domain), so build one provider per origin.
const providers = new Map<string, OAuthProvider<AppEnv>>();

function providerFor(origin: string): OAuthProvider<AppEnv> {
  let provider = providers.get(origin);
  if (!provider) {
    const resource = `${origin}/mcp`;
    provider = new OAuthProvider<AppEnv>({
      apiRoute: "/mcp",
      apiHandler: mcpHandler,
      defaultHandler,
      authorizeEndpoint: "/authorize",
      tokenEndpoint: "/oauth/token",
      clientRegistrationEndpoint: "/oauth/register", // Dynamic Client Registration (claude.ai)
      clientIdMetadataDocumentEnabled: true, // Client ID Metadata Documents (newer clients)
      scopesSupported: [SCOPE],
      requiredScopes: [SCOPE],
      resourceMetadata: { resource },
      accessTokenTTL: 60 * 60, // 1 hour; clients refresh silently
      refreshTokenTTL: 90 * 24 * 60 * 60, // re-approve every 90 days
      // The owner's access key, sent directly as a bearer token (Claude Code, SDK, curl).
      resolveExternalToken: async ({ token, env }) =>
        (await keyMatches(token, env.MCP_AUTH_TOKEN))
          ? { props: { userId: OWNER, via: "access-key" }, audience: resource }
          : null,
    });
    providers.set(origin, provider);
  }
  return provider;
}

export default {
  fetch(request, env, ctx) {
    return providerFor(new URL(request.url).origin).fetch(request, env, ctx);
  },
  // Daily: renew the Garmin login so it never lapses (each refresh token lasts ~30 days, so
  // even weeks of failed runs leave time to notice via get_connection_status).
  async scheduled(_controller, env) {
    await session(env).keepAlive();
  },
} satisfies ExportedHandler<AppEnv>;
