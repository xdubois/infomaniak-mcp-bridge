const API_BASE = "https://api.infomaniak.com";

export class InfomaniakApiError extends Error {
    constructor(
        public readonly status: number,
        public readonly code: string,
        message: string,
        public readonly scopes?: string[],
    ) {
        super(message);
        this.name = "InfomaniakApiError";
    }
}

export interface Profile {
    id: number | string;
    email?: string;
    display_name?: string;
}

interface Envelope<T> {
    result?: string;
    data?: T;
    error?: {code?: string; description?: string; context?: {scopes?: string[]}};
}

/**
 * Authenticated GET on an Infomaniak API (path on api.infomaniak.com, or a full URL for the
 * product hosts such as mail.infomaniak.com); throws InfomaniakApiError with Infomaniak's own code/description.
 */
export async function apiGet<T = unknown>(pathOrUrl: string, apiToken: string): Promise<T> {
    const url = /^https?:\/\//.test(pathOrUrl) ? pathOrUrl : `${API_BASE}${pathOrUrl}`;
    const res = await fetch(url, {
        headers: {Authorization: `Bearer ${apiToken}`, Accept: "application/json"},
    });
    const body = (await res.json().catch(() => ({}))) as Envelope<T>;
    if (!res.ok || body.result !== "success" || body.data === undefined) {
        const err = body.error ?? {};
        throw new InfomaniakApiError(res.status, err.code ?? "http_error", err.description ?? `HTTP ${res.status}`, err.context?.scopes);
    }
    return body.data;
}

/**
 * Authenticated GET used as a scope probe: any 2xx passes. Errors carry Infomaniak's envelope
 * description when there is one (that names the missing scope), else the JSON `message` of
 * plain APIs such as kChat, else the HTTP status.
 */
export async function apiProbe(url: string, apiToken: string): Promise<void> {
    const res = await fetch(url, {headers: {Authorization: `Bearer ${apiToken}`, Accept: "application/json"}});
    const body = (await res.json().catch(() => ({}))) as Envelope<unknown> & {message?: string};
    if (res.ok && body.result !== "error") return;
    const err = body.error ?? {};
    throw new InfomaniakApiError(res.status, err.code ?? "http_error", err.description ?? body.message ?? `HTTP ${res.status}`, err.context?.scopes);
}

/** GET /2/profile — needs the `user_info` scope; doubles as "is this API token valid, and whose is it". */
export const fetchProfile = (apiToken: string): Promise<Profile> => apiGet<Profile>("/2/profile", apiToken);

export const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));
