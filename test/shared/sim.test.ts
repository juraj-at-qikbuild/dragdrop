import { describe, expect, it } from 'vitest';
import { Sim } from '../../src/shared/sim/Sim';
import { Rng } from '../../src/shared/util/Rng';
import { SERVER_CAPS, playerScale } from '../../src/shared/sim/density';
import { Vehicle } from '../../src/shared/entities/Vehicle';
import { Ped } from '../../src/shared/entities/Ped';
import { VehiclePhysics } from '../../src/shared/sim/Physics';
import type { SimPlayer } from '../../src/shared/sim/SimPlayer';
import { loadWorld } from './helpers';

const profile = () => ({ money: 0, done: [], found: [], cumils: [] });

function run(sim: Sim, seconds: number, dt = 0.05) {
  for (let t = 0; t < seconds; t += dt) sim.step(dt);
}

/** point the player's camera at their figure, like a client would */
function look(p: SimPlayer) {
  const f = p.focus();
  Object.assign(p.observer, { fx: f.x, fy: f.y, cx: f.x, cy: f.y, hw: 30, hh: 18 });
}

describe('Sim', () => {
  it('fills the streets around a single player like the original game', () => {
    const sim = new Sim(loadWorld(), { rng: new Rng(1) });
    const p = sim.addPlayer({ nick: 'A', profile: profile(), kinematic: false });
    look(p);
    sim.prewarm(p);
    run(sim, 20);
    const t = sim.ai.lastTargets;
    const peds = sim.peds.filter((q) => q.kind === 'civ' && !q.vehicle && !q.dead).length;
    expect(peds).toBeGreaterThan(t.peds * 0.8);
    expect(sim.vehicles.filter((v) => v.parked).length).toBeGreaterThan(t.parked * 0.6);
  });

  it('prewarm never spawns cars on top of each other', () => {
    const sim = new Sim(loadWorld(), { rng: new Rng(7) });
    const p = sim.addPlayer({ nick: 'A', profile: profile(), kinematic: false });
    look(p);
    sim.prewarm(p);
    const cars = sim.vehicles.filter((v) => !v.isPlayer);
    expect(cars.length).toBeGreaterThan(10);
    let overlaps = 0;
    for (let i = 0; i < cars.length; i++)
      for (let j = i + 1; j < cars.length; j++) if (Math.hypot(cars[i].x - cars[j].x, cars[i].y - cars[j].y) < 3) overlaps++;
    expect(overlaps).toBe(0);
  });

  it('never exceeds the global caps, however many players there are', () => {
    const caps = { ...SERVER_CAPS, traffic: 60, parked: 80, peds: 150, trams: 6 };
    const sim = new Sim(loadWorld(), { rng: new Rng(2), caps });
    const w = sim.world;
    for (let i = 0; i < 20; i++) {
      const x = w.bounds.x0 + 200 + ((i * 397) % (w.bounds.x1 - w.bounds.x0 - 400));
      const y = w.bounds.y0 + 200 + ((i * 211) % (w.bounds.y1 - w.bounds.y0 - 400));
      const s = w.walkableNear(x, y);
      const p = sim.addPlayer({ nick: 'P' + i, profile: profile(), kinematic: true, x: s.x, y: s.y });
      look(p);
    }
    run(sim, 20);
    const traffic = sim.vehicles.filter((v) => sim.ai.drivers.get(v)?.mode === 'traffic').length;
    expect(traffic).toBeLessThanOrEqual(caps.traffic);
    expect(sim.vehicles.filter((v) => v.parked).length).toBeLessThanOrEqual(caps.parked);
    expect(sim.peds.filter((q) => q.kind === 'civ' && !q.vehicle && !q.dead).length).toBeLessThanOrEqual(caps.peds + 5);
    expect(sim.trams.length).toBeLessThanOrEqual(caps.trams);
    expect(playerScale(20)).toBeLessThan(1);
  });

  it('players standing together share their NPCs instead of doubling them', () => {
    const sim = new Sim(loadWorld(), { rng: new Rng(3) });
    const ps = [];
    for (let i = 0; i < 4; i++) {
      const p = sim.addPlayer({ nick: 'P' + i, profile: profile(), kinematic: true });
      look(p);
      ps.push(p);
    }
    run(sim, 20);
    const peds = sim.peds.filter((q) => q.kind === 'civ' && !q.vehicle && !q.dead).length;
    expect(peds).toBeLessThan(sim.ai.lastTargets.peds * 2);
  });

  it('sends the police after the player who committed the crime, not the one next to them', () => {
    const sim = new Sim(loadWorld(), { rng: new Rng(4) });
    // by the Eurovea riverside roads (the Old Town square has no streets for police cars nearby)
    const l = sim.world.landmark('eurovea');
    const s = sim.world.walkableNear(l.x, l.y - 40);
    const a = sim.addPlayer({ nick: 'A', profile: profile(), kinematic: false, x: s.x, y: s.y });
    const b = sim.addPlayer({ nick: 'B', profile: profile(), kinematic: false, x: s.x + 3, y: s.y });
    look(a);
    look(b);
    sim.prewarm(a);
    sim.setWanted(a, 3);
    run(sim, 15);
    const chasing = [...sim.ai.drivers.values()].filter((d) => d.mode === 'police' && d.target);
    expect(chasing.length).toBeGreaterThan(0);
    expect(chasing.every((d) => d.target === a.id)).toBe(true);
    expect(b.wanted).toBe(0);
  });

  it('PvP is a crime: hurting and killing another player raises the attacker wanted level', () => {
    const sim = new Sim(loadWorld(), { rng: new Rng(5) });
    const a = sim.addPlayer({ nick: 'A', profile: profile(), kinematic: true });
    const b = sim.addPlayer({ nick: 'B', profile: profile(), kinematic: true });
    sim.hurtPlayer(b, 30, a.ped.x, a.ped.y, a.id);
    expect(a.wanted).toBeGreaterThanOrEqual(1);
    sim.hurtPlayer(b, 500, a.ped.x, a.ped.y, a.id);
    expect(b.state).toBe('wasted');
    expect(a.wanted).toBeGreaterThanOrEqual(2);
  });

  it('respawns a wasted player at a hospital for a 10% fee and calls off their police', () => {
    const sim = new Sim(loadWorld(), { rng: new Rng(6) });
    const p = sim.addPlayer({ nick: 'A', profile: { ...profile(), money: 1000 }, kinematic: false });
    look(p);
    sim.setWanted(p, 3);
    run(sim, 8);
    const before = p.profile.money;
    sim.hurtPlayer(p, 1000, p.ped.x, p.ped.y);
    expect(p.state).toBe('wasted');
    run(sim, 4.5);
    expect(p.state).toBe('play');
    expect(p.profile.money).toBe(before - Math.round(before * 0.1));
    expect(p.wanted).toBe(0);
    expect([...sim.ai.drivers.values()].some((d) => d.mode === 'police' && d.target === p.id)).toBe(false);
  });

  it('runs two players for two minutes without errors', () => {
    const sim = new Sim(loadWorld(), { rng: new Rng(7) });
    const a = sim.addPlayer({ nick: 'A', profile: profile(), kinematic: false });
    const b = sim.addPlayer({ nick: 'B', profile: profile(), kinematic: false });
    sim.setWanted(a, 5);
    for (let t = 0; t < 120; t += 0.05) {
      a.ped.x += 0.1;
      look(a);
      look(b);
      sim.step(0.05);
    }
    expect(sim.peds.length).toBeGreaterThan(50);
  });

  it('people jump out of the way of a car bearing down on them', () => {
    const sim = new Sim(loadWorld(), { rng: new Rng(5) });
    // Most SNP's northbound carriageway: a player's car at 50 km/h, someone standing in its path
    const p = sim.addPlayer({ nick: 'A', profile: profile(), kinematic: false, x: -578.7, y: 560 });
    const car = sim.addVehicle(new Vehicle('sedan', -578.7, 560, -Math.PI / 2 - 0.035, '#fff'));
    expect(sim.enterVehicle(p, car)).toBe(true);
    car.vy = -14;
    const walker = sim.addPed(new Ped('civ', -580.3, 505, 3));
    for (const e of [car, walker, p.ped]) (e.level = 2), (e.levelInit = true);
    let dodged = false;
    for (let t = 0; t < 5; t += 1 / 30) {
      car.setControls(0.6, 0);
      look(p);
      sim.step(1 / 30);
      if (walker.state === 'flee') dodged = true;
    }
    expect(car.y).toBeLessThan(470); // the car went past them
    expect(dodged).toBe(true);
    expect(walker.dead).toBe(false);
  });
});

describe('VehiclePhysics', () => {
  it('a dynamic car bounces off a kinematic one, which does not move', () => {
    const world = loadWorld();
    const s = world.walkableNear(0, 0);
    const a = new Vehicle('sedan', s.x, s.y, 0, '#ffffff');
    const b = new Vehicle('sedan', s.x + 4.2, s.y, 0, '#000000');
    a.id = 1;
    b.id = 2;
    a.vx = 10;
    b.kinematic = true;
    const phys = new VehiclePhysics();
    const bx = b.x, by = b.y;
    let contact = 0;
    for (let i = 0; i < 30; i++) phys.step(1 / 60, [a, b], [], world, { carContact: () => contact++ });
    expect(contact).toBeGreaterThan(0);
    expect(b.x).toBe(bx);
    expect(b.y).toBe(by);
    expect(a.vx).toBeLessThan(10);
  });
});
