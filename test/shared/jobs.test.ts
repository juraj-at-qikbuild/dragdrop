// The Jobs rule (src/shared/sim/rules/jobs/Jobs.ts): Vlk courier and Hopík taxi shifts, on the real
// map, in both offline and server rules modes. Plan: docs/plans/social-events.md.
import { describe, expect, it } from 'vitest';
import { Sim } from '../../src/shared/sim/Sim';
import { Rng } from '../../src/shared/util/Rng';
import { Vehicle } from '../../src/shared/entities/Vehicle';
import { dist } from '../../src/shared/util/math';
import { nullEvents, type GlobalEvent, type PrivateEvent } from '../../src/shared/sim/events';
import type { JobState } from '../../src/shared/sim/rules/types';
import { Jobs } from '../../src/shared/sim/rules/jobs/Jobs';
import { offerCourier, roadMetres } from '../../src/shared/sim/rules/jobs/courier';
import { loadWorld } from './helpers';

const profile = () => ({ money: 0, done: [], found: [], cumils: [] });
/** an all-zero cap set: no NPC ever spawns, so a job scenario stays fully deterministic */
const NO_NPCS = { traffic: 0, parked: 0, peds: 0, trams: 0, police: 0, helis: 0, roadblocks: 0 };

function setup(seed: number, rules: 'offline' | 'server' = 'server') {
  const priv: [number, PrivateEvent][] = [];
  const globals: GlobalEvent[] = [];
  const sim = new Sim(loadWorld(), {
    rng: new Rng(seed), caps: NO_NPCS, rules,
    events: { ...nullEvents, toPlayer: (pid, e) => priv.push([pid, e]), global: (e) => globals.push(e) },
  });
  return { sim, priv, globals, jobs: sim.rule<Jobs>('jobs')! };
}

/** the most recent {k:'job'} state sent to this player (undefined: never sent; null: sent as "none") */
function lastJob(priv: [number, PrivateEvent][], pid: number): JobState | null | undefined {
  let s: JobState | null | undefined;
  for (const [id, e] of priv) if (id === pid && e.k === 'job') s = e.s;
  return s;
}

function messages(priv: [number, PrivateEvent][], pid: number) {
  return priv.filter((e): e is [number, Extract<PrivateEvent, { k: 'msg' }>] => e[0] === pid && e[1].k === 'msg').map(([, e]) => e.text);
}

function payouts(priv: [number, PrivateEvent][], pid: number, reason?: string) {
  return priv
    .filter((e): e is [number, Extract<PrivateEvent, { k: 'payout' }>] => e[0] === pid && e[1].k === 'payout' && (!reason || e[1].reason === reason))
    .map(([, e]) => e.amount);
}

/** Put the player's own figure exactly here, stopped. Unlike `sim.teleport`, which routes through
 *  `clearSpot()` (fine for a respawn, but free to land several — sometimes 10+ — metres off in a
 *  busy area, e.g. a park), this is what these tests need: an exact, deterministic "you're standing
 *  right there now", the same direct way they already position a car. */
function standAt(p: { ped: { x: number; y: number; vx: number; vy: number } }, x: number, y: number) {
  p.ped.x = x;
  p.ped.y = y;
  p.ped.vx = p.ped.vy = 0;
}

describe('Jobs: courier offer generation', () => {
  it('picks a pickup 200-900 m away and a drop 600-1800 m beyond it, from several spots on the map', () => {
    const world = loadWorld();
    const sim = new Sim(world, { rng: new Rng(1) });
    for (const id of ['main', 'castle', 'eurovea']) {
      const l = world.landmark(id);
      for (let i = 0; i < 8; i++) {
        const offer = offerCourier(sim, l.x, l.y);
        expect(offer).not.toBeNull();
        // the band is checked against the food place itself; the returned pickup point is then
        // snapped onto the walkable network (so the handover is always reachable), which can nudge
        // it a little outside the raw band — hence the small slack below
        const dPickup = dist(l.x, l.y, offer!.pickup.x, offer!.pickup.y);
        expect(dPickup).toBeGreaterThanOrEqual(200 - 25);
        expect(dPickup).toBeLessThanOrEqual(900 + 25);
        const dDrop = dist(offer!.pickup.x, offer!.pickup.y, offer!.drop.x, offer!.drop.y);
        expect(dDrop).toBeGreaterThanOrEqual(600 - 25);
        expect(dDrop).toBeLessThanOrEqual(1800 + 25);
        expect(offer!.pickup.label).toMatch(/^Vlk: bistro \S+ \S/); // a placeName phrase: "na ulici …", "pri …", "v štvrti …"
        expect(offer!.routeM).toBeGreaterThan(0);
      }
    }
  });
});

describe('Jobs: courier pickup and delivery', () => {
  it('hands over at both ends (on foot), with correct timer and pay maths, and stats.deliveries++', () => {
    const { sim, priv, jobs } = setup(10);
    const p = sim.addPlayer({ nick: 'A', profile: profile(), kinematic: false });
    jobs.start(p, 'courier');
    const offer = lastJob(priv, p.id)!;
    expect(offer.kind).toBe('courier');
    expect(offer.stage).toBe('pickup');

    standAt(p, offer.x, offer.y);
    for (let i = 0; i < 21; i++) sim.step(0.05); // just over 1 s stopped at the pickup
    const delivering = lastJob(priv, p.id)!;
    expect(delivering.stage).toBe('deliver');
    expect(delivering.label).not.toBe(offer.label);

    const routeM = roadMetres(sim.world, offer.x, offer.y, delivering.x, delivering.y);
    // the timer was fixed the instant the offer was made (sim.time 0 then): offer.left is the whole
    // budget; a little over 1 s has since ticked off delivering.left
    expect(offer.left).toBeCloseTo(routeM / 8 + 60, 3);
    expect(delivering.left).toBeCloseTo(offer.left - 1.05, 0);

    const before = p.profile.money;
    standAt(p, delivering.x, delivering.y);
    for (let i = 0; i < 21; i++) sim.step(0.05);
    expect(lastJob(priv, p.id)).toBeNull(); // completed: chaining to the next offer, nothing to show yet
    expect(p.profile.stats?.deliveries).toBe(1);

    const subtotal = 50 + 0.06 * routeM;
    const paid = p.profile.money - before;
    // delivered almost instantly: the time bonus is close to its full 50% ($50 + $0.06/m, x1.5)
    expect(paid).toBeGreaterThan(Math.round(subtotal));
    expect(paid).toBeLessThanOrEqual(Math.round(subtotal * 1.5) + 1);
    expect(payouts(priv, p.id, 'courier')).toEqual([paid]);
    expect(messages(priv, p.id).some((t) => t.startsWith('Doručené!'))).toBe(true);
  });

  it('a crash lowers the order condition, and four crashes spill it (job fails, no payout)', () => {
    const { sim, priv, jobs } = setup(11);
    const p = sim.addPlayer({ nick: 'A', profile: profile(), kinematic: false });
    jobs.start(p, 'courier');
    const offer = lastJob(priv, p.id)!;
    standAt(p, offer.x, offer.y);
    for (let i = 0; i < 21; i++) sim.step(0.05);
    const delivering = lastJob(priv, p.id)!;
    expect(delivering.stage).toBe('deliver');
    expect(delivering.condition).toBe(100);

    const car = sim.addVehicle(new Vehicle('sedan', delivering.x, delivering.y, 0, '#fff'));
    p.ped.x = car.x;
    p.ped.y = car.y;
    expect(sim.enterVehicle(p, car)).toBe(true);
    sim.step(0.05); // the crash tracker snaps its baseline to the car the instant it's entered

    for (let n = 0; n < 3; n++) {
      car.health -= car.spec.health * 0.05; // 5% > the 3% threshold
      sim.step(0.05);
      expect(lastJob(priv, p.id)!.condition).toBe(100 - 25 * (n + 1));
    }
    const before = p.profile.money;
    car.health -= car.spec.health * 0.05; // the 4th crash: condition hits 0
    sim.step(0.05);
    expect(lastJob(priv, p.id)).toBeNull();
    expect(p.profile.money).toBe(before); // spilled: no payout
    expect(messages(priv, p.id)).toContain('Objednávka sa vyliala!');

    // chains a fresh offer 20 s after a failure
    for (let t = 0; t < 20.5; t += 0.05) sim.step(0.05);
    const next = lastJob(priv, p.id)!;
    expect(next.kind).toBe('courier');
    expect(next.stage).toBe('pickup');
  });

  it('a near miss while carrying earns a €5 tip, shown as a style event', () => {
    const { sim, priv, jobs } = setup(12);
    const p = sim.addPlayer({ nick: 'A', profile: profile(), kinematic: false });
    jobs.start(p, 'courier');
    const offer = lastJob(priv, p.id)!;
    standAt(p, offer.x, offer.y);
    for (let i = 0; i < 21; i++) sim.step(0.05);
    const delivering = lastJob(priv, p.id)!;

    // the drop-off is a ped-graph spot beside a building; snap to the nearest road so the car can
    // actually build up speed there instead of clipping a wall a moment later
    const cn = sim.world.car.nearest(delivering.x, delivering.y, 400);
    const car = sim.addVehicle(new Vehicle('sedan', sim.world.car.nx(cn), sim.world.car.ny(cn), 0, '#fff'));
    p.ped.x = car.x;
    p.ped.y = car.y;
    expect(sim.enterVehicle(p, car)).toBe(true);
    car.vx = 15;
    car.vy = 0;
    // a synthetic "NPC" hatchback stopped in the next lane, 1.0 m clear of the sedan's hull as it passes
    const gap = 1.0;
    const other = sim.addVehicle(new Vehicle('hatch', car.x, car.y + car.spec.width / 2 + 0.83 + gap, 0, '#000'));
    other.vx = 0;
    other.vy = 0;
    const before = p.profile.money;
    sim.step(0.02); // small step: detects the near miss without letting physics resolve a real contact
    other.x = 99999; // out of the way: nothing left to interact with while the 0.3 s confirm runs out
    for (let i = 0; i < 20; i++) sim.step(0.02); // 0.4 s: past the confirm window, crash-free
    expect(p.profile.money).toBe(before + 5);
    expect(payouts(priv, p.id, 'tip')).toEqual([5]);
    expect(priv.some(([id, e]) => id === p.id && e.k === 'style' && e.label.startsWith('TESNE!'))).toBe(true);
  });
});

describe('Jobs: taxi', () => {
  it('spawns a hailing fare ahead of the car, boards it once stopped, and it leaves the world', () => {
    const { sim, priv, jobs } = setup(20);
    const p = sim.addPlayer({ nick: 'A', profile: profile(), kinematic: false });
    const car = sim.addVehicle(new Vehicle('sedan', p.ped.x, p.ped.y, 0, '#fff'));
    expect(sim.enterVehicle(p, car)).toBe(true);
    jobs.start(p, 'taxi');
    const offer = lastJob(priv, p.id)!;
    expect(offer.kind).toBe('taxi');
    expect(offer.stage).toBe('pickup');
    const d = dist(car.x, car.y, offer.x, offer.y);
    expect(d).toBeGreaterThanOrEqual(150);
    expect(d).toBeLessThanOrEqual(500);
    const fare = sim.peds.find((q) => q.kind === 'civ' && dist(q.x, q.y, offer.x, offer.y) < 0.01);
    expect(fare).toBeDefined();
    expect(fare!.handsUp).toBe(true);

    // 3 m clear of the fare (within the 6 m boarding radius, but not running it over)
    car.x = offer.x - 3;
    car.y = offer.y;
    car.vx = 0;
    car.vy = 0;
    for (let i = 0; i < 21; i++) sim.step(0.05);
    const boarded = lastJob(priv, p.id)!;
    expect(boarded.stage).toBe('deliver');
    expect(sim.peds.includes(fare!)).toBe(false); // the fare left the world when it boarded
  });

  it('re-offers a fresh fare if the current one dies before pickup', () => {
    const { sim, priv, jobs } = setup(21);
    const p = sim.addPlayer({ nick: 'A', profile: profile(), kinematic: false });
    const car = sim.addVehicle(new Vehicle('sedan', p.ped.x, p.ped.y, 0, '#fff'));
    expect(sim.enterVehicle(p, car)).toBe(true);
    jobs.start(p, 'taxi');
    const offer = lastJob(priv, p.id)!;
    const fare = sim.peds.find((q) => q.kind === 'civ' && dist(q.x, q.y, offer.x, offer.y) < 0.01)!;
    fare.kill(fare.x - 1, fare.y, 4);
    sim.step(0.05);
    const reOffer = lastJob(priv, p.id)!;
    expect(reOffer.kind).toBe('taxi');
    expect(reOffer.stage).toBe('pickup');
    expect(dist(car.x, car.y, reOffer.x, reOffer.y)).not.toBeCloseTo(0, 0); // a different spot
  });

  it('mood drops 30 per crash; at 0 the passenger bails and a fleeing ped is spawned', () => {
    const { sim, priv, jobs } = setup(22);
    const p = sim.addPlayer({ nick: 'A', profile: profile(), kinematic: false });
    const car = sim.addVehicle(new Vehicle('sedan', p.ped.x, p.ped.y, 0, '#fff'));
    expect(sim.enterVehicle(p, car)).toBe(true);
    jobs.start(p, 'taxi');
    const offer = lastJob(priv, p.id)!;
    car.x = offer.x - 3;
    car.y = offer.y;
    car.vx = 0;
    car.vy = 0;
    for (let i = 0; i < 21; i++) sim.step(0.05);
    expect(lastJob(priv, p.id)!.stage).toBe('deliver');

    for (let n = 0; n < 3; n++) {
      car.health -= car.spec.health * 0.05;
      sim.step(0.05);
      expect(lastJob(priv, p.id)!.condition).toBe(100 - 30 * (n + 1));
    }
    car.health -= car.spec.health * 0.05; // the 4th crash: mood goes to (and past) 0
    sim.step(0.05);
    expect(lastJob(priv, p.id)).toBeNull();
    expect(messages(priv, p.id)).toContain('Zákazník vystúpil!');
    expect(sim.peds.some((q) => q.state === 'flee')).toBe(true);
  });

  it('a taxi-kind car earns 25% more on the fare', () => {
    const { sim, priv, jobs } = setup(23);
    const p = sim.addPlayer({ nick: 'A', profile: profile(), kinematic: false });
    const car = sim.addVehicle(new Vehicle('taxi', p.ped.x, p.ped.y, 0, '#fdd835'));
    expect(sim.enterVehicle(p, car)).toBe(true);
    jobs.start(p, 'taxi');
    const offer = lastJob(priv, p.id)!;
    car.x = offer.x - 3;
    car.y = offer.y;
    car.vx = 0;
    car.vy = 0;
    for (let i = 0; i < 21; i++) sim.step(0.05);
    const boarded = lastJob(priv, p.id)!; // stage 'deliver': x, y now the destination
    const routeM = roadMetres(sim.world, offer.x, offer.y, boarded.x, boarded.y);
    car.x = boarded.x;
    car.y = boarded.y;
    const before = p.profile.money;
    for (let i = 0; i < 21; i++) sim.step(0.05);
    const [paidTaxi] = payouts(priv, p.id, 'taxi');
    // delivered almost instantly: close to the full 50% time bonus, x1.25 for the taxi-kind car
    const subtotal = 30 + 0.08 * routeM;
    expect(paidTaxi).toBeGreaterThan(Math.round(subtotal * 1.25));
    expect(paidTaxi).toBeLessThanOrEqual(Math.round(subtotal * 1.5 * 1.25) + 1);
    expect(p.profile.money - before).toBe(paidTaxi);
    expect(p.profile.stats?.fares).toBe(1);
  });
});

describe('Jobs: chaining and stop', () => {
  it('chains a fresh offer 5 s after a completed job, and stop() ends the shift for good', () => {
    const { sim, priv, jobs } = setup(30);
    const p = sim.addPlayer({ nick: 'A', profile: profile(), kinematic: false });
    jobs.start(p, 'courier');
    const offer = lastJob(priv, p.id)!;
    standAt(p, offer.x, offer.y);
    for (let i = 0; i < 21; i++) sim.step(0.05);
    const delivering = lastJob(priv, p.id)!;
    standAt(p, delivering.x, delivering.y);
    for (let i = 0; i < 21; i++) sim.step(0.05);
    expect(lastJob(priv, p.id)).toBeNull();

    for (let t = 0; t < 5.5; t += 0.05) sim.step(0.05);
    const chained = lastJob(priv, p.id)!;
    expect(chained.kind).toBe('courier');
    expect(chained.stage).toBe('pickup');

    jobs.stop(p);
    expect(lastJob(priv, p.id)).toBeNull();
    const before = priv.length;
    for (let i = 0; i < 200; i++) sim.step(0.05); // 10 s: no further job events once stopped
    expect(priv.slice(before).some(([id, e]) => id === p.id && e.k === 'job')).toBe(false);
  });
});

describe('Jobs: rules mode', () => {
  it('runs identically with rules: "offline"', () => {
    const { sim, priv, jobs } = setup(40, 'offline');
    expect(jobs).toBeDefined();
    const p = sim.addPlayer({ nick: 'A', profile: profile(), kinematic: false });
    jobs.start(p, 'courier');
    expect(lastJob(priv, p.id)?.stage).toBe('pickup');
    jobs.stop(p);
    expect(lastJob(priv, p.id)).toBeNull();
  });
});
