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

## Still open

### Gameplay
- **More crimes for witnesses**: hitting people with a car, wrecking cars, fights in public.
- **Pedestrian lights**: people cross on red. Stand-alone crossings already have a walk phase to
  obey; junctions would need one.
- **Knocked down, not always killed**: any car touching someone at over 16 km/h kills them (below
  that it just pushes them aside). In between, a knock-down (they fall, get up and shout) would fit
  the new reactions.
- **Missions using the new places**: deliveries to real restaurants, a taxi fare from a real address,
  Slavín and the Radio as destinations.
- **Tram line numbers**: the tracks know which lines run on them (`Edge.lines`); trams could pick a
  line, follow its route and show its number (one more byte in the tram record).
- **Something to spend money on** besides the spray shop: a gun shop, a garage that keeps a car.

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
- Car handling (tyre slip, weight transfer, ABS, stability control, drag) is in good shape
  (`test/shared/vehicle.test.ts`). Candidates: steering that pulls toward a damaged side, and
  motorbikes.
- Boats on the Danube.

### Online
- Protocol v7: the server must be redeployed (`fly deploy`) together with the client.
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
- **Kde to je? content runs out on 2026-10-26.** 30 days are uploaded (2026-09-27 through 2026-10-26 —
  see `docs/deploy.md`); regenerate more with `npm run spots:gen` before then.
