import {z} from "zod";

const csv = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);
const bool = z.string().default("false").transform((s) => ["1", "true", "yes"].includes(s.toLowerCase()));

const EnvSchema = z.object({
    /** Externally reachable base URL of this bridge (what claude.ai talks to). */
    PUBLIC_URL: z.url().default("http://localhost:3000"),
    PORT: z.coerce.number().int().positive().default(3000),
    /** Behind a reverse proxy / ingress, trust X-Forwarded-* (rate limiting, redirects). */
    TRUST_PROXY: bool,

    /** Infomaniak OAuth application (Manager > Cloud Computing > Auth, or account > applications). SSO only. */
    INFOMANIAK_CLIENT_ID: z.string().min(1),
    INFOMANIAK_CLIENT_SECRET: z.string().min(1),

    /** 32 random bytes, base64 (`openssl rand -base64 32`). Encrypts stored Infomaniak API tokens. */
    BRIDGE_ENCRYPTION_KEY: z.string().min(1),

    STORE: z.enum(["sqlite", "redis"]).default("sqlite"),
    SQLITE_PATH: z.string().default("./data/bridge.sqlite"),
    REDIS_URL: z.string().optional(),

    /** Which Infomaniak products the bridge exposes as MCP tools (see src/services/registry.ts). */
    ENABLED_SERVICES: z.string().default("mail,calendar").transform(csv),
    /** Optional extra guard: only these email domains may sign in (the Infomaniak app can also restrict to your org). */
    ALLOWED_EMAIL_DOMAINS: z.string().default("").transform(csv),

    /** Idle seconds before a user's upstream server process is stopped; max processes per replica. */
    PROCESS_IDLE_TTL: z.coerce.number().int().positive().default(600),
    MAX_PROCESSES: z.coerce.number().int().positive().default(100),

    ACCESS_TOKEN_TTL: z.coerce.number().int().positive().default(3600),
    REFRESH_TOKEN_TTL: z.coerce.number().int().positive().default(30 * 24 * 3600),
});

export type Config = z.infer<typeof EnvSchema> & {
    publicUrl: URL;
    encryptionKey: Buffer;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
    const parsed = EnvSchema.safeParse(env);
    if (!parsed.success) {
        const issues = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
        throw new Error(`Invalid configuration:\n${issues}\n(see .env.example)`);
    }
    const cfg = parsed.data;
    const key = Buffer.from(cfg.BRIDGE_ENCRYPTION_KEY, "base64");
    if (key.length !== 32) {
        throw new Error("BRIDGE_ENCRYPTION_KEY must be 32 bytes, base64-encoded (openssl rand -base64 32)");
    }
    return {...cfg, publicUrl: new URL(cfg.PUBLIC_URL), encryptionKey: key};
}
