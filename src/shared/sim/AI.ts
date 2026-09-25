// NPC behaviour: spawning/despawning traffic, parked cars, pedestrians and trams around every player,
// traffic driving on the road graph, pedestrians walking the footpaths, police pursuit (A*) of wanted
// players, and cops on foot.
import { Vehicle, SPECS, type VehicleKind } from '../entities/Vehicle';
import { Ped } from '../entities/Ped';
import { Tram } from '../entities/Tram';
import { Graph, linkPoints, type Link } from '../world/Graph';
import { angleDiff, bboxOf, clamp, dist } from '../util/math';
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
}

const TRAFFIC_MIX: [VehicleKind, number][] = [
  ['hatch', 30], ['sedan', 30], ['taxi', 8], ['van', 8], ['bus', 6], ['sport', 4], ['classic', 3],
];
const PARKED_MIX: [VehicleKind, number][] = [['hatch', 35], ['sedan', 35], ['van', 8], ['sport', 6], ['classic', 6], ['taxi', 5]];

const laneOffset = (l: Link) => (l.edge.oneway ? 0 : Math.min(l.edge.width / 4, 1.9));
const EMPTY_PEDS: Ped[] = [];
const COPS_WANTED = [0, 2, 3, 5, 7, 9];

// count-grid categories
const C_TRAFFIC = 0, C_PARKED = 1, C_PEDS = 2, C_TRAMS = 3;

export class AI {
  drivers = new Map<Vehicle, Driver>();
  policeGraph: Graph;
  private spawnTimer = 0;
  private retire = new Set<Vehicle>();
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
    // Police chase over every street and footway (cars fit through the Old Town), preferring real roads.
    this.policeGraph = new Graph(sim.world.data.graph.ped, false, (e) => e.len * (e.cls <= 5 ? 1 : e.cls <= 7 ? 1.3 : e.cls === 8 ? 1.8 : 3));
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
      } else if (d.mode === 'police') this.drivePolice(v, d, dt);
    }
    for (const p of sim.peds) {
      if (p.kinematic || p.playerId) continue;
      if (p.vehicle || p.dead || p.state === 'chase' || p.state === 'flee') {
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
      const keep = near(v.x, v.y, (r, d) => d < r.far + 60 || (d < r.far + 200 && sim.visibleToAny(v.x, v.y, 20)));
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
    const pts = linkPoints(link, laneOffset(link));
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
      searchTarget: null, searchTimer: 0, target, retarget: 2,
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
    if (this.onScreen(w.car.nx(n), w.car.ny(n), 8)) return false;
    const links = w.car.out[n];
    const link = sim.rng.pick(links);
    let kind = sim.rng.weighted(TRAFFIC_MIX);
    if (kind === 'bus' && link.edge.cls > 4) kind = 'sedan';
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

  private spawnParked(x: number, y: number, rMin: number, rMax: number) {
    const sim = this.sim;
    const w = sim.world;
    const nodes = w.car.nodesAround(x, y, rMin, rMax);
    if (!nodes.length) return false;
    const n = sim.rng.pick(nodes);
    const link = w.car.out[n].find((l) => l.edge.cls >= 4 && l.edge.len > 20);
    if (!link) return false;
    const pts = linkPoints(link, link.edge.width / 2 - 1.1);
    if (pts.length < 4) return false;
    const t = sim.rng.range(0.2, 0.8);
    const x0 = pts[0] + (pts[2] - pts[0]) * t, y0 = pts[1] + (pts[3] - pts[1]) * t;
    if (this.onScreen(x0, y0, 5) || !this.freeSpot(x0, y0, 5) || w.insideBuilding(x0, y0)) return false;
    const kind = sim.rng.weighted(PARKED_MIX);
    const v = new Vehicle(kind, x0, y0, Math.atan2(pts[3] - pts[1], pts[2] - pts[0]), sim.rng.pick(SPECS[kind].colors));
    v.parked = true;
    sim.addVehicle(v);
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
    if (this.onScreen(px, py, 3)) return 0;
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
    const tram = new Tram(g, link, sim.rng);
    if (this.onScreen(tram.x, tram.y, 40)) return;
    sim.addTram(tram);
  }

  // ------------------------------------------------------------- driving
  private chooseNext(d: Driver, graph: Graph): Link | null {
    if (!d.link) return null;
    const node = d.link.to;
    if (d.route.length && (d.route[0].fwd ? d.route[0].edge.a : d.route[0].edge.b) === node) return d.route.shift()!;
    const opts = graph.out[node].filter((l) => l.edge !== d.link!.edge);
    if (!opts.length) return graph.out[node][0] ?? null;
    // prefer similar or bigger roads, avoid tiny service roads
    const weightedOpts: [Link, number][] = opts.map((l) => [l, l.edge.cls <= 5 ? 3 : l.edge.cls === 6 ? 1 : 0.4]);
    return this.sim.rng.weighted(weightedOpts);
  }

  private appendLink(d: Driver, link: Link) {
    const pts = linkPoints(link, d.mode === 'police' ? 0 : laneOffset(link));
    // trim consumed points
    if (d.idx > 6) {
      d.pts.splice(0, (d.idx - 2) * 2);
      d.idx = 2;
    }
    d.pts.push(...pts.slice(2));
    d.link = link;
  }

  private drive(v: Vehicle, d: Driver, dt: number, chase: boolean) {
    const sim = this.sim;
    const graph = d.mode === 'police' ? this.policeGraph : sim.world.car;
    // advance target point
    const look = 3 + Math.abs(v.fwdSpeed) * 0.35;
    while (d.idx * 2 < d.pts.length && dist(v.x, v.y, d.pts[d.idx * 2], d.pts[d.idx * 2 + 1]) < look) d.idx++;
    if (d.idx * 2 >= d.pts.length - 2) {
      const next = this.chooseNext(d, graph);
      if (next) this.appendLink(d, next);
      if (d.idx * 2 >= d.pts.length) d.idx = d.pts.length / 2 - 1;
    }
    const tx = d.pts[d.idx * 2], ty = d.pts[d.idx * 2 + 1];
    const want = Math.atan2(ty - v.y, tx - v.x);
    let diff = angleDiff(v.angle, want);
    // corner speed: look further ahead
    const j = Math.min(d.idx + 2, d.pts.length / 2 - 1);
    const ahead = Math.atan2(d.pts[j * 2 + 1] - ty, d.pts[j * 2] - tx);
    const corner = Math.abs(angleDiff(v.angle, ahead));
    let desired = chase ? Math.max(10, (d.link?.edge.speed ?? 10) * 1.6) : (d.link?.edge.speed ?? 10) * 0.75;
    if (corner > 0.5) desired = Math.min(desired, chase ? 12 : 6);
    if (Math.abs(diff) > 0.9) desired = Math.min(desired, 4);
    if (!chase) desired = Math.min(desired, v.spec.maxSpeed * 0.5);

    // civilian traffic reacts to nearby gunfire/explosions and to a siren closing in from behind
    if (!chase && sim.anyWanted) {
      const danger = sim.police.nearestDanger(v.x, v.y, 22);
      if (danger) {
        desired = Math.min(v.spec.maxSpeed * 0.85, Math.max(desired, desired * 1.8 + 4));
        const away = Math.atan2(v.y - danger.y, v.x - danger.x);
        diff += angleDiff(v.angle, away) * 0.2;
        if (sim.rng.chance(dt * 1.5)) v.horn = 0.5;
      } else if (this.sirenBehind(v)) {
        desired *= 0.35;
        diff += 0.25;
      }
    }

    // police in pursuit shove through traffic instead of queueing
    const obstacle = chase ? null : this.obstacleAhead(v, 4 + Math.abs(v.fwdSpeed) * 1.1, false);
    if (obstacle) {
      desired = 0;
      if (obstacle === 'player' && !chase && sim.rng.chance(dt * 0.4)) v.horn = 0.6;
    }
    this.steerTo(v, d, diff, desired, dt, obstacle !== null);
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
    }
  }

  obstacleAhead(v: Vehicle, range: number, chase: boolean): 'player' | 'other' | null {
    const sim = this.sim;
    const fx = Math.cos(v.angle), fy = Math.sin(v.angle);
    const front = v.spec.length / 2;
    const test = (x: number, y: number, r: number) => {
      const dx = x - v.x, dy = y - v.y;
      const lon = dx * fx + dy * fy - front;
      const lat = Math.abs(-dx * fy + dy * fx);
      return lon > -0.5 && lon < range && lat < v.spec.width / 2 + r + 0.4;
    };
    let res: 'player' | 'other' | null = null;
    const cx = v.x + fx * (front + range / 2), cy = v.y + fy * (front + range / 2);
    const qr = range / 2 + 8;
    sim.forVehiclesNear(cx, cy, qr, (o) => {
      if (res === 'player' || o === v) return;
      if (Math.abs(o.x - v.x) > range + 8 || Math.abs(o.y - v.y) > range + 8) return;
      if (test(o.x, o.y, o.spec.width / 2)) {
        if (chase && o.isPlayer) return;
        res = o.isPlayer ? 'player' : res ?? 'other';
      }
    });
    if (res) return res;
    if (!chase) {
      for (const p of sim.pedsNear(cx, cy, qr)) {
        if (p.vehicle || p.dead) continue;
        if (Math.abs(p.x - v.x) > range + 3 || Math.abs(p.y - v.y) > range + 3) continue;
        if (test(p.x, p.y, 0.4)) return p.playerId ? 'player' : 'other';
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
    const los = dd < 55 && sim.world.raycast(v.x, v.y, real.x, real.y) >= 1;
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
    this.setPedLink(p, this.sim.rng.pick(out));
  }

  private setPedLink(p: Ped, l: Link) {
    const e = l.edge;
    const off = e.cls <= 7 ? e.width / 2 + 1.4 : Math.min(0.6, e.width / 3);
    p.link = l;
    p.pts = linkPoints(l, off * p.side);
    p.idx = 0;
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
    // civilians near an armed cop put their hands up
    if (p.kind === 'civ') {
      let near = false;
      for (const c of this.armedCops)
        if (dist(p.x, p.y, c.x, c.y) < 6) {
          near = true;
          break;
        }
      if (near !== p.handsUp) p.handsUp = near;
    }
    // walking groups: follow the leader at a fixed offset instead of navigating independently
    const fo = this.followers.get(p);
    if (fo && p.state === 'walk') {
      if (fo.leader.dead || fo.leader.vehicle) this.followers.delete(p);
      else {
        const tx = fo.leader.x + fo.ox, ty = fo.leader.y + fo.oy;
        const d = dist(p.x, p.y, tx, ty) || 1e-3;
        const sp = Math.min(fo.leader.speed * 1.15, d * 3);
        p.move(dt, sim.world, ((tx - p.x) / d) * sp, ((ty - p.y) / d) * sp);
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
    if (p.state === 'flee') {
      p.timer -= dt;
      const dx = p.x - p.fleeFrom.x, dy = p.y - p.fleeFrom.y;
      const l = Math.hypot(dx, dy) || 1;
      p.move(dt, sim.world, (dx / l) * 4.6, (dy / l) * 4.6);
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
      if (p.idx * 2 >= p.pts.length) {
        const opts = sim.world.ped.out[p.link.to].filter((l) => l.edge !== p.link!.edge);
        const next = opts.length ? rng.pick(opts) : sim.world.ped.out[p.link.to][0];
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
    // avoid walking into cars (they stop), simple wait
    const stuck = p.move(dt, sim.world, ((tx - p.x) / d) * p.speed, ((ty - p.y) / d) * p.speed);
    if (stuck) {
      p.timer += dt;
      if (p.timer > 3) {
        p.timer = 0;
        p.idx++;
        if (p.idx * 2 >= p.pts.length) p.link = null;
      }
    }
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
    const los = d < 30 && sim.world.raycast(p.x, p.y, tx, ty) >= 1;
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
