// Horúca Kofolka and Hon na Čumila (src/shared/sim/rules/events/), against the real map, plus the
// shared tyre-burst combat rule they both rely on (gunfire near a wheel, for any car).
// Plan: docs/plans/social-events.md
import { describe, expect, it } from 'vitest';
import { Sim } from '../../src/shared/sim/Sim';
import { Rng } from '../../src/shared/util/Rng';
import { LIVERY_KOFOLKA, LIVERY_NONE, Vehicle } from '../../src/shared/entities/Vehicle';
import { HitKind } from '../../src/shared/sim/Combat';
import { nullEvents, type GlobalEvent, type PrivateEvent } from '../../src/shared/sim/events';
import type { WorldEvents } from '../../src/shared/sim/rules/WorldEvents';
import { dist } from '../../src/shared/util/math';
import { loadWorld } from './helpers';

/** every landmark pre-"found", so the ordinary +€100 landmark bonus never confounds a payout assertion
 *  (players in these tests often stand right on top of one, e.g. 'main') */
const ALL_LANDMARKS = [...loadWorld().landmarks.keys()];
const profile = () => ({ money: 0, done: [], found: [...ALL_LANDMARKS], cumils: [] });
/** an all-zero cap set: no NPC ever spawns, so the long draining/expiry runs stay deterministic */
const NO_NPCS = { traffic: 0, parked: 0, peds: 0, trams: 0, police: 0, helis: 0, roadblocks: 0 };

describe('Horúca Kofolka', () => {
  it('spawns the van at a valid spot: in range, clear of players, drivable, level 0, outside buildings', () => {
    const sim = new Sim(loadWorld(), { rng: new Rng(201), rules: 'server', caps: NO_NPCS });
    const main = sim.world.landmark('main');
    const a = sim.addPlayer({ nick: 'A', profile: profile(), kinematic: false, x: main.x, y: main.y });
    const b = sim.addPlayer({ nick: 'B', profile: profile(), kinematic: false, x: main.x + 40, y: main.y });
    const dir = sim.rule<WorldEvents>('worldEvents')!;
    const ev = dir.start('kofolka');
    expect(ev).not.toBeNull();
    const van = sim.vehicles.find((v) => v.livery === LIVERY_KOFOLKA)!;
    expect(van).toBeTruthy();
    expect(van.mission).toBe(true);
    expect(van.parked).toBe(true);
    expect(van.color).toBe('#c8102e');
    const cx = (a.ped.x + b.ped.x) / 2, cy = (a.ped.y + b.ped.y) / 2;
    const d = dist(van.x, van.y, cx, cy);
    expect(d).toBeGreaterThanOrEqual(500);
    expect(d).toBeLessThanOrEqual(1500);
    expect(dist(van.x, van.y, a.ped.x, a.ped.y)).toBeGreaterThanOrEqual(150);
    expect(dist(van.x, van.y, b.ped.x, b.ped.y)).toBeGreaterThanOrEqual(150);
    expect(sim.world.collideCircle(van.x, van.y, van.spec.width / 2, 0)).toBeNull();
    sim.step(0.1); // physics assigns the level on the first tick (World.spawnLevel, the same check used to pick the spot)
    expect(van.level).toBe(0);
    expect(ev!.entry().place.length).toBeGreaterThan(0);
  });

  it('pays only the driver every second, and the pot drains; the other player gets nothing', () => {
    const sim = new Sim(loadWorld(), { rng: new Rng(202), rules: 'server', caps: NO_NPCS });
    const main = sim.world.landmark('main');
    const a = sim.addPlayer({ nick: 'A', profile: profile(), kinematic: false, x: main.x, y: main.y });
    const b = sim.addPlayer({ nick: 'B', profile: profile(), kinematic: false, x: main.x + 40, y: main.y });
    const dir = sim.rule<WorldEvents>('worldEvents')!;
    const ev = dir.start('kofolka')!;
    const van = sim.vehicles.find((v) => v.livery === LIVERY_KOFOLKA)!;
    for (let i = 0; i < 35; i++) sim.step(1); // past the 30 s announce, with margin; nobody has taken it yet
    expect(ev.entry().phase).toBe('live');
    expect(a.profile.money).toBe(0);
    expect(b.profile.money).toBe(0);
    a.ped.x = van.x;
    a.ped.y = van.y;
    expect(sim.enterVehicle(a, van, 10)).toBe(true);
    for (let i = 0; i < 5; i++) sim.step(1);
    expect(a.profile.money).toBe(50);
    expect(b.profile.money).toBe(0);
    expect(Math.round(ev.entry().pot!)).toBe(1450);
    expect(ev.entry().holder).toBe(a.id);
    expect(ev.entry().holderNick).toBe('A');
  });

  it('a wreck spills about the remaining pot as up to 10 cash pickups, then ends and un-marks the van', () => {
    const sim = new Sim(loadWorld(), { rng: new Rng(203), rules: 'server', caps: NO_NPCS });
    const main = sim.world.landmark('main');
    sim.addPlayer({ nick: 'A', profile: profile(), kinematic: false, x: main.x, y: main.y });
    const dir = sim.rule<WorldEvents>('worldEvents')!;
    dir.start('kofolka');
    const van = sim.vehicles.find((v) => v.livery === LIVERY_KOFOLKA)!;
    const before = sim.pickups.length;
    sim.wreck(van);
    dir.step(0.1);
    expect(dir.active.length).toBe(0);
    const spilled = sim.pickups.slice(before);
    expect(spilled.length).toBeGreaterThan(0);
    expect(spilled.length).toBeLessThanOrEqual(10);
    expect(spilled.every((p) => p.kind === 'cash' && dist(p.x, p.y, van.x, van.y) >= 1.9 && dist(p.x, p.y, van.x, van.y) <= 5.1)).toBe(true);
    expect(spilled.reduce((s, p) => s + p.amount, 0)).toBe(1500);
    expect(van.mission).toBe(false);
    expect(van.livery).toBe(LIVERY_NONE);
  });

  it('expires after 3 minutes live with nobody ever taking it', () => {
    const globals: GlobalEvent[] = [];
    const sim = new Sim(loadWorld(), { rng: new Rng(204), rules: 'server', caps: NO_NPCS, events: { ...nullEvents, global: (e) => globals.push(e) } });
    const main = sim.world.landmark('main');
    sim.addPlayer({ nick: 'A', profile: profile(), kinematic: false, x: main.x, y: main.y });
    const dir = sim.rule<WorldEvents>('worldEvents')!;
    dir.start('kofolka');
    for (let i = 0; i < 30 + 180 + 2; i++) sim.step(1); // the 30 s announce, then the 3-minute untaken cutoff
    expect(dir.active.length).toBe(0);
    expect(globals.some((e) => e.k === 'eventEnd' && e.kind === 'kofolka' && e.how === 'expired')).toBe(true);
  });
});

describe('Hon na Čumila', () => {
  it('places a valid target: in range, clear of players, walkable, level 0, dry — and the hint circle always contains it', () => {
    const sim = new Sim(loadWorld(), { rng: new Rng(210), rules: 'offline', caps: NO_NPCS });
    const main = sim.world.landmark('main');
    sim.addPlayer({ nick: 'A', profile: profile(), kinematic: false, x: main.x, y: main.y });
    const dir = sim.rule<WorldEvents>('worldEvents')!;
    const ev = dir.start('cumil')!;
    expect(ev).not.toBeNull();
    // the target itself is never in EventEntry ("never the target"); peek at the instance for the algorithm's own check
    const target = (ev as unknown as { target: { x: number; y: number } }).target;
    const d = dist(target.x, target.y, main.x, main.y);
    expect(d).toBeGreaterThanOrEqual(400);
    expect(d).toBeLessThanOrEqual(1200);
    const wk = sim.world.walkableNear(target.x, target.y);
    expect(dist(wk.x, wk.y, target.x, target.y)).toBeLessThanOrEqual(2);
    expect(sim.world.spawnLevel(target.x, target.y, 0.4)).toBe(0);
    expect(sim.world.inWater(target.x, target.y, 0)).toBe(false);

    // the circle is jittered from the very first entry: the exact spot never leaves the server
    const first = ev.entry();
    expect(Math.hypot(first.x! - target.x, first.y! - target.y)).toBeGreaterThan(0);
    for (let i = 0; i < 30 + 300 + 5; i++) {
      sim.step(1);
      const e = ev.entry();
      expect(Math.hypot(e.x! - target.x, e.y! - target.y)).toBeLessThanOrEqual(e.r! + 1e-6);
    }
    expect(ev.entry().r).toBeCloseTo(30, 0); // fully shrunk after 5 minutes live
  });

  it('picking it up pays 600, bumps stats.golden and ends the event', () => {
    const sim = new Sim(loadWorld(), { rng: new Rng(211), rules: 'offline', caps: NO_NPCS });
    const main = sim.world.landmark('main');
    const p = sim.addPlayer({ nick: 'A', profile: profile(), kinematic: false, x: main.x, y: main.y });
    const dir = sim.rule<WorldEvents>('worldEvents')!;
    const ev = dir.start('cumil')!;
    for (let i = 0; i < 35; i++) sim.step(1); // past the 30 s announce; the pickup now exists
    expect(ev.entry().phase).toBe('live');
    const target = (ev as unknown as { target: { x: number; y: number } }).target;
    p.ped.x = target.x;
    p.ped.y = target.y;
    sim.step(0.1);
    expect(p.profile.money).toBe(600);
    expect(p.profile.stats?.golden).toBe(1);
    expect(dir.active.length).toBe(0);
    expect(sim.pickups.some((pk) => pk.kind === 'goldenCumil')).toBe(false);
  });

  it('times out unclaimed after 7 minutes live: hides the pickup and ends "expired"', () => {
    const globals: GlobalEvent[] = [];
    const sim = new Sim(loadWorld(), { rng: new Rng(212), rules: 'offline', caps: NO_NPCS, events: { ...nullEvents, global: (e) => globals.push(e) } });
    const main = sim.world.landmark('main');
    sim.addPlayer({ nick: 'A', profile: profile(), kinematic: false, x: main.x, y: main.y });
    const dir = sim.rule<WorldEvents>('worldEvents')!;
    const ev = dir.start('cumil')!;
    const target = (ev as unknown as { target: { x: number; y: number } }).target;
    for (let i = 0; i < 30 + 420 + 2; i++) sim.step(1); // 30 s announce + 7 min live
    // the announce and start broadcasts carry the jittered circle centre, never the statue's spot
    for (const e of globals) if (e.k === 'eventAnnounce' || e.k === 'eventStart') expect(Math.hypot(e.x - target.x, e.y - target.y)).toBeGreaterThan(0);
    expect(globals.filter((e) => e.k === 'eventAnnounce' || e.k === 'eventStart').length).toBe(2);
    expect(dir.active.length).toBe(0);
    expect(globals.some((e) => e.k === 'eventEnd' && e.kind === 'cumil' && e.how === 'expired')).toBe(true);
    expect(sim.pickups.some((pk) => pk.kind === 'goldenCumil')).toBe(false);
  });

  it('a goldenCumil pickup never touches ammo or the weapon (Sim.takePickup)', () => {
    const sim = new Sim(loadWorld(), { rng: new Rng(213), caps: NO_NPCS });
    const p = sim.addPlayer({ nick: 'A', profile: profile(), kinematic: false });
    p.ammo.pistol = 5;
    p.ped.weapon = 'pistol';
    sim.pickups.push({ id: sim.ids.alloc(sim.time), x: p.ped.x, y: p.ped.y, kind: 'goldenCumil', amount: 600, respawn: 0, hidden: 0, cumil: -1 });
    sim.step(0.1);
    expect(p.ammo.pistol).toBe(5);
    expect(p.ammo.uzi).toBe(0);
    expect(p.ammo.shotgun).toBe(0);
    expect(p.ped.weapon).toBe('pistol');
    // Sim.takePickup itself only lets it be taken; the payout comes from CumilHunt.onPickup (tested
    // above), and there's no active rule here to pay it
    expect(p.profile.money).toBe(0);
  });
});

describe('tyre bursts (all cars)', () => {
  it('a pellet near a wheel bursts the tyres and tells a player owner', () => {
    const got: [number, PrivateEvent][] = [];
    const sim = new Sim(loadWorld(), { rng: new Rng(220), events: { ...nullEvents, toPlayer: (pid, e) => got.push([pid, e]) } });
    const car = sim.addVehicle(new Vehicle('sedan', 0, 0, 0, '#fff'));
    car.owner = 7; // a player's car (kinematic on the real server; irrelevant to this unit test)
    const wx = car.spec.length / 2 - 0.7, wy = car.spec.width / 2; // front-right wheel, angle 0
    sim.combat.applyShot(
      { id: 0, x: -2, y: 0, level: 0, vehicle: null },
      0,
      { w: 'pistol', ox: -1.5, oy: 0, a: 0, lvl: 0, pellets: [{ a: 0, kind: HitKind.Car, hit: car.id, hx: wx, hy: wy }] },
    );
    expect(car.tyresBurst).toBe(1);
    expect(got.some(([pid, e]) => pid === 7 && e.k === 'tyres' && e.vehicle === car.id)).toBe(true);
  });

  it('a pellet well clear of any wheel does not burst the tyres', () => {
    const sim = new Sim(loadWorld(), { rng: new Rng(221) });
    const car = sim.addVehicle(new Vehicle('sedan', 0, 0, 0, '#fff'));
    sim.combat.applyShot(
      { id: 0, x: -2, y: 0, level: 0, vehicle: null },
      0,
      { w: 'pistol', ox: -1.5, oy: 0, a: 0, lvl: 0, pellets: [{ a: 0, kind: HitKind.Car, hit: car.id, hx: 0, hy: 0 }] }, // dead centre
    );
    expect(car.tyresBurst).toBe(0);
  });
});
