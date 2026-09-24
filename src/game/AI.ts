import type { Game } from './Game';
import { Vehicle, type VehicleKind } from '../entities/Vehicle';
import { Ped } from '../entities/Ped';
import { Tram } from '../entities/Tram';
import { Graph, linkPoints, type Link } from '../world/Graph';
import { angleDiff, bboxOf, clamp, dist, pick, rand } from '../util/math';

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
  /** police search pattern: a random point inside game.searchZone this cop is currently driving to */
  searchTarget: { x: number; y: number } | null;
  searchTimer: number;
}

const TRAFFIC_MIX: [VehicleKind, number][] = [
  ['hatch', 30], ['sedan', 30], ['taxi', 8], ['van', 8], ['bus', 6], ['sport', 4], ['classic', 3],
];
const PARKED_MIX: [VehicleKind, number][] = [['hatch', 35], ['sedan', 35], ['van', 8], ['sport', 6], ['classic', 6], ['taxi', 5]];

function weighted<T>(list: [T, number][]): T {
  const total = list.reduce((s, [, w]) => s + w, 0);
  let r = Math.random() * total;
  for (const [v, w] of list) if ((r -= w) <= 0) return v;
  return list[0][0];
}

const laneOffset = (l: Link) => (l.edge.oneway ? 0 : Math.min(l.edge.width / 4, 1.9));
const EMPTY_PEDS: Ped[] = [];

export class AI {
  drivers = new Map<Vehicle, Driver>();
  policeGraph: Graph;
  private spawnTimer = 0;
  private retire = new Set<Vehicle>();
  private warm = false;
  /** walking groups: follower -> leader + fixed offset (WeakMap so despawned peds can be GC'd) */
  private followers = new WeakMap<Ped, { leader: Ped; ox: number; oy: number }>();
  /** pedestrian/landmark spawn hotspots, built lazily */
  private hotspots: { x: number; y: number }[] | null = null;
  /** AI LOD: per-frame counter + stable per-entity ids + accumulated skipped dt */
  private frameCount = 0;
  private lodIds = new WeakMap<object, number>();
  private lodNextId = 1;
  private lodAcc = new WeakMap<object, number>();
  /** cops (on foot) armed this frame, cached once per AI.update() for cheap ped-panic checks */
  private armedCops: Ped[] = [];

  constructor(private game: Game) {
    // Police chase over every street and footway (cars fit through the Old Town),
    // preferring real roads.
    this.policeGraph = new Graph(game.world.data.graph.ped, false, (e) => e.len * (e.cls <= 5 ? 1 : e.cls <= 7 ? 1.3 : e.cls === 8 ? 1.8 : 3));
  }

  /** ~city-feel target counts: base density scaled by render quality and time of day. */
  effectiveDensity() {
    const g = this.game;
    const q = g.quality === 0 ? 0.6 : 1;
    const h = g.atmos.time;
    const rush = (h >= 7 && h < 9) || (h >= 16 && h < 18);
    const night = h >= 23 || h < 5;
    const d = g.density;
    return {
      traffic: Math.round(d.traffic * q * (rush ? 1.3 : night ? 0.7 : 1)),
      parked: Math.round(d.parked * q),
      peds: Math.round(d.peds * q * (night ? 0.6 : 1)),
      trams: Math.max(1, Math.round(d.trams * q)),
    };
  }

  /** Entities far from the camera think less often; returns the dt to simulate with, or
   *  null to skip this frame entirely (the skipped time is folded into the next update). */
  private lodDt(o: object, x: number, y: number, dt: number): number | null {
    const g = this.game;
    const d = dist(x, y, g.cam.x, g.cam.y);
    if (d < 150) return dt;
    const period = d < 280 ? 2 : 3;
    let id = this.lodIds.get(o);
    if (id === undefined) (id = this.lodNextId++), this.lodIds.set(o, id);
    const acc = (this.lodAcc.get(o) ?? 0) + dt;
    if ((this.frameCount + id) % period !== 0) {
      this.lodAcc.set(o, acc);
      return null;
    }
    this.lodAcc.set(o, 0);
    return acc;
  }

  // ------------------------------------------------------------ spawning
  update(dt: number) {
    this.frameCount++;
    this.spawnTimer -= dt;
    if (this.spawnTimer <= 0) {
      this.spawnTimer = 0.25;
      this.populate();
    }
    const g = this.game;
    this.armedCops = g.wanted >= 3 || g.playerShotCops ? g.peds.filter((p) => p.kind === 'cop' && !p.dead && !p.vehicle) : EMPTY_PEDS;
    for (const [v, d] of this.drivers) {
      if (v.wrecked || v.sinking || v.isPlayer || !v.driver || v.driver.dead) {
        if (d.mode !== 'parked') v.setControls(0, 0, true);
        continue;
      }
      if (d.mode === 'traffic') {
        if (g.wanted > 0 && this.checkPanic(v, d, dt)) continue;
        const eff = this.lodDt(v, v.x, v.y, dt);
        if (eff !== null) this.drive(v, d, eff, false);
      } else if (d.mode === 'police') this.drivePolice(v, d, dt);
    }
    for (const p of this.game.peds) {
      if (p === this.game.player || p.vehicle || p.dead || p.state === 'chase' || p.state === 'flee') {
        this.updatePed(p, dt);
        continue;
      }
      const eff = this.lodDt(p, p.x, p.y, dt);
      if (eff !== null) this.updatePed(p, eff);
    }
    for (const t of this.game.trams) this.updateTram(t, dt);
  }

  private viewRadius() {
    const g = this.game;
    return Math.hypot(g.viewW, g.viewH) / 2 / g.cam.scale;
  }

  private populate() {
    const g = this.game;
    const { x, y } = g.focus();
    const vr = this.viewRadius();
    const far = Math.max(260, vr + 90);

    // despawn
    g.vehicles = g.vehicles.filter((v) => {
      if (v.isPlayer || v.mission) return true;
      if (this.retire.has(v)) {
        this.retire.delete(v);
        if (v.driver) g.peds = g.peds.filter((p) => p !== v.driver);
        this.drivers.delete(v);
        return false;
      }
      const d = dist(v.x, v.y, x, y);
      const keep = d < far + 60 || (d < far + 200 && this.onScreen(v.x, v.y, 20));
      if (!keep) {
        if (v.driver && v.driver !== g.player) g.peds = g.peds.filter((p) => p !== v.driver);
        this.drivers.delete(v);
      }
      return keep;
    });
    g.peds = g.peds.filter((p) => p === g.player || p.vehicle || dist(p.x, p.y, x, y) < 200 || (p.dead && dist(p.x, p.y, x, y) < 260));
    g.trams = g.trams.filter((t) => dist(t.x, t.y, x, y) < far + 150);

    const traffic = g.vehicles.filter((v) => this.drivers.get(v)?.mode === 'traffic').length;
    const parked = g.vehicles.filter((v) => v.parked).length;
    const peds = g.peds.filter((p) => p.kind === 'civ' && !p.vehicle && !p.dead).length;
    const density = this.effectiveDensity();

    if (traffic < density.traffic) this.spawnTraffic(x, y, vr + 25, far);
    if (parked < density.parked) this.spawnParked(x, y, vr + 10, far - 40);
    if (peds < density.peds) this.spawnPed(x, y, vr + 5, 170);
    if (g.trams.length < density.trams) this.spawnTram(x, y, vr + 40, far + 100);
    this.policeSpawn(x, y, vr);
  }

  onScreen(x: number, y: number, pad = 0) {
    const g = this.game;
    if (this.warm) return false;
    const hw = g.viewW / 2 / g.cam.scale + pad, hh = g.viewH / 2 / g.cam.scale + pad;
    return Math.abs(x - g.cam.x) < hw && Math.abs(y - g.cam.y) < hh;
  }

  private freeSpot(x: number, y: number, r: number) {
    for (const v of this.game.vehicles) if (dist(v.x, v.y, x, y) < r + v.radius) return false;
    for (const t of this.game.trams) if (t.hits(x, y, r)) return false;
    return true;
  }

  spawnOnLink(kind: VehicleKind, link: Link, mode: Driver['mode']) {
    const pts = linkPoints(link, laneOffset(link));
    const x = pts[0], y = pts[1];
    if (!this.freeSpot(x, y, 4)) return null;
    const v = new Vehicle(kind, x, y, Math.atan2(pts[3] - pts[1], pts[2] - pts[0]));
    const driver = new Ped(mode === 'police' ? 'cop' : 'civ', x, y);
    driver.vehicle = v;
    v.driver = driver;
    this.game.vehicles.push(v);
    this.game.peds.push(driver);
    const d: Driver = { mode, link, pts, idx: 1, route: [], repath: 0, stuck: 0, reverse: 0, direct: false, best: Infinity, noProgress: 0, searchTarget: null, searchTimer: 0 };
    this.drivers.set(v, d);
    const sp = Math.min(link.edge.speed * 0.6, 9);
    v.vx = Math.cos(v.angle) * sp;
    v.vy = Math.sin(v.angle) * sp;
    return v;
  }

  private spawnTraffic(x: number, y: number, rMin: number, rMax: number) {
    const w = this.game.world;
    const nodes = w.car.nodesAround(x, y, rMin, rMax);
    if (!nodes.length) return;
    const n = pick(nodes);
    if (this.onScreen(w.car.nx(n), w.car.ny(n), 8)) return;
    const links = w.car.out[n];
    const link = pick(links);
    let kind = weighted(TRAFFIC_MIX);
    if (kind === 'bus' && link.edge.cls > 4) kind = 'sedan';
    this.spawnOnLink(kind, link, 'traffic');
  }

  /** Fill the surroundings immediately (game start / respawn), on-screen included. */
  prewarm() {
    const { x, y } = this.game.focus();
    this.warm = true;
    const g = this.game;
    const density = this.effectiveDensity();
    const count = (f: () => number, max: number, spawn: () => void) => {
      for (let i = 0; i < max + 40 && f() < max; i++) spawn();
    };
    count(() => g.peds.filter((p) => p.kind === 'civ' && !p.vehicle).length, density.peds, () => this.spawnPed(x, y, 4, 150));
    count(() => g.vehicles.filter((v) => v.parked).length, density.parked, () => this.spawnParked(x, y, 8, 200));
    count(() => [...this.drivers.values()].filter((d) => d.mode === 'traffic').length, density.traffic, () => this.spawnTraffic(x, y, 20, 240));
    this.warm = false;
  }

  private spawnParked(x: number, y: number, rMin: number, rMax: number) {
    const w = this.game.world;
    const nodes = w.car.nodesAround(x, y, rMin, rMax);
    if (!nodes.length) return;
    const n = pick(nodes);
    const link = w.car.out[n].find((l) => l.edge.cls >= 4 && l.edge.len > 20);
    if (!link) return;
    const pts = linkPoints(link, link.edge.width / 2 - 1.1);
    if (pts.length < 4) return;
    const t = rand(0.2, 0.8);
    const x0 = pts[0] + (pts[2] - pts[0]) * t, y0 = pts[1] + (pts[3] - pts[1]) * t;
    if (this.onScreen(x0, y0, 5) || !this.freeSpot(x0, y0, 5) || w.insideBuilding(x0, y0)) return;
    const v = new Vehicle(weighted(PARKED_MIX), x0, y0, Math.atan2(pts[3] - pts[1], pts[2] - pts[0]));
    v.parked = true;
    this.game.vehicles.push(v);
  }

  /** landmarks, shops and Old-Town squares: pedestrians spawn biased towards these. */
  private getHotspots() {
    if (this.hotspots) return this.hotspots;
    const w = this.game.world;
    const pts: { x: number; y: number }[] = [];
    for (const l of w.landmarks.values()) pts.push({ x: l.x, y: l.y });
    for (const p of w.pois('shop')) pts.push({ x: p.x, y: p.y });
    for (const rings of w.data.areas.plaza) {
      const bb = bboxOf(rings[0]);
      pts.push({ x: (bb.x0 + bb.x1) / 2, y: (bb.y0 + bb.y1) / 2 });
    }
    return (this.hotspots = pts);
  }

  spawnPed(x: number, y: number, rMin: number, rMax: number) {
    const w = this.game.world;
    let cx = x, cy = y, rm = rMin, rM = rMax, hot = false;
    if (Math.random() < 0.4) {
      const spots = this.getHotspots().filter((h) => dist(h.x, h.y, x, y) < rMax + 45);
      if (spots.length) {
        const h = pick(spots);
        (cx = h.x), (cy = h.y), (rm = 0), (rM = 30), (hot = true);
      }
    }
    const nodes = w.ped.nodesAround(cx, cy, rm, rM);
    if (!nodes.length) return;
    const n = pick(nodes);
    const px = w.ped.nx(n), py = w.ped.ny(n);
    if (this.onScreen(px, py, 3)) return;
    const p = new Ped('civ', px, py);
    this.startWalk(p, n);
    this.game.peds.push(p);
    if (!hot) return;
    // near a hotspot: sometimes a knot of people chatting, sometimes a small walking group
    const r = Math.random();
    if (r < 0.15) {
      p.state = 'idle';
      p.timer = rand(4, 10);
      p.link = null;
    } else if (r < 0.35) {
      const size = 1 + ((Math.random() * 3) | 0);
      for (let i = 0; i < size; i++) {
        const a = Math.random() * Math.PI * 2, off = 0.5 + Math.random() * 0.7;
        const f = new Ped('civ', px + Math.cos(a) * off, py + Math.sin(a) * off);
        this.followers.set(f, { leader: p, ox: Math.cos(a) * off, oy: Math.sin(a) * off });
        this.game.peds.push(f);
      }
    }
  }

  private spawnTram(x: number, y: number, rMin: number, rMax: number) {
    const g = this.game.world.tram;
    const nodes = g.nodesAround(x, y, rMin, rMax);
    if (!nodes.length) return;
    const n = pick(nodes);
    if (this.onScreen(g.nx(n), g.ny(n), 40)) return;
    const link = pick(g.out[n]);
    if (link.edge.len < 30) return;
    for (const t of this.game.trams) if (dist(t.x, t.y, g.nx(n), g.ny(n)) < 80) return;
    const tram = new Tram(g, link);
    if (this.onScreen(tram.x, tram.y, 40)) return;
    this.game.trams.push(tram);
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
    return weighted(weightedOpts);
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
    const g = this.game;
    const graph = d.mode === 'police' ? this.policeGraph : g.world.car;
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
    if (!chase && g.wanted > 0) {
      const danger = g.police.nearestDanger(v.x, v.y, 22);
      if (danger) {
        desired = Math.min(v.spec.maxSpeed * 0.85, Math.max(desired, desired * 1.8 + 4));
        const away = Math.atan2(v.y - danger.y, v.x - danger.x);
        diff += angleDiff(v.angle, away) * 0.2;
        if (Math.random() < dt * 1.5) v.horn = 0.5;
      } else if (this.sirenBehind(v)) {
        desired *= 0.35;
        diff += 0.25;
      }
    }

    // police in pursuit shove through traffic instead of queueing
    const obstacle = chase ? null : this.obstacleAhead(v, 4 + Math.abs(v.fwdSpeed) * 1.1, false);
    if (obstacle) {
      desired = 0;
      if (obstacle === 'player' && !chase && Math.random() < dt * 0.4) v.horn = 0.6;
    }
    this.steerTo(v, d, diff, desired, dt, obstacle !== null);
  }

  /** is a siren-on police car (not the player) closing in from behind this traffic car? */
  private sirenBehind(v: Vehicle): boolean {
    for (const o of this.game.vehicles) {
      if (o === v || o.kind !== 'police' || !o.siren || o.isPlayer) continue;
      const dx = o.x - v.x, dy = o.y - v.y;
      const d2 = dx * dx + dy * dy;
      if (d2 > 256) continue;
      const behind = -(dx * Math.cos(v.angle) + dy * Math.sin(v.angle));
      if (behind > 1.5) return true;
    }
    return false;
  }

  /** civilian traffic very close to gunfire/an explosion sometimes bails out and flees on foot */
  private checkPanic(v: Vehicle, d: Driver, dt: number): boolean {
    if (v.kind === 'police' || !v.driver || v.driver === this.game.player) return false;
    const danger = this.game.police.nearestDanger(v.x, v.y, 9);
    if (!danger || Math.random() > dt * 3) return false;
    const g = this.game;
    const drv = v.driver;
    drv.vehicle = null;
    v.driver = null;
    drv.x = v.x - Math.sin(v.angle) * 1.6;
    drv.y = v.y + Math.cos(v.angle) * 1.6;
    g.combat.scare(drv, danger.x, danger.y);
    this.drivers.delete(v);
    v.setControls(0, 0, true);
    void d;
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
    const g = this.game;
    const fx = Math.cos(v.angle), fy = Math.sin(v.angle);
    const front = v.spec.length / 2;
    const test = (x: number, y: number, r: number) => {
      const dx = x - v.x, dy = y - v.y;
      const lon = dx * fx + dy * fy - front;
      const lat = Math.abs(-dx * fy + dy * fx);
      return lon > -0.5 && lon < range && lat < v.spec.width / 2 + r + 0.4;
    };
    for (const o of g.vehicles) {
      if (o === v) continue;
      if (Math.abs(o.x - v.x) > range + 8 || Math.abs(o.y - v.y) > range + 8) continue;
      if (test(o.x, o.y, o.spec.width / 2)) {
        if (chase && o.isPlayer) return null;
        return o.isPlayer ? 'player' : 'other';
      }
    }
    if (!chase) {
      for (const p of g.peds) {
        if (p.vehicle || p.dead) continue;
        if (Math.abs(p.x - v.x) > range + 3 || Math.abs(p.y - v.y) > range + 3) continue;
        if (test(p.x, p.y, 0.4)) return p === g.player ? 'player' : 'other';
      }
    }
    for (const t of g.trams)
      for (const s of t.sections) if (dist(s.x, s.y, v.x, v.y) < range + 8 && test(s.x, s.y, 1.2)) return 'other';
    return null;
  }

  // --------------------------------------------------------------- police
  private policeSpawn(x: number, y: number, vr: number) {
    const g = this.game;
    const stars = Math.ceil(g.wanted - 0.01);
    const want = stars <= 0 ? 0 : [0, 2, 3, 5, 7, 9][stars];
    const cops = g.vehicles.filter((v) => this.drivers.get(v)?.mode === 'police' && v.driver && !v.driver.dead && !v.wrecked).length;
    if (cops >= want) return;
    const pg = this.policeGraph;
    const nodes = pg.nodesAround(x, y, vr + 25, vr + 90).filter((n) => pg.out[n].some((l) => l.edge.cls <= 6));
    if (!nodes.length) return;
    const n = pick(nodes);
    if (this.onScreen(this.policeGraph.nx(n), this.policeGraph.ny(n), 10)) return;
    const link = pick(pg.out[n].filter((l) => l.edge.cls <= 6));
    const swat = stars >= 5 && Math.random() < 0.4;
    const v = this.spawnOnLink(swat ? 'van' : 'police', link, 'police');
    if (v) {
      v.siren = true;
      if (swat) {
        v.color = '#1b1f2a';
        g.police.swat.add(v);
        if (v.driver) v.driver.outfit = 'swat';
      }
    }
  }

  private drivePolice(v: Vehicle, d: Driver, dt: number) {
    const g = this.game;
    if (g.wanted <= 0) {
      // back to normal patrol
      v.siren = false;
      d.route = [];
      d.searchTarget = null;
      this.drive(v, d, dt, false);
      return;
    }
    v.siren = true;
    const real = g.focus();
    const dd = dist(v.x, v.y, real.x, real.y);
    // a cop that stops closing in while off-screen is recycled by the spawner
    if (dd < d.best - 5) (d.best = dd), (d.noProgress = 0);
    else if ((d.noProgress += dt) > 10 && !this.onScreen(v.x, v.y, 20)) {
      this.retire.add(v);
      return;
    }
    const los = dd < 55 && g.world.raycast(v.x, v.y, real.x, real.y) >= 1;
    // no direct sight, and nobody else has either: hunt the last-known-position search zone
    // instead of homing straight in, so a driver who breaks line of sight can actually lose them
    const zone = g.searchZone;
    const searching = !los && !!zone;
    let target = real;
    if (searching) {
      if (!d.searchTarget || d.searchTimer <= 0 || dist(v.x, v.y, d.searchTarget.x, d.searchTarget.y) < 10) {
        const a = Math.random() * Math.PI * 2, r = Math.random() * zone!.r;
        d.searchTarget = { x: zone!.x + Math.cos(a) * r, y: zone!.y + Math.sin(a) * r };
        d.searchTimer = rand(6, 11);
      }
      d.searchTimer -= dt;
      target = d.searchTarget;
    } else d.searchTarget = null;

    // end of the route (target is off-network): go straight for the suspect
    const close = !searching && !d.route.length && dd < 70 && d.idx * 2 >= d.pts.length - 2;
    if (los || close) {
      d.direct = true;
      const stars = Math.ceil(g.wanted - 0.01);
      const playerVeh = g.player.vehicle;
      const swat = g.police.swat.has(v);
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
    const g = this.game;
    const d = this.drivers.get(v);
    if (!d || d.mode !== 'police' || !v.driver) return;
    d.mode = 'idle';
    v.setControls(0, 0, true);
    const cop = v.driver;
    cop.vehicle = null;
    v.driver = null;
    const side = Math.random() < 0.5 ? 1 : -1;
    cop.x = v.x - Math.sin(v.angle) * 1.6 * side;
    cop.y = v.y + Math.cos(v.angle) * 1.6 * side;
    cop.state = 'chase';
    if (Math.random() < 0.7) {
      const cop2 = new Ped('cop', v.x + Math.sin(v.angle) * 1.6 * side, v.y - Math.cos(v.angle) * 1.6 * side);
      cop2.state = 'chase';
      g.peds.push(cop2);
    }
  }

  // --------------------------------------------------------- pedestrians
  startWalk(p: Ped, node: number) {
    const graph = this.game.world.ped;
    const out = graph.out[node];
    if (!out.length) return;
    this.setPedLink(p, pick(out));
  }

  private setPedLink(p: Ped, l: Link) {
    const e = l.edge;
    const off = e.cls <= 7 ? (e.width / 2 + 1.4) : Math.min(0.6, e.width / 3);
    p.link = l;
    p.pts = linkPoints(l, off * p.side);
    p.idx = 0;
  }

  private updatePed(p: Ped, dt: number) {
    const g = this.game;
    if (p === g.player || p.vehicle) return;
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
      for (const c of this.armedCops) if (dist(p.x, p.y, c.x, c.y) < 6) { near = true; break; }
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
        p.move(dt, g.world, ((tx - p.x) / d) * sp, ((ty - p.y) / d) * sp);
        return;
      }
    }
    // idle: standing still (chatting knot, or briefly waiting at a crossing)
    if (p.state === 'idle') {
      p.timer -= dt;
      if (p.timer <= 0) {
        p.state = 'walk';
        if (!p.link) {
          const n = g.world.ped.nearest(p.x, p.y, 60);
          if (n >= 0) this.startWalk(p, n);
        }
      }
      return;
    }
    if (p.cooldown > 0) p.cooldown -= dt;
    if (p.kind === 'cop' && (p.state === 'chase' || g.wanted > 0)) return this.copOnFoot(p, dt);
    if (p.state === 'flee') {
      p.timer -= dt;
      const dx = p.x - p.fleeFrom.x, dy = p.y - p.fleeFrom.y;
      const l = Math.hypot(dx, dy) || 1;
      p.move(dt, g.world, (dx / l) * 4.6, (dy / l) * 4.6);
      // panic cascade: scare nearby civilians too, with a cooldown so it doesn't loop forever
      if (p.kind === 'civ' && p.cooldown <= 0) {
        p.cooldown = 1.2;
        let spread = false;
        for (const q of g.peds) {
          if (q === p || q.kind !== 'civ' || q.dead || q.vehicle || q.state === 'flee') continue;
          if (dist(p.x, p.y, q.x, q.y) < 8) {
            g.combat.scare(q, p.fleeFrom.x, p.fleeFrom.y);
            spread = true;
          }
        }
        if (spread && Math.random() < 0.3) g.audio.scream();
      }
      if (p.timer <= 0) {
        p.state = 'walk';
        const n = g.world.ped.nearest(p.x, p.y, 80);
        p.link = null;
        if (n >= 0) {
          this.startWalk(p, n);
          p.pts = [g.world.ped.nx(n), g.world.ped.ny(n), ...p.pts];
        }
      }
      return;
    }
    if (!p.link || !p.pts.length) {
      const n = g.world.ped.nearest(p.x, p.y, 80);
      if (n >= 0) this.startWalk(p, n);
      else p.move(dt, g.world, 0, 0);
      return;
    }
    const tx = p.pts[p.idx * 2], ty = p.pts[p.idx * 2 + 1];
    const d = dist(p.x, p.y, tx, ty);
    if (d < 0.8) {
      p.idx++;
      if (p.idx * 2 >= p.pts.length) {
        const opts = g.world.ped.out[p.link.to].filter((l) => l.edge !== p.link!.edge);
        const next = opts.length ? pick(opts) : g.world.ped.out[p.link.to][0];
        // briefly wait before stepping onto a road crossing
        if (next.edge.cls <= 6 && Math.random() < 0.3) {
          p.state = 'idle';
          p.timer = rand(0.4, 1.3);
        }
        this.setPedLink(p, next);
        if (Math.random() < 0.15) p.side = -p.side;
      }
      return;
    }
    // avoid walking into cars (they stop), simple wait
    const stuck = p.move(dt, g.world, ((tx - p.x) / d) * p.speed, ((ty - p.y) / d) * p.speed);
    if (stuck) {
      p.timer += dt;
      if (p.timer > 3) {
        p.timer = 0;
        p.idx++;
        if (p.idx * 2 >= p.pts.length) p.link = null;
      }
    }
  }

  private copOnFoot(p: Ped, dt: number) {
    const g = this.game;
    const pl = g.player;
    const tx = pl.vehicle ? pl.vehicle.x : pl.x, ty = pl.vehicle ? pl.vehicle.y : pl.y;
    const d = dist(p.x, p.y, tx, ty);
    if (g.wanted <= 0) {
      p.state = 'walk';
      p.kind = 'cop';
      p.link = null;
      return;
    }
    const los = d < 30 && g.world.raycast(p.x, p.y, tx, ty) >= 1;
    const armed = g.wanted >= 3 || g.playerShotCops;
    if (armed && los && d < 22) {
      // stop and shoot
      p.move(dt, g.world, 0, 0);
      p.angle = Math.atan2(ty - p.y, tx - p.x);
      if (p.cooldown <= 0) {
        p.cooldown = rand(0.7, 1.3);
        g.combat.fire(p, p.angle, 'pistol');
      }
      return;
    }
    if (d > 1.1) {
      const sp = p.speed * (pl.vehicle ? 0.8 : 1);
      p.move(dt, g.world, ((tx - p.x) / d) * sp, ((ty - p.y) / d) * sp);
    }
    // busted when touching the player on foot (or stopped car)
    const stopped = !pl.vehicle || pl.vehicle.speed < 1.2;
    if (d < (pl.vehicle ? pl.vehicle.radius + 0.6 : 1.3) && stopped && !armed) {
      p.bustTimer += dt;
      if (p.bustTimer > (pl.vehicle ? 1.6 : 0.8)) g.bust();
    } else p.bustTimer = Math.max(0, p.bustTimer - dt);
  }

  // ---------------------------------------------------------------- trams
  private updateTram(t: Tram, dt: number) {
    const g = this.game;
    const fx = Math.cos(t.angle), fy = Math.sin(t.angle);
    let blocked = false;
    const check = (x: number, y: number, r: number) => {
      const dx = x - t.x, dy = y - t.y;
      const lon = dx * fx + dy * fy;
      const lat = Math.abs(-dx * fy + dy * fx);
      return lon > -1 && lon < 5 + t.speed * 1.2 && lat < 1.3 + r;
    };
    for (const v of g.vehicles) if (!v.wrecked && Math.abs(v.x - t.x) < 25 && Math.abs(v.y - t.y) < 25 && check(v.x, v.y, v.spec.width / 2)) blocked = true;
    for (const p of g.peds) if (!p.vehicle && !p.dead && Math.abs(p.x - t.x) < 20 && Math.abs(p.y - t.y) < 20 && check(p.x, p.y, 0.3)) {
      blocked = true;
      if (p === g.player && t.bell <= 0) {
        t.bell = 2;
        g.audio.bell();
      }
    }
    for (const o of g.trams) if (o !== t && check(o.x, o.y, 1.2)) blocked = true;
    t.blocked = blocked;
    t.update(dt);
  }
}
