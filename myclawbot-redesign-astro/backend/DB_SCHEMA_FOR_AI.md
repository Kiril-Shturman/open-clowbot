# MyClawBot DB Schema (AI-readable)

Этот файл — краткое описание БД для агентов/ИИ и разработчиков.
Физическая схема: `backend/sql/001_init.sql`

## Connection
- Engine: PostgreSQL 14+
- DB: `myclawbot`
- URL (local dev): `postgres://myclawbot:myclawbot@127.0.0.1:5432/myclawbot`

---

## Core domains
1. **Users/Auth**: `users`
2. **Balance/Billing**: `wallets`, `ledger_entries`, `usage_logs`
3. **Payments/Subscriptions**: `payments`, `payment_events`, `subscriptions`
4. **Infra/VPS/Bots**: `servers`, `bot_instances`, `deploy_jobs`, `server_events`
5. **Secrets/Audit**: `secrets`, `audit_logs`

---

## Tables

### users
- `id uuid pk`
- `email text unique`
- `name text`
- `role text default 'user'`
- `created_at timestamptz`

Purpose: основной пользователь SaaS.

### wallets
- `user_id uuid pk -> users.id`
- `balance_minor bigint` (в копейках)
- `currency text` (RUB)
- `updated_at`

Purpose: текущий баланс пользователя для списаний за AI usage.

### ledger_entries
- `id uuid pk`
- `user_id -> users.id`
- `delta_minor bigint` (+пополнение / -списание)
- `currency`
- `reason text` (`topup`, `openrouter_usage`, `manual_adjust`, ...)
- `metadata jsonb`
- `created_at`

Purpose: неизменяемый журнал всех финансовых движений.

### payments
- `id uuid pk`
- `user_id -> users.id`
- `provider text` (yookassa)
- `provider_payment_id text unique`
- `amount_minor bigint`
- `currency text`
- `status text` (`pending`, `succeeded`, `canceled`, ...)
- `metadata jsonb` (planCode, recurring, etc)
- `created_at`, `updated_at`

Purpose: платежные транзакции с PSP.

### payment_events
- `id uuid pk`
- `provider text`
- `event_type text`
- `provider_payment_id text`
- `payload jsonb`
- `created_at`

Purpose: сырые webhook события для аудита и идемпотентной обработки.

### subscriptions
- `id uuid pk`
- `user_id -> users.id`
- `provider text default yookassa`
- `provider_subscription_id text unique`
- `plan_code text`
- `status text` (`active`, `past_due`, `canceled`, ...)
- `current_period_start`, `current_period_end`
- `created_at`, `updated_at`

Purpose: рекуррентные подписки.

### usage_logs
- `id uuid pk`
- `user_id -> users.id`
- `model text`
- `prompt_tokens int`
- `completion_tokens int`
- `total_tokens int`
- `cost_minor bigint`
- `latency_ms int`
- `raw_response jsonb`
- `error_text text nullable`
- `created_at`

Purpose: учёт запросов к OpenRouter и их стоимости.

### servers
- `id uuid pk`
- `user_id -> users.id`
- `provider text` (hostkey)
- `provider_server_id text`
- `plan_code text`
- `region text`
- `status text` (`provisioning`, `ready`, `error`, ...)
- `ip_address text nullable`
- `metadata jsonb`
- `created_at`, `updated_at`

Purpose: арендованные VPS.

### bot_instances
- `id uuid pk`
- `user_id -> users.id`
- `server_id -> servers.id`
- `telegram_bot_token_enc text`
- `status text` (`pending_deploy`, `running`, `failed`, ...)
- `created_at`, `updated_at`

Purpose: привязка конкретного бота к серверу и его lifecycle.

### deploy_jobs
- `id uuid pk`
- `server_id -> servers.id`
- `user_id -> users.id`
- `status text` (`queued`, `running`, `done`, `failed`)
- `payload jsonb`
- `logs text`
- `created_at`, `updated_at`

Purpose: очередь задач на развёртывание OpenClaw на VPS.

### server_events
- `id uuid pk`
- `server_id -> servers.id`
- `event_type text`
- `payload jsonb`
- `created_at`

Purpose: история инфраструктурных событий по серверу.

### secrets
- `id uuid pk`
- `user_id -> users.id`
- `provider text` (`openrouter`, `telegram`, `hostkey`, `yookassa`)
- `key_name text`
- `secret_enc text` (AES-GCM encrypted)
- `created_at`, `updated_at`
- `unique(user_id, provider, key_name)`

Purpose: хранение чувствительных ключей в зашифрованном виде.

### audit_logs
- `id uuid pk`
- `user_id -> users.id nullable`
- `action text`
- `target text`
- `metadata jsonb`
- `created_at`

Purpose: журнал критичных действий (например изменения ключей).

---

## Relationship map (коротко)
- `users 1-1 wallets`
- `users 1-N ledger_entries`
- `users 1-N payments`
- `users 1-N subscriptions`
- `users 1-N usage_logs`
- `users 1-N servers`
- `servers 1-N bot_instances`
- `servers 1-N deploy_jobs`
- `servers 1-N server_events`
- `users 1-N secrets`

---

## API ↔ DB mapping
- `POST /api/payments/create` → `payments`
- `POST /api/payments/webhook/yookassa` → `payment_events`, update `payments`
- `GET /api/billing/wallet/:userId` → `wallets`
- `POST /api/billing/ledger/adjust` → `wallets`, `ledger_entries`
- `POST /api/ai/chat` → reads `wallets`, writes `ledger_entries`, `usage_logs`
- `POST /api/infra/servers/order` → `servers`, `bot_instances`, `server_events`
- `POST /api/deploy/enqueue` → `deploy_jobs`, `server_events`
- `POST /api/keys/upsert` → `secrets`, `audit_logs`

---

## Conventions
- Все деньги в `*_minor` (копейки), целые числа.
- Все timestamps — `timestamptz`.
- `metadata/payload/raw_response` — `jsonb` для расширяемости.
- Любое движение денег дублируется в `ledger_entries`.

---

## TODO (production)
- Добавить индексы на частые выборки (`user_id`, `status`, `created_at`).
- Добавить idempotency key в `payment_events`/webhook pipeline.
- Добавить soft-delete/archival policy.
- Добавить pg migrations tool (Prisma/Drizzle/Flyway).
