// The world-event director's plan (WorldEvents.schedule, sent to clients in `wev.up` for the Aktivity
// panel): what each kind needs, the cooldowns, the online-only kinds offline, and the version bumps
// that make the server resend it when who's around changes.
import { describe, expect, it } from 'vitest';
import { Sim } from '../../src/shared/sim/Sim';
import { Rng } from '../../src/shared/util/Rng';
import type { WorldEvents } from '../../src/shared/sim/rules/WorldEvents';
import { loadWorld } from './helpers';

const profile = () => ({ money: 0, done: [], found: [], cumils: [] });
const NO_NPCS = { traffic: 0, parked: 0, peds: 0, trams: 0, police: 0, helis: 0, roadblocks: 0 };

function setup(mode: 'server' | 'offline', players = 1) {
  const sim = new Sim(loadWorld(), { rng: new Rng(11), rules: mode, caps: NO_NPCS });
  const main = sim.world.landmark('main');
  const ps = Array.from({ length: players }, (_, i) => sim.addPlayer({ nick: `P${i}`, profile: profile(), kinematic: false, x: main.x + i * 20, y: main.y }));
  const dir = sim.rule<WorldEvents>('worldEvents')!;
  return { sim, dir, ps };
}

describe('world-event schedule', () => {
  it('online: every kind with the players it needs; the most wanted is not on the schedule', () => {
    const { dir } = setup('server');
    const s = dir.schedule();
    expect(s.on).toBe(true);
    expect(s.offline).toBe(false);
    expect(s.players).toBe(1);
    const k = Object.fromEntries(s.kinds.map((p) => [p.kind, p]));
    expect(Object.keys(k).sort()).toEqual(['armored', 'cumil', 'derby', 'kofolka', 'wanted']);
    expect([k.kofolka.min, k.cumil.min, k.armored.min, k.derby.min, k.wanted.min]).toEqual([2, 1, 2, 3, 2]);
    expect(k.wanted.sched).toBe(false);
    expect(s.kinds.filter((p) => p.sched).length).toBe(4);
    expect(s.kinds.every((p) => p.cd === 0 && !p.never)).toBe(true);
    // the first try comes 3–5 minutes after a (re)start
    expect(s.next).toBeGreaterThanOrEqual(3 * 60);
    expect(s.next).toBeLessThanOrEqual(5 * 60);
  });

  it('counts the next try down, and a kind that just ended has its cooldown left', () => {
    const { sim, dir } = setup('server');
    const next0 = dir.schedule().next;
    for (let i = 0; i < 10; i++) sim.step(1);
    expect(dir.schedule().next).toBe(next0 - 10);
    expect(dir.start('cumil')).not.toBeNull();
    dir.stopAll();
    const cd = () => dir.schedule().kinds.find((p) => p.kind === 'cumil')!.cd;
    expect(cd()).toBe(900);
    for (let i = 0; i < 60; i++) sim.step(1);
    expect(cd()).toBe(840);
    // the others never ran
    expect(dir.schedule().kinds.filter((p) => p.kind !== 'cumil').every((p) => p.cd === 0)).toBe(true);
  });

  it('offline: the online-only kinds never run, and player counts are not what holds the rest', () => {
    const { dir } = setup('offline');
    const s = dir.schedule();
    expect(s.offline).toBe(true);
    const never = s.kinds.filter((p) => p.never).map((p) => p.kind).sort();
    expect(never).toEqual(['derby', 'kofolka', 'wanted']);
    expect(s.kinds.filter((p) => !p.never).map((p) => p.kind).sort()).toEqual(['armored', 'cumil']);
  });

  it('says when the schedule is switched off', () => {
    const { dir } = setup('server');
    dir.config.enabled = false;
    expect(dir.schedule().on).toBe(false);
  });

  it('bumps the version when the player count or the switch changes, and only then', () => {
    const { sim, dir, ps } = setup('server', 2);
    sim.step(0.05); // the first step announces the starting count
    const v0 = dir.version;
    for (let i = 0; i < 20; i++) sim.step(0.05);
    expect(dir.version).toBe(v0); // nothing changed
    ps[1].away = true; // in the pause menu: doesn't count for events
    sim.step(0.05);
    expect(dir.version).toBe(v0 + 1);
    expect(dir.schedule().players).toBe(1);
    ps[1].away = false;
    sim.step(0.05);
    expect(dir.version).toBe(v0 + 2);
    expect(dir.schedule().players).toBe(2);
    dir.config.enabled = false;
    sim.step(0.05);
    expect(dir.version).toBe(v0 + 3);
    sim.removePlayer(ps[1]);
    sim.step(0.05);
    expect(dir.version).toBe(v0 + 4);
  });
});
