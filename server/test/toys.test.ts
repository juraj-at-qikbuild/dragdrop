// The Hračkárstvo's thrown toys over the wire (src/shared/sim/Toys.ts; docs/plans/gameplay.md,
// Phase 4): a `throw` costs a refill and flies from where the server has the thrower, others near
// see it fly (the thrower already showed it), a squirted toy can't be thrown nor a thrown one fired,
// and the snapshot counts every toy's refills.
import { describe, expect, it } from 'vitest';
import { Room } from '../src/Room';
import { PROTOCOL_VERSION, type ClientMsg, type WorldEvent } from '../../src/shared/net/protocol';
import { AMMO_LIST } from '../../src/shared/net/codec';
import { SPAWNS } from '../../src/shared/world/spawns';
import { FakeClock, FakeLink, TOKEN_A, TOKEN_B, disabledSupa, loadWorld } from './helpers';

const NO_NPCS = { traffic: 0, parked: 0, peds: 0, trams: 0, police: 0, helis: 0, roadblocks: 0 };

function setup() {
  const clock = new FakeClock();
  const room = new Room({ world: loadWorld(), now: clock.now, wallClock: clock.now, seed: 5, debug: true, caps: NO_NPCS, supa: disabledSupa() });
  const at = SPAWNS[0];
  const join = (token: string, nick: string, dx: number) => {
    const link = new FakeLink();
    const conn = room.onJoin(link);
    room.onMessage(conn, JSON.stringify({ t: 'hello', v: PROTOCOL_VERSION, token, nick, presence: true }));
    const p = room.sim.players.get(link.last('welcome').id)!;
    p.ped.x = at.x + dx;
    p.ped.y = at.y;
    const send = (m: ClientMsg) => room.onMessage(conn, JSON.stringify(m));
    return { link, p, send };
  };
  const tick = (n = 1) => {
    for (let i = 0; i < n; i++) {
      clock.advance(50);
      room.tick(50);
    }
  };
  return { room, join, tick, at };
}

const toys = (link: FakeLink) => link.json('ev').flatMap((m) => m.e).filter((e): e is Extract<WorldEvent, { k: 'toy' }> => e.k === 'toy');

describe('thrown toys over the wire', () => {
  it('a throw costs a refill, and whoever is near sees it fly and land', () => {
    const { join, tick, at } = setup();
    const a = join(TOKEN_A, 'Anna', 0), b = join(TOKEN_B, 'Boris', 8);
    a.p.ammo.egg = 2;
    tick();
    a.send({ t: 'throw', w: 'egg', tx: at.x + 6, ty: at.y });
    tick(20);
    expect(a.p.ammo.egg).toBe(1);
    const seen = toys(b.link);
    expect(seen.find((e) => e.op === 'throw')).toMatchObject({ w: 'egg', pid: a.p.id });
    expect(seen.some((e) => e.op === 'land' && e.w === 'egg')).toBe(true);
    // (the thrower showed their own throw already: not sent back, but its landing is)
    expect(toys(a.link).some((e) => e.op === 'throw')).toBe(false);
    expect(toys(a.link).some((e) => e.op === 'land')).toBe(true);
    // the snapshot counts every toy's refills, the egg's among them
    const me = a.link.lastSnapshot().me;
    expect(me.ammo).toHaveLength(AMMO_LIST.length);
    expect(me.ammo[AMMO_LIST.indexOf('egg')]).toBe(1);
  });

  it('no throw without a refill, nor of a toy that is squirted; no shot from a thrown one', () => {
    const { join, tick, at } = setup();
    const a = join(TOKEN_A, 'Anna', 0);
    tick();
    a.send({ t: 'throw', w: 'egg', tx: at.x + 6, ty: at.y });
    a.send({ t: 'throw', w: 'pistol', tx: at.x + 6, ty: at.y });
    a.p.ammo.soap = 1;
    a.send({ t: 'fire', w: 'soap', ox: at.x, oy: at.y, a: 0, lvl: 0, rt: 0, pellets: [{ a: 0, kind: 0, hit: 0, hx: at.x + 5, hy: at.y }] });
    tick(20);
    expect(toys(a.link)).toHaveLength(0);
    expect(a.p.ammo.pistol).toBeGreaterThan(0);
    expect(a.p.ammo.soap).toBe(1);
  });
});
