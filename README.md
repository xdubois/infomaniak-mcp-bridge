# Infomaniak MCP Bridge

Infomaniak publishes MCP servers for its kSuite products, [mail](https://github.com/Infomaniak/mcp-server-mail),
[calendar](https://github.com/Infomaniak/mcp-server-calendar), [contacts](https://github.com/Infomaniak/mcp-server-contact),
[kChat](https://github.com/Infomaniak/mcp-server-kchat) and [kDrive](https://github.com/Infomaniak/mcp-server-kdrive),
but they are stdio processes fed by a static API token: fine for Claude Desktop, unusable from claude.ai.
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
   (`mail_*`, `calendar_*`, …). The HTTP side is stateless, so any replica can serve any request.

| Service | Package | Tools | Extra setting |
|---|---|---|---|
| `mail` | `@infomaniak/mcp-server-mail` | 20 `mail_*` | |
| `calendar` | `@infomaniak/mcp-server-calendar` | 6 `calendar_*` | |
| `contact` | `@infomaniak/mcp-server-contact` | 2 `contact_*` | |
| `kchat` | `@infomaniak/mcp-server-kchat` | 9 `kchat_*` | `KCHAT_TEAM_NAME` |
| `kdrive` | `@infomaniak/mcp-server-kdrive` | 14 `kdrive_*` | `KDRIVE_ID` |

The extra settings are per deployment: one kChat team and one kDrive for every user of the
bridge, which fits an organisation. The API token each user enrols must carry the scopes of
the enabled services (shown on the enrolment page).

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

## Deploy

The image (`Dockerfile`: multi-stage on `node:24-bookworm-slim`, runs as `node`, works with a
read-only root filesystem and no capabilities) holds the compiled bridge plus the official
upstream packages; upgrading them is `npm update` and a rebuild. It defaults `TRUST_PROXY=true`
and keeps SQLite on the `/data` volume. Budget about 75 MB per upstream process: the default
`MAX_PROCESSES=20` fits a 2 GB memory limit. `docker compose up -d --build` runs it locally on
`127.0.0.1:3000` (with plain `docker run`, add `--init` so the child processes are reaped).

**Published image.** GitHub Actions (`.github/workflows/docker.yml`) typechecks, runs the
upstream check, then builds a multi-arch image and pushes it to
`ghcr.io/xdubois/infomaniak-mcp-bridge`: `main` and `sha-<commit>` on every push to `main`,
`X.Y.Z`, `X.Y` and `latest` on `vX.Y.Z` tags. While the package is private, pulling needs a
token with `read:packages` (on Kubernetes an `imagePullSecret`, see the comment in
`deploy/deployment.yml`).

### Kubernetes

`deploy/deployment.yml` (namespace, ConfigMap, Service, Deployment: stateless on `STORE=redis`,
scale as you like) and `deploy/secret.yml` (placeholders). Bring your own Redis and ingress:
route TLS traffic for `PUBLIC_URL` to service `bridge` port 80, and register
`<PUBLIC_URL>/auth/infomaniak/callback` on the Infomaniak app.

```sh
kubectl apply -f deploy/deployment.yml                  # edit PUBLIC_URL (and the image tag) first
set -a; . ./.env; set +a                                # or edit the placeholders by hand
envsubst < deploy/secret.yml | kubectl apply -f -
BRIDGE_URL=<PUBLIC_URL> python3 scripts/smoke.py
```

`TRUST_PROXY` in the ConfigMap: `true` when the ingress is the only proxy setting
`X-Forwarded-*`, `2` if an L7 load balancer in front of it also appends `X-Forwarded-For`,
otherwise the per-client rate limits collapse onto the balancer's address.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `PUBLIC_URL` | `http://localhost:3000` | Base URL claude.ai reaches; MCP endpoint is `/mcp` |
| `PORT` | `3000` | |
| `TRUST_PROXY` | `false` | Proxy hops that set `X-Forwarded-*`: `true`/`1` for a single reverse proxy or ingress, `2` if an L7 load balancer in front of it also appends `X-Forwarded-For`, or CIDRs. Drives per-client rate limits |
| `INFOMANIAK_CLIENT_ID/SECRET` | | The OAuth app (identity only) |
| `BRIDGE_ENCRYPTION_KEY` | | 32 bytes base64; encrypts stored API tokens |
| `STORE` | `sqlite` | `sqlite` (one replica, local file) or `redis` (shared by replicas) |
| `SQLITE_PATH` / `REDIS_URL` | `./data/bridge.sqlite` / | Location of that store |
| `ENABLED_SERVICES` | `mail,calendar` | Which products to expose (`mail`, `calendar`, `contact`, `kchat`, `kdrive`); drives processes, tools and required scopes |
| `KCHAT_TEAM_NAME` / `KDRIVE_ID` | | Needed when `kchat` / `kdrive` is enabled: the subdomain of your kChat URL, the id in your kDrive URL |
| `ALLOWED_EMAIL_DOMAINS` | | Optional extra sign-in guard |
| `PROCESS_IDLE_TTL` / `MAX_PROCESSES` | `600` / `20` | Upstream process pool per replica (one Node process each; size to memory) |
| `ACCESS_TOKEN_TTL` / `REFRESH_TOKEN_TTL` | `3600` / 30 days | Bridge tokens (opaque, stored hashed) |
| `CLIENT_TTL` | 90 days | Registered OAuth clients expire after this long without issuing tokens (never below `REFRESH_TOKEN_TTL`) |

## Adding a service

One entry in `src/services/registry.ts`: the npm package of Infomaniak's server, the env
var it reads its token from, the API scopes it needs, any other env vars it insists on
(`requiredEnv`, per deployment) and a probe URL (`${VAR}` placeholders allowed) that fails
without the scope. `npm install` the package, enable it with `ENABLED_SERVICES`. Upgrading
a service is `npm update`; `npm run check:upstream` spawns every known package and checks the
argument policy.

## Security notes

- API tokens are the user's own, scoped by them in the Manager, revocable there; the
  bridge only hands them to the official server process, which only talks to Infomaniak's
  API hosts (`api.infomaniak.com`, `mail.infomaniak.com`). Enrolment checks the token's `/2/profile` matches the signed-in
  Infomaniak account. Child processes get a sanitised environment plus that one token,
  never the bridge's own secrets.
- Users can make the bridge forget them at `<PUBLIC_URL>/auth/forget`: an Infomaniak sign-in
  proves identity, then the user record and encrypted token are deleted and every connected
  client gets asked to reconnect. Revoking the token itself is done in the Manager.
- Bridge access/refresh tokens are random, stored as sha256, rotated on refresh. A refresh can
  narrow the granted scopes but not widen them. Dynamically registered clients expire
  (`CLIENT_TTL`) unless they keep issuing tokens, so open registration can't fill the store.
- Infomaniak rate-limits per token (60 req/min), so users don't share a budget.
- Only the tools of enabled services are exposed. **Proxy policy** (`hiddenArgs` in the
  registry) removes arguments that are unsafe on a shared host from the tool schemas and
  rejects calls using them: upstream mail's `attachments` are local file paths read by the
  server process, which here would be the bridge's own disk.

## License

MIT, see `LICENSE`. The upstream Infomaniak MCP servers are MIT as well.
