import {createRequire} from "node:module";
import path from "node:path";
import {apiGet} from "../infomaniak/api.js";

/**
 * One Infomaniak product exposed by the bridge, backed by Infomaniak's OFFICIAL MCP server
 * package, run unmodified as a child process with the user's API token in its environment.
 * Enabled per deployment via ENABLED_SERVICES; adding a product = one entry here.
 */
export interface Service {
    name: string;
    title: string;
    /** Infomaniak API-token scopes the user's token must carry for this service. */
    scopes: string[];
    /** npm package of the official stdio MCP server (its `bin` is what we spawn). */
    pkg: string;
    /** Environment variable that package reads its API token from. */
    tokenEnv: string;
    /** Cheap authenticated GET (full URL) that fails without this service's scope (used at enrolment). */
    probeUrl: string;
    /**
     * Proxy policy: tool input arguments hidden from tools/list and rejected on tools/call.
     * Lets us neutralise upstream features that don't make sense on a shared host without
     * patching the upstream code.
     */
    hiddenArgs?: {names: string[]; reason: string};
}

const mail: Service = {
    name: "mail",
    title: "Mail (kMail)",
    scopes: ["workspace:mail"],
    pkg: "@infomaniak/mcp-server-mail",
    tokenEnv: "MAIL_TOKEN",
    // The official mail server uses the kMail API host, not api.infomaniak.com.
    probeUrl: "https://mail.infomaniak.com/api/mailbox",
    // Upstream's `attachments` are LOCAL FILE PATHS read by the server process. On the bridge
    // that process runs on our host, so every user could mail themselves our files.
    hiddenArgs: {names: ["attachments"], reason: "Attaching files by local path is not available on the hosted bridge"},
};

const calendar: Service = {
    name: "calendar",
    title: "Calendar",
    scopes: ["workspace:calendar"],
    pkg: "@infomaniak/mcp-server-calendar",
    tokenEnv: "CALENDAR_TOKEN",
    probeUrl: "https://api.infomaniak.com/1/calendar/pim/calendar",
};

export const ALL_SERVICES: Readonly<Record<string, Service>> = {mail, calendar};

export function resolveServices(names: string[]): Service[] {
    const unknown = names.filter((n) => !(n in ALL_SERVICES));
    if (unknown.length) {
        throw new Error(`Unknown ENABLED_SERVICES: ${unknown.join(", ")} (known: ${Object.keys(ALL_SERVICES).join(", ")})`);
    }
    if (!names.length) throw new Error("ENABLED_SERVICES must name at least one service");
    return names.map((n) => ALL_SERVICES[n]);
}

/** Scopes an enrolled API token needs: user_info (identity check) + every enabled service's scopes. */
export function requiredScopes(services: Service[]): string[] {
    return ["user_info", ...new Set(services.flatMap((s) => s.scopes))];
}

/** Throws (with Infomaniak's own error text, e.g. the missing scope) if the token can't use this service. */
export async function probeService(service: Service, apiToken: string): Promise<void> {
    await apiGet(service.probeUrl, apiToken);
}

const require = createRequire(import.meta.url);

/** Absolute path of the official server's executable, from the installed package's `bin`. */
export function serverEntrypoint(service: Service): string {
    const pkgJsonPath = require.resolve(`${service.pkg}/package.json`);
    const pkg = require(pkgJsonPath) as {bin?: string | Record<string, string>; version: string};
    const bin = typeof pkg.bin === "string" ? pkg.bin : Object.values(pkg.bin ?? {})[0];
    if (!bin) throw new Error(`${service.pkg} has no bin entry`);
    return path.resolve(path.dirname(pkgJsonPath), bin);
}

export function upstreamVersion(service: Service): string {
    return (require(`${service.pkg}/package.json`) as {version: string}).version;
}
