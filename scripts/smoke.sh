#!/usr/bin/env bash
# Smoke: health → POST text → GET list → GET detail against a running server.
# Usage: HOST=127.0.0.1 PORT=8787 ./scripts/smoke.sh
set -euo pipefail

HOST="${HOST:-127.0.0.1}"
PORT="${PORT:-8787}"
BASE="http://${HOST}:${PORT}"

echo "== GET /health"
curl -fsS "${BASE}/health"
echo

echo "== POST /items (text)"
ID=$(curl -fsS -X POST "${BASE}/items" \
  -H 'content-type: application/json' \
  -d "{\"source\":\"text\",\"text\":\"smoke test $(date -u +%Y-%m-%dT%H:%M:%SZ)\"}" | tee /dev/stderr | sed -E 's/.*"id":"([^"]+)".*/\1/')
echo

echo "== GET /items"
curl -fsS "${BASE}/items"
echo

echo "== GET /items/${ID}"
curl -fsS "${BASE}/items/${ID}"
echo

echo "smoke OK"
