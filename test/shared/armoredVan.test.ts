// Obrnené auto (src/shared/sim/rules/events/ArmoredVan.ts), against the real map with fixed Rng seeds.
// Plan: docs/plans/social-events.md
import { describe, expect, it } from 'vitest';
import { Sim } from '../../src/shared/sim/Sim';
import { Rng } from '../../src/shared/util/Rng';
import { LIVERY_ARMORED, LIVERY_NONE } from '../../src/shared/entities/Vehicle';
import { HitKind } from '../../src/shared/sim/Combat';
import { nullEvents, type GlobalEvent } from '../../src/shared/sim/events';
import type { WorldEvents } from '../../src/shared/sim/rules/WorldEvents';
import { dist } from '../../src/shared/util/math';
import { loadWorld } from './helpers';

/** every landmark pre-"found", so the ordinary +€100 landmark bonus never confounds a money assertion */
const ALL_LANDMARKS = [...loadWorld().landmarks.keys()];
const profile = () => ({ money: 0, done: [], found: [...ALL_LANDMARKS], cumils: [] });
/** an all-zero cap set: no NPC ever spawns, so shots/pickups/timers stay fully deterministic. The van
 *  drives itself outside this system (AI.driveRoute, not the capped spawners), so it needs nothing back. */
const NO_NPCS = { traffic: 0, parked: 0, peds: 0, trams: 0, police: 0, helis: 0, roadblocks: 0 };

/** two players near Hlavné námestie, far enough apart that neither blocks the other's placement checks */
function twoPlayers(sim: Sim) {
  const main = sim.world.landmark('main');
  const a = sim.addPlayer({ nick: 'A', profile: profile(), kinematic: false, x: main.x, y: main.y });
  const b = sim.addPlayer({ nick: 'B', profile: profile(), kinematic: false, x: main.x + 40, y: main.y });
  return { a, b };
}

/** a synthetic pistol pellet landing at (hx, hy) on `vid`, the way test/shared/rules.test.ts fires one */
function shootCar(sim: Sim, vid: number, hx: number, hy: number, pid: number) {
  sim.combat.applyShot(
    { id: 0, x: hx - 5, y: hy, level: 0, vehicle: null },
    pid,
    { w: 'pistol', ox: hx - 5, oy: hy, a: 0, lvl: 0, pellets: [{ a: 0, kind: HitKind.Car, hit: vid, hx, hy }] },
  );
}

describe('Obrnené auto (ArmoredVan)', () => {
  it('picks a route: the van at level 0, each leg 1.0-2.0 km by road', () => {
    const sim = new Sim(loadWorld(), { rng: new Rng(230), rules: 'server', caps: NO_NPCS });
    twoPlayers(sim);
    const dir = sim.rule<WorldEvents>('worldEvents')!;
    const ev = dir.start('armored');
    expect(ev).not.toBeNull();
    const van = sim.vehicles.find((v) => v.livery === LIVERY_ARMORED)!;
    expect(van).toBeTruthy();
    expect(van.mission).toBe(true);
    expect(van.locked).toBe(true);
    expect(van.parked).toBe(true);
    sim.step(0.1); // physics assigns the level on the first tick (World.spawnLevel, the same check used to pick the spot)
    expect(van.level).toBe(0);
    const legAB = (ev as unknown as { legAB: { edge: { len: number } }[] }).legAB;
    const legBC = (ev as unknown as { legBC: { edge: { len: number } }[] }).legBC;
    const lenAB = legAB.reduce((s, l) => s + l.edge.len, 0);
    const lenBC = legBC.reduce((s, l) => s + l.edge.len, 0);
    expect(lenAB).toBeGreaterThanOrEqual(1000);
    expect(lenAB).toBeLessThanOrEqual(2000);
    expect(lenBC).toBeGreaterThanOrEqual(1000);
    expect(lenBC).toBeLessThanOrEqual(2000);
    expect(ev!.entry().place.length).toBeGreaterThan(0);
    expect(ev!.entry().pot).toBe(1200);
    expect(ev!.entry().vid).toBe(van.id);
  });

  it('is locked: nobody can just drive off with it', () => {
    const sim = new Sim(loadWorld(), { rng: new Rng(231), rules: 'server', caps: NO_NPCS });
    const { a } = twoPlayers(sim);
    const dir = sim.rule<WorldEvents>('worldEvents')!;
    dir.start('armored');
    const van = sim.vehicles.find((v) => v.livery === LIVERY_ARMORED)!;
    a.ped.x = van.x;
    a.ped.y = van.y;
    expect(sim.enterVehicle(a, van, 10)).toBe(false);
    expect(van.driver).toBeNull();
    expect(van.owner).toBe(0);
  });

  it('the armour cuts a pistol pellet to 0.2x damage', () => {
    const sim = new Sim(loadWorld(), { rng: new Rng(232), rules: 'server', caps: NO_NPCS });
    twoPlayers(sim);
    const dir = sim.rule<WorldEvents>('worldEvents')!;
    dir.start('armored');
    const van = sim.vehicles.find((v) => v.livery === LIVERY_ARMORED)!;
    expect(van.armor).toBe(0.2);
    const before = van.health;
    // straight into the side, well clear of the rear doors
    const hx = van.x - Math.sin(van.angle) * van.spec.width * 0.4;
    const hy = van.y + Math.cos(van.angle) * van.spec.width * 0.4;
    shootCar(sim, van.id, hx, hy, 0);
    expect(before - van.health).toBeCloseTo(55 * 0.35 * 0.2, 6);
  });

  it('rear hits drain the door HP; side hits do not', () => {
    const sim = new Sim(loadWorld(), { rng: new Rng(233), rules: 'server', caps: NO_NPCS });
    twoPlayers(sim);
    const dir = sim.rule<WorldEvents>('worldEvents')!;
    const ev = dir.start('armored')!;
    const van = sim.vehicles.find((v) => v.livery === LIVERY_ARMORED)!;
    const doorHp = () => (ev as unknown as { doorHp: number }).doorHp;
    const side = { x: van.x - Math.sin(van.angle) * van.spec.width * 0.4, y: van.y + Math.cos(van.angle) * van.spec.width * 0.4 };
    shootCar(sim, van.id, side.x, side.y, 0);
    expect(doorHp()).toBe(100);
    const rear = { x: van.x - Math.cos(van.angle) * 2, y: van.y - Math.sin(van.angle) * 2 };
    shootCar(sim, van.id, rear.x, rear.y, 0);
    expect(doorHp()).toBeCloseTo(100 - 55 * 0.35, 6);
  });

  it('bursts the rear doors after about 6 pistol hits: 12 tagged pickups worth $1,200, robbery stars ' +
    'for the recent rear hitters, and eventEnd robbed with the bursting shooter as winner', () => {
    const globals: GlobalEvent[] = [];
    const sim = new Sim(loadWorld(), { rng: new Rng(234), rules: 'server', caps: NO_NPCS, events: { ...nullEvents, global: (e) => globals.push(e) } });
    const { a, b } = twoPlayers(sim);
    const dir = sim.rule<WorldEvents>('worldEvents')!;
    dir.start('armored');
    const van = sim.vehicles.find((v) => v.livery === LIVERY_ARMORED)!;
    const rear = { x: van.x - Math.cos(van.angle) * 2, y: van.y - Math.sin(van.angle) * 2 };
    const before = sim.pickups.length;
    for (let i = 0; i < 5; i++) shootCar(sim, van.id, rear.x, rear.y, a.id);
    expect(a.wanted).toBe(0); // not bumped by plain 'shoot' with no cop or witness around
    expect(sim.pickups.length).toBe(before); // doors still holding
    shootCar(sim, van.id, rear.x, rear.y, b.id); // the 6th hit bursts them
    dir.step(0.1); // the director only prunes a finished event on its own next step
    const spilled = sim.pickups.slice(before);
    expect(spilled.length).toBe(12);
    expect(spilled.every((p) => p.tag === 'van')).toBe(true);
    expect(spilled.reduce((s, p) => s + p.amount, 0)).toBe(1200);
    expect(spilled.every((p) => dist(p.x, p.y, van.x, van.y) >= 1.9 && dist(p.x, p.y, van.x, van.y) <= 5.1)).toBe(true);
    expect(a.wanted).toBeGreaterThanOrEqual(2); // hit the rear within the last 10 s too
    expect(b.wanted).toBeGreaterThanOrEqual(2);
    expect(dir.active.length).toBe(0);
    const end = globals.find((e) => e.k === 'eventEnd' && e.kind === 'armored') as Extract<GlobalEvent, { k: 'eventEnd' }>;
    expect(end).toBeTruthy();
    expect(end.how).toBe('robbed');
    expect(end.winner).toBe('B');
    expect(end.amount).toBe(1200);
    expect(van.mission).toBe(false);
    expect(van.livery).toBe(LIVERY_NONE);
    expect(van.locked).toBe(false);
    expect(van.armor).toBe(1);
  });

  it('picking up van-tagged cash pays the loot star, even after the event has ended', () => {
    const sim = new Sim(loadWorld(), { rng: new Rng(235), rules: 'server', caps: NO_NPCS });
    const { a } = twoPlayers(sim);
    const dir = sim.rule<WorldEvents>('worldEvents')!;
    dir.start('armored');
    const van = sim.vehicles.find((v) => v.livery === LIVERY_ARMORED)!;
    const rear = { x: van.x - Math.cos(van.angle) * 2, y: van.y - Math.sin(van.angle) * 2 };
    for (let i = 0; i < 6; i++) shootCar(sim, van.id, rear.x, rear.y, a.id);
    dir.step(0.1); // the director only prunes a finished event on its own next step
    expect(dir.active.length).toBe(0); // the event is long gone
    const before = a.wanted;
    const pk = sim.pickups.find((p) => p.tag === 'van')!;
    expect(pk).toBeTruthy();
    a.ped.x = pk.x;
    a.ped.y = pk.y;
    const moneyBefore = a.profile.money;
    sim.step(0.1);
    // (the 12 pickups scatter close together, so standing on one may sweep up a neighbour too;
    // this only cares that real cash changed hands, not exactly how many of the 12 that was)
    expect(a.profile.money).toBeGreaterThan(moneyBefore);
    expect(a.wanted).toBeGreaterThan(before); // the loot crime's own +1★, on top of the robbery
  });

  it('a wreck spills the full $1,200 the same way and ends wrecked', () => {
    const globals: GlobalEvent[] = [];
    const sim = new Sim(loadWorld(), { rng: new Rng(236), rules: 'server', caps: NO_NPCS, events: { ...nullEvents, global: (e) => globals.push(e) } });
    twoPlayers(sim);
    const dir = sim.rule<WorldEvents>('worldEvents')!;
    dir.start('armored');
    const van = sim.vehicles.find((v) => v.livery === LIVERY_ARMORED)!;
    const before = sim.pickups.length;
    sim.wreck(van);
    dir.step(0.1);
    expect(dir.active.length).toBe(0);
    const spilled = sim.pickups.slice(before);
    expect(spilled.length).toBe(12);
    expect(spilled.every((p) => p.tag === 'van')).toBe(true);
    expect(spilled.reduce((s, p) => s + p.amount, 0)).toBe(1200);
    expect(van.mission).toBe(false);
    expect(van.livery).toBe(LIVERY_NONE);
    expect(van.locked).toBe(false);
    expect(van.armor).toBe(1);
    expect(globals.some((e) => e.k === 'eventEnd' && e.kind === 'armored' && e.how === 'wrecked')).toBe(true);
  });

  it('drives the route: gets closer to bank B over simulated time, then stops there for about 15 s', () => {
    const sim = new Sim(loadWorld(), { rng: new Rng(310), rules: 'server', caps: NO_NPCS });
    twoPlayers(sim);
    const dir = sim.rule<WorldEvents>('worldEvents')!;
    const ev = dir.start('armored')!;
    const van = sim.vehicles.find((v) => v.livery === LIVERY_ARMORED)!;
    const b = (ev as unknown as { b: { x: number; y: number } }).b;
    for (let i = 0; i < 30; i++) sim.step(1); // past the 30 s announce (parked, asleep: a coarse dt is fine)
    expect(ev.entry().phase).toBe('live');
    expect(van.parked).toBe(false);
    const d0 = dist(van.x, van.y, b.x, b.y);
    for (let i = 0; i < 60 / 0.05; i++) sim.step(0.05); // a minute of driving, at a physics-friendly dt
    expect(dist(van.x, van.y, b.x, b.y)).toBeLessThan(d0); // it's getting there
    let arrived = false;
    for (let i = 0; i < 300 / 0.05 && !arrived; i++) {
      sim.step(0.05);
      if (dist(van.x, van.y, b.x, b.y) <= 20) arrived = true;
    }
    expect(arrived).toBe(true);
    for (let i = 0; i < 5 / 0.05; i++) sim.step(0.05); // well within the 15 s dwell: braked to a stop
    expect(van.speed).toBeLessThan(1);
    for (let i = 0; i < 9 / 0.05; i++) sim.step(0.05); // 14 s since arriving: still dwelling
    expect(van.speed).toBeLessThan(1);
    for (let i = 0; i < 3 / 0.05; i++) sim.step(0.05); // 17 s since arriving: past the 15 s dwell
    expect(van.speed).toBeGreaterThan(1);
  });

  it('the driver being gone (killed, or simply nobody left to drive) does not stop the 6-minute clock: ' +
    'the van just sits there until it times out', () => {
    const globals: GlobalEvent[] = [];
    const sim = new Sim(loadWorld(), { rng: new Rng(237), rules: 'server', caps: NO_NPCS, events: { ...nullEvents, global: (e) => globals.push(e) } });
    twoPlayers(sim);
    const dir = sim.rule<WorldEvents>('worldEvents')!;
    const ev = dir.start('armored')!;
    const van = sim.vehicles.find((v) => v.livery === LIVERY_ARMORED)!;
    for (let i = 0; i < 30; i++) sim.step(1); // past the 30 s announce: now live, driving
    expect(ev.entry().phase).toBe('live');
    sim.ai.drivers.delete(van); // the driver is gone (AI.ts stops any car this way if it's killed/pulled out)
    van.setControls(0, 0, true);
    const start = { x: van.x, y: van.y };
    for (let i = 0; i < 6 * 60 + 5; i++) sim.step(1); // 6 min live
    expect(dist(van.x, van.y, start.x, start.y)).toBeLessThan(1); // never went anywhere
    expect(dir.active.length).toBe(0);
    expect(globals.some((e) => e.k === 'eventEnd' && e.kind === 'armored' && e.how === 'expired')).toBe(true);
  });
});
