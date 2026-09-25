# Deploying Blava City

The game has two parts:

| Part | What | Where |
|---|---|---|
| Frontend | the static Vite build (`dist/`) | **Cloudflare Workers static assets** (`wrangler.jsonc`) |
| Game server | Node 22 + `ws`, one shared world | **Fly.io**, one Machine in `fra` (`fly.toml`, `server/Dockerfile`) |

The frontend works on its own. Single-player needs no server. The **Online** button appears only when the
build was made with `VITE_SERVER_URL` set.

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
| `E2E` | *(off)* | `1` accepts test-only `debug` messages (free weapons, money). **Never set it in production.** |

## Frontend on Cloudflare Workers

1. In the Cloudflare dashboard, go to **Workers & Pages → Create → Import a repository**, pick this repo
   and set:
   - **Build command:** `npm run build`
   - **Deploy command:** `npm run deploy` (`wrangler deploy`, which reads `wrangler.jsonc`)
   - **Production branch:** `main`. Other branches get preview URLs on `*.workers.dev`.
   - **Build variable:** `VITE_SERVER_URL=wss://ws.blava.example` (or `wss://<app>.fly.dev`). It is baked
     into the bundle at build time.
2. `public/_headers` sets cache headers: hashed `assets/` for a year, and `data/bratislava.json` for an hour.
3. You can check the config locally without logging in: `npx wrangler deploy --dry-run --outdir .wrangler/dry`.

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
