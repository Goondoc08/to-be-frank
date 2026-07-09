create table if not exists garmin_tokens (
  athlete text primary key,
  oauth1_token jsonb not null,
  oauth2_token jsonb not null,
  updated_at timestamptz not null default now()
);

-- RLS with no policies: anon/authenticated clients get zero access.
-- Only the service_role key (used inside Edge Functions, never shipped to
-- the app) bypasses RLS and can read/write this table.
alter table garmin_tokens enable row level security;
