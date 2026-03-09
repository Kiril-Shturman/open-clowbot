create extension if not exists pgcrypto;

create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  email text unique,
  name text,
  role text not null default 'user',
  created_at timestamptz not null default now()
);

create table if not exists wallets (
  user_id uuid primary key references users(id) on delete cascade,
  balance_minor bigint not null default 0,
  currency text not null default 'RUB',
  updated_at timestamptz not null default now()
);

create table if not exists ledger_entries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  delta_minor bigint not null,
  currency text not null default 'RUB',
  reason text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists payments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  provider text not null,
  provider_payment_id text unique,
  amount_minor bigint not null,
  currency text not null default 'RUB',
  status text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists payment_events (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  event_type text not null,
  provider_payment_id text,
  payload jsonb not null,
  created_at timestamptz not null default now()
);

create table if not exists subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  provider text not null default 'yookassa',
  provider_subscription_id text unique,
  plan_code text not null,
  status text not null,
  current_period_start timestamptz,
  current_period_end timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists usage_logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  model text not null,
  prompt_tokens int not null,
  completion_tokens int not null,
  total_tokens int not null,
  cost_minor bigint not null,
  latency_ms int not null,
  raw_response jsonb not null,
  error_text text,
  created_at timestamptz not null default now()
);

create table if not exists secrets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  provider text not null,
  key_name text not null,
  secret_enc text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, provider, key_name)
);

create table if not exists servers (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  provider text not null,
  provider_server_id text,
  plan_code text not null,
  region text not null,
  status text not null,
  ip_address text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists bot_instances (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  server_id uuid not null references servers(id) on delete cascade,
  telegram_bot_token_enc text not null,
  status text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists deploy_jobs (
  id uuid primary key default gen_random_uuid(),
  server_id uuid not null references servers(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  status text not null,
  payload jsonb not null,
  logs text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists server_events (
  id uuid primary key default gen_random_uuid(),
  server_id uuid not null references servers(id) on delete cascade,
  event_type text not null,
  payload jsonb not null,
  created_at timestamptz not null default now()
);

create table if not exists audit_logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references users(id) on delete set null,
  action text not null,
  target text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
