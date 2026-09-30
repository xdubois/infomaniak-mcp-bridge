import {Router} from "express";
import type {Config} from "../config.js";
import {decrypt, encrypt, randomToken, s256Challenge} from "../crypto.js";
import {errorMessage, fetchProfile, InfomaniakApiError} from "../infomaniak/api.js";
import type {InfomaniakOidc} from "../infomaniak/oidc.js";
import {probeService, requiredScopes, type Service} from "../services/registry.js";
import type {PendingAuthorize, PendingForget, Repo, User} from "../store/repo.js";
import {consentPage, enrolPage, errorPage, forgottenPage} from "./html.js";
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
    const enrolUrl = (pending: PendingAuthorize, reason?: string) => `/auth/enrol?p=${encodeURIComponent(pending.id)}${reason ? `&reason=${reason}` : ""}`;
    const consentUrl = (pending: PendingAuthorize) => `/auth/consent?p=${encodeURIComponent(pending.id)}`;
    /** The parked request behind the enrol / consent pages: sign-in completed, user record loaded. */
    const signedIn = async (p: string | undefined): Promise<{pending: PendingAuthorize; user: User} | undefined> => {
        const pending = p ? await repo.getPending(p) : undefined;
        if (!pending || pending.action === "forget" || !pending.userId) return undefined;
        const user = await repo.getUser(pending.userId);
        return user ? {pending, user} : undefined;
    };

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
        // Re-key the parked request: from here on only the browser that completed the Infomaniak
        // sign-in knows the id. Whoever started the flow knew the old one (it was the OIDC state),
        // and if that was someone else they must not be able to finish it.
        await repo.delPending(pending.id);
        const session: PendingAuthorize = {...pending, id: randomToken(32), userId: user.id};
        await repo.putPending(session, PENDING_TTL);

        if (user.apiTokenEnc) {
            let stored: string | undefined;
            try {
                stored = decrypt(user.apiTokenEnc, cfg.encryptionKey);
            } catch (e) {
                // E.g. the encryption key was rotated: ask for a fresh token instead of a raw 500.
                console.warn(`[auth] stored API token undecryptable for user ${user.id}: ${errorMessage(e)}`);
            }
            if (stored !== undefined) {
                const check = await tokenOwnedBy(stored, user);
                if (check.ok) {
                    res.redirect(302, consentUrl(session));
                    return;
                }
                console.warn(`[auth] stored API token for user ${user.id} no longer valid: ${check.reason}`);
            }
            res.redirect(302, enrolUrl(session, "invalid"));
            return;
        }
        res.redirect(302, enrolUrl(session));
    });

    // First-time (or replacement) API-token enrolment.
    r.get("/auth/enrol", async (req, res) => {
        const q = req.query as Record<string, string | undefined>;
        const ctx = await signedIn(q.p);
        if (!ctx) {
            res.status(400).type("html").send(errorPage("This page has expired.", EXPIRED_HINT));
            return;
        }
        const {pending, user} = ctx;
        render(res, pending, user, {
            notice: q.reason === "invalid" ? "The API token you saved earlier no longer works (revoked or expired). Please paste a new one." : undefined,
        });
    });

    r.post("/auth/enrol", async (req, res) => {
        const body = (req.body ?? {}) as Record<string, string | undefined>;
        const ctx = await signedIn(body.p);
        if (!ctx) {
            res.status(400).type("html").send(errorPage("This page has expired.", EXPIRED_HINT));
            return;
        }
        const {pending, user} = ctx;
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
        res.redirect(302, consentUrl(pending));
    });

    // Consent: the signed-in, enrolled user approves (or not) the client that asked for access,
    // shown by name and redirect URI. Anyone can register a client, and the Infomaniak login
    // only ever asks about the bridge's own app, so this page is the one place a user can tell
    // their own claude.ai from a client someone else registered (MCP spec: proxies with one
    // fixed upstream client id must obtain consent for each dynamically registered client).
    r.get("/auth/consent", async (req, res) => {
        const q = req.query as Record<string, string | undefined>;
        const ctx = await signedIn(q.p);
        if (!ctx) {
            res.status(400).type("html").send(errorPage("This page has expired.", EXPIRED_HINT));
            return;
        }
        const {pending, user} = ctx;
        if (!user.apiTokenEnc) {
            res.redirect(302, enrolUrl(pending));
            return;
        }
        const client = await repo.getClient(pending.clientId);
        if (!client) {
            res.status(400).type("html").send(errorPage("The client's registration has expired.", EXPIRED_HINT));
            return;
        }
        res.type("html").send(consentPage({pendingId: pending.id, email: user.email, clientName: client.client_name ?? client.client_id, redirectUri: pending.redirectUri, services}));
    });

    r.post("/auth/consent", async (req, res) => {
        const body = (req.body ?? {}) as Record<string, string | undefined>;
        const ctx = await signedIn(body.p);
        if (!ctx) {
            res.status(400).type("html").send(errorPage("This page has expired.", EXPIRED_HINT));
            return;
        }
        const {pending, user} = ctx;
        if (!user.apiTokenEnc) {
            res.redirect(302, enrolUrl(pending));
            return;
        }
        if (body.decision !== "allow") {
            await repo.delPending(pending.id);
            console.info(`[auth] user ${user.id} denied client ${pending.clientId}`);
            res.redirect(302, errorRedirect(pending, "access_denied", "The user denied the request"));
            return;
        }
        console.info(`[auth] user ${user.id} allowed client ${pending.clientId}`);
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
