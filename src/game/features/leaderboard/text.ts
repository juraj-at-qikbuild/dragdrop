// What the leaderboard panel says (src/game/features/LeaderboardUi.ts): the boards' names and what
// each covers, what every point is for (straight from the points table, so it can't drift), and the
// countdown to a new day or week. Pure and DOM-free, like news/lines.ts, so test/client can check it.
import { GETAWAY_MIN_S, POINTS, type BoardId, type ScorePeriod } from '../../../shared/sim/rules/points';

export const PERIOD_LABEL: Record<ScorePeriod, string> = { day: 'Dnes', week: 'Týždeň', all: 'Celkovo' };
export const PREV_LABEL: Record<'day' | 'week', string> = { day: 'Včera vyhral', week: 'Minulý týždeň vyhral' };
export const BOARD_INFO: Record<BoardId, { label: string; icon: string; about: string }> = {
  all: { label: 'Spolu', icon: '🏆', about: 'Všetky body za všetko, čo sa dá v meste dokázať.' },
  events: { label: 'Udalosti', icon: '💥', about: 'Horúca Kofolka, odmena za Najhľadanejšieho, Hon na Čumila, Obrnené auto a Derby.' },
  police: { label: 'Na úteku', icon: '🚨', about: 'Útek polícii, prežitie ako Najhľadanejší a zničené policajné autá.' },
  jobs: { label: 'Práca', icon: '🍔', about: 'Vlk kuriér a Hopík taxi, aj tesné obchádzky počas jazdy.' },
  races: { label: 'Závody', icon: '🏁', about: 'Vyhrané Závody? – dôjsť do cieľa prvý, nie kontumačne.' },
  city: { label: 'Mesto', icon: '🗺️', about: 'Kde to je?, objavené pamiatky, skrytí Čumili a zbierka áut.' },
  help: { label: 'Pomoc', icon: '✚', about: 'Hráči postavení na nohy (Dobrý samaritán).' },
};

/** what each thing is worth, for the panel's "Za čo sú body", straight from the points table */
export function pointsHelp(): string[] {
  const P = POINTS;
  return [
    `Vlk kuriér, Hopík taxi: 1 b za každých €${Math.round(1 / P.jobPerDollar)} z výplaty · tesná obchádzka +${P.tip} b`,
    `Závod? vyhratý v cieli: +${P.race} b`,
    `Derby: ${P.derby.join(' / ')} b za 1.–3. miesto, ${P.derbyField} b za účasť`,
    `Horúca Kofolka: +${P.kofolka} b za každých €100 z kasy, +${P.kofolkaTop} b pre najlepšieho`,
    `Najhľadanejší: +${P.wanted} b za minútu na 5★, +${P.escape} b za útek · lovec: ${P.bounty} b + 1 b za každých €${Math.round(1 / P.bountyPerDollar)} odmeny`,
    `Hon na Čumila: +${P.cumil} b · Obrnené auto: +${P.robbery} b za lúpež, +${P.loot} b za balík peňazí`,
    `Útek polícii (naháňačka aspoň ${GETAWAY_MIN_S} s): ${P.getaway.slice(1).join(' / ')} b podľa hviezd · zničené policajné auto +${P.takedown} b`,
    `Kde to je?: +${P.daily} b · pamiatka +${P.landmark} b · Čumil +${P.statue} b · zbierka áut (všetkých 8 druhov) +${P.collection} b`,
    `Postaviť hráča na nohy: +${P.samaritan} b`,
    'Partia sa delí o body z udalostí a práce rovnako ako o peniaze. Body sa rátajú iba online.',
  ];
}

/** "3 h 12 min", "2 d 5 h", "12 min" */
export function until(s: number): string {
  const m = Math.max(1, Math.round(s / 60));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h ${m % 60} min`;
  return `${Math.floor(h / 24)} d ${h % 24} h`;
}
