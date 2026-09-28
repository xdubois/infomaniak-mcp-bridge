import fs from "node:fs";
import path from "node:path";

/** Minimal .env loader (no dependency): KEY=value lines, '#' comments, optional quotes. Never overrides real env. */
export function loadDotEnv(file = path.resolve(process.cwd(), ".env")): void {
    if (!fs.existsSync(file)) return;
    for (const raw of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
        const line = raw.trim().replace(/^export\s+/, "");
        if (!line || line.startsWith("#")) continue;
        const eq = line.indexOf("=");
        if (eq < 0) continue;
        const key = line.slice(0, eq).trim();
        let value = line.slice(eq + 1).trim();
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
        }
        if (process.env[key] === undefined) process.env[key] = value;
    }
}
