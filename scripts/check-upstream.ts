// Spawns each enabled official Infomaniak MCP server through the pool (dummy token: they only
// hit the API on the first tool call) and checks tools/list + the argument policy.
// Usage: npm run check:upstream
import {applyPolicy, policyViolation} from "../src/mcp.js";
import {ProcessPool} from "../src/services/pool.js";
import {resolveServices, upstreamVersion} from "../src/services/registry.js";

const names = (process.env.ENABLED_SERVICES ?? "mail,calendar").split(",").map((s) => s.trim()).filter(Boolean);
const pool = new ProcessPool({idleTtlSec: 60, max: 10, version: "check"});
let failed = false;

for (const s of resolveServices(names)) {
    try {
        const entry = await pool.acquire(s, "check", "dummy-token");
        const tools = (await pool.listTools(entry)).map((t) => applyPolicy(s, t));
        const hidden = s.hiddenArgs?.names ?? [];
        const leaked = tools.filter((t) => hidden.some((n) => n in (t.inputSchema.properties ?? {})));
        console.log(`${s.name}  ${s.pkg}@${upstreamVersion(s)}  ${tools.length} tools: ${tools.map((t) => t.name).join(", ")}`);
        if (leaked.length) {
            failed = true;
            console.error(`  POLICY LEAK: ${hidden.join(",")} still visible in ${leaked.map((t) => t.name).join(", ")}`);
        }
        if (s.hiddenArgs) {
            const v = policyViolation(s, {[hidden[0]]: ["/etc/passwd"]});
            console.log(`  policy on call: ${v ?? "NOT ENFORCED"}`);
            if (!v) failed = true;
        }
    } catch (e) {
        failed = true;
        console.error(`${s.name}: FAILED ${e instanceof Error ? e.message : String(e)}`);
    }
}
await pool.closeAll();
process.exit(failed ? 1 : 0);
