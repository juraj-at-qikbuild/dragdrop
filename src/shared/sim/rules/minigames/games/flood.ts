// Povodeň (docs/plans/minigames.md): September 2024, and the Danube peaks at about 9.7 m in Bratislava.
// Crews put up the mobile flood wall along the Old Town's embankment, the promenade goes under, and half
// the city comes down to the river to watch and take selfies. Here the players are the crew: the wall
// has gaps, the panels are on a van, and the river comes in waves. Before each wave peaks every gap
// must be closed; an open one lets the Danube into the street behind it, and three of those are the end.
// Between the waves the water knocks panels out again, and flood tourists wander into the gaps for a
// selfie with the river and have to be asked, politely, to move.
//
// The wall stands on the real embankment: the map's river bank between Most SNP and Eurovea, a little
// inland of the water's edge (past the boats' gangways, on the promenade), wherever along it is nearest
// the round's start. Started away from the river, the players have to get there first; the waves wait
// for them a while, and not from further than FAR_R. With others it's one wall and one score: everyone
// is paid the same, and a little more for each panel they set themselves.
import { clamp, dist, segDist2 } from '../../../../util/math';
import type { Rng } from '../../../../util/Rng';
import { Ped } from '../../../../entities/Ped';
import { SPECS, Vehicle } from '../../../../entities/Vehicle';
import type { World } from '../../../../world/World';
import type { Sim } from '../../../Sim';
import type { SimPlayer } from '../../../SimPlayer';
import { MiniGame, type MiniGameDef, type MiniRound, type MiniView } from '../MiniGame';
import type { MiniMark } from '../types';

/** the river bank is looked at every STEP metres along it, from Most SNP to EAST metres past Eurovea */
const STEP = 2, EAST = 120;
/** the wall stands this far inland of the water's edge (m): past the gangways to the boats, on the
 *  promenade, so the rising river has a strip to climb before it reaches the wall */
const WALL_OFF = 14;
/** gaps in the wall, how far apart (m, centre to centre) and how long each is (m); the wall runs on
 *  this far past the first and the last (m; the drawer's stubs) */
const GAPS = 10, SPACING = 16, GAP_W = 6, STUB = 8;
/** gaps open when the round starts: with one player, one more for each other (at most) */
const OPEN_SOLO = 5, OPEN_MAX = 8;
/** the van that brought the panels stands this far inland of the wall (m), the first that fits, and
 *  unloaded them this far in front of its side, toward the wall: the stack is the depot (far enough
 *  from the van that standing at it isn't standing at a car's door) */
const VAN_OFFS = [11, 13, 9, 15, 17];
const STACK_OFF = 5.5;
const VAN_COLOR = '#ef6c00';
/** further than this from the embankment (m) it can't start: the Danube is someone else's problem */
export const FAR_R = 1500;
/** someone this close to the depot (m) is there: the waves start */
const ARRIVE_R = 60;
/** ...and they start anyway this long (s) after the round did, whoever's there */
const TRAVEL_S = 180;
/** the action key reaches a gap (from its line) or a tourist this far (m), and the stack this far */
const REACH = 3.5, DEPOT_REACH = 3.5;
/** the waves: when each one peaks (s after they started) and how high (m on the Bratislava gauge; the
 *  last is September 2024's) */
const PEAKS = [75, 130, 185, 240];
const HEIGHTS = [8.4, 9.0, 9.4, 9.7];
/** the level when the waves start, and how far it drops (m) over how long (s) after each peak */
const BASE = 7.5, EBB = 0.35, EBB_S = 10;
/** the promenade starts to go under at this level (m), and the water reaches the wall at this one */
const DRY_AT = 7.3, WALL_AT = 8.3;
/** the meter's range (m) */
const BAR_LO = 6.5, BAR_HI = 10;
/** this long after a peak (s), the wave it brought knocks panels out */
const KNOCK_AFTER = 8;
/** the last this many seconds before a peak, the open gaps blink and the meter is red */
const WARN_S = 15;
/** the round is over this long after the last peak (s) */
const END_AFTER = 5;
/** this many breaches and the street behind the wall is a river: the round is lost */
export const MAX_BREACH = 3;
/** the flooded street behind a breach reaches this far inland (m) */
const BREACH_DEPTH = 24;
/** flood tourists: the first comes this long (s) into the waves, then one every so often (alone,
 *  with others), at most so many at a time; they stroll at this speed (m/s) from this far away (m),
 *  and go this long (s) after being asked */
const TOURIST_FIRST = 18, TOURIST_EVERY = 15, TOURIST_EVERY_GROUP = 9, TOURISTS_SOLO = 2, TOURISTS_MAX = 4;
const TOURIST_SPEED = 1.3, TOURIST_FROM = 15, TOURIST_TO = 30, ASKED_S = 2, LEAVE_S = 25;
/** a tourist in a gap stands this far back from its line (m) */
const SELFIE_BACK = 0.9;
/** pay: each wave held, a dry Old Town (no breach at all), each panel a player set (up to a cap), a
 *  breach's cost to the shared score, and the consolation for a lost round */
const PAY_WAVE = 40, PAY_DRY = 60, PAY_PANEL = 3, PANEL_CAP = 30, BREACH_COST = 10, PAY_LOST = 15, LOST_PANEL = 2, LOST_CAP = 15;

/** One gap in the wall: its middle, its ends (west to east), which way it runs (u) and which way is
 *  inland (n: its left, away from the river), whether a panel is in it, and whether the river has come
 *  through it (the street behind stays flooded). */
export interface Gap {
  x: number;
  y: number;
  ax: number;
  ay: number;
  bx: number;
  by: number;
  ux: number;
  uy: number;
  nx: number;
  ny: number;
  closed: boolean;
  breached: boolean;
}

/** A flood tourist: walking to a gap (`gap`), taking selfies in it, asked to go (going in `t` s), or
 *  leaving (to tx, ty, for at most `t` s). */
interface Tourist {
  ped: Ped;
  gap: number;
  mode: 'walk' | 'selfie' | 'asked' | 'leave';
  t: number;
  tx: number;
  ty: number;
}

interface Player {
  /** a panel in their hands */
  carry: boolean;
  /** panels they set */
  panels: number;
}

// ------------------------------------------------------------------------------ the embankment
/** The Danube's left bank from Most SNP to Eurovea, as the water's edge every STEP metres: `ys[i]` is
 *  where the river starts south of x0 + i·STEP (NaN: nowhere), `ok[i]` whether a gap of the wall can
 *  stand there and `line[i]` whether the wall can run through there (1 yes, -1 no, 0 not looked at
 *  yet). The same for every round on a map. */
interface Shore {
  x0: number;
  ys: Float32Array;
  ok: Int8Array;
  line: Int8Array;
}

const SHORES = new WeakMap<World, Shore | null>();

/** Where the river starts going south from `top` at x: the first spot of the river with more of it
 *  beyond (so neither a puddle nor the water between a pontoon and the quay counts), to 10 cm. */
function edgeAt(w: World, x: number, top: number): number {
  for (let y = top; y <= top + 700; y += 1) {
    if (!w.inWater(x, y, 0) || !w.inWater(x, y + 20, 0) || !w.inWater(x, y + 50, 0)) continue;
    let lo = y - 1, hi = y;
    for (let k = 0; k < 4; k++) {
      const m = (lo + hi) / 2;
      if (w.inWater(x, m, 0)) hi = m;
      else lo = m;
    }
    return hi;
  }
  return NaN;
}

/** The bank, worked out once per map (a scan of the river's edge, ~20 ms). Median-smoothed, so a
 *  gangway or a slipway doesn't put a spike in it, and cut to start past Most SNP's deck, which comes
 *  down on this bank. Null on a map without the landmarks or the river. */
function shoreOf(w: World): Shore | null {
  if (SHORES.has(w)) return SHORES.get(w)!;
  let sh: Shore | null = null;
  const snp = w.landmarks.get('snp'), ev = w.landmarks.get('eurovea');
  if (snp && ev && ev.x > snp.x) {
    // from well inside the Old Town (its squares are north of the river) southwards
    const top = Math.min(w.landmarks.get('hviezdoslav')?.y ?? ev.y, ev.y) - 60;
    const x0 = snp.x - 60, n = Math.floor((ev.x + EAST - x0) / STEP) + 1;
    const raw = new Float32Array(n);
    for (let i = 0; i < n; i++) raw[i] = edgeAt(w, x0 + i * STEP, top);
    const ys = new Float32Array(n);
    const win: number[] = [];
    for (let i = 0; i < n; i++) {
      win.length = 0;
      for (let j = Math.max(0, i - 4); j <= Math.min(n - 1, i + 4); j++) if (!isNaN(raw[j])) win.push(raw[j]);
      win.sort((a, b) => a - b);
      ys[i] = win.length ? win[win.length >> 1] : NaN;
    }
    // Most SNP's deck over the promenade: the wall starts a little east of it
    let first = 0;
    for (let i = 0; i < n && x0 + i * STEP <= snp.x + 60; i++) if (!isNaN(ys[i]) && w.onBridge(x0 + i * STEP, ys[i] - WALL_OFF)) first = i + 5;
    if (first < n) sh = { x0: x0 + first * STEP, ys: ys.slice(first), ok: new Int8Array(n - first), line: new Int8Array(n - first) };
  }
  SHORES.set(w, sh);
  return sh;
}

/** The bank at column i: the water's edge (sx, sy), the wall's spot (x, y) WALL_OFF inland of it, the
 *  way the bank runs there (u, eastwards) and the way inland (n). Null where there's no bank. */
function wallAt(sh: Shore, i: number) {
  const ys = sh.ys;
  if (isNaN(ys[i])) return null;
  let a = Math.max(0, i - 3), b = Math.min(ys.length - 1, i + 3);
  while (a < i && isNaN(ys[a])) a++;
  while (b > i && isNaN(ys[b])) b--;
  const tx = (b - a) * STEP || 1, ty = ys[b] - ys[a], l = Math.hypot(tx, ty);
  const ux = tx / l, uy = ty / l;
  // the river is on the bank's right going east (south, on the map): inland is its left
  const nx = uy, ny = -ux;
  const sx = sh.x0 + i * STEP, sy = ys[i];
  return { sx, sy, x: sx + nx * WALL_OFF, y: sy + ny * WALL_OFF, ux, uy, nx, ny };
}

/** Can a gap stand at column i: all of it on dry, open ground at street level (not on a deck, a
 *  pontoon or in a building, clear of trunks and posts), with the river right past the edge in front of
 *  it and nothing built between. */
function slotOk(w: World, sh: Shore, i: number): boolean {
  if (sh.ok[i]) return sh.ok[i] > 0;
  const s = wallAt(sh, i);
  let ok = !!s && w.spawnLevel(s.x, s.y, 0.5) === 0 && w.inWater(s.sx - s.nx * 1.5, s.sy - s.ny * 1.5, 0);
  for (let k = -GAP_W / 2; ok && s && k <= GAP_W / 2; k += GAP_W / 2) {
    const x = s.x + s.ux * k, y = s.y + s.uy * k;
    ok = !w.inWater(x, y, 0) && !w.onBridge(x, y) && !w.onPier(x, y) && !w.insideBuilding(x, y) && !w.collideCircle(x, y, 0.5, 0);
  }
  for (let d = 2; ok && s && d < WALL_OFF; d += 3) ok = !w.insideBuilding(s.sx + s.nx * d, s.sy + s.ny * d);
  sh.ok[i] = ok ? 1 : -1;
  return ok;
}

/** Can the wall run through column i: its spot on dry ground, out of any building (between the gaps
 *  it's only drawn, so trunks and gangways don't matter). */
function lineOk(w: World, sh: Shore, i: number): boolean {
  if (i < 0 || i >= sh.ys.length) return false;
  if (!sh.line[i]) {
    const s = wallAt(sh, i);
    sh.line[i] = s && !w.inWater(s.x, s.y, 0) && !w.insideBuilding(s.x, s.y) ? 1 : -1;
  }
  return sh.line[i] > 0;
}

/** Does the van fit at (x, y) facing `a`: clear of walls, dry, off decks and out of buildings. */
function vanFits(w: World, x: number, y: number, a: number): boolean {
  const s = SPECS.van, r = s.width / 2, n = Math.max(2, Math.ceil(s.length / s.width));
  const fx = Math.cos(a), fy = Math.sin(a);
  for (let i = 0; i < n; i++) {
    const o = -s.length / 2 + r + ((s.length - 2 * r) * i) / (n - 1);
    const px = x + fx * o, py = y + fy * o;
    if (w.collideCircle(px, py, r + 0.3, 0) || w.inWater(px, py, 0) || w.onBridge(px, py) || w.insideBuilding(px, py)) return false;
  }
  return true;
}

/** where the panels are: the stack (x, y), and the van that brought them (vx, vy, facing a) */
export interface Depot {
  x: number;
  y: number;
  vx: number;
  vy: number;
  a: number;
}

/** The stretch of wall nearest (px, py): GAPS gaps SPACING apart where every one of them can stand,
 *  and behind its middle the van (off the carriageway if it can be) with the stack of panels in front
 *  of it. Null when the map has no such bank. */
export function findWall(w: World, px: number, py: number): { gaps: Gap[]; depot: Depot } | null {
  const sh = shoreOf(w);
  if (!sh) return null;
  const n = sh.ys.length, per = Math.round(SPACING / STEP), span = (GAPS - 1) * per;
  // (the wall runs on a stub past its first and last gap)
  const stub = Math.ceil((GAP_W / 2 + STUB) / STEP);
  // the bank runs west to east here: the column nearest the player's x, then outwards from it
  const c = clamp(Math.round((px - sh.x0) / STEP), 0, n - 1);
  let first = -1;
  for (let d = 0; d < n && first < 0; d++)
    for (const mid of d ? [c + d, c - d] : [c]) {
      const f = mid - (span >> 1);
      if (f < 0 || f + span >= n) continue;
      let ok = true;
      for (let k = 0; k < GAPS && ok; k++) ok = slotOk(w, sh, f + k * per);
      for (let i = f - stub; i <= f + span + stub && ok; i++) ok = lineOk(w, sh, i);
      if (ok) {
        first = f;
        break;
      }
    }
  if (first < 0) return null;
  const gaps: Gap[] = [];
  for (let k = 0; k < GAPS; k++) {
    const s = wallAt(sh, first + k * per)!;
    const hw = GAP_W / 2;
    gaps.push({
      x: s.x, y: s.y, ax: s.x - s.ux * hw, ay: s.y - s.uy * hw, bx: s.x + s.ux * hw, by: s.y + s.uy * hw,
      ux: s.ux, uy: s.uy, nx: s.nx, ny: s.ny, closed: true, breached: false,
    });
  }
  // the van: behind the wall's middle, along it; the stack between it and the wall, where someone can
  // stand
  const g0 = gaps[(GAPS - 1) >> 1], g1 = gaps[GAPS >> 1];
  const mx = (g0.x + g1.x) / 2, my = (g0.y + g1.y) / 2, a = Math.atan2(g0.uy + g1.uy, g0.ux + g1.ux);
  const stackOk = (x: number, y: number) => !w.inWater(x, y, 0) && !w.insideBuilding(x, y) && !w.onBridge(x, y) && !w.collideCircle(x, y, 0.6, 0);
  let depot: Depot | null = null;
  for (const road of [false, true])
    for (const off of VAN_OFFS) {
      const vx = mx + g0.nx * off, vy = my + g0.ny * off, x = vx - g0.nx * STACK_OFF, y = vy - g0.ny * STACK_OFF;
      if (!depot && vanFits(w, vx, vy, a) && (road || !w.onCarriageway(vx, vy)) && stackOk(x, y)) depot = { x, y, vx, vy, a };
    }
  if (!depot) {
    const v = w.clearSpot(mx + g0.nx * VAN_OFFS[0], my + g0.ny * VAN_OFFS[0], SPECS.van.width / 2 + 0.5);
    const s = w.clearSpot(mx + g0.nx * (VAN_OFFS[0] - STACK_OFF), my + g0.ny * (VAN_OFFS[0] - STACK_OFF), 0.6);
    depot = { x: s.x, y: s.y, vx: v.x, vy: v.y, a };
  }
  return { gaps, depot };
}

/** a seed whose person looks like a tourist (the bright shirt, the backpack and the camera): the
 *  appearance comes from the seed, on every client alike */
function touristSeed(rng: Rng): number {
  for (let k = 0; k < 60; k++) {
    const s = rng.seed();
    if (new Ped('civ', 0, 0, s).archetype === 'tourist') return s;
  }
  return rng.seed();
}

/** "1 panel", "3 panely", "5 panelov" */
function panels(n: number) {
  return `${n} ${n === 1 ? 'panel' : n >= 2 && n <= 4 ? 'panely' : 'panelov'}`;
}

/** 9.4 → "9,4" */
const metres = (h: number) => h.toFixed(1).replace('.', ',');
const r1 = (v: number) => Math.round(v * 10) / 10;

/** The Danube's level (m) `t` seconds into the waves: up to each peak, down a little after it, then
 *  up to the next one. */
export function levelAt(t: number): number {
  let t0 = 0, h0 = BASE;
  for (let k = 0; k < PEAKS.length; k++) {
    if (t <= PEAKS[k]) return h0 + ((HEIGHTS[k] - h0) * Math.max(0, t - t0)) / (PEAKS[k] - t0);
    if (t <= PEAKS[k] + EBB_S) return HEIGHTS[k] - (EBB * (t - PEAKS[k])) / EBB_S;
    (t0 = PEAKS[k] + EBB_S), (h0 = HEIGHTS[k] - EBB);
  }
  return h0;
}

// ------------------------------------------------------------------------------------ the round
class Flood extends MiniGame {
  late = true;
  private phase: 'travel' | 'waves' = 'travel';
  /** someone got to the embankment (the waves didn't just start without them) */
  private came = false;
  /** seconds since the waves started, and left to wait for the players to get there */
  private t = 0;
  private travel = TRAVEL_S;
  /** peaks passed, waves held (nothing came through at the peak), breaches so far */
  private wave = 0;
  private held = 0;
  private breaches = 0;
  /** the shared score (€): what everyone is paid, before their own panels */
  private score = 0;
  /** when (t) the last wave knocks panels out (-1: not now), and the next tourist comes */
  private knockAt = -1;
  private touristAt = TOURIST_FIRST;
  private tourists: Tourist[] = [];
  /** the van that brought the panels (only scenery: the stack in front of it is the depot) */
  van: Vehicle | null = null;
  private state = new Map<number, Player>();
  /** the embankment's name for the way there ("Rázusovo nábrežie") */
  private street: string;

  constructor(
    sim: Sim,
    round: MiniRound,
    readonly gaps: Gap[],
    private depot: Depot,
  ) {
    super(sim, round);
    const g = gaps[GAPS >> 1];
    this.street = sim.world.streetName(depot.vx + g.nx * 8, depot.vy + g.ny * 8) ?? '';
    round.x = Math.round((gaps[0].x + gaps[GAPS - 1].x) / 2);
    round.y = Math.round((gaps[0].y + gaps[GAPS - 1].y) / 2);
    this.open(OPEN_SOLO);
  }

  /** open gaps until `n` are (the lobby opens more for each player who joins) */
  private open(n: number) {
    const closed = () => this.gaps.filter((g) => g.closed);
    while (this.gaps.length - closed().length < Math.min(n, OPEN_MAX)) this.sim.rng.pick(closed()).closed = false;
  }

  start() {
    const v = new Vehicle('van', this.depot.vx, this.depot.vy, this.depot.a, VAN_COLOR);
    v.locked = true;
    v.parked = true;
    this.van = this.spawnVehicle(v);
    for (const p of this.players) this.onJoin(p);
    if (this.arrived()) return this.begin('Ste na nábreží! Nos panely z auta do medzier v stene.');
    this.round.left = this.travel;
    this.tell(`Utekaj na ${this.street || 'nábrežie'} – Dunaj stúpa!`, '#4fc3f7', 3);
  }

  onJoin(p: SimPlayer) {
    if (!this.state.has(p.id)) this.state.set(p.id, { carry: false, panels: 0 });
    // in the lobby a bigger crew gets a bigger job
    if (this.round.phase === 'lobby') this.open(OPEN_SOLO + this.players.length - 1);
  }

  onLeave(p: SimPlayer) {
    this.state.delete(p.id);
  }

  /** where the panels are: the stack the van unloaded (whatever becomes of the van) */
  private depotAt(): { x: number; y: number } {
    return this.depot;
  }

  // ---------------------------------------------------------------------------------- the step
  /** someone's at the embankment, by the panels */
  private arrived() {
    const d = this.depotAt();
    return (this.came ||= this.players.some((p) => {
      const f = this.pos(p);
      return dist(f.x, f.y, d.x, d.y) <= ARRIVE_R;
    }));
  }

  update(dt: number) {
    if (this.phase === 'travel') {
      this.travel -= dt;
      if (this.arrived()) this.begin('Ste na nábreží! Nos panely z auta do medzier v stene.');
      else if (this.travel <= 0) this.begin('Dunaj nečaká – prvá vlna je na ceste!');
      // the HUD's countdown: the time left to get there
      else this.round.left = this.travel;
      return;
    }
    this.t += dt;
    if (!this.came) this.arrived();
    while (this.wave < PEAKS.length && this.t >= PEAKS[this.wave] && !this.over) this.peak();
    if (this.over) return;
    if (this.knockAt >= 0 && this.t >= this.knockAt) this.knockOut();
    this.stepTourists(dt);
    if (this.wave >= PEAKS.length && this.t >= PEAKS[PEAKS.length - 1] + END_AFTER) return this.end(false);
    // the HUD's countdown (the round has no fixed length): the time to the next peak
    this.round.left = this.wave < PEAKS.length ? PEAKS[this.wave] - this.t : 0;
  }

  private begin(text: string) {
    this.phase = 'waves';
    this.t = 0;
    this.round.left = PEAKS[0];
    this.tell(this.players.length > 1 ? text : text.replace('Ste ', 'Si '), '#4fc3f7', 3);
  }

  /** a wave peaks: every gap still open lets the river through */
  private peak() {
    const k = this.wave++;
    let broke = 0;
    this.gaps.forEach((g, i) => {
      if (g.closed) return;
      g.breached = true;
      broke++;
      const t = this.blocker(i);
      if (t) {
        this.leave(t);
        this.tell('Turistovi zmokli tenisky – ale selfie má!', '#ffd740', 2.5);
      }
    });
    if (broke) {
      this.breaches += broke;
      this.score = Math.max(0, this.score - BREACH_COST * broke);
      this.tell(`Prielom! Dunaj sa valí na nábrežie (${broke}×).`, '#ff5252', 3);
      if (this.breaches >= MAX_BREACH) return this.end(true);
    } else {
      this.held++;
      this.score += PAY_WAVE;
      this.tell(`Kulminácia ${metres(HEIGHTS[k])} m – stena vydržala! 💪`, '#69f0ae', 3);
    }
    if (this.wave < PEAKS.length) this.knockAt = PEAKS[k] + KNOCK_AFTER;
  }

  /** the wave's aftermath: a few panels knocked out (one more for each extra player) */
  private knockOut() {
    this.knockAt = -1;
    const closed = this.gaps.filter((g) => g.closed);
    const n = Math.min(closed.length, 1 + this.players.length);
    for (let i = 0; i < n; i++) {
      const g = closed.splice(this.sim.rng.int(closed.length), 1)[0];
      g.closed = false;
    }
    if (n === 1) this.tell('Vlna vyrazila panel! Jedna medzera je zase otvorená.', '#ffd740', 3);
    else if (n > 1) this.tell(`Vlna vyrazila ${panels(n)}! Zase sú medzery.`, '#ffd740', 3);
  }

  private end(lost: boolean) {
    const team = [...this.state.values()].reduce((n, s) => n + s.panels, 0);
    const group = this.players.length > 1;
    for (const p of this.players) {
      const s = this.state.get(p.id) ?? { carry: false, panels: 0 };
      if (lost) {
        const pay = team ? PAY_LOST + Math.min(LOST_CAP, LOST_PANEL * s.panels) : 0;
        const text = team ? 'Dunaj prerazil stenu – nábrežie je pod vodou. 🌊' : this.came ? 'Ani jeden panel v stene… Dunaj si poradil sám.' : 'Na nábrežie nikto neprišiel… Dunaj si poradil sám.';
        this.outcome(p, { pay, text });
        continue;
      }
      const pay = this.score + (this.breaches ? 0 : PAY_DRY) + Math.min(PANEL_CAP, PAY_PANEL * s.panels);
      const text = !this.breaches
        ? 'Stena vydržala všetky vlny – Staré Mesto je suché! 🎉'
        : `Dunaj kulminoval. ${group ? 'Vydržali ste' : 'Vydržal si'} ${this.held} zo ${PEAKS.length} vĺn.`;
      this.outcome(p, { pay, text });
    }
    // for the news: the Old Town stayed dry enough (the consolation for a lost wall is no win)
    this.won = !lost;
    this.finish();
  }

  // ------------------------------------------------------------------------------ the tourists
  /** the tourist standing in gap i (taking selfies, or about to go): they keep the panel out */
  private blocker(i: number): Tourist | undefined {
    return this.tourists.find((t) => t.gap === i && (t.mode === 'selfie' || t.mode === 'asked'));
  }

  /** an open gap nobody's heading for yet, nearest (x, y) */
  private freeGap(x: number, y: number, except?: Tourist): number {
    let best = -1, bd = Infinity;
    this.gaps.forEach((g, i) => {
      if (g.closed || this.tourists.some((t) => t !== except && t.gap === i)) return;
      const d = dist(g.x, g.y, x, y);
      if (d < bd) (bd = d), (best = i);
    });
    return best;
  }

  private stepTourists(dt: number) {
    const group = this.players.length > 1;
    if (this.t >= this.touristAt && this.wave < PEAKS.length) {
      this.touristAt = this.t + (group ? TOURIST_EVERY_GROUP : TOURIST_EVERY);
      const max = group ? Math.min(TOURISTS_MAX, 1 + this.players.length) : TOURISTS_SOLO;
      if (this.tourists.filter((t) => t.mode !== 'leave').length < max) this.spawnTourist();
    }
    for (const t of [...this.tourists]) {
      const ped = t.ped;
      if (t.mode === 'walk') {
        // the gap got its panel before they got there: another one, or they wander off
        if (this.gaps[t.gap].closed) {
          const i = this.freeGap(ped.x, ped.y, t);
          if (i < 0) {
            this.leave(t);
            continue;
          }
          t.gap = i;
        }
        // (in the gap, a step back from its line: the river's in front, the phone up)
        const g = this.gaps[t.gap];
        if (walk(ped, g.x + g.nx * SELFIE_BACK, g.y + g.ny * SELFIE_BACK, TOURIST_SPEED, dt)) {
          t.mode = 'selfie';
          ped.angle = Math.atan2(-g.ny, -g.nx);
          this.tell('📱 Turista si v medzere robí selfie s Dunajom!', '#ff80ab', 2.5);
        }
      } else if (t.mode === 'asked') {
        t.t -= dt;
        if (t.t <= 0) this.leave(t);
      } else if (t.mode === 'leave') {
        t.t -= dt;
        if (walk(ped, t.tx, t.ty, TOURIST_SPEED * 1.4, dt) || t.t <= 0) {
          this.tourists.splice(this.tourists.indexOf(t), 1);
          this.despawn(ped);
        }
      }
    }
  }

  /** one comes strolling along the promenade toward an open gap */
  private spawnTourist() {
    const rng = this.sim.rng, w = this.sim.world;
    const free = this.gaps.map((g, i) => i).filter((i) => !this.gaps[i].closed && !this.tourists.some((t) => t.gap === i));
    if (!free.length) return;
    const i = rng.pick(free), g = this.gaps[i];
    const side = rng.chance(0.5) ? 1 : -1;
    for (const dir of [side, -side]) {
      const along = rng.range(TOURIST_FROM, TOURIST_TO) * dir;
      const x = g.x + g.ux * along + g.nx * 2.5, y = g.y + g.uy * along + g.ny * 2.5;
      if (w.inWater(x, y, 0) || w.insideBuilding(x, y) || w.onBridge(x, y) || w.spawnLevel(x, y, 0.4) !== 0) continue;
      const ped = this.spawnPed(new Ped('civ', x, y, touristSeed(rng)));
      ped.state = 'idle';
      this.tourists.push({ ped, gap: i, mode: 'walk', t: 0, tx: x, ty: y });
      return;
    }
  }

  /** off they go, inland and along, and out of the round */
  private leave(t: Tourist) {
    const g = this.gaps[Math.max(0, t.gap)], side = this.sim.rng.chance(0.5) ? 1 : -1;
    t.mode = 'leave';
    t.gap = -1;
    t.t = LEAVE_S;
    t.tx = t.ped.x + g.nx * 16 + g.ux * 10 * side;
    t.ty = t.ped.y + g.ny * 16 + g.uy * 10 * side;
  }

  // ------------------------------------------------------------------------------- the action
  /** the tourist in a gap within reach of `p` */
  private touristNear(p: SimPlayer): Tourist | undefined {
    const ped = p.ped;
    return this.tourists.find((t) => t.mode === 'selfie' && dist(t.ped.x, t.ped.y, ped.x, ped.y) <= REACH + 0.5);
  }

  /** the open gap within reach of `p` (from its line), nearest */
  private gapNear(p: SimPlayer): number {
    const ped = p.ped;
    let best = -1, bd = REACH * REACH;
    this.gaps.forEach((g, i) => {
      if (g.closed) return;
      const d = segDist2(ped.x, ped.y, g.ax, g.ay, g.bx, g.by);
      if (d <= bd) (bd = d), (best = i);
    });
    return best;
  }

  private atDepot(p: SimPlayer) {
    const d = this.depotAt();
    return dist(d.x, d.y, p.ped.x, p.ped.y) <= DEPOT_REACH;
  }

  /** What the action key does for `p` here (and does it): ask a selfie-taker out of a gap, set the
   *  panel they carry in the gap they're at, or take one from the stack. */
  private action(p: SimPlayer, s: Player, doIt: boolean): string | undefined {
    if (this.phase !== 'waves' || p.ped.vehicle) return undefined;
    const i = s.carry ? this.gapNear(p) : -1;
    const t = this.touristNear(p) ?? (i >= 0 ? this.blocker(i) : undefined);
    if (t?.mode === 'selfie') {
      if (doIt) {
        t.mode = 'asked';
        t.t = ASKED_S;
        this.msg(p, '„Choďte preč, prosím!" – „Ešte jedno selfie… Dobre, dobre."', '#ffd740', 3);
      }
      return 'Choďte preč, prosím!';
    }
    // (one who's been asked is on their way: the panel goes in once they're out of it)
    if (t) return undefined;
    if (i >= 0) {
      if (doIt) this.setPanel(p, s, i);
      return 'Osadiť panel';
    }
    if (!s.carry && this.atDepot(p)) {
      if (doIt) {
        s.carry = true;
        // (a floating word, not a line: the lines on the screen queue up, and the river's news
        // mustn't wait behind the routine)
        this.pop(p, 'panel!', p.ped.x, p.ped.y - 1.7);
      }
      return 'Vziať panel';
    }
    return undefined;
  }

  private setPanel(p: SimPlayer, s: Player, i: number) {
    if (this.blocker(i)) return this.msg(p, 'V medzere sa fotí turista – popros ho, nech odíde.', '#ffd740');
    const g = this.gaps[i];
    g.closed = true;
    s.carry = false;
    s.panels++;
    this.addPoints(p, 1);
    this.pop(p, 'panel sedí!', g.x, g.y - 1.5);
    if (this.gaps.every((q) => q.closed)) this.tell('Všetky medzery sú zatvorené! 💪', '#69f0ae', 2);
  }

  act(p: SimPlayer) {
    const s = this.state.get(p.id);
    if (!s) return;
    if (this.phase === 'waves' && p.ped.vehicle) return this.msg(p, 'Najprv vystúp z auta – panely sa nosia v rukách.');
    this.action(p, s, true);
  }

  // --------------------------------------------------------------------------------- the view
  /** the level now (m), and how far the river has climbed the promenade toward the wall (0..1) */
  private level() {
    const h = this.phase === 'waves' ? levelAt(this.t) : BASE;
    return { h, lv: clamp((h - DRY_AT) / (WALL_AT - DRY_AT), 0, 1) };
  }

  /** a peak comes within WARN_S: the open gaps blink, the meter goes red */
  private peakNear() {
    return this.phase === 'waves' && this.wave < PEAKS.length && PEAKS[this.wave] - this.t < WARN_S;
  }

  /** the wall for the drawer (draw/flood.ts): each gap's ends, and its state (0 open, 1 panel in, 2 a
   *  tourist in it, 3 open and the river's been through it, 4 a panel in again after that), the
   *  water, whether `p` carries a panel, the stack of panels */
  private wallX(carry: boolean, h: number, lv: number): Record<string, number | string | number[]> {
    const w: number[] = [];
    let st = '';
    this.gaps.forEach((g, i) => {
      w.push(r1(g.ax), r1(g.ay), r1(g.bx), r1(g.by));
      st += g.closed ? (g.breached ? '4' : '1') : this.blocker(i) ? '2' : g.breached ? '3' : '0';
    });
    const hv = clamp((h - BAR_LO) / (BAR_HI - BAR_LO), 0, 1), d = this.depot;
    return {
      w, s: st, lv: Math.round(lv * 100) / 100, hv: Math.round(hv * 100) / 100, d: WALL_OFF, c: carry ? 1 : 0, pk: this.peakNear() ? 1 : 0,
      dp: [r1(d.x), r1(d.y), Math.round(d.a * 100) / 100],
    };
  }

  private marks(p: SimPlayer, s: Player | undefined): MiniMark[] {
    const marks: MiniMark[] = [];
    const d = this.depotAt(), ped = p.ped;
    const live = this.round.phase === 'live' && this.phase === 'waves';
    // the arrow: to the depot for a panel (or on the way there), to the nearest open gap with one
    let target = -1, td = Infinity;
    if (live && s?.carry)
      this.gaps.forEach((g, i) => {
        const dd = dist(g.x, g.y, ped.x, ped.y);
        if (!g.closed && !this.blocker(i) && dd < td) (td = dd), (target = i);
      });
    const toDepot = !live || (!s?.carry && this.gaps.some((g) => !g.closed));
    marks.push({ x: Math.round(d.x), y: Math.round(d.y), icon: '🧱', label: 'panely', color: '#ffa726', r: 2.5, ...(toDepot ? { arrow: 1 as const } : {}) });
    this.gaps.forEach((g, i) => {
      if (g.breached) {
        // the street behind it, flooded
        const bx = g.nx * BREACH_DEPTH, by = g.ny * BREACH_DEPTH;
        marks.push({
          x: Math.round(g.x + bx * 0.6), y: Math.round(g.y + by * 0.6), icon: '🌊', label: 'zaplavené', color: '#29b6f6',
          poly: [g.ax, g.ay, g.bx, g.by, g.bx + bx, g.by + by, g.ax + bx, g.ay + by].map(Math.round),
        });
      }
      if (g.closed) return;
      const t = this.blocker(i);
      marks.push({
        x: r1(g.x), y: r1(g.y), w: GAP_W, h: 1.2, a: Math.round(Math.atan2(g.uy, g.ux) * 100) / 100,
        color: t ? '#ff80ab' : '#ff5252', label: t ? 'turista!' : 'medzera', ...(i === target ? { arrow: 1 as const } : {}),
      });
    });
    for (const t of this.tourists)
      if (t.mode !== 'leave') marks.push({ x: Math.round(t.ped.x), y: Math.round(t.ped.y), e: t.ped.id, icon: '📱', color: '#ff80ab', noMap: 1 });
    return marks;
  }

  view(p: SimPlayer): MiniView {
    const s = this.state.get(p.id);
    const { h, lv } = this.level();
    const open = this.gaps.filter((g) => !g.closed).length;
    const group = this.players.length > 1;
    let goal: string;
    if (this.phase === 'travel') goal = `Utekaj na ${this.street || 'nábrežie'}! Dunaj stúpa.`;
    else if (this.wave >= PEAKS.length) goal = 'Dunaj kulminoval – ešte chvíľu vydržať!';
    else if (p.ped.vehicle) goal = 'Vystúp z auta – panely sa nosia v rukách.';
    else if (s?.carry) goal = 'Nes panel do otvorenej medzery a osaď ho.';
    else if (open) goal = 'Vezmi panel z auta a zatvor medzery pred kulmináciou!';
    else goal = group ? 'Všetko zatvorené – strážte stenu, vlna prichádza.' : 'Všetko zatvorené – stráž stenu, vlna prichádza.';
    const stats: [string, string][] =
      this.phase === 'travel'
        ? [['Nábrežie', `${Math.round(dist(this.pos(p).x, this.pos(p).y, this.depotAt().x, this.depotAt().y))} m`]]
        : [['Vlna', `${Math.min(this.wave + 1, PEAKS.length)}/${PEAKS.length}`], ['Medzery', `${open}`], ['Prielomy', `${this.breaches}/${MAX_BREACH}`]];
    const v = clamp((h - BAR_LO) / (BAR_HI - BAR_LO), 0, 1);
    return {
      goal,
      stats,
      bar: { label: `Hladina Dunaja ${metres(h)} m`, v, color: this.peakNear() ? '#ff5252' : v > 0.75 ? '#ffb300' : '#4fc3f7' },
      marks: this.marks(p, s),
      act: s ? this.action(p, s, false) : undefined,
      x: this.wallX(!!s?.carry, h, lv),
    };
  }

  lobbyView(p: SimPlayer): MiniView {
    const { h, lv } = this.level();
    return { goal: 'Dunaj stúpa ako v septembri 2024! Na nábreží treba dostavať mobilnú stenu.', marks: this.marks(p, undefined), x: this.wallX(false, h, lv) };
  }
}

/** Walk `ped` toward (x, y) at `speed` for `dt`: true once it's there (and standing). */
function walk(ped: Ped, x: number, y: number, speed: number, dt: number): boolean {
  const dx = x - ped.x, dy = y - ped.y, d = Math.hypot(dx, dy);
  if (d <= speed * dt || d < 0.05) {
    ped.x = x;
    ped.y = y;
    ped.vx = ped.vy = 0;
    return true;
  }
  ped.vx = (dx / d) * speed;
  ped.vy = (dy / d) * speed;
  ped.x += ped.vx * dt;
  ped.y += ped.vy * dt;
  ped.angle = Math.atan2(dy, dx);
  ped.walkPhase += speed * dt * 3.2;
  return false;
}

export const FLOOD_DEF: MiniGameDef = {
  kind: 'flood',
  lobby: 20,
  create(sim, round) {
    const site = findWall(sim.world, round.x, round.y);
    if (!site) return 'Tu nie je nábrežie, ktoré by sa dalo brániť – skús to pri Dunaji.';
    const g = site.gaps[GAPS >> 1];
    if (dist(round.x, round.y, g.x, g.y) > FAR_R) return 'Povodeň je na nábreží v Starom Meste – príď bližšie k Dunaju.';
    return new Flood(sim, round, site.gaps, site.depot);
  },
};
