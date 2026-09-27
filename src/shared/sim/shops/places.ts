// Where the shops are (docs/plans/gameplay.md, Phase 2): worked out from the map, the same way on the
// server and in every client, so a client knows where a shop is without being told and the server
// can check a purchase against it.
// - Dielňa: the fuel stations (the old spray shops), in a car.
// - Garáž: a door on a quiet street by six of the spawn places, in a car or on foot.
// - Poľovnícke potreby, Butik, the lawyer: shopfronts by landmarks, on foot.
import type { World } from '../../world/World';
import { linkPoints } from '../../world/Graph';
import { dist } from '../../util/math';
import { SPAWNS } from '../../world/spawns';
import type { ShopKind } from './catalog';

export interface ShopPlace {
  /** stable id (a garage's id is what a player's gear remembers) */
  id: string;
  kind: ShopKind;
  name: string;
  x: number;
  y: number;
  /** how near counts as in it (m): in a car; on foot it's the door, FOOT_R at most (a garage's street
   *  isn't its door for someone walking past) */
  r: number;
  /** a garage: the street's heading at the door (a car taken out faces this way) */
  a: number;
  /** used from a stopped car, and/or on foot */
  car: boolean;
  foot: boolean;
}

/** on foot: stand within this of the door (m) */
export const FOOT_R = 3;
/** a workshop's forecourt (the spray shop's old radius) */
const TUNING_R = 12;
/** a garage's door */
const GARAGE_R = 9;

/** the shopfronts: kind, id, name, the landmark they're by and an offset from it (m), each landing on
 *  its own walkable spot (a landmark inside a building snaps out of it: two offsets can land on the
 *  same spot, which test/shared/shops.test.ts would catch) */
const FRONTS: { kind: ShopKind; id: string; name: string; at: string; dx: number; dy: number }[] = [
  { kind: 'guns', id: 'guns-michael', name: 'Poľovnícke potreby u Michala', at: 'michael', dx: 0, dy: 0 },
  { kind: 'guns', id: 'guns-eurovea', name: 'Poľovnícke potreby Eurovea', at: 'eurovea', dx: 0, dy: 0 },
  { kind: 'guns', id: 'guns-aupark', name: 'Poľovnícke potreby Aupark', at: 'aupark', dx: 0, dy: 0 },
  { kind: 'clothes', id: 'clothes-kamenne', name: 'Butik na Kamennom', at: 'kamenne', dx: 0, dy: 0 },
  { kind: 'clothes', id: 'clothes-eurovea', name: 'Butik Eurovea', at: 'eurovea', dx: -40, dy: 0 },
  { kind: 'clothes', id: 'clothes-aupark', name: 'Butik Aupark', at: 'aupark', dx: 0, dy: -40 },
  { kind: 'lawyer', id: 'lawyer', name: 'Advokátska kancelária JUDr. Paragraf', at: 'primate', dx: 0, dy: 0 },
];

/** the spawn places with a garage on a quiet street nearby */
const GARAGES = ['Hviezdoslavovo námestie', 'Námestie SNP', 'Slovenský rozhlas', 'Sky Park', 'Eurovea', 'Sad Janka Kráľa'];

const cache = new WeakMap<World, ShopPlace[]>();

/** every shop in the city */
export function shopPlaces(w: World): ShopPlace[] {
  let out = cache.get(w);
  if (out) return out;
  out = [];
  for (const f of w.pois('fuel'))
    out.push({ id: `tuning-${Math.round(f.x)}-${Math.round(f.y)}`, kind: 'tuning', name: `Dielňa ${f.n ?? ''}`.trim(), x: f.x, y: f.y, r: TUNING_R, a: 0, car: true, foot: false });
  for (const name of GARAGES) {
    const s = SPAWNS.find((q) => q.name === name);
    if (!s) continue;
    const n = w.car.nearest(s.x, s.y, 150);
    if (n < 0) continue;
    const link = w.car.out[n][0];
    const pts = link ? linkPoints(link) : null;
    const a = pts ? Math.atan2(pts[3] - pts[1], pts[2] - pts[0]) : 0;
    const id = `garage-${name.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z]+/g, '-')}`;
    out.push({ id, kind: 'garage', name: `Garáž – ${name}`, x: w.car.nx(n), y: w.car.ny(n), r: GARAGE_R, a, car: true, foot: true });
  }
  for (const f of FRONTS) {
    const l = w.landmark(f.at);
    const p = w.walkableNear(l.x + f.dx, l.y + f.dy);
    out.push({ id: f.id, kind: f.kind, name: f.name, x: p.x, y: p.y, r: FOOT_R, a: 0, car: false, foot: true });
  }
  cache.set(w, out);
  return out;
}

/** a shop by id */
export function shopById(w: World, id: string): ShopPlace | null {
  return shopPlaces(w).find((s) => s.id === id) ?? null;
}

/** The shop someone at (x, y) is in: on foot or in a car, as the shop takes them. `slack` widens
 *  every door (m): the server allows for where a client's report lags behind. */
export function shopAt(w: World, x: number, y: number, inCar: boolean, slack = 0): ShopPlace | null {
  let best: ShopPlace | null = null, bd = Infinity;
  for (const s of shopPlaces(w)) {
    if (inCar ? !s.car : !s.foot) continue;
    const d = dist(s.x, s.y, x, y);
    if (d <= (inCar ? s.r : Math.min(s.r, FOOT_R)) + slack && d < bd) (bd = d), (best = s);
  }
  return best;
}
