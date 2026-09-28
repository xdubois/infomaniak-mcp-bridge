# CLAUDE.md

Remote MCP bridge: exposes Infomaniak's **official** stdio MCP servers
(`@infomaniak/mcp-server-mail`, `@infomaniak/mcp-server-calendar`, run unmodified as
child processes) as one Streamable HTTP endpoint (`/mcp`) with the OAuth flow claude.ai
custom connectors need. README.md = user-facing setup; NOTES.md = probe findings and the
reasoning behind the design. Read both before changing auth or service code.

## Commands

```sh
npm run dev              # tsx watch src/main.ts (needs .env; see .env.example)
npm run build && npm start
npm run typecheck
npm run check:upstream   # spawns the official servers through the pool, lists tools, checks the arg policy
python3 scripts/smoke.py [tool]      # full flow as a fake MCP client: DCR → browser login → enrol → tokens → tools/call → refresh
npx tsx scripts/dev-token.ts <api-token>   # mint a bridge bearer for curl tests without the login (--remove to clean up)
CLIENT_ID=… ./scripts/scope-probe.sh ; python3 scripts/oauth-probe.py   # the Infomaniak OAuth probes behind NOTES.md
```

## Layout (`src/`)

- `main.ts` express app: SDK `mcpAuthRouter` (/authorize, /token, /register, /revoke,
  .well-known) + `auth/routes.ts` + `mcp.ts`; `/healthz`; landing page `/`.
- `auth/provider.ts` the OAuth 2.1 authorization server (opaque tokens stored hashed,
  refresh rotation, `completeAuthorization`). `auth/routes.ts` Infomaniak OIDC callback +
  one-time API-token enrolment (`/auth/enrol`), `auth/html.ts` the pages.
- `infomaniak/oidc.ts` identity-only login; `infomaniak/api.ts` `apiGet` (path on
  api.infomaniak.com or full URL) + `fetchProfile`.
- `services/registry.ts` one entry per product: npm package, token env var, scopes,
  `probeUrl`, `hiddenArgs` policy. `services/pool.ts` per-(user, service, token) child
  processes with idle reaping. `mcp.ts` stateless per-request proxy: merges tools/list,
  routes tools/call by prefix, enforces policy.
- `store/` tiny KV interface (`get/set/del` + TTL): `sqlite.ts` (node:sqlite) now,
  Redis planned for prod; `repo.ts` typed namespaces (client, user, pending, code, token).

## Decisions and gotchas

- **Infomaniak OAuth is SSO-only for third parties**: apps can only get
  `openid profile email phone`; API scopes → `invalid_scope`. Hence login for identity +
  the user pastes an API token (`user_info` + per-service scopes) once, stored AES-GCM.
- **Never vendor upstream code** (Mathieu's explicit preference): run the official
  packages; upgrade with `npm update`. Fix upstream problems with proxy policy
  (`hiddenArgs`) or an upstream PR, not local patches.
- Mail server talks to `https://mail.infomaniak.com/api`, calendar to
  `https://api.infomaniak.com/1/calendar/pim`; probes must use the right host.
- Upstream mail `attachments` = local file paths read by the server process → hidden and
  rejected by policy. Upstream calendar's invalid-token error is unhelpful
  ("Cannot read properties of undefined") — upstream issue, not ours.
- HTTP side is stateless (`sessionIdGenerator: undefined`, JSON responses); the process
  pool is a per-replica cache, so replicas + Redis work without sticky sessions.
- Infomaniak app redirect URIs currently registered: `http://localhost:3000/auth/infomaniak/callback`,
  `http://localhost:8000/callback` (smoke/probe scripts), claude.ai's callback. A public
  deployment needs `<PUBLIC_URL>/auth/infomaniak/callback` added too.

## Status (2026-09-28)

Local end-to-end smoke green (real calendar list through the bridge). Next: public HTTPS
deployment and first connect from claude.ai; Redis `Store`; upstream PR for a library
export so the proxy could run in-process.
