# Blava City

A top-down open-world crime game in the style of the classic 2D GTA games, set on the **real streets of Bratislava**. Every street, building, tram track, bridge and park comes from OpenStreetMap. The playable area covers the Old Town, the castle hill up to Slavín and the Slovak Radio, the Danube riverside and the northern edge of Petržalka (about 3.3 × 2.8 km).

Built with TypeScript, Vite and a custom Canvas2D engine. There is no backend; the output is a static site.

## Play

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # static site in dist/
npm run preview    # serve the production build
```

### Controls

| Key | Action |
| --- | --- |
| WASD / arrows | walk / drive |
| Mouse + left click | aim + shoot (drive-by when in a car) |
| F / Enter / E | enter or exit a vehicle (carjacking included) |
| Space | handbrake (car) · shoot (on foot) |
| Shift | run (nitro in a car) |
| Q, 1–4 | switch weapon |
| R | next radio station |
| H | horn · hold it next to another player's car to challenge them to a race (**Závod?**, online) |
| V | push-to-talk voice chat (online, signed-in accounts only) |
| N | party panel (**Partia**, online) |
| J | jobs: **Vlk courier / Hopík taxi** |
| K | **"Kde to je?"** daily photo card (online) |
| G | give up while downed (online) |
| M / Tab | city map (see below) |
| Mouse wheel | zoom in / out |
| Esc / P | pause |

**Gamepad** (standard mapping): left stick drives or walks, RT accelerates (fires on foot), LT brakes and reverses, RB is the handbrake, A runs (nitro in a car), Y gets in and out, the right stick aims (and fires a drive-by when pushed hard), X honks, B switches weapons, Start pauses, Back opens the map. Online: the left stick click (L3) is push-to-talk, and d-pad left opens jobs.

A prompt at the bottom of the screen says what the use button does where you stand: get in a parked car, pull a driver out, steal a police car, get out of a stopped car (and hints such as walking up to a phone booth or stopping at a spray shop). It shows the button the way you play: the F key, the pad's Y or the touch screen's car button. When you pick up a gamepad, and whenever you get in or out of a car with one, its buttons are shown for a few seconds. The pad rumbles on crashes, hits, nearby explosions, every shot, speed bumps and kerbs.

The **city map** (M) zooms from the whole city down to a few streets (wheel, pinch, +/−, or the pad's triggers) and pans by dragging (or WASD / the left stick). It shows street, square and quarter names, landmarks, missions, the police stations, hospitals and spray shops, and, as you zoom in, museums, theatres and churches, restaurants, cafés and bars, shops, pharmacies and tram stops (layers on keys 1–7 or in the legend). Click (or Enter at the cross) to set a waypoint: the GPS works out a route over the real streets (one-way streets respected, footpaths when on foot) and draws it on the map and the minimap. Right-click or Backspace clears it.

On foot, WASD is screen-relative by default (W walks up the screen). Set **Chôdza: za kurzorom myši** in the pause menu or the menu's controls panel to walk relative to the mouse instead: W walks towards the cursor, S backs away from it, and A/D strafe around it.

In a car, steering in reverse works like a real car: steer right and the tail swings right.

On touch devices a virtual joystick and buttons appear automatically.

## What's in the game

- **The real city.** 5,900 buildings drawn in fake-3D perspective, sun-shaded roofs, and shared walls hidden between terraced houses, 9,900 street segments, the Danube with its bridges (Most SNP, Starý most, Most Apollo), and street names shown as you drive. Building heights come from OSM (`height`, `building:levels`, the tallest `building:part`) and, where OSM has none, from the floor counts in Bratislava's technical map. Only about 13% of buildings still get a guessed 2–5 storeys. Buildings mapped in parts (`building:part`, about 1,200 of them) are drawn part by part, so towers rise from their naves and wings step down, and roofs take their real shape and colour from the map (`roof:shape`, `roof:colour`, `building:colour`): domes, onion domes, spires, pyramids, the castle's four corner towers, the green copper of the cathedral, the Radio's inverted pyramid. 52 landmarks are marked, from Slavín and the Radio down to Eurovea Tower and Sky Park.
- **The street in detail.** Raised traffic islands (cars mount them with a jolt), lift gates at car parks and service entrances whose booms snap when you ram them, Most SNP's piers, speed bumps and raised tables that bounce a car (or launch it, taken fast), stop and give-way signs, and 3,000 pieces of street furniture: benches, bins, fire hydrants that gush when knocked over, bus stops and shelters, advertising columns, billboards with parody ads, bike stands, café terraces. Around 1,400 real restaurants, cafés, bars, pharmacies, museums, theatres and hotels carry their names on the facades, and the HUD names the quarter (Podhradie, Palisády, Blumental…), borough and square you're in.
- **A city you can't drive through.** The map is solid where the real city is and open where it is open:
  - the UFO restaurant sits 85 m up on the Most SNP pylon, and traffic drives under it. Raised structures are never obstacles;
  - bridges have levels: the Most SNP road deck runs above its footway and cycle deck, and the motorway flyovers in Petržalka above the roads beneath them. Each deck's railings hold in only what is on that deck;
  - streets and paths go through buildings where they really do: Michalská brána, Leopoldova brána, courtyard passages, Žižkova under Námestie F. X. Messerschmidta;
  - the Suché mýto road tunnel under Hodžovo námestie and the tram tunnel under the castle hill are real tunnels with portals and an underground level. While you're inside, the city above turns see-through;
  - city and castle walls, garden walls, fences, hedges and concrete barriers stop people, cars and bullets, with gaps wherever a street, path or gate crosses them. Tree trunks off the road are solid too;
  - fountain basins (the Roland fountain on Hlavné námestie, Ganymede's fountain in front of the National Theatre…) are rims you can't drive or walk through;
  - the real bollards, concrete blocks and planters close pedestrian streets to cars but let people through, and statues, columns and memorial stones stand in the squares, solid enough to hide behind;
  - flights of steps are slow, slippery going for a car;
  - piers and pontoons on the Danube are walkable;
  - mall corridors, garage ramps and rooftop paths are left out, so nobody walks or drives through Nivy, Aupark or Eurovea.
- **Day, night and weather.** A full day passes in 24 minutes: golden-hour light, long sun-cast shadows, a blue night with street lamps, lit windows, neon rooftop ads, headlights and police lightbars. Rain showers bring falling streaks, splashes, wet roads, thunder and the occasional lightning flash. Debug with `?t=21` (time of day), `?rain=1` and `?freeze`, or `game.atmos.setTime(h)` / `setRain(v)` in the console.
- **Detailed procedural graphics.** Cobbled Old Town streets, textured asphalt and roofs, the real zebra crossings, trees and street lamps from the map (plus scattered trees in parks and woods), railway tracks, cars with steering wheels, visible damage and brake lights, DPB-liveried trams with pantographs, plus smoke, fire, sparks, debris and shockwaves.
- **Traffic AI** on the real road graph, which respects one-way streets, drives on the right, keeps to the real speed limits and stops at the 220 real traffic lights (police in pursuit don't). Cars stop at the real stop signs and go when the junction is clear, give way at give-way signs and wherever a side street meets a bigger road, slow for speed bumps, spread across the marked lanes of multi-lane roads, and buses pull up at the real bus stops. They keep to lanes fitted between the kerbs and walls, pull out round a parked or broken-down car (or a bus at its stop) when the way is clear and wait behind it when it isn't, sort out a nose-to-nose standoff on a narrow street (one backs up and tucks in), turn round in cul-de-sacs instead of driving into them, and a car that gets wedged is towed away out of sight. Parked cars stand at the kerb (on one side only of a narrow street) and fill the mapped parking lots and bays. **Red-and-white trams** run on the actual tram tracks and stop at the real tram stops.
- **People** walk the sidewalks and footpaths on lines clear of walls, fences and fountains, and make room for each other and for you instead of walking through. They sit on benches, in bus shelters and at café tables, wait at the tram stops and get on the tram (a few get off at each stop), jump out of the way of a car coming at them and step aside when you honk. Barge into someone and they tell you off (tourists in English); point a gun at them and they put their hands up while it stays on them, or run. One in seven able-bodied locals hits back when punched or carjacked. Shoot or steal a car with no police around and a witness gets away and phones them: stop them before they get through, or you're wanted.
- **Driving physics.** Cars grip on their tyres (slip angles, weight transfer, about 1 g of cornering at the limit, less for vans and buses), brake from 100 km/h in 32–44 m with ABS (a bus needs about 56 m), have stability control (the rear-engined Porše much less of it), reach their real top speeds against air drag and reverse at up to about 30 km/h. Cobbles, rain, grass and steps all cost grip. The handbrake still swings the tail round.
- **A wanted system (1–5 stars).** Police chase you through the real street network, get out and arrest you, and shoot at 3+ stars. At a *Slovnafta* spray shop (real fuel station locations) you can pay €250 for a respray and lose the heat.
- **Six missions tied to real places**, started from phone booths:
  - taxi fare from the castle to Eurovea;
  - Kofolka delivery to the UFO bridge;
  - getaway from Michael's Gate;
  - time trial along the Danube embankment;
  - car theft from the Blue Church to Aupark;
  - a finale in Sad Janka Kráľa.
- **Collectibles.** There are 10 hidden **Čumil** statues and 52 landmarks to discover.
- **Parody brands.** Rooftop ads and shop signs use spoofs (Kofolka, Strieborný Bažant, Dolinky, Billka, Starbáks, Slovnafta…). No real logos are used.
- **Procedural audio.** Engine, siren, weapons and four radio stations (*Rádio Expreso*, *Fan Rádio*, *Rádio Dévin Folk*, *Rádio Kecy*) with Slovak DJ chatter.
- **Saving.** Progress is saved in `localStorage`.

## Map data pipeline

The baked map (`public/data/bratislava.json`, ~4.3 MB, ~1.2 MB gzipped) is committed, so you don't need to rebuild it. To regenerate it from fresh OpenStreetMap data:

```bash
npm run build:map
```

This runs three scripts:

1. `scripts/fetch-osm.mjs` downloads the bounding box in `scripts/bbox.mjs` from the OSM API in 0.005° tiles, cached in `.cache/osm/`. The map's local metres are measured from a fixed origin (`ORIGIN` in the same file), so growing the box doesn't move anything already on the map.
2. `scripts/fetch-heights.mjs` (also `npm run fetch:heights`) downloads the floor counts of the buildings in the same box from Bratislava's technical map (the city's `tm/Stavby` geoportal service, CC BY 4.0), cached in `.cache/heights/floors.geojson`. If the download fails, the build still works and falls back to guessed heights.
3. `scripts/build-map.mjs` turns the raw data into game data:
   - projects it to local metres;
   - simplifies roads, buildings, areas, water and trams;
   - gives buildings their heights (OSM `height`/`building:levels`, `building:part`, then the city's floor counts) and keeps raised structures (`min_height`, `building:min_level`) off the ground; draws buildings mapped in parts part by part, with their roof shapes and colours;
   - sorts ways into surface, bridge, tunnel, building passage, indoor and underground ones: tunnels become tubes with portals, passages are cut through their buildings, and indoor corridors, garage ramps and rooftop paths are dropped;
   - turns walls, fences, hedges and barriers into obstacles, opened wherever a street, path or gate crosses them;
   - adds fountain basins, and bollards, blocks, planters, statues, columns and memorials as solid posts; rows of bollards across a street close it to cars;
   - builds navigation graphs for cars (with speed limits), pedestrians and trams;
   - fits each lane and walking line clear of the walls and posts beside it (running the game's own `World` code), finds the streets no car fits down, and bakes the results into the graphs so the game doesn't redo it on every page load;
   - collects trees, street lamps, zebra crossings, traffic lights, tram stops, railway tracks, piers and parking lots; traffic islands, lift gates (which also close the car graph), bridge piers, speed bumps and raised tables, stop and give-way signs with the approach they face, street furniture, café terraces and named places; lanes per direction and the tram lines on each track; boroughs, quarters and squares;
   - locates landmarks and POIs;
   - maps real brands to their parody names.

To play a different part of the city, change `scripts/bbox.mjs` and rebuild. The landmark list in `build-map.mjs` and the missions in `src/missions/Missions.ts` refer to places by id, so you would need to update those too.

## Code layout

```
src/
  main.ts              boot, menu, game loop, touch controls
  shared/              the DOM-free simulation, run by the browser (offline) and the server (online)
    world/World.ts     map data, collision grid (buildings, walls, fences, fountains, posts, trees,
                       tunnel tubes), levels (tunnel / ground / bridge deck / upper deck), water,
                       piers, line of sight, lane and walking-line fitting
    world/Graph.ts     road, footpath and tram networks + A*
    world/TrafficLights.ts  stop lines and signal phases from the real traffic lights; stop and give-way
                       signs, bumps and bus stops on the car graph
    world/Street.ts    traffic islands, speed bumps, lift gates, street furniture
    entities/          Vehicle (tyre-model physics with ABS and stability control), Ped, Tram,
                       Helicopter, props
    sim/               Sim: AI (traffic, pedestrians, trams, parking), Crowd (people among people:
                       seats, tram stops, reactions, fights, witnesses), police, combat rules,
                       pickups, clock; phrases.ts (what people say)
    net/               wire protocol and binary codec
  game/Game.ts         game state, player, wanted level, drawing
  game/LocalSimHost.ts runs the shared Sim offline; net/NetSimHost.ts mirrors the server's online
  game/Gps.ts          waypoint and GPS route over the real streets
  world/Renderer.ts    chunked Path2D map rendering, fake-3D buildings and roof shapes, shadows,
                       trees, lamps, walls and fences, tunnel portals, traffic lights, lane markings
  world/StreetDetail.ts  street furniture (knocked flying by cars), gates, signs, tram stops
  world/BuildingGeometry.ts  exposed wall pieces (party walls hidden, archways cut) and roof slopes
  world/Textures.ts    procedural surface textures (asphalt, cobbles, grass, roof tiles…)
  world/Atmosphere.ts  time of day, sun, ambient colour, rain
  world/Lighting.ts    light map (lamps, headlights, explosions) multiplied over the world
  world/Weather.ts     rain streaks, splashes, lightning
  render/              vehicles, peds, trams, props, name tags, speech bubbles, WebGL PostFX
  missions/Missions.ts mission definitions and runner
  ui/                  HUD (context prompts, pad legend), minimap and the interactive city map
  audio/Audio.ts       WebAudio sound effects and radio
  data/brands.ts       parody brands, radio stations, landmark texts
server/src/            the multiplayer game server (see docs/multiplayer.md)
```

## Credits and licences

- Map data © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright), available under the Open Database License (ODbL). The derived `public/data/bratislava.json` is also ODbL.
- Floor counts for building heights: Digitálna technická mapa hlavného mesta SR Bratislavy (©) Hlavné mesto SR Bratislava, [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). The game uses heights derived from them.
- All graphics are drawn procedurally in code. The coat-of-arms emblem (`public/assets/erb.svg`) is an original simplified drawing inspired by the Bratislava arms.
- Brands and ads are parodies; any resemblance is satirical. This is a fan project and is not affiliated with Rockstar Games or any company whose products are spoofed.

See [ATTRIBUTION.md](ATTRIBUTION.md).

## Multiplayer

**Online** in the main menu joins one shared, persistent city: every player sees the same traffic,
pedestrians, trams and police. Anything that happens to an NPC happens for everyone. Players can drive
into each other, shoot each other (it's a crime: the police come after you), and each has their own wanted
level and pursuit. Online progress (money, Čumils, landmarks) is kept on the server, separately from the
single-player save. Missions are single-player only.

On top of that shared world, there's a set of social features (protocol 7):

- **World events**, announced on the map and by Rádio Kecy: **Horúca Kofolka** (a delivery van full of
  cash — whoever drives it earns from the pot until it's drained, wrecked or time runs out),
  **Najhľadanejší** (the first player to hit 5★ gets a bounty that grows every minute, paid to whoever
  takes them down), **Hon na Čumila** (a golden Čumil hides somewhere in the city behind a shrinking,
  jittered hint circle), **Obrnené auto** (an armoured cash van drives bank to bank — shoot out its
  rear doors before it delivers) and **Derby na parkovisku** (a demolition derby in a parking lot,
  alternating between Aupark and Eurovea).
- **Partia**: invite a friend with a share-able link and they spawn right next to you. Members share
  event/job payouts, can't hurt or jack each other's cars, and show a `[TAG]` on nametags and the map.
- **Revive**: downed rather than killed outright, another player standing close by can revive you for
  a "Dobrý samaritán" bonus, or give up to go straight to hospital.
- **Kde to je?**: a daily close-up photo of somewhere in the city; the first player to stand on the
  spot wins $1,000.
- **Závod?**: pull up next to another player and hold the horn to challenge them to a race to a
  landmark 1–2 km away, for a stake.
- **Vlk courier / Hopík taxi**: city jobs — deliver food or drive a fare — that work solo, online or off.
- **Rádio Kecy** breaks in with news of whatever's happening around the city.
- **Proximity voice chat**, for signed-in accounts only: nearby players hear each other over WebRTC,
  with mute, report and a kill switch.
- **Guest or account play**: guests keep today's local-nickname flow; a Supabase account (e-mail +
  password) keeps progress across every device and unlocks voice chat. A guest can claim their
  progress into a fresh account once.

Hon na Čumila, Obrnené auto and the Vlk/Hopík jobs also run solo, offline. Everything else above —
Horúca Kofolka, Najhľadanejší, Derby na parkovisku, Partia, revive, Kde to je? and voice chat — is
online only. See `docs/multiplayer.md` for the design and `docs/deploy.md` for running the server.

The button only shows when the client was built with `VITE_SERVER_URL`. The client and the server must
speak the same protocol version (now 7): deploy the server (`fly deploy`) together with the client, or
older clients are refused.

```bash
npm --prefix server install
npm run dev:server                                   # game server on :8080
VITE_SERVER_URL=ws://localhost:8080 npm run dev      # client
npm test && npm run e2e                              # unit + end-to-end tests
```

## Hosting

`npm run build` produces a self-contained static site in `dist/` that any web server can host. It must be served over HTTP; opening `index.html` straight from disk won't load the map data.

```bash
npm run build && npx serve dist
```

The production frontend is served by **Cloudflare Workers static assets** (`wrangler.jsonc`,
`npm run deploy`). The multiplayer server runs on **Fly.io** (`fly.toml`, `server/`). Step-by-step setup
is in [docs/deploy.md](docs/deploy.md).
