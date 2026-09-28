// The client features the Game runs. Each feature adds its line here (docs/plans/social-events.md).
import type { Game } from '../Game';
import type { ClientFeature } from './ClientFeature';
import { ActivitiesUi } from './ActivitiesUi';
import { DailyCard } from './DailyCard';
import { EventsOverlay } from './EventsOverlay';
import { JobsHud } from './JobsHud';
import { LeaderboardUi } from './LeaderboardUi';
import { News } from './News';
import { OnboardingUi } from './OnboardingUi';
import { PartyUi } from './PartyUi';
import { PoliceUi } from './PoliceUi';
import { PresenceUi } from './PresenceUi';
import { RaceUi } from './RaceUi';
import { ReviveUi } from './ReviveUi';
import { ShopsUi } from './ShopsUi';
import { MiniGamesUi } from './MiniGamesUi';
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
  out.push(new JobsHud(g));
  out.push(new PresenceUi(g));
  out.push(new LeaderboardUi(g));
  out.push(new ActivitiesUi(g));
  out.push(new OnboardingUi(g));
  out.push(new PoliceUi(g));
  out.push(new ShopsUi(g));
  out.push(new MiniGamesUi(g));
  return out;
}
