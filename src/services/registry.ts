import {createRequire} from "node:module";
import path from "node:path";
import {apiProbe} from "../infomaniak/api.js";

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
    /**
     * Deployment-level settings the package also reads from its environment (e.g. the kChat team,
     * the kDrive id). Copied from the bridge's own environment into the child's; must be set when
     * the service is enabled. One value per deployment, i.e. one team / one drive for all users.
     */
    requiredEnv?: string[];
    /**
     * Cheap authenticated GET (full URL, `${VAR}` placeholders from requiredEnv) that fails without
     * this service's scope; run at enrolment. Any 2xx counts, so it works for Infomaniak's
     * `{result, data}` envelope and for kChat's plain (Mattermost-style) JSON alike.
     */
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

const contact: Service = {
    name: "contact",
    title: "Contacts",
    scopes: ["contacts"],
    pkg: "@infomaniak/mcp-server-contact",
    tokenEnv: "CONTACT_TOKEN",
    probeUrl: "https://contacts.infomaniak.com/api/pim/contact/all",
};

const kchat: Service = {
    name: "kchat",
    title: "kChat",
    scopes: ["kchat"],
    pkg: "@infomaniak/mcp-server-kchat",
    tokenEnv: "KCHAT_TOKEN",
    // The team is the subdomain of your kChat URL (https://<team>.kchat.infomaniak.com/...).
    requiredEnv: ["KCHAT_TEAM_NAME"],
    probeUrl: "https://${KCHAT_TEAM_NAME}.kchat.infomaniak.com/api/v4/teams/name/${KCHAT_TEAM_NAME}",
};

const kdrive: Service = {
    name: "kdrive",
    title: "kDrive",
    scopes: ["drive"],
    pkg: "@infomaniak/mcp-server-kdrive",
    tokenEnv: "KDRIVE_TOKEN",
    // The drive id is in the kDrive web app URL (https://ksuite.infomaniak.com/all/kdrive/app/drive/<id>).
    requiredEnv: ["KDRIVE_ID"],
    // File id 1 is the drive's root directory.
    probeUrl: "https://api.infomaniak.com/3/drive/${KDRIVE_ID}/files/1",
};

export const ALL_SERVICES: Readonly<Record<string, Service>> = {mail, calendar, contact, kchat, kdrive};

/** Enabled services, checked against the environment for the settings they need. */
export function resolveServices(names: string[], env: NodeJS.ProcessEnv = process.env): Service[] {
    const unknown = names.filter((n) => !(n in ALL_SERVICES));
    if (unknown.length) {
        throw new Error(`Unknown ENABLED_SERVICES: ${unknown.join(", ")} (known: ${Object.keys(ALL_SERVICES).join(", ")})`);
    }
    if (!names.length) throw new Error("ENABLED_SERVICES must name at least one service");
    const services = names.map((n) => ALL_SERVICES[n]);
    for (const s of services) {
        const missing = (s.requiredEnv ?? []).filter((v) => !env[v]);
        if (missing.length) throw new Error(`Service "${s.name}" needs ${missing.join(", ")} in the environment`);
    }
    return services;
}

/** The service's deployment-level settings (requiredEnv), read from the given environment. */
export function serviceEnv(service: Service, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
    return Object.fromEntries((service.requiredEnv ?? []).map((v) => [v, env[v] ?? ""]));
}

/** Scopes an enrolled API token needs: user_info (identity check) + every enabled service's scopes. */
export function requiredScopes(services: Service[]): string[] {
    return ["user_info", ...new Set(services.flatMap((s) => s.scopes))];
}

/** Throws (with Infomaniak's own error text, e.g. the missing scope) if the token can't use this service. */
export async function probeService(service: Service, apiToken: string, env: NodeJS.ProcessEnv = process.env): Promise<void> {
    const values = serviceEnv(service, env);
    const url = service.probeUrl.replace(/\$\{([A-Z0-9_]+)\}/g, (_m, name: string) => encodeURIComponent(values[name] ?? ""));
    await apiProbe(url, apiToken);
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
