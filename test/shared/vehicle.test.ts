// Vehicle handling measured on an open asphalt test track: top speeds match the specs, brakes and
// tyres are in a real car's range, and ordinary cars don't spin under a driver's usual inputs.
import { describe, expect, it } from 'vitest';
import { World } from '../../src/shared/world/World';
import { Vehicle, SPECS, type VehicleKind } from '../../src/shared/entities/Vehicle';
import type { MapJSON } from '../../src/shared/types';

const track = (() => {
  const w = new World({
    bounds: [-5000, -5000, 5000, 5000], origin: [0, 0], names: [], roads: [], trams: [], buildings: [],
    areas: { water: [], green: [], wood: [], plaza: [], parking: [], pitch: [], sand: [], rail: [] },
    rivers: [], pois: [], landmarks: [], graph: { car: { nodes: [], edges: [] }, ped: { nodes: [], edges: [] }, tram: { nodes: [], edges: [] } },
  } as MapJSON);
  w.surfaceAt = () => 'asphalt';
  return w;
})();
const dt = 1 / 120;
const kinds = Object.keys(SPECS) as VehicleKind[];

/** run `script` (throttle, steer, handbrake by time) from `kmh`; the car and its largest body slip (deg, while going forwards) */
function run(kind: VehicleKind, kmh: number, seconds: number, script: (t: number, v: Vehicle) => [number, number, boolean?]) {
  // from the west end of the 10 km track: even the Porše at full speed stays on it
  const v = new Vehicle(kind, -4900, 0, 0, '#fff');
  v.vx = kmh / 3.6;
  let slip = 0;
  for (let t = 0; t < seconds; t += dt) {
    const [thr, st, hb] = script(t, v);
    v.setControls(thr, st, !!hb);
    v.update(dt, track);
    if (v.speed > 5 && v.fwdSpeed > 0) {
      const d = Math.atan2(-v.vx * Math.sin(v.angle) + v.vy * Math.cos(v.angle), v.fwdSpeed);
      slip = Math.max(slip, (Math.abs(d) * 180) / Math.PI);
    }
  }
  return { v, slip };
}

describe('Vehicle', () => {
  it('reaches its top speed, and no more', () => {
    for (const k of kinds) {
      const { v } = run(k, 0, 70, () => [1, 0]);
      expect(v.speed).toBeGreaterThan(SPECS[k].maxSpeed * 0.97);
      expect(v.speed).toBeLessThan(SPECS[k].maxSpeed * 1.01);
    }
  });

  it('brakes like a car: 100 to 0 km/h in 30-45 m (a bus in under 60)', () => {
    for (const k of kinds) {
      const { v } = run(k, 100, 8, (_t, c) => [c.fwdSpeed > 0.3 ? -1 : 0, 0]);
      expect(v.x + 4900).toBeGreaterThan(30);
      expect(v.x + 4900).toBeLessThan(k === 'bus' ? 60 : 45);
    }
  });

  it('corners on its tyres: about 1 g at the limit, not the 3-6 g of a velocity that turned with the body', () => {
    for (const k of kinds) {
      const { v } = run(k, 60, 6, (_t, c) => [Math.max(0, Math.min(1, (60 / 3.6 - c.fwdSpeed) * 0.4)), 1]);
      const g = (v.speed * Math.abs(v.av)) / 9.81;
      expect(g).toBeGreaterThan(k === 'bus' ? 0.4 : 0.6);
      expect(g).toBeLessThan(1.35);
    }
  });

  it('reverses at walking-to-jogging car speeds, not 78 km/h', () => {
    for (const k of kinds) expect(-run(k, 0, 20, () => [-1, 0]).v.fwdSpeed * 3.6).toBeLessThan(32);
  });

  it('stays stable: lane changes, lifting off and braking in a bend don’t spin an ordinary car', () => {
    for (const k of kinds) {
      if (k === 'sport') continue; // a lively rear-engined car, on purpose
      expect(run(k, 100, 3, (t) => [0.3, t < 0.3 ? 1 : t < 0.6 ? -1 : 0]).slip).toBeLessThan(10);
      expect(run(k, 100, 3, (t) => [t < 0.2 ? 1 : 0, t > 0.2 && t < 1.2 ? 1 : 0]).slip).toBeLessThan(20);
      expect(run(k, 80, 3, (t) => [-1, t < 1.5 ? 1 : 0]).slip).toBeLessThan(45);
    }
  });

  it('still swings round on the handbrake', () => {
    for (const k of ['hatch', 'sedan', 'police', 'sport'] as VehicleKind[]) {
      const { v } = run(k, 60, 1.5, (t) => [0, t < 0.8 ? 1 : 0, t < 0.8]);
      expect((Math.abs(v.angle) * 180) / Math.PI).toBeGreaterThan(90);
    }
  });
});
