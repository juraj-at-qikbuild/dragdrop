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
  action key is **B** (the pad's R3, a violet touch button that says what it does). Soaked through
  (`wasted`) or busted is out of the round, unless the game keeps them.
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
    moves them, so the AI never gets them up when they're knocked down: `release(ped)` hands one back
    to the city, which does, and sends them home to change).
- `MiniGames.ts` — the rule: rounds, lobby, joining, sending each player's state (every 0.25 s when it
  changed, and every 2 s), the end (pay, points, news, stats `mini_<kind>`), cleaning up.
- `games/index.ts` — `MINI_DEFS`, one line per game; `games/<kind>.ts` — the game.

Server: `server/src/features/MiniGames.ts` hands the `mini` message to the rule, adds the joinable
rounds to `wev.mg`, stops every round on shutdown, and takes `debug.mini` (start a round, lobby cut
short) for tests. The welcome's `caps` lists `'mini'`.

Client:

- `LiveState.mini` / `miniAt` / `miniOpen`, `SimHost.mini(req)` / `takesMini` (both hosts).
- `src/game/features/MiniGamesUi.ts` — the HUD (top slot, where a mission's objective would be), the
  marks in the city and on the map, the arrow to the target (just under the HUD when it points up),
  the result card, the invitation line, the action key.
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

### Parkovací hon (`parking`) — built
The zone is a loop of the car graph a car can drive round near the player (a block or two within
300 m, else anything drivable within 500 m; at street level, round a block rather than up and down a
boulevard, ~260 m if it can), with blue bays (5.2 × 2.4 m, marks with `w`, `h`, `a`) at the right-hand
kerb, clear of junctions, walls, crossings, tram tracks and signs. Each sweep the scan car (a white
hatch, 🔍, `sim.ai.driveRoute`) drives one lap: the first 30–60 s in (later the farther the zone), then
every ~45–60 s, four sweeps (three on a long loop). Whoever it passes within 15 m is checked, and
whoever it never passes when the lap ends: standing in a bay (stopped, its centre inside) with a ticket
from the app (the action key, €2, one sweep, on the tab with empty pockets) is fine, anything else is
a fine (−€20); two and you're out. A player's car in a bay counts as parked, so traffic (the scan car
too) drives round it. NPC drivers turn up before free bays or circle the loop, pull into a free bay
they pass, stay 35–80 s and leave; alone one fewer of them than bays, with others only the bays the
players can't fill. After each sweep the city repaints bays as "zákaz státia": alone 5 → 4 → 3 → 2
(the player's own half the time), with others the players + 3, two fewer each sweep, so with others
the last one standing wins (the round ends when only one is left). Pay: €40 a sweep got through + €80
for finishing − €20 a fine (+€60 for the group's winner). Needs a car.

### Revízor (`revizor`)
On the trams (`rules/Trams.ts`: riding exists). Alone, the player is a fare dodger: ride trams from a
stop to a target stop across the city (and on to a second one); NPC inspectors (kinematic people)
wait at stops and board a tram that stops there; one aboard with the player checks them after a few
seconds unless they get off at a stop first. Caught: a €79 fine and the round's over. With others,
the players split into dodgers and inspectors: an inspector boarding the tram a dodger is on catches
them after a few seconds together; one who gets off and runs is caught on foot within reach. A
*výluka* reroutes a line mid-round (a closure mark). Pay by stops ridden unchecked, and for catches.

### Vydrž do 95. minúty (`football`) — built
The pitch is marked out on the best parking lot within 900 m of the starter (`footballPitch.ts`: a
2 m grid over the lot, free where it's on the lot and clear of walls, trunks, water, buildings, decks
and the car graph; the biggest rectangle that fits, half-length 15–26 m, goals 6–8 m wide and 2.5 m
deep; the nearest lot unless a further one holds a much bigger pitch); none near enough: refused. The
ball is a vehicle kind of its own (`ball`, the last in `VEHICLE_KINDS`: an older client draws a sedan;
1.6 m, 70 kg): it rolls and slows down, bounces off walls and cars (restitution 0.55) and off its
pitch's boards and posts (`Vehicle.pen`), and a net stops it. It takes no damage, never burns or
sinks, nobody gets in, it knocks nobody down, and it's no near miss or tip. Online the server simulates
it (players' cars are moving walls to it) and clients see an interpolated mirror (which stops no car).
When the lobby's over each player gets a car in their half (in with F; whoever drives onto the pitch
keeps their own), and the match kicks off once everyone's in (a warm-up of 40 s plus the way on foot,
4 min at most; nobody came: no pay). Alone, in turn: *Vedieš 1:0* — 90:00 to 95:00 in 3 minutes
against NPC England (a keeper and two strikers the game steers: in an arc behind the ball, three-point
turns, un-sticking), whose Bellingham tries a *nožnička* in the last ~20 s from within 26 m (warned
1.2 s ahead, then the ball flies at the goal at 21 m/s: a car in its way blocks it); an equaliser is
the loss. *Nemecko 2:0* — NPC Germany defends (a keeper and two defenders who clear it wide, steadily);
two goals, and more than Germany's, win. With others: SVK and ENG by joining order, NPC cars evening
the teams up; two goals, or the most at the whistle (3 minutes). A goal stops the clock; the kick-off
puts the ball back on the centre spot (held 3 s) and the NPC cars on theirs, and fixes a battered car.
A goal is the scoring team's last touch's (a deflection off the other team doesn't take it away). No
stars on the pitch for what a match does (a pedestrian knocked over, a police car bumped). Pay: alone
€250 a win, €60 a loss; with others €200 the winners, €60 the others, €100 a draw; +€50 a goal. The
drawer: the pitch chalked on the lot (lines, nets, boards with parody sponsors), a TV score bug
("SVK 1 : 0 ENG 94:12"), GÓÓÓL! and NOŽNIČKA! called out, the pitch and the ball on the map.

### AKCIA! Maslo (`butter`) — built
The sale (€1.49 a block) is at a real grocery (`pois('shop')`: Billka, Lidel, Tescó, Terno Plus, Jeme,
Krajec) 300–900 m from the start, its door the nearest pavement (`walkableNear`, within 35 m). Six
grannies (kinematic, elderly, a headscarf where the seed gives one) crowd the door: at the door the
action key is "Prepáčte, prosím!", 1.5 s of squeezing (they step aside and grumble) and at the counter
— unless an elbow sends you back (30 %, then 15 %; 50/25 % for someone they've seen before). Each press
at the counter is a block, charged at once (the till rounds the running total to whole euros), ten a
visit ("limit na osobu": walk out and squeeze in again for more). The stock is 28 + 12 per player, one
for everyone, and the grannies take 1–2 every 11–16 s as one leaves and another arrives. Buyers (💰,
hands up) stand 200–750 m from the shop (later round the players), 3–5 blocks each at €3.80–4.60 (the
further out, the more), and wait 140–220 s. The bag warms up (the meter) in 90 s on foot, three
times as fast in a car (twice on a tram, 1.3× on a scooter), not at the counter; full, a block melts
(gone) and it's at half again. 4 minutes, or until the shelf is empty and nobody has butter left. Pay
(at the end): the sales + €8 a block sold (+€40/20/10 for 1st–3rd by profit with others, in profit);
the purchases already cost, so a round nets the profit and the bonus.

### Bilbordová vojna (`billboard`) — built
The map's billboards, bus shelters and advertising columns around the start are the spots: the
nearest 24 within 700 m that someone on foot reaches (as far as 1.1 km where there are fewer than
12), each free, red's, blue's or moustached (then it counts for nobody). Two made-up candidates,
drawn per round: Ing. Jožko Sľubný („Nový most do roka!“) and Mgr. Zuzka Cyklopruhová („Viac
zelene, menej áut!“). A poster takes 3 s standing still on foot within 4.5 m (the action key;
moving cancels), a moustache on the rival's 1.5 s, and then it can be pasted over. Promises (⭐,
three at a time): *Nový most* (the next paste instant), *Električka do každej obce* (the next two in
0.8 s), *Amnestia na pokuty* (clears the stars, or lets off the next fine). The last 48 s are the
campaign silence: a paste then is €50 and a police star (moustaches are allowed). Alone, the AI
campaign moves every 12–16 s (slower when it leads, quicker behind: ×0.8–2), pasting free spots far
from the player, then moustaching theirs; with others, two campaigns by joining order, and the AI
runs one whose players have all left. 4 min; the result in percentages of the posters up; pay
€250 won / €80 lost / €150 drawn (only for whoever pasted or drew anything) + €5 a spot the
campaign holds. A drawer paints the posters onto the billboards and each spot's colour on the map.

### Punčová cesta (`punch`) — built
Fifteen stalls stand on the two squares (`marketStalls`: from the map alone, the same on the server
and in the client's drawer, `draw/punch.ts`, which draws the wooden huts with awnings and fairy
lights): on the square's outline, clear of walls, fountains, trunks, water, roofs, roads and tree
crowns, counters facing the middle — punch at €4–5, a turbo at €6, two sausage stalls (€9, steadies
you), decorations, gloves and the "Záloha za hrnčeky" stall. A round's list is six drink stalls, three
on each square, in a shuffled order (the arrow on the next; the others refuse until their turn); each
drink is paid at once, comes in a mug and adds 0.12 to the wobble (the turbo 0.2), which wears off at
0.003/s (`x.wobble`). Up to 22 visitors stand at the counters (they step aside for a player) and 3
pickpockets (+1 per extra player) haunt the players' next stalls: one goes for anyone who's stood
about with a mug for a second, takes one ("Vreckár ti vzal hrnček!") and runs off for 7 s — run into
him and it's back. Mugs go back at the deposit stall for €2 each. It can be started within 1.5 km of
Hlavné námestie (the round sits at the market). 4 minutes; done when the list is and the mugs are
back. Pay: €100 + up to €80 for speed (full at 1:30) + €15 a mug returned (+€50/25/10 for the first
three with others); out of time, €12 a stall and €8 a mug returned.

### Kolobežky všade (`scooters`) — built
8 dumped scooters (one more for each other player, at most 12) lie 100–450 m from the start on the
pavements and in the grass (off the carriageway, dry, outside the buildings, by a path), each within
220 m of one of the 12 nearest bike-share docks, each with the city's countdown to a fine for its
operator (100–270 s; it stops while someone rides it; run out, the scooter's gone). Stopped within
3.5 m of a dock after a ride (getting off, or the action key *Zaparkovať*), it's parked. Riding any
scooter off the carriageway (`World.onCarriageway`, 0.6 m past its edge) for 30 m on end is €10
(a warning at 8 m); not on a marked crossing, in a car park, by a dock, nor within 15 m of where the
ride began. The fridge (20 s in): loaded at A onto any scooter, it wobbles (`x.wobble` 0.35), falls
off when its rider gets off, and at B (stopped within 5 m) the video's views pay €110 and the police
fine €50. 4 min (sooner when every scooter is parked or lost); pay €20 a scooter, €40 for all of
them alone, €30 for the most with others, the fridge, less the fines. A drawer shows the fridge.

### Rozkopávky (`roadworks`) — built
Four minutes of deliveries by car: each address is on a named street 300–750 m from the last, and
stopping within 12 m hands the parcel over (€50). A closure is a 14 m stretch of street fenced off with
a barrier and three cones (`spawnProp`) and marked 🚧 with its crew (vodovod, teplovod, nové koľaje…);
a car driving into it is fined €20 once per closure, and the hole takes 60 % of its speed and a knock.
Alone, NPC crews dig every 20–30 s on the courier's way to the address (its A* route, 70–320 m ahead,
out of sight if they can), at most six open, each reopening after 70–100 s. With others, one builder
per three players (at least one; the second, fifth… to join, never the starter): the action key digs
up the street they stand or drive on (every 8 s, at most five of theirs, never within 20 m of a courier
or 25 m of a courier's address), and a courier driving into it scores for them; builders see the
couriers and their addresses. Pay: couriers €50 a delivery − €20 a fine, builders €30 + €40 a catch,
+€40 for the group's winner. Needs a car.

### Električkár (`tram`)
Take a tram's cab (the game can put the player in one at the nearest stop) and drive its line: stop
at each stop (stopped within a few metres, doors for 3 s), on a schedule (a *metro interval*).
Cars parked on the tracks ahead (spawned): ring the bell (H) and wait for the driver, wait for the
tow truck, or push it and pay for the damage. With two, the second drives the tow truck that clears
the line. Pay by stops on time.

### Povodeň (`flood`) — built
The wall stands on the real bank: the river's edge between Most SNP's deck and Eurovea (scanned once
per map from `inWater`, median-smoothed), 14 m inland of it on the promenade, nearest the start (Rázusovo,
Vajanského, Fajnorovo nábrežie, the Eurovea promenade). 10 gaps 16 m apart, 5 open at first (one more for
each player who joins the lobby, at most 8); a van (locked, scenery) and its stack of panels behind the
wall's middle. On foot: take a panel at the stack, set it in a gap within 3.5 m (the action key). Started
away from the river, it's "Utekaj na …!" first: the waves start when someone's within 60 m of the stack
(or after 180 s anyway); further than 1.5 km it won't start. Four waves peak at 75, 130, 185 and 240 s
(8.4, 9.0, 9.4, 9.7 m; the HUD's countdown is to the next peak); an open gap at a peak floods the street
behind it (a zone mark, the drawer's water) and costs the shared score €10; three breaches and it's
lost. 8 s after each peak the wave knocks out 1 + players panels. Flood tourists (every 15 s alone, 9 s
with others; 2, up to 4 at a time) stroll to an open gap and take selfies in it; the panel waits until
they're asked (the action key, "Choďte preč, prosím!") and go 2 s later. Together: one score, the same
pay (€40 a wave held, €60 for no breach at all) plus €3 a panel set (up to €30); lost, €15 + €2 a panel
(up to €15), nothing if nobody set one. The drawer: the river climbing the promenade to the wall
(wider and lighter as it rises), the wall's sections grey, set panels orange, open gaps blinking red
in the last 15 s before a peak, the flooded streets, the stack, the panel carried.

### Horúčava (`heat`) — built
Four minutes. Up to two cones at a time from the counter at Stará tržnica (the action key, from a car's
window too), to customers (people waiting outside cafés and bistros 300–900 m from the market, 150 m
apart; two alone, one more than the players with others). Where the player is sets how fast they heat
up and the ice cream melts (looked at every 0.25 s): the sun (full heat in 150 s, a cone in 130 s),
Námestie SNP's outline, the asphalt sea (70 s, 75 s, "60 °C"; the market's counter is on it), running
×1.6; shade under the trees' canopies or a roof cools, as do the drinking fountains (❄️, marked within
250 m), the fountains (the map's small water), the city's mist sprayers on Hlavné, Kamenné and
Hviezdoslavovo námestie, the Primate's Palace (its courtyard, through the gateway) and a tram whose air
conditioning works (a coin flip per tram and round: "Klíma ide!", else "Vyhňa…", which cooks); a car has
none. Over 55 % the legs go (`x.wobble`); at 100 % they faint: the cones in hand are gone, the heat
drops to 50 % and they're dizzy for 8 s. Pay €40 a cone + a tip of up to €20 for how much of it is still
ice cream; with others, whoever delivers most (ties: the tips) gets €40/20/10 more. The drawer: a warm
haze closing in from the screen's edges as the heat rises.
