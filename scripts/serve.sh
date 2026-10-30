#!/bin/sh
# Start Snitch and a named Cloudflare tunnel in one WSL Alpine shell.
set -eu
cd "$(dirname "$0")/.."

app_pid=
tunnel_pid=

cleanup() {
  if [ -n "$tunnel_pid" ] && kill -0 "$tunnel_pid" 2>/dev/null; then
    kill "$tunnel_pid" 2>/dev/null || true
  fi
  if [ -n "$app_pid" ] && kill -0 "$app_pid" 2>/dev/null; then
    kill "$app_pid" 2>/dev/null || true
  fi
  wait 2>/dev/null || true
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# Shell variables already set win, matching dotenv. Does not export the value.
# cloudflared treats an exported TUNNEL_ID as a connector instance id, not the
# tunnel UUID, so callers must keep the result in a normal shell variable.
read_env() {
  key=$1
  current=
  case $key in
    PORT) current=${PORT:-} ;;
    TUNNEL_ID) current=${TUNNEL_ID:-} ;;
    TUNNEL_TOKEN) current=${TUNNEL_TOKEN:-} ;;
  esac
  if [ -n "$current" ]; then
    printf '%s' "$current"
    return 0
  fi
  line=$(grep -E "^[[:space:]]*${key}=" .env | tail -n 1 || true)
  if [ -z "$line" ]; then
    return 0
  fi
  value=${line#*=}
  value=${value%%#*}
  value=$(printf '%s' "$value" | tr -d ' \t\r"'"'"'')
  printf '%s' "$value"
}

if ! command -v node >/dev/null 2>&1; then
  echo "node is not installed. On Alpine: apk add nodejs npm" >&2
  exit 1
fi
if ! command -v cloudflared >/dev/null 2>&1; then
  echo "cloudflared is not installed. See README.md, Run it locally." >&2
  exit 1
fi
if [ ! -f .env ]; then
  echo "Missing .env. Run: cp .env.example .env" >&2
  exit 1
fi
if [ ! -d node_modules ]; then
  npm install
fi

port=$(read_env PORT)
if [ -z "$port" ]; then
  port=8000
fi

tunnel_id=$(read_env TUNNEL_ID)
tunnel_token=$(read_env TUNNEL_TOKEN)
if [ -z "$tunnel_id" ] || [ -z "$tunnel_token" ]; then
  echo "Set TUNNEL_ID and TUNNEL_TOKEN in .env." >&2
  echo "TUNNEL_ID is the tunnel UUID. TUNNEL_TOKEN is the long token from the tunnel install command." >&2
  exit 1
fi
if ! printf '%s' "$tunnel_id" | grep -Eq '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'; then
  echo "TUNNEL_ID must be the tunnel UUID from the Cloudflare tunnel page." >&2
  exit 1
fi

# A tunnel token is base64 JSON: {"a":account,"t":tunnel id,"s":secret}.
# When a token is set, cloudflared ignores the tunnel argument and uses the id inside the token.
token_tunnel_id=$(printf '%s' "$tunnel_token" | tr -d '[:space:]' | base64 -d 2>/dev/null | sed -n 's/.*"t"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' || true)
if [ -z "$token_tunnel_id" ]; then
  echo "TUNNEL_TOKEN is not a Cloudflare tunnel token. Paste the long token from the tunnel install command, not the UUID." >&2
  exit 1
fi
id_lc=$(printf '%s' "$tunnel_id" | tr 'A-F' 'a-f')
token_id_lc=$(printf '%s' "$token_tunnel_id" | tr 'A-F' 'a-f')
if [ "$id_lc" != "$token_id_lc" ]; then
  echo "TUNNEL_TOKEN is for tunnel ${token_tunnel_id}, but TUNNEL_ID is ${tunnel_id}." >&2
  exit 1
fi

# Cloudflare is a reverse proxy. Trust its visitor address unless .env
# or the shell already chose a TRUST_PROXY value. dotenv does not
# override variables that are already set.
if [ -z "${TRUST_PROXY:-}" ]; then
  if ! grep -qE '^[[:space:]]*TRUST_PROXY=' .env; then
    export TRUST_PROXY=1
  fi
fi

node server.js &
app_pid=$!

echo "Waiting for Snitch on http://127.0.0.1:${port}"
i=0
ready=0
while [ "$i" -lt 60 ]; do
  if ! kill -0 "$app_pid" 2>/dev/null; then
    echo "Snitch exited before the tunnel started." >&2
    exit 1
  fi
  if wget -q -O /dev/null -T 2 "http://127.0.0.1:${port}/health" 2>/dev/null; then
    ready=1
    break
  fi
  i=$((i + 1))
  sleep 1
done

if [ "$ready" -ne 1 ]; then
  echo "Snitch did not answer /health on port ${port}." >&2
  exit 1
fi

echo "Tunneling http://127.0.0.1:${port} through tunnel ${tunnel_id}"
echo "Ctrl-C stops the app and the tunnel."
# Pass the token in the environment so it is not on the process command line.
# Drop TUNNEL_ID so cloudflared does not read the tunnel UUID as its connector id.
env -u TUNNEL_ID TUNNEL_TOKEN="$tunnel_token" \
  cloudflared tunnel run --url "http://127.0.0.1:${port}" "$tunnel_id" &
tunnel_pid=$!
status=0
wait "$tunnel_pid" || status=$?
exit "$status"
