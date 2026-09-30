# Infomaniak MCP Bridge

Use your Infomaniak **kSuite** (mail, calendar, contacts, kChat, kDrive) from claude.ai,
Claude Code or any remote MCP client, through Infomaniak's own MCP servers.

Community project, not affiliated with Infomaniak. **Host it yourself, or use an instance run
by someone you trust:** the operator holds every user's API token (see [Security](#security)).

## Why

Infomaniak publishes an MCP server per product: [mail](https://github.com/Infomaniak/mcp-server-mail),
[calendar](https://github.com/Infomaniak/mcp-server-calendar), [contacts](https://github.com/Infomaniak/mcp-server-contact),
[kChat](https://github.com/Infomaniak/mcp-server-kchat), [kDrive](https://github.com/Infomaniak/mcp-server-kdrive).
They are stdio processes fed by a static API token: perfect for Claude Desktop, unusable from
claude.ai, which needs a remote server with OAuth. And Infomaniak's OAuth only grants identity
scopes to third-party apps, never API access (details in [NOTES.md](NOTES.md)), so a plain
OAuth proxy is impossible.

This bridge fills the gap without forking anything: it runs the official packages unmodified
and puts the remote transport and the login in front of them.

## How it works

1. **OAuth server for the client.** claude.ai registers itself (dynamic client registration,
   PKCE) and receives bridge tokens: random, stored hashed, rotated on refresh.
2. **Infomaniak login for identity.** The user signs in with Infomaniak OpenID Connect; the
   OAuth app can restrict this to your organisation.
3. **One API token per user, once.** The user pastes an Infomaniak API token carrying the
   scopes of the enabled services. The bridge checks it belongs to the signed-in account and
   works for each service, then stores it encrypted (AES-256-GCM).
4. **Consent per client.** Before the code goes back, the user sees which client asked (name
   and redirect URI) and allows or denies it. Anyone can register a client, so this is what
   keeps a link crafted by someone else from connecting their client to your account.
5. **Official servers as child processes.** Every request runs against the user's own
   instances of Infomaniak's packages, spawned with that token and pooled with an idle
   timeout. Tool lists are merged, calls routed by prefix. The HTTP side is stateless.

| Service | Package | Tools | Extra setting |
|---|---|---|---|
| `mail` | `@infomaniak/mcp-server-mail` | 20 `mail_*` | |
| `calendar` | `@infomaniak/mcp-server-calendar` | 6 `calendar_*` | |
| `contact` | `@infomaniak/mcp-server-contact` | 2 `contact_*` | |
| `kchat` | `@infomaniak/mcp-server-kchat` | 9 `kchat_*` | `KCHAT_TEAM_NAME` |
| `kdrive` | `@infomaniak/mcp-server-kdrive` | 14 `kdrive_*` | `KDRIVE_ID` |

Upgrading a service is `npm update`. Arguments unsafe on a shared host are removed by proxy
policy instead of patches: mail's `attachments` are local file paths read by the server.
Adding a product is one entry in `src/services/registry.ts`.

## Configuration

Prerequisite: an Infomaniak OAuth app (Manager › Applications, type *Application*) with
redirect URI `<PUBLIC_URL>/auth/infomaniak/callback`. Everything else is environment
variables (`.env.example` has them all):

| Variable | Default | Purpose |
|---|---|---|
| `PUBLIC_URL` | `http://localhost:3000` | URL clients reach; the MCP endpoint is `<PUBLIC_URL>/mcp` |
| `INFOMANIAK_CLIENT_ID` / `_SECRET` | | The OAuth app (identity only) |
| `BRIDGE_ENCRYPTION_KEY` | | `openssl rand -base64 32`; encrypts stored API tokens |
| `ENABLED_SERVICES` | `mail,calendar` | Any of `mail`, `calendar`, `contact`, `kchat`, `kdrive` |
| `KCHAT_TEAM_NAME` / `KDRIVE_ID` | | Required with `kchat` / `kdrive`: subdomain of your kChat URL, id in your kDrive URL. One team and one drive per deployment |
| `STORE` | `sqlite` | `sqlite` (`SQLITE_PATH`, one replica) or `redis` (`REDIS_URL`, shared by replicas) |
| `TRUST_PROXY` | `false` | Proxy hops setting `X-Forwarded-*`: `true` for one ingress, `2` with an L7 load balancer in front, or CIDRs |
| `ALLOWED_EMAIL_DOMAINS` | | Optional extra sign-in guard |
| `MAX_PROCESSES` / `PROCESS_IDLE_TTL` | `20` / `600` | Upstream process pool per replica; see sizing below |
| `ACCESS_TOKEN_TTL` / `REFRESH_TOKEN_TTL` / `CLIENT_TTL` | 1 h / 30 d / 90 d | Bridge token and client registration lifetimes |

**Sizing.** A user holds one process per enabled service while active and for
`PROCESS_IDLE_TTL` seconds after (`tools/list` starts all of them): about 75 MB each for mail,
calendar and kDrive, 60 MB for contacts and kChat, so a user of all five costs about 335 MB.
The defaults (20 processes, 2 GB) serve about 10 simultaneously active users with mail and
calendar, or 4 with all five services. Beyond that the pool evicts the least recently used
process and respawns on demand (under 100 ms), so occasional users cost nothing while idle.
Replicas on Redis add capacity linearly.

## Run it

**Locally**

```sh
cp .env.example .env    # fill the OAuth app and the encryption key
npm install && npm run dev
```

**Docker.** Image `ghcr.io/xdubois/infomaniak-mcp-bridge` (`0.1.0` / `0.1` / `latest` on
release tags, `main` and `sha-<commit>` for every commit), built by GitHub Actions on Node 24, non-root, fine with
a read-only root filesystem. `docker compose up -d --build` runs it on `127.0.0.1:3000`; with
plain `docker run`, add `--init` so the child processes are reaped.

**Kubernetes.** `deploy/deployment.yml` (namespace, ConfigMap, Service, stateless
Deployment on Redis) and `deploy/secret.yml` (placeholders). Bring your own Redis and
ingress, route TLS traffic for `PUBLIC_URL` to service `bridge` port 80:

```sh
kubectl apply -f deploy/deployment.yml
envsubst < deploy/secret.yml | kubectl apply -f -
```

**Connect.** claude.ai: Settings › Connectors › Add custom connector, URL `<PUBLIC_URL>/mcp`,
client fields empty. Claude Code: `claude mcp add --transport http infomaniak <PUBLIC_URL>/mcp`,
then `/mcp` to authenticate. Either way: Infomaniak login, paste an API token once, done.

**Check.** `npm run check:upstream` spawns every official package and verifies the argument
policy; `BRIDGE_URL=<PUBLIC_URL> python3 scripts/smoke.py` runs the whole OAuth and MCP flow
as a fake client; `npx tsx scripts/dev-token.ts <api-token>` mints a bridge token for curl.

## Security

- The API token is the user's own, scoped and revocable in the Manager. The bridge hands it
  only to the official server process, which only talks to Infomaniak's APIs. Child processes
  get a sanitised environment, never the bridge's secrets.
- **Whoever operates the bridge can decrypt and use every enrolled token.** Nothing on
  Infomaniak's side prevents signing in to a stranger's bridge: the login works like "Sign in
  with Google" (any Infomaniak account, unless the operator restricted the app to their
  organisation), and the token pasted afterwards is the user's own. Only connect to an instance
  you host or whose operator you trust; operators, tick the organisation restriction on the
  OAuth app and set `ALLOWED_EMAIL_DOMAINS`.
- Enrolment verifies the token belongs to the signed-in account and reaches every enabled
  service. Users can make the bridge forget them at `<PUBLIC_URL>/auth/forget`; every
  connected client then asks to reconnect.
- Every authorization ends on a consent page naming the client and its redirect URI, and the
  request is re-keyed after the Infomaniak login so whoever started it cannot finish it.
- Bridge tokens are random, stored as SHA-256, rotated on refresh; a refresh can narrow
  scopes, never widen them. Registered clients expire unless they keep issuing tokens.
- Nothing sensitive is logged. Run the public instance behind TLS only, and give the bridge a
  Redis of its own: whoever can write to the store can act as any user.

## License

MIT, see `LICENSE`. The upstream Infomaniak MCP servers are MIT as well.
