# Multiplayer: tech stack and plan

Handover brief for implementing a shared-world multiplayer mode in Blava City.

## Goal

- **One persistent shared world.** All players are in the same world: no rooms, lobbies or matchmaking.
- **Target scale:** up to about 100 concurrent players, most of them in Central Europe.
- **Frontend:** stays a static Vite site, but moves from GitHub Pages (`.github/workflows/pages.yml`) to **Cloudflare Workers static assets**. The game server runs on **Fly.io**.

## Current state of the codebase (relevant facts)

- About 6.7k lines of TypeScript. The engine is custom Canvas2D; `package.json` lists `phaser` as a dependency but it isn't used for the core loop. There is no backend.
- `src/main.ts` fetches `public/data/bratislava.json`, which is about 3.0 MB raw and 0.8 MB gzipped, then builds `World`, `Graph` and `Game`.
- `Game.update(dt)` (`src/game/Game.ts`) runs on a **variable timestep**, and `Math.random` is used throughout AI, Combat, Vehicle, Ped and Tram. The simulation is therefore **not deterministic**, so lockstep networking won't work. Use **state sync plus snapshot interpolation** instead.
- NPCs (traffic, parked cars, peds, trams, police) spawn and despawn in a radius around the **single local player** (`src/game/AI.ts`, around lines 50–107).
- Simulation code is coupled to rendering and audio. For example, `Vehicle` imports `Atmosphere`/`LightLayer` types and calls `Combat` statics for visual effects, and `Combat` holds both damage logic and particles.
- Saves live in `localStorage` (`Game.ts`, `SAVE_KEY`).

## Tech stack

| Layer | Choice |
|---|---|
| Frontend hosting | **Cloudflare Workers static assets** (not Pages, which Cloudflare is folding into Workers), deployed through Workers Builds |
| Game server hosting | **Fly.io**, one Machine, region `fra` (Frankfurt), `shared-cpu-1x`, 512 MB RAM to start |
| Runtime | **Node.js 22**, TypeScript bundled with `esbuild`, or run with `tsx` in dev |
| Transport | **WebSockets** via the `ws` package (optionally swap in `uWebSockets.js` later if CPU-bound) |
| Protocol | JSON messages to start. Switch hot-path snapshots to binary (`DataView`/typed arrays) once it works |
| Persistence | **SQLite** (`better-sqlite3`) on a **Fly volume** mounted at `/data` |
| Shared code | Pure-TS simulation modules imported by both client and server (no DOM, Canvas or audio) |
| Client config | `VITE_SERVER_URL` (e.g. `wss://blava-city.fly.dev`) set as a Workers Builds build variable; single-player still works when it's unset |

### Repo layout (proposed)

```
server/
  src/index.ts        # HTTP server: /healthz plus WebSocket upgrade
  src/Room.ts         # the single world: players, tick loop, broadcast
  src/net/protocol.ts # re-exports shared message types
  src/db.ts           # SQLite access (phase 3)
  package.json, tsconfig.json
  Dockerfile
fly.toml
wrangler.jsonc        # Cloudflare static-assets config (frontend)
public/_headers       # cache headers, copied into dist/ by Vite
src/net/              # client: connection, reconnect, interpolation buffer, remote-player rendering
src/shared/           # protocol types + (phase 2) the DOM-free simulation
```

### Fly.io configuration essentials

- `fly.toml`:
  - `primary_region = "fra"`
  - `[http_service] internal_port = 8080`, `force_https = true`
  - `auto_stop_machines = "off"`, `auto_start_machines = true`, `min_machines_running = 1`
  - An HTTP health check on `/healthz`
  - `[[mounts]] source = "data"`, `destination = "/data"`
- Run **exactly one Machine** (`fly scale count 1`). All the state lives in its memory, so it must never be horizontally scaled.
- Deploys restart the process and drop every socket. The client must auto-reconnect with backoff and restore state, and the server must persist important state (see phase 3).
- Check the `Origin` header on WebSocket upgrade: allow the production frontend origin (for example `https://blava.example`), the `*.workers.dev` preview URLs and `localhost:5173`. Read the list from an `ALLOWED_ORIGINS` env var (`fly secrets set`).

### Cloudflare configuration essentials (frontend)

- Add `wrangler.jsonc` at the repo root. It serves the static build only; there is no Worker script:
  ```jsonc
  {
    "name": "blava-city",
    "compatibility_date": "<today>",
    "assets": { "directory": "./dist" }
  }
  ```
  `vite.config.ts` already sets `base: './'`, so it doesn't need to change. The game is one `index.html`, so no SPA fallback is needed.
- Add `wrangler` as a devDependency and a `"deploy": "wrangler deploy"` script to `package.json`.
- In the Cloudflare dashboard, connect the GitHub repo through **Workers Builds**:
  - Build command: `npm run build`
  - Deploy command: `npm run deploy`
  - Production branch: `main`. Other branches get preview URLs on `*.workers.dev`.
  - Build variable: `VITE_SERVER_URL=wss://<server domain>`. Build variables are baked into the bundle at build time and aren't available at runtime, which is what we want here.
- Add `public/_headers`:
  ```
  /assets/*
    Cache-Control: public, max-age=31536000, immutable
  /data/*
    Cache-Control: public, max-age=3600
  ```
  Files under `assets/` have content hashes in their names, so they can be cached for a year. `data/bratislava.json` has a fixed name, so its cache time stays short.
- Once the Cloudflare deploy works, delete `.github/workflows/pages.yml` and turn off GitHub Pages.
- **Domain:** put the domain's DNS on Cloudflare. Attach the apex (for example `blava.example`) to the Worker as a Custom Domain. Point `ws.blava.example` at Fly with a CNAME to `<app>.fly.dev` set to **DNS only** (grey cloud), then run `fly certs add ws.blava.example`. Fly then handles TLS for the WebSocket, and Cloudflare's proxy stays out of the realtime path.
- Why Cloudflare rather than Vercel: static bandwidth is free, commercial use is allowed on the free plan, and every visit downloads the roughly 0.8 MB (gzipped) map. Vercel Hobby is non-commercial only and capped at 100 GB a month. Neither platform can run the Node WebSocket server.

## Networking model

- **Server tick:** fixed 20 Hz. Snapshots go to clients at 10–20 Hz.
- **Client → server:** the local player's own state (position, angle, velocity, vehicle id, weapon, firing) at about 15–20 Hz. The client is authoritative for its own movement, so controls stay responsive. The server sanity-checks speed and teleport distance and clamps or rejects bad updates.
- **Server → client:** for each client, only the entities within its interest radius, about 300 m (use a spatial grid with cells about 100 m across). Include a server timestamp and send removals for entities that leave the area.
- **Client rendering of remote entities:** buffer snapshots and render about 100 ms in the past, interpolating between them. Never extrapolate more than about 250 ms.
- **The server is authoritative for:** player joins and leaves, vehicle occupancy (entering a car is a request the server grants or denies, to prevent double carjacking), hits and damage, deaths and respawns, the wanted level, police, pickups, money and missions.
- **IDs:** the server assigns them to every networked entity.

## Phases

### Phase 1: shared players only
- Add the `server/` relay: it tracks players, broadcasts positions with interest management and handles join and leave.
- Client: add `src/net/`, render remote players (on foot and in cars) and add name tags.
- Every client still runs its own NPC simulation, so players see different traffic. That's acceptable for this phase.
- Deploy the server to Fly and the frontend to Cloudflare. The Cloudflare build points at the server through `VITE_SERVER_URL`.
- **Done when:** two browsers on different machines see each other drive around smoothly, and a `fly deploy` reconnects both automatically.

### Phase 2: server-authoritative NPCs
- Extract the simulation from rendering and audio into `src/shared/`: `World`, `Graph`, the `AI` spawn and drive logic, entity physics and combat damage. Rendering and effects stay client-side and are triggered by events or snapshots.
- The server loads `bratislava.json` from disk and runs the NPC AI. Spawn and despawn areas are computed around **all** players, so overlapping areas merge.
- Clients stop simulating NPCs. They render them from snapshots, with local effects only.
- Replace ad-hoc `Math.random` in the shared code with an injectable RNG.

### Phase 3: combat, wanted level and persistence
- Hits are validated on the server, which then handles damage and wanted level per player, with police targeting the right player.
- Player identity: an anonymous UUID token in `localStorage`, sent on connect. Add a nickname.
- Store player progress (money, missions, collectibles) in SQLite on `/data`, replacing `localStorage` saves when online.
- Persist world-critical state periodically and on `SIGTERM`, so deploys lose nothing important.

## Non-goals (for now)

- Rooms, matchmaking or multiple regions.
- Client-side prediction with server reconciliation for the local player. Movement stays client-authoritative.
- Anti-cheat beyond basic server-side sanity checks.

## Why not Cloudflare Durable Objects

It was considered and rejected. A Durable Object is a single-threaded instance with a soft limit of about 1,000 requests/s, and every incoming WebSocket message counts. It also bills per message and can't hibernate while a tick loop runs. That caps a single global world at roughly a few dozen players once the server runs the full simulation. A single Node process on Fly has more CPU headroom and no per-message cost, and restarts happen only when we deploy. To keep migration possible later, keep the game logic in `Room.ts` independent of the transport: it should expose `onMessage`/`tick`/`onJoin`/`onLeave` and never touch `ws` directly.
