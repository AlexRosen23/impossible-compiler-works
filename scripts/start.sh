#!/usr/bin/env bash
# Production-style start (used by the Constellation launcher): build the UI once, then serve
# UI + API from one process on 127.0.0.1:5720, with the API also on 5721 for the contract.
set -euo pipefail
cd "$(dirname "$0")/.."
[ -d node_modules ] || npm ci --no-audit --no-fund
[ -f web/dist/index.html ] || npx vite build --config web/vite.config.ts >/dev/null
export WITNESS_PORT="${API_PORT:-${WITNESS_PORT:-5721}}"
WEB="${WEB_PORT:-${WITNESS_WEB_PORT:-5720}}"
node src/server/main.ts & API=$!
trap 'kill $API 2>/dev/null || true' EXIT INT TERM
WITNESS_PORT="$WEB" API_PORT="$WITNESS_PORT" node src/server/proxy.ts
