// The client features the Game runs. Each feature adds its line here (docs/plans/social-events.md).
import type { Game } from '../Game';
import type { ClientFeature } from './ClientFeature';
import { PartyUi } from './PartyUi';
import { ReviveUi } from './ReviveUi';

export type { ClientFeature };

export function createClientFeatures(g: Game): ClientFeature[] {
  const out: ClientFeature[] = [];
  out.push(new ReviveUi(g));
  out.push(new PartyUi(g));
  // each feature adds its line here: out.push(new EventsOverlay(g)) …
  return out;
}
