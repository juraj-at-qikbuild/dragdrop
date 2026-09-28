# Plan: mini-games from five years of Bratislava (Blava City)

Status: the framework and Súrna potreba built (28 September 2026); the other eleven in progress.

Twelve short mini-games, each a joke every Bratislavan gets: the parking zones, the ticket
inspectors, the EURO 2024 heartbreak, the butter prices, the billboard wars, the Christmas punch,
the e-scooters, the roadworks, the Petržalka tram, the 2024 flood, the heatwaves and the Old Town's
missing toilets. **Every one can be played alone**, whenever a player likes, online or offline; online,
whoever is near (or in the starter's party) can join its lobby, and then it's against each other (or,
for a few, together against the city).

| # | Kind | Game | What it makes fun of | Alone | With others |
|---|---|---|---|---|---|
| 1 | `parking` | Parkovací hon | PAAS zones and their scan cars (since 2022) | against NPC drivers | musical chairs for the bays |
| 3 | `revizor` | Revízor | the ticket inspectors (body cams since 2026) | dodge NPC inspectors | dodgers against inspectors |
| 4 | `football` | Vydrž do 95. minúty | EURO 2024: 1:0 Belgium, Bellingham's 95th-minute kick; 2:0 Germany 2025 | against NPC "England" | team car football |
| 6 | `butter` | AKCIA! Maslo | butter at €4.29 (Oct 2024), discount hunts, grannies | against NPC grannies | race for the same pallet |
| 8 | `billboard` | Bilbordová vojna | every campaign's billboards, and the moustaches drawn on them | against an AI campaign | two campaigns |
| 9 | `punch` | Punčová cesta | the Christmas markets: €4–5 punch, the mug deposit | the list against the clock | who drinks the list first |
| 10 | `scooters` | Kolobežky všade | shared scooters dumped everywhere; off the pavements since 2026 | the clock | who parks the most |
| 11 | `roadworks` | Rozkopávky | the summer roadworks, detours and jams | NPC crews close streets | couriers against builders |
| 12 | `tram` | Električkár | the Petržalka tram at last (July 2025); cars parked on the tracks | alone | a second one drives the tow truck |
| 13 | `flood` | Povodeň | the September 2024 Danube flood and its mobile walls | alone | together |
| 14 | `heat` | Horúčava | 42 °C, trams without air conditioning, the cooling spots | the clock | who delivers most |
| 15 | `toilet` | Súrna potreba | too few public toilets, locked or "for customers only" | the bladder | who makes it first |

(Numbers are the brainstorm's; 2, 5 and 7 were left out.)

## How a round works

- **Starting.** The Aktivity panel (U) has a *Minihry* section: every game with *▶ Hrať*. The round
  opens a **lobby**: 20 s (a game can set its own) when anyone else could join — another active
  player within 400 m, or a party member anywhere online — otherwise a 3 s count-in. The starter can
  cut the lobby short (*Začať hneď*, or the action key).
- **Joining.** Rounds still in their lobby (or live, for a game that takes latecomers) are listed in
  the panel (*Pridať sa*, *Navigovať*), marked on the map, and a line on the HUD tells a player near
  one. Joining needs the player within 600 m of the round, or in its starter's party; a round has a
  player limit per game (`MINI_INFO[kind].max`).
- **One thing at a time.** No round while wanted, during a job (and no job during a round), or,
  offline, during a mission (and no mission during a round). A new round replaces the last one's
  result on screen.
- **Live.** The game runs; each player sees their own state (the objective, a countdown, a meter, a
  few numbers, the standings, their marks in the city and on the map, what the action key does). The
  action key is **B** (the pad's R3, a violet touch button that says what it does). Wasted or busted
  is out of the round, unless the game keeps them.
- **The end.** Each player gets their outcome: money (at most €600 a round), points on the new
  *Minihry* board (1 per €5, 20 awards an hour), a line and, with others, a place. A round two or more
  played makes Rádio Kecy's news. The result stays on screen 6 s.
- **Away.** A player in a round others play isn't shielded while in the pause menu (online).

## The code

Shared (DOM-free, `src/shared/sim/rules/minigames/`):

- `types.ts` — `MiniKind`, `MiniState` (what a player is shown), `MiniMark` (a spot, a zone, a target:
  a ring, a rectangle, a polygon, an emoji and a label; it can follow an entity by id), `MiniOpen` (a
  joinable round), `MiniReq`.
- `catalog.ts` — `MINI_INFO`: every game's name, emoji, colour, about, player limit, what it needs.
- `MiniGame.ts` — the base class a game extends, and `MiniGameDef`, its registration:
  - `create(sim, round)` picks where it happens (or returns why it can't start here);
  - `start()` when the lobby is over, `update(dt)` each step, `view(p)` what `p` sees,
    `act(p)` the action key, `onJoin/onLeave`, `onTimeout` (with a `duration`), the Sim's hooks;
  - `finish()` when it's decided; `outcome(p, {pay, text, points?})` per player; `addPoints` for the
    standings (`board()`, `ranked()`, the place);
  - `spawnVehicle/spawnPed/spawnProp` put things in the city that go when the round ends
    (`dispose()`); a vehicle is a mission vehicle (never despawned), a person is kinematic (the game
    moves them).
- `MiniGames.ts` — the rule: rounds, lobby, joining, sending each player's state (every 0.25 s when it
  changed, and every 2 s), the end (pay, points, news, stats `mini_<kind>`), cleaning up.
- `games/index.ts` — `MINI_DEFS`, one line per game; `games/<kind>.ts` — the game.

Server: `server/src/features/MiniGames.ts` hands the `mini` message to the rule, adds the joinable
rounds to `wev.mg`, stops every round on shutdown, and takes `debug.mini` (start a round, lobby cut
short) for tests. The welcome's `caps` lists `'mini'`.

Client:

- `LiveState.mini` / `miniAt` / `miniOpen`, `SimHost.mini(req)` / `takesMini` (both hosts).
- `src/game/features/MiniGamesUi.ts` — the HUD (top slot, where a mission's objective would be), the
  marks in the city and on the map, the arrow to the target, the result card, the invitation line, the
  action key.
- `src/game/features/minigames/draw/` — a game's own drawing beyond its marks (`MINI_DRAW[kind]`:
  `world`, `hud`, `map`), fed by the state's small `x` record.
- `Game.wobble()` — `x.wobble` (0..1) makes the controls unsteady: the steering pulls, the legs
  wander (the punch, the heat).
- The Aktivity panel's *Minihry* section; Rádio Kecy's `miniOpen` / `miniResult` lines; the
  leaderboard's *Minihry* board.

## Wire (still protocol 7)

Everything is optional both ways, like the trams: the client sends `{ t: 'mini', op, … }` only to a
server whose welcome lists `'mini'`; the private `mini` event, the global `miniOpen`/`miniResult`
and `wev.mg` are kinds and fields an older client ignores. Client and server deploy in either order.

## The games

Each game is its own file (`games/<kind>.ts`), its line in `games/index.ts`, a test
(`test/shared/minigames/<kind>.test.ts`) and, if it needs one, a drawer (`minigames/draw/<kind>.ts`,
its line in `draw/index.ts`). Money: a good solo round pays about €100–250, a great one up to ~€400.

### Súrna potreba (`toilet`) — built
The map's public toilets (`places('wc')`, 8 nearest within 1.1 km) are free (20 %), paid (40 %, needs
coins) or locked (40 %), found out at the door; at least one works. A café's toilet is for customers
(a coffee, €3, gives change); a bakery changes money (€1). The bladder starts at 30 % and fills in
~150 s walking, faster running (×1.7), riding (×1.35) or swimming (×2.2); full is the end. Relief takes
4 s standing by the door, one player at a time. Pay: €60 + up to €70 for the room left + €70/35/15 for
1st–3rd with others.

### Parkovací hon (`parking`)
A PAAS zone of a few streets near the player (the kerbs of the car graph's links): blue bays painted
at the kerb (marks with `w`, `h`, `a`), fewer than the cars. A scan car (a spawned car, driven along a
route through the zone with `sim.ai.driveRoute`) sweeps it every ~60 s; any player's car not standing
in a bay (stopped, its centre inside) when it passes within ~15 m is fined (out after two fines). NPC
drivers (spawned cars driven to free bays) take bays too; alone they're the rivals. Rounds shrink the
bays. Paying at the parking app (the action key in a bay, €2) makes a bay safe for one sweep. Needs a
car.

### Revízor (`revizor`) — built
On the trams (`rules/Trams.ts`). The start is the stop nearest the player (within 600 m); the target
a stop 1–2 km on along the tracks (right-hand running, at most one change of line, by the edges'
`lines`). The round runs its own trams: one comes in, out of sight 150–330 m up the track, to the
platform where a player waits (within 25 m of a stop) and keeps to the way to their target
(`Tram.follow`); any other tram a dodger boards is turned onto the way too. Alone, 1–3 NPC inspectors
(kinematic people in a dark 'suit', 🎫) wait at stops on the way; one boards the player's tram when
it stands at their stop, and after 6 s aboard together it's a €79 fine ("Pokuta 79 €. Revízor s
kamerou si ťa natočil.") and the round's over, unless the player got off first; one who sees them
get off runs after them (5.5 m/s: a walk is caught, a sprint gets away) for 12 s, caught within
1.5 m. Getting off at the target counts after 3 stops ridden (walking doesn't); half the rounds have
a *výluka*: with the target a stop or two ahead it moves 300–900 m on (🚧 at the old one, "Výluka!
Náhradná doprava nejazdí."). Time by the way's length (5–9 min). Pay €150–250 by the stops ridden
(€20 a stop over €110); out of time €8 a stop. With others (4 min): one inspector for every two or
three players by joining order, never the starter; an inspector aboard the same tram as a dodger for
5 s, or on foot within 1.5 m of one who got off in the last 15 s, catches them: the dodger pays the
€79 and is seen off at the next stop (20 s immune), the inspector scores 80. Dodgers score 10 a stop
and 60 a target (then a new one 0.7–1.6 km on). Pay = points. The AI's trams run either way on either
rail and wait nose to nose for ever, so the round takes a tram of the city's coming the other way off
its way (out of sight, or at once when stuck), tows a car parked on the track and steps people off
it. Helpers for both tram games: `games/tramline.ts`.

### Vydrž do 95. minúty (`football`)
Car football in a parking-lot arena (like the derby: `Zones`, `bestParkingNear`), a goal at each end,
a ball: a new vehicle kind `ball` (round, light, bouncy; appended to `VEHICLE_KINDS`, drawn as a
football) so everyone sees it move and the physics pushes it. The players get cars (spawned). Alone:
"you lead 1:0, the 90th minute": keep the ball out of your goal for the stoppage time against NPC
"England" cars (driven by the game toward the ball and your goal); at the end they get a *nožnička*
(a bicycle kick: the ball launched over the cars at the goal) — a second scenario, "Nemecko 2:0",
scores twice. With others: two teams, first to two goals or the most at the whistle.

### AKCIA! Maslo (`butter`)
A flash sale at a Billka/Lidel/Tescó (`pois('shop')` by name) near the player: get there first,
through the grannies crowding the door (kinematic people who push in and block; a shove moves them),
buy with the action key (limited stock, a few blocks each), and sell to buyers around the city before
the butter melts (it melts in the sun and faster in a car; `x` can carry it). Alone against the
grannies and the clock; with others, one pallet for everyone. Pay: the profit.

### Bilbordová vojna (`billboard`)
The map's billboards (69) and bus shelters (92) near the player are the campaign's spots. Paste a
poster (the action key, a few seconds) on a spot; paint a moustache on the rival's (also the action
key). Promises are power-ups on the map (pick one up: "amnestia" clears your stars, "nový most" a
speed boost…). The last minute is the campaign silence: anyone who pastes then is fined. Alone,
against an AI campaign that pastes on its own; with others, two campaigns (teams by joining order).
The spots held at the end decide it; Rádio Kecy calls the districts.

### Punčová cesta (`punch`)
Christmas-market stalls on Hlavné námestie and Hviezdoslavovo námestie (marks; the squares from the
map). A list of stalls to visit in order; each punch (the action key, €4–5) raises the wobble
(`x.wobble`), collect the year's mug, don't lose it to the pickpockets in the crowd, and return mugs
for their deposit at the end. Pay by the stalls done and the time.

### Kolobežky všade (`scooters`)
Dumped scooters (spawned `scooter` vehicles, lying about: on pavements, in the grass, by the Danube)
around the player; ride each to a parking spot (marks at the bike-share docks) before the city's fine
lands on it; riding on a pavement (not the road) is fined. A bonus delivery: a fridge on a scooter
(the wobble while carrying it). Alone against the clock; with others, who parks the most.

### Rozkopávky (`roadworks`)
Deliveries by car across the Old Town while streets close: a closure is cones (`spawnProp`) across a
link and a zone mark; driving through one is a fine. Alone, NPC crews close streets on the route as
you go; with others, the players split into couriers and builders — a builder closes the street
they stand on (the action key) and scores for every courier who has to detour or hits it. Pay by
deliveries, minus fines.

### Električkár (`tram`) — built
A tram of the round's waits at the stop nearest the player (within 700 m), doors open, at its
nearest platform with a few stops ahead (not off to the map's edge); the cab (F at its nose, "Do
kabíny") is no crime. The run: six stops, each the next along the tracks (of the nearest few, the
one with another stop not too far past it; the view says which way to steer at a junction: "Výhybka
o 80 m: drž doľava"), on a *metro interval* (22 s + the way at 9 m/s, 45–80 s). Served stopped with
the nose within 6 m of it, the doors open 3 s: €25–40 on time (by how close), €10 late; gone past by
more than 8 m, −€30. After stops 1, 3 and 5 a car stands on the track 140–300 m ahead (before the
next stop, out of sight): ring the bell (H) within 25 m and its driver walks back and drives it off
in 8 s; the action key calls the tow truck (20 s); pushing through is −€150. With two (co-op), the
second gets a tow truck (a van) near them: next to a car on the track, the action key tows it at
once (+€15), and both get the run's pay. Bonuses: all six on time +€50, no damage +€20. Six minutes;
out of the cab, the tram waits. People of the city's step clear of the running tram; the city's
trams coming the other way (or dawdling ahead) are taken off its track while nobody sees.

### Povodeň (`flood`)
The Danube rises in waves at the Old Town embankment (Fajnorovo/Rázusovo nábrežie): gaps in the
mobile wall along it (marks), panels at a depot (a truck); carry a panel (the action key) to a gap and
set it (the action key). Before each wave's peak every gap must be closed; an open one floods the
street behind it (a zone). Flood tourists taking selfies get in the way. Together with others. A
drawer shows the water line. Pay by gaps held, waves survived.

### Horúčava (`heat`)
A heat meter fills in the sun (fastest on the new Námestie SNP), drains in the shade (trees, arcades),
at drinking fountains and fountains, in the Primate's Palace and on a tram (if its air conditioning
works: a coin flip per tram). Deliver ice cream from Stará tržnica to customers before it melts; the
heat also makes the wobble. Alone against the clock; with others, who delivers most.
