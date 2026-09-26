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
- **The level is on the wire.** `STATE` reports carry it in their flags (2 = on a deck, 4 = in a tunnel, both = on the upper deck) and entity records in their head byte (bit 4 = deck, bit 5 = tunnel, both = upper deck). Protocol v4 added -1 and v5 added 2 (and changed the colliders); v6 grew the map (new colliders: traffic islands, lift gates, piers, street furniture) and added three ped states and the `say` event (below). Older clients are refused. The server's hit history stores levels as signed bytes, and shot validation traces walls on the shooter's level.
- **The street's rules send nothing either.** Stop and give-way signs, speed bumps, bus stops and lift gates come from the map (`StreetMarks`, `Gates`): the server's traffic obeys them and clients draw them. A gate's boom snapping is the one exception: each process snaps its own (a car it simulates hit it), which is only a visual.
- **The crowd runs on the server** (`src/shared/sim/Crowd.ts`): pushing bodies apart, seats and tram stops, reactions to guns, horns and shoves, fights and witness calls. Clients see its results as ped states: besides `walk`, `flee`, `dead`, `chase` and `idle`, the 3-bit state field now carries `sit` (on a bench or café chair, facing the way it's posed), `phone` (a witness calling the police) and `fight`. A line someone says is a `say` world event (`{ k: 'say', id, l }`, the line number from `phrases.ts`), shown as a speech bubble over them. Pointing a gun is read from the player's reported weapon and facing, a honk from the `horn` message, and a shove from their figure overlapping someone.
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
- `npm test` runs the codec, simulation, room and persistence tests, `test/shared/traffic.test.ts` (stop signs, bus stops, pulling out round a parked car, and a two-minute soak that no car is stuck in), `test/shared/crowd.test.ts` (bodies, guns, seats, tram stops, fights, witnesses, the new states on the wire), `test/shared/street.test.ts` (islands, bumps, gates), plus `test/shared/world.test.ts`, which drives cars, walks figures and runs trams through the real map with the shared collision code (the UFO, passages, both tunnels, walls and fences, fountains, bollards, both decks of Most SNP, piers and traffic lights, lanes and walking lines clear of walls, cul-de-sacs), and `test/shared/vehicle.test.ts`, which measures the car physics on a test track (top speeds, braking distances, cornering grip, stability).
- `npm run smoke` runs the offline game in headless Chromium.
- `npm run e2e` starts a real server and drives two browser pages through Online. `scripts/e2e-phase2.mjs` checks shared NPC deaths, and `scripts/e2e-phase3.mjs` checks PvP and progress surviving a server restart. `E2E_PHASE=social` and `E2E_PHASE=accounts` cover the social features and Supabase accounts (see `docs/deploy.md`).
- `npm run loadtest` and `npm --prefix server run bench` measure capacity.

## Social features: protocol v7

World events, parties, accounts, revive, races, jobs, the daily puzzle, radio news and proximity voice
(`docs/plans/social-events.md`). Where this section and that plan disagree, this section (and the plan's
own "Implementation notes" addenda) win — they're what actually got built.

### Protocol v7
`PROTOCOL_VERSION` (`src/shared/net/protocol.ts`) is now 7. Exactly as with every earlier bump, an
older client gets `error.code: 'version'` and the "Nová verzia hry" refusal; client and server ship
together (see `docs/deploy.md`).

- **New `ClientMsg`s**: `partyInvite`, `partyLeave`, `partyKick{id}`, `challenge{target}`,
  `challengeAnswer{from, ok}`, `job{op: 'start'|'stop', kind?}`, `giveUp`, `voice{on}`,
  `voiceSig{to, data}`, `report{target, reason}`, `accountDelete`. `hello` gains `join?` (a party invite
  code), `auth?` (a Supabase access token) and `claim?`; `debug` (E2E only) gains `event`, `teleport`
  and `daily`.
- **New `ServerMsg`s**: `wev{ev: EventEntry[], daily: DailyState | null}` — the city-wide state, sent on
  hello, within about 150 ms of a change (see below) and every second while anything is on; `voicePeers{add, del}`,
  `voiceIce{ice}` and `voiceSig{from, data}` for the voice mesh. `welcome` gains `account` and
  `claimed?`; `error.code` gains `'auth' | 'auth-unavailable' | 'nick-taken'`.
- **`ev.g`**: the existing `ev` message (world effects `e`, private events `p`) gains an optional
  `g?: GlobalEvent[]` — news every player hears regardless of where they are: an event starting or
  ending, a most-wanted chase, a race or derby result, the daily puzzle being revealed, hinted or
  solved. `Room.tick()` clears the event buffers before `features[].tick()` runs, so a `GlobalEvent`
  raised from a feature's own `tick()` reaches clients on the *next* tick, not the one it fired in.
- **The `wev` state.** `WorldEvents.version` (the director) bumps whenever an event starts, ends or
  changes phase worth telling the map about; `Room` compares it every tick and, if it's moved on,
  shortens the next `wev` send to within 150 ms instead of waiting for the 1 Hz timer. A feature (only
  `Daily` today) can add its own bit to the same message through the `wev()` `RoomFeature` hook.
- **The 9-field roster.** `RosterRow` grew from 7 fields to
  `[id, nick, x, y, wanted, inCar, pedId, partyId, flags]`. `flags` is `ROSTER_DOWNED` (bit 0),
  `ROSTER_VOICE` (bit 1) and `ROSTER_ACCOUNT` (bit 2). The `roster` message also carries an optional
  `pt: [partyId, tag, colour][]` — every active party's nametag tag, contributed by whichever feature
  tracks parties (`Party.partyTags()`) rather than known to `Room` itself.
- **Binary wire (`src/shared/net/codec.ts`).** `PSTATES` gained `'downed'` (a ped's state bit and the
  local player's own 2-bit state field); `pedDynamic` bit 7 is the downed flag; `vehicleStatic` bits
  2–3 encode `Vehicle.livery` (`LIVERY_NONE`/`KOFOLKA`/`ARMORED`/`DERBY`); `PICKUP_KINDS` gained
  `'goldenCumil'`. A vehicle's dynamic health byte is still `health / spec.health` — see "Anti-abuse
  and known gaps" below for what that means for the armoured van.

### The plug-in architecture
Every social feature is a plug-in, registered once in a small number of files, so five to six
Sonnet agents could build most of this in parallel without touching each other's code
(`docs/plans/social-events.md`'s orchestration table).

- **`SimRule`** (`src/shared/sim/rules/SimRule.ts`): the shared, DOM-free rule interface. `Sim.rules:
  SimRule[]` calls every rule's hooks at fixed points in `step()` and elsewhere —
  `allowPvp`/`allowCrime` (gate an action), `onState` (a play/downed/wasted/busted transition — this
  single hook replaces an earlier `onDown`, and also covers respawns and revives), `onKill`,
  `onEnter`/`onExit`, `onVehicleHit`, `onPickup`, `onAdd`/`onRemove`. A rule only ever reaches players
  through `sim.events` and `sim.payout`, never DOM/audio/`Math.random`, so identical code runs offline
  and on the server. `createRules(sim, mode)` (`rules/index.ts`) builds the list per host: `Jobs` and
  the armoured van's spilled-cash rule (`VanLoot`) run in both modes; `Revive`, `MostWantedWatch` and
  `Race` are server-only, because they need `SimOptions.downed` or another connected player.
- **`WorldEvents`** (`rules/WorldEvents.ts`): the director, itself a `SimRule` that forwards every hook
  to whichever event instances are currently active. `register(def)` adds a `WorldEventDef` (`kind`,
  `minPlayers`, `offline`, `scheduled`, `weight`, `cooldown`, `create()`); a scheduled event starts
  every 7–11 minutes online (12–18 offline) among the ready, weight-drawn candidates, while the
  most-wanted chase only ever starts through `trigger()`. `TimedEvent` is the shared base for an
  announce phase then a live one, each with its own countdown (`onLive()`/`onTimeout()`); an
  instance's `entry()` is exactly what the map and HUD are shown (`EventEntry`).
- **`RoomFeature`** (`server/src/features/RoomFeature.ts`): a server-side plug-in with its own
  client-message handlers (`messages`), `onHello`/`onLeave`/`onDrop`, `tick()`, a `wev()` contribution,
  `shutdown()` and `stats()`. `Room.features[]` (`createFeatures()`, `server/src/features/index.ts`)
  is where parties, voice, accounts, the daily puzzle and the Supabase sinks (`RemoteConfig`,
  `Activity`) all live; unknown JSON message types fall through to whichever feature declared a
  handler for them. Features are *constructed* before any of them is added to `room.features`, so a
  feature must not look up another feature in its constructor — it takes it as a parameter instead
  (`Voice` takes `RemoteConfig` and `Activity`) or looks it up lazily later.
- **`ClientFeature`** (`src/game/features/ClientFeature.ts`): the client-side mirror —
  `update`/`drawWorld`/`drawHud`/`drawMap`/`onGlobal`/`onPrivate`/`onMessage`/`reset`. `Game.features[]`
  (`createClientFeatures()`, `src/game/features/index.ts`) holds the event overlay, the party/revive/
  race/jobs HUDs, the daily card, Rádio Kecy's news ticker and voice chat.
- **`LiveState`** (`src/game/SimHost.ts`): the one place HUD and map code read social-feature state —
  active events, the daily puzzle, this player's party/job/race/challenge/revive — filled identically
  by both hosts: `LocalSimHost` straight from the shared rules, `NetSimHost` from the server's `wev`
  message and private events (`applyLive()`). Neither the HUD nor the map ever branches on which host
  it's talking to.

### Identity
Every player is keyed by a **player key** (`Session.key` in `server/src/Room.ts`), not the raw token —
the existing SQLite `players.token_hash` column keeps its name but now holds this key either way:

- **Guests**: `sha256(guestToken)` (`hashToken()`, `server/src/db.ts`), from the same anonymous UUID
  `hello.token` has always carried. A guest never touches Supabase at all.
- **Accounts**: `'acct:' + userId`. `hello.auth` carries a Supabase access token; `Room.hello()` awaits
  `AuthVerifier.verify()` (`server/src/auth.ts`, ES256 against the project's JWKS, cached and mirrored
  into SQLite so a restart mid-outage can still verify) before accepting — every other message on that
  connection is *held*, not struck, while it's pending.
- **Nicknames.** An account's nickname is reserved case-insensitively unique in SQLite `accounts`
  (`nick_lower`). A brand-new account reserves whatever its first hello sent, or gets `nick-taken` if
  it's gone; an existing account always keeps its stored nickname regardless of what a later hello
  sends (the `nick` message renames it, checking uniqueness again). Guest nicknames stay free-form, as
  before.
- **Claiming.** `hello.claim` (with the device's still-present guest `token`) moves that guest's
  `players`/`sessions` rows into the account (`Store.movePlayer`), only once, and only into an account
  with no progress of its own yet (`store.hasPlayer(acctKey)` must be false). A live guest session
  under that key is sent `bye: 'replaced'` and dropped first, so it can't resurrect the row the move is
  about to overwrite. `src/ui/AccountUi.ts` offers this right after sign-up when local guest progress
  exists, via a flag stashed in `localStorage` across the reload that actually connects online.
- **Deleting an account** (`accountDelete`, GDPR): the SQLite `players`/`accounts` rows are deleted
  synchronously (`Room` never awaits I/O in a tick); the Supabase auth user and that player's
  `activity` rows are removed fire-and-forget through the shared `Supa` client.

### Voice signalling
Voice is a WebRTC mesh — audio is peer-to-peer; the server (`server/src/features/Voice.ts`) only ever
decides *who* may signal *whom*, and relays that signalling over the existing game WebSocket.

- **Opting in** (`voice{on:true}`) is rate-limited per session, a repeat while already on is ignored,
  and at most one TURN mint per session is ever in flight. A player becomes pairable only once their
  `voiceIce` has gone out, so a client never builds a peer connection without its ICE servers.
- **Pairing** runs once a second (`pairVoice()`, pure and unit-tested against plain fixtures): a
  spatial, greedy match over every opted-in, connected, non-AFK player. A pair **links** below 45 m
  (`VOICE_LINK_M`) and stays linked until it drifts past 60 m (`VOICE_UNLINK_M`) — hysteresis, so
  hovering at the edge doesn't flap the connection open and closed. Candidates are sorted nearest-first
  and accepted greedily under a cap of 8 links per player (`VOICE_MAX_LINKS`), so the cap naturally
  keeps each player's *nearest* peers. A tunnel and the surface never link.
- Every add/remove is diffed against the previous link set and sent as one `voicePeers{add, del}` per
  affected player. Each `add` entry carries `polite: id > peerId`, so both ends derive the same
  Perfect-Negotiation role without asking the server which one they are.
- `voiceSig` is relayed only between *currently* linked pairs (checked again at signal time, since a
  link can drop between two messages) and shape-checked (`validSignalShape()`) before forwarding — the
  server confirms a payload looks like SDP/ICE but never otherwise parses it, and it has its own rate
  limit, separate from the connection's general one.
- `voiceIce` sends two public STUN servers (Cloudflare's and Google's, always, no setup needed), plus —
  when `CF_TURN_KEY_ID`/`CF_TURN_API_TOKEN` are set — Cloudflare Realtime TURN credentials minted
  server-side (24 h TTL, cached per session, refreshed a little early). Unset, it's STUN-only, which
  still connects most NAT pairs but not symmetric NAT/CGNAT pairs (see `docs/deploy.md` for setup and
  cost).
- **Reconnects reset voice.** `Voice.onHello` turns a player's voice off on *every* hello, fresh or
  reconnect, and drops their links: a reloaded page has no mic open and the previous
  `RTCPeerConnection`s are dead either way. The client's `VoiceFeature` notices the fresh `welcome`,
  closes its own dead peer connections, and opts back in (fresh signalling, fresh links) if it was on.
- **Client-side** (`src/game/features/voice/`): one `RTCPeerConnection` per peer following the MDN
  Perfect Negotiation pattern; Opus tuned for voice (`usedtx=1;useinbandfec=1`, a 24 kbps cap); a muted
  `<audio>` element per remote track (a Chrome playback workaround) feeding
  `MediaStreamSource → Gain → StereoPanner → voiceBus` (`src/audio/Audio.ts`). Gain is
  `clamp((45 − d) / 40, 0, 1) ^ 1.5` (distance to the peer's mirrored ped), ×0.15 on a level mismatch
  (one player underground, one not), recomputed every frame with `setTargetAtTime`; pan comes from the
  peer's lateral offset. The impolite side restarts ICE once when a connection goes `failed`; if it's
  still not connected 10 s after starting, `poll()` tears the peer connection down and rebuilds it from
  scratch after a 60 s back-off.
- **Moderation.** Push-to-talk is the default mode, any player can mute a peer locally, and "Nahlásiť"
  sends reporter/target/positions/voice-state to Supabase `reports`. Because the audio itself never
  reaches the server, it can't be recorded or reviewed after the fact — moderation leans on accounts
  (bans stick), the `voice_blocklist` and the `voice_enabled`/`voice_requires_account` kill switches
  instead (`docs/deploy.md`).

### Supabase, and why hot state stays in SQLite
Supabase holds **Auth** and **cold, shared** data; every hot per-player value — money, position,
sessions, invite codes, account nicknames, `players.stats` — stays exactly where it always was, in the
server's own SQLite, so a join or a tick never waits on the network.

- `server/src/supa.ts`'s `Supa` client is a thin wrapper over `fetch` against PostgREST/GoTrue/Storage
  — no `supabase-js` on the server. It sends the secret key as `apikey` only (PostgREST treats that as
  `service_role`, bypassing RLS); the one exception is GoTrue's admin API (account deletion), which
  also checks `Authorization`, so that call alone repeats the same secret key there too.
- **Reads and one-shot writes** (`select`/`patch`/`insert`/`rpc`/`deleteRows`/`adminDeleteUser`) are
  plain, awaited calls, for the few things that need a fresh answer right away (the daily puzzle's
  poll, `RemoteConfig`'s reload, account deletion).
- **High-volume writes** (`activity`, `reports`) go through `enqueue()`, a per-table batched queue
  flushed every 5 s and never awaited from a tick or a message handler. A table that starts failing
  (network error, 429, 5xx) backs off exponentially (1 s doubling to a 60 s cap) on its own timer; a
  non-retryable 4xx just drops that one batch and logs why (never the key or the response body). The
  queue is capped at 5,000 rows, oldest dropped first, so a long outage can't grow it without bound. On
  SIGTERM, `shutdown()` abandons any backoff wait and makes one last attempt, bounded to 3 s.
- Every Supabase-backed feature degrades to "off" rather than erroring when it's unset or unreachable:
  `RemoteConfig` keeps its hardcoded defaults, `Daily` shows no puzzle, `Activity`/reporting are
  no-ops. Nothing in the tick ever blocks waiting for any of it.
- What lives where: **Auth** (`auth.users`, Supabase's own schema) for accounts — there's no
  `profiles` table, since nicknames live in SQLite `accounts` next to the rest of the hot profile;
  **`daily_spots`/`daily_spot_secrets`** for "Kde to je?" (the coordinates are in the second table,
  behind RLS with no policies at all, so only the server's secret key can ever read them);
  **`activity`**, an append-only log of every payout share and milestone, for the weekly leaderboard;
  **`reports`** for moderation; **`game_config`** for remote tunables and kill switches; and the
  `spots` Storage bucket for the daily puzzle's photos. Details and day-to-day operation are in
  `docs/deploy.md`.

### Anti-abuse and known gaps
- **Pair cooldowns.** Revive: at most one paid "Dobrý samaritán" bonus per (reviver, victim) pair per
  10 minutes, and 10 per reviver per rolling hour; none at all if the reviver hurt the victim in the
  last 60 s. Závod?: 2 minutes between races for the same pair. Najhľadanejší: a 60-minute cooldown per
  (taker, target) pair on the bounty itself, a separate 5-minute cooldown before the same player can be
  re-triggered as a target at all, and the target must have spent at least 60 s (accumulated) at 5★
  before any takedown or escape pays out anything — tapping 5★ and hiding immediately earns nothing.
- **Party exclusions.** `allowPvp` refuses damage and car-jacking between same-party members; the
  most-wanted bounty never pays a party-mate of the target; a party's payout split (event and job
  money — not race stakes, pickups or the samaritan bonus) only reaches connected members within 300 m
  who are playing or downed.
- **Party invites and kicks.** An invite code is 10 random base32 characters (50 bits, minted at most
  once per 10 s per player, valid 24 h), so guessing one isn't practical. A kicked player can't rejoin
  that party through anyone's invite for 30 minutes, and a member's invite codes die with their
  membership (leaving, a kick, a drop, an account deletion or a claim).
- **Friendly races.** The $50 city prize for a stakeless race is paid at most 3 times per player per
  (sim) day, counted by player id, so renaming doesn't reset it.
- **Derby.** A car counts toward the prize pool and the paid places only if it's still in the fight
  10 s into the live phase, so decoys that drive in and straight out neither inflate the pot nor take
  3rd place. The arena's star amnesty never covers the most wanted target, and it ends without giving
  stars back when a player is wasted or busted (the respawn already set their wanted level).
- **Escrowed stakes are refunded on shutdown.** A Závod? stake leaves both players' accounts the
  moment they accept, before the countdown even starts. It comes back if the race times out after
  5 minutes with nobody finishing, and — on a graceful shutdown (`fly deploy` sends `SIGTERM`) — every
  race still in progress is refunded rather than left to resolve as a deploy-timed forfeit
  (`Race.refundAll()`, run before `Room`'s final save). A race that actually finishes, or that one
  player forfeits by leaving, still pays the stake (doubled) to whoever's left.
- **The golden Čumil's 40 m interest radius.** The `goldenCumil` pickup is only ever included in a
  snapshot within 40 m of a player (`GOLDEN_CUMIL_R`, `server/src/snapshot.ts`) — far tighter than the
  usual entity interest radius — so its exact coordinates can never be read off the wire from across
  the map. Only the hint circle is broadcast at range.
- **The jittered hint circle.** Hon na Čumila's circle shrinks from 450 m to 30 m over six steps across
  five minutes, but its centre is re-randomised within 0.6× the *new* radius at every step
  (`CIRCLE_JITTER`) rather than staying centred on the real target — the circle always contains the
  statue, but its centre alone never gives away exactly where.
- **Crash safety.** Every fire-and-forget promise (Supabase writes, the config poll, the account
  hello's token check, the TURN mint) carries its own `.catch`, and `server/src/index.ts` also logs any
  unhandled rejection instead of letting Node exit: one bad response must never drop every player.
- Every reward is decided server-side and paid through `sim.payout`; the daily puzzle's coordinates
  never reach a client (only the image and the hints do); a guest's claim into an account is one-shot
  and only into an empty one, so progress can't be duplicated.
- **Known gaps, not yet closed** (see `docs/roadmap.md`): the armoured van's raised health pool
  (`Vehicle.maxHealth`) isn't sent over the wire, so a spectator's damage visuals are scaled to the
  base `van` kind's 150 HP rather than its true 600; and derby eliminations and the courier/taxi crash
  check both trust the driving client's *reported* `vehicle.health`, the same way collision damage
  always has online — nothing new validates it server-side.
