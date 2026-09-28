// Nobody dies (docs/plans/non-violent.md): someone soaked through, tickled till they sit down, bounced
// off a car or caught next to a car giving up is knocked down, sits dazed a few seconds, gets up dry
// and goes home to change. One reward a person; contact with a car never pays; a cop who got up is
// off duty; a driver knocked down at the wheel gets out.
import { describe, expect, it } from 'vitest';
import { Sim } from '../../src/shared/sim/Sim';
import { Rng } from '../../src/shared/util/Rng';
import { Vehicle } from '../../src/shared/entities/Vehicle';
import { Ped, dazeTime } from '../../src/shared/entities/Ped';
import { nullEvents, type PrivateEvent } from '../../src/shared/sim/events';
import type { Caps } from '../../src/shared/sim/density';
import type { SimPlayer } from '../../src/shared/sim/SimPlayer';
import { STYLE } from '../../src/shared/sim/rules/Style';
import { SAY_UP, lineText } from '../../src/shared/sim/phrases';
import { loadWorld } from './helpers';

const NO_NPCS: Caps = { traffic: 0, parked: 0, peds: 0, trams: 0, police: 0, helis: 0, roadblocks: 0 };
// Pečnianska in Petržalka: a straight, open street (see style.test.ts)
const A = { x: -1052.6, y: 1124.9 }, B = { x: -1202.5, y: 1117.5 };
const WEST = Math.atan2(B.y - A.y, B.x - A.x);
const DX = Math.cos(WEST), DY = Math.sin(WEST);

function setup() {
  const priv: [number, PrivateEvent][] = [];
  const said: number[] = [];
  const sim = new Sim(loadWorld(), {
    rng: new Rng(5), caps: NO_NPCS, driveClock: false, rules: 'offline',
    events: { ...nullEvents, toPlayer: (pid, e) => priv.push([pid, e]), say: (_id, _x, _y, line) => said.push(line) },
  });
  sim.clock.setTime(12);
  const p = sim.addPlayer({ nick: 'A', profile: { money: 0, done: [], found: [...loadWorld().landmarks.keys()], cumils: [] }, kinematic: true, x: A.x, y: A.y });
  const sent = <K extends PrivateEvent['k']>(k: K) => priv.map(([, e]) => e).filter((e): e is Extract<PrivateEvent, { k: K }> => e.k === k);
  return { sim, p, sent, said };
}

/** squirt `ped` with the water pistol until they sit down (a hit is 55 of their 100) */
function soak(sim: Sim, p: SimPlayer, ped: Ped) {
  p.ammo.pistol = 50;
  for (let i = 0; i < 4 && !ped.dazed; i++)
    sim.applyShot(p, { ox: p.ped.x, oy: p.ped.y, a: 0, w: 'pistol', lvl: 0, pellets: [{ a: 0, hx: ped.x, hy: ped.y, kind: 2, hit: ped.id }], rt: 0 } as never);
}

/** a police car with a cop at the wheel, parked facing `angle` (nobody drives it: it stays put) */
function policeCar(sim: Sim, x: number, y: number, angle: number) {
  const v = new Vehicle('police', x, y, angle, '#f5f5f5');
  const cop = new Ped('cop', x, y, 7);
  cop.vehicle = v;
  v.driver = cop;
  sim.addVehicle(v);
  sim.addPed(cop);
  return v;
}

function run(sim: Sim, seconds: number, dt = 0.05) {
  for (let t = 0; t < seconds - 1e-9; t += dt) {
    for (const v of sim.vehicles) if (v.kinematic) (v.x += v.vx * dt), (v.y += v.vy * dt);
    for (const pl of sim.players.values()) if (pl.ped.vehicle) (pl.ped.x = pl.ped.vehicle.x), (pl.ped.y = pl.ped.vehicle.y);
    sim.step(dt);
  }
}

describe('knocked down, not killed', () => {
  it('soaked through: sits dazed, gets up dry after their daze time, says so, and heads home', () => {
    const { sim, p, said } = setup();
    const ped = sim.addPed(new Ped('civ', A.x + 3, A.y, 11));
    soak(sim, p, ped);
    expect(ped.dazed).toBe(true);
    expect(ped.downMess).toBe('water');
    run(sim, dazeTime(ped) - 0.3);
    expect(ped.dazed).toBe(true);
    run(sim, 0.6);
    expect(ped.dazed).toBe(false);
    expect(ped.health).toBe(100);
    expect(ped.leaving).toBe(true);
    expect(ped.state).toBe('flee');
    // their line: one of the getting-up ones, about being wet
    const up = said.filter((l) => ((l & 127) >> 4) === SAY_UP);
    expect(up).toHaveLength(1);
    expect(['Moje nové topánky!', 'Mokro až do ponožiek!', 'Idem sa prezliecť!', 'Práve idem od kaderníčky!', 'My shoes!', "I'm soaked!", 'Not the hair!', 'So wet!']).toContain(lineText(up[0]));
    expect(sim.peds.includes(ped)).toBe(true);
  });

  it("someone on their way home is gone once no player's camera sees them (not before)", () => {
    const { sim, p } = setup();
    const ped = sim.addPed(new Ped('civ', A.x + 3, A.y, 12));
    soak(sim, p, ped);
    run(sim, dazeTime(ped) + 0.5);
    expect(ped.leaving).toBe(true);
    expect(sim.peds.includes(ped)).toBe(true);
    // the camera looks elsewhere (still near enough that nobody would despawn otherwise)
    p.observer.cx = p.observer.fx = A.x + 90;
    run(sim, 1);
    expect(sim.peds.includes(ped)).toBe(false);
  });

  it("someone sitting dazed can't be squirted again, and one reward a person: their cash and the combo only the first time", () => {
    const { sim, p, sent } = setup();
    const ped = sim.addPed(new Ped('civ', A.x + 3, A.y, 13));
    ped.money = 30;
    soak(sim, p, ped);
    const pickups = () => sim.pickups.filter((k) => k.kind === 'cash').length;
    expect(pickups()).toBe(1);
    expect(sent('style').filter((e) => e.mult)).toHaveLength(1);
    const hits = sent('style').length;
    soak(sim, p, ped); // (dazed: nothing lands)
    expect(sent('style')).toHaveLength(hits);
    run(sim, dazeTime(ped) + 0.5);
    ped.x = A.x + 3;
    ped.y = A.y;
    const stars = p.wanted;
    soak(sim, p, ped); // knocked down again on the way home: the crime, but no second reward
    expect(ped.dazed).toBe(true);
    expect(sent('style').filter((e) => e.mult)).toHaveLength(1);
    expect(pickups()).toBe(1);
    expect(p.wanted).toBeGreaterThanOrEqual(stars);
  });

  it("a car that hits someone bounces them off (BOING): a star in front of the police, but no combo and no cash; they get up", () => {
    const { sim, p, sent } = setup();
    // a patrol car up the street, facing the player's way: it sees the bump
    policeCar(sim, A.x + DX * 45 - DY * 5, A.y + DY * 45 + DX * 5, WEST + Math.PI);
    const v = sim.addVehicle(new Vehicle('sedan', A.x, A.y, WEST, '#1565c0'));
    expect(sim.enterVehicle(p, v, 5)).toBe(true);
    // (close enough that they can't jump out of the way any more: AI.dodge)
    const ped = sim.addPed(new Ped('civ', A.x + DX * 3.8, A.y + DY * 3.8, 14));
    ped.money = 30;
    v.vx = DX * 12;
    v.vy = DY * 12;
    for (let i = 0; i < 40 && !ped.dazed; i++) run(sim, 0.05);
    expect(ped.dazed).toBe(true);
    expect(ped.downMess).toBe('bonk');
    expect(p.wanted).toBeGreaterThanOrEqual(1);
    const styles = sent('style');
    expect(styles.map((e) => e.label)).toContain('BOING!');
    expect(styles.filter((e) => e.mult)).toHaveLength(0);
    expect(sim.pickups.filter((k) => k.kind === 'cash')).toHaveLength(0);
    // no second BOING for someone already sitting there: the car only nudges them aside
    const stars = p.wanted;
    v.vx = v.vy = 0;
    v.x = ped.x - DX * 4;
    v.y = ped.y - DY * 4;
    v.vx = DX * 12;
    v.vy = DY * 12;
    run(sim, 0.8);
    expect(sent('style').filter((e) => e.label === 'BOING!')).toHaveLength(1);
    expect(p.wanted).toBe(stars);
    v.vx = v.vy = 0;
    run(sim, dazeTime(ped) + 0.5);
    expect(ped.dazed).toBe(false);
    expect(ped.health).toBe(100);
  });

  it('a BOING nobody sees and nobody is there to phone in costs no stars', () => {
    const { sim, p, sent } = setup();
    const v = sim.addVehicle(new Vehicle('sedan', A.x, A.y, WEST, '#1565c0'));
    expect(sim.enterVehicle(p, v, 5)).toBe(true);
    const ped = sim.addPed(new Ped('civ', A.x + DX * 3.8, A.y + DY * 3.8, 14));
    v.vx = DX * 12;
    v.vy = DY * 12;
    for (let i = 0; i < 40 && !ped.dazed; i++) run(sim, 0.05);
    expect(ped.dazed).toBe(true);
    expect(sent('style').map((e) => e.label)).toContain('BOING!');
    expect(p.wanted).toBe(0);
  });

  it('a cop knocked down goes off duty once up: no chase, not armed', () => {
    const { sim, p } = setup();
    const cop = sim.addPed(new Ped('cop', A.x + 3, A.y, 15));
    soak(sim, p, cop);
    expect(cop.dazed).toBe(true);
    p.wanted = 3;
    run(sim, dazeTime(cop) + 0.5);
    expect(cop.dazed).toBe(false);
    expect(cop.leaving).toBe(true);
    expect(cop.state).toBe('flee');
    const d0 = Math.hypot(cop.x - p.ped.x, cop.y - p.ped.y);
    run(sim, 2);
    // hurrying off, not closing in to cuff or squirt the player
    expect(Math.hypot(cop.x - p.ped.x, cop.y - p.ped.y)).toBeGreaterThan(d0);
    expect(cop.state).toBe('flee');
  });

  it('a driver knocked down at the wheel stops the car, comes round and gets out', () => {
    const { sim, p } = setup();
    const v = sim.addVehicle(new Vehicle('hatch', A.x + 6, A.y, WEST, '#eeeeee'));
    const d = sim.addPed(new Ped('civ', v.x, v.y, 16));
    d.vehicle = v;
    v.driver = d;
    sim.knockDown(d, p.ped.x, p.ped.y, 3, 'shot', p.id, 'water');
    expect(d.dazed).toBe(true);
    expect(d.vehicle).toBe(v);
    run(sim, dazeTime(d) + 0.5);
    expect(d.dazed).toBe(false);
    expect(d.vehicle).toBeNull();
    expect(v.driver).toBeNull();
    expect(Math.hypot(d.x - v.x, d.y - v.y)).toBeLessThan(6);
  });

  it('a car blowing up knocks down the people next to it, sooty, and they get up', () => {
    const { sim } = setup();
    const ped = sim.addPed(new Ped('civ', A.x + 3, A.y, 17));
    const v = sim.addVehicle(new Vehicle('sedan', A.x, A.y, WEST, '#1565c0'));
    sim.combat.explode(v.x, v.y, v, 0);
    expect(ped.dazed).toBe(true);
    expect(ped.downMess).toBe('soot');
    run(sim, dazeTime(ped) + 0.5);
    expect(ped.dazed).toBe(false);
  });

  it('the combo for a soaking is a toy word, not a kill', () => {
    expect(Object.values(STYLE).map((s) => s.label).join(' ')).not.toMatch(/KILL|TAKEDOWN|K\.O\./);
  });
});
