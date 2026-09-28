import {Router} from "express";
import type {Config} from "../config.js";
import {decrypt, encrypt, randomToken, s256Challenge} from "../crypto.js";
import {errorMessage, fetchProfile, InfomaniakApiError} from "../infomaniak/api.js";
import type {InfomaniakOidc} from "../infomaniak/oidc.js";
import {probeService, requiredScopes, type Service} from "../services/registry.js";
import type {PendingAuthorize, PendingForget, Repo, User} from "../store/repo.js";
import {enrolPage, errorPage, forgottenPage} from "./html.js";
import {PENDING_TTL, type BridgeAuthProvider} from "./provider.js";

interface Deps {
    cfg: Config;
    repo: Repo;
    oidc: InfomaniakOidc;
    provider: BridgeAuthProvider;
    services: Service[];
}

const EXPIRED_HINT = "Go back to Claude and start the connection again.";

/** OAuth error redirect back to the MCP client, per RFC 6749 §4.1.2.1. */
function errorRedirect(pending: PendingAuthorize, error: string, description: string): string {
    const url = new URL(pending.redirectUri);
    url.searchParams.set("error", error);
    url.searchParams.set("error_description", description);
    if (pending.state) url.searchParams.set("state", pending.state);
    return url.href;
}

function emailAllowed(email: string | undefined, domains: string[]): boolean {
    if (!domains.length) return true;
    const domain = email?.split("@")[1]?.toLowerCase();
    return !!domain && domains.some((d) => d.toLowerCase() === domain);
}

/** The token must belong to the signed-in user (matching Infomaniak id, or email as fallback). */
async function tokenOwnedBy(apiToken: string, user: User): Promise<{ok: true} | {ok: false; reason: string}> {
    try {
        const profile = await fetchProfile(apiToken);
        const sameId = String(profile.id) === user.id;
        const sameEmail = !!user.email && !!profile.email && profile.email.toLowerCase() === user.email.toLowerCase();
        if (sameId || sameEmail) return {ok: true};
        return {ok: false, reason: `This token belongs to a different Infomaniak account (${profile.email ?? profile.id}). Create it while logged in as ${user.email ?? user.id}.`};
    } catch (e) {
        const detail = e instanceof InfomaniakApiError ? `HTTP ${e.status} ${e.code}` : "network error";
        console.warn(`[auth] API token check failed for user ${user.id}: ${detail} ${errorMessage(e)}`);
        return {ok: false, reason: `Infomaniak rejected this token (${detail}: ${errorMessage(e)}). Copy it again from the Manager, or create a new one.`};
    }
}

export function authRoutes({cfg, repo, oidc, provider, services}: Deps): Router {
    const r = Router();
    const scopes = requiredScopes(services);

    const render = (res: import("express").Response, pending: PendingAuthorize, user: User | undefined, extra: {error?: string; notice?: string} = {}) =>
        res.status(extra.error ? 400 : 200).type("html").send(enrolPage({pendingId: pending.id, email: user?.email, services, scopes, ...extra}));

    // Back from Infomaniak sign-in.
    r.get("/auth/infomaniak/callback", async (req, res) => {
        const q = req.query as Record<string, string | undefined>;
        const pending = q.state ? await repo.getPending(q.state) : undefined;
        if (!pending) {
            res.status(400).type("html").send(errorPage("This sign-in link has expired or was already used.", EXPIRED_HINT));
            return;
        }
        if (q.error || !q.code) {
            await repo.delPending(pending.id);
            if (pending.action === "forget") {
                res.status(400).type("html").send(errorPage("The Infomaniak sign-in was cancelled; nothing was changed."));
                return;
            }
            res.redirect(302, errorRedirect(pending, "access_denied", q.error_description ?? q.error ?? "Infomaniak sign-in was cancelled"));
            return;
        }

        let identity;
        try {
            identity = await oidc.exchangeCode(q.code, pending.oidcVerifier);
        } catch (e) {
            console.error("[auth] Infomaniak code exchange failed:", errorMessage(e));
            res.status(502).type("html").send(errorPage("Could not complete the Infomaniak sign-in.", EXPIRED_HINT));
            return;
        }
        if (!emailAllowed(identity.email, cfg.ALLOWED_EMAIL_DOMAINS)) {
            await repo.delPending(pending.id);
            if (pending.action === "forget") {
                res.status(403).type("html").send(errorPage("This Infomaniak account is not allowed to use this bridge."));
                return;
            }
            res.redirect(302, errorRedirect(pending, "access_denied", "This Infomaniak account is not allowed to use this bridge"));
            return;
        }

        if (pending.action === "forget") {
            // Identity proven: drop the user record (API token included). Outstanding bridge tokens
            // now fail with 401 at /mcp, so every connected client asks to reconnect.
            await repo.delPending(pending.id);
            const forgotten = await repo.getUser(identity.userId);
            if (forgotten) await repo.delUser(forgotten.id);
            console.info(`[auth] user ${identity.userId} asked the bridge to forget them (${forgotten?.apiTokenEnc ? "API token deleted" : "nothing was stored"})`);
            res.type("html").send(forgottenPage({email: identity.email, hadToken: !!forgotten?.apiTokenEnc}));
            return;
        }

        const existing = await repo.getUser(identity.userId);
        const user: User = {...existing, id: identity.userId, email: identity.email ?? existing?.email};
        await repo.putUser(user);
        pending.userId = user.id;
        await repo.putPending(pending, PENDING_TTL);

        if (user.apiTokenEnc) {
            const check = await tokenOwnedBy(decrypt(user.apiTokenEnc, cfg.encryptionKey), user);
            if (check.ok) {
                res.redirect(302, await provider.completeAuthorization(pending, user.id));
                return;
            }
            console.warn(`[auth] stored API token for user ${user.id} no longer valid: ${check.reason}`);
            res.redirect(302, `/auth/enrol?p=${encodeURIComponent(pending.id)}&reason=invalid`);
            return;
        }
        res.redirect(302, `/auth/enrol?p=${encodeURIComponent(pending.id)}`);
    });

    // First-time (or replacement) API-token enrolment.
    r.get("/auth/enrol", async (req, res) => {
        const q = req.query as Record<string, string | undefined>;
        const pending = q.p ? await repo.getPending(q.p) : undefined;
        if (!pending || pending.action === "forget" || !pending.userId) {
            res.status(400).type("html").send(errorPage("This page has expired.", EXPIRED_HINT));
            return;
        }
        const user = await repo.getUser(pending.userId);
        render(res, pending, user, {
            notice: q.reason === "invalid" ? "The API token you saved earlier no longer works (revoked or expired). Please paste a new one." : undefined,
        });
    });

    r.post("/auth/enrol", async (req, res) => {
        const body = (req.body ?? {}) as Record<string, string | undefined>;
        const pending = body.p ? await repo.getPending(body.p) : undefined;
        const user = pending?.userId ? await repo.getUser(pending.userId) : undefined;
        if (!pending || pending.action === "forget" || !user) {
            res.status(400).type("html").send(errorPage("This page has expired.", EXPIRED_HINT));
            return;
        }
        const token = (body.token ?? "").trim();
        if (!token) {
            render(res, pending, user, {error: "Please paste a token."});
            return;
        }

        const owned = await tokenOwnedBy(token, user);
        if (!owned.ok) {
            render(res, pending, user, {error: owned.reason});
            return;
        }
        const failures: string[] = [];
        for (const s of services) {
            try {
                await probeService(s, token);
            } catch (e) {
                console.warn(`[auth] probe ${s.name} failed for user ${user.id}: ${errorMessage(e)}`);
                failures.push(`${s.title}: ${errorMessage(e)}`);
            }
        }
        if (failures.length) {
            render(res, pending, user, {error: `The token works but can't access: ${failures.join(" | ")}. Check it has the scopes ${scopes.join(", ")}.`});
            return;
        }

        await repo.putUser({...user, apiTokenEnc: encrypt(token, cfg.encryptionKey), enrolledAt: Date.now()});
        console.info(`[auth] user ${user.id} enrolled an API token`);
        res.redirect(302, await provider.completeAuthorization(pending, user.id));
    });

    // Self-service "forget my API token": prove identity through the same Infomaniak sign-in,
    // then the callback deletes the user record. Revoking the token itself is done in the Manager.
    r.get("/auth/forget", async (_req, res) => {
        const pending: PendingForget = {id: randomToken(32), action: "forget", oidcVerifier: randomToken(48), createdAt: Date.now()};
        await repo.putPending(pending, PENDING_TTL);
        res.redirect(302, oidc.authorizeUrl({state: pending.id, codeChallenge: s256Challenge(pending.oidcVerifier)}));
    });

    return r;
}
