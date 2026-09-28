import {createRequire} from "node:module";
import express from "express";
import {mcpAuthRouter} from "@modelcontextprotocol/sdk/server/auth/router.js";
import {landingPage} from "./auth/html.js";
import {BridgeAuthProvider} from "./auth/provider.js";
import {authRoutes} from "./auth/routes.js";
import {loadConfig} from "./config.js";
import {loadDotEnv} from "./env.js";
import {InfomaniakOidc} from "./infomaniak/oidc.js";
import {MCP_PATH, mcpRouter} from "./mcp.js";
import {ProcessPool} from "./services/pool.js";
import {resolveServices, upstreamVersion} from "./services/registry.js";
import {createStore} from "./store/index.js";
import {Repo} from "./store/repo.js";

const require = createRequire(import.meta.url);
const {version} = require("../package.json") as {version: string};

async function main(): Promise<void> {
    loadDotEnv();
    const cfg = loadConfig();
    const services = resolveServices(cfg.ENABLED_SERVICES);
    const store = await createStore(cfg);
    const repo = new Repo(store);
    const oidc = new InfomaniakOidc(cfg.INFOMANIAK_CLIENT_ID, cfg.INFOMANIAK_CLIENT_SECRET, new URL("/auth/infomaniak/callback", cfg.publicUrl).href);
    const provider = new BridgeAuthProvider(repo, oidc, cfg);
    const mcpUrl = new URL(MCP_PATH, cfg.publicUrl);
    const pool = new ProcessPool({idleTtlSec: cfg.PROCESS_IDLE_TTL, max: cfg.MAX_PROCESSES, version});

    const app = express();
    app.disable("x-powered-by");
    if (cfg.TRUST_PROXY) app.set("trust proxy", 1);
    app.use(express.json({limit: "8mb"}));
    app.use(express.urlencoded({extended: false}));

    // /authorize, /token, /register, /revoke + /.well-known/{oauth-authorization-server,oauth-protected-resource/mcp}
    app.use(
        mcpAuthRouter({
            provider,
            issuerUrl: cfg.publicUrl,
            resourceServerUrl: mcpUrl,
            resourceName: "Infomaniak MCP Bridge",
            serviceDocumentationUrl: cfg.publicUrl,
            clientRegistrationOptions: {clientSecretExpirySeconds: 0},
        }),
    );
    app.use(authRoutes({cfg, repo, oidc, provider, services}));
    app.use(mcpRouter({cfg, repo, provider, services, pool, version}));

    app.get("/healthz", (_req, res) => {
        res.json({ok: true, version, services: Object.fromEntries(services.map((s) => [s.name, `${s.pkg}@${upstreamVersion(s)}`])), processes: pool.size});
    });
    app.get("/", (_req, res) => {
        res.type("html").send(landingPage({mcpUrl: mcpUrl.href, services}));
    });

    const httpServer = app.listen(cfg.PORT, () => {
        console.info(`[bridge] v${version} listening on :${cfg.PORT}, public ${cfg.publicUrl.href}, MCP ${mcpUrl.href}`);
        console.info(`[bridge] services: ${services.map((s) => `${s.name} (${s.pkg}@${upstreamVersion(s)})`).join(", ")}; store: ${cfg.STORE}`);
        console.info(`[bridge] Infomaniak app redirect URI must include ${new URL("/auth/infomaniak/callback", cfg.publicUrl).href}`);
    });

    const shutdown = (signal: string) => {
        console.info(`[bridge] ${signal}, shutting down`);
        httpServer.close(() => {
            void Promise.all([pool.closeAll(), store.close()]).then(() => process.exit(0));
        });
        setTimeout(() => process.exit(1), 10_000).unref();
    };
    process.on("SIGTERM", () => shutdown("SIGTERM"));
    process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((e) => {
    console.error("[bridge] fatal:", e instanceof Error ? e.message : e);
    process.exit(1);
});
