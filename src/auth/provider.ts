import type {Response} from "express";
import type {OAuthRegisteredClientsStore} from "@modelcontextprotocol/sdk/server/auth/clients.js";
import {InvalidGrantError, InvalidScopeError, InvalidTokenError} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type {AuthorizationParams, OAuthServerProvider} from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type {AuthInfo} from "@modelcontextprotocol/sdk/server/auth/types.js";
import type {OAuthClientInformationFull, OAuthTokenRevocationRequest, OAuthTokens} from "@modelcontextprotocol/sdk/shared/auth.js";
import type {Config} from "../config.js";
import {randomToken, s256Challenge, sha256} from "../crypto.js";
import type {InfomaniakOidc} from "../infomaniak/oidc.js";
import type {Pending, Repo} from "../store/repo.js";

export const PENDING_TTL = 10 * 60; // user has 10 min to sign in + enrol
const CODE_TTL = 5 * 60;

const nowSec = () => Math.floor(Date.now() / 1000);

/**
 * The bridge is the OAuth 2.1 authorization server that MCP clients (claude.ai) talk to.
 *
 * authorize()  -> park the request, send the user to Infomaniak OIDC (identity only)
 * callback     -> src/auth/routes.ts: identity -> (enrol API token if needed) -> completeAuthorization()
 * token        -> opaque access/refresh tokens, stored hashed, bound to an Infomaniak user
 * verify       -> AuthInfo.extra.userId lets the MCP endpoint load that user's API token
 */
export class BridgeAuthProvider implements OAuthServerProvider {
    constructor(
        private readonly repo: Repo,
        private readonly oidc: InfomaniakOidc,
        private readonly cfg: Config,
    ) {}

    get clientsStore(): OAuthRegisteredClientsStore {
        return {
            getClient: (clientId) => this.repo.getClient(clientId),
            // The SDK's registration handler generates client_id (+ secret) before calling us.
            registerClient: async (client) => {
                const full = client as OAuthClientInformationFull;
                await this.repo.putClient(full, this.clientTtl);
                return full;
            },
        };
    }

    /** Registrations expire unless they keep issuing tokens; never shorter than a refresh token's life. */
    private get clientTtl(): number {
        return Math.max(this.cfg.CLIENT_TTL, this.cfg.REFRESH_TOKEN_TTL);
    }

    async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
        const pending: Pending = {
            id: randomToken(32),
            clientId: client.client_id,
            redirectUri: params.redirectUri,
            codeChallenge: params.codeChallenge,
            state: params.state,
            scopes: params.scopes ?? [],
            resource: params.resource?.href,
            oidcVerifier: randomToken(48),
            createdAt: Date.now(),
        };
        await this.repo.putPending(pending, PENDING_TTL);
        res.redirect(302, this.oidc.authorizeUrl({state: pending.id, codeChallenge: s256Challenge(pending.oidcVerifier)}));
    }

    /** Called by routes once the user is signed in AND has an API token on file. */
    async completeAuthorization(pending: Pending, userId: string): Promise<string> {
        const code = randomToken(32);
        await this.repo.putCode(
            sha256(code),
            {
                clientId: pending.clientId,
                userId,
                redirectUri: pending.redirectUri,
                codeChallenge: pending.codeChallenge,
                scopes: pending.scopes,
                resource: pending.resource,
            },
            CODE_TTL,
        );
        await this.repo.delPending(pending.id);
        const url = new URL(pending.redirectUri);
        url.searchParams.set("code", code);
        if (pending.state) url.searchParams.set("state", pending.state);
        return url.href;
    }

    async challengeForAuthorizationCode(client: OAuthClientInformationFull, authorizationCode: string): Promise<string> {
        const rec = await this.repo.getCode(sha256(authorizationCode));
        if (!rec || rec.clientId !== client.client_id) throw new InvalidGrantError("Unknown authorization code");
        return rec.codeChallenge;
    }

    async exchangeAuthorizationCode(
        client: OAuthClientInformationFull,
        authorizationCode: string,
        _codeVerifier?: string,
        redirectUri?: string,
        resource?: URL,
    ): Promise<OAuthTokens> {
        const hash = sha256(authorizationCode);
        const rec = await this.repo.getCode(hash);
        if (!rec || rec.clientId !== client.client_id) throw new InvalidGrantError("Unknown authorization code");
        await this.repo.delCode(hash); // single use
        if (redirectUri && redirectUri !== rec.redirectUri) throw new InvalidGrantError("redirect_uri mismatch");
        if (resource && rec.resource && resource.href !== rec.resource) throw new InvalidGrantError("resource mismatch");
        return this.issueTokens(rec.userId, client.client_id, rec.scopes, rec.resource);
    }

    async exchangeRefreshToken(
        client: OAuthClientInformationFull,
        refreshToken: string,
        scopes?: string[],
        resource?: URL,
    ): Promise<OAuthTokens> {
        const hash = sha256(refreshToken);
        const rec = await this.repo.getToken(hash);
        if (!rec || rec.kind !== "refresh" || rec.clientId !== client.client_id || rec.expiresAt <= nowSec()) {
            throw new InvalidGrantError("Invalid refresh token");
        }
        // RFC 6749 §6: a refresh may narrow the grant, never widen it; the resource stays the same.
        if (scopes?.some((s) => !rec.scopes.includes(s))) throw new InvalidScopeError("Requested scope exceeds the original grant");
        if (resource && rec.resource && resource.href !== rec.resource) throw new InvalidGrantError("resource mismatch");
        // Rotate: the old refresh token and its access token die together.
        await this.repo.delToken(hash);
        if (rec.pairHash) await this.repo.delToken(rec.pairHash);
        return this.issueTokens(rec.userId, client.client_id, scopes ?? rec.scopes, rec.resource);
    }

    async verifyAccessToken(token: string): Promise<AuthInfo> {
        const rec = await this.repo.getToken(sha256(token));
        if (!rec || rec.kind !== "access") throw new InvalidTokenError("Invalid access token");
        if (rec.expiresAt <= nowSec()) throw new InvalidTokenError("Access token expired");
        return {
            token,
            clientId: rec.clientId,
            scopes: rec.scopes,
            expiresAt: rec.expiresAt,
            resource: rec.resource ? new URL(rec.resource) : undefined,
            extra: {userId: rec.userId},
        };
    }

    async revokeToken(client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
        const hash = sha256(request.token);
        const rec = await this.repo.getToken(hash);
        if (!rec || rec.clientId !== client.client_id) return;
        await this.repo.delToken(hash);
        if (rec.pairHash) await this.repo.delToken(rec.pairHash);
    }

    private async issueTokens(userId: string, clientId: string, scopes: string[], resource?: string): Promise<OAuthTokens> {
        const access = randomToken(32);
        const refresh = randomToken(32);
        const accessHash = sha256(access);
        const now = nowSec();
        const base = {clientId, userId, scopes, resource};
        await this.repo.putToken(accessHash, {...base, kind: "access", expiresAt: now + this.cfg.ACCESS_TOKEN_TTL}, this.cfg.ACCESS_TOKEN_TTL);
        await this.repo.putToken(
            sha256(refresh),
            {...base, kind: "refresh", expiresAt: now + this.cfg.REFRESH_TOKEN_TTL, pairHash: accessHash},
            this.cfg.REFRESH_TOKEN_TTL,
        );
        await this.repo.touchClient(clientId, this.clientTtl);
        return {
            access_token: access,
            token_type: "bearer",
            expires_in: this.cfg.ACCESS_TOKEN_TTL,
            refresh_token: refresh,
            scope: scopes.length ? scopes.join(" ") : undefined,
        };
    }
}
