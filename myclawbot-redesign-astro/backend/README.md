# MyClawBot Backend (MVP Skeleton)

## Быстрый старт

```bash
cd backend
cp .env.example .env
npm i
npm run dev
```

## База данных

Нужен PostgreSQL. Применить схему:

```bash
psql "$DATABASE_URL" -f sql/001_init.sql
```

## Что уже есть

- Payments scaffold (YooKassa create + webhook ingestion)
- Wallet/Ledger
- OpenRouter proxy endpoint (`/api/ai/chat`) + usage logging + списание
- Hostkey provisioning scaffold + servers registry
- Deploy jobs queue table + endpoints
- Secrets storage (encrypted at rest)

## Важно (доделать в первую очередь)

1. Реальные SDK/API вызовы YooKassa/Hostkey
2. Проверка подписи webhook
3. Реальный auth middleware (JWT/session)
4. Воркер для deploy_jobs
5. Точный прайсинг по моделям OpenRouter
6. Миграции/ORM + тесты
