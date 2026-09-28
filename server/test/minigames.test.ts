// The mini-games through the Room (server/src/features/MiniGames.ts, docs/plans/minigames.md): the
// welcome says the server takes `mini`, a round started by one player shows up in everyone's `wev`
// to join, joining and the action key go through the message, and each player gets their own
// private `mini` state; a malformed message does nothing.
import { describe, expect, it } from 'vitest';
import { Room } from '../src/Room';
import { PROTOCOL_VERSION } from '../../src/shared/net/protocol';
import type { PrivateEvent } from '../../src/shared/sim/events';
import type { MiniState } from '../../src/shared/sim/rules/minigames/types';
import { FakeClock, FakeLink, TOKEN_A, TOKEN_B, disabledSupa, loadWorld } from './helpers';

function setup() {
  const clock = new FakeClock();
  const room = new Room({ world: loadWorld(), now: clock.now, wallClock: clock.now, seed: 42, debug: true, supa: disabledSupa() });
  const join = (token: string, nick: string) => {
    const link = new FakeLink();
    const conn = room.onJoin(link);
    room.onMessage(conn, JSON.stringify({ t: 'hello', v: PROTOCOL_VERSION, token, nick }));
    return { link, conn, send: (m: object) => room.onMessage(conn, JSON.stringify(m)) };
  };
  const tick = (n = 1) => {
    for (let i = 0; i < n; i++) {
      clock.advance(50);
      room.tick(50);
    }
  };
  return { room, join, tick };
}

/** the latest private `mini` state this link got */
function mini(link: FakeLink): MiniState | null | undefined {
  let s: MiniState | null | undefined;
  for (const m of link.json('ev')) for (const e of m.p as PrivateEvent[]) if (e.k === 'mini') s = e.s;
  return s;
}

describe('mini-games through the Room', () => {
  it('says so in the welcome, and runs a round two players share', () => {
    const { join, tick } = setup();
    const a = join(TOKEN_A, 'Fero');
    const b = join(TOKEN_B, 'Jana');
    expect(a.link.last('welcome').caps).toContain('mini');
    tick(2);
    a.send({ t: 'mini', op: 'start', kind: 'toilet' });
    tick(30);
    expect(mini(a.link)?.phase).toBe('lobby');
    // B sees the round to join in the city-wide state
    const wev = b.link.last('wev');
    expect(wev.mg?.length).toBe(1);
    const id = wev.mg![0].id;
    expect(wev.mg![0]).toMatchObject({ kind: 'toilet', nick: 'Fero', n: 1 });
    b.send({ t: 'mini', op: 'join', id });
    tick(5);
    expect(mini(b.link)?.n).toBe(2);
    // the starter goes at once
    a.send({ t: 'mini', op: 'act' });
    tick(80);
    expect(mini(a.link)?.phase).toBe('live');
    expect(mini(b.link)?.phase).toBe('live');
    expect(mini(a.link)?.bar?.label).toBe('Mechúr');
    b.send({ t: 'mini', op: 'leave' });
    tick(2);
    expect(mini(b.link)).toBeNull();
  });

  it('ignores a malformed request', () => {
    const { join, tick, room } = setup();
    const a = join(TOKEN_A, 'Fero');
    tick(2);
    a.send({ t: 'mini', op: 'start', kind: 'nothing' });
    a.send({ t: 'mini', op: 'join', id: 'x' });
    tick(5);
    expect(mini(a.link)).toBeUndefined();
    expect(room.stats().miniRounds).toBe(0);
  });

  it('a debug start cuts the lobby short (the e2e)', () => {
    const { join, tick } = setup();
    const a = join(TOKEN_A, 'Fero');
    join(TOKEN_B, 'Jana');
    tick(2);
    a.send({ t: 'debug', mini: 'toilet' });
    tick(80);
    expect(mini(a.link)?.phase).toBe('live');
  });
});
