import {createClient} from "redis";
import type {Store} from "./types.js";

// Pin the concrete client type node-redis infers for a plain URL client (its generic default is wider).
const makeClient = (url: string) => createClient({url});
type Client = ReturnType<typeof makeClient>;

/**
 * Store over Redis: `<prefix>:<ns>:<id>` -> JSON, TTL via SETEX. Shared by every replica, which is
 * what makes the bridge horizontally scalable (the HTTP side is stateless, the process pool is a
 * per-replica cache).
 */
export class RedisStore implements Store {
    private constructor(
        private readonly client: Client,
        private readonly prefix: string,
    ) {}

    static async connect(url: string, prefix = "bridge"): Promise<RedisStore> {
        const client = makeClient(url);
        client.on("error", (e: Error) => console.error("[store] redis:", e.message));
        await client.connect();
        return new RedisStore(client, prefix);
    }

    private key(ns: string, id: string): string {
        return `${this.prefix}:${ns}:${id}`;
    }

    async get<T>(ns: string, id: string): Promise<T | undefined> {
        const v = await this.client.get(this.key(ns, id));
        return v == null ? undefined : (JSON.parse(v) as T);
    }

    async set<T>(ns: string, id: string, value: T, ttlSeconds?: number): Promise<void> {
        const key = this.key(ns, id);
        const json = JSON.stringify(value);
        if (ttlSeconds) await this.client.setEx(key, ttlSeconds, json);
        else await this.client.set(key, json);
    }

    async del(ns: string, id: string): Promise<void> {
        await this.client.del(this.key(ns, id));
    }

    async close(): Promise<void> {
        await this.client.close();
    }
}
