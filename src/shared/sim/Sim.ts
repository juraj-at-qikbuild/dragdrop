// The world simulation: every NPC, vehicle, tram, pickup and police unit, plus the rules of the game for
// each player (crime and wanted level, damage, death and respawn, pickups, landmarks, spray shops).
//
// The same code runs in two places:
//  - offline, in the browser (LocalSimHost): one player, whose figure and car are simulated here;
//  - online, on the server (server/src/Room.ts): many players, whose figures and cars are `kinematic`,
//    i.e. simulated by their own clients and reported to the server, which validates and applies them.
import { Vehicle } from '../entities/Vehicle';
import { Ped, setPlayerLook, type WeaponId } from '../entities/Ped';
import type { Tram } from '../entities/Tram';
import type { Prop } from '../entities/Props';
import type { Level, World } from '../world/World';
import { SpatialHash } from '../util/SpatialHash';
import { Rng } from '../util/Rng';
import { clamp, dist } from '../util/math';
import { AI } from './AI';
import { Police } from './Police';
import { CombatRules, WEAPONS, type Shooter, type ShotReport } from './Combat';
import { VehiclePhysics, pedContacts, updateLevels } from './Physics';
import { placePickups, type Pickup, type PickupKind } from './Pickups';
import { Clock } from './Clock';
import { IdPool } from './IdPool';
import { nullEvents, type SimEvents } from './events';
import { BASE_DENSITY, NO_CAPS, type Caps, type Density } from './density';
import { SimPlayer, type Profile } from './SimPlayer';

export type Crime =
  | 'shoot' | 'killPed' | 'killCop' | 'shootCop' | 'carjack' | 'hitCop' | 'stealCop' | 'destroy'
  /** hurting / killing another player (online) */
  | 'hitPlayer' | 'killPlayer';

export interface SimOptions {
  rng?: Rng;
  events?: SimEvents;
  /** advance the clock in step() (the server does; the offline client drives it from its Atmosphere) */
  driveClock?: boolean;
  clock?: Clock;
  caps?: Caps;
  /** server: players' cars coast along their last reported velocity between reports */
  extrapolatePlayers?: boolean;
}

const SPRAY_COLORS = ['#c62828', '#1565c0', '#2e7d32', '#f9a825', '#eeeeee', '#263238'];
const SPRAY_COST = 250;
const LANDMARK_REWARD = 100;
/** seconds a player's damage to a car/player still earns them the kill */
const CREDIT_WINDOW = 10;

export class Sim {
  world: World;
  rng: Rng;
  events: SimEvents;
  clock: Clock;
  ids = new IdPool();
  /** simulation time, seconds */
  time = 0;
  vehicles: Vehicle[] = [];
  peds: Ped[] = [];
  trams: Tram[] = [];
  pickups: Pickup[] = [];
  players = new Map<number, SimPlayer>();
  ai: AI;
  police: Police;
  combat: CombatRules;
  physics = new VehiclePhysics();
  /** base target counts around each player (scaled by quality, time of day, player count, governor) */
  density: Density = { ...BASE_DENSITY };
  /** render quality of the (single) offline client: 0 = low (fewer NPCs) */
  quality = 1;
  caps: Caps;
  /** 0.3..1: the server's load governor thins the city out when ticks run long */
  governor = 1;
  driveClock: boolean;
  /** called when a player's persistent progress changed (save it) */
  onProfileChange?: (p: SimPlayer) => void;
  private pedHash = new SpatialHash<Ped>(16);
  /** vehicles for AI neighbourhood queries (coarser cells than the physics broad phase) */
  private vehHash = new SpatialHash<Vehicle>(25);
  /** observing players by camera centre, for "is anyone looking here" queries */
  private camHash = new SpatialHash<SimPlayer>(200);
  private maxHalf = 0;
  private nextPlayerId = 1;
  private sweepTimer = 1;
  private byId = new Map<number, Vehicle | Ped>();
  /** any player currently wanted (cheap check for AI panic reactions) */
  anyWanted = false;
  /** integrate traffic far from every camera at half rate (server) */
  coarsePhysics = false;

  constructor(world: World, opts: SimOptions = {}) {
    this.world = world;
    this.rng = opts.rng ?? new Rng();
    this.events = opts.events ?? nullEvents;
    this.clock = opts.clock ?? new Clock(this.rng);
    this.driveClock = opts.driveClock ?? true;
    this.caps = opts.caps ?? NO_CAPS;
    this.physics.extrapolateKinematic = !!opts.extrapolatePlayers;
    this.ai = new AI(this);
    this.police = new Police(this);
    this.combat = new CombatRules(this);
    for (const p of placePickups(world)) this.pickups.push({ ...p, id: this.ids.alloc(0) });
  }

  // ---------------------------------------------------------------- entities
  addVehicle(v: Vehicle) {
    if (!v.id) v.id = this.ids.alloc(this.time);
    this.vehicles.push(v);
    this.byId.set(v.id, v);
    // visible to neighbour queries right away, so back-to-back spawns (prewarm) see each other
    this.vehHash.insert(v, v.x, v.y, v.radius);
    return v;
  }
  addPed(p: Ped) {
    if (!p.id) p.id = this.ids.alloc(this.time);
    this.peds.push(p);
    this.byId.set(p.id, p);
    this.pedHash.insert(p, p.x, p.y);
    return p;
  }
  addTram(t: Tram) {
    t.id = this.ids.alloc(this.time);
    this.trams.push(t);
    return t;
  }
  addProp(p: Prop) {
    p.id = this.ids.alloc(this.time);
    this.police.props.push(p);
    return p;
  }
  get props(): readonly Prop[] {
    return this.police.props;
  }

  /** alive vehicle with this id, or null */
  vehicleById(id: number): Vehicle | null {
    const v = this.byId.get(id);
    return v instanceof Vehicle && this.vehicles.includes(v) ? v : null;
  }
  pedById(id: number): Ped | null {
    const p = this.byId.get(id);
    return p instanceof Ped && this.peds.includes(p) ? p : null;
  }

  /** peds within a square of half-size r (hash rebuilt each step; may include a few just outside) */
  pedsNear(x: number, y: number, r: number): Ped[] {
    const out: Ped[] = [];
    this.pedHash.query(x, y, r, (p) => out.push(p));
    return out;
  }
  vehiclesNear(x: number, y: number, r: number): Vehicle[] {
    const out: Vehicle[] = [];
    this.vehHash.query(x, y, r, (v) => out.push(v));
    return out;
  }

  /** visit vehicles near (x, y) (AI queries; hash rebuilt once per step) */
  forVehiclesNear(x: number, y: number, r: number, fn: (v: Vehicle) => void) {
    this.vehHash.query(x, y, r, fn);
  }

  private rehash() {
    this.physics.rehash(this.vehicles);
    this.vehHash.clear();
    for (const v of this.vehicles) this.vehHash.insert(v, v.x, v.y, v.radius);
    this.pedHash.clear();
    for (const p of this.peds) this.pedHash.insert(p, p.x, p.y);
    this.camHash.clear();
    this.maxHalf = 0;
    for (const p of this.players.values()) {
      if (!p.observing) continue;
      this.camHash.insert(p, p.observer.cx, p.observer.cy);
      this.maxHalf = Math.max(this.maxHalf, p.observer.hw, p.observer.hh);
    }
  }

  // ------------------------------------------------------------------ players
  /** Add a player. Their figure starts next to Hlavné námestie unless a position is given. */
  addPlayer(o: { id?: number; nick: string; look?: number; profile: Profile; kinematic: boolean; x?: number; y?: number }): SimPlayer {
    const id = o.id ?? this.nextPlayerId++;
    this.nextPlayerId = Math.max(this.nextPlayerId, id + 1);
    let x = o.x, y = o.y;
    if (x === undefined || y === undefined) {
      const main = this.world.landmark('main');
      const s = this.world.walkableNear(main.x, main.y);
      // spread arrivals a little so players don't stand inside each other
      const a = this.rng.next() * Math.PI * 2, r = this.players.size ? 2 + this.rng.next() * 6 : 3 * Math.SQRT2;
      const p = this.players.size ? this.world.walkableNear(s.x + Math.cos(a) * r, s.y + Math.sin(a) * r) : { x: s.x + 3, y: s.y + 3 };
      // not in the fountain, nor against a statue
      ({ x, y } = this.world.clearSpot(p.x, p.y));
    }
    const ped = new Ped('player', x, y, this.rng.seed());
    ped.playerId = id;
    ped.kinematic = o.kinematic;
    setPlayerLook(ped, o.look ?? 0);
    this.addPed(ped);
    const p = new SimPlayer(id, o.nick, ped, o.profile, o.kinematic);
    p.lastSeenPos = { x, y };
    this.players.set(id, p);
    return p;
  }

  removePlayer(p: SimPlayer) {
    const v = p.ped.vehicle;
    if (v) this.releaseCar(p, v);
    this.police.clear(p);
    this.peds = this.peds.filter((q) => q !== p.ped);
    this.players.delete(p.id);
    for (const q of this.peds) if (q.targetPid === p.id) q.targetPid = 0;
  }

  /** the player leaves the car (or is thrown out); it becomes an ordinary, simulated car */
  private releaseCar(p: SimPlayer, v: Vehicle) {
    v.owner = 0;
    v.kinematic = false;
    v.driver = null;
    v.setControls(0, 0, true);
    p.ped.vehicle = null;
  }

  /** players whose cameras NPCs spawn around */
  observers(): SimPlayer[] {
    const out: SimPlayer[] = [];
    for (const p of this.players.values()) if (p.observing) out.push(p);
    return out;
  }

  /** is (x, y) inside anyone's view (plus `pad` metres)? `except` is ignored (prewarming) */
  visibleToAny(x: number, y: number, pad: number, except: SimPlayer | null = null) {
    let seen = false;
    this.camHash.query(x, y, this.maxHalf + pad, (p) => {
      if (seen || p === except || !p.observing) return;
      const o = p.observer;
      if (Math.abs(x - o.cx) < o.hw + pad && Math.abs(y - o.cy) < o.hh + pad) seen = true;
    });
    return seen;
  }

  /** distance to the nearest observer's camera centre, or Infinity when none is within `range` */
  nearestCamera(x: number, y: number, range = 300) {
    let best = Infinity;
    this.camHash.query(x, y, range, (p) => {
      if (!p.observing) return;
      const d = dist(x, y, p.observer.cx, p.observer.cy);
      if (d < best) best = d;
    });
    return best;
  }

  // --------------------------------------------------------------------- step
  step(dt: number) {
    this.time += dt;
    if (this.driveClock) this.clock.update(dt);
    Vehicle.env.wet = this.clock.wet;
    this.anyWanted = false;
    for (const p of this.players.values()) {
      if (p.wanted > 0) this.anyWanted = true;
      if (p.state !== 'play') {
        p.stateTimer -= dt;
        if (p.stateTimer <= 0) this.respawn(p);
      }
      if (p.sprayCooldown > 0) p.sprayCooldown -= dt;
    }
    this.rehash();
    this.ai.update(dt);
    this.police.update(dt);
    this.updateVehicles(dt);
    updateLevels(this.world, this.trams, this.peds);
    this.updatePickups(dt);
    for (const p of this.players.values()) {
      if (p.state !== 'play') continue;
      this.updateWanted(p, dt);
      this.sprayShop(p);
      this.hazards(p, dt);
      this.discover(p);
    }
    this.sweepTimer -= dt;
    if (this.sweepTimer <= 0) {
      this.sweepTimer = 1;
      this.sweepIds();
    }
  }

  private sweepIds() {
    const alive = new Set<number>();
    this.byId.clear();
    for (const v of this.vehicles) alive.add(v.id), this.byId.set(v.id, v);
    for (const p of this.peds) alive.add(p.id), this.byId.set(p.id, p);
    for (const t of this.trams) alive.add(t.id);
    for (const pk of this.pickups) alive.add(pk.id);
    for (const pr of this.police.props) alive.add(pr.id);
    for (const h of this.police.helis()) alive.add(h.id);
    this.ids.sweep(alive, this.time);
  }

  /** Prefill NPCs around a player (start, respawn, joining). */
  prewarm(p: SimPlayer) {
    this.rehash();
    this.ai.prewarm(p);
    this.rehash();
  }

  // ------------------------------------------------------------------ vehicles
  private updateVehicles(dt: number) {
    const ev = this.events;
    this.physics.step(dt, this.vehicles, this.trams, this.world, {
      impact: (v, sev) => ev.crash(v.id, v.x, v.y, sev, -Math.cos(v.angle), -Math.sin(v.angle), sev > 7 ? sev : 0),
      carContact: (a, b, sev, cx, cy, nx, ny) => {
        if (sev > 4) ev.spark(cx, cy, 1);
        if (sev > 6) ev.spark(cx, cy, 2);
        if (sev <= 5) return;
        for (const [me, other, s] of [[a, b, -1], [b, a, 1]] as const) {
          if (!me.isPlayer) continue;
          ev.crash(me.id, me.x, me.y, sev, nx * s, ny * s, sev * 2);
          const pl = this.players.get(me.owner);
          if (!pl) continue;
          if (other.kind === 'police' && !other.wrecked && !other.isPlayer) this.crime(pl, 'hitCop');
          other.lastDamagedBy = pl.id;
          other.lastDamagedAt = this.time;
        }
      },
      kinematicPair: (a, b) => {
        // two players' cars touching (server): remember who rammed whom for kill credit
        const rel = Math.hypot(a.vx - b.vx, a.vy - b.vy);
        if (rel < 5) return;
        (a.lastDamagedBy = b.owner), (a.lastDamagedAt = this.time);
        (b.lastDamagedBy = a.owner), (b.lastDamagedAt = this.time);
      },
      tramContact: (v, _t, sev) => ev.crash(v.id, v.x, v.y, sev, 0, 0, 0),
    });
    // per-frame consequences (once, not per physics substep)
    const gone = new Set<Ped>();
    for (const v of this.vehicles) {
      if (v.fire > 0 && !v.wrecked && !v.kinematic && v.driver && !v.driver.playerId && !v.driver.dead) {
        // AI bails out of burning cars
        const d = v.driver;
        d.vehicle = null;
        v.driver = null;
        d.x = v.x - Math.sin(v.angle) * 2;
        d.y = v.y + Math.cos(v.angle) * 2;
        this.combat.scare(d, v.x, v.y);
        this.ai.drivers.delete(v);
      }
      // a player's own car: their client runs its fire countdown and sinking, and reports the result
      if (v.fire > -1 && v.fire <= 0 && !v.wrecked) this.wreck(v);
      if (v.sinking > 2.5 && !v.kinematic) {
        const owner = this.players.get(v.owner);
        if (owner && owner.ped.vehicle === v) this.wasted(owner);
        if (v.driver && !v.driver.playerId) gone.add(v.driver);
      }
    }
    if (gone.size) this.peds = this.peds.filter((p) => !gone.has(p));
    this.vehicles = this.vehicles.filter((v) => {
      const keep = v.sinking <= 3 || v.isPlayer || v.kinematic;
      if (!keep) this.ai.drivers.delete(v);
      return keep;
    });
    this.physics.rehash(this.vehicles);
    pedContacts(this.peds, this.physics.hash, this.trams, dt, {
      runOver: (p, v, sp, cx, cy) => this.runOver(p, v, sp, cx, cy),
      tramHit: (p, t, sx, sy) => {
        if (p.playerId) {
          const pl = this.players.get(p.playerId);
          if (pl) this.hurtPlayer(pl, t.speed * 5, sx, sy, 0);
          return;
        }
        p.kill(sx, sy, t.speed);
        this.events.pedHit(p.id, p.x, p.y, 0.8);
        this.events.pedKilled(p.id, p.x, p.y, 0, 'tram');
      },
    });
  }

  /** a burning car's countdown ran out */
  wreck(v: Vehicle) {
    v.wrecked = true;
    v.fire = -1;
    v.siren = false;
    const credit = this.creditFor(v);
    this.combat.explode(v.x, v.y, v, credit?.id ?? 0);
    const owner = this.players.get(v.owner);
    if (owner && owner.ped.vehicle === v) {
      if (credit && credit !== owner) this.killedBy(owner, credit);
      this.wasted(owner);
    }
    if (credit && credit !== owner) {
      this.crime(credit, 'destroy');
      if (v.kind === 'police' && !v.isPlayer) this.events.toPlayer(credit.id, { k: 'style', label: 'TAKEDOWN!', cash: 60, x: v.x, y: v.y - 2 });
    }
  }

  /** who gets the blame for a car blowing up */
  private creditFor(v: Vehicle): SimPlayer | undefined {
    if (v.lastDamagedBy && this.time - v.lastDamagedAt < CREDIT_WINDOW) return this.players.get(v.lastDamagedBy);
    // single player: any explosion near a player who has been driving counts (the original rule)
    if (this.players.size === 1) {
      const p = this.players.values().next().value!;
      const f = p.focus();
      if (p.lastCar && dist(v.x, v.y, f.x, f.y) < 60 && p.ped.vehicle !== v) return p;
    }
    return undefined;
  }

  private runOver(p: Ped, v: Vehicle, sp: number, cx: number, cy: number) {
    if (p.playerId) {
      const pl = this.players.get(p.playerId);
      if (pl) {
        this.hurtPlayer(pl, sp * 3, v.x, v.y, v.owner);
        p.x += (v.vx / sp) * 1.5;
        p.y += (v.vy / sp) * 1.5;
      }
      return;
    }
    p.kill(cx - v.vx, cy - v.vy, sp * 0.8);
    this.events.pedHit(p.id, p.x, p.y, 0.8);
    this.events.pedKilled(p.id, p.x, p.y, v.owner, 'road');
    const driver = this.players.get(v.owner);
    if (driver) {
      this.crime(driver, p.kind === 'cop' ? 'killCop' : 'killPed');
      this.dropCash(p.x, p.y, p.money);
      this.events.toPlayer(driver.id, { k: 'style', label: 'ROADKILL', cash: p.kind === 'cop' ? 40 : 15, x: p.x, y: p.y - 1.5 });
    }
    for (const q of this.pedsNear(p.x, p.y, 20)) if (q.kind === 'civ' && !q.dead && dist(q.x, q.y, p.x, p.y) < 20) this.combat.scare(q, p.x, p.y);
  }

  /** Damage a vehicle. A player's car is simulated by their client, so they are told to apply it. */
  damageVehicle(v: Vehicle, amount: number, byPid = 0, impulse?: { dvx: number; dvy: number; dav: number }) {
    if (byPid && byPid !== v.owner) (v.lastDamagedBy = byPid), (v.lastDamagedAt = this.time);
    if (v.kinematic && v.owner) {
      this.events.toPlayer(v.owner, { k: 'vehDamage', vehicle: v.id, amount, dvx: impulse?.dvx ?? 0, dvy: impulse?.dvy ?? 0, dav: impulse?.dav ?? 0 });
      return;
    }
    v.damage(amount);
    if (impulse) {
      v.vx += impulse.dvx;
      v.vy += impulse.dvy;
      v.av += impulse.dav;
      if (v.parked && !v.isPlayer) v.parked = false;
    }
  }

  // -------------------------------------------------------- entering / leaving
  /** the car a player on foot would get into (nearest, within reach) */
  enterableFor(p: SimPlayer): Vehicle | null {
    const ped = p.ped;
    let best: Vehicle | null = null, bd = 4.2;
    for (const v of this.vehiclesNear(ped.x, ped.y, 12)) {
      if (v.wrecked || v.sinking || v.level !== ped.level) continue;
      const d = dist(v.x, v.y, ped.x, ped.y) - v.spec.width / 2;
      if (d < bd) (bd = d), (best = v);
    }
    return best;
  }

  /** Get `p` into `v` (carjacking whoever drives it). Returns false if not allowed. */
  enterVehicle(p: SimPlayer, v: Vehicle | null, slack = 0): boolean {
    const ped = p.ped;
    if (!v || p.state !== 'play' || ped.vehicle || v.wrecked || v.sinking || v.level !== ped.level) return false;
    if (dist(v.x, v.y, ped.x, ped.y) - v.spec.width / 2 > 4.2 + slack) return false;
    if (v.owner && v.owner !== p.id) {
      // another player's car: only when it's (nearly) standing still
      const other = this.players.get(v.owner);
      if (!other || v.speed > 2) return false;
      this.eject(other, v, ped.x, ped.y);
      this.crime(p, 'carjack');
      this.hurtPlayer(other, 0, ped.x, ped.y, p.id);
    } else if (v.driver && v.driver !== ped) {
      // carjacking: throw the driver out
      const d = v.driver;
      d.vehicle = null;
      d.x = v.x - Math.sin(v.angle) * 2;
      d.y = v.y + Math.cos(v.angle) * 2;
      if (d.kind === 'civ') this.combat.scare(d, ped.x, ped.y);
      else d.state = 'chase';
      this.crime(p, 'carjack');
    }
    if (v.kind === 'police') this.crime(p, 'stealCop');
    this.ai.drivers.delete(v);
    v.driver = ped;
    v.owner = p.id;
    v.kinematic = p.kinematic;
    v.parked = false;
    ped.vehicle = v;
    p.lastCar = v;
    this.events.toPlayer(p.id, { k: 'enter', vehicle: v.id, ok: true });
    return true;
  }

  /** throw a player out of their car (carjacked) */
  private eject(p: SimPlayer, v: Vehicle, fromX: number, fromY: number) {
    this.releaseCar(p, v);
    const side = (fromX - v.x) * -Math.sin(v.angle) + (fromY - v.y) * Math.cos(v.angle) >= 0 ? -1 : 1;
    p.ped.x = v.x - Math.sin(v.angle) * (v.spec.width / 2 + 0.8) * side;
    p.ped.y = v.y + Math.cos(v.angle) * (v.spec.width / 2 + 0.8) * side;
    this.events.toPlayer(p.id, { k: 'eject', vehicle: v.id, x: p.ped.x, y: p.ped.y });
  }

  /** Leave the car: step out on a free side (or wherever when forced). */
  exitVehicle(p: SimPlayer, force = false, at?: { x: number; y: number }) {
    const ped = p.ped;
    const v = ped.vehicle;
    if (!v) return;
    if (at) (ped.x = at.x), (ped.y = at.y);
    else
      for (const s of [1, -1]) {
        const x = v.x + Math.sin(v.angle) * (v.spec.width / 2 + 0.7) * s;
        const y = v.y - Math.cos(v.angle) * (v.spec.width / 2 + 0.7) * s;
        // the spot beside the car, at its level (on a deck, or inside the tunnel tube)
        if (force || !this.world.collideCircle(x, y, 0.4, v.level, false)) {
          ped.x = x;
          ped.y = y;
          break;
        }
      }
    this.releaseCar(p, v);
  }

  // ------------------------------------------------------------------- combat
  /** A player fired (offline: straight from the local player; online: a validated report). */
  applyShot(p: SimPlayer, shot: ShotReport) {
    const ped = p.ped;
    const shooter: Shooter = { id: ped.id, x: shot.ox - Math.cos(shot.a) * 0.5, y: shot.oy - Math.sin(shot.a) * 0.5, level: shot.lvl, vehicle: ped.vehicle };
    this.combat.applyShot(shooter, p.id, shot);
  }

  applyMelee(p: SimPlayer, targetId: number) {
    const t = targetId ? this.pedById(targetId) : null;
    this.combat.applyMelee(p.ped, p.id, t);
  }

  // -------------------------------------------------------------------- crime
  crime(p: SimPlayer, kind: Crime) {
    if (p.state !== 'play') return;
    const now = this.time;
    const cd = p.crimeCooldown.get(kind) ?? -Infinity;
    const f = p.focus();
    const copNear = (r: number) => this.pedsNear(f.x, f.y, r).some((c) => c.kind === 'cop' && !c.dead && dist(c.x, c.y, f.x, f.y) < r);
    switch (kind) {
      case 'shoot':
        this.police.danger(f.x, f.y, 20);
        if (copNear(45) && now > cd) this.raise(p, 1, kind, 5);
        break;
      case 'killPed':
        this.raise(p, 1, kind, 0.5);
        break;
      case 'killCop':
        this.police.danger(f.x, f.y, 25);
        this.raise(p, 2, kind, 0.5);
        p.shotCops = true;
        break;
      case 'shootCop':
        this.police.danger(f.x, f.y, 22);
        p.shotCops = true;
        if (now > cd) this.raise(p, 1, kind, 6);
        break;
      case 'carjack':
        if (copNear(60)) this.raise(p, 1, kind, 3);
        break;
      case 'hitCop':
        if (now > cd) this.raise(p, 1, kind, 8);
        break;
      case 'stealCop':
        this.raise(p, 2, kind, 1);
        break;
      case 'destroy':
        this.police.danger(f.x, f.y, 18);
        if (now > cd) this.raise(p, 0.6, kind, 3);
        break;
      case 'hitPlayer':
        this.police.danger(f.x, f.y, 20);
        if (now > cd) this.raise(p, 1, kind, 6);
        break;
      case 'killPlayer':
        this.police.danger(f.x, f.y, 25);
        this.raise(p, 1, kind, 0.5);
        break;
    }
  }

  private raise(p: SimPlayer, amount: number, kind: string, cooldown: number) {
    const before = Math.ceil(p.wanted);
    p.wanted = clamp(Math.max(p.wanted, 0) + amount, 0, 5);
    if (p.wanted < 1) p.wanted = 1;
    p.unseen = 0;
    p.crimeCooldown.set(kind, this.time + cooldown);
    if (Math.ceil(p.wanted) > before) this.events.toPlayer(p.id, { k: 'stars' });
    this.anyWanted = true;
  }

  setWanted(p: SimPlayer, level: number) {
    const before = Math.ceil(p.wanted);
    p.wanted = clamp(level, 0, 5);
    if (Math.ceil(p.wanted) > before) this.events.toPlayer(p.id, { k: 'stars' });
    if (p.wanted > 0) this.anyWanted = true;
  }

  // ------------------------------------------------------------ health / death
  /** Damage a player from (fx, fy). `byPid` is the player responsible (PvP), 0 for the world/NPCs. */
  hurtPlayer(p: SimPlayer, dmg: number, fx: number, fy: number, byPid = 0) {
    if (p.state !== 'play') return;
    const attacker = byPid && byPid !== p.id ? this.players.get(byPid) : undefined;
    if (attacker) {
      p.lastAttacker = attacker.id;
      p.lastAttackedAt = this.time;
      if (dmg > 0) this.crime(attacker, 'hitPlayer');
    }
    if (dmg <= 0) return;
    const ped = p.ped;
    // body armour soaks most of the hit until it is used up
    const soak = Math.min(ped.armor, dmg * 0.7);
    ped.armor -= soak;
    ped.health -= dmg - soak;
    this.events.pedHit(ped.id, ped.x, ped.y, 0.3);
    this.events.toPlayer(p.id, { k: 'hurt', dmg, fx, fy });
    if (ped.health <= 0) {
      const killer = attacker ?? (p.lastAttacker && this.time - p.lastAttackedAt < CREDIT_WINDOW ? this.players.get(p.lastAttacker) : undefined);
      if (killer) this.killedBy(p, killer);
      this.wasted(p);
    }
  }

  /** PvP kill credit: a crime, and a style bonus for the killer */
  private killedBy(victim: SimPlayer, killer: SimPlayer) {
    if (killer === victim) return;
    this.crime(killer, 'killPlayer');
    const f = victim.focus();
    this.events.toPlayer(killer.id, { k: 'style', label: `K.O. ${victim.nick}`, cash: 50, x: f.x, y: f.y - 1.5 });
    this.events.toPlayer(victim.id, { k: 'msg', title: '', text: `Dostal ťa ${killer.nick}.`, time: 3, color: '#ff8a80' });
  }

  wasted(p: SimPlayer) {
    if (p.state !== 'play') return;
    p.state = 'wasted';
    p.stateTimer = 4;
    p.ped.health = 0;
    this.events.toPlayer(p.id, { k: 'down', state: 'wasted' });
  }

  bust(p: SimPlayer) {
    if (p.state !== 'play') return;
    p.state = 'busted';
    p.stateTimer = 4;
    this.events.toPlayer(p.id, { k: 'down', state: 'busted' });
  }

  respawn(p: SimPlayer) {
    const busted = p.state === 'busted';
    const kind = busted ? 'police' : 'hospital';
    const f = p.focus();
    const list = this.world.pois(kind);
    let best = list[0];
    for (const q of list) if (dist(q.x, q.y, f.x, f.y) < dist(best.x, best.y, f.x, f.y)) best = q;
    const near = best ? this.world.walkableNear(best.x, best.y) : this.world.walkableNear(0, 0);
    const pos = this.world.clearSpot(near.x, near.y);
    const ped = p.ped;
    if (ped.vehicle) this.exitVehicle(p, true);
    ped.x = pos.x;
    ped.y = pos.y;
    ped.vx = ped.vy = 0;
    ped.health = 100;
    ped.armor = 0;
    ped.state = 'walk';
    ped.levelInit = false;
    const fee = Math.round(p.profile.money * 0.1);
    this.addMoney(p, -fee);
    p.wanted = 0;
    p.shotCops = false;
    p.drown = 0;
    p.lastAttacker = 0;
    if (busted) {
      p.ammo = { fist: Infinity, pistol: 0, uzi: 0, shotgun: 0 };
      ped.weapon = 'fist';
    }
    // call off the police that were after this player
    this.police.clear(p);
    const chasing = new Set<Vehicle>();
    for (const [v, d] of this.ai.drivers) if (d.mode === 'police' && d.target === p.id) chasing.add(v);
    const gone = new Set<Ped>();
    this.vehicles = this.vehicles.filter((v) => {
      if (!chasing.has(v) || v.isPlayer) return true;
      if (v.driver) gone.add(v.driver);
      this.ai.drivers.delete(v);
      return false;
    });
    this.peds = this.peds.filter((q) => !gone.has(q) && !(q.kind === 'cop' && !q.vehicle && q.targetPid === p.id));
    p.searchZone = null;
    p.searching = false;
    p.state = 'play';
    p.epoch = (p.epoch + 1) & 0xff;
    this.events.toPlayer(p.id, { k: 'respawn', x: pos.x, y: pos.y, busted, poi: best?.n ?? '', fee, epoch: p.epoch });
    this.onProfileChange?.(p);
    p.observer.fx = p.observer.cx = pos.x;
    p.observer.fy = p.observer.cy = pos.y;
    this.prewarm(p);
  }

  // -------------------------------------------------------------------- money
  addMoney(p: SimPlayer, v: number, x?: number, y?: number) {
    p.profile.money = Math.max(0, p.profile.money + v);
    if (v > 0 && x !== undefined && y !== undefined) this.events.toPlayer(p.id, { k: 'cash', amount: v, x, y });
  }

  dropCash(x: number, y: number, amount: number) {
    this.pickups.push({ id: this.ids.alloc(this.time), x, y, kind: 'cash', amount, respawn: 0, hidden: 0, cumil: -1 });
  }

  // ------------------------------------------------------------------ pickups
  private updatePickups(dt: number) {
    let removed = false;
    for (const pk of this.pickups) {
      if (pk.hidden > 0) {
        pk.hidden = Math.max(0, pk.hidden - dt);
        continue;
      }
      if (pk.hidden < 0) continue;
      for (const p of this.players.values()) {
        if (p.state !== 'play') continue;
        if (pk.cumil >= 0 && p.profile.cumils.includes(pk.cumil)) continue;
        const f = p.focus();
        const onFoot = !p.ped.vehicle;
        const r = pk.kind === 'cash' ? 1.2 : onFoot ? 1.3 : 3;
        if (Math.abs(pk.x - f.x) > r || Math.abs(pk.y - f.y) > r || dist(pk.x, pk.y, f.x, f.y) > r) continue;
        if (!this.takePickup(p, pk, onFoot)) continue;
        // Čumils are collected per player: the statue stays for everyone else
        if (pk.cumil >= 0) break;
        if (pk.respawn) pk.hidden = pk.respawn;
        else (pk.hidden = -1), (removed = true);
        break;
      }
    }
    if (removed) this.pickups = this.pickups.filter((p) => p.hidden !== -1);
  }

  private takePickup(p: SimPlayer, pk: Pickup, onFoot: boolean): boolean {
    const ped = p.ped;
    const ev = this.events;
    switch (pk.kind) {
      case 'cash':
        this.addMoney(p, pk.amount, pk.x, pk.y);
        ev.toPlayer(p.id, { k: 'pickup', kind: 'cash', amount: pk.amount });
        return true;
      case 'health':
        if (ped.health >= 100) return false;
        ped.health = 100;
        ev.toPlayer(p.id, { k: 'pickup', kind: 'health', amount: pk.amount });
        return true;
      case 'armor':
        if (ped.armor >= 100) return false;
        ped.armor = Math.min(100, ped.armor + pk.amount);
        ev.toPlayer(p.id, { k: 'pickup', kind: 'armor', amount: pk.amount });
        return true;
      case 'cumil':
        p.profile.cumils.push(pk.cumil);
        this.addMoney(p, pk.amount);
        ev.toPlayer(p.id, { k: 'cumil', id: pk.cumil, count: p.profile.cumils.length, reward: pk.amount });
        this.onProfileChange?.(p);
        return true;
      default: {
        if (!onFoot) return false;
        const w = pk.kind as WeaponId & PickupKind;
        p.ammo[w] = Math.min(p.ammo[w] + pk.amount, 999);
        ped.weapon = w;
        ev.toPlayer(p.id, { k: 'pickup', kind: w, amount: pk.amount });
        return true;
      }
    }
  }

  // ------------------------------------------------------------------- wanted
  private updateWanted(p: SimPlayer, dt: number) {
    if (p.wanted <= 0) {
      p.searchZone = null;
      p.searching = false;
      return;
    }
    const f = p.focus();
    const fl = p.focusLevel();
    // nobody on the surface can see into a tunnel, nor out of one
    const sightOk = (level: Level) => (level === -1) === (fl === -1);
    let seen = false;
    for (const v of this.vehiclesNear(f.x, f.y, 70)) {
      if (v.kind !== 'police' || v.wrecked || v.isPlayer || !v.siren) continue;
      if (dist(v.x, v.y, f.x, f.y) < 70 && sightOk(v.level) && this.world.raycast(v.x, v.y, f.x, f.y, fl) >= 1) {
        seen = true;
        break;
      }
    }
    if (!seen)
      for (const c of this.pedsNear(f.x, f.y, 40)) {
        if (c.kind !== 'cop' || c.dead || c.vehicle) continue;
        if (dist(c.x, c.y, f.x, f.y) < 40 && sightOk(c.level) && this.world.raycast(c.x, c.y, f.x, f.y, fl) >= 1) {
          seen = true;
          break;
        }
      }
    if (!seen && fl !== -1) for (const h of this.police.helis()) if (h.sees(f.x, f.y)) seen = true;
    if (seen) {
      p.unseen = 0;
      p.lastSeenPos = { x: f.x, y: f.y };
      p.searchZone = null;
    } else {
      p.unseen += dt;
      if (!p.searchZone) p.searchZone = { x: p.lastSeenPos.x, y: p.lastSeenPos.y, r: 40 };
      else p.searchZone.r = Math.min(120, p.searchZone.r + dt * 4);
      const outsideZone = dist(f.x, f.y, p.searchZone.x, p.searchZone.y) > p.searchZone.r;
      if (outsideZone && p.unseen > 9 + Math.ceil(p.wanted) * 1.5) {
        p.unseen = 0;
        p.wanted = Math.max(0, Math.ceil(p.wanted) - 1);
        if (p.wanted === 0) {
          p.shotCops = false;
          p.searchZone = null;
          this.events.toPlayer(p.id, { k: 'msg', title: '', text: 'Polícia ťa stratila z dohľadu.', time: 2, color: '#90caf9' });
        }
      }
    }
    p.searching = !seen;
  }

  /** Slovnafta spray shop: repaint + repair + lose the cops */
  private sprayShop(p: SimPlayer) {
    const v = p.ped.vehicle;
    if (!v || v.speed >= 3 || p.sprayCooldown > 0) return;
    for (const fuel of this.world.pois('fuel')) {
      if (dist(fuel.x, fuel.y, v.x, v.y) > 12) continue;
      p.sprayCooldown = 6;
      if (p.profile.money < SPRAY_COST) {
        this.events.toPlayer(p.id, { k: 'msg', title: 'Striekareň', text: `Nemáš dosť peňazí (€${SPRAY_COST}).`, time: 2.5, color: '#ff8a80' });
        return;
      }
      this.addMoney(p, -SPRAY_COST);
      const color = this.rng.pick(SPRAY_COLORS);
      // a kinematic car is simulated by its driver's client: the spray event tells it to repair
      if (!v.kinematic) {
        v.health = v.spec.health;
        v.fire = -1;
      }
      v.color = color;
      v.rev++;
      p.wanted = 0;
      p.shotCops = false;
      this.events.toPlayer(p.id, { k: 'spray', vehicle: v.id, color });
      this.events.toPlayer(p.id, { k: 'msg', title: 'Striekareň ' + fuel.n, text: `Nové auto, nová identita.  −€${SPRAY_COST}`, time: 3, color: '#90caf9' });
      return;
    }
  }

  /** drowning in the Danube */
  private hazards(p: SimPlayer, dt: number) {
    const ped = p.ped;
    if (!ped.vehicle && this.world.inWater(ped.x, ped.y, ped.level)) {
      p.drown += dt;
      if (p.drown > 1.5) this.wasted(p);
    } else p.drown = 0;
  }

  /** landmarks within 45 m count as discovered */
  private discover(p: SimPlayer) {
    const f = p.focus();
    for (const l of this.world.landmarks.values()) {
      if (Math.abs(l.x - f.x) > 45 || Math.abs(l.y - f.y) > 45) continue;
      if (p.profile.found.includes(l.id) || dist(l.x, l.y, f.x, f.y) > 45) continue;
      p.profile.found.push(l.id);
      this.addMoney(p, LANDMARK_REWARD);
      this.events.toPlayer(p.id, { k: 'found', id: l.id, reward: LANDMARK_REWARD });
      this.onProfileChange?.(p);
    }
  }
}

export { WEAPONS };
