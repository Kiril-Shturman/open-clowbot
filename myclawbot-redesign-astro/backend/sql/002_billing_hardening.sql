create table if not exists model_prices (
  id uuid primary key default gen_random_uuid(),
  model text not null unique,
  input_usd_per_mtok numeric(12,6) not null,
  output_usd_per_mtok numeric(12,6) not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table usage_logs
  add column if not exists prehold_minor bigint not null default 0,
  add column if not exists settlement_delta_minor bigint not null default 0;

alter table payment_events
  add column if not exists event_hash text unique;

create index if not exists idx_ledger_user_created on ledger_entries(user_id, created_at desc);
create index if not exists idx_payments_user_created on payments(user_id, created_at desc);
create index if not exists idx_usage_user_created on usage_logs(user_id, created_at desc);
create index if not exists idx_servers_user_created on servers(user_id, created_at desc);
