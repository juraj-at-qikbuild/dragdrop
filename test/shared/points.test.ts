// Leaderboard points (docs/plans/leaderboard.md): Sim.score itself (the party split, the host saying
// how many it took, offline scoring nothing), and every source that awards them, each driven through
// the same real-map flow its own rule's tests use.
import { describe, expect, it } from 'vitest';
import { Sim } from '../../src/shared/sim/Sim';
import { Rng } from '../../src/shared/util/Rng';
import { LIVERY_ARMORED, LIVERY_KOFOLKA, Vehicle } from '../../src/shared/entities/Vehicle';
import { HitKind } from '../../src/shared/sim/Combat';
import { nullEvents, type PrivateEvent } from '../../src/shared/sim/events';
import type { WorldEvents } from '../../src/shared/sim/rules/WorldEvents';
import type { Race } from '../../src/shared/sim/rules/Race';
import type { Jobs } from '../../src/shared/sim/rules/jobs/Jobs';
import type { JobState } from '../../src/shared/sim/rules/types';
import { bestParkingNear } from '../../src/shared/sim/rules/Zones';
import { POINTS, SOURCE_BOARD, bountyPoints, getawayPoints, jobPoints, type ScoreSource } from '../../src/shared/sim/rules/points';
import { loadWorld } from './helpers';

/** every landmark pre-"found", so walking past one never scores in a test about something else */
const allFound = () => [...loadWorld().landmarks.keys()];
const profile = (found = allFound(), money = 1000) => ({ money, done: [], found, cumils: [] as number[] });
const NO_NPCS = { traffic: 0, parked: 0, peds: 0, trams: 0, police: 0, helis: 0, roadblocks: 0 };

/** a real-map Sim that scores (the way the server's Leaderboard does, minus the caps), recording every
 *  point awarded and every private event */
function setup(seed: number, opts: { rules?: 'server' | 'offline'; downed?: boolean } = {}) {
  const priv: [number, PrivateEvent][] = [];
  const sim = new Sim(loadWorld(), {
    rng: new Rng(seed), caps: NO_NPCS, rules: opts.rules ?? 'server', downed: opts.downed,
    events: { ...nullEvents, toPlayer: (pid, e) => priv.push([pid, e]) },
  });
  const scored: [string, number, ScoreSource][] = [];
  sim.onScore = (p, n, src) => {
    scored.push([p.nick, n, src]);
    return n;
  };
  return { sim, priv, scored };
}

const total = (scored: [string, number, ScoreSource][], nick: string, src?: ScoreSource) =>
  scored.filter(([n, , s]) => n === nick && (!src || s === src)).reduce((t, [, n]) => t + n, 0);

describe('the points table', () => {
  it('puts every source on a board', () => {
    for (const src of Object.keys(SOURCE_BOARD) as ScoreSource[]) expect(['events', 'police', 'jobs', 'races', 'city', 'help', 'style']).toContain(SOURCE_BOARD[src]);
  });

  it('scales getaways by stars, jobs by pay and bounties by size', () => {
    expect([1, 2, 3, 4, 5].map(getawayPoints)).toEqual([5, 15, 40, 80, 150]);
    expect(getawayPoints(0)).toBe(0);
    expect(jobPoints(150)).toBe(30);
    expect(jobPoints(1)).toBe(1);
    expect(bountyPoints(300)).toBe(55);
    expect(bountyPoints(3000)).toBe(190);
  });
});

describe('Sim.score', () => {
  it('scores nothing offline (no onScore): no event either', () => {
    const priv: [number, PrivateEvent][] = [];
    const sim = new Sim(loadWorld(), { rng: new Rng(1), caps: NO_NPCS, events: { ...nullEvents, toPlayer: (pid, e) => priv.push([pid, e]) } });
    const p = sim.addPlayer({ nick: 'A', profile: profile(), kinematic: false });
    sim.score(p, 30, 'courier');
    expect(priv.some(([, e]) => e.k === 'points')).toBe(false);
  });

  it('tells the player what was taken, where it was scored', () => {
    const { sim, priv, scored } = setup(2);
    const p = sim.addPlayer({ nick: 'A', profile: profile(), kinematic: false });
    sim.score(p, 29.6, 'courier', 10, 20);
    expect(scored).toEqual([['A', 30, 'courier']]);
    expect(priv).toContainEqual([p.id, { k: 'points', n: 30, src: 'courier', x: 10, y: 20 }]);
    sim.score(p, 0, 'courier');
    sim.score(p, -5, 'courier');
    expect(scored.length).toBe(1);
  });

  it('shows nothing when the host took nothing (an hourly cap)', () => {
    const { sim, priv } = setup(3);
    sim.onScore = () => 0;
    const p = sim.addPlayer({ nick: 'A', profile: profile(), kinematic: false });
    sim.score(p, 10, 'getaway');
    expect(priv.some(([, e]) => e.k === 'points')).toBe(false);
  });

  it('splits through the payout policy like money: the rest of an uneven split goes to the earner', () => {
    const { sim, priv, scored } = setup(4);
    const a = sim.addPlayer({ nick: 'A', profile: profile(), kinematic: false });
    const b = sim.addPlayer({ nick: 'B', profile: profile(), kinematic: false });
    const c = sim.addPlayer({ nick: 'C', profile: profile(), kinematic: false });
    const reasons: string[] = [];
    sim.payoutPolicy = (p, amount, reason) => {
      reasons.push(reason);
      const share = Math.floor(amount / 3);
      return [{ p, amount: amount - 2 * share }, { p: b, amount: share }, { p: c, amount: share }];
    };
    sim.score(a, 31, 'courier', 5, 5);
    expect(reasons).toEqual(['courier']);
    expect(scored).toEqual([['A', 11, 'courier'], ['B', 10, 'courier'], ['C', 10, 'courier']]);
    // the earner's where it happened; the others where they are
    const pts = priv.filter(([, e]) => e.k === 'points').map(([id, e]) => [id, (e as { x: number }).x]);
    expect(pts).toEqual([[a.id, 5], [b.id, b.ped.x], [c.id, c.ped.x]]);
  });
});

describe('the city', () => {
  it('a landmark scores once, when it is discovered', () => {
    const { sim, scored } = setup(10);
    const found = allFound().filter((id) => id !== 'main');
    const main = sim.world.landmark('main');
    const p = sim.addPlayer({ nick: 'A', profile: profile(found), kinematic: false, x: main.x, y: main.y });
    sim.step(0.1);
    sim.step(0.1);
    expect(scored).toEqual([['A', POINTS.landmark, 'landmark']]);
    expect(p.profile.found).toContain('main');
  });

  it('a hidden Čumil statue scores when it is found', () => {
    const { sim, scored } = setup(11);
    const pk = sim.pickups.find((q) => q.kind === 'cumil')!;
    const p = sim.addPlayer({ nick: 'A', profile: profile(), kinematic: false, x: pk.x, y: pk.y });
    p.ped.x = pk.x;
    p.ped.y = pk.y;
    sim.step(0.1);
    expect(p.profile.cumils).toEqual([pk.cumil]);
    expect(total(scored, 'A', 'statue')).toBe(POINTS.statue);
    sim.step(0.1); // already found: never again
    expect(total(scored, 'A', 'statue')).toBe(POINTS.statue);
  });
});

describe('on the run', () => {
  /** a player somewhere the police last saw them far from, so the search zone never holds them, and
   *  on the run: never still, so never lying low (which would fade the stars faster, and a 3★ chase
   *  under the 30 s a getaway needs) */
  function runner(sim: Sim) {
    const main = sim.world.landmark('main'), gate = sim.world.landmark('michael');
    const p = sim.addPlayer({ nick: 'A', profile: profile(), kinematic: false, x: main.x, y: main.y });
    p.lastSeenPos = { x: main.x, y: main.y };
    return {
      p,
      away: () => ((p.ped.x = gate.x), (p.ped.y = gate.y), (p.ped.vx = 3)),
      back: () => ((p.ped.x = main.x), (p.ped.y = main.y)),
    };
  }

  it('losing the police after a real chase scores by its most stars', () => {
    const { sim, scored } = setup(20);
    const { p, away } = runner(sim);
    sim.setWanted(p, 3);
    sim.step(0.1);
    away();
    for (let i = 0; i < 60 && p.wanted > 0; i++) sim.step(1); // one star at a time, ~36 s in all
    expect(p.wanted).toBe(0);
    expect(scored).toEqual([['A', getawayPoints(3), 'getaway']]);
  });

  it('a chase under 30 s, the spray shop or a respawn scores nothing', () => {
    const { sim, scored } = setup(21);
    const { p, away } = runner(sim);
    sim.setWanted(p, 1);
    sim.step(0.1);
    away();
    for (let i = 0; i < 30 && p.wanted > 0; i++) sim.step(1); // 1★ is gone in ~11 s
    expect(p.wanted).toBe(0);
    sim.setWanted(p, 4);
    for (let i = 0; i < 40; i++) sim.step(0.5);
    sim.setWanted(p, 0); // stars wiped some other way (the spray shop does exactly this)
    sim.step(0.1);
    expect(p.chaseSince).toBe(-1);
    expect(scored).toEqual([]);
  });

  it('a second getaway within 90 s scores nothing', () => {
    const { sim, scored } = setup(22);
    const { p, away, back } = runner(sim);
    sim.setWanted(p, 3);
    sim.step(0.1);
    away();
    for (let i = 0; i < 60 && p.wanted > 0; i++) sim.step(1);
    expect(scored.length).toBe(1);
    sim.setWanted(p, 3); // the police know where A is again...
    sim.step(0.1);
    back(); // ...and A runs off once more
    for (let i = 0; i < 60 && p.wanted > 0; i++) sim.step(1); // a 30 s+ chase again, but too soon
    expect(p.wanted).toBe(0);
    expect(scored.length).toBe(1);
  });

  it('destroying a police car scores a takedown for whoever did the damage', () => {
    const { sim, scored } = setup(23);
    const main = sim.world.landmark('main');
    const p = sim.addPlayer({ nick: 'A', profile: profile(), kinematic: false, x: main.x, y: main.y });
    const cop = sim.addVehicle(new Vehicle('police', main.x + 60, main.y, 0, '#fff'));
    sim.damageVehicle(cop, 10, p.id);
    sim.wreck(cop);
    expect(scored).toEqual([['A', POINTS.takedown, 'takedown']]);
    const car = sim.addVehicle(new Vehicle('sedan', main.x + 60, main.y + 20, 0, '#fff'));
    sim.damageVehicle(car, 10, p.id);
    sim.wreck(car); // an ordinary car: no takedown
    expect(scored.length).toBe(1);
  });
});

describe('Najhľadanejší', () => {
  function chase(seed: number) {
    const s = setup(seed, { downed: true });
    const a = s.sim.addPlayer({ nick: 'A', profile: profile(), kinematic: true });
    const k = s.sim.addPlayer({ nick: 'K', profile: profile(), kinematic: true });
    // the target keeps moving (as its client reports): not lying low, the 5★ hold with no police about
    a.ped.vx = 2;
    s.sim.setWanted(a, 5);
    const dir = s.sim.rule<WorldEvents>('worldEvents')!;
    dir.trigger('wanted', a);
    return { ...s, a, k, dir };
  }

  it('the target scores each minute at 5★, the hunter the bounty', () => {
    const { sim, scored, a, k } = chase(30);
    for (let i = 0; i < 61; i++) sim.step(1);
    expect(total(scored, 'A', 'wanted')).toBe(POINTS.wanted);
    sim.hurtPlayer(a, 1000, k.ped.x, k.ped.y, k.id);
    expect(total(scored, 'K', 'bounty')).toBe(bountyPoints(450));
  });

  it('getting away scores the escape', () => {
    const { sim, scored, a } = chase(31);
    for (let i = 0; i < 61; i++) sim.step(1);
    sim.setWanted(a, 0);
    for (let i = 0; i < 61; i++) sim.step(1);
    expect(total(scored, 'A', 'escape')).toBe(POINTS.escape);
  });
});

describe('world events', () => {
  it('Horúca Kofolka: points for each $100 of the pot, and the top earner when it runs dry', () => {
    const { sim, scored } = setup(40);
    const main = sim.world.landmark('main');
    const a = sim.addPlayer({ nick: 'A', profile: profile(), kinematic: false, x: main.x, y: main.y });
    sim.addPlayer({ nick: 'B', profile: profile(), kinematic: false, x: main.x + 40, y: main.y });
    const dir = sim.rule<WorldEvents>('worldEvents')!;
    dir.start('kofolka');
    const van = sim.vehicles.find((v) => v.livery === LIVERY_KOFOLKA)!;
    for (let i = 0; i < 35; i++) sim.step(1);
    a.ped.x = van.x;
    a.ped.y = van.y;
    expect(sim.enterVehicle(a, van, 10)).toBe(true);
    for (let i = 0; i < 19; i++) sim.step(1);
    expect(total(scored, 'A', 'kofolka')).toBe(POINTS.kofolka); // $190 paid: one $100 mark crossed
    for (let i = 0; i < 140 && dir.active.length; i++) sim.step(1);
    expect(dir.active.length).toBe(0);
    expect(total(scored, 'A', 'kofolka')).toBe(15 * POINTS.kofolka + POINTS.kofolkaTop);
  });

  it('Hon na Čumila: the finder scores', () => {
    const { sim, scored } = setup(41, { rules: 'offline' });
    const main = sim.world.landmark('main');
    const p = sim.addPlayer({ nick: 'A', profile: profile(), kinematic: false, x: main.x, y: main.y });
    const ev = sim.rule<WorldEvents>('worldEvents')!.start('cumil')!;
    for (let i = 0; i < 35; i++) sim.step(1);
    const target = (ev as unknown as { target: { x: number; y: number } }).target;
    p.ped.x = target.x;
    p.ped.y = target.y;
    sim.step(0.1);
    expect(scored).toEqual([['A', POINTS.cumil, 'cumil']]);
  });

  it('Obrnené auto: every recent rear shooter scores the robbery, each bundle of cash the loot', () => {
    const { sim, scored } = setup(42);
    const main = sim.world.landmark('main');
    const a = sim.addPlayer({ nick: 'A', profile: profile(), kinematic: false, x: main.x, y: main.y });
    const b = sim.addPlayer({ nick: 'B', profile: profile(), kinematic: false, x: main.x + 40, y: main.y });
    const dir = sim.rule<WorldEvents>('worldEvents')!;
    dir.start('armored');
    const van = sim.vehicles.find((v) => v.livery === LIVERY_ARMORED)!;
    const rear = { x: van.x - Math.cos(van.angle) * 2, y: van.y - Math.sin(van.angle) * 2 };
    const shoot = (pid: number) =>
      sim.combat.applyShot(
        { id: 0, x: rear.x - 5, y: rear.y, level: 0, vehicle: null }, pid,
        { w: 'pistol', ox: rear.x - 5, oy: rear.y, a: 0, lvl: 0, pellets: [{ a: 0, kind: HitKind.Car, hit: van.id, hx: rear.x, hy: rear.y }] },
      );
    for (let i = 0; i < 5; i++) shoot(a.id);
    shoot(b.id);
    expect(total(scored, 'A', 'robbery')).toBe(POINTS.robbery);
    expect(total(scored, 'B', 'robbery')).toBe(POINTS.robbery);
    const pk = sim.pickups.find((q) => q.tag === 'van')!;
    a.ped.x = pk.x;
    a.ped.y = pk.y;
    sim.step(0.1);
    const loot = total(scored, 'A', 'loot');
    expect(loot).toBeGreaterThanOrEqual(POINTS.loot);
    expect(loot % POINTS.loot).toBe(0);
  });

  it('Derby: 100/50/30 for the podium, 10 for the rest of the field', () => {
    const { sim, scored } = setup(43);
    const dir = sim.rule<WorldEvents>('worldEvents')!;
    dir.start('derby');
    const arena = bestParkingNear(sim.world, 'aupark', 250)!;
    const cars: Vehicle[] = [];
    ['Anna', 'Boris', 'Cyril', 'Dana'].forEach((nick, i) => {
      const x = arena.cx + (i - 1.5) * 5, y = arena.cy;
      const p = sim.addPlayer({ nick, profile: profile(), kinematic: false, x, y });
      const car = sim.addVehicle(new Vehicle('classic', x, y, 0, '#fff'));
      expect(sim.enterVehicle(p, car, 10)).toBe(true);
      cars.push(car);
    });
    for (let i = 0; i < 92 + 10; i++) sim.step(1); // live, and past the 10 s grace
    cars[1].wrecked = true; // Boris out first
    sim.step(1);
    cars[3].wrecked = true; // then Dana
    sim.step(1);
    cars[0].health = 1; // then Anna: Cyril is the last car standing
    sim.step(1);
    expect(dir.active.length).toBe(0);
    expect(total(scored, 'Cyril', 'derby')).toBe(100);
    expect(total(scored, 'Anna', 'derby')).toBe(50);
    expect(total(scored, 'Dana', 'derby')).toBe(30);
    expect(total(scored, 'Boris', 'derby')).toBe(POINTS.derbyField);
  });
});

describe('races, jobs and help', () => {
  const MAIN = [-247.1, -357.3] as const;
  function racers(seed: number) {
    const s = setup(seed);
    const mk = (nick: string, x: number, y: number) => {
      const p = s.sim.addPlayer({ nick, profile: profile(), kinematic: true, x, y });
      const car = s.sim.addVehicle(new Vehicle('sedan', x, y, 0, '#fff'));
      expect(s.sim.enterVehicle(p, car)).toBe(true);
      return { p, car };
    };
    const A = mk('A', ...MAIN);
    const B = mk('B', A.car.x + 5, A.car.y);
    const rule = s.sim.rule<Race>('race')!;
    expect(rule.challenge(A.p, B.p)).toBeNull();
    rule.answer(B.p, A.p.id, true);
    return { ...s, A, B };
  }

  it('Závod?: a win at the line scores', () => {
    const { sim, priv, scored, A } = racers(50);
    const race = [...priv].reverse().find(([id, e]) => id === A.p.id && e.k === 'race')![1] as Extract<PrivateEvent, { k: 'race' }>;
    for (let t = 0; t < 31; t++) sim.step(0.1);
    A.car.x = race.s!.x;
    A.car.y = race.s!.y;
    sim.step(0.1);
    expect(scored).toEqual([['A', POINTS.race, 'race']]);
  });

  it('Závod?: a forfeit (a false start, or the other one leaving) scores nothing', () => {
    const one = racers(51);
    one.A.car.x += 20; // A jumps the start: B wins
    one.sim.step(0.1);
    expect(one.B.p.profile.stats?.racesWon).toBe(1);
    const two = racers(52);
    for (let t = 0; t < 31; t++) two.sim.step(0.1);
    two.sim.removePlayer(two.B.p);
    expect(two.A.p.profile.stats?.racesWon).toBe(1);
    expect([...one.scored, ...two.scored]).toEqual([]);
  });

  it('a delivery scores by its pay, a near miss while carrying scores a tip', () => {
    const { sim, priv, scored } = setup(12);
    const jobs = sim.rule<Jobs>('jobs')!;
    const p = sim.addPlayer({ nick: 'A', profile: profile(), kinematic: false });
    const job = () => [...priv].reverse().find(([id, e]) => id === p.id && e.k === 'job')![1] as Extract<PrivateEvent, { k: 'job' }>;
    const standAt = (x: number, y: number) => ((p.ped.x = x), (p.ped.y = y), (p.ped.vx = p.ped.vy = 0));
    jobs.start(p, 'courier');
    const offer = job().s as JobState;
    standAt(offer.x, offer.y);
    for (let i = 0; i < 21; i++) sim.step(0.05);
    const delivering = job().s as JobState;
    // a near miss on the way (the jobs test's own recipe)
    const cn = sim.world.car.nearest(delivering.x, delivering.y, 400);
    const car = sim.addVehicle(new Vehicle('sedan', sim.world.car.nx(cn), sim.world.car.ny(cn), 0, '#fff'));
    p.ped.x = car.x;
    p.ped.y = car.y;
    expect(sim.enterVehicle(p, car)).toBe(true);
    car.vx = 15;
    const other = sim.addVehicle(new Vehicle('hatch', car.x, car.y + car.spec.width / 2 + 0.83 + 1, 0, '#000'));
    sim.step(0.02);
    other.x = 99999;
    for (let i = 0; i < 20; i++) sim.step(0.02);
    expect(total(scored, 'A', 'tip')).toBe(POINTS.tip);
    // then the delivery itself, on foot at the door
    sim.exitVehicle(p, true);
    const before = p.profile.money;
    standAt(delivering.x, delivering.y);
    for (let i = 0; i < 21; i++) sim.step(0.05);
    const pay = p.profile.money - before;
    expect(pay).toBeGreaterThan(0);
    expect(total(scored, 'A', 'courier')).toBe(jobPoints(pay));
  });

  it('a revive scores for the Dobrý samaritán, only when the bonus pays', () => {
    const { sim, scored } = setup(60, { downed: true });
    const a = sim.addPlayer({ nick: 'A', profile: profile(), kinematic: true });
    const b = sim.addPlayer({ nick: 'B', profile: profile(), kinematic: true });
    const reviveOnce = () => {
      sim.down(a);
      b.ped.x = a.ped.x + 1.5;
      b.ped.y = a.ped.y;
      for (let i = 0; i < 61; i++) sim.step(0.05);
      expect(a.state).toBe('play');
    };
    reviveOnce();
    expect(scored).toEqual([['B', POINTS.samaritan, 'samaritan']]);
    reviveOnce(); // the same pair again within 10 min: no bonus, no points
    expect(scored.length).toBe(1);
  });
});
