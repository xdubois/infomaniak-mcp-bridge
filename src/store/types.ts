/**
 * Namespaced key-value store with optional TTL. Deliberately tiny so a Redis
 * implementation is `SET ns:id json EX ttl` / `GET` / `DEL` (see src/store/index.ts).
 */
export interface Store {
    get<T>(ns: string, id: string): Promise<T | undefined>;
    set<T>(ns: string, id: string, value: T, ttlSeconds?: number): Promise<void>;
    del(ns: string, id: string): Promise<void>;
    close(): Promise<void>;
}
