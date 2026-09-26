// Horúca Kofolka, Hon na Čumila and Obrnené auto through the Room: the debug-started event reaches
// clients via `wev`, money accrues to whoever drives the Kofolka van, the golden Čumil is snapshotted
// only within 40 m, and the armoured van's livery reaches the snapshot too.
// Plan: docs/plans/social-events.md
import { describe, expect, it } from 'vitest';
import { Room, type RoomOptions } from '../src/Room';
import { PROTOCOL_VERSION } from '../../src/shared/net/protocol';
import { Ent } from '../../src/shared/net/codec';
import { LIVERY_ARMORED, LIVERY_DERBY, LIVERY_KOFOLKA } from '../../src/shared/entities/Vehicle';
import { FakeClock, FakeLink, TOKEN_A, TOKEN_B, loadWorld, stateMsg } from './helpers';

function setup(extra: Partial<RoomOptions> = {}) {
  const clock = new FakeClock();
  const room = new Room({ world: loadWorld(), now: clock.now, wallClock: clock.now, seed: 7, debug: true, ...extra });
  const join = (token: string, nick: string) => {
    const link = new FakeLink();
    const conn = room.onJoin(link);
    room.onMessage(conn, JSON.stringify({ t: 'hello', v: PROTOCOL_VERSION, token, nick }));
    const w = link.last('welcome');
    return { link, conn, id: w?.id, ped: w?.ped, x: w?.x, y: w?.y };
  };
  const tick = (n = 1) => {
    for (let i = 0; i < n; i++) {
      clock.advance(50);
      room.tick(50);
    }
  };
  return { clock, room, join, tick };
}

describe('Horúca Kofolka through the Room', () => {
  it('debug{event:"kofolka"} with 2 players starts it, and wev lists it', () => {
    const { room, join, tick } = setup();
    const a = join(TOKEN_A, 'Anna');
    join(TOKEN_B, 'Boris');
    room.onMessage(a.conn, JSON.stringify({ t: 'debug', event: 'kofolka' }));
    tick(5); // the debounced wev broadcast fires within ~150 ms of a version bump
    const wev = a.link.last('wev');
    expect(wev).toBeTruthy();
    expect(wev.ev.some((e) => e.kind === 'kofolka')).toBe(true);
    expect(room.sim.vehicles.some((v) => v.livery === LIVERY_KOFOLKA)).toBe(true);
  });

  it('pays whoever drives the van, credited every second', () => {
    const { room, join, tick } = setup();
    const a = join(TOKEN_A, 'Anna');
    room.onMessage(a.conn, JSON.stringify({ t: 'debug', event: 'kofolka' }));
    const van = room.sim.vehicles.find((v) => v.livery === LIVERY_KOFOLKA)!;
    expect(van).toBeTruthy();
    tick(700); // past the 30 s announce (700 * 50 ms = 35 s), with margin
    const p = room.sim.players.get(a.id!)!;
    const before = p.profile.money;
    p.ped.x = van.x;
    p.ped.y = van.y;
    expect(room.sim.enterVehicle(p, van, 10)).toBe(true);
    tick(100); // 5 more seconds live
    expect(p.profile.money).toBeGreaterThan(before);
    expect(p.profile.money - before).toBe(50); // 5 s at $10/s
  });
});

describe('Derby na parkovisku through the Room', () => {
  it('debug{event:"derby"} starts it, and wev lists it with its arena zone', () => {
    const { room, join, tick } = setup();
    const a = join(TOKEN_A, 'Anna');
    join(TOKEN_B, 'Boris');
    room.onMessage(a.conn, JSON.stringify({ t: 'debug', event: 'derby' }));
    tick(5); // the debounced wev broadcast fires within ~150 ms of a version bump
    const wev = a.link.last('wev');
    expect(wev).toBeTruthy();
    const derby = wev.ev.find((e) => e.kind === 'derby');
    expect(derby).toBeTruthy();
    expect(derby!.phase).toBe('announce');
    expect(derby!.zone).toBeDefined();
    expect(derby!.zone!.length).toBeGreaterThanOrEqual(6); // >= 3 points
    expect(room.sim.vehicles.filter((v) => v.livery === LIVERY_DERBY).length).toBe(6);
  });
});

describe('Obrnené auto through the Room', () => {
  it('debug{event:"armored"} with 2 players puts an armored entry with a van id in wev', () => {
    const { room, join, tick } = setup();
    const a = join(TOKEN_A, 'Anna');
    join(TOKEN_B, 'Boris');
    room.onMessage(a.conn, JSON.stringify({ t: 'debug', event: 'armored' }));
    tick(5); // the debounced wev broadcast fires within ~150 ms of a version bump
    const wev = a.link.last('wev');
    expect(wev).toBeTruthy();
    const entry = wev.ev.find((e) => e.kind === 'armored');
    expect(entry).toBeTruthy();
    expect(entry!.vid).toBeGreaterThan(0);
    expect(room.sim.vehicles.some((v) => v.livery === LIVERY_ARMORED && v.id === entry!.vid)).toBe(true);
  });

  it('the van reaches the snapshot with the armoured livery', () => {
    const { room, join, tick } = setup();
    const a = join(TOKEN_A, 'Anna');
    room.onMessage(a.conn, JSON.stringify({ t: 'debug', event: 'armored' }));
    const van = room.sim.vehicles.find((v) => v.livery === LIVERY_ARMORED)!;
    expect(van).toBeTruthy();
    // the route's start bank is 300-1500 m out (beyond INTEREST_R): teleport Anna's figure right next
    // to the van (a stateMsg report of a jump that size would fail the server's anti-cheat move check)
    const p = room.sim.players.get(a.id!)!;
    p.ped.x = van.x;
    p.ped.y = van.y;
    tick(4); // an unchanged, already-known entity isn't resent every tick, so look across all of them
    let seenLivery: number | undefined;
    for (const s of a.link.snapshots())
      for (const e of s.ents) if (e.type === Ent.Vehicle && e.id === van.id && e.full) seenLivery = e.v.livery;
    expect(seenLivery).toBe(LIVERY_ARMORED);
  });
});

describe('Hon na Čumila snapshot interest', () => {
  it('leaves out a goldenCumil pickup beyond 40 m and includes one within it', () => {
    const { room, join, tick } = setup();
    const a = join(TOKEN_A, 'Anna');
    room.onMessage(a.conn, stateMsg(a.x!, a.y!));
    tick(2);
    const nearId = room.sim.ids.alloc(room.sim.time), farId = room.sim.ids.alloc(room.sim.time);
    room.sim.pickups.push(
      { id: nearId, x: a.x! + 10, y: a.y!, kind: 'goldenCumil', amount: 600, respawn: 0, hidden: 0, cumil: -1 }, // 10 m: within
      { id: farId, x: a.x! + 200, y: a.y!, kind: 'goldenCumil', amount: 600, respawn: 0, hidden: 0, cumil: -1 }, // 200 m: still < 300 m INTEREST_R, but beyond the 40 m cap
    );
    tick(4); // an unchanged, already-known entity isn't resent every tick, so look across all of them
    const ids = new Set<number>();
    for (const s of a.link.snapshots()) for (const e of s.ents) if (e.type === Ent.Pickup) ids.add(e.id);
    expect(ids.has(nearId)).toBe(true);
    expect(ids.has(farId)).toBe(false);
  });
});
