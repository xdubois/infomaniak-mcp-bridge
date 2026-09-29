import {Router, type Request, type Response} from "express";
import {requireBearerAuth} from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import {getOAuthProtectedResourceMetadataUrl} from "@modelcontextprotocol/sdk/server/auth/router.js";
import {Server} from "@modelcontextprotocol/sdk/server/index.js";
import {StreamableHTTPServerTransport} from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult, type Tool} from "@modelcontextprotocol/sdk/types.js";
import type {BridgeAuthProvider} from "./auth/provider.js";
import type {Config} from "./config.js";
import {decrypt} from "./crypto.js";
import {errorMessage} from "./infomaniak/api.js";
import type {ProcessPool} from "./services/pool.js";
import type {Service} from "./services/registry.js";
import type {Repo} from "./store/repo.js";

interface Deps {
    cfg: Config;
    repo: Repo;
    provider: BridgeAuthProvider;
    services: Service[];
    pool: ProcessPool;
    version: string;
}

export const MCP_PATH = "/mcp";
const UPSTREAM_TIMEOUT_MS = 120_000;

/** tools/list view of an upstream tool with policy-hidden arguments removed from its schema. */
export function applyPolicy(service: Service, tool: Tool): Tool {
    const hidden = service.hiddenArgs?.names ?? [];
    if (!hidden.length || !tool.inputSchema?.properties) return tool;
    const properties = Object.fromEntries(Object.entries(tool.inputSchema.properties).filter(([k]) => !hidden.includes(k)));
    const required = tool.inputSchema.required?.filter((k) => !hidden.includes(k));
    return {...tool, inputSchema: {...tool.inputSchema, properties, ...(required ? {required} : {})}};
}

/** Returns the reason if the call uses a hidden argument (non-empty), else undefined. */
export function policyViolation(service: Service, args: Record<string, unknown> | undefined): string | undefined {
    if (!service.hiddenArgs || !args) return undefined;
    for (const name of service.hiddenArgs.names) {
        const v = args[name];
        if (v === undefined || v === null || (Array.isArray(v) && v.length === 0)) continue;
        return `${service.hiddenArgs.reason} (argument "${name}")`;
    }
    return undefined;
}

const errorResult = (text: string): CallToolResult => ({content: [{type: "text", text}], isError: true});

/**
 * Stateless Streamable HTTP: every POST builds a throwaway MCP server that proxies
 * tools/list and tools/call to the calling user's upstream processes (one official
 * Infomaniak server per enabled service, from the pool).
 */
export function mcpRouter({cfg, repo, provider, services, pool, version}: Deps): Router {
    const r = Router();
    const resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(new URL(MCP_PATH, cfg.publicUrl));
    const bearer = requireBearerAuth({verifier: provider, resourceMetadataUrl});

    r.post(MCP_PATH, bearer, async (req: Request, res: Response) => {
        const userId = req.auth?.extra?.userId;
        const user = typeof userId === "string" ? await repo.getUser(userId) : undefined;
        if (!user?.apiTokenEnc) {
            // Valid bridge token but no API token on file: answer like an expired token so the
            // client re-runs the OAuth flow, which lands on enrolment.
            res.set("WWW-Authenticate", `Bearer error="invalid_token", error_description="No Infomaniak API token enrolled", resource_metadata="${resourceMetadataUrl}"`);
            res.status(401).json({error: "invalid_token", error_description: "No Infomaniak API token enrolled; reconnect the connector"});
            return;
        }
        let apiToken: string;
        try {
            apiToken = decrypt(user.apiTokenEnc, cfg.encryptionKey);
        } catch (e) {
            // E.g. the encryption key was rotated: treat as "no usable token" so the client
            // re-runs the OAuth flow and re-enrols, instead of a raw 500.
            console.error(`[mcp] stored API token undecryptable for user ${user.id}: ${errorMessage(e)}`);
            res.set("WWW-Authenticate", `Bearer error="invalid_token", error_description="No Infomaniak API token enrolled", resource_metadata="${resourceMetadataUrl}"`);
            res.status(401).json({error: "invalid_token", error_description: "No Infomaniak API token enrolled; reconnect the connector"});
            return;
        }
        const upstream = (service: Service) => pool.acquire(service, user.id, apiToken);
        const clientId = req.auth?.clientId ?? "unknown";

        const server = new Server({name: "infomaniak-mcp-bridge", version}, {capabilities: {tools: {}}});

        server.setRequestHandler(ListToolsRequestSchema, async () => {
            const lists = await Promise.allSettled(
                services.map(async (s) => (await pool.listTools(await upstream(s))).map((t) => applyPolicy(s, t))),
            );
            const tools: Tool[] = [];
            lists.forEach((l, i) => {
                if (l.status === "fulfilled") tools.push(...l.value);
                else console.error(`[mcp] tools/list from ${services[i].name} failed for user ${user.id}: ${errorMessage(l.reason)}`);
            });
            return {tools};
        });

        server.setRequestHandler(CallToolRequestSchema, async (req) => {
            const {name, arguments: args} = req.params;
            const started = Date.now();
            // Audit trail: who called what through which client. Tool ARGUMENTS are never
            // logged (they carry message bodies, file names, ...); the outcome line is the
            // only record of a user's actions on the shared host.
            const audit = (outcome: string, detail = "") =>
                console.info(`[audit] user=${user.id} client=${clientId} tool=${name} ${outcome}${detail ? ` (${detail})` : ""} ${Date.now() - started}ms`);
            const service = services.find((s) => name.startsWith(`${s.name}_`));
            if (!service) {
                audit("rejected", "unknown tool");
                return errorResult(`Unknown tool: ${name}`);
            }
            const violation = policyViolation(service, args);
            if (violation) {
                audit("rejected", "policy");
                return errorResult(violation);
            }
            try {
                const entry = await upstream(service);
                const result = (await entry.client.callTool({name, arguments: args ?? {}}, undefined, {timeout: UPSTREAM_TIMEOUT_MS})) as CallToolResult;
                audit(result.isError ? "error" : "ok");
                return result;
            } catch (e) {
                audit("error", errorMessage(e));
                throw e;
            }
        });

        const transport = new StreamableHTTPServerTransport({sessionIdGenerator: undefined, enableJsonResponse: true});
        res.on("close", () => {
            void transport.close();
            void server.close();
        });
        try {
            await server.connect(transport);
            await transport.handleRequest(req, res, req.body);
        } catch (e) {
            console.error("[mcp] request failed:", e);
            if (!res.headersSent) res.status(500).json({jsonrpc: "2.0", error: {code: -32603, message: "Internal server error"}, id: null});
        }
    });

    const methodNotAllowed = (_req: Request, res: Response) => {
        res.status(405).json({jsonrpc: "2.0", error: {code: -32000, message: "Method not allowed."}, id: null});
    };
    r.get(MCP_PATH, methodNotAllowed);
    r.delete(MCP_PATH, methodNotAllowed);
    return r;
}
