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

On touch devices a virtual joystick and buttons appear automatically.

## What's in the game

- **The real city.** 4,600+ buildings with fake-3D extrusion from real `building:levels`, 8,000+ street segments, the Danube with its bridges (Most SNP, Starý most, Most Apollo), and street names shown as you drive. Landmark buildings get realistic colours: the white castle with its red roof, the Blue Church, the pink Primate's Palace. The UFO sits on top of the Most SNP pylon.
- **Traffic AI** on the real road graph, which respects one-way streets and drives on the right. **Red-and-white trams** run on the actual tram tracks, and **pedestrians** walk the sidewalks and footpaths.
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

This runs two scripts:

1. `scripts/fetch-osm.mjs` downloads the bounding box in `scripts/bbox.mjs` from the OSM API in 0.005° tiles, cached in `.cache/osm/`.
2. `scripts/build-map.mjs` turns the raw data into game data:
   - projects it to local metres;
   - simplifies roads, buildings, areas, water and trams;
   - builds navigation graphs for cars, pedestrians and trams;
   - locates landmarks and POIs;
   - maps real brands to their parody names.

To play a different part of the city, change `scripts/bbox.mjs` and rebuild. The landmark list in `build-map.mjs` and the missions in `src/missions/Missions.ts` refer to places by id, so you would need to update those too.

## Code layout

```
src/
  main.ts              boot, menu, game loop, touch controls
  game/Game.ts         game state, player, collisions, wanted level, drawing
  game/AI.ts           traffic, police pursuit (A*), pedestrians, trams, spawning
  game/Combat.ts       weapons, explosions, particles, decals
  world/World.ts       map data, collision grid, water/bridge/street queries
  world/Graph.ts       road network + A*
  world/Renderer.ts    chunked Path2D map rendering, fake-3D buildings, rooftop ads
  entities/            Vehicle (arcade physics), Ped, Tram
  missions/Missions.ts mission definitions and runner
  ui/                  HUD, minimap and full map
  audio/Audio.ts       WebAudio sound effects and radio
  data/brands.ts       parody brands, radio stations, landmark texts
```

## Credits and licences

- Map data © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright), available under the Open Database License (ODbL). The derived `public/data/bratislava.json` is also ODbL.
- All graphics are drawn procedurally in code. The coat-of-arms emblem (`public/assets/erb.svg`) is an original simplified drawing inspired by the Bratislava arms.
- Brands and ads are parodies; any resemblance is satirical. This is a fan project and is not affiliated with Rockstar Games or any company whose products are spoofed.

See [ATTRIBUTION.md](ATTRIBUTION.md).
