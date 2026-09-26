// Pickups: weapons, health and armour that respawn, one-off cash drops, and the ten hidden Čumil
// statues (collected once per player profile, so each stays visible to players who haven't found it).
import type { World } from '../world/World';
import { dist, rng } from '../util/math';

/** goldenCumil: the Hon na Čumila world event's statue (first to touch it wins; not a collectible) */
export type PickupKind = 'cash' | 'health' | 'armor' | 'pistol' | 'uzi' | 'shotgun' | 'cumil' | 'goldenCumil';
/** index-encoded on the wire: append only */
export const PICKUP_KINDS: PickupKind[] = ['cash', 'health', 'armor', 'pistol', 'uzi', 'shotgun', 'cumil', 'goldenCumil'];

export interface Pickup {
  /** network id */
  id: number;
  x: number;
  y: number;
  kind: PickupKind;
  amount: number;
  /** seconds until it comes back after being taken; 0 = one-off */
  respawn: number;
  /** > 0: taken, seconds until it respawns; -1: gone for good */
  hidden: number;
  /** Čumil statue index 0..9, or -1 */
  cumil: number;
  /** where it came from, for rules that care (e.g. 'van' for the armoured van's spilled cash); not sent */
  tag?: string;
}

/** reward for each Čumil statue */
export const CUMIL_REWARD = 250;

/** The fixed pickup layout (ids are assigned by the Sim). */
export function placePickups(w: World): Omit<Pickup, 'id'>[] {
  const out: Omit<Pickup, 'id'>[] = [];
  const at = (id: string, dx = 0, dy = 0) => {
    const l = w.landmark(id);
    return w.walkableNear(l.x + dx, l.y + dy);
  };
  const add = (p: { x: number; y: number }, kind: PickupKind, amount: number, respawn: number) =>
    out.push({ x: p.x, y: p.y, kind, amount, respawn, hidden: 0, cumil: -1 });
  add(at('main', 20, -15), 'pistol', 36, 45);
  add(at('cathedral', 25, 0), 'uzi', 120, 60);
  add(at('eurovea', 0, -30), 'shotgun', 16, 60);
  add(at('sng', 0, 20), 'pistol', 36, 45);
  add(at('sad', 30, 30), 'uzi', 120, 60);
  add(at('kamenne', -10, 10), 'health', 100, 40);
  for (const h of w.pois('hospital')) add(w.walkableNear(h.x, h.y), 'health', 100, 30);
  add(at('michael', 15, 10), 'armor', 100, 60);
  add(at('snp', -20, 25), 'armor', 100, 60);
  for (const ps of w.pois('police')) add(w.walkableNear(ps.x + 12, ps.y + 12), 'armor', 50, 90);

  // ten hidden Čumil statues spread over the city (fixed seed: the same spots for everyone)
  const r = rng(1337);
  const g = w.ped;
  const spots: { x: number; y: number }[] = [];
  for (let tries = 0; tries < 3000 && spots.length < 10; tries++) {
    const n = Math.floor(r() * (g.nodes.length / 2));
    const x = g.nx(n), y = g.ny(n);
    if (!g.out[n].length || x < w.bounds.x0 + 60 || x > w.bounds.x1 - 60 || y < w.bounds.y0 + 60 || y > w.bounds.y1 - 60) continue;
    if (spots.every((s) => dist(s.x, s.y, x, y) > 420)) spots.push({ x, y });
  }
  spots.forEach((s, i) => out.push({ x: s.x, y: s.y, kind: 'cumil', amount: CUMIL_REWARD, respawn: 0, hidden: 0, cumil: i }));
  return out;
}
