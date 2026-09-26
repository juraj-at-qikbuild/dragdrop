// NPC behaviour: spawning/despawning traffic, parked cars, pedestrians and trams around every player,
// traffic driving on the road graph, pedestrians walking the footpaths, police pursuit (A*) of wanted
// players, and cops on foot.
import { Vehicle, SPECS, type VehicleKind } from '../entities/Vehicle';
import { Ped } from '../entities/Ped';
import { Tram } from '../entities/Tram';
import { Graph, linkPoints, type Link } from '../world/Graph';
import { angleDiff, bboxOf, clamp, dist, pointInRings } from '../util/math';
import { MARK_BUS_STOP, MARK_GIVE_WAY, MARK_STOP, type Mark, type StopLine } from '../world/TrafficLights';
import { OFF_MAP } from '../world/World';
import { SECONDS_PER_HOUR } from './Clock';
import { CountGrid, playerScale, targetDensity } from './density';
import type { Sim } from './Sim';
import type { SimPlayer } from './SimPlayer';

export interface Driver {
  mode: 'traffic' | 'police' | 'parked' | 'idle';
  link: Link | null;
  pts: number[];
  idx: number;
  route: Link[];
  repath: number;
  stuck: number;
  reverse: number;
  direct: boolean;
  /** pursuit progress tracking */
  best: number;
  noProgress: number;
  /** police search pattern: a random point inside the target's search zone this cop is driving to */
  searchTarget: { x: number; y: number } | null;
  searchTimer: number;
  /** police: the player being chased (0 = none), re-evaluated every couple of seconds */
  target: number;
  retarget: number;
  /** traffic lights ahead on the links queued in `pts`, in order */
  stops: StopLine[];
  /** stop and give-way signs, speed bumps and (buses) bus stops ahead, in order */
  marks: Mark[];
  /** the sign or bus stop it's standing at, and for how long */
  waitAt: Mark | null;
  waited: number;
  /** which of a multi-lane street's lanes it keeps to (0 = the kerb lane) */
  lane: number;
  /** how far it has pulled out of its lane (m, + to the right) to get round a car that isn't going
   *  anywhere, and how far it's heading for */
  nudge: number;
  nudgeTo: number;
  /** the car it's pulling out round, or waiting behind until the way past is clear, and for how long */
  passing: Vehicle | null;
  waitFor: Vehicle | null;
  waitedFor: number;
  /** time to the next look at the way past */
  passCheck: number;
  /** the car in its way last update, and for how long it has been */
  blocker: Vehicle | null;
  blockedT: number;
  /** a head-on standoff (two cars each waiting for the other): the car it's giving way to (backing
   *  up and tucking in), or squeezing past, for `standoff` seconds more */
  yieldTo: Vehicle | null;
  squeeze: Vehicle | null;
  standoff: number;
  /** how long someone on foot has stood in its way */
  pedWait: number;
  /** times it has had to back up since it last got anywhere, and where that was */
  wedged: number;
  px: number;
  py: number;
}

const TRAFFIC_MIX: [VehicleKind, number][] = [
  ['hatch', 30], ['sedan', 30], ['taxi', 8], ['van', 8], ['bus', 6], ['sport', 4], ['classic', 3],
];
const PARKED_MIX: [VehicleKind, number][] = [['hatch', 35], ['sedan', 35], ['van', 8], ['sport', 6], ['classic', 6], ['taxi', 5]];

/** how far right of the centre line traffic drives on this link (fitted to the street by World) */
const laneOffset = (l: Link) => (l.fwd ? l.edge.laneF : l.edge.laneR) ?? (l.edge.oneway ? 0 : Math.min(l.edge.width / 4, 1.9));
/** marked lanes in the direction of a link (1 when the map doesn't say) */
const lanesOf = (l: Link) => (l.fwd ? l.edge.lanesF : l.edge.lanesR) ?? 1;
/** Lane `lane` (0 = by the kerb) of a link: on a street with several marked lanes each way, their
 *  centres across the carriageway (the directions share it lane by lane); else the fitted lane. */
function laneFor(l: Link, lane: number) {
  const n = lanesOf(l);
  if (n < 2) return laneOffset(l);
  const total = (l.edge.lanesF ?? 0) + (l.edge.lanesR ?? 0), lw = l.edge.width / Math.max(1, total);
  return l.edge.width / 2 - (Math.min(lane, n - 1) + 0.5) * lw;
}
/** how fast traffic takes a speed bump, a raised table, cushions, a rumble strip (m/s) */
const BUMP_SPEED = [4.5, 7, 8.5, 30];
/** how long a bus stands at a stop (s) */
const BUS_DWELL = 5;
/** a link traffic may take: its lane doesn't run into a building, and it doesn't lead off the map */
const drivable = (l: Link) => !(l.fwd ? l.edge.blockedF : l.edge.blockedR);
const EMPTY_PEDS: Ped[] = [];
/** scratch points for `AI.along` */
const AHEAD = { x: 0, y: 0, a: 0, got: 0 };
const PASS = { x: 0, y: 0, a: 0, got: 0 };
/** gap (m) traffic leaves behind a parked car it's waiting to get round */
const PASS_GAP = 3.5;
/** distances ahead (m) at which traffic checks how far its lane has turned, to slow for bends */
const CURVE_SAMPLES = [4, 8, 13, 20, 28, 38, 50];
const COPS_WANTED = [0, 2, 3, 5, 7, 9];

// count-grid categories
const C_TRAFFIC = 0, C_PARKED = 1, C_PEDS = 2, C_TRAMS = 3;

export class AI {
  drivers = new Map<Vehicle, Driver>();
  policeGraph: Graph;
  private spawnTimer = 0;
  private retire = new Set<Vehicle>();
  /** the nearest car `obstacleAhead` last found in the way, or the person (not a player) */
  private lastBlocker: Vehicle | null = null;
  private lastPed: Ped | null = null;
  /** while prewarming around this player, their own screen doesn't block spawns */
  private warmFor: SimPlayer | null = null;
  /** walking groups: follower -> leader + fixed offset (WeakMap so despawned peds can be GC'd) */
  private followers = new WeakMap<Ped, { leader: Ped; ox: number; oy: number }>();
  /** pedestrian/landmark spawn hotspots, built lazily */
  private hotspots: { x: number; y: number }[] | null = null;
  /** AI LOD: per-update counter + stable per-entity ids + accumulated skipped dt */
  private frameCount = 0;
  private lodIds = new WeakMap<object, number>();
  private lodNextId = 1;
  private lodAcc = new WeakMap<object, number>();
  /** distance to the nearest camera, refreshed every few updates per entity */
  private camDist = new WeakMap<object, number>();
  /** cops (on foot) whose target is armed-level wanted, cached once per update for cheap panic checks */
  private armedCops: Ped[] = [];
  private counts = new CountGrid(4);
  /** current per-player target density (for /stats and tests) */
  lastTargets = { traffic: 0, parked: 0, peds: 0, trams: 0 };

  constructor(private sim: Sim) {
    // Police chase over every street and footway (cars fit through the Old Town), preferring real
    // roads, but never through a row of bollards or blocks.
    this.policeGraph = new Graph(sim.world.data.graph.ped, false, (e) =>
      e.noCars ? Infinity : e.len * (e.cls <= 5 ? 1 : e.cls <= 7 ? 1.3 : e.cls === 8 ? 1.8 : 3),
    );
  }

  /** Entities far from every camera think less often; returns the dt to simulate with, or
   *  null to skip this update entirely (the skipped time is folded into the next one). */
  private lodDt(o: object, x: number, y: number, dt: number): number | null {
    let id = this.lodIds.get(o);
    if (id === undefined) (id = this.lodNextId++), this.lodIds.set(o, id);
    const d = this.distToCamera(o, id, x, y);
    if (d < 150) return dt;
    const period = d < 280 ? 2 : 3;
    const acc = (this.lodAcc.get(o) ?? 0) + dt;
    if ((this.frameCount + id) % period !== 0) {
      this.lodAcc.set(o, acc);
      return null;
    }
    this.lodAcc.set(o, 0);
    return acc;
  }

  /** nearest camera distance, cached per entity and refreshed on a staggered 5-update cycle */
  private distToCamera(o: object, id: number, x: number, y: number) {
    let d = this.camDist.get(o);
    if (d === undefined || (this.frameCount + id) % 5 === 0) {
      d = this.sim.nearestCamera(x, y);
      this.camDist.set(o, d);
    }
    return d;
  }

  // ------------------------------------------------------------ spawning
  update(dt: number) {
    const sim = this.sim;
    this.frameCount++;
    this.spawnTimer -= dt;
    if (this.spawnTimer <= 0) {
      this.spawnTimer = 0.25;
      this.populate();
    }
    // cops on foot whose suspect is dangerous enough to draw on (3+ stars, or shot at the police)
    this.armedCops = EMPTY_PEDS;
    const armed = [...sim.players.values()].filter((p) => p.wanted >= 3 || p.shotCops);
    if (armed.length) this.armedCops = sim.peds.filter((c) => c.kind === 'cop' && !c.dead && !c.vehicle && armed.includes(this.copTarget(c)!));
    const danger = sim.anyWanted && sim.police.dangerEvents.length > 0;
    for (const [v, d] of this.drivers) {
      if (v.wrecked || v.sinking || v.isPlayer || !v.driver || v.driver.dead) {
        if (d.mode !== 'parked') v.setControls(0, 0, true);
        continue;
      }
      if (d.mode === 'traffic') {
        if (danger && this.checkPanic(v, d, dt)) continue;
        const eff = this.lodDt(v, v.x, v.y, dt);
        // traffic nobody is watching closely gets coarser physics (server only: offline there's one camera)
        v.coarse = this.sim.coarsePhysics && (this.camDist.get(v) ?? 0) > 120;
        if (eff !== null) this.drive(v, d, eff, false);
        // wedged (after a crash, in a corner too tight for it) and backing up over and over without
        // getting anywhere: towed away once nobody's looking
        if (dist(v.x, v.y, d.px, d.py) > 8) (d.px = v.x), (d.py = v.y), (d.wedged = 0);
        else if (d.wedged >= 3 && !this.onScreen(v.x, v.y, 10)) this.retire.add(v);
      } else if (d.mode === 'police') this.drivePolice(v, d, dt);
    }
    for (const p of sim.peds) {
      if (p.kinematic || p.playerId) continue;
      if (p.vehicle || p.dead || p.state === 'chase' || p.state === 'flee' || p.state === 'fight') {
        this.updatePed(p, dt);
        continue;
      }
      const eff = this.lodDt(p, p.x, p.y, dt);
      if (eff !== null) this.updatePed(p, eff);
    }
    for (const t of sim.trams) this.updateTram(t, dt);
  }

  private populate() {
    const sim = this.sim;
    const obs = sim.observers();
    if (!obs.length) return;
    const ranges = obs.map((p) => {
      const o = p.observer;
      const vr = Math.hypot(o.hw, o.hh);
      return { p, x: o.fx, y: o.fy, vr, far: Math.max(260, vr + 90) };
    });
    const near = (x: number, y: number, f: (r: (typeof ranges)[number], d: number) => boolean) => {
      for (const r of ranges) if (f(r, dist(x, y, r.x, r.y))) return true;
      return false;
    };

    // despawn what no player is near any more
    const gone = new Set<Ped>();
    sim.vehicles = sim.vehicles.filter((v) => {
      if (v.isPlayer || v.mission || v.kinematic) return true;
      if (this.retire.has(v)) {
        this.retire.delete(v);
        if (v.driver && !v.driver.playerId) gone.add(v.driver);
        this.drivers.delete(v);
        return false;
      }
      // traffic that reaches the edge of the map drives on out of the city (when nobody sees it go)
      const B = sim.world.bounds;
      const leaving = this.drivers.get(v)?.mode === 'traffic' && (v.x < B.x0 + 14 || v.x > B.x1 - 14 || v.y < B.y0 + 14 || v.y > B.y1 - 14) && !sim.visibleToAny(v.x, v.y, 8);
      const keep = !leaving && near(v.x, v.y, (r, d) => d < r.far + 60 || (d < r.far + 200 && sim.visibleToAny(v.x, v.y, 20)));
      if (!keep) {
        if (v.driver && !v.driver.playerId) gone.add(v.driver);
        this.drivers.delete(v);
      }
      return keep;
    });
    sim.peds = sim.peds.filter((p) => !gone.has(p) && (p.playerId !== 0 || p.kinematic || !!p.vehicle || near(p.x, p.y, (_r, d) => d < 200 || (p.dead && d < 260))));
    sim.trams = sim.trams.filter((t) => near(t.x, t.y, (r, d) => d < r.far + 150));

    // how many of each kind are around each player
    let traffic = 0, parked = 0, peds = 0, police = 0;
    const g = this.counts;
    g.clear();
    for (const v of sim.vehicles) {
      const d = this.drivers.get(v);
      if (d?.mode === 'traffic') traffic++, g.add(v.x, v.y, C_TRAFFIC);
      else if (v.parked) parked++, g.add(v.x, v.y, C_PARKED);
      if (d?.mode === 'police' && v.driver && !v.driver.dead && !v.wrecked) police++;
    }
    for (const p of sim.peds) if (p.kind === 'civ' && !p.vehicle && !p.dead) peds++, g.add(p.x, p.y, C_PEDS);
    for (const t of sim.trams) g.add(t.x, t.y, C_TRAMS);
    // the load governor shrinks the world-wide caps too, and anything over them that nobody can see is
    // thinned out a few at a time, so an overloaded server actually gets lighter
    const k = sim.governor;
    const caps = k < 1 ? { ...sim.caps, traffic: sim.caps.traffic * k, parked: sim.caps.parked * k, peds: sim.caps.peds * k } : sim.caps;
    if (k < 1) this.thin(traffic - caps.traffic, parked - caps.parked, peds - caps.peds);
    const target = targetDensity(sim.density, sim.quality, sim.clock.time, playerScale(obs.length) * k);
    this.lastTargets = target;
    const solo = ranges.length === 1;
    // the neediest players spawn first, so a crowded server fills the empty streets before the busy ones
    const order = ranges
      .map((r) => ({ r, need: solo ? 0 : g.within(r.x, r.y, r.far, C_PEDS) / Math.max(1, target.peds) }))
      .sort((a, b) => a.need - b.need);
    for (const { r } of order) {
      const count = (cat: number, global: number) => (solo ? global : g.within(r.x, r.y, r.far, cat));
      if (traffic < caps.traffic && count(C_TRAFFIC, traffic) < target.traffic && this.spawnTraffic(r.x, r.y, r.vr + 25, r.far)) traffic++;
      if (parked < caps.parked && count(C_PARKED, parked) < target.parked && this.spawnParked(r.x, r.y, r.vr + 10, r.far - 40)) parked++;
      if (peds < caps.peds && count(C_PEDS, peds) < target.peds) peds += this.spawnPed(r.x, r.y, r.vr + 5, 170);
      if (sim.trams.length < caps.trams && count(C_TRAMS, sim.trams.length) < target.trams) this.spawnTram(r.x, r.y, r.vr + 40, r.far + 100);
    }
    for (const p of sim.players.values()) if (p.stars > 0 && police < caps.police) police += this.policeSpawn(p);
  }

  /** retire up to a few off-screen NPCs of each kind that is over its cap */
  private thin(traffic: number, parked: number, peds: number) {
    const sim = this.sim;
    const n = (x: number) => Math.min(6, Math.ceil(x));
    let t = n(traffic), p = n(parked), q = n(peds);
    if (t > 0 || p > 0)
      for (const v of sim.vehicles) {
        if (t <= 0 && p <= 0) break;
        if (v.isPlayer || v.mission || v.kinematic || sim.visibleToAny(v.x, v.y, 15)) continue;
        const d = this.drivers.get(v);
        if (t > 0 && d?.mode === 'traffic') (this.retire.add(v), t--);
        else if (p > 0 && v.parked && !v.driver) (this.retire.add(v), p--);
      }
    if (q > 0) {
      const gone = new Set<Ped>();
      for (const ped of sim.peds) {
        if (q <= 0) break;
        if (ped.kind !== 'civ' || ped.vehicle || ped.playerId || sim.visibleToAny(ped.x, ped.y, 5)) continue;
        gone.add(ped);
        q--;
      }
      if (gone.size) sim.peds = sim.peds.filter((x) => !gone.has(x));
    }
  }

  private freeSpot(x: number, y: number, r: number) {
    let free = true;
    this.sim.forVehiclesNear(x, y, r + 8, (v) => {
      if (free && dist(v.x, v.y, x, y) < r + v.radius) free = false;
    });
    if (!free) return false;
    for (const t of this.sim.trams) if (t.hits(x, y, r)) return false;
    return true;
  }

  spawnOnLink(kind: VehicleKind, link: Link, mode: Driver['mode'], target = 0) {
    const sim = this.sim;
    // on a multi-lane street, most keep to the kerb lane, the rest overtake (buses keep right)
    const lane = kind === 'bus' || kind === 'van' ? 0 : sim.rng.chance(0.45) ? 1 + sim.rng.int(2) : 0;
    const pts = linkPoints(link, mode === 'police' ? 0 : laneFor(link, lane));
    const x = pts[0], y = pts[1];
    if (!this.freeSpot(x, y, 4)) return null;
    const v = new Vehicle(kind, x, y, Math.atan2(pts[3] - pts[1], pts[2] - pts[0]), sim.rng.pick(SPECS[kind].colors));
    const driver = new Ped(mode === 'police' ? 'cop' : 'civ', x, y, sim.rng.seed());
    driver.vehicle = v;
    driver.targetPid = target;
    v.driver = driver;
    sim.addVehicle(v);
    sim.addPed(driver);
    const d: Driver = {
      mode, link, pts, idx: 1, route: [], repath: 0, stuck: 0, reverse: 0, direct: false, best: Infinity, noProgress: 0,
      searchTarget: null, searchTimer: 0, target, retarget: 2, stops: mode === 'traffic' ? [...sim.world.lights.forLink(link)] : [],
      marks: mode === 'traffic' ? this.marksFor(link, kind) : [], waitAt: null, waited: 0, lane,
      nudge: 0, nudgeTo: 0, passing: null, waitFor: null, waitedFor: 0, passCheck: 0,
      blocker: null, blockedT: 0, yieldTo: null, squeeze: null, standoff: 0, pedWait: 0,
      wedged: 0, px: x, py: y,
    };
    this.drivers.set(v, d);
    const sp = Math.min(link.edge.speed * 0.6, 9);
    v.vx = Math.cos(v.angle) * sp;
    v.vy = Math.sin(v.angle) * sp;
    return v;
  }

  private spawnTraffic(x: number, y: number, rMin: number, rMax: number) {
    const sim = this.sim;
    const w = sim.world;
    const nodes = w.car.nodesAround(x, y, rMin, rMax);
    if (!nodes.length) return false;
    const n = sim.rng.pick(nodes);
    // traffic appears on the through network (a car or two still comes out of the side streets)
    const depth = w.car.depth;
    if (depth && (depth[n] >= OFF_MAP || (depth[n] > 0 && sim.rng.chance(0.8)))) return false;
    if (this.onScreen(w.car.nx(n), w.car.ny(n), 8)) return false;
    const links = w.car.out[n].filter((l) => drivable(l) && (!depth || depth[l.to] < OFF_MAP));
    if (!links.length) return false;
    const link = sim.rng.pick(links);
    let kind = sim.rng.weighted(TRAFFIC_MIX);
    if (kind === 'bus' && link.edge.cls > 4) kind = 'sedan';
    // not with its nose in a wall (a lane that starts in a tight corner)
    const pts = linkPoints(link, laneFor(link, 0));
    if (!this.clearOfWalls(kind, pts[0], pts[1], Math.atan2(pts[3] - pts[1], pts[2] - pts[0]))) return false;
    return !!this.spawnOnLink(kind, link, 'traffic');
  }

  private onScreen(x: number, y: number, pad: number) {
    return this.sim.visibleToAny(x, y, pad, this.warmFor);
  }

  /** Fill a player's surroundings immediately (game start / respawn), their own screen included. */
  prewarm(p: SimPlayer) {
    const sim = this.sim;
    const { x, y } = p.focus();
    this.warmFor = p;
    const n = sim.observers().length || 1;
    const density = targetDensity(sim.density, sim.quality, sim.clock.time, playerScale(n) * sim.governor);
    const within = (list: readonly { x: number; y: number }[], r: number) => list.reduce((c, e) => c + (dist(e.x, e.y, x, y) < r ? 1 : 0), 0);
    // spawn until the neighbourhood is full, or the whole world hits its cap
    const count = (local: () => number, max: number, global: () => number, cap: number, spawn: () => void) => {
      for (let i = 0; i < max + 40 && local() < max && global() < cap; i++) spawn();
    };
    const civList = () => sim.peds.filter((q) => q.kind === 'civ' && !q.vehicle && !q.dead);
    const parkedList = () => sim.vehicles.filter((v) => v.parked);
    const trafficList = () => sim.vehicles.filter((v) => this.drivers.get(v)?.mode === 'traffic');
    count(() => within(civList(), 200), density.peds, () => civList().length, sim.caps.peds, () => void this.spawnPed(x, y, 4, 150));
    count(() => within(parkedList(), 260), density.parked, () => parkedList().length, sim.caps.parked, () => void this.spawnParked(x, y, 8, 200));
    count(() => within(trafficList(), 260), density.traffic, () => trafficList().length, sim.caps.traffic, () => void this.spawnTraffic(x, y, 20, 240));
    this.warmFor = null;
  }

  /** the map's parking lots and on-street bays, in each one's own frame (u along its longest
   *  edge, v across), built lazily */
  private lots: { rings: number[][]; cx: number; cy: number; ux: number; uy: number; u0: number; u1: number; v0: number; v1: number }[] | null = null;
  private getLots() {
    if (this.lots) return this.lots;
    const out: NonNullable<AI['lots']> = [];
    for (const rings of this.sim.world.data.areas.parking) {
      const r = rings[0];
      let best = 0, ux = 1, uy = 0;
      for (let i = 0; i < r.length - 2; i += 2) {
        const dx = r[i + 2] - r[i], dy = r[i + 3] - r[i + 1], L = Math.hypot(dx, dy);
        if (L > best) (best = L), (ux = dx / L), (uy = dy / L);
      }
      let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
      for (let i = 0; i < r.length; i += 2) {
        const u = r[i] * ux + r[i + 1] * uy, v = -r[i] * uy + r[i + 1] * ux;
        (u0 = Math.min(u0, u)), (u1 = Math.max(u1, u)), (v0 = Math.min(v0, v)), (v1 = Math.max(v1, v));
      }
      if (u1 - u0 < 5 || v1 - v0 < 2.2) continue;
      const bb = bboxOf(r);
      out.push({ rings, cx: (bb.x0 + bb.x1) / 2, cy: (bb.y0 + bb.y1) / 2, ux, uy, u0, u1, v0, v1 });
    }
    return (this.lots = out);
  }

  /** A parked car in a real parking lot or bay near (x, y): nose-in rows on lots, bumper to
   *  bumper along narrow street-side bays. False if there's no free space this time. */
  private parkInLot(x: number, y: number, rMin: number, rMax: number): boolean {
    const sim = this.sim;
    const w = sim.world;
    const near = this.getLots().filter((l) => {
      const d = dist(l.cx, l.cy, x, y);
      return d > rMin && d < rMax;
    });
    if (!near.length) return false;
    const lot = sim.rng.pick(near);
    const kind = sim.rng.weighted(PARKED_MIX);
    const across = lot.v1 - lot.v0;
    const perpendicular = across >= 4.8;
    let u: number, v: number;
    if (perpendicular) {
      // rows along the lot's edges (and every ~8 m inside big lots), a bay every 2.6 m
      const rows = Math.max(1, Math.floor((across - 5.2) / 8.2) + 1);
      v = lot.v0 + 2.6 + sim.rng.int(rows) * 8.2;
      if (across >= 10 && sim.rng.chance(0.5)) v = lot.v1 - 2.6;
      u = lot.u0 + 1.4 + sim.rng.int(Math.max(1, Math.floor((lot.u1 - lot.u0 - 2.8) / 2.6) + 1)) * 2.6;
    } else {
      v = (lot.v0 + lot.v1) / 2;
      u = lot.u0 + 3.2 + sim.rng.int(Math.max(1, Math.floor((lot.u1 - lot.u0 - 6.4) / 6) + 1)) * 6;
    }
    const px = u * lot.ux - v * lot.uy, py = u * lot.uy + v * lot.ux;
    const angle = (perpendicular ? Math.atan2(lot.ux, -lot.uy) : Math.atan2(lot.uy, lot.ux)) + (sim.rng.chance(0.5) ? Math.PI : 0);
    // the whole car must fit in the bay
    const spec = SPECS[kind], fx = Math.cos(angle), fy = Math.sin(angle);
    for (const [a, b] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      const cx = px + fx * (spec.length / 2) * a - fy * (spec.width / 2) * b, cy = py + fy * (spec.length / 2) * a + fx * (spec.width / 2) * b;
      if (!pointInRings(cx, cy, lot.rings)) return false;
    }
    if (this.onScreen(px, py, 5) || !this.freeSpot(px, py, 3) || w.insideBuilding(px, py) || w.inWater(px, py) || !this.clearOfWalls(kind, px, py, angle)) return false;
    const car = new Vehicle(kind, px, py, angle, sim.rng.pick(spec.colors));
    car.parked = true;
    sim.addVehicle(car);
    return true;
  }

  private spawnParked(x: number, y: number, rMin: number, rMax: number) {
    const sim = this.sim;
    if (sim.rng.chance(0.6) && this.parkInLot(x, y, rMin, rMax)) return true;
    const w = sim.world;
    const nodes = w.car.nodesAround(x, y, rMin, rMax);
    if (!nodes.length) return false;
    const n = sim.rng.pick(nodes);
    // at the kerb of a residential street (not in a lane of a multi-lane one), and on a narrow
    // two-way street only along one side of it (the right-hand side of one direction, picked per
    // street), so there's still room to get past
    const cands = w.car.out[n].filter((l) => l.edge.cls >= 4 && l.edge.len > 20 && (l.edge.lanesF ?? 1) + (l.edge.lanesR ?? 1) <= 2);
    for (let tries = 0; tries < 3 && cands.length; tries++) {
      const link = cands.splice(sim.rng.int(cands.length), 1)[0];
      const e = link.edge;
      // on this link's right, facing its way, or on its left facing back (the other direction's side)
      const along = !!e.oneway || e.width >= 9 || link.fwd === (e.id % 2 === 0);
      const pts = linkPoints(link, (along ? 1 : -1) * (e.width / 2 - 1));
      if (pts.length < 4) continue;
      const t = sim.rng.range(0.2, 0.8);
      const x0 = pts[0] + (pts[2] - pts[0]) * t, y0 = pts[1] + (pts[3] - pts[1]) * t;
      if (this.onScreen(x0, y0, 5) || !this.freeSpot(x0, y0, 5) || w.insideBuilding(x0, y0)) continue;
      const kind = sim.rng.weighted(PARKED_MIX);
      const angle = Math.atan2(pts[3] - pts[1], pts[2] - pts[0]) + (along ? 0 : Math.PI);
      if (!this.clearOfWalls(kind, x0, y0, angle)) continue;
      const v = new Vehicle(kind, x0, y0, angle, sim.rng.pick(SPECS[kind].colors));
      v.parked = true;
      sim.addVehicle(v);
      return true;
    }
    return false;
  }

  /** Would a car of this kind standing at (x, y) facing `angle` be clear of every wall, fence,
   *  trunk and post? (Kerbside spots on narrow streets and lots drawn over a wall aren't.) */
  private clearOfWalls(kind: VehicleKind, x: number, y: number, angle: number) {
    const s = SPECS[kind], r = s.width / 2, n = Math.max(2, Math.ceil(s.length / s.width));
    const fx = Math.cos(angle), fy = Math.sin(angle);
    for (let i = 0; i < n; i++) {
      const o = -s.length / 2 + r + ((s.length - 2 * r) * i) / (n - 1);
      if (this.sim.world.collideCircle(x + fx * o, y + fy * o, r, 0)) return false;
    }
    return true;
  }

  /** landmarks, shops and Old-Town squares: pedestrians spawn biased towards these. */
  private getHotspots() {
    if (this.hotspots) return this.hotspots;
    const w = this.sim.world;
    const pts: { x: number; y: number }[] = [];
    for (const l of w.landmarks.values()) pts.push({ x: l.x, y: l.y });
    for (const p of w.pois('shop')) pts.push({ x: p.x, y: p.y });
    for (const rings of w.data.areas.plaza) {
      const bb = bboxOf(rings[0]);
      pts.push({ x: (bb.x0 + bb.x1) / 2, y: (bb.y0 + bb.y1) / 2 });
    }
    return (this.hotspots = pts);
  }

  /** spawns a pedestrian (sometimes a small group); returns how many */
  spawnPed(x: number, y: number, rMin: number, rMax: number): number {
    const sim = this.sim;
    const rng = sim.rng;
    const w = sim.world;
    // some already sit on a bench or at a café table, or wait for a tram
    const special = rng.next();
    if (special < 0.12) {
      const n = sim.crowd.spawnSeated(x, y, rMin, rMax);
      if (n) return n;
    } else if (special < 0.2) {
      const n = sim.crowd.spawnWaiting(x, y, rMin, rMax);
      if (n) return n;
    }
    let cx = x, cy = y, rm = rMin, rM = rMax, hot = false;
    if (rng.chance(0.4)) {
      const spots = this.getHotspots().filter((h) => dist(h.x, h.y, x, y) < rMax + 45);
      if (spots.length) {
        const h = rng.pick(spots);
        (cx = h.x), (cy = h.y), (rm = 0), (rM = 30), (hot = true);
      }
    }
    const nodes = w.ped.nodesAround(cx, cy, rm, rM);
    if (!nodes.length) return 0;
    const n = rng.pick(nodes);
    const px = w.ped.nx(n), py = w.ped.ny(n);
    // on a walkable way, not at the bottom of steps into the river or past the edge of the map
    if (this.onScreen(px, py, 3) || w.ped.out[n].every((l) => l.edge.noWalk) || w.inWater(px, py, 0)) return 0;
    const p = new Ped('civ', px, py, rng.seed());
    this.startWalk(p, n);
    sim.addPed(p);
    if (!hot) return 1;
    // near a hotspot: sometimes a knot of people chatting, sometimes a small walking group
    const r = rng.next();
    if (r < 0.15) {
      p.state = 'idle';
      p.timer = rng.range(4, 10);
      p.link = null;
    } else if (r < 0.35) {
      const size = 1 + rng.int(3);
      for (let i = 0; i < size; i++) {
        const a = rng.next() * Math.PI * 2, off = 0.5 + rng.next() * 0.7;
        const f = new Ped('civ', px + Math.cos(a) * off, py + Math.sin(a) * off, rng.seed());
        this.followers.set(f, { leader: p, ox: Math.cos(a) * off, oy: Math.sin(a) * off });
        sim.addPed(f);
      }
      return 1 + size;
    }
    return 1;
  }

  private spawnTram(x: number, y: number, rMin: number, rMax: number) {
    const sim = this.sim;
    const g = sim.world.tram;
    const nodes = g.nodesAround(x, y, rMin, rMax);
    if (!nodes.length) return;
    const n = sim.rng.pick(nodes);
    if (this.onScreen(g.nx(n), g.ny(n), 40)) return;
    const link = sim.rng.pick(g.out[n]);
    if (link.edge.len < 30) return;
    for (const t of sim.trams) if (dist(t.x, t.y, g.nx(n), g.ny(n)) < 80) return;
    const tram = new Tram(g, link, sim.rng, sim.world.tramStops);
    if (this.onScreen(tram.x, tram.y, 40)) return;
    sim.addTram(tram);
  }

  // ------------------------------------------------------------- driving
  private chooseNext(v: Vehicle, d: Driver, graph: Graph): Link | null {
    if (!d.link) return null;
    const node = d.link.to;
    if (d.route.length && (d.route[0].fwd ? d.route[0].edge.a : d.route[0].edge.b) === node) return d.route.shift()!;
    let opts = graph.out[node].filter((l) => l.edge !== d.link!.edge && drivable(l));
    if (!opts.length) return graph.out[node].find((l) => l.edge === d.link!.edge) ?? graph.out[node][0] ?? null;
    // through traffic stays out of cul-de-sacs, courtyards, car parks and roads off the map (and
    // drives back out of one it started in), unless there's nowhere else to go
    const depth = graph.depth;
    if (depth) {
      const through = opts.filter((l) => depth[l.to] <= depth[node]);
      if (through.length) opts = through;
      else {
        // only deeper roads ahead: turn round where we came from, if that's allowed and doesn't
        // lead deeper in (off the map is never an option)
        const from = d.link.fwd ? d.link.edge.a : d.link.edge.b;
        const back = graph.out[node].find((l) => l.edge === d.link!.edge);
        if (back && (depth[from] <= depth[node] || opts.every((l) => depth[l.to] >= OFF_MAP))) return back;
      }
    }
    // buses and vans keep to streets they fit down
    if (v.spec.length > 5) {
      const fits = opts.filter((l) => l.edge.cls <= 5 && l.edge.width >= (v.spec.length > 8 ? 6 : 5));
      if (fits.length) opts = fits;
    }
    // prefer similar or bigger roads, avoid tiny service roads
    const weightedOpts: [Link, number][] = opts.map((l) => [l, l.edge.cls <= 5 ? 3 : l.edge.cls === 6 ? 1 : 0.4]);
    return this.sim.rng.weighted(weightedOpts);
  }

  /** The point `s` metres further along the driver's queued lane than the car is level with
   *  (measured from its projection onto the segment it's on), the lane's heading there, and how
   *  far along it actually got before the queued lane ran out. Fills and returns `out`. */
  private along(v: Vehicle, d: Driver, s: number, out: { x: number; y: number; a: number; got: number }) {
    const pts = d.pts, n = pts.length / 2;
    let k = Math.min(d.idx, n - 1);
    let x = pts[k * 2], y = pts[k * 2 + 1], a = v.angle;
    if (k > 0) {
      const px = pts[k * 2 - 2], py = pts[k * 2 - 1], sx = x - px, sy = y - py, L2 = sx * sx + sy * sy;
      if (L2 > 1e-9) {
        const t = clamp(((v.x - px) * sx + (v.y - py) * sy) / L2, 0, 1);
        (x = px + sx * t), (y = py + sy * t), (a = Math.atan2(sy, sx));
      }
    }
    let rem = s;
    for (; k < n && rem > 0; k++) {
      const qx = pts[k * 2], qy = pts[k * 2 + 1];
      const seg = Math.hypot(qx - x, qy - y);
      if (seg < 1e-6) continue;
      a = Math.atan2(qy - y, qx - x);
      if (seg >= rem) {
        x += ((qx - x) * rem) / seg;
        y += ((qy - y) * rem) / seg;
        rem = 0;
        break;
      }
      rem -= seg;
      (x = qx), (y = qy);
    }
    out.x = x;
    out.y = y;
    out.a = a;
    out.got = s - rem;
    return out;
  }

  private appendLink(d: Driver, link: Link, v?: Vehicle) {
    const pts = linkPoints(link, d.mode === 'police' ? 0 : laneFor(link, d.lane));
    // trim consumed points
    if (d.idx > 6) {
      d.pts.splice(0, (d.idx - 2) * 2);
      d.idx = 2;
    }
    d.pts.push(...pts.slice(2));
    d.link = link;
    if (d.mode === 'traffic') {
      d.stops.push(...this.sim.world.lights.forLink(link));
      d.marks.push(...this.marksFor(link, v?.kind));
    }
  }

  /** the signs and bumps on a link (bus stops only for buses) */
  private marksFor(link: Link, kind?: VehicleKind): Mark[] {
    const all = this.sim.world.marks.forLink(link);
    return kind === 'bus' ? [...all] : all.filter((m) => m.kind !== MARK_BUS_STOP);
  }

  /** Stop signs, give-way signs, speed bumps and bus stops ahead: the speed they allow now. */
  private obeyMarks(v: Vehicle, d: Driver, desired: number, dt: number): number {
    const fwd = Math.max(0, v.fwdSpeed);
    while (d.marks.length) {
      const m = d.marks[0];
      // how far its front is past the line (a bus straddling it is past it)
      const past = (v.x - m.x) * m.ux + (v.y - m.y) * m.uy + v.spec.length / 2;
      if (past > 0.5 || (d.waitAt === m && past > -1.2 && d.waited < 0)) {
        d.marks.shift();
        if (d.waitAt === m) (d.waitAt = null), (d.waited = 0);
        continue;
      }
      break;
    }
    for (let k = 0; k < Math.min(3, d.marks.length); k++) {
      const m = d.marks[k];
      const gap = (m.x - v.x) * m.ux + (m.y - v.y) * m.uy - v.spec.length / 2;
      if (gap > 45) break;
      /** the speed that still stops by `at` metres before the line */
      const stopBy = (at: number) => (gap < at ? 0 : Math.sqrt(2 * 3 * (gap - at)));
      if (m.kind >= 2 && m.kind < MARK_BUS_STOP) {
        if (gap < 16) desired = Math.min(desired, BUMP_SPEED[m.kind - 2] + Math.max(0, gap - 1.5) * 0.7);
      } else if (m.kind === MARK_BUS_STOP) {
        // a bus pulls up at the stop, stands a few seconds, then goes on
        if (d.waitAt === m && d.waited < 0) continue;
        desired = Math.min(desired, stopBy(0.5));
        if (gap < 2 && fwd < 0.5) {
          d.waitAt = m;
          if ((d.waited += dt) > BUS_DWELL) d.waited = -1;
        }
      } else if (m.kind === MARK_STOP) {
        // stop at the line, then go when the way across is clear
        if (d.waitAt === m && d.waited < 0) continue;
        desired = Math.min(desired, stopBy(1));
        if (gap < 3 && fwd < 0.6) {
          d.waitAt = m;
          // (on a busy road someone lets it out in the end)
          if ((d.waited += dt) > 1 && (this.crossClear(v, m) || d.waited > 9)) d.waited = -1;
        }
      } else if (m.kind === MARK_GIVE_WAY) {
        // slow down to look, stop only for traffic coming across (and after a long wait at the
        // line, nose out anyway: someone lets it in)
        if (d.waitAt === m && d.waited < 0) continue;
        if (gap < 20) desired = Math.min(desired, 3.5 + Math.max(0, gap) * 0.35);
        if (gap < 12 && !this.crossClear(v, m)) {
          desired = Math.min(desired, stopBy(1));
          if (gap < 3 && fwd < 0.6) {
            d.waitAt = m;
            if ((d.waited += dt) > 10) d.waited = -1;
          }
        }
      }
      // only the next sign or stop matters (bumps before it count too)
      if (m.kind === MARK_STOP || m.kind === MARK_GIVE_WAY || m.kind === MARK_BUS_STOP) break;
    }
    return desired;
  }

  /** Head-on standoffs: two cars that have each been waiting for the other a moment (nose to nose
   *  on a narrow street, or across each other's path in a junction). The one with the lower id
   *  gives way: backs up a little and tucks in to the right; the other squeezes past slowly,
   *  tucked in too. Returns the speed that allows. */
  private standoffs(v: Vehicle, d: Driver, dt: number): number {
    if (d.yieldTo || d.squeeze) {
      const o = (d.yieldTo ?? d.squeeze)!;
      const hx = Math.cos(v.angle), hy = Math.sin(v.angle);
      // over once they're past each other, or it's taking too long
      const past = (o.x - v.x) * hx + (o.y - v.y) * hy < -(o.spec.length + v.spec.length) / 2;
      if ((d.standoff -= dt) <= 0 || past || o.wrecked || !this.drivers.has(o)) {
        d.yieldTo = d.squeeze = null;
        d.standoff = 0;
        if (!d.passing) d.nudgeTo = 0;
        return Infinity;
      }
      return d.yieldTo ? 0 : 3.5;
    }
    const o = d.blocker;
    if (!o || d.blockedT < 1.5 || o.speed > 1 || v.speed > 1) return Infinity;
    const od = this.drivers.get(o);
    if (!od || od.blocker !== v || od.blockedT < 0.5 || od.yieldTo || od.squeeze) return Infinity;
    const [y, yd, g, gd] = v.id < o.id ? [v, d, o, od] : [o, od, v, d];
    yd.yieldTo = g;
    gd.squeeze = y;
    yd.standoff = gd.standoff = 4;
    if (!this.obstacleBehind(y, 4)) yd.reverse = 1.1;
    yd.nudgeTo = this.tuckIn(y, yd, 1.2);
    gd.nudgeTo = this.tuckIn(g, gd, 0.8);
    return d.yieldTo ? 0 : 3.5;
  }

  /** how far right of its lane (up to `max` m) a car can tuck in over the next few metres without
   *  touching a wall */
  private tuckIn(v: Vehicle, d: Driver, max: number) {
    const w = this.sim.world;
    for (const n of [max, max * 0.6, max * 0.3]) {
      let ok = true;
      for (let s = 0; s <= 6 && ok; s += 2) {
        this.along(v, d, s, PASS);
        if (w.collideCircle(PASS.x - Math.sin(PASS.a) * n, PASS.y + Math.cos(PASS.a) * n, v.spec.width / 2, 0)) ok = false;
      }
      if (ok) return n;
    }
    return 0;
  }

  /** a car in the way that isn't going anywhere by itself: parked, abandoned, wrecked, or a bus
   *  standing at its stop */
  private stillCar(o: Vehicle) {
    if (o.speed > 0.8) return false;
    return o.parked || !o.driver || o.wrecked || o.sinking > 0 || this.drivers.get(o)?.waitAt?.kind === MARK_BUS_STOP;
  }

  /** How far (x, y), `lon` metres ahead of the car, lies right of its queued lane (null where the
   *  queued lane doesn't reach). */
  private laneOff(v: Vehicle, d: Driver, x: number, y: number, lon: number): number | null {
    this.along(v, d, Math.max(0, lon), PASS);
    if (PASS.got < lon - 1) return null;
    const sa = Math.sin(PASS.a), ca = Math.cos(PASS.a);
    if (Math.abs((x - PASS.x) * ca + (y - PASS.y) * sa) > 4) return null;
    return (x - PASS.x) * -sa + (y - PASS.y) * ca;
  }

  /** the nearest car that isn't going anywhere standing in the lane within `range` ahead */
  private stillAhead(v: Vehicle, d: Driver, range: number): Vehicle | null {
    const hx = Math.cos(v.angle), hy = Math.sin(v.angle);
    let best: Vehicle | null = null, bl = Infinity;
    this.sim.forVehiclesNear(v.x + (hx * range) / 2, v.y + (hy * range) / 2, range / 2 + 6, (o) => {
      if (o === v || !this.stillCar(o)) return;
      const lon = (o.x - v.x) * hx + (o.y - v.y) * hy;
      if (lon < 0 || lon > range + v.spec.length / 2 || lon >= bl) return;
      const off = this.laneOff(v, d, o.x, o.y, lon);
      if (off === null || Math.abs(off - d.nudge) >= (v.spec.width + o.spec.width) / 2 + 0.3) return;
      (bl = lon), (best = o);
    });
    return best;
  }

  /** Is the way past `o`, `nudge` metres off the lane, clear: on the carriageway, no wall, post,
   *  person or tram in it, no car in it, and nothing oncoming that would arrive before we're past?
   *  An impatient driver (`squeeze`) mounts the kerb and squeezes by closer. */
  private clearToPass(v: Vehicle, d: Driver, o: Vehicle, nudge: number, squeeze = false) {
    const sim = this.sim, w = sim.world;
    const hx = Math.cos(v.angle), hy = Math.sin(v.angle);
    const lonO = (o.x - v.x) * hx + (o.y - v.y) * hy;
    const L = lonO + (o.spec.length + v.spec.length) / 2 + 2;
    // stays on the carriageway (a wheel over the kerb at most; service roads and car parks have
    // room either side)
    if (d.link && d.mode !== 'police') {
      const lane = laneFor(d.link, d.lane) + nudge;
      if (Math.abs(lane) + v.spec.width / 2 > d.link.edge.width / 2 + (squeeze || d.link.edge.cls >= 6 ? 1.5 : 0.6)) return false;
    }
    for (let s = 1.5; s <= L; s += 1.5) {
      this.along(v, d, s, PASS);
      if (PASS.got < s - 0.5) return false;
      const x = PASS.x - Math.sin(PASS.a) * nudge, y = PASS.y + Math.cos(PASS.a) * nudge;
      if (w.collideCircle(x, y, v.spec.width / 2, 0)) return false;
    }
    let clear = true;
    const margin = squeeze ? 0.05 : 0.15;
    sim.forVehiclesNear(v.x + (hx * L) / 2, v.y + (hy * L) / 2, L / 2 + 32, (q) => {
      if (!clear || q === v || q === o) return;
      const dx = q.x - v.x, dy = q.y - v.y;
      const lon = dx * hx + dy * hy, sp = q.vx * hx + q.vy * hy;
      // oncoming: as far as it gets in the few seconds the pass takes
      const oncoming = sp < -1;
      if (lon < -v.spec.length || lon > (oncoming ? L - sp * 3.5 + 6 : L)) return;
      const off = this.laneOff(v, d, q.x, q.y, lon) ?? -dx * hy + dy * hx + d.nudge;
      if (Math.abs(off - nudge) < (v.spec.width + q.spec.width) / 2 + margin) clear = false;
    });
    if (!clear) return false;
    for (const p of sim.pedsNear(v.x + (hx * L) / 2, v.y + (hy * L) / 2, L / 2 + 2)) {
      if (p.vehicle || p.dead) continue;
      const lon = (p.x - v.x) * hx + (p.y - v.y) * hy;
      if (lon < 0 || lon > L) continue;
      const off = this.laneOff(v, d, p.x, p.y, lon);
      if (off !== null && Math.abs(off - nudge) < v.spec.width / 2 + 0.8) return false;
    }
    for (const t of sim.trams)
      for (const s of t.sections) {
        if (dist(s.x, s.y, v.x, v.y) > L + 10) continue;
        const lon = (s.x - v.x) * hx + (s.y - v.y) * hy;
        const off = this.laneOff(v, d, s.x, s.y, lon);
        if (lon > -4 && lon < L + 8 && off !== null && Math.abs(off - nudge) < v.spec.width / 2 + 1.8) return false;
      }
    return true;
  }

  /** Get round a car that isn't going anywhere standing in the lane ahead: pull out past it when
   *  the way is clear, else wait a few metres back until it is (honking now and then). Returns
   *  the speed that allows. */
  private passStill(v: Vehicle, d: Driver, dt: number): number {
    const hx = Math.cos(v.angle), hy = Math.sin(v.angle);
    const fwd = Math.max(0, v.fwdSpeed);
    const lonOf = (o: Vehicle) => (o.x - v.x) * hx + (o.y - v.y) * hy;
    // done with the car being passed (it's behind now, or drove off): back into the lane
    if (d.passing) {
      const o = d.passing;
      if (lonOf(o) < -(o.spec.length + v.spec.length) / 2 - 1 || !this.stillCar(o) || dist(o.x, o.y, v.x, v.y) > 30) (d.passing = null), (d.nudgeTo = 0);
    }
    if (d.waitFor && (!this.stillCar(d.waitFor) || lonOf(d.waitFor) < 0 || dist(d.waitFor.x, d.waitFor.y, v.x, v.y) > 30)) (d.waitFor = null), (d.waitedFor = 0);
    d.passCheck -= dt;
    if (d.passCheck <= 0) {
      d.passCheck = 0.25;
      const o = d.passing ?? this.stillAhead(v, d, 8 + fwd * 1.8);
      if (o) {
        const lon = lonOf(o);
        const off = this.laneOff(v, d, o.x, o.y, lon) ?? 0;
        const need = (v.spec.width + o.spec.width) / 2 + 0.35;
        const alongside = lon < (o.spec.length + v.spec.length) / 2 - 0.5;
        const squeeze = d.waitedFor > 12;
        if (d.passing === o) {
          // oncoming traffic turned up before we got level: back into the lane and wait
          if (!alongside && !this.clearToPass(v, d, o, d.nudgeTo, squeeze)) (d.passing = null), (d.nudgeTo = 0), (d.waitFor = o);
        } else {
          // round the side away from it (the car parked on the right is passed on the left);
          // after a long wait, mounting the kerb and squeezing by closer
          const nudge = off >= 0 ? off - need + (squeeze ? 0.2 : 0) : off + need - (squeeze ? 0.2 : 0);
          if (Math.abs(nudge) < 3.6 && this.clearToPass(v, d, o, nudge, squeeze)) {
            d.passing = o;
            d.nudgeTo = nudge;
            d.waitFor = null;
            d.waitedFor = 0;
            // right up behind it: back up a little first to have room to pull out
            const gap = lon - (o.spec.length + v.spec.length) / 2;
            if (gap < 1.8 && fwd < 0.5 && !this.obstacleBehind(v, 5)) d.reverse = 0.7;
          } else d.waitFor = o;
        }
      }
    }
    // ease out of (and back into) the lane
    const rate = 1.2 + fwd * 0.3;
    d.nudge += clamp(d.nudgeTo - d.nudge, -rate * dt, rate * dt);
    if (d.passing) return 5.5;
    const o = d.waitFor;
    if (!o) return Infinity;
    // waiting for the way past to clear: a few metres back, honking now and then (and after half a
    // minute stuck there, it's as good as wedged: towed away once nobody's looking)
    d.waitedFor += dt;
    if (d.waitedFor > 6 && this.sim.rng.chance(dt * 0.15)) this.honk(v);
    if (d.waitedFor > 30) d.wedged = Math.max(d.wedged, 3);
    const gap = lonOf(o) - (o.spec.length + v.spec.length) / 2;
    return gap < PASS_GAP ? 0 : Math.sqrt(2 * 3 * (gap - PASS_GAP));
  }

  /** a car or person within `range` behind `v` (in the way of backing up) */
  private obstacleBehind(v: Vehicle, range: number) {
    const hx = Math.cos(v.angle), hy = Math.sin(v.angle), back = v.spec.length / 2;
    let hit = false;
    this.sim.forVehiclesNear(v.x - hx * (back + range / 2), v.y - hy * (back + range / 2), range / 2 + 6, (o) => {
      if (hit || o === v) return;
      const dx = o.x - v.x, dy = o.y - v.y;
      const lon = -(dx * hx + dy * hy) - back - o.spec.length / 2;
      if (lon > -0.5 && lon < range && Math.abs(-dx * hy + dy * hx) < (v.spec.width + o.spec.width) / 2 + 0.3) hit = true;
    });
    return hit;
  }

  /** nothing coming across the junction past sign `m` (cars within ~18 m of it, moving toward it,
   *  heading another way) */
  private crossClear(v: Vehicle, m: Mark): boolean {
    const jx = m.x + m.ux * 5, jy = m.y + m.uy * 5;
    let clear = true;
    this.sim.forVehiclesNear(jx, jy, 20, (o) => {
      if (!clear || o === v || o.parked || o.wrecked) return;
      const sp = o.speed;
      if (sp < 1.5) return;
      const dx = jx - o.x, dy = jy - o.y, d = Math.hypot(dx, dy);
      if (d > 20) return;
      // moving toward the junction, and not just the car ahead going our way
      if (dx * o.vx + dy * o.vy <= 0) return;
      if ((o.vx * m.ux + o.vy * m.uy) / sp > 0.8) return;
      clear = false;
    });
    return clear;
  }

  private drive(v: Vehicle, d: Driver, dt: number, chase: boolean) {
    const sim = this.sim;
    const graph = d.mode === 'police' ? this.policeGraph : sim.world.car;
    // progress along the lane: step past every vertex the car has drawn level with
    while (d.idx * 2 < d.pts.length) {
      const qx = d.pts[d.idx * 2], qy = d.pts[d.idx * 2 + 1];
      const near = dist(v.x, v.y, qx, qy) < 1.5;
      if (d.idx > 0 && !near) {
        const sx = qx - d.pts[d.idx * 2 - 2], sy = qy - d.pts[d.idx * 2 - 1];
        if ((v.x - qx) * sx + (v.y - qy) * sy < 0) break;
      } else if (!near) break;
      d.idx++;
    }
    // keep enough road queued to steer along it and to see the next bend coming
    const fwd = Math.max(0, v.fwdSpeed);
    const horizon = 14 + fwd * 2.2;
    for (let i = 0; i < 6 && this.along(v, d, horizon, AHEAD).got < horizon; i++) {
      const next = this.chooseNext(v, d, graph);
      if (!next) break;
      this.appendLink(d, next, v);
    }
    // a parked or abandoned car, a wreck or a bus at its stop in the lane: pull out round it
    const passCap = chase ? Infinity : this.passStill(v, d, dt);
    // steer for a point a little further along the lane (not the next vertex, which on a long
    // straight can be far off and made traffic cut every corner into the buildings)
    const look = 2.5 + Math.abs(v.fwdSpeed) * 0.3;
    this.along(v, d, look, AHEAD);
    if (d.nudge) (AHEAD.x -= Math.sin(AHEAD.a) * d.nudge), (AHEAD.y += Math.cos(AHEAD.a) * d.nudge);
    let diff = angleDiff(v.angle, Math.atan2(AHEAD.y - v.y, AHEAD.x - v.x));
    let desired = chase ? Math.max(10, (d.link?.edge.speed ?? 10) * 1.6) : (d.link?.edge.speed ?? 10) * 0.75;
    // bends ahead: no faster than the tyres hold round them (traffic comfortably, police at the
    // limit), estimating each bend's radius from how far the lane turns over the distance to it
    this.along(v, d, 0, AHEAD);
    const a0 = AHEAD.a;
    const aLat = (chase ? 8.5 : 4.5) * (1 - 0.3 * sim.clock.wet);
    for (const s of CURVE_SAMPLES) {
      if (s > horizon) break;
      const got = this.along(v, d, s, AHEAD).got;
      const turn = Math.abs(angleDiff(a0, AHEAD.a));
      if (turn > 0.12) desired = Math.min(desired, Math.sqrt(aLat * Math.max(6, got / turn)));
      if (got < s) break;
    }
    if (Math.abs(diff) > 0.9) desired = Math.min(desired, 4);
    if (!chase) desired = Math.min(desired, v.spec.maxSpeed * 0.5, passCap);

    // civilian traffic reacts to nearby gunfire/explosions and to a siren closing in from behind
    if (!chase && sim.anyWanted) {
      const danger = sim.police.nearestDanger(v.x, v.y, 22);
      if (danger) {
        desired = Math.min(v.spec.maxSpeed * 0.85, Math.max(desired, desired * 1.8 + 4));
        const away = Math.atan2(v.y - danger.y, v.x - danger.x);
        diff += angleDiff(v.angle, away) * 0.2;
        if (sim.rng.chance(dt * 0.6)) this.honk(v);
      } else if (this.sirenBehind(v)) {
        desired *= 0.35;
        diff += 0.25;
      }
    }

    // traffic lights: stop at the line on red, and on amber when there's room to. The cycle runs
    // on the world clock, which online clients sync to, so everyone sees the same colours.
    if (!chase && d.stops.length) {
      // (once its front is over the line it carries on through the junction)
      while (d.stops.length && (v.x - d.stops[0].x) * d.stops[0].ux + (v.y - d.stops[0].y) * d.stops[0].uy + v.spec.length / 2 > 0.5) d.stops.shift();
      const l = d.stops[0];
      if (l) {
        const gap = (l.x - v.x) * l.ux + (l.y - v.y) * l.uy - v.spec.length / 2;
        if (gap < 45) {
          const light = sim.world.lights.state(l, sim.clock.time * SECONDS_PER_HOUR);
          const sp = Math.max(0, v.fwdSpeed);
          if (light === 2 || (light === 1 && gap > (sp * sp) / 9 + 1)) desired = Math.min(desired, gap < 1.2 ? 0 : Math.sqrt(2 * 3.5 * (gap - 1.2)));
        }
      }
    }

    // stop and give-way signs, speed bumps, bus stops
    if (!chase && d.marks.length) desired = this.obeyMarks(v, d, desired, dt);

    // police in pursuit shove through traffic instead of queueing
    const obstacle = chase ? null : this.obstacleAhead(v, 4 + Math.abs(v.fwdSpeed) * 1.1, false, d.passing ?? d.squeeze);
    // two cars nose to nose, each waiting for the other: one gives way
    // (the look-ahead shrinks as a car stops, so a car nose to nose with it drops in and out of
    // view: it only counts as gone after a while)
    const blk = obstacle ? this.lastBlocker : null;
    if (blk) {
      if (blk !== d.blocker) (d.blocker = blk), (d.blockedT = 0);
      d.blockedT += dt;
    } else if (d.blocker && (d.blockedT -= dt * 0.5) <= 0) (d.blocker = null), (d.blockedT = 0);
    if (!chase) desired = Math.min(desired, this.standoffs(v, d, dt));
    if (obstacle) {
      desired = 0;
      if (obstacle === 'player' && !chase && sim.rng.chance(dt * 0.4)) this.honk(v);
    }
    // someone standing in the road: a toot after a while, and they step aside
    if (obstacle === 'other' && this.lastPed && !chase) {
      if ((d.pedWait += dt) > 2.5) {
        d.pedWait = -4;
        this.honk(v);
      }
    } else if (d.pedWait > 0) d.pedWait = 0;
    this.steerTo(v, d, diff, desired, dt, obstacle !== null);
  }

  /** traffic leans on the horn: everyone near hears it, people in its way step aside */
  private honk(v: Vehicle) {
    if (v.horn > 0) return;
    v.horn = 0.6;
    this.sim.events.horn(v.id, v.x, v.y);
    this.sim.honk(v);
  }

  /** is a siren-on police car (not a player's) closing in from behind this traffic car? */
  private sirenBehind(v: Vehicle): boolean {
    let found = false;
    this.sim.forVehiclesNear(v.x, v.y, 16, (o) => {
      if (found || o === v || o.kind !== 'police' || !o.siren || o.isPlayer) return;
      const dx = o.x - v.x, dy = o.y - v.y;
      const d2 = dx * dx + dy * dy;
      if (d2 > 256) return;
      const behind = -(dx * Math.cos(v.angle) + dy * Math.sin(v.angle));
      if (behind > 1.5) found = true;
    });
    return found;
  }

  /** civilian traffic very close to gunfire/an explosion sometimes bails out and flees on foot */
  private checkPanic(v: Vehicle, _d: Driver, dt: number): boolean {
    const sim = this.sim;
    if (v.kind === 'police' || !v.driver || v.driver.playerId) return false;
    const danger = sim.police.nearestDanger(v.x, v.y, 9);
    if (!danger || sim.rng.next() > dt * 3) return false;
    const drv = v.driver;
    drv.vehicle = null;
    v.driver = null;
    drv.x = v.x - Math.sin(v.angle) * 1.6;
    drv.y = v.y + Math.cos(v.angle) * 1.6;
    sim.combat.scare(drv, danger.x, danger.y);
    this.drivers.delete(v);
    v.setControls(0, 0, true);
    return true;
  }

  private steerTo(v: Vehicle, d: Driver, diff: number, desired: number, dt: number, waiting: boolean, boost = false) {
    const sp = v.fwdSpeed;
    if (d.reverse > 0) {
      d.reverse -= dt;
      v.setControls(-1, -Math.sign(diff), false);
      return;
    }
    let throttle = desired > sp + 0.5 ? 1 : desired < sp - 1.5 ? -1 : desired < 0.5 ? -0.3 : 0.15;
    if (desired > sp + 0.5 && desired - sp < 3) throttle = 0.5;
    v.setControls(throttle, clamp(diff * 2.2, -1, 1), false, boost);
    if (!waiting && desired > 2 && Math.abs(sp) < 0.6) d.stuck += dt;
    else d.stuck = Math.max(0, d.stuck - dt);
    if (d.stuck > 1.6) {
      d.stuck = 0;
      d.reverse = 1.5;
      d.wedged++;
      // backed up twice and still nowhere: it has lost its lane (shunted off it, or cut a corner
      // into a wall): pick the road up again from the nearest junction the way it's facing
      if (d.wedged === 2 && d.mode === 'traffic') this.rejoin(v, d);
    }
  }

  /** Put a traffic car that lost its lane back on the road network: its path starts where it is
   *  and joins the street out of the nearest junction that best matches the way it faces (or the
   *  way behind it, when that's all there is). */
  private rejoin(v: Vehicle, d: Driver) {
    const w = this.sim.world, g = w.car;
    const n = g.nearest(v.x, v.y, 50, (i) => g.out[i].some(drivable));
    if (n < 0) return;
    const fx = Math.cos(v.angle), fy = Math.sin(v.angle);
    let best: Link | null = null, bs = -Infinity;
    for (const l of g.out[n]) {
      if (!drivable(l)) continue;
      const pts = linkPoints(l);
      const dx = pts[2] - pts[0], dy = pts[3] - pts[1], L = Math.hypot(dx, dy) || 1;
      // heading the same way, and the junction not behind the car
      const toNode = (g.nx(n) - v.x) * fx + (g.ny(n) - v.y) * fy;
      const score = (dx * fx + dy * fy) / L + (toNode > -2 ? 0.5 : 0);
      if (score > bs) (bs = score), (best = l);
    }
    if (!best) return;
    const pts = linkPoints(best, laneFor(best, d.lane));
    d.link = best;
    d.pts = [v.x, v.y, ...pts];
    d.idx = 1;
    d.route = [];
    d.stops = [...w.lights.forLink(best)];
    d.marks = this.marksFor(best, v.kind);
    d.waitAt = null;
    d.nudge = d.nudgeTo = 0;
    d.passing = d.waitFor = d.yieldTo = d.squeeze = null;
  }

  /** Is anything in the way just ahead of `v` (within `range` of its front)? Oncoming cars only
   *  count when they'd actually touch (narrow streets are passed mirror to mirror); `ignore` is a
   *  car it's pulling out round. The nearest car in the way is left in `lastBlocker`. */
  obstacleAhead(v: Vehicle, range: number, chase: boolean, ignore: Vehicle | null = null): 'player' | 'other' | null {
    const sim = this.sim;
    const fx = Math.cos(v.angle), fy = Math.sin(v.angle);
    const front = v.spec.length / 2;
    const test = (x: number, y: number, r: number, margin = 0.4) => {
      const dx = x - v.x, dy = y - v.y;
      const lon = dx * fx + dy * fy - front;
      const lat = Math.abs(-dx * fy + dy * fx);
      return lon > -0.5 && lon < range && lat < v.spec.width / 2 + r + margin;
    };
    let res: 'player' | 'other' | null = null;
    let near: Vehicle | null = null, nd = Infinity;
    const cx = v.x + fx * (front + range / 2), cy = v.y + fy * (front + range / 2);
    const qr = range / 2 + 8;
    sim.forVehiclesNear(cx, cy, qr, (o) => {
      if (res === 'player' || o === v || o === ignore) return;
      if (Math.abs(o.x - v.x) > range + 8 || Math.abs(o.y - v.y) > range + 8) return;
      if (test(o.x, o.y, o.spec.width / 2, Math.cos(o.angle - v.angle) < -0.5 ? 0.15 : 0.4)) {
        if (chase && o.isPlayer) return;
        res = o.isPlayer ? 'player' : res ?? 'other';
        const od = (o.x - v.x) * fx + (o.y - v.y) * fy;
        if (od < nd) (nd = od), (near = o);
      }
    });
    this.lastBlocker = near;
    this.lastPed = null;
    if (res) return res;
    if (!chase) {
      for (const p of sim.pedsNear(cx, cy, qr)) {
        if (p.vehicle || p.dead) continue;
        if (Math.abs(p.x - v.x) > range + 3 || Math.abs(p.y - v.y) > range + 3) continue;
        if (!test(p.x, p.y, 0.4)) continue;
        if (!p.playerId) this.lastPed = p;
        return p.playerId ? 'player' : 'other';
      }
    }
    for (const t of sim.trams)
      for (const s of t.sections) if (dist(s.x, s.y, v.x, v.y) < range + 8 && test(s.x, s.y, 1.2)) return 'other';
    return null;
  }

  // --------------------------------------------------------------- police
  /** keep enough police cars chasing a wanted player; returns how many were spawned */
  private policeSpawn(p: SimPlayer): number {
    const sim = this.sim;
    const stars = p.stars;
    const want = stars <= 0 ? 0 : COPS_WANTED[Math.min(5, stars)];
    let cops = 0;
    for (const [v, d] of this.drivers) if (d.mode === 'police' && d.target === p.id && v.driver && !v.driver.dead && !v.wrecked) cops++;
    if (cops >= want) return 0;
    const o = p.observer;
    const vr = Math.hypot(o.hw, o.hh);
    const f = p.focus();
    const pg = this.policeGraph;
    const nodes = pg.nodesAround(f.x, f.y, vr + 25, vr + 90).filter((n) => pg.out[n].some((l) => l.edge.cls <= 6));
    if (!nodes.length) return 0;
    const n = sim.rng.pick(nodes);
    if (this.onScreen(pg.nx(n), pg.ny(n), 10)) return 0;
    const link = sim.rng.pick(pg.out[n].filter((l) => l.edge.cls <= 6));
    const swat = stars >= 5 && sim.rng.chance(0.4);
    const v = this.spawnOnLink(swat ? 'van' : 'police', link, 'police', p.id);
    if (!v) return 0;
    v.siren = true;
    if (swat) {
      v.color = '#1b1f2a';
      v.rev++;
      sim.police.swat.add(v);
      if (v.driver) v.driver.outfit = 'swat';
    }
    return 1;
  }

  /** wanted player a cop car should chase: keep the current one while wanted, else the nearest nearby */
  private pickTarget(x: number, y: number, current: SimPlayer | undefined): SimPlayer | undefined {
    let best: SimPlayer | undefined, bd = 250;
    for (const p of this.sim.players.values()) {
      if (p.wanted <= 0 || p.state !== 'play') continue;
      const f = p.focus();
      const d = dist(x, y, f.x, f.y);
      if (d < bd) (bd = d), (best = p);
    }
    if (current && current.wanted > 0 && current.state === 'play') {
      const f = current.focus();
      // only switch when someone else is much closer
      if (!best || best === current || dist(x, y, f.x, f.y) < bd * 2) return current;
    }
    return best;
  }

  private drivePolice(v: Vehicle, d: Driver, dt: number) {
    const sim = this.sim;
    let t = sim.players.get(d.target);
    d.retarget -= dt;
    if (d.retarget <= 0 || !t || t.wanted <= 0) {
      d.retarget = 2;
      t = this.pickTarget(v.x, v.y, t);
      d.target = t?.id ?? 0;
      if (v.driver) v.driver.targetPid = d.target;
    }
    if (!t || t.wanted <= 0) {
      // back to normal patrol
      v.siren = false;
      d.route = [];
      d.searchTarget = null;
      this.drive(v, d, dt, false);
      return;
    }
    v.siren = true;
    const real = t.focus();
    const dd = dist(v.x, v.y, real.x, real.y);
    // a cop that stops closing in while off-screen is recycled by the spawner
    if (dd < d.best - 5) (d.best = dd), (d.noProgress = 0);
    else if ((d.noProgress += dt) > 10 && !this.onScreen(v.x, v.y, 20)) {
      this.retire.add(v);
      return;
    }
    // no seeing into or out of a tunnel
    const los = dd < 55 && (v.level === -1) === (t.focusLevel() === -1) && sim.world.raycast(v.x, v.y, real.x, real.y, v.level) >= 1;
    // no direct sight, and nobody else has either: hunt the last-known-position search zone
    // instead of homing straight in, so a driver who breaks line of sight can actually lose them
    const zone = t.searchZone;
    const searching = !los && !!zone;
    let target = real;
    if (searching) {
      if (!d.searchTarget || d.searchTimer <= 0 || dist(v.x, v.y, d.searchTarget.x, d.searchTarget.y) < 10) {
        const a = sim.rng.next() * Math.PI * 2, r = sim.rng.next() * zone!.r;
        d.searchTarget = { x: zone!.x + Math.cos(a) * r, y: zone!.y + Math.sin(a) * r };
        d.searchTimer = sim.rng.range(6, 11);
      }
      d.searchTimer -= dt;
      target = d.searchTarget;
    } else d.searchTarget = null;

    // end of the route (target is off-network): go straight for the suspect
    const close = !searching && !d.route.length && dd < 70 && d.idx * 2 >= d.pts.length - 2;
    if (los || close) {
      d.direct = true;
      const stars = t.stars;
      const playerVeh = t.ped.vehicle;
      const swat = sim.police.swat.has(v);
      let aimX = target.x, aimY = target.y;
      // 2+ stars, in a car chase, close behind/beside: aim the rear quarter to ram/PIT instead of nose-first
      if (playerVeh && stars >= 2 && dd < (swat ? 30 : 22)) {
        const hAngle = Math.hypot(playerVeh.vx, playerVeh.vy) > 1 ? Math.atan2(playerVeh.vy, playerVeh.vx) : playerVeh.angle;
        const hx = Math.cos(hAngle), hy = Math.sin(hAngle);
        const px = -hy, py = hx;
        const side = (v.x - target.x) * px + (v.y - target.y) * py >= 0 ? 1 : -1;
        const back = swat ? 1 : 1.5, lat = swat ? 1.2 : 1.8;
        aimX = target.x - hx * back + px * side * lat;
        aimY = target.y - hy * back + py * side * lat;
      }
      const want = Math.atan2(aimY - v.y, aimX - v.x);
      const diff = angleDiff(v.angle, want);
      const onFoot = !playerVeh;
      let desired = onFoot ? Math.min(20, (dd - 7) * 1.4) : 30;
      if (Math.abs(diff) > 1.2) desired = Math.min(desired, 8);
      const boost = !onFoot && stars >= 2 && dd < 35;
      this.steerTo(v, d, diff, desired, dt, false, boost);
      // cops get out when the suspect is on foot nearby (or car stopped)
      if (dd < 14 && (onFoot || playerVeh!.speed < 2) && Math.abs(v.fwdSpeed) < 3) this.copsExit(v);
      return;
    }
    if (d.direct) {
      // lost direct sight: rejoin the road network
      d.direct = false;
      const n = this.policeGraph.nearest(v.x, v.y, 120);
      if (n >= 0) {
        d.pts = [this.policeGraph.nx(n), this.policeGraph.ny(n)];
        d.idx = 0;
        d.link = this.policeGraph.out[n][0] ?? null;
        if (d.link) d.link = { ...d.link, to: n };
        d.route = [];
        d.repath = 0;
      }
    }
    d.repath -= dt;
    if (d.repath <= 0 && d.link) {
      d.repath = 2;
      const goal = this.policeGraph.nearest(target.x, target.y, 200);
      const route = this.policeGraph.path(d.link.to, goal, 4000);
      if (route) d.route = route;
    }
    this.drive(v, d, dt, true);
  }

  copsExit(v: Vehicle) {
    const sim = this.sim;
    const d = this.drivers.get(v);
    if (!d || d.mode !== 'police' || !v.driver) return;
    d.mode = 'idle';
    v.setControls(0, 0, true);
    const cop = v.driver;
    cop.vehicle = null;
    cop.targetPid = d.target;
    v.driver = null;
    const side = sim.rng.chance(0.5) ? 1 : -1;
    cop.x = v.x - Math.sin(v.angle) * 1.6 * side;
    cop.y = v.y + Math.cos(v.angle) * 1.6 * side;
    cop.state = 'chase';
    if (sim.rng.chance(0.7)) {
      const cop2 = new Ped('cop', v.x + Math.sin(v.angle) * 1.6 * side, v.y - Math.cos(v.angle) * 1.6 * side, sim.rng.seed());
      cop2.state = 'chase';
      cop2.targetPid = d.target;
      if (cop.outfit === 'swat') cop2.outfit = 'swat';
      sim.addPed(cop2);
    }
  }

  // --------------------------------------------------------- pedestrians
  startWalk(p: Ped, node: number) {
    const graph = this.sim.world.ped;
    const out = graph.out[node];
    if (!out.length) return;
    const ok = out.filter((l) => !l.edge.noWalk);
    this.setPedLink(p, this.sim.rng.pick(ok.length ? ok : out));
  }

  private setPedLink(p: Ped, l: Link) {
    const e = l.edge;
    // on the pavement (or the path) on their side, as far out as World found room for
    const right = p.side * (l.fwd ? 1 : -1) > 0;
    const off = (right ? e.walkR : e.walkL) ?? (e.cls <= 7 ? e.width / 2 + 1.4 : Math.min(0.6, e.width / 3));
    p.link = l;
    p.pts = linkPoints(l, off * p.side);
    p.idx = 0;
    p.bestD = Infinity;
  }

  private updatePed(p: Ped, dt: number) {
    const sim = this.sim;
    const rng = sim.rng;
    if (p.playerId || p.vehicle) return;
    if (p.dead) {
      p.deadTime += dt;
      this.followers.delete(p);
      if (Math.hypot(p.vx, p.vy) > 0.05) {
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.vx *= 1 - dt * 4;
        p.vy *= 1 - dt * 4;
      }
      return;
    }
    // civilians near an armed cop, or with a gun pointed at them, put their hands up
    if (p.kind === 'civ') {
      if (p.surrender > 0) p.surrender -= dt;
      let near = p.surrender > 0;
      if (!near)
        for (const c of this.armedCops)
          if (dist(p.x, p.y, c.x, c.y) < 6) {
            near = true;
            break;
          }
      if (near !== p.handsUp) p.handsUp = near;
      // sitting, waiting for a tram, phoning, fighting, heading for a seat...
      if (this.sim.crowd.updatePed(p, dt, this.followers.has(p))) return;
    }
    // walking groups: follow the leader at a fixed offset instead of navigating independently
    const fo = this.followers.get(p);
    if (fo && p.state === 'walk') {
      if (fo.leader.dead || fo.leader.vehicle) this.followers.delete(p);
      else {
        const tx = fo.leader.x + fo.ox, ty = fo.leader.y + fo.oy;
        const d = dist(p.x, p.y, tx, ty) || 1e-3;
        const sp = Math.min(fo.leader.speed * 1.15, d * 3);
        // their spot beside the leader is inside a wall (they touch it and keep falling behind): go
        // their own way
        if (p.move(dt, sim.world, ((tx - p.x) / d) * sp, ((ty - p.y) / d) * sp) && d > 1.5) {
          if ((p.timer += dt) > 1.5) {
            this.followers.delete(p);
            p.timer = 0;
            p.link = null;
          }
        } else p.timer = Math.max(0, p.timer - dt);
        return;
      }
    }
    // idle: standing still (chatting knot, or briefly waiting at a crossing)
    if (p.state === 'idle') {
      p.timer -= dt;
      if (p.timer <= 0) {
        p.state = 'walk';
        if (!p.link) {
          const n = sim.world.ped.nearest(p.x, p.y, 60);
          if (n >= 0) this.startWalk(p, n);
        }
      }
      return;
    }
    if (p.cooldown > 0) p.cooldown -= dt;
    if (p.kind === 'cop' && (p.state === 'chase' || sim.anyWanted)) return this.copOnFoot(p, dt);
    if (p.kind === 'civ' && p.state === 'walk' && this.dodge(p)) return;
    if (p.state === 'flee') {
      p.timer -= dt;
      const dx = p.x - p.fleeFrom.x, dy = p.y - p.fleeFrom.y;
      const l = Math.hypot(dx, dy) || 1;
      const x0 = p.x, y0 = p.y;
      let blocked = p.move(dt, sim.world, (dx / l) * 4.6, (dy / l) * 4.6) && dist(x0, y0, p.x, p.y) < 4.6 * dt * 0.4;
      // ...and nobody flees into the Danube: the river bank stops them like a wall
      if (!blocked && sim.world.inWater(p.x, p.y, p.level) && !sim.world.inWater(x0, y0, p.level)) {
        (p.x = x0), (p.y = y0);
        blocked = true;
      }
      if (blocked) {
        // ran into a wall: turn a right angle (the way they're already sliding, else their side)
        // by moving where they flee from, instead of pressing against it
        const turn = (p.x - x0) * -dy + (p.y - y0) * dx >= 0 ? 1 : -1;
        const tside = Math.hypot(p.x - x0, p.y - y0) > 1e-3 ? turn : p.side;
        p.fleeFrom.x = p.x - (-dy / l) * tside * l;
        p.fleeFrom.y = p.y - (dx / l) * tside * l;
      }
      // panic cascade: scare nearby civilians too, with a cooldown so it doesn't loop forever
      if (p.kind === 'civ' && p.cooldown <= 0) {
        p.cooldown = 1.2;
        let spread = false;
        for (const q of sim.pedsNear(p.x, p.y, 8)) {
          if (q === p || q.kind !== 'civ' || q.dead || q.vehicle || q.state === 'flee') continue;
          if (dist(p.x, p.y, q.x, q.y) < 8) {
            sim.combat.scare(q, p.fleeFrom.x, p.fleeFrom.y);
            spread = true;
          }
        }
        if (spread && rng.chance(0.3)) sim.events.scream(p.x, p.y);
      }
      if (p.timer <= 0) {
        p.state = 'walk';
        const n = sim.world.ped.nearest(p.x, p.y, 80);
        p.link = null;
        if (n >= 0) {
          this.startWalk(p, n);
          p.pts = [sim.world.ped.nx(n), sim.world.ped.ny(n), ...p.pts];
        }
      }
      return;
    }
    if (!p.link || !p.pts.length) {
      const n = sim.world.ped.nearest(p.x, p.y, 80);
      if (n >= 0) this.startWalk(p, n);
      else p.move(dt, sim.world, 0, 0);
      return;
    }
    const tx = p.pts[p.idx * 2], ty = p.pts[p.idx * 2 + 1];
    const d = dist(p.x, p.y, tx, ty);
    if (d < 0.8) {
      p.idx++;
      p.bestD = Infinity;
      if (p.idx * 2 >= p.pts.length) {
        // on along any walkable way but the one they came by, else back the way they came
        const out = sim.world.ped.out[p.link.to];
        const opts = out.filter((l) => l.edge !== p.link!.edge && !l.edge.noWalk);
        const next = opts.length ? rng.pick(opts) : out.find((l) => l.edge === p.link!.edge) ?? out[0];
        // briefly wait before stepping onto a road crossing
        if (next.edge.cls <= 6 && rng.chance(0.3)) {
          p.state = 'idle';
          p.timer = rng.range(0.4, 1.3);
        }
        this.setPedLink(p, next);
        if (rng.chance(0.15)) p.side = -p.side;
      }
      return;
    }
    // walk on. When they stop getting any closer to where they're walking (a wall the map's path
    // runs into: a door it ends at, a corner it clips, the edge of the map), they turn round instead
    // of pressing against it
    const hit = p.move(dt, sim.world, ((tx - p.x) / d) * p.speed, ((ty - p.y) / d) * p.speed);
    if (d < p.bestD - 0.2) (p.bestD = d), (p.timer = 0);
    else if ((p.timer += dt) > (hit ? 1.5 : 5)) {
      const l = p.link;
      const back = sim.world.ped.out[l.to].find((o) => o.edge === l.edge) ?? { edge: l.edge, fwd: !l.fwd, to: l.fwd ? l.edge.a : l.edge.b };
      p.side = -p.side;
      this.setPedLink(p, back);
      // from where they are, not from the far end of the way back
      let best = 0, bd = Infinity;
      for (let i = 0; i < p.pts.length; i += 2) {
        const dd = dist(p.x, p.y, p.pts[i], p.pts[i + 1]);
        if (dd < bd) (bd = dd), (best = i / 2);
      }
      p.idx = Math.min(best + 1, p.pts.length / 2 - 1);
    }
  }

  /** A car bearing down on them (the player's, a police car on a call, anything fast; ordinary
   *  traffic brakes for people instead): they jump off its line, unless it's too late to react.
   *  Returns true when they do. */
  private dodge(p: Ped): boolean {
    let best = Infinity, cx = 0, cy = 0, px = 0, py = 0;
    this.sim.forVehiclesNear(p.x, p.y, 20, (v) => {
      if (v.level !== p.level || v.wrecked || v.parked) return;
      const sp = v.speed;
      if (sp < 5 || !(v.isPlayer || v.siren || sp > 9)) return;
      const ux = v.vx / sp, uy = v.vy / sp;
      const dx = p.x - v.x, dy = p.y - v.y;
      const along = dx * ux + dy * uy - v.spec.length / 2;
      if (along < -0.5 || along > sp * 1.3) return;
      const lat = dx * -uy + dy * ux;
      if (Math.abs(lat) > v.spec.width / 2 + 0.8) return;
      const ttc = Math.max(0, along) / sp;
      if (ttc >= best) return;
      best = ttc;
      // the nearest point of the car's line, and the way off it (their own side when right on it)
      const side = Math.abs(lat) > 0.2 ? Math.sign(lat) : p.side;
      (cx = p.x - -uy * lat), (cy = p.y - ux * lat);
      (px = -uy * side), (py = ux * side);
    });
    if (best === Infinity || best < 0.2) return false;
    p.state = 'flee';
    p.timer = 0.8 + this.sim.rng.next() * 0.5;
    // flee from a point just on the other side of the line, so they run straight off it
    p.fleeFrom.x = cx - px;
    p.fleeFrom.y = cy - py;
    // a near miss isn't a panic: no screaming crowd
    p.cooldown = Math.max(p.cooldown, 2.5);
    return true;
  }

  /** the player a cop on foot is after: their assigned target, or the nearest wanted player close by */
  private copTarget(p: Ped): SimPlayer | undefined {
    const sim = this.sim;
    const t = sim.players.get(p.targetPid);
    if (t && t.wanted > 0 && t.state === 'play') return t;
    let best: SimPlayer | undefined, bd = 80;
    for (const q of sim.players.values()) {
      if (q.wanted <= 0 || q.state !== 'play') continue;
      const f = q.focus();
      const d = dist(p.x, p.y, f.x, f.y);
      if (d < bd) (bd = d), (best = q);
    }
    if (best) p.targetPid = best.id;
    return best;
  }

  private copOnFoot(p: Ped, dt: number) {
    const sim = this.sim;
    const t = this.copTarget(p);
    if (!t) {
      p.state = 'walk';
      p.kind = 'cop';
      p.link = null;
      return;
    }
    const pl = t.ped;
    const tx = pl.vehicle ? pl.vehicle.x : pl.x, ty = pl.vehicle ? pl.vehicle.y : pl.y;
    const d = dist(p.x, p.y, tx, ty);
    const los = d < 30 && (p.level === -1) === (t.focusLevel() === -1) && sim.world.raycast(p.x, p.y, tx, ty, p.level) >= 1;
    const armed = t.wanted >= 3 || t.shotCops;
    if (armed && los && d < 22) {
      // stop and shoot
      p.move(dt, sim.world, 0, 0);
      p.angle = Math.atan2(ty - p.y, tx - p.x);
      if (p.cooldown <= 0) {
        p.cooldown = sim.rng.range(0.7, 1.3);
        sim.combat.fireNpc(p, p.angle, 'pistol');
      }
      return;
    }
    if (d > 1.1) {
      const sp = p.speed * (pl.vehicle ? 0.8 : 1);
      p.move(dt, sim.world, ((tx - p.x) / d) * sp, ((ty - p.y) / d) * sp);
    }
    // busted when touching the player on foot (or stopped car)
    const stopped = !pl.vehicle || pl.vehicle.speed < 1.2;
    if (d < (pl.vehicle ? pl.vehicle.radius + 0.6 : 1.3) && stopped && !armed) {
      p.bustTimer += dt;
      if (p.bustTimer > (pl.vehicle ? 1.6 : 0.8)) sim.bust(t);
    } else p.bustTimer = Math.max(0, p.bustTimer - dt);
  }

  // ---------------------------------------------------------------- trams
  private updateTram(t: Tram, dt: number) {
    const sim = this.sim;
    const fx = Math.cos(t.angle), fy = Math.sin(t.angle);
    let blocked = false;
    const check = (x: number, y: number, r: number) => {
      const dx = x - t.x, dy = y - t.y;
      const lon = dx * fx + dy * fy;
      const lat = Math.abs(-dx * fy + dy * fx);
      return lon > -1 && lon < 5 + t.speed * 1.2 && lat < 1.3 + r;
    };
    sim.forVehiclesNear(t.x, t.y, 25, (v) => {
      if (!blocked && !v.wrecked && Math.abs(v.x - t.x) < 25 && Math.abs(v.y - t.y) < 25 && check(v.x, v.y, v.spec.width / 2)) blocked = true;
    });
    for (const p of sim.pedsNear(t.x, t.y, 20))
      if (!p.vehicle && !p.dead && Math.abs(p.x - t.x) < 20 && Math.abs(p.y - t.y) < 20 && check(p.x, p.y, 0.3)) {
        blocked = true;
        if (p.playerId && t.bell <= 0) {
          t.bell = 2;
          sim.events.bell(t.x, t.y);
        }
      }
    for (const o of sim.trams) if (o !== t && check(o.x, o.y, 1.2)) blocked = true;
    t.blocked = blocked;
    t.update(dt);
  }
}
