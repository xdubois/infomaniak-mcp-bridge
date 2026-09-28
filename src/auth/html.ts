import type {Service} from "../services/registry.js";

export const MANAGER_TOKENS_URL = "https://manager.infomaniak.com/v3/ng/accounts/token/list";

const esc = (s: string) =>
    s.replace(/[&<>"']/g, (c) => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"})[c] as string);

export function page(title: string, body: string): string {
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>
:root{color-scheme:light dark;--fg:#1a1a1a;--bg:#fff;--muted:#666;--accent:#0098ff;--border:#ddd;--err:#b00020;--errbg:#fdecee;--okbg:#eef7ee}
@media (prefers-color-scheme:dark){:root{--fg:#eee;--bg:#161616;--muted:#aaa;--border:#333;--errbg:#3a1a1e;--okbg:#1c2e1c}}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
main{max-width:620px;margin:6vh auto;padding:0 16px}
h1{font-size:1.5rem;margin:0 0 .5rem}p{margin:.5rem 0}.muted{color:var(--muted)}
ol{padding-left:1.3rem}li{margin:.35rem 0}code{background:rgba(127,127,127,.15);padding:.1em .35em;border-radius:4px}
label{display:block;font-weight:600;margin-top:1.2rem}
input[type=text]{width:100%;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;box-sizing:border-box;font:inherit;padding:.6rem;border:1px solid var(--border);border-radius:6px;background:transparent;color:inherit}
button{margin-top:1rem;font:inherit;font-weight:600;padding:.65rem 1.2rem;border:0;border-radius:6px;background:var(--accent);color:#fff;cursor:pointer}
.err{background:var(--errbg);border-left:4px solid var(--err);padding:.6rem .9rem;border-radius:4px;margin:1rem 0}
.notice{background:var(--okbg);padding:.6rem .9rem;border-radius:4px;margin:1rem 0}
</style></head><body><main>${body}</main></body></html>`;
}

export function errorPage(message: string, hint?: string): string {
    return page("Infomaniak MCP Bridge", `<h1>Something went wrong</h1><p class="err">${esc(message)}</p>${hint ? `<p class="muted">${esc(hint)}</p>` : ""}`);
}

export function enrolPage(opts: {
    pendingId: string;
    email?: string;
    services: Service[];
    scopes: string[];
    error?: string;
    notice?: string;
}): string {
    const scopeList = opts.scopes.map((s) => `<code>${esc(s)}</code>`).join(", ");
    const serviceList = opts.services.map((s) => esc(s.title)).join(" and ");
    return page(
        "Connect your Infomaniak API token",
        `<h1>One more step</h1>
<p>You're signed in${opts.email ? ` as <strong>${esc(opts.email)}</strong>` : ""}. Infomaniak's login only proves who you are;
to let Claude use your ${serviceList}, the bridge needs an Infomaniak <strong>API token</strong> created by you.</p>
${opts.notice ? `<p class="notice">${esc(opts.notice)}</p>` : ""}
${opts.error ? `<p class="err">${esc(opts.error)}</p>` : ""}
<ol>
<li>Open <a href="${MANAGER_TOKENS_URL}" target="_blank" rel="noopener">Manager &rsaquo; API tokens</a> and create a token.</li>
<li>Give it exactly these scopes: ${scopeList}.</li>
<li>Pick a validity you're comfortable with, then paste the token below. It is stored encrypted and only ever sent to Infomaniak's own APIs.</li>
</ol>
<form method="post" action="/auth/enrol" autocomplete="off">
<input type="hidden" name="p" value="${esc(opts.pendingId)}">
<label for="token">Infomaniak API token</label>
<input id="token" type="text" name="token" required spellcheck="false" autocapitalize="off" autocomplete="off" data-1p-ignore data-lpignore="true" data-bwignore placeholder="paste the token you just created">
<button type="submit">Save and continue to Claude</button>
</form>
<p class="muted">You can revoke this token any time in the Manager; the bridge then stops working until you connect again.</p>`,
    );
}

export function forgottenPage(opts: {email?: string; hadToken: boolean}): string {
    const who = opts.email ? ` for <strong>${esc(opts.email)}</strong>` : "";
    return page(
        "Infomaniak MCP Bridge",
        `<h1>${opts.hadToken ? "Token forgotten" : "Nothing to forget"}</h1>
<p>${opts.hadToken ? `The bridge no longer holds an API token${who}. Connected clients (claude.ai, Claude Code, …) will ask you to reconnect and to paste a token again.` : `The bridge held no API token${who}.`}</p>
<p>The token itself still exists at Infomaniak until you revoke it there: <a href="${MANAGER_TOKENS_URL}" target="_blank" rel="noopener">Manager &rsaquo; API tokens</a>.</p>`,
    );
}

export function landingPage(opts: {mcpUrl: string; services: Service[]}): string {
    return page(
        "Infomaniak MCP Bridge",
        `<h1>Infomaniak MCP Bridge</h1>
<p>Exposes your Infomaniak ${opts.services.map((s) => esc(s.title)).join(" and ")} as MCP tools for claude.ai (and any remote-MCP client).</p>
<p><strong>MCP endpoint:</strong> <code>${esc(opts.mcpUrl)}</code></p>
<ol>
<li>In claude.ai, open <em>Settings &rsaquo; Connectors &rsaquo; Add custom connector</em> and paste the endpoint URL above. Leave the OAuth client fields empty: the bridge supports dynamic registration.</li>
<li>Click <em>Connect</em>: you'll sign in with your Infomaniak account, then paste an Infomaniak API token once.</li>
</ol>
<p class="muted">Your API token is stored encrypted and is only sent to Infomaniak's own APIs.
Want the bridge to forget it? <a href="/auth/forget">Sign in with Infomaniak and delete it</a>; revoke the token itself in the Manager.</p>`,
    );
}
