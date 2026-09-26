// The client features the Game runs. Each feature adds its line here (docs/plans/social-events.md).
import type { Game } from '../Game';
import type { ClientFeature } from './ClientFeature';
import { DailyCard } from './DailyCard';
import { EventsOverlay } from './EventsOverlay';
import { News } from './News';
import { PartyUi } from './PartyUi';
import { RaceUi } from './RaceUi';
import { ReviveUi } from './ReviveUi';
import { VoiceFeature } from './voice/VoiceFeature';

export type { ClientFeature };

export function createClientFeatures(g: Game): ClientFeature[] {
  const out: ClientFeature[] = [];
  out.push(new EventsOverlay(g));
  out.push(new ReviveUi(g));
  out.push(new PartyUi(g));
  out.push(new VoiceFeature(g));
  out.push(new DailyCard(g));
  out.push(new News(g));
  out.push(new RaceUi(g));
  // each feature adds its line here: out.push(new JobsHud(g)) …
  return out;
}
