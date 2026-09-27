# Plan: deeper gameplay, in five phases (Blava City)

Status: Phases 1 and 2 implemented (27 September 2026); Phases 3–5 planned. Where the build differs
from this plan, see [Phase 1 as built](#phase-1-as-built) and [Phase 2 as built](#phase-2-as-built) at
the end.

This plan is about how the game plays, not about new missions. Every phase builds on systems that
already exist (the police, the money, the driving model, the crowd, the parties, the leaderboard) and
makes them matter more.

## Context

How it works today:

- **Losing the police is purely a matter of line of sight.** Once no police car within 70 m, cop
  within 40 m or helicopter within 24 m can see the player, a circle opens where they were last
  seen (40 m, growing 4 m/s to 120 m). Outside it, unseen for 9 + 1.5 × stars seconds, the player
  loses a star (`Sim.updateWanted`).
  - The police don't care what the player is driving. Switching cars changes nothing.
  - Police sight is a circle. A car sees as far behind it as ahead, and just as far at 3 a.m. in
    the rain as at noon.
  - Several units know where the player is even when nobody sees them. Reinforcements spawn around
    the player's real position (`AI.policeSpawn`). Cops on foot walk straight to them
    (`AI.copOnFoot`). The helicopter follows them exactly, with its 24 m view right on top of them
    (`Helicopter.update`). Roadblocks go up ahead of wherever they're really heading
    (`Police.pickAheadLink`). Only the police cars themselves search the circle (`AI.drivePolice`).
  - A witness's report puts the search wherever the police last saw the player, which can be
    minutes old and across the city, not where the crime happened.
  - A crime counts as seen by the police whenever a cop is within 45–60 m, whether or not they're
    looking (`copNear` in `Sim.crime`).
  - The spray shop (€250) clears every star.
- **Money has almost nowhere to go.** It comes in from missions, jobs, world events, races,
  bounties, landmarks (€100), Čumils (€250) and, offline, combos. It goes out only at the spray
  shop and as the 10% respawn fee. Race stakes move it between players.
- **Driving is the best part, but the scoring stops offline.** Drift and near-miss combos pay cash
  offline (`Juice`), online they only charge nitro (`NetSimHost.styleCash` is a no-op).
- **There's one way to move besides walking: a car.** Trams run on their real tracks, but a player
  can't board them. The car-free Old Town is closed by real bollards the police can't cross, but
  nothing fast gets through it. The Danube drowns a swimmer in 1.5 s.
- **On foot, combat is standing and shooting.** There are four weapons (fists, pistol, uzi,
  shotgun), no dodge, and no answer to the helicopter, which can't be hit.
- **Friends can play together, but not in the same car.** Partia (up to 4) shares payouts and turns
  off friendly fire, but everyone drives their own car.
- **The city forgets.** A shoot-out leaves no mark once the stars are gone. Day and night change the
  traffic and crowds (0.7× and 0.6× at night) and rain costs grip, and that's all.

## Goals

1. **Getting away is a skill.** The police act on what they see and what they're told, and the
   player can read and use that: sight lines, darkness, cover, a change of car, lying low.
2. **Rewards have a purpose.** Money buys things worth having, and losing it hurts less than
   losing what it bought.
3. **More ways to move, drive and fight,** each with a use that the others don't have.
4. **Friends play in the same car, and on both sides of the law.**
5. **The city remembers** what players did in it, and the time of day matters.
6. **Nothing becomes a free exit.** Every new way out of trouble has a cost, a counter or a cooldown,
   and each comes with a test.

## The phases

| Phase | Theme | What players get | Wire |
|---|---|---|---|
| **1** | Outsmarting the police | Police who look for a car, not a GPS dot. Sight cones that shrink at night and in rain. Lying low. A searchlight you can dodge. What the police know, on the minimap and HUD. Police radio. Bribes. | Protocol 7, optional additions only |
| **2** | Money with a purpose | A garage and a car collection, tuning, a gun shop, a clothes shop, cash that drops where you die, a lawyer | Protocol 7, optional additions only |
| **3** | Behind the wheel, and new ways around | Combos that count online, new combo moves, slipstream, damage you feel, sirens and an ambulance, e-scooters and bikes, trams you can ride and drive, swimming and boats | Protocol bump (new vehicle kinds, riding a tram) |
| **4** | Fighting, alone and together | Passenger seats, players on duty as police, revenge bounties, a dive and cover, weapons with a clear job, knock-downs, shooting the helicopter down | Protocol bump (seats, more weapons) |
| **5** | A city that remembers | District heat, turf for parties, a time of day that matters, things that just happen, a rank | Optional additions |

The order is by value and by what each phase needs from the ones before it:

- Phase 1 needs no new content. It deepens the loop players already play most (crime, chase,
  getaway), and later phases lean on it: the clothes shop (Phase 2) changes the police's
  description, players on duty (Phase 4) hunt with the same sight rules, and district heat
  (Phase 5) raises the patrols the chase meets.
- Phase 2 gives money a purpose before Phases 3–5 add more ways to earn it.
- Phase 4's passenger seats don't depend on Phases 2–3. If co-op becomes the priority, they can
  move ahead of them.

Each phase ships on its own and is split into steps that can each be merged separately. The wire
changes of a phase that needs a protocol bump are declared once, up front, as they were for v7.
Wherever a phase can instead add only optional fields and messages, as Phases 1 and 2 do, it stays
on protocol 7.

---

## Phase 1: Outsmarting the police

### What players get

| When | What the player sees | What the police do |
|---|---|---|
| **A crime** | The stars. A cop who didn't see it doesn't count; a witness may still phone it in, and the police then search where it happened, for the car used. | They know where it happened and what the player was in (the description). |
| **Being chased** | On the minimap, the sight cone of every unit in the chase: red while they see the player, blue while they search. A chip under the top panel: "🚔 Hľadajú: červená Felícia". | Cars chase what they see, and radio it: while anyone sees the player, every unit knows where they are. |
| **Breaking line of sight** | The stars flash, the search circle opens, "?" over any unit that's looking at the player but hasn't recognised them. | Cars, cops on foot and the helicopter search the circle. Reinforcements come in around the circle, not around the player. Roadblocks stop going up. |
| **A different car** (or out on foot) | "Nepoznajú ťa" on the chip. The stars fade faster. | A unit that sees the player needs a longer look to recognise them (instant up close). Once it does, the description changes: "Pozor, podozrivý prestúpil!" |
| **Lying low** (still, out of sight, for 3 s) | "Pritajený" on the chip, "v úkryte" in a car park or under cover. The stars fade faster, even inside the circle. At night a still car's lights are off. | They drive past a dark parked car without noticing it, unless they come close or look long enough. The helicopter can't see under a roof, a passage or a bridge deck. |
| **Night and rain** | Shorter cones on the minimap. At night the helicopter's beam sweeps the circle and is drawn where it really is. | Every unit sees less far. At night the helicopter sees only what its beam lights. |
| **Arrested at 1–2★** | "ZATKNUTÝ", then "[F] Podplatiť policajta: €300" for 5 s. | Paid: the cop pockets it and walks off. The stars go, and the player keeps their guns. |
| **All the way** | Rádio "Vysielačka" lines: the search, the description, a change of car, the search called off. | |

### Decisions

1. **Sight is a cone, and it shrinks at night and in the rain.** Every number is a tunable in
   `src/shared/sim/sight.ts`.

   | Unit | By day, clear | Cone | All round (close) |
   |---|---|---|---|
   | Police car in the chase (siren on) | 70 m | ±60° | 14 m |
   | Cop on foot | 40 m | ±70° | 8 m |
   | Helicopter | 30 m circle under it | – | – |
   | Helicopter at night | its beam: 10 m round where it points | – | – |

   - Range × (1 − 0.4 × darkness) × (1 − 0.2 × rain). Darkness (0–1) comes from the same day curve
     the renderer shades the city with, moved to shared code. Full night alone: 42 m for a car, 24 m
     on foot.
   - A still car at night (lying low, lights off) is seen from only 0.7× as far.
   - The close range doesn't shrink: nobody walks up to a cop unseen.
   - Sight also needs a clear line (`World.raycast`), and nobody sees into or out of a tunnel, as
     today.
   - *Rejected:* street lamps lighting the player up. It's a good next step, but every lamp would
     then be a sight check.
2. **Crimes need eyes.** A crime is seen by the police when a police car (patrolling or chasing) or a
   cop on foot has the player in sight when it happens. Otherwise a witness may phone it in, as
   today. This replaces the 45–60 m radius. Crimes against the police themselves are always seen.
3. **The police look for a description.**
   - It's the car the police last saw the player in (its id and colour), or "on foot".
   - It's updated whenever they see the player, and by every crime: they know where it happened and
     what the player was in. A witness's report carries where the crime happened and the car used
     then, however long the call took.
   - A player who matches it is seen as soon as a unit has them in sight, as today.
   - A player who doesn't (a different car, a new colour, on foot) is recognised only after a unit
     has watched them for 1 s + 1 s per 20 m (so 3 s at 40 m), twice as long while they lie low.
     Within the close range, recognition is instant.
   - The progress is the player's (0–1). It rises while any unit watches (at the nearest one's rate)
     and falls at 0.4/s otherwise. Clients see it as the "?" over the watching unit.
   - Recognised: the description becomes the new car, with "Pozor, podozrivý prestúpil!".
   - *Rejected:* per-unit memory, where each unit knows only what it saw. Dispatch shares everything
     the moment one unit sees the player, which is how it already works for positions, and it's
     readable.
4. **When they've lost the player, the police search; nobody homes in.**
   - Police cars drive to random points in the circle (as today). They chase directly only while the
     player is seen and they have a clear line.
   - Cops on foot go to the last-seen spot, then to random points in the circle. They draw on and
     arrest only a player who's seen.
   - Reinforcements spawn off-screen within 60 m of the circle and within the player's NPC range,
     or not at all.
   - A pursuing car's progress, which recycles cars that stop closing in, is measured to where
     it's going (its search point), not to the player's real position.
   - Roadblocks and spike strips go up only while the player is seen or was seen in the last 5 s.
   - The helicopter follows a seen player. Otherwise it flies from one search point to the next, its
     beam sweeping, and it fires only at a seen player.
5. **Lying low: standing still out of sight makes the stars fade faster, even inside the circle.**
   - After 3 s still (under 0.6 m/s) and unseen, the player is lying low.
   - The unseen timer runs at 1× normally, ×1.4 while they don't match the description, +0.4 while
     they lie low, and +0.4 more in a hideout, up to 2.2× in all.
     - A hideout is a car inside a mapped car park or street-side bays, or anyone under cover: in a
       building passage, under a roof or canopy, under a bridge deck, or in a tunnel.
   - Outside the circle, stars fade as today (9 + 1.5 × stars s of the timer per star). Lying low,
     they fade inside it too, where the searching units are.
   - The helicopter can't see anyone under cover.
6. **Úplatok: at 1–2★, an arrest can be bought off.**
   - It's only offered to a player who hasn't shot at the police (`shotCops`).
   - The arrest then waits 5 s instead of 4, with the offer: €150 per star.
   - Paid: the money goes, the stars go, and the arrest is off. No weapons are taken and there's no
     fee. The cops lose interest.
   - Refused: a second bribe within 10 min ("Tentoraz ti to neprejde."), or not enough money.
   - A bought-off chase scores no getaway points. Offline, a mission fails when the player is taken to
     the station, not when they're cuffed, so a bribe saves it.
   - *Rejected:* bribes at 3★ and up. Cops at 3★ shoot rather than arrest, and a bribe shouldn't
     end a real chase.
7. **Protocol 7 stays.** Every addition is optional, as with pausing and the leaderboard:
   - A new private event `police`: the pursuit as the player may know it (description, recognition
     progress, lying low). Older clients ignore it.
   - A new private event `bribe`: the offer. Older clients ignore it and are arrested as before.
   - A new client message `bribe`, sent only in answer to an offer, so never to an older server.
   - The helicopter's `tx, ty` (already on the wire) now carry where its beam points. Older clients
     draw it a little off.

### Design

**Shared (`src/shared`)**

- `sim/sight.ts`: the sight table, `darkness(hour)`, `sightFor(kind, dark, rain)` and a cheap
  `inSight(from, facing, sight, x, y)` (range and cone; the caller does the raycast). The sim
  decides with it and the minimap draws with it, so the cones on screen are the cones in the sim.
- `sim/Pursuit.ts`: the chase per player, moved out of `Sim.updateWanted` and grown:
  - who sees the player, recognition, the description and the "police know where you are" moment
    (a crime, a report, a sighting);
  - lying low and hideouts;
  - the unseen timer, star fading, getaways;
  - the `police` status event, sent when it changes;
  - the bribe (`offer`, `bribe`).
- `SimPlayer`: `desc`, `spot`, `still`, `low`, `lastSeenAt`, `bribeAt`, `bribeOffer`.
- `AI`: `drivePolice` (direct pursuit only when seen, progress to the search point), `copOnFoot`
  (search without a sighting, shoot and arrest only when seen), `policeSpawn` (around the circle
  while searching).
- `Police`: the helicopter's search and its sight, and roadblocks and spikes only while the player is
  seen or just lost.
- `Helicopter`: a beam that eases toward where it looks and sweeps while searching, and fires only
  when told the target is seen.
- `World`: `covered(x, y, level)` (under a roof, a passage, a bridge deck or in a tunnel) and
  `inParking(x, y)` (the mapped car parks and bays).
- `Crowd.witness`: the call remembers where the crime happened and the car used.
- `Sim.crime`: police eyes (`Pursuit.policeWatching`) instead of `copNear`.

**Client**

- `src/game/features/PoliceUi.ts` (a `ClientFeature`):
  - the chip ("🚔 Hľadajú: …", "Nepoznajú ťa", "Pritajený · v úkryte", the recognition bar);
  - the "?" and "!" over police units;
  - the Vysielačka lines;
  - the bribe prompt.
- `MapView`: the cones and the helicopter's view on the minimap and the city map.
- `drawHeli`: the beam at its real point and size.
- `LiveState.police` and `LiveState.bribe`, kept by `applyLive` for both hosts.
- `SimHost.bribe()`.
- Keys: the use key (F, Enter, E, the pad's Y) pays the bribe. On a touch screen, a "busted" context
  shows a button for it.
- Missions fail an arrest at `respawn` rather than at `down`.

**Server**

- `server/src/features/Police.ts`: the `bribe` message → `Pursuit.bribe`.

### Steps

1. `sight.ts`, `World.covered` and `World.inParking`, with tests.
2. `Pursuit`: sight, recognition and the description, crimes that need eyes, witness reports at the
   crime scene.
3. The search without homing: `drivePolice`, `copOnFoot`, `policeSpawn`, roadblocks, the helicopter.
4. Lying low and the unseen timer's rates.
5. The `police` event, `LiveState.police`, the chip, the "?" and "!", the minimap cones and the beam.
6. The Vysielačka lines.
7. Úplatok: the offer, `Pursuit.bribe`, the server feature, the prompt (keys, pad, touch), and
   missions failing at the station.
8. Docs: the README's wanted system, `docs/multiplayer.md`, this plan's as-built notes.

### Verification

- **`test/shared/pursuit.test.ts`** against the real map:
  - a police car doesn't see a player behind it (outside the cone, beyond 14 m), does ahead, and
    always does close by;
  - the same car sees a player 55 m ahead at noon but not at midnight;
  - a crime behind a patrol car's back isn't seen by it, and a witness's report puts the search where
    it happened;
  - a player who changed cars out of sight is recognised only after the right time, at once up
    close, and the description follows;
  - while searching, cops on foot head for the circle, not the player; reinforcements spawn near the
    circle; no roadblocks go up;
  - stars fade faster in a different car, faster still lying low, fastest in a hideout, and lying
    low works inside the circle;
  - at night the helicopter sees only in its beam, never under cover, and never fires at a search
    point;
  - bribes: accepted at 1–2★ with the money, refused at 3★, after shooting at the police, within
    10 min and without the money. A bribe leaves the guns and scores nothing.
- **`test/shared/sight.test.ts`**: cones, ranges, darkness through the day.
- **`server/test/police.test.ts`**: a busted player's `bribe` through the Room, an unoffered or
  repeated `bribe` doing nothing.
- The existing suites (`npm test`), `npm run build`, `npm run smoke` and `npm run smoke:mobile`.

### Risks

- **Too easy.** Lying low in a car park after changing cars fades the stars at 2.2×: from 5★ to
  none in about 30 s. But it takes breaking the line of sight, a car change nobody saw, and
  sitting still where the search is going on. Units still recognise the player up close, and the
  numbers are tunables.
- **Too hard to read.** Cones, the chip and the "?" say what the police know. Each
  sight rule has a visible counterpart.
- **Police that never find anyone.** While the player is seen, everything works as before
  (dispatch shares the position). Searching units still cover the circle, and reinforcements come
  in around it.
- **Server cost.** One cone check per nearby unit per wanted player per tick, and a raycast only for
  units whose cone holds the player. Negligible next to the crowd.
- **The bribe as a money exploit.** It only ever costs money, and the 10 min cooldown and the
  `shotCops` rule keep it from being a routine way out.

---

## Phase 2: Money with a purpose

Players get things worth buying, at real places: guns, clothes, a lawyer, tuning, and a garage for
the cars they're proud of. Losing money becomes a risk, not a formality.

### What players get

| Where | What |
|---|---|
| **Poľovnícke potreby** (3 gun shops: by Michalská brána, Eurovea, Aupark) | Walk in: a pistol (€250), an uzi (€700) or a shotgun (€900) with a box of ammo, a bulletproof vest (€300). |
| **Butik** (3 clothes shops: Kamenné námestie, Eurovea, Aupark) | A jacket in any of ten colours (€150), a cap, a hat, a helmet or a scarf (€120). The police look for what the player wore when they last saw them. |
| **Advokátska kancelária** (by the Primate's Palace) | A lawyer on retainer (€500): the next arrest keeps the guns and halves the fee. |
| **Dielňa** (the 9 fuel stations, the old spray shops) | Stop in one, not wanted: paint of the player's choice and a repair (€250); engine I–II (€900, €1,800); plating I–II (€800, €1,600); run-flat tyres (€600); a bigger nitro tank I–II (€500, €1,000); neon underglow in seven colours (€400). Wanted, it still resprays at once and loses the police, as before. |
| **Garáž** (6 doors by the spawn places) | Buy it (€2,500); park a car in it and take it out at any of the player's garages, colour, tuning and damage and all. 2 places, then 4 (€1,500) and 6 (€2,500). |
| **Zbierka** | Every kind of vehicle driven is ticked off (8 in all). All eight: €1,000 and 100 points, once. |
| **A death** | The 10% fee lands where the player died, minus its first €100, as cash anyone can pick up for 2 min. |

### Decisions

1. **Shops are places on the map**, drawn on the city map and the minimap and marked in the street.
   Walking in (on foot) or stopping (in a car) opens the shop's panel. Leaving and coming back opens
   it again. Every purchase goes through the shared simulation (`rules/Shops.ts`), which checks where the
   player is, what they have and what it costs; online the server does exactly that with the request.
2. **Prices are tunables**: defaults in `src/shared/sim/shops/catalog.ts`, and online `game_config`'s
   `shops` key overrides any of them. The server sends its price list (`catalog`) after every welcome.
3. **What a player owns is their gear** (`Profile.gear`): clothes, garages and the cars in them, the
   collection, a lawyer. Offline it's in the save, online in a new `gear` column of the players table.
   The client hears about changes with a `gear` private event.
4. **Tuning belongs to the car.** A car's `mods` (engine, plating, tyres, nitro, neon) change how it
   drives, what hurts it and how it looks. A tuned car left in the street is lost with it: the garage is
   what keeps it. The car that leaves the city with its driver (docs/plans/pause-resume.md) takes its
   tuning along.
   - Engine: acceleration ×1.15 / ×1.3, top speed ×1.06 / ×1.12.
   - Plating: damage ×0.75 / ×0.55.
   - Run-flat tyres: spike strips and shots can't burst them.
   - Nitro tank: lasts ×1.5 / ×2.
   - Neon: seen by everyone, brightest at night.
   - Police cars and event vehicles (liveries, mission cars) can't be tuned, garaged or collected
     beyond being driven once.
5. **The police look for clothes too.** On foot, the description is the jacket and the hat the police
   last saw. New clothes bought out of sight count as a different identity, as a new car does (Phase 1's
   rules: a longer look to recognise, the stars fade faster).
6. **The garage.** Storing a car takes it off the street (its driver steps out at the door). Taking one out
   puts it at the door with the player in it, if the door is clear. Cars are shared by all the player's
   garages. The collection counts every kind of vehicle the player gets into, a police car and a bus
   included.
7. **A death drops cash.** Arrests don't: the police keep the fee (half with a lawyer).
8. **Protocol 7 stays.** Everything is optional, as in Phase 1:
   - The neon travels in spare bits of the vehicle record's flag byte, the hat in spare bits of the
     figure record's outfit byte. Older clients ignore both.
   - A static record is re-sent whenever its bytes change, so a new jacket or neon reaches everyone.
   - `catalog`, the `gear` event, `profile.gear` and the `enter`/`mods` events' tuning are new messages and
     fields older clients ignore. A client sends `shop` requests only to a server that sent a `catalog`.

### Design

- **Shared.**
  - `src/shared/sim/shops/catalog.ts`: items, default prices, paints, hats, tiers, `Gear`, `Mods`,
    `StoredCar`.
  - `src/shared/sim/shops/places.ts`: the shops' places, worked out from the map the same way everywhere.
  - `src/shared/sim/rules/Shops.ts` (a `SimRule`, offline and online): `act(p, req)` for buying,
    parking and taking out; the collection (`onEnter`); a player's clothes on arrival (`onAdd`).
  - `Vehicle.mods` and `tune()`; `burstTyres()` instead of setting `tyresBurst` directly.
  - `Sim.respawn`: the cash drop and the lawyer. `Pickup.until`: a drop that disappears.
  - `Pursuit`: the on-foot description (jacket and hat).
- **Server.** `server/src/features/Shops.ts`:
  - the `shop` message;
  - `catalog` after every welcome;
  - prices from `RemoteConfig`;
  - spending logged to `activity`.

  `db.ts` gets the `gear` column (and `copyPlayerAs`), `savedCar` its `mods`, `Room` a player's saved
  look.
- **Client.**
  - `src/game/features/ShopsUi.ts`: the markers in the street and on the maps, opening a panel, the
    panels themselves.
  - `shops/text.ts`: names and descriptions.
  - `drawVehicle`: the neon. `drawPed`: the hats.
  - `LiveState.catalog`.
  - `Game.prompt`: the workshop hint.

### Steps

1. The catalog, the places, `Profile.gear` (save, `gear` column, `profile.gear`, the `gear` event), and
   the `Shops` rule with the `shop` message and `catalog`.
2. Poľovnícke potreby and the lawyer, and cash on death.
3. The Butik: the jacket and the hat on the wire and in the police's description.
4. The Dielňa: `mods`, the physics, the neon, paint and repair.
5. The garage and the collection.
6. Spending in `activity`; docs.

### Verification

- `test/shared/shops.test.ts` against the real map:
  - every shop's place is reachable (walkable, or on a road for the garages and workshops);
  - buying refuses the wrong place, too little money, a car that can't be tuned or garaged, and a tier
    already owned;
  - each item does what it says (ammo, vest, clothes, lawyer, each mod, paint);
  - the garage keeps and returns a car with its colour, mods and damage;
  - the collection pays once;
  - a death drops cash that expires;
  - an arrest with a lawyer keeps the guns;
  - clothes change the description.
- Vehicle tests: the engine's acceleration, plating's damage, run-flat tyres against a spike strip,
  the bigger tank.
- `server/test/shops.test.ts`: the `shop` message through the Room, `catalog` after a welcome, gear
  saved and loaded (the migration), prices from `game_config`.
- `test/client/`: the shop texts.
- `npm test`, `npm run build`, `npm run smoke`, `npm run smoke:mobile`, `npm run e2e`.

### Risks

- **Inflation.** Every price is a tunable, and spending is logged next to earning (`activity`).
- **Pay-to-win online.** Tuning helps in races and chases, as money always could buy a faster car. If
  it matters, races can later be "stock cars only".
- **Profile size.** Six stored cars of a few fields each, capped by the slots.
- **Trust.** A tuned car is still driven by its owner's client, as every car is. The server checks moves
  against speeds a tuned car can't beat either (`CAR_MAX`).

---

## Phase 3: Behind the wheel, and new ways around

Driving gains depth and scores online, and the map's structure (bollards, tram tracks, the river)
becomes something players use.

### What players get

| What | How it plays |
|---|---|
| **Style online** | The combo (near misses, drifts, kills, takedowns…) runs in the shared simulation, so it pays online too, and its payout scores on a new **Štýl** board. |
| **New combo moves** | *WRONG WAY* down a one-way street, *AIR* off a bump taken fast, *TRAM DODGE*, *RED LIGHT* at speed, *THREAD THE NEEDLE* flat out through a building's passage, a *CLEAN GETAWAY* in an undamaged car. |
| **Slipstream** | Close behind a bus, a van or a tram above 43 km/h: up to 5 % more top speed, and the nitro fills four times as fast. |
| **Damage you feel** | A damaged side pulls the steering toward it; a smoking engine (under 35 % health) loses up to a quarter of its power. |
| **Sirens** | In a police car or an ambulance, H switches the siren on and off, and traffic pulls over for it. |
| **The ambulance** | Parked at the hospitals. Its driver heals 2 HP a second. |
| **Scooters and bikes** | *Bolťák* e-scooters at the bike-share docks, bikes at the bicycle stands. 25 km/h, through bollard rows police cars can't pass, and the rider falls off when hit. |
| **Trams** | Ride one (board at a stop, get off at any stop: the police take twice as long to pick the player out of a crowd), or drive it from the front cab: throttle, brake and the bell. Stealing one is a crime. |
| **The Danube** | Swim (slowly, for 20 s, and cops on foot don't follow), or take a boat moored at a pier. A police boat comes at 4★. |

### Decisions

1. **Style is a shared rule** (`rules/Style.ts`, both modes). Every move banks cash into the player's
   combo and raises its multiplier (to ×5); 4 s with no new move and it pays (`payout` for `style`).
   A crash ends it early (paid), a death or an arrest loses it. The bank is capped at €400 and a
   combo at 60 s, so chaining near misses isn't a money printer. Online a payout scores 1 point per
   €25 (at most 40) on the new `style` board, at most 30 times an hour. Kills, road kills, takedowns
   and knock-outs go through `Sim.style` into the same combo. The client's meter only shows the
   simulation's (`style` events carry the multiplier); the client detects nothing itself any more.
2. **Every move is detected from the car's pose**, so the server can do it for a player's car it
   doesn't simulate (a kinematic car it only knows from reports): near misses (only with moving
   traffic, and voided by a crash within 0.3 s), drifts (sideways speed against the heading, not the
   client's skid flag), bumps crossed at speed (`world.bumps`, the same limits as the physics), a
   one-way link's direction (a new `Graph.segmentAt`), stop lines crossed on red (`world.lights`),
   distance covered inside a solid building's footprint (only a passage lets a car in there), and a
   tram's sections.
3. **Slipstream and damage are physics** (`Vehicle`), for a player's car: `VehiclePhysics` works out
   the slipstream each step for the car it simulates (offline the Sim, online the driver's client).
4. **Sirens.** H toggles the siren of a police car or an ambulance a player drives (the horn
   otherwise). It goes off when a player gets in (a stolen car's lights no longer stay on). Traffic
   pulls over for any siren closing in from behind, a player's too, whether or not anyone is wanted.
5. **New vehicle kinds** (ambulance, scooter, bike, boat) are appended to `SPECS`, so every existing
   kind keeps its index on the wire and an older client draws a new one as a sedan. They join the
   collection.
6. **Scooters and bikes are vehicles with a narrow body** (0.6 m: its circles pass a bollard row's
   1.2 m gaps, where a car's can't). They spawn parked at the real docks and stands near players (a
   rule, both modes), cost nothing and aren't a crime. A hit harder than a shove throws the rider off.
7. **Trams.**
   - **Riding:** F by an open door of a tram standing at a stop boards it; F again while it's stopped
     gets off at a door. Aboard, the player moves with the tram and isn't drawn, cars and trams can't
     hit them, and a unit needs twice as long to recognise them.
   - **Driving:** F by the front of a stopped tram takes the cab. Throttle and brake only, the track
     does the steering (at a junction the steering key picks the branch), H rings the bell. The tram
     shoves cars aside and hits people. Taking it is a crime (like a police car). Leaving hands it back
     to the AI. One tram per player.
   - **Online** the tram stays server-simulated. The client asks (`tram` message: board, off, drive,
     and the cab's controls); the server checks, attaches the player (their reports are ignored while
     aboard) and answers with a private `tram` event. Another client sees a rider vanish and reappear,
     as the crowd's passengers do.
8. **The Danube.**
   - **Swimming:** on foot in the water the player swims at a third of walking pace for 20 s, then
     drowns (the server's clock decides). No running, no shooting. Cops on foot stop at the bank.
   - **Boats:** a boat is a vehicle kept to the water (land is a wall to it), with loose grip and no
     sinking. Boats are moored along the piers near players. At 4★, with the player on the water, a
     police boat comes after them.
9. **Protocol 7 stays.** Everything is optional: new event fields and kinds older clients ignore, new
   kinds that decode as a sedan, and the `tram` message sent only to a server whose welcome lists it
   (`welcome.caps`).

### Steps

1. Style online: the rule, the board and caps, the meter on the rule's events.
2. The new combo moves.
3. Slipstream and the damage model.
4. The player's siren, and the ambulance.
5. Scooters and bikes: the kinds, the physics, the spawning, falling off.
6. Trams: riding, then driving.
7. Swimming, then boats and the police boat.

### Verification

- `test/shared/style.test.ts`: each move fires on a scripted run and not on a normal drive; the
  combo's multiplier, payout, caps and loss; the points online.
- Vehicle tests: the slipstream gain, the pull, the power loss.
- Traffic pulls over for a player's siren; an ambulance heals its driver.
- A scooter passes a bollard row a car can't (Uršulínska), and the police graph still refuses it.
- Trams: boarding and getting off offline and through the Room; a driven tram moves on its track;
  a disconnect while aboard.
- Swimming: the time limit. Boats: kept to the water; the police boat.
- `npm test`, the typechecks, `npm run smoke`, `npm run smoke:mobile`, `npm run e2e`.

### Risks

- **Server load.** The style checks are per player at the wheel and look only nearby (like the jobs'
  tips); stop lines are one flat list of about 200.
- **Farming style online.** Parked cars don't count for near misses, the bank and the combo are
  capped, and the points have an hourly cap.
- **Trams are shared.** A driven tram leaves everyone's schedule until it's handed back, so one per
  player, and it goes back to the AI when the driver leaves or drops.

---

## Phase 4: Fighting, alone and together

Co-op in one car, a lawful side to play, and fights with more than one tactic.

### Decisions

1. **Passenger seats.** Up to three passengers, each able to shoot all round.
   - Party members can get in without asking; anyone else is let in by the driver (the horn key
     while they're at the door).
   - The driver's client still simulates the car. A passenger's figure rides with it, and their
     shots are checked from the car's position.
   - If the driver leaves, a passenger can take the wheel.
2. **Players on duty as police** ("Na službe").
   - A player with no stars gets into a police car and goes on duty.
   - They get the police radio: wanted players appear as their search circles, not exact positions,
     under Phase 1's rules.
   - Arresting (the same touch as a cop) or taking down a wanted player pays a reward, capped per
     hour, and part of the arrested player's fee.
   - A crime ends the shift. Hurting a wanted player on duty isn't a crime. Party members can't
     arrest each other.
3. **Revenge bounties** ("Odmena"). Within 5 min of being killed by a player, the victim can put
   €200–2,000 on the killer for 15 min. It's shown to everyone as a moving circle, like the Most
   Wanted's, and whoever takes the killer down collects it. There are no bounties within a party, and
   a victim can't collect their own.
4. **A dive and cover.**
   - A dive on foot (Ctrl, the pad's B): a short roll with 0.3 s during which shots miss.
   - Crouching behind something low (a bench, a bin, a car) blocks shots from the far side. Walls
     already stop them.
5. **Weapons with a clear job** (sold in Phase 2's gun shop):
   - a bat (melee that knocks down);
   - a Molotov (a patch of fire);
   - a brick (knocks down, breaks a car's windows);
   - a "Pancierovka" rocket launcher for cars and the helicopter.
6. **Knocked down, not always killed** (from the roadmap). A car at 16–35 km/h knocks people over;
   they get up and shout. Players are knocked down for a second.
7. **The helicopter can be shot down.** It has 300 HP: an uzi hit does 4, a rocket 150. It comes
   down in flames, and a new one comes after 60 s at 4★ or more. It's a "TAKEDOWN" and scores
   points.

### Wire

- Seats: `enter` gains a seat, the ped record gains a seat index.
- Weapons: the ped record's weapon bits must grow. Today it's 2 bits, which fit the four weapons
  there are.
- The duty flag goes on the roster, and bounties go in `wev`.
- One protocol bump.

### Steps

1. Passenger seats: sim, server validation and client, party first, then the driver's permission.
2. The dive, cover and knock-downs.
3. The new weapons, then the helicopter's health.
4. Players on duty.
5. Revenge bounties.

### Verification

- Seats: enter and leave, shooting from the back seat validated, the driver leaving, a disconnect
  while riding.
- Duty: the start conditions, the radio showing circles not positions, the rewards and caps, and
  crimes ending it.
- Bounties: the anti-abuse rules.
- The dive's miss window, cover blocking shots from behind it, knock-down speeds.
- The helicopter's health, its crash and its replacement.

### Risks

- **Seats are the hardest netcode yet.** A figure is driven by another player's client. The
  existing `kinematic` split (the driver's client owns the car) holds, and a passenger only sends
  aim and shots.
- **Players on duty griefing.** The caps, party rules, and the fact that a crime ends the shift
  limit it, and reports reach the existing moderation tools.

---

## Phase 5: A city that remembers

### Decisions

1. **District heat.** Each quarter (`World.quarter`: Podhradie, Palisády…) keeps a heat value.
   Crimes there raise it and in-game hours cool it.
   - A hot quarter has more patrol cars and cops on foot.
   - Its witnesses get through faster (4 s instead of 7).
   - The city map can show it as a layer.
   - Offline it's in the save, online on the server, persisted.
2. **Turf for parties** ("Rajón"). A party claims a quarter through activity there: tags sprayed at
   a few spots per quarter, jobs done there, event wins there. Other parties contest it.
   - Holding a quarter pays a little per hour and colours it on the map.
   - A claim needs two members online, and it fades without activity.
3. **A time of day that matters.**
   - Street races by the river at night, open to anyone (Závod? with more than two players).
   - More people near the bars and cafés at night: more witnesses in the Old Town, fewer
     elsewhere.
   - Rush-hour jams to lose a pursuer in.
   - Trams stop overnight, as they do for real.
   - Phase 2's shops keep opening hours.
4. **Things that just happen**: small scenes the AI sets up near players, not missions (no
   objective, no timer). The player can help, rob or ignore them.
   - a bag snatcher running past (tackle him for a reward, or rob him yourself);
   - car alarms when a parked car is hit;
   - an ambulance on its way to an accident, with traffic pulling over;
   - a wedding convoy honking through the Old Town;
   - a hockey-win celebration with flags that blocks Hlavné námestie;
   - a street musician drawing a crowd.
5. **A rank from the points already earned**: Turista → Brigádnik → Miestny → Známa tvár →
   Pouličná legenda → Legenda Blavy, from all-time points (the leaderboard's), offline from the
   save's stats.
   - It's shown as a badge on the nametag.
   - It unlocks looks only: paint, horns, clothes. Nobody gets stronger in PvP just by playing more.

### Wire

Heat and turf per quarter in `wev`, and the rank on the roster. These are optional fields, so it
stays within whatever protocol Phase 4 set.

### Steps

1. District heat and its effect on patrols and witnesses.
2. The rank, then its looks.
3. The time of day: crowds, trams at night, night races.
4. Things that just happen, one scene at a time.
5. Turf.

### Verification

- Heat rises and falls with crimes and hours, and patrol density follows.
- The rank's thresholds.
- Each scene spawns only near players, cleans up after itself, and never blocks a street for good.
- Turf: the claim rules, the fading, and the two-member rule.

### Risks

- **Scenes that break traffic.** They use the same AI as the traffic and the crowd, run for a
  time, and are cleared by the existing wedged-car and despawn rules.
- **Turf favouring big parties.** Parties are capped at 4, and claims fade without activity.

---

## Out of scope

- New missions (this plan is about systems, not content).
- Changing the map area.
- Real-money purchases of any kind.

## Phase 1 as built

Phase 1 shipped as planned, on protocol 7. [docs/multiplayer.md](../multiplayer.md) ("The police
chase") covers the online side. These are the places where it differs from the plan above.

- **Gunfire is heard.** A shot within 20 m of a police unit counts as seen, whichever way the unit faces
  (`HEAR_SHOT`), so nobody can fire a gun right behind a cop unnoticed. The old radius counted only cops
  on foot. Police cars count now too, for every crime.
- **The stars hold while a unit looks the player over.** While a unit that hasn't recognised the player
  has them in sight, the unseen timer stops.
- **A report opens the search at once.** When a witness gets through, the search circle opens at the
  crime scene straight away. The units don't home in on the player for the one step before it opens.
- **Who counts as police eyes.**
  - SWAT vans now count. Before, only police-car kinds did.
  - A roadblock's parked cars have no driver and don't count, but the cops standing at the roadblock do.
  - Cops on foot more than 80 m beyond the search circle hold their post: a roadblock stays manned
    during a search.
- **Recycling police cars.** A car that stops closing in is still recycled once off-screen (after 10 s).
  While searching, its progress is measured to its search point.
- **The police radio** also says when they find the player again after losing them. On a phone the
  arrest takes the radio's slot, so the line is cleared while a bribe is on offer.
- **Bribes.**
  - On a touch screen, a "Podplatiť" button appears while an arrest can be bought off (a `busted`
    touch context).
  - A job (Vlk, Hopík) still ends at the arrest itself. A bribe saves an offline mission, but not a
    job.
- **Shared day curve.** The day's ambient curve moved to `src/shared/sim/Clock.ts` (`AMBIENT_KEYS`,
  `darkness`). The renderer and the police's sight now use the same curve.
- **Wording.** `src/game/features/police/text.ts` names each car's colour and model in the right case
  and gender ("Hľadajú červenú Felíciu", "biely autobus", "oranžové Porše").
- **Tests.**
  - New: `test/shared/pursuit.test.ts`, `test/shared/sight.test.ts`, `test/client/police.test.ts` and
    `server/test/police.test.ts`.
  - Three existing suites assumed a player standing still keeps their stars, which lying low changed.
    The Most Wanted and points suites now keep their players on the move. Two derby tests pin the
    police clock, so the stars wait for the amnesty.
  - `npm run e2e`, `npm run smoke` and `npm run smoke:mobile` pass.
  - Two checks were run by hand: the police status reaching an online client, and a real arrest by
    server-side police bought off over the wire.

## Phase 2 as built

Phase 2 shipped on protocol 7, with every addition optional as planned. [docs/multiplayer.md](../multiplayer.md)
("The shops") covers the online side, and [docs/deploy.md](../deploy.md) the `shops` prices in
`game_config`. These are the places where it differs from the plan above.

- **Opening a shop.** A panel opens for a player who stops there: a car pulled up (under 1 m/s) or
  someone standing at the door. On foot a shop is its door (3 m), a garage included. Its 9 m zone
  counts only for a car, so walking past one, or arriving at the spawn place beside it, opens nothing.
  A panel that was closed opens again after leaving, or when coming back the other way (on foot
  after driving, or the reverse). `test/shared/shops.test.ts` checks that every spawn place is clear
  of every door.
- **Taking a car out of the garage.** It waits at the door, parked and held for its owner for 90 s,
  instead of starting with them in it: a snapshot never carries a player's own car, so a client can't
  be put straight into a car it has never seen. Cars held for a player (this one, and a returning
  player's) are no longer despawned by the AI while held. Parking stands the player at the door, so
  the garage's panel stays open.
- **Butik Eurovea** is 28 m west of the gun shop there. The Eurovea landmark is inside the mall, and the
  planned offset snapped to the gun shop's own spot.
- **Names.** The Butik names its jackets with the same colour words the police use ("Modrá" in the shop,
  "Hľadajú modrú bundu" on the chip), so the olive jacket is "Žltá". The paints are named the same way
  ("Červený lak"). The police radio says when a suspect on foot has changed clothes.
- **The respray** is a full repair (dents and burst tyres too), also the spray shop's on the run.
- **Panels and the gamepad.** The shops' panels are the social features' kit modals. Every kit panel
  (the shops, Aktivity, the leaderboard…) can now be driven with the pad: the d-pad or stick moves to
  the nearest control that way, A chooses, B leaves. A pad legend says so. An open panel takes the
  controls, so the pad no longer walks or drives underneath it. On the Aktivity panel, d-pad down now
  moves instead of closing it; B closes it.
- **Keys stay with an open panel**, even when the focus has left it: a purchase that rebuilt the panel
  used to drop the focus to the page, and Escape then paused the game under the panel instead of
  closing it (`src/ui/kit/dom.ts`).
- **The neon** is a pool of colour under the car by day and lights the street at night.
- **Spending** is logged to `activity` as `kind = 'shop'` with amount 0 and `meta = { spent, item }`:
  `leaderboard_week()` adds up amounts as money earned.
- **The leaderboard's help** lists the collection's points on the city board.
- **Test tools.** The test-only `debug` message can park a car beside the player (`car`), for the
  garage's end-to-end check.
- **Tests.**
  - New: `test/shared/shops.test.ts` (the places on the real map, every item, the refusals, the garage,
    the collection, the cash drop, the lawyer, clothes in the description, prices and saves),
    `server/test/shops.test.ts` (the messages, the catalog, `game_config`, the activity log, gear and a
    tuned car across a restart, the migration), `test/client/shops.test.ts` (the words), tuning in
    `test/shared/vehicle.test.ts`, the neon and hat bits in `test/shared/codec.test.ts`.
  - `npm run smoke` buys a pistol with a click and a jacket with a (simulated) gamepad; `npm run e2e`
    now runs `scripts/e2e-shops.mjs`: the price list, clothes another player sees, a garage round trip
    with two clients, and the gear across a server restart.
  - `npm test` (the whole suite), `npm run smoke`, `npm run smoke:mobile` and `npm run e2e` pass.

## Phase 3 as built

Phase 3 shipped on protocol 7, with every addition optional as planned; [docs/multiplayer.md](../multiplayer.md)
("Behind the wheel, and new ways around") covers the online side. These are the places where it differs
from the plan above, or fills it in.

- **Style.** A combo pays 4 s after its last move, banks at most €400 and lasts at most 60 s; a crash
  (8 % of the car's health lost within 0.5 s) ends it early, paid. The moves: a near miss (at 12 m/s or
  more, past moving traffic within 1.2 m, confirmed crash-free 0.3 s later, once in 1.5 s a vehicle),
  a drift (3.5 m/s sideways at 6 m/s or more, one a second after the first 0.6 s, each topping up the
  nitro), *AIR* (a bump taken 5 m/s over what the car takes it at: the physics' own limit), *RED LIGHT*
  (a stop line crossed on red at over 8 m/s), *WRONG WAY* (1.5 s the wrong way down a one-way street at
  over 10 m/s, not on a bridge, once in 8 s), *THREAD THE NEEDLE* (5 m inside a passage at 14 m/s or
  more), *TRAM DODGE* (within 1.5 m of a tram's body at 8 m/s or more, once in 4 s a tram) and
  *CLEAN GETAWAY* (losing the police from 2★ or more with the car at 95 % of its health).
- **Slipstream** fills the nitro up to five times as fast (four in the plan): a nitro tank refills at
  3 % a second, and at 15 % in the strongest slipstream.
- **The ambulance** waits at the kerb of the street nearest each hospital, for a player within 240 m
  (`rules/Ambulances.ts`).
- **Scooters and bikes.**
  - Every bike-share dock gets a scooter and every other bicycle stand a bike (by where it is, so the
    same ones), up to 8 near a player within 150 m (`rules/Bikes.ts`). They don't count against the
    AI's parked cars.
  - A knock of 4.5 m/s or more (a wall, a car, a tram, a blast) throws the rider off, hurt 5–30. What
    threw them off doesn't also run them over for 0.6 s. The rider is out in the open: a shot at them
    hurts as it would on foot, and so does a blast.
  - A scooter or a bike never runs anyone over (it barges them aside), doesn't catch fire or blow up
    when it breaks (the rider lands beside it), has no nitro, no radio and no engine noise, and rings a
    bell for a horn. It goes round a lift gate's boom. No shop, spray shop or taxi fare takes one; a
    courier can ride one. The camera keeps the view on foot.
- **Getting into a car parked at a shop's door** no longer opens the shop's panel (it took the controls
  from someone who only wanted the car). Once the car has moved, stopping there does.
- **Trams.**
  - The cab is taken by its nose: F within 2.5 m of the front of a stopped tram. It drives up to 50 km/h
    (the AI keeps to 40) and stops dead against a tram ahead of it (trams don't push each other).
    Whoever it hits is its driver's doing: a crime, and style.
  - A rider is picked out slowly even when they match the description (the plan had it for a unit's
    recognition time only), and a stopped tram counts as lying low. Cops can arrest a rider or a
    driver from beside a stopped tram. Shots and blasts don't reach anyone aboard.
  - A driver who disconnects or pauses (online) brakes to a stop, and the AI has the tram back.
  - Online, a snapshot doesn't say whether a tram's doors are open: the client reads a tram standing
    at a stop as open, which is when the server's trams stop. A reconnect is told it's still aboard.
- **The Danube.**
  - A swimmer moves at 1.5 m/s and can't run, shoot or punch; the HUD shows the breath left. A car that
    goes into the river lets its driver out after a second, to swim for it (it used to drown them).
  - The boat is a *Motorový čln* (61 km/h), the police boat 65 km/h. The whole hull is kept to the
    water: running onto the bank or a pier puts it back and bounces it off. There is one mooring a pier
    with open water off it (32 on the map), and up to 4 boats moored near a player within 220 m
    (`rules/Boats.ts`). Getting off mid-river puts the player in the water; by a pier, onto it.
  - The police boat comes for a player in a boat or swimming at 4★, launched out of sight 110–220 m
    away. It makes straight for them, backs off the bank when it runs aground, and its cop fires within
    28 m. Stealing it is a crime, as stealing a police car is.
- **The collection** now has 13 kinds of vehicle.
- **Test tools.** The test-only `debug` message can send trams to the stop nearest the player (`tram`).
- **Tests.**
  - New: `test/shared/style.test.ts` (every move on a scripted run and not on a normal drive, the combo's
    rules, the points), `test/shared/sirens.test.ts` (traffic pulling over, the ambulance),
    `test/shared/bikes.test.ts` (through the Uršulínska bollards, handling, falling off, shots, the docks
    and stands), `test/shared/trams.test.ts` (riding, the cab, a junction, the tram ahead, the police),
    `test/shared/danube.test.ts` (swimming, the bank, a sinking car, boats, the police boat); the
    slipstream, the pull and the power loss in `test/shared/vehicle.test.ts`; in `server/test/room.test.ts`,
    a fall off a scooter and trams through the Room (hidden from another player, reports ignored, a
    driver who drops).
  - `npm run smoke` rides a scooter, drives a tram and swims and takes a boat on the Danube; `npm run e2e`
    now runs `scripts/e2e-trams.mjs`: on and off a tram with another player watching, and its cab.
  - `npm test` (the whole suite), `npm run smoke`, `npm run smoke:mobile` and `npm run e2e` pass.
