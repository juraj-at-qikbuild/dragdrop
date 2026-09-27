// server/src/features/Police.ts (docs/plans/gameplay.md, Phase 1): buying off an arrest over the wire.
// The offer comes from the shared Sim.bust (a `bribe` private event); the client's `bribe` answer is
// the only thing this feature handles. The rules themselves are tested in test/shared/pursuit.test.ts.
import { describe, expect, it } from 'vitest';
import { Room } from '../src/Room';
import { PROTOCOL_VERSION } from '../../src/shared/net/protocol';
import type { PrivateEvent } from '../../src/shared/sim/events';
import { FakeClock, FakeLink, TOKEN_A, disabledSupa, loadWorld } from './helpers';

function setup() {
  const clock = new FakeClock();
  const room = new Room({ world: loadWorld(), now: clock.now, wallClock: clock.now, seed: 42, debug: true, supa: disabledSupa() });
  const link = new FakeLink();
  const conn = room.onJoin(link);
  room.onMessage(conn, JSON.stringify({ t: 'hello', v: PROTOCOL_VERSION, token: TOKEN_A, nick: 'Anna' }));
  const p = room.sim.players.get(link.last('welcome')!.id)!;
  const tick = (n = 1) => {
    for (let i = 0; i < n; i++) {
      clock.advance(50);
      room.tick(50);
    }
  };
  const send = (m: object) => room.onMessage(conn, JSON.stringify(m));
  const bribes = () => link.json('ev').flatMap((m) => m.p).filter((e): e is Extract<PrivateEvent, { k: 'bribe' }> => e.k === 'bribe');
  return { room, conn, link, p, tick, send, bribes };
}

describe('Police (Úplatok)', () => {
  it('offers to buy off an arrest at 2★, and a bribe sent back calls it off', () => {
    const { room, p, tick, send, bribes } = setup();
    p.profile.money = 1000;
    p.ammo.pistol = 12;
    room.sim.setWanted(p, 2);
    room.sim.bust(p);
    tick();
    expect(bribes()).toEqual([{ k: 'bribe', price: 300, t: 5 }]);
    send({ t: 'bribe' });
    expect(p.state).toBe('play');
    expect(p.wanted).toBe(0);
    expect(p.profile.money).toBe(700);
    expect(p.ammo.pistol).toBe(12);
    tick();
    expect(bribes().at(-1)).toEqual({ k: 'bribe', price: 0, t: 0 });
  });

  it('a bribe nobody offered, or a second one, does nothing (and is no offence)', () => {
    const { room, conn, p, tick, send } = setup();
    p.profile.money = 1000;
    send({ t: 'bribe' });
    expect(p.profile.money).toBe(1000);
    room.sim.setWanted(p, 1);
    room.sim.bust(p);
    tick();
    send({ t: 'bribe' });
    send({ t: 'bribe' });
    expect(p.profile.money).toBe(850);
    expect(p.state).toBe('play');
    expect(conn.strikes).toBe(0);
  });

  it('at 3★ nothing is offered, and the arrest goes ahead', () => {
    const { room, p, tick, send, bribes } = setup();
    p.profile.money = 1000;
    room.sim.setWanted(p, 3);
    room.sim.bust(p);
    tick();
    expect(bribes()).toEqual([]);
    send({ t: 'bribe' });
    expect(p.state).toBe('busted');
    tick(90); // 4.5 s: taken to the station
    expect(p.state).toBe('play');
    expect(p.profile.money).toBe(900);
  });
});
