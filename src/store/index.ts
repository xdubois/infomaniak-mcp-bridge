import type {Config} from "../config.js";
import {RedisStore} from "./redis.js";
import {SqliteStore} from "./sqlite.js";
import type {Store} from "./types.js";

export type {Store} from "./types.js";

export async function createStore(cfg: Config): Promise<Store> {
    switch (cfg.STORE) {
        case "sqlite":
            return new SqliteStore(cfg.SQLITE_PATH);
        case "redis":
            if (!cfg.REDIS_URL) throw new Error("STORE=redis needs REDIS_URL (e.g. redis://:password@host:6379/0)");
            return RedisStore.connect(cfg.REDIS_URL);
    }
}
