-- Blava City: data for the social features (docs/plans/social-events.md).
-- Applied with the Supabase CLI: `npx supabase link --project-ref <ref>` once, then `npx supabase db push`.
-- Idempotent (re-running is harmless).
--
-- Who can see what:
--  * The game server and the scripts use the secret key, which bypasses row level security.
--  * Browsers use the publishable key (role anon): they may read the revealed daily puzzles and call
--    leaderboard_week(), nothing else. Accounts (Auth) live in Supabase's own auth schema.
--  * The hot per-player data (money, sessions, nicknames) stays in the game server's SQLite.

-- ------------------------------------------------------------------ "Kde to je?" daily puzzle
-- One row per day. The public part (the photo) is readable once revealed; the spot itself lives in
-- daily_spot_secrets, which no browser can read.
create table if not exists public.daily_spots (
  day date primary key,
  -- object path in the 'spots' bucket (a random name, so it can't be guessed before the reveal)
  image_path text not null,
  -- when it goes live (18:00 Europe/Bratislava by default, set by scripts/spots-gen.mjs)
  reveal_at timestamptz not null,
  solved_nick text,
  solved_at timestamptz,
  created_at timestamptz not null default now()
);
alter table public.daily_spots enable row level security;
revoke insert, update, delete, truncate on public.daily_spots from anon, authenticated;
grant select on public.daily_spots to anon, authenticated;
drop policy if exists "revealed spots are public" on public.daily_spots;
create policy "revealed spots are public" on public.daily_spots
  for select to anon, authenticated
  using (reveal_at <= now());

create table if not exists public.daily_spot_secrets (
  day date primary key references public.daily_spots (day) on delete cascade,
  -- game metres (map projection), level: -1 tunnel, 0 ground, 1 deck, 2 upper deck
  x real not null,
  y real not null,
  level smallint not null default 0,
  radius real not null default 6,
  -- courtyard | crossing | passage | square | river | roof
  kind text not null default 'spot',
  hint_district text,
  hint_quarter text,
  hint_street text
);
alter table public.daily_spot_secrets enable row level security;
revoke all on public.daily_spot_secrets from anon, authenticated;

-- ------------------------------------------------------------------ activity log (leaderboards)
-- Append-only, written by the game server in batches. `player` is the player key: sha256 of a guest
-- token, or 'acct:<auth user id>'; `kind` is the payout reason (kofolka, bounty, cumil, race, courier…).
create table if not exists public.activity (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  kind text not null,
  player text not null,
  nick text not null,
  amount integer not null default 0,
  meta jsonb not null default '{}'::jsonb
);
create index if not exists activity_kind_at on public.activity (kind, at desc);
create index if not exists activity_player on public.activity (player);
create index if not exists activity_at on public.activity (at desc);
alter table public.activity enable row level security;
revoke all on public.activity from anon, authenticated;

-- ------------------------------------------------------------------ moderation
-- Voice chat and conduct reports from players (the server adds positions and nicknames as context).
create table if not exists public.reports (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  reporter text not null,
  reporter_nick text not null,
  target text not null,
  target_nick text not null,
  reason text not null,
  context jsonb not null default '{}'::jsonb,
  handled boolean not null default false
);
create index if not exists reports_open on public.reports (handled, at desc);
alter table public.reports enable row level security;
revoke all on public.reports from anon, authenticated;

-- ------------------------------------------------------------------ remote config and kill switches
-- Read by the game server every minute. Edit values in the dashboard's table editor.
create table if not exists public.game_config (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);
alter table public.game_config enable row level security;
revoke all on public.game_config from anon, authenticated;
insert into public.game_config (key, value) values
  ('voice_enabled', 'true'::jsonb),
  ('voice_requires_account', 'true'::jsonb),
  -- account ids (auth user ids) not allowed to use voice chat
  ('voice_blocklist', '[]'::jsonb),
  -- world-event tunables, e.g. {"gap": [420, 660], "enabled": true}
  ('events', '{}'::jsonb)
on conflict (key) do nothing;

-- ------------------------------------------------------------------ weekly leaderboard (public)
-- Aggregates only: nicknames and totals, never player keys.
create or replace function public.leaderboard_week()
returns table (nick text, earned bigint, wins bigint, deliveries bigint, fares bigint, races bigint, dailies bigint)
language sql
stable
security definer
set search_path = ''
as $$
  select (array_agg(a.nick order by a.at desc))[1] as nick,
         coalesce(sum(a.amount), 0)::bigint as earned,
         (count(*) filter (where a.kind in ('bounty', 'cumil', 'derby', 'race', 'daily')))::bigint as wins,
         (count(*) filter (where a.kind = 'courier'))::bigint as deliveries,
         (count(*) filter (where a.kind = 'taxi'))::bigint as fares,
         (count(*) filter (where a.kind = 'race'))::bigint as races,
         (count(*) filter (where a.kind = 'daily'))::bigint as dailies
  from public.activity a
  where a.at >= date_trunc('week', now())
  group by a.player
  order by earned desc
  limit 50;
$$;
revoke all on function public.leaderboard_week() from public;
grant execute on function public.leaderboard_week() to anon, authenticated;

-- ------------------------------------------------------------------ storage: daily puzzle photos
-- Public: an image can be fetched by its URL. There is deliberately no select policy on
-- storage.objects for this bucket, so nobody can list it and find tomorrow's photo early.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('spots', 'spots', true, 2097152, array['image/webp', 'image/png', 'image/jpeg'])
on conflict (id) do nothing;
