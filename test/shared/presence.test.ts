// Away and the shield (src/shared/sim/rules/Presence.ts), against the real map: a player in the pause
// menu (or dropped) is away; after a few seconds, and only when they're not in trouble, nothing can
// hurt, arrest or carjack them, and stepping away is never a way out of a race, the derby, the most
// wanted chase or the Kofolka van.
// Plan: docs/plans/pause-resume.md
import { describe, expect, it } from 'vitest';
import { Sim } from '../../src/shared/sim/Sim';
import { Rng } from '../../src/shared/util/Rng';
import { LIVERY_KOFOLKA, Vehicle } from '../../src/shared/entities/Vehicle';
import { Ped } from '../../src/shared/entities/Ped';
import { nullEvents, type PrivateEvent } from '../../src/shared/sim/events';
import type { WorldEvents } from '../../src/shared/sim/rules/WorldEvents';
import type { Race } from '../../src/shared/sim/rules/Race';
import { PVP_COOLDOWN_S, SHIELD_ARM_S, type Presence } from '../../src/shared/sim/rules/Presence';
import type { SimRule } from '../../src/shared/sim/rules/SimRule';
import { bestParkingNear } from '../../src/shared/sim/rules/Zones';
import { loadWorld } from './helpers';

/** every landmark pre-"found", so no discovery reward lands in the middle of a money assertion */
const allFound = () => [...loadWorld().landmarks.values()].map((l) => l.id);
const profile = (money = 1000) => ({ money, done: [], found: allFound(), cumils: [] });
/** no NPCs: nothing wanders in to change the outcome */
const NO_NPCS = { traffic: 0, parked: 0, peds: 0, trams: 0, police: 0, helis: 0, roadblocks: 0 };
/** a car-graph node near Hlavné námestie that a race challenge reliably finds a route from (race.test.ts) */
const MAIN = [-247.1, -357.3] as const;

function setup(seed: number) {
  const priv: [number, PrivateEvent][] = [];
  const sim = new Sim(loadWorld(), {
    rng: new Rng(seed), downed: true, caps: NO_NPCS, rules: 'server',
    events: { ...nullEvents, toPlayer: (pid, e) => priv.push([pid, e]) },
  });
  const presence = sim.rule<Presence>('presence')!;
  const dir = sim.rule<WorldEvents>('worldEvents')!;
  const run = (seconds: number) => {
    for (let t = 0; t < seconds - 1e-9; t += 0.05) sim.step(0.05);
  };
  const shieldEvents = (pid: number) => priv.filter(([p, e]) => p === pid && e.k === 'shield').map(([, e]) => (e as Extract<PrivateEvent, { k: 'shield' }>).on);
  return { sim, priv, presence, dir, run, shieldEvents };
}

/** a kinematic player (as on the server) driving a sedan at (x, y) */
function driver(sim: Sim, nick: string, x: number, y: number) {
  const p = sim.addPlayer({ nick, profile: profile(), kinematic: true, x, y });
  const car = sim.addVehicle(new Vehicle('sedan', x, y, 0, '#fff'));
  expect(sim.enterVehicle(p, car)).toBe(true);
  return { p, car };
}

describe('Presence: the shield', () => {
  it('arms after a few seconds away, tells the player, and then nothing lands (and it is no crime)', () => {
    const { sim, presence, run, shieldEvents } = setup(801);
    const a = sim.addPlayer({ nick: 'A', profile: profile(), kinematic: true });
    const b = sim.addPlayer({ nick: 'B', profile: profile(), kinematic: true });
    presence.setAway(a, true);
    run(SHIELD_ARM_S - 0.5);
    expect(a.shielded).toBe(false); // a quick look at the menu isn't cover
    run(0.6);
    expect(a.shielded).toBe(true);
    expect(shieldEvents(a.id)).toEqual([true]);

    sim.hurtPlayer(a, 50, a.ped.x, a.ped.y, b.id);
    expect(a.ped.health).toBe(100);
    expect(b.wanted).toBe(0); // hitting them wasn't a crime either
    sim.hurtPlayer(a, 500, a.ped.x, a.ped.y, 0); // nor anything the city throws at them
    expect(a.state).toBe('play');
  });

  it('drops at once when they resume, and when they get a star', () => {
    const { sim, presence, run, shieldEvents } = setup(802);
    const a = sim.addPlayer({ nick: 'A', profile: profile(), kinematic: true });
    presence.setAway(a, true);
    run(SHIELD_ARM_S + 0.2);
    expect(a.shielded).toBe(true);
    presence.setAway(a, false);
    expect(a.shielded).toBe(false); // no waiting for the next step
    expect(shieldEvents(a.id)).toEqual([true, false]);

    presence.setAway(a, true);
    run(SHIELD_ARM_S + 0.2);
    expect(a.shielded).toBe(true);
    sim.setWanted(a, 1); // say a witness's call went through
    sim.step(0.05);
    expect(a.shielded).toBe(false);
  });

  it('never arms while wanted, downed or in a burning car', () => {
    const { sim, presence, run } = setup(803);
    const wanted = sim.addPlayer({ nick: 'W', profile: profile(), kinematic: true });
    sim.setWanted(wanted, 2);
    const downed = sim.addPlayer({ nick: 'D', profile: profile(), kinematic: true });
    sim.down(downed);
    const { p: burning, car } = driver(sim, 'B', ...MAIN);
    car.fire = 3; // on a player's (kinematic) car the fuse is theirs to run: it stays lit here
    for (const p of [wanted, downed, burning]) presence.setAway(p, true);
    run(SHIELD_ARM_S + 2);
    expect(wanted.shielded).toBe(false);
    expect(downed.shielded).toBe(false);
    expect(burning.shielded).toBe(false);
  });

  it('waits out a fight: no shield for either player within the PvP cooldown', () => {
    const { sim, presence, run } = setup(804);
    const a = sim.addPlayer({ nick: 'A', profile: profile(), kinematic: true });
    const b = sim.addPlayer({ nick: 'B', profile: profile(), kinematic: true });
    sim.hurtPlayer(a, 10, a.ped.x, a.ped.y, b.id);
    sim.setWanted(b, 0); // leave the hit's stars out of it: this is about the fight itself
    presence.setAway(a, true);
    presence.setAway(b, true);
    run(SHIELD_ARM_S + 1);
    expect(a.shielded).toBe(false);
    expect(b.shielded).toBe(false);
    run(PVP_COOLDOWN_S - SHIELD_ARM_S);
    expect(a.shielded).toBe(true);
    expect(b.shielded).toBe(true);
  });

  it('a shielded driver: no damage to their car, no carjacking, no arrest; civilians leave them be', () => {
    const { sim, priv, presence, run } = setup(805);
    const { p: a, car } = driver(sim, 'A', ...MAIN);
    const b = sim.addPlayer({ nick: 'B', profile: profile(), kinematic: true, x: car.x + 3, y: car.y });
    presence.setAway(a, true);
    run(SHIELD_ARM_S + 0.2);
    expect(a.shielded).toBe(true);

    priv.length = 0;
    sim.damageVehicle(car, 500, b.id);
    expect(priv.some(([pid, e]) => pid === a.id && e.k === 'vehDamage')).toBe(false); // their client is never told to take it
    expect(car.lastDamagedBy).toBe(0); // and nobody gets credit for a wreck that won't happen

    b.ped.level = car.level;
    expect(sim.enterVehicle(b, car, 2)).toBe(false);
    expect(car.owner).toBe(a.id);

    sim.bust(a);
    expect(a.state).toBe('play');

    // a civilian who'd normally square up to a player (one in seven do) won't pick a fight with them
    let civ: Ped | null = null;
    for (let seed = 1; seed < 5000 && !civ; seed++) {
      const q = new Ped('civ', a.ped.x + 1, a.ped.y, seed);
      if (q.fighter) civ = q;
    }
    expect(civ).not.toBeNull();
    expect(sim.crowd.provoke(civ!, a)).toBe(false);
    expect(sim.crowd.provoke(civ!, b)).toBe(true); // B isn't shielded
  });

  it('any rule can veto it (SimRule.allowShield)', () => {
    const { sim, presence, run } = setup(806);
    const a = sim.addPlayer({ nick: 'A', profile: profile(), kinematic: true });
    let allow = false;
    sim.rules.push({ id: 'test', allowShield: () => allow } satisfies SimRule);
    presence.setAway(a, true);
    run(SHIELD_ARM_S + 0.5);
    expect(a.shielded).toBe(false);
    allow = true;
    sim.step(0.05);
    expect(a.shielded).toBe(true);
  });

  it('no shield while racing, from the countdown on', () => {
    const { sim, presence, run } = setup(807);
    const race = sim.rule<Race>('race')!;
    const { p: a, car: ca } = driver(sim, 'A', ...MAIN);
    const { p: b } = driver(sim, 'B', ca.x + 5, ca.y);
    expect(race.challenge(a, b)).toBeNull();
    race.answer(b, a.id, true);
    presence.setAway(a, true);
    run(SHIELD_ARM_S + 1);
    expect(a.shielded).toBe(false);
  });

  it('no shield for the most wanted target, even once they are below 5★', () => {
    const { sim, dir, presence, run } = setup(808);
    const a = sim.addPlayer({ nick: 'A', profile: profile(), kinematic: true });
    sim.addPlayer({ nick: 'B', profile: profile(), kinematic: true });
    sim.setWanted(a, 5);
    expect(dir.trigger('wanted', a)).not.toBeNull();
    sim.setWanted(a, 0); // stars gone, but the chase runs until they've stayed low for a minute
    presence.setAway(a, true);
    run(SHIELD_ARM_S + 1);
    expect(dir.get('wanted')).toBeDefined();
    expect(a.shielded).toBe(false);
  });

  it("no shield for the Kofolka van's driver (it pays by the second)", () => {
    const { sim, dir, presence, run } = setup(809);
    const main = sim.world.landmark('main');
    // the van is placed relative to the players already in the city (events.test.ts does the same)
    const a = sim.addPlayer({ nick: 'A', profile: profile(), kinematic: true, x: main.x, y: main.y });
    sim.addPlayer({ nick: 'B', profile: profile(), kinematic: true, x: main.x + 40, y: main.y });
    expect(dir.start('kofolka')).not.toBeNull();
    const van = sim.vehicles.find((v) => v.livery === LIVERY_KOFOLKA)!;
    a.ped.x = van.x;
    a.ped.y = van.y;
    a.ped.level = van.level;
    expect(sim.enterVehicle(a, van, 10)).toBe(true);
    presence.setAway(a, true);
    run(SHIELD_ARM_S + 1);
    expect(a.shielded).toBe(false);
  });

  it('no shield in the live derby arena', () => {
    const { sim, dir, presence, run } = setup(810);
    expect(dir.start('derby')).not.toBeNull();
    const arena = bestParkingNear(sim.world, 'aupark', 250)!;
    const inCar = (nick: string, dx: number) => {
      const p = sim.addPlayer({ nick, profile: profile(), kinematic: false, x: arena.cx + dx, y: arena.cy });
      const car = sim.addVehicle(new Vehicle('classic', arena.cx + dx, arena.cy, 0, '#fff'));
      expect(sim.enterVehicle(p, car, 10)).toBe(true);
      return p;
    };
    const a = inCar('A', 0);
    inCar('B', 6);
    for (let i = 0; i < 92; i++) sim.step(1); // past the announce: live, with A and B in the fight
    expect(dir.get('derby')?.phase).toBe('live');
    presence.setAway(a, true);
    run(SHIELD_ARM_S + 1);
    expect(a.shielded).toBe(false);
  });

  it('an away player still observes (the city lives on around the menu) but no longer counts as taking part', () => {
    const { sim, presence, dir } = setup(811);
    const a = sim.addPlayer({ nick: 'A', profile: profile(), kinematic: true });
    sim.addPlayer({ nick: 'B', profile: profile(), kinematic: true });
    expect(dir.playerCount()).toBe(2);
    presence.setAway(a, true);
    expect(a.observing).toBe(true);
    expect(a.active).toBe(false);
    expect(dir.playerCount()).toBe(1);
  });
});

describe('Presence: a returning player’s car', () => {
  it('is theirs alone until the hold runs out (Sim.reservedFromOthers)', () => {
    const { sim } = setup(812);
    const a = sim.addPlayer({ nick: 'A', profile: profile(), kinematic: true, x: MAIN[0], y: MAIN[1] });
    const b = sim.addPlayer({ nick: 'B', profile: profile(), kinematic: true, x: MAIN[0], y: MAIN[1] });
    const car = sim.addVehicle(new Vehicle('sedan', MAIN[0], MAIN[1], 0, '#fff'));
    car.parked = true;
    car.reservedFor = a.id;
    car.reservedUntil = sim.time + 300;
    expect(sim.enterVehicle(b, car, 2)).toBe(false);
    expect(sim.enterVehicle(a, car, 2)).toBe(true);
    expect(car.reservedFor).toBe(0); // taken back: an ordinary car again

    const other = sim.addVehicle(new Vehicle('sedan', MAIN[0] + 3, MAIN[1], 0, '#fff'));
    other.reservedFor = a.id;
    other.reservedUntil = sim.time - 1; // the hold is over
    expect(sim.enterVehicle(b, other, 4)).toBe(true);
  });
});
