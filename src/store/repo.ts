import type {OAuthClientInformationFull} from "@modelcontextprotocol/sdk/shared/auth.js";
import type {Store} from "./types.js";

export interface User {
    /** Infomaniak user id (from the OIDC login). */
    id: string;
    email?: string;
    /** Infomaniak API token, AES-GCM encrypted (see crypto.ts). Absent until enrolled. */
    apiTokenEnc?: string;
    enrolledAt?: number;
}

/** An authorization request from an MCP client, parked while the user signs in / enrols. */
export interface Pending {
    id: string;
    clientId: string;
    redirectUri: string;
    codeChallenge: string;
    state?: string;
    scopes: string[];
    resource?: string;
    /** PKCE verifier for OUR upstream Infomaniak login. */
    oidcVerifier: string;
    /** Set once Infomaniak sign-in completed. */
    userId?: string;
    createdAt: number;
}

export interface CodeRecord {
    clientId: string;
    userId: string;
    redirectUri: string;
    codeChallenge: string;
    scopes: string[];
    resource?: string;
}

export interface TokenRecord {
    kind: "access" | "refresh";
    clientId: string;
    userId: string;
    scopes: string[];
    resource?: string;
    /** Unix seconds. */
    expiresAt: number;
    /** For refresh tokens: sha256 of the access token issued alongside (revoked on rotation). */
    pairHash?: string;
}

const NS = {client: "client", user: "user", pending: "pending", code: "code", token: "token"} as const;

/** Typed access to the store's namespaces. Tokens and codes are keyed by their sha256, never stored raw. */
export class Repo {
    constructor(private readonly store: Store) {}

    getClient = (id: string) => this.store.get<OAuthClientInformationFull>(NS.client, id);
    putClient = (c: OAuthClientInformationFull) => this.store.set(NS.client, c.client_id, c);

    getUser = (id: string) => this.store.get<User>(NS.user, id);
    putUser = (u: User) => this.store.set(NS.user, u.id, u);

    getPending = (id: string) => this.store.get<Pending>(NS.pending, id);
    putPending = (p: Pending, ttl: number) => this.store.set(NS.pending, p.id, p, ttl);
    delPending = (id: string) => this.store.del(NS.pending, id);

    getCode = (hash: string) => this.store.get<CodeRecord>(NS.code, hash);
    putCode = (hash: string, c: CodeRecord, ttl: number) => this.store.set(NS.code, hash, c, ttl);
    delCode = (hash: string) => this.store.del(NS.code, hash);

    getToken = (hash: string) => this.store.get<TokenRecord>(NS.token, hash);
    putToken = (hash: string, t: TokenRecord, ttl: number) => this.store.set(NS.token, hash, t, ttl);
    delToken = (hash: string) => this.store.del(NS.token, hash);
}
