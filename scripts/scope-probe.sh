#!/usr/bin/env bash
# Probe which OAuth scopes login.infomaniak.com accepts for an app.
# Usage: CLIENT_ID=xxx ./scripts/scope-probe.sh [scope ...]
# An invalid scope makes /authorize redirect straight to redirect_uri with
# error=invalid_scope; a valid one redirects to the login page instead.
set -euo pipefail
: "${CLIENT_ID:?set CLIENT_ID}"
REDIRECT="${REDIRECT_URI:-http://localhost:8000/callback}"
scopes=("$@")
if [ ${#scopes[@]} -eq 0 ]; then
  scopes=("" openid profile email user_info workspace:mail workspace:calendar
          mail calendar workspace kmail pim "workspace:mail user_info")
fi
for s in "${scopes[@]}"; do
  enc=$(printf '%s' "$s" | sed 's/ /%20/g')
  sp=""; [ -n "$s" ] && sp="&scope=$enc"
  label="${s:-(no scope param)}"
  loc=$(curl -sI "https://login.infomaniak.com/authorize?response_type=code&access_type=offline&client_id=$CLIENT_ID&redirect_uri=$REDIRECT$sp&state=probe" \
        | awk 'tolower($1)=="location:"{print $2}' | tr -d '\r')
  case "$loc" in
    *error=*) printf '%-28s -> %s\n' "$label" "$(printf '%s' "$loc" | sed -E 's/.*error=([^&]*).*/\1/')";;
    "")       printf '%-28s -> (no redirect: probably 200 login page = accepted)\n' "$label";;
    *)        printf '%-28s -> redirect %s\n' "$label" "$(printf '%s' "$loc" | cut -c1-80)";;
  esac
done
