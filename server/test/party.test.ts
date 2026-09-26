// server/src/features/Party.ts (docs/plans/social-events.md "Partia + invite link"). Invites are
// persisted, so every test here runs against a temp-file SQLite Store (server/test/db.test.ts's
// withDb pattern), not the in-memory-only Room `setup()` in room.test.ts.
import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { GRACE_MS, Room } from '../src/Room';
import { Store, hashToken } from '../src/db';
import { PROTOCOL_VERSION } from '../../src/shared/net/protocol';
import type { PartyState } from '../../src/shared/sim/rules/types';
import { dist } from '../../src/shared/util/math';
import { FakeClock, FakeLink, TOKEN_A, TOKEN_B, TOKEN_C, loadWorld } from './helpers';

const TOKEN_D = '44444444-4444-4444-8444-444444444444';
const TOKEN_E = '55555555-5555-4555-8555-555555555555';

function withDb(fn: (file: string) => void) {
  const dir = mkdtempSync(path.join(tmpdir(), 'blava-party-'));
  try {
    fn(path.join(dir, 'test.db'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function setup(file: string) {
  const clock = new FakeClock();
  const store = new Store(file);
  const room = new Room({ world: loadWorld(), now: clock.now, wallClock: clock.now, seed: 7, store, debug: true });
  const join = (token: string, nick: string, extra: { join?: string } = {}) => {
    const link = new FakeLink();
    const conn = room.onJoin(link);
    room.onMessage(conn, JSON.stringify({ t: 'hello', v: PROTOCOL_VERSION, token, nick, ...extra }));
    const w = link.last('welcome');
    return { link, conn, id: w?.id, ped: w?.ped, x: w?.x, y: w?.y };
  };
  const invite = (conn: ReturnType<typeof room.onJoin>) => room.onMessage(conn, JSON.stringify({ t: 'partyInvite' }));
  const leave = (conn: ReturnType<typeof room.onJoin>) => room.onMessage(conn, JSON.stringify({ t: 'partyLeave' }));
  const kick = (conn: ReturnType<typeof room.onJoin>, id: number) => room.onMessage(conn, JSON.stringify({ t: 'partyKick', id }));
  const tick = (n = 1) => {
    for (let i = 0; i < n; i++) {
      clock.advance(50);
      room.tick(50);
    }
  };
  return { clock, store, room, join, invite, leave, kick, tick };
}

/** the code from the most recent {k:'invite'} private event sent to this link */
function lastInvite(link: FakeLink): string | undefined {
  const all = link.json('ev').flatMap((m) => m.p);
  for (let i = all.length - 1; i >= 0; i--) {
    const e = all[i];
    if (e.k === 'invite') return e.code;
  }
  return undefined;
}

/** the state from the most recent {k:'party'} private event sent to this link (undefined: none sent yet) */
function lastParty(link: FakeLink): PartyState | null | undefined {
  const all = link.json('ev').flatMap((m) => m.p);
  for (let i = all.length - 1; i >= 0; i--) {
    const e = all[i];
    if (e.k === 'party') return e.s;
  }
  return undefined;
}

/** every {k:'msg'} text delivered to this link so far */
function msgTexts(link: FakeLink): string[] {
  const out: string[] = [];
  for (const e of link.json('ev').flatMap((m) => m.p)) if (e.k === 'msg') out.push(e.text);
  return out;
}

describe('Party', () => {
  it('mints a 10-char base32 invite code (50 bits), rate-limited to one per 10 s', () => {
    withDb((file) => {
      const { join, invite, tick, clock } = setup(file);
      const a = join(TOKEN_A, 'Fero');

      invite(a.conn);
      tick();
      const code1 = lastInvite(a.link);
      expect(code1).toMatch(/^[a-z2-7]{10}$/);

      a.link.clear();
      invite(a.conn); // far too soon
      tick();
      expect(lastInvite(a.link)).toBeUndefined();

      clock.advance(10_000); // exactly the refill window
      invite(a.conn);
      tick();
      const code2 = lastInvite(a.link);
      expect(code2).toMatch(/^[a-z2-7]{10}$/);
      expect(code2).not.toBe(code1);
    });
  });

  it('a 6-char code minted before the length increase still joins fine (getInvite has no length check)', () => {
    withDb((file) => {
      const { room, store, join, tick } = setup(file);
      const a = join(TOKEN_A, 'Fero');
      store.createInvite('ab23cd', hashToken(TOKEN_A), room.wallNow(), 24 * 60 * 60 * 1000); // a legacy 6-char code
      const b = join(TOKEN_B, 'Boris', { join: 'ab23cd' });
      tick();
      const pa = room.sim.players.get(a.id!)!;
      const pb = room.sim.players.get(b.id!)!;
      expect(pb.partyId).toBe(pa.partyId);
      expect(pa.partyId).toBeGreaterThan(0);
    });
  });

  it('hello.join with a new session: same party, spawned within 8 m of the inviter', () => {
    withDb((file) => {
      const { room, join, invite, tick } = setup(file);
      const a = join(TOKEN_A, 'Fero');
      invite(a.conn);
      tick();
      const code = lastInvite(a.link)!;

      const b = join(TOKEN_B, 'Boris', { join: code }); // a brand-new session
      tick();

      const pa = room.sim.players.get(a.id!)!;
      const pb = room.sim.players.get(b.id!)!;
      expect(pa.partyId).toBeGreaterThan(0);
      expect(pb.partyId).toBe(pa.partyId);
      expect(dist(pa.ped.x, pa.ped.y, pb.ped.x, pb.ped.y)).toBeLessThan(8);
      expect(msgTexts(a.link)).toContain('Boris sa pridal do partie');
      expect(msgTexts(b.link).some((t) => t.startsWith('Si v partii'))).toBe(true);
    });
  });

  it('hello.join on an existing session: a teleport event arrives', () => {
    withDb((file) => {
      const { room, join, invite, tick } = setup(file);
      const a = join(TOKEN_A, 'Fero');
      invite(a.conn);
      tick();
      const code = lastInvite(a.link)!;

      join(TOKEN_B, 'Boris'); // Boris already has a session, not in any party
      tick();
      const b2 = join(TOKEN_B, 'Boris', { join: code }); // clicks the link: a second connection, same identity
      tick();

      const teleport = b2.link.json('ev').flatMap((m) => m.p).find((e) => e.k === 'teleport');
      expect(teleport).toBeTruthy();
      const pa = room.sim.players.get(a.id!)!;
      const pb = room.sim.players.get(b2.id!)!;
      expect(pb.partyId).toBe(pa.partyId);
      expect(dist(pa.ped.x, pa.ped.y, pb.ped.x, pb.ped.y)).toBeLessThan(8);
    });
  });

  it('an offline or unknown inviter: a message (with their nick when known), and a normal spawn', () => {
    withDb((file) => {
      const { room, store, join, invite, tick } = setup(file);
      const a = join(TOKEN_A, 'Fero');
      invite(a.conn);
      tick();
      const code = lastInvite(a.link)!;
      room.onLeave(a.conn); // Fero goes offline (still within the grace period)

      const b = join(TOKEN_B, 'Boris', { join: code });
      tick();
      expect(msgTexts(b.link)).toContain('Fero nie je online.');
      expect(room.sim.players.get(b.id!)!.partyId).toBe(0);

      // a code minted for a key nobody has ever played under: the generic fallback text
      store.createInvite('ghostc', 'nobody-key', room.wallNow(), 60_000);
      const c = join(TOKEN_C, 'Cyril', { join: 'ghostc' });
      tick();
      expect(msgTexts(c.link)).toContain('Hráč, ktorý ťa pozval, nie je online.');
      expect(room.sim.players.get(c.id!)!.partyId).toBe(0);
    });
  });

  it('an expired or invalid code: "Pozvánka už neplatí." and a normal spawn', () => {
    withDb((file) => {
      const { room, join, invite, tick, clock } = setup(file);
      const a = join(TOKEN_A, 'Fero');
      invite(a.conn);
      tick();
      const code = lastInvite(a.link)!;
      clock.advance(24 * 60 * 60 * 1000 + 1000); // past the 24 h TTL

      const b = join(TOKEN_B, 'Boris', { join: code });
      tick();
      expect(msgTexts(b.link)).toContain('Pozvánka už neplatí.');
      expect(room.sim.players.get(b.id!)!.partyId).toBe(0);

      const c = join(TOKEN_C, 'Cyril', { join: 'nonexist' });
      tick();
      expect(msgTexts(c.link)).toContain('Pozvánka už neplatí.');
      expect(room.sim.players.get(c.id!)!.partyId).toBe(0);
    });
  });

  it('a full party (4) refuses a 5th joiner', () => {
    withDb((file) => {
      const { room, join, invite, tick } = setup(file);
      const a = join(TOKEN_A, 'Lea');
      invite(a.conn);
      tick();
      const code = lastInvite(a.link)!; // codes are reusable: every joiner below rides the same link

      const b = join(TOKEN_B, 'Boris', { join: code });
      const c = join(TOKEN_C, 'Cyril', { join: code });
      const d = join(TOKEN_D, 'Dano', { join: code });
      tick();
      const pa = room.sim.players.get(a.id!)!;
      for (const j of [b, c, d]) expect(room.sim.players.get(j.id!)!.partyId).toBe(pa.partyId);

      const e = join(TOKEN_E, 'Ema', { join: code });
      tick();
      expect(room.sim.players.get(e.id!)!.partyId).toBe(0);
      expect(msgTexts(e.link)).toContain('Partia je plná.');
    });
  });

  it('hurtPlayer does nothing between party members but works with outsiders', () => {
    withDb((file) => {
      const { room, join, invite, tick } = setup(file);
      const a = join(TOKEN_A, 'Fero');
      invite(a.conn);
      tick();
      const code = lastInvite(a.link)!;
      const b = join(TOKEN_B, 'Boris', { join: code });
      const c = join(TOKEN_C, 'Cyril'); // outsider
      tick();

      const pa = room.sim.players.get(a.id!)!;
      const pb = room.sim.players.get(b.id!)!;
      const pc = room.sim.players.get(c.id!)!;
      expect(pa.partyId).toBe(pb.partyId);
      expect(pa.partyId).not.toBe(pc.partyId);

      room.sim.hurtPlayer(pb, 50, pb.ped.x, pb.ped.y, pa.id);
      expect(pb.ped.health).toBe(100);
      room.sim.hurtPlayer(pb, 50, pb.ped.x, pb.ped.y, pc.id);
      expect(pb.ped.health).toBeLessThan(100);
    });
  });

  it("jacking a member's stopped car is refused; an outsider's works", () => {
    withDb((file) => {
      const { room, join, invite, tick } = setup(file);
      const a = join(TOKEN_A, 'Fero');
      invite(a.conn);
      tick();
      const code = lastInvite(a.link)!;
      const b = join(TOKEN_B, 'Boris', { join: code });
      const c = join(TOKEN_C, 'Cyril'); // outsider
      tick();

      const pa = room.sim.players.get(a.id!)!;
      const pb = room.sim.players.get(b.id!)!;
      const pc = room.sim.players.get(c.id!)!;
      const car = room.sim.vehicles.find((v) => v.parked && !v.driver)!;
      car.owner = pa.id;
      car.driver = pa.ped;
      car.parked = false;

      pb.ped.x = car.x;
      pb.ped.y = car.y;
      pb.ped.level = car.level;
      expect(room.sim.enterVehicle(pb, car)).toBe(false);
      expect(car.owner).toBe(pa.id);

      pc.ped.x = car.x;
      pc.ped.y = car.y;
      pc.ped.level = car.level;
      expect(room.sim.enterVehicle(pc, car)).toBe(true);
      expect(car.owner).toBe(pc.id);
    });
  });

  it('splits event-reason payouts among connected, nearby, play/downed members; other reasons do not', () => {
    withDb((file) => {
      const { room, join, invite, tick } = setup(file);
      const a = join(TOKEN_A, 'Fero');
      invite(a.conn);
      tick();
      const code = lastInvite(a.link)!;
      const b = join(TOKEN_B, 'Boris', { join: code }); // near (teleported next to Fero)
      const c = join(TOKEN_C, 'Cyril', { join: code }); // near too, for now
      tick();

      const pa = room.sim.players.get(a.id!)!;
      const pb = room.sim.players.get(b.id!)!;
      const pc = room.sim.players.get(c.id!)!;
      pc.ped.x += 500; // now well past the 300 m radius

      const before = { a: pa.profile.money, b: pb.profile.money, c: pc.profile.money };
      room.sim.payout(pa, 301, 'kofolka'); // a split reason; odd amount exercises the remainder
      expect(pa.profile.money - before.a).toBe(151); // share (150) + the remainder
      expect(pb.profile.money - before.b).toBe(150);
      expect(pc.profile.money - before.c).toBe(0); // too far

      const before2 = { a: pa.profile.money, b: pb.profile.money };
      room.sim.payout(pa, 100, 'samaritan'); // not a split reason
      expect(pa.profile.money - before2.a).toBe(100);
      expect(pb.profile.money - before2.b).toBe(0);
    });
  });

  it('leave, kick, leader handoff on removal, and dissolving (with its codes) when the last member drops', () => {
    withDb((file) => {
      const { room, store, join, invite, leave, kick, tick, clock } = setup(file);
      const a = join(TOKEN_A, 'Fero');
      invite(a.conn);
      tick();
      const code = lastInvite(a.link)!;
      const b = join(TOKEN_B, 'Boris', { join: code });
      const c = join(TOKEN_C, 'Cyril', { join: code });
      const d = join(TOKEN_D, 'Dano', { join: code });
      tick();

      const pa = room.sim.players.get(a.id!)!;
      const pb = room.sim.players.get(b.id!)!;
      const pc = room.sim.players.get(c.id!)!;
      const pd = room.sim.players.get(d.id!)!;
      const partyId = pa.partyId;
      for (const p of [pb, pc, pd]) expect(p.partyId).toBe(partyId);

      // Boris leaves voluntarily
      leave(b.conn);
      tick();
      expect(pb.partyId).toBe(0);
      expect(lastParty(b.link)).toBeNull();
      expect(pa.partyId).toBe(partyId); // the party goes on without him

      // Fero (the leader) kicks Cyril
      kick(a.conn, pc.id);
      tick();
      expect(pc.partyId).toBe(0);
      expect(lastParty(c.link)).toBeNull();
      expect(msgTexts(c.link).some((t) => /vyhodili/i.test(t))).toBe(true);

      // Fero disconnects; once the grace period lapses, leadership passes to Dano, the only one left
      room.onLeave(a.conn);
      clock.advance(GRACE_MS + 1000);
      tick();
      expect(pd.partyId).toBe(partyId);
      expect(lastParty(d.link)?.members.find((m) => m.id === pd.id)?.leader).toBe(true);
      expect(room.sim.players.has(pa.id)).toBe(false); // Fero is gone for good

      // Dano mints his own code, then leaves too: with no members left connected, the party
      // dissolves and takes its (his) invite code down with it
      invite(d.conn);
      tick();
      const dCode = lastInvite(d.link)!;
      leave(d.conn);
      tick();
      expect(pd.partyId).toBe(0);
      expect(lastParty(d.link)).toBeNull();
      expect(store.getInvite(dCode, room.wallNow())).toBeNull();
    });
  });

  it("a member's own invite is deleted when they leave, even though the party lives on without them", () => {
    withDb((file) => {
      const { room, store, join, invite, leave, tick } = setup(file);
      const a = join(TOKEN_A, 'Fero');
      invite(a.conn);
      tick();
      const codeA = lastInvite(a.link)!;
      const b = join(TOKEN_B, 'Boris', { join: codeA }); // Boris joins Fero's party
      tick();
      invite(b.conn); // Boris mints his own invite too
      tick();
      const codeB = lastInvite(b.link)!;
      expect(store.getInvite(codeB, room.wallNow())).not.toBeNull();

      leave(b.conn); // Boris leaves voluntarily; Fero (and the party) carries on without him
      tick();
      expect(room.sim.players.get(a.id!)!.partyId).toBeGreaterThan(0);
      expect(store.getInvite(codeB, room.wallNow())).toBeNull(); // Boris's own invite must not outlive him
    });
  });

  it("a kicked player is refused when rejoining via another member's invite, until the 30-minute ban expires", () => {
    withDb((file) => {
      const { room, join, invite, kick, tick, clock } = setup(file);
      const a = join(TOKEN_A, 'Fero');
      invite(a.conn);
      tick();
      const code = lastInvite(a.link)!;
      const b = join(TOKEN_B, 'Boris', { join: code });
      const c = join(TOKEN_C, 'Cyril', { join: code });
      tick();
      const pa = room.sim.players.get(a.id!)!;
      const pb = room.sim.players.get(b.id!)!;

      kick(a.conn, pb.id); // Fero (leader) kicks Boris
      tick();
      expect(pb.partyId).toBe(0);

      invite(c.conn); // a different member's invite, not the kicker's own
      tick();
      const codeC = lastInvite(c.link)!;

      const b2 = join(TOKEN_B, 'Boris', { join: codeC }); // Boris clicks it right away (a fresh connection)
      tick();
      expect(pb.partyId).toBe(0); // still refused
      expect(msgTexts(b2.link)).toContain('Z tejto partie ťa vyhodili.');

      clock.advance(30 * 60_000 + 1000); // the 30-minute ban has now expired
      join(TOKEN_B, 'Boris', { join: codeC });
      tick();
      expect(pb.partyId).toBe(pa.partyId); // now allowed back in
    });
  });

  it('the roster carries pt (party id, tag, colour) for active parties', () => {
    withDb((file) => {
      const { room, join, invite, tick } = setup(file);
      const a = join(TOKEN_A, 'Anet');
      invite(a.conn);
      tick();
      const code = lastInvite(a.link)!;
      join(TOKEN_B, 'Boris', { join: code });
      tick();

      const pa = room.sim.players.get(a.id!)!;
      const pt = a.link.json('roster').flatMap((m) => m.pt ?? []);
      const entry = pt.find((t) => t[0] === pa.partyId);
      expect(entry).toBeTruthy();
      expect(entry![1]).toBe('ANET'); // the leader's nick, first 4 letters, uppercased
      expect(entry![2]).toMatch(/^#[0-9a-f]{6}$/i);
    });
  });
});
