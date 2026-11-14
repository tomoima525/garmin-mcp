import type { ConsentDescription } from "@cloudflare/workers-oauth-provider";
import { describe, expect, it } from "vitest";
import { consentPage, escapeHtml } from "./consent";

const details = (over: Partial<ConsentDescription> = {}): ConsentDescription =>
  ({
    clientId: "abc",
    clientName: "Claude",
    redirectUri: "https://claude.ai/api/mcp/auth_callback",
    redirectHost: "claude.ai",
    redirectIsLoopback: false,
    scope: ["garmin:read"],
    ...over,
  }) as ConsentDescription;

describe("consentPage", () => {
  it("shows client, destination host, handle and scopes", () => {
    const html = consentPage(details(), "h1");
    expect(html).toContain("Allow Claude to read your Garmin data?");
    expect(html).toContain("<strong>claude.ai</strong>");
    expect(html).toContain('name="handle" value="h1"');
    expect(html).toContain('name="scope" value="garmin:read"');
    expect(html).toContain("its name is not verified");
    expect(html).not.toContain('role="alert"');
  });

  it("escapes everything that came from the client", () => {
    const html = consentPage(
      details({ clientName: "<script>x</script>", redirectHost: '"><img src=x>', scope: ['a"b'] }),
      '"><b>',
    );
    expect(html).not.toMatch(/<script>|<img|<b>/);
    expect(html).toContain("&#60;script&#62;");
  });

  it("names a verified publisher and warns about local redirects", () => {
    const html = consentPage(details({ clientDomain: "example.com", redirectIsLoopback: true }), "h");
    expect(html).toContain("Published by <strong>example.com</strong>");
    expect(html).toContain("an app on your computer");
  });

  it("shows an error message", () => {
    expect(consentPage(details(), "h", "Wrong key")).toContain('role="alert">Wrong key<');
  });
});

describe("escapeHtml", () => {
  it("escapes the five HTML-significant characters", () => {
    expect(escapeHtml(`&<>"'`)).toBe("&#38;&#60;&#62;&#34;&#39;");
  });
});
