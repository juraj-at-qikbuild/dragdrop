import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { Room } from '../src/Room';
import { MIGRATIONS, Store, hashToken } from '../src/db';
import { PROTOCOL_VERSION } from '../../src/shared/net/protocol';
import type { SimPlayer } from '../../src/shared/sim/SimPlayer';
import { FakeClock, FakeLink, TOKEN_A, disabledSupa, loadWorld, stateMsg } from './helpers';

/** the minimal shape Store.savePlayers reads off a player; a real SimPlayer needs a whole Sim/World */
function fakePlayer(over: { money?: number; stats?: Record<string, number> } = {}): SimPlayer {
  return {
    profile: { money: over.money ?? 0, done: [], found: [], cumils: [], stats: over.stats },
    ped: { level: 0, health: 100, armor: 0, weapon: 'fist' },
    ammo: { pistol: 0, uzi: 0, shotgun: 0 },
    state: 'play',
    wanted: 0,
    focus: () => ({ x: 1, y: 2 }),
  } as unknown as SimPlayer;
}

function withDb(fn: (file: string) => void) {
  const dir = mkdtempSync(path.join(tmpdir(), 'blava-db-'));
  try {
    fn(path.join(dir, 'test.db'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function boot(file: string) {
  const clock = new FakeClock();
  const store = new Store(file);
  const room = new Room({ world: loadWorld(), now: clock.now, wallClock: clock.now, seed: 1, store, debug: true, supa: disabledSupa() });
  const join = (nick: string) => {
    const link = new FakeLink();
    const conn = room.onJoin(link);
    room.onMessage(conn, JSON.stringify({ t: 'hello', v: PROTOCOL_VERSION, token: TOKEN_A, nick }));
    return { link, conn, w: link.last('welcome') };
  };
  const tick = (n = 1) => {
    for (let i = 0; i < n; i++) {
      clock.advance(50);
      room.tick(50);
    }
  };
  return { clock, store, room, join, tick };
}

describe('persistence', () => {
  it('stores only a hash of the token', () => {
    withDb((file) => {
      const { room, join, store } = boot(file);
      join('Anna');
      room.shutdown();
      store.close();
      const again = new Store(file);
      expect(again.loadProfile(hashToken(TOKEN_A))).not.toBeNull();
      expect(hashToken(TOKEN_A)).toMatch(/^[0-9a-f]{64}$/);
      again.close();
    });
  });

  it('sockets closing after shutdown do not write to the closed database', () => {
    withDb((file) => {
      const { room, join, store } = boot(file);
      const a = join('Anna');
      room.shutdown();
      store.close();
      const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        room.onLeave(a.conn);
        room.flush();
        expect(errors).not.toHaveBeenCalled();
      } finally {
        errors.mockRestore();
      }
    });
  });

  it('money, discoveries, weapons, position and wanted level survive a server restart', () => {
    withDb((file) => {
      const first = boot(file);
      const a = first.join('Anna');
      first.room.onMessage(a.conn, stateMsg(a.w.x, a.w.y));
      first.tick(2);
      first.room.onMessage(a.conn, JSON.stringify({ t: 'debug', money: 4321, give: 'uzi', wanted: 2 }));
      const p = first.room.sim.players.get(a.w.id)!;
      p.profile.found.push('castle');
      // walk a little so the saved position is not the spawn point
      let x = a.w.x;
      for (let i = 0; i < 10; i++) {
        x += 0.3;
        first.room.onMessage(a.conn, stateMsg(x, a.w.y, { seq: 100 + i }));
        first.tick();
      }
      // deploy: SIGTERM flushes, the process goes away
      first.room.shutdown();
      first.store.close();

      const second = boot(file);
      const b = second.join('Anna');
      expect(second.room.sim.players.size).toBe(1);
      const q = second.room.sim.players.get(b.w.id)!;
      expect(q.profile.money).toBe(4321);
      expect(q.profile.found).toContain('castle');
      expect(q.ammo.uzi).toBe(999);
      expect(q.wanted).toBe(2);
      expect(b.w.x).toBeCloseTo(x, 0);
      expect(b.link.last('profile').money).toBe(4321);
      second.store.close();
    });
  });

  it('keeps the time of day across restarts', () => {
    withDb((file) => {
      const first = boot(file);
      first.room.sim.clock.setTime(21.5);
      first.room.flush();
      first.store.close();
      const second = boot(file);
      expect(second.room.sim.clock.time).toBeCloseTo(21.5, 2);
      second.store.close();
    });
  });
});

describe('social features store (Phase 0a)', () => {
  it('round-trips profile.stats, defaulting to {} when never set', () => {
    withDb((file) => {
      const store = new Store(file);
      store.savePlayers([{ key: 'k1', nick: 'Anon', player: fakePlayer() }]);
      expect(store.loadProfile('k1')!.profile.stats).toEqual({});
      store.savePlayers([{ key: 'k1', nick: 'Anon', player: fakePlayer({ stats: { golden: 3, deliveries: 7 } }) }]);
      expect(store.loadProfile('k1')!.profile.stats).toEqual({ golden: 3, deliveries: 7 });
      store.close();
    });
  });

  it('invites expire, and deleteInvitesOf clears every code from one inviter', () => {
    withDb((file) => {
      const store = new Store(file);
      store.createInvite('code1', 'k1', 1000, 60_000);
      store.createInvite('code2', 'k1', 1000, 60_000);
      store.createInvite('code3', 'k2', 1000, 60_000);
      expect(store.getInvite('code1', 1000)).toEqual({ inviterKey: 'k1' });
      expect(store.getInvite('code1', 60_999)).toEqual({ inviterKey: 'k1' }); // still valid, just before expiry
      expect(store.getInvite('code1', 61_000)).toBeNull(); // expired
      expect(store.getInvite('nope', 1000)).toBeNull(); // unknown code
      store.deleteInvitesOf('k1');
      expect(store.getInvite('code2', 1000)).toBeNull();
      expect(store.getInvite('code3', 1000)).not.toBeNull(); // a different inviter, untouched
      store.close();
    });
  });

  it('reserveNick is unique case-insensitively, and an account can change its own nick', () => {
    withDb((file) => {
      const store = new Store(file);
      expect(store.reserveNick('u1', 'Fero', 0)).toBe(true);
      expect(store.reserveNick('u2', 'fero', 0)).toBe(false); // taken, case-insensitively
      expect(store.reserveNick('u1', 'Fero2', 0)).toBe(true); // u1 changing its own nick is fine
      expect(store.getAccount('u1')).toEqual({ nick: 'Fero2' });
      expect(store.reserveNick('u2', 'fero2', 0)).toBe(false); // still taken (now under u1's new nick)
      expect(store.reserveNick('u2', 'Fero', 0)).toBe(true); // u1's old nick is free again
      expect(store.getAccount('nope')).toBeNull();
      store.deleteAccount('u1');
      expect(store.getAccount('u1')).toBeNull();
      store.close();
    });
  });

  it('movePlayer moves the players and sessions rows, only when the target has no progress yet', () => {
    withDb((file) => {
      const store = new Store(file);
      store.savePlayers([{ key: 'guest1', nick: 'Anon', player: fakePlayer({ money: 500 }) }]);
      expect(store.movePlayer('guest1', 'acct:u1')).toBe(true);
      expect(store.hasPlayer('guest1')).toBe(false); // the old row is gone…
      expect(store.loadProfile('acct:u1')!.profile.money).toBe(500); // …its progress moved…
      expect(store.loadSession('acct:u1')).not.toBeNull(); // …and so did its session row

      // a second guest can't be moved into an account that already has progress
      store.savePlayers([{ key: 'guest2', nick: 'Iny', player: fakePlayer({ money: 1 }) }]);
      expect(store.movePlayer('guest2', 'acct:u1')).toBe(false);
      expect(store.hasPlayer('guest2')).toBe(true); // untouched
      expect(store.loadProfile('acct:u1')!.profile.money).toBe(500); // untouched

      expect(store.movePlayer('nope-at-all', 'acct:u2')).toBe(false); // nothing to move
      store.close();
    });
  });

  it('deletePlayer cascades its session row', () => {
    withDb((file) => {
      const store = new Store(file);
      store.savePlayers([{ key: 'guest1', nick: 'Anon', player: fakePlayer() }]);
      expect(store.hasPlayer('guest1')).toBe(true);
      expect(store.loadSession('guest1')).not.toBeNull();
      store.deletePlayer('guest1');
      expect(store.hasPlayer('guest1')).toBe(false);
      expect(store.loadSession('guest1')).toBeNull(); // gone with it (ON DELETE CASCADE)
      store.close();
    });
  });
});

describe('migration', () => {
  it('migrates a v1 database file in place: existing data survives, new columns/tables work', () => {
    withDb((file) => {
      // build a database that has only ever run MIGRATIONS[0] (the schema before this Store version)
      const raw = new Database(file);
      raw.exec(MIGRATIONS[0]);
      raw.pragma('user_version = 1');
      raw
        .prepare('INSERT INTO players (token_hash, nickname, money, found, cumils, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run('abc', 'Old', 42, '["castle"]', '[]', 0, 0);
      raw.close();

      const store = new Store(file); // opening it runs MIGRATIONS[1]
      const profile = store.loadProfile('abc')!;
      expect(profile.profile.money).toBe(42);
      expect(profile.profile.found).toEqual(['castle']);
      expect(profile.profile.stats).toEqual({}); // the new column's default, backfilled by the ALTER TABLE
      // the new tables are there and usable
      expect(store.reserveNick('u1', 'Fero', 0)).toBe(true);
      store.createInvite('code1', 'abc', 0, 1000);
      expect(store.getInvite('code1', 0)).toEqual({ inviterKey: 'abc' });
      store.close();

      // reopening an already-migrated file re-runs nothing and keeps the data
      const again = new Store(file);
      expect(again.loadProfile('abc')!.profile.money).toBe(42);
      again.close();
    });
  });
});
