import { describe, expect, it } from 'vitest';
import { Room, GRACE_MS } from '../src/Room';
import { PROTOCOL_VERSION, type StateMsg } from '../../src/shared/net/protocol';
import { FakeClock, FakeLink, TOKEN_A, TOKEN_B, TOKEN_C } from './helpers';

const bounds = { x0: -2000, y0: -2000, x1: 2000, y1: 2000 };

function state(x: number, y: number, extra: Partial<StateMsg> = {}): string {
  const s: StateMsg = { t: 'state', seq: 1, ep: 0, x, y, a: 0, vx: 0, vy: 0, lvl: 0, w: 'fist', hp: 100, wanted: 0, dead: 0, hw: 20, hh: 12, veh: null, ...extra };
  return JSON.stringify(s);
}

function setup() {
  const clock = new FakeClock();
  const room = new Room({ bounds, now: clock.now });
  const join = (token: string, nick: string) => {
    const link = new FakeLink();
    const conn = room.onJoin(link);
    room.onMessage(conn, JSON.stringify({ t: 'hello', v: PROTOCOL_VERSION, token, nick }));
    return { link, conn };
  };
  const tick = () => {
    clock.advance(50);
    room.tick(50);
  };
  return { clock, room, join, tick };
}

describe('Room', () => {
  it('welcomes a valid hello', () => {
    const { join } = setup();
    const a = join(TOKEN_A, 'Jožo');
    const w = a.link.last('welcome');
    expect(w.v).toBe(PROTOCOL_VERSION);
    expect(w.id).toBeGreaterThan(0);
    expect(w.nick).toBe('Jožo');
  });

  it('rejects a protocol version mismatch', () => {
    const { room } = setup();
    const link = new FakeLink();
    const conn = room.onJoin(link);
    room.onMessage(conn, JSON.stringify({ t: 'hello', v: PROTOCOL_VERSION + 99, token: TOKEN_A, nick: 'Jožo' }));
    expect(link.last('error').code).toBe('version');
    expect(link.closed).not.toBeNull();
  });

  it('rejects bad tokens and nicknames', () => {
    const { room } = setup();
    for (const [token, nick] of [['nope', 'Jožo'], [TOKEN_A, 'x'], [TOKEN_A, '<script>']]) {
      const link = new FakeLink();
      room.onMessage(room.onJoin(link), JSON.stringify({ t: 'hello', v: PROTOCOL_VERSION, token, nick }));
      expect(link.last('error').code).toBe('bad-hello');
    }
  });

  it('two nearby players see each other; far players do not', () => {
    const { room, join, tick } = setup();
    const a = join(TOKEN_A, 'Anna');
    const b = join(TOKEN_B, 'Boris');
    const c = join(TOKEN_C, 'Cyril');
    room.onMessage(a.conn, state(0, 0));
    room.onMessage(b.conn, state(50, 0));
    room.onMessage(c.conn, state(1500, 0));
    tick();
    const sa = a.link.last('snap');
    expect(sa.ps.map((p) => p.nick)).toEqual(['Boris']);
    expect(b.link.last('snap').ps.map((p) => p.nick)).toEqual(['Anna']);
    expect(c.link.last('snap').ps).toEqual([]);
  });

  it('sends a removal when a player leaves the interest area', () => {
    const { room, join, tick, clock } = setup();
    const a = join(TOKEN_A, 'Anna');
    const b = join(TOKEN_B, 'Boris');
    room.onMessage(a.conn, state(0, 0));
    room.onMessage(b.conn, state(100, 0));
    tick();
    const bid = b.link.last('welcome').id;
    expect(a.link.last('snap').ps[0].id).toBe(bid);
    // drive away in a car, one plausible step at a time
    let x = 100;
    for (let i = 0; i < 20; i++) {
      x += 20;
      clock.advance(500);
      room.onMessage(b.conn, state(x, 0, { veh: veh(x, 0) }));
    }
    tick();
    expect(a.link.last('snap').gone).toContain(bid);
  });

  it('rejects teleports but accepts a new epoch (respawn)', () => {
    const { room, join, tick } = setup();
    const a = join(TOKEN_A, 'Anna');
    const b = join(TOKEN_B, 'Boris');
    room.onMessage(a.conn, state(0, 0));
    room.onMessage(b.conn, state(10, 0));
    tick();
    room.onMessage(b.conn, state(10, 500));
    expect(b.link.last('correct')).toMatchObject({ x: 10, y: 0 });
    room.onMessage(b.conn, state(10, 200, { ep: 1 }));
    tick();
    const snap = a.link.last('snap');
    expect(snap.ps[0].y).toBe(200);
  });

  it('keeps a disconnected player during the grace period and resumes on reconnect', () => {
    const { room, join, tick, clock } = setup();
    const a = join(TOKEN_A, 'Anna');
    const b = join(TOKEN_B, 'Boris');
    room.onMessage(a.conn, state(0, 0));
    room.onMessage(b.conn, state(20, 0));
    tick();
    const bid = b.link.last('welcome').id;
    room.onLeave(b.conn);
    tick();
    expect(a.link.last('snap').ps.map((p) => p.id)).toEqual([bid]);
    clock.advance(GRACE_MS / 2);
    const b2 = join(TOKEN_B, 'Boris');
    expect(b2.link.last('welcome').id).toBe(bid);
    // and removal after the grace period expires
    room.onLeave(b2.conn);
    clock.advance(GRACE_MS + 1000);
    tick();
    expect(a.link.last('snap').gone).toContain(bid);
    expect(room.players.has(bid)).toBe(false);
  });

  it('a second connection with the same token takes over', () => {
    const { join } = setup();
    const a1 = join(TOKEN_A, 'Anna');
    const a2 = join(TOKEN_A, 'Anna');
    expect(a1.link.last('bye').reason).toBe('replaced');
    expect(a1.link.closed).not.toBeNull();
    expect(a2.link.last('welcome').id).toBe(a1.link.last('welcome').id);
  });

  it('relays shots to nearby players only, not back to the shooter', () => {
    const { room, join, tick } = setup();
    const a = join(TOKEN_A, 'Anna');
    const b = join(TOKEN_B, 'Boris');
    room.onMessage(a.conn, state(0, 0));
    room.onMessage(b.conn, state(30, 0));
    tick();
    room.onMessage(a.conn, JSON.stringify({ t: 'shot', w: 'pistol', x: 0.5, y: 0, a: 0, lvl: 0, ends: [20, 0] }));
    tick();
    expect(b.link.last('ev').e[0]).toMatchObject({ k: 'shot', w: 'pistol' });
    expect(a.link.json('ev')).toHaveLength(0);
  });

  it('rate-limits state spam and closes abusive connections', () => {
    const { room, join } = setup();
    const a = join(TOKEN_A, 'Anna');
    for (let i = 0; i < 200; i++) room.onMessage(a.conn, state(0, 0));
    expect(a.link.closed?.code).toBe(1008);
  });
});

function veh(x: number, y: number) {
  return { k: 'sedan', c: '#263238', x, y, a: 0, vx: 40, vy: 0, av: 0, st: 0, th: 1, f: 0, hp: 110, dmg: [0, 0, 0, 0] as [number, number, number, number], sk: 0, sink: 0, fire: -1 };
}
