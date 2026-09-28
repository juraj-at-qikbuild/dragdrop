# Admin portal and playtime

The read-only portal is at https://gta-sk.fun/admin/. It is a separate Vite entry point: it does not load
the game/map. Its Supabase Auth session uses `blava-city-admin-auth`, independently of the game's
PKCE session. Operator invitations and recovery links use the implicit browser callback; auth-js
consumes the fragment before the portal loads data.

## Permissions

Only Auth user IDs in `public.admin_users` can execute the reporting RPCs successfully. Membership
is checked inside every call. No authorization comes from user metadata or an email in the frontend.
All analytics tables have RLS enabled and no grants to anon/authenticated.
The browser uses the public key and its own access token; only the game server and operator tooling
receive the Supabase secret key.

- `admin_overview(p_days)`: account count, selected-period totals, guest/account breakdown and daily charts.
- `admin_players(p_days,p_search,p_kind,p_sort,p_direction,p_page,p_limit)`: filtered directory plus total.
- `admin_player(p_player,p_days,p_page,p_limit)`: directory entry, daily totals and paged session history.
- `analytics_ingest(p_entries,p_heartbeat)`: service-only, transactional, at most 200 outbox entries.

Periods are 1, 7, 30 or 90 Bratislava calendar days, including today. Pages are 1-based (default 25,
maximum 100). Existing Auth accounts appear even if they never played. Old SQLite profiles are seeded
once as directory entries; their historical playtime is unknown and is never invented.

## Measurement and delivery

Clients negotiate `hello.analytics` / `welcome.caps: analytics` and emit an `activity` pulse only
on actual keyboard/mouse/touch/gamepad input, at most once per five seconds. State-report heartbeats
do not count as input. The server measures connected milliseconds with its monotonic clock. Active
milliseconds require a connected, unpaused player and gameplay input during the previous 60 seconds.
A legacy tab contributes connected time with zero measured milliseconds; the UI identifies this
coverage limitation. Held controls count as continued input.

A logical session survives the existing reconnect grace period and replacement tabs, excludes
disconnected gaps, and ends on final drop or server restart. Date boundaries use Europe/Bratislava,
including 23/25-hour daylight-saving days. Input activity has up to five seconds of sampling precision.

Every 15 seconds and on lifecycle transitions, cumulative snapshots and their revisions are written
to SQLite's durable outbox. Uploads are asynchronous; duplicate/older revisions never increment
totals or regress snapshots. Only the exact acknowledged payload is removed. A restart closes
unfinished snapshots at their last checkpoint, then retries the outbox. A hard crash can lose at
most the time since the last checkpoint (normally 15 seconds). No downtime is credited.
Shutdown has a bounded drain before closing SQLite. The server's protected /stats includes
analyticsPending and analyticsFailures.

The collector emits freshness even with no players. After 90 seconds without a heartbeat, the portal
marks status stale instead of claiming current online counts. Guest history is transferred only after
the existing progress claim succeeds. Account deletion removes history and pending uploads; minimal
identity tombstones block delayed replays from recreating deleted history.

## Provisioning and release

Apply timestamped migrations through Supabase CLI only: migration list, db push --dry-run, db push,
migration list. Never use config push with the local Auth configuration.

Run `node scripts/admin-provision.mjs juraj+admin@qikbuild.com` with SUPABASE_SECRET_KEY and optionally
SUPABASE_URL in the environment. New users are invited; existing users receive a recovery email
after their UUID membership is verified. ADMIN_REDIRECT_URL defaults to
https://gta-sk.fun/admin/?setup=1. The command reports provider acceptance, not inbox delivery.
Deploy the portal and verify its URL/hosted redirect allow-list before running it. Do not commit keys.

Build/test both components, apply the forward migration, deploy the Fly server and Cloudflare assets,
then provision the operator. Additive capabilities preserve protocol 7 compatibility.

## Verification

`npm test`, `npm run build`, and `npm --prefix server run typecheck` cover timing/persistence,
midnight/DST and input throttling alongside game regressions.

`node scripts/check-admin.mjs` uses SUPABASE_SECRET_KEY and VITE_SUPABASE_PUBLISHABLE_KEY to create
disposable users (no emails sent), verify RLS/RPC permissions, retry ordering, claiming, deletion,
and run browser login/detail/mobile/password-setup checks. ADMIN_TEST_WEB_URL defaults to the
production build served at http://127.0.0.1:4195. It always removes its test users and analytics
fixtures. Screenshots are under ignored .cache/admin-check/.

\`node scripts/check-playtime.mjs\` verifies the deployed guest/account input, pause, inactivity cutoff,
reconnect and collector data end to end. It uses the same environment variables and creates no emails.
It removes the disposable account and analytics fixtures; a guest's saved game profile can remain on
Fly because guests have no account-deletion action.
