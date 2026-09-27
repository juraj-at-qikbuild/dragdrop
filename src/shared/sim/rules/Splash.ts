// What replaced running people over (docs/plans/non-violent.md): the reward is for a close pass, never
// for contact (that's a BOING: Sim.bonk).
// - ŠPLECH! A player's car passing someone close and fast through water soaks them: any road when the
//   ground is wet, else a pothole that never dries (world/Puddles.ts). A cop soaked like that is
//   "pokropenie verejného činiteľa", a star.
// - PLÁCNI SI! A fan holding their hand out (Ped.fan) high-fives a player's car passing close and not
//   too fast.
// - HOP DO KRÍKA! Someone diving out of a player's car's way at the last second (AI.dodge).
// All go through the combo as moves waiting to be confirmed (Style.pend): a crash or a BOING a moment
// later voids them. Clients see the splash and the high five as world events.
import type { Ped } from '../../entities/Ped';
import type { Vehicle } from '../../entities/Vehicle';
import type { Sim } from '../Sim';
import type { SimPlayer } from '../SimPlayer';
import type { SimRule } from './SimRule';
import type { Style } from './Style';

/** the splash: at least this fast (m/s), someone within this gap of the car's side (m), who then stays
 *  too wet to count again this long (s); the ground is wet enough for any road to splash from this */
export const SPLASH_SPEED = 8;
export const SPLASH_REACH = 2.8;
export const SPLASH_COOLDOWN = 30;
export const WET_ANY = 0.35;
/** the high five: between these speeds (m/s), within this gap (m), once a fan this often (s), and at
 *  most one a second for a player */
export const FIVE_MIN = 4;
export const FIVE_MAX = 16;
export const FIVE_GAP = 1;
export const FIVE_COOLDOWN = 40;
/** the dive counts for a player once this often (s) */
export const DIVE_EVERY = 2;

/** Where a car's side is to someone: `along` its heading from its centre, `lat` to its left (m), and
 *  the gap between its side and them (<= 0: touching). Exported for the client, which raises a fan's
 *  hand as a player's car comes (Game). */
export function besideCar(v: { x: number; y: number; angle: number; spec: { length: number; width: number } }, x: number, y: number, r: number) {
  const fx = Math.cos(v.angle), fy = Math.sin(v.angle);
  const dx = x - v.x, dy = y - v.y;
  const along = dx * fx + dy * fy, lat = -dx * fy + dy * fx;
  return { along, lat, gap: Math.abs(lat) - v.spec.width / 2 - r };
}

export class Splash implements SimRule {
  readonly id = 'splash';
  /** each player's last high five (sim time) */
  private lastFive = new Map<number, number>();

  constructor(private sim: Sim) {}

  step() {
    for (const p of this.sim.players.values()) {
      const v = p.ped.vehicle;
      if (p.state !== 'play' || !v || v.spec.boat || v.spec.twoWheeler || v.wrecked || v.level !== 0) continue;
      this.scan(p, v);
    }
  }

  onRemove(p: SimPlayer) {
    this.lastFive.delete(p.id);
  }

  private scan(p: SimPlayer, v: Vehicle) {
    const sim = this.sim;
    const sp = v.speed;
    if (sp < FIVE_MIN) return;
    const style = sim.rule<Style>('style');
    const L = v.spec.length, W = v.spec.width;
    const fx = Math.cos(v.angle), fy = Math.sin(v.angle);
    const wet = sim.clock.wet >= WET_ANY;
    sim.forPedsNear(v.x, v.y, L / 2 + 4, (q) => {
      if (q.playerId || q.vehicle || q.aboard || q.dazed || q.kinematic || q.level !== v.level) return;
      const { along, lat, gap } = besideCar(v, q.x, q.y, q.r);
      if (gap <= 0) return;
      const side = lat >= 0 ? 1 : -1;
      // a fan beside the car with their hand out: a high five
      if (q.fan && (q.state === 'walk' || q.state === 'idle') && sp <= FIVE_MAX && gap <= FIVE_GAP && Math.abs(along) <= L / 2
        && sim.time >= q.fiveAt + FIVE_COOLDOWN && sim.time >= (this.lastFive.get(p.id) ?? -Infinity) + 1) {
        q.fiveAt = sim.time;
        this.lastFive.set(p.id, sim.time);
        // (the hands meet halfway across the gap)
        const k = side * (W / 2 + gap / 2);
        sim.events.highFive(q.id, v.x + fx * along - fy * k, v.y + fy * along + fx * k);
        if (q.state === 'walk') (q.state = 'idle'), (q.timer = 1);
        q.angle = Math.atan2(v.y - q.y, v.x - q.x);
        style?.pend(p, 'highfive', q.x, q.y, { nitro: 0.05 });
        return;
      }
      // the splash: the wheel on their side through water, close and fast
      if (sp < SPLASH_SPEED || gap > SPLASH_REACH || along < -L / 2 - 1.2 || along > L / 2 + 0.4 || sim.time < q.wetUntil) return;
      const wa = Math.max(-(L / 2 - 0.7), Math.min(L / 2 - 0.7, along));
      const wx = v.x + fx * wa - fy * side * (W / 2), wy = v.y + fy * wa + fx * side * (W / 2);
      if (!(wet ? sim.world.surfaceAt(wx, wy, v.level) !== 'offroad' : sim.world.puddles.at(wx, wy, 0.3, true) >= 0)) return;
      q.wetUntil = sim.time + SPLASH_COOLDOWN;
      sim.events.splash(q.id, wx, wy, Math.atan2(q.y - wy, q.x - wx), Math.max(0.4, Math.min(1.2, sp / 20)));
      // they stop, dripping, and say what they think of it
      if (q.state === 'walk') (q.state = 'idle'), (q.timer = 1.3);
      if (q.state === 'idle') q.angle = Math.atan2(v.y - q.y, v.x - q.x);
      if (sim.time - q.saidAt > 2) sim.crowd.sayUp(q, 'water');
      if (q.kind === 'cop') {
        sim.crime(p, 'splashCop');
        style?.pend(p, 'copsplash', q.x, q.y, { nitro: 0.05 });
      } else style?.pend(p, 'splash', q.x, q.y, { nitro: 0.05 });
    });
  }

  /** `q` dived out of the way of `v` at the last second (AI.dodge): a little something for a player at
   *  its wheel, once in a while */
  dove(q: Ped, v: Vehicle) {
    const pl = v.owner ? this.sim.players.get(v.owner) : undefined;
    const style = this.sim.rule<Style>('style');
    if (!pl || pl.ped.vehicle !== v || !style || this.sim.time < style.lastAt(pl, 'dive') + DIVE_EVERY) return;
    style.touch(pl, 'dive');
    style.pend(pl, 'dive', q.x, q.y);
  }
}
