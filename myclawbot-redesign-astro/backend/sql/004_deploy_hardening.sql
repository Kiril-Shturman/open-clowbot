alter table deploy_jobs
  add column if not exists attempts int not null default 0,
  add column if not exists max_attempts int not null default 3,
  add column if not exists next_retry_at timestamptz not null default now(),
  add column if not exists last_error text;

create index if not exists idx_deploy_jobs_status_retry on deploy_jobs(status, next_retry_at);
