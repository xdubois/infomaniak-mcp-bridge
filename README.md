# Infomaniak MCP Bridge

Infomaniak publishes MCP servers for [mail](https://github.com/Infomaniak/mcp-server-mail)
and [calendar](https://github.com/Infomaniak/mcp-server-calendar), but they are stdio
processes fed by a static API token: fine for Claude Desktop, unusable from claude.ai.
This bridge exposes those **same, unmodified servers** as one remote MCP server
(Streamable HTTP) with the OAuth flow claude.ai's custom connectors expect.

## How it works

Infomaniak's OAuth only does identity for third-party apps (its apps can request
`openid profile email phone`, nothing more; see `NOTES.md`). So the bridge:

1. is the OAuth 2.1 authorization server claude.ai talks to (dynamic client
   registration, PKCE, refresh tokens; endpoints from the MCP TypeScript SDK);
2. signs the user in through **Infomaniak OpenID Connect** for identity (and your
   organisation restriction on the Infomaniak app);
3. asks the user **once** for an Infomaniak API token with the scopes the enabled
   services need, verifies it belongs to the signed-in account, stores it encrypted
   (AES-256-GCM);
4. on every MCP request maps the bridge token to the user, and proxies `tools/list` /
   `tools/call` to that user's **official Infomaniak MCP server processes**
   (`@infomaniak/mcp-server-*` from npm, spawned with the user's token in their
   environment, pooled per user with an idle timeout). Tool lists are merged
   (`mail_*`, `calendar_*`). The HTTP side is stateless, so any replica can serve any request.

## Setup

1. **Infomaniak OAuth app** (Manager → Cloud Computing → Auth, or account →
   Applications), type *Application*. Redirect URIs: `<PUBLIC_URL>/auth/infomaniak/callback`.
   Tick "restrict to my organisation" if you want only your org to sign in.
2. `cp .env.example .env`, fill client id/secret, and `BRIDGE_ENCRYPTION_KEY=$(openssl rand -base64 32)`.
3. `npm install && npm run dev` (or `npm run build && npm start`).
4. In claude.ai: *Settings → Connectors → Add custom connector*, URL `<PUBLIC_URL>/mcp`,
   leave client id/secret empty (dynamic registration). Connect → Infomaniak login →
   paste an API token (Manager → API tokens, scopes shown on the page).

Checks: `npm run check:upstream` spawns the official servers and lists their tools;
`scripts/smoke.py` runs the whole OAuth + MCP flow from the terminal as a fake client;
`npx tsx scripts/dev-token.ts <api-token>` mints a bridge token for local curl tests
without the login.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `PUBLIC_URL` | `http://localhost:3000` | Base URL claude.ai reaches; MCP endpoint is `/mcp` |
| `PORT` | `3000` | |
| `TRUST_PROXY` | `false` | `true` behind an ingress |
| `INFOMANIAK_CLIENT_ID/SECRET` | | The OAuth app (identity only) |
| `BRIDGE_ENCRYPTION_KEY` | | 32 bytes base64; encrypts stored API tokens |
| `STORE` | `sqlite` | `sqlite` now; `redis` planned (`src/store/index.ts`) |
| `SQLITE_PATH` | `./data/bridge.sqlite` | |
| `ENABLED_SERVICES` | `mail,calendar` | Which products to expose; drives processes, tools and required scopes |
| `ALLOWED_EMAIL_DOMAINS` | | Optional extra sign-in guard |
| `PROCESS_IDLE_TTL` / `MAX_PROCESSES` | `600` / `100` | Upstream process pool per replica |
| `ACCESS_TOKEN_TTL` / `REFRESH_TOKEN_TTL` | `3600` / 30 days | Bridge tokens (opaque, stored hashed) |

## Adding a service

One entry in `src/services/registry.ts`: the npm package of Infomaniak's server, the env
var it reads its token from, the API scopes it needs and a probe path. `npm install` the
package, enable it with `ENABLED_SERVICES`. Upgrading a service is `npm update`.

## Security notes

- API tokens are the user's own, scoped by them in the Manager, revocable there; the
  bridge only hands them to the official server process, which only talks to
  `api.infomaniak.com`. Enrolment checks the token's `/2/profile` matches the signed-in
  Infomaniak account. Child processes get a sanitised environment plus that one token,
  never the bridge's own secrets.
- Bridge access/refresh tokens are random, stored as sha256, rotated on refresh.
- Infomaniak rate-limits per token (60 req/min), so users don't share a budget.
- Only the tools of enabled services are exposed. **Proxy policy** (`hiddenArgs` in the
  registry) removes arguments that are unsafe on a shared host from the tool schemas and
  rejects calls using them: upstream mail's `attachments` are local file paths read by the
  server process, which here would be the bridge's own disk.
