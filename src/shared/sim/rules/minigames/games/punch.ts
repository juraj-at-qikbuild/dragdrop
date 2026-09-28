// Punčová cesta (docs/plans/minigames.md): every Advent the Christmas markets fill Hlavné námestie and
// Hviezdoslavovo námestie — punch at €4–5 (the "turbo" more), a €9 sausage, a city mug with a deposit on
// it, crowds, and the pickpockets who work them. Out of season? Punč je punč.
//
// The stalls stand on the two squares (the map's own square outlines, clear of walls, fountains, roads
// and trees), always in the same places: marketStalls() works them out from the map alone, so the
// client's drawer (draw/punch.ts) puts its little wooden huts exactly where the game has them. A round
// is a list of six drink stalls in order; at each the action key buys the drink (the money really
// goes), which comes in this year's mug and rocks you a little more (`x.wobble`, which makes the
// controls unsteady: Game.wobble). Pickpockets move through the crowd and go for anyone standing
// still with a mug; run into one making off with yours and it's yours again. The list done, the mugs
// go back at the deposit stall (€2 each). With others it's a race down the same list.
import { dist, pointInRings } from '../../../../util/math';
import { Rng } from '../../../../util/Rng';
import { Ped } from '../../../../entities/Ped';
import type { World } from '../../../../world/World';
import type { Sim } from '../../../Sim';
import type { SimPlayer } from '../../../SimPlayer';
import { MiniGame, type MiniGameDef, type MiniRound, type MiniView } from '../MiniGame';
import type { MiniMark } from '../types';

export type StallKind = 'drink' | 'turbo' | 'food' | 'tree' | 'gloves' | 'deposit';

export interface Stall {
  x: number;
  y: number;
  /** the way its counter faces (rad) */
  a: number;
  kind: StallKind;
  name: string;
  /** what it sells for (€), and how much a drink of it rocks you (0..1) */
  price: number;
  wob: number;
  /** 0: Hlavné námestie, 1: Hviezdoslavovo námestie */
  sq: 0 | 1;
}

/** the two squares, and how many stalls on each */
const SQUARES: [string, number][] = [['Hlavné námestie', 6], ['Hviezdoslavovo námestie', 9]];
/** what stands where, in the order each square's spots come out (the deposit is set apart below) */
const KINDS: StallKind[][] = [
  ['drink', 'drink', 'food', 'drink', 'tree', 'drink'],
  ['drink', 'turbo', 'drink', 'food', 'gloves', 'drink', 'drink', 'tree', 'drink'],
];
/** the drink stalls, in the order they're set out: what they pour and for how much (€) */
const DRINKS: [string, number][] = [
  ['Punč u Jožka', 4], ['Višňový punč', 5], ['Medovina', 5], ['Varené víno', 4], ['Hriatô', 5],
  ['Šípkový punč', 4], ['Staromestský punč', 5], ['Punč k lokšiam', 4], ['Brusnicový punč', 5],
];
/** a punch rocks you this much, the turbo more; a sausage steadies you; they cost this (€) */
export const WOB = 0.12, TURBO_WOB = 0.2, TURBO_PRICE = 6, SAUSAGE = 9, SAUSAGE_WOB = 0.15;
/** the rocking wears off this fast (per second) */
export const WOB_DECAY = 0.003;
/** a stall's hut needs this much room all round (m); its spot is looked for on a grid this fine, at
 *  least this far from the next stall (on Hlavné, on Hviezdoslavovo) */
const STALL_R = 2.0, GRID = 3, GAP = [12, 14];

const cache = new WeakMap<World, Stall[]>();

/** The market's stalls on the map: the same on the server and in every client (the drawer's huts),
 *  from the map alone. A spot is on the square with room for the hut (no wall, fountain, post or trunk
 *  within STALL_R, no water, no roof over it, not on a road, not under a tree's crown) and for people
 *  at its counter; the spots are picked in a fixed shuffled order, apart from each other. The counters
 *  face the middle of the square. The deposit is the stall on Hviezdoslavovo námestie nearest Hlavné. */
export function marketStalls(w: World): Stall[] {
  const hit = cache.get(w);
  if (hit) return hit;
  const out: Stall[] = [];
  const rng = new Rng(1224);
  let drink = 0;
  SQUARES.forEach(([name, n], sq) => {
    // (the map's own outline of the square)
    const rings = w.data.squares?.find((q) => w.names[q.n] === name)?.r;
    if (!rings?.length) return;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const r0 = rings[0];
    for (let i = 0; i < r0.length; i += 2) {
      x0 = Math.min(x0, r0[i]);
      x1 = Math.max(x1, r0[i]);
      y0 = Math.min(y0, r0[i + 1]);
      y1 = Math.max(y1, r0[i + 1]);
    }
    // the trees on the square: a hut isn't put under one's crown
    const trees: number[] = [];
    for (let i = 0; i < w.trees.length; i += 4) {
      const tx = w.trees[i], ty = w.trees[i + 1];
      if (tx > x0 - 10 && tx < x1 + 10 && ty > y0 - 10 && ty < y1 + 10) trees.push(tx, ty, w.trees[i + 2]);
    }
    const shaded = (x: number, y: number) => {
      for (let i = 0; i < trees.length; i += 3) if (dist(x, y, trees[i], trees[i + 1]) < trees[i + 2] + 1.2) return true;
      return false;
    };
    const pts: { x: number; y: number }[] = [];
    for (let x = Math.ceil(x0 / GRID) * GRID; x <= x1; x += GRID)
      for (let y = Math.ceil(y0 / GRID) * GRID; y <= y1; y += GRID) if (pointInRings(x, y, rings) && !shaded(x, y) && roomy(w, x, y, STALL_R)) pts.push({ x, y });
    if (!pts.length) return;
    // the middle of the square (of the room on it): where the counters face
    let cx = 0, cy = 0;
    for (const p of pts) (cx += p.x / pts.length), (cy += p.y / pts.length);
    for (let i = pts.length - 1; i > 0; i--) {
      const j = rng.int(i + 1);
      [pts[i], pts[j]] = [pts[j], pts[i]];
    }
    let k = 0;
    for (const p of pts) {
      if (k >= n) break;
      if (out.some((s) => dist(s.x, s.y, p.x, p.y) < GAP[sq])) continue;
      const a = Math.atan2(cy - p.y, cx - p.x);
      // someone stands at the counter
      if (!roomy(w, p.x + Math.cos(a) * 2.8, p.y + Math.sin(a) * 2.8, 0.6)) continue;
      const kind = KINDS[sq][k++];
      const s: Stall = { x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10, a: Math.round(a * 100) / 100, kind, name: '', price: 0, wob: 0, sq: sq as 0 | 1 };
      if (kind === 'drink') {
        const [name, price] = DRINKS[drink++ % DRINKS.length];
        Object.assign(s, { name, price, wob: WOB });
      } else if (kind === 'turbo') Object.assign(s, { name: 'Turbo punč', price: TURBO_PRICE, wob: TURBO_WOB });
      else if (kind === 'food') Object.assign(s, { name: 'Klobásy', price: SAUSAGE });
      else s.name = kind === 'tree' ? 'Vianočné ozdoby' : 'Rukavice a čiapky';
      out.push(s);
    }
  });
  // the deposit: the stall on Hviezdoslavovo námestie nearest Hlavné (a drink stall gives way to it)
  const main = out.filter((s) => s.sq === 0);
  if (main.length) {
    let mx = 0, my = 0;
    for (const s of main) (mx += s.x / main.length), (my += s.y / main.length);
    let best: Stall | null = null, bd = Infinity;
    for (const s of out) if (s.sq === 1 && s.kind === 'drink' && dist(s.x, s.y, mx, my) < bd) (bd = dist(s.x, s.y, mx, my)), (best = s);
    if (best) Object.assign(best, { kind: 'deposit', name: 'Záloha za hrnčeky', price: 0, wob: 0 });
  }
  cache.set(w, out);
  return out;
}

/** room for something `r` across at (x, y) out in the open on the square: nothing solid, no water, no
 *  roof, no road, nothing inside a building */
function roomy(w: World, x: number, y: number, r: number) {
  if (w.collideCircle(x, y, r, 0, false) || w.insideBuilding(x, y) || w.covered(x, y, 0) || w.onCarriageway(x, y, 2)) return false;
  for (const [dx, dy] of [[0, 0], [r, 0], [-r, 0], [0, r], [0, -r]]) if (w.inWater(x + dx, y + dy, 0)) return false;
  return true;
}

/** stalls on the list */
const LIST = 6;
/** the action key reaches a stall's counter from this far (m) */
const REACH = 4.5;
/** the mug deposit (€ each) */
export const DEPOSIT = 2;
/** the round (s), and how far from Hlavné námestie it can be started from (m) */
const DURATION = 240, START_R = 1500;
/** people standing at the stalls (at most), and pickpockets in the crowd (more with others) */
const VISITORS = 22, PICKPOCKETS = 3, PICKPOCKETS_MAX = 5;
/** a pickpocket: wanders at this pace (faster to somewhere further off); goes for a player within this
 *  (m) who's been slower than this (m/s) for this long (s), and not robbed in the last few seconds,
 *  at this pace; touching is this close; he runs off at this pace for this long, and can be caught
 *  this close; a new one turns up this much later (s) */
const LURK_SPEED = 1.1, LURK_FAR = 2.2, STALK_R = 18, SLOW = 1.6, STILL = 1, GRACE = 6, STALK_SPEED = 2.2, TOUCH = 0.9;
const FLEE_SPEED = 3.4, FLEE_S = 7, CATCH = 1.3, RESPAWN = 20;
/** pay: made it, how fast (full at 90 s, nothing at the end), each mug returned; with others 1st–3rd
 *  get more; not made it: each stall and each mug returned */
const PAY_BASE = 100, PAY_TIME = 80, PAY_MUG = 15, PLACE_BONUS = [50, 25, 10], PAY_STALL = 12, PAY_MUG_LATE = 8;

interface Walker {
  ped: Ped;
  /** where they stand (a visitor), or where they're wandering to (a pickpocket) */
  hx: number;
  hy: number;
  mode: 'stand' | 'lurk' | 'stalk' | 'flee';
  /** the player being stalked or robbed (id) */
  pid: number;
  /** since (sim.time) the mode began, or until a pickpocket moves on */
  t: number;
  /** a pickpocket's loot (mugs) */
  mug: number;
  /** stepped aside for a player going past, until sim.time `until` */
  ax: number;
  ay: number;
  until: number;
  /** what a visitor looks at (their stall) */
  ox: number;
  oy: number;
}

interface Player {
  /** the next stall on the list (index into `list`) */
  step: number;
  mugs: number;
  returned: number;
  wob: number;
  /** finished (the list done and the mugs back), and how long it took (s) */
  done: boolean;
  took: number;
  /** robbed at (sim.time): the next pickpocket waits a moment */
  robbedAt: number;
  /** how fast they've been going lately (m/s), from where they were, and for how long (s) they've
   *  been standing about */
  speed: number;
  still: number;
  lx: number;
  ly: number;
}

class Punch extends MiniGame {
  stalls: Stall[] = [];
  /** the round's list: indices into `stalls`, in order */
  list: number[] = [];
  private visitors: Walker[] = [];
  private pickpockets: Walker[] = [];
  /** when missing pickpockets come back (sim.time) */
  private comeback: number[] = [];
  private state = new Map<number, Player>();
  private t0 = 0;
  private finishers = 0;

  constructor(sim: Sim, round: MiniRound) {
    super(sim, round);
    this.duration = DURATION;
  }

  /** the market and the round's list; false when it's too far to walk to */
  pick(x: number, y: number): boolean {
    const w = this.sim.world;
    this.stalls = marketStalls(w);
    const main = w.landmark('main');
    if (this.stalls.length < 10 || dist(x, y, main.x, main.y) > START_R) return false;
    // six drinks, three on each square where there are, in a shuffled order
    const rng = this.sim.rng;
    const pickN = (sq: number, n: number) => {
      const c = this.stalls.map((s, i) => i).filter((i) => (this.stalls[i].kind === 'drink' || this.stalls[i].kind === 'turbo') && this.stalls[i].sq === sq);
      for (let i = c.length - 1; i > 0; i--) {
        const j = rng.int(i + 1);
        [c[i], c[j]] = [c[j], c[i]];
      }
      return c.slice(0, n);
    };
    const a = pickN(0, LIST / 2), b = pickN(1, LIST - a.length);
    const list = [...a, ...b];
    for (let i = list.length - 1; i > 0; i--) {
      const j = rng.int(i + 1);
      [list[i], list[j]] = [list[j], list[i]];
    }
    this.list = list;
    // the round is at the market (joining, the panel's "near you")
    let cx = 0, cy = 0;
    for (const s of this.stalls) (cx += s.x / this.stalls.length), (cy += s.y / this.stalls.length);
    this.round.x = Math.round(cx);
    this.round.y = Math.round(cy);
    return this.list.length >= 5;
  }

  start() {
    const sim = this.sim, w = sim.world;
    this.t0 = sim.time;
    for (const p of this.players) this.onJoin(p);
    // people at the counters: one or two at each stall, facing it
    for (const s of this.stalls) {
      if (this.visitors.length >= VISITORS) break;
      const n = s.kind === 'deposit' ? 1 : 1 + sim.rng.int(2);
      for (let i = 0; i < n && this.visitors.length < VISITORS; i++) {
        const side = (i - (n - 1) / 2) * 1.3 + sim.rng.range(-0.3, 0.3);
        const fx = Math.cos(s.a), fy = Math.sin(s.a);
        const x = s.x + fx * sim.rng.range(2.3, 3.1) - fy * side, y = s.y + fy * sim.rng.range(2.3, 3.1) + fx * side;
        if (w.collideCircle(x, y, 0.36, 0, false) || w.inWater(x, y, 0)) continue;
        const ped = this.spawnPed(new Ped('civ', x, y, sim.rng.seed()));
        ped.state = 'idle';
        ped.angle = Math.atan2(s.y - y, s.x - x);
        this.visitors.push({ ped, hx: x, hy: y, mode: 'stand', pid: 0, t: 0, mug: 0, ax: 0, ay: 0, until: 0, ox: s.x, oy: s.y });
      }
    }
    const n = Math.min(PICKPOCKETS_MAX, PICKPOCKETS + this.players.length - 1);
    for (let i = 0; i < n; i++) this.addPickpocket();
    this.tell('Vianočné trhy sú otvorené! Mimo adventu? Punč je punč. 🍷', '#e57373', 3.5);
  }

  onJoin(p: SimPlayer) {
    const f = this.pos(p);
    if (!this.state.has(p.id)) this.state.set(p.id, { step: 0, mugs: 0, returned: 0, wob: 0, done: false, took: 0, robbedAt: -1e9, speed: 0, still: 0, lx: f.x, ly: f.y });
  }

  onLeave(p: SimPlayer) {
    this.state.delete(p.id);
    for (const k of this.pickpockets) if (k.pid === p.id && k.mode === 'stalk') k.mode = 'lurk';
  }

  /** a player's state (tests) */
  of(p: SimPlayer): Player | undefined {
    return this.state.get(p.id);
  }

  // ------------------------------------------------------------------------------------ the step
  update(dt: number) {
    for (const p of this.players) {
      const s = this.state.get(p.id);
      if (!s) continue;
      const f = this.pos(p);
      const v = dist(f.x, f.y, s.lx, s.ly) / Math.max(dt, 1e-3);
      s.speed = s.speed * 0.85 + Math.min(v, 30) * 0.15;
      s.still = s.speed < SLOW ? s.still + dt : 0;
      s.lx = f.x;
      s.ly = f.y;
      s.wob = Math.max(0, s.wob - WOB_DECAY * dt);
    }
    this.stepVisitors(dt);
    this.stepPickpockets(dt);
    if (this.players.length && this.players.every((p) => this.state.get(p.id)?.done)) this.finish();
  }

  /** the visitors stand at the counters, sway a little and step aside for a player going through */
  private stepVisitors(dt: number) {
    const now = this.sim.time;
    for (const v of [...this.visitors]) {
      const ped = v.ped;
      if (ped.dazed) {
        // knocked down: they get up by themselves and head home to change
        this.visitors.splice(this.visitors.indexOf(v), 1);
        this.release(ped);
        continue;
      }
      for (const p of this.players) {
        if (p.ped.vehicle || p.ped.aboard) continue;
        const dx = ped.x - p.ped.x, dy = ped.y - p.ped.y, d = Math.hypot(dx, dy);
        if (d < 0.9 && now >= v.until) {
          v.ax = d > 1e-3 ? (dx / d) * 0.8 : 0.8;
          v.ay = d > 1e-3 ? (dy / d) * 0.8 : 0;
          v.until = now + 2.5;
        }
      }
      const k = ped.seed % 89;
      const tx = v.hx + Math.sin(now * 0.7 + k) * 0.1 + (now < v.until ? v.ax : 0);
      const ty = v.hy + Math.cos(now * 0.6 + k) * 0.1 + (now < v.until ? v.ay : 0);
      this.walk(ped, tx, ty, 1.4, dt);
      // (back at the counter, eyes on the stall)
      if (ped.state === 'idle') ped.angle = Math.atan2(v.oy - ped.y, v.ox - ped.x);
    }
  }

  /** move a figure of the round's toward (tx, ty), easing in (at most `max` m/s) */
  private walk(ped: Ped, tx: number, ty: number, max: number, dt: number) {
    const dx = tx - ped.x, dy = ty - ped.y, d = Math.hypot(dx, dy);
    const sp = d > 0.03 ? Math.min(max, d * 3) : 0;
    ped.move(dt, this.sim.world, sp ? (dx / d) * sp : 0, sp ? (dy / d) * sp : 0);
    ped.state = sp > 0.2 ? 'walk' : 'idle';
    return d;
  }

  // ---------------------------------------------------------------------------- the pickpockets
  /** A spot in the crowd in front of stall `i` (any stall by default), a step or two out. */
  private crowdSpot(i = this.sim.rng.int(this.stalls.length)): { x: number; y: number } {
    const sim = this.sim, s = this.stalls[i];
    const a = s.a + sim.rng.range(-0.9, 0.9), r = sim.rng.range(3.5, 6);
    return sim.world.clearSpot(s.x + Math.cos(a) * r, s.y + Math.sin(a) * r, 0.36);
  }

  /** Where a pickpocket hangs about next: they know where the punch crawlers go, so mostly at a
   *  player's next stall on the list, else near one of them, else anywhere in the market. */
  private haunt(): { x: number; y: number } {
    const sim = this.sim;
    const p = this.players.length ? this.players[sim.rng.int(this.players.length)] : null;
    const s = p ? this.state.get(p.id) : undefined;
    const r = sim.rng.next();
    if (p && s && !s.done && r < 0.5 && s.step < this.list.length) return this.crowdSpot(this.list[s.step]);
    if (p && r < 0.75) {
      const f = this.pos(p);
      let best = 0, bd = Infinity;
      this.stalls.forEach((q, i) => {
        const d = dist(q.x, q.y, f.x, f.y);
        if (d < bd) (bd = d), (best = i);
      });
      return this.crowdSpot(best);
    }
    return this.crowdSpot();
  }

  private addPickpocket() {
    const sim = this.sim;
    // somewhere nobody's looking right now
    let at = this.crowdSpot();
    for (let i = 0; i < 6 && this.players.some((p) => dist(this.pos(p).x, this.pos(p).y, at.x, at.y) < 20); i++) at = this.crowdSpot();
    const ped = this.spawnPed(new Ped('civ', at.x, at.y, sim.rng.seed()));
    const to = this.haunt();
    this.pickpockets.push({ ped, hx: to.x, hy: to.y, mode: 'lurk', pid: 0, t: sim.time + sim.rng.range(2, 5), mug: 0, ax: 0, ay: 0, until: 0, ox: 0, oy: 0 });
  }

  private stepPickpockets(dt: number) {
    const sim = this.sim, now = sim.time;
    for (const k of [...this.pickpockets]) {
      const ped = k.ped;
      if (ped.dazed) {
        // knocked down: he drops the mug he was running off with, gets up by himself and heads home
        const p = k.mode === 'flee' ? this.playerById(k.pid) : undefined;
        const s = p ? this.state.get(p.id) : undefined;
        if (p && s && k.mug) {
          s.mugs += k.mug;
          this.msg(p, 'Vreckár je na zemi. Hrnček je späť.', '#69f0ae');
        }
        this.pickpockets.splice(this.pickpockets.indexOf(k), 1);
        this.release(ped);
        this.comeback.push(now + RESPAWN);
        continue;
      }
      if (k.mode === 'flee') {
        const p = this.playerById(k.pid);
        const s = p ? this.state.get(p.id) : undefined;
        // run into him (once he's off: not while still in your pocket) and the mug's back
        if (p && s && !p.ped.vehicle && now - k.t > 0.8 && s.speed > SLOW && dist(p.ped.x, p.ped.y, ped.x, ped.y) <= CATCH) {
          s.mugs += k.mug;
          this.msg(p, 'Máš ho! Hrnček je späť.', '#69f0ae');
          this.pop(p, 'CHYTENÝ!', ped.x, ped.y - 1.7);
          this.gone(k);
          continue;
        }
        if (now - k.t >= FLEE_S) {
          if (p) this.msg(p, 'Vreckár sa stratil v dave. Aj s hrnčekom.', '#ff8a80');
          this.gone(k);
          continue;
        }
        const from = p ? p.ped : ped;
        const dx = ped.x - from.x, dy = ped.y - from.y, d = Math.hypot(dx, dy) || 1;
        this.walk(ped, ped.x + (dx / d) * 4, ped.y + (dy / d) * 4, FLEE_SPEED, dt);
        continue;
      }
      if (k.mode === 'stalk') {
        const p = this.playerById(k.pid);
        const s = p ? this.state.get(p.id) : undefined;
        if (!p || !s || !s.mugs || s.done || p.ped.vehicle || p.ped.aboard || dist(p.ped.x, p.ped.y, ped.x, ped.y) > STALK_R + 5 || (s.speed > SLOW * 1.6 && now - k.t > 1.5)) {
          k.mode = 'lurk';
          k.t = now + sim.rng.range(2, 4);
          continue;
        }
        const d = this.walk(ped, p.ped.x, p.ped.y, STALK_SPEED, dt);
        if (d <= TOUCH) this.rob(k, p, s);
        continue;
      }
      // lurking: from one stall's crowd to another, an eye out for someone standing still with a mug
      const prey = this.prey(ped);
      if (prey) {
        Object.assign(k, { mode: 'stalk', pid: prey.id, t: now });
        continue;
      }
      // (hurrying when it's a way off, strolling through the crowd near it)
      const far = dist(ped.x, ped.y, k.hx, k.hy) > 40;
      if (this.walk(ped, k.hx, k.hy, far ? LURK_FAR : LURK_SPEED, dt) < 0.5 && now >= k.t) {
        const to = this.haunt();
        Object.assign(k, { hx: to.x, hy: to.y, t: now + sim.rng.range(3, 7) });
      }
    }
    for (let i = this.comeback.length - 1; i >= 0; i--) {
      if (now < this.comeback[i]) continue;
      this.comeback.splice(i, 1);
      this.addPickpocket();
    }
  }

  /** a player worth going for: near, standing (nearly) still, a mug on them, not just robbed, and
   *  nobody else after them already */
  private prey(ped: Ped): SimPlayer | null {
    const now = this.sim.time;
    let best: SimPlayer | null = null, bd = STALK_R;
    for (const p of this.players) {
      const s = this.state.get(p.id);
      if (!s || !s.mugs || s.done || s.still < STILL || now - s.robbedAt < GRACE || p.ped.vehicle || p.ped.aboard || p.state !== 'play') continue;
      if (this.pickpockets.some((k) => k.mode === 'stalk' && k.pid === p.id)) continue;
      const d = dist(p.ped.x, p.ped.y, ped.x, ped.y);
      if (d < bd) (bd = d), (best = p);
    }
    return best;
  }

  private rob(k: Walker, p: SimPlayer, s: Player) {
    s.mugs--;
    s.robbedAt = this.sim.time;
    Object.assign(k, { mode: 'flee', t: this.sim.time, mug: 1 });
    this.msg(p, 'Vreckár ti vzal hrnček! Chyť ho!', '#ff5252', 3);
    for (const q of this.pickpockets) if (q !== k && q.mode === 'stalk' && q.pid === p.id) q.mode = 'lurk';
  }

  /** a pickpocket off the scene (caught, or away with the loot); another turns up later */
  private gone(k: Walker) {
    this.pickpockets.splice(this.pickpockets.indexOf(k), 1);
    this.despawn(k.ped);
    this.comeback.push(this.sim.time + RESPAWN);
  }

  private playerById(id: number): SimPlayer | undefined {
    return this.players.find((p) => p.id === id);
  }

  // ------------------------------------------------------------------------------ the action
  /** the stall `p` is at (within reach of its counter): the nearest one */
  private at(p: SimPlayer): number {
    let best = -1, bd = REACH;
    for (let i = 0; i < this.stalls.length; i++) {
      const d = dist(this.stalls[i].x, this.stalls[i].y, p.ped.x, p.ped.y);
      if (d <= bd) (bd = d), (best = i);
    }
    return best;
  }

  private actionAt(p: SimPlayer, s: Player): string | undefined {
    if (s.done || p.ped.vehicle || p.ped.aboard) return undefined;
    const i = this.at(p);
    if (i < 0) return undefined;
    const st = this.stalls[i];
    if (st.kind === 'deposit') return s.mugs ? `Vrátiť hrnčeky (+€${s.mugs * DEPOSIT})` : undefined;
    if (st.kind === 'food') return `Kúpiť klobásu (€${SAUSAGE})`;
    if (st.kind === 'tree' || st.kind === 'gloves') return 'Pozrieť';
    return this.list[s.step] === i ? `Kúpiť: ${st.name} (€${st.price})` : undefined;
  }

  act(p: SimPlayer) {
    const s = this.state.get(p.id);
    if (!s || s.done) return;
    if (p.ped.vehicle || p.ped.aboard) return this.msg(p, 'Najprv vystúp – punč sa pije pešo.');
    const i = this.at(p);
    if (i < 0) return;
    const st = this.stalls[i];
    const money = p.profile.money;
    switch (st.kind) {
      case 'deposit':
        if (!s.mugs) return this.msg(p, s.step < this.list.length ? 'Najprv nejaký hrnček – treba ísť na punč.' : 'Nemáš čo vrátiť.');
        this.sim.addMoney(p, s.mugs * DEPOSIT, st.x, st.y);
        this.msg(p, `Záloha späť: €${s.mugs * DEPOSIT}.`, '#69f0ae');
        s.returned += s.mugs;
        s.mugs = 0;
        if (s.step >= this.list.length) this.done(p, s);
        return;
      case 'food':
        if (money < SAUSAGE) return this.msg(p, 'Klobása za €9? Na to nemáš.', '#ff8a80');
        this.sim.addMoney(p, -SAUSAGE);
        s.wob = Math.max(0, s.wob - SAUSAGE_WOB);
        return this.msg(p, 'Klobása za €9. Aspoň nie si na lačno.', '#ffcc80');
      case 'tree':
        return this.msg(p, 'Sklenená guľa za €25? Pekná… ďakujem, nechcem.', '#b0bec5');
      case 'gloves':
        return this.msg(p, 'Rukavice za €35. Ruky si zohreješ aj o punč.', '#b0bec5');
    }
    if (this.list[s.step] !== i) {
      const k = this.list.indexOf(i);
      return this.msg(p, k > s.step ? `Tento je na zozname až ${k + 1}. – ide sa podľa poradia!` : k >= 0 ? 'Tu si už bol.' : 'Tento nie je na zozname.', '#ffd740');
    }
    if (money < st.price) return this.msg(p, 'Na punč nemáš. Smutné Vianoce.', '#ff8a80');
    this.sim.addMoney(p, -st.price);
    s.mugs++;
    s.wob = Math.min(1, s.wob + st.wob);
    s.step++;
    this.addPoints(p, 10);
    this.pop(p, st.kind === 'turbo' ? 'TURBO! 🔥' : 'Na zdravie! 🍷', st.x, st.y - 1.7);
    if (s.step < this.list.length) {
      const nx = this.stalls[this.list[s.step]];
      this.msg(p, `${st.name} ✓ Ďalej: ${nx.name}.`, '#e57373');
    } else this.msg(p, 'Zoznam hotový! Teraz vráť hrnčeky – záloha €2 za kus.', '#69f0ae', 3);
    // the list done with every mug stolen: nothing to take back
    if (s.step >= this.list.length && !s.mugs) this.done(p, s);
  }

  /** `p` made it: the list done and the mugs back (or gone) */
  private done(p: SimPlayer, s: Player) {
    s.done = true;
    s.took = this.sim.time - this.t0;
    const place = ++this.finishers;
    this.addPoints(p, 1000 - place * 10);
    const group = this.round.started >= 2;
    if (group) for (const q of this.players) if (q !== p) this.msg(q, `${p.nick} dopil zoznam${place === 1 ? ' prvý' : ''}!`, '#ffd740');
    this.settle(p, s, place);
  }

  /** `p`'s outcome as it stands: made it (by time, mugs and place), or how far they got */
  private settle(p: SimPlayer, s: Player, place = 0) {
    const group = this.round.started >= 2;
    if (s.done) {
      const fast = Math.max(0, Math.min(1, (DURATION - s.took) / (DURATION - 90)));
      const pay = PAY_BASE + PAY_TIME * fast + PAY_MUG * s.returned + (group ? (PLACE_BONUS[place - 1] ?? 0) : 0);
      const time = `${Math.floor(s.took / 60)}:${String(Math.floor(s.took % 60)).padStart(2, '0')}`;
      const mugs = s.returned ? `, ${s.returned} ${mugWord(s.returned)} späť` : ', hrnčeky ukradnuté';
      this.outcome(p, { pay, text: group ? `${place}. v cieli za ${time}${mugs}. Na zdravie!` : `Punčová cesta za ${time}${mugs}. Na zdravie!` });
      return;
    }
    const n = this.list.length;
    const text = s.step >= n ? 'Zoznam máš, ale hrnčeky si nevrátil.' : `Stihol si ${s.step}/${n} stánkov. Punč počká do budúcich Vianoc.`;
    this.outcome(p, { pay: PAY_STALL * s.step + PAY_MUG_LATE * s.returned, text });
  }

  onTimeout() {
    for (const p of this.players) {
      const s = this.state.get(p.id);
      if (s && !s.done) this.settle(p, s);
    }
    this.finish();
  }

  // --------------------------------------------------------------------------------- the view
  view(p: SimPlayer): MiniView {
    const s = this.state.get(p.id);
    if (!s) return { goal: this.title };
    const marks: MiniMark[] = [];
    const n = this.list.length;
    const toDeposit = s.step >= n && s.mugs > 0 && !s.done;
    for (let i = 0; i < this.stalls.length; i++) {
      const st = this.stalls[i];
      const k = this.list.indexOf(i);
      if (k >= 0) {
        const cur = k === s.step && !s.done;
        const m: MiniMark = { x: st.x, y: st.y, icon: '🍷', color: st.kind === 'turbo' ? '#ff7043' : '#e57373', label: cur ? `${k + 1}. ${st.name} · €${st.price}` : k < s.step ? `${k + 1}. ✓` : `${k + 1}.` };
        if (cur) (m.arrow = 1), (m.r = 2.6);
        if (k < s.step) (m.dim = 1), (m.noMap = 1);
        marks.push(m);
      } else if (st.kind === 'deposit') {
        const m: MiniMark = { x: st.x, y: st.y, icon: '♻️', label: 'Záloha za hrnčeky', color: '#81c784' };
        if (toDeposit) (m.arrow = 1), (m.r = 2.6);
        else if (!s.mugs) m.dim = 1;
        marks.push(m);
      } else {
        const icon = st.kind === 'food' ? '🌭' : st.kind === 'tree' ? '🎄' : st.kind === 'gloves' ? '🧤' : '🍷';
        marks.push({ x: st.x, y: st.y, icon, label: st.kind === 'food' ? `klobása €${SAUSAGE}` : undefined, color: '#a1887f', dim: st.kind === 'drink' || st.kind === 'turbo' ? 1 : undefined, noMap: 1 });
      }
    }
    // the one running off with your mug
    for (const k of this.pickpockets)
      if (k.mode === 'flee' && k.pid === p.id) marks.push({ x: Math.round(k.ped.x), y: Math.round(k.ped.y), e: k.ped.id, icon: '👛', label: 'vreckár!', color: '#ff5252', r: 1.2, noMap: 1 });
    const cur = s.step < n ? this.stalls[this.list[s.step]] : null;
    const f = this.pos(p);
    const group = this.round.started >= 2;
    const goal = s.done
      ? group
        ? 'Hotovo! Počkaj na ostatných.'
        : 'Hotovo! Na zdravie. 🍷'
      : cur
        ? dist(cur.x, cur.y, f.x, f.y) > 250
          ? `Na vianočné trhy! ${s.step ? 'Ďalší' : 'Prvý'} na zozname: ${cur.name}.`
          : `${s.step + 1}/${n}: ${cur.name} za €${cur.price}.${s.mugs && s.speed < SLOW ? ' Nestoj – vreckári!' : ''}`
        : s.mugs
          ? `Vráť ${s.mugs} ${mugWord(s.mugs)} – záloha €${DEPOSIT} za kus!`
          : 'Hotovo.';
    return {
      goal,
      stats: [['Stánky', `${s.step}/${n}`], ['Hrnčeky', `${s.mugs}`], ['Peniaze', `€${Math.floor(p.profile.money)}`]],
      bar: { label: 'Punč v krvi', v: Math.round(s.wob * 100) / 100, color: s.wob > 0.6 ? '#ff5252' : s.wob > 0.3 ? '#ffb300' : '#e57373' },
      marks,
      act: this.actionAt(p, s),
      x: s.wob > 0 ? { wobble: Math.round(s.wob * 100) / 100 } : undefined,
    };
  }

  lobbyView(): MiniView {
    return { goal: 'Vianočné trhy: punč, klobásy a hrnčeky so zálohou. Mimo adventu? Punč je punč.' };
  }
}

/** 1 hrnček, 2 hrnčeky, 5 hrnčekov */
function mugWord(n: number) {
  return n === 1 ? 'hrnček' : n >= 2 && n <= 4 ? 'hrnčeky' : 'hrnčekov';
}

export const PUNCH_DEF: MiniGameDef = {
  kind: 'punch',
  lobby: 20,
  create(sim, round) {
    const g = new Punch(sim, round);
    return g.pick(round.x, round.y) ? g : 'Vianočné trhy sú na Hlavnom a Hviezdoslavovom námestí – príď bližšie k Starému Mestu.';
  },
};
