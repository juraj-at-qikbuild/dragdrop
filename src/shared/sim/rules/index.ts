// The rule set a host runs: the world-event director (with every event kind registered) and the
// other rules. Each feature adds its registration here (docs/plans/social-events.md).
import type { Sim } from '../Sim';
import type { SimRule } from './SimRule';
import { WorldEvents, type RulesMode } from './WorldEvents';
import { Revive } from './Revive';
import { Race } from './Race';
import { KOFOLKA_DEF } from './events/Kofolka';
import { CUMIL_HUNT_DEF } from './events/CumilHunt';
import { MOST_WANTED_DEF, MostWantedWatch } from './events/MostWanted';

export type { RulesMode };

export function createRules(sim: Sim, mode: RulesMode): SimRule[] {
  const director = new WorldEvents(sim, mode);
  director.register(KOFOLKA_DEF);
  director.register(CUMIL_HUNT_DEF);
  director.register(MOST_WANTED_DEF);
  const rules: SimRule[] = [director];
  // online-only: offline never sets SimOptions.downed (revive), a lone player can't be "most wanted"
  // (minPlayers: 2), and races need two players
  if (mode === 'server') {
    rules.push(new Revive(sim));
    rules.push(new MostWantedWatch(sim));
    rules.push(new Race(sim));
  }
  return rules;
}
