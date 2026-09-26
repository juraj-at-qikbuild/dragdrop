# Plan: world events, parties, accounts, city mini-games, radio news and proximity voice (Blava City)

## Context

Blava City already runs one shared online world (protocol v6): a Node `ws` server on Fly runs one `Sim` for
everyone, clients mirror it, and profiles live in SQLite under an anonymous localStorage UUID. Players can
drive, fight and collect, but little makes them meet or cooperate, nothing gives a solo player something to
do online (missions are offline only), and progress is stuck in one browser. This change adds:

- server-run **world events** announced on the map and the radio (Horúca Kofolka, Najhľadanejší, Hon na
  Čumila, Obrnené auto, Derby na parkovisku)
- **parties with invite links** and **revive**
- **guest or account play**: accounts use Supabase Auth with email and password
- three city mini-games (**Kde to je?**, **Závod?**, **Vlk/Hopík jobs**)
- **Rádio Kecy breaking news**
- **proximity voice chat**, for accounts only

Supabase holds accounts (Auth), the daily-puzzle content, analytics and moderation data. The aim is more
reasons to meet, cooperate and come back daily, with "send a link and play together" as the growth loop.

## Decisions

1. **Rules go in the shared `Sim`, transport and identity in `Room` features, and UI in client features.**
   This keeps today's "one simulation, three hosts" split (`LocalSimHost`, `Room`, `NetSimHost`). The PvE
   subset then runs offline for free, and every rule is unit-testable against the real map.
2. **Protocol v7, bumped once in Phase 0** with every new message and bit declared up front. The server
   refuses older clients as it does today. Client and server ship together, exactly as v6 did.
3. **Persistence is split for performance (your call).** SQLite keeps all hot per-player state: money,
   sessions, the clock, invite codes, account nicknames and a new `players.stats` JSON. It's synchronous and
   local, so a join or a tick never waits on the network. Supabase holds Auth plus cold, shared data: the
   daily puzzle (tables plus Storage images), the `activity` log with its leaderboards, `reports` and
   `game_config` (remote tunables and kill switches).
   - The server uses plain `fetch` to PostgREST with the `apikey: <secret>` header only.
   - Writes go through a batched, fire-and-forget queue and are never awaited in the tick.
   - Everything degrades to "feature off" when Supabase is unset or unreachable.
4. **Guests and accounts (your call: email and password; only voice needs an account).**
   - Guests keep today's local UUID, which involves no Supabase at all, so the fast path of "open the link
     and play" never depends on it.
   - Accounts use `@supabase/auth-js` in the browser with `flowType: 'pkce'`, which keeps the URL hash free
     for `#join`. It's lazy-loaded, about 24 KB gzipped, so guests don't download it.
   - The game server verifies the ES256 access token locally against Supabase's public signing keys
     (JWKS), using `jose`, with no network call per join.
   - Profiles are keyed by player key: `sha256(guestToken)` for a guest, `acct:<user id>` for an account.
   - A guest can **claim** their progress into a brand-new account, once.
   - Account nicknames are unique; guest nicknames stay free-form.
5. **Voice is a WebRTC peer-to-peer mesh (your call)**, for accounts only.
   - The server pairs nearby opted-in players (at most 8 peers each).
   - Connection setup (signaling) is relayed over the existing game WebSocket, only between paired players.
   - ICE uses Cloudflare STUN, plus optional Cloudflare Realtime TURN credentials minted by the server.
   - Playback goes through a Web Audio gain per peer, driven by distance every frame. `audio.volume` is
     read-only on iOS, so Web Audio is the only option there.
6. **Kde to je? images are pre-rendered** by a headless-Chromium script that drives the real renderer in a
   photo mode, then uploaded to Supabase Storage under random names. Only the server ever sees the
   coordinates, which live in a secret table.
7. **Plug-in registries** (`SimRule`, `RoomFeature`, `ClientFeature`), plus every wire bit, SQLite column and
   env var reserved in Phase 0. Each Sonnet agent then mostly adds new files plus one registration line,
   which keeps parallel work mergeable.
8. **Invite links carry an opaque server-minted code** (`…/#join=fero-k3x9q2`; the nick part is only
   decoration), because nicknames aren't unique.

## Phase 0: foundations

### 0a Core contracts (main agent, sequential)

Start with `npm ci`, then `npm --prefix server ci`, then a green baseline of
`npm test`, `npm run build` and `npm --prefix server run typecheck`.
Commit this plan as `docs/plans/social-events.md` so that agents working in worktrees can read their
section.

**Protocol v7 (`src/shared/net/protocol.ts`)**

- `HelloMsg` gains `join?: string`, `auth?: string` (a Supabase access token) and `claim?: boolean`. The
  guest `token` is still always sent.
- `WelcomeMsg` gains `account: boolean` and `claimed?: boolean`.
- `error.code` gains `'auth' | 'auth-unavailable' | 'nick-taken'`.
- New `ClientMsg` types:
  - `partyInvite`, `partyLeave`, `partyKick{id}`
  - `challenge{target}`, `challengeAnswer{from, ok}`
  - `job{op:'start'|'stop', kind?:'courier'|'taxi'}`
  - `giveUp`
  - `voice{on}`, `voiceSig{to, data}`, `report{target, reason}`
  - `accountDelete`
  - `debug` gains `event`, `teleport`, `daily` and `stars`
- `ServerMsg` changes:
  - `ev` gains `g?: GlobalEvent[]`.
  - New `wev{events: EventEntry[], daily: DailyState|null}`: full replace at 1 Hz, on change (debounced to
    at most 1/s) and on hello.
  - New `voicePeers{add:{id, polite}[], del:number[]}`, `voiceIce{iceServers}` and `voiceSig{from, data}`.
- `RosterRow` becomes `[id, nick, x, y, stars, inCar, pedId, partyId, flags]`, where flags bit0 = downed,
  bit1 = voice on and bit2 = account. The roster also carries `pt: [partyId, tag, colour][]`.
- `PROTOCOL_VERSION = 7`.

**Identity and persistence (`server/src/Room.ts`, `server/src/db.ts`, `server/src/config.ts`)**

- `Room` sessions and the `Store` are keyed by **player key** instead of the raw token. The existing
  `players.token_hash` column keeps its name and holds the player key.
- `RoomOptions.auth?: AuthVerifier {verify(token): Promise<{userId, email}|null>}`. `hello` with `auth`
  awaits it:
  - Messages arriving on that connection before the welcome are ignored, not struck.
  - With no verifier configured, an `auth` hello gets `auth-unavailable`.
- SQLite `MIGRATIONS[1]`:
  - `players.stats TEXT DEFAULT '{}'`
  - `invites(code PK, inviter_key, created_at, expires_at)`
  - `accounts(user_id PK, nick, nick_lower UNIQUE, created_at)`
- `config.ts` reads every new env var:
  - `SUPABASE_URL ?? GTA_BRATISKA_SUPABASE_URL ?? GTA_BRATISKA_SUPABASE_PROJECT_URL` and `SUPABASE_SECRET_KEY ?? GTA_BRATISKA_SUPABASE_SECRET_KEY`
  - optional `CF_TURN_KEY_ID` and `CF_TURN_API_TOKEN`
  - `AUTH_DISABLED` for tests

**Events (`src/shared/sim/events.ts`)**

- `SimEvents.global(e: GlobalEvent)`, implemented in `nullEvents`, `server/src/NetEvents.ts` (collected
  once per tick) and `src/game/ClientEvents.ts`.
- `GlobalEvent` is a typed union with `x,y` where a place matters (for news):
  - `eventAnnounce`, `eventStart`, `eventEnd{kind, winner?, amount?, x, y}`
  - `mostWanted{nick, x, y}`, `mostWantedEnd{nick, by?, how, amount}`
  - `holder{kind, nick}`
  - `raceResult{winner, loser, dest, amount}`
  - `derbyResult{winners[]}`
  - `dailyReveal`, `dailyHint{level, text}`, `dailySolved{nick}`, `dailyAnswer{x, y}`
  - `revived{by, who, x, y}`
- New `PrivateEvent` kinds:
  - `party{s}`, `invite{code}`
  - `job{s}`, `race{s}`, `challenge{from, nick, stake, dest}`, `revive{s}`
  - `payout{amount, reason, x, y}`, `teleport{x, y, lvl, epoch}`
  - `down.state` gains `'downed'`.

**Codec (`src/shared/net/codec.ts`)**

- `PSTATES += 'downed'`.
- `pedDynamic` bit 7 = downed.
- `vehicleStatic` flags bits 2–3 = livery enum (0 none, 1 Kofolka event, 2 armoured, 3 derby).
- `PICKUP_KINDS` gets `'goldenCumil'` appended.

**`src/shared/sim/rules/SimRule.ts`**

```ts
interface SimRule { id: string; step?(dt): void; allowPvp?(a, v): boolean; allowCrime?(p, kind, target?: SimPlayer): boolean;
  onDown?(victim, by?): void; onKill?(victim, killer): void; onEnter?(p, v): void; onExit?(p, v): void;
  onVehicleHit?(v, dmg, byPid, hx, hy): void; onPickup?(p, pk): void; onRemove?(p): void }
```

**`Sim.ts` changes**

- `rules: SimRule[]` and `payoutPolicy?`.
- `payout(p, amount, reason, x?, y?)` applies the split policy, calls `addMoney`, then `onProfileChange`.
  `addMoney` alone never marks the profile dirty.
- `teleport(p, x, y, lvl)` bumps the epoch and sends a `teleport` private event.
- `crime(p, kind, victim?, target?: SimPlayer)`:
  - `hurtPlayer` and `killedBy` pass the victim.
  - The first line consults `allowCrime`.
- `hurtPlayer`:
  - First checks `allowPvp`, which also gates jacking a player's car in `enterVehicle`.
  - Damage to a downed player finishes them off.
  - Lethal damage calls a new `down(p, killer)` when `SimOptions.downed` is set (server only). `down()`:
    - sets state `'downed'` with `stateTimer` 25 s
    - pulls the player out of any car
    - raises the killer's `killPlayer` crime and runs the `onDown` hooks
  - Drowning and car explosions still call `wasted()` directly.
  - Bleed-out falls through to the existing `respawn()`.
- The other hooks go in `killedBy`, `enterVehicle`/`exitVehicle`, `updatePickups`, `removePlayer` and the
  end of `step()`.
- `Pickup.tag?` is a server-only source marker.
- `SimPlayer` gets `partyId`, `voiceOn` and `account`. Features only set them; the roster rows and their
  flags are built in 0a.

**Other shared pieces**

- `CombatRules.applyShot`, car branch (`src/shared/sim/Combat.ts` ~146): calls
  `onVehicleHit(car, dmg, pid, pl.hx, pl.hy)`.
- `src/shared/sim/rules/WorldEvents.ts`: the director. It holds a registry of
  `WorldEventDef {kind, minPlayers, offline, weight, cooldown, start(sim): EventInstance|null}`, and each
  `EventInstance {step(dt): boolean, entry(): EventEntry, end(reason)}`.
  - A scheduled event starts every 7–11 min when none is active, respecting per-kind cooldowns and player
    counts.
  - Scheduled events have an announce phase (30 s, or 90 s for the derby).
  - Triggered events (Most Wanted) use `director.trigger()`.
- `EventEntry {id, kind, phase, endsAt, x?, y?, r?, holder?, pot?, alive?, zone?: number[]}`.
- `src/shared/sim/rules/Zones.ts`: named polygons plus `zoneAt()`, built on `pointInRings`
  (`src/shared/util/math.ts`).
- `src/shared/sim/rules/placeName.ts`: turns a position into a Slovak phrase with the right case ("na Moste
  SNP", "pri Eurovei"). It tries, in order: a hand-written locative table for the 52 landmarks and 24
  squares, then `world.streetName`, then `quarter`, then `district`.
- `World.places(kind)` helper.
- `src/shared/sim/rules/index.ts`: `createRules(sim, 'offline'|'server')`.

**Server (`server/src/features/RoomFeature.ts`)**

```ts
{ id; messages?: {[t]: (room, s, msg) => void}; onHello?(room, s, isNew, msg); onLeave?; onDrop?; tick?(room, dtMs); wev?(): Partial<WevMsg> }
```

- `Room` gets a `features[]` registry.
- The `default:` branch of `onMessage` dispatches to the feature before striking.
- `wev` is broadcast next to the roster timer.

**Client (`src/game/features/ClientFeature.ts`)**

```ts
{ id; update?(g, dt); drawWorld?(g, ctx, view); drawHud?(g, ctx); drawMap?(g, ctx, toScreen, full); onGlobal?(g, e); onPrivate?(g, e) }
```

- It is called from `Game.update/draw`, `MapView.blips` and `ClientEvents`.
- `SimHost.live: LiveState {events, daily, party, job, race, revive, challenge}` is filled by
  `LocalSimHost` from the rules and by `NetSimHost` from `wev` and private events. HUD and map features
  never branch on the host.
- `src/main.ts` gets a `parseBootLinks()` stub returning `{online, join, photo, authCallback, reset}`. Each
  agent then fills in its own branch.

**Key reservations (`src/game/Input.ts`)**

| Key | Action |
|---|---|
| V | push-to-talk |
| N | party panel |
| J | jobs |
| K | Kde to je? card |
| G | give up while downed |
| H (hold) | race challenge / accept |

Gamepad: button 10 = push-to-talk, button 14 = jobs.

Everything above lands without behaviour change: no events are registered, `downed` is off and there is no
auth verifier. The existing tests must stay green.

### 0b Infrastructure (3 Sonnet agents in parallel, after 0a is committed)

**I1: Supabase data plumbing**

- `server/src/supa.ts`:
  - fetch client that sends `apikey` only
  - a per-table batched insert queue, flushed every 5 s with exponential backoff
  - a queue cap of 5,000 rows
  - a 3 s flush on SIGTERM
  - `select`, `patch`, `rpc` and admin helpers
- `server/src/features/RemoteConfig.ts`: `game_config` loaded at boot and every 60 s, with typed defaults.
- `server/src/features/Activity.ts`: `room.activity.log(kind, p, amount, meta)`.
- `supabase/migrations/20260926110000_social_events.sql` (schema below). Later schema changes are new migration files (`npx supabase migration new <name>`), never edits to applied ones.
- `scripts/supa-check.mjs`: verifies the tables, the RLS rules (anon cannot read the secrets, activity or
  reports) and the bucket.
- Tests use an injected fake `fetch`.

**I2: client UI kit**

- `src/ui/kit/`:
  - an announcement banner queue
  - an active-event HUD list with timers
  - a hold-progress ring
  - an image card
  - DOM panel and modal helpers
- A `MapView` overlay API: markers, labels, and a `pulsingCircle()` extracted from `searchZone()`
  (`src/ui/MapView.ts` ~249).
- A nametag decoration API in `src/render/nametags.ts`: a prefix tag with colour, plus icons for downed and
  talking.
- A `#pause-extra` settings container in `index.html`, plus a localStorage settings helper.
- The generic `wev`/private-event → `LiveState` plumbing in `NetSimHost` and `LocalSimHost`.

**I3: accounts.** The spec is under Features → Accounts. I3 owns:

- `server/src/auth.ts`
- the account paths in `server/src/features/Account.ts`
- `src/net/auth.ts`
- `src/ui/AccountUi.ts`
- the `authCallback` and `reset` branches of `parseBootLinks`
- `supabase/templates/*`

### 0c Pause: Supabase setup by you

Wave 1 continues meanwhile, because every feature degrades gracefully without Supabase.

1. Apply the migrations with the Supabase CLI on your machine, so they're recorded in the migration history: `npx supabase link --project-ref eejvrdvzteyrwlhjfnfx` once, then `npx supabase db push`. This container can't reach Postgres directly: it only has HTTPS through a proxy, and the database host is IPv6-only.
2. Add `GTA_BRATISKA_SUPABASE_PROJECT_URL` to this environment.
3. If the environment's network policy blocks `*.supabase.co`, allow it.
4. Set up Auth: see Setup below.

`scripts/supa-check.mjs` then confirms the setup.

## Feature specs

Every number is a default that can be tuned through `game_config`. Every payout goes through `sim.payout`.

### Accounts: guest or Supabase Auth (I3; online)

- **Menu.** The **Online** button (and any `#join` link) opens a "Ako chceš hrať?" modal:
  - **Hrať ako hosť**: today's nickname prompt and local UUID; it's the default button, so invite links
    stay one click.
  - **Prihlásiť sa**: email and password.
  - **Vytvoriť účet**: email, password (≥8 characters) and a nickname (`cleanNick`).
  - A stored session skips the modal and connects as the account.
  - A pending `#join` code is kept in `sessionStorage` across the whole flow.
- **Client (`src/net/auth.ts`):**
  - `@supabase/auth-js` is imported dynamically, only when the modal opens, a `?code=` callback is present,
    or a stored session exists (custom `storageKey: 'blava-city-auth'`).
  - It uses `flowType: 'pkce'`.
  - Sign-up calls `signUp({email, password, options: {data: {nickname}, emailRedirectTo}})`, then shows
    "Potvrď e-mail". The confirmation link comes back as `?code=`, which auth-js exchanges for a session.
  - Password reset uses `resetPasswordForEmail`. The `?reset=1` return (the `PASSWORD_RECOVERY` event)
    opens a new-password modal, which calls `updateUser({password})`.
  - Before every (re)connect the client calls `getSession()`, which also refreshes the token, and sends
    `hello.auth`.
  - `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` enable it. When they're unset, the account
    buttons are hidden and play is guest-only.
- **Server (`server/src/auth.ts`):**
  - `jose` `createRemoteJWKSet(${SUPABASE_URL}/auth/v1/.well-known/jwks.json)` verifies the token with
    ES256 pinned, `iss = ${SUPABASE_URL}/auth/v1`, `aud = 'authenticated'` and `exp`, and rejects
    `is_anonymous`.
  - The last JWKS is persisted in the SQLite `world` table, so a restart during a Supabase outage can still
    verify tokens.
  - If the project still uses the legacy HS256 secret, rotate to asymmetric keys in the dashboard (see
    Setup).
  - An invalid token gets `error:'auth'`. The client refreshes once and then offers guest play.
- **Nicknames:**
  - On an account's first hello, the nickname is reserved in `accounts`, case-insensitively unique.
  - If it's taken, the server answers `nick-taken` and the client asks again.
  - After that, the stored nickname is the one used. Changing it with the `nick` message checks uniqueness
    again.
- **Claim:**
  - `hello.claim` with the device's guest `token` moves that guest's `players`/`sessions` rows to
    `acct:<id>`.
  - It happens only if the account has no progress yet, and at most once.
  - Afterwards the client discards the guest token; a later guest session starts fresh.
  - The UI offers it right after sign-up when local guest progress exists.
- **Pause menu:**
  - "Prihlásený ako Fero · Odhlásiť sa · Zmazať účet".
  - Guests see "Vytvor si účet: postup na všetkých zariadeniach + hlasový chat".
- **Deleting an account (GDPR):** `accountDelete` makes the server:
  - delete the SQLite rows
  - call `DELETE ${SUPABASE_URL}/auth/v1/admin/users/{id}` with `apikey: <secret>`
  - delete that player's `activity` rows
  The client then signs out.
- **Slovak email templates** go in `supabase/templates/{confirm,reset}.html`, for you to paste into the
  dashboard.
- **Tests:**
  - Room tests with a fake `AuthVerifier`: account hello, an invalid or expired token, `nick-taken`, claim
    only once and only into an empty account, delete, and a reconnect on a second "device" resuming the
    same profile.
  - `auth.ts` unit tests against a local ES256 key and JWKS from `jose`.

### World events (director in 0a; each kind is a `WorldEventDef` in `src/shared/sim/rules/events/`)

**Horúca Kofolka** (`Kofolka.ts`; online; needs ≥2 players)

- A `van` with the Kofolka-event livery and `mission=true` (so it doesn't despawn) is parked at a kerb on a
  car link 500–1500 m from the players' centroid and ≥150 m from any player.
- It carries a pot of $1,500 that drains to its driver at $10/s, credited every second. The HUD shows a
  running counter, and the floating "+$" text appears every 5 s.
- The event ends when the pot is drained, after 8 min, or after 3 min with nobody taking the van.
- If the van is wrecked, the remaining pot spills out as 10 `dropCash` pickups.
- The van shows on everyone's map through `wev` at 1 Hz, and on screen through the normal snapshot.
- The existing rule that a player's car can only be jacked at ≤2 m/s already creates the
  box-in-and-ram dynamic.
- **New:** gunfire can burst tyres, for all cars. A pellet that hits within 0.6 m of a wheel point sets
  `tyresBurst`; a player's car is told through the existing `{k:'tyres'}` private event.
- Tests:
  - unit: spawn, drain, spill
  - room: money accrues to whoever currently drives; `wev.holder` updates

**Najhľadanejší** (`MostWanted.ts`; online; ≥2 connected players; one target at a time)

- Triggered when a player first reaches 5★. The server announces it.
- While the target stays at 5★, they get +$100 each minute and the bounty grows by $150/min, from a $300
  start.
- A takedown (downed or killed) by another player pays the bounty to the taker, split with their party.
- `allowCrime` suppresses the `hitPlayer` and `killPlayer` stars for any hit on the target.
- A police bust, a police kill or a bleed-out voids the bounty.
- Dropping below 5★ for 60 s counts as escaping: the target gets +50% of the bounty.
- Anti-collusion:
  - no bounty when taker and target share a party
  - a 60 min cooldown per pair
  - the target must have survived ≥60 s at 5★
  - every payout is logged to `activity`
- The map shows the target from the roster; the target id comes from `wev`.

**Hon na Čumila** (`CumilHunt.ts`; online and offline; 1+ players)

- A `goldenCumil` pickup appears at a live-RNG ped-graph node 400–1200 m from the players' centroid, using
  the same placement method as `Pickups.ts`.
- The "pops out of a manhole" part is a client animation only; there is no manhole data.
- The pickup is sent in snapshots only within 40 m, via a pickup-kind interest radius in
  `server/src/snapshot.ts`.
- The hint circle shrinks from 450 m to 30 m in six steps over 5 min, always containing the target, with a
  jittered centre. It is drawn gold on the minimap and the map.
- The first to touch it wins $600 and `stats.golden++`. The event times out after 7 min.

**Obrnené auto** (`ArmoredVan.ts`; online and offline; needs ≥2 players online)

- The van is the `van` kind with the armoured livery and flag. Bullet damage is ×0.2 except in the rear
  zone, and its health is 600.
- It drives a bank→bank→bank route (`world.places('bank')`, 44 banks, each leg 1–2 km by road) by setting
  the AI's `driver.route` from `world.car.path` (`src/shared/sim/AI.ts` ~582). It stops 15 s at each bank.
- **Rear doors:**
  - `onVehicleHit` computes the local zone the way `Vehicle.applyDamageAt` does.
  - Rear hits drain 100 door HP.
  - When the doors burst, the van stops and 12 pickups worth $1,200 in total spill behind it, tagged
    `'van'`.
- **Police:**
  - The players who hit the rear within 10 s get a new `robbery` crime, +2★.
  - Each van-cash pickup gives the new `loot` crime, +1★, with a 10 s cooldown.
- The event ends when the van is robbed, delivered, wrecked (the remainder spills) or after 6 min.

**Derby na parkovisku** (`Derby.ts`; online; needs ≥3 players; alternates between Aupark and Eurovea)

- The arena is the largest `areas.parking` ring within 250 m of the `aupark` or `eurovea` landmark, found
  through `Zones`.
- **Announce, 90 s:**
  - The arena outline appears on the map.
  - 6 unlocked `classic` cars with the derby livery spawn inside it.
- **Live, 3 min**, for players inside the arena:
  - Wanted level is stored on entry and restored on exit, so police don't follow and nobody wipes their
    stars by driving in.
  - `allowCrime` is false for every kind.
- A car is eliminated when:
  - its client-reported `health` is ≤10% or it is `wrecked`
  - its driver is on foot
  - it has been outside the arena for more than 3 s
- The last car standing wins; at the timeout, the highest health % wins.
- The prize pool is $300 × participants (capped at $2,400), split 60/25/15. The derby is cancelled with
  fewer than 2 cars.

### Partia + invite link (`server/src/features/Party.ts`, `src/game/features/PartyUi.ts`; online, guests too)

- The party panel (N) lets you invite, copy or share the link, leave, or kick (leader only).
  - The server mints a 6-char base32 code, rate-limited to one per 10 s, valid 24 h, with one active code
    per inviter. It is stored in SQLite `invites`.
- **Joining from a link:**
  - The `join` branch of `parseBootLinks` forces online mode. It shows the guest/account modal only if there
    is no stored identity, and sends `hello.join`.
  - If the inviter is online, the joiner is added to their party and placed next to them: at spawn for a
    new session, or through `sim.teleport` for an existing one.
  - Otherwise the joiner gets a toast ("Fero je offline") and spawns normally.
- **Party rules:**
  - Up to 4 members; the leadership passes on if the leader leaves.
  - A party dissolves when it has no connected members.
  - `SimPlayer.partyId` is set.
  - `allowPvp` blocks same-party damage and car-jacking.
  - `payoutPolicy` splits event and job payouts evenly among members within 300 m. Race stakes, pickups and
    the Samaritan bonus are not split.
- **Visibility:**
  - Nametags show `[TAG]` (the leader's first 4 letters) in the party colour.
  - Members are highlighted with names on the minimap and the map.

### Revive (`src/shared/sim/rules/Revive.ts`, `src/game/features/ReviveUi.ts`; online)

- The downed core is in 0a.
- **Reviving:**
  - Another player on foot, on the same level, within 2 m for 3 s continuously revives the downed player
    at 40 HP with no fee.
  - The reviver gets the +$100 "Dobrý samaritán" bonus.
- **Anti-farm:** no bonus if the reviver hurt the victim in the last 60 s, at most one paid revive per pair
  per 10 min, and at most 10 per hour.
- **While downed:**
  - The player crawls at 0.8 m/s (enforced client-side) and can't fire or enter cars; the server rejects
    both.
  - G gives up, which sends the player to hospital right away.
  - A cop on foot within 2 m busts a downed player who is wanted (`src/shared/sim/AI.ts` `copOnFoot`).
- **UI:**
  - a lying pose in `drawPed.ts`, from pedDynamic bit 7
  - a "Pomôž mu vstať" prompt with the hold ring
  - a bleed-out vignette with a countdown
  - a downed icon on the map

### Kde to je? (online to win)

- **Photo mode** (`src/game/features/PhotoMode.ts`, reached through `?photo`):
  - It boots the world with no NPCs or players at a fixed 13:00, dry.
  - It uses the renderer sequence that `Game.draw` uses. MapView's offscreen pattern (`MapView.image()` ~75)
    proves the renderer can draw an arbitrary view.
  - The camera is north-up, about 45 m wide, with a small red ✕ at the target.
  - It exposes `window.__photo.candidates(n, seed)` and `__photo.render(spot)`.
- **Candidate spots:**
  - courtyards: walkable points with buildings within 30 m in at least 9 of 12 raycast directions
  - `data.crossings`, `data.passages`, squares, riverside points
  - roofs: buildings mapped in parts with distinctive roof shapes, with the target at the nearest walkable
    point
  - each must be reachable on the ped graph and at least 80 m from landmarks and the fixed Čumils
  - the mix is spread across all three boroughs
- **`scripts/spots-gen.mjs`** (`npm run spots:gen -- --days 30 [--from] [--dry]`):
  - It runs `vite preview` and playwright-core with Chromium at `/opt/pw-browsers/chromium`, like
    `scripts/smoke-offline.mjs`.
  - It exports a 960×640 WebP per spot.
  - It uploads the image to the `spots` bucket as `<uuid>.webp`, with `x-upsert`.
  - It inserts a `daily_spots` row with `reveal_at` = 18:00 Europe/Bratislava.
  - It inserts a `daily_spot_secrets` row with x, y, level, a 6 m radius and hints.
  - `--dry` writes a local contact sheet for curation instead.
- **`server/src/features/Daily.ts`:**
  - A 60 s `setInterval` outside the tick fetches today's rows by the Bratislava wall-clock date (not
    `sim.clock`).
  - At `reveal_at` it sets `wev.daily` to the image URL and the hints revealed so far, and emits
    `dailyReveal`.
  - Hints reveal the district after 20 min, the quarter after 40 min and the street after 60 min.
  - Each tick it checks every connected player who is on foot and on the same level against the target
    radius.
  - The first player within 6 m wins $1,000, not split, and `stats.dailyWins++`. The server then PATCHes
    `solved_nick`/`solved_at`, logs the win to `activity` and emits `dailySolved`.
  - If the spot is still unsolved at the next day's reveal, `dailyAnswer` is broadcast.
- **UI:** a HUD card under the minimap with the thumbnail; K enlarges it.

### Závod? (`src/shared/sim/rules/Race.ts`, `src/game/features/RaceUi.ts`; online)

- **Challenging:**
  - Hold H for 1.2 s while driving slower than 3 m/s, with another player's car within 6 m. The client sends
    `challenge`.
  - The server re-validates: both players in cars and playing, within 8 m, neither in a race or the derby,
    and a 2 min cooldown per pair.
- **Destination:**
  - The server picks a landmark whose road route from the pair's midpoint node is 1.0–2.0 km long, using
    A* with `Graph.path` and summing `edge.len`.
  - It tries at most 12 candidates, ordered by straight-line distance.
- **Stake and accepting:**
  - The stake is min($250, the poorer player's money). Under $20 it becomes a friendly race with a $50 city
    prize, at most 3 per day.
  - The target has 15 s to accept by holding H.
- **The race:**
  - Stakes go into escrow and a 3 s countdown starts. The client locks the throttle during the countdown
    and sets a GPS waypoint (`src/game/Gps.ts`).
  - The first player within 20 m of the destination wins 2× the stake and `raceResult` is broadcast.
  - After 5 min both stakes are refunded. If one player leaves or drops, the other wins by forfeit.

### Vlk courier / Hopík taxi (`src/shared/sim/rules/jobs/`, `src/game/features/JobsHud.ts`; online and offline)

- J opens the job picker. Per-player job state lives in `SimPlayer.job`, and payouts go through
  `sim.payout`.
- **Courier:**
  - Pick up at a `food` place 200–900 m away (418 exist, drawn with Vlk branding).
  - Deliver to an address node 600–1800 m away.
  - At both ends, stop below 2 m/s within 10 m for 1 s.
  - The timer is road length ÷ 8 m/s + 60 s.
  - The order's condition drops by 25 on each crash, detected by a car health drop of ≥3% within 0.5 s.
    At 0 the order is spilled and the job fails.
  - Pay is $50 + $0.06/m, plus up to 50% time bonus, plus tips.
- **Taxi:**
  - Needs a car; a `taxi`-kind car earns +25%.
  - The fare is a spawned civilian with raised hands 150–500 m ahead, or waiting at a `taxi` stand.
  - The fare boards when you stop within 6 m below 1 m/s.
  - The destination is a landmark or place 800–2500 m away.
  - Pay is $30 + $0.08/m.
  - The passenger's mood drops by 30 on each crash; at 0 they bail out.
- **Tips:** while carrying, passing within 1.2 m of a vehicle or pedestrian at a relative speed above 8 m/s
  without contact earns $5, capped at 12 per job. The shared rule detects this, so it works identically on
  the server and offline.
- **Chaining:** the next offer arrives 5 s after a job, with a 20 s cooldown after a failure.
- **Stats:** `stats.deliveries` and `stats.fares`.
- **UI:** reuses `drawObjective`, the countdown and `drawArrow` from `src/ui/Hud.ts`.

### Rádio Kecy breaking news (`src/game/features/News.ts`; online and offline)

- It consumes `GlobalEvent`s and turns them into Slovak template lines (3–5 variants per kind) using
  `placeName()`.
- A priority queue allows at most one line per 20 s and drops lines older than 60 s.
- Lines are shown through `game.radioText` as "📻 Rádio Kecy – MIMORIADNE: …" with a synthesized news
  sting.
- Lines are spoken with `speechSynthesis` only when the player is in a car with the radio on, a Slovak voice
  exists (checked with `getVoices()`), and the "Hlásateľ" setting is on (it defaults to on).

### Proximity voice (`server/src/features/Voice.ts`, `server/src/turn.ts`, `src/game/features/voice/`; accounts only)

- **Server:**
  - A `voice{on}` message opts a player in or out. It is refused unless all three hold:
    - `session.account` is true, when `game_config.voice_requires_account` is on (the default)
    - `game_config.voice_enabled` is on
    - the player is not on the `voice_blocklist` (a list of account ids)
  - The server pairs players once per second through a spatial grid:
    - a pair links below 45 m and unlinks above 60 m
    - they must be on a compatible level (tunnel vs not)
    - each player keeps their 8 nearest peers
  - It sends `voicePeers` deltas; `polite = id > peerId`, so both sides derive it identically.
  - `voiceSig` is relayed only between linked pairs, with its own token bucket.
  - `voiceIce` sends STUN (`stun.cloudflare.com:3478`) plus Cloudflare TURN credentials, minted through
    `POST https://rtc.live.cloudflare.com/v1/turn/keys/$ID/credentials/generate-ice-servers` with a 24 h TTL
    and cached per session.
  - Without TURN it sends STUN only.
- **Client:**
  - Guests see "Hlasový chat je len pre prihlásených" with a sign-in button.
  - `getUserMedia({echoCancellation, noiseSuppression, autoGainControl, channelCount: 1})` is called only
    from the opt-in gesture. `navigator.audioSession.type = 'play-and-record'` is set where supported.
  - There is one `RTCPeerConnection` per peer, following the MDN perfect-negotiation pattern.
  - Opus is set to `useinbandfec=1;usedtx=1`, and `maxBitrate` to 24 kbps.
- **Remote audio:**
  - Each remote track is also attached to a muted `<audio>` element, a Chrome workaround.
  - It then runs `MediaStreamSource → Gain → StereoPanner → voiceBus`. The `voiceBus` is new in
    `src/audio/Audio.ts`, under `master`.
- **Volume:**
  - Each frame the gain is set to `clamp((45 − d) / 40, 0, 1)^1.5`, measured from that player's mirrored
    ped in `host.peds`, using `setTargetAtTime`.
  - A level mismatch multiplies the gain by 0.15.
- **Recovery:** on `failed`, the peer calls `restartIce()` once. After 10 s the connection is closed, with a
  60 s back-off.
- **Talking:**
  - Push-to-talk (V) toggles `track.enabled`; an open-mic mode is also available.
  - A 🎙 icon appears on the nametag, driven by `getSynchronizationSources().audioLevel`.
  - A local mic meter uses an `AnalyserNode`.
- **Pause-menu settings:**
  - mode: Vypnutý / Stlač V a hovor / Otvorený mikrofón
  - microphone choice
  - voice volume
  - a first-enable warning
- The full map's player list offers per-player mute and **report**. Reports go to `reports` with the
  reporter's and target's account ids, positions and nicks.
- Because the audio is peer-to-peer, it can't be recorded server-side. Moderation therefore relies on
  accounts (bans stick), push-to-talk as the default, mute, reports, the blocklist and the kill switch.
- Stretch: party members hear each other up to 300 m as a band-passed "radio".

## Supabase schema (`supabase/migrations/20260926110000_social_events.sql`)

Auth uses Supabase's built-in `auth.users`. No `profiles` table is needed, because account nicknames live
in SQLite next to the rest of the hot profile.

- **`daily_spots`** (public): day PK, image_path, reveal_at, solved_nick, solved_at. RLS: anon may
  `select` only rows where `reveal_at <= now()`.
- **`daily_spot_secrets`**: day PK→FK, x, y, level, radius, kind, hint_district, hint_quarter,
  hint_street. RLS is on with no policies, so only the server's secret key can read it.
- **`activity`**: id identity, at, kind, player (the player key), nick, amount, meta jsonb. Indexed on
  (kind, at desc). RLS on, no policies.
- **`reports`**: id, at, reporter, reporter_nick, target, target_nick, reason, context jsonb. RLS on, no
  policies.
- **`game_config`**: key PK, value jsonb, updated_at. RLS on, no policies. It is seeded with
  `voice_enabled`, `voice_requires_account`, `voice_blocklist` and the event tunables.
- **`public.leaderboard_week()`**: a security-definer SQL function (`set search_path = ''`) that returns
  nick, money earned and wins per kind for the current ISO week. `grant execute` to anon.
- **Storage:** `insert into storage.buckets (id, name, public) values ('spots', 'spots', true)`. There is no
  `storage.objects` select policy, so images can be read by URL but the bucket can't be listed.

## Orchestration: main agent for architecture and merges, Sonnet agents for the build

Every subagent runs with `model: "sonnet"`, in its own git worktree (`isolation: "worktree"`), in the
background. Each gets:

- its spec section (from `docs/plans/social-events.md`)
- the Phase-0 contracts
- the files it owns (see the ownership table)

Subagent rules:

- Symlink `node_modules` (root and `server/`) from the main checkout rather than installing. New
  dependencies (`jose` on the server, `@supabase/auth-js` on the client) are installed by the main agent
  in 0a.
- Keep shared code DOM-free, with no `Math.random` (use `sim.rng`), no I/O awaited in the tick, and money
  only through `sim.payout`.
- Write Slovak UI strings inline.
- Add tests.
- Run `npm test`, `npm run build` and `npm --prefix server run typecheck`.
- Commit on the worktree branch without pushing, then report the files changed and the test output.

The main agent reviews each diff for architecture compliance, then merges into
`claude/world-events-teaming-plan-54itrj`, resolves conflicts, runs the full checks plus smoke and e2e
serially, and pushes after each wave.

| Wave | Agents (parallel) | Owns (new files, plus the few shared files listed) | Depends on |
|---|---|---|---|
| 0a | main | the contracts above, including identity keys, the SQLite migration, config env and deps | – |
| 0b | I1 Supabase data · I2 UI kit · I3 Accounts | I1: `server/src/supa.ts`, `features/{RemoteConfig,Activity}.ts`, SQL, `supa-check.mjs` · I2: `src/ui/kit/*`, `MapView.ts`, `nametags.ts`, `index.html`, `NetSimHost`/`LocalSimHost` LiveState plumbing · I3: `server/src/auth.ts`, `features/Account.ts`, the claim and nickname paths in `Room.hello`, `src/net/auth.ts`, `src/ui/AccountUi.ts`, `supabase/templates/*` | 0a |
| 1 | A1 Kofolka + Čumil hunt · A2 Revive · A3 Party · A4 Voice · A5 Kde to je? | A1: `rules/events/{Kofolka,CumilHunt}.ts`, `snapshot.ts`, `Combat.ts` (tyres), `drawVehicle.ts` livery · A2: `rules/Revive.ts`, `drawPed.ts`, AI `copOnFoot` · A3: `features/Party.ts`, the `join` branch of `parseBootLinks`, the roster `pt` tags · A4: `features/Voice.ts`, `turn.ts`, `src/game/features/voice/*`, `Audio.ts` `voiceBus` · A5: `PhotoMode.ts` and the `photo` branch of `parseBootLinks`, `scripts/spots-gen.mjs`, `features/Daily.ts`, `DailyCard.ts` | 0a, 0b |
| 2 | B1 Najhľadanejší · B2 Závod? · B3 Jobs · B4 Rádio Kecy | B1: `rules/events/MostWanted.ts` · B2: `rules/Race.ts`, `RaceUi.ts` · B3: `rules/jobs/*`, `JobsHud.ts` · B4: `News.ts`, the `placeName` table, TTS | B1 needs A2 + A3; the others need 0a |
| 3 | C1 Obrnené auto · C2 Derby | C1: `rules/events/ArmoredVan.ts`, new crimes in `Sim.ts` · C2: `rules/events/Derby.ts`, `Zones` usage | director (0a), A1 patterns |
| 4 | D1 e2e scenarios · D2 docs · D3 adversarial review | D1: `scripts/e2e-social.mjs` · D2: `README.md`, `docs/multiplayer.md`, `docs/roadmap.md`, `docs/deploy.md` · D3: read-only review with a findings list | all |

Registration lines in `rules/index.ts`, `features/index.ts` and `src/game/features/index.ts` are the only
expected conflicts, and they are trivial.

## Verification

- **Each wave:**
  - `npm test`: shared rule unit tests with the real map, plus `server/test/room.test.ts` scenarios using
    `FakeLink`/`FakeClock` and the new `debug{event, teleport, stars, daily}` messages. Account tests use a
    fake `AuthVerifier` and a local ES256 JWKS.
  - `npm run build`: tsc, then the DOM-free shared guard, then vite. A bundle check confirms auth-js sits in
    its own lazily loaded chunk.
  - `npm --prefix server run typecheck`.
  - `npm run smoke`, extended with offline Čumil-hunt, jobs and armoured-van checks.
- **`npm run e2e` plus a new `E2E_PHASE=social`** (two or three headless Chromium pages against a real
  server):
  - an invite link spawns the friend next to the inviter, with no friendly fire and the party tag in the
    roster
  - a revive works
  - a forced Kofolka event pays its holder, and `wev` reaches every page
  - a race challenge runs to its finish
  - voice works end to end: with Chromium's `--use-fake-ui-for-media-stream --use-fake-device-for-media-stream`,
    both pages get `voicePeers`, reach the `connected` state, and see a remote `audioLevel` above 0. The
    pages use account sessions, or `voice_requires_account=false` under `E2E=1` when there's no Supabase.
- **`E2E_PHASE=accounts`**, once Supabase is set up:
  - The script creates a confirmed test user through `POST /auth/v1/admin/users` (`email_confirm: true`)
    and signs in through `POST /auth/v1/token?grant_type=password`.
  - Progress follows the account to a second page with a different guest token.
  - A guest's progress is claimed once.
  - Voice is refused for a guest.
  - The test user is deleted at the end.
- **Load:** `npm run loadtest` with 100 bots, comparing `tickAvg` and `snapshotBytes` against the pre-change
  baseline.
- **Supabase:** after you've run the SQL:
  - `node scripts/supa-check.mjs`, which checks among other things that anon is denied the secrets and
    activity
  - `npm run spots:gen -- --days 3 --dry`, review the images, then generate 30 real days
  - a server run with the URL set proves a daily reveal and solve by injecting today's spot
- **Manual:** `npm run dev:server` plus `npm run dev`, with `VITE_SERVER_URL`, `VITE_SUPABASE_URL` and
  `VITE_SUPABASE_PUBLISHABLE_KEY` set, in two browser windows: one guest, one account.

## Setup you'll need (and at deploy time)

**This environment**

- Add `GTA_BRATISKA_SUPABASE_PROJECT_URL`.
- Let the network reach `*.supabase.co`.

**Supabase: SQL**

- Apply the migrations with `npx supabase db push`, after `npx supabase link --project-ref eejvrdvzteyrwlhjfnfx` once. Use the CLI rather than the SQL editor, so the migration history stays right.

**Supabase: Auth**

- **Email provider:** enabled, with "Confirm email" on (both are the defaults).
- **URL Configuration:**
  - Site URL = your production URL.
  - Redirect URLs: `https://<prod>/**`, `https://*.workers.dev/**`, `http://localhost:5173/**` and
    `http://localhost:4173/**`.
- **JWT Keys:** confirm the project uses ES256 asymmetric keys. If it shows the legacy HS256 secret,
  "Migrate", then "Rotate".
- **Emails:** paste the Slovak templates from `supabase/templates/`.
- **Custom SMTP before launch** (Resend, Postmark or SES, for example). The built-in sender allows only
  2 emails per hour.
- Optional: CAPTCHA with Turnstile, under Bot and Abuse Protection.

**Fly**

- `fly secrets set SUPABASE_URL=… SUPABASE_SECRET_KEY=…`
- Optional: `CF_TURN_KEY_ID` and `CF_TURN_API_TOKEN`, from Cloudflare dashboard → Realtime → TURN. TURN is
  free up to 1,000 GB/month shared, then $0.05/GB.

**Cloudflare Workers Builds**

- Set `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY`. Accounts need them; without them the game
  is guest-only.

**Deploy**

- Ship client and server together (protocol v7), as with v6.

## Risks and mitigations

- **Tick budget** (shared-cpu-1x, 12 ms budget):
  - Rules index their own active instances and never scan every player per tick without need.
  - Voice pairing runs at 1 Hz, and the daily-puzzle fetch runs outside the tick.
  - Token verification is async and happens only at hello.
  - At most one active instance of each scheduled event.
  - Timings per rule are exposed in `Room.stats()`.
- **Bandwidth:** `wev` goes out at 1 Hz, debounced. Roster rows grow by 2 fields. Voice audio never touches
  the server.
- **Cheating:**
  - Every reward is decided on the server.
  - Stakes are held in escrow.
  - Pair cooldowns and party exclusions block bounty, revive and race farming.
  - The daily coordinates never reach clients; the image name is random and the bucket can't be listed.
  - The golden Čumil is sent only within 40 m.
  - A claim is one-shot and only into an empty account, so progress can't be duplicated.
- **Auth availability:**
  - Guests never touch Supabase.
  - Accounts verify locally against a cached JWKS that is persisted in SQLite. If it truly can't verify, the
    client offers guest play.
  - The built-in SMTP limit is the main launch trap, so it's in Setup.
- **Voice safety:** it's accounts-only and opt-in with push-to-talk by default, with mute and report, a
  server blocklist and a kill switch. Peer-to-peer audio can't be moderated after the fact.
- **Supabase outage or free-tier pause:** writes are fire-and-forget with a bounded queue, and config uses
  hardcoded defaults. A missed daily fetch skips the day. The server's regular traffic keeps the project
  from auto-pausing after 7 days.
- **Protocol v7:** old clients get the existing "Nová verzia hry – obnov stránku." message. Deploy client
  and server together, at a quiet hour.

## Implementation notes: Phase-0 contracts as built

Where this section and the text above disagree, this section wins.

- **Rule hooks** (`src/shared/sim/rules/SimRule.ts`):
  - The single `onState(p, from, to, by?)` hook replaces `onDown`. It covers play → downed, wasted or
    busted; downed → play (revived) or wasted (finished off, or bled out: a bleed-out is always
    downed → wasted, then the usual respawn, so rules can tell it from a revive); and respawns
    (wasted or busted → play).
  - `onAdd` and `onRemove` fire when players come and go.
  - `PayoutReason` lists the reasons parties may split.
- **Rules modules** must `import type` from `../Sim`, never import it as a value. `Sim.ts` imports
  `rules/index.ts`, so a value import would be a runtime cycle.
- **Director** (`rules/WorldEvents.ts`):
  - `register(def)`, `start(kind, arg?)`, `trigger(kind, arg?)`, `get(kind)`, `entries()`, `changed()`
    (the hosts then resend `wev`), `stopAll()` and `config` (gaps, retry, enabled).
  - Events implement `EventInstance`: `update(dt): boolean`, `entry()`, `stop()`, plus any SimRule hooks,
    which the director forwards to them.
  - `TimedEvent` gives an announce phase and a live phase with `tick(dt)`, `onLive()` and `onTimeout()`.
  - `EventEntry.left` is the number of seconds left when the entry was sent.
- **`Sim`:**
  - The `rules` array; `rule<T>(id)`.
  - `payout(p, amount, reason, x?, y?)`, which splits through `payoutPolicy`, sends `{k:'payout'}` and
    calls `onProfileChange`.
  - `teleport(p, x, y, lvl)`, which bumps the epoch and sends `{k:'teleport'}`.
  - `SimOptions.rules` is `'offline' | 'server'` (the hosts already pass it) and `SimOptions.downed`
    defaults to off. The rules run at the end of `step()`.
- **`Room`:**
  - `features` (from `server/src/features/index.ts` `createFeatures(room)`) and `director`.
  - `broadcast()`, `sendTo(session, msg)`, `wallNow()`, `sessionById(id)`, and public `store` and `debug`.
  - Unknown JSON messages go to the feature that declared a handler for them.
  - `ev.g` carries `GlobalEvent`s to everyone.
  - `wev` goes out on hello, soon after `director.version` changes, and every second while anything is on.
  - Roster rows have 9 fields (`ROSTER_DOWNED`, `ROSTER_VOICE`, `ROSTER_ACCOUNT` flags).
- **Client:**
  - `Game.features` (from `src/game/features/index.ts` `createClientFeatures(g)`).
  - `ClientFeature` hooks: `update`, `drawWorld`, `drawHud` (called after `Hud.draw`), `drawMap` (called
    from `MapView.blips`, for the minimap and the full map), `onGlobal`, `onPrivate` (after the built-in
    effects), `onMessage` (for the voice messages) and `reset`.
  - `SimHost.live: LiveState` with `emptyLive`, `applyLive` and `eventLeft` (`src/game/SimHost.ts`).
  - `NetView.tagFor` also returns `partyId` and `flags`.
  - `parseBootLinks(hash, search)` is in `src/boot/links.ts`.
  - `KEYS` is in `src/game/Input.ts` (gamepad: L3 = push-to-talk, d-pad left = jobs).
- **Wire (v7):**
  - `Vehicle.livery` uses `LIVERY_*`; `Ped.downed`.
  - `PSTATES` includes `'downed'`.
  - The `goldenCumil` pickup kind.
  - `Pickup.tag` is never sent.
- **Tests:** `test/shared/contracts.test.ts` covers these contracts.

## Implementation notes: what the Wave 0b/1 merges settled

These notes also win over the text above.

- **Payouts are logged once, centrally.** `Sim.onPayout(p, amount, reason)` fires for every share of
  every payout, and `Room` logs it to Supabase `activity`. A feature must not log a payout to
  `activity` again.
- **World-event placement.** `rules/events/placement.ts` has `centroidOf(sim)` and
  `clearOfPlayers(sim, x, y, minD)`; use them rather than a local copy.
- **Hidden positions stay on the server.** An event whose point is secret (the golden Čumil) never puts
  that point in `entry()`, `eventAnnounce`, `eventStart` or a place name; it uses a jittered hint
  circle instead. The pickup itself goes out in snapshots only within 40 m (`server/src/snapshot.ts`).
- **Timing of GlobalEvents from features.** `Room.tick()` clears the event buffers before
  `features[].tick()`, so a `GlobalEvent` emitted from a feature's `tick()` reaches clients on the next
  tick. Tests tick once more before reading `ev.g`.
- **Features are constructed before they're registered.** `createFeatures()` builds every feature
  before `Room` adds them to `room.features`, so a feature must not look up other features
  (`room.remoteConfig`, `room.activity`) in its constructor. Pass them in (as `Voice` does), or look
  them up lazily.
- **Fire-and-forget I/O always carries a `.catch`.** An unhandled rejection takes the whole server
  down.
- **Accounts on the client.** `NetSimHost.account` comes from `welcome.account`, the server's answer.
  - `resolveOnlineIdentity()` (`src/ui/AccountUi.ts`) picks the account when a Supabase session is
    stored, otherwise the guest. Every online entry uses it: `#online`, `#join` and a reload.
  - `askNick` lives in `src/ui/askNick.ts`.
  - `window.openAccountModal` opens the account chooser (the voice feature calls it for guests).
- **Reconnects.** On a reconnect, `NetSimHost` forwards the new `welcome` to every feature's
  `onMessage`. Features with per-connection server state start over there. Voice is one: the server
  turns a player's voice off on every hello and every lost connection, and `VoiceFeature` closes its
  peers and opts in again.
- **Kde to je? content** is generated with `npm run spots:gen`. It drives `?photo`, which is loaded on
  demand and draws no signs, ads or tram-stop names (`Renderer.labels`/`StreetDetail.labels` are off
  there).
