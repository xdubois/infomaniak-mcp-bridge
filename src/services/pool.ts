import {Client} from "@modelcontextprotocol/sdk/client/index.js";
import {getDefaultEnvironment, StdioClientTransport} from "@modelcontextprotocol/sdk/client/stdio.js";
import type {Tool} from "@modelcontextprotocol/sdk/types.js";
import {sha256} from "../crypto.js";
import {serverEntrypoint, serviceEnv, type Service} from "./registry.js";

export interface PooledServer {
    key: string;
    service: Service;
    userId: string;
    client: Client;
    lastUsed: number;
    tools?: Promise<Tool[]>;
}

const TOOLS_CACHE_MS = 5 * 60 * 1000;

/**
 * Keeps one official MCP server process per (user, service, token) alive while it is being
 * used, and reaps it after `idleTtlSec`. Purely a per-replica cache: the HTTP side is
 * stateless, so any replica can spawn its own copy on demand.
 */
export class ProcessPool {
    private readonly entries = new Map<string, Promise<PooledServer>>();
    private readonly reaper: NodeJS.Timeout;

    constructor(private readonly opts: {idleTtlSec: number; max: number; version: string}) {
        this.reaper = setInterval(() => void this.reap(), 30_000);
        this.reaper.unref();
    }

    get size(): number {
        return this.entries.size;
    }

    async acquire(service: Service, userId: string, apiToken: string): Promise<PooledServer> {
        const key = `${userId}:${service.name}:${sha256(apiToken).slice(0, 16)}`;
        let pending = this.entries.get(key);
        if (!pending) {
            if (this.entries.size >= this.opts.max) await this.evictOldest();
            pending = this.spawn(key, service, userId, apiToken);
            this.entries.set(key, pending);
            pending.catch(() => this.entries.delete(key));
        }
        const entry = await pending;
        entry.lastUsed = Date.now();
        return entry;
    }

    /** tools/list of the upstream server, cached per process for a few minutes. */
    listTools(entry: PooledServer): Promise<Tool[]> {
        if (!entry.tools) {
            entry.tools = entry.client.listTools().then((r) => r.tools);
            entry.tools.catch(() => (entry.tools = undefined));
            setTimeout(() => (entry.tools = undefined), TOOLS_CACHE_MS).unref();
        }
        return entry.tools;
    }

    private async spawn(key: string, service: Service, userId: string, apiToken: string): Promise<PooledServer> {
        const transport = new StdioClientTransport({
            command: process.execPath,
            args: [serverEntrypoint(service)],
            // Only a sanitised base environment, the service's deployment settings (team, drive id)
            // and the one token: never the bridge's own secrets.
            env: {...getDefaultEnvironment(), ...serviceEnv(service), [service.tokenEnv]: apiToken},
            stderr: "pipe",
        });
        transport.stderr?.on("data", (chunk: Buffer) => {
            for (const line of chunk.toString().split("\n")) {
                if (line.trim()) console.warn(`[upstream ${service.name} user=${userId}] ${line}`);
            }
        });
        const client = new Client({name: "infomaniak-mcp-bridge", version: this.opts.version});
        const started = Date.now();
        await client.connect(transport);
        const entry: PooledServer = {key, service, userId, client, lastUsed: Date.now()};
        client.onclose = () => {
            this.entries.delete(key);
        };
        client.onerror = (e) => console.error(`[upstream ${service.name} user=${userId}] ${e.message}`);
        console.info(`[pool] spawned ${service.pkg} for user ${userId} in ${Date.now() - started}ms (pool size ${this.entries.size})`);
        return entry;
    }

    private async reap(): Promise<void> {
        const cutoff = Date.now() - this.opts.idleTtlSec * 1000;
        for (const [key, pending] of this.entries) {
            const entry = await pending.catch(() => undefined);
            if (entry && entry.lastUsed < cutoff) await this.close(key, entry);
        }
    }

    private async evictOldest(): Promise<void> {
        let oldest: PooledServer | undefined;
        for (const pending of this.entries.values()) {
            const e = await pending.catch(() => undefined);
            if (e && (!oldest || e.lastUsed < oldest.lastUsed)) oldest = e;
        }
        if (oldest) await this.close(oldest.key, oldest);
    }

    private async close(key: string, entry: PooledServer): Promise<void> {
        this.entries.delete(key);
        await entry.client.close().catch(() => undefined);
    }

    async closeAll(): Promise<void> {
        clearInterval(this.reaper);
        await Promise.all([...this.entries].map(async ([key, p]) => this.close(key, await p.catch(() => undefined) as PooledServer).catch(() => undefined)));
    }
}
