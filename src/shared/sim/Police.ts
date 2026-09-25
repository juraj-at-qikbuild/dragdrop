// Everything that makes the city react to wanted players: per-player roadblocks, spike strips and the
// pursuit helicopter (capped world-wide), SWAT marking, and the "danger" events traffic/peds panic around.
import { Vehicle } from '../entities/Vehicle';
import { Ped } from '../entities/Ped';
import { Prop, propHit } from '../entities/Props';
import { Helicopter } from '../entities/Helicopter';
import { linkPoints } from '../world/Graph';
import { dist } from '../util/math';
import type { Sim } from './Sim';
import type { Roadblock, SimPlayer } from './SimPlayer';

export class Police {
  /** vehicles marked as SWAT (dark livery, heavier ramming, swat-outfit driver) */
  swat = new WeakSet<Vehicle>();
  /** roadblock barriers and spike strips of every player's pursuit */
  props: Prop[] = [];
  /** recent gunfire/explosion events: traffic swerves + speeds up, peds may bail/flee near them */
  dangerEvents: { x: number; y: number; r: number; t: number }[] = [];

  constructor(private sim: Sim) {}

  /** Call from crimes (and where a player fires) to make the street react. */
  danger(x: number, y: number, radius: number) {
    this.dangerEvents.push({ x, y, r: radius, t: 2.5 });
  }

  nearestDanger(x: number, y: number, maxR: number) {
    let best: { x: number; y: number; r: number; t: number } | null = null, bd = maxR;
    for (const e of this.dangerEvents) {
      const d = dist(x, y, e.x, e.y);
      if (d < bd) (bd = d), (best = e);
    }
    return best;
  }

  /** every helicopter currently in the air */
  helis(): Helicopter[] {
    const out: Helicopter[] = [];
    for (const p of this.sim.players.values()) if (p.police.heli?.spawned) out.push(p.police.heli);
    return out;
  }

  update(dt: number) {
    for (const e of this.dangerEvents) e.t -= dt;
    if (this.dangerEvents.length) this.dangerEvents = this.dangerEvents.filter((e) => e.t > 0);
    for (const p of this.sim.players.values()) {
      const stars = p.state === 'play' ? p.stars : 0;
      this.updateHelicopter(p, dt, stars);
      this.updateRoadblocks(p, dt, stars);
      this.updateSpikes(p, dt, stars);
    }
    for (const p of this.props) p.age += dt;
    this.checkSpikeCollisions();
  }

  /** Clear a player's police escalation (respawn, leaving the game). */
  clear(p: SimPlayer) {
    for (const rb of p.police.roadblocks) this.removeRoadblock(rb);
    p.police.roadblocks = [];
    this.props = this.props.filter((pr) => pr.owner !== p.id);
    if (p.police.heli) p.police.heli.spawned = false;
    this.dangerEvents = [];
  }

  // --------------------------------------------------------------- helicopter
  private updateHelicopter(p: SimPlayer, dt: number, stars: number) {
    const sim = this.sim;
    const pp = p.police;
    if (stars >= 4) {
      if (!pp.heli) {
        if (this.helis().length >= sim.caps.helis) return;
        pp.heli = new Helicopter();
        pp.heli.targetPid = p.id;
      }
      const f = p.focus();
      const car = p.ped.vehicle;
      const target = { x: f.x, y: f.y, vx: car?.vx ?? 0, vy: car?.vy ?? 0, inCar: !!car };
      if (!pp.heli.spawned) {
        pp.heli.spawn(target);
        pp.heli.id = sim.ids.alloc(sim.time);
      }
      const h = pp.heli;
      h.update(dt, target, stars, () => sim.rng.next(), (a) => sim.combat.fireNpc({ id: 0, x: h.x, y: h.y, level: 0, vehicle: null }, a, 'uzi'));
    } else if (pp.heli?.spawned) pp.heli.spawned = false;
  }

  // --------------------------------------------------------------- roadblocks
  private updateRoadblocks(p: SimPlayer, dt: number, stars: number) {
    const sim = this.sim;
    const pp = p.police;
    pp.rbTimer -= dt;
    const car = p.ped.vehicle;
    if (stars >= 3 && pp.roadblocks.length < 2 && pp.rbTimer <= 0 && car && car.speed > 3 && this.roadblockCount() < sim.caps.roadblocks) {
      pp.rbTimer = sim.rng.range(10, 16);
      this.trySpawnRoadblock(p, stars >= 5);
    }
    const f = p.focus();
    const keep: Roadblock[] = [];
    for (const rb of pp.roadblocks) {
      rb.age += dt;
      const gone = rb.age > 60 || stars < 3 || dist(rb.x, rb.y, f.x, f.y) > 260;
      if (gone) this.removeRoadblock(rb);
      else keep.push(rb);
    }
    pp.roadblocks = keep;
  }

  private roadblockCount() {
    let n = 0;
    for (const p of this.sim.players.values()) n += p.police.roadblocks.length;
    return n;
  }

  /** Picks a car-graph edge ~150-250 m ahead along the player's heading, off everyone's screen. */
  private pickAheadLink(p: SimPlayer, rMin: number, rMax: number) {
    const sim = this.sim;
    const v = p.ped.vehicle;
    if (!v) return null;
    const heading = Math.hypot(v.vx, v.vy) > 1 ? Math.atan2(v.vy, v.vx) : v.angle;
    const f = p.focus();
    const hx = Math.cos(heading), hy = Math.sin(heading);
    const car = sim.world.car;
    const nodes = car.nodesAround(f.x, f.y, rMin, rMax);
    let best = -1, bestScore = 0.45;
    for (const n of nodes) {
      const nx = car.nx(n), ny = car.ny(n);
      const dx = nx - f.x, dy = ny - f.y;
      const d = Math.hypot(dx, dy) || 1;
      const dot = (dx / d) * hx + (dy / d) * hy;
      if (dot <= bestScore || sim.visibleToAny(nx, ny, 15)) continue;
      if (!car.out[n].some((l) => l.edge.cls <= 6 && l.edge.width > 5 && l.edge.len > 12)) continue;
      (bestScore = dot), (best = n);
    }
    if (best < 0) return null;
    return sim.rng.pick(car.out[best].filter((l) => l.edge.cls <= 6 && l.edge.width > 5 && l.edge.len > 12));
  }

  private trySpawnRoadblock(p: SimPlayer, swatTier: boolean) {
    const sim = this.sim;
    const link = this.pickAheadLink(p, 140, 260);
    if (!link) return;
    const pts = linkPoints(link);
    const mx = (pts[0] + pts[2]) / 2, my = (pts[1] + pts[3]) / 2;
    const ang = Math.atan2(pts[3] - pts[1], pts[2] - pts[0]);
    const across = ang + Math.PI / 2;
    const cax = Math.cos(across), cay = Math.sin(across);
    const fx = Math.cos(ang), fy = Math.sin(ang);
    const w = Math.max(5, link.edge.width);
    const rb: Roadblock = { cars: [], cops: [], props: [], age: 0, x: mx, y: my };
    for (const side of [-1, 1]) {
      const cx = mx + cax * w * 0.27 * side, cy = my + cay * w * 0.27 * side;
      const swat = swatTier && sim.rng.chance(0.5);
      const car = new Vehicle(swat ? 'van' : 'police', cx, cy, across + side * 0.2, swat ? '#1b1f2a' : '#f5f5f5');
      car.parked = true;
      car.siren = true;
      if (swat) this.swat.add(car);
      sim.addVehicle(car);
      rb.cars.push(car);
      const cop = new Ped('cop', cx + fx * 2.3, cy + fy * 2.3, sim.rng.seed());
      cop.angle = ang + Math.PI;
      cop.targetPid = p.id;
      if (swat) cop.outfit = 'swat';
      sim.addPed(cop);
      rb.cops.push(cop);
    }
    const barrier = new Prop('barrier', mx, my, ang, 0, w * 0.7, 70);
    barrier.owner = p.id;
    sim.addProp(barrier);
    rb.props.push(barrier);
    p.police.roadblocks.push(rb);
    const f = p.focus();
    if (dist(mx, my, f.x, f.y) < 400) sim.events.toPlayer(p.id, { k: 'msg', title: '', text: 'Polícia stavia zátaras!', time: 2.5, color: '#ff8a80' });
  }

  private removeRoadblock(rb: Roadblock) {
    const sim = this.sim;
    if (rb.cars.length) sim.vehicles = sim.vehicles.filter((v) => !rb.cars.includes(v) || v.isPlayer);
    if (rb.cops.length) sim.peds = sim.peds.filter((p) => !rb.cops.includes(p));
    if (rb.props.length) this.props = this.props.filter((p) => !rb.props.includes(p));
  }

  // --------------------------------------------------------------- spike strips
  private updateSpikes(p: SimPlayer, dt: number, stars: number) {
    const sim = this.sim;
    const pp = p.police;
    pp.spikeTimer -= dt;
    let active = 0;
    for (const pr of this.props) if (pr.kind === 'spike' && pr.owner === p.id) active++;
    const car = p.ped.vehicle;
    if (stars >= 4 && active < 2 && pp.spikeTimer <= 0 && car && car.speed > 3) {
      pp.spikeTimer = sim.rng.range(9, 15);
      this.trySpawnSpike(p);
    }
    const f = p.focus();
    this.props = this.props.filter((pr) => pr.kind !== 'spike' || pr.owner !== p.id || (pr.age < pr.life && dist(pr.x, pr.y, f.x, f.y) < 220));
  }

  private trySpawnSpike(p: SimPlayer) {
    const sim = this.sim;
    const link = this.pickAheadLink(p, 70, 160);
    if (!link) return;
    const pts = linkPoints(link);
    const mx = (pts[0] + pts[2]) / 2, my = (pts[1] + pts[3]) / 2;
    const ang = Math.atan2(pts[3] - pts[1], pts[2] - pts[0]);
    const strip = new Prop('spike', mx, my, ang, 0, Math.max(5, link.edge.width) * 0.9, 45);
    strip.owner = p.id;
    sim.addProp(strip);
    const f = p.focus();
    if (dist(mx, my, f.x, f.y) < 400) sim.events.toPlayer(p.id, { k: 'msg', title: '', text: 'Pozor, pásy s klincami!', time: 2.5, color: '#ffd740' });
  }

  private checkSpikeCollisions() {
    const sim = this.sim;
    for (const p of this.props) {
      if (p.kind !== 'spike' || !p.active) continue;
      sim.forVehiclesNear(p.x, p.y, p.len + 2, (v) => {
        // players' own cars are checked by their clients (spikeCheck), which simulate them
        if (!p.active || v.wrecked || v.kinematic || v.level !== p.level || v.tyresBurst) return;
        if (!spikeHit(p, v)) return;
        v.tyresBurst = 1;
        p.hits++;
        if (p.hits >= 3) p.active = false;
        if (v.owner) sim.events.toPlayer(v.owner, { k: 'msg', title: '', text: 'Klince prepichli pneumatiky!', time: 2.5, color: '#ff8a80' });
      });
    }
  }
}

/** does this car's footprint touch the spike strip? */
export function spikeHit(p: Prop, v: Vehicle) {
  if (Math.abs(v.x - p.x) > p.len + 2 || Math.abs(v.y - p.y) > p.len + 2) return false;
  return propHit(p, v.x, v.y, v.spec.width / 2);
}
