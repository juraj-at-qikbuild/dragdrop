// Scooters and bikes (docs/plans/gameplay.md, Phase 3): narrow enough for a bollard row a car can't
// pass, 25 and 30 km/h, no nitro, no crime to take, a rider thrown off by a hard knock (not a nudge)
// and out in the open to shots, and parked at the real docks and stands near players.
import { describe, expect, it } from 'vitest';
import { Sim } from '../../src/shared/sim/Sim';
import { Rng } from '../../src/shared/util/Rng';
import { Ped } from '../../src/shared/entities/Ped';
import { SERVER_CAPS } from '../../src/shared/sim/density';
import { FALL_KNOCK, Vehicle, fallHurt, type VehicleKind } from '../../src/shared/entities/Vehicle';
import { VehiclePhysics } from '../../src/shared/sim/Physics';
import { HitKind } from '../../src/shared/sim/Combat';
import { bikeSpot, type Bikes } from '../../src/shared/sim/rules/Bikes';
import type { PrivateEvent } from '../../src/shared/sim/events';
import type { Jobs } from '../../src/shared/sim/rules/jobs/Jobs';
import { nullEvents } from '../../src/shared/sim/events';
import { dist } from '../../src/shared/util/math';
import { linkPoints, type Link } from '../../src/shared/world/Graph';
import { loadWorld } from './helpers';

const EMPTY = { ...SERVER_CAPS, traffic: 0, parked: 0, peds: 0, trams: 0, police: 0 };
const profile = () => ({ money: 0, done: [], found: [...loadWorld().landmarks.keys()], cumils: [] });

/** Ride a `kind` along waypoints (a simple follow-the-points rider, as world.test.ts's drive()). */
function ride(kind: VehicleKind, pts: number[], maxT = 60, cruise = 9) {
  const w = loadWorld();
  const v = new Vehicle(kind, pts[0], pts[1], Math.atan2(pts[3] - pts[1], pts[2] - pts[0]), '#fff');
  v.level = w.spawnLevel(v.x, v.y, v.spec.width / 2, v.angle);
  let i = 2, t = 0, maxImpact = 0, top = 0;
  const dt = 1 / 120;
  while (i < pts.length && t < maxT) {
    const dx = pts[i] - v.x, dy = pts[i + 1] - v.y;
    if (Math.hypot(dx, dy) < 2) {
      i += 2;
      continue;
    }
    let diff = Math.atan2(dy, dx) - v.angle;
    while (diff > Math.PI) diff -= 2 * Math.PI;
    while (diff < -Math.PI) diff += 2 * Math.PI;
    v.setControls(v.fwdSpeed < cruise ? 1 : 0, Math.max(-1, Math.min(1, diff * 2.2)), false, true);
    w.updateLevel(v, v.vx, v.vy, v.spec.width / 2);
    maxImpact = Math.max(maxImpact, v.update(dt, w));
    top = Math.max(top, v.speed);
    t += dt;
  }
  return { reached: i >= pts.length, maxImpact, top, v };
}

/** a player riding a fresh `kind` in an empty city, and events sent to them */
function riding(kind: VehicleKind = 'scooter', seed = 1, rules?: 'offline') {
  const sent: PrivateEvent[] = [];
  const sim = new Sim(loadWorld(), { rng: new Rng(seed), caps: EMPTY, rules, events: { ...nullEvents, toPlayer: (_id: number, e: PrivateEvent) => sent.push(e) } });
  const p = sim.addPlayer({ nick: 'A', profile: profile(), kinematic: false });
  const v = sim.addVehicle(new Vehicle(kind, p.ped.x + 1.2, p.ped.y, 0, '#34d186'));
  v.parked = true;
  expect(sim.enterVehicle(p, v, 5)).toBe(true);
  return { sim, p, v, sent };
}

/** a long, straight street */
function straight(): number[] {
  const w = loadWorld();
  for (const e of w.car.edges) {
    if (e.cls > 4 || e.len < 120) continue;
    const p = linkPoints({ edge: e, fwd: true, to: e.b } as Link);
    if (Math.hypot(p[p.length - 2] - p[0], p[p.length - 1] - p[1]) > e.len * 0.99) return [p[0], p[1], p[p.length - 2], p[p.length - 1]];
  }
  throw new Error('no straight street');
}

describe('scooters and bikes', () => {
  // Uršulínska at Primaciálne námestie: world.test.ts shows a sedan stopped by its bollards (four
  // posts 1.5 m apart across the street); the way through is square on to the row, between two
  const URSULINSKA = [-229.7, -393.1, -224.7, -385.3, -207.5, -364.9, -200, -356];
  const THROUGH_THE_GAP = [-224.7, -385.3, -212.5, -369.7, -204.7, -360.6, -200, -356];

  it('get through the bollard row a car can\'t (the car graph stays cut there for the police)', () => {
    expect(ride('sedan', URSULINSKA, 8, 8).reached).toBe(false);
    expect(ride('sedan', THROUGH_THE_GAP, 8, 8).reached).toBe(false);
    for (const kind of ['scooter', 'bike'] as const) {
      const r = ride(kind, THROUGH_THE_GAP, 20, 8);
      expect(r.reached, kind).toBe(true);
      expect(r.maxImpact, kind).toBeLessThan(FALL_KNOCK);
    }
    expect(loadWorld().car.nearest(-207.5, -364.9, 3)).toBe(-1);
  });

  it('top out at 25 and 30 km/h, with no nitro to boost', () => {
    // (the boost key is held all the way: ride() sets it)
    const pts = straight();
    const scooter = ride('scooter', pts, 20, 99), bike = ride('bike', pts, 20, 99);
    expect(scooter.top).toBeGreaterThan(6.5);
    expect(scooter.top).toBeLessThan(7.3);
    expect(bike.top).toBeGreaterThan(8);
    expect(bike.top).toBeLessThan(8.8);
    expect(scooter.v.nitro).toBe(0);
    expect(scooter.v.boosting).toBe(false);
    scooter.v.addNitro(0.5);
    expect(scooter.v.nitro).toBe(0);
  });

  it('stop within a few metres, and a swerve at full speed doesn\'t spin them', () => {
    const w = loadWorld();
    for (const kind of ['scooter', 'bike'] as const) {
      // along a straight street, from full speed
      const pts = straight();
      const a = Math.atan2(pts[3] - pts[1], pts[2] - pts[0]);
      const brake = (script: (t: number, v: Vehicle) => [number, number]) => {
        const v = new Vehicle(kind, pts[0], pts[1], a, '#fff');
        v.owner = 1;
        v.vx = Math.cos(a) * v.spec.maxSpeed;
        v.vy = Math.sin(a) * v.spec.maxSpeed;
        let slip = 0;
        for (let t = 0; t < 3; t += 1 / 120) {
          v.setControls(...script(t, v));
          v.update(1 / 120, w);
          if (v.speed > 2 && v.fwdSpeed > 0) slip = Math.max(slip, Math.abs(Math.atan2(-v.vx * Math.sin(v.angle) + v.vy * Math.cos(v.angle), v.fwdSpeed)));
        }
        return { d: Math.hypot(v.x - pts[0], v.y - pts[1]), v, slip };
      };
      const stop = brake((_t, v) => [v.fwdSpeed > 0.2 ? -1 : 0, 0]);
      expect(stop.d, kind).toBeGreaterThan(3);
      expect(stop.d, kind).toBeLessThan(10);
      expect(stop.v.speed, kind).toBeLessThan(0.3);
      const swerve = brake((t) => [0.5, t < 0.3 ? 1 : t < 0.6 ? -1 : 0]);
      expect((swerve.slip * 180) / Math.PI, kind).toBeLessThan(15);
    }
  });

  it('are nobody\'s: taking one is no crime', () => {
    const { p } = riding('bike');
    expect(p.wanted).toBe(0);
  });

  it('a car driven into the rider throws them off and hurts them; a nudge doesn\'t', () => {
    for (const [speed, falls] of [[1.2, false], [10, true]] as const) {
      const { sim, p, v, sent } = riding('scooter', 3);
      // a van from the side, at `speed`
      const van = sim.addVehicle(new Vehicle('van', v.x, v.y - 4.2, Math.PI / 2, '#fff'));
      van.vy = speed;
      for (let t = 0; t < 0.6 && p.ped.vehicle; t += 1 / 60) {
        van.setControls(0, 0, false);
        sim.step(1 / 60);
      }
      // (the van goes, before it runs the fallen rider over as well)
      sim.removeVehicle(van);
      expect(!!p.ped.vehicle, `at ${speed} m/s`).toBe(!falls);
      if (!falls) continue;
      expect(p.ped.health).toBeLessThan(100);
      expect(p.ped.health).toBeGreaterThanOrEqual(100 - 30);
      expect(sent.some((e) => e.k === 'eject' && e.fall && e.vehicle === v.id)).toBe(true);
      // on foot beside it, and it's there to get back on
      expect(dist(p.ped.x, p.ped.y, v.x, v.y)).toBeLessThan(4);
      expect(v.wrecked).toBe(false);
    }
  });

  it('riding flat out into a wall throws the rider off', () => {
    const w = loadWorld();
    const { sim, p, v } = riding('bike', 4);
    // straight at the nearest building wall, from 12 m away
    let hit: { x: number; y: number; a: number } | null = null;
    for (let a = 0; a < Math.PI * 2 && !hit; a += Math.PI / 16) {
      const x = v.x + Math.cos(a) * 12, y = v.y + Math.sin(a) * 12;
      if (w.raycast(v.x, v.y, x, y) < 1) hit = { x, y, a };
    }
    expect(hit).not.toBeNull();
    v.angle = hit!.a;
    v.vx = Math.cos(v.angle) * 8.5;
    v.vy = Math.sin(v.angle) * 8.5;
    for (let t = 0; t < 3 && p.ped.vehicle; t += 1 / 60) {
      v.setControls(1, 0, false);
      sim.step(1 / 60);
    }
    expect(p.ped.vehicle).toBeNull();
  });

  it('breaking under the rider: no fire, no blast, and they land beside it', () => {
    const { sim, p, v } = riding('scooter', 5);
    let blasts = 0;
    (sim as unknown as { events: { explode: () => void } }).events.explode = () => void blasts++;
    sim.damageVehicle(v, 500);
    sim.step(1 / 60);
    expect(v.wrecked).toBe(true);
    expect(v.fire).toBe(-1);
    expect(blasts).toBe(0);
    expect(p.ped.vehicle).toBeNull();
    expect(p.state).toBe('play');
  });

  it('the rider is out in the open: a shot at them hurts as it would on foot', () => {
    const hurt = (kind: VehicleKind) => {
      const { sim, p, v } = riding(kind, 6);
      const shooter = sim.addPlayer({ nick: 'B', profile: profile(), kinematic: false, x: v.x - 6, y: v.y });
      shooter.ammo.pistol = 10;
      sim.applyShot(shooter, { w: 'pistol', ox: v.x - 5, oy: v.y, a: 0, lvl: 0, pellets: [{ a: 0, kind: HitKind.Car, hit: v.id, hx: v.x - 0.3, hy: v.y }] });
      return 100 - p.ped.health;
    };
    const onScooter = hurt('scooter'), inCar = hurt('sedan');
    expect(inCar).toBeGreaterThan(0);
    expect(onScooter).toBeGreaterThan(inCar * 2.5);
  });

  it('a Vlk courier can ride one; a Hopík taxi fare can\'t', () => {
    const courier = riding('bike', 9, 'offline');
    courier.sim.rule<Jobs>('jobs')!.start(courier.p, 'courier');
    expect(courier.sent.some((e) => e.k === 'job' && e.s?.kind === 'courier')).toBe(true);
    const taxi = riding('scooter', 9, 'offline');
    taxi.sim.rule<Jobs>('jobs')!.start(taxi.p, 'taxi');
    expect(taxi.sent.some((e) => e.k === 'job' && e.s?.kind === 'taxi')).toBe(false);
    expect(taxi.sent.some((e) => e.k === 'msg' && /potrebuješ auto/.test(e.text))).toBe(true);
  });

  it('never run anyone over: people are only barged aside', () => {
    const { sim, v } = riding('bike', 7);
    const civ = sim.addPed(new Ped('civ', v.x + 3, v.y, 1));
    v.vx = 8;
    for (let t = 0; t < 1; t += 1 / 60) {
      v.setControls(1, 0, false);
      sim.step(1 / 60);
    }
    expect(civ.dazed).toBe(false);
  });

  it('a car that hits someone else\'s scooter (online: kinematic, their client knocks them off) drives on', () => {
    const phys = new VehiclePhysics();
    const w = loadWorld();
    const run = (kind: VehicleKind) => {
      const other = new Vehicle(kind, 0, 0, 0, '#fff');
      other.kinematic = true;
      other.owner = 9;
      other.id = 1;
      const car = new Vehicle('sedan', -4, 0, 0, '#fff');
      car.id = 2;
      car.vx = 10;
      const x0 = car.x;
      for (let t = 0; t < 0.5; t += 1 / 60) phys.step(1 / 60, [other, car], [], w, {});
      return car.x - x0;
    };
    // (somewhere open: the origin's surroundings don't matter for a half-second roll)
    expect(run('scooter')).toBeGreaterThan(3.5);
    expect(run('sedan')).toBeLessThan(3);
  });
});

describe('the docks and stands', () => {
  it('a scooter waits at a bike-share dock and a bike at a stand near a player, out of sight, parked', () => {
    const w = loadWorld();
    const f = w.furniture;
    // a bike-share dock
    let dock = -1;
    for (let i = 0; i < f.length && dock < 0; i += 4) if (f[i + 3] === 13) dock = i;
    expect(dock).toBeGreaterThanOrEqual(0);
    const s = bikeSpot(f, dock)!;
    expect(s.kind).toBe('scooter');
    const sim = new Sim(w, { rng: new Rng(2), caps: EMPTY, rules: 'offline' });
    expect(sim.rule<Bikes>('bikes')).toBeTruthy();
    // a player 60 m off, looking the other way
    const p = sim.addPlayer({ nick: 'A', profile: profile(), kinematic: true, x: s.x + 60, y: s.y });
    Object.assign(p.observer, { fx: s.x + 60, fy: s.y, cx: s.x + 80, cy: s.y, hw: 20, hh: 12 });
    for (let t = 0; t < 2; t += 0.25) sim.step(0.25);
    const scooter = sim.vehicles.find((v) => v.kind === 'scooter' && dist(v.x, v.y, s.x, s.y) < 0.5);
    expect(scooter).toBeTruthy();
    expect(scooter!.parked).toBe(true);
    const near = sim.vehicles.filter((v) => v.spec.twoWheeler && dist(v.x, v.y, p.observer.fx, p.observer.fy) < 150);
    expect(near.length).toBeLessThanOrEqual(8);
    // and none in view
    for (const v of near) expect(Math.abs(v.x - p.observer.cx) < 20 && Math.abs(v.y - p.observer.cy) < 12).toBe(false);
  });

  it('a bike waits at every other bicycle stand', () => {
    const w = loadWorld();
    const f = w.furniture;
    let stands = 0, kept = 0, stand = -1;
    for (let i = 0; i < f.length; i += 4) {
      if (f[i + 3] !== 7) continue;
      stands++;
      const s = bikeSpot(f, i);
      if (!s) continue;
      kept++;
      expect(s.kind).toBe('bike');
      if (stand < 0) stand = i;
    }
    expect(kept / stands).toBeGreaterThan(0.35);
    expect(kept / stands).toBeLessThan(0.65);
    const s = bikeSpot(f, stand)!;
    const sim = new Sim(w, { rng: new Rng(2), caps: EMPTY, rules: 'offline' });
    const p = sim.addPlayer({ nick: 'A', profile: profile(), kinematic: true, x: s.x - 60, y: s.y });
    Object.assign(p.observer, { fx: s.x - 60, fy: s.y, cx: s.x - 80, cy: s.y, hw: 20, hh: 12 });
    for (let t = 0; t < 2; t += 0.25) sim.step(0.25);
    const bike = sim.vehicles.find((v) => v.kind === 'bike' && dist(v.x, v.y, s.x, s.y) < 0.5);
    expect(bike).toBeTruthy();
  });

  it('the traffic AI doesn\'t count them among its parked cars', () => {
    const w = loadWorld();
    const sim = new Sim(w, { rng: new Rng(3), rules: 'offline' });
    const p = sim.addPlayer({ nick: 'A', profile: profile(), kinematic: false });
    sim.prewarm(p);
    for (let t = 0; t < 6; t += 0.25) sim.step(0.25);
    const cars = sim.vehicles.filter((v) => v.parked && !v.spec.twoWheeler).length;
    const two = sim.vehicles.filter((v) => v.parked && v.spec.twoWheeler).length;
    expect(two).toBeGreaterThan(0);
    // as many parked cars as without them
    const bare = new Sim(w, { rng: new Rng(3), rules: 'offline' });
    bare.rules = bare.rules.filter((r) => r.id !== 'bikes');
    const q = bare.addPlayer({ nick: 'A', profile: profile(), kinematic: false });
    bare.prewarm(q);
    for (let t = 0; t < 6; t += 0.25) bare.step(0.25);
    expect(Math.abs(cars - bare.vehicles.filter((v) => v.parked).length)).toBeLessThanOrEqual(2);
  });

  it('what a fall costs', () => {
    expect(fallHurt(FALL_KNOCK + 0.1)).toBeGreaterThanOrEqual(5);
    expect(fallHurt(30)).toBe(30);
  });
});
