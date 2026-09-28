// The market stalls (src/shared/world/Stalls.ts; docs/plans/non-violent.md: MOJE LOKŠE!): on the
// pavement by a street, a car can get to them; a player's car ploughing through one pays the combo once
// and knocks it over until it's rebuilt; anyone else's knocks it over for nothing.
import { beforeEach, describe, expect, it } from 'vitest';
import { Sim } from '../../src/shared/sim/Sim';
import { Rng } from '../../src/shared/util/Rng';
import { Vehicle } from '../../src/shared/entities/Vehicle';
import { nullEvents, type PrivateEvent } from '../../src/shared/sim/events';
import type { Caps } from '../../src/shared/sim/density';
import { STYLE } from '../../src/shared/sim/rules/Style';
import { STALL_REBUILD } from '../../src/shared/world/Stalls';
import { loadWorld } from './helpers';

const NO_NPCS: Caps = { traffic: 0, parked: 0, peds: 0, trams: 0, police: 0, helis: 0, roadblocks: 0 };
const w = loadWorld();
const stalls = w.stalls;

function setup(at: { x: number; y: number }) {
  const priv: PrivateEvent[] = [];
  const sim = new Sim(w, { rng: new Rng(9), caps: NO_NPCS, driveClock: false, rules: 'offline', events: { ...nullEvents, toPlayer: (_pid, e) => priv.push(e) } });
  sim.clock.setTime(12);
  const p = sim.addPlayer({ nick: 'A', profile: { money: 0, done: [], found: [...w.landmarks.keys()], cumils: [] }, kinematic: true, x: at.x, y: at.y });
  const labels = () => priv.filter((e): e is Extract<PrivateEvent, { k: 'style' }> => e.k === 'style' && e.mult !== undefined).map((e) => e.label);
  return { sim, p, labels };
}

/** a car `back` metres from stall i, heading straight at it (from the street side), going `speed` */
function carAt(sim: Sim, i: number, back: number, speed: number) {
  const a = stalls.a[i] + Math.PI; // (a stall faces the street: come at it from there)
  const v = sim.addVehicle(new Vehicle('sedan', stalls.x[i] - Math.cos(a) * back, stalls.y[i] - Math.sin(a) * back, a, '#1565c0'));
  v.vx = Math.cos(a) * speed;
  v.vy = Math.sin(a) * speed;
  v.kinematic = true;
  return v;
}

function run(sim: Sim, seconds: number, dt = 0.05) {
  for (let t = 0; t < seconds - 1e-9; t += dt) {
    for (const v of sim.vehicles) if (v.kinematic) (v.x += v.vx * dt), (v.y += v.vy * dt);
    for (const pl of sim.players.values()) if (pl.ped.vehicle) (pl.ped.x = pl.ped.vehicle.x), (pl.ped.y = pl.ped.vehicle.y);
    sim.step(dt);
  }
}

beforeEach(() => stalls.broken.fill(0));

describe('the market stalls', () => {
  it('a handful, on the pavement beside a street a car can reach, apart', () => {
    expect(stalls.n).toBeGreaterThanOrEqual(4);
    for (let i = 0; i < stalls.n; i++) {
      const x = stalls.x[i], y = stalls.y[i];
      expect(w.insideBuilding(x, y) || w.inWater(x, y, 0) || w.onBridge(x, y)).toBe(false);
      expect(w.collideCircle(x, y, 1.4, 0)).toBeNull();
      // the street it faces, a few metres off
      const n = w.car.nearest(x, y, 60);
      expect(n).toBeGreaterThanOrEqual(0);
      for (let j = 0; j < i; j++) expect(Math.hypot(stalls.x[j] - x, stalls.y[j] - y)).toBeGreaterThan(25);
    }
  });

  it("a player's car through one: MOJE LOKŠE! once, and it's down until it's rebuilt", () => {
    const i = 0;
    const { sim, p, labels } = setup({ x: stalls.x[i], y: stalls.y[i] });
    const v = carAt(sim, i, 8, 10);
    p.ped.x = v.x;
    p.ped.y = v.y;
    expect(sim.enterVehicle(p, v, 5)).toBe(true);
    v.vx = Math.cos(v.angle) * 10;
    v.vy = Math.sin(v.angle) * 10;
    run(sim, 1.5);
    expect(stalls.broken[i]).toBeGreaterThan(0);
    expect(labels()).toContain(STYLE.stall.label);
    // back through it straight away: it's still down, nothing more
    v.vx = -v.vx;
    v.vy = -v.vy;
    run(sim, 1.5);
    expect(labels().filter((l) => l === STYLE.stall.label)).toHaveLength(1);
    run(sim, STALL_REBUILD);
    expect(stalls.broken[i]).toBe(0);
  });

  it("anyone else's car knocks it over for nothing; a slow one doesn't", () => {
    const i = 1;
    const { sim, labels } = setup({ x: stalls.x[i], y: stalls.y[i] });
    carAt(sim, i, 8, 2);
    run(sim, 1);
    expect(stalls.broken[i]).toBe(0);
    carAt(sim, i, 8, 10);
    run(sim, 1.5);
    expect(stalls.broken[i]).toBeGreaterThan(0);
    expect(labels()).toHaveLength(0);
  });
});
