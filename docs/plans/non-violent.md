# Plan: mischief instead of violence ("Šibalstvo namiesto násilia", Blava City)

Status: built (27 September 2026), as one change in the order of the steps below. Cars blow up
again since 28 September (decision 4). See [As built](#as-built) at the end for where the build
differs from the plan.

## Context

Blava City is a GTA-2-style sandbox. Its jokes are local satire (parody brands, Rádio Kecy,
grumpy passers-by), but the violence itself was played straight:

- four weapons: fists, pistol, uzi, shotgun (`Combat.ts`);
- police who shoot from 3★, and a helicopter that fires an uzi at 5★;
- cars that burn and explode, leaving scorch marks;
- bodies in growing blood pools, and blood stains that stay;
- screams, and the "ZOŠROTOVANÝ" screen;
- combo moves KILL, ROADKILL, TAKEDOWN! and K.O.

Any car over 16 km/h killed a pedestrian, and that paid a combo. Phase 4 of
[gameplay.md](gameplay.md) planned more: a bat, a Molotov, a brick, a rocket launcher, and shooting the
helicopter down.

This plan keeps the sandbox: steal cars, cause mischief, outrun the police, do jobs and events. But
nobody gets hurt any more, and it has to stay cheeky rather than turn sweet.

## Pillars

1. **Nikto sa nezraní, každý sa nahnevá** (nobody gets hurt, everybody gets annoyed).
   - A hit makes someone wet, soapy, covered in confetti or dizzy.
   - They sit down, grumble, get up and leave.
   - No death, no blood, no bodies. Cars still burn and blow up (decision 4), but that only leaves
     people sooty.
2. **The mechanics stay; the fiction changes.**
   - Weapon roles, damage numbers, stars, arrests, respawn, money and the combo all stay.
   - Damage is getting wet, and health is how dry you are.
   - The wire keeps its ids: the 2-bit weapon (`fist | pistol | uzi | shotgun`) and the 3-bit ped
     state. Saves and server validation don't change.
3. **The reaction is the punchline.** Speech bubbles (`phrases.ts`), Rádio Kecy and the police radio
   carry the jokes, and the victims grumble in Slovak.
4. **Reward mischief and skill, not contact.** The best combos come from close passes and splashes.
   Actually hitting someone only earns a star.

## Decisions

1. **Toys, not weapons** (same stats, same slots). Around them:
   - the vest becomes a **Pršiplášť** (raincoat);
   - health pickups become a **Uterák** (towel);
   - "Poľovnícke potreby" becomes **Hračkárstvo** (toy shop);
   - ammo becomes a **náplň** (refill).

   | Slot | Toy | How it plays | On a person |
   |---|---|---|---|
   | fist | **Šteklenie** (tickling) | melee | they double over laughing |
   | pistol | **Vodná pištoľ** | precise squirts | wet, dripping |
   | uzi | **Bublinkový samopal** | a stream of bubbles | soapy; the final hit floats them off in a giant bubble that pops |
   | shotgun | **Konfetová brokovnica** | short, wide, big push | covered in confetti |

2. **Nobody dies.**
   - A pedestrian at zero health is **down**: sitting dazed on the pavement with little birds circling.
     After a few seconds they get up, grumble and walk off or run away.
   - The wire's `dead` slot is `dazed` now (no new state, no protocol bump).
   - Blood becomes water and soap that dry out. Bodies, blood pools and screams are gone.
3. **The player:**
   - "ZOŠROTOVANÝ" becomes **"PREMOČENÝ DO NITKY"**.
   - At the hospital: "Vysušili ťa a dali ti čaj."
   - Online, downed and bleeding out becomes downed and **freezing** ("Mrzneš"). A friend gets you up
     by **blow-drying** you ("Vyfénuj kamoša").
4. **Explosions stay** (revised on 28 September; first built as a cartoon breakdown, see As built):
   - A car at 0 HP burns and blows up as before: the fireball, the scorch mark, the charred wreck.
   - The push stays. People near it are knocked down **sooty**, as in a cartoon (blackened, the hair
     on end, a wisp of smoke), and get up again; nobody is killed.
   - TAKEDOWN! becomes **ODSTAVENÉ!**.
5. **Police:**
   - Squirt guns at 3★ (same rules as the pistol).
   - SWAT becomes **hasiči** (firefighters).
   - The helicopter tips its **water bucket** instead of firing an uzi.
   - The river police boat squirts too.
   - Arrests stay.
6. **What replaces roadkill** (the reward moves from contact to a close pass):
   - **ŠPLECH!** (the splash-by). A player's car passing someone close, fast, through a puddle soaks
     them. Puddles:
     - any road when the ground is wet (`Clock.wet`);
     - **výtlky**, pothole puddles placed deterministically along the roads (a few never dry, because
       it's Bratislava).

     Soaking a cop is *pokropenie verejného činiteľa* (sprinkling a public official) and costs +1★.
   - **ZĽAKOL SA!** (the dive). People already jump out of a car's way (`AI.dodge`). They now dive
     comically, say so (the unused `SAY_DODGE` line), and a close one pays a little.
   - **BOING!** (contact). Hitting someone knocks them down like a rubber ball, and they get up again.
     No combo, and +1★ (+2★ for a cop) for *nebezpečná jazda* (reckless driving). Trams do the same.
7. **Extras:**
   - **Holuby** (pigeons): flocks on the squares burst into feathers around cars and runners. Client
     only, no points.
   - **PLÁCNI SI!** (drive-by high five): some passers-by hold up a hand as a player's car comes. A
     close pass without contact high-fives them, and it chains into the combo.
   - **MOJE LOKŠE!** (stalls): a few Christmas-market and langoš stalls at named places. A car
     ploughing through one sends food flying and pays a combo move. The stall is rebuilt after a
     while.
8. **Combo labels in Slovak** for everything new or renamed, and without gender (a label pops up
   over a man or a woman alike): ŠPLECH!, SPRCHA!, POLICAJT V SPRCHE!, ODSTAVENÉ!, HOP DO KRÍKA!,
   BOING!, PLÁCNI SI!, MOJE LOKŠE!. The driving moves (NEAR MISS, DRIFT…) stay as they are for now.
9. **One version for everyone.** The online world is shared, so there's no family-mode toggle. The
   violent version lives on in git history.
10. **Wire.** Only optional additions, so it stays on protocol 7:
    - a `m` (mess) field on `pedHit`;
    - new kill causes, which older clients just don't recognise;
    - new world event kinds for the splash, the high five and the stalls, which older clients ignore.

## Words

| Now | Instead |
|---|---|
| Päste / Pištoľ / Samopal / Brokovnica | Šteklenie / Vodná pištoľ / Bublinkový samopal / Konfetová brokovnica |
| Nepriestrelná vesta | Pršiplášť |
| Poľovnícke potreby | Hračkárstvo |
| KILL / cop KILL | SPRCHA!, BUBLI-BUBLI!, KONFETY!, ŠTEKLI-ŠTEKLI! (by the toy) / POLICAJT V SPRCHE! and co. |
| ROADKILL | ŠPLECH! (a close pass) / BOING! (contact, no combo) |
| TAKEDOWN! | ODSTAVENÉ! |
| K.O. {nick} | {nick}: SPRCHA! |
| ZOŠROTOVANÝ | PREMOČENÝ DO NITKY |
| "Nestrieľajte!", "Mám deti!" | "Len nie na vlasy!", "Mám v tom mobil!" |
| "Tu sa strieľa!" | "Tu sa strieka!" |
| "Krvácaš – N s" | "Mrzneš – N s" |
| "skončil na dlažbe" | "skončil v kaluži" |
| "Rozstrieľaj mu zadné dvere" | "Oblej mu zámok, nech zhrdzavie" |
| Streľba / Zbraň | Striekanie / Hračka |

## Steps

Each step leaves `npm test` and `npm run build` green.

1. **Toys.**
   - Names (`Combat.WEAPONS`, the shop catalogue and text).
   - Looks: the toys in hand (`drawPed`), the HUD icons, the touch buttons, the pickups, the reticle.
   - Shots: a water jet, bubbles and confetti instead of tracers, flashes and casings (`Fx.shot`).
   - Sounds: a squirt, bubble pops, a party popper (`Audio.shot`).
2. **Nobody dies.**
   - The ped's "down" state and getting up (`Ped`, `AI`, the crowd, the mirrors).
   - How someone down looks (`drawPed`).
   - Blood becomes mess that dries (`Fx`): the mess is keyed by ped id from `pedHit`, which carries
     `m`.
   - Screams become squeals and giggles.
   - The player's screens: "PREMOČENÝ DO NITKY", freezing instead of bleeding, blow-dry.
3. **Explosions and the police.**
   - `Combat.explode` knocks people down instead of killing them.
   - The PUF, the broken-down wreck (`Fx`, `EntityFx`, `drawVehicle`) and the sad trombone, since
     turned back into the explosion (decision 4).
   - The police's toys, the firefighters and the helicopter's water bucket.
4. **Roadkill's replacements.**
   - `Sim.runOver` and the tram hit become BOING.
   - A new `Splash` rule: ŠPLECH!, the dive, PLÁCNI SI!.
   - Pothole puddles from the road graph, drawn when wet.
   - The client's splash wave and wet people.
5. **Extras:** pigeons (client only) and stalls (a small sim rule plus a world event).
6. **Words:** every string in the table's spirit, across the HUD, shops, radio, events, onboarding,
   missions, the menu and help.
7. **Docs:**
   - This file's As built.
   - Phase 4 of gameplay.md rewritten as toys: a squeaky hammer, a soap bomb, an egg that blinds a
     windscreen, a foam cannon that grounds the helicopter.
   - README and roadmap.

## Verification

- **Unit tests** (`npm test`):
  - a ped that goes down gets up and leaves;
  - nobody dies from a car, a tram, a shot or a blast;
  - a close pass through a puddle banks ŠPLECH!, and a cop costs a star;
  - contact pays no combo and costs a star;
  - the high five and the stalls pay once, with cooldowns;
  - the wording in the client text tests.
- `npm run build`, and `tsc --noEmit` in `server/`.
- `npm run smoke`, playing offline in a real browser: soak someone, see them sit down and get up,
  splash someone, wreck a car.
- **By hand:** the toys and effects, the pigeons, the stalls, the HUD and the respawn screens.

## Risks

- **A ped coming back from the old `dead` state.** Every reader of `dead` has to treat it as
  temporary: the crowd, the police, witnesses, targeting, collisions, and the mirrors.
- **Stale clients** online still draw blood until they reload. It's cosmetic only, and the next
  deploy fixes it.
- **Rewarding the wrong thing.** Contact must never pay more than a close pass does, or people get
  run over for points again. A test pins it.

## As built

Built in seven commits on protocol 7, as planned, with only optional additions on the wire; an eighth
brought the car explosions back. These are the places where it differs from the plan above, or goes
further.

- **The state is `dazed`, not `down`** (`Ped.dazed`, `knockDown`, `dazedTime`, `pedDazed`), so it
  can't be read as the player's `downed`. `Sim.knockDown` is the only way into it. Someone sits there
  4–7 s (`dazeTime`, from their seed). A driver knocked down at the wheel stops the car, comes round
  and gets out. Carjacking a dazed driver just puts them on the pavement.
- **Leaving** (from the Plan agent's review). Someone who got up heads home to change (`Ped.leaving`).
  - They're gone once no player's camera sees them, and they never count twice.
  - Knocking them down again is a crime but pays nothing: one reward a person, their wallet included.
  - A cop who got up is off duty: out of the chase, the sight cones and the armed cops. Soaking a cop
    still takes them out of the chase, as killing one did.
  - Someone leaving doesn't witness, fight back or put their hands up, and doesn't spread panic.
- **The slide respects the world.** Thrown people slide against walls and stop at the water's edge;
  the old corpse slide went through both.
- **Traffic and trams wait** for someone sitting dazed in the road. A car only nudges them aside, and
  never bounces them twice.
- **Labels by toy, without gender**: SPRCHA!, BUBLI-BUBLI!, KONFETY!, ŠTEKLI-ŠTEKLI! and the cop
  versions (`Style.SOAK_LABEL`). The dive is HOP DO KRÍKA!, not ZĽAKOL SA!.
- **BOING.** A car or a tram that hits someone costs a star (the crimes keep their ids) and shows a
  "BOING!" that banks nothing. It also voids a splash, high five or dive still being confirmed
  (`Style.voidPending`).
- **Getting-up lines** are one say category (7), grouped by what knocked them down (`pickUpLine`).
  That stays inside the old line encoding. A splash reuses the wet group.
- **The potholes** (`world.puddles`): 463 on the map, 180 of them never dry. The splash counts any
  paved road once `Clock.wet` ≥ 0.35. Cars throw spray off their wheels in the same places.
- **The splash, the high five and the dive** are one rule, `rules/Splash.ts`.
  - The splash: at least 8 m/s, within 2.8 m of the car's side, once per person every 30 s. A cop is
    the new crime `splashCop` (+1★).
  - The high five: 4–16 m/s, within 1 m, once per fan every 40 s.
  - The dive: €5, at most every 2 s.
  - A fan (`Ped.fan`, by seed and archetype) beside a player's car's line doesn't dive. Clients raise
    the fan's hand themselves (`besideCar`).
- **The stalls** (`world.stalls`): five, at Hviezdoslavovo, Kamenné, Eurovea, Námestie SNP and
  Hodžovo námestie. The market hall's square had no free spot. A stall is back 120 s after being
  knocked over. Knocking one over is the `destroy` crime (+0.6★), as blowing up a car is.
- **The pigeons**: a flock at ten squares, gone after dark. Besides cars and runners, a squirt, an
  explosion, a splash, a horn and a stall going over also send them off.
- **The firefighters** carry the `Vehicle.swat` flag (from the snapshot's existing swat bit on a
  mirror): a red van with a ladder and HASIČI. The helicopter's water bucket hangs under it, and its
  shots are water whatever it fires.
- **Cars blow up again** (28 September, the eighth commit). The first build had a car at 0 HP give up
  in a PUF of foam and confetti, steaming, its bonnet up and its hazard lights blinking, with a sad
  trombone. That's gone, and the explosion is back as it was: the flames on a car about to go, the
  fireball, the scorch mark, the charred wreck smouldering for 20 s, the boom and the full jolt.
  - What stays new is the people. Caught in the blast they're knocked down **sooty** (the `soot`
    mess, in place of the PUF's `foam`): blackened, the hair frizzled and smoking, for 25 s. A
    player caught in it looks the same.
  - Getting up, they share the bumped group's "Vidím hviezdičky!" and "Kde to som?", plus "Khe-khe…
    vyzerám ako kominár!" of their own. The tickled group lost "To nebolo fér!" to make room.
- **Rádio Kecy** jokes about the potholes, the pigeons and the puddles. The page's description says
  it's a mischief game where nobody gets hurt.
- **Not done, for later**:
  - the hat blown off in the draught;
  - refilling the water pistol at fountains and hydrants;
  - a city-wide Easter water fight;
  - the driving moves' labels in Slovak;
  - the player's own screens when a blast did it: they still say soaked ("PREMOČENÝ DO NITKY",
    "Mrzneš");
  - Phase 4 of [gameplay.md](gameplay.md), rewritten as toys (a squeaky hammer, a soap bomb, an egg,
    a foam cannon that grounds the helicopter, an umbrella).
- **Verification.**
  - `npm test`: 63 files, 732 tests. New: `test/shared/dazed.test.ts`, `splash.test.ts` (with the
    potholes), `stalls.test.ts` and `test/client/pigeons.test.ts`.
  - `npm run build` and the server's `tsc --noEmit` pass.
  - `npm run smoke`, `npm run smoke:mobile` and `npm run e2e` pass, the e2e including a civilian
    soaked by one player sitting dazed for the other.
  - Screenshots checked by hand: the toys, the dazed poses and the bubble float, the firefighters,
    the potholes, a fan's hand, a stall knocked over and the pigeons; then a car burning, blowing up
    and smouldering, with the people round it sitting sooty and getting up.
