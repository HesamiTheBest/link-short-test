#!/usr/bin/env bash
set -euo pipefail

BASE="${BASE:-http://localhost:8080}"

echo "waiting for /health..."
for i in $(seq 1 30); do
  if curl -fs "$BASE/health" > /dev/null; then
    echo "healthy"
    break
  fi
  if [ "$i" -eq 30 ]; then echo "never became healthy"; exit 1; fi
  sleep 2
done

echo "creating a link..."
CODE=$(curl -fs -X POST "$BASE/shorten" -H "Content-Type: application/json" \
  -d '{"url":"https://example.com"}' | jq -r .code)

echo "following it..."
STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/$CODE")
[ "$STATUS" = "302" ] || { echo "expected redirect, got $STATUS"; exit 1; }

echo "checking stats..."
CLICKS=$(curl -fs "$BASE/stats/$CODE" | jq -r .clicks)
[ "$CLICKS" -ge 1 ] || { echo "clicks not counted"; exit 1; }

echo "all tests passed"