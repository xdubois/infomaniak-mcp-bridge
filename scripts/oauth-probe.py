#!/usr/bin/env python3
"""One-shot OAuth probe against login.infomaniak.com.

Reads INFOMANIAK_CLIENT_ID / INFOMANIAK_CLIENT_SECRET from .env, starts a
listener on the registered redirect URI (http://localhost:8000/callback),
prints the authorize URL, waits for the browser callback, exchanges the code,
then calls the profile and calendar APIs with the access token.

Answers the design question: does an OAuth-app token (no scope param,
access_type=offline) work against api.infomaniak.com, and is there a
refresh_token? Saves the token response to .token.json (git-ignored).
"""
import base64, hashlib, json, os, secrets, sys, urllib.parse, urllib.request
from http.server import BaseHTTPRequestHandler, HTTPServer

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
for line in open(os.path.join(ROOT, ".env")):
    line = line.strip()
    if line and not line.startswith("#") and "=" in line:
        k, v = line.split("=", 1)
        os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))

CLIENT_ID = os.environ["INFOMANIAK_CLIENT_ID"]
CLIENT_SECRET = os.environ["INFOMANIAK_CLIENT_SECRET"]
REDIRECT = os.environ.get("REDIRECT_URI", "http://localhost:8000/callback")
SCOPE = os.environ.get("SCOPE")  # unset by default: Infomaniak apps send none
AUTH = "https://login.infomaniak.com/authorize"
TOKEN = "https://login.infomaniak.com/token"

verifier = secrets.token_urlsafe(64)
challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
state = secrets.token_urlsafe(16)
params = {
    "response_type": "code", "client_id": CLIENT_ID, "redirect_uri": REDIRECT,
    "access_type": "offline", "state": state,
    "code_challenge": challenge, "code_challenge_method": "S256",
}
if SCOPE:
    params["scope"] = SCOPE
print("\nOpen this URL in your browser and log in:\n")
print(AUTH + "?" + urllib.parse.urlencode(params), "\n", flush=True)

result = {}

class H(BaseHTTPRequestHandler):
    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        if u.path != urllib.parse.urlparse(REDIRECT).path:
            self.send_response(404); self.end_headers(); return
        q = dict(urllib.parse.parse_qsl(u.query))
        result.update(q)
        self.send_response(200); self.send_header("Content-Type", "text/plain"); self.end_headers()
        self.wfile.write(b"ok, back to the terminal")
    def log_message(self, *a): pass

port = urllib.parse.urlparse(REDIRECT).port or 80
with HTTPServer(("127.0.0.1", port), H) as srv:
    srv.handle_request()

print("callback params:", {k: (v[:12] + "..." if k == "code" else v) for k, v in result.items()})
if "error" in result:
    sys.exit(f"authorize failed: {result}")
if result.get("state") != state:
    sys.exit("state mismatch")

def post(url, data):
    req = urllib.request.Request(url, data=urllib.parse.urlencode(data).encode(),
                                 headers={"Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}")

status, tok = post(TOKEN, {
    "grant_type": "authorization_code", "client_id": CLIENT_ID, "client_secret": CLIENT_SECRET,
    "redirect_uri": REDIRECT, "code": result["code"], "code_verifier": verifier,
})
print(f"\ntoken endpoint -> HTTP {status}")
redacted = {k: (v[:8] + "..." if isinstance(v, str) and "token" in k else v) for k, v in tok.items()}
print(json.dumps(redacted, indent=2))
if status != 200:
    sys.exit(1)
json.dump(tok, open(os.path.join(ROOT, ".token.json"), "w"))

def get(url, token):
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}", "Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}")

at = tok["access_token"]
for label, url in [
    ("profile", "https://api.infomaniak.com/2/profile"),
    ("calendars", "https://api.infomaniak.com/1/calendar/pim/calendar"),
    ("mailboxes", "https://api.infomaniak.com/1/mail_hostings"),
]:
    st, body = get(url, at)
    summary = body
    if isinstance(body, dict) and body.get("result") == "success":
        data = body.get("data")
        if isinstance(data, list):
            summary = f"{len(data)} items; first: " + json.dumps(data[0], ensure_ascii=False)[:300] if data else "0 items"
        elif isinstance(data, dict):
            summary = {k: data[k] for k in list(data)[:8]}
    print(f"\n{label}: HTTP {st}\n  {json.dumps(summary, ensure_ascii=False, default=str)[:600]}")
