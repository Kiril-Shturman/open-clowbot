# MyClawBot Backend (MVP Skeleton)

## Быстрый старт

```bash
cd backend
cp .env.example .env
npm i
npm run dev
```

## База данных

Нужен PostgreSQL. Применить схемы:

```bash
psql "$DATABASE_URL" -f sql/001_init.sql
psql "$DATABASE_URL" -f sql/002_billing_hardening.sql
psql "$DATABASE_URL" -f sql/003_subscriptions.sql
psql "$DATABASE_URL" -f sql/004_deploy_hardening.sql
```

## Что уже есть

- Реальный create payment в YooKassa (`/api/payments/create`)
- Webhook ingestion с idempotency по `event_hash` + secret check (`x-yookassa-webhook-secret`)
- Auto-create/update subscription при successful recurring payment
- Wallet/Ledger
- OpenRouter proxy endpoint (`/api/ai/chat`) с pre-hold + settlement по фактическим токенам
- Модельный прайсинг (`model_prices`) + fallback pricing
- Hostkey provisioning через `HOSTKEY_BASE_URL` (или mock fallback)
- Deploy jobs queue table + endpoints + deploy worker (`npm run worker:deploy`)
- Secrets storage (encrypted at rest)

## Preflight перед продом

```bash
npm run preflight:prod
```

Проверяет:
- обязательные ENV
- применение SQL миграций (001..004)
- синтаксис backend + workers

## Что осталось перед финальным go-live

1. Реальный auth middleware (JWT/session)
2. E2E тесты critical flows (payment webhook, renewals, deploy)
3. Monitoring/alerts (ошибки worker'ов, 5xx, stuck jobs)
4. Rate-limit store в Redis (вместо memory) для multi-instance
