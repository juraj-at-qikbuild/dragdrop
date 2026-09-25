# Blava City

A top-down open-world crime game in the style of the classic 2D GTA games, set on the **real streets of Bratislava**. Every street, building, tram track, bridge and park comes from OpenStreetMap. The playable area covers the Old Town, the castle hill, the Danube riverside and the northern edge of Petržalka (about 3.3 × 2.4 km).

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
| Shift | run |
| Q, 1–4 | switch weapon |
| R | next radio station |
| H | horn |
| M / Tab | city map |
| Esc / P | pause |

On foot, WASD is screen-relative by default (W walks up the screen). Set **Chôdza: za kurzorom myši** in the pause menu or the menu's controls panel to walk relative to the mouse instead: W walks towards the cursor, S backs away from it, and A/D strafe around it.

In a car, steering in reverse works like a real car: steer right and the tail swings right.

On touch devices a virtual joystick and buttons appear automatically.

## What's in the game

- **The real city.** 4,600+ buildings drawn in fake-3D perspective, sun-shaded hipped and gabled roofs, and shared walls hidden between terraced houses, 8,000+ street segments, the Danube with its bridges (Most SNP, Starý most, Most Apollo), and street names shown as you drive. Building heights come from OSM (`height`, `building:levels`, the tallest `building:part`) and, where OSM has none, from the floor counts in Bratislava's technical map. Only about 13% of buildings still get a guessed 2–5 storeys. Landmark buildings get realistic colours: the white castle with its red roof, the Blue Church, the pink Primate's Palace.
- **A city you can't drive through.** The map is solid where the real city is and open where it is open:
  - the UFO restaurant sits 85 m up on the Most SNP pylon, and traffic drives under it. Raised structures are never obstacles;
  - streets and paths go through buildings where they really do: Michalská brána, Leopoldova brána, courtyard passages, Žižkova under Námestie F. X. Messerschmidta;
  - the Suché mýto road tunnel under Hodžovo námestie and the tram tunnel under the castle hill are real tunnels with portals and an underground level. While you're inside, the city above turns see-through;
  - city and castle walls, garden walls, fences, hedges and concrete barriers stop people, cars and bullets, with gaps wherever a street, path or gate crosses them. Tree trunks off the road are solid too;
  - piers and pontoons on the Danube are walkable;
  - mall corridors, garage ramps and rooftop paths are left out, so nobody walks or drives through Nivy, Aupark or Eurovea.
- **Day, night and weather.** A full day passes in 24 minutes: golden-hour light, long sun-cast shadows, a blue night with street lamps, lit windows, neon rooftop ads, headlights and police lightbars. Rain showers bring falling streaks, splashes, wet roads, thunder and the occasional lightning flash. Debug with `?t=21` (time of day), `?rain=1` and `?freeze`, or `game.atmos.setTime(h)` / `setRain(v)` in the console.
- **Detailed procedural graphics.** Cobbled Old Town streets, textured asphalt and roofs, the real zebra crossings, trees and street lamps from the map (plus scattered trees in parks and woods), railway tracks, cars with steering wheels, visible damage and brake lights, DPB-liveried trams with pantographs, plus smoke, fire, sparks, debris and shockwaves.
- **Traffic AI** on the real road graph, which respects one-way streets, drives on the right, keeps to the real speed limits and stops at the 179 real traffic lights (police in pursuit don't). **Red-and-white trams** run on the actual tram tracks and stop at the real tram stops, **pedestrians** walk the sidewalks and footpaths, and parked cars fill the mapped parking lots and bays.
- **A wanted system (1–5 stars).** Police chase you through the real street network, get out and arrest you, and shoot at 3+ stars. At a *Slovnafta* spray shop (real fuel station locations) you can pay €250 for a respray and lose the heat.
- **Six missions tied to real places**, started from phone booths:
  - taxi fare from the castle to Eurovea;
  - Kofolka delivery to the UFO bridge;
  - getaway from Michael's Gate;
  - time trial along the Danube embankment;
  - car theft from the Blue Church to Aupark;
  - a finale in Sad Janka Kráľa.
- **Collectibles.** There are 10 hidden **Čumil** statues and 21 landmarks to discover.
- **Parody brands.** Rooftop ads and shop signs use spoofs (Kofolka, Strieborný Bažant, Dolinky, Billka, Starbáks, Slovnafta…). No real logos are used.
- **Procedural audio.** Engine, siren, weapons and four radio stations (*Rádio Expreso*, *Fan Rádio*, *Rádio Dévin Folk*, *Rádio Kecy*) with Slovak DJ chatter.
- **Saving.** Progress is saved in `localStorage`.

## Map data pipeline

The baked map (`public/data/bratislava.json`, ~3 MB, ~0.8 MB gzipped) is committed, so you don't need to rebuild it. To regenerate it from fresh OpenStreetMap data:

```bash
npm run build:map
```

This runs three scripts:

1. `scripts/fetch-osm.mjs` downloads the bounding box in `scripts/bbox.mjs` from the OSM API in 0.005° tiles, cached in `.cache/osm/`.
2. `scripts/fetch-heights.mjs` (also `npm run fetch:heights`) downloads the floor counts of the buildings in the same box from Bratislava's technical map (the city's `tm/Stavby` geoportal service, CC BY 4.0), cached in `.cache/heights/floors.geojson`. If the download fails, the build still works and falls back to guessed heights.
3. `scripts/build-map.mjs` turns the raw data into game data:
   - projects it to local metres;
   - simplifies roads, buildings, areas, water and trams;
   - gives buildings their heights (OSM `height`/`building:levels`, `building:part`, then the city's floor counts) and keeps raised structures (`min_height`, `building:min_level`) off the ground;
   - sorts ways into surface, bridge, tunnel, building passage, indoor and underground ones: tunnels become tubes with portals, passages are cut through their buildings, and indoor corridors, garage ramps and rooftop paths are dropped;
   - turns walls, fences, hedges and barriers into obstacles, opened wherever a street, path or gate crosses them;
   - builds navigation graphs for cars (with speed limits), pedestrians and trams;
   - collects trees, street lamps, zebra crossings, traffic lights, tram stops, railway tracks, piers and parking lots;
   - locates landmarks and POIs;
   - maps real brands to their parody names.

To play a different part of the city, change `scripts/bbox.mjs` and rebuild. The landmark list in `build-map.mjs` and the missions in `src/missions/Missions.ts` refer to places by id, so you would need to update those too.

## Code layout

```
src/
  main.ts              boot, menu, game loop, touch controls
  shared/              the DOM-free simulation, run by the browser (offline) and the server (online)
    world/World.ts     map data, collision grid (buildings, walls, fences, trees, tunnel tubes),
                       levels (tunnel / ground / bridge deck), water, piers, line of sight
    world/Graph.ts     road, footpath and tram networks + A*
    world/TrafficLights.ts  stop lines and signal phases from the real traffic lights
    entities/          Vehicle (arcade physics), Ped, Tram, Helicopter, props
    sim/               Sim: AI (traffic, pedestrians, trams, parking), police, combat rules, pickups, clock
    net/               wire protocol and binary codec
  game/Game.ts         game state, player, wanted level, drawing
  game/LocalSimHost.ts runs the shared Sim offline; net/NetSimHost.ts mirrors the server's online
  world/Renderer.ts    chunked Path2D map rendering, fake-3D buildings, shadows, trees, lamps,
                       walls and fences, tunnel portals, traffic lights
  world/BuildingGeometry.ts  exposed wall pieces (party walls hidden, archways cut) and roof slopes
  world/Textures.ts    procedural surface textures (asphalt, cobbles, grass, roof tiles…)
  world/Atmosphere.ts  time of day, sun, ambient colour, rain
  world/Lighting.ts    light map (lamps, headlights, explosions) multiplied over the world
  world/Weather.ts     rain streaks, splashes, lightning
  render/              vehicles, peds, trams, props, name tags, WebGL PostFX
  missions/Missions.ts mission definitions and runner
  ui/                  HUD, minimap and full map
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

The button only shows when the client was built with `VITE_SERVER_URL`. See `docs/multiplayer.md` for the
design and `docs/deploy.md` for running the server.

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
