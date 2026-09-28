// Where the shops are (docs/plans/gameplay.md, Phase 2): worked out from the map, the same way on the
// server and in every client, so a client knows where a shop is without being told and the server
// can check a purchase against it.
// - Dielňa: the fuel stations (the old spray shops), in a car.
// - Garáž: a door on a quiet street by six of the spawn places, in a car or on foot.
// - Hračkárstvo (the toy shop, ten of them round the city), Butik, the lawyer: shopfronts by
//   landmarks, on foot.
// - Teleport: a bay in the street by each of the ten spawn places, on foot or in a car; from any of
//   them to any other, for a price (rules/Shops.ts).
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
/** a teleport's bay */
const TELEPORT_R = 8;
/** a teleport stands at least this far from any other shop's door (m), and this far from its spawn
 *  place at most */
const TELEPORT_GAP = 25;
const TELEPORT_MAX = 260;
/** ...and this far from a tram track (m) */
const TRAM_CLEAR = 5;

/** the shopfronts: kind, id, name, the landmark they're by and an offset from it (m), each landing on
 *  its own walkable spot (a landmark inside a building snaps out of it: two offsets can land on the
 *  same spot, which test/shared/shops.test.ts would catch) */
const FRONTS: { kind: ShopKind; id: string; name: string; at: string; dx: number; dy: number }[] = [
  { kind: 'guns', id: 'guns-michael', name: 'Hračkárstvo u Michala', at: 'michael', dx: 0, dy: 0 },
  { kind: 'guns', id: 'guns-eurovea', name: 'Hračkárstvo Eurovea', at: 'eurovea', dx: 0, dy: 0 },
  { kind: 'guns', id: 'guns-aupark', name: 'Hračkárstvo Aupark', at: 'aupark', dx: 0, dy: 0 },
  // ...and all round the city, so there's one within a few minutes' walk wherever you are
  { kind: 'guns', id: 'guns-kyjev', name: 'Hračkárstvo Kyjev', at: 'kyjev', dx: 0, dy: 0 },
  { kind: 'guns', id: 'guns-hodzovo', name: 'Hračkárstvo na Hodžovom', at: 'hodzovo', dx: 0, dy: 40 },
  { kind: 'guns', id: 'guns-radio', name: 'Hračkárstvo pod Rozhlasom', at: 'radio', dx: 0, dy: 40 },
  { kind: 'guns', id: 'guns-medicka', name: 'Hračkárstvo pri Medickej', at: 'medicka', dx: -40, dy: 0 },
  { kind: 'guns', id: 'guns-skypark', name: 'Hračkárstvo Sky Park', at: 'skypark', dx: 0, dy: 40 },
  { kind: 'guns', id: 'guns-podhradie', name: 'Hračkárstvo v Podhradí', at: 'mikulas', dx: 0, dy: 30 },
  { kind: 'guns', id: 'guns-incheba', name: 'Hračkárstvo Incheba', at: 'incheba', dx: 0, dy: 0 },
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
    const id = `garage-${slug(name)}`;
    out.push({ id, kind: 'garage', name: `Garáž – ${name}`, x: w.car.nx(n), y: w.car.ny(n), r: GARAGE_R, a, car: true, foot: true });
  }
  for (const f of FRONTS) {
    const l = w.landmark(f.at);
    const p = w.walkableNear(l.x + f.dx, l.y + f.dy);
    out.push({ id: f.id, kind: f.kind, name: f.name, x: p.x, y: p.y, r: FOOT_R, a: 0, car: false, foot: true });
  }
  // the teleports, in SPAWNS' order (a destination is its index in `teleports`): the nearest street
  // corner to the spawn place a car can drive on from, at street level, clear of the other shops and
  // the tram tracks
  const depth = w.car.depth;
  for (const s of SPAWNS) {
    let best = -1, bd = Infinity;
    for (const n of w.car.nodesAround(s.x, s.y, 0, TELEPORT_MAX)) {
      const x = w.car.nx(n), y = w.car.ny(n), d = dist(x, y, s.x, s.y);
      // (not on a tram's tracks either: a car arriving there would stand in its way)
      if (d >= bd || (depth && depth[n] !== 0) || w.onBridge(x, y) || w.tunnelDepth(x, y) >= 0 || w.tram.segmentAt(x, y, TRAM_CLEAR)) continue;
      if (out.some((o) => dist(o.x, o.y, x, y) < TELEPORT_GAP)) continue;
      (bd = d), (best = n);
    }
    if (best < 0) continue;
    const pts = linkPoints(w.car.out[best][0]);
    const a = Math.atan2(pts[3] - pts[1], pts[2] - pts[0]);
    out.push({ id: `teleport-${slug(s.name)}`, kind: 'teleport', name: `Teleport – ${s.name}`, x: w.car.nx(best), y: w.car.ny(best), r: TELEPORT_R, a, car: true, foot: true });
  }
  cache.set(w, out);
  return out;
}

/** every teleport, in order: a teleport request names its destination by its index here */
export function teleports(w: World): ShopPlace[] {
  return shopPlaces(w).filter((s) => s.kind === 'teleport');
}

/** a place's name as an id: "Sad Janka Kráľa" → "sad-janka-krala" */
function slug(name: string): string {
  return name.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z]+/g, '-');
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
