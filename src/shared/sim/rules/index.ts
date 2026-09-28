// The rule set a host runs: the world-event director (with every event kind registered) and the
// other rules. Each feature adds its registration here (docs/plans/social-events.md).
import type { Sim } from '../Sim';
import type { SimRule } from './SimRule';
import { WorldEvents, type RulesMode } from './WorldEvents';
import { Revive } from './Revive';
import { Race } from './Race';
import { Presence } from './Presence';
import { Jobs } from './jobs/Jobs';
import { Shops } from './Shops';
import { Style } from './Style';
import { Ambulances } from './Ambulances';
import { Bikes } from './Bikes';
import { Trams } from './Trams';
import { Boats } from './Boats';
import { MiniGames } from './minigames/MiniGames';
import { KOFOLKA_DEF } from './events/Kofolka';
import { CUMIL_HUNT_DEF } from './events/CumilHunt';
import { MOST_WANTED_DEF, MostWantedWatch } from './events/MostWanted';
import { DERBY_DEF } from './events/Derby';
import { ARMORED_DEF, VanLoot } from './events/ArmoredVan';

export type { RulesMode };

export function createRules(sim: Sim, mode: RulesMode): SimRule[] {
  const director = new WorldEvents(sim, mode);
  director.register(KOFOLKA_DEF);
  director.register(CUMIL_HUNT_DEF);
  director.register(MOST_WANTED_DEF);
  director.register(DERBY_DEF);
  director.register(ARMORED_DEF);
  const rules: SimRule[] = [director];
  // both modes: courier and taxi jobs; the armoured van's spilled cash (it outlives the event); what
  // money buys (docs/plans/gameplay.md, Phase 2)
  rules.push(new Jobs(sim));
  rules.push(new VanLoot(sim));
  rules.push(new Shops(sim));
  // style: the combo, online too; ambulances at the hospitals; scooters and bikes at the docks and
  // stands; riding and driving trams; boats on the Danube, and the police boat (Phase 3)
  rules.push(new Style(sim));
  rules.push(new Ambulances(sim));
  rules.push(new Bikes(sim));
  rules.push(new Trams(sim));
  rules.push(new Boats(sim));
  // the mini-games a player starts from the Aktivity panel, alone or with whoever joins
  // (docs/plans/minigames.md): both modes
  rules.push(new MiniGames(sim, mode));
  // online-only: offline never sets SimOptions.downed (revive), a lone player can't be "most wanted"
  // (minPlayers: 2), races need two players, and offline the pause menu freezes the world (Presence)
  if (mode === 'server') {
    rules.push(new Revive(sim));
    rules.push(new MostWantedWatch(sim));
    rules.push(new Race(sim));
    rules.push(new Presence(sim));
  }
  return rules;
}
