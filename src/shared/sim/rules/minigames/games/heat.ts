// Horúčava (docs/plans/minigames.md): every summer a new record (Slovakia's 42.2 °C in August 2026), trams
// without air conditioning ("vyhňa"), the city's cooling spots, and the new Námestie SNP, an "asphalt sea"
// where a columnist measured 60 °C. The players deliver ice cream from Stará tržnica to customers at
// cafés and bistros 300–900 m away, one or two cones at a time, before it melts (in the sun faster, in
// the shade slower, in a car too: no car has air conditioning) — and they overheat doing it. The sun
// heats them up (the asphalt sea fastest, running worse); shade (under the trees, the arcades), the
// drinking fountains, the fountains, the city's mist sprayers on the squares, the Primate's Palace and a
// tram whose air conditioning works (a coin flip per tram) cool them down. As the heat rises their legs
// go unsteady (the wobble); at the top they faint: the ice cream in their hands is gone, and they come
// round dizzy. Alone it's four minutes against the clock; with others, whoever delivers most wins.
import { clamp, dist, pointInRings, hypot } from '../../../../util/math';
import { Ped } from '../../../../entities/Ped';
import type { Tram } from '../../../../entities/Tram';
import type { World } from '../../../../world/World';
import type { Sim } from '../../../Sim';
import type { SimPlayer } from '../../../SimPlayer';
import { MiniGame, type MiniGameDef, type MiniRound, type MiniView } from '../MiniGame';
import type { MiniMark } from '../types';

/** the round's length (s) */
const ROUND_S = 240;
/** further than this from Stará tržnica (m) it can't start */
export const FAR_R = 1500;
/** customers wait at cafés and bistros this far from the market (m), at least this far from each
 *  other (m), and this close to where someone can stand (m) */
const CUST_MIN = 300, CUST_MAX = 900, CUST_APART = 150, CUST_SPOT = 25;
/** customers waiting at once: alone, and with others (one more than the players, at most) */
const CUST_SOLO = 2, CUST_MAX_N = 5;
/** cones in the hands at most, and how far the action key reaches: the market's counter, a customer (m) */
const CARRY = 2, PICKUP_R = 8, SERVE_R = 7;
/** pay: each cone delivered, and a tip for how much of it is still ice cream (fast is cold) */
export const PAY_CONE = 40, TIP = 20;
/** with others: extra for 1st, 2nd, 3rd (for whoever delivered anything) */
const PLACE_BONUS = [40, 20, 10];
/** the heat at the start, where the legs start to go (the wobble), where the player is warned, and
 *  where they come round after fainting (0..1) */
const HEAT_START = 0.2, WOBBLE_FROM = 0.55, WARN_AT = 0.8, FAINT_TO = 0.5;
/** fainting leaves them dizzy this long (s) */
const DIZZY_S = 8;
/** running this fast (m/s: a sprint; a walk is 4.6) heats this much faster */
const RUN_SPEED = 5.5, RUN_HEAT = 1.6;
/** where the player is (their surroundings) is looked at this often (s) */
const ENV_EVERY = 0.25;
/** a drinking fountain cools within this far (m), a fountain within this far of its rim (m), a mist
 *  sprayer within this far (m) */
const DRINK_R = 3, FOUNTAIN_R = 3, MIST_R = 5;
/** the squares the city puts its mist sprayers on (landmarks) */
const MIST_AT = ['main', 'kamenne', 'hviezdoslav'];
/** cooling spots are marked this far around the player (m) */
const COOL_MARK_R = 250;
/** tree canopies on a grid of this (m) */
const TREE_CELL = 8;
/** a line on the screen about the same surroundings at most this often (s) */
const SAY_GAP = 20;

/** where the player is, as far as the heat goes */
export type Env = 'sun' | 'snp' | 'shade' | 'drink' | 'fountain' | 'mist' | 'palace' | 'ac' | 'oven' | 'car' | 'water';

/** per surroundings: the heat (per second, of the whole meter; below 0 it cools), the melting (per
 *  second, of a whole cone), the temperature it feels like (°C) and a line on getting there */
const ENV: Record<Env, { heat: number; melt: number; temp: number; say?: string }> = {
  // walking in the sun, a leg of a delivery (two minutes) is about all anyone takes
  sun: { heat: 1 / 150, melt: 1 / 130, temp: 38 },
  snp: { heat: 1 / 70, melt: 1 / 75, temp: 60, say: 'Námestie SNP: asfaltové more, 60 °C!' },
  shade: { heat: -1 / 40, melt: 1 / 260, temp: 31 },
  drink: { heat: -1 / 4, melt: 1 / 240, temp: 24, say: 'Pítko! Studená voda za golier. 💧' },
  fountain: { heat: -1 / 8, melt: 1 / 220, temp: 27, say: 'Fontána! Aspoň trochu sa ochladíš. ⛲' },
  mist: { heat: -1 / 6, melt: 1 / 220, temp: 28, say: 'Rozprašovač! Chladná hmla. 💦' },
  palace: { heat: -1 / 6, melt: 1 / 280, temp: 23, say: 'V Primaciálnom paláci je chládok. 🏛️' },
  ac: { heat: -1 / 15, melt: 1 / 400, temp: 22, say: 'Klíma ide! ❄️' },
  oven: { heat: 1 / 80, melt: 1 / 85, temp: 45, say: 'Vyhňa… klíma v tejto električke nejde. 🔥' },
  car: { heat: 1 / 140, melt: 1 / 110, temp: 51, say: 'Auto bez klímy – vnútri je 51 °C.' },
  water: { heat: -1 / 5, melt: 1 / 130, temp: 21, say: 'Osvieženie v Dunaji! 🌊' },
};

// ----------------------------------------------------------------------------- the cool places
/** What cools (and what doesn't) on a map, worked out once per map: the drinking fountains, the
 *  fountains (the small water the map draws), the mist sprayers, the trees' canopies on a grid,
 *  Námestie SNP's outline, the Primate's Palace (its courtyard, reached through the gateway, or its
 *  door), and the cafés and bistros around the market a customer can wait at. */
interface Cool {
  market: { x: number; y: number } | null;
  drink: number[];
  /** flat x, y, radius */
  fountains: number[];
  /** the mist sprayers, flat x, y */
  mist: number[];
  trees: Map<number, number[]>;
  /** its outline and bounding box, and the landmark on it (where its mark's label goes) */
  snp: { ring: number[]; x0: number; y0: number; x1: number; y1: number; lx: number; ly: number } | null;
  /** the courtyard's middle and reach, and the gateway's door */
  palace: { x: number; y: number; r: number; dx: number; dy: number } | null;
  /** customers' spots: where they stand, and what the place is */
  spots: { x: number; y: number; k: string }[];
}

const COOL = new WeakMap<World, Cool>();
const cellKey = (gx: number, gy: number) => (gx + 4096) * 8192 + gy + 4096;

function ringArea(r: ArrayLike<number>) {
  let a = 0;
  for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) a += r[j] * r[i + 1] - r[i] * r[j + 1];
  return Math.abs(a / 2);
}

function centroid(r: ArrayLike<number>) {
  let x = 0, y = 0;
  const n = r.length >> 1;
  for (let i = 0; i < r.length; i += 2) (x += r[i]), (y += r[i + 1]);
  return { x: x / n, y: y / n };
}

function coolOf(w: World): Cool {
  let c = COOL.get(w);
  if (c) return c;
  const m = w.landmarks.get('market');
  const market = m ? w.walkableNear(m.x, m.y) : null;
  // the drinking fountains (the map's furniture)
  const drink: number[] = [];
  for (let i = 0; i < w.furniture.length; i += 4) if (w.furniture[i + 3] === 10) drink.push(w.furniture[i], w.furniture[i + 1]);
  // the fountains: water too small to be the river or a pond (the World leaves them out of its water)
  const fountains: number[] = [];
  for (const rings of w.data.areas.water) {
    const r = rings[0];
    if (!r || r.length < 6) continue;
    const a = ringArea(r);
    if (a < 4 || a >= 4000) continue;
    const o = centroid(r);
    fountains.push(o.x, o.y, Math.sqrt(a / Math.PI));
  }
  // the mist sprayers: one on each of the squares, where people can stand
  const mist: number[] = [];
  for (const id of MIST_AT) {
    const l = w.landmarks.get(id);
    if (!l) continue;
    const at = w.walkableNear(l.x, l.y);
    mist.push(at.x, at.y);
  }
  // the trees' canopies
  const trees = new Map<number, number[]>();
  const t = w.trees;
  for (let i = 0; i < t.length; i += 4) {
    const x = t[i], y = t[i + 1], r = t[i + 2];
    for (let gx = Math.floor((x - r) / TREE_CELL); gx <= Math.floor((x + r) / TREE_CELL); gx++)
      for (let gy = Math.floor((y - r) / TREE_CELL); gy <= Math.floor((y + r) / TREE_CELL); gy++) {
        const k = cellKey(gx, gy), cell = trees.get(k);
        if (cell) cell.push(i);
        else trees.set(k, [i]);
      }
  }
  // Námestie SNP: the square the landmark stands on
  let snp: Cool['snp'] = null;
  const sl = w.landmarks.get('snpsquare');
  if (sl)
    for (const q of w.data.squares ?? []) {
      const ring = q.r[0];
      if (!ring || !pointInRings(sl.x, sl.y, [ring])) continue;
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (let i = 0; i < ring.length; i += 2) (x0 = Math.min(x0, ring[i])), (x1 = Math.max(x1, ring[i])), (y0 = Math.min(y0, ring[i + 1])), (y1 = Math.max(y1, ring[i + 1]));
      snp = { ring, x0, y0, x1, y1, lx: sl.x, ly: sl.y };
      break;
    }
  // the Primate's Palace: its courtyard (the building's largest inner ring), else its door
  let palace: Cool['palace'] = null;
  const pl = w.landmarks.get('primate');
  if (pl) {
    const door = w.walkableNear(pl.x, pl.y);
    const b = w.buildings.find((q) => q.rings.length > 1 && pointInRings(pl.x, pl.y, [q.rings[0]]));
    let yard: ArrayLike<number> | null = null;
    for (const r of b?.rings.slice(1) ?? []) if (!yard || ringArea(r) > ringArea(yard)) yard = r;
    if (yard && ringArea(yard) > 50) {
      const o = centroid(yard);
      let r = 0;
      for (let i = 0; i < yard.length; i += 2) r = Math.max(r, dist(o.x, o.y, yard[i], yard[i + 1]));
      palace = { x: o.x, y: o.y, r: r + 2, dx: door.x, dy: door.y };
    } else palace = { x: door.x, y: door.y, r: 8, dx: door.x, dy: door.y };
  }
  // where customers can wait: outside a café or a bistro, at street level, near the market
  const spots: Cool['spots'] = [];
  if (market)
    for (const k of ['cafe', 'food']) {
      for (const p of w.places(k)) {
        const d = dist(p.x, p.y, market.x, market.y);
        if (d < CUST_MIN || d > CUST_MAX) continue;
        const s = w.walkableNear(p.x, p.y);
        if (dist(s.x, s.y, p.x, p.y) > CUST_SPOT || w.spawnLevel(s.x, s.y, 0.4) !== 0 || w.inWater(s.x, s.y, 0)) continue;
        const ds = dist(s.x, s.y, market.x, market.y);
        if (ds >= CUST_MIN && ds <= CUST_MAX) spots.push({ x: s.x, y: s.y, k });
      }
    }
  c = { market, drink, fountains, mist, trees, snp, palace, spots };
  COOL.set(w, c);
  return c;
}

/** under a tree's canopy */
function underTree(w: World, c: Cool, x: number, y: number) {
  const cell = c.trees.get(cellKey(Math.floor(x / TREE_CELL), Math.floor(y / TREE_CELL)));
  if (!cell) return false;
  const t = w.trees;
  for (const i of cell) {
    const dx = t[i] - x, dy = t[i + 1] - y, r = t[i + 2];
    if (dx * dx + dy * dy < r * r) return true;
  }
  return false;
}

/** by a drinking fountain (the map's furniture) */
function atDrinkingFountain(w: World, x: number, y: number) {
  const out = { at: false };
  w.forFurnitureNear(x, y, DRINK_R, (i) => {
    if (w.furniture[i + 3] === 10 && dist(w.furniture[i], w.furniture[i + 1], x, y) <= DRINK_R) out.at = true;
  });
  return out.at;
}

/** A tram's air conditioning works or it doesn't: a coin flip per tram, the same all round. */
export function tramAc(tramId: number, seed: number): boolean {
  let h = Math.imul((tramId ^ seed) >>> 0, 0x9e3779b1);
  h ^= h >>> 15;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  return (h & 1) === 1;
}

/** "1 zmrzlinu", "3 zmrzliny", "5 zmrzlín" */
function cones(n: number) {
  return `${n} ${n === 1 ? 'zmrzlinu' : n >= 2 && n <= 4 ? 'zmrzliny' : 'zmrzlín'}`;
}

/** Douglas–Peucker: the outline (a closed ring) with fewer points, none further off than `tol` (m).
 *  It's split at the point furthest from its first, since a ring's ends meet. */
function simplify(ring: ArrayLike<number>, tol: number): number[] {
  const n = ring.length >> 1;
  const keep = new Uint8Array(n);
  let far = 0;
  for (let i = 1; i < n; i++) if (dist(ring[0], ring[1], ring[i * 2], ring[i * 2 + 1]) > dist(ring[0], ring[1], ring[far * 2], ring[far * 2 + 1])) far = i;
  keep[0] = keep[far] = keep[n - 1] = 1;
  const stack: [number, number][] = [[0, far], [far, n - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    const ax = ring[a * 2], ay = ring[a * 2 + 1], bx = ring[b * 2], by = ring[b * 2 + 1];
    const l = hypot(bx - ax, by - ay);
    let best = -1, bd = tol;
    for (let i = a + 1; i < b; i++) {
      const px = ring[i * 2], py = ring[i * 2 + 1];
      const d = l > 1e-6 ? Math.abs((bx - ax) * (ay - py) - (ax - px) * (by - ay)) / l : dist(ax, ay, px, py);
      if (d > bd) (bd = d), (best = i);
    }
    if (best >= 0) {
      keep[best] = 1;
      stack.push([a, best], [best, b]);
    }
  }
  const out: number[] = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(Math.round(ring[i * 2]), Math.round(ring[i * 2 + 1]));
  return out;
}

interface Customer {
  x: number;
  y: number;
  k: string;
  ped: Ped;
  /** the spot's index in Cool.spots */
  i: number;
}

interface Player {
  heat: number;
  /** the cones in their hands: how much of each is still ice cream (1 frozen .. 0 melted) */
  cones: number[];
  delivered: number;
  tips: number;
  earned: number;
  /** dizzy until this sim.time (after fainting) */
  dizzy: number;
  env: Env;
  envAt: number;
  /** the tram they were last seen aboard (its air conditioning is announced once a ride) */
  tram: number;
  /** when each surroundings' line was last shown */
  said: Map<Env, number>;
  warned: boolean;
}

// ------------------------------------------------------------------------------------ the round
class Heat extends MiniGame {
  private customers: Customer[] = [];
  /** served customers walking off with their ice cream, until sim.time `until` */
  private leaving: { ped: Ped; until: number }[] = [];
  private state = new Map<number, Player>();
  /** the round's coin for the trams' air conditioning */
  readonly seed: number;

  constructor(
    sim: Sim,
    round: MiniRound,
    readonly cool: Cool,
    readonly pickup: { x: number; y: number },
  ) {
    super(sim, round);
    this.duration = ROUND_S;
    this.seed = sim.rng.seed();
    round.x = Math.round(pickup.x);
    round.y = Math.round(pickup.y);
  }

  start() {
    for (const p of this.players) this.onJoin(p);
    const n = this.players.length > 1 ? Math.min(CUST_MAX_N, this.players.length + 1) : CUST_SOLO;
    for (let i = 0; i < n; i++) this.addCustomer();
    this.tell('Nový rekord: 42,2 °C! Rozvez zmrzlinu, kým sa neroztopí – a neprehrej sa.', '#ffb74d', 3.5);
  }

  onJoin(p: SimPlayer) {
    if (!this.state.has(p.id))
      this.state.set(p.id, { heat: HEAT_START, cones: [], delivered: 0, tips: 0, earned: 0, dizzy: 0, env: 'sun', envAt: -1e9, tram: 0, said: new Map(), warned: false });
  }

  onLeave(p: SimPlayer) {
    this.state.delete(p.id);
  }

  /** a new customer at a café or a bistro, away from the others waiting */
  private addCustomer() {
    const spots = this.cool.spots, rng = this.sim.rng;
    if (!spots.length) return;
    let pick = -1;
    for (let k = 0; k < 40 && pick < 0; k++) {
      const i = rng.int(spots.length), s = spots[i];
      if (this.customers.every((c) => c.i !== i && dist(c.x, c.y, s.x, s.y) >= CUST_APART)) pick = i;
    }
    if (pick < 0) pick = rng.int(spots.length);
    const s = spots[pick];
    const ped = this.spawnPed(new Ped('civ', s.x, s.y, rng.seed()));
    ped.state = 'idle';
    ped.angle = rng.range(-Math.PI, Math.PI);
    this.customers.push({ x: s.x, y: s.y, k: s.k, ped, i: pick });
  }

  // ------------------------------------------------------------------------------ the step
  /** where `p` is, as far as the heat goes */
  envOf(p: SimPlayer): Env {
    const w = this.sim.world, c = this.cool, ped = p.ped;
    const tram = ped.aboard as Tram | null;
    if (tram) return tramAc(tram.id, this.seed) ? 'ac' : 'oven';
    const v = ped.vehicle;
    if (v && !v.spec.twoWheeler) return 'car';
    const f = this.pos(p);
    const { x, y } = f;
    if (w.inWater(x, y, p.focusLevel())) return 'water';
    const pal = c.palace;
    if (pal && (dist(x, y, pal.x, pal.y) <= pal.r || dist(x, y, pal.dx, pal.dy) <= 4)) return 'palace';
    if (atDrinkingFountain(w, x, y)) return 'drink';
    const fs = c.fountains;
    for (let i = 0; i < fs.length; i += 3) if (Math.abs(fs[i] - x) < 40 && dist(fs[i], fs[i + 1], x, y) <= fs[i + 2] + FOUNTAIN_R) return 'fountain';
    for (let i = 0; i < c.mist.length; i += 2) if (dist(c.mist[i], c.mist[i + 1], x, y) <= MIST_R) return 'mist';
    if (w.covered(x, y, p.focusLevel()) || underTree(w, c, x, y)) return 'shade';
    const q = c.snp;
    if (q && x >= q.x0 && x <= q.x1 && y >= q.y0 && y <= q.y1 && pointInRings(x, y, [q.ring])) return 'snp';
    return 'sun';
  }

  update(dt: number) {
    const now = this.sim.time;
    for (const p of this.players) {
      const s = this.state.get(p.id);
      if (!s) continue;
      if (now - s.envAt >= ENV_EVERY) {
        s.envAt = now;
        const e = this.envOf(p);
        if (e !== s.env) this.arrive(p, s, e);
        s.env = e;
      }
      const env = ENV[s.env], ped = p.ped;
      let heat = env.heat;
      if (heat > 0 && !ped.vehicle && !ped.aboard && hypot(ped.vx, ped.vy) > RUN_SPEED) heat *= RUN_HEAT;
      s.heat = clamp(s.heat + heat * dt, 0, 1);
      for (let i = s.cones.length - 1; i >= 0; i--) {
        s.cones[i] -= env.melt * dt;
        if (s.cones[i] > 0) continue;
        s.cones.splice(i, 1);
        this.msg(p, 'Zmrzlina sa roztopila… 🫠', '#ff8a80');
      }
      if (s.heat >= 1) this.faint(p, s);
      else if (s.heat >= WARN_AT && !s.warned) {
        s.warned = true;
        this.msg(p, 'Prehrievaš sa! Tieň, pítko alebo fontána – hneď.', '#ff7043', 3);
      } else if (s.heat < WARN_AT - 0.2) s.warned = false;
    }
    for (const l of [...this.leaving]) {
      if (now < l.until) {
        l.ped.x += l.ped.vx * dt;
        l.ped.y += l.ped.vy * dt;
        l.ped.walkPhase += dt * 4;
        continue;
      }
      this.leaving.splice(this.leaving.indexOf(l), 1);
      this.despawn(l.ped);
    }
  }

  /** `p` got somewhere else: a line about it (a tram's air conditioning once a ride; the rest now and
   *  then) */
  private arrive(p: SimPlayer, s: Player, e: Env) {
    const say = ENV[e].say;
    if (!say) return;
    const now = this.sim.time;
    if (e === 'ac' || e === 'oven') {
      const id = (p.ped.aboard as Tram | null)?.id ?? 0;
      if (id === s.tram) return;
      s.tram = id;
    } else if (now - (s.said.get(e) ?? -1e9) < SAY_GAP) return;
    s.said.set(e, now);
    this.msg(p, say, ENV[e].heat < 0 ? '#80deea' : '#ffab40', 2.5);
  }

  /** Too hot: they black out. The ice cream in their hands is gone, and they come round dizzy (a
   *  passer-by with a bottle of water helped). */
  private faint(p: SimPlayer, s: Player) {
    const had = s.cones.length;
    s.cones = [];
    s.heat = FAINT_TO;
    s.warned = false;
    s.dizzy = this.sim.time + DIZZY_S;
    this.msg(p, had ? 'Odpadol si od horúčavy! 🥵 Zmrzlina skončila na dlažbe.' : 'Odpadol si od horúčavy! 🥵 Okoloidúci ťa polial vodou.', '#ff5252', 3.5);
    this.pop(p, 'ÚPAL!', p.ped.x, p.ped.y - 1.7);
  }

  // ------------------------------------------------------------------------------ the action
  private atPickup(p: SimPlayer) {
    const f = this.pos(p);
    return dist(f.x, f.y, this.pickup.x, this.pickup.y) <= PICKUP_R;
  }

  /** the waiting customer within reach of `p`, nearest */
  private customerAt(p: SimPlayer): Customer | undefined {
    const f = this.pos(p);
    let best: Customer | undefined, bd = SERVE_R;
    for (const c of this.customers) {
      const d = dist(c.x, c.y, f.x, f.y);
      if (d <= bd) (bd = d), (best = c);
    }
    return best;
  }

  /** what the action key does for `p` here (and does it): hand a customer a cone, or take cones at the
   *  market (from the car's window too: it's that kind of heat) */
  private action(p: SimPlayer, s: Player, doIt: boolean): string | undefined {
    if (p.ped.aboard) return undefined;
    const c = s.cones.length ? this.customerAt(p) : undefined;
    if (c) {
      if (doIt) this.serve(p, s, c);
      return 'Podať zmrzlinu';
    }
    if (s.cones.length < CARRY && this.atPickup(p)) {
      if (doIt) {
        const n = CARRY - s.cones.length;
        for (let i = 0; i < n; i++) s.cones.push(1);
        // (a floating word, not a line: the lines on the screen queue up behind each other)
        const f = this.pos(p);
        this.pop(p, n > 1 ? '🍦🍦 a rýchlo!' : '🍦 a rýchlo!', f.x, f.y - 1.7);
      }
      return s.cones.length ? 'Doplniť zmrzlinu' : 'Vziať zmrzlinu';
    }
    return undefined;
  }

  private serve(p: SimPlayer, s: Player, c: Customer) {
    // the best-kept cone goes first
    let best = 0;
    for (let i = 1; i < s.cones.length; i++) if (s.cones[i] > s.cones[best]) best = i;
    const left = s.cones.splice(best, 1)[0];
    const tip = Math.round(TIP * clamp(left, 0, 1));
    s.delivered++;
    s.tips += tip;
    s.earned += PAY_CONE + tip;
    this.addPoints(p, 1);
    this.msg(p, tip ? `Doručené! Tringelt €${tip}. 🍦` : 'Doručené – ale už skoro tekutá. 🍦', '#69f0ae');
    this.pop(p, `+€${PAY_CONE + tip}`, c.x, c.y - 1.7);
    // the customer walks off with it, and someone else somewhere wants one
    this.customers.splice(this.customers.indexOf(c), 1);
    const a = this.sim.rng.range(-Math.PI, Math.PI);
    c.ped.vx = Math.cos(a) * 1.2;
    c.ped.vy = Math.sin(a) * 1.2;
    c.ped.angle = a;
    this.leaving.push({ ped: c.ped, until: this.sim.time + 4 });
    this.addCustomer();
  }

  act(p: SimPlayer) {
    const s = this.state.get(p.id);
    if (s) this.action(p, s, true);
  }

  // ------------------------------------------------------------------------------ the end
  /** the best, then (a tie) the more tips */
  ranked(): SimPlayer[] {
    const tips = (p: SimPlayer) => this.state.get(p.id)?.tips ?? 0;
    return [...this.players].sort((a, b) => this.pointsOf(b) - this.pointsOf(a) || tips(b) - tips(a));
  }

  onTimeout() {
    const group = this.round.started >= 2 && this.players.length >= 2;
    const ranked = this.ranked();
    for (const p of this.players) {
      const s = this.state.get(p.id);
      if (!s || !s.delivered) {
        this.outcome(p, { pay: 0, text: 'Ani jedna zmrzlina nedorazila… 🫠' });
        continue;
      }
      const bonus = group ? (PLACE_BONUS[ranked.indexOf(p)] ?? 0) : 0;
      this.outcome(p, { pay: s.earned + bonus, text: `Doručil si ${cones(s.delivered)}, tringelt €${s.tips}.` });
    }
    this.finish();
  }

  // ------------------------------------------------------------------------------ the view
  private marks(p: SimPlayer, s: Player | undefined): MiniMark[] {
    const marks: MiniMark[] = [];
    const f = this.pos(p), c = this.cool;
    const carrying = !!s?.cones.length;
    // the market's counter, or (with ice cream in hand) the nearest customer
    marks.push({ x: Math.round(this.pickup.x), y: Math.round(this.pickup.y), icon: '🍦', label: 'Stará tržnica', color: '#f48fb1', r: 3, ...(carrying ? {} : { arrow: 1 as const }) });
    let near = -1, nd = Infinity;
    this.customers.forEach((cu, i) => {
      const d = dist(cu.x, cu.y, f.x, f.y);
      if (d < nd) (nd = d), (near = i);
    });
    this.customers.forEach((cu, i) =>
      marks.push({
        x: Math.round(cu.x), y: Math.round(cu.y), e: cu.ped.id, icon: '🙋', label: cu.k === 'cafe' ? 'zákazník · kaviareň' : 'zákazník · bistro', color: '#ffd54f', r: 2.5,
        ...(carrying && i === near ? { arrow: 1 as const } : {}),
      }),
    );
    // the cooling spots around
    for (let i = 0; i < c.drink.length; i += 2)
      if (dist(c.drink[i], c.drink[i + 1], f.x, f.y) <= COOL_MARK_R) marks.push({ x: Math.round(c.drink[i]), y: Math.round(c.drink[i + 1]), icon: '❄️', label: 'pítko', color: '#80deea', r: DRINK_R });
    for (let i = 0; i < c.fountains.length; i += 3)
      if (c.fountains[i + 2] >= 1.5 && dist(c.fountains[i], c.fountains[i + 1], f.x, f.y) <= COOL_MARK_R)
        marks.push({ x: Math.round(c.fountains[i]), y: Math.round(c.fountains[i + 1]), icon: '⛲', label: 'fontána', color: '#4fc3f7', noMap: 1 });
    for (let i = 0; i < c.mist.length; i += 2)
      if (dist(c.mist[i], c.mist[i + 1], f.x, f.y) <= COOL_MARK_R) marks.push({ x: Math.round(c.mist[i]), y: Math.round(c.mist[i + 1]), icon: '💦', label: 'rozprašovač', color: '#80deea', r: MIST_R });
    if (c.palace) marks.push({ x: Math.round(c.palace.dx), y: Math.round(c.palace.dy), icon: '🏛️', label: 'palác – chládok', color: '#80deea', r: 3 });
    if (c.snp) marks.push({ x: Math.round(c.snp.lx), y: Math.round(c.snp.ly), icon: '🔥', label: 'asfaltové more', color: '#ff7043', poly: (this.snpPoly ??= simplify(c.snp.ring, 5)) });
    return marks;
  }

  /** Námestie SNP's outline for its mark, simplified (it's sent with every state) */
  private snpPoly: number[] | undefined;

  view(p: SimPlayer): MiniView {
    const s = this.state.get(p.id);
    if (!s) return { goal: 'Horúčava' };
    const dizzy = this.sim.time < s.dizzy;
    const goal = dizzy
      ? 'Točí sa ti hlava… Chvíľu to potrvá.'
      : s.heat >= WARN_AT
        ? 'Prehrievaš sa! Rýchlo do tieňa, k pítku alebo fontáne.'
        : !s.cones.length
          ? 'Vyzdvihni zmrzlinu v Starej tržnici.'
          : 'Doruč zmrzlinu zákazníkovi, kým sa neroztopí!';
    const wobble = dizzy ? 1 : clamp((s.heat - WOBBLE_FROM) / (1 - WOBBLE_FROM), 0, 1) * 0.75;
    return {
      goal,
      bar: { label: 'Prehriatie', v: s.heat, color: s.heat >= WARN_AT ? '#ff1744' : s.heat >= WOBBLE_FROM ? '#ff7043' : '#ffb74d' },
      stats: [
        ['Doručené', `${s.delivered}`],
        ['Zmrzlina', s.cones.length ? s.cones.map((v) => `${Math.max(1, Math.round(v * 100))} %`).join(' · ') : '–'],
        ['Tu', `${ENV[s.env].temp} °C`],
      ],
      marks: this.marks(p, s),
      act: this.action(p, s, false),
      x: { wobble: Math.round(wobble * 100) / 100, h: Math.round(s.heat * 100) / 100 },
    };
  }

  lobbyView(p: SimPlayer): MiniView {
    return { goal: 'Nový rekord: 42,2 °C. Zmrzlina čaká v Starej tržnici.', marks: this.marks(p, undefined).slice(0, 1) };
  }
}

export const HEAT_DEF: MiniGameDef = {
  kind: 'heat',
  lobby: 20,
  create(sim, round) {
    const c = coolOf(sim.world);
    if (!c.market || c.spots.length < 3) return 'Zmrzlina sa rozváža zo Starej tržnice – tu nie je komu.';
    if (dist(round.x, round.y, c.market.x, c.market.y) > FAR_R) return 'Zmrzlinu rozvážame zo Starej tržnice – príď bližšie do centra.';
    return new Heat(sim, round, c, c.market);
  },
};
