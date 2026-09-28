// "Čo teraz?": the one thing (and a couple of others) worth doing right now, for the top of the
// Aktivity panel, so a player on a phone with a few minutes gets going with one tap instead of reading
// the whole list. Pure (no DOM, no Game): the caller hands in what it knows, test/client/suggest.test.ts
// checks the choice.
import type { EventEntry } from '../../../shared/sim/rules/types';
import { MINI_INFO } from '../../../shared/sim/rules/minigames/catalog';
import { MINI_KINDS, type MiniKind, type MiniOpen } from '../../../shared/sim/rules/minigames/types';
import { EVENT_ABOUT, EVENT_LABEL } from './text';

export type SuggestAct =
  | { op: 'gps'; x: number; y: number }
  | { op: 'join'; id: number }
  | { op: 'mini'; kind: MiniKind }
  | { op: 'job'; kind: 'courier' | 'taxi' };

export interface Suggestion {
  icon: string;
  /** what it is, a few words */
  title: string;
  /** why now / how far, one short line */
  why: string;
  /** the button's label */
  label: string;
  act: SuggestAct;
}

export interface SuggestIn {
  me: { x: number; y: number };
  inCar: boolean;
  online: boolean;
  wanted: number;
  /** something already going: a mission, a job, a mini-game round (then there's nothing to suggest) */
  busy: boolean;
  events: EventEntry[];
  /** rounds others opened, to join */
  open: MiniOpen[];
  /** offline: the phone booths with a mission to start */
  booths: { x: number; y: number; title: string }[];
  /** the spray shops (the fuel stations), for shaking the police off */
  sprayShops: { x: number; y: number }[];
  /** which of the fitting mini-games to offer (it rotates, so the panel isn't always the same one) */
  turn: number;
}

const far = (d: number) => (d < 1000 ? `${Math.round(d / 10) * 10} m` : `${(d / 1000).toFixed(1)} km`);
const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);

function nearest<T extends { x: number; y: number }>(me: { x: number; y: number }, list: T[]): { it: T; d: number } | null {
  let best: { it: T; d: number } | null = null;
  for (const it of list) {
    const d = dist(me, it);
    if (!best || d < best.d) best = { it, d };
  }
  return best;
}

/** Up to three suggestions, the best first; none while something is already going. */
export function suggest(o: SuggestIn): Suggestion[] {
  const out: Suggestion[] = [];
  // on the run: a spray shop loses the police (and nothing else starts with them after you)
  if (o.wanted > 0) {
    const s = nearest(o.me, o.sprayShops);
    if (s) out.push({ icon: '🎨', title: 'Striasť políciu', why: `Striekareň ${far(s.d)} odtiaľto: nový lak a stratia ťa (€250)`, label: '📍 Navigovať', act: { op: 'gps', x: s.it.x, y: s.it.y } });
    return out;
  }
  if (o.busy) return out;
  // a world event on right now, the nearest first
  const ev = nearest(o.me, o.events.filter((e): e is EventEntry & { x: number; y: number } => e.x !== undefined && e.y !== undefined && e.phase !== 'ending'));
  if (ev) out.push({ icon: EVENT_ABOUT[ev.it.kind].emoji, title: EVENT_LABEL[ev.it.kind], why: `${ev.it.phase === 'announce' ? 'Čoskoro začína' : 'Práve beží'} · ${far(ev.d)}`, label: '📍 Navigovať', act: { op: 'gps', x: ev.it.x, y: ev.it.y } });
  // a round someone opened nearby, still taking players
  const round = nearest(o.me, o.open.filter((r) => r.n < r.max && r.phase !== 'done'));
  if (round && round.d < 1500) {
    const info = MINI_INFO[round.it.kind];
    out.push({ icon: info.emoji, title: info.title, why: `${round.it.nick} hľadá hráčov · ${far(round.d)}`, label: '➕ Pridať sa', act: { op: 'join', id: round.it.id } });
  }
  // offline: the next mission's phone booth
  const booth = o.online ? null : nearest(o.me, o.booths);
  if (booth) out.push({ icon: '☎', title: `Misia: ${booth.it.title}`, why: `Telefónna búdka ${far(booth.d)} odtiaľto`, label: '📍 Navigovať', act: { op: 'gps', x: booth.it.x, y: booth.it.y } });
  // a mini-game that fits how they're getting about (one that needs a car only in one)
  const fits = MINI_KINDS.filter((k) => (MINI_INFO[k].needs.includes('auto') ? o.inCar : true));
  if (fits.length) {
    const kind = fits[((o.turn % fits.length) + fits.length) % fits.length];
    const info = MINI_INFO[kind];
    out.push({ icon: info.emoji, title: info.title, why: 'Minihra na pár minút, hneď tu', label: '▶ Hrať', act: { op: 'mini', kind } });
  }
  // a shift: a taxi in a car, the courier on foot
  out.push(o.inCar
    ? { icon: '🚕', title: 'Hopík taxi', why: 'Voz ľudí po meste za peniaze', label: '▶ Začať zmenu', act: { op: 'job', kind: 'taxi' } }
    : { icon: '🍔', title: 'Vlk kuriér', why: 'Rozvážaj jedlo po meste za peniaze', label: '▶ Začať zmenu', act: { op: 'job', kind: 'courier' } });
  return out.slice(0, 3);
}
