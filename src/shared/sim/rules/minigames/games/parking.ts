// Parkovací hon (docs/plans/minigames.md): since 2022 Bratislava's paid-parking zones (PAAS) keep
// spreading, a scan car drives every regulated street about three times a day looking for a resident
// card or a paid ticket, and there are never enough spots. Here the zone is a loop of a few streets
// near the player with blue bays painted at the kerb, fewer than the cars that want them. Every sweep
// the scan car drives the loop once: a car it passes that isn't standing in a bay with a ticket paid
// in the app is fined, and so is one it never finds in the zone at all. Two fines and you're out.
//
// NPC drivers circle the loop and take whatever bay they pass free, stay a while and leave again;
// after each sweep the city repaints a bay or two as "zákaz státia", so the chairs get fewer while
// the music plays on. Alone the drivers are the rivals; with others, everyone hunts the same bays and
// the last one standing wins.
import { angleDiff, clamp, dist } from '../../../../util/math';
import { linkPoints, type Edge, type Link } from '../../../../world/Graph';
import type { World } from '../../../../world/World';
import { SPECS, Vehicle, type VehicleKind } from '../../../../entities/Vehicle';
import type { Sim } from '../../../Sim';
import type { SimPlayer } from '../../../SimPlayer';
import { MiniGame, type MiniGameDef, type MiniRound, type MiniView } from '../MiniGame';
import { MINI_INFO } from '../catalog';
import type { MiniMark } from '../types';

/** a bay: this long along the kerb and this wide (m), one every BAY_STEP along a street, and none
 *  closer than BAY_END to a junction */
const BAY_L = 5.2, BAY_W = 2.4, BAY_STEP = 6.5, BAY_END = 9;
/** a zone needs room for at least this many bays */
const MIN_SLOTS = 7;
/** the zone's loop: at least this long, and made of at most this many links */
const LOOP_MIN = 150, LOOP_LINKS = 12;
/** the length a lap should have (m): under a minute's drive for the scan car; and how wide a loop
 *  should be at least (its area over its length, m: 20 is round a block 80 m across, 5 up and down a
 *  divided street) */
const LOOP_BEST = 260, THIN = 12;
/** how the loop is looked for: residential streets near the player first, then anything drivable a
 *  bit further (a mall's car park, the hills' long bends) */
interface Tier {
  cls: [number, number];
  lanes: number;
  r: number;
  max: number;
}
const TIERS: Tier[] = [
  { cls: [3, 6], lanes: 2, r: 300, max: 420 },
  { cls: [2, 7], lanes: 3, r: 500, max: 600 },
];
/** the search for loops gives up after this many steps (a few milliseconds either way); then the bays
 *  are laid out along the best loops until this many have room for them (looking at twice that many
 *  at most) */
const SEARCH_BUDGET = 50000, SHORTLIST = 6;
/** the scan car sees this far (m) */
const SCAN_R = 15;
/** the first sweep starts FIRST_SWEEP after the round, and a second more for every FIRST_PER metres
 *  the farthest player has to drive to a bay, up to FIRST_MAX (s); after that a sweep starts at
 *  least SWEEP_EVERY after the last one started, and SWEEP_GAP after it came back */
const FIRST_SWEEP = 30, FIRST_PER = 7, FIRST_MAX = 60, SWEEP_EVERY = 45, SWEEP_GAP = 10;
/** a lap stuck this long without getting anywhere (s), or taking longer than LAP_MAX, ends the sweep
 *  where it is (a red light is ~22 s at most; the Old Town jams) */
const STUCK_S = 26, LAP_MAX = 80;
/** sweeps in a round: four, or three when a lap takes longer than LONG_LAP (s) at the scan car's
 *  average speed, LAP_SPEED (m/s), so that a round is over in three or four minutes */
const SWEEPS = 4, LONG_LAP = 40, LAP_SPEED = 6.5;
/** fines that put a player out */
const FINES_OUT = 2;
/** the parking app's price for one sweep (€) */
const FEE = 2;
/** a car slower than this (m/s) is standing */
const STOPPED = 0.5;
/** pay: each sweep got through, still in at the end, each fine, the group's winner */
const PAY_SWEEP = 40, PAY_FINISH = 80, FINE = 20, WIN_BONUS = 60;
/** standings: a sweep got through, and still in at the end */
const PTS_SWEEP = 100, PTS_FINISH = 150;
/** a round never runs longer than this (s) */
const MAX_S = 360;
/** NPC drivers: how long one stays in a bay (s), the gap before the next one turns up (s), how close
 *  ahead a free bay has to be for one to pull in (m), and how long one circles before giving up (s) */
const STAY: [number, number] = [35, 80];
const RIVAL_GAP: [number, number] = [3, 8];
const GRAB_R = 13, CIRCLE_MAX = 60;
const RIVAL_KINDS: VehicleKind[] = ['hatch', 'sedan', 'hatch', 'sedan', 'van', 'classic', 'taxi'];
const BLUE = MINI_INFO.parking.color, OK = '#69f0ae', WARN = '#ffd740', BAD = '#ff5252';

interface Bay {
  x: number;
  y: number;
  /** the street's direction there */
  a: number;
  /** the loop link it's on, and how far along it (m) */
  li: number;
  s: number;
  /** repainted: zákaz státia */
  gone: boolean;
  /** the vehicle standing in it now (its centre inside), if any */
  by: Vehicle | null;
  /** an NPC driver pulling into it */
  claim: Rival | null;
}

interface Rival {
  v: Vehicle;
  state: 'circle' | 'park' | 'parked' | 'leave';
  bay: Bay | null;
  /** seconds in this state */
  t: number;
  /** parked: sim.time it leaves; leave: sim.time it may be taken out of the city */
  until: number;
}

interface Player {
  /** the car that counts: the one they drove last in the round */
  car: Vehicle | null;
  fines: number;
  /** sweeps got through */
  ok: number;
  /** the app's ticket: this bay, for this sweep */
  paid: { bay: Bay; sweep: number } | null;
  /** the sweep the scan car last checked them in */
  checked: number;
  out: boolean;
  /** the car the game marked as parked (so traffic, the scan car too, drives round it) */
  flagged: Vehicle | null;
  /** parking fees paid on credit, with no money on them: they come off the round's pay (€) */
  tab: number;
}

/** the zone: its loop of links, the loop's centre line (closed, flat) with the distance along it at
 *  each point, every place a bay could go (in the order the loop meets them), where the scan car
 *  waits between sweeps, and the outline for the map */
interface Zone {
  links: Link[];
  pts: number[];
  cum: number[];
  len: number;
  slots: Bay[];
  /** the bays are picked evenly round the loop from here (0..1 of a step): the same ones for the
   *  same count, in the lobby and after */
  from: number;
  rest: { x: number; y: number; a: number };
  cx: number;
  cy: number;
  poly: number[];
}

/** the point and heading at arc length `s` along a flat polyline */
function along(p: number[], s: number): { x: number; y: number; a: number } {
  let acc = 0;
  for (let i = 0; i + 3 < p.length; i += 2) {
    const dx = p[i + 2] - p[i], dy = p[i + 3] - p[i + 1], l = Math.hypot(dx, dy);
    if (acc + l >= s || i + 4 >= p.length) {
      const t = l ? clamp((s - acc) / l, 0, 1) : 0;
      return { x: p[i] + dx * t, y: p[i + 1] + dy * t, a: Math.atan2(dy, dx) };
    }
    acc += l;
  }
  return { x: p[0], y: p[1], a: 0 };
}

/** would a car of `kind` standing at (x, y) facing `a` be clear of every wall, fence and post (AI.ts's
 *  own check, private there) */
function clearOfWalls(w: World, kind: VehicleKind, x: number, y: number, a: number): boolean {
  const s = SPECS[kind], r = s.width / 2, n = Math.max(2, Math.ceil(s.length / s.width));
  const fx = Math.cos(a), fy = Math.sin(a);
  for (let i = 0; i < n; i++) {
    const o = -s.length / 2 + r + ((s.length - 2 * r) * i) / (n - 1);
    if (w.collideCircle(x + fx * o, y + fy * o, r, 0)) return false;
  }
  return true;
}

/** the lane traffic keeps to on a link (AI.ts's `laneOffset`): the NPC drivers set off from it */
function laneOf(l: Link): number {
  return (l.fwd ? l.edge.laneF : l.edge.laneR) ?? (l.edge.oneway ? 0 : Math.min(l.edge.width / 4, 1.9));
}

/** a street the zone's loop may run along: the tier's kinds of road, not too many lanes, and at
 *  street level all the way (no bridge deck, no tunnel) */
function edgeOk(w: World, e: Edge, t: Tier): boolean {
  if (e.cls < t.cls[0] || e.cls > t.cls[1]) return false;
  if ((e.lanesF ?? 1) + (e.lanesR ?? 1) > t.lanes) return false;
  const p = e.p;
  for (let i = 0; i + 3 < p.length; i += 2) {
    const n = Math.max(1, Math.ceil(Math.hypot(p[i + 2] - p[i], p[i + 3] - p[i + 1]) / 8));
    for (let k = 0; k <= n; k++) {
      const x = p[i] + ((p[i + 2] - p[i]) * k) / n, y = p[i + 1] + ((p[i + 3] - p[i + 1]) * k) / n;
      if (w.onBridge(x, y) || w.tunnelDepth(x, y) >= 0) return false;
    }
  }
  return true;
}

/** Directed loops of the car graph near (x, y): a way round a block or two that a car can drive, each
 *  street once, back to where it began (the scan car's round). A depth-first search from the nodes
 *  nearest the player, within the tier's limits. */
function loopsNear(w: World, x: number, y: number, t: Tier): Link[][] {
  const g = w.car;
  const ok = new Map<number, boolean>();
  const usable = (l: Link) => {
    if (l.fwd ? l.edge.blockedF : l.edge.blockedR) return false;
    let v = ok.get(l.edge.id);
    if (v === undefined) ok.set(l.edge.id, (v = edgeOk(w, l.edge, t)));
    return v;
  };
  const starts = g
    .nodesAround(x, y, 0, t.r)
    .map((n) => ({ n, d: dist(g.nx(n), g.ny(n), x, y) }))
    .sort((a, b) => a.d - b.d)
    .slice(0, 30);
  const found = new Map<string, Link[]>();
  let budget = SEARCH_BUDGET;
  for (const { n: s } of starts) {
    const path: Link[] = [];
    const seen = new Set<number>([s]);
    const walk = (n: number, len: number) => {
      for (const l of g.out[n]) {
        if (--budget < 0) return;
        if (!usable(l) || path.some((q) => q.edge === l.edge)) continue;
        const nl = len + l.edge.len;
        if (nl > t.max) continue;
        if (l.to === s) {
          if (path.length >= 2 && nl >= LOOP_MIN) {
            const loop = [...path, l];
            const key = loop.map((q) => q.edge.id).sort((a, b) => a - b).join(',');
            if (!found.has(key)) found.set(key, loop);
          }
          continue;
        }
        if (seen.has(l.to) || path.length >= LOOP_LINKS - 1) continue;
        seen.add(l.to);
        path.push(l);
        walk(l.to, nl);
        path.pop();
        seen.delete(l.to);
      }
    };
    walk(s, 0);
    if (budget < 0) break;
  }
  return [...found.values()];
}

/** the map's marked pedestrian crossings in cells CROSS_CELL wide, built once per map */
const CROSS_CELL = 16, CROSS_R = 7;
const crossGrids = new WeakMap<World, Map<number, number[]>>();
const cellKey = (gx: number, gy: number) => (gx + 5000) * 10000 + gy + 5000;
function nearCrossing(w: World, x: number, y: number): boolean {
  let grid = crossGrids.get(w);
  if (!grid) {
    grid = new Map();
    const c = w.data.crossings ?? [];
    for (let i = 0; i < c.length; i += 4) {
      const k = cellKey(Math.floor(c[i] / CROSS_CELL), Math.floor(c[i + 1] / CROSS_CELL));
      const cell = grid.get(k);
      if (cell) cell.push(c[i], c[i + 1]);
      else grid.set(k, [c[i], c[i + 1]]);
    }
    crossGrids.set(w, grid);
  }
  const gx = Math.floor(x / CROSS_CELL), gy = Math.floor(y / CROSS_CELL);
  for (let i = gx - 1; i <= gx + 1; i++)
    for (let j = gy - 1; j <= gy + 1; j++) {
      const cell = grid.get(cellKey(i, j));
      if (cell) for (let k = 0; k < cell.length; k += 2) if (dist(cell[k], cell[k + 1], x, y) < CROSS_R) return true;
    }
  return false;
}

/** Where bays can be painted along a loop: at the right-hand kerb of each street wide and long
 *  enough, a car's length apart, clear of junctions, traffic lights, signs and bus stops, pedestrian
 *  crossings, tram tracks, walls and buildings, and of any car standing there now (the quick checks
 *  first). */
function baySlots(sim: Sim, links: Link[]): Bay[] {
  const w = sim.world;
  const out: Bay[] = [];
  links.forEach((l, li) => {
    const e = l.edge;
    if (e.width < 4.4 || e.len < BAY_END * 2) return;
    const pts = linkPoints(l, e.width / 2 - BAY_W / 2);
    const signs = [...w.lights.forLink(l), ...w.marks.forLink(l)];
    for (let s = BAY_END; s <= e.len - BAY_END; s += BAY_STEP) {
      const b = along(pts, s);
      if (signs.some((m) => dist(m.x, m.y, b.x, b.y) < 8) || out.some((q) => dist(q.x, q.y, b.x, b.y) < BAY_L + 0.4)) continue;
      if (w.spawnLevel(b.x, b.y, BAY_W / 2, b.a) !== 0 || nearCrossing(w, b.x, b.y) || w.tram.segmentAt(b.x, b.y, 3.4)) continue;
      const fx = Math.cos(b.a), fy = Math.sin(b.a);
      let ok = true;
      for (const [u, v] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
        const cx = b.x + (fx * u * BAY_L) / 2 - (fy * v * BAY_W) / 2, cy = b.y + (fy * u * BAY_L) / 2 + (fx * v * BAY_W) / 2;
        if (ok && (w.insideBuilding(cx, cy) || w.inWater(cx, cy, 0))) ok = false;
      }
      if (!ok || !clearOfWalls(w, 'sedan', b.x, b.y, b.a)) continue;
      if (sim.vehiclesNear(b.x, b.y, 8).some((v) => dist(v.x, v.y, b.x, b.y) < v.spec.length / 2 + BAY_L / 2)) continue;
      out.push({ x: b.x, y: b.y, a: b.a, li, s, gone: false, by: null, claim: null });
    }
  });
  return out;
}

/** The PAAS zone near (x, y): the best loop (near the player, about a minute's drive round, with room
 *  for enough bays), turned so that the scan car can wait at the kerb where it starts. Null when
 *  there's no loop near. */
function findZone(sim: Sim, x: number, y: number): Zone | null {
  const w = sim.world, rng = sim.rng;
  for (const tier of TIERS) {
    // the loops by how near, how long and how round they are; then the bays of the best few (the
    // walls and crossings along a loop take a while to look at)
    const loops = loopsNear(w, x, y, tier).map((links) => {
      const len = links.reduce((s, l) => s + l.edge.len, 0);
      let near = Infinity, area = 0;
      for (const l of links) {
        const p = linkPoints(l);
        for (let i = 0; i + 3 < p.length; i += 2) area += p[i] * p[i + 3] - p[i + 2] * p[i + 1];
        for (let i = 0; i < p.length; i += 2) near = Math.min(near, dist(p[i], p[i + 1], x, y));
      }
      // round a block (or a few) rather than up one side of a boulevard and back down the other
      const thin = Math.max(0, THIN - Math.abs(area / 2) / len);
      return { links, score: near + Math.abs(len - LOOP_BEST) * 0.5 + thin * 15 + rng.next() * 25 };
    });
    loops.sort((a, b) => a.score - b.score);
    let best: { links: Link[]; slots: Bay[]; score: number } | null = null;
    let viable = 0, looked = 0;
    for (const { links, score } of loops) {
      if (viable >= SHORTLIST || looked++ >= SHORTLIST * 2) break;
      const slots = baySlots(sim, links);
      if (slots.length < MIN_SLOTS) continue;
      viable++;
      const total = score - Math.min(slots.length, 14) * 3;
      if (!best || total < best.score) best = { links, slots, score: total };
    }
    if (!best) continue;
    // start the loop where the scan car can wait at the kerb, not right beside the player
    const n = best.links.length;
    for (let k = 0; k < n; k++) {
      const links = [...best.links.slice(k), ...best.links.slice(0, k)];
      const l0 = links[0];
      const r = along(linkPoints(l0, l0.edge.width / 2 - 1), 4);
      if (!clearOfWalls(w, 'hatch', r.x, r.y, r.a) || w.spawnLevel(r.x, r.y, 1, r.a) !== 0) continue;
      if (k < n - 1 && dist(r.x, r.y, x, y) < 25) continue;
      // (a stable sort: along each link they stay in the order they were found)
      const slots = best.slots.map((b) => ({ ...b, li: (b.li - k + n) % n })).sort((a, b) => a.li - b.li);
      return buildZone(sim, links, slots, r);
    }
  }
  return null;
}

/** the zone from its loop: the centre line to follow the scan car along, and the outline */
function buildZone(sim: Sim, links: Link[], slots: Bay[], rest: { x: number; y: number; a: number }): Zone {
  const pts: number[] = [];
  for (const l of links) {
    const p = linkPoints(l);
    pts.push(...(pts.length ? p.slice(2) : p));
  }
  const cum = [0];
  for (let i = 2; i < pts.length; i += 2) cum.push(cum[cum.length - 1] + dist(pts[i - 2], pts[i - 1], pts[i], pts[i + 1]));
  let cx = 0, cy = 0;
  const n = pts.length / 2;
  for (let i = 0; i < pts.length; i += 2) (cx += pts[i]), (cy += pts[i + 1]);
  // the outline for the map: at most ~40 points, rounded
  const every = Math.max(1, Math.ceil(n / 40));
  const poly: number[] = [];
  for (let i = 0; i < n; i += every) poly.push(Math.round(pts[i * 2]), Math.round(pts[i * 2 + 1]));
  return { links, pts, cum, len: cum[cum.length - 1], slots, from: sim.rng.next(), rest, cx: cx / n, cy: cy / n, poly };
}

/** `n` of the zone's places for bays, spread evenly round the loop */
function pickBays(z: Zone, n: number): Bay[] {
  n = Math.min(n, z.slots.length);
  const step = z.slots.length / n;
  const out: Bay[] = [];
  for (let i = 0; i < n; i++) out.push(z.slots[Math.min(z.slots.length - 1, Math.floor((z.from + i) * step))]);
  return out;
}

/** the car a player plays with: a car, not a scooter, a bike or a boat */
const isCar = (v: Vehicle | null | undefined): v is Vehicle => !!v && !v.spec.twoWheeler && !v.spec.boat;

class Parking extends MiniGame {
  private st = new Map<number, Player>();
  private bays: Bay[] = [];
  private rivals: Rival[] = [];
  private scan!: Vehicle;
  /** sweeps started so far (the current one while `sweeping`) */
  private sweep = 0;
  private sweeps = SWEEPS;
  private sweeping = false;
  /** the next sweep starts at this sim.time; the wait for it began at `waitFrom` */
  private nextAt = 0;
  private waitFrom = 0;
  private warned = false;
  /** the scan car's lap: when it set off, the segment of the loop it's on, whether it has come round
   *  past the start, how far round it has got (m), and when that last grew */
  private lapAt = 0;
  private seg = 0;
  private lapped = false;
  private prog = 0;
  private progAt = 0;
  private t0 = 0;
  private nextRival = 0;
  private group = false;

  constructor(
    sim: Sim,
    round: MiniRound,
    readonly zone: Zone,
  ) {
    super(sim, round);
    // the game ends itself after the last sweep (a round clock would only mislead: the scan car
    // keeps its own time), with MAX_S as the backstop
    this.duration = 0;
    round.x = zone.cx;
    round.y = zone.cy;
  }

  /** the players still in (not out on fines) */
  private inPlay(): SimPlayer[] {
    return this.players.filter((p) => this.st.get(p.id) && !this.st.get(p.id)!.out);
  }

  /** the bays each sweep has: alone five, one fewer each sweep; with others three more than the
   *  players at first, then two fewer each sweep, down to one */
  private baysFor(sweep: number, players = this.players.length): number {
    const k = Math.max(1, sweep) - 1;
    return this.group || players > 1 ? Math.max(1, players + 3 - 2 * k) : Math.max(2, 5 - k);
  }

  /** NPC drivers after the bays: alone one fewer than the bays (one's left for the player, if they're
   *  quick), with others only the bays the players can't fill */
  private rivalTarget(): number {
    const live = this.bays.filter((b) => !b.gone).length;
    return this.group ? Math.max(0, live - this.inPlay().length) : Math.max(1, live - 1);
  }

  start() {
    const sim = this.sim, z = this.zone;
    this.t0 = sim.time;
    this.group = this.round.started >= 2;
    this.bays = pickBays(z, this.baysFor(1));
    // (whatever car each one sits in now: they may have changed cars while the lobby waited)
    for (const p of this.players) this.enroll(p);
    // three sweeps when a lap takes long
    if (z.len / LAP_SPEED > LONG_LAP) this.sweeps = 3;
    const r = z.rest;
    const scan = new Vehicle('hatch', r.x, r.y, r.a, '#f5f5f5');
    scan.parked = true;
    scan.locked = true;
    this.scan = this.spawnVehicle(scan);
    // time to get there first: the farther the zone, the later the first sweep
    let far = 0;
    for (const p of this.players) {
      const f = p.focus();
      far = Math.max(far, Math.min(...this.bays.map((b) => dist(b.x, b.y, f.x, f.y))));
    }
    this.nextAt = sim.time + clamp(FIRST_SWEEP + far / FIRST_PER, FIRST_SWEEP, FIRST_MAX);
    this.waitFrom = sim.time;
    this.nextRival = sim.time;
    this.tell('Zóna PAAS! Zaparkuj v modrom boxe a zaplať v appke, kým príde skenovacie auto.', BLUE, 4);
  }

  /** a player in the round from the start: their car is the one they're in (or last drove) */
  private enroll(p: SimPlayer) {
    const car = isCar(p.ped.vehicle) ? p.ped.vehicle : isCar(p.lastCar) ? p.lastCar : null;
    this.st.set(p.id, { car, fines: 0, ok: 0, paid: null, checked: 0, out: false, flagged: null, tab: 0 });
  }

  onEnter(p: SimPlayer, v: Vehicle) {
    const s = this.st.get(p.id);
    if (!s || !isCar(v) || v.locked) return;
    if (s.car !== v) this.unflag(s);
    s.car = v;
  }

  onLeave(p: SimPlayer) {
    const s = this.st.get(p.id);
    if (s) this.unflag(s);
    this.st.delete(p.id);
  }

  // ---------------------------------------------------------------------------------- the step
  update(dt: number) {
    const sim = this.sim;
    if (sim.time - this.t0 > MAX_S) return this.end();
    this.occupy();
    for (const p of this.players) {
      const s = this.st.get(p.id);
      if (s && !s.out) this.keep(p, s);
    }
    this.stepRivals(dt);
    this.stepScan();
  }

  /** who stands in each bay now */
  private occupy() {
    for (const b of this.bays) {
      b.by = null;
      if (b.gone) continue;
      this.sim.forVehiclesNear(b.x, b.y, BAY_L, (v) => {
        if (!b.by && v !== this.scan && !v.wrecked && this.inside(v, b, 0.4)) b.by = v;
      });
    }
  }

  /** the centre of `v` inside bay `b` (give or take `slack` metres) */
  private inside(v: Vehicle, b: Bay, slack = 0.25): boolean {
    const dx = v.x - b.x, dy = v.y - b.y, c = Math.cos(b.a), s = Math.sin(b.a);
    return Math.abs(dx * c + dy * s) <= BAY_L / 2 + slack && Math.abs(-dx * s + dy * c) <= BAY_W / 2 + slack;
  }

  /** the bay `v` stands in (stopped, its centre inside), if any */
  private bayOf(v: Vehicle | null): Bay | null {
    if (!v || v.speed > STOPPED) return null;
    for (const b of this.bays) if (!b.gone && this.inside(v, b)) return b;
    return null;
  }

  /** the player's car, if it's still in the city and whole */
  private carOf(s: Player): Vehicle | null {
    const v = s.car;
    return v && !v.wrecked && this.sim.vehicleById(v.id) ? v : null;
  }

  /** A player's car standing in a bay is a parked car: traffic (the scan car too) drives round it,
   *  as it does round the city's own parked cars, instead of waiting behind it honking. A ticket goes
   *  with the bay it was bought in. */
  private keep(p: SimPlayer, s: Player) {
    const car = this.carOf(s);
    const bay = this.bayOf(car);
    if (bay && car) {
      if (s.flagged !== car) this.unflag(s);
      car.parked = true;
      s.flagged = car;
    } else this.unflag(s);
    if (s.paid && (!car || s.paid.bay.gone || !this.inside(car, s.paid.bay, 0.6))) {
      if (s.paid.sweep >= this.ticketFor(s) && !s.paid.bay.gone) this.msg(p, 'Odišiel si z boxu – lístok platil len tam.', WARN);
      s.paid = null;
    }
  }

  private unflag(s: Player) {
    const v = s.flagged;
    // (a car its player left standing is a parked car either way)
    if (v && v.owner) v.parked = false;
    s.flagged = null;
  }

  // -------------------------------------------------------------------------- the NPC drivers
  private stepRivals(dt: number) {
    const sim = this.sim;
    for (const r of [...this.rivals]) {
      r.t += dt;
      const v = r.v;
      if (v.wrecked || !sim.vehicleById(v.id)) {
        this.drop(r);
        continue;
      }
      if (r.state === 'circle') this.circle(r);
      else if (r.state === 'park') this.parkInto(r);
      else if (r.state === 'parked') {
        if (r.bay?.gone || sim.time >= r.until) this.leave(r);
      } else if (!sim.visibleToAny(v.x, v.y, 10) && (sim.time >= r.until || dist(v.x, v.y, this.zone.cx, this.zone.cy) > 180)) this.drop(r);
      else if (r.t > 90) this.drop(r);
    }
    // as many as the bays call for: the extra ones go (one circling first), the missing ones turn up
    // a few seconds apart
    const active = this.rivals.filter((r) => r.state !== 'leave');
    const target = this.rivalTarget();
    if (active.length > target) {
      const r = active.find((q) => q.state === 'circle') ?? active.find((q) => q.state === 'parked');
      if (r) this.leave(r);
    } else if (active.length < target && sim.time >= this.nextRival) {
      this.nextRival = sim.time + sim.rng.range(RIVAL_GAP[0], RIVAL_GAP[1]);
      this.spawnRival();
    }
  }

  /** A driver who comes looking for a spot, somewhere on the loop no player is looking: most turn up
   *  a little way before a bay that's free (they've seen it from the corner), the rest anywhere, to
   *  circle. At most two circle at a time: the Old Town's streets jam easily enough. */
  private spawnRival() {
    const sim = this.sim, z = this.zone, rng = sim.rng;
    if (this.rivals.filter((r) => r.state === 'circle').length >= 2) return;
    const spots: { li: number; s: number }[] = [];
    const free = this.bays.filter((b) => !b.gone && !b.by && !b.claim);
    while (free.length) {
      const b = free.splice(rng.int(free.length), 1)[0];
      spots.push({ li: b.li, s: Math.max(0, b.s - 22) });
    }
    const n = z.links.length, from = rng.int(n);
    for (let k = 0; k < n; k++) spots.push({ li: (from + k) % n, s: 0 });
    for (const { li, s } of spots) {
      const l = z.links[li];
      const q = along(linkPoints(l, laneOf(l)), s);
      if (sim.visibleToAny(q.x, q.y, 12) || sim.vehiclesNear(q.x, q.y, 9).some((o) => dist(o.x, o.y, q.x, q.y) < 7)) continue;
      const kind = rng.pick(RIVAL_KINDS);
      if (!clearOfWalls(sim.world, kind, q.x, q.y, q.a)) continue;
      const v = new Vehicle(kind, q.x, q.y, q.a, rng.pick(SPECS[kind].colors));
      v.locked = true;
      this.spawnVehicle(v);
      sim.ai.driveRoute(v, this.loopFrom(li, 3));
      this.rivals.push({ v, state: 'circle', bay: null, t: 0, until: 0 });
      return;
    }
  }

  /** the loop from link `li` on, `laps` times round */
  private loopFrom(li: number, laps: number): Link[] {
    const ls = this.zone.links, out: Link[] = [];
    for (let i = 0; i < ls.length * laps; i++) out.push(ls[(li + i) % ls.length]);
    return out;
  }

  /** round the loop, pulling into the first free bay just ahead; after a while, off home */
  private circle(r: Rival) {
    const v = r.v;
    if (r.t > CIRCLE_MAX) return this.leave(r);
    const fx = Math.cos(v.angle), fy = Math.sin(v.angle);
    for (const b of this.bays) {
      if (b.gone || b.by || b.claim) continue;
      const dx = b.x - v.x, dy = b.y - v.y;
      const ahead = dx * fx + dy * fy, side = -dx * fy + dy * fx;
      if (ahead < 5 || ahead > GRAB_R || Math.abs(side) > 4.5 || Math.abs(angleDiff(v.angle, b.a)) > 0.6) continue;
      // the traffic AI hands over for the last few metres
      this.sim.ai.drivers.delete(v);
      b.claim = r;
      r.bay = b;
      r.state = 'park';
      r.t = 0;
      return;
    }
  }

  /** the last few metres into the bay, steered by hand, then set straight in it */
  private parkInto(r: Rival) {
    const v = r.v, b = r.bay!;
    const dx = b.x - v.x, dy = b.y - v.y, d = Math.hypot(dx, dy);
    // someone else got in first (a player, most likely): back to circling
    if (b.gone || (b.by && b.by !== v)) {
      b.claim = null;
      r.bay = null;
      r.state = 'circle';
      this.sim.ai.driveRoute(v, this.loopFrom((b.li + 1) % this.zone.links.length, 3));
      return;
    }
    if (d < 0.9 || (r.t > 1.5 && d < 2.4 && v.speed < 1.2) || r.t > 6) {
      b.claim = null;
      if (d > 4) return this.leave(r);
      v.x = b.x;
      v.y = b.y;
      v.angle = b.a;
      v.vx = v.vy = v.av = 0;
      v.setControls(0, 0, true);
      v.parked = true;
      r.state = 'parked';
      r.t = 0;
      r.until = this.sim.time + this.sim.rng.range(STAY[0], STAY[1]);
      return;
    }
    const fx = Math.cos(v.angle), fy = Math.sin(v.angle);
    const ahead = dx * fx + dy * fy;
    const want = clamp(d * 0.8, 1.2, 5.5), sp = v.fwdSpeed;
    const throttle = ahead < 0 ? -0.6 : sp < want - 0.4 ? 0.55 : sp > want + 0.6 ? -0.7 : 0.05;
    v.setControls(throttle, clamp(angleDiff(v.angle, Math.atan2(dy, dx)) * 2.2, -1, 1), false);
  }

  /** off out of the zone (the traffic AI drives it away), and out of the city a little later */
  private leave(r: Rival) {
    const v = r.v, sim = this.sim;
    const bay = r.bay;
    if (bay?.claim === r) bay.claim = null;
    const was = r.state;
    r.state = 'leave';
    r.bay = null;
    r.t = 0;
    r.until = sim.time + 35;
    v.parked = false;
    if (bay && (was === 'parked' || was === 'park')) sim.ai.driveRoute(v, this.loopFrom(bay.li, 1).slice(0, 2));
    else {
      // circling: off the loop at the next junction (the traffic AI picks the way from there)
      const d = sim.ai.drivers.get(v);
      if (d) d.route = d.route.slice(0, 1);
    }
  }

  private drop(r: Rival) {
    if (r.bay?.claim === r) r.bay.claim = null;
    this.rivals.splice(this.rivals.indexOf(r), 1);
    this.despawn(r.v);
  }

  // ------------------------------------------------------------------------------ the scan car
  private stepScan() {
    const sim = this.sim, scan = this.scan;
    // wrecked or gone (someone had enough of it): the city sends another for the next sweep
    if (scan.wrecked || !sim.vehicleById(scan.id)) {
      if (this.sweeping) this.endSweep();
      if (this.over) return;
      this.despawn(scan);
      const r = this.zone.rest;
      const v = new Vehicle('hatch', r.x, r.y, r.a, '#f5f5f5');
      v.parked = true;
      v.locked = true;
      this.scan = this.spawnVehicle(v);
      this.tell('Skenovacie auto je na odpis – mesto posiela nové.', WARN);
      return;
    }
    if (!this.sweeping) {
      if (!this.warned && this.nextAt - sim.time <= 10) {
        this.warned = true;
        this.tell('O 10 sekúnd vyráža skenovacie auto!', WARN);
      }
      if (sim.time >= this.nextAt) this.startSweep();
      return;
    }
    this.track();
    // everyone it passes is checked, once a sweep
    for (const p of this.players) {
      const s = this.st.get(p.id);
      if (this.over) return;
      if (!s || s.out || s.checked === this.sweep) continue;
      const car = this.carOf(s);
      if (car && car.level === scan.level && dist(car.x, car.y, scan.x, scan.y) <= SCAN_R) this.check(p, s);
    }
    const now = sim.time;
    if (this.prog >= this.zone.len + 2 || now - this.lapAt > LAP_MAX || now - this.progAt > STUCK_S) this.endSweep();
  }

  private startSweep() {
    const sim = this.sim, scan = this.scan;
    this.sweep++;
    this.sweeping = true;
    this.warned = false;
    this.lapAt = this.progAt = sim.time;
    this.seg = 0;
    this.lapped = false;
    this.prog = 0;
    scan.parked = false;
    // two laps queued: the car is stopped at the end of the first
    sim.ai.driveRoute(scan, this.loopFrom(0, 2));
    this.tell(`🔍 Sken ${this.sweep}/${this.sweeps}: skenovacie auto vyráža!`, BLUE, 3);
  }

  /** How far round the loop the scan car has got: its nearest point on the loop's centre line, looked
   *  for a little ahead of where it was (the loop can pass the same corner twice). */
  private track() {
    const z = this.zone, P = z.pts, C = z.cum, scan = this.scan;
    const segs = P.length / 2 - 1;
    // (where it was along this lap: the segments that start more than a little way past that are
    // too far ahead to be where it is now)
    const pos = this.prog - (this.lapped ? z.len : 0);
    let best = -1, bd = 12 * 12, bt = 0;
    for (let n = 0, k = this.seg; n < 40; n++, k = (k + 1) % segs) {
      if (n > 0 && C[k] + (k < this.seg ? z.len : 0) - pos > 40) break;
      const ax = P[k * 2], ay = P[k * 2 + 1], bx = P[k * 2 + 2], by = P[k * 2 + 3];
      const ux = bx - ax, uy = by - ay, l2 = ux * ux + uy * uy;
      const t = l2 ? clamp(((scan.x - ax) * ux + (scan.y - ay) * uy) / l2, 0, 1) : 0;
      const d2 = (ax + ux * t - scan.x) ** 2 + (ay + uy * t - scan.y) ** 2;
      if (d2 < bd) (bd = d2), (best = k), (bt = t);
    }
    if (best < 0) return;
    // from the loop's last segments into its first again: round past the start
    if (best < this.seg) this.lapped = true;
    this.seg = best;
    const s = (this.lapped ? z.len : 0) + C[best] + (C[best + 1] - C[best]) * bt;
    if (s > this.prog + 0.5) {
      this.prog = s;
      this.progAt = this.sim.time;
    }
  }

  /** The lap is over (or gave up): whoever it didn't pass is checked where they are, the scan car
   *  waits, the city repaints a bay or two, and the next sweep is set, or the round is over. */
  private endSweep() {
    const sim = this.sim, scan = this.scan;
    this.sweeping = false;
    for (const p of this.players) {
      const s = this.st.get(p.id);
      if (s && !s.out && s.checked !== this.sweep && !this.over) this.check(p, s);
    }
    if (sim.vehicleById(scan.id)) {
      sim.ai.drivers.delete(scan);
      scan.setControls(0, 0, true);
      scan.parked = true;
      // lost on the way (pushed off its loop): back where it waits, while nobody's looking
      const r = this.zone.rest;
      if (this.prog < this.zone.len && !sim.visibleToAny(scan.x, scan.y, 10) && !sim.visibleToAny(r.x, r.y, 10)) {
        scan.x = r.x;
        scan.y = r.y;
        scan.angle = r.a;
        scan.vx = scan.vy = scan.av = 0;
      }
    }
    if (this.over) return;
    if (this.sweep >= this.sweeps) return this.end();
    this.repaint();
    this.waitFrom = sim.time;
    this.nextAt = Math.max(sim.time + SWEEP_GAP, this.lapAt + SWEEP_EVERY);
  }

  /** The scan car checks `p`'s car: standing in a bay with this sweep's ticket is fine, anything else
   *  is a fine (the second puts them out). */
  private check(p: SimPlayer, s: Player) {
    s.checked = this.sweep;
    const car = this.carOf(s);
    const bay = this.bayOf(car);
    const f = car ?? p.focus();
    if (bay && s.paid && s.paid.bay === bay && s.paid.sweep === this.sweep) {
      s.ok++;
      this.addPoints(p, PTS_SWEEP);
      this.pop(p, '✓ OK', f.x, f.y - 1.5);
      this.msg(p, 'Sken OK – lístok platí. ✓', OK);
      return;
    }
    s.fines++;
    this.pop(p, 'POKUTA!', f.x, f.y - 1.5);
    const why = !car ? 'Nemáš v zóne auto.' : bay ? 'Nezaplatené!' : this.inZone(car) ? 'Nestojíš v boxe.' : 'Tvoje auto nestojí v zóne.';
    if (s.fines >= FINES_OUT) {
      s.out = true;
      this.unflag(s);
      s.paid = null;
      this.outcome(p, { pay: this.payOf(s, false), text: `Dve pokuty – vypadol si. Skeny OK: ${s.ok}.` });
      this.msg(p, `POKUTA! ${why} Druhá – vypadol si z hry.`, BAD, 3.5);
      for (const q of this.players) if (q !== p) this.msg(q, `${p.nick} dostal druhú pokutu a vypadol!`, WARN);
      this.checkLast();
    } else this.msg(p, `POKUTA! ${why} (−€${FINE}; ďalšia ťa vyradí)`, BAD, 3.5);
  }

  /** near the loop: on (or just off) the scan car's streets */
  private inZone(v: Vehicle): boolean {
    const P = this.zone.pts;
    for (let i = 0; i + 3 < P.length; i += 2) {
      const ux = P[i + 2] - P[i], uy = P[i + 3] - P[i + 1], l2 = ux * ux + uy * uy;
      const t = l2 ? clamp(((v.x - P[i]) * ux + (v.y - P[i + 1]) * uy) / l2, 0, 1) : 0;
      if (dist(P[i] + ux * t, P[i + 1] + uy * t, v.x, v.y) < 20) return true;
    }
    return false;
  }

  /** Musical chairs: after each sweep the city repaints bays as "zákaz státia" down to the next
   *  sweep's count. Alone it's the player's own bay half the time (the hunt starts over); with others
   *  it's any of them, the taken ones more often. */
  private repaint() {
    const rng = this.sim.rng;
    const live = () => this.bays.filter((b) => !b.gone);
    let n = live().length - this.baysFor(this.sweep + 1);
    const hit: Bay[] = [];
    while (n-- > 0) {
      const all = live();
      if (all.length <= 1) break;
      let b: Bay | undefined;
      if (!this.group) {
        const mine = all.find((q) => q.by && this.players.some((p) => this.st.get(p.id)?.car === q.by));
        if (mine && rng.chance(0.5)) b = mine;
      } else if (rng.chance(0.6)) {
        const taken = all.filter((q) => q.by);
        if (taken.length) b = rng.pick(taken);
      }
      b ??= rng.pick(all);
      b.gone = true;
      hit.push(b);
    }
    if (!hit.length) return;
    for (const p of this.players) {
      const s = this.st.get(p.id);
      if (!s || s.out) continue;
      const car = this.carOf(s);
      if (car && hit.some((b) => this.inside(car, b, 0.6))) this.msg(p, 'Tvoj box premaľovali na zákaz státia! Preparkuj.', BAD, 3.5);
      else this.msg(p, `Mesto premaľovalo ${hit.length === 1 ? 'jeden box' : `${hit.length} boxy`} na zákaz státia.`, WARN);
      if (s.paid?.bay.gone) s.paid = null;
    }
    for (const r of [...this.rivals]) if (r.bay?.gone) this.leave(r);
  }

  /** with others, the last one still in wins there and then */
  private checkLast() {
    const left = this.inPlay();
    if (!left.length || (this.group && this.players.length >= 2 && left.length === 1)) this.end();
  }

  /** what a player's round pays: the sweeps got through, finishing (still in), minus the fines and
   *  any parking paid on credit */
  private payOf(s: Player, finished: boolean): number {
    return Math.max(0, s.ok * PAY_SWEEP + (finished ? PAY_FINISH : 0) - s.fines * FINE - s.tab);
  }

  /** It's over: everyone still in gets the finish, the group's winner a bonus. */
  private end() {
    if (this.over) return;
    const left = this.inPlay();
    for (const p of left) this.addPoints(p, PTS_FINISH);
    const ranked = this.ranked();
    for (const p of left) {
      const s = this.st.get(p.id)!;
      this.unflag(s);
      const won = this.group && ranked[0] === p;
      const text = this.group
        ? won
          ? `Posledný so zaparkovaným autom! Skeny OK: ${s.ok}.`
          : `Vydržal si do konca. Skeny OK: ${s.ok}, pokuty: ${s.fines}.`
        : s.fines
          ? `Prežil si ${s.ok} z ${this.sweep} skenov, pokuty: ${s.fines}.`
          : 'Všetky skeny bez pokuty! Parkovací majster.';
      this.outcome(p, { pay: this.payOf(s, true) + (won ? WIN_BONUS : 0), text });
    }
    this.finish();
  }

  // ------------------------------------------------------------------------------- the action
  /** the sweep a ticket bought now is for: this one while the scan car hasn't checked them yet,
   *  else the next */
  private ticketFor(s: Player): number {
    return this.sweeping && s.checked !== this.sweep ? this.sweep : this.sweep + 1;
  }

  /** the bay `p` could pay for now: they stand in it without a ticket for the next check */
  private canPay(s: Player): Bay | null {
    if (s.out) return null;
    const bay = this.bayOf(this.carOf(s));
    if (!bay || (s.paid && s.paid.bay === bay && s.paid.sweep >= this.ticketFor(s))) return null;
    return bay;
  }

  act(p: SimPlayer) {
    const s = this.st.get(p.id);
    if (!s || s.out) return;
    const bay = this.canPay(s);
    if (!bay) {
      if (!this.bayOf(this.carOf(s))) this.msg(p, 'Najprv zastav v modrom boxe.', WARN);
      return;
    }
    s.paid = { bay, sweep: this.ticketFor(s) };
    // (a player with empty pockets isn't locked out of the game: the app puts it on their tab)
    if (p.profile.money >= FEE) {
      this.sim.addMoney(p, -FEE);
      this.msg(p, `Zaplatené v appke (€${FEE}) – platí na jeden sken.`, OK);
    } else {
      s.tab += FEE;
      this.msg(p, `Zaplatené v appke na dlh – €${FEE} ti strhnú z výhry. Platí na jeden sken.`, OK);
    }
  }

  // --------------------------------------------------------------------------------- the view
  private zoneMarks(): MiniMark[] {
    const z = this.zone;
    return [
      { x: Math.round(z.cx), y: Math.round(z.cy), poly: z.poly, color: BLUE },
      { x: Math.round(z.cx), y: Math.round(z.cy), icon: '🅿️', label: 'Zóna PAAS', color: BLUE },
    ];
  }

  private bayMark(b: Bay): MiniMark {
    return { x: Math.round(b.x * 10) / 10, y: Math.round(b.y * 10) / 10, w: BAY_L, h: BAY_W, a: Math.round(b.a * 100) / 100, color: BLUE };
  }

  view(p: SimPlayer): MiniView {
    const s = this.st.get(p.id);
    if (!s) return { goal: 'Parkovací hon' };
    const sim = this.sim;
    const car = this.carOf(s);
    const bay = s.out ? null : this.bayOf(car);
    const ticket = !!bay && !!s.paid && s.paid.bay === bay && s.paid.sweep >= this.ticketFor(s);
    const marks = this.zoneMarks();
    const f = p.focus();
    let arrow = -1, ad = Infinity, free = 0;
    for (const b of this.bays) {
      const m = this.bayMark(b);
      if (b.gone) Object.assign(m, { color: BAD, icon: '🚫', label: 'zákaz státia', dim: 1, noMap: 1 });
      else if (b === bay) Object.assign(m, ticket ? { color: OK, label: 'zaplatené' } : { color: WARN, label: 'zaplať (B)' });
      else if (b.by || b.claim) m.dim = 1;
      else {
        free++;
        const d = dist(b.x, b.y, f.x, f.y);
        if (d < ad) (ad = d), (arrow = marks.length);
      }
      marks.push(m);
    }
    if (arrow >= 0 && !bay && !s.out) marks[arrow].arrow = 1;
    const scan = this.scan;
    marks.push({ x: Math.round(scan.x), y: Math.round(scan.y), e: scan.id, icon: '🔍', label: this.sweeping ? 'SKEN' : 'PAAS', color: '#e3f2fd', r: this.sweeping ? SCAN_R : undefined });
    const goal = s.out
      ? 'Dve pokuty – si mimo hry. Počkaj na koniec.'
      : !car
        ? 'Nemáš auto! Nastúp do nejakého a zaparkuj v zóne.'
        : bay
          ? ticket
            ? this.sweeping
              ? 'Skenovacie auto ide – stoj a nehýb sa!'
              : 'Zaplatené ✓ Čakaj na skenovacie auto.'
            : 'Stojíš v boxe – zaplať v appke (B)!'
          : free
            ? 'Nájdi voľný modrý box v zóne a zaparkuj v ňom.'
            : 'Všetky boxy sú plné – krúž, kým niekto neodíde.';
    const left = Math.max(0, Math.ceil(this.nextAt - sim.time));
    const bar = this.sweeping
      ? { label: `Sken ${this.sweep}/${this.sweeps} prebieha`, v: clamp(this.prog / this.zone.len, 0, 1), color: BAD }
      : { label: `Sken ${this.sweep + 1}/${this.sweeps} o ${left} s`, v: clamp((sim.time - this.waitFrom) / Math.max(1, this.nextAt - this.waitFrom), 0, 1), color: left <= 10 ? BAD : BLUE };
    return {
      goal,
      bar,
      stats: [['Pokuty', `${s.fines}/${FINES_OUT}`], ['Skeny OK', `${s.ok}`], ['Voľné boxy', `${free}`]],
      marks,
      act: this.canPay(s) ? `Zaplatiť v appke (€${FEE})` : undefined,
    };
  }

  lobbyView(): MiniView {
    const marks = this.zoneMarks();
    for (const b of pickBays(this.zone, this.baysFor(1, this.players.length))) marks.push(this.bayMark(b));
    return { goal: 'Zóna PAAS je vyznačená. O chvíľu sa začne hon na parkovacie miesta!', marks };
  }

  dispose() {
    for (const s of this.st.values()) this.unflag(s);
    super.dispose();
  }
}

export const PARKING_DEF: MiniGameDef = {
  kind: 'parking',
  lobby: 20,
  check(_sim, p) {
    return isCar(p.ped.vehicle) ? null : 'Na toto potrebuješ auto – nie kolobežku, bicykel ani loď.';
  },
  create(sim, round) {
    const f = round.owner.focus();
    const zone = findZone(sim, f.x, f.y);
    if (!zone) return 'Tu nikde nie je parkovacia zóna – skús to v meste, medzi domami.';
    return new Parking(sim, round, zone);
  },
};
