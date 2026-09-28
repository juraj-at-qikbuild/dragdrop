// Vehicle state and tyre physics (a bicycle model: axle slip angles, weight transfer, yaw inertia,
// drag, friction-limited brakes), tuned a little livelier than life. Shared by the browser and the
// game server; drawing lives in src/render/drawVehicle.ts and cosmetic effects (tyre smoke, sparks,
// splashes) in src/game/EntityFx.ts.
import type { Level, Surface, World } from '../world/World';
import { clamp } from '../util/math';
import type { Ped } from './Ped';
import { ENGINE, NO_MODS, PLATING, TANK, type Mods } from '../sim/shops/catalog';

/** New kinds go at the end (docs/plans/gameplay.md, Phase 3): the wire sends a kind as its index in
 *  SPECS, and a client from before draws one it doesn't know as a sedan. The last one, `ball`, isn't a
 *  vehicle at all but the car football's ball (docs/plans/minigames.md, Vydrž do 95. minúty): a body
 *  the physics pushes about and every client sees, like any NPC car. */
export type VehicleKind = 'hatch' | 'sedan' | 'taxi' | 'police' | 'van' | 'bus' | 'sport' | 'classic' | 'ambulance' | 'scooter' | 'bike' | 'boat' | 'policeboat' | 'ball';

/** a located-damage zone: front/rear/left/right of the car's local frame */
export type DamageZone = 'front' | 'rear' | 'left' | 'right';

/** world-event paint jobs (2 bits on the wire): the Horúca Kofolka van, the armoured cash van, derby cars */
export type Livery = 0 | 1 | 2 | 3;
export const LIVERY_NONE = 0;
export const LIVERY_KOFOLKA = 1;
export const LIVERY_ARMORED = 2;
export const LIVERY_DERBY = 3;

export interface CarSpec {
  kind: VehicleKind;
  name: string;
  length: number;
  width: number;
  /** top speed on the level (m/s) */
  maxSpeed: number;
  /** pull away from standstill, m/s² */
  accel: number;
  /** full braking on dry asphalt, m/s² (less on cobbles, in the wet and off the road) */
  brake: number;
  /** tyre grip, 7 = an ordinary car (about 1.1 g round a bend on dry asphalt) */
  grip: number;
  mass: number;
  health: number;
  colors: string[];
  drive: 'fwd' | 'rwd' | 'awd';
  /** axle grip balance (1 = neutral); <1 on the front makes it push wide (understeer), <1 on the rear makes it swing out (oversteer) */
  frontGrip: number;
  rearGrip: number;
  /** yaw moment of inertia, kg·m² — filled in below from mass/length/width */
  inertia: number;
  /** speed at which the engine's pull (falling off with speed) would reach zero — filled in below
   *  so that it meets the drag exactly at `maxSpeed` */
  vCap: number;
  /** a scooter or a bike (docs/plans/gameplay.md, Phase 3): narrow enough for a bollard row, no nitro,
   *  no fire, and the rider is out in the open (shots and knocks reach them) */
  twoWheeler?: boolean;
  /** a boat (docs/plans/gameplay.md, Phase 3): kept to the water (land is a wall to it), and it
   *  doesn't sink */
  boat?: boolean;
  /** a ball (docs/plans/minigames.md, Vydrž do 95. minúty): one round body with no driver, engine or
   *  tyres that rolls where it's knocked and bounces off walls and cars. Nothing about it breaks,
   *  burns or sinks, nobody gets in, and it knocks nobody down (Vehicle.roll, Physics' ballContact) */
  ball?: boolean;
}

/** A pitch a ball is kept on (Vehicle.pen): a rectangle centred at (x, y), its length along the angle
 *  `a`, `hl` × `hw` its half-extents; at each end a goal `gw` wide opens into a net `gd` deep. The
 *  ball bounces off its boards, the goalposts and the nets; the cars come and go as they like. */
export interface Pen {
  x: number;
  y: number;
  a: number;
  hl: number;
  hw: number;
  gw: number;
  gd: number;
}

// All vehicles are parody models, loosely styled on cars you see on Bratislava streets.
export const SPECS: Record<VehicleKind, CarSpec> = {
  hatch: { kind: 'hatch', name: 'Škodovka Felícia', length: 3.9, width: 1.66, maxSpeed: 38, accel: 8, brake: 9.5, grip: 7, mass: 1000, health: 100,
    drive: 'fwd', frontGrip: 1, rearGrip: 1.05, inertia: 0, vCap: 0,
    colors: ['#c62828', '#1565c0', '#2e7d32', '#f9a825', '#eeeeee', '#6d4c41', '#455a64', '#8e24aa'] },
  sedan: { kind: 'sedan', name: 'Octávka Kombi', length: 4.65, width: 1.8, maxSpeed: 46, accel: 9.5, brake: 10, grip: 7.5, mass: 1350, health: 110,
    drive: 'fwd', frontGrip: 1, rearGrip: 1.02, inertia: 0, vCap: 0,
    colors: ['#263238', '#b0bec5', '#37474f', '#fafafa', '#1a237e', '#4e342e', '#7b1fa2'] },
  taxi: { kind: 'taxi', name: 'Hopík Taxi', length: 4.65, width: 1.8, maxSpeed: 44, accel: 9, brake: 10, grip: 7.5, mass: 1350, health: 110,
    drive: 'fwd', frontGrip: 1, rearGrip: 1.02, inertia: 0, vCap: 0, colors: ['#fdd835'] },
  police: { kind: 'police', name: 'Policajná Octávka', length: 4.7, width: 1.82, maxSpeed: 50, accel: 11, brake: 10.5, grip: 8, mass: 1450, health: 160,
    drive: 'rwd', frontGrip: 1, rearGrip: 1, inertia: 0, vCap: 0, colors: ['#f5f5f5'] },
  van: { kind: 'van', name: 'Dodávka Kofolka', length: 5.4, width: 2.05, maxSpeed: 34, accel: 6.5, brake: 8.5, grip: 6, mass: 2200, health: 150,
    drive: 'rwd', frontGrip: 0.85, rearGrip: 1, inertia: 0, vCap: 0, colors: ['#c8102e', '#fafafa', '#1e88e5'] },
  bus: { kind: 'bus', name: 'Mestský autobus', length: 12, width: 2.55, maxSpeed: 26, accel: 4, brake: 6.5, grip: 5, mass: 11000, health: 300,
    drive: 'rwd', frontGrip: 0.8, rearGrip: 0.95, inertia: 0, vCap: 0, colors: ['#d71920'] },
  sport: { kind: 'sport', name: 'Porše 911 Blava', length: 4.5, width: 1.85, maxSpeed: 62, accel: 15, brake: 11.5, grip: 9, mass: 1400, health: 90,
    drive: 'rwd', frontGrip: 1, rearGrip: 0.85, inertia: 0, vCap: 0,
    colors: ['#ff6f00', '#212121', '#d50000', '#00bfa5'] },
  classic: { kind: 'classic', name: 'Tatrovka 603', length: 5.1, width: 1.9, maxSpeed: 40, accel: 7, brake: 8.5, grip: 6, mass: 1500, health: 140,
    drive: 'rwd', frontGrip: 1, rearGrip: 0.95, inertia: 0, vCap: 0, colors: ['#111111', '#2b2b2b', '#5d1a1a'] },
  // docs/plans/gameplay.md, Phase 3: parked at the hospitals, a siren, and it heals its driver
  ambulance: { kind: 'ambulance', name: 'Sanitka Záchranka', length: 5.6, width: 2.05, maxSpeed: 40, accel: 8, brake: 9, grip: 6.5, mass: 2400, health: 170,
    drive: 'rwd', frontGrip: 0.9, rearGrip: 1, inertia: 0, vCap: 0, colors: ['#fafafa'] },
  // docs/plans/gameplay.md, Phase 3: at the bike-share docks and the bicycle stands, 25 and 30 km/h,
  // and narrow enough (a 0.55–0.6 m body) to get through the bollard rows police cars can't
  scooter: { kind: 'scooter', name: 'Bolťák', length: 1.2, width: 0.55, maxSpeed: 7, accel: 3.2, brake: 5, grip: 7, mass: 110, health: 40,
    drive: 'rwd', frontGrip: 1, rearGrip: 1, inertia: 0, vCap: 0, colors: ['#34d186'], twoWheeler: true },
  bike: { kind: 'bike', name: 'Favoritka', length: 1.75, width: 0.6, maxSpeed: 8.5, accel: 2.8, brake: 5.5, grip: 7, mass: 95, health: 45,
    drive: 'rwd', frontGrip: 1, rearGrip: 1, inertia: 0, vCap: 0, colors: ['#1565c0', '#c62828', '#212121', '#f9a825', '#2e7d32', '#eeeeee'], twoWheeler: true },
  // docs/plans/gameplay.md, Phase 3: moored at the piers on the Danube, loose on the water (it slides
  // round a bend), and the brake is the propeller in reverse. The police boat comes at 4★
  boat: { kind: 'boat', name: 'Motorový čln', length: 5.6, width: 2.2, maxSpeed: 17, accel: 4.5, brake: 3.5, grip: 3.2, mass: 1100, health: 110,
    drive: 'rwd', frontGrip: 1, rearGrip: 0.8, inertia: 0, vCap: 0, colors: ['#fafafa', '#1565c0', '#c62828', '#263238'], boat: true },
  policeboat: { kind: 'policeboat', name: 'Policajný čln', length: 6.2, width: 2.4, maxSpeed: 18, accel: 5, brake: 4, grip: 3.5, mass: 1400, health: 170,
    drive: 'rwd', frontGrip: 1, rearGrip: 0.85, inertia: 0, vCap: 0, colors: ['#eceff1'], boat: true },
  // docs/plans/minigames.md, Vydrž do 95. minúty: the car football's ball, 1.6 m across and light next
  // to a car (a car's knock sends it off at about one and a half times the car's speed). It has no
  // engine: the driving numbers are only there to fill the spec
  ball: { kind: 'ball', name: 'Lopta', length: 1.6, width: 1.6, maxSpeed: 40, accel: 1, brake: 1, grip: 1, mass: 70, health: 100,
    drive: 'rwd', frontGrip: 1, rearGrip: 1, inertia: 0, vCap: 0, colors: ['#fafafa'], ball: true },
};
/** rolling resistance (m/s²) and air drag (per m of speed², i.e. m/s² at 1 m/s) */
const ROLL = 0.15, AERO = 0.00065;
/** a ball's (CarSpec.ball) rolling resistance and air drag, as above: a good knock at 15 m/s rolls on
 *  about 60 m, a nudge at 5 m/s about 8 (it can be dribbled) */
export const BALL_ROLL = 1.5, BALL_AIR = 0.004;
/** how much of the speed it hits them with a ball keeps, off a wall, a car, a goalpost or the pitch's
 *  boards; a goal's net takes nearly all of it, and inside one the ball soon lies still (the net
 *  sags round it: NET_DAMP of its speed goes each second) */
export const BALL_BOUNCE = 0.55;
const NET_BOUNCE = 0.05, NET_DAMP = 4;
/** a goalpost's radius (m) */
const POST_R = 0.2;
/** the slipstream's top speed gain at its strongest, and how much faster the nitro fills (per s) */
const DRAFT_TOP = 0.05;
const DRAFT_NITRO = 0.12;
/** below this share of its health an engine loses power, up to WEAK_LOSS of it */
const WEAK_HP = 0.35;
const WEAK_LOSS = 0.25;
/** how hard a fully damaged side pulls the steering (a share of full lock) */
const DMG_PULL = 0.18;

/** The speed (m/s) a car takes a bump of `kind` at without flying (0 a bump, 1 a raised table, 2 a
 *  cushion, which buses and vans straddle); 5 m/s more and it leaves the ground (overBump, and the
 *  style combo's AIR: rules/Style.ts). */
export function bumpLimit(kind: number, width: number): number {
  return [5.5, 8, width > 2 ? 30 : 9][kind] ?? 6;
}
/** over its limit by this much, a car takes off */
export const BUMP_AIR = 5;
/** a knock at least this hard (m/s of closing speed: a wall, a car, a tram) throws a scooter's or a
 *  bike's rider off (docs/plans/gameplay.md, Phase 3); a shove doesn't */
export const FALL_KNOCK = 4.5;
/** for this long after a fall (s), the rider isn't run over by what threw them off as well */
export const FALL_GRACE = 0.6;
/** what falling off costs the rider, for a knock `sev` hard (health) */
export function fallHurt(sev: number): number {
  return clamp(5 + (sev - FALL_KNOCK) * 3, 5, 30);
}
const drag = (v: number) => ROLL + AERO * v * v;
for (const k of Object.keys(SPECS) as VehicleKind[]) {
  const s = SPECS[k];
  s.inertia = (s.mass * (s.length * s.length + s.width * s.width)) / 12;
  // accel * (1 - v / vCap) = drag(v) at v = maxSpeed (a ball has no engine to cap)
  s.vCap = s.ball ? s.maxSpeed : s.maxSpeed / (1 - drag(s.maxSpeed) / s.accel);
}

export interface Controls {
  throttle: number; // -1..1
  steer: number; // -1..1 (positive = right / clockwise)
  handbrake: boolean;
  boost: boolean;
}

const STOPPED: Controls = { throttle: 0, steer: 0, handbrake: true, boost: false };

export class Vehicle {
  /** network id, assigned by Sim.addVehicle (or the server, for mirrors) */
  id = 0;
  spec: CarSpec;
  x: number;
  y: number;
  angle: number;
  vx = 0;
  vy = 0;
  av = 0;
  steer = 0;
  color: string;
  health: number;
  fire = -1; // seconds until explosion when burning
  wrecked = false;
  sinking = 0;
  driver: Ped | null = null;
  /** -1 in a tunnel, 0 on the ground or under a bridge deck, 1 on the deck (see World.updateLevel) */
  level: Level = 0;
  /** false until the first level update places it on/under a deck it spawned on (World.spawnLevel) */
  levelInit = false;
  /** id of the player driving it (0 = nobody / an NPC) */
  owner = 0;
  /** posed from outside the local simulation (a mirror of a server entity, or on the server a car its
   *  driver's client simulates): never integrated or pushed locally */
  kinematic = false;
  /** bumped when a static field (kind/colour/mission) changes, so snapshots resend it */
  rev = 0;
  /** far from every camera: the server integrates it at half rate (AI traffic only) */
  coarse = false;
  /** last player whose shots/ram damaged it, for kill credit */
  lastDamagedBy = 0;
  lastDamagedAt = -1e9;
  siren = false;
  parked = false;
  mission = false;
  /** paint job for world events (LIVERY_*), sent with the static block */
  livery: Livery = LIVERY_NONE;
  /** can't be entered at all (the armoured van: rob it by shooting the rear doors instead) */
  locked = false;
  /** a returning player's car (server/src/Room.ts): only player `reservedFor` may take it until sim
   *  time `reservedUntil` (Sim.reservedFromOthers); 0 = anyone's */
  reservedFor = 0;
  reservedUntil = 0;
  /** bullet-damage multiplier (Combat.applyShot's car branch); 1 = normal, the armoured van is 0.2 */
  armor = 1;
  /** overrides spec.health for this one vehicle's damage-fraction visuals (0 = use spec.health): the
   *  armoured van's raised health pool would otherwise look undamaged until spec.health itself ran out */
  maxHealth = 0;
  skid = 0;
  lastHit = 0;
  horn = 0;
  radius: number;
  circles: number[];
  ctrl: Controls = { throttle: 0, steer: 0, handbrake: false, boost: false };
  /** located damage 0..1, front/rear/left/right — for crumple rendering and handling penalties */
  dmg = { front: 0, rear: 0, left: 0, right: 0 };
  /** burst-tyre flag/bitmask (future spike strips): nonzero drops grip hard */
  tyresBurst = 0;
  /** nitro charge 0..1 (none on two wheels) */
  nitro = 1;
  boosting = false;
  /** slipstream, 0..1: close behind a bus, a van or a tram (set by VehiclePhysics for a player's car
   *  each step, docs/plans/gameplay.md Phase 3): a little more top speed, and the nitro fills faster */
  draft = 0;
  /** tuning (docs/plans/gameplay.md, Phase 2: the Dielňa): set with `tune`, which works out what it
   *  does to the engine */
  mods: Mods = { ...NO_MODS };
  /** the engine's pull and top speed with the tuning (see `tune`) */
  private accelK = 1;
  private topK = 1;
  private vCapT: number;
  /** a scooter or a bike: the hardest knock it took (m/s of closing speed) since whoever simulates it
   *  last looked (VehiclePhysics sets it; a rider is thrown off over FALL_KNOCK) */
  knock = 0;
  /** seconds left of the body's bounce after a jolt (a speed bump, a kerb), for drawing */
  bounce = 0;
  /** how hard that jolt was, 0..1 */
  joltK = 0;
  /** jolts so far: the client watches its own car's count for camera shake and rumble */
  jolts = 0;
  /** seconds left in the air after flying over a bump: the tyres barely touch the road (a ball: kicked
   *  up, for drawing; it still meets whatever is in its way) */
  air = 0;
  /** a ball: the pitch it's kept on, set by the game that put it there (null: loose in the city) */
  pen: Pen | null = null;
  private surf: Surface = 'asphalt';
  private surfT = 0;

  /** shared per-frame environment, set by Game before stepping vehicles */
  static env = { wet: 0 };

  constructor(kind: VehicleKind, x: number, y: number, angle: number, color: string) {
    this.spec = SPECS[kind];
    this.x = x;
    this.y = y;
    this.angle = angle;
    this.color = color;
    this.health = this.spec.health;
    this.vCapT = this.spec.vCap;
    if (this.spec.twoWheeler || this.spec.ball) this.nitro = 0;
    const r = this.spec.width / 2;
    // (a ball is the one circle)
    const n = this.spec.ball ? 1 : Math.max(2, Math.ceil(this.spec.length / this.spec.width));
    this.circles = [];
    for (let i = 0; i < n; i++) this.circles.push(n < 2 ? 0 : -this.spec.length / 2 + r + ((this.spec.length - 2 * r) * i) / (n - 1));
    this.radius = this.spec.ball ? r : Math.hypot(this.spec.length / 2, this.spec.width / 2);
  }

  get speed() {
    return Math.hypot(this.vx, this.vy);
  }
  /** signed forward speed */
  get fwdSpeed() {
    return this.vx * Math.cos(this.angle) + this.vy * Math.sin(this.angle);
  }
  get kind() {
    return this.spec.kind;
  }
  /** driven by a player (local or remote) */
  /** a police car or an ambulance: its siren works (a player's too: H, docs/plans/gameplay.md Phase 3) */
  get hasSiren() {
    return this.kind === 'police' || this.kind === 'ambulance' || this.kind === 'policeboat';
  }

  get isPlayer() {
    return this.owner !== 0;
  }

  /** Fit tuning (a copy is kept): the engine's pull and top speed, and the speed its pull fades out at
   *  so that it still meets the drag right at the new top speed (as SPECS works vCap out). */
  tune(m: Mods) {
    this.mods = { ...m };
    const e = ENGINE[Math.max(0, Math.min(ENGINE.length - 1, m.engine))];
    this.accelK = e.accel;
    this.topK = e.top;
    const top = this.spec.maxSpeed * e.top, accel = this.spec.accel * e.accel;
    this.vCapT = top / (1 - drag(top) / accel);
  }

  /** Burst the tyres (a spike strip, a shot at a wheel): not run-flats. Returns whether they burst. */
  burstTyres(): boolean {
    if (this.mods.tyres > 0 || this.tyresBurst || this.spec.ball) return false;
    this.tyresBurst = 1;
    return true;
  }

  circleAt(i: number): [number, number] {
    const o = this.circles[i];
    return [this.x + Math.cos(this.angle) * o, this.y + Math.sin(this.angle) * o];
  }
  /** centre of collision circle i, without allocating (hot paths) */
  circleX(i: number) {
    return this.x + Math.cos(this.angle) * this.circles[i];
  }
  circleY(i: number) {
    return this.y + Math.sin(this.angle) * this.circles[i];
  }

  /** Fixed-step (Game calls this at 1/120 s) tyre-model update: axle slip-angle forces, weight transfer, yaw inertia. */
  update(dt: number, world: World): number {
    const s = this.spec;
    if (s.ball) return this.roll(dt, world);
    const c = this.wrecked || this.sinking ? STOPPED : this.ctrl;
    const a0 = this.angle;

    // surface, cached and re-queried every metre or so (often enough to catch a kerb); a boat's is
    // the water, the same all over
    this.surfT -= dt;
    if (this.surfT <= 0 && !s.boat) {
      const was = this.surf;
      this.surf = world.surfaceAt(this.x, this.y, this.level);
      this.surfT = clamp(1.2 / Math.max(1, this.speed), 0.02, 0.1);
      // up the kerb of a traffic island (and down off it): a jolt that costs speed, and at speed the
      // wheels and suspension
      if ((this.surf === 'kerb') !== (was === 'kerb') && !this.wrecked) this.kerbJolt(this.surf === 'kerb');
    }
    if (this.bounce > 0) this.bounce = Math.max(0, this.bounce - dt);
    let muSurf = this.surf === 'cobble' ? 0.9 : this.surf === 'offroad' ? 0.65 : this.surf === 'steps' ? 0.6 : this.surf === 'kerb' ? 0.8 : 1;
    if (!s.boat) muSurf *= 1 - 0.28 * Vehicle.env.wet;
    // flying off a speed bump: nothing to push, brake or steer with until the wheels land
    const airborne = this.air > 0;
    if (airborne) this.air = Math.max(0, this.air - dt);
    const wheels = airborne ? 0.08 : 1;
    const tyreMul = this.tyresBurst ? 0.45 : 1;

    // nitro (a bigger tank lasts longer; none on two wheels)
    if (c.boost && this.nitro > 0) {
      this.nitro = Math.max(0, this.nitro - (0.35 / TANK[this.mods.nitro]) * dt);
      this.boosting = true;
    } else {
      this.boosting = false;
      if (!s.twoWheeler) this.nitro = Math.min(1, this.nitro + (0.03 + DRAFT_NITRO * this.draft) * dt);
    }
    const boostAccel = this.boosting ? 1.6 : 1;
    const boostTop = this.boosting ? 1.25 : 1;
    const dmgTop = 1 - 0.2 * this.dmg.front;
    const dmgSteer = 1 - 0.35 * this.dmg.front;
    const draftK = 1 + DRAFT_TOP * this.draft;
    const vCap = this.vCapT * boostTop * dmgTop * draftK;
    const maxSpeed = s.maxSpeed * this.topK * boostTop * dmgTop * draftK;
    // a badly damaged engine (smoking, see EntityFx) loses power, up to a quarter of it at the end
    const full = this.maxHealth || s.health;
    const power = this.health < full * WEAK_HP ? 1 - WEAK_LOSS * (1 - Math.max(0, this.health) / (full * WEAK_HP)) : 1;
    /** reverse gear tops out around 30 km/h */
    const revMax = Math.min(8.5, s.maxSpeed * 0.25);

    const fx = Math.cos(this.angle), fy = Math.sin(this.angle);
    const rx = -fy, ry = fx;
    let vF = this.vx * fx + this.vy * fy;
    let vR = this.vx * rx + this.vy * ry;

    // engine / brakes -> longitudinal accel this step (also drives weight transfer below). Braking
    // is friction-limited (wet or loose surfaces stretch it out), and so is putting power down.
    const muLong = clamp(muSurf, 0.35, 1);
    const tIn = c.throttle;
    // ABS: braking while steering, the brakes back off a little so the front wheels still steer
    const abs = 1 - 0.3 * Math.min(1, Math.abs(this.steer));
    let ax = 0, braking = 0;
    if (tIn > 0 && vF < -0.5) (ax = s.brake * muLong * tIn * abs), (braking = tIn * abs); // reversing: brake first
    else if (tIn > 0) ax = s.accel * this.accelK * power * tIn * boostAccel * Math.sqrt(muLong) * Math.max(0, 1 - Math.max(0, vF) / vCap);
    else if (tIn < 0 && vF > 0.5) (ax = s.brake * muLong * tIn * abs), (braking = -tIn * abs);
    else if (tIn < 0) ax = vF > -revMax ? s.accel * 0.5 * muLong * tIn : 0;
    else ax = -Math.sign(vF) * Math.min(Math.abs(vF) / dt, ENGINE_BRAKE);
    ax *= wheels;
    // air drag and rolling resistance (never enough to reverse the car), and the rough off the road
    const rough = airborne ? 0 : this.surf === 'offroad' ? OFFROAD_DRAG : this.surf === 'steps' ? STEPS_DRAG : this.surf === 'kerb' ? KERB_DRAG : 0;
    const resist = drag(Math.abs(vF)) + rough * Math.min(1, Math.abs(vF) / 4);
    ax -= Math.sign(vF) * Math.min(Math.abs(vF) / dt, resist);
    vF += ax * dt;
    if (c.handbrake && !airborne) vF -= Math.sign(vF) * Math.min(Math.abs(vF), 5 * muLong * dt);
    vF = clamp(vF, -revMax - 0.5, maxSpeed * 1.15);

    // steering: the wheels turn as far as a driver would at this speed, about as far as the front
    // tyres grip (a keyboard's full lock then carves the tightest line the car holds, instead of
    // plowing straight on), tighter in a parking manoeuvre. A player's wheel turns quicker, and
    // centres quicker still, so a tapped key is a short, crisp correction.
    const assist = this.isPlayer;
    // a damaged side pulls the wheel toward it (a player's car: traffic's drivers hold it straight)
    const want = assist && Math.abs(vF) > 3 ? clamp(c.steer + (this.dmg.right - this.dmg.left) * DMG_PULL, -1, 1) : c.steer;
    const centring = want * this.steer < 0 || Math.abs(want) < Math.abs(this.steer);
    this.steer += (want - this.steer) * Math.min(1, dt * (assist ? (centring ? PLAYER_STEER_CENTRE : PLAYER_STEER_IN) : 8));
    const wheelbase = s.length * 0.6;
    const a = wheelbase * 0.5, b = wheelbase * 0.5; // axle distances from CG
    const vAbs = Math.abs(vF);
    const gripK = assist ? PLAYER_GRIP : 1;
    const latMax = 2 * TIRE_FORCE * 0.9 * (s.grip / 7) * muSurf * gripK;
    const maxSteer = Math.min(0.6, (1.15 * wheelbase * latMax) / Math.max(1, vAbs * vAbs) + 0.04) * dmgSteer;
    const steerAngle = this.steer * maxSteer;

    // weight transfer: braking loads the front, throttle loads the rear
    const staticF = s.mass * 4.9, staticR = s.mass * 4.9; // (mass*g/2)
    const transfer = clamp((s.mass * ax * 0.5) / wheelbase, -staticF * 0.6, staticR * 0.6);
    const loadF = Math.max(0.2 * staticF, staticF - transfer);
    const loadR = Math.max(0.2 * staticR, staticR + transfer);

    // axle slip angles, measured against |vF| so they stay small when rolling backwards (atan2 with a
    // negative x lands near ±PI and saturates the tyres). In reverse the steered wheels lead the other
    // way, so the steer term flips sign: wheel right swings the tail right, like a real car. It fades out
    // at a standstill so a parked car can't pivot on the spot.
    const dir = clamp(vF / 1.5, -1, 1);
    const vFa = Math.max(vAbs, 1.5);
    const slipF = Math.atan2(vR + a * this.av, vFa) - steerAngle * dir;
    const slipR = Math.atan2(vR - b * this.av, vFa);

    const muF = (s.grip / 7) * muSurf * s.frontGrip * tyreMul * gripK;
    // the handbrake locks the rear wheels: a locked tyre slides with little sideways grip
    const muR = (s.grip / 7) * muSurf * s.rearGrip * tyreMul * gripK * (c.handbrake ? 0.2 : 1);
    // Fy is a genuine force (N): tireCurve * mu * load-fraction * peak-accel-per-tyre * mass,
    // so dividing by mass below gives back the peak accel, and dividing by inertia gives a sane yaw accel.
    let FyF = -tireCurve(slipF) * muF * (loadF / staticF) * TIRE_FORCE * s.mass * wheels;
    let FyR = -tireCurve(slipR) * muR * (loadR / staticR) * TIRE_FORCE * s.mass * wheels;
    // friction ellipse: tyres that brake or drive hard give up some of their cornering grip (the
    // brakes are biased to the front, so braking mostly costs the front tyres theirs)
    const driveF = s.drive === 'fwd' ? 1 : s.drive === 'awd' ? 0.5 : 0;
    const driveR = s.drive === 'rwd' ? 1 : s.drive === 'awd' ? 0.5 : 0;
    const demand = braking ? 0 : clamp(Math.abs(ax) / s.accel, 0, 1);
    FyF *= Math.sqrt(Math.max(0.15, 1 - 0.6 * (demand * driveF) ** 2 - 0.5 * braking * braking));
    FyR *= Math.sqrt(Math.max(0.15, 1 - 0.6 * (demand * driveR) ** 2 - 0.15 * braking * braking));

    vR += ((FyF + FyR) / s.mass) * dt;
    let avAccel = (a * FyF - b * FyR) / s.inertia;
    avAccel -= this.av * 0.3; // passive yaw damping
    if (Math.abs(vR) > 2.5 && this.steer * dir !== 0 && Math.sign(this.steer * dir) === -Math.sign(this.av)) avAccel -= this.av * 1.2; // counter-steer assist
    // a player's yaw control: the car turns at the rate its wheels ask for (as tight as the weaker
    // axle holds, so it never throws the car into a slide). Rotating more than that (overshooting
    // into a bend, or still swinging after the key is let go) is reined in hard; falling behind it
    // gets a gentler push while the rear tyres still grip. Off with the handbrake, and gentler in
    // the sports car, so drifts and handbrake turns still work; it fades out at a crawl, where a
    // shove can still spin the car.
    if (assist && !c.handbrake) {
      const rMax = (0.9 * latMax * tyreMul * Math.min(s.frontGrip, s.rearGrip)) / Math.max(1, vAbs);
      const err = clamp((vF * Math.tan(steerAngle)) / wheelbase, -rMax, rMax) - this.av;
      const k = err * this.av < 0 ? (s.kind === 'sport' ? 6 : 12) : 8 * clamp((0.14 - Math.abs(slipR)) / 0.08, 0, 1);
      avAccel += err * k * wheels * clamp((vAbs - 1) / 4, 0, 1);
    }
    // stability control: once the body rotates faster than the tyres are turning the car's path
    // (the tail stepping out under braking, or lifting off mid-bend), it's reined back, so an
    // ordinary car doesn't spin. Off with the handbrake, and gentler in the sports car, so drifts and
    // handbrake turns still work.
    if (!c.handbrake && vAbs > 3) {
      const pathRate = (FyF + FyR) / s.mass / vAbs;
      const excess = this.av - pathRate;
      const slip = Math.abs(Math.atan2(vR, vAbs));
      if (slip > 0.06 && Math.sign(excess) === Math.sign(this.av)) avAccel -= excess * (s.kind === 'sport' ? 6 : 14) * Math.min(1, (slip - 0.06) / 0.06);
    }
    this.av += avAccel * dt;
    this.angle += this.av * dt;

    this.skid = s.boat ? 0 : Math.abs(vR) > 2.5 || (c.handbrake && Math.abs(vF) > 6) || (braking > 0.8 && vAbs > 8 && muLong < 0.8) ? clamp(Math.abs(vR) / 7 + 0.3, 0, 1) : 0;

    // back to the world: the forces above acted in the frame the car was in at the start of the
    // step, so the velocity only turns as far as the tyres turned it (rotating it with the body for
    // free let cars round a corner at 90 km/h in 10 m)
    this.vx = fx * vF - fy * vR;
    this.vy = fy * vF + fx * vR;
    const x0 = this.x, y0 = this.y;
    this.x += this.vx * dt;
    this.y += this.vy * dt;
    // speed bumps and raised tables: over one too fast and the car takes off
    if (this.level === 0 && world.bumps.n) {
      const kind = world.bumps.crossed(x0, y0, this.x, this.y);
      if (kind >= 0) this.overBump(kind, vF);
    }

    // walls: impulse at the contact point, no energy gain
    let impact = 0;
    const r = s.width / 2;
    for (let i = 0; i < this.circles.length; i++) {
      const cx = this.circleX(i), cy = this.circleY(i);
      const hit = world.collideCircle(cx, cy, r, this.level);
      if (!hit) continue;
      this.x += hit.nx * hit.depth;
      this.y += hit.ny * hit.depth;
      // hit.n points out of the wall; resolveContact wants the normal from the car towards what it hit,
      // applied at the circle's rim where it touches. Extra yaw inertia keeps an angled hit a deflection
      // along the wall rather than a spin-out.
      const px = cx - hit.nx * (r - hit.depth), py = cy - hit.ny * (r - hit.depth);
      const sev = resolveContact(this, px, py, null, px, py, -hit.nx, -hit.ny, 0.25, 0.45, undefined, 2.5);
      impact = Math.max(impact, sev);
    }
    if (s.boat) impact = Math.max(impact, this.afloat(world, x0, y0, a0));
    if (impact > 7) this.damage((impact - 7) * 1.6);

    // water (a boat's element)
    if (!s.boat && !this.sinking && world.inWater(this.x, this.y, this.level)) this.sinking = 0.001;
    if (this.sinking) {
      this.sinking += dt;
      this.vx *= 1 - dt * 2;
      this.vy *= 1 - dt * 2;
    }
    if (this.fire > 0) this.fire -= dt;
    if (this.horn > 0) this.horn -= dt;
    return impact;
  }

  /** A ball's step (CarSpec.ball): it rolls on the way it was knocked, slowing down, and bounces off
   *  walls and, on a pitch (`pen`), off its boards, the goalposts and the nets. No tyres, no engine,
   *  no spin worth simulating (the way it turns is only drawn), and nothing it meets damages it:
   *  returns 0, so a ball against a wall is never a crash. It never goes under either: it floats. */
  private roll(dt: number, world: World): number {
    const sp = Math.hypot(this.vx, this.vy);
    if (sp > 0) {
      const slow = Math.min(sp, (BALL_ROLL + BALL_AIR * sp * sp) * dt);
      this.vx -= (this.vx / sp) * slow;
      this.vy -= (this.vy / sp) * slow;
    }
    this.av = 0;
    if (this.air > 0) this.air = Math.max(0, this.air - dt);
    this.x += this.vx * dt;
    this.y += this.vy * dt;
    const hit = world.collideCircle(this.x, this.y, this.spec.width / 2, this.level);
    if (hit) {
      this.x += hit.nx * hit.depth;
      this.y += hit.ny * hit.depth;
      const vn = this.vx * hit.nx + this.vy * hit.ny;
      if (vn < 0) (this.vx -= (1 + BALL_BOUNCE) * vn * hit.nx), (this.vy -= (1 + BALL_BOUNCE) * vn * hit.ny);
    }
    if (this.pen) this.keepOn(this.pen, dt);
    return 0;
  }

  /** Keep a ball on its pitch: off the four goalposts; in a net once it's over a goal line between
   *  the posts (where the net soon stops it); inside the boards everywhere else. Worked out in the
   *  pitch's own frame, where every edge is straight, so however hard a car shoves the ball through one
   *  it comes back on the right side of it. */
  private keepOn(p: Pen, dt: number) {
    const r = this.spec.width / 2;
    const ca = Math.cos(p.a), sa = Math.sin(p.a);
    const dx = this.x - p.x, dy = this.y - p.y;
    let lx = dx * ca + dy * sa, ly = -dx * sa + dy * ca;
    let vl = this.vx * ca + this.vy * sa, vw = -this.vx * sa + this.vy * ca;
    let moved = false;
    for (let i = 0; i < 4; i++) {
      const px = (i & 1 ? 1 : -1) * p.hl, py = (i & 2 ? 1 : -1) * (p.gw / 2);
      const ex = lx - px, ey = ly - py, d = Math.hypot(ex, ey), rr = r + POST_R;
      if (d >= rr || d < 1e-6) continue;
      const nx = ex / d, ny = ey / d;
      lx = px + nx * rr;
      ly = py + ny * rr;
      const vn = vl * nx + vw * ny;
      if (vn < 0) (vl -= (1 + BALL_BOUNCE) * vn * nx), (vw -= (1 + BALL_BOUNCE) * vn * ny);
      moved = true;
    }
    // (an edge the ball is over sends back what it still carries toward it, `e` of it)
    const clamp1 = (v: number, lim: number) => (v > lim ? lim : v < -lim ? -lim : v);
    const mouth = Math.abs(ly) < p.gw / 2;
    if (mouth && Math.abs(lx) > p.hl) {
      const side = p.gw / 2 - r, back = p.hl + p.gd - r;
      if (Math.abs(ly) > side) (ly = clamp1(ly, side)), (vw = vw * ly > 0 ? -vw * NET_BOUNCE : vw);
      if (Math.abs(lx) > back) (lx = clamp1(lx, back)), (vl = vl * lx > 0 ? -vl * NET_BOUNCE : vl);
      const k = Math.max(0, 1 - NET_DAMP * dt);
      (vl *= k), (vw *= k), (moved = true);
    } else {
      const side = p.hw - r, end = p.hl - r;
      if (Math.abs(ly) > side) (ly = clamp1(ly, side)), (vw = vw * ly > 0 ? -vw * BALL_BOUNCE : vw), (moved = true);
      if (!mouth && Math.abs(lx) > end) (lx = clamp1(lx, end)), (vl = vl * lx > 0 ? -vl * BALL_BOUNCE : vl), (moved = true);
    }
    if (!moved) return;
    this.x = p.x + lx * ca - ly * sa;
    this.y = p.y + lx * sa + ly * ca;
    this.vx = vl * ca - vw * sa;
    this.vy = vl * sa + vw * ca;
  }

  /** A boat's bow or stern ran onto the bank (or a pier): it's back where it was and bounces off, and
   *  its speed is how hard it hit. */
  private afloat(world: World, x0: number, y0: number, a0: number): number {
    // (the hull a little inside its drawn outline: its bow and quarters may just touch the bank)
    if (world.afloat(this.x, this.y, this.angle, this.spec.length * 0.9, this.spec.width * 0.8)) return 0;
    const sev = this.speed;
    this.x = x0;
    this.y = y0;
    this.angle = a0;
    this.vx *= -0.3;
    this.vy *= -0.3;
    this.av *= -0.3;
    return sev;
  }

  /** Rolled over a bump of kind 0 speed bump, 1 raised table, 2 cushions, 3 rumble strip at forward
   *  speed vF: gentle below the speed it's built for, a hard jolt above it, airborne well above. */
  private overBump(kind: number, vF: number) {
    const v = Math.abs(vF);
    if (kind === 3) return this.jolt(Math.min(0.2, v / 60), 0.2);
    const over = v - bumpLimit(kind, this.spec.width);
    if (over <= 0) return this.jolt(Math.min(0.15, v / 40), 0.3);
    const k = clamp(over / 12, 0.15, 1);
    const keep = 1 - clamp(over * 0.012, 0, 0.18);
    this.vx *= keep;
    this.vy *= keep;
    if (over > BUMP_AIR) this.air = Math.max(this.air, clamp((over - BUMP_AIR) * 0.03, 0.05, 0.45));
    if (over > 11) {
      this.damage((over - 11) * 2);
      this.dmg.front = clamp(this.dmg.front + 0.03, 0, 1);
    }
    this.jolt(k, 0.45);
  }

  /** Up onto (or down off) a traffic island's kerb. */
  private kerbJolt(up: boolean) {
    const v = this.speed;
    if (v < 1.5) return;
    const keep = 1 - clamp((up ? 0.05 : 0.02) + v * (up ? 0.006 : 0.002), 0, up ? 0.25 : 0.08);
    this.vx *= keep;
    this.vy *= keep;
    if (up && v > 14) {
      this.damage((v - 14) * 1.2);
      this.dmg.front = clamp(this.dmg.front + (v - 14) * 0.006, 0, 1);
      if (v > 24) this.air = Math.max(this.air, 0.12);
    }
    this.jolt(clamp(v / (up ? 18 : 30), 0.1, 1), 0.35);
  }

  private jolt(k: number, t: number) {
    this.joltK = k;
    this.bounce = t;
    this.jolts++;
  }

  damage(amount: number) {
    // (a ball takes no damage, so it never burns either)
    if (this.wrecked || this.spec.ball) return;
    this.health -= amount * PLATING[this.mods.plating];
    // a car catches fire and blows up 3.5 s later; a scooter or a bike is just broken (Sim.wreck)
    if (this.health <= 0 && this.fire < 0) this.fire = this.spec.twoWheeler ? 0 : 3.5;
  }

  /** Which local zone (front/rear/left/right) a world-space point falls into (e.g. the armoured
   *  van's rear doors: `v.damageZoneAt(hx, hy) === 'rear'`). */
  damageZoneAt(px: number, py: number): DamageZone {
    const fx = Math.cos(this.angle), fy = Math.sin(this.angle);
    const rx = -fy, ry = fx;
    const dx = px - this.x, dy = py - this.y;
    const lx = dx * fx + dy * fy, ly = dx * rx + dy * ry;
    return Math.abs(lx) > Math.abs(ly) ? (lx > 0 ? 'front' : 'rear') : ly > 0 ? 'right' : 'left';
  }

  /** Convert a world-space impact point to a local damage zone and accumulate. */
  applyDamageAt(px: number, py: number, amount: number) {
    if (amount <= 0 || this.spec.ball) return;
    const zone = this.damageZoneAt(px, py);
    this.dmg[zone] = clamp(this.dmg[zone] + amount, 0, 1);
  }

  /** Top up nitro charge (0..1), e.g. from a pickup (none on two wheels, nor in a ball). */
  addNitro(x: number) {
    if (!this.spec.twoWheeler && !this.spec.ball) this.nitro = clamp(this.nitro + x, 0, 1);
  }

  /** Apply AI or player controls (clamped). */
  setControls(throttle: number, steer: number, handbrake = false, boost = false) {
    this.ctrl.throttle = clamp(throttle, -1, 1);
    this.ctrl.steer = clamp(steer, -1, 1);
    this.ctrl.handbrake = handbrake;
    this.ctrl.boost = boost;
  }

}

const SLIP_PEAK = 0.15; // rad, ~8.6°, where a tyre's lateral force peaks
/** m/s² of lateral accel one fully loaded axle with grip 7 gives: both together hold ~1.1 g */
const TIRE_FORCE = 5.6;
/** A player's car grips this much harder than traffic (about 2 g round a bend on dry asphalt): at
 *  real-car grip a junction has to be taken at 40 km/h, and at 90 km/h full lock needs a 60 m circle. */
const PLAYER_GRIP = 2;
/** how fast a player's steering follows the key or stick (1/s): turning in, and back to centre */
const PLAYER_STEER_IN = 12;
const PLAYER_STEER_CENTRE = 16;
/** lifting off the throttle: engine braking in gear, m/s² */
const ENGINE_BRAKE = 0.9;
/** extra drag rolling over grass and gravel, m/s² */
const OFFROAD_DRAG = 1.4;
/** ...and bumping down a flight of steps */
const STEPS_DRAG = 5;
/** ...and over a traffic island's kerbs and verge */
const KERB_DRAG = 2.4;

/** Slip-angle -> normalized lateral force: rises to a peak near SLIP_PEAK, then softens a little as the
 *  tyre slides (real tyre behaviour; kept gentle, so a car at the limit slides progressively instead of
 *  snapping round). */
function tireCurve(slip: number): number {
  const x = clamp(slip / SLIP_PEAK, -4, 4);
  const base = Math.tanh(x * 1.3);
  const falloff = 1 - 0.08 * clamp(Math.abs(x) - 1, 0, 4);
  return base * Math.max(0.75, falloff);
}

/**
 * Resolves a contact-point impulse between vehicle `a` and either vehicle `b`, or an immovable surface
 * (b = null): a wall (bVel omitted) or a tram (bVel = its velocity at the contact, infinite mass so it
 * doesn't move). Restitution + Coulomb friction + angular terms from r×n keep it bounded (no energy gain)
 * and let side-swipes spin cars. `n` points from `a` towards `b` (into the wall/tram), i.e. opposite to the
 * direction `a` gets pushed out. `yawInertiaMul` > 1 makes `a` harder to spin (arcade-tuned wall hits).
 * Applies located damage on every party hit, unless `dent` is false (a ball: nobody's dented by one).
 * Returns the impact severity.
 */
export function resolveContact(
  a: Vehicle, cax: number, cay: number,
  b: Vehicle | null, cbx: number, cby: number,
  nx: number, ny: number,
  restitution: number, friction: number,
  bVel?: { vx: number; vy: number; av: number },
  yawInertiaMul = 1,
  dent = true,
): number {
  const invMa = 1 / a.spec.mass, invIa = 1 / (a.spec.inertia * yawInertiaMul);
  const invMb = b ? 1 / b.spec.mass : 0, invIb = b ? 1 / b.spec.inertia : 0;
  const rax = cax - a.x, ray = cay - a.y;
  const rbx = b ? cbx - b.x : 0, rby = b ? cby - b.y : 0;
  const bv = b ? { vx: b.vx, vy: b.vy, av: b.av } : bVel ?? { vx: 0, vy: 0, av: 0 };
  const pax = a.vx - a.av * ray, pay = a.vy + a.av * rax;
  const pbx = bv.vx - bv.av * rby, pby = bv.vy + bv.av * rbx;
  const rvx = pbx - pax, rvy = pby - pay;
  const vn = rvx * nx + rvy * ny;
  if (vn >= 0) return 0; // already separating

  const rCrossNa = rax * ny - ray * nx, rCrossNb = rbx * ny - rby * nx;
  const denomN = invMa + invMb + rCrossNa * rCrossNa * invIa + rCrossNb * rCrossNb * invIb;
  const jn = (-(1 + restitution) * vn) / (denomN || 1e-6);
  a.vx -= jn * nx * invMa;
  a.vy -= jn * ny * invMa;
  a.av -= rCrossNa * jn * invIa;
  if (b) {
    b.vx += jn * nx * invMb;
    b.vy += jn * ny * invMb;
    b.av += rCrossNb * jn * invIb;
  }

  const tx = -ny, ty = nx;
  const vt = rvx * tx + rvy * ty;
  const rCrossTa = rax * ty - ray * tx, rCrossTb = rbx * ty - rby * tx;
  const denomT = invMa + invMb + rCrossTa * rCrossTa * invIa + rCrossTb * rCrossTb * invIb;
  let jt = -vt / (denomT || 1e-6);
  const maxJt = friction * Math.abs(jn);
  jt = clamp(jt, -maxJt, maxJt);
  a.vx -= jt * tx * invMa;
  a.vy -= jt * ty * invMa;
  a.av -= rCrossTa * jt * invIa;
  if (b) {
    b.vx += jt * tx * invMb;
    b.vy += jt * ty * invMb;
    b.av += rCrossTb * jt * invIb;
  }

  const sev = -vn;
  if (!dent) return sev;
  a.applyDamageAt(cax, cay, clamp((sev - 3) * 0.06, 0, 0.4));
  if (b) b.applyDamageAt(cbx, cby, clamp((sev - 3) * 0.06, 0, 0.4));
  return sev;
}

