# Review and roadmap

What a review of the map, gameplay, controls and physics found, what has been done about it, and what
is still open. Numbers come from the soak tests in `test/shared/traffic.test.ts` and ad-hoc probes of
the simulation around ten parts of the city (Eurovea, Most SNP, Hlavné námestie, Blumental, Kyjev,
Medická záhrada, Incheba, Nivy Tower, Aupark, the Presidential Palace).

## Done

### The map
- The playable area grew north to Slavín and the Slovak Radio. The projection origin is fixed, so
  nothing already on the map moved.
- Buildings mapped in parts are drawn part by part, with their real roof shapes and colours; 52
  landmarks (up from 21).
- Traffic islands, lift gates, Most SNP's piers, speed bumps and raised tables, stop and give-way
  signs, 3,000 pieces of street furniture, café terraces, ~1,400 named places, boroughs, quarters
  and squares, lanes per direction and the tram lines on each track.
- An interactive city map with a waypoint and a GPS route over the real streets.

### Traffic
- **Traffic stood still half the time**, and a quarter of all traffic time was spent queued behind
  parked cars: they were parked 1.1 m in from the edge of the road, in the lane, on three out of
  four streets. Parked cars now stand at the kerb (one side only of a narrow street), and traffic
  pulls out round parked, abandoned and wrecked cars and buses at their stops.
- **Head-on standoffs** (two cars each waiting for the other on a narrow street or across a
  junction) deadlocked for good; now one gives way.
- Stop and give-way signs, priority where a side street meets a bigger road, speed bumps, multi-lane
  roads, bus stops.
- A 12 m bus straddling a give-way line was held at walking pace forever, and a long vehicle caught by
  a red with its nose over the line stopped inside the junction: signs and lights now count as passed
  once the front bumper is over the line.
- Average traffic speed 3.1 → 4.7 m/s at the same crash rate per distance; no car stuck for a minute.
- AI horns were silent (only a flag); now they're heard, and people standing in the road step aside.

### People
- Bodies push apart instead of passing through each other and the player.
- Reactions: to being barged into (a word, sometimes a shove back), a gun pointed at them (hands up
  while it stays on them, or running), a horn (stepping off the car's line instead of a whole street
  fleeing in panic, as before).
- Sitting on benches, in bus shelters and at café tables; waiting at tram stops and boarding; getting
  off at stops.
- One in seven able-bodied civilians hits back when punched or carjacked.
- Witnesses phone the police about a shooting or a carjacking with no police around (these went
  unpunished before), unless the player stops them.
- Figures with rounded limbs, hands and shoes; sitting, phone, fighting and hands-up poses. Fleeing
  civilians no longer show a punching arm (the panic cooldown was read as a punch).

### Controls
- A context prompt for the use button (F / the pad's Y / the touch car button), the gamepad's button
  legend when it's picked up and on getting in or out, and rumble on crashes, hits, explosions, shots,
  bumps and kerbs.
- **Touch, rebuilt for phones** (landscape first). Before: a fixed stick and four emoji buttons, no
  pause, weapon switch, running, nitro, horn, radio or drive-bys; online a touch player never got past
  their fists; the HUD's minimap sat under the left thumb. Now a floating stick (a full push runs), a
  right-thumb cluster per situation (on foot, both driving schemes, bleeding out, the city map), a use
  button that says what it does, a pause button, the minimap tapped for the map, aim assist on the
  fire button (hold: the best target ahead, threats first; drag: aim yourself), the HUD laid out
  around the thumbs and the notch (`src/ui/layout.ts`), first-run tips, and `npm run smoke:mobile`.
- **Touch driving fixed**: with the stick more than 126° behind the car it flickered and then reversed
  forever (the reverse steering had the wrong sign). Now a K-turn, a real brake (it had none: 97 m to
  coast to a stop from 15 m/s), and a classic scheme with pedals (`test/client/touchDrive.test.ts`).

### The first start
- **An introduction for newcomers** (`src/game/features/OnboardingUi.ts`). Before, a first game opened with one line of text: find a phone booth or steal a car. Nothing said what the world events were, and the Aktivity panel only pulsed in a corner. Now a newcomer gets three short cards over the paused city:
  - the controls to know, for the keyboard, the pad or touch;
  - the world events, with what's on now (and a GPS button) or what's coming;
  - everything else to do, ending at the Aktivity panel.
- It shows once per device for online and for offline play, and only to players with nothing to show yet (online: the server's profile). The pause menu brings it back. A one-time tip at the first world event points a player who never opened Aktivity at it. Checked by `npm run smoke` and `npm run smoke:mobile`, which run it with `?intro=1`.
- **"Nová hra" over a save starts afresh.** It used to clear the save and reload, but the page wrote the old game back into the save as it unloaded, so the old money, landmarks and purchases came back.

### Social features (protocol v7)
- **Five server-run world events**, announced on the map and by Rádio Kecy: Horúca Kofolka (a cash van
  to drive), Najhľadanejší (a bounty on the first player to hit 5★), Hon na Čumila (a golden statue
  behind a shrinking, jittered hint circle — online or solo), Obrnené auto (an armoured van to rob
  bank-to-bank — online or solo) and Derby na parkovisku (a demolition derby, alternating Aupark and
  Eurovea).
- **Partia**: invite links, up to 4 members, shared event/job payouts, no friendly fire or car-jacking,
  a nametag `[TAG]` and map highlight.
- **Revive**: downed instead of killed outright; another player nearby revives you for a "Dobrý
  samaritán" bonus, anti-farmed with pair/hourly caps, or give up to skip straight to hospital.
- **Guest or Supabase-account play**: e-mail/password accounts, unique nicknames, cross-device
  progress, a one-time claim of a guest's local progress, and GDPR self-deletion.
- **Kde to je?**: a daily photo puzzle, generated by a headless-Chromium script and hosted on Supabase,
  with hints unlocking over the day.
- **Závod?**: pull up next to another player and hold the horn to challenge them to a race to a
  landmark 1–2 km away, for a stake.
- **Vlk courier / Hopík taxi**: two solo-or-shared city jobs (deliver food, drive a fare), working
  offline too.
- **Rádio Kecy breaking news**: world events, chases and race/derby results as radio bulletins.
- **Proximity voice chat**: a WebRTC mesh paired by the server (accounts only), with push-to-talk,
  mute, report and a kill switch.
- **Rebríček** (the leaderboard, [plans/leaderboard.md](plans/leaderboard.md)): points for 18 kinds of
  achievement (events, jobs, races, getaways, the city, revives), on boards for today, this week and
  all time, overall and per kind, with the HUD's running total and rank, rank-up messages and the
  day's leader on Rádio Kecy. Anti-farmed (hourly caps, no points for forfeits, getaways need a real
  chase), and split by parties like money.

### The police chase ([plans/gameplay.md](plans/gameplay.md), Phase 1)
- **The police act on what they see.** Before, reinforcements spawned round the player's real
  position, cops on foot walked straight to them and the helicopter followed them exactly, whether
  anyone had seen them or not. Now cars and cops look through cones that darkness and rain shorten,
  and the helicopter sees by day under it and at night only in its beam, never under cover. With
  nobody seeing the player, every unit searches the circle where they were last seen. Roadblocks
  go up only just after a sighting.
- **Crimes need eyes.** A crime counts as seen when a unit has the player in sight (or hears
  gunfire within 20 m), not whenever a cop is within 45–60 m. A witness's report sends the search to
  the crime scene, for the car used there; before, it went to wherever the police had last seen the
  player.
- **A description.** The police look for the car they last saw the player in. Another car takes a
  unit 1 s + 1 s per 20 m to recognise, instantly up close, and the stars fade 1.4× as fast.
- **Lying low.** Still and unseen, the stars fade faster, even inside the circle, and fastest in a
  car park or under cover.
- **On screen.** A chip with what the police are looking for, "!"/"?" over units, sight cones on the
  minimap, the helicopter's beam drawn where it really is, and a police radio.
- **Úplatok.** An arrest at 1–2★ can be bought off for €150 a star.

### Money with a purpose ([plans/gameplay.md](plans/gameplay.md), Phase 2)
- **Shops at real places**, marked in the street and on the maps, each with a panel that opens when
  the player stops at its door (or pulls up in a car): three gun shops (Poľovnícke potreby), three
  boutiques (Butik), a lawyer (JUDr. Paragraf), a workshop at every fuel station (Dielňa) and six
  garages by the spawn places. Prices are tunables (`game_config` `shops` online).
- **Tuning belongs to the car**: engine I–II, plating I–II, run-flat tyres, nitro tanks I–II, neon in
  seven colours, and paint of the player's choice with a repair. The car that leaves the city with its
  driver keeps it.
- **The garage** keeps up to six cars with their colour, tuning and damage; any of the player's garages
  gives them back.
- **Clothes the police look for**: on foot, the description is the jacket and the hat they last saw,
  and the chip and the police radio say so ("Hľadajú modrú bundu so šiltovkou").
- **The lawyer** keeps the guns through the next arrest and halves its fee. **A death's fee** lies where
  the player fell (less €100) for two minutes. **The collection**: every kind of vehicle driven,
  €1,000 and 100 points.
- **Panels with a gamepad**: every panel (the shops, Aktivity, the leaderboard…) can be driven with the
  d-pad or stick, A and B, and a panel takes the controls while it's open.

### Driving and new ways around ([plans/gameplay.md](plans/gameplay.md), Phase 3)
- **Style online.** The combo (near misses, drifts, road kills, takedowns) runs in the shared
  simulation, so it pays online too and scores on a new **Štýl** board. New moves: *WRONG WAY*, *AIR*,
  *RED LIGHT*, *THREAD THE NEEDLE*, *TRAM DODGE* and a *CLEAN GETAWAY*.
- **Driving.** A slipstream behind a bus, a van or a tram; a damaged side pulls the steering, and a
  smoking engine loses power.
- **Sirens and the ambulance.** H switches a police car's or an ambulance's siren, and traffic pulls
  over for it. An ambulance waits at every hospital and heals its driver.
- **Scooters and bikes** at the real bike-share docks and bicycle stands: through the bollard rows
  police cars can't pass, and a hard knock throws the rider off.
- **Trams.** Ride one (the police take longer to pick out a rider), or steal one from its cab and drive
  it: throttle, brake, the branch at a junction and the bell.
- **The Danube.** Swim for 20 s (it used to drown a player in 1.5 s), take a boat moored at a pier, and
  at 4★ the police boat comes after a player on the water. A car in the river lets its driver out.
- **Getting into a car at a shop's door** no longer opens the shop's panel.

## Still open

### Gameplay
The next round of gameplay work is planned in five phases in
[plans/gameplay.md](plans/gameplay.md): the police (1, done), money (2, done), driving and new ways
around (3, done), fighting alone and together (4) and a city that remembers (5). Several items below are
part of it, as noted.

- **More crimes for witnesses**: hitting people with a car, wrecking cars, fights in public.
- **Pedestrian lights**: people cross on red. Stand-alone crossings already have a walk phase to
  obey; junctions would need one.
- **Knocked down, not always killed** (gameplay plan, Phase 4): any car touching someone at over
  16 km/h kills them (below that it just pushes them aside). In between, a knock-down (they fall,
  get up and shout) would fit the new reactions.
- **Missions using the new places**: deliveries to real restaurants, a taxi fare from a real address,
  Slavín and the Radio as destinations.
- **Tram line numbers**: the tracks know which lines run on them (`Edge.lines`); trams could pick a
  line, follow its route and show its number (one more byte in the tram record).

### Controls
- Remappable keys and a second pad layout (throttle on A, brake on X for pads without analog
  triggers).
- Aim assist on foot for the pad: snap toward the nearest target in the stick's cone
  (`src/game/aimAssist.ts` already does it for touch).
- Phones, still open: fullscreen and an installable app (manifest, icons), pausing and muting when
  the app goes to the background, haptics (`navigator.vibrate` beside the pad's rumble), and
  performance: the automatic graphics quality measures the gap between frames instead of the work in
  them, so on a 60 Hz screen it can only ever go down (`Game.trackFrameTime`), then the pixel ratio and
  the canvas caches on low-memory phones.
- Online drive-bys at speed can fail the server's check that a shot starts within 4 m of the player
  (`Room.onFire`), with any input.

### Physics
- Car handling (tyre slip, weight transfer, ABS, stability control, drag, a damaged side's pull) is in
  good shape (`test/shared/vehicle.test.ts`). Candidates: motorbikes.
- Boats are kept to the water by their hull's footprint against the water polygons, and bounce off the
  bank: there's no current, no waves and no wash to rock the boats nearby.
- A tram a player drives stops dead against a tram ahead (trams don't push each other), and nothing
  stops it at a junction: there are no tram signals.

### Online
- Protocol v7: the server must be redeployed (`fly deploy`) together with the client.
- **Clients from before the gameplay plan's Phase 3** draw the new vehicles (the ambulance, scooters,
  bikes, boats, the police boat) as sedans, and one that takes a scooter or a boat simulates it as a
  sedan (which sinks on the river). The server doesn't refuse them: the client and the server deploy
  together.
- The crowd runs on the server at ~0.3 ms per tick for ~950 people (3% of a tick); worth watching as
  the player count grows.
- **The armoured van's `maxHealth` isn't sent over the wire.** The event raises the van's real health
  pool to 600 by setting `Vehicle.maxHealth` (`ArmoredVan.ts`), a field only the server's own copy of
  the vehicle ever has set — the wire still carries `health / spec.health` (150, the base `van` kind's
  health), and every client's mirror is built from that alone. A spectator (anyone not driving it) sees
  its damage visuals as if 600 HP were 150: good as undamaged for most of a fight, then suddenly
  wrecked. Worth sending the true max, or a pre-divided fraction, instead.
- **Client-reported car health is trusted.** Derby eliminations (a car at or under 10% of its spec
  health) and the courier/taxi crash check (a drop of at least 3% of spec health within 0.5 s) both
  read the number the driving client itself reports — the same trust collision damage has always had
  online, but now with money riding on it. Worth a look if either payout starts attracting complaints.
- **Party-radio voice** (a stretch goal, not built): party members hearing each other up to 300 m as a
  band-passed "radio", on top of today's proximity mesh.
- **The leaderboard outside the game.** It's only in game today (L, the pause menu). The main menu
  (before joining) or a web page would need a read-only HTTP endpoint on the game server. Rewards for
  the day's and week's winners (a title, a name-tag badge) would give it more pull.
- **Supabase `leaderboard_week()`** is now unused by the game (the leaderboard is in the server's
  SQLite). It still counts every party share as its own win and derby 2nd/3rd places as wins; drop or
  rewrite it in a new migration if anything outside the game is going to read it.
- **Kde to je? content runs out on 2026-10-26.** 30 days are uploaded (2026-09-27 through 2026-10-26 —
  see `docs/deploy.md`); regenerate more with `npm run spots:gen` before then.
