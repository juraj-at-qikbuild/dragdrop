// The SimRule hook plumbing (Sim.ts, Combat.ts), the downed-player core, and the three shared
// helpers (World.places, Zones, placeName) that the social-events rules build on.
// Plan: docs/plans/social-events.md
import { describe, expect, it } from 'vitest';
import { DOWNED_BLEED, Sim } from '../../src/shared/sim/Sim';
import { HitKind } from '../../src/shared/sim/Combat';
import { Rng } from '../../src/shared/util/Rng';
import { Vehicle } from '../../src/shared/entities/Vehicle';
import { bestParkingNear, Zones } from '../../src/shared/sim/rules/Zones';
import { placeName } from '../../src/shared/sim/rules/placeName';
import { loadWorld } from './helpers';

const profile = () => ({ money: 0, done: [], found: [], cumils: [] });
/** an all-zero cap set: no NPC ever spawns, so a long-running test stays fully deterministic */
const NO_NPCS = { traffic: 0, parked: 0, peds: 0, trams: 0, police: 0, helis: 0, roadblocks: 0 };

describe('SimRule hooks', () => {
  it('allowPvp blocks damage and car-jacking between two players', () => {
    const sim = new Sim(loadWorld(), { rng: new Rng(101) });
    const a = sim.addPlayer({ nick: 'A', profile: profile(), kinematic: true });
    const b = sim.addPlayer({ nick: 'B', profile: profile(), kinematic: true });
    sim.rules.push({ id: 'noPvp', allowPvp: () => false });
    sim.hurtPlayer(b, 100, a.ped.x, a.ped.y, a.id);
    expect(b.ped.health).toBe(100);
    expect(a.wanted).toBe(0);
    const car = sim.addVehicle(new Vehicle('sedan', b.ped.x + 1, b.ped.y, 0, '#fff'));
    expect(sim.enterVehicle(b, car, 10)).toBe(true);
    expect(sim.enterVehicle(a, car, 10)).toBe(false);
    expect(car.owner).toBe(b.id);
    expect(car.driver).toBe(b.ped);
  });

  it('allowCrime false for a target keeps stars at 0', () => {
    const sim = new Sim(loadWorld(), { rng: new Rng(102) });
    const a = sim.addPlayer({ nick: 'A', profile: profile(), kinematic: true });
    const b = sim.addPlayer({ nick: 'B', profile: profile(), kinematic: true });
    sim.rules.push({ id: 'noCrime', allowCrime: (_p, _kind, target) => target !== b });
    sim.hurtPlayer(b, 100, a.ped.x, a.ped.y, a.id);
    expect(a.wanted).toBe(0);
    expect(b.ped.health).toBeLessThan(100); // the rule only silences the crime, not the damage
  });

  it('onEnter and onExit fire for a normal enter/exit', () => {
    const sim = new Sim(loadWorld(), { rng: new Rng(103) });
    const p = sim.addPlayer({ nick: 'A', profile: profile(), kinematic: true });
    const log: string[] = [];
    sim.rules.push({ id: 'watch', onEnter: () => log.push('enter'), onExit: () => log.push('exit') });
    const car = sim.addVehicle(new Vehicle('sedan', p.ped.x, p.ped.y, 0, '#fff'));
    expect(sim.enterVehicle(p, car)).toBe(true);
    expect(log).toEqual(['enter']);
    sim.exitVehicle(p);
    expect(log).toEqual(['enter', 'exit']);
  });

  it('onAdd and onRemove fire as players join and leave', () => {
    const sim = new Sim(loadWorld(), { rng: new Rng(104) });
    const log: string[] = [];
    sim.rules.push({ id: 'watch', onAdd: (p) => log.push('add:' + p.nick), onRemove: (p) => log.push('remove:' + p.nick) });
    const p = sim.addPlayer({ nick: 'A', profile: profile(), kinematic: true });
    expect(log).toEqual(['add:A']);
    sim.removePlayer(p);
    expect(log).toEqual(['add:A', 'remove:A']);
  });

  it('onPickup fires for a cash pickup', () => {
    const sim = new Sim(loadWorld(), { rng: new Rng(105) });
    const p = sim.addPlayer({ nick: 'A', profile: profile(), kinematic: false });
    const picked: { kind: string; amount: number }[] = [];
    sim.rules.push({ id: 'watch', onPickup: (_p, pk) => picked.push({ kind: pk.kind, amount: pk.amount }) });
    sim.dropCash(p.ped.x, p.ped.y, 50);
    sim.step(0.05);
    expect(picked).toEqual([{ kind: 'cash', amount: 50 }]);
  });

  it('onVehicleHit fires with the pellet hit point when a shot hits a car', () => {
    const sim = new Sim(loadWorld(), { rng: new Rng(106) });
    const car = sim.addVehicle(new Vehicle('sedan', 0, 0, 0, '#fff'));
    const hits: { dmg: number; pid: number; hx: number; hy: number }[] = [];
    sim.rules.push({ id: 'watch', onVehicleHit: (_v, dmg, pid, hx, hy) => hits.push({ dmg, pid, hx, hy }) });
    sim.combat.applyShot(
      { id: 0, x: -2, y: 0, level: 0, vehicle: null },
      7,
      { w: 'pistol', ox: -1.5, oy: 0, a: 0, lvl: 0, pellets: [{ a: 0, kind: HitKind.Car, hit: car.id, hx: 1.23, hy: 4.56 }] },
    );
    expect(hits).toEqual([{ dmg: 55 * 0.35, pid: 7, hx: 1.23, hy: 4.56 }]);
  });
});

describe('downed core (SimOptions.downed)', () => {
  it('downs a player on lethal damage, with the same PvP credit a kill gives, then revive() stands them up', () => {
    const sim = new Sim(loadWorld(), { rng: new Rng(110), downed: true });
    const a = sim.addPlayer({ nick: 'A', profile: profile(), kinematic: true });
    const b = sim.addPlayer({ nick: 'B', profile: profile(), kinematic: true });
    const states: [string, string, string | undefined][] = [];
    const kills: [string, string][] = [];
    sim.rules.push({
      id: 'watch',
      onState: (p, from, to, by) => states.push([from, to, by?.nick]),
      onKill: (victim, killer) => kills.push([victim.nick, killer.nick]),
    });
    sim.hurtPlayer(b, 1000, a.ped.x, a.ped.y, a.id);
    expect(b.state).toBe('downed');
    expect(b.ped.downed).toBe(true);
    expect(b.ped.health).toBe(0);
    expect(b.ped.vehicle).toBeNull();
    expect(a.wanted).toBeGreaterThanOrEqual(2); // killPlayer stars, exactly as an outright kill gives today
    expect(states).toEqual([['play', 'downed', 'A']]);
    expect(kills).toEqual([['B', 'A']]);

    sim.revive(b, a, 40);
    expect(b.state).toBe('play');
    expect(b.ped.health).toBe(40);
    expect(b.ped.downed).toBe(false);
    expect(states[1]).toEqual(['downed', 'play', 'A']);
  });

  it('a second hit finishes off a downed player, with no second kill credit', () => {
    const sim = new Sim(loadWorld(), { rng: new Rng(111), downed: true });
    const a = sim.addPlayer({ nick: 'A', profile: profile(), kinematic: true });
    const b = sim.addPlayer({ nick: 'B', profile: profile(), kinematic: true });
    let kills = 0;
    sim.rules.push({ id: 'watch', onKill: () => kills++ });
    sim.hurtPlayer(b, 1000, a.ped.x, a.ped.y, a.id);
    expect(b.state).toBe('downed');
    expect(kills).toBe(1);
    sim.hurtPlayer(b, 40, a.ped.x, a.ped.y, a.id);
    expect(b.state).toBe('wasted');
    expect(b.stateTimer).toBe(4);
    expect(kills).toBe(1);
  });

  it('a downed player bleeds out (downed → wasted), then respawns at a hospital with ped.downed cleared', () => {
    const sim = new Sim(loadWorld(), { rng: new Rng(112), downed: true, caps: NO_NPCS });
    const p = sim.addPlayer({ nick: 'A', profile: { ...profile(), money: 500 }, kinematic: false });
    const seen: string[] = [];
    sim.rules.push({ id: 'spy', onState: (_q, from, to) => seen.push(`${from}>${to}`) });
    sim.down(p);
    expect(p.state).toBe('downed');
    expect(p.stateTimer).toBe(DOWNED_BLEED);
    for (let t = 0; t < DOWNED_BLEED + 0.5; t += 0.1) sim.step(0.1);
    expect(p.state).toBe('wasted');
    for (let t = 0; t < 4.5; t += 0.1) sim.step(0.1);
    expect(seen).toEqual(['play>downed', 'downed>wasted', 'wasted>play']);
    expect(p.state).toBe('play');
    expect(p.ped.downed).toBe(false);
    expect(p.ped.health).toBe(100);
  });

  it('with downed off, lethal damage still goes straight to wasted (unchanged behaviour)', () => {
    const sim = new Sim(loadWorld(), { rng: new Rng(113) });
    const a = sim.addPlayer({ nick: 'A', profile: profile(), kinematic: true });
    const b = sim.addPlayer({ nick: 'B', profile: profile(), kinematic: true });
    sim.hurtPlayer(b, 1000, a.ped.x, a.ped.y, a.id);
    expect(b.state).toBe('wasted');
    expect(b.ped.downed).toBe(false);
  });
});

describe('World.places', () => {
  it('returns places of a kind, cached, and [] for a kind the map has none of', () => {
    const world = loadWorld();
    const banks = world.places('bank');
    expect(banks.length).toBeGreaterThan(0);
    expect(banks.every((p) => p.k === 'bank')).toBe(true);
    expect(world.places('bank')).toBe(banks); // same array back: cached per kind
    expect(world.places('doesNotExist')).toEqual([]);
  });
});

describe('Zones', () => {
  it('zoneAt and inZone test membership by name', () => {
    const zones = new Zones();
    zones.add('arena', [[0, 0, 10, 0, 10, 10, 0, 10]], 'derby');
    expect(zones.zoneAt(5, 5)?.name).toBe('arena');
    expect(zones.zoneAt(5, 5)?.kind).toBe('derby');
    expect(zones.zoneAt(50, 50)).toBeNull();
    expect(zones.inZone('arena', 5, 5)).toBe(true);
    expect(zones.inZone('arena', 50, 50)).toBe(false);
    expect(zones.inZone('nope', 5, 5)).toBe(false);
    zones.remove('arena');
    expect(zones.zoneAt(5, 5)).toBeNull();
  });

  it('bestParkingNear finds a lot for aupark and eurovea within 250 m', () => {
    const world = loadWorld();
    const aupark = bestParkingNear(world, 'aupark', 250);
    const eurovea = bestParkingNear(world, 'eurovea', 250);
    expect(aupark).not.toBeNull();
    expect(eurovea).not.toBeNull();
    expect(aupark!.area).toBeGreaterThan(0);
    const l = world.landmark('aupark');
    expect(Math.hypot(aupark!.cx - l.x, aupark!.cy - l.y)).toBeLessThanOrEqual(250);
    expect(bestParkingNear(world, 'not-a-landmark', 250)).toBeNull();
  });
});

describe('placeName', () => {
  it('names the landmark table near Most SNP and Eurovea, and a street elsewhere', () => {
    const world = loadWorld();
    const snp = world.landmark('snp');
    expect(placeName(world, snp.x, snp.y)).toBe('na Moste SNP');
    const eurovea = world.landmark('eurovea');
    expect(placeName(world, eurovea.x, eurovea.y)).toBe('pri Eurovei');
    // Vansovej, out in Karlova Ves: far from every landmark in the table, but a named street
    expect(placeName(world, -1211.3, -777.5)).toBe('na ulici Vansovej');
  });
});
