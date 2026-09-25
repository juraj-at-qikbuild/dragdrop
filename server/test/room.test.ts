import { describe, expect, it } from 'vitest';
import { Room, GRACE_MS } from '../src/Room';
import { PROTOCOL_VERSION } from '../../src/shared/net/protocol';
import { Ent } from '../../src/shared/net/codec';
import { HitKind } from '../../src/shared/sim/Combat';
import { FakeClock, FakeLink, TOKEN_A, TOKEN_B, TOKEN_C, loadWorld, stateMsg } from './helpers';

function setup() {
  const clock = new FakeClock();
  const room = new Room({ world: loadWorld(), now: clock.now, seed: 42, debug: true });
  const join = (token: string, nick: string, resume?: { x: number; y: number }) => {
    const link = new FakeLink();
    const conn = room.onJoin(link);
    room.onMessage(conn, JSON.stringify({ t: 'hello', v: PROTOCOL_VERSION, token, nick, resume: resume && { ...resume, lvl: 0, car: 0 } }));
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

const idsOf = (link: FakeLink, type: Ent) => {
  const seen = new Set<number>();
  for (const s of link.snapshots()) {
    for (const e of s.ents) if (e.type === type) seen.add(e.id);
    for (const g of s.gone) seen.delete(g);
  }
  return seen;
};

describe('Room', () => {
  it('welcomes a valid hello with a player and a figure', () => {
    const { join } = setup();
    const a = join(TOKEN_A, 'Jožo');
    const w = a.link.last('welcome');
    expect(w.v).toBe(PROTOCOL_VERSION);
    expect(w.id).toBeGreaterThan(0);
    expect(w.ped).toBeGreaterThan(0);
    expect(w.nick).toBe('Jožo');
    expect(a.link.last('profile').money).toBe(0);
  });

  it('rejects a protocol version mismatch and bad hellos', () => {
    const { room } = setup();
    const link = new FakeLink();
    room.onMessage(room.onJoin(link), JSON.stringify({ t: 'hello', v: PROTOCOL_VERSION + 99, token: TOKEN_A, nick: 'Jožo' }));
    expect(link.last('error').code).toBe('version');
    for (const [token, nick] of [['nope', 'Jožo'], [TOKEN_A, 'x'], [TOKEN_A, '<script>']]) {
      const l = new FakeLink();
      room.onMessage(room.onJoin(l), JSON.stringify({ t: 'hello', v: PROTOCOL_VERSION, token, nick }));
      expect(l.last('error').code).toBe('bad-hello');
    }
  });

  it('two nearby players see each other and share the same NPCs', () => {
    const { room, join, tick } = setup();
    const a = join(TOKEN_A, 'Anna');
    const b = join(TOKEN_B, 'Boris');
    room.onMessage(a.conn, stateMsg(a.x!, a.y!));
    room.onMessage(b.conn, stateMsg(b.x!, b.y!));
    tick(40);
    const aPeds = idsOf(a.link, Ent.Ped), bPeds = idsOf(b.link, Ent.Ped);
    expect(aPeds.has(b.ped!)).toBe(true);
    expect(bPeds.has(a.ped!)).toBe(true);
    expect(aPeds.has(a.ped!)).toBe(false);
    // the city around them is the same city
    const shared = [...aPeds].filter((id) => bPeds.has(id));
    expect(shared.length).toBeGreaterThan(40);
    const aCars = idsOf(a.link, Ent.Vehicle), bCars = idsOf(b.link, Ent.Vehicle);
    expect([...aCars].filter((id) => bCars.has(id)).length).toBeGreaterThan(20);
  });

  it('far apart players do not see each other', () => {
    const { room, join, tick } = setup();
    const a = join(TOKEN_A, 'Anna');
    const c = join(TOKEN_C, 'Cyril', { x: 900, y: 600 });
    room.onMessage(a.conn, stateMsg(a.x!, a.y!));
    room.onMessage(c.conn, stateMsg(c.x!, c.y!));
    tick(5);
    expect(idsOf(a.link, Ent.Ped).has(c.ped!)).toBe(false);
  });

  it('a shot NPC dies for everyone', () => {
    const { room, join, tick } = setup();
    const a = join(TOKEN_A, 'Anna');
    const b = join(TOKEN_B, 'Boris');
    room.onMessage(a.conn, stateMsg(a.x!, a.y!));
    room.onMessage(b.conn, stateMsg(b.x!, b.y!));
    tick(20);
    // pick a live civilian both can see
    const victim = room.sim.peds.find((p) => p.kind === 'civ' && !p.dead && !p.vehicle && idsOf(b.link, Ent.Ped).has(p.id))!;
    expect(victim).toBeDefined();
    room.onMessage(a.conn, JSON.stringify({ t: 'debug', give: 'pistol' }));
    // stand next to it and shoot
    const ax = victim.x - 3, ay = victim.y;
    const sp = room.sim.players.get(a.id!)!;
    sp.ped.x = ax;
    sp.ped.y = ay;
    for (let i = 0; i < 3 && !victim.dead; i++) {
      room.onMessage(a.conn, JSON.stringify({ t: 'fire', w: 'pistol', ox: ax + 0.5, oy: ay, a: 0, lvl: 0, rt: 0, pellets: [{ a: 0, kind: HitKind.Ped, hit: victim.id, hx: victim.x - 0.3, hy: victim.y }] }));
      tick(8);
    }
    expect(victim.dead).toBe(true);
    // B's latest record for that ped says dead
    let state = '';
    for (const s of b.link.snapshots()) for (const e of s.ents) if (e.id === victim.id && e.type === Ent.Ped) state = e.v.state;
    expect(state).toBe('dead');
    expect(room.sim.players.get(a.id!)!.wanted).toBeGreaterThanOrEqual(1);
  });

  it('keeps a disconnected player for the grace period and resumes them on reconnect', () => {
    const { room, join, tick, clock } = setup();
    const a = join(TOKEN_A, 'Anna');
    const b = join(TOKEN_B, 'Boris');
    room.onMessage(a.conn, stateMsg(a.x!, a.y!));
    room.onMessage(b.conn, stateMsg(b.x!, b.y!));
    tick(3);
    room.onLeave(b.conn);
    tick(3);
    expect(idsOf(a.link, Ent.Ped).has(b.ped!)).toBe(true);
    clock.advance(GRACE_MS / 2);
    const b2 = join(TOKEN_B, 'Boris');
    expect(b2.id).toBe(b.id);
    expect(b2.ped).toBe(b.ped);
    room.onLeave(b2.conn);
    clock.advance(GRACE_MS + 1000);
    tick(2);
    expect(idsOf(a.link, Ent.Ped).has(b.ped!)).toBe(false);
    expect(room.sim.players.has(b.id!)).toBe(false);
  });

  it('a second connection with the same token takes over', () => {
    const { join } = setup();
    const a1 = join(TOKEN_A, 'Anna');
    const a2 = join(TOKEN_A, 'Anna');
    expect(a1.link.last('bye').reason).toBe('replaced');
    expect(a1.link.closed).not.toBeNull();
    expect(a2.id).toBe(a1.id);
  });

  it('rejects teleports with a correction', () => {
    const { room, join, tick } = setup();
    const a = join(TOKEN_A, 'Anna');
    room.onMessage(a.conn, stateMsg(a.x!, a.y!));
    tick();
    room.onMessage(a.conn, stateMsg(a.x! + 300, a.y!));
    const c = a.link.last('correct');
    expect(c.x).toBeCloseTo(a.x!, 1);
    expect(c.y).toBeCloseTo(a.y!, 1);
  });

  it('lets a player take a parked car and drive it', () => {
    const { room, join, tick } = setup();
    const a = join(TOKEN_A, 'Anna');
    room.onMessage(a.conn, stateMsg(a.x!, a.y!));
    tick(10);
    const car = room.sim.vehicles.find((v) => v.parked && !v.driver)!;
    const p = room.sim.players.get(a.id!)!;
    const x = car.x + Math.sin(car.angle) * 2, y = car.y - Math.cos(car.angle) * 2;
    p.ped.x = x;
    p.ped.y = y;
    room.onMessage(a.conn, JSON.stringify({ t: 'enter', vid: car.id }));
    tick();
    expect(a.link.json('ev').flatMap((m) => m.p).some((e) => e.k === 'enter' && e.ok && e.vehicle === car.id)).toBe(true);
    expect(car.owner).toBe(a.id);
    expect(car.kinematic).toBe(true);
    room.onMessage(a.conn, JSON.stringify({ t: 'exit', x, y, veh: { x: car.x, y: car.y, a: car.angle, vx: 0, vy: 0, av: 0, hp: car.health, dmg: [0, 0, 0, 0], fire: -1, tyres: 0, nitro: 1, lvl: 0 } }));
    expect(car.owner).toBe(0);
    expect(car.kinematic).toBe(false);
  });

  it('rate-limits state spam and closes abusive connections', () => {
    const { room, join } = setup();
    const a = join(TOKEN_A, 'Anna');
    for (let i = 0; i < 300; i++) room.onMessage(a.conn, stateMsg(a.x!, a.y!));
    expect(a.link.closed?.code).toBe(1008);
  });
});
