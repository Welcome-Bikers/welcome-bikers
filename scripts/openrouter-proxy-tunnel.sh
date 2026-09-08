#!/usr/bin/env bash
# Start or hold the GitHub-runner Cloudflare quick tunnel used by Real Bro discovery.
set -euo pipefail

TUNNEL_BIN="${TUNNEL_BIN:-/tmp/cloudflared}"
TUNNEL_LOG="${TUNNEL_LOG:-/tmp/tunnel.log}"
TUNNEL_PID_FILE="${TUNNEL_PID_FILE:-/tmp/tunnel.pid}"
PROXY_URL_FILE="${PROXY_URL_FILE:-/tmp/proxy-url.txt}"
PROXY_LOG="${PROXY_LOG:-/tmp/proxy.log}"
LOCAL_HEALTH="${LOCAL_HEALTH:-http://127.0.0.1:8787/health}"

start_tunnel() {
  if [ -f "$TUNNEL_PID_FILE" ]; then
    kill "$(cat "$TUNNEL_PID_FILE")" 2>/dev/null || true
    sleep 2
  fi
  : > "$TUNNEL_LOG"
  "$TUNNEL_BIN" tunnel --no-autoupdate --protocol http2 --url http://127.0.0.1:8787 > "$TUNNEL_LOG" 2>&1 &
  echo "$!" > "$TUNNEL_PID_FILE"
}

extract_url() {
  grep -oE 'https://[a-zA-Z0-9.-]+\.trycloudflare\.com' "$TUNNEL_LOG" | head -n1 || true
}

wait_for_url() {
  local i url
  for i in $(seq 1 90); do
    if ! kill -0 "$(cat "$TUNNEL_PID_FILE")" 2>/dev/null; then
      echo "cloudflared exited before publishing a URL" >&2
      cat "$TUNNEL_LOG" >&2 || true
      return 1
    fi
    url="$(extract_url)"
    if [ -n "$url" ]; then
      printf '%s\n' "$url"
      return 0
    fi
    sleep 1
  done
  echo "Tunnel URL not found" >&2
  cat "$TUNNEL_LOG" >&2 || true
  return 1
}

public_health() {
  local base="$1"
  # Quick tunnels often publish a hostname before DNS/IPv6 is usable.
  curl -4 --max-time 20 -fsS "${base}/health" >/dev/null
}

wait_for_public_health() {
  local base="$1" i
  for i in $(seq 1 36); do
    if public_health "$base"; then
      return 0
    fi
    echo "waiting for public /health (${i}/36): ${base}"
    sleep 5
  done
  return 1
}

publish_discovery() {
  local proxy_url="$1"
  if [ -z "${GH_TOKEN:-}" ] || [ -z "${GITHUB_REPOSITORY:-}" ]; then
    echo "GH_TOKEN and GITHUB_REPOSITORY are required to publish discovery" >&2
    return 1
  fi
  echo "$proxy_url" > "$PROXY_URL_FILE"
  local body
  body="$(printf '{"base":"%s","updatedAt":"%s"}' "$proxy_url" "$(date -u +%Y-%m-%dT%H:%M:%SZ)")"
  rm -rf /tmp/disc-repo
  mkdir -p /tmp/disc-repo/public
  printf '%s\n' "$body" > /tmp/disc-repo/public/or-proxy.json
  git -C /tmp/disc-repo init
  git -C /tmp/disc-repo checkout -b proxy-url
  git -C /tmp/disc-repo add public/or-proxy.json
  git -C /tmp/disc-repo -c user.name="Welcome-Bikers" -c user.email="321496092+Welcome-Bikers@users.noreply.github.com" \
    commit -m "Refresh Real Bro proxy endpoint."
  git -C /tmp/disc-repo remote add origin "https://x-access-token:${GH_TOKEN}@github.com/${GITHUB_REPOSITORY}.git"
  git -C /tmp/disc-repo push -f origin proxy-url
  echo "Published discovery → https://raw.githubusercontent.com/${GITHUB_REPOSITORY}/proxy-url/public/or-proxy.json"
}

bring_up() {
  local attempt url
  for attempt in 1 2 3; do
    echo "Starting Cloudflare quick tunnel (attempt ${attempt}/3)"
    start_tunnel
    url="$(wait_for_url)" || continue
    echo "PROXY_URL=$url"
    if wait_for_public_health "$url"; then
      publish_discovery "$url"
      return 0
    fi
    echo "Public /health not reachable yet; restarting tunnel"
    cat "$TUNNEL_LOG" || true
  done
  echo "Could not bring up a reachable public tunnel"
  cat "$TUNNEL_LOG" || true
  cat "$PROXY_LOG" || true
  return 1
}

keep_alive() {
  local public_failures=0
  if [ ! -f "$PROXY_URL_FILE" ]; then
    echo "proxy URL file is missing" >&2
    return 1
  fi
  echo "Proxy up — holding runner ($(cat "$PROXY_URL_FILE"))"
  while true; do
    kill -0 "$(cat "$TUNNEL_PID_FILE")" || { echo "tunnel died"; return 1; }
    curl -fsS "$LOCAL_HEALTH" >/dev/null || { echo "proxy died"; return 1; }
    if public_health "$(cat "$PROXY_URL_FILE")"; then
      public_failures=0
    else
      public_failures=$((public_failures + 1))
      echo "public tunnel health check failed (${public_failures}/5)"
      if [ "$public_failures" -ge 5 ]; then
        echo "Restarting unreachable public tunnel"
        bring_up || return 1
        public_failures=0
      fi
    fi
    sleep 60
  done
}

cmd="${1:-bring_up}"
case "$cmd" in
  bring_up) bring_up ;;
  keep_alive) keep_alive ;;
  *)
    echo "unknown command: $cmd" >&2
    exit 1
    ;;
esac
