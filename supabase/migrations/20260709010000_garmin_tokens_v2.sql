-- Replaces the OAuth1/OAuth2 token shape from the abandoned garmin-connect
-- npm package with garmin-connect-sdk's simpler GarminTokens shape
-- ({ accessToken, refreshToken, accessTokenExpiresAt, ... }). No real data
-- was ever written to the old columns (the old Edge Function never
-- successfully booted), so this drops and recreates rather than migrating.
drop table if exists garmin_tokens;

create table garmin_tokens (
  athlete text primary key,
  tokens jsonb not null,
  updated_at timestamptz not null default now()
);

-- RLS with no policies: only the service_role key (used inside Edge
-- Functions, never shipped to the app) bypasses RLS and can read/write.
alter table garmin_tokens enable row level security;
