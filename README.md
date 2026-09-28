# Blava City

A top-down open-world mischief game in the style of the classic 2D GTA games, set on the **real streets of Bratislava**, where **nobody gets hurt**: the guns are water pistols, bubble guns and confetti, and people get soaked, sit down dazed, grumble and go home to change ([docs/plans/non-violent.md](docs/plans/non-violent.md)). Every street, building, tram track, bridge and park comes from OpenStreetMap. The playable area covers the Old Town, the castle hill up to Slavín and the Slovak Radio, the Danube riverside and the northern edge of Petržalka (about 3.3 × 2.8 km).

Built with TypeScript, Vite and a custom Canvas2D engine. There is no backend; the output is a static site.

## Play

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # static site in dist/
npm run preview    # serve the production build
npm run dev -- --host   # also on your network, to play on a phone
npm run build && npm run smoke && npm run smoke:mobile   # desktop and touch smoke tests
```

### Controls

| Key | Action |
| --- | --- |
| WASD / arrows | walk / drive |
| Mouse + left click | aim + squirt (from the car window when in a car) |
| F / Enter / E | enter or exit a vehicle (carjacking included), get on a scooter or a bike, get on a tram at a stop or take the cab of a stopped one, get off; when arrested at 1–2★, pay the cop off (**Úplatok**) |
| Space | handbrake (car) · squirt (on foot) |
| Shift | run (nitro in a car) |
| Q, 1–4 | switch toy |
| R | next radio station |
| H | horn (a bell on a scooter, a bike or in a tram's cab) · the siren on and off in a police car or an ambulance · hold it next to another player's car to challenge them to a race (**Závod?**, online) |
| V | push-to-talk voice chat (online, signed-in accounts only) |
| N | party panel (**Partia**, online) |
| U | **Aktivity**: the **Minihry** to start or join, the world events on now and when the next one may come, and everything else to do with its key |
| B | a mini-game's own action, which the HUD names (pay for parking, paste a poster, set a flood panel…); in its lobby, start now |
| J | jobs: **Vlk courier / Hopík taxi** |
| K | **"Kde to je?"** daily photo card (online) |
| L | leaderboard (**Rebríček**, online) |
| G | give up while downed (online) |
| M / Tab | city map (see below) |
| Mouse wheel | zoom in / out |
| Esc / P | pause |

**Gamepad** (standard mapping): left stick drives or walks, RT accelerates (squirts on foot), LT brakes and reverses, RB is the handbrake, A runs (nitro in a car), Y gets in and out, the right stick aims (and squirts from the car when pushed hard), X honks (rings the bell, or switches a police car's or an ambulance's siren), B switches toys, Start pauses, Back opens the map. D-pad down opens **Aktivity**, d-pad left jobs, the right stick click (R3) is a mini-game's action, and online the left stick click (L3) is push-to-talk.

A prompt at the bottom of the screen says what the use button does where you stand: get in a parked car, pull a driver out, steal a police car, get on a scooter or a tram, steal a tram, get out of a stopped car (and hints such as walking up to a phone booth or stopping at a spray shop). It shows the button the way you play: the F key or the pad's Y; on a touch screen the use button itself says it. When you pick up a gamepad, and whenever you get in or out of a car with one, its buttons are shown for a few seconds. The pad rumbles on crashes, hits, a car giving up nearby, every squirt, speed bumps and kerbs.

The **city map** (M) zooms from the whole city down to a few streets (wheel, pinch, +/−, or the pad's triggers) and pans by dragging (or WASD / the left stick). It shows street, square and quarter names, landmarks, missions, the police stations, hospitals and spray shops (the workshops), the toy shops, boutiques, the lawyer and the garages (yours ringed), and, as you zoom in, museums, theatres and churches, restaurants, cafés and bars, shops, pharmacies and tram stops (layers on keys 1–7 or in the legend). Click (or Enter at the cross) to set a waypoint: the GPS works out a route over the real streets (one-way streets respected, footpaths when on foot) and draws it on the map and the minimap. Right-click or Backspace clears it.

On foot, WASD is screen-relative by default (W walks up the screen). Set **Chôdza: za kurzorom myši** in the pause menu or the menu's controls panel to walk relative to the mouse instead: W walks towards the cursor, S backs away from it, and A/D strafe around it.

In a car, steering in reverse works like a real car: steer right and the tail swings right.

**Touch** (phones and tablets; best held sideways): the controls appear by themselves and change with what you're doing.

| Control | Action |
| --- | --- |
| Left thumb, anywhere on the left | a stick appears under it: walk or drive; pushed all the way, run |
| 💦 (held) | squirt at the best target in front (cops and people after you first), brackets show who; drag from the button to aim yourself, pulled onto a target right beside the line |
| Toy button | next toy (it shows the one in hand and the refills left) |
| Yellow button | says what it does and does it: get in, pull a driver out, steal a police car, get out |
| Violet button | a mini-game's own action, saying what it does (only while a round has one) |
| BRZDA · RUČNÁ · N₂O | brake (held at a standstill: reverse) · handbrake · nitro, with its charge |
| 📣 · 📻 | horn (held next to another player's car: a race challenge) · next radio station |
| Minimap | tap for the city map: drag, pinch, tap for a waypoint; ✕, +/− and ⌖ on the side, layers from the "Vrstvy" chip |
| ☰ Aktivity | under the street name: what's on in the city and coming next, jobs, races and the rest |
| ❚❚ | pause and settings |

Two ways to drive, chosen in the pause menu: **Smer** (the default) points the stick where the car should go and it speeds up by itself (pointed behind, it turns around with a short K-turn), **Klasické** steers with the stick and has gas and brake pedals (slide the thumb between them). The pause menu also sets how close the camera is. Tips next to each control show the first time; "Zobraziť tipy znova" in the controls panel brings them back. On a touch screen the HUD moves out of the thumbs' way (the minimap goes top-left) and keeps clear of the notch. `?touch=1` in the URL forces the touch controls on a desktop, `?touch=0` turns them off.

**The first start** (`src/game/features/OnboardingUi.ts`). A new player's first game, online or off, opens with three short cards over the city before they set off:
1. **Vitaj**: where they are, and the four controls to know for the way they play (keyboard and mouse, gamepad or touch).
2. **Udalosti v meste**: the world events, each in a line. It also shows what's on right now, with a button that sets the GPS there, or when the next one may come. Offline it lists the two that run solo and names what online adds.
3. **Čo môžeš robiť**: jobs, races, the party, the daily photo, the shops and the leaderboard (offline: missions, jobs, shops and collectibles), ending at the Aktivity panel (U) that lists it all from then on.

The game is paused while the cards are open (online the player is away, and shielded once it's safe, as in the pause menu). Afterwards the usual first message says what to do first. The cards show once per device for online play and once for offline play, and only to a player with nothing to show yet: no money, landmarks, Čumils or purchases. Online the server's profile decides, so an account signing in on a new device skips them. **📖 Úvod do hry** in the pause menu brings them back. The first time a world event is on while the player has never opened Aktivity, a one-line tip says how to find out about it. Automated browsers (the smoke and end-to-end scripts) don't get the cards unless the URL has `?intro=1`; `?intro=0` turns them off.

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
  - piers and pontoons on the Danube are walkable, and the river itself can be swum (briefly) or crossed by boat;
  - mall corridors, garage ramps and rooftop paths are left out, so nobody walks or drives through Nivy, Aupark or Eurovea.
- **Day, night and weather.** A full day passes in 24 minutes: golden-hour light, long sun-cast shadows, a blue night with street lamps, lit windows, neon rooftop ads, headlights and police lightbars. Rain showers bring falling streaks, splashes, wet roads, thunder and the occasional lightning flash. Debug with `?t=21` (time of day), `?rain=1` and `?freeze`, or `game.atmos.setTime(h)` / `setRain(v)` in the console.
- **Detailed procedural graphics.** Cobbled Old Town streets, textured asphalt and roofs, the real zebra crossings, trees and street lamps from the map (plus scattered trees in parks and woods), railway tracks, cars with steering wheels, visible damage and (on players' cars) brake lights, DPB-liveried trams with pantographs, plus smoke, fire, sparks, debris and shockwaves, water jets, soap bubbles, confetti and feathers.
- **Traffic AI** on the real road graph, which respects one-way streets, drives on the right, keeps to the real speed limits and stops at the 220 real traffic lights (police in pursuit don't). Cars stop at the real stop signs and go when the junction is clear, give way at give-way signs and wherever a side street meets a bigger road, slow for speed bumps, spread across the marked lanes of multi-lane roads, and buses pull up at the real bus stops. They keep to lanes fitted between the kerbs and walls, pull out round a parked or broken-down car (or a bus at its stop) when the way is clear and wait behind it when it isn't, sort out a nose-to-nose standoff on a narrow street (one backs up and tucks in), turn round in cul-de-sacs instead of driving into them, and a car that gets wedged is towed away out of sight. Parked cars stand at the kerb (on one side only of a narrow street) and fill the mapped parking lots and bays. **Red-and-white trams** run on the actual tram tracks and stop at the real tram stops.
- **People** walk the sidewalks and footpaths on lines clear of walls, fences and fountains, and make room for each other and for you instead of walking through. They sit on benches, in bus shelters and at café tables, wait at the tram stops and get on the tram (a few get off at each stop), jump out of the way of a car coming at them and step aside when you honk. Barge into someone and they tell you off (tourists in English); point a toy at them and they put their hands up while it stays on them ("Len nie na vlasy!"), or run. One in seven able-bodied locals tickles back when tickled or carjacked. Squirt someone or steal a car where no police can see it and a witness gets away and phones them: stop them before they get through, or you're wanted.
- **Nobody gets hurt** ([docs/plans/non-violent.md](docs/plans/non-violent.md)). The toys: *Šteklenie* (tickling), *Vodná pištoľ*, *Bublinkový samopal* (its last hit floats someone off in a giant bubble) and *Konfetová brokovnica*. Someone soaked through, tickled till they sit down, bounced off a car (BOING, a star, never a reward) or caught next to a car blowing up (sooty, the hair on end) sits dazed on the pavement with stars going round their head, gets up dry, says what they think of it and goes home to change; a cop goes off duty. Instead of road kills: drive through a puddle next to someone and soak them (**ŠPLECH!**; any road in the rain, else the potholes that never dry), high-five the fans holding a hand out as you pass (**PLÁCNI SI!**), make someone dive into a bush at the last second (**HOP DO KRÍKA!**), plough through a lokše or langoš stall (**MOJE LOKŠE!**), or just scatter the pigeons on the squares.
- **Driving physics.** Cars grip on their tyres (slip angles, weight transfer, about 1 g of cornering at the limit in traffic, less for vans and buses), brake from 100 km/h in 32–44 m with ABS (a bus needs about 56 m), have stability control (the rear-engined Porše much less of it), reach their real top speeds against air drag and reverse at up to about 30 km/h. Cobbles, rain, grass and steps all cost grip. The handbrake still swings the tail round. A player's car grips about twice as hard, steers quicker and has yaw control: at 90 km/h full lock holds a 30 m circle instead of 60 m, and the car stops turning the moment the key is let go. The camera zooms out only gently with speed and looks ahead of the car.
- **A wanted system (1–5 stars).** Police chase you through the real street network, get out and arrest you, and squirt at 3+ stars (service water pistols; at 5 stars the firefighters, and the helicopter tips a water bucket). They act on what they see ([docs/plans/gameplay.md](docs/plans/gameplay.md), Phase 1):
  - police cars and cops look through cones that shrink at night and in the rain. The helicopter sees the circle under it by day and only its searchlight after dark, never under a roof, a passage or a bridge deck;
  - a crime no cop sees (or, for squirting, hears close by) may still be phoned in by a witness, who sends them to where it happened;
  - they look for the car they last saw you in. Switch cars out of sight and a unit needs a good look to recognise you, though up close it's instant;
  - once they've lost you, they search the circle where you were last seen, and the stars flash and fade. They fade faster in a car they're not looking for, faster still lying low (still and out of sight, even inside the circle), fastest in a car park or under cover;
  - a chip under the stars says what they're looking for and whether they see you. "!" and "?" mark the units that see you or are looking you over, the minimap shows every unit's cone, and the police radio (*Vysielačka*) follows the chase;
  - at 1–2 stars, an arrest can be bought off (**Úplatok**: F, €150 a star, once in 10 minutes, not after soaking the police).

  On the run, stopping at a *Slovnafta* spray shop (real fuel station locations) still buys a respray for €250 and loses the heat.
- **Money with a purpose** ([docs/plans/gameplay.md](docs/plans/gameplay.md), Phase 2). Shops at real places, marked in the street and on the maps. Stop at the door (or pull up in a car) and the shop's panel opens:
  - **Hračkárstvo** (by Michalská brána, Eurovea and Aupark): a water pistol, a bubble gun or a confetti shotgun with a refill, and a raincoat (*Pršiplášť*);
  - **Butik** (Kamenné námestie, Eurovea, Aupark): a jacket in ten colours, and a cap, a hat, a helmet or a scarf. On foot, the police look for the clothes they last saw you in, so a change out of sight works like a change of car;
  - **JUDr. Paragraf** (by the Primate's Palace): a lawyer for the next arrest, who gets your toys back and halves the fee;
  - **Dielňa** (the fuel stations): paint of your choice with a full repair, two engine tiers, two tiers of plating, run-flat tyres, two bigger nitro tanks and neon underglow in seven colours. Tuning belongs to the car: leave it in the street and it's gone;
  - **Garáž** (by six of the places you start from): park the car you drive and take it out again at any of your garages, colour, tuning and dents and all. Two places to start with, up to six;
  - **Zbierka**: drive every kind of vehicle in the city, all 13 (the police car, the bus, the ambulance, a scooter, a bike, a boat and the police boat included) for €1,000, and 100 points online.

  Getting soaked through leaves its fee where you went down, less the first €100, as cash anyone can pick up for two minutes. The panels work with the mouse, the keyboard, a touch screen and a gamepad (the d-pad or stick moves, A chooses, B leaves). Online, the prices come from the server, which checks every purchase.
- **Behind the wheel, and new ways around** ([docs/plans/gameplay.md](docs/plans/gameplay.md), Phase 3):
  - **Style**, online too: near misses, drifts, splashes, high fives, last-second dives, stalls, police cars sidelined and the new moves (*WRONG WAY* down a one-way street, *AIR* off a bump taken fast, *RED LIGHT* at speed, *THREAD THE NEEDLE* flat out through a building's passage, *TRAM DODGE*, a *CLEAN GETAWAY* in an undamaged car) chain into a combo, up to ×5, that pays when it ends and scores on the **Štýl** board;
  - **slipstream** close behind a bus, a van or a tram (a little more top speed, and the nitro fills much faster), and **damage you feel**: a dented side pulls the steering, and a smoking engine loses power;
  - **sirens**: H in a police car or an ambulance, and traffic pulls over. An **ambulance** waits at every hospital and dries its driver off, 2 HP a second;
  - **scooters and bikes** (*Bolťák* e-scooters at the bike-share docks, bikes at the stands): 25 and 30 km/h, through the bollard rows police cars can't pass. A hard knock throws the rider off, and a squirt reaches them;
  - **trams**: ride one (on at a stop, off at the next: the police take twice as long to pick you out of the passengers), or steal one from its cab and drive it on its tracks (throttle, brake, A/D for the branch at a junction, H for the bell);
  - **the Danube**: swim (20 s at a third of walking pace; cops on foot stop at the bank), take a boat moored at a pier, and at 4★ a police boat comes after you on the water.
- **Six missions tied to real places**, started from phone booths:
  - taxi fare from the castle to Eurovea;
  - Kofolka delivery to the UFO bridge;
  - getaway from Michael's Gate;
  - time trial along the Danube embankment;
  - car theft from the Blue Church to Aupark;
  - a finale in Sad Janka Kráľa.
- **Minihry: twelve mini-games from five years of Bratislava** ([docs/plans/minigames.md](docs/plans/minigames.md)). Short rounds of a few minutes, each a joke every Bratislavan gets, started from **Aktivity** (U) wherever you are, online or off. Every one can be played alone; online, whoever is near can join, and then it's against each other (or, in Povodeň and Električkár, together). B (the pad's R3, the violet button on a touch screen) is the round's own action:
  - **Súrna potreba**: the bladder is filling, and the Old Town's toilets are free, paid (have coins) or locked; a café's is for customers only;
  - **Parkovací hon**: pay the parking app before the PAAS scan car comes round the zone; with others, musical chairs for the bays;
  - **Revízor**: ride the trams without a ticket past the inspectors; with others, dodgers against inspectors;
  - **Vydrž do 95. minúty**: car football, 1:0 up in stoppage time against "England" (or 2:0 against "Germany"); with others, two teams;
  - **AKCIA! Maslo**: butter on offer at €1.49, ten blocks a visit past the grannies at the door, sold on before it melts;
  - **Bilbordová vojna**: paste your candidate's posters over the billboards, bus shelters and columns (and moustaches on the rival's) before the campaign silence;
  - **Punčová cesta**: six Christmas market stalls in order, the wobble growing, pickpockets after your mugs and the deposit back at the end;
  - **Kolobežky všade**: park the dumped shared scooters at the docks before the city fines them, and not along the pavement;
  - **Rozkopávky**: deliveries through streets that keep getting dug up; with others, some are the builders;
  - **Električkár**: drive a tram to its schedule, stop by stop, with cars parked on the tracks; a second player drives the tow truck;
  - **Povodeň**: set the mobile flood wall's panels in the gaps before each peak of the Danube, tourists taking selfies in the way;
  - **Horúčava**: 42 °C, ice cream from Stará tržnica to customers before it melts (and you do), by the shade, the fountains and a tram whose air conditioning works.

  A round pays when it's over (up to €600), online scores on the **Minihry** board, and a group round makes Rádio Kecy's news.
- **Collectibles.** There are 10 hidden **Čumil** statues and 52 landmarks to discover.
- **Parody brands.** Rooftop ads and shop signs use spoofs (Kofolka, Strieborný Bažant, Dolinky, Billka, Starbáks, Slovnafta…). No real logos are used.
- **Procedural audio.** Engine, siren, explosions, the toys (squirts, bubble plops, party poppers, a boing, a sad trombone) and four radio stations (*Rádio Expreso*, *Fan Rádio*, *Rádio Dévin Folk*, *Rádio Kecy*) with Slovak DJ chatter.
- **Ten places to start.** A new game, and a first visit online, begins at one of ten places round the city picked at random: Hlavné námestie, Hviezdoslavovo námestie, Námestie SNP, Hodžovo námestie, Slovenský rozhlas, Medická záhrada, Sky Park, Eurovea, Sad Janka Kráľa or Podhradie (`src/shared/world/spawns.ts`). Online, a returning player comes back where they left off, and an invited friend next to whoever invited them.
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
  main.ts              boot, menu, game loop, settings
  shared/              the DOM-free simulation, run by the browser (offline) and the server (online)
    world/World.ts     map data, collision grid (buildings, walls, fences, fountains, posts, trees,
                       tunnel tubes), levels (tunnel / ground / bridge deck / upper deck), water,
                       piers, line of sight, lane and walking-line fitting
    world/Graph.ts     road, footpath and tram networks + A*
    world/TrafficLights.ts  stop lines and signal phases from the real traffic lights; stop and give-way
                       signs, bumps and bus stops on the car graph
    world/Street.ts    traffic islands, speed bumps, lift gates, street furniture
    world/Puddles.ts   the potholes (výtlky) a car's wheel splashes people from
    world/Stalls.ts    the market stalls a car can plough through (MOJE LOKŠE!)
    entities/          Vehicle (tyre-model physics with ABS and stability control), Ped, Tram,
                       Helicopter, props
    sim/               Sim: AI (traffic, pedestrians, trams, parking), Crowd (people among people:
                       seats, tram stops, reactions, fights, witnesses), police, Pursuit (the
                       police's side of a chase: who sees whom, the description, the search, lying
                       low, bribes) and sight.ts (cones, darkness, the helicopter's view), the toys
                       and who gets soaked (Combat.ts), pickups, clock; phrases.ts (what people
                       say); shops/ (the catalog, where the shops are, gear from a save) and
                       rules/Shops.ts (what money buys); rules/Splash.ts (the splash, the high five,
                       the dive: what replaced road kills); rules/minigames/ (the Minihry: MiniGames.ts
                       runs a round, MiniGame.ts is the base every game in games/ extends)
    net/               wire protocol and binary codec
  game/Game.ts         game state, player, wanted level, drawing
  game/LocalSimHost.ts runs the shared Sim offline; net/NetSimHost.ts mirrors the server's online
  game/Gps.ts          waypoint and GPS route over the real streets
  game/touchDrive.ts   touch driving (the stick's direction or steering, K-turns, the brake)
  game/aimAssist.ts    touch aim assist: who the fire button locks onto
  world/Renderer.ts    chunked Path2D map rendering, fake-3D buildings and roof shapes, shadows,
                       trees, lamps, walls and fences, tunnel portals, traffic lights, lane markings
  world/StreetDetail.ts  street furniture (knocked flying by cars), gates, signs, tram stops
  world/BuildingGeometry.ts  exposed wall pieces (party walls hidden, archways cut) and roof slopes
  world/Textures.ts    procedural surface textures (asphalt, cobbles, grass, roof tiles…)
  world/Atmosphere.ts  time of day, sun, ambient colour, rain
  world/Lighting.ts    light map (lamps, headlights, explosions) multiplied over the world
  world/Pigeons.ts     the flocks on the squares (client only)
  world/Weather.ts     rain streaks, splashes, lightning
  render/              vehicles, peds, trams, props, market stalls, name tags, speech bubbles, WebGL
                       PostFX
  missions/Missions.ts mission definitions and runner
  ui/                  HUD (context prompts, pad legend), minimap and the interactive city map;
                       layout.ts (where the HUD goes, phones included), TouchControls.ts and
                       TouchTips.ts (the touch screen's controls and first-run tips); kit/ (panels,
                       with gamepad navigation)
  game/features/       the social features' and the gameplay plan's screens: PoliceUi (the chase),
                       ShopsUi (the shops' signs, map badges and panels), MiniGamesUi (a mini-game
                       round's HUD, marks and result; minigames/draw/ has each game's own drawing),
                       and more
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
into each other, soak each other (it's a crime: the police come after you), and each has their own wanted
level and pursuit. Online progress (money, Čumils, landmarks, and what money bought) is kept on the server,
separately from the single-player save. Missions are single-player only.

On top of that shared world, there's a set of social features (protocol 7):

- **World events**, announced on the map and by Rádio Kecy: **Horúca Kofolka** (a delivery van full of
  cash — whoever drives it earns from the pot until it's drained, wrecked or time runs out),
  **Najhľadanejší** (the first player to hit 5★ gets a bounty that grows every minute, paid to whoever
  soaks them through), **Hon na Čumila** (a golden Čumil hides somewhere in the city behind a shrinking,
  jittered hint circle), **Obrnené auto** (an armoured cash van drives bank to bank — squirt its
  rear doors' lock until it rusts, before it delivers) and **Derby na parkovisku** (an autodróm in a
  parking lot, bump the others until their cars give up, alternating between Aupark and Eurovea).
- **Partia**: invite a friend with a share-able link and they spawn right next to you. Members share
  event/job payouts, can't hurt or jack each other's cars, and show a `[TAG]` on nametags and the map.
- **Revive**: soaked through, you're down and freezing rather than out at once; another player standing
  close by can blow-dry you back up for a "Dobrý samaritán" bonus, or give up to go and dry off at the
  hospital.
- **Kde to je?**: a daily close-up photo of somewhere in the city; the first player to stand on the
  spot wins $1,000.
- **Závod?**: pull up next to another player and hold the horn to challenge them to a race to a
  landmark 1–2 km away, for a stake.
- **Vlk courier / Hopík taxi**: city jobs — deliver food or drive a fare — that work solo, online or off.
- **Minihry** (see *What's in the game*): start one and a line on screen invites the players within
  500 m. They (from up to 600 m away) and your party (from anywhere) have 20 s to join it from Aktivity,
  where 📍 sets the GPS there; with nobody around, it's a 3 s count-in. Most are against each other, for
  places and a bonus; Povodeň and Električkár are played together.
- **Rádio Kecy** breaks in with news of whatever's happening around the city.
- **Proximity voice chat**, for signed-in accounts only: nearby players hear each other over WebRTC,
  with mute, report and a kill switch.
- **Guest or account play**: guests keep today's local-nickname flow; a Supabase account (e-mail +
  password) keeps progress across every device and unlocks voice chat. A guest can claim their
  progress into a fresh account once.
- **Rebríček** (L, or the pause menu): points for nearly everything above — events, jobs, races,
  getaways from the police, landmarks and Čumils, reviving others — on boards for today, this week and
  all time, overall and per kind of thing (Udalosti, Na úteku, Práca, Závody, Mesto, Pomoc, Minihry). Points
  float up as you score them, the HUD shows today's total and rank, and Rádio Kecy names the day's
  leader. See [docs/plans/leaderboard.md](docs/plans/leaderboard.md) for what everything is worth.

**Aktivity** (U, the pad's d-pad down, the chip under the money panel, or the pause menu; on a touch screen
the chip under the street name) puts all of it in one place. It lists every world event: what's on right
now (with a button that sets the GPS there), when the next one may come and which it could be, and what
holds the others back ("treba aspoň 2 hráčov", a cooldown). It also lists every mini-game with its key and
a button to start it or open its panel. The chip itself counts down to the next event. The server sends
the director's plan with the world events (`wev.up`) and resends it when players come, go or step away.
Alone online, only Hon na Čumila can start (the others need 2–3 players), so the panel says so and
suggests inviting a friend.

Hon na Čumila, Obrnené auto, the Vlk/Hopík jobs and all twelve Minihry also run solo, offline. Everything else above —
Horúca Kofolka, Najhľadanejší, Derby na parkovisku, Partia, revive, Kde to je?, voice chat and the
leaderboard — is online only. See `docs/multiplayer.md` for the design and `docs/deploy.md` for running the server.

**Stepping away and coming back** ([docs/plans/pause-resume.md](docs/plans/pause-resume.md)). The shared
city never stops, so online the pause menu (Esc, P, ❚❚, Start, or just switching tabs or apps) is a menu
over a running city, and says so. Your figure stops and others see ⏸ over it; after 3 s, if you're not
wanted and haven't fought another player in the last 15 s, nobody can hurt, arrest or carjack you (🛡).
Racing, the derby, being the most wanted and driving the Kofolka van never get that cover.
**Odísť z mesta** ends the session: it says what's kept, and your spot, health, toys, money and the car
you were driving are saved (a wanted or fighting player's figure stays behind 10 s first). Your party
holds your seat for 15 minutes. Coming back is one click on **Pokračovať online** in the main menu, and a
reload or a restored tab goes straight back in: same spot for 24 hours, your car parked beside you, and
your stars only if you're back within 30 minutes. A dropped connection keeps your figure in the city for
2 minutes, and 15 minutes away (paused or hidden) moves you out of the city, saved.

The button only shows when the client was built with `VITE_SERVER_URL`. The client and the server must
speak the same protocol version (now 7): deploy the server (`fly deploy`) together with the client, or
older clients are refused. (The pausing and coming-back additions, the Aktivity plan, the gameplay plan's
phases and the mini-games kept protocol 7: they're optional on both sides, so either one can go out first. A
client from before the gameplay plan's Phase 3 draws the new vehicles as sedans, and a server from before it
offers no trams to ride: its welcome doesn't list them. Likewise a server from before the mini-games doesn't
list `mini`, and Aktivity says it has none.)

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
