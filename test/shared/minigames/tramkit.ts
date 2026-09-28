// For the tests of the mini-games played on the trams (Revízor, Električkár): stepping the city with
// every player's camera on them (the AI keeps trams only around the players' cameras: riding off
// with the camera left behind, the tram would go), and getting on a tram.
import type { Tram } from '../../../src/shared/entities/Tram';
import type { Trams } from '../../../src/shared/sim/rules/Trams';
import type { SimPlayer } from '../../../src/shared/sim/SimPlayer';
import { doorNear } from '../../../src/shared/sim/rules/minigames/games/tramline';
import { standAt, type MiniSetup } from './helpers';

/** Step the city `secs` seconds at 20 Hz, each player's camera on them; `each` true stops early
 *  (returns whether it did). */
export function go(s: MiniSetup, secs: number, each?: () => boolean | void): boolean {
  for (let t = 0; t < secs; t += 0.05) {
    for (const p of s.sim.players.values()) Object.assign(p.observer, { fx: p.ped.x, fy: p.ped.y, cx: p.ped.x, cy: p.ped.y, hw: 30, hh: 18 });
    s.sim.step(0.05);
    if (each?.()) return true;
  }
  return false;
}

export const tramsOf = (s: MiniSetup) => s.sim.rule<Trams>('trams')!;

/** `p` on foot at the door of tram `t` nearest them, and on it; whether they got on */
export function board(s: MiniSetup, p: SimPlayer, t: Tram): boolean {
  const d = doorNear(t, p.ped.x, p.ped.y);
  standAt(p, d.x, d.y);
  p.ped.level = t.level;
  return tramsOf(s).act(p, 'board');
}
