/**
 * Infomaniak OpenID Connect, used for IDENTITY ONLY.
 *
 * Probed 2026-09-28 (see NOTES.md): Manager-created OAuth apps can request just
 * `openid profile email phone`; every API scope is rejected with invalid_scope.
 * So we log the user in here and ask them for an API token separately.
 */
const AUTHORIZE_URL = "https://login.infomaniak.com/authorize";
const TOKEN_URL = "https://login.infomaniak.com/token";
const USERINFO_URL = "https://login.infomaniak.com/oauth2/userinfo";
/** Outbound HTTP budget: a hang guard, not a tuning knob. */
const FETCH_TIMEOUT_MS = 10_000;

export interface Identity {
    /** Infomaniak user id, as a string. */
    userId: string;
    email?: string;
}

export class InfomaniakOidc {
    constructor(
        private readonly clientId: string,
        private readonly clientSecret: string,
        private readonly redirectUri: string,
    ) {}

    authorizeUrl(opts: {state: string; codeChallenge: string}): string {
        const u = new URL(AUTHORIZE_URL);
        u.searchParams.set("response_type", "code");
        u.searchParams.set("client_id", this.clientId);
        u.searchParams.set("redirect_uri", this.redirectUri);
        u.searchParams.set("scope", "openid email");
        u.searchParams.set("state", opts.state);
        u.searchParams.set("code_challenge", opts.codeChallenge);
        u.searchParams.set("code_challenge_method", "S256");
        return u.href;
    }

    async exchangeCode(code: string, codeVerifier: string): Promise<Identity> {
        const res = await fetch(TOKEN_URL, {
            method: "POST",
            headers: {"Content-Type": "application/x-www-form-urlencoded", Accept: "application/json"},
            body: new URLSearchParams({
                grant_type: "authorization_code",
                client_id: this.clientId,
                client_secret: this.clientSecret,
                redirect_uri: this.redirectUri,
                code,
                code_verifier: codeVerifier,
            }),
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
        if (!res.ok) {
            throw new Error(`Infomaniak token endpoint HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
        }
        const tok = (await res.json()) as {access_token: string; user_id?: string | number};

        let email: string | undefined;
        let sub: string | undefined;
        try {
            const ui = await fetch(USERINFO_URL, {
                headers: {Authorization: `Bearer ${tok.access_token}`, Accept: "application/json"},
                signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
            });
            if (ui.ok) {
                const info = (await ui.json()) as {sub?: string | number; email?: string};
                email = info.email;
                sub = info.sub != null ? String(info.sub) : undefined;
            }
        } catch {
            /* identity still usable via user_id */
        }
        const userId = tok.user_id != null ? String(tok.user_id) : sub;
        if (!userId) throw new Error("Infomaniak did not return a user id");
        return {userId, email};
    }
}
