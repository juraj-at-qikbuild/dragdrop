# Plan: deeper gameplay, in five phases (Blava City)

Status: Phase 1 implemented (27 September 2026); Phases 2–5 planned. Where the build of Phase 1
differs from this plan, see [Phase 1 as built](#phase-1-as-built) at the end.

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
| **2** | Money with a purpose | A garage and a car collection, tuning, a gun shop, a clothes shop, cash that drops where you die, a lawyer | Protocol bump (tuning and looks on the wire) |
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

Players get things worth buying, at real places: a garage for the cars they're proud of, tuning,
guns, clothes. Losing money becomes a risk, not a formality.

### Decisions

1. **Shops are real places.** Each is a spot on the map (a Slovnafta for tuning, a real shop for
   clothes, a gun shop in an Old Town cellar, garages at real addresses). The player stops in it and
   a panel opens. Every purchase goes through the sim (`Sim.buy(p, item)`), online as a request the
   server validates. Prices are `game_config` tunables (`RemoteConfig`).
2. **A garage keeps cars.** Bought at one of six addresses near the spawn places, first with 2
   spaces, then 4 and 6.
   - Drive a car in to store it: kind, colour, tuning and damage are kept.
   - Take one out at any of the player's garages.
   - A police car can't be stored. Event vehicles can't either (the Kofolka van, the armoured van,
     derby cars).
   - Online the cars live in the server's profile, offline in the save.
3. **The collection.** Every kind a player has driven (and stored) is ticked off in a "Zbierka" page,
   with the rare ones picked out: the Porše (4% of traffic), the Tatrovka (3%), and later the
   ambulance and the scooter. Collecting all of them scores leaderboard points once.
4. **Tuning at the Slovnafta** (the spray shop grows a menu). Each upgrade has 2–3 tiers:
   - engine (acceleration, top speed);
   - armour (damage ×0.75, ×0.55);
   - run-flat tyres (spikes and shots can't burst them);
   - a bigger nitro tank (+50%, +100%);
   - paint of the player's choice, horns, neon underglow (seen at night).

   Tuning belongs to the car. A tuned car left in the street is lost, which is the garage's reason
   to exist.
5. **A gun shop** ("Zbrojnica") sells ammo, armour and weapons, so a death no longer means walking
   to a fixed pickup. Phase 4's new weapons are sold here.
6. **A clothes shop** changes the player's look (`look` and a hat). On top of Phase 1's
   description, the police's on-foot description becomes "a figure in a brown jacket": new clothes
   out of sight count as a different identity, as a new car does.
7. **Cash drops where you die.** The 10% fee for a death (not for an arrest, which the police keep)
   lands as a cash pickup at the spot for 2 min, visible to everyone. The player can race back for
   it, or someone else gets there first.
   - Anti-farming: nothing drops for the first €100, and a PvP kill within a party drops nothing.
8. **A lawyer** ("Advokát", €500) covers the next arrest: the guns are kept and the fee halved.

### Wire

- `vehicleStatic` gains the visible tuning (underglow, a tuned flag), in the spare bits of the livery
  byte where possible.
- `pedStatic` gains the hat, and a ped's static part learns to change: a `rev`, as vehicles have, so
  a change of clothes reaches everyone.
- New messages: `buy`, `garageStore`, `garageTake`.
- Declared together as one protocol bump.

### Steps

1. Shops: the places, the panel (a `ClientFeature`), `Sim.buy`, the server's `buy` handler, prices in
   `RemoteConfig`.
2. The garage and the collection: the profile's `garage` and `seen`, a Supabase or SQLite column
   online, the save offline.
3. Tuning: `Vehicle.mods`, applied by the physics (the driver's client simulates its own car, so the
   server checks mods against the profile), and drawn.
4. The gun shop and the lawyer.
5. The clothes shop and the on-foot description.
6. Cash on death.
7. Economy telemetry: purchases logged to `activity`, and a first round of tuning the prices against
   what players earn per hour.

### Verification

- Shared tests for `Sim.buy`: refusals, the money, the item, offline and online.
- A stored car comes back with its colour, tuning and damage.
- Tuning is visible in the physics tests (acceleration, damage taken, a spike strip that doesn't
  burst run-flats).
- Server tests for each message: validation and persistence.
- The description changes with clothes (Phase 1's pursuit tests, extended).
- Cash on death: the amount, the anti-farm rules, and expiry.

### Risks

- **Inflation.** Every price is a tunable, and the telemetry shows earnings per hour before
  prices are set.
- **Pay-to-win online.** Tuning helps in races and chases. Race stakes are matched by the
  challenger's car anyway. If it matters, a race can offer "stock cars only".
- **Profile size.** Six cars of a few fields each is small. The garage is capped.

---

## Phase 3: Behind the wheel, and new ways around

Driving gains depth and scoring online, and the map's structure (bollards, tram tracks, the river)
becomes something players use.

### Decisions

1. **Combos count online.** The server detects near misses (as it already does for the jobs' tips,
   `Jobs.ts`) and drifts (from the reported skid) and pays style points onto a new "Štýl"
   leaderboard board, with hourly caps like every other source. The client's combo meter shows the
   server's count.
2. **New combo moves from what the city already has:**
   - wrong way down a one-way street (the car graph knows);
   - air off a raised table or a speed bump taken fast (`Vehicle.overBump` already launches the
     car);
   - threading between two trams, or a near miss with one;
   - through a red light at speed (`TrafficLights` knows the phase);
   - flat out through a building passage;
   - a clean getaway (Phase 1): losing the police without a scratch on the car.
3. **Slipstream.** Close behind a bus, van or tram above 12 m/s, nitro charges and top speed rises
   5%.
4. **Damage you feel.** A damaged side pulls the steering toward it. Below 30% health the engine
   smokes and loses up to 25% of its power. Burst tyres already exist.
5. **Vehicles with abilities.**
   - A player driving a police car turns its siren on with the horn key, and traffic pulls over for
     them (`AI.sirenBehind` skips players today).
   - An ambulance (a new kind, spawning at the hospitals) has a siren too, and heals its driver
     2 HP/s up to full.
6. **E-scooters and bikes.** A parody rental scooter ("Bolťák") at the real bike-share docks, and
   bikes at the bicycle stands.
   - They go about 25 km/h, fit through bollard rows and use footpaths, and the rider falls off when
     hit.
   - The car-free Old Town becomes a way to lose police cars, which can't cross the bollards.
7. **Trams.**
   - **Riding:** board at a stop, as the crowd does. Aboard, the police need twice as long to
     recognise the player (a crowd). Get off at any stop.
   - **Driving:** take the front cab. Throttle and the bell only, since the tram follows its track.
     It shoves cars aside and runs through the castle tunnel. Stealing one is a crime.
8. **The Danube.**
   - **Swimming:** slow, for 20 s before the player tires and drowns. Cops on foot don't follow into
     the water.
   - **Boats:** moored at the piers and pontoons, driven with water physics, stealable, and a police
     boat at 4★.

### Wire

New vehicle kinds (ambulance, scooter, bike, boat), a player riding a tram (an attach state), the
police car siren for players, and the style board. That's one protocol bump.

### Steps

1. Style online: server-side detection, the "Štýl" board and caps, the client meter on server
   events.
2. The new combo moves, each with its own label and base value.
3. Slipstream and the damage model.
4. The player's siren and the ambulance.
5. Scooters and bikes: the kinds, the physics, the bollards, the docks.
6. Trams, riding and then driving.
7. Swimming, then boats.

### Verification

- Style: server-detected near misses and drifts match the client's within tolerance on recorded
  runs, and the caps hold.
- Each combo move fires on a scripted run and not on a normal drive.
- Vehicle tests: the slipstream gain, the pull, the power loss.
- Traffic pulls over for a player's siren (a soak test like `traffic.test.ts`).
- A scooter passes a bollard row that a car can't, and the police graph still refuses it.
- A tram rider and driver online: attach and detach, a disconnect while aboard.
- Swimming: the time limit. Boats: kept to the water.

### Risks

- **Server load from style detection.** It's per player and per nearby car, like the tips already
  are.
- **Trams are shared.** A player driving one takes it from everyone's schedule: it's returned to AI
  control on exit, and one tram per player at a time.

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
