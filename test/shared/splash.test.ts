// What replaced running people over (src/shared/sim/rules/Splash.ts, src/shared/world/Puddles.ts;
// docs/plans/non-violent.md): the potholes, ŠPLECH! (a close, fast pass through water soaks someone; a
// cop costs a star), PLÁCNI SI! (a fan's high five) and HOP DO KRÍKA! (someone diving out of the way),
// all through the combo; contact voids them.
import { describe, expect, it } from 'vitest';
import { Sim } from '../../src/shared/sim/Sim';
import { Rng } from '../../src/shared/util/Rng';
import { Vehicle } from '../../src/shared/entities/Vehicle';
import { Ped } from '../../src/shared/entities/Ped';
import { nullEvents, type PrivateEvent } from '../../src/shared/sim/events';
import type { Caps } from '../../src/shared/sim/density';
import type { SimPlayer } from '../../src/shared/sim/SimPlayer';
import { STYLE } from '../../src/shared/sim/rules/Style';
import { Puddles } from '../../src/shared/world/Puddles';
import { loadWorld } from './helpers';

const NO_NPCS: Caps = { traffic: 0, parked: 0, peds: 0, trams: 0, police: 0, helis: 0, roadblocks: 0 };
// Pečnianska in Petržalka: a straight, open street (see style.test.ts)
const A = { x: -1052.6, y: 1124.9 }, B = { x: -1202.5, y: 1117.5 };
const WEST = Math.atan2(B.y - A.y, B.x - A.x);
const DX = Math.cos(WEST), DY = Math.sin(WEST);
// the left of the car's heading
const LX = -DY, LY = DX;

function setup(o: { rain?: number } = {}) {
  const priv: [number, PrivateEvent][] = [];
  const world: { splash: number[]; five: number[] } = { splash: [], five: [] };
  const sim = new Sim(loadWorld(), {
    rng: new Rng(7), caps: NO_NPCS, driveClock: false, rules: 'offline',
    events: { ...nullEvents, toPlayer: (pid, e) => priv.push([pid, e]), splash: (id) => world.splash.push(id), highFive: (id) => world.five.push(id) },
  });
  sim.clock.setTime(12);
  sim.clock.setRain(o.rain ?? 0);
  const p = sim.addPlayer({ nick: 'A', profile: { money: 0, done: [], found: [...loadWorld().landmarks.keys()], cumils: [] }, kinematic: true, x: A.x, y: A.y });
  // (the moves this is about, not the street's own: a bump the car flies over is AIR)
  const ours = new Set([STYLE.splash.label, STYLE.copsplash.label, STYLE.highfive.label, STYLE.dive.label]);
  const labels = () => priv.map(([, e]) => e).filter((e): e is Extract<PrivateEvent, { k: 'style' }> => e.k === 'style' && e.mult !== undefined && ours.has(e.label)).map((e) => e.label);
  return { sim, p, labels, world };
}

/** `p` at the wheel of a car at `at`, heading `angle`, going `speed` (the client drives it: kinematic) */
function car(sim: Sim, p: SimPlayer, at: { x: number; y: number }, speed: number, angle = WEST) {
  const v = sim.addVehicle(new Vehicle('sedan', at.x, at.y, angle, '#1565c0'));
  p.ped.x = at.x;
  p.ped.y = at.y;
  expect(sim.enterVehicle(p, v, 5)).toBe(true);
  v.vx = Math.cos(angle) * speed;
  v.vy = Math.sin(angle) * speed;
  return v;
}

/** someone standing still (idle) `ahead` metres along the street from A and `left` metres to its left */
function stander(sim: Sim, ahead: number, left: number, seed: number, kind: 'civ' | 'cop' = 'civ') {
  const q = sim.addPed(new Ped(kind, A.x + DX * ahead + LX * left, A.y + DY * ahead + LY * left, seed));
  q.state = 'idle';
  q.timer = 999;
  return q;
}

function run(sim: Sim, seconds: number, dt = 0.05) {
  for (let t = 0; t < seconds - 1e-9; t += dt) {
    for (const v of sim.vehicles) if (v.kinematic) (v.x += v.vx * dt), (v.y += v.vy * dt);
    for (const pl of sim.players.values()) if (pl.ped.vehicle) (pl.ped.x = pl.ped.vehicle.x), (pl.ped.y = pl.ped.vehicle.y);
    sim.step(dt);
  }
}

/** a seed for a civilian who's (or isn't) a fan */
function fanSeed(want: boolean, from = 1) {
  for (let s = from; ; s++) if (new Ped('civ', 0, 0, s).fan === want) return s;
}

// (a sedan is 1.9 m wide: its side 0.95 m off the centre line; a ped's radius is 0.34 m)
const SIDE = 0.95 + 0.34;

describe('the potholes (výtlky)', () => {
  const w = loadWorld();
  const holes = w.puddles.holes;

  it('a few hundred along the streets, some that never dry, the same from the same map', () => {
    expect(holes.length).toBeGreaterThan(200);
    expect(holes.length).toBeLessThan(1500);
    const always = holes.filter((h) => h.always).length;
    expect(always).toBeGreaterThan(holes.length * 0.2);
    expect(always).toBeLessThan(holes.length * 0.5);
    const again = new Puddles(w).holes;
    expect(again).toEqual(holes);
  });

  it('on the carriageway: never in the water, a building, a tunnel or on a bridge', () => {
    for (const h of holes) {
      expect(w.inWater(h.x, h.y, 0)).toBe(false);
      expect(w.insideBuilding(h.x, h.y)).toBe(false);
      expect(w.onBridge(h.x, h.y)).toBe(false);
      expect(w.tunnelDepth(h.x, h.y)).toBeLessThan(0);
      expect(['asphalt', 'cobble']).toContain(w.surfaceAt(h.x, h.y, 0));
    }
  });

  it('`at` finds one where it is, not a few metres off', () => {
    const h = holes[Math.floor(holes.length / 2)];
    const i = w.puddles.at(h.x, h.y);
    expect(i).toBeGreaterThanOrEqual(0);
    expect(w.puddles.holes[i]).toBe(h);
    expect(w.puddles.at(h.x + h.uy * 3, h.y - h.ux * 3)).toBe(-1);
    const dry = holes.find((x) => !x.always)!;
    expect(w.puddles.at(dry.x, dry.y, 0, true)).toBe(-1);
  });
});

describe('ŠPLECH!', () => {
  it('on a wet road: a close, fast pass soaks someone, once they stay clear a moment', () => {
    const { sim, p, labels, world } = setup({ rain: 1 });
    const q = stander(sim, 14, SIDE + 1.2, fanSeed(false));
    car(sim, p, A, 12);
    run(sim, 1.2);
    expect(world.splash).toEqual([q.id]);
    run(sim, 0.5);
    expect(labels()).toEqual([STYLE.splash.label]);
    expect(p.wanted).toBe(0);
    expect(q.dazed).toBe(false);
  });

  it('in the dry, only through a pothole that never dries', () => {
    const { sim, p, world } = setup();
    stander(sim, 14, SIDE + 1.2, fanSeed(false, 30));
    car(sim, p, A, 12);
    run(sim, 1.5);
    expect(world.splash).toHaveLength(0);
    // one that never dries, driven through with the nearside wheel, someone just beyond it
    const w = sim.world, h = w.puddles.holes.find((x) => x.always)!;
    const angle = Math.atan2(h.uy, h.ux);
    const lx = -Math.sin(angle), ly = Math.cos(angle);
    const start = { x: h.x - h.ux * 12 - lx * 0.95, y: h.y - h.uy * 12 - ly * 0.95 };
    const { sim: sim2, p: p2, labels: labels2, world: world2 } = setup();
    // (the camera there too: nobody is kept that far from every player)
    p2.observer.cx = p2.observer.fx = h.x;
    p2.observer.cy = p2.observer.fy = h.y;
    const q = sim2.addPed(new Ped('civ', h.x + lx * 1.2, h.y + ly * 1.2, fanSeed(false, 60)));
    q.state = 'idle';
    q.timer = 999;
    car(sim2, p2, start, 12, angle);
    run(sim2, 2);
    expect(world2.splash).toEqual([q.id]);
    expect(labels2()).toContain(STYLE.splash.label);
  });

  it('a cop soaked from a puddle: a star, and the cop version', () => {
    const { sim, p, labels } = setup({ rain: 1 });
    stander(sim, 14, SIDE + 1.2, 5, 'cop');
    car(sim, p, A, 12);
    run(sim, 2);
    expect(labels()).toEqual([STYLE.copsplash.label]);
    expect(p.wanted).toBeGreaterThanOrEqual(1);
  });

  it('the same person only once in a while; too slow or too far, nothing', () => {
    const { sim, p, labels, world } = setup({ rain: 1 });
    const q = stander(sim, 14, SIDE + 1.2, fanSeed(false));
    const v = car(sim, p, A, 12);
    run(sim, 2);
    expect(world.splash).toEqual([q.id]);
    v.x = A.x;
    v.y = A.y;
    run(sim, 2);
    expect(world.splash).toEqual([q.id]);
    expect(labels()).toEqual([STYLE.splash.label]);
    // (someone new) too slow
    const { sim: s2, p: p2, world: w2 } = setup({ rain: 1 });
    stander(s2, 14, SIDE + 1.2, fanSeed(false));
    car(s2, p2, A, 6);
    run(s2, 3);
    expect(w2.splash).toHaveLength(0);
    // too far
    const { sim: s3, p: p3, world: w3 } = setup({ rain: 1 });
    stander(s3, 14, SIDE + 3.5, fanSeed(false));
    car(s3, p3, A, 12);
    run(s3, 2);
    expect(w3.splash).toHaveLength(0);
  });

  it('a BOING straight after voids it: contact never pays', () => {
    const { sim, p, labels, world } = setup({ rain: 1 });
    stander(sim, 12, SIDE + 1.2, fanSeed(false));
    // and someone standing in the car's path just beyond, hit a moment after the splash (someone
    // standing still doesn't jump clear)
    const inPath = stander(sim, 13, 0, fanSeed(false, 90));
    car(sim, p, A, 12);
    run(sim, 1.5);
    expect(world.splash).toHaveLength(1);
    expect(inPath.dazed).toBe(true);
    expect(labels()).toEqual([]);
  });
});

describe('PLÁCNI SI! and HOP DO KRÍKA!', () => {
  it('a fan beside a car coming past, close and not too fast, high-fives it (once in a while)', () => {
    const { sim, p, labels, world } = setup();
    const q = stander(sim, 14, SIDE + 0.5, fanSeed(true));
    const v = car(sim, p, A, 10);
    run(sim, 2);
    expect(world.five).toEqual([q.id]);
    expect(labels()).toEqual([STYLE.highfive.label]);
    expect(q.dazed).toBe(false);
    // again straight away: no
    v.x = A.x;
    v.y = A.y;
    run(sim, 2);
    expect(world.five).toEqual([q.id]);
    // too fast: no high five
    const { sim: s2, p: p2, world: w2 } = setup();
    stander(s2, 14, SIDE + 0.5, fanSeed(true));
    car(s2, p2, A, 22);
    run(s2, 1.2);
    expect(w2.five).toHaveLength(0);
    // not a fan: no high five
    const { sim: s3, p: p3, world: w3 } = setup();
    stander(s3, 14, SIDE + 0.5, fanSeed(false));
    car(s3, p3, A, 10);
    run(s3, 2);
    expect(w3.five).toHaveLength(0);
  });

  it('someone walking in the car’s line dives clear at the last second: HOP DO KRÍKA!', () => {
    const { sim, p, labels } = setup();
    const q = sim.addPed(new Ped('civ', A.x + DX * 14, A.y + DY * 14, fanSeed(false, 120)));
    q.state = 'walk';
    car(sim, p, A, 12);
    let dove = false;
    for (let i = 0; i < 30 && !dove; i++) {
      run(sim, 0.05);
      if (q.state === 'flee' && q.dash > 0) dove = true;
    }
    expect(dove).toBe(true);
    run(sim, 1);
    expect(q.dazed).toBe(false);
    expect(labels()).toContain(STYLE.dive.label);
  });
});
