#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROXY_HOST="127.0.0.1"
PROXY_PORT="15080"
USER_ID="testuser"
SECRET="abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789"

echo "==> Building and starting services..."
cd "$SCRIPT_DIR"
docker compose -f docker-compose.test.yml up --build -d

# Wait for services to be ready
echo "==> Waiting for services..."
for i in $(seq 1 30); do
  if curl -sf "http://${PROXY_HOST}:15404/health" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

echo ""
echo "==> Test 1: CONNECT without auth (expect 401)"
echo -e "CONNECT osu.ppy.sh:443 HTTP/1.1\r\nHost: osu.ppy.sh:443\r\n\r\n" | \
  nc -w5 "$PROXY_HOST" "$PROXY_PORT" || true

echo ""
echo "==> Test 2: CONNECT with valid HMAC"
echo "Computing HMAC..."
TIMESTAMP=$(date +%s)
NONCE=$(uuidgen 2>/dev/null || cat /proc/sys/kernel/random/uuid 2>/dev/null || echo "test-nonce")
MESSAGE="${TIMESTAMP}:${NONCE}"
DIGEST=$(echo -n "$MESSAGE" | openssl dgst -sha256 -hmac "$(echo -n "$SECRET" | xxd -r -p)" | awk '{print $2}')
echo "Auth: HMAC ${USER_ID}:${TIMESTAMP}:${NONCE}:${DIGEST}"

echo -e "CONNECT osu.ppy.sh:443 HTTP/1.1\r\nHost: osu.ppy.sh:443\r\nProxy-Authorization: HMAC ${USER_ID}:${TIMESTAMP}:${NONCE}:${DIGEST}\r\n\r\n" | \
  nc -w5 "$PROXY_HOST" "$PROXY_PORT" || true

echo ""
echo "==> Test 3: CONNECT to non-allowed destination (expect 403)"
echo -e "CONNECT evil.com:443 HTTP/1.1\r\nHost: evil.com:443\r\nProxy-Authorization: HMAC ${USER_ID}:${TIMESTAMP}:${NONCE}:${DIGEST}\r\n\r\n" | \
  nc -w5 "$PROXY_HOST" "$PROXY_PORT" || true

echo ""
echo "==> Cleaning up..."
cd "$SCRIPT_DIR"
docker compose -f docker-compose.test.yml down

echo ""
echo "==> Done. Review output above for expected status codes."
echo "    Full end-to-end TLS tunnel test requires the CF Worker with CONNECT_PROXY_* env vars."
