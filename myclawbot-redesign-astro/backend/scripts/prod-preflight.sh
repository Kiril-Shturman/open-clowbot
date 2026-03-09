#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

echo "[1/5] env check"
required=(
  DATABASE_URL
  ENCRYPTION_KEY
  OPENROUTER_API_KEY
  YOOKASSA_SHOP_ID
  YOOKASSA_SECRET_KEY
  YOOKASSA_WEBHOOK_SECRET
)

missing=0
for key in "${required[@]}"; do
  if [[ -z "${!key:-}" ]]; then
    echo "  - missing: $key"
    missing=1
  fi
done

if [[ "$missing" -eq 1 ]]; then
  echo "env check failed"
  exit 1
fi

echo "[2/5] db migrations"
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f sql/001_init.sql >/dev/null
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f sql/002_billing_hardening.sql >/dev/null
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f sql/003_subscriptions.sql >/dev/null
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f sql/004_deploy_hardening.sql >/dev/null

echo "[3/5] node syntax"
node --check src/server.js >/dev/null
node --check src/workers/deploy-worker.js >/dev/null
node --check src/workers/subscription-renewal-worker.js >/dev/null
node --check src/workers/hostkey-sync-worker.js >/dev/null

echo "[4/5] install deps"
npm ci --silent >/dev/null

echo "[5/5] health dry-run"
echo "preflight ok"
