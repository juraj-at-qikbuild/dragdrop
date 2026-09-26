// Derby na parkovisku (src/shared/sim/rules/events/Derby.ts), against the real map.
// Plan: docs/plans/social-events.md
import { describe, expect, it } from 'vitest';
import { Sim } from '../../src/shared/sim/Sim';
import { Rng } from '../../src/shared/util/Rng';
import { LIVERY_DERBY, LIVERY_NONE, SPECS, Vehicle } from '../../src/shared/entities/Vehicle';
import { nullEvents, type GlobalEvent } from '../../src/shared/sim/events';
import type { WorldEvents } from '../../src/shared/sim/rules/WorldEvents';
import type { Zones } from '../../src/shared/sim/rules/Zones';
import { bestParkingNear } from '../../src/shared/sim/rules/Zones';
import { dist, pointInRings } from '../../src/shared/util/math';
import { loadWorld } from './helpers';

const profile = () => ({ money: 0, done: [], found: [], cumils: [] });
/** an all-zero cap set: no NPC ever spawns, so a long-running test stays fully deterministic */
const NO_NPCS = { traffic: 0, parked: 0, peds: 0, trams: 0, police: 0, helis: 0, roadblocks: 0 };
const HEALTH = SPECS.classic.health; // 140

/** the site a point sits closest to: aupark and eurovea are ~1.7 km apart, well beyond the 250 m
 *  `bestParkingNear` search radius either way, so this is unambiguous */
function siteOf(world: ReturnType<typeof loadWorld>, x: number, y: number): 'aupark' | 'eurovea' {
  const a = world.landmark('aupark'), e = world.landmark('eurovea');
  return dist(x, y, a.x, a.y) <= dist(x, y, e.x, e.y) ? 'aupark' : 'eurovea';
}

/** drop a fresh classic car at (x, y) and put `p` in it (matches how the existing event tests enter a
 *  car: park the ped on it first, then Sim.enterVehicle) */
function putInCar(sim: Sim, p: ReturnType<Sim['addPlayer']>, x: number, y: number) {
  const car = sim.addVehicle(new Vehicle('classic', x, y, 0, '#fff'));
  p.ped.x = x;
  p.ped.y = y;
  expect(sim.enterVehicle(p, car, 10)).toBe(true);
  return car;
}

/** advance past the 90 s announce (with a little margin), so the derby is live */
function toLive(sim: Sim) {
  for (let i = 0; i < 92; i++) sim.step(1);
}

function makeSim(seed: number) {
  return new Sim(loadWorld(), { rng: new Rng(seed), rules: 'server', caps: NO_NPCS });
}

describe('Derby na parkovisku', () => {
  it('places the arena at aupark first, then alternates to eurovea, with a real zone', () => {
    const sim = makeSim(301);
    const world = sim.world;
    const dir = sim.rule<WorldEvents>('worldEvents')!;

    const ev1 = dir.start('derby')!;
    expect(ev1).not.toBeNull();
    const e1 = ev1.entry();
    expect(e1.kind).toBe('derby');
    expect(e1.phase).toBe('announce');
    expect(e1.zone).toBeDefined();
    expect(e1.zone!.length).toBeGreaterThanOrEqual(6); // >= 3 points
    expect(siteOf(world, e1.x!, e1.y!)).toBe('aupark');
    const aupark = bestParkingNear(world, 'aupark', 250)!;
    expect(dist(e1.x!, e1.y!, aupark.cx, aupark.cy)).toBeLessThan(1e-6);
    // the zone matches the arena ring the real map picks for aupark
    expect(e1.zone).toEqual(aupark.ring);

    // end it (mid-announce is fine: stop() cleans up too) and start the next one
    ev1.stop('test');
    sim.step(0.1);
    expect(dir.active.length).toBe(0);

    const ev2 = dir.start('derby')!;
    expect(ev2).not.toBeNull();
    const e2 = ev2.entry();
    expect(siteOf(world, e2.x!, e2.y!)).toBe('eurovea');
    const eurovea = bestParkingNear(world, 'eurovea', 250)!;
    expect(e2.zone).toEqual(eurovea.ring);
  });

  it('returns null when the arena landmark is missing from the map', () => {
    // exercised indirectly above (both real sites always resolve); this just documents the contract
    // used by create(): bestParkingNear returns null for an unknown landmark (rules.test.ts covers it).
    expect(bestParkingNear(loadWorld(), 'not-a-landmark', 250)).toBeNull();
  });

  it('spawns 6 unlocked classic cars with the derby livery inside the ring, clear of each other and walls, at level 0', () => {
    const sim = makeSim(302);
    const dir = sim.rule<WorldEvents>('worldEvents')!;
    const ev = dir.start('derby')!;
    const ring = ev.entry().zone!;
    const cars = sim.vehicles.filter((v) => v.livery === LIVERY_DERBY);
    expect(cars.length).toBe(6);
    const radius = Math.hypot(SPECS.classic.length / 2, SPECS.classic.width / 2);
    for (const v of cars) {
      expect(v.kind).toBe('classic');
      expect(v.mission).toBe(true);
      expect(v.owner).toBe(0); // unlocked: nobody's in it, anyone can get in
      expect(v.driver).toBeNull();
      expect(pointInRings(v.x, v.y, [ring])).toBe(true);
      expect(sim.world.collideCircle(v.x, v.y, radius, 0)).toBeNull();
    }
    for (let i = 0; i < cars.length; i++)
      for (let j = i + 1; j < cars.length; j++) expect(dist(cars[i].x, cars[i].y, cars[j].x, cars[j].y)).toBeGreaterThanOrEqual(radius * 2);
    sim.step(0.1); // physics assigns the level on the first tick, as the spot search itself checked
    for (const v of cars) expect(v.level).toBe(0);
  });

  it('cancels with fewer than 2 cars in the arena when the announce ends', () => {
    const globals: GlobalEvent[] = [];
    const sim = new Sim(loadWorld(), { rng: new Rng(303), rules: 'server', caps: NO_NPCS, events: { ...nullEvents, global: (e) => globals.push(e) } });
    const dir = sim.rule<WorldEvents>('worldEvents')!;
    const ev = dir.start('derby')!;
    const arena = bestParkingNear(sim.world, 'aupark', 250)!;
    const a = sim.addPlayer({ nick: 'A', profile: profile(), kinematic: false, x: arena.cx, y: arena.cy });
    putInCar(sim, a, arena.cx, arena.cy); // exactly one car in the arena: fewer than 2
    toLive(sim);
    expect(dir.active.length).toBe(0);
    expect(globals.some((e) => e.k === 'eventEnd' && e.kind === 'derby' && e.how === 'cancelled')).toBe(true);
    expect(sim.vehicles.some((v) => v.livery === LIVERY_DERBY)).toBe(false); // retired
    expect((ev as unknown as { zones: Zones }).zones.inZone('derby', arena.cx, arena.cy)).toBe(false);
  });

  it('only the players driving inside the arena when it goes live become participants', () => {
    const sim = makeSim(304);
    const dir = sim.rule<WorldEvents>('worldEvents')!;
    const ev = dir.start('derby')!;
    const arena = bestParkingNear(sim.world, 'aupark', 250)!;
    const a = sim.addPlayer({ nick: 'A', profile: profile(), kinematic: false, x: arena.cx, y: arena.cy });
    putInCar(sim, a, arena.cx, arena.cy); // inside, driving: in
    const b = sim.addPlayer({ nick: 'B', profile: profile(), kinematic: false, x: arena.cx + 5, y: arena.cy });
    putInCar(sim, b, arena.cx + 5, arena.cy); // inside, driving: in
    const c = sim.addPlayer({ nick: 'C', profile: profile(), kinematic: false, x: arena.cx + 1000, y: arena.cy });
    putInCar(sim, c, arena.cx + 1000, arena.cy); // driving, but well outside: out
    const d = sim.addPlayer({ nick: 'D', profile: profile(), kinematic: false, x: arena.cx - 5, y: arena.cy }); // inside, on foot: out
    toLive(sim);
    expect(ev.entry().phase).toBe('live');
    expect(ev.entry().alive).toBe(2);
    const ids = (ev as unknown as { participants: { id: number }[] }).participants.map((p) => p.id).sort();
    expect(ids).toEqual([a.id, b.id].sort());
    expect(ids).not.toContain(c.id);
    expect(ids).not.toContain(d.id);
  });

  it('stores a participant\'s wanted level, zeroes it while they stay inside, and restores it on leaving', () => {
    const sim = makeSim(305);
    const dir = sim.rule<WorldEvents>('worldEvents')!;
    dir.start('derby')!;
    const arena = bestParkingNear(sim.world, 'aupark', 250)!;
    const a = sim.addPlayer({ nick: 'A', profile: profile(), kinematic: false, x: arena.cx, y: arena.cy });
    const carA = putInCar(sim, a, arena.cx, arena.cy);
    const b = sim.addPlayer({ nick: 'B', profile: profile(), kinematic: false, x: arena.cx + 5, y: arena.cy });
    putInCar(sim, b, arena.cx + 5, arena.cy);
    const c = sim.addPlayer({ nick: 'C', profile: profile(), kinematic: false, x: arena.cx - 5, y: arena.cy });
    putInCar(sim, c, arena.cx - 5, arena.cy);
    a.wanted = 3;
    toLive(sim);
    expect(a.wanted).toBe(0); // zeroed right away, the moment it goes live

    carA.x = arena.cx + 1000; // drive well outside
    carA.y = arena.cy;
    sim.step(1); // one poll tick is enough to notice
    expect(a.wanted).toBe(3); // restored on leaving, before the 3 s grace even matters
  });

  it('the most wanted target gets no amnesty inside the arena (no sitting out the escape countdown there)', () => {
    const sim = makeSim(309);
    const dir = sim.rule<WorldEvents>('worldEvents')!;
    dir.start('derby')!;
    const arena = bestParkingNear(sim.world, 'aupark', 250)!;
    const a = sim.addPlayer({ nick: 'A', profile: profile(), kinematic: false, x: arena.cx, y: arena.cy });
    putInCar(sim, a, arena.cx, arena.cy);
    const b = sim.addPlayer({ nick: 'B', profile: profile(), kinematic: false, x: arena.cx + 5, y: arena.cy });
    putInCar(sim, b, arena.cx + 5, arena.cy);
    sim.setWanted(a, 5);
    expect(dir.trigger('wanted', a)).not.toBeNull();
    for (let i = 0; i < 92; i++) {
      sim.setWanted(a, 5); // keep the chase on through the announce (no police here to keep it up)
      if (i === 88) b.wanted = 2; // just before it goes live at 90 s
      sim.step(1);
    }
    expect(dir.get('derby')!.entry().phase).toBe('live');
    expect(dir.get('wanted')?.entry().holder).toBe(a.id);
    expect(b.wanted).toBe(0); // everyone else inside still gets the amnesty
    expect(Math.ceil(a.wanted)).toBe(5); // the target keeps their stars
  });

  it('allowCrime is false for any player inside the live arena, and normal again outside it', () => {
    const sim = makeSim(306);
    const dir = sim.rule<WorldEvents>('worldEvents')!;
    dir.start('derby')!;
    const arena = bestParkingNear(sim.world, 'aupark', 250)!;
    const a = sim.addPlayer({ nick: 'A', profile: profile(), kinematic: false, x: arena.cx, y: arena.cy });
    putInCar(sim, a, arena.cx, arena.cy);
    const b = sim.addPlayer({ nick: 'B', profile: profile(), kinematic: false, x: arena.cx + 5, y: arena.cy });
    putInCar(sim, b, arena.cx + 5, arena.cy);
    // a bystander, never a participant (on foot throughout), who happens to be standing in the arena
    const c = sim.addPlayer({ nick: 'C', profile: profile(), kinematic: false, x: arena.cx - 5, y: arena.cy });
    toLive(sim);
    expect(c.wanted).toBe(0);
    sim.crime(c, 'killPed');
    expect(c.wanted).toBe(0); // suppressed: C is inside

    c.ped.x = arena.cx + 1000;
    c.ped.y = arena.cy;
    sim.step(1); // amnesty poll notices C left
    sim.crime(c, 'killPed');
    expect(c.wanted).toBeGreaterThan(0); // back to normal outside the arena
  });

  it('eliminates a participant whose car is wrecked or at/under 10% health, without ending the derby early', () => {
    const sim = makeSim(307);
    const dir = sim.rule<WorldEvents>('worldEvents')!;
    const ev = dir.start('derby')!;
    const arena = bestParkingNear(sim.world, 'aupark', 250)!;
    const mk = (nick: string, dx: number) => {
      const p = sim.addPlayer({ nick, profile: profile(), kinematic: false, x: arena.cx + dx, y: arena.cy });
      const car = putInCar(sim, p, arena.cx + dx, arena.cy);
      return { p, car };
    };
    const a = mk('A', 0), b = mk('B', 8), c = mk('C', -8), d = mk('D', 16);
    toLive(sim);
    expect(ev.entry().alive).toBe(4);

    a.car.health = HEALTH * 0.05; // well under 10%
    b.car.wrecked = true;
    sim.step(1);
    expect(ev.entry().alive).toBe(2);
    expect(dir.active.length).toBe(1); // still running: 2 left (c, d)
    expect(ev.entry().phase).toBe('live');
  });

  it('eliminates a participant who gets out of their car', () => {
    const sim = makeSim(308);
    const dir = sim.rule<WorldEvents>('worldEvents')!;
    const ev = dir.start('derby')!;
    const arena = bestParkingNear(sim.world, 'aupark', 250)!;
    const a = sim.addPlayer({ nick: 'A', profile: profile(), kinematic: false, x: arena.cx, y: arena.cy });
    putInCar(sim, a, arena.cx, arena.cy);
    const b = sim.addPlayer({ nick: 'B', profile: profile(), kinematic: false, x: arena.cx + 5, y: arena.cy });
    putInCar(sim, b, arena.cx + 5, arena.cy);
    const c = sim.addPlayer({ nick: 'C', profile: profile(), kinematic: false, x: arena.cx - 5, y: arena.cy });
    putInCar(sim, c, arena.cx - 5, arena.cy);
    toLive(sim);
    expect(ev.entry().alive).toBe(3);

    sim.exitVehicle(a);
    sim.step(1);
    expect(ev.entry().alive).toBe(2);
    expect(dir.active.length).toBe(1);
  });

  it('eliminates a participant whose car stays outside the arena for more than 3 s, not sooner', () => {
    const sim = makeSim(309);
    const dir = sim.rule<WorldEvents>('worldEvents')!;
    const ev = dir.start('derby')!;
    const arena = bestParkingNear(sim.world, 'aupark', 250)!;
    const a = sim.addPlayer({ nick: 'A', profile: profile(), kinematic: false, x: arena.cx, y: arena.cy });
    const carA = putInCar(sim, a, arena.cx, arena.cy);
    const b = sim.addPlayer({ nick: 'B', profile: profile(), kinematic: false, x: arena.cx + 5, y: arena.cy });
    putInCar(sim, b, arena.cx + 5, arena.cy);
    const c = sim.addPlayer({ nick: 'C', profile: profile(), kinematic: false, x: arena.cx - 5, y: arena.cy });
    putInCar(sim, c, arena.cx - 5, arena.cy);
    toLive(sim);

    carA.x = arena.cx + 1000;
    carA.y = arena.cy;
    sim.step(1); // outsideSince set here
    sim.step(1); // ~1 s outside
    expect(ev.entry().alive).toBe(3); // not eliminated yet
    sim.step(1); // ~2 s outside
    expect(ev.entry().alive).toBe(3);
    sim.step(1); // ~3 s outside: still not strictly over the limit
    sim.step(1); // > 3 s now
    expect(ev.entry().alive).toBe(2);
  });

  it('eliminates a participant who disconnects, and one who is removed outright', () => {
    const sim = makeSim(310);
    const dir = sim.rule<WorldEvents>('worldEvents')!;
    const ev = dir.start('derby')!;
    const arena = bestParkingNear(sim.world, 'aupark', 250)!;
    const a = sim.addPlayer({ nick: 'A', profile: profile(), kinematic: false, x: arena.cx, y: arena.cy });
    putInCar(sim, a, arena.cx, arena.cy);
    const b = sim.addPlayer({ nick: 'B', profile: profile(), kinematic: false, x: arena.cx + 5, y: arena.cy });
    putInCar(sim, b, arena.cx + 5, arena.cy);
    const c = sim.addPlayer({ nick: 'C', profile: profile(), kinematic: false, x: arena.cx - 5, y: arena.cy });
    putInCar(sim, c, arena.cx - 5, arena.cy);
    const d = sim.addPlayer({ nick: 'D', profile: profile(), kinematic: false, x: arena.cx, y: arena.cy + 5 });
    putInCar(sim, d, arena.cx, arena.cy + 5);
    toLive(sim);
    expect(ev.entry().alive).toBe(4);

    b.connected = false;
    sim.step(1); // the poll notices
    expect(ev.entry().alive).toBe(3);
    expect(dir.active.length).toBe(1);

    sim.removePlayer(c); // onRemove: immediate, no poll needed
    expect(ev.entry().alive).toBe(2);
    expect(dir.active.length).toBe(1);
  });

  it('the last car standing wins, paid 60/25/15 in reverse elimination order, with derbyResult and stats.derbyWins', () => {
    const globals: GlobalEvent[] = [];
    const sim = new Sim(loadWorld(), { rng: new Rng(311), rules: 'server', caps: NO_NPCS, events: { ...nullEvents, global: (e) => globals.push(e) } });
    const dir = sim.rule<WorldEvents>('worldEvents')!;
    const ev = dir.start('derby')!;
    const arena = bestParkingNear(sim.world, 'aupark', 250)!;
    const a = sim.addPlayer({ nick: 'Anna', profile: profile(), kinematic: false, x: arena.cx, y: arena.cy });
    const carA = putInCar(sim, a, arena.cx, arena.cy);
    const b = sim.addPlayer({ nick: 'Boris', profile: profile(), kinematic: false, x: arena.cx + 5, y: arena.cy });
    const carB = putInCar(sim, b, arena.cx + 5, arena.cy);
    const c = sim.addPlayer({ nick: 'Cyril', profile: profile(), kinematic: false, x: arena.cx - 5, y: arena.cy });
    putInCar(sim, c, arena.cx - 5, arena.cy);
    // a bystander on foot, never a participant, still inside when it all ends
    const d = sim.addPlayer({ nick: 'Dana', profile: profile(), kinematic: false, x: arena.cx, y: arena.cy - 5 });
    d.wanted = 2;
    toLive(sim);
    expect(ev.entry().alive).toBe(3);
    expect(ev.entry().pot).toBe(900); // min(2400, 300*3)
    expect(d.wanted).toBe(0); // bystander amnesty too

    carB.wrecked = true; // Boris eliminated first
    sim.step(1);
    expect(ev.entry().alive).toBe(2);
    carA.health = 1; // Anna eliminated second (more recently than Boris)
    sim.step(1);

    expect(dir.active.length).toBe(0); // Cyril is the sole survivor: the round ends right away
    expect(c.profile.money).toBe(540); // 60% of 900
    expect(a.profile.money).toBe(225); // 25%: eliminated more recently than Boris
    expect(b.profile.money).toBe(135); // 15%
    expect(c.profile.stats?.derbyWins).toBe(1);
    expect(a.profile.stats?.derbyWins ?? 0).toBe(0);
    const result = globals.find((e) => e.k === 'derbyResult') as Extract<GlobalEvent, { k: 'derbyResult' }> | undefined;
    expect(result).toBeTruthy();
    expect(result!.winners).toEqual(['Cyril', 'Anna', 'Boris']);
    expect(globals.some((e) => e.k === 'eventEnd' && e.kind === 'derby')).toBe(false); // derbyResult only, never both
    expect(d.wanted).toBe(2); // restored at the very end, having never left the arena
    expect(sim.vehicles.some((v) => v.livery === LIVERY_DERBY)).toBe(false); // cars retired
    expect((ev as unknown as { zones: Zones }).zones.inZone('derby', arena.cx, arena.cy)).toBe(false); // zone gone
  });

  it('at the timeout, ranks every survivor by health % and pays them the same way', () => {
    const sim = makeSim(312);
    const dir = sim.rule<WorldEvents>('worldEvents')!;
    const ev = dir.start('derby')!;
    const arena = bestParkingNear(sim.world, 'aupark', 250)!;
    const a = sim.addPlayer({ nick: 'A', profile: profile(), kinematic: false, x: arena.cx, y: arena.cy });
    const carA = putInCar(sim, a, arena.cx, arena.cy);
    const b = sim.addPlayer({ nick: 'B', profile: profile(), kinematic: false, x: arena.cx + 5, y: arena.cy });
    const carB = putInCar(sim, b, arena.cx + 5, arena.cy);
    const c = sim.addPlayer({ nick: 'C', profile: profile(), kinematic: false, x: arena.cx - 5, y: arena.cy });
    const carC = putInCar(sim, c, arena.cx - 5, arena.cy);
    toLive(sim);
    carA.health = HEALTH * 0.8; // well above the 10% elimination line throughout
    carB.health = HEALTH * 0.5;
    carC.health = HEALTH * 0.2;

    for (let i = 0; i < 182; i++) sim.step(1); // the 3-minute live phase runs out
    expect(dir.active.length).toBe(0);
    expect(ev.entry).toBeTruthy(); // the instance itself is still readable even once retired
    expect(a.profile.money).toBe(540);
    expect(b.profile.money).toBe(225);
    expect(c.profile.money).toBe(135);
    expect(a.profile.stats?.derbyWins).toBe(1);
  });

  it('cleans up (restores wanted, drops the zone, retires the cars) in stop() too', () => {
    const sim = makeSim(313);
    const dir = sim.rule<WorldEvents>('worldEvents')!;
    const ev = dir.start('derby')!;
    const arena = bestParkingNear(sim.world, 'aupark', 250)!;
    const a = sim.addPlayer({ nick: 'A', profile: profile(), kinematic: false, x: arena.cx, y: arena.cy });
    a.wanted = 4;
    const cars = sim.vehicles.filter((v) => v.livery === LIVERY_DERBY);
    expect(cars.length).toBe(6);

    ev.stop('shutdown'); // mid-announce: nobody's a participant yet, but the cars/zone still need cleanup
    for (const v of cars) {
      expect(v.mission).toBe(false);
      expect(v.livery).toBe(LIVERY_NONE);
    }
    expect((ev as unknown as { zones: Zones }).zones.inZone('derby', arena.cx, arena.cy)).toBe(false);
  });
});
