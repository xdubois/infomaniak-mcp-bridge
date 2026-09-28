import fs from "node:fs";
import path from "node:path";
import {DatabaseSync, type StatementSync} from "node:sqlite";
import type {Store} from "./types.js";

const nowSec = () => Math.floor(Date.now() / 1000);

export class SqliteStore implements Store {
    private readonly db: DatabaseSync;
    private readonly getStmt: StatementSync;
    private readonly setStmt: StatementSync;
    private readonly delStmt: StatementSync;
    private readonly purgeStmt: StatementSync;
    private readonly purgeTimer: NodeJS.Timeout;

    constructor(file: string) {
        if (file !== ":memory:") fs.mkdirSync(path.dirname(file), {recursive: true});
        this.db = new DatabaseSync(file);
        this.db.exec(`
            PRAGMA journal_mode = WAL;
            CREATE TABLE IF NOT EXISTS records (
                ns TEXT NOT NULL,
                id TEXT NOT NULL,
                data TEXT NOT NULL,
                expires_at INTEGER,
                PRIMARY KEY (ns, id)
            );
            CREATE INDEX IF NOT EXISTS records_expires_at ON records (expires_at);
        `);
        this.getStmt = this.db.prepare("SELECT data, expires_at FROM records WHERE ns = ? AND id = ?");
        this.setStmt = this.db.prepare("INSERT OR REPLACE INTO records (ns, id, data, expires_at) VALUES (?, ?, ?, ?)");
        this.delStmt = this.db.prepare("DELETE FROM records WHERE ns = ? AND id = ?");
        this.purgeStmt = this.db.prepare("DELETE FROM records WHERE expires_at IS NOT NULL AND expires_at <= ?");
        this.purgeTimer = setInterval(() => this.purge(), 10 * 60 * 1000);
        this.purgeTimer.unref();
        this.purge();
    }

    async get<T>(ns: string, id: string): Promise<T | undefined> {
        const row = this.getStmt.get(ns, id) as {data: string; expires_at: number | null} | undefined;
        if (!row) return undefined;
        if (row.expires_at !== null && row.expires_at <= nowSec()) {
            this.delStmt.run(ns, id);
            return undefined;
        }
        return JSON.parse(row.data) as T;
    }

    async set<T>(ns: string, id: string, value: T, ttlSeconds?: number): Promise<void> {
        this.setStmt.run(ns, id, JSON.stringify(value), ttlSeconds ? nowSec() + ttlSeconds : null);
    }

    async del(ns: string, id: string): Promise<void> {
        this.delStmt.run(ns, id);
    }

    purge(): void {
        this.purgeStmt.run(nowSec());
    }

    async close(): Promise<void> {
        clearInterval(this.purgeTimer);
        this.db.close();
    }
}
