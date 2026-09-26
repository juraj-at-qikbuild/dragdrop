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
- Aim assist on foot for the pad: snap toward the nearest target in the stick's cone.
- Touch: show the prompt's text on the touch button itself.

### Physics
- Car handling (tyre slip, weight transfer, ABS, stability control, drag) is in good shape
  (`test/shared/vehicle.test.ts`). Candidates: steering that pulls toward a damaged side, and
  motorbikes.
- Boats on the Danube.

### Online
- Protocol v6: the server must be redeployed (`fly deploy`) together with the client.
- The crowd runs on the server at ~0.3 ms per tick for ~950 people (3% of a tick); worth watching as
  the player count grows.
