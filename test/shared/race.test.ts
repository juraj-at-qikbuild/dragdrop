// The Race rule (src/shared/sim/rules/Race.ts): pull up next to another player and hold the horn to
// challenge them to a race to a landmark 1-2 km away by road, with money staked on the outcome.
// Plan: docs/plans/social-events.md ("Závod?")
import { describe, expect, it } from 'vitest';
import { Sim } from '../../src/shared/sim/Sim';
import { Rng } from '../../src/shared/util/Rng';
import { Vehicle } from '../../src/shared/entities/Vehicle';
import { nullEvents, type GlobalEvent, type PrivateEvent } from '../../src/shared/sim/events';
import { loadWorld } from './helpers';
import { Race } from '../../src/shared/sim/rules/Race';

/** every landmark pre-"found": players spawn near Hlavné námestie (a landmark), and the unrelated
 *  €100 discovery reward would otherwise land on top of this file's own money assertions */
const allFound = () => [...loadWorld().landmarks.values()].map((l) => l.id);
const profile = (money = 1000) => ({ money, done: [], found: allFound(), cumils: [] });
/** an all-zero cap set: no NPC ever spawns, so a race scenario stays fully deterministic */
const NO_NPCS = { traffic: 0, parked: 0, peds: 0, trams: 0, police: 0, helis: 0, roadblocks: 0 };

/** a real-map Sim with the server rules on, capturing every private and global event it sends */
function setup(seed: number) {
  const priv: [number, PrivateEvent][] = [];
  const globals: GlobalEvent[] = [];
  const sim = new Sim(loadWorld(), {
    rng: new Rng(seed), caps: NO_NPCS, rules: 'server',
    events: { ...nullEvents, toPlayer: (pid, e) => priv.push([pid, e]), global: (e) => globals.push(e) },
  });
  const rule = sim.rule<Race>('race')!;
  return { sim, priv, globals, rule };
}

/** the most recent private event of kind `k` sent to `pid` (challenge/race states keep getting
 *  refreshed, so later assertions want the latest one, not the first) */
function lastEvent<K extends PrivateEvent['k']>(priv: [number, PrivateEvent][], pid: number, k: K) {
  for (let i = priv.length - 1; i >= 0; i--) {
    const [p, e] = priv[i];
    if (p === pid && e.k === k) return e as Extract<PrivateEvent, { k: K }>;
  }
  return undefined;
}

/** a kinematic player already driving a car at exactly (x, y) (kinematic cars aren't integrated by
 *  the physics step, so a test can move them by hand and expect them to stay put) */
function driver(sim: Sim, nick: string, x: number, y: number, money = 1000) {
  const p = sim.addPlayer({ nick, profile: profile(money), kinematic: true, x, y });
  const car = sim.addVehicle(new Vehicle('sedan', x, y, 0, '#fff'));
  expect(sim.enterVehicle(p, car)).toBe(true);
  return { p, car };
}

// A car-graph node near Hlavné námestie: a challenge from here reliably finds a landmark route in
// the 1000-2000 m primary band (empirically checked against the real map — see "Race: destination").
const MAIN = [-247.1, -357.3] as const;

describe('Race: challenge validation', () => {
  it('accepts two nearby drivers: the target gets a challenge state, the challenger a msg', () => {
    const { sim, priv, rule } = setup(501);
    const { p: a, car: ca } = driver(sim, 'A', ...MAIN);
    const { p: b } = driver(sim, 'B', ca.x + 5, ca.y);
    expect(rule.challenge(a, b)).toBeNull();
    const s = lastEvent(priv, b.id, 'challenge')!.s!;
    expect(s.from).toBe(a.id);
    expect(s.nick).toBe('A');
    expect(s.left).toBe(15);
    expect(priv.some(([pid, e]) => pid === a.id && e.k === 'msg')).toBe(true);
    expect(priv.some(([pid, e]) => pid === a.id && e.k === 'challenge')).toBe(false);
  });

  it('rejects when one of them is not "play"', () => {
    const { sim, rule } = setup(502);
    const { p: a, car: ca } = driver(sim, 'A', ...MAIN);
    const { p: b } = driver(sim, 'B', ca.x + 5, ca.y);
    b.state = 'wasted';
    expect(rule.challenge(a, b)).toBe('Obaja musíte byť v hre.');
  });

  it('rejects when one of them is on foot', () => {
    const { sim, rule } = setup(503);
    const { p: a, car: ca } = driver(sim, 'A', ...MAIN);
    const { p: b } = driver(sim, 'B', ca.x + 5, ca.y);
    sim.exitVehicle(b);
    expect(rule.challenge(a, b)).toBe('Obaja musíte sedieť za volantom.');
  });

  it('rejects when they are more than 8 m apart', () => {
    const { sim, rule } = setup(504);
    const { p: a, car: ca } = driver(sim, 'A', ...MAIN);
    const { p: b } = driver(sim, 'B', ca.x + 20, ca.y);
    expect(rule.challenge(a, b)).toBe('Ste príliš ďaleko od seba.');
  });

  it('rejects a challenge while one of them is already racing', () => {
    const { sim, rule } = setup(505);
    const { p: a, car: ca } = driver(sim, 'A', ...MAIN);
    const { p: b } = driver(sim, 'B', ca.x + 5, ca.y);
    const { p: c } = driver(sim, 'C', ca.x + 5, ca.y + 5);
    expect(rule.challenge(a, c)).toBeNull();
    rule.answer(c, a.id, true);
    expect(rule.challenge(a, b)).toBe('Niekto z vás už závodí.');
  });

  it('rejects a second challenge while one already has a pending one', () => {
    const { sim, rule } = setup(506);
    const { p: a, car: ca } = driver(sim, 'A', ...MAIN);
    const { p: b } = driver(sim, 'B', ca.x + 5, ca.y);
    const { p: c } = driver(sim, 'C', ca.x + 5, ca.y + 5);
    expect(rule.challenge(a, c)).toBeNull();
    expect(rule.challenge(a, b)).toBe('Niekto z vás už má nevybavenú výzvu.');
  });

  it('a decline clears the challenge state for the target and tells the challenger', () => {
    const { sim, priv, rule } = setup(508);
    const { p: a, car: ca } = driver(sim, 'A', ...MAIN);
    const { p: b } = driver(sim, 'B', ca.x + 5, ca.y);
    expect(rule.challenge(a, b)).toBeNull();
    rule.answer(b, a.id, false);
    expect(lastEvent(priv, b.id, 'challenge')!.s).toBeNull();
    expect(priv.some(([pid, e]) => pid === a.id && e.k === 'msg')).toBe(true);
  });

  it('fails with "Nenašiel sa vhodný cieľ" far from any suitable landmark route', () => {
    const { sim, rule } = setup(507);
    // empirically confirmed: near the SW corner of the map, no landmark clears either route window
    const { p: a, car: ca } = driver(sim, 'A', -1611.2, 1102.7);
    const { p: b } = driver(sim, 'B', ca.x + 5, ca.y);
    expect(rule.challenge(a, b)).toBe('Nenašiel sa vhodný cieľ.');
  });
});

describe('Race: destination', () => {
  it('picks a landmark whose by-road route is 1000-2000 m, at a few different spots', () => {
    const spots: [string, number, number][] = [
      ['Hlavné námestie', -247.1, -357.3],
      ['Nivy Tower', 1284.9, -549.4],
      ['Slavín', -905.5, -1467.5],
    ];
    for (const [name, x, y] of spots) {
      const { sim, priv, rule } = setup(600);
      const { p: a, car: ca } = driver(sim, 'A', x, y);
      const { p: b, car: cb } = driver(sim, 'B', x + 4, y);
      expect(rule.challenge(a, b), name).toBeNull();
      rule.answer(b, a.id, true);
      const race = lastEvent(priv, a.id, 'race')!.s!;
      // recompute the by-road length exactly as the rule does, to check the contract directly
      const graph = sim.world.car;
      const start = graph.nearest((ca.x + cb.x) / 2, (ca.y + cb.y) / 2, 400);
      const end = graph.nearest(race.x, race.y, 5);
      const links = graph.path(start, end)!;
      let len = 0;
      for (const l of links) len += l.edge.len;
      expect(len, name).toBeGreaterThanOrEqual(1000);
      expect(len, name).toBeLessThanOrEqual(2000);
    }
  });
});

describe('Race: stake', () => {
  it("is the poorer player's money, floored to $10, capped at $250", () => {
    const { sim, priv, rule } = setup(700);
    const { p: a, car: ca } = driver(sim, 'A', ...MAIN, 1000);
    const { p: b } = driver(sim, 'B', ca.x + 5, ca.y, 137); // poorer: floor(137/10)*10 = 130
    expect(rule.challenge(a, b)).toBeNull();
    expect(lastEvent(priv, b.id, 'challenge')!.s!.stake).toBe(130);
  });

  it('caps at $250 even when both are rich', () => {
    const { sim, priv, rule } = setup(701);
    const { p: a, car: ca } = driver(sim, 'A', ...MAIN, 10000);
    const { p: b } = driver(sim, 'B', ca.x + 5, ca.y, 9000);
    expect(rule.challenge(a, b)).toBeNull();
    expect(lastEvent(priv, b.id, 'challenge')!.s!.stake).toBe(250);
  });

  it('under $20 (the poorer player) it is a stakeless friendly race', () => {
    const { sim, priv, rule } = setup(702);
    const { p: a, car: ca } = driver(sim, 'A', ...MAIN, 15);
    const { p: b } = driver(sim, 'B', ca.x + 5, ca.y, 1000);
    expect(rule.challenge(a, b)).toBeNull();
    expect(lastEvent(priv, b.id, 'challenge')!.s!.stake).toBe(0);
  });
});

describe('Race: running it to the finish', () => {
  it('holds both stakes on accept, pays the winner double, and bumps their win count', () => {
    const { sim, priv, globals, rule } = setup(800);
    const { p: a, car: ca } = driver(sim, 'A', ...MAIN, 500);
    const { p: b } = driver(sim, 'B', ca.x + 5, ca.y, 300);
    expect(rule.challenge(a, b)).toBeNull();
    rule.answer(b, a.id, true);
    expect(lastEvent(priv, b.id, 'challenge')!.s).toBeNull(); // accepting clears the challenge panel too
    // stake = min(250, floor(300/10)*10) = 250, held from both right away
    expect(a.profile.money).toBe(500 - 250);
    expect(b.profile.money).toBe(300 - 250);
    const race = lastEvent(priv, a.id, 'race')!.s!;
    expect(race.startsIn).toBe(3);
    expect(race.left).toBe(300);
    for (let t = 0; t < 31; t++) sim.step(0.1); // clear the 3 s countdown without moving (no false start)
    ca.x = race.x;
    ca.y = race.y; // A reaches the finish
    sim.step(0.1);
    expect(a.profile.money).toBe(500 + 250); // +2x stake: net +1 stake
    expect(b.profile.money).toBe(300 - 250); // net -1 stake
    expect(a.profile.stats?.racesWon).toBe(1);
    expect(globals.some((e) => e.k === 'raceResult' && e.winner === 'A' && e.loser === 'B' && e.amount === 500)).toBe(true);
    expect(lastEvent(priv, a.id, 'race')!.s).toBeNull();
    expect(lastEvent(priv, b.id, 'race')!.s).toBeNull();
  });

  it('a friendly race pays the winner a flat $50 city prize instead of a stake', () => {
    const { sim, priv, rule } = setup(801);
    const { p: a, car: ca } = driver(sim, 'A', ...MAIN, 10);
    const { p: b } = driver(sim, 'B', ca.x + 5, ca.y, 10);
    expect(rule.challenge(a, b)).toBeNull();
    rule.answer(b, a.id, true);
    expect(a.profile.money).toBe(10); // nothing held: friendly races are stakeless
    expect(b.profile.money).toBe(10);
    for (let t = 0; t < 31; t++) sim.step(0.1);
    const race = lastEvent(priv, a.id, 'race')!.s!;
    ca.x = race.x;
    ca.y = race.y;
    sim.step(0.1);
    expect(a.profile.money).toBe(60);
    expect(b.profile.money).toBe(10);
  });

  it('friendly prizes are capped at 3 per winner per day; the win still counts after that', () => {
    const { sim, priv, rule } = setup(802);
    const [bx, by] = MAIN;
    const w = sim.addPlayer({ nick: 'Winner', profile: profile(10), kinematic: true, x: bx, y: by });
    const wCar = sim.addVehicle(new Vehicle('sedan', bx, by, 0, '#fff'));
    expect(sim.enterVehicle(w, wCar)).toBe(true);
    for (let i = 0; i < 4; i++) {
      wCar.x = bx;
      wCar.y = by; // back on the start line for the next challenge
      const o = sim.addPlayer({ nick: `Opp${i}`, profile: profile(10), kinematic: true, x: bx + 3, y: by });
      const oCar = sim.addVehicle(new Vehicle('sedan', bx + 3, by, 0, '#fff'));
      expect(sim.enterVehicle(o, oCar)).toBe(true);
      expect(rule.challenge(w, o)).toBeNull();
      rule.answer(o, w.id, true);
      for (let t = 0; t < 31; t++) sim.step(0.1);
      const race = lastEvent(priv, w.id, 'race')!.s!;
      wCar.x = race.x;
      wCar.y = race.y;
      sim.step(0.1);
    }
    expect(w.profile.money).toBe(10 + 50 * 3); // only the first 3 friendly wins paid
    expect(w.profile.stats?.racesWon).toBe(4); // every win still counts

    // a day of sim time later the cap starts over
    (sim as unknown as { time: number }).time += 24 * 60 * 60;
    wCar.x = bx;
    wCar.y = by;
    const o = sim.addPlayer({ nick: 'NextDay', profile: profile(10), kinematic: true, x: bx + 3, y: by });
    const oCar = sim.addVehicle(new Vehicle('sedan', bx + 3, by, 0, '#fff'));
    expect(sim.enterVehicle(o, oCar)).toBe(true);
    expect(rule.challenge(w, o)).toBeNull();
    rule.answer(o, w.id, true);
    for (let t = 0; t < 31; t++) sim.step(0.1);
    const race = lastEvent(priv, w.id, 'race')!.s!;
    wCar.x = race.x;
    wCar.y = race.y;
    sim.step(0.1);
    expect(w.profile.money).toBe(10 + 50 * 4);
  });

  it('the friendly cap is keyed by player id, not nick: renaming between wins does not reset it', () => {
    const { sim, priv, rule } = setup(803);
    const [bx, by] = MAIN;
    const w = sim.addPlayer({ nick: 'Winner', profile: profile(10), kinematic: true, x: bx, y: by });
    const wCar = sim.addVehicle(new Vehicle('sedan', bx, by, 0, '#fff'));
    expect(sim.enterVehicle(w, wCar)).toBe(true);
    for (let i = 0; i < 4; i++) {
      wCar.x = bx;
      wCar.y = by; // back on the start line for the next challenge
      w.nick = `Guest${i}`; // a fresh nick before every single win: a nick-keyed cap would never repeat a key
      const o = sim.addPlayer({ nick: `Opp${i}`, profile: profile(10), kinematic: true, x: bx + 3, y: by });
      const oCar = sim.addVehicle(new Vehicle('sedan', bx + 3, by, 0, '#fff'));
      expect(sim.enterVehicle(o, oCar)).toBe(true);
      expect(rule.challenge(w, o)).toBeNull();
      rule.answer(o, w.id, true);
      for (let t = 0; t < 31; t++) sim.step(0.1);
      const race = lastEvent(priv, w.id, 'race')!.s!;
      wCar.x = race.x;
      wCar.y = race.y;
      sim.step(0.1);
    }
    expect(w.profile.money).toBe(10 + 50 * 3); // still capped at 3, despite 4 wins under 4 different nicks
    expect(w.profile.stats?.racesWon).toBe(4); // every win still counts
  });
});

describe('Race: countdown, forfeits, timeout and the pair cooldown', () => {
  it('a false start (moving more than 15 m before ŠTART) forfeits to the other player', () => {
    const { sim, globals, rule } = setup(900);
    const { p: a, car: ca } = driver(sim, 'A', ...MAIN, 500);
    const { p: b } = driver(sim, 'B', ca.x + 5, ca.y, 500);
    expect(rule.challenge(a, b)).toBeNull();
    rule.answer(b, a.id, true);
    sim.step(0.5); // still counting down
    ca.x += 20; // A jumps the start
    sim.step(0.1);
    expect(globals.some((e) => e.k === 'raceResult' && e.winner === 'B' && e.loser === 'A')).toBe(true);
    expect(b.profile.stats?.racesWon).toBe(1);
  });

  it('refunds both stakes after 300 s with nobody finishing', () => {
    const { sim, priv, rule } = setup(901);
    const { p: a, car: ca } = driver(sim, 'A', ...MAIN, 500);
    const { p: b } = driver(sim, 'B', ca.x + 5, ca.y, 500);
    expect(rule.challenge(a, b)).toBeNull();
    rule.answer(b, a.id, true);
    expect(a.profile.money).toBe(250);
    for (let t = 0; t < 31; t++) sim.step(0.1); // clear the 3 s countdown
    for (let t = 0; t < 62; t++) sim.step(5); // > 300 s; nobody moves, so a big step is safe here
    expect(a.profile.money).toBe(500);
    expect(b.profile.money).toBe(500);
    expect(lastEvent(priv, a.id, 'race')!.s).toBeNull();
  });

  it('the other player wins by forfeit when a racer leaves the world', () => {
    const { sim, globals, rule } = setup(902);
    const { p: a, car: ca } = driver(sim, 'A', ...MAIN, 500);
    const { p: b } = driver(sim, 'B', ca.x + 5, ca.y, 500);
    expect(rule.challenge(a, b)).toBeNull();
    rule.answer(b, a.id, true);
    for (let t = 0; t < 31; t++) sim.step(0.1); // into the running race
    sim.removePlayer(b);
    expect(globals.some((e) => e.k === 'raceResult' && e.winner === 'A' && e.loser === 'B')).toBe(true);
    expect(a.profile.stats?.racesWon).toBe(1);
  });

  it('the pair cannot race again for 120 s after a race ends', () => {
    const { sim, rule } = setup(903);
    const { p: a, car: ca } = driver(sim, 'A', ...MAIN, 500);
    const { p: b } = driver(sim, 'B', ca.x + 5, ca.y, 500);
    expect(rule.challenge(a, b)).toBeNull();
    rule.answer(b, a.id, true);
    sim.step(0.5);
    ca.x += 20; // a false start ends the race right away
    sim.step(0.1);
    ca.x -= 20; // back within range: only the pair cooldown should block a re-challenge now
    expect(rule.challenge(a, b)).toBe('S týmto hráčom môžeš závodiť znova až o chvíľu.');
    for (let t = 0; t < 25; t++) sim.step(5); // > 120 s later
    expect(rule.challenge(a, b)).toBeNull();
  });
});
