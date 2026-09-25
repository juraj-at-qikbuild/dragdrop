import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Room } from '../src/Room';
import { Store, hashToken } from '../src/db';
import { PROTOCOL_VERSION } from '../../src/shared/net/protocol';
import { FakeClock, FakeLink, TOKEN_A, loadWorld, stateMsg } from './helpers';

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
  const room = new Room({ world: loadWorld(), now: clock.now, wallClock: clock.now, seed: 1, store, debug: true });
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
      expect(again.loadProfile(TOKEN_A)).not.toBeNull();
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
