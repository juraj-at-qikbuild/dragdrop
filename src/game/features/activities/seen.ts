// Whether this player has ever opened the Aktivity panel: until they have, its HUD chip pulses, so a
// newcomer notices the one key that lists everything there is to do (Hud.drawActivities).
import { setting } from '../../../ui/kit/settings';

const stored = setting<boolean>('activities-seen', false, (v): v is boolean => typeof v === 'boolean');
let seen: boolean | null = null;

export function activitiesSeen() {
  return (seen ??= stored.get());
}

export function markActivitiesSeen() {
  if (activitiesSeen()) return;
  seen = true;
  stored.set(true);
}
