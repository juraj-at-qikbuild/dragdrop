// The words of the Aktivity panel and its HUD chip: what each world event is, where it stands and
// when the next one may come. Pure (no DOM), so test/client/activities.test.ts can read them.
import type { EventKind } from '../../../shared/sim/rules/types';
import { formatMoney } from '../../../shared/util/math';
import type { Forecast, KindStatus } from './forecast';

/** names and colours of the world events (the HUD's event list uses them too) */
export const EVENT_LABEL: Record<EventKind, string> = {
  kofolka: 'Horúca Kofolka',
  wanted: 'Najhľadanejší',
  cumil: 'Hon na Čumila',
  armored: 'Obrnené auto',
  derby: 'Derby na parkovisku',
};
export const EVENT_COLOR: Record<EventKind, string> = {
  kofolka: '#ff8a65',
  wanted: '#ff5252',
  cumil: '#ffd600',
  armored: '#90caf9',
  derby: '#ffab40',
};

/** the panel's order: the scheduled ones, then the one that starts by itself */
export const EVENT_ORDER: EventKind[] = ['kofolka', 'cumil', 'armored', 'derby', 'wanted'];

/** what each one is about, with its prize (the numbers are the events' own, in rules/events/) */
export const EVENT_ABOUT: Record<EventKind, { emoji: string; about: string }> = {
  kofolka: { emoji: '🥤', about: `Dodávka plná peňazí. Kto ju šoféruje, zarába ${formatMoney(10)}/s z ${formatMoney(1500)} – kým mu ju niekto nevezme.` },
  cumil: { emoji: '🔍', about: `Zlatý Čumil sa skrýva v kruhu, ktorý sa zmenšuje. Kto sa ho prvý dotkne, berie ${formatMoney(600)}.` },
  armored: { emoji: '💰', about: `Obrnené auto vozí peniaze medzi bankami. Rozstrieľaj mu zadné dvere a zober ${formatMoney(1200)} (+2★).` },
  derby: { emoji: '💥', about: `Demolačné derby na parkovisku pri Auparku alebo Eurovei. Traja najlepší si delia až ${formatMoney(2400)}.` },
  wanted: { emoji: '🚨', about: 'Hráč s 5★ má na hlave odmenu, ktorá rastie. Kto ho zloží, berie ju; keď ujde, polovica je jeho.' },
};

/** 1 hráč, 2 hráči, 5 hráčov */
export function players(n: number) {
  return `${n} ${n === 1 ? 'hráč' : n >= 2 && n <= 4 ? 'hráči' : 'hráčov'}`;
}

/** "4 min", rounded up (the director's timing is itself only good to half a minute) */
export function mins(secs: number) {
  return `${Math.max(1, Math.ceil(secs / 60))} min`;
}

/** "0:42", "12:05" */
export function clock(secs: number) {
  const s = Math.max(0, Math.ceil(secs));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** "o chvíľu" under a minute, else "asi o 4 min" */
export function soon(secs: number) {
  return secs < 60 ? 'o chvíľu' : `asi o ${mins(secs)}`;
}

export type Tone = 'live' | 'ready' | 'wait' | 'need' | 'off';

/** where one kind stands, in a few words, and the colour it's shown in */
export function statusText(st: KindStatus): { text: string; tone: Tone } {
  switch (st.s) {
    case 'live':
      return { text: 'práve beží', tone: 'live' };
    case 'ready':
      return { text: 'môže prísť na rad', tone: 'ready' };
    case 'cooldown':
      return { text: st.secs < 60 ? 'znova o chvíľu' : `znova o ${mins(st.secs)}`, tone: 'wait' };
    case 'players':
      return { text: `treba aspoň ${st.need} hráčov · teraz ${st.have}`, tone: 'need' };
    case 'trigger':
      return st.have < st.need ? { text: `pri 5★ · treba aspoň ${st.need} hráčov`, tone: 'need' } : { text: 'keď niekto dosiahne 5★', tone: 'wait' };
    case 'never':
      return { text: 'iba online', tone: 'off' };
    case 'off':
      return { text: 'vypnuté', tone: 'off' };
  }
}

/** "a, b alebo c" (`and`: "a, b a c") */
export function either(items: string[], and = false) {
  return items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} ${and ? 'a' : 'alebo'} ${items[items.length - 1]}`;
}

/** the panel's headline about the next world event */
export function nextLine(f: Forecast): string {
  if (f.busy) return 'Ďalšia udalosť príde, až keď skončí táto.';
  if (f.next === null) return f.kinds.some((k) => k.status.s === 'off') ? 'Udalosti sú teraz vypnuté.' : 'Na ďalšie udalosti treba viac hráčov.';
  return `Ďalšia udalosť ${soon(f.next)}.`;
}

/** which kinds the next one could be ('' while one runs, or when none can come) */
export function candidatesLine(f: Forecast): string {
  if (f.busy || !f.candidates.length) return '';
  const names = f.candidates.map((k) => EVENT_LABEL[k]);
  return names.length === 1 ? `Na rade je ${names[0]}.` : `Môže to byť ${either(names)}.`;
}

/** a nudge when some scheduled kinds are held back only by the player count */
export function morePlayersLine(f: Forecast): string {
  const held = EVENT_ORDER.filter((kind) => f.kinds.some((k) => k.kind === kind && k.status.s === 'players')).map((k) => EVENT_LABEL[k]);
  if (!held.length) return '';
  return `${either(held, true)} ${held.length === 1 ? 'príde' : 'prídu'}, keď vás bude v meste viac – pozvi kamaráta do partie.`;
}

/** the HUD chip's second line ('' when there's nothing to say) */
export function chipLine(f: Forecast | null): string {
  if (!f) return '';
  if (f.busy) return 'udalosť práve beží';
  if (f.next === null) return '';
  return f.next < 60 ? 'udalosť o chvíľu' : `udalosť o ${mins(f.next)}`;
}
