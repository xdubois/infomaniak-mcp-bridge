# AGENTS.md

Remote MCP bridge: exposes Infomaniak's **official** stdio MCP servers
(`@infomaniak/mcp-server-{mail,calendar,contact,kchat,kdrive}`, run unmodified as
child processes) as one Streamable HTTP endpoint (`/mcp`) with the OAuth flow claude.ai
custom connectors need. README.md = user-facing setup; NOTES.md = probe findings and the
reasoning behind the design. Read both before changing auth or service code.

## Commands

```sh
npm run dev              # tsx watch src/main.ts (needs .env; see .env.example)
npm run build && npm start
npm run typecheck
docker compose up -d --build        # local container; k8s: deploy/deployment.yml + secret.yml (bring your own Redis + ingress)
# CI: .github/workflows/docker.yml = typecheck + check:upstream, then multi-arch image to ghcr.io/xdubois/infomaniak-mcp-bridge (main, sha-*, semver on v* tags)
npm run check:upstream   # spawns the official servers through the pool, lists tools, checks the arg policy
python3 scripts/smoke.py [tool]      # full flow as a fake MCP client: DCR → browser login → enrol → tokens → tools/call → refresh
npx tsx scripts/dev-token.ts <api-token>   # mint a bridge bearer for curl tests without the login (--remove to clean up)
CLIENT_ID=… ./scripts/scope-probe.sh ; python3 scripts/oauth-probe.py   # the Infomaniak OAuth probes behind NOTES.md
```

## Layout (`src/`)

- `main.ts` express app: SDK `mcpAuthRouter` (/authorize, /token, /register, /revoke,
  .well-known) + `auth/routes.ts` + `mcp.ts`; `/healthz`; landing page `/`.
- `auth/provider.ts` the OAuth 2.1 authorization server (opaque tokens stored hashed,
  refresh rotation, `completeAuthorization`). `auth/routes.ts` Infomaniak OIDC callback (re-keys the
  parked request so only the browser that signed in can finish it) + one-time API-token
  enrolment (`/auth/enrol`) + per-client consent page (`/auth/consent`, names the client and
  its redirect URI; MCP spec requirement for proxies with one fixed upstream client) +
  self-service forget (`/auth/forget`, deletes the user record), `auth/html.ts` the pages.
- `infomaniak/oidc.ts` identity-only login; `infomaniak/api.ts` `apiGet` (path on
  api.infomaniak.com or full URL) + `fetchProfile`.
- `services/registry.ts` one entry per product: npm package, token env var, scopes,
  `requiredEnv` (deployment-level settings such as `KCHAT_TEAM_NAME`, `KDRIVE_ID`, copied into
  the child env and validated at startup), `probeUrl` (`${VAR}` placeholders), `hiddenArgs`
  policy. `services/pool.ts` per-(user, service, token) child
  processes with idle reaping. `mcp.ts` stateless per-request proxy: merges tools/list,
  routes tools/call by prefix, enforces policy.
- `store/` tiny KV interface (`get/set/del` + TTL): `sqlite.ts` (node:sqlite, one replica) and
  `redis.ts` (`redis` client, shared by replicas); `repo.ts` typed namespaces (client, user,
  pending, code, token).

## Decisions and gotchas

- **Infomaniak OAuth is SSO-only for third parties**: apps can only get
  `openid profile email phone`; API scopes → `invalid_scope`. Hence login for identity +
  the user pastes an API token (`user_info` + per-service scopes) once, stored AES-GCM.
- **Never vendor upstream code** (Mathieu's explicit preference): run the official
  packages; upgrade with `npm update`. Fix upstream problems with proxy policy
  (`hiddenArgs`) or an upstream PR, not local patches.
- Mail server talks to `https://mail.infomaniak.com/api`, calendar to
  `https://api.infomaniak.com/1/calendar/pim`, contacts to `https://contacts.infomaniak.com/api/pim`,
  kDrive to `https://api.infomaniak.com/{2,3}/drive/<id>`, kChat to
  `https://<team>.kchat.infomaniak.com/api/v4` (Mattermost-style JSON, no `{result,data}`
  envelope: `apiProbe` accepts any 2xx). Probes must use the right host.
- Upstream mail `attachments` = local file paths read by the server process → hidden and
  rejected by policy. Upstream calendar's invalid-token error is unhelpful
  ("Cannot read properties of undefined") — upstream issue, not ours.
- HTTP side is stateless (`sessionIdGenerator: undefined`, JSON responses); the process
  pool is a per-replica cache, so replicas + Redis work without sticky sessions.
- Infomaniak app redirect URIs currently registered: `http://localhost:3000/auth/infomaniak/callback`,
  `http://localhost:8000/callback` (smoke/probe scripts), claude.ai's callback (harmless but
  unnecessary: MCP clients register their callback with the bridge via DCR, Infomaniak only
  ever sees the bridge's own). A public deployment needs `<PUBLIC_URL>/auth/infomaniak/callback`.

## Status (2026-09-30)

v0.1.0 released: repo public, CI publishes `ghcr.io/xdubois/infomaniak-mcp-bridge` (`0.1.0`,
`0.1`, `latest`, `main`, `sha-*`), a private instance runs on Kubernetes with Redis. Releases:
bump `version` in package.json, tag `vX.Y.Z`, push the tag; CI builds and pushes the image,
then create the GitHub release from the tag. Decided (2026-09-28): keep child processes, ~20
users; in-process/worker variants were measured and rejected as not worth the internals
dependency. Known upstream nits: `mcp-server-contact` and `-kchat` still pin SDK 1.12 (npm
audit flags its HTTP transport; they only ever run stdio here).

Pre-release review (2026-09-30): added the per-client consent page and callback re-keying
(before, an enrolled user following a crafted `/authorize` link, or an Infomaniak login link
someone else started, silently handed that client a grant). Hardening pass (2026-09-29, post-review): 10s timeouts on all outbound fetches; 60s grace
window on refresh-token rotation (RFC 6749 §10.4, replay re-issues the grant); tools/call
routes by prefix only (check:upstream now fails CI on unprefixed upstream tools); decrypt
failures degrade to the 401/re-enrolment path instead of a 500; multiple `bin` entries in an
upstream package fail loudly; `[audit] user=… client=… tool=… outcome` console line per
tools/call (arguments never logged); TRUST_PROXY and boolean env vars reject invalid values
at startup instead of silently defaulting.
