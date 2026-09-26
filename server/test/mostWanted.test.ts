// Najhľadanejší through the Room: debug{wanted:5} on a connected player, with a second player online
// to satisfy the minimum player count, lets MostWantedWatch trigger the chase; wev carries it (holder
// = that player's id) and ev.g announces it.
// Plan: docs/plans/social-events.md
import { describe, expect, it } from 'vitest';
import { Room, type RoomOptions } from '../src/Room';
import { PROTOCOL_VERSION } from '../../src/shared/net/protocol';
import { FakeClock, FakeLink, TOKEN_A, TOKEN_B, loadWorld } from './helpers';

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

describe('Najhľadanejší through the Room', () => {
  it('debug{wanted:5} with 2 players starts the chase: wev carries it, ev.g announces it', () => {
    const { room, join, tick } = setup();
    const a = join(TOKEN_A, 'Anna');
    join(TOKEN_B, 'Boris');
    room.onMessage(a.conn, JSON.stringify({ t: 'debug', wanted: 5 }));
    tick(60); // past the watcher's 1 Hz check, plus the debounced wev broadcast
    const wev = a.link.last('wev');
    expect(wev).toBeTruthy();
    const entry = wev.ev.find((e) => e.kind === 'wanted');
    expect(entry).toBeTruthy();
    expect(entry!.holder).toBe(a.id);
    const gs = a.link.json('ev').flatMap((m) => m.g ?? []);
    expect(gs.some((g) => g.k === 'mostWanted' && g.nick === 'Anna')).toBe(true);
  });

  it("does not start with only 1 player online (debug{wanted:5} sets the star level, not the chase)", () => {
    const { room, join, tick } = setup();
    const a = join(TOKEN_A, 'Anna');
    room.onMessage(a.conn, JSON.stringify({ t: 'debug', wanted: 5 }));
    tick(60);
    const wev = a.link.last('wev');
    expect(wev?.ev.some((e) => e.kind === 'wanted')).toBeFalsy();
  });
});
