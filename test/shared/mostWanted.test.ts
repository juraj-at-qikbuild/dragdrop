// Najhľadanejší (src/shared/sim/rules/events/MostWanted.ts), against the real map: the watcher that
// triggers a chase for the first player to reach 5★, the growing bounty and the target's own danger
// money, takedowns (with the anti-collusion checks), busts/police kills/bleed-outs voiding it, and
// escaping by staying under 5★ for a minute.
// Plan: docs/plans/social-events.md ("Najhľadanejší").
import { describe, expect, it } from 'vitest';
import { Sim } from '../../src/shared/sim/Sim';
import { Rng } from '../../src/shared/util/Rng';
import { nullEvents, type GlobalEvent, type PrivateEvent } from '../../src/shared/sim/events';
import type { WorldEvents } from '../../src/shared/sim/rules/WorldEvents';
import { loadWorld } from './helpers';

/** every landmark pre-"found": players spawn near Hlavné námestie (a landmark), and the unrelated
 *  €100 discovery reward would otherwise land on top of this file's own payout assertions */
const allFound = () => [...loadWorld().landmarks.values()].map((l) => l.id);
const profile = () => ({ money: 0, done: [], found: allFound(), cumils: [] });
/** an all-zero cap set: no cops ever spawn, so a stationary player's wanted level never decays on
 *  its own (Sim.updateWanted only drops it once the police lose sight for a while) */
const NO_NPCS = { traffic: 0, parked: 0, peds: 0, trams: 0, police: 0, helis: 0, roadblocks: 0 };

/** a real-map Sim with downing and every social rule on ('server' rules mode), capturing every
 *  global event and payout it sends */
function setup(seed: number) {
  const priv: [number, PrivateEvent][] = [];
  const globals: GlobalEvent[] = [];
  const payouts: [string, number, string][] = [];
  const sim = new Sim(loadWorld(), {
    rng: new Rng(seed), downed: true, caps: NO_NPCS, rules: 'server',
    events: { ...nullEvents, toPlayer: (pid, e) => priv.push([pid, e]), global: (e) => globals.push(e) },
  });
  sim.onPayout = (p, amount, reason) => payouts.push([p.nick, amount, reason]);
  const dir = sim.rule<WorldEvents>('worldEvents')!;
  return { sim, dir, priv, globals, payouts };
}

describe('MostWantedWatch', () => {
  it('triggers only once at least 2 players count and one is at 5★', () => {
    const { sim, dir } = setup(401);
    const a = sim.addPlayer({ nick: 'A', profile: profile(), kinematic: true });
    sim.setWanted(a, 5);
    for (let i = 0; i < 3; i++) sim.step(1);
    expect(dir.get('wanted')).toBeUndefined(); // only 1 player counts so far

    sim.addPlayer({ nick: 'B', profile: profile(), kinematic: true });
    for (let i = 0; i < 3; i++) sim.step(1);
    const ev = dir.get('wanted');
    expect(ev).toBeDefined();
    expect(ev!.entry().holder).toBe(a.id);
  });

  it('targets whoever has been at 5★ longest', () => {
    const { sim, dir } = setup(402);
    const a = sim.addPlayer({ nick: 'A', profile: profile(), kinematic: true });
    sim.setWanted(a, 5);
    for (let i = 0; i < 3; i++) sim.step(1); // a's clock is running, but only 1 player counts so far
    const b = sim.addPlayer({ nick: 'B', profile: profile(), kinematic: true });
    sim.setWanted(b, 5); // b only reaches 5★ now, once there are 2 players to count
    sim.step(1);
    expect(dir.get('wanted')!.entry().holder).toBe(a.id);
  });

  it('holds a 5-min re-trigger cooldown after a chase ends', () => {
    const { sim, dir } = setup(403);
    const a = sim.addPlayer({ nick: 'A', profile: profile(), kinematic: true });
    sim.addPlayer({ nick: 'B', profile: profile(), kinematic: true });
    sim.setWanted(a, 5);
    for (let i = 0; i < 2; i++) sim.step(1);
    expect(dir.get('wanted')).toBeDefined();

    sim.setWanted(a, 0); // drop and stay well below 5★ long enough to escape, ending the chase
    for (let i = 0; i < 61; i++) sim.step(1);
    expect(dir.get('wanted')).toBeUndefined();

    sim.setWanted(a, 5); // back at 5★ right away, but on the re-trigger cooldown
    for (let i = 0; i < 290; i++) sim.step(1); // comfortably under 5 min since the chase ended
    expect(dir.get('wanted')).toBeUndefined();

    for (let i = 0; i < 30; i++) sim.step(1); // now comfortably past 5 min: free to trigger again
    expect(dir.get('wanted')).toBeDefined();
  });
});

describe('the bounty', () => {
  it('grows $150 and pays the target $100 every full minute at 5★, capped at $3000', () => {
    const { sim, dir, payouts } = setup(410);
    const a = sim.addPlayer({ nick: 'A', profile: profile(), kinematic: true });
    sim.addPlayer({ nick: 'B', profile: profile(), kinematic: true });
    sim.setWanted(a, 5);
    const ev = dir.trigger('wanted', a);
    expect(ev).not.toBeNull();
    expect(ev!.entry().pot).toBe(300);

    for (let i = 0; i < 60; i++) sim.step(1);
    expect(ev!.entry().pot).toBe(450);
    expect(a.profile.money).toBe(100);
    expect(payouts.some(([nick, amount, reason]) => nick === 'A' && amount === 100 && reason === 'wanted')).toBe(true);

    for (let i = 0; i < 60; i++) sim.step(1);
    expect(ev!.entry().pot).toBe(600);
    expect(a.profile.money).toBe(200);

    for (let i = 0; i < 60 * 23; i++) sim.step(1); // run well past the cap
    expect(ev!.entry().pot).toBe(3000);
  });
});

describe('takedowns', () => {
  it('pays the killer the current bounty after 60s at 5★, and ends the chase as taken', () => {
    const { sim, dir, globals } = setup(420);
    const a = sim.addPlayer({ nick: 'A', profile: profile(), kinematic: true });
    const k = sim.addPlayer({ nick: 'K', profile: profile(), kinematic: true });
    sim.setWanted(a, 5);
    dir.trigger('wanted', a);
    for (let i = 0; i < 61; i++) sim.step(1); // just past the 60s eligibility mark; bounty now $450
    const before = k.profile.money;
    sim.hurtPlayer(a, 1000, k.ped.x, k.ped.y, k.id);
    expect(a.state).toBe('downed');
    expect(k.profile.money - before).toBe(450);
    expect(globals.some((e) => e.k === 'mostWantedEnd' && e.how === 'taken' && e.by === 'K' && e.amount === 450)).toBe(true);
    sim.step(0.1); // let the finished instance clear out of the director
    expect(dir.get('wanted')).toBeUndefined();
  });

  it('pays nothing inside the first 60s at 5★', () => {
    const { sim, dir, globals } = setup(421);
    const a = sim.addPlayer({ nick: 'A', profile: profile(), kinematic: true });
    const k = sim.addPlayer({ nick: 'K', profile: profile(), kinematic: true });
    sim.setWanted(a, 5);
    dir.trigger('wanted', a);
    for (let i = 0; i < 30; i++) sim.step(1);
    const before = k.profile.money;
    sim.hurtPlayer(a, 1000, k.ped.x, k.ped.y, k.id);
    expect(k.profile.money).toBe(before);
    expect(globals.some((e) => e.k === 'mostWantedEnd' && e.how === 'taken' && e.amount === 0)).toBe(true);
  });

  it("pays nothing when the killer shares the target's party", () => {
    const { sim, dir } = setup(422);
    const a = sim.addPlayer({ nick: 'A', profile: profile(), kinematic: true });
    const k = sim.addPlayer({ nick: 'K', profile: profile(), kinematic: true });
    a.partyId = k.partyId = 7;
    sim.setWanted(a, 5);
    dir.trigger('wanted', a);
    for (let i = 0; i < 61; i++) sim.step(1);
    const before = k.profile.money;
    sim.hurtPlayer(a, 1000, k.ped.x, k.ped.y, k.id);
    expect(k.profile.money).toBe(before);
  });

  it('a 60-min cooldown blocks a repeat payout for the same killer/target pair', () => {
    const { sim, dir, globals } = setup(423);
    const a = sim.addPlayer({ nick: 'A', profile: profile(), kinematic: true });
    const k = sim.addPlayer({ nick: 'K', profile: profile(), kinematic: true });
    sim.setWanted(a, 5);
    dir.trigger('wanted', a);
    for (let i = 0; i < 61; i++) sim.step(1);
    sim.hurtPlayer(a, 1000, k.ped.x, k.ped.y, k.id);
    expect(k.profile.money).toBe(450); // first payout goes through
    sim.step(0.1); // let the finished instance clear out of the director

    sim.revive(a, undefined, 100);
    dir.trigger('wanted', a); // a second chase for the same target, bypassing the watcher's own cooldown
    for (let i = 0; i < 61; i++) sim.step(1);
    const before = k.profile.money;
    sim.hurtPlayer(a, 1000, k.ped.x, k.ped.y, k.id);
    expect(k.profile.money).toBe(before); // no second payout: the pair cooldown (60 min)
    expect(globals.filter((e) => e.k === 'mostWantedEnd' && e.how === 'taken').length).toBe(2);
    expect(globals.some((e) => e.k === 'mostWantedEnd' && e.how === 'taken' && e.amount === 0)).toBe(true);
  });

  it('gives the hunter no stars for hitting the target, though the damage still lands', () => {
    const { sim, dir } = setup(424);
    const a = sim.addPlayer({ nick: 'A', profile: profile(), kinematic: true });
    const k = sim.addPlayer({ nick: 'K', profile: profile(), kinematic: true });
    sim.setWanted(a, 5);
    dir.trigger('wanted', a);
    const before = a.ped.health;
    sim.hurtPlayer(a, 10, k.ped.x, k.ped.y, k.id);
    expect(k.wanted).toBe(0);
    expect(a.ped.health).toBeLessThan(before);
    expect(a.state).toBe('play');
  });

  it('a bust voids the bounty', () => {
    const { sim, dir, globals } = setup(425);
    const a = sim.addPlayer({ nick: 'A', profile: profile(), kinematic: true });
    sim.addPlayer({ nick: 'B', profile: profile(), kinematic: true });
    sim.setWanted(a, 5);
    dir.trigger('wanted', a);
    for (let i = 0; i < 61; i++) sim.step(1); // grow the bounty, to prove it's still voided
    sim.bust(a);
    expect(globals.some((e) => e.k === 'mostWantedEnd' && e.how === 'busted' && e.amount === 0)).toBe(true);
    sim.step(0.1);
    expect(dir.get('wanted')).toBeUndefined();
  });

  it('a police kill or bleed-out (no player credit) voids the bounty', () => {
    const { sim, dir, globals } = setup(426);
    const a = sim.addPlayer({ nick: 'A', profile: profile(), kinematic: true });
    sim.addPlayer({ nick: 'B', profile: profile(), kinematic: true });
    sim.setWanted(a, 5);
    dir.trigger('wanted', a);
    sim.down(a); // no killer: a police kill, drowning or an unattributed explosion all look like this
    expect(globals.some((e) => e.k === 'mostWantedEnd' && e.how === 'died' && e.amount === 0)).toBe(true);
    sim.step(0.1);
    expect(dir.get('wanted')).toBeUndefined();
  });
});

describe('escaping', () => {
  it('staying below 5★ for 60s continuously pays 50% of the bounty and ends the chase', () => {
    const { sim, dir, globals } = setup(430);
    const a = sim.addPlayer({ nick: 'A', profile: profile(), kinematic: true });
    sim.addPlayer({ nick: 'B', profile: profile(), kinematic: true });
    dir.trigger('wanted', a);
    sim.setWanted(a, 3);
    for (let i = 0; i < 59; i++) sim.step(1);
    expect(dir.get('wanted')).toBeDefined(); // not yet
    const before = a.profile.money;
    sim.step(1); // crosses the 60s mark
    expect(a.profile.money - before).toBe(150); // 50% of the starting $300 bounty
    expect(globals.some((e) => e.k === 'mostWantedEnd' && e.how === 'escaped' && e.amount === 150)).toBe(true);
    expect(dir.get('wanted')).toBeUndefined();
  });

  it('going back to 5★ resets the escape countdown', () => {
    const { sim, dir } = setup(431);
    const a = sim.addPlayer({ nick: 'A', profile: profile(), kinematic: true });
    sim.addPlayer({ nick: 'B', profile: profile(), kinematic: true });
    dir.trigger('wanted', a);
    sim.setWanted(a, 3);
    for (let i = 0; i < 45; i++) sim.step(1);
    sim.setWanted(a, 5); // resets the escape countdown
    sim.step(1);
    sim.setWanted(a, 3);
    for (let i = 0; i < 45; i++) sim.step(1); // 45s again: never 60 continuous seconds below 5★
    expect(dir.get('wanted')).toBeDefined();
  });
});

describe('leaving', () => {
  it('the target leaving the world ends the chase as left, with nothing paid', () => {
    const { sim, dir, globals } = setup(440);
    const a = sim.addPlayer({ nick: 'A', profile: profile(), kinematic: true });
    sim.addPlayer({ nick: 'B', profile: profile(), kinematic: true });
    sim.setWanted(a, 5);
    dir.trigger('wanted', a);
    sim.removePlayer(a);
    expect(globals.some((e) => e.k === 'mostWantedEnd' && e.how === 'left' && e.amount === 0)).toBe(true);
  });
});
