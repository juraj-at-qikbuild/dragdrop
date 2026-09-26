# Deploying Blava City

The game has two parts:

| Part | What | Where |
|---|---|---|
| Frontend | the static Vite build (`dist/`) | **Cloudflare Workers static assets** (`wrangler.jsonc`) |
| Game server | Node 22 + `ws`, one shared world | **Fly.io**, one Machine in `fra` (`fly.toml`, `server/Dockerfile`) |

The frontend works on its own. Single-player needs no server. The **Online** button appears only when the
build was made with `VITE_SERVER_URL` set.

## Deploy order

Client and server speak the same wire protocol (`PROTOCOL_VERSION` in `src/shared/net/protocol.ts`, now
**7**); the server refuses an older client outright ("Nová verzia hry – obnov stránku."). Deploy both
together, as with every earlier protocol bump — there's no compatibility window to stagger through.
`fly deploy` (server) and the Cloudflare Workers Build (client, triggered by a push to `main`) are two
independent pipelines, so trigger both around the same time, ideally at a quiet hour: a server deploy
drops every open socket (clients auto-reconnect on their own within a couple of seconds), and a client
build takes a minute or two to go live.

## Local development

```bash
npm install
npm --prefix server install

npm run dev:server                                   # game server on ws://localhost:8080
VITE_SERVER_URL=ws://localhost:8080 npm run dev      # client on http://localhost:5173
```

Open two browser windows, or one normal and one private window so each has its own identity, and click
**Online** in both. `ALLOWED_ORIGINS` defaults to the local Vite ports.

Tests:

```bash
npm test              # unit tests (vitest): protocol, server room, persistence, simulation
npm run smoke         # offline single-player in headless Chromium (no server)
npm run e2e           # builds the client, starts a server, drives headless Chromium pages
npm run loadtest -- --bots 100 --spread city --duration 60   # bot clients against a running server
npm --prefix server run bench -- --players 30 --spread city  # simulation only, no networking
```

`npm run e2e` covers two players seeing each other, shared NPC deaths, PvP damage and wanted stars, a
server restart that both clients survive with their money intact, and an offline game that opens no
connection. Start the server with `E2E=1` for the load test, so bots can be handed a pistol.

## Game server on Fly.io

One-time setup (needs [`flyctl`](https://fly.io/docs/flyctl/install/) and a Fly account):

```bash
# 1. pick an app name and put it in fly.toml (`app = "..."`), then create the app without deploying
fly launch --copy-config --no-deploy --name <app> --region fra

# 2. the SQLite volume (player profiles live here); same region as the Machine
fly volumes create data --region fra --size 1

# 3. which browser origins may open a WebSocket. `*` matches one DNS label fragment.
fly secrets set ALLOWED_ORIGINS="https://blava.example,https://*blava-city.<account>.workers.dev,http://localhost:5173"

# 4. optional: a token for GET /stats (bearer auth)
fly secrets set STATS_TOKEN=$(openssl rand -hex 16)

# 5. deploy, and make sure there is exactly one Machine: all world state lives in its memory
fly deploy
fly scale count 1
```

After that, deploy with `fly deploy` from the repo root. The build context is the root, not `server/`,
because the server bundles `src/shared` and ships `public/data/bratislava.json`.

- **What a deploy does.** Fly sends SIGTERM. The server tells every client `bye: restart`, writes profiles
  and sessions to SQLite, and exits. Clients reconnect on their own, with the first retry about 1.5 s
  later, and resume where they were.
- **Health.** `GET /healthz` returns `{ ok, players, tickMs }`. `GET /stats` returns tick time, entity
  counts and traffic; it needs `Authorization: Bearer $STATS_TOKEN` or a loopback request
  (`fly ssh console -C "curl -s localhost:8080/stats"`).
- **Backups.** Fly takes daily volume snapshots, so check `fly volumes snapshots list`. The database is
  `/data/blava.db`.

### Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8080` | HTTP/WebSocket port |
| `ALLOWED_ORIGINS` | local Vite ports | comma-separated browser origins allowed to connect (`*` wildcard per label fragment) |
| `MAP_PATH` | `/app/data/bratislava.json` | baked map; the Docker image copies it there |
| `DB_PATH` | `/data/blava.db` | SQLite database on the Fly volume |
| `TICK_HZ` | `20` | simulation and snapshot rate |
| `TICK_BUDGET_MS` | `12` | the load governor thins out NPCs when the average tick time exceeds this |
| `NPC_SCALE` | `1` | multiplies the world-wide NPC caps (traffic 220, parked 260, pedestrians 700, trams 16, police 40, helicopters 4, roadblocks 6); raise it on a bigger Machine |
| `MAX_PLAYERS` | `150` | connections beyond this get `server full` |
| `STATS_TOKEN` | *(empty)* | bearer token for `/stats` |
| `WS_DEFLATE` | *(off)* | `1` enables permessage-deflate (less bandwidth, more CPU) |
| `SUPABASE_URL` | *(empty)* | Supabase project URL (Auth JWKS, PostgREST, Storage); also accepts `GTA_BRATISKA_SUPABASE_URL` or `GTA_BRATISKA_SUPABASE_PROJECT_URL`. Empty disables every Supabase-backed feature (accounts, the daily puzzle, remote config, activity/reports) — they degrade to "off", not to an error |
| `SUPABASE_SECRET_KEY` | *(empty)* | the `service_role`-equivalent secret key (also accepts `GTA_BRATISKA_SUPABASE_SECRET_KEY`); server-only, never sent to a client or logged |
| `CF_TURN_KEY_ID` / `CF_TURN_API_TOKEN` | *(empty)* | Cloudflare Realtime TURN credentials for voice chat; unset means STUN-only ICE (see **Voice chat: TURN** below) |
| `AUTH_DISABLED` | *(off)* | `1` skips Supabase JWT verification even when `SUPABASE_URL` is set (tests, or local dev with no Supabase project) — every account hello then gets `auth-unavailable`, and only guest play works |
| `E2E` | *(off)* | `1` accepts test-only `debug` messages (free weapons, money, forcing a world event, today's daily spot) and relaxes `voice_requires_account` so the voice e2e script can opt in a guest. **Never set it in production.** |

## Frontend on Cloudflare Workers

1. In the Cloudflare dashboard, go to **Workers & Pages → Create → Import a repository**, pick this repo
   and set:
   - **Build command:** `npm run build`
   - **Deploy command:** `npm run deploy` (`wrangler deploy`, which reads `wrangler.jsonc`)
   - **Production branch:** `main`. Other branches get preview URLs on `*.workers.dev`.
   - **Build variables:** `VITE_SERVER_URL=wss://ws.blava.example` (or `wss://<app>.fly.dev`), and, for
     account play and voice chat, `VITE_SUPABASE_URL` (the project URL) and
     `VITE_SUPABASE_PUBLISHABLE_KEY` (the publishable/anon key — never the secret key). All three are
     baked into the bundle at build time; leaving the Supabase pair unset just hides the account
     buttons and keeps play guest-only, same as an unset `VITE_SERVER_URL` hides the Online button.
2. `public/_headers` sets cache headers: hashed `assets/` for a year, and `data/bratislava.json` for an hour.
3. You can check the config locally without logging in: `npx wrangler deploy --dry-run --outdir .wrangler/dry`.

## Supabase

Supabase backs accounts (Auth), the daily puzzle, the activity log and moderation reports
(`docs/multiplayer.md` has the design and the anti-abuse rules; this section is the day-to-day
operator's side of it). Every Supabase-backed feature degrades to "off" on its own when
`SUPABASE_URL`/`SUPABASE_SECRET_KEY` are unset — there's no hard dependency on it to run the server at
all.

### Migrations

Apply schema changes only through the Supabase CLI, never the dashboard's SQL editor — the CLI keeps a
migration history that the editor doesn't, and every later migration assumes that history is accurate.

```bash
npm run db:link   # npx supabase link --project-ref <ref>; once per checkout
npm run db:push   # npx supabase db push
```

`db:link` is pinned to the project in `package.json`; re-run it if the repo ever points at a different
Supabase project. A schema change is a **new**, timestamped migration file
(`npx supabase migration new <name>`) — never an edit to one that's already been applied. The one
that's there today is `supabase/migrations/20260926110000_social_events.sql`.

### Auth dashboard setup

Under **Authentication** in the Supabase dashboard. Set all of this by hand — never run `supabase
config push`: `supabase/config.toml`'s `[auth]` block is local-dev config (localhost Site URL and
redirect URLs included), and that command would overwrite the hosted project's settings with it.

- **Providers → Email**: enabled, with **Confirm email** on (both are the project defaults).
- **URL Configuration**: Site URL = the production frontend URL; **Redirect URLs** add
  `https://<prod>/**`, `https://*.workers.dev/**` (Cloudflare preview builds), `http://localhost:5173/**`
  and `http://localhost:4173/**` (dev and preview). Sign-up confirmation and password reset both round-trip
  through one of these.
- **JWT Keys**: confirm the project signs with **ES256** (asymmetric) keys — `server/src/auth.ts` pins
  `ES256` and won't accept a token signed with the legacy shared secret. A project still on that legacy
  secret needs **Migrate**, then **Rotate**, in the dashboard.
- **Email templates**: paste the Slovak templates from `supabase/templates/confirm.html` (sign-up) and
  `supabase/templates/reset.html` (password reset) into the matching dashboard templates. Both use
  `{{ .ConfirmationURL }}`.
- **Custom SMTP before launch.** The built-in sender allows only **2 e-mails/hour**, project-wide —
  fine for testing, not for real signups. Set up Resend, Postmark, SES or similar under
  **Settings → Auth → SMTP** before announcing the game.
- **Optional: Turnstile**, under **Bot and Abuse Protection**, if signups start attracting abuse.

### TURN setup and cost

Proximity voice chat needs at least a STUN server to connect two players — two public ones (Cloudflare's
and Google's) are always offered, no setup needed, and that's enough for most straightforward NATs. Add
TURN (relayed, so it also crosses symmetric NAT/CGNAT, at the cost of routing that audio through
Cloudflare) for the players it can't otherwise pair:

1. Cloudflare dashboard → **Realtime** → **TURN**, create a key.
2. `fly secrets set CF_TURN_KEY_ID=<key id> CF_TURN_API_TOKEN=<api token>`.

The server mints credentials itself per session (`POST .../v1/turn/keys/$ID/credentials/generate-ice-servers`,
a 24 h TTL, cached and refreshed a little early) and falls back to STUN-only if the key is missing,
invalid, or the request fails. **Cost**: Cloudflare's TURN relay is free up to 1,000 GB/month shared
across the whole account, then $0.05/GB. Audio only relays through TURN when a direct peer-to-peer path
fails, and it's mono, 24 kbps Opus, so this is unlikely to matter until the player base is large.

### Generating Kde to je? content

Daily spots are generated ahead of time and uploaded to Supabase; the server just serves whichever row
matches today's Bratislava date (`server/src/features/Daily.ts`). Generate more with:

```bash
npm run spots:gen -- --days 30                     # the next 30 days after the latest uploaded one
npm run spots:gen -- --days 7 --from 2026-11-01     # a specific start date
npm run spots:gen -- --days 3 --dry                 # preview only, writes no Supabase rows
```

**Always review a batch with `--dry` first.** It renders the same images but writes them, plus an
`index.html` contact sheet, to `.cache/spots/` instead of uploading — worth a look before a candidate
spot goes live for a whole day. It builds the client if `dist/` is missing, then drives headless
Chromium against `?photo` the same way `npm run smoke` does.

**30 days are already uploaded, `2026-09-27` through `2026-10-26`.** Run `spots:gen` again before
**2026-10-26** so the well doesn't run dry — a day with no uploaded row simply shows no puzzle
(`Daily.ts` retries every 15 minutes while one is missing).

### `game_config` operations

Read by the server at boot and every 60 s (`server/src/features/RemoteConfig.ts`), with hardcoded
defaults whenever a row is missing, malformed, or Supabase is unreachable. Change a value from the
dashboard's **Table Editor** (open `game_config`, edit the `value` cell) or with SQL — either way it's
a data change, not a migration, and takes effect on the next poll (within a minute):

```sql
-- turn voice chat off everywhere
update game_config set value = 'false'::jsonb where key = 'voice_enabled';

-- block specific accounts from voice chat (Supabase auth user ids, not nicknames)
update game_config set value = '["<uuid>", "<uuid>"]'::jsonb where key = 'voice_blocklist';

-- retune the world-event scheduler; any field left out keeps its current value
update game_config set value = '{"gap": [420, 660], "enabled": true}'::jsonb where key = 'events';
```

The four seeded keys are `voice_enabled` and `voice_requires_account` (booleans), `voice_blocklist` (an
array of Supabase account ids) and `events` (`gap`/`offlineGap`/`first` as `[min, max]` second pairs,
`retry` in seconds, `enabled`). A bad or absent field is ignored on its own — it never blocks the rest
of the row from applying.

### Moderation

Voice/conduct reports (the in-game peers list's **Nahlásiť** button) land in `public.reports`:
`reporter`/`reporter_nick`, `target`/`target_nick`, a free-text `reason`, and a `context` jsonb blob
(both players' positions and whether the target had voice on at the time). Browse them from the
dashboard's **Table Editor**, newest first — there's no admin UI in the game itself. Set `handled =
true` once you've acted on one, so the open queue stays short. There's no automatic action on a
report: voice audio can't be recorded or reviewed after the fact, so moderation is manual, backed by
the `voice_blocklist` (bans an account outright) and the `voice_enabled` kill switch above.

### `scripts/supa-check.mjs`

Run after `db:push`, and again after any Auth dashboard change, to verify the deployed project
actually matches what the game expects:

```bash
node scripts/supa-check.mjs
```

With the secret key, it checks that every table from the migration exists and that `game_config` has
its four seeded keys. With the publishable key, it checks that anon is denied
`daily_spot_secrets`/`activity`/`reports`/`game_config` but can read `daily_spots` and call
`leaderboard_week()`. It also checks that the `spots` Storage bucket exists and is public but can't be
listed by anon, and that the Auth JWKS advertises an ES256 key. Besides `SUPABASE_URL`/
`SUPABASE_SECRET_KEY` (or their `GTA_BRATISKA_` fallbacks), it needs `SUPABASE_PUBLISHABLE_KEY` (or
`GTA_BRATISKA_SUPABASE_PUBLISHABLE_KEY`) set — the server itself never uses a publishable key, so this
is one to set just for running the check. Nothing it prints ever includes a key value.

GitHub Pages is no longer used. If it was turned on for the repo, switch it off under
*Settings → Pages*.

## Domain

1. Put the domain's DNS on Cloudflare.
2. Attach the apex (`blava.example`) to the Worker as a **Custom Domain**.
3. Add `ws.blava.example` as a **CNAME** to `<app>.fly.dev` with the proxy **off** (grey cloud,
   *DNS only*), then run `fly certs add ws.blava.example`. Fly terminates TLS for the WebSocket, and
   Cloudflare's proxy stays out of the realtime path.
4. Add `https://blava.example` to `ALLOWED_ORIGINS`, and point `VITE_SERVER_URL` at
   `wss://ws.blava.example`.

## Capacity

The server simulates every NPC once for everyone. The number of NPCs around each player shrinks as more
players join, and global caps (`NPC_SCALE`) set a hard ceiling. A governor also thins the city out
(down to 20% of normal density, starting with what nobody is looking at) when the average tick time
exceeds `TICK_BUDGET_MS`. An overloaded Machine gets a quieter city instead of lag.

Measured with `npm run loadtest` against a server pinned to one core (`taskset -c 0`) of the development
machine, 60 s runs. Bots walk the pedestrian graph, report state at 20 Hz, decode every snapshot and
shoot now and then:

| Players | Where | Tick avg / p95 | CPU of one core | Governor | Down per player | Server RSS |
|---|---|---|---|---|---|---|
| 1 | anywhere | 2 ms / 3 ms | ~4% | 1.0 | ~31 KB/s | ~185 MB |
| 10 | around the main square | 6 ms / 13 ms | ~11% | 1.0 | ~31 KB/s | ~195 MB |
| 30 | spread over the city | 10 ms / 16–22 ms | ~20% | ~0.3 | ~6 KB/s | ~250 MB |
| 100 | spread over the city | 16 ms / 28 ms | ~32% | 0.2 | ~7 KB/s | ~380 MB |
| 100 | around the main square | 20 ms / 32–36 ms | ~40% | 0.2 | ~56 KB/s | ~230 MB |

The tick runs every 50 ms, so the loop keeps its 20 Hz up to about 45 ms per tick. Players in one place
share the same NPCs and cost less CPU, but each of them receives all the others (100 players together
are about 5.6 MB/s out). Spread-out players each get their own slice of city, thinned by the governor.

**`shared-cpu-1x` is enough for a handful of players, not for 100.** A shared-CPU Machine gets a baseline
of 1/16 of a core (6.25%) and bursts above it only while it has a burst balance saved up (see Fly's
[CPU performance](https://fly.io/docs/machines/cpu-performance/) page). One player uses about 4%. A busy
evening drains the balance, and then Fly throttles the Machine to its baseline: ticks stretch, the governor
drops to its floor, and NPCs thin out. For real load, switch `fly.toml` to a dedicated core:

```toml
[[vm]]
  size = "performance-1x"   # 1 dedicated vCPU, 2 GB
  memory = "2gb"
```

Raise `--max-old-space-size` in `NODE_OPTIONS` along with the memory (say `1500` for 2 GB). With a
dedicated core you can also raise `NPC_SCALE` (for example `1.5`) if `/stats` shows `governor`
staying at 1 and `loop.p95` well under 30 ms.

### Watching it

`GET /stats` (loopback or `Authorization: Bearer $STATS_TOKEN`) returns:

- `players` / `connected`: sessions, including the 30 s reconnect grace, and live connections
- `loop.avg` / `loop.p95` / `loop.max`: tick time in ms over the last few seconds
- `governor`: 1 is the full city; 0.2 is the floor
- `vehicles`, `peds`, `trams`, `ids`: entity counts
- `snapshotBytes`, `bytesOut`, `msgsIn`: traffic
- `shots` / `badHits`: fired shots and hit claims the server rejected (a wall in the way, the target
  wasn't there at the shooter's render time). A steady `badHits` share above a few percent means someone
  is sending forged hits or the tolerance is too tight.
- `rejected` / `teleports`: invalid messages, and position reports answered with a correction
- `mem`: RSS in bytes
