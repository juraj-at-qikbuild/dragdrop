// Phase-0 contracts of the social features (docs/plans/social-events.md): the v7 wire bits, the
// world-event director, payouts and teleports, and the boot links.
import { describe, expect, it } from 'vitest';
import {
  Ent, Reader, Writer, decodeSnapshot, encodeSnapshotHeader, entityHead, pedDynamic, pedStatic, pickupStatic, vehicleDynamic, vehicleStatic,
} from '../../src/shared/net/codec';
import { LIVERY_ARMORED, Vehicle } from '../../src/shared/entities/Vehicle';
import { Ped } from '../../src/shared/entities/Ped';
import { Sim } from '../../src/shared/sim/Sim';
import { Rng } from '../../src/shared/util/Rng';
import { TimedEvent, type WorldEventDef, type WorldEvents } from '../../src/shared/sim/rules/WorldEvents';
import type { EventEntry } from '../../src/shared/sim/rules/types';
import type { PrivateEvent } from '../../src/shared/sim/events';
import { nullEvents } from '../../src/shared/sim/events';
import { parseBootLinks } from '../../src/boot/links';
import { loadWorld } from './helpers';

const profile = () => ({ money: 0, done: [], found: [], cumils: [] });

describe('v7 wire bits', () => {
  it('carries the downed state, liveries, the downed flag and the golden Čumil', () => {
    const w = new Writer(16);
    encodeSnapshotHeader(w, 1, 1000, 0, { health: 0, armor: 0, wanted: 0, state: 'downed', stateTimer: 20, searching: false, shotCops: false, money: 5, ammo: [0, 0, 0], epoch: 1, zone: null });
    w.u16(3);
    const v = new Vehicle('van', 10, 20, 0, '#ffffff');
    v.id = 7;
    v.mission = true;
    v.livery = LIVERY_ARMORED;
    entityHead(w, v.id, Ent.Vehicle, true, 0);
    vehicleStatic(w, v, true);
    vehicleDynamic(w, v);
    const p = new Ped('player', 1, 2, 3);
    p.id = 8;
    p.playerId = 2;
    p.downed = true;
    entityHead(w, p.id, Ent.Ped, true, 0);
    pedStatic(w, p);
    pedDynamic(w, p, 5);
    entityHead(w, 9, Ent.Pickup, true, 0);
    pickupStatic(w, { id: 9, x: 5, y: 6, kind: 'goldenCumil', amount: 600, respawn: 0, hidden: 0, cumil: -1 });
    w.u16(0);
    const s = decodeSnapshot(new Reader(w.finish()));
    expect(s.me.state).toBe('downed');
    const [ve, pe, pk] = s.ents;
    expect(ve.type === Ent.Vehicle && ve.v.livery).toBe(LIVERY_ARMORED);
    expect(ve.type === Ent.Vehicle && ve.v.mission && ve.v.swat).toBe(true);
    expect(pe.type === Ent.Ped && pe.v.downed).toBe(true);
    expect(pe.type === Ent.Ped && pe.v.stars).toBe(5);
    expect(pk.type === Ent.Pickup && pk.v?.kind).toBe('goldenCumil');
  });
});

/** a do-nothing event that lasts `live` seconds after a 5 s announcement */
class TestEvent extends TimedEvent {
  update(dt: number) {
    this.tick(dt);
    return !(this.phase === 'live' && this.left <= 0);
  }
  entry(): EventEntry {
    return { id: this.id, kind: this.kind, phase: this.phase, left: this.left };
  }
  stop() {}
}

const testDef = (over: Partial<WorldEventDef> = {}): WorldEventDef => ({
  kind: 'cumil', minPlayers: 1, offline: true, scheduled: true, weight: 1, cooldown: 60,
  create: (sim, dir, id) => new TestEvent(sim, dir, id, 'cumil', 5, 30),
  ...over,
});

describe('world-event director', () => {
  it('schedules an event, runs its phases and ends it', () => {
    const sim = new Sim(loadWorld(), { rng: new Rng(3), rules: 'offline' });
    sim.addPlayer({ nick: 'A', profile: profile(), kinematic: false });
    const dir = sim.rule<WorldEvents>('worldEvents')!;
    expect(dir).toBeDefined();
    dir.register(testDef());
    dir.config.first = [1, 1];
    (dir as unknown as { timer: number }).timer = 1;
    const v0 = dir.version;
    for (let i = 0; i < 30; i++) dir.step(0.05);
    expect(dir.active.length).toBe(1);
    expect(dir.entries()[0].phase).toBe('announce');
    expect(dir.version).toBeGreaterThan(v0);
    for (let i = 0; i < 120; i++) dir.step(0.05);
    expect(dir.entries()[0].phase).toBe('live');
    for (let i = 0; i < 700; i++) dir.step(0.05);
    expect(dir.active.length).toBe(0);
  });

  it('respects the player count online and runs only offline kinds in single-player', () => {
    const sim = new Sim(loadWorld(), { rng: new Rng(4), rules: 'server' });
    const dir = sim.rule<WorldEvents>('worldEvents')!;
    dir.register(testDef({ minPlayers: 2 }));
    (dir as unknown as { timer: number }).timer = 0;
    dir.step(0.05);
    expect(dir.active.length).toBe(0);
    const off = new Sim(loadWorld(), { rng: new Rng(5), rules: 'offline' });
    off.addPlayer({ nick: 'A', profile: profile(), kinematic: false });
    const d2 = off.rule<WorldEvents>('worldEvents')!;
    d2.register(testDef({ offline: false }));
    (d2 as unknown as { timer: number }).timer = 0;
    d2.step(0.05);
    expect(d2.active.length).toBe(0);
  });

  it('trigger() starts a kind only once', () => {
    const sim = new Sim(loadWorld(), { rng: new Rng(6), rules: 'server' });
    const dir = sim.rule<WorldEvents>('worldEvents')!;
    dir.register(testDef({ kind: 'wanted', scheduled: false, create: (s, d, id) => new TestEvent(s, d, id, 'wanted', 0, 30) }));
    expect(dir.trigger('wanted')).not.toBeNull();
    expect(dir.trigger('wanted')).toBeNull();
    expect(dir.entries()[0].phase).toBe('live');
  });
});

describe('payout and teleport', () => {
  it('pays through the policy, tells each recipient and marks their profile for saving', () => {
    const got: [number, PrivateEvent][] = [];
    const sim = new Sim(loadWorld(), { rng: new Rng(8), events: { ...nullEvents, toPlayer: (pid, e) => got.push([pid, e]) } });
    const a = sim.addPlayer({ nick: 'A', profile: profile(), kinematic: true });
    const b = sim.addPlayer({ nick: 'B', profile: profile(), kinematic: true });
    const saved: string[] = [];
    sim.onProfileChange = (p) => saved.push(p.nick);
    sim.payout(a, 100, 'kofolka', 1, 2);
    expect(a.profile.money).toBe(100);
    sim.payoutPolicy = (p, amount) => [{ p, amount: amount / 2 }, { p: b, amount: amount / 2 }];
    sim.payout(a, 100, 'kofolka', 1, 2);
    expect(a.profile.money).toBe(150);
    expect(b.profile.money).toBe(50);
    expect(saved).toEqual(['A', 'A', 'B']);
    const payouts = got.filter(([, e]) => e.k === 'payout');
    expect(payouts.length).toBe(3);
    sim.payout(a, -5, 'tip');
    expect(a.profile.money).toBe(150);
  });

  it('teleports a player with a new epoch', () => {
    const got: PrivateEvent[] = [];
    const sim = new Sim(loadWorld(), { rng: new Rng(9), events: { ...nullEvents, toPlayer: (_pid, e) => got.push(e) } });
    const a = sim.addPlayer({ nick: 'A', profile: profile(), kinematic: true });
    const l = sim.world.landmark('eurovea');
    const to = sim.world.walkableNear(l.x, l.y - 40);
    const e0 = a.epoch;
    sim.teleport(a, to.x, to.y, 0);
    expect(a.epoch).toBe((e0 + 1) & 0xff);
    expect(Math.hypot(a.ped.x - to.x, a.ped.y - to.y)).toBeLessThan(15);
    expect(got.some((e) => e.k === 'teleport' && e.epoch === a.epoch)).toBe(true);
  });
});

describe('boot links', () => {
  it('reads online play, invite codes, photo mode and account returns', () => {
    expect(parseBootLinks('#online', '').online).toBe(true);
    expect(parseBootLinks('#join=fero-k3x9q2', '').join).toBe('k3x9q2');
    expect(parseBootLinks('#join=K3X9Q2', '').join).toBe('k3x9q2');
    expect(parseBootLinks('#join=Jožko Mrkvička-abcd12', '').join).toBe('abcd12');
    expect(parseBootLinks('#join=', '').join).toBeNull();
    expect(parseBootLinks('', '?photo').photo).toBe(true);
    expect(parseBootLinks('', '?code=abc').authCallback).toBe(true);
    expect(parseBootLinks('', '?reset=1').reset).toBe(true);
  });
});
