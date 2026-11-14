// HTML for the OAuth sign-in/consent page. Pure functions so they can be unit-tested.
//
// Everything about the client (name, domain, redirect host, scopes) comes from dynamic
// registration or a client metadata document, i.e. from whoever is asking. Escape all of it.

import type { ConsentDescription } from "@cloudflare/workers-oauth-provider";

export const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

const STYLE = `
  :root { color-scheme: light dark; --fg:#1b1b1f; --muted:#5d5d66; --bg:#f6f6f8; --card:#fff;
          --line:#dcdce2; --accent:#0b62d6; --warn-bg:#fff4e0; --warn-fg:#7a4a00; --err:#b3261e; }
  @media (prefers-color-scheme: dark) {
    :root { --fg:#ececf1; --muted:#a3a3ad; --bg:#121215; --card:#1c1c21; --line:#33333b;
            --accent:#5a9cff; --warn-bg:#3a2a10; --warn-fg:#ffd48a; --err:#ff8a80; }
  }
  * { box-sizing: border-box; }
  body { margin:0; min-height:100vh; display:grid; place-items:center; padding:16px;
         background:var(--bg); color:var(--fg); font:16px/1.5 system-ui, sans-serif; }
  main { width:100%; max-width:420px; background:var(--card); border:1px solid var(--line);
         border-radius:12px; padding:24px; }
  h1 { font-size:20px; margin:0 0 8px; }
  p { margin:8px 0; }
  .muted { color:var(--muted); font-size:14px; }
  .warn { background:var(--warn-bg); color:var(--warn-fg); padding:8px 12px; border-radius:8px; }
  .err { color:var(--err); font-weight:600; }
  label { display:block; margin:16px 0 4px; font-weight:600; }
  input[type=password] { width:100%; padding:10px 12px; font:inherit; color:inherit;
         background:transparent; border:1px solid var(--line); border-radius:8px; }
  .actions { display:flex; gap:8px; margin-top:16px; }
  button { flex:1; padding:10px; font:inherit; border-radius:8px; border:1px solid var(--line);
           background:transparent; color:inherit; cursor:pointer; }
  button.primary { background:var(--accent); border-color:var(--accent); color:#fff; font-weight:600; }
`;

function layout(title: string, body: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title><style>${STYLE}</style></head>
<body><main>${body}</main></body></html>`;
}

export function consentPage(details: ConsentDescription, handle: string, error?: string): string {
  const name = escapeHtml(details.clientName);
  const publisher = details.clientDomain
    ? `Published by <strong>${escapeHtml(details.clientDomain)}</strong>.`
    : "This app registered itself, so its name is not verified.";
  const loopback = details.redirectIsLoopback
    ? `<p class="warn">This sends access to an app on your computer. Continue only if you just
       started connecting from it.</p>`
    : "";
  const scopes = details.scope
    .map((s) => `<input type="hidden" name="scope" value="${escapeHtml(s)}">`)
    .join("");
  return layout(
    `Connect ${details.clientName} to Garmin MCP`,
    `<h1>Allow ${name} to read your Garmin data?</h1>
<p class="muted">${publisher} Access will be sent to
  <strong>${escapeHtml(details.redirectHost)}</strong>.</p>
${loopback}
<p>It will be able to read your sleep, HRV, Body Battery, stress, training and activity data.
It can't change anything.</p>
<form method="post">
  <input type="hidden" name="handle" value="${escapeHtml(handle)}">
  ${scopes}
  <label for="key">Access key</label>
  <input id="key" name="access_key" type="password" autocomplete="current-password" required autofocus>
  <p class="muted">The MCP_AUTH_TOKEN you saved when you deployed this server.</p>
  ${error ? `<p class="err" role="alert">${escapeHtml(error)}</p>` : ""}
  <div class="actions">
    <button type="submit" name="decision" value="deny" formnovalidate>Deny</button>
    <button type="submit" name="decision" value="approve" class="primary">Allow</button>
  </div>
</form>`,
  );
}

export function messagePage(title: string, message: string): string {
  return layout(title, `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p>`);
}
