# Infomaniak OAuth findings (2026-09-28)

Goal: expose Infomaniak's official calendar + mail MCP servers (stdio, static
API token) as a remote Streamable HTTP MCP server that claude.ai can use as a
custom connector, with login via Infomaniak OAuth.

## What Infomaniak's OAuth gives an app

Probed with an "Application"-type app created in the Manager
(`scripts/oauth-probe.py`, `scripts/scope-probe.sh`).

- Endpoints: `https://login.infomaniak.com/authorize` and `/token`; OIDC discovery
  at `/.well-known/openid-configuration`. Auth code + PKCE S256 + refresh_token
  grant work. `access_type=offline` yields a `refresh_token`; `expires_in` 7200.
- Scopes an app may request: only `openid profile email phone` (the OIDC set).
  Every API scope is rejected at `/authorize` with `invalid_scope`:
  `user_info`, `workspace:calendar`, `workspace:mail`, `mail`, `calendar`.
- With no `scope` param the token comes back with `scope: "profile email phone"`,
  and api.infomaniak.com answers 403 `all_scopes` naming the missing scope
  (`user_info` for /2/profile, `workspace:calendar` for calendar, `mail` for
  mail hostings). So the API does check scopes on OAuth tokens; the OAuth app
  simply cannot be granted them. Infomaniak's own apps (android-login) send no
  scope and get full tokens, i.e. first-party client ids are privileged.
- Conclusion: Manager OAuth apps are SSO/identity only. API access needs a
  static API token (Manager > API tokens) with `user_info workspace:mail
  workspace:calendar`, which is what the official MCP servers expect in
  `MAIL_TOKEN` / `CALENDAR_TOKEN`.

## Consequence for the bridge design

Stateless passthrough (claude.ai holds an Infomaniak token, bridge forwards it)
is not possible. The bridge must be its own OAuth authorization server for
claude.ai and hold each user's Infomaniak API token:

1. claude.ai -> bridge `/authorize` (bridge = MCP resource server + auth server).
2. Bridge sends the user through Infomaniak OIDC login (identity, org
   restriction, `user_id`).
3. First time only: bridge asks the user to paste an Infomaniak API token with
   the three scopes; stored encrypted, keyed by Infomaniak `user_id`.
4. Bridge issues its own access/refresh tokens to claude.ai; per MCP request it
   maps token -> user -> API token and runs the mail/calendar tools with it.

Closed: the app's Manager page lists exactly `openid profile email phone` as
its authorised scopes and offers no way to edit them. Independently confirmed
by ruffzy/infomaniak-mcp-agent's ARCHITECTURE.md: "The product scopes (web,
mail, drive, etc.) used by the manager itself cannot be granted to OAuth
clients today." Infomaniak's OAuth is SSO-only for third parties, period.

## Implementation choice: proxy the official packages, don't copy them

`@infomaniak/mcp-server-mail` and `@infomaniak/mcp-server-calendar` publish only a stdio
binary (`dist/index.js`, no `exports`, reads `MAIL_TOKEN` / `CALENDAR_TOKEN` and connects
stdio at import time), so they can't be imported as libraries. The bridge therefore runs
them **unmodified as child processes**, one per (user, service, token), pooled with an
idle timeout (`src/services/pool.ts`), and proxies `tools/list` / `tools/call`
(`src/mcp.ts`). Upgrading upstream = `npm update`. Upstream's local-file-path
`attachments` argument is neutralised by proxy policy (hidden from the schema, rejected
on call) instead of by patching their code.
