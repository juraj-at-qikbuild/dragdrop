// Touch driving (src/game/touchDrive.ts) against the real car physics on an open test track: the
// 'direction' stick turns every car toward where it points, turns around with a short K-turn instead
// of locking into an endless reverse, backs out of a dead end, and BRAKE stops the car.
import { describe, expect, it } from 'vitest';
import { World } from '../../src/shared/world/World';
import { Vehicle, SPECS, type VehicleKind } from '../../src/shared/entities/Vehicle';
import type { MapJSON } from '../../src/shared/types';
import { newDriveState, touchDrive, type DriveScheme } from '../../src/game/touchDrive';

function track() {
  const w = new World({
    bounds: [-5000, -5000, 5000, 5000], origin: [0, 0], names: [], roads: [], trams: [], buildings: [],
    areas: { water: [], green: [], wood: [], plaza: [], parking: [], pitch: [], sand: [], rail: [] },
    rivers: [], pois: [], landmarks: [], graph: { car: { nodes: [], edges: [] }, ped: { nodes: [], edges: [] }, tram: { nodes: [], edges: [] } },
  } as MapJSON);
  w.surfaceAt = () => 'asphalt';
  return w;
}
const dt = 1 / 120;
const kinds = Object.keys(SPECS) as VehicleKind[];
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
const deg = (a: number) => (Math.abs(a) * 180) / Math.PI;

interface Opts {
  scheme?: DriveScheme;
  /** the stick's direction (rad), or null for no stick */
  stick: number | null;
  jitter?: number;
  gas?: boolean;
  brake?: boolean;
  speed?: number;
  seconds: number;
  world?: World;
}

/** drive a car (heading east from the origin) with the touch controls; what happened on the way */
function drive(kind: VehicleKind, o: Opts) {
  const w = o.world ?? track();
  const car = new Vehicle(kind, 0, 0, 0, '#fff');
  car.id = 7;
  car.vx = o.speed ?? 0;
  const st = newDriveState();
  let settled = -1, revSpeed = 0, revDist = 0, stoppedAt = -1, firstReverse = -1;
  for (let t = 0; t < o.seconds; t += dt) {
    const a = o.stick === null ? 0 : o.stick + (o.jitter ? (Math.random() * 2 - 1) * o.jitter : 0);
    const c = touchDrive(o.scheme ?? 'direction', { x: Math.cos(a), y: Math.sin(a), on: o.stick !== null }, { gas: !!o.gas, brake: !!o.brake }, { id: car.id, angle: car.angle, fwdSpeed: car.fwdSpeed }, st, dt);
    car.setControls(c.throttle, c.steer);
    car.update(dt, w);
    if (car.fwdSpeed < -0.05) {
      revSpeed = Math.max(revSpeed, -car.fwdSpeed);
      revDist += -car.fwdSpeed * dt;
      if (firstReverse < 0) firstReverse = t;
    }
    if (stoppedAt < 0 && car.speed < 0.3) stoppedAt = t;
    if (o.stick !== null) {
      const err = deg(wrap(car.angle - o.stick));
      if (err < 25 && car.fwdSpeed > 1) {
        if (settled < 0) settled = t;
      } else if (err > 40) settled = -1;
    }
  }
  return { car, settled, revSpeed, revDist, stoppedAt, firstReverse };
}

describe('touch driving: direction', () => {
  it('turns every car toward the stick, turning around with a short, slow K-turn', () => {
    for (const k of kinds) {
      const limit = k === 'bus' ? 14 : 7;
      for (const [a, jitter] of [[Math.PI / 2, 0], [(3 * Math.PI) / 4, 0], [Math.PI, 0], [Math.PI, 0.08], [-2.97, 0]]) {
        const r = drive(k, { stick: a, jitter, seconds: limit + 2 });
        expect(r.settled, `${k} to ${deg(a).toFixed(0)}°`).toBeGreaterThanOrEqual(0);
        expect(r.settled, `${k} to ${deg(a).toFixed(0)}°`).toBeLessThanOrEqual(limit);
        // backing up slowly and not far (a 12 m bus needs more room)
        expect(r.revSpeed).toBeLessThanOrEqual(3);
        expect(r.revDist).toBeLessThanOrEqual(k === 'bus' ? 22 : 12);
        // ...and then driving off, not reversing on and on
        expect(r.car.fwdSpeed).toBeGreaterThan(5);
      }
    }
  });

  it('never reverses on its own with the stick ahead or to the side', () => {
    for (const k of kinds)
      for (const a of [0, 0.6, -1.2, Math.PI / 2, -Math.PI / 2 - 0.3]) {
        const r = drive(k, { stick: a, seconds: 6 });
        expect(r.firstReverse, `${k} to ${deg(a).toFixed(0)}°`).toBe(-1);
      }
  });

  it('turns around from speed without jerking between throttle and brake', () => {
    for (const k of kinds) {
      const r = drive(k, { stick: Math.PI, speed: 25, seconds: 12 });
      expect(r.settled, k).toBeGreaterThanOrEqual(0);
      expect(r.car.fwdSpeed, k).toBeGreaterThan(5);
    }
  });

  it('backs out of a dead end: nose 0.7 m from a wall, the stick to the side', () => {
    for (const k of kinds) {
      const w = track();
      const wx = SPECS[k].length / 2 + 0.7;
      w.collideCircle = (x: number, _y: number, r: number) => (x + r > wx ? { nx: -1, ny: 0, depth: x + r - wx } : null);
      const r = drive(k, { stick: Math.PI / 2, seconds: k === 'bus' ? 14 : 8, world: w });
      expect(r.settled, k).toBeGreaterThanOrEqual(0);
    }
  });

  it('coasts when the stick is let go', () => {
    const r = drive('sedan', { stick: null, speed: 10, seconds: 1 });
    expect(r.car.fwdSpeed).toBeGreaterThan(8);
    expect(r.firstReverse).toBe(-1);
  });
});

describe('touch driving: BRAKE', () => {
  it('stops from 15 m/s in about 20 m, then holds still before reversing', () => {
    for (const k of kinds) {
      if (k === 'bus') continue;
      const r = drive(k, { stick: null, brake: true, speed: 15, seconds: 4 });
      expect(r.stoppedAt, k).toBeGreaterThan(0);
      expect(r.car.x, k).toBeLessThan(20);
    }
    // standing still, it waits a moment before backing up
    const r = drive('hatch', { stick: null, brake: true, seconds: 1 });
    expect(r.firstReverse).toBeGreaterThanOrEqual(0.3);
    expect(r.car.fwdSpeed).toBeLessThan(0);
  });

  it('reverses toward the stick: the tail swings the way it points', () => {
    const r = drive('hatch', { stick: Math.PI - 0.6, brake: true, seconds: 4 });
    expect(r.car.fwdSpeed).toBeLessThan(0);
    // backing up heading west-south-west: the tail went south, the nose turned north (counter-clockwise)
    expect(r.car.y).toBeGreaterThan(0.3);
    expect(r.car.angle).toBeLessThan(0);
  });
});

describe('touch driving: classic', () => {
  it('steers with the stick x, drives on GAS and brakes on BRAKE', () => {
    const st = newDriveState();
    const car = { id: 1, angle: 0, fwdSpeed: 10 };
    const c = touchDrive('classic', { x: 0.5, y: -0.8, on: true }, { gas: true, brake: false }, car, st, dt);
    expect(c.throttle).toBe(1);
    expect(c.steer).toBeCloseTo(0.5 ** 1.4, 5);
    expect(touchDrive('classic', { x: -1, y: 0, on: true }, { gas: true, brake: true }, car, st, dt)).toEqual({ throttle: -1, steer: -1 });
    expect(touchDrive('classic', { x: 0, y: 0, on: false }, { gas: false, brake: false }, car, st, dt)).toEqual({ throttle: 0, steer: 0 });
  });

  it('drives off on GAS', () => {
    const r = drive('sedan', { scheme: 'classic', stick: null, gas: true, seconds: 3 });
    expect(r.car.fwdSpeed).toBeGreaterThan(10);
  });
});
