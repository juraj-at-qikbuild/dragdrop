// What the introduction (OnboardingUi) has already done on this device, remembered in localStorage:
// shown for online play, shown for offline play, and the one-time tip on the first world event.
import { setting } from '../../../ui/kit/settings';

export type IntroMark = 'online' | 'offline' | 'event';

const store = setting<string[]>('onboarding-v1', [], (v): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string'));
let done: Set<string> | null = null;

export function introDone(m: IntroMark) {
  return (done ??= new Set(store.get())).has(m);
}

export function markIntro(m: IntroMark) {
  if (introDone(m)) return;
  done!.add(m);
  store.set([...done!]);
}
