#!/usr/bin/env python3
"""End-to-end smoke test acting as a remote MCP client (what claude.ai does):

discovery -> dynamic client registration -> /authorize (browser: Infomaniak login
+ API-token enrolment on first run + consent) -> code -> /token -> MCP initialize,
tools/list, one tools/call -> refresh-token rotation.

Usage: BRIDGE_URL=http://localhost:3000 python3 scripts/smoke.py [tool_name]
"""
import base64, hashlib, json, os, secrets, sys, urllib.error, urllib.parse, urllib.request
from http.server import BaseHTTPRequestHandler, HTTPServer

BRIDGE = os.environ.get("BRIDGE_URL", "http://localhost:3000").rstrip("/")
REDIRECT = "http://localhost:8000/callback"
TOOL = sys.argv[1] if len(sys.argv) > 1 else "calendar_list_calendars"
MCP = f"{BRIDGE}/mcp"


def http(method, url, body=None, headers=None, form=False):
    headers = {"Accept": "application/json", **(headers or {})}
    data = None
    if body is not None:
        if form:
            data = urllib.parse.urlencode(body).encode()
            headers["Content-Type"] = "application/x-www-form-urlencoded"
        else:
            data = json.dumps(body).encode()
            headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            raw = r.read()
            return r.status, dict(r.headers), (json.loads(raw) if raw else None)
    except urllib.error.HTTPError as e:
        raw = e.read()
        try:
            return e.code, dict(e.headers), json.loads(raw)
        except Exception:
            return e.code, dict(e.headers), raw.decode(errors="replace")[:300]


def step(label, ok, detail=""):
    print(f"{'OK ' if ok else 'FAIL'} {label}" + (f"  {detail}" if detail else ""))
    if not ok:
        sys.exit(1)


# 1. discovery
st, _, meta = http("GET", f"{BRIDGE}/.well-known/oauth-authorization-server")
step("authorization server metadata", st == 200 and "authorization_endpoint" in meta, meta.get("issuer") if st == 200 else meta)
st, _, prm = http("GET", f"{BRIDGE}/.well-known/oauth-protected-resource/mcp")
step("protected resource metadata", st == 200 and prm.get("resource", "").endswith("/mcp"), prm.get("resource") if st == 200 else prm)

# 2. unauthenticated MCP call must 401 and point at the metadata
st, hdrs, _ = http("POST", MCP, {"jsonrpc": "2.0", "id": 0, "method": "ping"})
step("unauthenticated /mcp -> 401 + WWW-Authenticate", st == 401 and "resource_metadata" in hdrs.get("WWW-Authenticate", ""), hdrs.get("WWW-Authenticate", "")[:90])

# 3. dynamic client registration
st, _, client = http("POST", meta["registration_endpoint"], {
    "redirect_uris": [REDIRECT], "client_name": "bridge smoke test",
    "grant_types": ["authorization_code", "refresh_token"], "response_types": ["code"],
    "token_endpoint_auth_method": "none",
})
step("dynamic client registration", st in (200, 201) and "client_id" in client, str(client)[:120] if st not in (200, 201) else client["client_id"])

# 4. authorize in the browser
verifier = secrets.token_urlsafe(64)
challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
state = secrets.token_urlsafe(16)
url = meta["authorization_endpoint"] + "?" + urllib.parse.urlencode({
    "response_type": "code", "client_id": client["client_id"], "redirect_uri": REDIRECT,
    "code_challenge": challenge, "code_challenge_method": "S256", "state": state, "resource": MCP,
})
# A short local link redirects to the long authorize URL, so nothing gets mangled by copy/paste.
START = "http://localhost:8000/start"
print(f"\nOpen {START} in your browser, sign in with Infomaniak (and paste an API token on first run).\n", flush=True)

cb = {}
class H(BaseHTTPRequestHandler):
    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        if u.path == "/start":
            self.send_response(302); self.send_header("Location", url); self.end_headers(); return
        if u.path != "/callback":
            self.send_response(404); self.end_headers(); return
        cb.update(dict(urllib.parse.parse_qsl(u.query)))
        self.send_response(200); self.send_header("Content-Type", "text/plain"); self.end_headers()
        self.wfile.write(b"ok, back to the terminal")
    def log_message(self, *a): pass
with HTTPServer(("127.0.0.1", 8000), H) as srv:
    try:
        import webbrowser
        webbrowser.open(START)  # best effort; the printed link works too
    except Exception:
        pass
    while not cb:
        srv.handle_request()
step("authorization callback", "code" in cb and cb.get("state") == state, {k: v for k, v in cb.items() if k != "code"})

# 5. token
st, _, tok = http("POST", meta["token_endpoint"], {
    "grant_type": "authorization_code", "code": cb["code"], "redirect_uri": REDIRECT,
    "client_id": client["client_id"], "code_verifier": verifier, "resource": MCP,
}, form=True)
step("code -> tokens", st == 200 and "access_token" in tok, f"expires_in={tok.get('expires_in')} refresh={'yes' if tok.get('refresh_token') else 'no'}" if st == 200 else tok)


def mcp(access, method, params, rid):
    return http("POST", MCP, {"jsonrpc": "2.0", "id": rid, "method": method, "params": params},
                headers={"Authorization": f"Bearer {access}", "Accept": "application/json, text/event-stream"})

# 6. MCP
st, _, r = mcp(tok["access_token"], "initialize", {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "smoke", "version": "0"}}, 1)
step("initialize", st == 200 and "result" in r, r.get("result", {}).get("serverInfo") if st == 200 else r)
st, _, r = mcp(tok["access_token"], "tools/list", {}, 2)
tools = [t["name"] for t in r.get("result", {}).get("tools", [])] if st == 200 else []
step("tools/list", st == 200 and tools, f"{len(tools)} tools: {', '.join(tools[:6])}{' ...' if len(tools) > 6 else ''}")
st, _, r = mcp(tok["access_token"], "tools/call", {"name": TOOL, "arguments": {}}, 3)
content = r.get("result", {}).get("content", []) if st == 200 else []
text = next((c.get("text", "") for c in content if c.get("type") == "text"), "")
step(f"tools/call {TOOL}", st == 200 and "result" in r and not r["result"].get("isError"), text[:200].replace("\n", " ") or str(r)[:200])

# 7. refresh rotation
st, _, tok2 = http("POST", meta["token_endpoint"], {"grant_type": "refresh_token", "refresh_token": tok["refresh_token"], "client_id": client["client_id"]}, form=True)
step("refresh -> new tokens", st == 200 and tok2.get("access_token") not in (None, tok["access_token"]), "" if st == 200 else tok2)
st, _, _ = mcp(tok["access_token"], "tools/list", {}, 4)
step("old access token revoked", st == 401)
st, _, r = mcp(tok2["access_token"], "tools/list", {}, 5)
step("new access token works", st == 200 and "result" in r)
print("\nall good")
