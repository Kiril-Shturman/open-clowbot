alter table subscriptions
  add column if not exists amount_minor bigint not null default 0,
  add column if not exists currency text not null default 'RUB',
  add column if not exists yookassa_payment_method_id text,
  add column if not exists canceled_at timestamptz;

create index if not exists idx_subscriptions_user_status on subscriptions(user_id, status);
create index if not exists idx_subscriptions_period_end on subscriptions(current_period_end);
