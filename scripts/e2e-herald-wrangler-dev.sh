#!/usr/bin/env bash
# Herald room schema gate under `wrangler dev` with the GENERATED local config
# (bead asimposiumorg-f37v). The worker served is apps/wire/src/index.ts via
# infra/environments/local.wrangler.toml, not a test entry point.
#   1. An unmigrated local D1 refuses a room upgrade fail-closed:
#      503 ROOM_UNAVAILABLE, with the HERALD_ROOM_SCHEMA_MISSING warning logged.
#   2. After the shipped migrations are applied, the same upgrade reaches the
#      room and is refused only for its missing credential (401 UNAUTHORIZED).
# Local state lives in a fresh temporary directory; the repo's .wrangler state
# is never touched. Not covered: a 101 with a live credential (herald-room
# real-bindings lane), deployed Durable Objects.
# Exit: 0 pass, 1 fail, 78 blocked (wrangler or curl unavailable).
set -uo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
wrangler="$repository_root/apps/wire/node_modules/.bin/wrangler"
config="$repository_root/infra/environments/local.wrangler.toml"
user_agent="OpenAI File Downloader, XaiImageApiFetch/1.0"
port="${HERALD_WRANGLER_DEV_PORT:-18787}"
room="/p/P-01JXYZ4K6Q8M2N3P4R5S6T7V8W/room?since=0"

emit() { printf '{"suite":"e2e-herald-wrangler-dev","status":"%s","code":"%s"%s}\n' "$1" "$2" "${3:-}"; }

if [[ ! -x "$wrangler" ]] || ! command -v curl >/dev/null 2>&1; then
  emit blocked HERALD_WRANGLER_DEV_TOOL_UNAVAILABLE
  exit 78
fi
state_root="$(mktemp -d "${TMPDIR:-/tmp}/asimp-herald-wrangler-dev.XXXXXX")"

# Serve one persisted state dir, probe the room once, stop the server.
# Prints "<http status> <problem code> <schema-missing warnings>".
probe() {
  local state="$1" log="$state_root/$2.log" pid out status code warnings
  (cd "$repository_root/apps/wire" &&
    exec "$wrangler" dev --config "$config" --ip 127.0.0.1 --port "$port" --persist-to "$state") >"$log" 2>&1 &
  pid=$!
  for _ in $(seq 1 120); do
    curl -s -o /dev/null -A "$user_agent" "http://127.0.0.1:$port/capabilities" && break
    sleep 1
  done
  out="$(curl -s -A "$user_agent" \
    -H "upgrade: websocket" -H "connection: upgrade" -H "sec-websocket-version: 13" \
    -H "sec-websocket-key: dGhlIHNhbXBsZSBub25jZQ==" -H "sec-websocket-protocol: asimposium.room.v1" \
    -w $'\n%{http_code}' "http://127.0.0.1:$port$room")"
  status="$(tail -n1 <<<"$out")"
  code="$(grep -o '"code":"[A-Z_]*"' <<<"$out" | head -n1 | cut -d'"' -f4)"
  pkill -TERM -P "$pid" 2>/dev/null
  kill -TERM "$pid" 2>/dev/null
  wait "$pid" 2>/dev/null
  sleep 2
  warnings="$(grep -c HERALD_ROOM_SCHEMA_MISSING "$log")"
  printf '%s %s %s\n' "$status" "${code:-none}" "$warnings"
}

read -r status code warnings < <(probe "$state_root/unmigrated" unmigrated)
if [[ "$status" != 503 || "$code" != ROOM_UNAVAILABLE || "$warnings" -lt 1 ]]; then
  emit fail HERALD_UNMIGRATED_NOT_FAIL_CLOSED ",\"http\":\"$status\",\"problem\":\"$code\""
  exit 1
fi

if ! (cd "$repository_root/apps/wire" &&
  "$wrangler" d1 migrations apply DB --local --config "$config" --persist-to "$state_root/migrated") \
  >"$state_root/migrate.log" 2>&1; then
  emit fail HERALD_LOCAL_MIGRATION_FAILED
  exit 1
fi

read -r status code warnings < <(probe "$state_root/migrated" migrated)
if [[ "$status" != 401 || "$code" != UNAUTHORIZED || "$warnings" -ne 0 ]]; then
  emit fail HERALD_MIGRATED_ROOM_NOT_REACHED ",\"http\":\"$status\",\"problem\":\"$code\""
  exit 1
fi

emit pass HERALD_WRANGLER_DEV_SCHEMA_GATE_PASS ",\"unmigrated\":\"503 ROOM_UNAVAILABLE\",\"migrated\":\"401 UNAUTHORIZED\""
