// The Revive rule (src/shared/sim/rules/Revive.ts): standing near a downed player revives them at
// 40 HP and pays the "Dobrý samaritán" bonus, with anti-farm limits; Sim.bust also accepts a downed
// wanted player (the AI.ts cop-on-foot side of this is exercised through the real ped graph, which
// makes it awkward to drive deterministically in a unit test — see the note on that test below).
// Plan: docs/plans/social-events.md ("Revive")
import { describe, expect, it } from 'vitest';
import { DOWNED_BLEED, Sim } from '../../src/shared/sim/Sim';
import { Rng } from '../../src/shared/util/Rng';
import { Vehicle } from '../../src/shared/entities/Vehicle';
import { nullEvents, type GlobalEvent, type PrivateEvent } from '../../src/shared/sim/events';
import { loadWorld } from './helpers';

/** every landmark pre-"found": players spawn near Hlavné námestie (a landmark), and the unrelated
 *  €100 discovery reward would otherwise land on top of this file's own payout assertions */
const allFound = () => [...loadWorld().landmarks.values()].map((l) => l.id);
const profile = () => ({ money: 0, done: [], found: allFound(), cumils: [] });
/** an all-zero cap set: no NPC ever spawns, so a downed/revive scenario stays fully deterministic */
const NO_NPCS = { traffic: 0, parked: 0, peds: 0, trams: 0, police: 0, helis: 0, roadblocks: 0 };

/** a real-map Sim with downing and the Revive rule on ('server' rules mode), capturing every
 *  private and global event it sends */
function setup(seed: number) {
  const priv: [number, PrivateEvent][] = [];
  const globals: GlobalEvent[] = [];
  const sim = new Sim(loadWorld(), {
    rng: new Rng(seed), downed: true, caps: NO_NPCS, rules: 'server',
    events: { ...nullEvents, toPlayer: (pid, e) => priv.push([pid, e]), global: (e) => globals.push(e) },
  });
  return { sim, priv, globals };
}

/** stand `b` `m` metres from `a`, same spot, same level */
function place(a: { ped: { x: number; y: number } }, b: { ped: { x: number; y: number } }, m: number) {
  b.ped.x = a.ped.x + m;
  b.ped.y = a.ped.y;
}

describe('Revive', () => {
  it('a reviver standing 1.5 m away for 3 s revives the downed player at 40 HP and pays the bonus', () => {
    const { sim, globals } = setup(301);
    const a = sim.addPlayer({ nick: 'A', profile: profile(), kinematic: true });
    const b = sim.addPlayer({ nick: 'B', profile: profile(), kinematic: true });
    sim.down(a);
    place(a, b, 1.5);
    for (let i = 0; i < 61; i++) sim.step(0.05); // 3.05 s
    expect(a.state).toBe('play');
    expect(a.ped.health).toBe(40);
    expect(a.ped.downed).toBe(false);
    expect(b.profile.money).toBe(100);
    expect(globals.some((e) => e.k === 'revived' && e.by === 'B' && e.who === 'A')).toBe(true);
  });

  it('walking away resets the revive progress: a discontiguous 2 s + 2 s is not enough', () => {
    const { sim } = setup(302);
    const a = sim.addPlayer({ nick: 'A', profile: profile(), kinematic: true });
    const b = sim.addPlayer({ nick: 'B', profile: profile(), kinematic: true });
    sim.down(a);
    place(a, b, 1.5);
    for (let i = 0; i < 40; i++) sim.step(0.05); // 2 s: not yet revived
    expect(a.state).toBe('downed');
    b.ped.x = a.ped.x + 50; // walk far away: progress resets
    sim.step(0.05);
    place(a, b, 1.5); // come back
    for (let i = 0; i < 40; i++) sim.step(0.05); // another 2 s: still not enough on its own
    expect(a.state).toBe('downed');
    for (let i = 0; i < 21; i++) sim.step(0.05); // just over the third second completes the fresh 3 s
    expect(a.state).toBe('play');
  });

  it('a reviver sitting in a car does not count, even within range', () => {
    const { sim } = setup(303);
    const a = sim.addPlayer({ nick: 'A', profile: profile(), kinematic: true });
    const b = sim.addPlayer({ nick: 'B', profile: profile(), kinematic: true });
    sim.down(a);
    place(a, b, 1.5);
    const car = sim.addVehicle(new Vehicle('sedan', b.ped.x, b.ped.y, 0, '#fff'));
    expect(sim.enterVehicle(b, car, 10)).toBe(true);
    for (let i = 0; i < 80; i++) sim.step(0.05); // 4 s: plenty, if it counted
    expect(a.state).toBe('downed');
  });

  describe('anti-farm', () => {
    it('pays the bonus only once per pair within the cooldown', () => {
      const { sim } = setup(304);
      const a = sim.addPlayer({ nick: 'A', profile: profile(), kinematic: true });
      const b = sim.addPlayer({ nick: 'B', profile: profile(), kinematic: true });
      sim.down(a);
      place(a, b, 1.5);
      for (let i = 0; i < 61; i++) sim.step(0.05);
      expect(a.state).toBe('play');
      expect(b.profile.money).toBe(100);
      sim.down(a); // downed again, same reviver right there
      for (let i = 0; i < 61; i++) sim.step(0.05);
      expect(a.state).toBe('play'); // revived again…
      expect(b.profile.money).toBe(100); // …but no second bonus (600 s pair cooldown)
    });

    it('no bonus when the reviver hurt the victim within the last 60 s', () => {
      const { sim, priv } = setup(305);
      const a = sim.addPlayer({ nick: 'A', profile: profile(), kinematic: true });
      const b = sim.addPlayer({ nick: 'B', profile: profile(), kinematic: true });
      sim.hurtPlayer(a, 10, b.ped.x, b.ped.y, b.id); // b hurt a moments ago (not lethal)
      sim.down(a); // a goes down some other way
      place(a, b, 1.5);
      for (let i = 0; i < 61; i++) sim.step(0.05);
      expect(a.state).toBe('play'); // still revived…
      expect(b.profile.money).toBe(0); // …just no bonus
      expect(priv.some(([pid, e]) => pid === b.id && e.k === 'msg')).toBe(true); // told why
    });

    it('no bonus once the reviver has already been paid 10 times in the last hour', () => {
      const { sim } = setup(306);
      const b = sim.addPlayer({ nick: 'B', profile: profile(), kinematic: true });
      for (let i = 0; i < 11; i++) {
        const v = sim.addPlayer({ nick: 'V' + i, profile: profile(), kinematic: true });
        v.ped.x = b.ped.x = 100 + i * 20;
        v.ped.y = b.ped.y = 100;
        sim.down(v);
        for (let t = 0; t < 61; t++) sim.step(0.05);
        expect(v.state).toBe('play'); // always revived, whether or not the bonus is paid
      }
      expect(b.profile.money).toBe(1000); // 10 × €100; the 11th pair got no bonus
    });
  });

  it('bleed-out still happens normally with the Revive rule registered', () => {
    const { sim } = setup(307);
    const a = sim.addPlayer({ nick: 'A', profile: { ...profile(), money: 500 }, kinematic: false });
    sim.down(a);
    expect(a.stateTimer).toBe(DOWNED_BLEED);
    for (let t = 0; t < DOWNED_BLEED + 0.5; t += 0.1) sim.step(0.1);
    expect(a.state).toBe('wasted');
    for (let t = 0; t < 4.5; t += 0.1) sim.step(0.1);
    expect(a.state).toBe('play');
    expect(a.ped.downed).toBe(false);
  });

  // A cop actually walking up to a downed player exercises AI.ts's ped-graph pathing (copOnFoot),
  // which needs a full traffic/police simulation to drive deterministically; Sim.bust is the part
  // Revive itself owns, so it's what's unit-tested here (AI.ts's copTarget/copOnFoot changes are
  // the few lines that route a downed, wanted player into the same call).
  it('Sim.bust accepts a downed player, busting them and clearing the downed flag', () => {
    const { sim } = setup(308);
    const a = sim.addPlayer({ nick: 'A', profile: profile(), kinematic: true });
    sim.down(a);
    a.wanted = 3;
    expect(a.ped.downed).toBe(true);
    sim.bust(a);
    expect(a.state).toBe('busted');
    expect(a.ped.downed).toBe(false);
    expect(a.stateTimer).toBe(4);
  });

  it('tells the reviver too when the revive in progress is cut short, not just the downed player', () => {
    // both a bust and a finishing blow (sim.wasted — the same call bleeding out makes on its own
    // timeout) end the downed period without going through Revive's own success path in step(), which
    // is the only place that used to send the reviver their own final {s: null}
    for (const end of ['bust', 'wasted'] as const) {
      const { sim, priv } = setup(end === 'bust' ? 309 : 310);
      const a = sim.addPlayer({ nick: 'A', profile: profile(), kinematic: true });
      const b = sim.addPlayer({ nick: 'B', profile: profile(), kinematic: true });
      sim.down(a);
      place(a, b, 1.5);
      sim.step(0.05); // one tick: b is now mid-revive on a
      expect(priv.some(([pid, e]) => pid === b.id && e.k === 'revive' && e.s !== null), end).toBe(true); // sanity: in progress

      if (end === 'bust') sim.bust(a);
      else sim.wasted(a); // a finishing blow (bleeding out reaches sim.wasted the same way, on its own timer)
      expect(priv.some(([pid, e]) => pid === b.id && e.k === 'revive' && e.s === null), end).toBe(true);
    }
  });
});
