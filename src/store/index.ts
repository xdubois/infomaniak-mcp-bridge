import type {Config} from "../config.js";
import {SqliteStore} from "./sqlite.js";
import type {Store} from "./types.js";

export type {Store} from "./types.js";

export async function createStore(cfg: Config): Promise<Store> {
    switch (cfg.STORE) {
        case "sqlite":
            return new SqliteStore(cfg.SQLITE_PATH);
        case "redis":
            // Planned for production: implement Store over REDIS_URL
            // (SET ns:id json EX ttl / GET / DEL) in src/store/redis.ts.
            throw new Error("STORE=redis is not implemented yet (src/store/redis.ts)");
    }
}
