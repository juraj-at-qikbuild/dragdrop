// Style (docs/plans/gameplay.md, Phase 3): the combo, run by the shared simulation so it counts online
// as it does offline. Moves at the wheel are detected here for every player driving (a near miss, a
// drift, and the city's own: see `moves` below), and other code adds its own through Sim.style (someone
// soaked through, a splash, a last-second dive, a high five, a stall, a police car sidelined, a clean
// getaway: docs/plans/non-violent.md; contact with a car never counts). Each move banks its cash into the player's
// combo and raises the multiplier, up to ×5; 4 s without a new one and the combo pays out, bank ×
// multiplier, and online scores points on the "Štýl" board. A crash ends it early (paid all the same),
// and a death or an arrest loses it.
import { BUMP_AIR, bumpLimit, type Vehicle } from '../../entities/Vehicle';
import { TRAM_SEG } from '../../entities/Tram';
import { dist } from '../../util/math';
import { SECONDS_PER_HOUR } from '../Clock';
import type { Sim } from '../Sim';
import type { PlayerState, SimPlayer } from '../SimPlayer';
import type { SimRule } from './SimRule';

export type StyleMove =
  | 'near' | 'drift' | 'wrongway' | 'air' | 'tram' | 'red' | 'passage'
  | 'soak' | 'copsoak' | 'splash' | 'copsplash' | 'dive' | 'highfive' | 'stall' | 'takedown' | 'ko' | 'getaway';

/** each move: what it's called on screen and the cash it banks (a drift's grows with its speed). The
 *  new ones (docs/plans/non-violent.md) in Slovak: soaking someone through with a toy (its own words
 *  per toy: SOAK_LABEL), splashing them from a puddle, a last-second dive out of the way, a drive-by
 *  high five, a market stall ploughed through, a police car sidelined. */
export const STYLE: Record<StyleMove, { label: string; cash: number }> = {
  near: { label: 'NEAR MISS', cash: 20 },
  drift: { label: 'DRIFT', cash: 10 },
  wrongway: { label: 'WRONG WAY', cash: 30 },
  air: { label: 'AIR', cash: 25 },
  tram: { label: 'TRAM DODGE', cash: 60 },
  red: { label: 'RED LIGHT', cash: 25 },
  passage: { label: 'THREAD THE NEEDLE', cash: 40 },
  soak: { label: 'SPRCHA!', cash: 15 },
  copsoak: { label: 'POLICAJT V SPRCHE!', cash: 40 },
  splash: { label: 'ŠPLECH!', cash: 20 },
  copsplash: { label: 'ŠPLECH NA POLICAJTA!', cash: 40 },
  dive: { label: 'HOP DO KRÍKA!', cash: 5 },
  highfive: { label: 'PLÁCNI SI!', cash: 25 },
  stall: { label: 'MOJE LOKŠE!', cash: 35 },
  takedown: { label: 'ODSTAVENÉ!', cash: 60 },
  ko: { label: 'SPRCHA!', cash: 50 },
  getaway: { label: 'CLEAN GETAWAY', cash: 150 },
};

/** soaking someone through, by the toy that did it: [a civilian, a cop] */
export const SOAK_LABEL: Record<'water' | 'bubbles' | 'confetti' | 'tickle', [string, string]> = {
  water: ['SPRCHA!', 'POLICAJT V SPRCHE!'],
  bubbles: ['BUBLI-BUBLI!', 'POLICAJT V PENE!'],
  confetti: ['KONFETY!', 'POLICAJT NA OSLAVE!'],
  tickle: ['ŠTEKLI-ŠTEKLI!', 'ŠTEKLI-ŠTEKLI POLICAJTA!'],
};

/** seconds a combo waits for the next move before it pays */
export const COMBO_WINDOW = 4;
export const COMBO_MAX_MULT = 5;
/** a combo banks at most this much (before the multiplier), and pays out after this long whatever
 *  comes: chaining near misses for ever isn't a way to print money */
export const COMBO_BANK_MAX = 400;
export const COMBO_MAX_S = 60;
/** style points online: one per this much of a combo's payout, at most STYLE_POINTS_MAX a combo */
export const STYLE_PER_POINT = 25;
export const STYLE_POINTS_MAX = 40;

/** near misses: the player's speed, another vehicle's (parked ones don't count), the hull gap, how
 *  long one has to stay crash-free before it banks, and how soon the same vehicle counts again */
const NEAR_SPEED = 12;
const NEAR_OTHER_SPEED = 3;
const NEAR_GAP = 1.2;
const NEAR_CONFIRM = 0.3;
const NEAR_COOLDOWN = 1.5;
/** drifts: sideways this fast (m/s) while going forward at least this fast, for this long before the
 *  first one counts, then one a second */
const DRIFT_SIDE = 3.5;
const DRIFT_FWD = 6;
const DRIFT_START = 0.6;
const DRIFT_EVERY = 1;
/** a crash: this share of the car's health lost within CRASH_WINDOW s */
const CRASH_FRAC = 0.08;
const CRASH_WINDOW = 0.5;
/** the city's moves (docs/plans/gameplay.md, Phase 3): the wrong way down a one-way street for this
 *  long at this speed, and not again for a while; a red light run at this speed; this far flat out
 *  (never slower than this) through a building's passage; a tram passed this close at this speed */
const WRONG_SPEED = 10;
const WRONG_TIME = 1.5;
const WRONG_EVERY = 8;
const RED_SPEED = 8;
const PASSAGE_MIN = 5;
const PASSAGE_SPEED = 14;
const TRAM_GAP = 1.5;
const TRAM_SPEED = 8;
const TRAM_COOLDOWN = 4;
/** a tram section's half-width (m) */
const TRAM_HALF_W = 1.25;

interface Pending {
  move: StyleMove;
  label: string;
  cash: number;
  x: number;
  y: number;
  age: number;
  nitro: number;
}

/** one player's combo, and what the detection keeps between steps */
interface State {
  mult: number;
  left: number;
  bank: number;
  since: number;
  x: number;
  y: number;
  /** moves waiting to prove crash-free (near misses) */
  pending: Pending[];
  /** other vehicle id → sim.time it last counted for a near miss */
  lastNear: Map<number, number>;
  /** seconds drifting so far, and since the last drift that counted */
  drift: number;
  driftGap: number;
  /** the car being watched for crashes, its health a moment ago and what it lost lately */
  car: Vehicle | null;
  hp: number;
  lost: { t: number; hp: number }[];
  /** per move: sim.time it last counted (the city's moves have their own cool-downs) */
  last: Map<string, number>;
  /** the car the city's moves last saw, where it was then (its centre, and its front) */
  pcar: Vehicle | null;
  px: number;
  py: number;
  pfx: number;
  pfy: number;
  /** seconds going the wrong way down a one-way street */
  wrong: number;
  /** metres flat out inside a building's passage so far, and the slowest it went there */
  inside: number;
  insideMin: number;
  /** tram id → sim.time it last counted for a dodge */
  lastTram: Map<number, number>;
}

export class Style implements SimRule {
  readonly id = 'style';
  private states = new Map<number, State>();

  constructor(private sim: Sim) {}

  private state(p: SimPlayer): State {
    let s = this.states.get(p.id);
    if (!s)
      this.states.set(
        p.id,
        (s = {
          mult: 1, left: 0, bank: 0, since: 0, x: 0, y: 0, pending: [], lastNear: new Map(), drift: 0, driftGap: 0, car: null, hp: 0, lost: [], last: new Map(),
          pcar: null, px: 0, py: 0, pfx: 0, pfy: 0, wrong: 0, inside: 0, insideMin: Infinity, lastTram: new Map(),
        }),
      );
    return s;
  }

  /** the combo `p` has going: its multiplier and seconds left, or null */
  combo(p: SimPlayer): { mult: number; left: number; bank: number } | null {
    const s = this.states.get(p.id);
    return s && s.left > 0 ? { mult: s.mult, left: s.left, bank: s.bank } : null;
  }

  /** A move: banks its cash (or `cash`) into the combo and raises the multiplier. `label` replaces the
   *  move's own ("K.O. Anna"); `nitro` tops up the driver's tank. */
  move(p: SimPlayer, move: StyleMove, x: number, y: number, o: { label?: string; cash?: number; nitro?: number } = {}) {
    if (p.state !== 'play') return;
    const s = this.state(p);
    if (s.left <= 0) (s.mult = 1), (s.bank = 0), (s.since = this.sim.time);
    s.mult = Math.min(COMBO_MAX_MULT, s.mult + 1);
    s.left = COMBO_WINDOW;
    s.bank = Math.min(COMBO_BANK_MAX, s.bank + Math.max(0, o.cash ?? STYLE[move].cash));
    s.x = x;
    s.y = y;
    s.last.set(move, this.sim.time);
    const label = o.label ?? STYLE[move].label;
    this.sim.events.toPlayer(p.id, { k: 'style', label, cash: 0, x, y: y - 1.8, mult: s.mult, ...(o.nitro ? { nitro: o.nitro } : {}) });
  }

  /** when `move` last counted for `p` (sim.time; -Infinity: never), for the moves' own cool-downs */
  lastAt(p: SimPlayer, move: string): number {
    return this.states.get(p.id)?.last.get(move) ?? -Infinity;
  }

  /** mark a move as counted without banking it (a cool-down for something only half done) */
  touch(p: SimPlayer, move: string) {
    this.state(p).last.set(move, this.sim.time);
  }

  /** the combo is over: bank × multiplier, and the points */
  private payOut(p: SimPlayer, s: State) {
    const amount = Math.round(s.bank * s.mult);
    s.left = 0;
    s.bank = 0;
    s.pending.length = 0;
    if (amount <= 0 || p.state !== 'play') return;
    this.sim.payout(p, amount, 'style', s.x, s.y);
    this.sim.score(p, Math.min(STYLE_POINTS_MAX, Math.round(amount / STYLE_PER_POINT)), 'style', s.x, s.y);
  }

  // ------------------------------------------------------------------------------------------ step
  step(dt: number) {
    for (const p of this.sim.players.values()) {
      const s = this.states.get(p.id);
      if (p.state !== 'play') {
        if (s) (s.left = 0), (s.bank = 0), (s.pending.length = 0), (s.drift = 0);
        continue;
      }
      const v = p.ped.vehicle;
      if (v && !v.wrecked) this.drive(p, v, dt);
      else if (s) (s.drift = 0), (s.car = null);
      if (!s) continue;
      this.confirm(p, s, dt);
      if (s.left > 0) {
        s.left -= dt;
        if (s.left <= 0 || this.sim.time - s.since > COMBO_MAX_S) this.payOut(p, s);
      }
    }
  }

  onState(p: SimPlayer, _from: PlayerState, to: PlayerState) {
    // a death or an arrest loses the combo
    if (to !== 'play') {
      const s = this.states.get(p.id);
      if (s) (s.left = 0), (s.bank = 0), (s.pending.length = 0);
    }
  }

  onRemove(p: SimPlayer) {
    this.states.delete(p.id);
  }

  /** the moves at the wheel, each step */
  private drive(p: SimPlayer, v: Vehicle, dt: number) {
    const s = this.state(p);
    if (this.crashed(s, v)) {
      // a crash voids the near misses still proving themselves, and ends the combo (paid)
      s.pending.length = 0;
      if (s.left > 0) this.payOut(p, s);
    }
    const speed = v.speed;
    // a drift: going forward, and sideways too
    const ca = Math.cos(v.angle), sa = Math.sin(v.angle);
    const fwd = v.vx * ca + v.vy * sa, side = Math.abs(-v.vx * sa + v.vy * ca);
    if (fwd > DRIFT_FWD && side > DRIFT_SIDE && v.air <= 0) {
      s.drift += dt;
      s.driftGap += dt;
      if (s.drift >= DRIFT_START && s.driftGap >= DRIFT_EVERY) {
        s.driftGap = 0;
        this.move(p, 'drift', v.x, v.y, { label: `DRIFT ${Math.round(s.drift * 10) / 10} s`, cash: Math.round(STYLE.drift.cash + speed * 0.8), nitro: 0.05 });
      }
    } else if (s.drift > 0) (s.drift = 0), (s.driftGap = DRIFT_EVERY);
    // near misses with moving vehicles, banked once they've stayed crash-free a moment
    if (speed > NEAR_SPEED) {
      const r = v.spec.length / 2 + NEAR_GAP + 3;
      this.sim.forVehiclesNear(v.x, v.y, r + 4, (o) => {
        // (a football flying past is no near miss: docs/plans/minigames.md)
        if (o === v || o.wrecked || o.speed < NEAR_OTHER_SPEED || o.level !== v.level || o.spec.ball) return;
        const gap = dist(v.x, v.y, o.x, o.y) - v.radius - o.radius;
        if (gap < 0 || gap > NEAR_GAP) return;
        if (this.sim.time - (s.lastNear.get(o.id) ?? -Infinity) < NEAR_COOLDOWN) return;
        s.lastNear.set(o.id, this.sim.time);
        s.pending.push({ move: 'near', label: STYLE.near.label, cash: STYLE.near.cash, x: (v.x + o.x) / 2, y: (v.y + o.y) / 2, age: 0, nitro: 0.06 });
      });
    }
    this.city(p, v, s, dt);
  }

  // ------------------------------------------------------------------------------- the city's moves
  /** What the street and the traffic around the car make of its driving this step: air off a bump, a
   *  red light, the wrong way down a one-way street, a building's passage flat out, a tram dodged.
   *  All from the car's pose, which the server has for a player's car it doesn't simulate too. */
  private city(p: SimPlayer, v: Vehicle, s: State, dt: number) {
    const w = this.sim.world;
    const t = this.sim.time;
    const ca = Math.cos(v.angle), sa = Math.sin(v.angle);
    const fx = v.x + (ca * v.spec.length) / 2, fy = v.y + (sa * v.spec.length) / 2;
    const ground = v.level === 0;
    if (s.pcar === v && ground) {
      // AIR: a bump taken fast enough to leave the ground (as Vehicle.overBump works it out)
      const k = w.bumps.crossed(s.px, s.py, v.x, v.y);
      if (k >= 0 && k < 3 && v.speed - bumpLimit(k, v.spec.width) > BUMP_AIR && t - this.lastAt(p, 'air') > 1) this.move(p, 'air', v.x, v.y);
      // RED LIGHT: the front over a stop line while it's red, at speed
      if (v.speed > RED_SPEED && t - this.lastAt(p, 'red') > 3) {
        const secs = this.sim.clock.time * SECONDS_PER_HOUR;
        for (const l of w.lights.lines) {
          if (Math.abs(l.x - fx) > 30 || Math.abs(l.y - fy) > 30) continue;
          const before = (l.x - s.pfx) * l.ux + (l.y - s.pfy) * l.uy, after = (l.x - fx) * l.ux + (l.y - fy) * l.uy;
          if (before <= 0 || after > 0) continue;
          const right = (fx - l.x) * -l.uy + (fy - l.y) * l.ux;
          if (right < -1 || right > l.hw + 1 || v.vx * l.ux + v.vy * l.uy < RED_SPEED) continue;
          if (w.lights.state(l, secs) !== 2) continue;
          this.move(p, 'red', fx, fy);
          break;
        }
      }
    }
    // WRONG WAY: against a one-way street's flow, a while, at speed (not on a bridge's deck, whose
    // roads the car graph doesn't tell from the ones under it)
    const seg = ground && v.speed > WRONG_SPEED && !w.onBridge(v.x, v.y) ? w.car.segmentAt(v.x, v.y, 5) : null;
    const e = seg?.edge;
    if (seg && e && e.oneway !== 0 && seg.d < e.width / 2 + 1 && ((v.vx * seg.dx + v.vy * seg.dy) / v.speed) * e.oneway < -0.7) {
      s.wrong += dt;
      if (s.wrong >= WRONG_TIME && t - this.lastAt(p, 'wrongway') > WRONG_EVERY) {
        s.wrong = 0;
        this.move(p, 'wrongway', v.x, v.y);
      }
    } else s.wrong = Math.max(0, s.wrong - dt);
    // THREAD THE NEEDLE: flat out all the way through a passage in a building (only a passage lets a
    // car inside a building's footprint), banked once out and still in one piece
    if (ground && w.inBuildingPassage(v.x, v.y)) {
      s.inside += v.speed * dt;
      s.insideMin = Math.min(s.insideMin, v.speed);
    } else if (s.inside > 0) {
      if (s.inside >= PASSAGE_MIN && s.insideMin >= PASSAGE_SPEED) this.pend(p, 'passage', v.x, v.y);
      s.inside = 0;
      s.insideMin = Infinity;
    }
    // TRAM DODGE: past a tram's side at speed, close
    if (v.speed > TRAM_SPEED)
      for (const tr of this.sim.trams) {
        if (tr.level !== v.level || Math.abs(tr.x - v.x) > 45 || Math.abs(tr.y - v.y) > 45) continue;
        if (t - (s.lastTram.get(tr.id) ?? -Infinity) < TRAM_COOLDOWN) continue;
        for (const sec of tr.sections) {
          // the gap between the car's body and the section's box
          const dx = v.x - sec.x, dy = v.y - sec.y, c = Math.cos(sec.a), n = Math.sin(sec.a);
          const along = Math.abs(dx * c + dy * n) - TRAM_SEG / 2, across = Math.abs(-dx * n + dy * c) - TRAM_HALF_W;
          const gap = Math.max(along, across) - v.spec.width / 2;
          if (!(gap >= 0 && gap <= TRAM_GAP) || !(Math.hypot(v.vx - c * tr.speed, v.vy - n * tr.speed) >= TRAM_SPEED)) continue;
          s.lastTram.set(tr.id, t);
          this.pend(p, 'tram', v.x, v.y);
          break;
        }
      }
    s.pcar = v;
    s.px = v.x;
    s.py = v.y;
    s.pfx = fx;
    s.pfy = fy;
  }

  /** queue a move that counts only once it has stayed crash-free a moment (NEAR_CONFIRM) */
  pend(p: SimPlayer, move: StyleMove, x: number, y: number, o: { label?: string; cash?: number; nitro?: number } = {}) {
    this.state(p).pending.push({ move, label: o.label ?? STYLE[move].label, cash: o.cash ?? STYLE[move].cash, x, y, age: 0, nitro: o.nitro ?? 0 });
  }

  /** drop whatever `p` has waiting to be confirmed: they just hit someone (a BOING), and a splash or
   *  a dive the moment before doesn't count any more */
  voidPending(p: SimPlayer) {
    const s = this.states.get(p.id);
    if (s) s.pending.length = 0;
  }

  private confirm(p: SimPlayer, s: State, dt: number) {
    for (let i = s.pending.length - 1; i >= 0; i--) {
      const q = s.pending[i];
      q.age += dt;
      if (q.age < NEAR_CONFIRM) continue;
      s.pending.splice(i, 1);
      this.move(p, q.move, q.x, q.y, { label: q.label, cash: q.cash, nitro: q.nitro });
    }
  }

  /** the car lost CRASH_FRAC of its health within the last CRASH_WINDOW s (a new car starts clean) */
  private crashed(s: State, v: Vehicle): boolean {
    if (s.car !== v) {
      s.car = v;
      s.hp = v.health;
      s.lost.length = 0;
      return false;
    }
    const t = this.sim.time;
    const d = s.hp - v.health;
    s.hp = v.health;
    if (d > 0) s.lost.push({ t, hp: d });
    while (s.lost.length && t - s.lost[0].t > CRASH_WINDOW) s.lost.shift();
    let sum = 0;
    for (const l of s.lost) sum += l.hp;
    if (sum < v.spec.health * CRASH_FRAC) return false;
    s.lost.length = 0;
    return true;
  }
}

export type { State as StyleState };
