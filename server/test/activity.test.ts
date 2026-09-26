import { describe, expect, it, vi } from 'vitest';
import { Room } from '../src/Room';
import { PROTOCOL_VERSION } from '../../src/shared/net/protocol';
import { Activity } from '../src/features/Activity';
import { Supa } from '../src/supa';
import { FakeLink, TOKEN_A, TOKEN_B, disabledSupa, loadWorld } from './helpers';

function fakeSupa() {
  const fn = vi.fn(async (_url: string, _init: RequestInit) => new Response('', { status: 200 }));
  const supa = new Supa('https://x.example', 'k', { fetch: fn as unknown as typeof fetch });
  return { supa, fn };
}

/** a Room with two joined sessions, for report()/log(Session, …) */
function twoPlayers() {
  const room = new Room({ world: loadWorld(), seed: 1, debug: true, supa: disabledSupa() });
  const join = (token: string, nick: string) => {
    const link = new FakeLink();
    const conn = room.onJoin(link);
    room.onMessage(conn, JSON.stringify({ t: 'hello', v: PROTOCOL_VERSION, token, nick }));
    return room.sessionById(link.last('welcome').id)!;
  };
  return { room, a: join(TOKEN_A, 'Anna'), b: join(TOKEN_B, 'Boris') };
}

describe('Activity', () => {
  it('log() accepts a plain {key, nick} in place of a Session', async () => {
    const { supa, fn } = fakeSupa();
    const activity = new Activity(supa);
    activity.log('daily', { key: 'acct:u1', nick: 'Fero' }, 1000);
    await supa.flush();
    const sent = JSON.parse(fn.mock.calls[0][1].body as string);
    expect(sent).toEqual([{ kind: 'daily', player: 'acct:u1', nick: 'Fero', amount: 1000, meta: {} }]);
  });

  it('log() rounds the amount and forwards meta, keyed by the session', async () => {
    const { supa, fn } = fakeSupa();
    const activity = new Activity(supa);
    const { a } = twoPlayers();
    activity.log('bounty', a, 149.5, { targetId: 7 });
    await supa.flush();
    const sent = JSON.parse(fn.mock.calls[0][1].body as string);
    expect(sent).toEqual([{ kind: 'bounty', player: a.key, nick: 'Anna', amount: 150, meta: { targetId: 7 } }]);
  });

  it('report() enqueues both players\' keys and nicks into reports', async () => {
    const { supa, fn } = fakeSupa();
    const activity = new Activity(supa);
    const { a, b } = twoPlayers();
    activity.report(a, b, 'harassment', { x: 1, y: 2 });
    await supa.flush();
    const sent = JSON.parse(fn.mock.calls[0][1].body as string);
    expect(sent).toEqual([{ reporter: a.key, reporter_nick: 'Anna', target: b.key, target_nick: 'Boris', reason: 'harassment', context: { x: 1, y: 2 } }]);
  });

  it('does nothing when Supabase is disabled', async () => {
    const supa = disabledSupa();
    const activity = new Activity(supa);
    const { a, b } = twoPlayers();
    activity.log('kofolka', a, 100);
    activity.report(a, b, 'spam', {});
    expect(supa.stats()).toEqual({ pending: 0, dropped: 0 });
    activity.shutdown(); // must not throw with nothing queued and Supabase off
  });

  it('shutdown() flushes the queue through the shared Supa', async () => {
    const { supa, fn } = fakeSupa();
    const activity = new Activity(supa);
    const { a } = twoPlayers();
    activity.log('cumil', a, 600);
    activity.shutdown(); // fire-and-forget: shutdown() itself doesn't return a promise to await
    await vi.waitFor(() => expect(supa.stats().pending).toBe(0));
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("Room exposes the same Supa/Activity instances through its typed accessors", () => {
    const { supa } = fakeSupa();
    const room = new Room({ world: loadWorld(), seed: 1, debug: true, supa });
    expect(room.activity).toBeInstanceOf(Activity);
    expect(room.supa).toBe(supa);
    expect(room.remoteConfig).toBeTruthy();
  });
});
