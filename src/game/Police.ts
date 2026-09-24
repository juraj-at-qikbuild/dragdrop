import type { Game } from './Game';
import { Vehicle } from '../entities/Vehicle';
import { Ped } from '../entities/Ped';
import { Prop, propHit } from '../entities/Props';
import { Helicopter } from '../entities/Helicopter';
import { linkPoints } from '../world/Graph';
import { dist, pick, rand } from '../util/math';

interface Roadblock {
  cars: Vehicle[];
  cops: Ped[];
  props: Prop[];
  age: number;
  x: number;
  y: number;
}

/** Owns everything that makes the city react to a wanted level: roadblocks, spike strips,
 *  the pursuit helicopter, SWAT marking, and the "danger" events traffic/peds panic around. */
export class Police {
  /** vehicles marked as SWAT (dark livery, heavier ramming, swat-outfit driver) */
  swat = new WeakSet<Vehicle>();
  props: Prop[] = [];
  roadblocks: Roadblock[] = [];
  heli: Helicopter | null = null;
  /** recent gunfire/explosion events: traffic swerves + speeds up, peds may bail/flee near them */
  dangerEvents: { x: number; y: number; r: number; t: number }[] = [];
  private rbTimer = 0;
  private spikeTimer = 0;

  constructor(private game: Game) {}

  /** Call from Game.crime() (and optionally where the player fires) to make the street react. */
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

  update(dt: number) {
    const g = this.game;
    for (const e of this.dangerEvents) e.t -= dt;
    if (this.dangerEvents.length) this.dangerEvents = this.dangerEvents.filter((e) => e.t > 0);
    const stars = Math.ceil(g.wanted - 0.01);
    this.updateHelicopter(dt, stars);
    this.updateRoadblocks(dt, stars);
    this.updateSpikes(dt, stars);
  }

  /** Clear all police-escalation state; called from Game.respawn(). */
  clear() {
    for (const rb of this.roadblocks) this.removeRoadblock(rb);
    this.roadblocks = [];
    this.props = [];
    if (this.heli) this.heli.spawned = false;
    this.game.audio.rotor(0);
    this.dangerEvents = [];
  }

  // --------------------------------------------------------------- helicopter
  private updateHelicopter(dt: number, stars: number) {
    const g = this.game;
    if (stars >= 4) {
      if (!this.heli) this.heli = new Helicopter();
      if (!this.heli.spawned) this.heli.spawn(g);
      this.heli.update(dt, g);
    } else if (this.heli?.spawned) {
      this.heli.spawned = false;
      g.audio.rotor(0);
    }
  }

  // --------------------------------------------------------------- roadblocks
  private updateRoadblocks(dt: number, stars: number) {
    const g = this.game;
    this.rbTimer -= dt;
    if (stars >= 3 && this.roadblocks.length < 2 && this.rbTimer <= 0 && g.player.vehicle && g.player.vehicle.speed > 3) {
      this.rbTimer = rand(10, 16);
      this.trySpawnRoadblock(stars >= 5);
    }
    const f = g.focus();
    const keep: Roadblock[] = [];
    for (const rb of this.roadblocks) {
      rb.age += dt;
      const gone = rb.age > 60 || stars < 3 || dist(rb.x, rb.y, f.x, f.y) > 260;
      if (gone) this.removeRoadblock(rb);
      else keep.push(rb);
    }
    this.roadblocks = keep;
  }

  private onScreen(x: number, y: number, pad: number) {
    const g = this.game;
    const hw = g.viewW / 2 / g.cam.scale + pad, hh = g.viewH / 2 / g.cam.scale + pad;
    return Math.abs(x - g.cam.x) < hw && Math.abs(y - g.cam.y) < hh;
  }

  /** Picks a car-graph edge ~150-250 m ahead along the player's heading, off screen. */
  private pickAheadLink(rMin: number, rMax: number) {
    const g = this.game;
    const v = g.player.vehicle;
    if (!v) return null;
    const heading = Math.hypot(v.vx, v.vy) > 1 ? Math.atan2(v.vy, v.vx) : v.angle;
    const f = g.focus();
    const hx = Math.cos(heading), hy = Math.sin(heading);
    const nodes = g.world.car.nodesAround(f.x, f.y, rMin, rMax);
    let best = -1, bestScore = 0.45;
    for (const n of nodes) {
      const nx = g.world.car.nx(n), ny = g.world.car.ny(n);
      const dx = nx - f.x, dy = ny - f.y;
      const d = Math.hypot(dx, dy) || 1;
      const dot = (dx / d) * hx + (dy / d) * hy;
      if (dot <= bestScore || this.onScreen(nx, ny, 15)) continue;
      if (!g.world.car.out[n].some((l) => l.edge.cls <= 6 && l.edge.width > 5 && l.edge.len > 12)) continue;
      (bestScore = dot), (best = n);
    }
    if (best < 0) return null;
    return pick(g.world.car.out[best].filter((l) => l.edge.cls <= 6 && l.edge.width > 5 && l.edge.len > 12));
  }

  private trySpawnRoadblock(swatTier: boolean) {
    const g = this.game;
    const link = this.pickAheadLink(140, 260);
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
      const swat = swatTier && Math.random() < 0.5;
      const car = new Vehicle(swat ? 'van' : 'police', cx, cy, across + side * 0.2);
      car.parked = true;
      car.siren = true;
      if (swat) (car.color = '#1b1f2a'), this.swat.add(car);
      g.vehicles.push(car);
      rb.cars.push(car);
      const cop = new Ped('cop', cx + fx * 2.3, cy + fy * 2.3);
      cop.angle = ang + Math.PI;
      if (swat) cop.outfit = 'swat';
      g.peds.push(cop);
      rb.cops.push(cop);
    }
    const barrier = new Prop('barrier', mx, my, ang, 0, w * 0.7, 70);
    this.props.push(barrier);
    rb.props.push(barrier);
    this.roadblocks.push(rb);
    if (dist(mx, my, g.focus().x, g.focus().y) < 400) g.message('', 'Polícia stavia zátaras!', 2.5, '#ff8a80');
  }

  private removeRoadblock(rb: Roadblock) {
    const g = this.game;
    if (rb.cars.length) g.vehicles = g.vehicles.filter((v) => !rb.cars.includes(v));
    if (rb.cops.length) g.peds = g.peds.filter((p) => !rb.cops.includes(p));
    if (rb.props.length) this.props = this.props.filter((p) => !rb.props.includes(p));
  }

  // --------------------------------------------------------------- spike strips
  private updateSpikes(dt: number, stars: number) {
    const g = this.game;
    this.spikeTimer -= dt;
    const active = this.props.filter((p) => p.kind === 'spike').length;
    if (stars >= 4 && active < 2 && this.spikeTimer <= 0 && g.player.vehicle && g.player.vehicle.speed > 3) {
      this.spikeTimer = rand(9, 15);
      this.trySpawnSpike();
    }
    const f = g.focus();
    for (const p of this.props) p.age += dt;
    this.props = this.props.filter((p) => p.kind !== 'spike' || (p.age < p.life && dist(p.x, p.y, f.x, f.y) < 220));
    this.checkSpikeCollisions();
  }

  private trySpawnSpike() {
    const g = this.game;
    const link = this.pickAheadLink(70, 160);
    if (!link) return;
    const pts = linkPoints(link);
    const mx = (pts[0] + pts[2]) / 2, my = (pts[1] + pts[3]) / 2;
    const ang = Math.atan2(pts[3] - pts[1], pts[2] - pts[0]);
    const strip = new Prop('spike', mx, my, ang, 0, Math.max(5, link.edge.width) * 0.9, 45);
    this.props.push(strip);
    if (dist(mx, my, g.focus().x, g.focus().y) < 400) g.message('', 'Pozor, pásy s klincami!', 2.5, '#ffd740');
  }

  private checkSpikeCollisions() {
    const g = this.game;
    for (const p of this.props) {
      if (p.kind !== 'spike' || !p.active) continue;
      for (const v of g.vehicles) {
        if (v.wrecked || v.level !== p.level || v.tyresBurst) continue;
        if (Math.abs(v.x - p.x) > p.len + 2 || Math.abs(v.y - p.y) > p.len + 2) continue;
        if (!propHit(p, v.x, v.y, v.spec.width / 2)) continue;
        v.tyresBurst = 1;
        p.hits++;
        if (p.hits >= 3) p.active = false;
        if (v.isPlayer) g.message('', 'Klince prepichli pneumatiky!', 2.5, '#ff8a80');
      }
    }
  }
}
