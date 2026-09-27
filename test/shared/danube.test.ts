// The Danube (docs/plans/gameplay.md, Phase 3): swimming (20 s, and cops on foot stop at the bank), a
// car in the river letting its driver out to swim, boats kept to the water and moored along the piers,
// and the police boat that comes for a player on the water at 4★.
import { describe, expect, it } from 'vitest';
import { Sim, SWIM_S } from '../../src/shared/sim/Sim';
import { Rng } from '../../src/shared/util/Rng';
import { SERVER_CAPS } from '../../src/shared/sim/density';
import { Vehicle, SPECS } from '../../src/shared/entities/Vehicle';
import { Ped } from '../../src/shared/entities/Ped';
import { POLICE_BOAT_STARS, type Boats } from '../../src/shared/sim/rules/Boats';
import type { SimPlayer } from '../../src/shared/sim/SimPlayer';
import { dist } from '../../src/shared/util/math';
import { loadWorld } from './helpers';

const EMPTY = { ...SERVER_CAPS, traffic: 0, parked: 0, peds: 0, trams: 0, police: 0 };
const profile = () => ({ money: 0, done: [], found: [...loadWorld().landmarks.keys()], cumils: [] });

function city(seed = 1, rules?: 'offline') {
  const sim = new Sim(loadWorld(), { rng: new Rng(seed), caps: EMPTY, rules });
  const p = sim.addPlayer({ nick: 'A', profile: profile(), kinematic: false });
  return { sim, p, w: sim.world };
}

/** the moorings along the piers (boats lie there, on open water) */
const moorings = () => loadWorld().moorings(SPECS.boat.length, SPECS.boat.width);

/** a spot out on the river with open water all round (m across), near mooring 0 */
function midRiver(across = 14): { x: number; y: number } {
  const w = loadWorld(), m = moorings();
  for (let r = 20; r < 300; r += 10)
    for (let k = 0; k < 16; k++) {
      const a = (k / 16) * Math.PI * 2, x = m[0] + Math.cos(a) * r, y = m[1] + Math.sin(a) * r;
      if (w.afloat(x, y, 0, across, across)) return { x, y };
    }
  throw new Error('no open water');
}

/** the camera on (x, y) */
function look(p: SimPlayer, x: number, y: number) {
  Object.assign(p.observer, { fx: x, fy: y, cx: x, cy: y, hw: 30, hh: 18 });
}

describe('swimming', () => {
  it(`lasts ${SWIM_S} s, then the player drowns`, () => {
    const { sim, p } = city(1);
    const m = moorings();
    p.ped.x = m[0];
    p.ped.y = m[1];
    p.ped.level = 0;
    p.ped.levelInit = true;
    expect(sim.world.inWater(p.ped.x, p.ped.y, 0)).toBe(true);
    for (let t = 0; t < SWIM_S - 2; t += 0.1) sim.step(0.1);
    expect(p.state).toBe('play');
    for (let t = 0; t < 3; t += 0.1) sim.step(0.1);
    expect(p.state).toBe('wasted');
  });

  it('a cop on foot chasing a swimmer stops at the bank', () => {
    const { sim, p, w } = city(2);
    const m = moorings();
    // a swimmer a few metres out, and a cop on the bank nearest them
    const bank = w.walkableNear(m[0], m[1]);
    expect(w.inWater(bank.x, bank.y, 0)).toBe(false);
    Object.assign(p.ped, { x: m[0], y: m[1], level: 0, levelInit: true });
    look(p, m[0], m[1]);
    sim.setWanted(p, 1);
    const cop = sim.addPed(new Ped('cop', bank.x, bank.y, 3));
    cop.state = 'chase';
    cop.targetPid = p.id;
    for (let t = 0; t < 8; t += 0.1) {
      sim.step(0.1);
      expect(w.inWater(cop.x, cop.y, 0), `the cop at ${cop.x.toFixed(1)},${cop.y.toFixed(1)}`).toBe(false);
    }
  });

  it('a car driven into the river lets its driver out to swim for it', () => {
    const { sim, p } = city(3);
    // (out in the river: by a pier they'd step out onto it)
    const at = midRiver();
    const car = sim.addVehicle(new Vehicle('sedan', at.x, at.y, 0, '#fff'));
    Object.assign(p.ped, { x: car.x, y: car.y });
    expect(sim.enterVehicle(p, car, 10)).toBe(true);
    look(p, car.x, car.y);
    for (let t = 0; t < 2; t += 0.05) sim.step(0.05);
    expect(car.sinking).toBeGreaterThan(0);
    expect(p.ped.vehicle).toBeNull();
    expect(p.state).toBe('play');
    expect(sim.world.inWater(p.ped.x, p.ped.y, 0)).toBe(true);
  });
});

describe('boats', () => {
  it('lie along the piers on open water', () => {
    const m = moorings(), w = loadWorld();
    expect(m.length / 3).toBeGreaterThan(8);
    for (let i = 0; i < m.length; i += 3) expect(w.afloat(m[i], m[i + 1], m[i + 2], SPECS.boat.length, SPECS.boat.width)).toBe(true);
  });

  it('are kept to the water: full throttle at the bank, it stops there, afloat, and never sinks', () => {
    const w = loadWorld(), m = moorings();
    let aground = 0;
    for (let i = 0; i < Math.min(m.length, 30); i += 3) {
      const v = new Vehicle('boat', m[i], m[i + 1], m[i + 2], '#fff');
      v.owner = 1;
      let impact = 0;
      // out along the pier, then hard round towards the bank
      for (let t = 0; t < 12; t += 1 / 60) {
        v.setControls(1, t > 3 ? 1 : 0, false);
        impact = Math.max(impact, v.update(1 / 60, w));
        for (let c = 0; c < v.circles.length; c++) expect(w.inWater(v.circleX(c), v.circleY(c), 0)).toBe(true);
      }
      expect(v.sinking).toBe(0);
      if (impact > 0) aground++;
    }
    expect(aground).toBeGreaterThan(0);
  });

  it('are fast and loose on the water', () => {
    const w = loadWorld(), m = moorings();
    // the longest run of open water ahead of one of them
    let best = 0;
    for (let i = 0; i < m.length; i += 3) {
      const v = new Vehicle('boat', m[i], m[i + 1], m[i + 2], '#fff');
      v.owner = 1;
      for (let t = 0; t < 6; t += 1 / 60) {
        v.setControls(1, 0, false);
        v.update(1 / 60, w);
      }
      best = Math.max(best, v.speed);
    }
    expect(best).toBeGreaterThan(12);
  });

  it('wait moored at the piers near a player, and a player gets off one mid-river into the water', () => {
    const { sim, p } = city(4, 'offline');
    const rule = sim.rule<Boats>('boats')!;
    const m = rule.moorings;
    // a player 100 m from the first mooring, looking the other way
    const x = m[0] + 100, y = m[1];
    Object.assign(p.ped, { x, y });
    Object.assign(p.observer, { fx: x, fy: y, cx: x + 20, cy: y, hw: 20, hh: 12 });
    for (let t = 0; t < 2.5; t += 0.25) sim.step(0.25);
    const boat = sim.vehicles.find((v) => v.kind === 'boat' && dist(v.x, v.y, m[0], m[1]) < 1);
    expect(boat).toBeTruthy();
    expect(boat!.parked).toBe(true);
    // in, out onto the river, and off
    Object.assign(p.ped, { x: boat!.x, y: boat!.y });
    expect(sim.enterVehicle(p, boat!, 10)).toBe(true);
    expect(p.wanted).toBe(0);
    // out on the river
    const mid = midRiver();
    boat!.x = mid.x;
    boat!.y = mid.y;
    sim.exitVehicle(p);
    expect(p.ped.vehicle).toBeNull();
    expect(sim.world.inWater(p.ped.x, p.ped.y, 0)).toBe(true);
    expect(dist(p.ped.x, p.ped.y, boat!.x, boat!.y)).toBeGreaterThan(1);
  });
});

describe('the police boat', () => {
  it(`comes for a player on the water at ${POLICE_BOAT_STARS}★, and closes in`, () => {
    const { sim, p } = city(5, 'offline');
    const rule = sim.rule<Boats>('boats')!;
    const m = rule.moorings;
    const boat = sim.addVehicle(new Vehicle('boat', m[0], m[1], m[2], '#fff'));
    Object.assign(p.ped, { x: boat.x, y: boat.y });
    expect(sim.enterVehicle(p, boat, 10)).toBe(true);
    look(p, boat.x, boat.y);
    // at 3★, none
    sim.setWanted(p, 3);
    for (let t = 0; t < 4; t += 0.25) {
      look(p, boat.x, boat.y);
      sim.step(0.25);
    }
    expect(rule.policeBoat(p)).toBeNull();
    sim.setWanted(p, POLICE_BOAT_STARS);
    for (let t = 0; t < 6 && !rule.policeBoat(p); t += 0.25) {
      look(p, boat.x, boat.y);
      sim.step(0.25);
    }
    const police = rule.policeBoat(p)!;
    expect(police).toBeTruthy();
    expect(police.kind).toBe('policeboat');
    expect(police.siren).toBe(true);
    expect(sim.world.inWater(police.x, police.y, 0)).toBe(true);
    const d0 = dist(police.x, police.y, boat.x, boat.y);
    for (let t = 0; t < 20; t += 0.1) {
      p.wanted = Math.max(p.wanted, POLICE_BOAT_STARS);
      look(p, boat.x, boat.y);
      sim.step(0.1);
    }
    expect(dist(police.x, police.y, boat.x, boat.y)).toBeLessThan(d0 - 30);
  });
});
