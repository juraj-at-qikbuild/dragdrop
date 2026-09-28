// The words of the mini-games' HUD and panel (docs/plans/minigames.md): the phase and its countdown,
// the result, an invitation to someone else's round. Pure (no DOM), so test/client can read them.
import { MINI_INFO } from '../../../shared/sim/rules/minigames/catalog';
import type { MiniOpen, MiniState } from '../../../shared/sim/rules/minigames/types';
import { formatMoney } from '../../../shared/util/math';

/** "0:42" */
export function clock(secs: number) {
  const s = Math.max(0, Math.ceil(secs));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** the headline over the objective: the game and its phase */
export function headline(s: MiniState): string {
  const i = MINI_INFO[s.kind];
  const phase = s.phase === 'lobby' ? (s.n > 1 ? ` · ${s.n} hráči` : '') : s.phase === 'done' ? ' · koniec' : '';
  return `${i.emoji} ${i.title.toUpperCase()}${phase}`;
}

/** the countdown line: the lobby's count-in, the time left, or nothing */
export function countdown(s: MiniState, left: number): string {
  if (s.phase === 'lobby') return left > 0 ? `Začína o ${clock(left)}` : 'Štart!';
  if (s.phase === 'live') return left > 0 ? clock(left) : '';
  return '';
}

/** the result card's lines: what happened, the money, the place */
export function resultLines(s: MiniState): string[] {
  const r = s.result;
  if (!r) return [];
  const out = [r.text];
  const bits: string[] = [];
  if (r.place) bits.push(r.place === 1 ? '🥇 1. miesto' : r.place === 2 ? '🥈 2. miesto' : r.place === 3 ? '🥉 3. miesto' : `${r.place}. miesto`);
  bits.push(r.pay > 0 ? `+${formatMoney(r.pay)}` : 'bez odmeny');
  out.push(bits.join(' · '));
  return out;
}

/** "Fero spúšťa Parkovací hon – pridaj sa (U)" */
export function inviteLine(o: MiniOpen, key: string): string {
  const i = MINI_INFO[o.kind];
  const who = o.phase === 'lobby' ? `${o.nick} spúšťa` : `${o.nick} hrá`;
  return `${i.emoji} ${who} ${i.title} (${o.n}/${o.max}) – pridaj sa${key ? ` (${key})` : ''}`;
}

/** a place in the standings: "1. Fero 120" */
export function boardLine(board: [string, number][], me: string, max = 4): string {
  return board
    .slice(0, max)
    .map(([nick, pts], i) => `${i + 1}. ${nick === me ? 'Ty' : nick} ${pts}`)
    .join('   ');
}
