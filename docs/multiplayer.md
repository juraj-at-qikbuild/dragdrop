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

## Implementation notes (as built)

All three phases are implemented. Where the build differs from the plan above, this section wins.
Deployment and measured capacity are in [deploy.md](deploy.md).

### One simulation, three hosts
- `src/shared/` is DOM-free (`tsconfig.shared.json` enforces it) and holds the whole game world: `World`/`Graph`, entity state and physics, and `sim/Sim.ts` with AI, police, combat rules, pickups, the clock and per-player state (`SimPlayer`).
- **Offline** single-player runs the same `Sim` in the browser (`src/game/LocalSimHost.ts`), with no caps and a fixed governor, so it plays as before. Saves stay in `localStorage`.
- **The server** (`server/src/Room.ts`) runs one `Sim` for everyone. Every client sees the same NPCs, and an NPC killed by one player is dead for all of them.
- **Online clients** (`src/net/NetSimHost.ts`) run no NPC logic. They render mirrors of snapshot entities (`Mirrors.ts`, interpolated 100 ms behind by `Interp.ts`) and simulate only their own ped and car, which bump into the mirrors.
- The rules code never touches audio or rendering. It emits events (`sim/events.ts`), which `src/game/ClientEvents.ts` turns into effects. On the server, `NetEvents.ts` routes them to the players in range.

### Networking
- **Client → server:** binary `STATE` at 20 Hz (pose, weapon, camera extents, plus the car's full state when driving). Everything else is JSON: `hello`, `fire`, `punch`, `enter`, `exit`, `hit`, `horn`, `nick`, `ping`, `leave`.
- **Server → client:** a binary snapshot every tick, with private state followed by entity records. Only records that changed since the last snapshot are sent; the first sighting also carries a static block. Entities beyond 150 m are refreshed at half rate, and ones that leave interest are listed as removals. Events, roster, clock and profile go as JSON. `src/shared/net/codec.ts` does the encoding.
- **Interest:** 300 m for vehicles, trams, props and helicopters, 200 m for peds, with 30 m of hysteresis.
- **Density:** players' cameras are the spawn/despawn observers. Each player's share shrinks as more join (`playerScale`), under global caps (`SERVER_CAPS` × `NPC_SCALE`) and a load governor that thins the city when ticks run over budget.

### Authority
- **Movement is client-authoritative.** The server rejects NaN and out-of-map reports, and answers speed jumps and teleports with a `correct` message. Every server-side teleport (respawn) bumps the player's `epoch`, and reports from an older epoch are ignored.
- **Players' cars are kinematic on the server**, extrapolated from reports. NPC cars treat them as moving walls, and running over an NPC is detected there.
- **Shots are traced by the client and validated by the server.** It checks the weapon, ammo and fire rate, and that the muzzle is near the reported position. It then rewinds each claimed target through a ~1.2 s position history (`server/src/history.ts`) to the shooter's render time. A claim passes only if the pellet is within the weapon's spread and range, the hit point is close to where the target was, and no wall is in the way (`validate.ts`). Punches are checked for reach and facing against the same history.
- **A player hit by a car or tram reports it** (`hit`). The server checks the source's speed and position in history before applying damage.
- **Entering a car is a request.** The server grants it first come, first served. A car another player is driving can be jacked only when it is nearly stopped, and its driver is ejected.
- **Wanted level, police targeting, the helicopter, roadblocks and spikes are per player**, under world-wide caps. PvP is a crime: `hitPlayer` and `killPlayer` raise the attacker's stars.

### The map in the simulation
- **Everything solid is baked into `bratislava.json`**: building footprints (raised ones such as the UFO on Most SNP are not solid), passages cut through them, walls, fences, hedges and barriers with their gaps, fountain rims, bollards, blocks, planters, statues and columns, tree trunks, tunnel tubes and piers. `World` builds the same colliders from it on the server and in every browser, so a client's own figure and car hit exactly what the server's NPCs hit. The lanes and walking lines fitted to those colliders are baked in too (`MapJSON.fit`), so the server and every client steer NPCs along the same lines without fitting them at startup.
- **Four levels:** -1 in a tunnel (Suché mýto, the castle tram tunnel), 0 on the ground or under a deck, 1 on a bridge deck, 2 on an upper deck that crosses another one (the Most SNP road deck above its footway and cycle deck, the motorway flyovers in Petržalka). `World.updateLevel` moves entities between them at deck ends and tunnel portals, and from one deck onto the other where they meet. Collisions, shots, punches, explosions and police line of sight only connect things on the same level. `raycast` and `collideCircle` take the level, so tube walls only exist underground, street-level walls don't block the tunnel below, and each deck's railings only hold in what is on that deck.
- **The level is on the wire.** `STATE` reports carry it in their flags (2 = on a deck, 4 = in a tunnel, both = on the upper deck) and entity records in their head byte (bit 4 = deck, bit 5 = tunnel, both = upper deck). Protocol v4 added -1 and v5 added 2 (and changed the colliders), so older clients are refused. The server's hit history stores levels as signed bytes, and shot validation traces walls on the shooter's level.
- **Traffic lights send nothing.** A light's state is a pure function of its junction's offset and the world clock (`clock.time × SECONDS_PER_HOUR`). Both cycles divide the 24-minute game day evenly, so the phase never jumps at midnight. The server's traffic obeys the lights, and clients draw them from their own clock, which the server keeps in sync.
- **No `Math.random` in the new rules.** Parking-lot choices use the simulation's `Rng`, and a tram's dwell at a stop is seeded by the stop's index.

### Identity and persistence
- The client keeps an anonymous UUID and a nickname in `localStorage` (`src/net/identity.ts`). The first Online click asks for the nickname; the pause menu can change it.
- `server/src/db.ts` uses SQLite (WAL) on the Fly volume and stores only a SHA-256 of the token. It has three tables:
  - `players`: nickname, money, landmarks found, Čumils collected
  - `sessions`: position, health, armour, weapons, wanted level; valid for 2 h
  - `world`: the clock and weather
- Dirty profiles are written every 5 s, everyone every 30 s, and again on leave and on SIGTERM.
- A reconnect within 30 s gets the same figure and car back. After a deploy, the saved session (or, failing that, the position the client sends in `resume`) puts players back where they were.
- **Missions are single-player only.** Online, the phone booths say so.

### Tests and tools
- `npm test` runs the codec, simulation, room and persistence tests, plus `test/shared/world.test.ts`, which drives cars, walks figures and runs trams through the real map with the shared collision code (the UFO, passages, both tunnels, walls and fences, fountains, bollards, both decks of Most SNP, piers and traffic lights, lanes and walking lines clear of walls, cul-de-sacs), and `test/shared/vehicle.test.ts`, which measures the car physics on a test track (top speeds, braking distances, cornering grip, stability).
- `npm run smoke` runs the offline game in headless Chromium.
- `npm run e2e` starts a real server and drives two browser pages through Online. `scripts/e2e-phase2.mjs` checks shared NPC deaths, and `scripts/e2e-phase3.mjs` checks PvP and progress surviving a server restart.
- `npm run loadtest` and `npm --prefix server run bench` measure capacity.
