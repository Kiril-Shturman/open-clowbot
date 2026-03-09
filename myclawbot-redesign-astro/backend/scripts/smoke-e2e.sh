#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

: "${DATABASE_URL:?DATABASE_URL is required}"
: "${JWT_SECRET:?JWT_SECRET is required}"

TMP_USER_ID=$(psql "$DATABASE_URL" -Atc "select gen_random_uuid();")
TMP_SERVER_ID=$(psql "$DATABASE_URL" -Atc "select gen_random_uuid();")
TMP_SUB_ID=$(psql "$DATABASE_URL" -Atc "select gen_random_uuid();")

TOKEN=$(node -e "import jwt from 'jsonwebtoken'; console.log(jwt.sign({sub:'$TMP_USER_ID', role:'user'}, process.env.JWT_SECRET, {expiresIn:'1h'}));")

echo "[1/3] seed db"
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 <<SQL >/dev/null
insert into users(id,email,name) values ('$TMP_USER_ID','smoke+$TMP_USER_ID@test.local','smoke') on conflict do nothing;
insert into wallets(user_id,balance_minor,currency) values ('$TMP_USER_ID',100000,'RUB') on conflict (user_id) do update set balance_minor=excluded.balance_minor;
insert into servers(id,user_id,provider,provider_server_id,plan_code,region,status,ip_address,metadata)
values ('$TMP_SERVER_ID','$TMP_USER_ID','hostkey','hk_smoke','base','ru-msk','provisioning','127.0.0.1','{}'::jsonb)
on conflict do nothing;
insert into subscriptions(id,user_id,provider,provider_subscription_id,plan_code,status,amount_minor,currency,yookassa_payment_method_id,current_period_start,current_period_end,metadata)
values ('$TMP_SUB_ID','$TMP_USER_ID','yookassa','pm_smoke','base','past_due',389000,'RUB','pm_smoke',now()-interval '1 month',now()-interval '1 day','{}'::jsonb)
on conflict do nothing;
SQL

echo "[2/3] api auth + scoped flows"
BASE_URL=${BASE_URL:-http://127.0.0.1:8787}

curl -fsS -H "Authorization: Bearer $TOKEN" "$BASE_URL/api/billing/wallet/$TMP_USER_ID" >/dev/null
curl -fsS -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d "{\"userId\":\"$TMP_USER_ID\",\"serverId\":\"$TMP_SERVER_ID\"}" \
  "$BASE_URL/api/deploy/enqueue" >/dev/null
curl -fsS -X POST -H "Authorization: Bearer $TOKEN" "$BASE_URL/api/infra/servers/$TMP_SERVER_ID/sync" >/dev/null

echo "[3/3] yookassa webhook idempotency"
WEBHOOK_BODY='{"event":"payment.succeeded","object":{"id":"pay_smoke_1","status":"succeeded","payment_method":{"id":"pm_smoke_new"}}}'

psql "$DATABASE_URL" -v ON_ERROR_STOP=1 <<SQL >/dev/null
insert into payments(user_id,provider,provider_payment_id,amount_minor,currency,status,metadata)
values ('$TMP_USER_ID','yookassa','pay_smoke_1',10000,'RUB','pending','{"planCode":"base","recurring":true}'::jsonb)
on conflict (provider_payment_id) do nothing;
SQL

curl -fsS -X POST -H "Content-Type: application/json" -H "x-yookassa-webhook-secret: ${YOOKASSA_WEBHOOK_SECRET:-}" -d "$WEBHOOK_BODY" "$BASE_URL/api/payments/webhook/yookassa" >/dev/null
curl -fsS -X POST -H "Content-Type: application/json" -H "x-yookassa-webhook-secret: ${YOOKASSA_WEBHOOK_SECRET:-}" -d "$WEBHOOK_BODY" "$BASE_URL/api/payments/webhook/yookassa" >/dev/null

echo "smoke e2e ok"
