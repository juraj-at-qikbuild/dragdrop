// The rule set a host runs: the world-event director (with every event kind registered) and the
// other rules. Each feature adds its registration here (docs/plans/social-events.md).
import type { Sim } from '../Sim';
import type { SimRule } from './SimRule';
import { WorldEvents, type RulesMode } from './WorldEvents';
import { Revive } from './Revive';

export type { RulesMode };

export function createRules(sim: Sim, mode: RulesMode): SimRule[] {
  const director = new WorldEvents(sim, mode);
  // world events: director.register(KOFOLKA) …
  const rules: SimRule[] = [director];
  // revive is online-only: offline never sets SimOptions.downed, so there's nothing for it to do
  if (mode === 'server') rules.push(new Revive(sim));
  return rules;
}
