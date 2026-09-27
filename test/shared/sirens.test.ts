// Sirens and the ambulance (docs/plans/gameplay.md, Phase 3): traffic pulls over for a player's siren
// (nobody wanted), getting in switches a car's siren off, an ambulance heals its driver, and the
// hospitals keep an ambulance parked outside for players nearby.
import { describe, expect, it } from 'vitest';
import { Sim, AMBULANCE_HEAL } from '../../src/shared/sim/Sim';
import { Rng } from '../../src/shared/util/Rng';
import { SERVER_CAPS } from '../../src/shared/sim/density';
import { Vehicle } from '../../src/shared/entities/Vehicle';
import { linkPoints, type Link } from '../../src/shared/world/Graph';
import type { Ambulances } from '../../src/shared/sim/rules/Ambulances';
import { dist } from '../../src/shared/util/math';
import { loadWorld } from './helpers';

const EMPTY = { ...SERVER_CAPS, traffic: 0, parked: 0, peds: 0, trams: 0, police: 0 };
const profile = () => ({ money: 0, done: [], found: [...loadWorld().landmarks.keys()], cumils: [] });

/** a long, straight street without lights, for traffic to drive down */
function straightLink(): Link {
  const w = loadWorld();
  for (const e of w.car.edges) {
    if (e.cls > 4 || e.oneway === -1 || e.blockedF || e.len < 160) continue;
    const link: Link = { edge: e, fwd: true, to: e.b };
    if (w.lights.forLink(link).length || w.marks.forLink(link).length) continue;
    const p = linkPoints(link);
    if (Math.hypot(p[p.length - 2] - p[0], p[p.length - 1] - p[1]) > e.len * 0.98) return link;
  }
  throw new Error('no straight street');
}

describe('a player\'s siren', () => {
  it('traffic ahead slows and pulls over for it, with nobody wanted', () => {
    const link = straightLink();
    const speedWith = (siren: boolean) => {
      const sim = new Sim(loadWorld(), { rng: new Rng(4), caps: EMPTY });
      const p0 = linkPoints(link);
      const p = sim.addPlayer({ nick: 'A', profile: profile(), kinematic: true, x: p0[0] + 300, y: p0[1] + 300 });
      Object.assign(p.observer, { fx: p0[0], fy: p0[1], cx: p0[0], cy: p0[1], hw: 30, hh: 18 });
      const car = sim.ai.spawnOnLink('sedan', link, 'traffic')!;
      for (let t = 0; t < 4; t += 0.05) sim.step(0.05);
      // an ambulance the player drives (taking it is no crime), right behind it
      const cop = sim.addVehicle(new Vehicle('ambulance', car.x - Math.cos(car.angle) * 9, car.y - Math.sin(car.angle) * 9, car.angle, '#fafafa'));
      p.ped.x = cop.x;
      p.ped.y = cop.y;
      expect(sim.enterVehicle(p, cop, 5)).toBe(true);
      cop.siren = siren;
      for (let t = 0; t < 2.5; t += 0.05) {
        cop.x = car.x - Math.cos(car.angle) * 9;
        cop.y = car.y - Math.sin(car.angle) * 9;
        cop.vx = car.vx;
        cop.vy = car.vy;
        sim.step(0.05);
      }
      expect(sim.anyWanted).toBe(false);
      return car.speed;
    };
    const normal = speedWith(false), yielding = speedWith(true);
    expect(normal).toBeGreaterThan(5);
    expect(yielding).toBeLessThan(normal * 0.6);
  });

  it('getting in switches a car\'s siren off (the player switches it on)', () => {
    const sim = new Sim(loadWorld(), { rng: new Rng(1), caps: EMPTY });
    const p = sim.addPlayer({ nick: 'A', profile: profile(), kinematic: false, x: 0, y: 0 });
    const cop = sim.addVehicle(new Vehicle('police', p.ped.x + 2.5, p.ped.y, 0, '#f5f5f5'));
    cop.siren = true;
    expect(sim.enterVehicle(p, cop, 5)).toBe(true);
    expect(cop.siren).toBe(false);
    expect(cop.hasSiren && new Vehicle('ambulance', 0, 0, 0, '#fff').hasSiren && !new Vehicle('van', 0, 0, 0, '#fff').hasSiren).toBe(true);
  });
});

describe('the ambulance', () => {
  it('heals its driver 2 HP a second, up to full', () => {
    const sim = new Sim(loadWorld(), { rng: new Rng(1), caps: EMPTY });
    const p = sim.addPlayer({ nick: 'A', profile: profile(), kinematic: true, x: 0, y: 0 });
    const v = sim.addVehicle(new Vehicle('ambulance', p.ped.x + 2.5, p.ped.y, 0, '#fafafa'));
    expect(sim.enterVehicle(p, v, 5)).toBe(true);
    p.ped.health = 40;
    for (let t = 0; t < 5; t += 0.05) sim.step(0.05);
    expect(p.ped.health).toBeCloseTo(40 + 5 * AMBULANCE_HEAL, 0);
    for (let t = 0; t < 40; t += 0.25) sim.step(0.25);
    expect(p.ped.health).toBe(100);
  });

  it('waits outside each hospital for a player nearby, and is back after one is taken away', () => {
    const sim = new Sim(loadWorld(), { rng: new Rng(2), caps: EMPTY, rules: 'offline' });
    const rule = sim.rule<Ambulances>('ambulances')!;
    const spots = rule.places;
    expect(spots.length).toBe(loadWorld().pois('hospital').length);
    const s = spots[0];
    // a player 120 m off, looking the other way (the spot is off their screen)
    const p = sim.addPlayer({ nick: 'A', profile: profile(), kinematic: true, x: s.x + 120, y: s.y });
    Object.assign(p.observer, { fx: s.x + 120, fy: s.y, cx: s.x + 140, cy: s.y, hw: 20, hh: 12 });
    for (let t = 0; t < 2.5; t += 0.25) sim.step(0.25);
    const amb = sim.vehicles.find((v) => v.kind === 'ambulance' && dist(v.x, v.y, s.x, s.y) < 5);
    expect(amb).toBeTruthy();
    expect(amb!.parked).toBe(true);
    // someone drives it off (far away): another is put down
    amb!.x += 500;
    for (let t = 0; t < 2.5; t += 0.25) sim.step(0.25);
    expect(sim.vehicles.filter((v) => v.kind === 'ambulance' && dist(v.x, v.y, s.x, s.y) < 5)).toHaveLength(1);
  });
});
